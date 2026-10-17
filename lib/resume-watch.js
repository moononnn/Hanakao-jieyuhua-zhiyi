// lib/resume-watch.js — 知意「断联续接」的判定与状态机（纯逻辑，可单元测试）
//
// 分工（2026-10-14 与用户敲定）：**异常提醒归提个醒，知意只管续接**。
// 所以这里做检测但不生产通知文案弹窗：事件解析照提个醒 lib/event-parse.js 的实机口径搬过来，
// 差异只有两点——
//   ① 不再 fs 扫会话文件，全部只用 bus 事件里的 sessionPath/agentId；
//   ② 判定结果只喂给续接状态机，最多在「续接几次都没成」时由上层报一次。
//
// 一条重要边界：App 拿不到「宿主内部正在生成」的状态，卡住兜底只能靠
// agent/before-start 与 messages/post-assistant 的时间差，所以它天生会误判
// 用户主动按停——文案因此必须留余地，不能断言「出错了」。

export const RESUME_TEXT = "继续哈";
export const RESUME_GRACE_MS = 2_500;          // 失败候选先等一会儿，看宿主是否自己进重试
export const STUCK_TURN_TIMEOUT_MS = 90_000;   // 开头多久没正文算卡住
export const RESUME_COOLDOWN_MS = 60_000;      // 同一会话两次续接之间的间隔
export const RESUME_MAX_CONSECUTIVE = 3;       // 连续多少次续接没成后停手
export const RESUME_AUTO_DELAY_MS = 4_000;     // 确认不是宿主重试之后再动手

const USER_ABORT_REASONS = new Set([
  "abort", "abort_all", "close", "close_all", "user_abort",
  "user_cancel", "user_cancelled", "user_canceled",
]);

/** 会话与伙伴标识从 bus 给的路径里认，不去扫文件。 */
export function sessionIdFromPath(sessionPath) {
  if (!sessionPath || typeof sessionPath !== "string") return "";
  const base = String(sessionPath).split(/[\\/]/).pop() || "";
  return base.replace(/\.jsonl$/i, "");
}

export function agentIdFromSessionPath(sessionPath) {
  if (!sessionPath || typeof sessionPath !== "string") return "";
  const match = String(sessionPath).match(/[\\/]agents[\\/]([^\\/]+)[\\/]sessions[\\/]/i);
  return match ? match[1] : "";
}

/** 用户明确停止/关闭时不当作故障，也不该触发续接。 */
export function isUserInitiatedAbortReason(reason) {
  return USER_ABORT_REASONS.has(String(reason || "").trim().toLowerCase());
}

function errorText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  const nested = errorText(value.message || value.errorMessage || value.error || value.reason);
  const codeValue = value.code ?? value.http_code ?? value.status;
  const code = codeValue === undefined || codeValue === null ? "" : String(codeValue).trim();
  if (nested) return code && !nested.includes(code) ? `${code}: ${nested}` : nested;
  return code;
}

function messageError(message) {
  if (!message || typeof message !== "object") return "";
  return errorText(message.errorMessage) || errorText(message.error);
}

/** 助手正文：只认真正的文字块，工具调用不算「说完了」。 */
export function assistantTextOf(message) {
  if (!message || typeof message !== "object") return "";
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim())
    .map((part) => part.text.trim())
    .join("\n")
    .trim();
}

function turnEndInfo(event, sessionPath) {
  const agentId = String(event?.agentId || agentIdFromSessionPath(sessionPath) || "");
  const sessionId = sessionIdFromPath(sessionPath) || String(event?.sessionId || "");
  const content = Array.isArray(event?.message?.content) ? event.message.content : [];
  const hasToolCall = content.some((part) => part?.type === "toolCall");
  const stopReason = event?.message?.stopReason || event?.stopReason || null;
  return {
    agentId,
    sessionId,
    sessionPath: sessionPath || null,
    text: assistantTextOf(event?.message),
    hasToolCall,
    stopReason,
    aborted: event?.aborted === true,
    reason: String(event?.reason || "").trim(),
    wasSuccessful: typeof event?.wasSuccessful === "boolean" ? event.wasSuccessful : null,
  };
}

/** 工具循环的中间轮不算结束；最终轮才是 stop 或没有 stopReason。 */
export function isIntermediateToolTurn(info) {
  return info?.stopReason === "toolUse" || (info?.stopReason == null && info?.hasToolCall === true);
}

/**
 * 从 turn_end 里认「异常结束」。
 * 刻意保守：只有 stopReason=error、非用户主动的中断、或 wasSuccessful=false 的最终轮才算。
 * 宁可漏报也不误报——误报会让知意白花一次模型调用去发「继续哈」。
 */
export function parseTurnFailure(event, sessionPath) {
  if (!event || event.type !== "turn_end") return null;
  const info = turnEndInfo(event, sessionPath);
  if (!info.sessionId && !info.agentId) return null;
  if (info.aborted && isUserInitiatedAbortReason(info.reason)) return null;
  const abnormalAbort = info.aborted && !isUserInitiatedAbortReason(info.reason);
  const failedByStatus = info.wasSuccessful === false && !isIntermediateToolTurn(info);
  const failedByReason = info.stopReason === "error";
  if (!abnormalAbort && !failedByStatus && !failedByReason) return null;
  return { ...info, errorMessage: messageError(event.message) || errorText(event.errorMessage) || errorText(event.error) || info.reason };
}

/** 宿主自动重试结束且失败：这是「续接之前就该等一等」的信号。 */
export function parseAutoRetryFailure(event, sessionPath) {
  if (!event || event.type !== "auto_retry_end" || event.success !== false) return null;
  return {
    agentId: String(event.agentId || agentIdFromSessionPath(sessionPath) || ""),
    sessionId: sessionIdFromPath(sessionPath) || String(event?.sessionId || ""),
    sessionPath: sessionPath || null,
    attempt: Number(event.attempt) || 0,
    finalError: errorText(event.finalError) || errorText(event.errorMessage),
  };
}

/** 宿主开始自动重试：这期间知意不能抢着续接。 */
export function parseAutoRetryStart(event, sessionPath) {
  if (!event || event.type !== "auto_retry_start") return null;
  return {
    agentId: String(event.agentId || agentIdFromSessionPath(sessionPath) || ""),
    sessionId: sessionIdFromPath(sessionPath) || String(event?.sessionId || ""),
    sessionPath: sessionPath || null,
    attempt: Number(event.attempt) || 0,
  };
}

/** 会话被强制释放（isStreaming=false 且 aborted）且不是用户自己停的。 */
export function parseSessionAbort(event, sessionPath) {
  if (!event || event.type !== "session_status") return null;
  if (event.isStreaming !== false || event.aborted !== true) return null;
  const reason = String(event.reason || "").trim();
  if (isUserInitiatedAbortReason(reason)) return null;
  return {
    agentId: String(event.agentId || agentIdFromSessionPath(sessionPath) || ""),
    sessionId: sessionIdFromPath(sessionPath) || String(event?.sessionId || ""),
    sessionPath: sessionPath || null,
    reason,
    errorMessage: reason || "会话被提前释放",
  };
}

/**
 * 把一个 bus 事件认成「需要考虑续接」的信号，认不出返回 null。
 * auto_retry_start 只登记「宿主在重试」，不当异常。
 */
export function parseResumeSignal(event, sessionPath) {
  return parseTurnFailure(event, sessionPath)
    || parseAutoRetryFailure(event, sessionPath)
    || parseSessionAbort(event, sessionPath)
    || null;
}

export const DEFAULT_RESUME_CONFIG = Object.freeze({
  // 自动续接默认关：它每发一次就是一次真实模型调用，会花钱也占上下文，必须由用户自己开。
  enabled: true,
  autoResume: false,
  maxConsecutive: RESUME_MAX_CONSECUTIVE,
  cooldownMs: RESUME_COOLDOWN_MS,
  stuckTimeoutMs: STUCK_TURN_TIMEOUT_MS,
});

export function normalizeResumeConfig(value) {
  const raw = value && typeof value === "object" ? value : {};
  const int = (input, min, max, fallback) => {
    const n = Math.round(Number(input));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    enabled: raw.enabled !== false,
    autoResume: raw.autoResume === true,
    maxConsecutive: int(raw.maxConsecutive, 1, 10, DEFAULT_RESUME_CONFIG.maxConsecutive),
    cooldownMs: int(raw.cooldownMs, 10_000, 600_000, DEFAULT_RESUME_CONFIG.cooldownMs),
    stuckTimeoutMs: int(raw.stuckTimeoutMs, 30_000, 300_000, DEFAULT_RESUME_CONFIG.stuckTimeoutMs),
  };
}

/** 会话与伙伴标识从 bus 给的路径里认，不去扫文件。 */

const keyOf = (sessionId, agentId) => String(sessionId || agentId || "unknown");

/**
 * 续接状态机。
 * 记录每个会话「这一轮开了没」「有没有出正文」「续接了几次」，并给出下一步动作。
 * 动作只有三种：wait（再等等）、resume（该发「继续哈」了）、report（续接用尽，该报一次）。
 */
export function createResumeTracker({
  now = () => Date.now(),
  autoResume = false,
  maxConsecutive = RESUME_MAX_CONSECUTIVE,
  cooldownMs = RESUME_COOLDOWN_MS,
  stuckTimeoutMs = STUCK_TURN_TIMEOUT_MS,
} = {}) {
  const states = new Map();

  function stateOf(key) {
    const id = keyOf(key);
    let state = states.get(id);
    if (!state) {
      state = { startedAt: 0, producedAt: 0, consecutive: 0, lastResumeAt: 0, reported: false, pending: null };
      states.set(id, state);
    }
    return state;
  }

  return {
    /** agent/before-start：这一轮开始了。 */
    markStarted(sessionId, agentId = "") {
      const state = stateOf(keyOf(sessionId, agentId));
      state.startedAt = now();
      state.producedAt = 0;
      state.pending = null;
      state.reported = false;
      return state;
    },
    /** messages/post-assistant：这一轮出了正文，卡住计时作废。 */
    markProduced(sessionId, agentId = "") {
      const state = stateOf(keyOf(sessionId, agentId));
      state.producedAt = now();
      state.pending = null;
      return state;
    },
    /** 正常收尾：把连续失败计数清零。 */
    markRecovered(sessionId, agentId = "") {
      const state = stateOf(keyOf(sessionId, agentId));
      state.consecutive = 0;
      state.reported = false;
      state.pending = null;
      state.producedAt = now();
      return state;
    },
    /** 宿主在自动重试：这期间不能抢着续接。 */
    markRetrying(sessionId, agentId = "") {
      const state = stateOf(keyOf(sessionId, agentId));
      state.pending = { at: now(), kind: "retrying" };
      return state;
    },
    /**
     * 收到异常信号 → 该做什么。
     * @returns {{action:"wait"|"resume"|"report"|"ignore", reason:string, sessionId:string, agentId:string, attempt:number}}
     */
    onAbnormal(signal) {
      const key = keyOf(signal?.sessionId, signal?.agentId);
      const state = stateOf(key);
      state.pending = { at: now(), kind: "abnormal", signal };
      if (isUserInitiatedAbortReason(signal?.reason)) return { action: "ignore", reason: "用户自己停的", ...signal, attempt: state.consecutive };
      return { action: "wait", reason: "先等宿主重试", ...signal, attempt: state.consecutive };
    },
    /** 等够时间后再问一次：这次到底续不续。 */
    resolve(key) {
      const id = keyOf(key?.sessionId, key?.agentId);
      const state = states.get(id);
      if (!state || !state.pending) return { action: "ignore", reason: "没有待决信号" };
      const pending = state.pending;
      const elapsed = now() - pending.at;
      if (pending.kind === "retrying") return { action: "ignore", reason: "宿主自己在重试", sessionId: id, attempt: state.consecutive };
      if (elapsed < (pending.kind === "abnormal" ? RESUME_AUTO_DELAY_MS : STUCK_TURN_TIMEOUT_MS)) {
        return { action: "wait", reason: "还没到判断点", sessionId: id, attempt: state.consecutive };
      }
      if (state.reported) return { action: "ignore", reason: "这个会话已经报过了", sessionId: id, attempt: state.consecutive };
      if (!autoResume) {
        state.reported = true;
        return { action: "report", reason: "自动续接没开，只报一次", sessionId: id, attempt: state.consecutive };
      }
      if (state.consecutive >= maxConsecutive) {
        state.reported = true;
        return { action: "report", reason: `连续 ${state.consecutive} 次续接没成`, sessionId: id, attempt: state.consecutive };
      }
      if (state.lastResumeAt && now() - state.lastResumeAt < cooldownMs) {
        return { action: "wait", reason: "冷却中", sessionId: id, attempt: state.consecutive };
      }
      state.consecutive += 1;
      state.lastResumeAt = now();
      state.pending = null;
      return { action: "resume", reason: "发一句「继续哈」", sessionId: id, attempt: state.consecutive };
    },
    /** 「继续哈」发出后、成功出正文前，再异常一次就算这次没成。 */
    noteResumeFailed(sessionId, agentId = "") {
      const state = stateOf(keyOf(sessionId, agentId));
      state.startedAt = now();
      state.producedAt = 0;
      state.pending = { at: now() - RESUME_AUTO_DELAY_MS, kind: "abnormal", failed: true };
      return state;
    },
    /** 卡住兜底：到点了还既没正文也没收尾。 */
    checkStuck(nowMs = now()) {
      const stuck = [];
      for (const [id, state] of states) {
        if (!state.startedAt || state.producedAt || state.pending) continue;
        if (nowMs - state.startedAt < stuckTimeoutMs) continue;
        state.pending = { at: state.startedAt, kind: "stuck" };
        stuck.push({ sessionId: id });
      }
      return stuck;
    },
    /** 只读快照，给设置页与传音樱面板显示。 */
    snapshot(sessionId = "") {      const id = keyOf(sessionId);
      const state = states.get(id);
      if (!state) return { sessionId: id, consecutive: 0, pending: null, reported: false, lastResumeAt: 0 };
      return {
        sessionId: id,
        consecutive: state.consecutive,
        pending: state.pending ? state.pending.kind : null,
        reported: state.reported,
        lastResumeAt: state.lastResumeAt,
      };
    },
    /** 当前有待决信号的会话；定时器靠它决定该问谁。 */
    pendingKeys() {
      return [...states.entries()].filter(([, state]) => state.pending).map(([id]) => id);
    },
    /** 「继续哈」没发出去：把刚记上的那次续接退回去，不白占用户的上限。 */
    rollbackResume(sessionId = "", agentId = "") {
      const state = stateOf(keyOf(sessionId, agentId));
      state.consecutive = Math.max(0, state.consecutive - 1);
      state.lastResumeAt = 0;
      state.pending = null;
      return state;
    },
    forget(sessionId = "") {
      states.delete(keyOf(sessionId));
    },
  };
}

/** 说给用户听的解释：只说现象与下一步，不把内部错误码原话甩出去。 */
export function buildResumeExplanation(signal) {
  const reason = String(signal?.reason || signal?.errorMessage || "").trim();
  const aborted = signal?.aborted === true;
  if (aborted) return "这一轮在说完之前就停住了，可能是连接断了或被中断。";
  if (reason) return "这一轮没能正常收尾。";
  return "这一轮好像停在半路了。";
}