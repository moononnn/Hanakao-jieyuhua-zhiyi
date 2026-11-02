// 追问层：让「这版改了什么」从一张墙变成能对话的东西。
//
// 两种问法都要接住：
//   1) 点了某张卡再问 —— 只喂这张卡引用的那几条原文，答得准、答得短。
//   2) 没点卡直接问 —— 先用问题在这次的窗口版本里找相关条目，找到多少喂多少。
// 这就是为什么不让模型「自由发挥」：它手里只有原文，说出去的话都能翻回去。
//
// 一个刻意的取舍：原文没写的东西，必须说没写。
// 「这次优化了性能吗」这种问题，材料里没有就是没有，不许拿常识补。宁可让用户觉得它笨，
// 也不能让她信一句听着对、实际没发生的话。

import { randomUUID } from "node:crypto";
import { chatModelOptions, normalizeModelRef } from "./ask-model.js";
import { invokeTextModel, resolveTaskModel } from "./custom-model.js";
import { listReleases } from "./handbook-service.js";
import { VOICE_STYLE } from "./voice-style.js";

const HISTORY_LIMIT = 8;
const QUESTION_CHARS = 600;
const MAX_SOURCES = 10;

export class HandbookChatError extends Error {}

export const CHAT_SYSTEM = [
  "你是知意里负责讲 Hana 更新的那个人。对面是不懂技术的普通用户，正看着一张「这版改了啥」的墙，点开其中一条来问你。",
  "回答只依据给你的更新说明原文。原文里没有的，直接说「这版说明里没写」，不要用常识补，不要猜作者的意图。你可以判断、可以推测，但必须说成推断。",
  "说人话：日常词优先，不出现文件名、函数名、字段名、协议缩写。真要提实现，就说「它把东西存在你电脑上」这种。用户说看不懂，下一轮整段重讲，一个技术词都不留。",
  "短。一般两到四句，能一句说完就一句，不列一堆点；不写「根据材料」这类开场。用户明确要「还有哪些」的时候才可以列，最多五条。",
  "用户问「我要不要开」「这对我有用吗」这类，可以给判断，但先说事实再说建议，两件事分开：事实来自原文，建议是你的看法。",
  "用户问一个术语是什么，先用一句日常话讲它是干嘛的，再补一句「跟你日常有没有关系」，没关系就直说没关系，别硬讲。",
  "官方自己写了限制、代价、注意事项的，那一句要带出来。比如「不保证所有细节都会被记住」「模型看到的图可能是压过的」。这是用户最容易被误导的地方。",
  VOICE_STYLE,
].join("\n");

const bigrams = (text) => {
  const clean = String(text || "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, "");
  const out = new Set();
  for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2));
  return out;
};

/** 没点卡直接问时，用问题在窗口版本里捞相关条目。纯字面匹配，不花模型调用。 */
export function selectRelevantItems(releases, tags, question, limit = MAX_SOURCES) {
  const wanted = new Set(Array.isArray(tags) ? tags : []);
  const q = bigrams(question);
  if (!q.size) return [];
  const scored = [];
  for (const release of Array.isArray(releases) ? releases : []) {
    if (wanted.size && !wanted.has(release.tag)) continue;
    for (const section of release.sections || []) {
      for (const group of section.groups || []) {
        for (const item of group.items || []) {
          const hay = bigrams(`${item.title} ${item.detail} ${group.name} ${section.title}`);
          let hit = 0;
          for (const gram of q) if (hay.has(gram)) hit += 1;
          if (!hit) continue;
          scored.push({ score: hit / q.size, item, release, section, group });
        }
      }
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ item, release, section, group }) => ({
    id: item.id,
    tag: release.tag,
    section: section.title,
    group: group.name,
    title: item.title,
    detail: item.detail,
  }));
}

export function buildChatMaterials({ question, card, sources, upgradeNotes }) {
  const lines = [];
  if (card) {
    lines.push(`用户点开的是这张卡：「${card.title}」（${card.tag}）`);
    if (card.now) lines.push(`卡片上写的现在：${card.now}`);
  }
  if (Array.isArray(sources) && sources.length) {
    lines.push("", "这些是支撑它的原文条目：");
    for (const row of sources) {
      lines.push(`- [${row.tag}] ${row.title}${row.detail ? `：${row.detail}` : ""}`);
    }
  }
  if (Array.isArray(upgradeNotes) && upgradeNotes.length) {
    lines.push("", "这一版的官方升级提示（属于注意事项，不是新功能）：");
    for (const note of upgradeNotes.slice(0, 6)) lines.push(`- ${note.title}：${note.detail}`);
  }
  if (!lines.length) lines.push("这次没有匹配到具体条目，说明用户问的事这一版没提到。");
  lines.push("", `用户问：${question}`);
  return lines.join("\n");
}

/**
 * 回答一次追问。
 * history 只带最近几轮，且只带正文：追问用量要可控，不能越聊越贵。
 */
export async function askHandbook(sdk, { question, card = null, tags = [], history = [], timeoutMs = 60000 } = {}) {
  const q = String(question || "").trim().slice(0, QUESTION_CHARS);
  if (!q) throw new HandbookChatError("还没写问题。");

  const releases = await listReleases(sdk);
  let sources = [];
  if (card && Array.isArray(card.items) && card.items.length) {
    const wanted = new Set(card.items);
    for (const release of releases) {
      if (release.tag !== card.tag) continue;
      for (const section of release.sections) {
        for (const group of section.groups) {
          for (const item of group.items) {
            if (wanted.has(item.id)) sources.push({ id: item.id, tag: release.tag, section: section.title, group: group.name, title: item.title, detail: item.detail });
          }
        }
      }
    }
  }
  if (!sources.length) sources = selectRelevantItems(releases, tags, q);

  const upgradeNotes = (releases.find((row) => row.tag === (card?.tag || tags[0])) || {}).upgradeNotes || [];
  const materials = buildChatMaterials({ question: q, card, sources, upgradeNotes });

  const chosen = normalizeModelRef(await sdk.storage.global.get("recommendationModel", null));
  const options = chosen ? chatModelOptions(await sdk.models.list()) : [];
  const hostModel = chosen ? options.find((row) => row.provider === chosen.provider && row.model === chosen.model) : null;
  if (chosen && !hostModel) throw new HandbookChatError("先在知意「模型和接口」里重新选一条可用的内容模型。");
  const resolved = await resolveTaskModel(sdk, { hostModel });
  if (!resolved) throw new HandbookChatError("先在知意「模型和接口」里选内容模型，再问更新的事。");

  const messages = history
    .slice(-HISTORY_LIMIT)
    .map(({ role, content }) => ({ role: role === "assistant" ? "assistant" : "user", content: [{ type: "text", text: String(content).slice(0, 2000) }] }));
  messages.push({ role: "user", content: [{ type: "text", text: materials }] });

  const requestId = `zhiyi_handbook_ask_${randomUUID()}`;
  const call = invokeTextModel(sdk, resolved, {
    requestId,
    systemPrompt: CHAT_SYSTEM,
    messages,
    temperature: 0.3,
    maxTokens: 900,
    timeoutMs,
  });
  let timer;
  let timedOut = false;
  try {
    const text = await Promise.race([
      call,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new HandbookChatError("回答超时了，这次没答上来。"));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
    const content = String(text || "").trim();
    if (!content) throw new HandbookChatError("模型没说话，这次没有回答。");
    return { content: content.slice(0, 4000), model: resolved.name || "内容模型", sources: sources.map((row) => ({ id: row.id, tag: row.tag, title: row.title })) };
  } catch (error) {
    if (timedOut && resolved.kind === "host") await sdk.models.cancel(requestId).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
