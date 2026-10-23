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

// 子代理（subagent）会话不是用户窗口：它们由伙伴自己派出去干活，没有「用户要不要续接」
// 这件事，也不该在球上弹一张「某个窗口没说完」的卡。2026-10-19 实机：一次派发 4 个子代理，
// 四段会话各自在 90 秒后被判卡住，连弹四张续接卡。
const SUBAGENT_PATH_RE = /[\\/]subagent-sessions[\\/]/i;
const SUBAGENT_KINDS = new Set(["subagent", "subagent_child", "subagent-child"]);

/** 事件/钩子只给路径时，用它挡在记账之前。 */
export function isSubagentSessionPath(sessionPath = "") {
  return SUBAGENT_PATH_RE.test(String(sessionPath || ""));
}

/**
 * 会话条目或复核结果里带着路径、kind、provenance 任一条，都能认出来。
 * 真实调用路径上：session:list 的条目带 path 与 kind（kind 可能为 null），所以主要靠 path，
 * kind 次之；provenance 目前只有直接传对象时才有（session:list 不带这一列），
 * 留着是给将来宿主补字段时的现成口子，不拿它当唯一依据。
 */
export function isSubagentSessionTarget(target = {}) {
  if (!target || typeof target !== "object") return false;
  if (isSubagentSessionPath(target.path || target.sessionPath)) return true;
  const kind = String(target.kind || "").trim().toLowerCase();
  if (SUBAGENT_KINDS.has(kind)) return true;
  if (kind.startsWith("subagent")) return true;
  const createdBy = String(target.provenance?.createdBy || "").trim().toLowerCase();
  return createdBy === "subagent";
}

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

/**
 * 宿主的两套编号：事件给的 sessionPath 文件名、hook 给的 sessionId（sess_xxx）。
 * 续接状态机只认一个 key，否则「开始时记了 A、恢复时清了 B」，两边永远对不上。
 * 这里按 session:list 的条目建双向索引，让两侧都能落到 sessionId 上。
 */
export function buildSessionIndex(entries) {
  const byId = new Map();
  const byPath = new Map();
  // 第三本账：裸 UUID。
  // 实机（2026-10-17）看到的现象是：bus 事件回调的 sessionPath 有时是空的，
  // 于是 sessionId 只剩事件自带的那串 "01a14908-bc69-..."；而 session:list 给的
  // 稳定编号是 "sess_0mvc7z5bx_8d43..."，两边都对不上。结果提醒标题、伙伴名全空，
  // 显示成「一个还没标题的对话」，用户根本不知道是哪段对话断了。
  // 文件名里那个 UUID 是两套编号唯一共同的锚点，所以单独建一本按 UUID 查的账。
  const byUuid = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    const sessionId = String(entry.sessionId || entry.session_id || "").trim();
    const path = String(entry.path || entry.sessionPath || "").trim();
    const info = {
      sessionId,
      path,
      title: String(entry.title || "").trim(),
      firstMessage: String(entry.firstMessage || "").trim(),
      agentId: String(entry.agentId || "").trim(),
      agentName: String(entry.agentName || "").trim(),
      // kind 用来认子代理会话（subagent_child）；session:list 有这一列，别丢。
      kind: String(entry.kind || "").trim(),
      // provenance 不在 session:list 条目里（只有 manifest 有），这里透传一层：
      // 调用方自己带过来时认得，带不过来也不影响 path/kind 两条。
      provenance: entry.provenance && typeof entry.provenance === "object" ? entry.provenance : null,
      modified: toMillis(entry.modified),
    };
    if (sessionId) byId.set(sessionId, info);
    const base = path ? pathBaseName(path) : "";
    if (base) byPath.set(base, info);
    const uuid = sessionUuidOf(path) || sessionUuidOf(base);
    if (uuid) byUuid.set(uuid, info);
  }
  return { byId, byPath, byUuid };
}

function pathBaseName(sessionPath) {
  return String(sessionPath || "").split(/[\\/]/).pop().replace(/\.jsonl$/i, "");
}

/** 从路径、文件名或编号里抠出标准 UUID（带连字符那种）。抠不出返回空串。 */
export function sessionUuidOf(value) {
  const match = String(value || "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match ? match[0].toLowerCase() : "";
}

/** session:list 的 modified 有秒也有毫秒，统一成毫秒；认不出返回 0。 */
export function toMillis(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/** 按 sessionId 优先、路径其次，在索引里找这条会话。找不到返回 null。 */
export function lookupSession(index, { sessionId = "", sessionPath = "" } = {}) {
  if (!index) return null;
  const id = String(sessionId || "").trim();
  if (id && index.byId?.has(id)) return index.byId.get(id);
  const base = pathBaseName(sessionPath);
  if (base && index.byPath?.has(base)) return index.byPath.get(base);
  if (base && index.byId?.has(base)) return index.byId.get(base);
  // 最后一道：两边都只剩 UUID 时靠它对齐（sessionPath 为空时就走这里）。
  for (const candidate of [id, base, sessionPath]) {
    const uuid = sessionUuidOf(candidate);
    if (uuid && index.byUuid?.has(uuid)) return index.byUuid.get(uuid);
  }
  return null;
}

/**
 * 复核用：这条会话在 startedAt 之后有没有被写过。
 * 卡住兜底不能只信 hook 计时——宿主一次 RPC 限流就能把「已出正文」的记账吞掉。
 */
export function sessionWrittenSince(info, startedAt, slackMs = 1_000) {
  const modified = toMillis(info?.modified);
  const start = Number(startedAt) || 0;
  if (!modified || !start) return false;
  return modified > start + Math.max(0, Number(slackMs) || 0);
}

/**
 * 卡住复核的结论。三种动作：recovered（有进展，作废计时）、wait（拿不到证据，不报）、report（确证没进展）。
 *
 * 为什么多一个 wait：session:list 超时会沿用旧索引（index.js 的 readResumeSessionIndex），
 * 旧索引里的 modified 是过期值。拿过期 modified 跑 sessionWrittenSince，得到的 false
 * 只说明「这份快照里没更新」，不说明「这一轮没进展」。2026-10-18 已观察到工具轮中误报，
 * 但原日志不足以证明当次使用了旧快照；这里修复的是已能用合成输入复现的证据失效漏洞。
 * 证据不新鲜或缺少必要时间，都不能据此断言没有进展。
 */
export function reviewStuckCandidate(candidate, { target = null, indexStale = false } = {}) {
  if (!target) return { action: "wait", reason: "unknown-session" };
  if (indexStale) return { action: "wait", reason: "stale-index" };
  if (!toMillis(target.modified) || !Number.isFinite(candidate?.startedAt) || candidate.startedAt <= 0) {
    return { action: "wait", reason: "missing-timing" };
  }
  if (sessionWrittenSince(target, candidate?.startedAt)) return { action: "recovered", reason: "written-since" };
  return { action: "report", reason: "no-progress" };
}

/**
 * 小条上「来自哪儿」的说法：窗口名 → 伙伴名 → 这段对话开头那句话。
 * 最后那层是给「宿主还没给这段对话标题」的情况准备的：只写「一个还没标题的对话」
 * 等于什么都没说，用户既认不出是哪个窗，也没法判断要不要接。用开头几个字至少能对上号。
 */
export function describeResumeSource({ title = "", agentName = "", firstMessage = "", openedAt = "" } = {}) {
  const windowTitle = String(title || "").trim();
  const agent = String(agentName || "").trim();
  if (windowTitle && agent) return `来自窗口：${windowTitle}（${agent}）`;
  if (windowTitle) return `来自窗口：${windowTitle}`;
  if (agent) return `来自：${agent} 的对话`;
  const opening = openingSnippet(firstMessage);
  if (opening) return `来自：一段还没起名的对话（开头是「${opening}」）`;
  const clock = String(openedAt || "").trim();
  if (clock) return `来自：${clock} 开的那段对话`;
  return "来自：一段还没起名的对话";
}

/** 把首条消息压成一句能认人的开头，最多 16 个字。 */
export function openingSnippet(text, limit = 16) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const chars = [...flat];
  return chars.length > limit ? `${chars.slice(0, limit).join("")}…` : flat;
}

/**
 * 会话文件名开头印着 UTC 时间（2026-10-17T08-44-31-721Z_<uuid>.jsonl）。
 * 侧栏就是按这个时间排序的，所以转成本地「今天 16:44」后用户一眼能对上号。
 * 解析不出来就返回空串，不编时间；同一段对话不管调多少次都是同一个结果。
 */
export function openedAtSnippet(sessionPathOrId, now = Date.now()) {
  const raw = String(sessionPathOrId || "");
  const match = raw.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (!match) return "";
  const [, y, mo, d, h, mi, s, ms] = match;
  const at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(ms));
  if (!Number.isFinite(at)) return "";
  const then = new Date(at);
  const today = new Date(now);
  const sameDay = then.getFullYear() === today.getFullYear()
    && then.getMonth() === today.getMonth()
    && then.getDate() === today.getDate();
  const hh = String(then.getHours()).padStart(2, "0");
  const mm = String(then.getMinutes()).padStart(2, "0");
  if (sameDay) return `今天 ${hh}:${mm}`;
  return `${then.getMonth() + 1} 月 ${then.getDate()} 日 ${hh}:${mm}`;
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
  // 断点续接整体默认关：它会主动向别人的对话里插话，默认开着等于替用户拿主意。
  // 已经显式存过 enabled 的配置不受影响，只影响没有这个字段的新安装。
  enabled: false,
  // 自动续接默认关：它每发一次就是一次真实模型调用，会花钱也占上下文，必须由用户自己开。
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
    // 只有显式 true 才开：没写过这个字段的旧配置一律按「关」处理。
    enabled: raw.enabled === true,
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
 *
 * 两套编号的账在这里必须合成一本：钩子给的是 sess_xxx 稳定编号，事件里可能只剩
 * 文件名或裸 UUID。上层查到对应关系后调 registerAlias，之后两边自动落到同一个键，
 * 否则「开始时记了 A、正常收尾时清了 B」，卡住兜底会把好好的会话当成断联。
 */
export function createResumeTracker(options = {}) {
  const { now = () => Date.now() } = options;
  // 注意：cooldownMs 传 0 是合法的（测试里用于去掉冷却），不能用 || 取默认值。
  const numberOr = (value, fallback) => (value === undefined || value === null || !Number.isFinite(Number(value)) ? fallback : Number(value));
  // 这几个是可变的：设置改了以后要在同一个状态机上生效，重建会把已续次数清零。
  let autoResume = options.autoResume === true;
  let maxConsecutive = numberOr(options.maxConsecutive, RESUME_MAX_CONSECUTIVE);
  let cooldownMs = numberOr(options.cooldownMs, RESUME_COOLDOWN_MS);
  let stuckTimeoutMs = numberOr(options.stuckTimeoutMs, STUCK_TURN_TIMEOUT_MS);
  let awaitingTimeoutMs = numberOr(options.awaitingTimeoutMs, STUCK_TURN_TIMEOUT_MS);
  const states = new Map();
  const aliases = new Map();

  /** 任何编号 → 当前认得的那个稳定编号（可多级跳，带环保护）。 */
  function canonical(id) {
    let current = keyOf(id);
    const seen = new Set();
    while (aliases.has(current) && !seen.has(current)) {
      seen.add(current);
      current = aliases.get(current);
    }
    return current;
  }

  function stateOf(key) {
    const id = canonical(key);
    let state = states.get(id);
    if (!state) {
      state = { startedAt: 0, producedAt: 0, consecutive: 0, lastResumeAt: 0, reported: false, pending: null, agentId: "", awaiting: null, awaitingFailed: null, settled: false };
      states.set(id, state);
    }
    return state;
  }

  /** 卡住候选：到点了还既没正文也没收尾，只报不记（复核由上层做）。 */
  function stuckCandidates(nowMs) {
    const stuck = [];
    for (const [id, state] of states) {
      if (!state.startedAt || state.producedAt || state.pending) continue;
      // 已经在等「继续哈」的回复、已经报过、或已经判失败：这几条各有自己的判定路径。
      // 让卡住兜底再插一脚，会把「宿主写了一次会话」当成故障轮已恢复，然后永远不再判它。
      if (state.awaiting || state.awaitingFailed || state.reported) continue;
      if (nowMs - state.startedAt < stuckTimeoutMs) continue;
      stuck.push({ sessionId: id, agentId: state.agentId || "", startedAt: state.startedAt });
    }
    return stuck;
  }

  function markStuck(sessionId) {
    const state = states.get(canonical(keyOf(sessionId)));
    if (!state || state.pending) return null;
    state.pending = { at: state.startedAt || now(), kind: "stuck" };
    return state;
  }

  return {
    /**
     * 改设置而不重开局：states、aliases、已续几次、等待中的状态全留着。
     * 之前这里只改外层 config，resolve 用的还是建状态机那一刻的旧值——
     * 用户把自动打开，行为却没变；把上限调到 1，也照样发满三次。
     */
    configure(config = {}) {
      if (typeof config.autoResume === "boolean") autoResume = config.autoResume;
      if (Number.isFinite(Number(config.maxConsecutive))) {
        maxConsecutive = Math.min(10, Math.max(1, Math.round(Number(config.maxConsecutive))));
      }
      if (Number.isFinite(Number(config.cooldownMs))) cooldownMs = Number(config.cooldownMs);
      if (Number.isFinite(Number(config.stuckTimeoutMs))) stuckTimeoutMs = Number(config.stuckTimeoutMs);
      if (Number.isFinite(Number(config.awaitingTimeoutMs))) awaitingTimeoutMs = Number(config.awaitingTimeoutMs);
      return { autoResume, maxConsecutive, cooldownMs, stuckTimeoutMs, awaitingTimeoutMs };
    },
    /**
     * 登记「这两个编号说的是同一段对话」。
     * 调用方在 session:list 里查到时顺手登记一次即可；已有状态一并搬过去，
     * 不然迁移前那半轮计时会丢在旧键上，换个键重新开始计时。
     */
    registerAlias(fromId, toId) {
      const from = String(fromId || "").trim();
      const to = String(toId || "").trim();
      if (!from || !to || from === to) return;
      aliases.set(from, to);
      const old = states.get(from);
      if (old && from !== to) {
        states.delete(from);
        const target = states.get(to);
        if (!target) states.set(to, old);
        else {
          // 两边都有账时取「更晚开始、更大失败数」的那份，别把已经续过的次数清零。
          if (old.startedAt > target.startedAt) target.startedAt = old.startedAt;
          target.consecutive = Math.max(target.consecutive, old.consecutive);
          target.reported = target.reported || old.reported;
          if (!target.pending && old.pending) target.pending = old.pending;
          // 等待中的那一发与「故障轮未结束」也要搬：只搬计数的话，
          // 换号之后那一发就没人等了，等同于把已发出去的续接当成没发生过。
          if (!target.awaiting && old.awaiting) target.awaiting = old.awaiting;
          if (!target.awaitingFailed && old.awaitingFailed) target.awaitingFailed = old.awaitingFailed;
          target.settled = target.settled && old.settled;
        }
      }
    },
    /** 给上层看当前认得的稳定编号。 */
    canonicalId(sessionId = "") {
      return canonical(sessionId);
    },
    /** agent/before-start：这一轮开始了。 */
    markStarted(sessionId, agentId = "") {
      const state = stateOf(keyOf(sessionId, agentId));
      state.startedAt = now();
      state.producedAt = 0;
      state.pending = null;
      state.reported = false;
      // 「新的一轮开始」是宿主在跑我们发的那句「继续哈」——等待的对象就是它，
      // 所以 awaiting 不能在这里清掉，否则故障轮永远等不到判定，进度会永远停在 1/N。
      // 真正清故障的是上层处理用户新消息时调 forget。
      state.settled = false;
      state.agentId = String(agentId || state.agentId || "");
      return state;
    },
    /** messages/post-assistant：这一轮出了正文，卡住计时作废。 */
    markProduced(sessionId, agentId = "") {
      const state = stateOf(keyOf(sessionId, agentId));
      state.producedAt = now();
      state.pending = null;
      // 工具中间轮有正文只证明有进展；继续等最终结果，并从最新进展重新计时。
      if (state.awaiting) state.awaiting.at = now();
      return state;
    },
    /** 正常收尾：把连续失败计数清零。 */
    markRecovered(sessionId, agentId = "") {
      const state = stateOf(keyOf(sessionId, agentId));
      state.consecutive = 0;
      state.reported = false;
      state.pending = null;
      state.producedAt = now();
      state.awaiting = null;
      state.awaitingFailed = null;
      state.pausedAt = 0;
      state.settled = true;
      state.sent = 0;
      return state;
    },
    /** 宿主在自动重试：这期间不能抢着续接。
     * 还要把本地那一发的倒计时按住：宿主已经在自己重试了，我们再数一遍等于双份计时。 */
    markRetrying(sessionId, agentId = "") {
      const state = stateOf(keyOf(sessionId, agentId));
      state.pending = { at: now(), kind: "retrying" };
      state.pausedAt = now();
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
      state.settled = false;
      // 新的异常信号 = 宿主那次重试确实没成，按住的地方可以松了。
      state.pausedAt = 0;
      if (isUserInitiatedAbortReason(signal?.reason)) return { action: "ignore", reason: "用户自己停的", ...signal, attempt: state.consecutive };
      return { action: "wait", reason: "先等宿主重试", ...signal, attempt: state.consecutive };
    },
    /** 等够时间后再问一次：这次到底续不续。 */    resolve(key) {
      const id = canonical(keyOf(key?.sessionId, key?.agentId));
      const state = states.get(id);
      // awaiting/awaitingFailed 自带判据，不靠 pending 撑着：发送失败那条路会把 pending 清掉。
      if (!state || (!state.pending && !state.awaiting && !state.awaitingFailed)) {
        return { action: "ignore", reason: "没有待决信号" };
      }
      // 零、宿主在自己重试：本地那一发的倒计时按住，等它明确失败或成功再说。
      if (state.pausedAt && !state.awaitingFailed) {
        return { action: "ignore", reason: "宿主自己在重试", sessionId: id, attempt: state.consecutive };
      }
      // 一、上一发还在等结果：发送成功不等于恢复，没等到就不许再发。
      if (state.awaiting) {
        if (now() - state.awaiting.at < awaitingTimeoutMs) {
          return { action: "wait", reason: "等上一发的真实结果", sessionId: id, attempt: state.consecutive };
        }
        // 等到上限还没正文：这一次算没成，但不能立刻补发，先转成待决往下走。
        state.awaiting = null;
        state.startedAt = now();
        state.producedAt = 0;
        state.pending = { at: now() - RESUME_AUTO_DELAY_MS, kind: "abnormal", failed: true };
      }
      // 二、发送本身没送出去：不占成功次数，但也不再后台重发，等人处理。
      if (state.awaitingFailed) {
        state.awaitingFailed = null;
        state.pending = null;
        state.reported = true;
        return { action: "report", reason: "上一发没送出去", sessionId: id, attempt: state.consecutive };
      }
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
    /** 「继续哈」发出去了：开始等真实结果，不立即当失败。 */
    markAwaiting(sessionId, agentId = "") {
      const state = stateOf(keyOf(sessionId, agentId));
      state.pending = null;
      state.settled = false;
      state.awaiting = { at: now(), attempt: state.consecutive };
      // 真的发出去一句就算一句：手动单发也要能被球上写成「已发送继续哈」，
      // 不能拿失败计数（手动时恒为 0）冒充进度。
      state.sent = (state.sent || 0) + 1;
      return state;
    },
    /** 发送 RPC 本身失败：不算成功次数，也不后台重发。 */
    failAwaiting(sessionId, agentId = "", reason = "") {
      const state = stateOf(keyOf(sessionId, agentId));
      state.awaiting = null;
      state.awaitingFailed = { at: now(), reason: String(reason || "") };
      state.pending = null;
      // 这句没送出去，不算发过。
      state.sent = Math.max(0, (state.sent || 0) - 1);
      return state;
    },
    /** 总开关关掉时清干净：待决动作、旧提醒、等待中的发数一并作废。 */
    clearAll() {
      states.clear();
    },
    /** 给面板与设置页看的进度项；status: waiting | failed | limit。
     *  waiting 不只表示「刚发出去在等」，还包括「已经续过几次、这一轮还没真的说回来」——
     *  新一轮开始时 markStarted 会清掉 awaiting，所以要靠 settled 记住故障轮还没结束，
     *  不然自动续接刚开始，1/3 的进度就被藏了。 */
    progressItems(nowMs = now()) {
      const items = [];
      for (const [id, state] of states) {
        let status = "";
        let at = 0;
        if (state.awaiting) {
          status = "waiting";
          at = state.awaiting.at;
        } else if (state.awaitingFailed) {
          status = "failed";
          at = state.awaitingFailed.at;
        } else if (state.reported) {
          // 手动提醒没有消耗自动次数，不把 0/N 说成达到上限。
          if (!autoResume) continue;
          status = state.consecutive >= maxConsecutive ? "limit" : "failed";
          at = state.lastResumeAt || state.startedAt || nowMs;
        } else if (state.consecutive > 0 && !state.settled && state.startedAt) {
          status = "waiting";
          at = state.startedAt || nowMs;
        } else {
          continue;
        }
        items.push({ sessionId: id, attempt: state.consecutive, maxConsecutive, status, at, sent: state.sent || 0 });
      }
      return items;
    },
    /**
     * 卡住兜底：到点了还既没正文也没收尾的候选，只报不记。
     * 上层要先复核（这条会话是不是真的没再写过），确认了再 markStuck。
     */
    stuckCandidates(nowMs = now()) {
      return stuckCandidates(nowMs);
    },
    /** 复核通过：把这条记成待决，后面 resolve 才会动手。 */
    markStuck(sessionId = "") {
      return markStuck(sessionId);
    },
    /** 卡住兜底：到点了还既没正文也没收尾。 */
    checkStuck(nowMs = now()) {
      return stuckCandidates(nowMs).map((candidate) => {
        markStuck(candidate.sessionId);
        return { sessionId: candidate.sessionId, agentId: candidate.agentId };
      });
    },
    /** 只读快照，给设置页与传音樱面板显示。 */
    snapshot(sessionId = "") {
      const id = canonical(keyOf(sessionId));
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
      // 等待中和发送失败都要能被上层拿到：pending 被清掉后 resolve 仍得有机会跑一次。
      return [...states.entries()]
        .filter(([, state]) => state.pending || state.awaiting || state.awaitingFailed)
        .map(([id]) => id);
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
      states.delete(canonical(keyOf(sessionId)));
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