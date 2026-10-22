// lib/voice-replies.js — 朗读目标：从会话里取「要念哪一句」
//
// 判定模板照知识卡片 kc-debug-朗读目标与回复一致性：
// 列表请求记下 sessionId，合成请求必须显式带着同一个 sessionId 与 entryId 回来；
// 定位不到就报错，不静默改念另一条。只靠「第 N 条」重算是错的——新回复一插进来就是另一条。
//
// 读历史只能按 sessionId（实机诊断 2026-10-12：光给 sessionPath 一律被宿主拒）。

import { cleanReadableText, extractReadableText, MAX_REPLY_CHARS, REPLY_HISTORY_LIMIT } from "./voice.js";
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

/**
 * 读对话时间线。
 *
 * 优先用 session:entries：它是全量条目，长对话能拿到尾部（2026-10-22 实机：
 * 这段对话 600 多条消息，session:history 只回开头 200 条，朗读列表里的「最新」
 * 永远是我好几轮前的回复）。entries 是树形结构，所以要沿 parentId 把当前分支
 * 回溯成一条线，不能直接按数组顺序排。
 * 拿不到 entries 时退回 history（短对话够用）。
 */
async function readTimeline(sdk, sessionId) {
  try {
    const raw = await sdk.bus.request("session:entries", { sessionId, scope: "all" }, { timeoutMs: 15_000 });
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.entries) ? raw.entries : []);
    if (list.length) {
      const byId = new Map();
      let newest = null;
      for (const entry of list) {
        const id = String(entry?.id || entry?.entryId || "");
        if (!id) continue;
        byId.set(id, entry);
        const stamp = String(entry?.timestamp || "");
        if (!newest || stamp > String(newest?.timestamp || "")) newest = entry;
      }
      const chain = [];
      const seen = new Set();
      let cursor = newest;
      while (cursor) {
        const id = String(cursor?.id || cursor?.entryId || "");
        if (!id || seen.has(id)) break;
        seen.add(id);
        chain.push(cursor);
        cursor = byId.get(String(cursor?.parentId || "")) || null;
      }
      chain.reverse();
      const messages = [];
      for (const entry of chain) {
        const role = entry?.role ?? entry?.message?.role;
        if (role !== "user" && role !== "assistant") continue;
        messages.push({
          role,
          entryId: String(entry?.id || entry?.entryId || ""),
          content: entry?.content ?? entry?.message?.content ?? "",
          timestamp: String(entry?.timestamp || ""),
        });
      }
      if (messages.length) {
        await sdk.logger?.info?.(`朗读数据源：entries / 条目 ${list.length} / 分支上消息 ${messages.length} 条`);
        return messages;
      }
    }
  } catch (error) {
    await sdk.logger?.info?.(`朗读数据源 entries 不可用：${String(error?.message || error).slice(0, 140)}`);
  }
  const history = await readHistory(sdk, sessionId);
  return Array.isArray(history?.messages) ? history.messages : [];
}

/** 固定了某段对话就用它，没固定才取最近活跃。名字从名单里补，读不到也不影响朗读。 */
async function resolveTargetInfo(sdk, sessionId) {
  if (!sessionId) return pickMostActiveSession(sdk);
  try {
    const result = await sdk.bus.request("session:list", { scope: "all" }, { timeoutMs: SESSION_LIST_TIMEOUT_MS });
    const sessions = Array.isArray(result) ? result : result?.sessions;
    const hit = (Array.isArray(sessions) ? sessions : []).find(
      (item) => String(item?.sessionId ?? item?.session_id ?? "") === sessionId,
    );
    if (hit) {
      return {
        sessionPath: typeof (hit?.path || hit?.sessionPath) === "string" ? (hit.path || hit.sessionPath) : "",
        sessionId,
        agentId: String(hit?.agentId || ""),
        agentName: String(hit?.agentName || "").trim(),
        currentTitle: String(hit?.title || "").trim(),
        modified: Number(hit?.modified) || 0,
      };
    }
  } catch {
    // 名单读不到也能直接用编号读历史；名字缺就按没名字处理。
  }
  return { sessionId, sessionPath: "", agentId: "", agentName: "", currentTitle: "" };
}

/**
 * 取最近若干条伙伴回复，供设置页与传音樱朗读窗选择。
 *
 * 按「一轮」聚合，而不是按每条消息列：
 * 一轮里我常常分几次说话（先给方案、工具跑完再补一句、最后收尾），
 * 逐条列出来的话，列表里全是同一轮切开的碎片，最新的一句反而被埋在下面。
 * 一轮的边界用「你的话」划分：你的话之后、下一次你的话之前的全部回复算一轮。
 */
export async function listSpeakableReplies(sdk, { sessionId = "", limit = 8 } = {}) {
  const target = await resolveTargetInfo(sdk, String(sessionId || "").trim());
  const messages = await readTimeline(sdk, target.sessionId);
  const wanted = Math.min(Math.max(Number(limit) || 8, 1), 20);

  const rounds = [];
  let current = null;
  for (const message of messages) {
    const role = message?.role;
    if (role === "user") {
      current = { entryIds: [], texts: [] };
      rounds.push(current);
      continue;
    }
    if (role !== "assistant") continue;
    if (!current) { current = { entryIds: [], texts: [] }; rounds.push(current); }
    const entryId = String(message.entryId || message.entry_id || "").trim();
    const visible = cleanReadableText(messageText(message));
    if (!visible) continue;
    current.entryIds.push(entryId);
    current.texts.push(visible);
  }

  const replies = [];
  let roundCount = 0;
  let emptyCount = 0;
  const samples = [];
  for (let index = rounds.length - 1; index >= 0 && replies.length < wanted; index -= 1) {
    const round = rounds[index];
    roundCount += 1;
    if (!round.entryIds.length) { emptyCount += 1; continue; }
    const text = round.texts.join("\n\n");
    if (samples.length < 12) samples.push(`${round.texts.length}段/${text.length}字`);
    replies.push({
      // entryId 保留给还按单条走的调用方；entryIds 才是这一轮的全量。
      entryId: round.entryIds[0],
      entryIds: [...round.entryIds],
      index,
      // 「最新」由后端说了算：这个函数是从后往前收的，第一个 push 进来的就是最新一轮。
      // 前端不许再按数组下标自己猜（2026-10-22 实机：面板把最后一条标成「最新」，点开念的却是最旧一轮）。
      isLatest: replies.length === 0,
      preview: text.slice(0, 120),
      // 朗读前也要能先看到字（实机：选了回复、窗口里是空的，得等合成完才有）。
      // 只带一段，不带整篇：六条加起来还得过桥的 64KB 上限；1200 字也比朗读上限 800 长。
      text: text.slice(0, 1200),
      truncated: text.length > 1200,
      chars: text.length,
    });
  }
  // 只记数字，不记正文：列表为什么只列得出两条，只能从这几个计数上看出来。
  await sdk.logger?.info?.(`朗读列表统计：会话 ${target.sessionId || "未绑定"} / ${target.currentTitle || "无标题"} / 读到 ${messages.length} 条消息 / 轮次 ${roundCount} / 空轮 ${emptyCount} / 列出 ${replies.length} 轮 / 最近几轮 ${samples.join(" ")}`);
  // 唯一要记的正文片段（24 字）：用来判定宿主到底把「最近 200 条」还是「最早 200 条」给了我们。
  // 只靠条数看不出方向：读满配额时两种都可能，而方向一错，「最新回复」就是永远看不到的那一头。
  const tailAssistant = [...messages].reverse().find((message) => message?.role === "assistant" && cleanReadableText(messageText(message)));
  if (tailAssistant) {
    await sdk.logger?.info?.(`朗读列表末条：${cleanReadableText(messageText(tailAssistant)).slice(0, 24)}`);
  }
  return {
    session: target,
    // 从后往前收的，最近的就在数组前面：列表要最新的在上面。
    replies,
  };
}

/**
 * 合成目标：优先按 entryId 在同一段对话里认回复；认不到就报错。
 * 直接传 text 的入口只留给连通测试与自定义文本，不给「念最近一条」这种含糊语义开口子。
 */
export async function resolveSpeakTarget(sdk, { sessionId = "", entryId = "", entryIds = [], text = "" } = {}) {
  const inline = String(text || "").trim();
  const target = sessionId
    ? await resolveTargetInfo(sdk, String(sessionId).trim())
    : await pickMostActiveSession(sdk);

  const list = Array.isArray(entryIds)
    ? entryIds.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  // 整轮列表优先；没给列表时才回落到单个编号。
  const ids = list.length ? list : (entryId ? [String(entryId).trim()] : []);
  if (!ids.length) {
    if (inline) {
      return { ...target, entryId: "", entryIds: [], raw: inline, source: "custom" };
    }
    throw new Error("没说要念哪一句：给一条回复的编号，或者直接给要念的文字。");
  }
  if (!String(sessionId).trim()) {
    throw new Error("只知道回复编号、不知道属于哪段对话，已经停下不念了。重新打开朗读列表再选一次。");
  }

  const messages = await readTimeline(sdk, target.sessionId);
  const picked = [];
  for (const id of ids) {
    const hit = messages.find((message) => String(message?.entryId || message?.entry_id || "").trim() === id);
    if (!hit || hit.role !== "assistant") {
      throw new Error("这条回复已经不在原对话里了（可能刚被删或换了窗口），重新打开列表再选一次。");
    }
    picked.push(hit);
  }
  // 一轮里我可能分几次说话，合成时要把这几段按顺序接起来念。
  const raw = picked.map((message) => messageText(message)).join("\n\n");
  if (!cleanReadableText(raw)) throw new Error("这条回复没有可以朗读的正文。");
  return { ...target, entryId: ids[0], entryIds: ids, raw, source: "reply" };
}

/** 按配置的范围（整条 / 只念引号台词）与长度上限取出真正要念的文本。 */
export function prepareSpeakText(raw, config) {
  return extractReadableText(raw, config?.scope, config?.maxChars);
}

/**
 * 取一条回复（或一整轮）的完整可读正文，给「改稿」用。
 * 列表里的 text 只带前 1200 字（桥有 64KB 上限），长回复在编辑器里会缺后半截，
 * 删完保存就等于把后半截默默跳过。所以进编辑页时要单独要一次全文。
 */
export async function readFullReplyText(sdk, { sessionId = "", entryId = "", entryIds = [] } = {}) {
  const target = await resolveSpeakTarget(sdk, { sessionId, entryId, entryIds });
  const text = cleanReadableText(target.raw);
  return { text, chars: text.length, entryId: target.entryId, entryIds: target.entryIds };
}

/**
 * 改过稿的朗读：稿子是用户亲手删改的，不再套「只念引号」与字数上限——
 * 否则她删完一半再被默默截一刀，白改了。只清掩码与空白，再留一道防呆硬上限。
 */
export function prepareDraftText(raw) {
  const text = cleanReadableText(raw);
  const limit = MAX_REPLY_CHARS * 10;
  const truncated = text.length > limit;
  return { text: truncated ? text.slice(0, limit) : text, matched: true, truncated };
}
