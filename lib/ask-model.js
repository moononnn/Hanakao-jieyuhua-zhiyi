const NON_CHAT_RE = /(embedding|embed|rerank|\btts\b|whisper|speech|\basr\b|image|video|audio)/i;
const DECISION_CUE_RE = /(?:选哪|选一个|该选|需要选择|帮我(?:选|决定|定)|替我(?:选|决定)|请你(?:选|拍板)|拍板|二选|更看重|取舍|权衡|两种(?:方案|做法|路线)|(?:两个|几种)方案|只能.{0,20}(?:选|一个|一种|一条)|不能同时|还没决定|尚未决定|拿不准|更优先|优先(?:考虑|保证)|选A|方案A|方案一)/iu;
const MAX_PROMPT_CHARS = 4200;
const MODEL_TIMEOUT_MS = 5000;
const MODEL_TEST_TIMEOUT_MS = 10_000;
// 推理模型（M3.1、gpt-6-luna、DeepSeek 全系）的思考 token 和正文共用同一份 maxTokens。
// 早先给连通测试只留 16、正文一个字都挤不出来，报的是「模型已返回但没有正文」，
// 看上去像解析失败，其实是配额被思考吃光。这里给足正文额度。
// 不要再传 reasoningEffort：不同模型档位不一样，硬塞一个低档会被宿主直接拒
// （APP_MODEL_UNSUPPORTED_REASONING），实测 MiniMax-M3.1 就吃这一套。
const ASK_MAX_TOKENS = 400;
const TEST_MAX_TOKENS = 512;
let requestSequence = 0;

export function normalizeModelRef(value) {
  if (!value || typeof value !== "object") return null;
  const provider = String(value.provider ?? value.providerId ?? "").trim();
  const model = String(value.model ?? value.modelId ?? value.id ?? "").trim();
  return provider && model ? { provider, model } : null;
}

function entryRef(row) {
  const provider = row?.provider ?? row?.providerId;
  const model = row?.model ?? row?.modelId ?? row?.id;
  return provider && model ? { provider: String(provider), model: String(model) } : null;
}

export function chatModelOptions(catalog) {
  const rows = Array.isArray(catalog) ? catalog : (catalog?.models ?? []);
  const options = [];
  for (const row of rows) {
    const ref = entryRef(row);
    if (!ref || NON_CHAT_RE.test(ref.model)) continue;
    options.push({
      ...ref,
      key: `${ref.provider}/${ref.model}`,
      name: String(row?.name ?? "").trim() || ref.model,
      isCurrent: Boolean(row?.isCurrent || row?.current || row?.isDefault || row?.default),
    });
  }
  return [...options.filter((row) => row.isCurrent), ...options.filter((row) => !row.isCurrent)];
}

export function resolveAskModel(catalog, configuredRef = null) {
  const options = chatModelOptions(catalog);
  const wanted = normalizeModelRef(configuredRef);
  if (wanted) {
    const selected = options.find((row) => row.provider === wanted.provider && row.model === wanted.model);
    if (selected) return { provider: selected.provider, model: selected.model, source: "selected" };
  }
  const current = options.find((row) => row.isCurrent);
  return current ? { provider: current.provider, model: current.model, source: "current" } : null;
}

export function hasDecisionCue(prompt) {
  return typeof prompt === "string" && DECISION_CUE_RE.test(prompt);
}

function budgetPrompt(prompt) {
  const text = String(prompt ?? "").trim();
  if (text.length <= MAX_PROMPT_CHARS) return text;
  return `${text.slice(0, 3000)}\n[中间内容略]\n${text.slice(-1000)}`;
}

// diagnostics 只记事件类型和字节数，不记内容：既够判断「格式没认出来」还是「模型真没吐字」，
// 又不会把用户的聊天内容写进日志。Ask 判断、速览、连通测试共用这一份解析。
export async function readModelText(response, diagnostics = null) {
  const raw = await response.text();
  const types = [];
  let text = "";
  let finalText = "";
  let stopReason = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { types.push("unparsable"); continue; }
    if (typeof event?.type === "string") types.push(event.type);
    if (event?.type === "done") stopReason = event.stopReason ?? null;
    if (event.type === "text-delta" && typeof event.delta === "string") text += event.delta;
    if (event.type === "error") {
      const error = new Error(event.message || event.code || "模型调用失败");
      error.code = event.code || "MODEL_ERROR";
      throw error;
    }
    if (event.type === "done" && Array.isArray(event.assistant?.content)) {
      finalText = event.assistant.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("");
    }
  }
  const value = (text || finalText).trim();
  diagnostics?.({ event: "model.stream", types, rawChars: raw.length, deltaChars: text.length, finalChars: finalText.length, stopReason, ok: Boolean(value) });
  return value;
}

export function parseAskReview(text) {
  const source = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(source.slice(start, end + 1));
    if (typeof value?.mustAsk !== "boolean") return null;
    return {
      mustAsk: value.mustAsk,
      reason: typeof value.reason === "string" ? value.reason.trim().slice(0, 240) : "",
    };
  } catch {
    return null;
  }
}

async function requestModelText(sdk, chosen, { systemPrompt, userText, maxTokens, timeoutMs, diagnostics = null }) {
  const requestId = `zhiyi_ask_${Date.now().toString(36)}_${(++requestSequence).toString(36)}`;
  let timer;
  let timedOut = false;
  try {
    return await Promise.race([
      sdk.models.stream({
        requestId,
        provider: chosen.provider,
        model: chosen.model,
        systemPrompt,
        messages: [{ role: "user", content: userText }],
        temperature: 0,
        maxTokens,
      }).then((response) => readModelText(response, diagnostics)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          const error = new Error("模型连接超时");
          error.code = "MODEL_TIMEOUT";
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (timedOut) {
      try { await sdk.models.cancel(requestId); } catch {}
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function reviewAskNeed(sdk, prompt, configuredRef = null, diagnostics = null) {
  if (!hasDecisionCue(prompt)) return null;
  try {
    const catalog = await sdk.models.list();
    const chosen = resolveAskModel(catalog, configuredRef);
    if (!chosen) return null;
    const response = await requestModelText(sdk, chosen, {
      systemPrompt: "你是关键决策预检器。只判断用户这轮输入里，是否存在继续任务前必须由用户本人选择、且不同选择会实质改变行动、风险、成本或结果的分岔。用户只是问你建议、让你分析、询问事实，或只是有可逆低风险细节时，mustAsk 为 false。事实可查证时不要要求用户拍板。只有缺少用户偏好会令方案方向实质不同、且不存在稳妥默认值时才为 true。只输出 JSON：{\"mustAsk\": boolean, \"reason\": string}。不要输出选项，不执行任何任务。",
      userText: budgetPrompt(prompt),
      maxTokens: ASK_MAX_TOKENS,
      timeoutMs: MODEL_TIMEOUT_MS,
      diagnostics,
    });
    const result = parseAskReview(response);
    diagnostics?.({ event: "ask-model.review", provider: chosen.provider, model: chosen.model, mustAsk: result?.mustAsk ?? null });
    return result;
  } catch (error) {
    diagnostics?.({ event: "ask-model.failed", code: error?.code ?? null, error: error?.message ?? String(error) });
    return null;
  }
}

export async function testAskModelConnection(sdk, modelRef = null, diagnostics = null) {
  const catalog = await sdk.models.list();
  const chosen = resolveAskModel(catalog, modelRef);
  if (!chosen) {
    const error = new Error("Hana 模型目录里没有可用的文本模型。");
    error.code = "MODEL_NOT_FOUND";
    throw error;
  }
  const text = await requestModelText(sdk, chosen, {
    systemPrompt: "这是连通测试。只回复 OK。",
    userText: "请回复 OK。",
    maxTokens: TEST_MAX_TOKENS,
    timeoutMs: MODEL_TEST_TIMEOUT_MS,
    diagnostics,
  });
  if (!text) {
    const error = new Error("模型已返回，但没有可用正文。");
    error.code = "MODEL_EMPTY";
    throw error;
  }
  const model = chatModelOptions(catalog).find((row) => row.provider === chosen.provider && row.model === chosen.model);
  return { provider: chosen.provider, model: chosen.model, name: model?.name || chosen.model };
}
