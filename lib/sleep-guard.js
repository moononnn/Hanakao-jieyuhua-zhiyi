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
import { spawn } from "node:child_process";
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
/** 一次采样最多允许跑多久：宿主 RPC 挂住时不能把后面的采样全堵死。 */
const TICK_TIMEOUT_MS = 90_000;
/** 连续看不清多久才打扰人一次。太短会凌晨报个不停。 */
const BLIND_NOTICE_MS = 10 * 60 * 1000;
/** 模块层允许的最短静默，开发验证时要压到几十秒。 */
const MIN_IDLE_MS = 10 * 1000;
const MAX_IDLE_MS = 12 * 60 * 60 * 1000;
const MAX_LOG = 60;
/** 复盘时间线：只记「忙的变了」，一晚下来能看出到底是谁一直拖着不让关。 */
const MAX_TIMELINE = 300;
/** 指纹变得太频繁时，至少隔这么久才落一次盘。 */
const TIMELINE_MIN_GAP_MS = 15_000;

let runtime = null;
// 5 秒一次的采样是异步的，重叠起来会各判一遍，可能把关机发两次。
let tickInFlight = false;

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
    // 这笔「关机已发出」的旧账报到第几回了。同一个 firedAt 只通知一次：
    // 以前每次重载都重新弹，一上午能来三条，人会以为又出了新问题。
    reportedFiredAt: null,
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
    // 判不清时到底是哪一层瞎了。攒够一段时间还没看清就发一条通知，
    // 免得到早上只看见「没关」而不知道是故意没关。
    blind: null,
    blindSince: null,
    blindNotified: false,
  };
}

/** 对外的一份简读：面板和工具都看这个，不暴露内部计时器。 */
export function describeSleepGuard() {
  const state = runtime?.state ? { ...runtime.state } : null;
  if (!state) return { armed: false, state: null };
  const now = Date.now();
  // 「关机命令已发出」也算应激态：那 30 秒里还能用 shutdown /a 撤掉，
  // 所以面板得仍然显示它，否则人看到一个「没在守」就以为万事大吉，机器却照关。
  const armed = ["watching", "countdown", "shutdown-preparing", "shutdown-sending",
    "shutdown-issued", "shutdown-unknown", "abort-pending", "abort-failed"].includes(state.status);
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
    abortLeftMs: ["shutdown-sending", "shutdown-issued", "shutdown-unknown", "abort-pending", "abort-failed"].includes(state.status) && state.firedAt
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

  if (state.status === "abort-pending") return "正在向 Windows 撤销关机请求，请核实结果";
  if (state.status === "abort-failed") return "关机撤销失败，系统可能仍会关机 · 请立即检查 Windows";
  if (state.status === "shutdown-unknown") return "Windows 关机结果不明，可能仍会关机 · 请立即检查";
  if (state.status === "shutdown-sending" || state.status === "shutdown-preparing") return "正在准备/发送关机请求 · 仍可取消";
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

/**
 * 判不清的时候把原因和一整晚的「没关」绑在一起，攒够十分钟就说一声。
 * 为什么要说：按定好的规矩，看不清就不关，但只关不说，早上只会看到
 * 「关机又坏了」，不知道是它自己决定不关。
 */
async function noteBlind(sdk, state, verdict, now) {
  const blind = Array.isArray(verdict?.blind) ? verdict.blind.filter(Boolean) : [];
  if (!blind.length) {
    state.blind = null;
    state.blindSince = null;
    state.blindNotified = false;
    return;
  }
  state.blind = blind;
  if (!state.blindSince) state.blindSince = now;
  if (state.blindNotified === true) return;
  if (now - state.blindSince < BLIND_NOTICE_MS) return;
  state.blindNotified = true;
  const text = blind.join("；");
  await pushLog(sdk, { kind: "blind", at: new Date(now).toISOString(), reasons: blind });
  await notify(
    sdk,
    "知意 · 今晚大概不会关机",
    `看不清 Hana 是不是已经闲下来（${text}），所以没关。这是你定的规矩：拿不准就不关，文件丢不了。`,
  );
}

async function fire(sdk, idleMs) {
  const state = runtime.state;
  // 并发采样（旧的那次超时不取消、新的又进来了）可能同时判出「该关了」。
  // 只许先到的那一处开倒计时，后面跟上的直接作废。
  if (!state || state.status !== "watching") return;
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

  // 采样期间可能已经被取消、重新挂上或重载过，回包到了也不能接着算。
  if (runtime?.state !== state || state.status !== "countdown") return;
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
/**
 * Spawn a Windows shutdown command. Exit 0 means the request was accepted,
 * NOT that the computer has shut down or an abort is guaranteed to succeed.
 * A timeout is UNKNOWN, not success. The process is killed on timeout.
 * Inject spawnProcess in unit tests; do not execute shutdown.exe in tests.
 */
export function runShutdownProcess(args, { spawnProcess = spawn, timeoutMs = 6_000 } = {}) {
  return new Promise((resolve) => {
    let child = null;
    let timer = null;
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...outcome, stdout: stdout.slice(0, 200), raw: stderr.slice(0, 200) });
    };
    try {
      // spawn() is synchronous up to process creation: callers can atomically
      // check their current state and initiate the command without an await.
      child = spawnProcess("shutdown.exe", args, {
        env: buildShutdownEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (error) => finish({
        ok: false,
        code: null,
        detail: String(error?.message || error).slice(0, 160),
      }));
      child.on("exit", (code) => finish({
        ok: code === 0,
        code,
        detail: `退码 ${code}`,
      }));
      timer = setTimeout(() => {
        try { child.kill?.(); } catch {}
        finish({ ok: false, code: null, timedOut: true, detail: "shutdown.exe 6 秒内未返回，结果不明" });
      }, timeoutMs);
      timer.unref?.();
    } catch (error) {
      finish({ ok: false, code: null, detail: String(error?.message || error).slice(0, 160) });
    }
  });
}

/** 真的下手；只有倒计时还有效时才允许送出系统命令。 */
export async function executeShutdown(sdk, options = {}) {
  const state = runtime?.state;
  if (!state || state.status !== "countdown") return;
  const summary = state.lastSummary;

  if (state.dryRun) {
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

  // Preparation is cancellable. Never send the shutdown after asynchronous
  // logging, notifications or storage if the user cancelled or rearmed.
  state.status = "shutdown-preparing";
  state.result = "shutdown-preparing";
  stopTimer();
  await pushLog(sdk, {
    kind: "shutdown-preparing",
    at: new Date().toISOString(),
    idleMs: state.firedIdleMs,
    graceMs: state.graceMs,
    sessionsTotal: summary?.sessions?.total ?? null,
    tasksTotal: summary?.tasks?.total ?? null,
  });
  await notify(sdk, "知意 · 正在请求关机", `已通过最终空闲检测，正在请求系统安排关机。\n\n${SAVE_REMINDER}`);
  await save(sdk);
  if (runtime?.state !== state || state.status !== "shutdown-preparing") return;

  // Persist the ambiguous sending state BEFORE launching the process. A crash
  // between spawn() and the next save must still be recoverable on reload.
  state.status = "shutdown-sending";
  state.result = "shutdown-sending";
  state.firedAt = Date.now();
  await save(sdk);
  if (runtime?.state !== state || state.status !== "shutdown-sending") return;

  // No await between the final state check and process creation. If cancel is
  // invoked later, it will see shutdown-issued and attempt a real system abort.
  state.status = "shutdown-issued";
  state.result = "shutdown-issued";
  let completion;
  try {
    const command = ["/s", "/t", "30", "/c", SHUTDOWN_COMMENT];
    const runner = typeof options.commandRunner === "function" ? options.commandRunner : runShutdownProcess;
    completion = Promise.resolve(runner(command));
  } catch (error) {
    completion = Promise.resolve({ ok: false, detail: String(error?.message || error).slice(0, 160) });
  }
  await save(sdk);
  let outcome;
  try {
    outcome = await completion;
  } catch (error) {
    outcome = { ok: false, detail: String(error?.message || error).slice(0, 160) };
  }
  await pushLog(sdk, {
    kind: outcome?.ok === true ? "shutdown-accepted" : outcome?.timedOut ? "shutdown-unknown" : "shutdown-failed",
    at: new Date().toISOString(),
    code: outcome?.code ?? null,
    detail: String(outcome?.detail || "未知结果").slice(0, 160),
  });
  // An abort may have finished while shutdown.exe was exiting; do not overwrite
  // its result or resurrect an old guard after rearm/dispose.
  if (runtime?.state !== state || state.status !== "shutdown-issued") return;
  if (outcome?.ok === true) {
    state.result = "shutdown-accepted";
    await sdk.logger?.info?.("Windows 已接受关机请求，30 秒窗口内可撤销");
  } else {
    state.status = outcome?.timedOut ? "shutdown-unknown" : "shutdown-failed";
    state.result = state.status;
    await sdk.logger?.warn?.(`Windows 关机命令未获确认：${String(outcome?.detail || "未知错误").slice(0, 160)}`);
    await notify(
      sdk,
      outcome?.timedOut ? "知意 · 关机结果不明" : "知意 · 关机命令失败",
      outcome?.timedOut
        ? "系统命令超时，无法确认是否安排了关机；请检查 Windows 的关机提示。"
        : `系统没有确认安排关机：${String(outcome?.detail || "未知错误").slice(0, 100)}`,
    );
  }
  await save(sdk);
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
  const sessionsKnown = summary?.sessions?.readable === true
    && summary?.sessions?.complete !== false;
  // 会话层瞎了就是看不见 Code 页以外的一切，不能当成「它们都空着」
  const sessionUnknownBusy = sessionsKnown ? 0 : 1;
  // 事件层刚开张（App 刚重载）时账本是空的，但这不代表没人干活：
  // 重载不会让 Code 页那一段正在跑的东西停下来。这种「空」不能当成真空。
  // 只有它确实报出了忙才计入（那种情况下拦是对的）。
  const eventsUncertain = summary?.events?.readable === false || (
    summary?.events?.readable === true &&
    summary?.events?.warmingUp === true &&
    Number(summary?.events?.busyCount || 0) === 0
  );
  const eventsUnknownBusy = eventsUncertain ? 1 : 0;
  const busyCount = Number(summary?.busyCount || 0) + taskBusy + sessionUnknownBusy;

  // 看不清的原因是给人看的：昨晚为什么没关，得能一句话说清。
  const blind = [];
  if (!tasksKnown) blind.push("后台任务读不到");
  if (summary?.sessions?.readable !== true) blind.push("会话名单读不到");
  else if (summary?.sessions?.complete === false) {
    const candidates = Number(summary?.sessions?.candidateCount || 0);
    const probed = Number(summary?.sessions?.probedCount || 0);
    const left = Math.max(0, candidates - probed);
    blind.push(left > 0 ? `有 ${left} 段会话没查完` : "会话扫描不完整");
  }
  if (eventsUncertain) {
    blind.push(summary?.events?.readable === false ? "窗口事件这一层读不到" : "窗口事件账本还在预热");
  }

  if (!tasksKnown || !sessionsKnown || eventsUncertain || busyCount > 0) {
    return {
      busy: true,
      tasksKnown,
      sessionsKnown,
      eventsUncertain,
      blind,
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
    return { busy: false, tasksKnown, sessionsKnown, eventsUncertain: false, blind: [], busyCount: 0, idleSince, idleMs, fire: true, expire: false };
  }
  // 空下来才轮得上计时；等着等着超过最长等待就放弃，但不推翻刚满的那一下。
  const expire = Boolean(state?.armedAt) && now - Number(state.armedAt) >= Number(state.maxWaitMs || 0);
  return { busy: false, tasksKnown, sessionsKnown, eventsUncertain: false, blind: [], busyCount: 0, idleSince, idleMs, fire: false, expire };
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

  if (runtime !== rt || rt.state !== state || state.status !== "watching") return;
  const now = Date.now();
  state.lastCheckAt = now;
  state.lastSummary = summary;

  const verdict = judgeIdle(state, summary, now);
  state.degraded = !verdict.tasksKnown;
  state.idleSince = verdict.idleSince;
  // 先记账再判：到底是谁拦着不让关，得留下来。
  await noteBusyChange(sdk, state, summary, verdict.busyCount, now);
  if (runtime !== rt || rt.state !== state || state.status !== "watching") return;
  if (verdict.busy) {
    state.lastBusyAt = now;
    await noteBlind(sdk, state, verdict, now);
    return;
  }
  state.blind = null;
  state.blindSince = null;
  state.blindNotified = false;
  if (verdict.fire) {
    await fire(sdk, verdict.idleMs);
    return;
  }
  if (verdict.expire) await expire(sdk);
}

async function tickOnce(sdk) {
  if (tickInFlight) return;
  tickInFlight = true;
  let timer = null;
  try {
    // 采样里有一段宿主 RPC 没有自己的超时（tasks.list）。它挂着不回来时，
    // 单飞锁会把后面每一次采样都挡掉，看上去「还在守」，其实早就停了。
    await Promise.race([
      tick(sdk),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`一次采样超过 ${TICK_TIMEOUT_MS / 1000} 秒没回来`)), TICK_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    const brief = String(error?.message || error).slice(0, 160);
    await sdk.logger?.warn?.(`守门采样失败：${brief}`);
    if (runtime?.state) {
      runtime.state.lastCheckAt = Date.now();
      runtime.state.stalled = brief;
    }
  } finally {
    if (timer) clearTimeout(timer);
    tickInFlight = false;
  }
}

function startTimer(sdk) {
  stopTimer();
  const timer = setInterval(() => void tickOnce(sdk), SAMPLE_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  runtime.timer = timer;
  void tickOnce(sdk);
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
  if (runtime?.state && MAY_HAVE_SHUTDOWN.has(runtime.state.status)) {
    throw new Error("先前的系统关机请求尚未确认撤销，不能重新挂上来覆盖危险状态；请先取消并核实 Windows。 ");
  }
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

/** A /t 30 request may only be aborted during its original 30-second window. */
export function withinAbortWindow(state, now = Date.now()) {
  const firedAt = Number(state?.firedAt);
  return Number.isFinite(firedAt) && firedAt > 0 && now >= firedAt && now - firedAt < 30_000;
}

/**
 * 系统这次启动发生在什么时候（毫秒）。拿不到返回 null。
 *
 * 为什么需要它：一条「关机已发出」的记录会一直躺在磁盘上等谁去销账。
 * 可机器真被关掉那一刻，App 没有任何机会写「已完成」——下次开机读到这条
 * 旧记录，按 30 秒窗口只能判成「不明」，然后一遍遍报警。
 * 系统启动时刻晚于发令时刻，本身就是那次关机已经走完的铁证。
 *
 * 快速启动（hiberboot）在部分机器上不重置 uptime，那时算出的启动时刻偏早，
 * 判不出「重启过」，于是退回原来的保守路径：宁可多报一次不明，
 * 也不会把没关成的说成已关成。
 */
export function estimateBootTime(now = Date.now(), uptimeSeconds = null) {
  let seconds = uptimeSeconds;
  if (seconds === null || seconds === undefined) {
    try {
      seconds = os.uptime();
    } catch {
      return null;
    }
  }
  const uptimeMs = Number(seconds) * 1000;
  if (!Number.isFinite(uptimeMs) || uptimeMs <= 0) return null;
  const boot = Number(now) - uptimeMs;
  return Number.isFinite(boot) && boot > 0 ? boot : null;
}

/** 发令之后系统重启过吗？重启过就说明那次关机已经完成。 */
export function rebootedSince(timestampMs, options = {}) {
  const firedAt = Number(timestampMs);
  if (!Number.isFinite(firedAt) || firedAt <= 0) return false;
  let boot = null;
  if (typeof options.bootTimeProvider === "function") {
    try {
      boot = Number(options.bootTimeProvider());
    } catch {
      boot = null;
    }
  } else {
    boot = estimateBootTime();
  }
  if (!Number.isFinite(boot) || boot <= 0) return false;
  return boot > firedAt;
}

const MAY_HAVE_SHUTDOWN = new Set([
  "shutdown-sending", "shutdown-issued", "shutdown-unknown", "abort-pending", "abort-failed",
]);
let abortInFlight = false;

/**
 * Cancel locally until process handoff, or actually abort the Windows request.
 * Failed /a NEVER becomes "cancelled". A second click may retry within /t 30.
 */
export async function cancelSleepGuard(sdk, reason = "", options = {}) {
  const state = runtime?.state;
  if (!state) return { armed: false, cancelled: false };
  if (abortInFlight) {
    return { armed: true, cancelled: false, wasIssued: true, pending: true, reason: "关机撤销仍在执行" };
  }
  const wasIssued = MAY_HAVE_SHUTDOWN.has(state.status);
  const wasWatching = state.status === "watching" || state.status === "countdown" || state.status === "shutdown-preparing";
  if (!wasIssued && !wasWatching) {
    return { armed: false, cancelled: false, reason: "当前没有可以撤销的守门" };
  }
  stopTimer();
  const cancelReason = String(reason || "手动取消").slice(0, 120);
  state.cancelReason = cancelReason;
  state.lastCheckAt = Date.now();

  if (!wasIssued) {
    // The preparation path checks this state again before starting shutdown.exe.
    state.status = "cancelled";
    state.result = "cancelled";
    await save(sdk);
    await pushLog(sdk, { kind: "cancelled", at: new Date().toISOString(), reason: cancelReason });
    return { armed: false, cancelled: true, wasIssued: false, abort: null, reason: cancelReason };
  }

  if (!withinAbortWindow(state)) {
    // Do not run a late /a: it could cancel somebody else's unrelated shutdown.
    const abort = { ok: false, detail: "原关机请求的 30 秒撤销窗口已过或时间戳不可信；未执行 shutdown /a" };
    state.status = "abort-failed";
    state.result = "shutdown-abort-failed";
    state.abort = abort;
    await save(sdk);
    await pushLog(sdk, { kind: "shutdown-abort-window-expired", at: new Date().toISOString(), reason: cancelReason });
    await notify(sdk, "知意 · 关机撤销窗口已过", "无法确认原关机请求是否还在执行，请立即检查 Windows 状态。");
    return { armed: true, cancelled: false, wasIssued: true, abort, reason: cancelReason };
  }

  abortInFlight = true;
  try {
    state.status = "abort-pending";
    state.result = "shutdown-abort-pending";
    await save(sdk);
    let abort;
    try {
      abort = await abortSystemShutdown(sdk, options);
    } catch (error) {
      abort = { ok: false, detail: String(error?.message || error).slice(0, 160) };
    }
    if (runtime?.state === state && state.status === "abort-pending") {
      state.status = abort?.ok === true ? "cancelled" : "abort-failed";
      state.result = abort?.ok === true ? "shutdown-aborted" : "shutdown-abort-failed";
      state.abort = abort;
      await save(sdk);
      await pushLog(sdk, {
        kind: abort?.ok === true ? "cancelled" : "cancel-failed",
        at: new Date().toISOString(),
        reason: cancelReason,
      });
    }
    return {
      armed: abort?.ok !== true,
      cancelled: abort?.ok === true,
      wasIssued: true,
      abort,
      reason: cancelReason,
    };
  } finally {
    abortInFlight = false;
  }
}

/**
 * /a is a global Windows action: it can cancel another program's shutdown.
 * Call ONLY while this guard has a recent, persisted shutdown attempt.
 * The tests inject options.commandRunner; no actual Windows shutdown is needed.
 */
export async function abortSystemShutdown(sdk, options = {}) {
  let outcome;
  try {
    const runner = typeof options.commandRunner === "function" ? options.commandRunner : runShutdownProcess;
    outcome = await runner(["/a"]);
  } catch (error) {
    outcome = { ok: false, detail: String(error?.message || error).slice(0, 160) };
  }
  await pushLog(sdk, {
    kind: outcome?.ok === true ? "shutdown-aborted" : "shutdown-abort-failed",
    at: new Date().toISOString(),
    detail: String(outcome?.detail || "未知原因").slice(0, 160),
    ...(outcome?.raw ? { raw: outcome.raw } : {}),
  });
  await sdk.logger?.[outcome?.ok === true ? "info" : "warn"]?.(
    outcome?.ok === true ? "系统关机请求已撤销" : `系统关机撤销未获确认：${String(outcome?.detail || "未知原因").slice(0, 160)}`,
  );
  if (outcome?.ok === true) {
    await notify(sdk, "知意 · 已撤销系统关机", "Windows 已确认取消待执行的关机请求。");
  } else {
    await notify(sdk, "知意 · 关机撤销没有成功", `${String(outcome?.detail || "未知原因").slice(0, 120)}。系统可能仍会关机，请立即检查。`);
  }
  return outcome;
}

/**
 * 人工核实系统里确实没有待执行的关机之后，把危险状态清掉。
 * 为什么必须有这个口：abort-failed 和 shutdown-unknown 会拦住新的 arm，
 * 而重载又会把它们恢复成同一种“不明”，不给人一个出口就只能永远挂不上。
 */
export async function clearSleepGuardWarning(sdk, reason = "") {
  const state = runtime?.state;
  const status = String(state?.status || "");
  if (!state || (status !== "shutdown-unknown" && status !== "abort-failed")) {
    return { cleared: false, reason: "当前没有需要人工解除的关机警告" };
  }
  state.status = "cleared";
  state.result = "cleared-by-user";
  state.abort = null;
  state.cancelReason = String(reason || "人工核实系统里没有待执行的关机").slice(0, 120);
  state.lastCheckAt = Date.now();
  await pushLog(sdk, { kind: "cleared", at: new Date().toISOString(), reason: state.cancelReason });
  await save(sdk);
  await notify(sdk, "知意 · 关机警告已解除", "按你的确认清掉了上一轮的关机记录，可以重新挂了。系统里要是还有待执行的关机，得先去取消。");
  return { cleared: true, state: describeSleepGuard() };
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
 * Recover after App reload. Never resume an in-progress countdown blindly.
 * A persisted shutdown attempt is handled as an emergency recovery path:
 * try /a only within the original 30-second window; otherwise report unknown.
 */
export async function restoreSleepGuard(sdk, options = {}) {
  let stored = null;
  try {
    stored = await sdk.storage.global.get(SLEEP_GUARD_STATE_KEY, null);
  } catch {
    return { restored: false };
  }
  if (!stored || !stored.armedAt) return { restored: false };

  if (stored.status === "countdown" || stored.status === "shutdown-preparing") {
    // shutdown-preparing cannot have spawned a command; execution rechecks
    // current state immediately before entering the sending state.
    if (!runtime) runtime = { state: baseState(), timer: null };
    stopTimer();
    runtime.state = { ...baseState(), ...stored, status: "cancelled", result: "reload-dropped" };
    await save(sdk);
    await pushLog(sdk, { kind: "dropped", at: new Date().toISOString(), reason: "重载中断了倒计时或关机准备" });
    return { restored: false, recovered: true, state: describeSleepGuard() };
  }

  if (MAY_HAVE_SHUTDOWN.has(stored.status)) {
    if (!runtime) runtime = { state: baseState(), timer: null };
    stopTimer();
    // 先查「那次关机到底发生过没有」。系统启动时刻晚于发令时刻，就说明这中间
    // 机器重启过，关机早就走完了。此时再按 30 秒窗口去撤一个已经不在的请求，
    // 只会拿到「没有正在进行的关机」，还把这笔旧账升级成「撤销失败」的警告。
    //
    // 2026-11-05 实机：11-03 00:24 发出的关机当晚就关成了，App 没机会销账；
    // 此后每次重载都把这条旧记录当新账报（08:13 / 09:00 / 11:24），用户点取消
    // 反而变成「关机撤销失败，系统可能仍会关机」。系统启动时间是零副作用的铁证：
    // 只读，不发命令，碰不到别人的关机请求。
    const bootAt = rebootedSince(stored.firedAt, options) ? estimateBootTime() : null;
    if (bootAt) {
      runtime.state = {
        ...baseState(),
        armedAt: Number.isFinite(Number(stored.armedAt)) ? Number(stored.armedAt) : null,
        status: "shutdown-done",
        result: "shutdown-completed-before-restore",
        firedAt: stored.firedAt,
        lastCheckAt: Date.now(),
        cancelReason: "上次关机已完成（系统在那之后重启过）",
      };
      await pushLog(sdk, {
        kind: "shutdown-completed",
        at: new Date().toISOString(),
        firedAt: stored.firedAt,
        bootAt,
        reason: "系统在发令之后重启过，上次关机已完成",
      });
      await save(sdk);
      return { restored: false, recovered: true, completed: true, state: describeSleepGuard() };
    }
    runtime.state = { ...baseState(), ...stored };
    if (withinAbortWindow(stored)) {
      const cancellation = await cancelSleepGuard(sdk, "App 重载后优先撤销未确认的关机请求", options);
      return { restored: false, recovered: true, abort: cancellation.abort, state: describeSleepGuard() };
    }
    runtime.state.status = "shutdown-unknown";
    runtime.state.result = "reload-abort-window-expired";
    // 同一笔旧账只报一次。横幅仍然挂着，人看得见；反复弹通知只会让人以为
    // 又出了新问题。换了新的 firedAt（新一次关机）才重新报。
    const reportedBefore = Number(stored.reportedFiredAt) > 0
      && Number(stored.reportedFiredAt) === Number(stored.firedAt);
    runtime.state.reportedFiredAt = stored.firedAt;
    await save(sdk);
    await pushLog(sdk, { kind: "shutdown-recovery-uncertain", at: new Date().toISOString(), reason: "已超过可安全执行 /a 的 30 秒范围" });
    if (!reportedBefore) {
      await notify(sdk, "知意 · 上次关机状态不明", "App 重载时发现关机请求记录，但撤销窗口已过。未执行可能影响其他程序的 shutdown /a；请核对 Windows 状态。");
    }
    return { restored: false, recovered: true, uncertain: true, state: describeSleepGuard() };
  }
  if (stored.status === "shutdown-failed") {
    if (!runtime) runtime = { state: baseState(), timer: null };
    stopTimer();
    runtime.state = { ...baseState(), ...stored };
    return { restored: false, recovered: true, state: describeSleepGuard() };
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
