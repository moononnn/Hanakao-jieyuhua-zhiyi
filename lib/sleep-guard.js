// lib/sleep-guard.js — 「活干完了帮我关」的守门人
//
// 场景（2026-10-19 用户原话）：困得要死，但某个窗口还在传应用、跑子代理，
// 想让它干完之后自己关机，人先去睡。
//
// 设计上只有一条硬规矩：**判不清就不动手。** 会话层会漏子代理（实机漏了两分十五秒），
// 任务层看得见（同一个子代理从头到尾挂着 running），所以任务层为主、会话层为辅；
// 任务层读不到时按「不空」处理，宁可永远不触发。
//
// 默认演练：到点只写记录、发一条通知，不执行任何关机命令。
// 真关机要用户明确同意后单独打开（`sleepGuardRealEnabled`），默认关闭；
// 就算打开了，也还有一段可撤销的倒计时窗口，窗口里一有动静就当场收手。
//
// 守卫状态落 sdk.storage，App 重载后能接上；运行中的计时器在内存，重载会重新起算。

import os from "node:os";
import { getActivityLedger, setActivityLedger } from "./activity-ledger.js";
import { sampleIdleSnapshot, summarizeSnapshot } from "./idle-watch.js";

export const SLEEP_GUARD_STATE_KEY = "sleepGuardState";
export const SLEEP_GUARD_LOG_KEY = "sleepGuardLog";
export const SLEEP_GUARD_TIMELINE_KEY = "sleepGuardTimeline";
export const SLEEP_GUARD_CONFIG_KEY = "sleepGuardConfig";

/** 默认：空十分钟才算完，动手前留五分钟可撤，最多守四小时。 */
export const DEFAULT_SLEEP_GUARD_CONFIG = Object.freeze({ idleMinutes: 10, graceMinutes: 5, maxWaitMinutes: 240 });

function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(max, Math.max(min, num));
}

/** 面板上的几个数字，越界一律夹回合理区间。 */
export function normalizeSleepGuardConfig(raw = {}) {
  const base = raw && typeof raw === "object" ? raw : {};
  return {
    idleMinutes: clamp(base.idleMinutes, 1, 720, DEFAULT_SLEEP_GUARD_CONFIG.idleMinutes),
    graceMinutes: clamp(base.graceMinutes, 1, 60, DEFAULT_SLEEP_GUARD_CONFIG.graceMinutes),
    maxWaitMinutes: clamp(base.maxWaitMinutes, 10, 1440, DEFAULT_SLEEP_GUARD_CONFIG.maxWaitMinutes),
  };
}

export async function readSleepGuardConfig(sdk) {
  try {
    return normalizeSleepGuardConfig(await sdk.storage.global.get(SLEEP_GUARD_CONFIG_KEY, {}));
  } catch {
    return { ...DEFAULT_SLEEP_GUARD_CONFIG };
  }
}

export async function saveSleepGuardConfig(sdk, patch = {}) {
  const current = await readSleepGuardConfig(sdk);
  const next = normalizeSleepGuardConfig({ ...current, ...(patch && typeof patch === "object" ? patch : {}) });
  await sdk.storage.global.set(SLEEP_GUARD_CONFIG_KEY, next);
  return next;
}
/** 真关机总开关。默认关，只能在用户明确同意后由工具打开。 */
export const SLEEP_GUARD_REAL_KEY = "sleepGuardRealEnabled";

/** 判定成立之后、真正关机之前的可撤销窗口。 */
export const DEFAULT_GRACE_MS = 5 * 60 * 1000;

export const DEFAULT_IDLE_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_WAIT_MS = 4 * 60 * 60 * 1000;
export const SAMPLE_INTERVAL_MS = 5_000;
/** 模块层允许的最短静默，开发验证时要压到几十秒。 */
const MIN_IDLE_MS = 10 * 1000;
const MAX_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_LOG = 60;
/** 复盘时间线：只记「忙的变了」，一晚下来能看出到底是谁一直拖着不让关。 */
const MAX_TIMELINE = 300;
/** 指纹变得太频繁时，至少隔这么久才落一次盘。 */
const TIMELINE_MIN_GAP_MS = 15_000;

let runtime = null;

// 宿主事件账本由 index.js 在订阅装上之后注入。
// 真正的存放处是 lib/activity-ledger.js 的模块级变量：采样层也要读它，
// 而且不能让不同入口（守门人 vs 探针）看到不同结果。这两个函数只做转接。
// 没注入时采样层会报 events.readable=false，判定那边不会因此拦关机
// （它只拦会话层/任务层读不到——账本是 Code 页的补充眼睛，不是必须项）。
export { setActivityLedger };

function ledgerReader() {
  return getActivityLedger();
}

function minutesText(ms) {
  const minutes = Math.round((Number(ms) || 0) / 6000) / 10;
  if (minutes < 1) return `${Math.round((Number(ms) || 0) / 1000)} 秒`;
  if (minutes >= 60) {
    const hours = Math.round((minutes / 60) * 10) / 10;
    return `${hours} 小时`;
  }
  return `${minutes} 分钟`;
}

function stopTimer() {
  if (runtime?.timer) {
    clearInterval(runtime.timer);
    runtime.timer = null;
  }
}

async function save(sdk) {
  try {
    await sdk.storage.global.set(SLEEP_GUARD_STATE_KEY, runtime?.state || null);
  } catch (error) {
    await sdk.logger?.warn?.(`守门状态没存上：${String(error?.message || error).slice(0, 120)}`);
  }
}

async function readLog(sdk) {
  try {
    const list = await sdk.storage.global.get(SLEEP_GUARD_LOG_KEY, []);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function pushLog(sdk, entry) {
  try {
    const list = await readLog(sdk);
    list.push(entry);
    await sdk.storage.global.set(SLEEP_GUARD_LOG_KEY, list.slice(-MAX_LOG));
  } catch (error) {
    await sdk.logger?.warn?.(`守门记录没存上：${String(error?.message || error).slice(0, 120)}`);
  }
}

/** 现在到底是谁在忙，拼成一个可比较的指纹。 */
function busyFingerprint(summary) {
  const parts = [];
  for (const item of summary?.busy || []) parts.push(`win:${item.id || item.agent || "?"}`);
  for (const item of summary?.activeTasks || []) parts.push(`task:${item.id || "?"}:${item.type || ""}`);
  return parts.sort().join("|");
}

/** 把忙碌项写成能看懂的样子，方便事后倒查。 */
function describeBusy(summary) {
  const items = [];
  for (const item of summary?.busy || []) {
    items.push({
      kind: "window",
      id: item.id || null,
      agent: item.agent || null,
      idleSeconds: Number.isFinite(item.idleMs) ? Math.round(item.idleMs / 1000) : null,
    });
  }
  for (const item of summary?.activeTasks || []) {
    items.push({
      kind: "task",
      id: item.id || null,
      type: item.type || null,
      status: item.status || null,
      owner: item.owner || null,
    });
  }
  return items.slice(0, 12);
}

async function pushTimeline(sdk, entry) {
  try {
    const list = await sdk.storage.global.get(SLEEP_GUARD_TIMELINE_KEY, []);
    const arr = Array.isArray(list) ? list : [];
    arr.push(entry);
    await sdk.storage.global.set(SLEEP_GUARD_TIMELINE_KEY, arr.slice(-MAX_TIMELINE));
  } catch (error) {
    await sdk.logger?.warn?.(`复盘时间线没存上：${String(error?.message || error).slice(0, 120)}`);
  }
}

/** 把「忙的变了」记一笔：一晚下来能看出到底是谁一直拖着。 */
async function noteBusyChange(sdk, state, summary, busyCount, now) {
  const fingerprint = busyFingerprint(summary);
  if (fingerprint === state.busyFingerprint) return;
  const firstChange = state.busyFingerprint === null;
  state.busyFingerprint = fingerprint;
  const gapOk = now - (state.lastTimelineAt || 0) >= TIMELINE_MIN_GAP_MS;
  // 从忙变空必须记；其他变化限流，免得她用电脑时把日志刷爆。
  if (!gapOk && fingerprint !== "" && !firstChange) return;
  state.lastTimelineAt = now;
  await pushTimeline(sdk, {
    at: new Date(now).toISOString(),
    kind: fingerprint ? "busy" : "idle",
    count: busyCount,
    sessionsTotal: summary?.sessions?.total ?? null,
    tasksActive: summary?.tasks?.active ?? null,
    tasksReadable: summary?.tasks?.readable === true,
    busy: describeBusy(summary),
  });
}

/** 读复盘时间线，默认给最近 120 条。 */
export async function readSleepTimeline(sdk, limit = 120) {
  try {
    const list = await sdk.storage.global.get(SLEEP_GUARD_TIMELINE_KEY, []);
    const arr = Array.isArray(list) ? list : [];
    const count = Math.min(500, Math.max(1, Number(limit) || 120));
    return arr.slice(-count);
  } catch {
    return [];
  }
}

// 关机前必须让人看到的那句话。
//
// 为什么单独抽出来到处带：这个功能只负责两件事——
//   ① 判断 Hana 什么时候真干完；② 到点执行关机。
// 它管不了别的程序有没有存盘，关机命令也不会替谁保存。
// 所以「非 Hana 的内容请自己先存好」这件事只能靠文案说清楚，
// 而且必须出现在人还醒着、还来得及动手的地方（挂上时、倒计时开始时）。
// 只说在关机那一瞬没用：那时人在床上，或者屏幕已经黑了。
const SAVE_REMINDER = "⚠️ 别的内容请先存好：这个功能只等 Hana 的窗口和任务跑完，不会替你保存其他程序（Word、PS、浏览器表单这些）的内容。";

// 关机命令里那句屏幕提示。
// 它只往屏幕上和系统事件日志里加一句话，不改关机时机、不改任何机制。
// 半夜屏幕突然亮起来说「30 秒后关机」，人得知道这是谁干的、为什么干。
const SHUTDOWN_COMMENT = "知意：Hana 的活干完了，30 秒后关机。请确认其他程序的内容已保存。";

/**
 * 宿主报的错误码翻成人话。
 *
 * 为什么不能只把英文原样写进日志（2026-10-29）：这些码是唯一能分清「没权限」
 * 「被勿扰挡住」「桌面端没就绪」的依据，写成英文事后没人愿意读，
 * 结果就是“通知没弹”这件事永远查不清。
 */
const NOTIFY_ERROR_TEXT = {
  APP_NOTIFICATION_UNSUPPORTED: "这台机器不支持系统通知",
  APP_CAPABILITY_DENIED: "知意没拿到通知权限",
  APP_NOTIFICATION_DESKTOP_UNAVAILABLE: "桌面端那边还没接上",
  APP_NOTIFICATION_DESKTOP_DISCONNECTED: "桌面端在弹之前断开了",
  APP_NOTIFICATION_TIMEOUT: "桌面端十秒内没确认，通知可能没弹出来",
  APP_NOTIFICATION_FAILED: "系统没让这条通知弹出来（可能被勿扰或通知设置挡住）",
  APP_NOTIFICATION_INVALID_RESULT: "桌面端回了看不懂的结果",
  APP_NOTIFICATION_FORBIDDEN: "桌面端没拿到这次弹通知的授权",
  APP_NOTIFICATION_LIMIT: "排队的通知太多，这条没排上",
};

function describeNotifyError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || error || "").slice(0, 160);
  const human = NOTIFY_ERROR_TEXT[code];
  return {
    code: code || null,
    // 有现成的人话就用人话，后面缀上原始信息方便核对代码。
    detail: human ? `${human}（${code}）` : message || "未知原因",
  };
}

/**
 * 弹一条系统通知，并把结果记下来。
 *
 * 这个函数以前有个真缺陷（2026-10-29 查出来）：拿不到 `sdk.notifications.show`
 * 时直接 `return false`，**一行日志都不写**；抛错那条路写的 warn 又依赖
 * `sdk.logger` 本身可用。两条路都可能一声不响地失败。
 *
 * 后果不是“少弹一条弹窗”那么简单：挂上关机那一刻的提醒是最后一道防线——
 * 人还醒着、还来得及去存别的程序。它静默失败，人就以为没挂上。
 * 所以现在不管成不成，都往护门记录里写一笔，带上错误码和一句人话。
 *
 * 返回值仍是布尔：调用方按需自己决定要不要额外动作。
 * 注：输入框上方那条横幅是另一条独立的展示位，即使这里失败它照样在，
 * 但那是另一个通道，不能拿来当作“提醒已经发出去了”的理由。
 */
async function notify(sdk, title, body) {
  const heading = String(title || "");
  const write = async (ok, info = {}) => {
    const state = runtime?.state;
    if (state) {
      state.lastNotifyAt = new Date().toISOString();
      state.lastNotifyOk = ok;
      state.lastNotifyCode = info.code || null;
      state.lastNotifyDetail = ok ? "已发出" : info.detail || null;
      state.lastNotifyTitle = heading.slice(0, 60);
    }
    await pushLog(sdk, {
      kind: ok ? "notify-shown" : "notify-failed",
      at: new Date().toISOString(),
      title: heading.slice(0, 60),
      ...info.code ? { code: info.code } : {},
      ...ok ? {} : { detail: String(info.detail || "").slice(0, 160) },
    });
    // 日志也写一份：警告要能在宿主日志里 grep 到，不能只存在 App 自己的账本里。
    if (!ok) {
      await sdk.logger?.warn?.(`守门通知没弹出来：${String(info.detail || info.code || "未知原因").slice(0, 160)}`);
    }
  };

  try {
    if (typeof sdk?.notifications?.show !== "function") {
      // 以前这里直接 return false，事后什么都查不到。
      await write(false, { code: "NOTIFICATIONS_UNAVAILABLE", detail: "这一版宿主没给 App 提供通知接口" });
      return false;
    }
    await sdk.notifications.show({ title, body });
    await write(true);
    return true;
  } catch (error) {
    const info = describeNotifyError(error);
    await write(false, info);
    return false;
  }
}

function baseState() {
  return {
    status: "idle",
    armedAt: null,
    idleMs: DEFAULT_IDLE_MS,
    maxWaitMs: DEFAULT_MAX_WAIT_MS,
    dryRun: true,
    real: false,
    graceMs: DEFAULT_GRACE_MS,
    shutdownAt: null,
    armedBy: null,
    note: "",
    idleSince: null,
    lastBusyAt: null,
    lastCheckAt: null,
    firedAt: null,
    firedIdleMs: null,
    result: null,
    cancelReason: null,
    lastSummary: null,
    busyFingerprint: null,
    lastTimelineAt: 0,
    // 最近一次通知的结局。挂上关机那一刻的提醒是最后一道防线，
    // 它失败得能查得到，不能只靠人去翻日志。
    lastNotifyAt: null,
    lastNotifyOk: null,
    lastNotifyCode: null,
    lastNotifyDetail: null,
    lastNotifyTitle: null,
  };
}

/** 对外的一份简读：面板和工具都看这个，不暴露内部计时器。 */
export function describeSleepGuard() {
  const state = runtime?.state ? { ...runtime.state } : null;
  if (!state) return { armed: false, state: null };
  const now = Date.now();
  // 「关机命令已发出」也算应激态：那 30 秒里还能用 shutdown /a 撤掉，
  // 所以面板得仍然显示它，否则人看到一个「没在守」就以为万事大吉，机器却照关。
  const armed = state.status === "watching" || state.status === "countdown" || state.status === "shutdown-issued";
  // 现在到底忙不忙，得从最后一次采样里拿。
  // 不报这个的话，工具层只能说「已经空了 0 秒」——而「0 秒」看不出是
  // 「刚空下来」还是「一直有活在跑，根本没开始计时」。
  // 2026-10-28 演练时就撞上了：时间线上写着「忙 7 处」，状态行却写「空了 0 秒」。
  const last = state.lastSummary && typeof state.lastSummary === "object" ? state.lastSummary : null;
  const busyCount = last && Number.isFinite(Number(last.busyCount)) ? Number(last.busyCount) : null;
  return {
    armed,
    state,
    idleForMs: armed && state.idleSince ? now - state.idleSince : 0,
    sinceArmedMs: state.armedAt ? now - state.armedAt : 0,
    progress: armed && state.idleSince ? Math.min(1, (now - state.idleSince) / state.idleMs) : 0,
    countdownLeftMs: state.status === "countdown" && state.shutdownAt ? Math.max(0, state.shutdownAt - now) : 0,
    // 命令已发出后的剩余可撤销秒数：发出去时记下 firedAt，/t 是 30 秒。
    // 过了这个窗口就真撤不掉了，所以得让界面知道还剩多久。
    abortLeftMs: state.status === "shutdown-issued" && state.firedAt
      ? Math.max(0, 30_000 - (now - state.firedAt))
      : 0,
    // 最近一次采样的结论：null 表示还没采到。
    busyCount,
    waitingSince: busyCount !== null && busyCount > 0 ? state.lastBusyAt || null : null,
    dryRun: state.dryRun === true,
  };
}

/**
 * 输入框上方那条提示条该写什么。
 *
 * 为什么抽成纯函数放这里：它是这个功能唯一常驻的展示位，文案错了人就白等一晚。
 * 以前它写在 index.js 里、拿不到测试，结果一直留着一句「已开 0:03」——
 * 那是「挂上以后过了多久」，跟她真正想知道的「还有多久就关」南辕北辙。
 *
 * 写文案的两条规矩：
 * ① 人关心的是「还剩多久、什么条件下会关」，不是「已经挂了几分钟」；
 * ② 宿主横幅 text 上限 200 字符，得短。
 *
 * @param {object} described describeSleepGuard() 的返回值
 * @returns {string} 没在守时返回空串
 */
export function describeBannerText(described) {
  if (!described || described.armed !== true) return "";
  const state = described.state || {};
  const dryRun = state.dryRun === true;
  const saveTail = "· 别的内容请先存好";

  // 命令已经发出去了。这 30 秒里还能抢回来，所以提示条不能消失。
  // 以前 armed 不包含这个状态，提示条会直接收掉，人以为没事了。
  if (state.status === "shutdown-issued") {
    const left = Math.max(0, Math.round((described.abortLeftMs || 0) / 1000));
    return left > 0
      ? `关机已发出，约 ${left} 秒后关（还能撤）· 点一下取消`
      : "关机已发出，可撤销窗口已过";
  }

  // 倒计时已经开始了：剩下的就是离关机本身的时间，最该报的就是它。
  if (state.status === "countdown") {
    const left = Math.max(0, Math.round((described.countdownLeftMs || 0) / 1000));
    const leftText = left >= 60 ? `${Math.round(left / 60)} 分钟` : `${left} 秒`;
    return dryRun
      ? `${leftText}后结束演练（不关机） ${saveTail}`
      : `${leftText}后关机 ${saveTail}`;
  }

  const idleMin = Math.max(1, Math.round((state.idleMs || 0) / 60_000));
  const graceMin = Math.max(1, Math.round((state.graceMs || 0) / 60_000));

  // 还有活在跑：这时候根本没开始计时，「还剩多久」是算不出来的。
  // 老实说清楚在等什么，比编一个数字强。
  if (Number(described.busyCount || 0) > 0) {
    return dryRun
      ? `演练中（不会真关）：还有 ${described.busyCount} 处在跑，跑完空满 ${idleMin} 分钟走一遍流程 ${saveTail}`
      : `会自动关机：还有 ${described.busyCount} 处在跑，跑完空满 ${idleMin} 分钟关机 ${saveTail}`;
  }

  // 已经空下来了、正在计时：这才是真能给出「还有多久」的时候。
  if (state.idleSince) {
    const needMs = Number(state.idleMs || 0);
    const idleMs = Number(described.idleForMs || 0);
    const remainMs = Math.max(0, needMs - idleMs);
    const remainMin = Math.ceil(remainMs / 60_000);
    // 先走完静默期，再来一段可撤的倒计时；把两段一起报出来最接近「实际多久后关」。
    const totalMin = remainMin + graceMin;
    if (dryRun) {
      return `演练中（不会真关）：还要空 ${remainMin} 分钟 ${saveTail}`;
    }
    return `会自动关机：还要空 ${remainMin} 分钟，之后 ${graceMin} 分钟倒计时（约 ${totalMin} 分钟后）${saveTail}`;
  }

  // 刚挂上、还在跑：同样给不出准数，但能把两段时限说清。
  if (dryRun) {
    return `演练中（不会真关）：Hana 空满 ${idleMin} 分钟走一遍流程 ${saveTail}`;
  }
  return `会自动关机：Hana 空满 ${idleMin} 分钟后倒计时 ${graceMin} 分钟再关 ${saveTail}`;
}

async function fire(sdk, idleMs) {
  const state = runtime.state;
  state.status = "fired";
  state.firedAt = Date.now();
  state.firedIdleMs = idleMs;
  state.lastCheckAt = state.firedAt;
  stopTimer();

  const summary = state.lastSummary;
  const clock = new Date(state.firedAt);
  const clockText = `${String(clock.getHours()).padStart(2, "0")}:${String(clock.getMinutes()).padStart(2, "0")}`;
  const windowsText = summary?.sessions?.total ? `扫了 ${summary.sessions.total} 个窗口` : "窗口数没读到";
  const tasksText = summary?.tasks?.readable
    ? `后台任务 ${summary.tasks.total} 条里没有在跑的`
    : "后台任务这一层没读到";
  // 第三层必须一起报：聊天页以外的会话（尤其 Code 页）只有这一层看得见。
  // 不报的话，人看到「活都完了」根本分不清是「真看过了」还是「没看见」。
  const eventsText = summary?.events?.readable
    ? `事件层盯着 ${summary.events.tracked} 段会话`
    : "事件这一层没读到（聊天页以外的会话可能没看见）";

  // 演练和真关机走同一套倒计时，只是最后一步不同。
  // 判定成立之后不直接下手，先进一段可撤销的倒计时。
  // 这几分钟里只要有人动一下（开会话、发消息、跑任务），当场收手，退回守着。
  state.status = "countdown";
  state.shutdownAt = state.firedAt + state.graceMs;
  state.result = "countdown";
  await pushLog(sdk, {
    kind: "countdown-start",
    at: new Date(state.firedAt).toISOString(),
    clockText,
    idleMs,
    needMs: state.idleMs,
    graceMs: state.graceMs,
    dryRun: state.dryRun,
    sessionsTotal: summary?.sessions?.total ?? null,
    tasksTotal: summary?.tasks?.total ?? null,
  });
  await notify(
    sdk,
    state.dryRun
      ? `知意 · ${clockText} 起活都完了（演练）`
      : `知意 · ${clockText} 起活都完了，${minutesText(state.graceMs)}后关机`,
    [
      state.dryRun
        ? `${clockText} 起已经 ${minutesText(idleMs)}没有 Hana 的窗口或任务在跑（${windowsText}，${tasksText}，${eventsText}）。演练：${minutesText(state.graceMs)}后到这里就会关，这期间一有动静就自动收手。`
        : `${clockText} 起已经 ${minutesText(idleMs)}没有 Hana 的窗口或任务在跑（${windowsText}，${tasksText}，${eventsText}）。这 ${minutesText(state.graceMs)}里只要还有动静就会自动收手。`,
      "",
      SAVE_REMINDER,
    ].join("\n"),
  );
  // fire 开头把计时器停了，倒计时这一层还得靠它复核。
  startTimer(sdk);

  await save(sdk);
}

/** 倒计时期间：还空就等，一有活就撤。 */
async function tickCountdown(sdk) {
  const state = runtime?.state;
  if (!state || state.status !== "countdown") return;

  let summary = null;
  try {
    const snapshot = await sampleIdleSnapshot(sdk, {
      recentMs: Math.max(state.idleMs, 10 * 60 * 1000),
      activityLedger: ledgerReader(),
    });
    summary = summarizeSnapshot(snapshot);
  } catch (error) {
    // 看不清就收手，不外推。
    state.lastSummary = { error: String(error?.message || error).slice(0, 160) };
    await cancelCountdown(sdk, "关机前最后一次查看没看成");
    return;
  }

  const now = Date.now();
  state.lastCheckAt = now;
  state.lastSummary = summary;
  const verdict = judgeIdle({ ...state, idleMs: 0, idleSince: null }, summary, now);

  if (verdict.busy) {
    await cancelCountdown(sdk, "又有东西跑起来了");
    return;
  }
  if (now >= state.shutdownAt) await executeShutdown(sdk);
}

/** 倒计时被你自己的一下动静撤掉：不是出错，是它认账。 */
async function cancelCountdown(sdk, reason) {
  const state = runtime.state;
  state.status = "watching";
  state.shutdownAt = null;
  state.idleSince = null;
  state.result = "countdown-cancelled";
  state.cancelReason = String(reason || "").slice(0, 120);
  await pushLog(sdk, { kind: "countdown-cancelled", at: new Date().toISOString(), reason: state.cancelReason });
  await notify(sdk, "知意 · 先不关了", `${state.cancelReason}，倒计时作废，接着守。`);
  await save(sdk);
}

/** 真的下手。这一步之前已经在倒计时里反复复核过全局空闲。 */
async function executeShutdown(sdk) {
  const state = runtime.state;
  const summary = state.lastSummary;

  if (state.dryRun) {
    // 演练走到最后一步：只记一笔，不碰系统。
    state.status = "preview-done";
    state.result = "dry-run";
    state.firedAt = Date.now();
    stopTimer();
    await pushLog(sdk, {
      kind: "would-shutdown",
      at: new Date(state.firedAt).toISOString(),
      idleMs: state.firedIdleMs,
      needMs: state.idleMs,
      graceMs: state.graceMs,
      sessionsTotal: summary?.sessions?.total ?? null,
      tasksTotal: summary?.tasks?.total ?? null,
      note: "演练：走到倒计时结束就没再往下，没执行任何关机命令。",
    });
    await notify(sdk, "知意 · 演练：本来这时候就关了", `倒计时走完，Hana 的窗口和后台任务一直空着。这次没真关。\n\n${SAVE_REMINDER}`);
    await save(sdk);
    return;
  }

  state.status = "shutdown-issued";
  state.result = "shutdown-issued";
  state.firedAt = Date.now();
  stopTimer();

  await pushLog(sdk, {
    kind: "shutdown-issued",
    at: new Date(state.firedAt).toISOString(),
    idleMs: state.firedIdleMs,
    graceMs: state.graceMs,
    sessionsTotal: summary?.sessions?.total ?? null,
    tasksTotal: summary?.tasks?.total ?? null,
    note: "到这一步才真的关机。",
  });
  await notify(sdk, "知意 · 这就关机了", `活都干完了，好好睡。\n\n${SAVE_REMINDER}`);
  await save(sdk);

  try {
    const { spawn } = await import("node:child_process");
    // 不要 detached：第一次实机（2026-10-19 23:51）就是带着 detached 静默失败，
    // 事件日志里连一条 1074 都没有。现在把 stdout/stderr 与退码全部记下来。
    //
    // /t 30 保持不变：这条命令连续几天实机验证过（0.1.43 及以前），
    // 2026-10-28 我自己把它改成 300 想多给个存盘窗口，又被推回去了——
    // 这次改动的目的是「关机看得见 Code 页」，不是改关机本身。
    // 关机命令一变，「之前几天验证过」那份证据就作废了，得重新验一遍，不值得。
    // 要改 /t 应该单独立项、单独验，不能搭在判定层的改动里顺手改。
    const child = spawn("shutdown.exe", [
      "/s", "/t", "30",
      // /c 只加一句屏幕提示（同时进系统事件日志），不改关机时机与机制。
      "/c", SHUTDOWN_COMMENT,
    ], { env: buildShutdownEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      void pushLog(sdk, { kind: "shutdown-error", at: new Date().toISOString(), message: String(error?.message || error).slice(0, 200) });
    });
    child.on("exit", (code) => {
      void pushLog(sdk, { kind: "shutdown-exit", at: new Date().toISOString(), code, stdout: stdout.slice(0, 200), stderr: stderr.slice(0, 200) });
      void sdk.logger?.info?.(`shutdown.exe 退码 ${code}${stderr ? `：${stderr.slice(0, 120)}` : ""}`);
    });
    child.unref?.();
    await sdk.logger?.info?.("已发出关机命令，30 秒后关机");
  } catch (error) {
    state.result = "shutdown-failed";
    await pushLog(sdk, { kind: "shutdown-failed", at: new Date().toISOString(), message: String(error?.message || error).slice(0, 160) });
    await notify(sdk, "知意 · 关机没发出去", `该关了但命令没发出去：${String(error?.message || error).slice(0, 80)}。电脑不会关，早上跟我说一声。`);
    await save(sdk);
  }
}

async function expire(sdk) {
  const state = runtime.state;
  state.status = "expired";
  state.firedAt = Date.now();
  state.result = "waited-too-long";
  stopTimer();
  const summary = state.lastSummary;
  const busy = summary ? summary.busyCount + (summary.tasks?.readable ? summary.tasks.active : 0) : null;
  await pushLog(sdk, {
    kind: "gave-up",
    at: new Date(state.firedAt).toISOString(),
    waitedMs: state.firedAt - state.armedAt,
    busy,
    whoWasBusy: describeBusy(summary).slice(0, 6),
  });
  await notify(
    sdk,
    "知意 · 这次没关机",
    `守了 ${minutesText(state.firedAt - state.armedAt)}，Hana 里一直有活儿在跑${busy ? `（现在还有 ${busy} 处）` : ""}，所以没到能关机的时候。`,
  );
  await save(sdk);
}

/**
 * 一次判定的纯逻辑，单独拆出来是为了能测：忙、还没空够、该动手了。
 *
 * 这里只有一条不能妥协的规矩：**判不清就不动手。**
 *   ① 任务层读不到 → 按忙算（2026-10-19 实机：子代理只在任务层看得见）；
 *   ② 会话层读不到 → 也按忙算（2026-10-27 补：以前只校验了任务层，
 *      session:list 抛错时会话层整体瞎掉，只要任务层空着就关机）；
 *   ③ 事件账本里还有在跑的 → 按忙算（这是 Code 页唯一的可见渠道）。
 */
export function judgeIdle(state, summary, now) {
  const tasksKnown = summary?.tasks?.readable === true;
  const taskBusy = tasksKnown ? Number(summary?.tasks?.active || 0) : 1;
  const sessionsKnown = summary?.sessions?.readable === true;
  // 会话层瞎了就是看不见 Code 页以外的一切，不能当成「它们都空着」
  const sessionUnknownBusy = sessionsKnown ? 0 : 1;
  // 事件层刚开张（App 刚重载）时账本是空的，但这不代表没人干活：
  // 重载不会让 Code 页那一段正在跑的东西停下来。这种「空」不能当成真空。
  // 只有它确实报出了忙才计入（那种情况下拦是对的）。
  const eventsUncertain =
    summary?.events?.readable === true &&
    summary?.events?.warmingUp === true &&
    Number(summary?.events?.busyCount || 0) === 0;
  const eventsUnknownBusy = eventsUncertain ? 1 : 0;
  const busyCount = Number(summary?.busyCount || 0) + taskBusy + sessionUnknownBusy;

  if (!tasksKnown || !sessionsKnown || eventsUncertain || busyCount > 0) {
    return {
      busy: true,
      tasksKnown,
      sessionsKnown,
      eventsUncertain,
      busyCount: busyCount + eventsUnknownBusy,
      idleSince: null,
      idleMs: 0,
      fire: false,
      expire: false,
    };
  }

  const idleSince = Number(state?.idleSince) || now;
  const idleMs = now - idleSince;
  if (idleMs >= Number(state?.idleMs || 0)) {
    return { busy: false, tasksKnown, sessionsKnown, eventsUncertain: false, busyCount: 0, idleSince, idleMs, fire: true, expire: false };
  }
  // 空下来才轮得上计时；等着等着超过最长等待就放弃，但不推翻刚满的那一下。
  const expire = Boolean(state?.armedAt) && now - Number(state.armedAt) >= Number(state.maxWaitMs || 0);
  return { busy: false, tasksKnown, sessionsKnown, eventsUncertain: false, busyCount: 0, idleSince, idleMs, fire: false, expire };
}

async function tick(sdk) {
  const rt = runtime;
  if (!rt) return;
  if (rt.state.status === "countdown") return tickCountdown(sdk);
  if (rt.state.status !== "watching") return;
  const state = rt.state;

  let summary = null;
  try {
    const snapshot = await sampleIdleSnapshot(sdk, {
      recentMs: Math.max(state.idleMs, 10 * 60 * 1000),
      activityLedger: ledgerReader(),
    });
    summary = summarizeSnapshot(snapshot);
  } catch (error) {
    // 采不到就当成「有活」，绝不在看不清的时候往下走。
    state.idleSince = null;
    state.lastCheckAt = Date.now();
    state.lastSummary = { error: String(error?.message || error).slice(0, 160) };
    return;
  }

  const now = Date.now();
  state.lastCheckAt = now;
  state.lastSummary = summary;

  const verdict = judgeIdle(state, summary, now);
  state.degraded = !verdict.tasksKnown;
  state.idleSince = verdict.idleSince;
  // 先记账再判：到底是谁拦着不让关，得留下来。
  await noteBusyChange(sdk, state, summary, verdict.busyCount, now);
  if (verdict.busy) {
    state.lastBusyAt = now;
    return;
  }
  if (verdict.fire) {
    await fire(sdk, verdict.idleMs);
    return;
  }
  if (verdict.expire) await expire(sdk);
}

function startTimer(sdk) {
  stopTimer();
  const timer = setInterval(() => void tick(sdk), SAMPLE_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  runtime.timer = timer;
  void tick(sdk);
}

/**
 * Hana 给 App 子进程的环境是被裁剪过的：SESSIONNAME、COMPUTERNAME 这些都不在里面。
 * shutdown.exe 恰恰靠它们干活，缺了就直接报 203「系统找不到输入的环境选项」，
 * 命令看着发出去了，其实一个字节都没到系统（2026-10-19 23:51 那次就是这么静默失败的）。
 * 这里只补缺的，不覆盖已有的。
 */
export function buildShutdownEnv() {
  const env = { ...process.env };
  if (!env.COMPUTERNAME) env.COMPUTERNAME = os.hostname();
  if (!env.SESSIONNAME) env.SESSIONNAME = "Console";
  if (!env.SystemDrive) env.SystemDrive = "C:";
  if (!env.SystemRoot) env.SystemRoot = "C:\\WINDOWS";
  if (!env.windir) env.windir = env.SystemRoot;
  if (!env.USERPROFILE) env.USERPROFILE = os.homedir();
  if (!env.TEMP) env.TEMP = os.tmpdir();
  if (!env.TMP) env.TMP = env.TEMP;
  return env;
}

/** 真关机开关现在是什么状态。 */
export async function isRealEnabled(sdk) {
  try {
    return (await sdk.storage.global.get(SLEEP_GUARD_REAL_KEY, false)) === true;
  } catch {
    return false;
  }
}

/** 打开/关闭真关机。只有用户明确同意后才该调这里。 */
export async function setRealEnabled(sdk, enabled) {
  const next = enabled === true;
  await sdk.storage.global.set(SLEEP_GUARD_REAL_KEY, next);
  return next;
}

/**
 * 挂上守门。默认演练；要真关机得先把总开关打开。
 */
export async function armSleepGuard(sdk, options = {}) {
  // 演练已经退役（2026-10-21 用户定）：静候关机就是真关机。
  // dryRun 只留给开发时验证用，界面上不再出现，也不再读那个总开关。
  const dryRun = options.dryRun === true;
  const wantsReal = !dryRun;
  if (!runtime) runtime = { state: baseState(), timer: null };
  stopTimer();

  const state = baseState();
  state.status = "watching";
  state.armedAt = Date.now();
  // 没传具体数字就用面板存的那几项，不硬编码。
  const config = await readSleepGuardConfig(sdk);
  state.idleMs = clamp(options.idleMs, MIN_IDLE_MS, MAX_IDLE_MS, config.idleMinutes * 60_000);
  state.maxWaitMs = clamp(options.maxWaitMs, state.idleMs, MAX_IDLE_MS, config.maxWaitMinutes * 60_000);
  state.dryRun = dryRun;
  state.real = wantsReal;
  state.graceMs = clamp(options.graceMs, 30_000, 60 * 60 * 1000, config.graceMinutes * 60_000);
  state.armedBy = String(options.armedBy || "").slice(0, 60) || null;
  state.note = String(options.note || "").slice(0, 200);
  runtime.state = state;

  // 新的一轮就重新记一遍：旧时间线混进来，事后反而看不清。
  try {
    await sdk.storage.global.set(SLEEP_GUARD_TIMELINE_KEY, []);
  } catch {}
  await save(sdk);
  startTimer(sdk);

  // 挂上的这一刻是最后一道提醒。这时候人还醒着、还没躺下，还来得及去把
  // 别的东西存了。等到倒计时开始才说，人可能已经睡着了。
  if (options.quiet !== true) {
    await notify(
      sdk,
      dryRun ? "知意 · 演练已挂上（不会真关）" : "知意 · 关机已挂上",
      [
        dryRun
          ? `Hana 的窗口和任务全部停下来后满 ${minutesText(state.idleMs)}，就会走完一遍完整流程（只记录，不关机）。`
          : `Hana 的窗口和任务全部停下来后满 ${minutesText(state.idleMs)}，再给 ${minutesText(state.graceMs)}倒计时，然后关机。`,
        "",
        SAVE_REMINDER,
        "要取消：点知意面板上的关机格子，或直接说一声。",
      ].join("\n"),
    );
  }
  return describeSleepGuard();
}

/**
 * 撤掉守门。任何理由都能撤。
 *
 * 关键：如果关机命令已经发出去了（status === "shutdown-issued"），
 * 光把 App 自己的状态改成 cancelled 是不够的——电脑还是会按计划关。
 * 必须同时发一条 `shutdown /a` 去撒销系统层面的关机。
 *
 * 这个缺陷以前一直存在（2026-10-28 查代码才发现）：
 * `/sleep-guard/cancel` 只写了本地状态，从来没调过 `/a`。
 * 于是那 30 秒里就算在面板上点「取消」，机器照样会关。
 */
export async function cancelSleepGuard(sdk, reason = "") {
  const state = runtime?.state;
  if (!state) return { armed: false, cancelled: false };
  const wasWatching = state.status === "watching" || state.status === "countdown";
  // 命令发出去了才需要去撒系统那条。
  const wasIssued = state.status === "shutdown-issued";
  stopTimer();
  state.status = "cancelled";
  state.cancelReason = String(reason || "手动取消").slice(0, 120);
  state.lastCheckAt = Date.now();
  await pushLog(sdk, { kind: "cancelled", at: new Date().toISOString(), reason: state.cancelReason });

  let abortResult = null;
  if (wasIssued) {
    abortResult = await abortSystemShutdown(sdk);
    // 撒不掉就不谎称「已经取消」：机器还会关，得让调用方知道。
    state.abort = abortResult;
  }

  await save(sdk);
  return {
    armed: false,
    cancelled: wasWatching || wasIssued,
    reason: state.cancelReason,
    wasIssued,
    abort: abortResult,
  };
}

/**
 * 发 `shutdown /a` 撒销已经排上队的关机。
 * 只在 `/t` 那个窗口内有效；过了就撤不掉（Windows 会报错）。
 * 返回 { ok, detail }：ok 为 false 时表示没能撤销，机器还会关。
 */
export async function abortSystemShutdown(sdk) {
  try {
    const { spawn } = await import("node:child_process");
    const outcome = await new Promise((resolve) => {
      const child = spawn("shutdown.exe", ["/a"], {
        env: buildShutdownEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (error) => resolve({ ok: false, detail: String(error?.message || error).slice(0, 160) }));
      child.on("exit", (code) => {
        // 退码 0 = 撤掉了；非 0 一般是 1116「没有关机正在进行」。
        // stderr 是系统本地代码页（中文 Windows 是 GBK），Node 按 UTF-8 读会变成乱码。
        // 所以不把原始 stderr 往界面上择：按退码给一句人话，原始内容只进日志。
        const reason = code === 0
          ? ""
          : code === 1116 || /1116/.test(stderr)
            ? "：系统里已经没有待执行的关机"
            : `：退码 ${code}`;
        resolve({
          ok: code === 0,
          detail: `退码 ${code}${reason}`,
          raw: stderr.trim().slice(0, 200),
        });
      });
      const timer = setTimeout(() => resolve({ ok: false, detail: "shutdown /a 超时没回话" }), 6_000);
      timer.unref?.();
    });
    await pushLog(sdk, {
      kind: outcome.ok ? "shutdown-aborted" : "shutdown-abort-failed",
      at: new Date().toISOString(),
      detail: outcome.detail,
      ...outcome.raw ? { raw: outcome.raw } : {},
    });
    await sdk.logger?.[outcome.ok ? "info" : "warn"]?.(
      outcome.ok ? "已撤销系统排上的关机" : `关机没能撤销：${outcome.detail}`,
    );
    if (outcome.ok) {
      await notify(sdk, "知意 · 关机已撤销", "系统里排着的关机已经撤销，电脑不会关了。");
    } else {
      await notify(sdk, "知意 · 撤销没成功，机器还会关", `${outcome.detail}。要留在开机就赶快手动敲 shutdown /a。`);
    }
    return outcome;
  } catch (error) {
    const detail = String(error?.message || error).slice(0, 160);
    await pushLog(sdk, { kind: "shutdown-abort-failed", at: new Date().toISOString(), detail });
    return { ok: false, detail };
  }
}

/** 读状态 + 历史记录。 */
export async function readSleepGuard(sdk, options = {}) {
  const described = describeSleepGuard();
  if (!options.withLog && !options.withTimeline) return described;
  const out = { ...described };
  if (options.withLog) out.log = (await readLog(sdk)).slice(-12);
  if (options.withTimeline) out.timeline = await readSleepTimeline(sdk, options.timelineLimit || 120);
  return out;
}

/**
 * App 起来时接上一轮没走完的守门。
 * 只在状态还是 watching、且没超过最长等待的时候接；计时从这次重挂开始重算，
 * 因为进程换了一茬，中间那段到底空没空已经看不到，不能凭空算数。
 */
export async function restoreSleepGuard(sdk) {
  let stored = null;
  try {
    stored = await sdk.storage.global.get(SLEEP_GUARD_STATE_KEY, null);
  } catch {
    return { restored: false };
  }
  if (!stored || !stored.armedAt) return { restored: false };
  if (stored.status === "countdown") {
    // 重载打断了倒计时。做了一半的关机不复原，宁可错过今晩，也不盲目接上。
    await pushLog(sdk, { kind: "dropped", at: new Date().toISOString(), reason: "重载时正在倒计时，已作废" });
    return { restored: false };
  }
  if (stored.status !== "watching") return { restored: false };
  const now = Date.now();
  if (now - stored.armedAt >= (Number(stored.maxWaitMs) || DEFAULT_MAX_WAIT_MS)) {
    await pushLog(sdk, { kind: "dropped", at: new Date(now).toISOString(), reason: "重载时已经超过最长等待" });
    return { restored: false };
  }
  if (!runtime) runtime = { state: baseState(), timer: null };
  stopTimer();
  runtime.state = {
    ...baseState(),
    ...stored,
    status: "watching",
    // 中间断过，计不清，从零开始。
    idleSince: null,
    lastCheckAt: null,
    lastSummary: null,
  };
  startTimer(sdk);
  await pushLog(sdk, { kind: "resumed", at: new Date(now).toISOString() });
  await save(sdk);
  return { restored: true, state: describeSleepGuard() };
}

/** App 卸载/停用时清干净，别留一个跑着的定时器。 */
export function disposeSleepGuard() {
  stopTimer();
  runtime = null;
}
