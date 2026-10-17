// lib/voice-replies.js — 朗读目标：从会话里取「要念哪一句」
//
// 判定模板照知识卡片 kc-debug-朗读目标与回复一致性：
// 列表请求记下 sessionId，合成请求必须显式带着同一个 sessionId 与 entryId 回来；
// 定位不到就报错，不静默改念另一条。只靠「第 N 条」重算是错的——新回复一插进来就是另一条。
//
// 读历史只能按 sessionId（实机诊断 2026-10-12：光给 sessionPath 一律被宿主拒）。

import { cleanReadableText, extractReadableText, REPLY_HISTORY_LIMIT } from "./voice.js";
import { pickMostActiveSession } from "./session-title.js";

const SESSION_LIST_TIMEOUT_MS = 8_000;

function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

async function readHistory(sdk, sessionId) {
  try {
    return await sdk.sessions.history({ sessionId, scope: "all", limit: REPLY_HISTORY_LIMIT });
  } catch (error) {
    throw new Error(`读不到这段对话的内容：${error?.message || error}`);
  }
}

/** 取最近若干条伙伴回复，供设置页与传音樱朗读窗选择。 */
export async function listSpeakableReplies(sdk, { sessionId = "", limit = 8 } = {}) {
  const target = sessionId
    ? { sessionId, sessionPath: "", agentId: "", agentName: "", currentTitle: "" }
    : await pickMostActiveSession(sdk);
  const history = await readHistory(sdk, target.sessionId);
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  const wanted = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const replies = [];
  for (let index = messages.length - 1; index >= 0 && replies.length < wanted; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const raw = messageText(message);
    if (!raw.trim()) continue;
    const visible = cleanReadableText(raw);
    if (!visible) continue;
    replies.push({
      entryId: String(message.entryId || message.entry_id || "").trim(),
      index,
      preview: visible.slice(0, 120),
      chars: visible.length,
    });
  }
  return {
    session: target,
    replies: replies.reverse(),
  };
}

/**
 * 合成目标：优先按 entryId 在同一段对话里认回复；认不到就报错。
 * 直接传 text 的入口只留给连通测试与自定义文本，不给「念最近一条」这种含糊语义开口子。
 */
export async function resolveSpeakTarget(sdk, { sessionId = "", entryId = "", text = "" } = {}) {
  const inline = String(text || "").trim();
  const target = sessionId
    ? { sessionId, sessionPath: "", agentId: "", agentName: "", currentTitle: "" }
    : await pickMostActiveSession(sdk);

  if (!entryId) {
    if (inline) {
      return { ...target, entryId: "", raw: inline, source: "custom" };
    }
    throw new Error("没说要念哪一句：给一条回复的编号，或者直接给要念的文字。");
  }
  if (!String(sessionId).trim()) {
    throw new Error("只知道回复编号、不知道属于哪段对话，已经停下不念了。重新打开朗读列表再选一次。");
  }

  const history = await readHistory(sdk, target.sessionId);
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  const hit = messages.find((message) => String(message?.entryId || message?.entry_id || "").trim() === entryId);
  if (!hit || hit.role !== "assistant") {
    throw new Error("这条回复已经不在原对话里了（可能刚被删或换了窗口），重新打开列表再选一次。");
  }
  const raw = messageText(hit);
  if (!cleanReadableText(raw)) throw new Error("这条回复没有可以朗读的正文。");
  return { ...target, entryId, raw, source: "reply" };
}

/** 按配置的范围（整条 / 只念引号台词）与长度上限取出真正要念的文本。 */
export function prepareSpeakText(raw, config) {
  return extractReadableText(raw, config?.scope, config?.maxChars);
}
