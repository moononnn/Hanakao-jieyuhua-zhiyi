// lib/custom-model.js — 自定义模型档：地址 + API Key + 模型名，直连调用。
//
// 分享版接入标准（2026-08-01 定稿）：分享版反而更需要有模型配置——用户可能没配好 Hana 的模型，
// 或者想用自己的渠道。所以这三样要能填，但必须做到：Key 落盘前加密、页面只回显掩码、
// 掩码/空值都不覆盖已存的 Key、必须能「测试一下」且测试不保存。
//
// 三档分派在 resolveTaskModel 里：显式选的 Hana 模型 → 自定义档 → 都没有就报错说去哪选，
// 不偷偷挑一条默认的替用户花钱。

import { readModelText } from "./ask-model.js";
import { unprotectKey, protectKey } from "./crypto.js";

export const DEFAULT_CUSTOM_MODEL = Object.freeze({
  enabled: false,
  baseUrl: "",
  model: "",
  apiKey: "",
});

export const MASKED_KEY = "********";
const CUSTOM_TIMEOUT_MS = 60_000;
const CUSTOM_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function cleanText(value, limit) {
  if (typeof value !== "string") return "";
  return [...value]
    .filter((char) => { const code = char.codePointAt(0); return code >= 0x20 && code !== 0x7f; })
    .join("")
    .trim()
    .slice(0, limit);
}

export function normalizeCustomModelConfig(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    enabled: raw.enabled === true,
    baseUrl: cleanText(raw.baseUrl, 500).replace(/\/+$/, ""),
    model: cleanText(raw.model, 200),
    apiKey: String(raw.apiKey ?? ""),
  };
}

export function isMaskedKey(value) {
  return String(value || "").trim() === MASKED_KEY;
}

/** 页面回包一律脱敏；不回 Key 就等于没开这个功能。 */
export function maskCustomModelConfig(value) {
  const config = normalizeCustomModelConfig(value);
  return { ...config, apiKey: config.apiKey ? MASKED_KEY : "" };
}

/**
 * 合并页面提交的配置：
 * "********"、空串都不覆盖已存的 Key；只有显式 clearApiKey 才真的删掉。
 * 这是分享版标准里最容易做错的一条——掩码回传把真 Key 冲掉，用户就只能重新填。
 */
export async function mergeCustomModelConfig(current, submitted) {
  const base = normalizeCustomModelConfig(current);
  const next = normalizeCustomModelConfig(submitted);
  let apiKey = base.apiKey;
  if (submitted?.clearApiKey === true) apiKey = "";
  else if (!isMaskedKey(submitted?.apiKey) && String(next.apiKey || "").trim()) {
    apiKey = next.apiKey === base.apiKey ? base.apiKey : await protectKey(next.apiKey);
  }
  return {
    enabled: next.enabled,
    baseUrl: next.baseUrl,
    model: next.model,
    apiKey,
  };
}

/** 三档分派：Hana 里显式选过的模型优先，其次自定义档，都没有就 null（由调用方说人话）。 */
export async function resolveTaskModel(sdk, { hostModel = null, useCustom = true } = {}) {
  if (hostModel && typeof hostModel.provider === "string" && typeof hostModel.model === "string") {
    return { kind: "host", model: hostModel, name: hostModel.name || `${hostModel.provider}/${hostModel.model}` };
  }
  if (!useCustom) return null;
  const config = normalizeCustomModelConfig(await sdk.storage.global.get("customTextModel", {}));
  if (!config.enabled) return null;
  const missing = [];
  if (!config.baseUrl) missing.push("接口地址");
  if (!config.model) missing.push("模型名");
  if (!config.apiKey) missing.push("API Key");
  if (missing.length) {
    const error = new Error(`自定义模型还没配齐：缺 ${missing.join("、")}。去「知意设置 → 自定义模型」补上，或关掉它改用 Hana 的模型。`);
    error.code = "CUSTOM_MODEL_INCOMPLETE";
    throw error;
  }
  if (!/^https?:\/\//i.test(config.baseUrl)) {
    const error = new Error("自定义模型的接口地址不合法，要以 http(s):// 开头。");
    error.code = "CUSTOM_MODEL_BAD_URL";
    throw error;
  }
  return { kind: "custom", config, name: `自定义 · ${config.model}` };
}

async function postChatJson(ctx, config, key, body, timeoutMs) {
  if (!ctx?.network?.fetch) throw new Error("Hana 尚未提供受控网络接口。");
  return ctx.network.fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    timeoutMs,
    maxResponseBytes: CUSTOM_MAX_RESPONSE_BYTES,
  });
}

function textFromChatJson(data) {
  const choice = data?.choices?.[0]?.message;
  const content = choice?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text).join("").trim();
  }
  return "";
}

function apiError(data, fallback) {
  const values = [data?.error?.message, data?.message, data?.error];
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
  }
  return fallback;
}

/**
 * 统一的文本调用口：Hana 模型走 sdk.models.stream，自定义档走受控网络直连。
 * 调用点只管传参数，不用各自处理两套协议。
 */
export async function invokeTextModel(sdk, resolved, {
  requestId,
  messages,
  systemPrompt = "",
  temperature = 0.3,
  maxTokens = 1200,
  timeoutMs = CUSTOM_TIMEOUT_MS,
  callToken = "",
} = {}) {
  if (!resolved) throw new Error("没有可用模型：先去「知意设置」里选一条，或配一条自定义模型。");
  if (resolved.kind === "host") {
    // stream() 返回的是 Promise，要先等它变成 Response 再读文本。
    return readModelText(await sdk.models.stream({
      requestId,
      // callToken 把这次调用挂回发起它的那段对话；丢了会让归属和用量对不上。
      ...(callToken ? { callToken } : {}),
      provider: resolved.model.provider,
      model: resolved.model.model,
      systemPrompt,
      messages,
      temperature,
      maxTokens,
    }));
  }
  const key = await unprotectKey(resolved.config.apiKey);
  if (!key) throw new Error("自定义模型的 Key 解不出来了，去设置页重填一次。");
  const response = await postChatJson(sdk, resolved.config, key, {
    model: resolved.config.model,
    messages: systemPrompt ? [{ role: "system", content: systemPrompt }, ...messages] : messages,
    temperature,
    max_tokens: maxTokens,
  }, timeoutMs);
  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) throw new Error(apiError(data, `自定义模型调用失败（HTTP ${response.status}）`));
  const text = textFromChatJson(data);
  if (!text) {
    const error = new Error("自定义模型连上了但没有返回正文；推理模型可能把输出额度用在了思考上，或者这个接口不兼容。");
    error.code = "MODEL_EMPTY";
    throw error;
  }
  return text;
}

/** 连通测试：短消息验证，**不保存任何配置**。 */
export async function testCustomModel(sdk, submitted) {
  const merged = normalizeCustomModelConfig({
    ...submitted,
    apiKey: isMaskedKey(submitted?.apiKey) ? (await sdk.storage.global.get("customTextModel", {})).apiKey : submitted?.apiKey,
  });
  const missing = [];
  if (!merged.baseUrl) missing.push("接口地址");
  if (!merged.model) missing.push("模型名");
  if (!merged.apiKey) missing.push("API Key");
  if (missing.length) throw new Error(`还差 ${missing.join("、")}，补齐了再测。`);
  if (!/^https?:\/\//i.test(merged.baseUrl)) throw new Error("接口地址不合法，要以 http(s):// 开头。");
  const text = await invokeTextModel(sdk, { kind: "custom", config: merged, name: "自定义" }, {
    requestId: `zhiyi_custom_test_${Date.now().toString(36)}`,
    messages: [{ role: "user", content: "回一个字就好：好" }],
    temperature: 0,
    maxTokens: 64,
    timeoutMs: 20_000,
  });
  return { ok: true, sample: text.slice(0, 40), model: merged.model };
}
