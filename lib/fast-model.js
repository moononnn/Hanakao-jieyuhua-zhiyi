// lib/fast-model.js — 快速档：速览、会话标题这类要立刻出结果的小功能专用一条模型。
//
// 为什么单独一条：这类活儿要的是「快」，不是「想得透」。让它们跟 Ask 判断共用一条，
// 结果就是推理模型把输出预算用在思考上、正文一个字不吐（2026-10-18 实机：
// 知意的长回复速览 9 次里失败 4 次，失败信息全是「简写模型没有返回正文」）。
//
// 为什么不按 provider 写一张「关思考参数」映射表：DeepSeek 认 reasoning_effort、
// MiniMax 认 thinking.type、OpenAI 又认 reasoning.effort，写出来只能靠猜。
// 宿主已经把这层统一成一个标准档位（off/minimal/low/medium/high/xhigh/max），
// 由它转成各家协议。所以这里采用「先试后退」：
//   1. 先试 off。模型不吃，宿主会明确抛 APP_MODEL_UNSUPPORTED_REASONING；
//   2. 脱掉这个参数，用同一个模型重发一次——快不了，但保证不失败；
//   3. 还是空正文，用同一模型把输出预算翻倍再试一次，并把「只输出可见正文」写进提示词。
// 全程不换模型，也不静默改用户选的 provider/model。

import { resolveAskModel, normalizeModelRef } from "./ask-model.js";
import { invokeTextModel, resolveTaskModel } from "./custom-model.js";

export const FAST_TASK_MODEL_KEY = "fastTaskModel";
export const FAST_REASONING_OFF = "off";
const RETRY_MAX_TOKENS = 2400;

/** 宿主拒绝了这条思考档位：这个模型不吃这套参数，脱掉重发就行。 */
export function isUnsupportedReasoning(error) {
  const code = String(error?.code || "");
  return code === "APP_MODEL_UNSUPPORTED_REASONING" || /不支持.*思考档位|reasoning effort/i.test(String(error?.message || ""));
}

/** 读设置里的快速档模型；没选就跟随传入的兜底（通常是 Ask 判断那条）。 */
export async function resolveFastModel(sdk, fallbackRef = null, { useStored = true } = {}) {
  // 测试当前选择时跳过已保存值；正式任务仍优先沿用已保存的快速档。
  const raw = useStored ? await sdk.storage.global.get(FAST_TASK_MODEL_KEY, null) : null;
  const configured = normalizeModelRef(raw) || normalizeModelRef(fallbackRef);
  if (!configured) return null;
  const catalog = await sdk.models.list();
  const chosen = resolveAskModel(catalog, configured);
  if (!chosen || chosen.provider !== configured.provider || chosen.model !== configured.model) return null;
  return resolveTaskModel(sdk, { hostModel: chosen });
}

/**
 * 走快速档发一次短任务。
 * @returns {Promise<{text: string, effort: string, reasoningTokens: number|null, attempts: number}>}
 */
export async function invokeFastTextModel(sdk, resolved, {
  requestId,
  messages,
  systemPrompt = "",
  temperature = 0,
  maxTokens = 800,
} = {}) {
  if (!resolved) throw new Error("快速档没有可用模型：去「知意设置」里选一条，或让它跟随 Ask 判断那条。");
  // 自定义档是直连 HTTP，没有思考档位这层概念，参数发了也没人接。
  const canSkipThinking = resolved.kind === "host";
  let effort = canSkipThinking ? FAST_REASONING_OFF : "";
  let reasoningTokens = null;
  let attempts = 0;

  const run = async (thinking, extraSystem = "", tokenScale = 1) => {
    attempts += 1;
    let seen = null;
    const text = await invokeTextModel(sdk, resolved, {
      requestId: `${requestId}_a${attempts}`,
      messages,
      systemPrompt: extraSystem ? `${systemPrompt}\n${extraSystem}` : systemPrompt,
      temperature,
      maxTokens: Math.max(maxTokens * tokenScale, tokenScale > 1 ? RETRY_MAX_TOKENS : 0),
      reasoningEffort: thinking,
      diagnostics: (info) => { if (Number.isFinite(info?.reasoning)) seen = info.reasoning; },
    });
    if (seen !== null) reasoningTokens = seen;
    return text;
  };

  let text = "";
  try {
    text = await run(effort);
  } catch (error) {
    if (!canSkipThinking || !isUnsupportedReasoning(error)) throw error;
    // 这个模型不吃关思考这档，退回默认思考，但仍然是同一条模型。
    effort = "";
    text = await run(effort);
  }

  if (text && text.trim()) return { text, effort, reasoningTokens, attempts };

  // 空正文：思考大概率吃光了预算。同模型加预算重来一次，不换模型。
  const wider = await run(effort, "只输出最终可见正文，不要输出思考过程。", 2);
  if (!wider || !wider.trim()) {
    const error = new Error("快速档模型没有返回正文。");
    error.code = "MODEL_EMPTY";
    error.reasoningTokens = reasoningTokens;
    throw error;
  }
  return { text: wider, effort, reasoningTokens, attempts };
}
