// 传音樱的「目标会话」：跟随最近活跃 / 固定某一段。
//
// 这里只做纯计算：把宿主名单归一成候选、决定当前该作用于哪一段对话。
// 真正读名单、写固定状态、生成推荐都由调用方负责（App 侧 lib/ball-bridge.js）。
//
// 只取 path/sessionId/title/agentName/modified 这几个字段，不读任何对话内容。

export const RECENT_SESSION_LIMIT = 5;

function cleanText(value, limit) {
  if (typeof value !== "string") return "";
  return [...value]
    .filter((char) => { const code = char.codePointAt(0); return code >= 0x20 && code !== 0x7f; })
    .join("")
    .trim()
    .slice(0, limit);
}

function toTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

/** 一条会话候选：只保留球要用到的字段，认不出编号的直接丢弃。 */
export function normalizeSessionCandidate(raw) {
  const item = raw && typeof raw === "object" ? raw : {};
  const sessionId = String(item.sessionId ?? item.session_id ?? "").trim();
  if (!sessionId) return null;
  return {
    sessionId,
    sessionPath: cleanText(item.sessionPath || item.path || "", 500),
    title: cleanText(item.title || "", 120),
    agentId: cleanText(item.agentId || "", 120),
    agentName: cleanText(item.agentName || "", 120),
    modified: toTimestamp(item.modified ?? item.updatedAt ?? item.modifiedAt),
  };
}

/** 最近活跃的若干段对话，按 modified 倒序，去重、限长。 */
export function pickRecentSessions(list, limit = RECENT_SESSION_LIMIT) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const picked = [];
  for (const raw of list) {
    const candidate = normalizeSessionCandidate(raw);
    if (!candidate || seen.has(candidate.sessionId)) continue;
    seen.add(candidate.sessionId);
    picked.push(candidate);
  }
  picked.sort((a, b) => b.modified - a.modified);
  const cap = Number.isInteger(limit) && limit >= 0 ? limit : RECENT_SESSION_LIMIT;
  return picked.slice(0, cap);
}

/** 固定状态归一：只有 mode=pinned 且带得出编号时才算固定，其余一律按跟随处理。 */
export function normalizeBallTargetState(raw) {
  const item = raw && typeof raw === "object" ? raw : {};
  const pinned = normalizeSessionCandidate(item.pinned);
  const mode = item.mode === "pinned" && pinned ? "pinned" : "auto";
  return { mode, pinned: mode === "pinned" ? pinned : null };
}

/**
 * 当前该作用于哪一段对话：
 * 固定且还在名单里 → 用名单里的那条（标题可能已被改新）；
 * 固定但已不在最近 5 个里 → 仍按固定走，标记 stale，让界面如实说明；
 * 跟随 → 取最近活跃的一条；名单为空 → null。
 */
export function resolveTargetSession(state, sessions) {
  const normalized = normalizeBallTargetState(state);
  const list = pickRecentSessions(sessions, RECENT_SESSION_LIMIT);
  if (normalized.mode === "pinned" && normalized.pinned) {
    const match = list.find((row) => row.sessionId === normalized.pinned.sessionId);
    return match ? { ...match, mode: "pinned", stale: false } : { ...normalized.pinned, mode: "pinned", stale: true };
  }
  return list.length ? { ...list[0], mode: "auto", stale: false } : null;
}

/** 固定状态写盘时的形状：只留可重建的字段，不夹带会话内容。 */
export function toPinnedRecord(candidate) {
  const normalized = normalizeSessionCandidate(candidate);
  if (!normalized) return null;
  return {
    sessionId: normalized.sessionId,
    sessionPath: normalized.sessionPath,
    title: normalized.title,
    agentId: normalized.agentId,
    agentName: normalized.agentName,
  };
}
