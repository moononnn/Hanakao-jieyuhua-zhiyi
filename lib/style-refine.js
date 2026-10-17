// lib/style-refine.js — 推荐方向的「对话式修订」：材料、建议解析、逐条对照、落盘校验
//
// 这套按知识卡片 kc-design-对话式修订建议应用 做：AI 只出建议，用户点「确认修改」才生效；
// 建议卡长在对话流里，带「现在 / 改完以后」对照、单条丢弃、一个总应用按钮；
// 应用落不上就留在原界面让她重试，不静默当成功。
//
// 一条硬约束：配置里的 styles 只有数组下标，没有稳定 id，而下标会因删条漂移。
// 所以对外一律用 planKey（内容派生的稳定键）标识一条方向，落盘时才转回数组。

import { DEFAULT_STYLES, normalizeRecommendationConfig } from "./recommendation-config.js";
import { resolvePolishModel } from "./polish.js";
import { invokeTextModel, resolveTaskModel } from "./custom-model.js";

const REFINE_SYSTEM_PROMPT = [
  "你帮用户调整知意「推荐回复」的方向清单。",
  "只输出 JSON，不要解释、不要寒暄、不要代码块。",
  "保持克制：用户没说清楚就按原样保留；不要为了显得改了很多而重写全部。",
].join("");
const REFINE_TIMEOUT_MS = 60_000;
let requestSequence = 0;

/** 跟用户商量完，出一份可对照的新方向清单。只出建议，不碰配置。 */
export async function refineStyles(sdk, { request = "", maxTokens = 1200 } = {}) {
  const config = normalizeRecommendationConfig(await sdk.storage.global.get("recommendationConfig", {}));
  const model = await resolvePolishModel(sdk);
  const resolved = await resolveTaskModel(sdk, { hostModel: model });
  const requestId = `zhiyi_style_${Date.now().toString(36)}_${(++requestSequence).toString(36)}`;
  let timer;
  let timedOut = false;
  let raw = "";
  try {
    raw = await Promise.race([
      invokeTextModel(sdk, resolved, {
        requestId,
        systemPrompt: REFINE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildRefineMaterial(config, { request }) }],
        temperature: 0.3,
        maxTokens,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          const error = new Error("想的方向有点多，等它想完了就超时了；把话说短一点再试。");
          error.code = "MODEL_TIMEOUT";
          reject(error);
        }, REFINE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (timedOut) { try { await sdk.models.cancel(requestId); } catch {} }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const plan = parseRefinePlan(raw);
  if (!plan.ok) throw new Error(plan.error);
  return { ...plan, config, model: resolved.name };
}


export const STYLE_LIMITS = Object.freeze({ min: 2, max: 6, nameChars: 20, intentChars: 60 });
export const DRAFT_TTL_MS = 30 * 60 * 1000;

function cleanText(value, limit) {
  if (typeof value !== "string") return "";
  const stripped = [...value]
    .filter((char) => { const code = char.codePointAt(0); return code >= 0x20 && code !== 0x7f; })
    .join("");
  return stripped.trim().slice(0, limit);
}

/** planKey：同名同意图 → 同一条；改了内容 → 新的一条。用它做丢弃与对照的锚。 */
export function styleKey(style) {
  const name = cleanText(style?.name, STYLE_LIMITS.nameChars);
  const intent = cleanText(style?.intent, STYLE_LIMITS.intentChars);
  if (!name) return "";
  return `${name}␟${intent}`;
}

/** 给模型的材料：当前清单要摊成可对照的形状，不能只丢一句话让它猜。 */
export function buildRefineMaterial(config, { request = "" } = {}) {
  const normalized = normalizeRecommendationConfig(config);
  const lines = normalized.styles.map((style, index) => {
    const name = cleanText(style.name, STYLE_LIMITS.nameChars);
    const intent = cleanText(style.intent, STYLE_LIMITS.intentChars) || "按方向名理解";
    return `${index + 1}. 名称：${name}｜意图：${intent}`;
  });
  return [
    "（知意 · 推荐方向修订材料）",
    `用户现在的推荐方向共 ${normalized.styles.length} 条，每次给 ${normalized.count} 条：`,
    ...lines,
    "",
    `用户想改的地方：${cleanText(request, 400) || "（用户没说具体诉求）"}`,
    "",
    "要求：",
    `1. 只输出 ${STYLE_LIMITS.min}~${STYLE_LIMITS.max} 条方向；用户没说要改就别乱换，只在确实该改的地方改。`,
    `2. 名称不超过 ${STYLE_LIMITS.nameChars} 字，意图不超过 ${STYLE_LIMITS.intentChars} 字，说人话，别写「多樣性」这种空词。`,
    "3. 原来的清单要尽量保留：没改动的照抄，没要的删掉，用户想要的新增。",
    "4. 严格输出 JSON：{\"reply\":\"一句话回给用户\",\"styles\":[{\"name\":\"…\",\"intent\":\"…\"}]}",
  ].join("\n");
}

/** 模型回包 → 可对照的建议。认不出就明确失败，不给半截清单。 */
export function parseRefinePlan(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: false, error: "模型没有回内容。" };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "模型回的不是 JSON。" };
  let data;
  try { data = JSON.parse(text.slice(start, end + 1)); } catch { return { ok: false, error: "模型回的 JSON 解析不了。" }; }
  const list = Array.isArray(data?.styles) ? data.styles : [];
  const styles = [];
  for (const item of list) {
    const name = cleanText(item?.name, STYLE_LIMITS.nameChars);
    const intent = cleanText(item?.intent, STYLE_LIMITS.intentChars);
    if (name) styles.push({ name, intent: intent || "按方向名理解" });
  }
  if (styles.length < STYLE_LIMITS.min) return { ok: false, error: `至少要留 ${STYLE_LIMITS.min} 条方向，模型只给了 ${styles.length} 条。` };
  if (styles.length > STYLE_LIMITS.max) return { ok: false, error: `最多 ${STYLE_LIMITS.max} 条方向，模型给了 ${styles.length} 条。` };
  const seen = new Set();
  const unique = styles.filter((style) => {
    const key = styleKey(style);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (unique.length < STYLE_LIMITS.min) return { ok: false, error: "模型给的清单里有重复项，去重后不够条数。" };
  return { ok: true, reply: cleanText(data?.reply, 200), styles: unique };
}

/**
 * 逐条对照：每条建议标出它是「改过的」「新增的」还是「原样保留的」。
 * 对照用 planKey 当锚，名字相同但意图变了也算改过——那正是用户要看的差别。
 */
export function diffStyles(current, proposed) {
  const before = normalizeRecommendationConfig(current).styles;
  const beforeKeys = new Set(before.map(styleKey));
  return proposed.map((style) => {
    const key = styleKey(style);
    const previous = before.find((item) => styleKey(item) === key) || null;
    const sameName = before.find((item) => cleanText(item.name, STYLE_LIMITS.nameChars) === style.name) || null;
    let action = "add";
    if (previous) action = "keep";
    else if (sameName) action = "update";
    return { key, name: style.name, intent: style.intent, action, before: sameName || null };
  });
}

/** 丢掉用户勾掉的几条之后，真正要落盘的清单。 */
export function applyDrops(plan, droppedKeys = []) {
  const dropped = new Set((Array.isArray(droppedKeys) ? droppedKeys : []).map(String));
  return (Array.isArray(plan) ? plan : []).filter((item) => !dropped.has(item.key));
}

/**
 * 落盘前的最后一道：这份清单还能不能用。
 * 返回 ok=false 时调用方要留在原界面并把原因说给用户，不能当成功。
 */
export function validatePlanStyles(styles) {
  const list = Array.isArray(styles) ? styles : [];
  if (list.length < STYLE_LIMITS.min) {
    return { ok: false, error: `去掉你不要的之后只剩 ${list.length} 条了，至少要留 ${STYLE_LIMITS.min} 条。` };
  }
  if (list.length > STYLE_LIMITS.max) return { ok: false, error: `最多 ${STYLE_LIMITS.max} 条。` };
  const seen = new Set();
  for (const style of list) {
    const key = styleKey(style);
    if (!key) return { ok: false, error: "有一条方向没有名字。" };
    if (seen.has(key)) return { ok: false, error: `「${style.name}」重复了。` };
    seen.add(key);
  }
  return { ok: true, styles: list.map((style) => ({ name: style.name, intent: style.intent })) };
}

/** 换了方向清单，勾选关系必须跟着重算——否则会指向不存在的下标。 */
export function reselectStyles(config, styles) {
  const normalized = normalizeRecommendationConfig(config);
  const count = normalized.count;
  const indexes = Array.from({ length: count }, (_, index) => index % styles.length);
  return { ...normalized, styles, selectedByCount: { ...normalized.selectedByCount, [count]: indexes } };
}

// ── 草稿：建议先存着，等用户点「确认修改」才真正写进配置 ──
export function createDraft(plan, now = Date.now()) {
  return {
    planId: `plan_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now,
    expiresAt: now + DRAFT_TTL_MS,
    reply: String(plan?.reply || ""),
    items: (plan?.styles || []).map((item) => ({ key: styleKey(item), name: item.name, intent: item.intent })),
    droppedKeys: [],
  };
}

export function isDraftAlive(draft, now = Date.now()) {
  if (!draft || typeof draft !== "object") return false;
  return Number(draft.expiresAt) > now;
}

/** 恢复默认：不是「清空」，而是把默认清单原样装回去并重算勾选。 */
export function restoreDefaultStyles(config) {
  return reselectStyles(config, DEFAULT_STYLES.map((style) => ({ ...style })));
}
