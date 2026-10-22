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

async function notify(sdk, title, body) {
  try {
    if (typeof sdk.notifications?.show !== "function") return false;
    await sdk.notifications.show({ title, body });
    return true;
  } catch (error) {
    await sdk.logger?.warn?.(`守门通知没弹出来：${String(error?.message || error).slice(0, 120)}`);
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
  };
}

/** 对外的一份简读：面板和工具都看这个，不暴露内部计时器。 */
export function describeSleepGuard() {
  const state = runtime?.state ? { ...runtime.state } : null;
  if (!state) return { armed: false, state: null };
  const now = Date.now();
  const armed = state.status === "watching" || state.status === "countdown";
  return {
    armed,
    state,
    idleForMs: armed && state.idleSince ? now - state.idleSince : 0,
    sinceArmedMs: state.armedAt ? now - state.armedAt : 0,
    progress: armed && state.idleSince ? Math.min(1, (now - state.idleSince) / state.idleMs) : 0,
    countdownLeftMs: state.status === "countdown" && state.shutdownAt ? Math.max(0, state.shutdownAt - now) : 0,
  };
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
    state.dryRun
      ? `${clockText} 起已经 ${minutesText(idleMs)}没有窗口或任务在跑（${windowsText}，${tasksText}）。演练：${minutesText(state.graceMs)}后到这里就会关，这期间一有动静就自动收手。`
      : `${clockText} 起已经 ${minutesText(idleMs)}没有窗口或任务在跑（${windowsText}，${tasksText}）。这 ${minutesText(state.graceMs)}里只要还有动静就会自动收手。`,
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
    await notify(sdk, "知意 · 演练：本来这时候就关了", "倒计时走完，窗口和后台任务一直空着。这次没真关。");
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
  await notify(sdk, "知意 · 这就关机了", "活都干完了，好好睡。");
  await save(sdk);

  try {
    const { spawn } = await import("node:child_process");
    // 不要 detached：第一次实机（2026-10-19 23:51）就是带着 detached 静默失败，
    // 事件日志里连一条 1074 都没有。现在把 stdout/stderr 与退码全部记下来。
    const child = spawn("shutdown.exe", ["/s", "/t", "30"], { env: buildShutdownEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
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
 * 任务层读不到时永远按「忙」算，这是这个功能唯一不能妥协的地方。
 */
export function judgeIdle(state, summary, now) {
  const tasksKnown = summary?.tasks?.readable === true;
  const taskBusy = tasksKnown ? Number(summary?.tasks?.active || 0) : 1;
  const busyCount = Number(summary?.busyCount || 0) + taskBusy;

  if (!tasksKnown || busyCount > 0) {
    return { busy: true, tasksKnown, busyCount, idleSince: null, idleMs: 0, fire: false, expire: false };
  }

  const idleSince = Number(state?.idleSince) || now;
  const idleMs = now - idleSince;
  if (idleMs >= Number(state?.idleMs || 0)) {
    return { busy: false, tasksKnown, busyCount: 0, idleSince, idleMs, fire: true, expire: false };
  }
  // 空下来才轮得上计时；等着等着超过最长等待就放弃，但不推翻刚满的那一下。
  const expire = Boolean(state?.armedAt) && now - Number(state.armedAt) >= Number(state.maxWaitMs || 0);
  return { busy: false, tasksKnown, busyCount: 0, idleSince, idleMs, fire: false, expire };
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
  return describeSleepGuard();
}

/** 撤掉守门。任何理由都能撤。 */
export async function cancelSleepGuard(sdk, reason = "") {
  const state = runtime?.state;
  if (!state) return { armed: false, cancelled: false };
  const wasWatching = state.status === "watching" || state.status === "countdown";
  stopTimer();
  state.status = "cancelled";
  state.cancelReason = String(reason || "手动取消").slice(0, 120);
  state.lastCheckAt = Date.now();
  await pushLog(sdk, { kind: "cancelled", at: new Date().toISOString(), reason: state.cancelReason });
  await save(sdk);
  return { armed: false, cancelled: wasWatching, reason: state.cancelReason };
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
