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
//
// 单条模型内部做到这一步就到头了：要是这条模型本身不可用（额度用完、被限流、
// 模型下线、密钥失效），再怎么调参数也没用。所以 2026-11-04 起外面再套一层
// 降级链：快速模型 → 内容模型 → 备用模型，按设置里她配的那几条依次顶上去。
// 换模型这件事会写在返回值里（degraded / modelRole / modelName），
// 调用方要能说清「这几句是谁拟的」，不静默换掉。

import { chatModelOptions, resolveAskModel, normalizeModelRef } from "./ask-model.js";
import { invokeTextModel, resolveTaskModel } from "./custom-model.js";

export const FAST_TASK_MODEL_KEY = "fastTaskModel";
export const CONTENT_MODEL_KEY = "recommendationModel";
export const BACKUP_MODEL_KEY = "recommendationFallbackModel";
export const FAST_REASONING_OFF = "off";
const RETRY_MAX_TOKENS = 2400;

const ROLE_LABELS = { fast: "快速模型", content: "内容模型", backup: "备用模型", custom: "自定义模型" };

/** 把角色名翻成人话，日志和界面上都用这套说法。 */
export function modelRoleLabel(role) {
  return ROLE_LABELS[role] || "模型";
}

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

function hostRefKey(model) {
  return model ? `${model.provider || ""}/${model.model || ""}` : "";
}

async function hostMatchFromRef(catalog, ref) {
  const normalized = normalizeModelRef(ref);
  if (!normalized) return null;
  return chatModelOptions(catalog).find((item) => item.provider === normalized.provider && item.model === normalized.model) || null;
}

/**
 * 快速档的降级链：快速模型 → 内容模型 → 备用模型。
 *
 * 顺序按「她配这套东西的本意」排：快速档是首选，配了专门一条说明想让小活走它；
 * 内容模型是这些活儿的默认落点（快速档没单独选时本来就是它，去重后不会重复）；
 * 备用模型是最后一道，跟推荐回复那边共用同一个设置项。
 *
 * 每一条都可能解析不出来（模型被删了、目录里没了），那就跳过这一条，
 * 不因为一条坏链把整条链拖死。
 */
export async function resolveFastModelChain(sdk, fallbackRef = null, { useStored = true } = {}) {
  const chain = [];
  const seen = new Set();
  const push = (resolved, role) => {
    if (!resolved) return;
    const key = resolved.kind === "host" ? hostRefKey(resolved.model) : `custom:${resolved.name || ""}`;
    if (!key || seen.has(key)) return;
    seen.add(key);
    chain.push({ ...resolved, role });
  };

  push(await resolveFastModel(sdk, fallbackRef, { useStored }).catch(() => null), "fast");

  let catalog = null;
  try {
    catalog = await sdk.models.list();
  } catch {
    catalog = null;
  }
  if (catalog) {
    for (const [storageKey, role] of [[CONTENT_MODEL_KEY, "content"], [BACKUP_MODEL_KEY, "backup"]]) {
      let ref = null;
      try {
        ref = await sdk.storage.global.get(storageKey, null);
      } catch {
        ref = null;
      }
      const match = await hostMatchFromRef(catalog, ref);
      if (!match) continue;
      push(await resolveTaskModel(sdk, { hostModel: match }).catch(() => null), role);
    }
  }

  // 最后一条兜底：只用自定义 HTTP 档的用户，Hana 目录里本来就没有可匹配的条目，
  // 前面几条都解析不出来，这里把它接上。没开自定义档时 resolveTaskModel 返回 null，
  // 不会凭空多出一条。
  push(await resolveTaskModel(sdk, { hostModel: null }).catch(() => null), "custom");

  return chain;
}

// 每次真实调用用的 requestId 形如 `<基号>_a2`（脱参数、加预算那两次就是 a2 / a3）。
// 超时要取消就必须取消这些实际发出去的号；调用方只拿得到基号，所以在这里登记一份。
const activeAttempts = new Map();
const cancelledBases = new Set();
const CANCEL_MEMORY_MS = 60_000;

function trackAttempt(base, id) {
  let set = activeAttempts.get(base);
  if (!set) {
    set = new Set();
    activeAttempts.set(base, set);
  }
  set.add(id);
}

function untrackAttempt(base, id) {
  const set = activeAttempts.get(base);
  if (!set) return;
  set.delete(id);
  if (!set.size) activeAttempts.delete(base);
}

/**
 * 取消这一组快速档请求，连带正在跑的链。
 *
 * 调用方超时时只拿得到基号，直接 sdk.models.cancel(基号) 是取消不到的；
 * 而且要是不告诉链「别试了」，它还会继续拿后备模型烧额度。
 */
export async function cancelFastModel(sdk, baseRequestId) {
  const base = String(baseRequestId || "");
  if (!base) return false;
  cancelledBases.add(base);
  const timer = setTimeout(() => cancelledBases.delete(base), CANCEL_MEMORY_MS);
  timer.unref?.();
  const ids = [...(activeAttempts.get(base) || [])];
  let cancelled = false;
  for (const id of ids) {
    try {
      await sdk.models.cancel(id);
      cancelled = true;
    } catch {}
  }
  return cancelled;
}

// 单条模型跑一次短任务：先关思考，不吃就脱掉，空正文再加预算。
async function invokeOneFastModel(sdk, resolved, {
  requestId,
  messages,
  systemPrompt = "",
  temperature = 0,
  maxTokens = 800,
} = {}) {
  // 自定义档是直连 HTTP，没有思考档位这层概念，参数发了也没人接。
  const canSkipThinking = resolved.kind === "host";
  let effort = canSkipThinking ? FAST_REASONING_OFF : "";
  let reasoningTokens = null;
  let attempts = 0;

  const run = async (thinking, extraSystem = "", tokenScale = 1) => {
    attempts += 1;
    let seen = null;
    const attemptId = `${requestId}_a${attempts}`;
    trackAttempt(requestId, attemptId);
    try {
      const text = await invokeTextModel(sdk, resolved, {
        requestId: attemptId,
        messages,
        systemPrompt: extraSystem ? `${systemPrompt}\n${extraSystem}` : systemPrompt,
        temperature,
        maxTokens: Math.max(maxTokens * tokenScale, tokenScale > 1 ? RETRY_MAX_TOKENS : 0),
        reasoningEffort: thinking,
        diagnostics: (info) => { if (Number.isFinite(info?.reasoning)) seen = info.reasoning; },
      });
      if (seen !== null) reasoningTokens = seen;
      return text;
    } finally {
      untrackAttempt(requestId, attemptId);
    }
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

/**
 * 走快速档发一次短任务。第二个参数可以是单条 resolved，也可以是一条链
 * （resolveFastModelChain 的返回值）。链上任意一条出结果就收工。
 *
 * 返回值比原来多三个字段：
 *   modelName  实际出结果的那条模型
 *   modelRole  fast / content / backup，靠它说清是顶上去的还是原本那条
 *   degraded   true 表示换过模型（前面几条没接住）
 *   tried      被跳过的那些（角色、名字、错误码），写日志用
 *
 * @returns {Promise<{text: string, effort: string, reasoningTokens: number|null, attempts: number,
 *   modelName: string, modelRole: string, degraded: boolean, tried: Array<object>}>}
 */
export async function invokeFastTextModel(sdk, resolved, options = {}) {
  const { budgetMs = 0, ...callOptions } = options;
  const baseId = String(callOptions.requestId || "");
  const chain = (Array.isArray(resolved) ? resolved : [resolved]).filter(Boolean);
  if (!chain.length) throw new Error("快速档没有可用模型：去「知意设置」里选一条，或让它跟随 Ask 判断那条。");

  const startedAt = Date.now();
  const tried = [];
  let firstError = null;
  const bail = (message, code) => {
    const error = new Error(message);
    error.code = code;
    error.triedModels = [...tried];
    return error;
  };
  for (const item of chain) {
    // 调用方已经超时放弃：链别再往下换模型，那是别人等不起的额度。
    if (baseId && cancelledBases.has(baseId)) throw bail("这次已经被放弃了，不再换模型。", "MODEL_CANCELLED");
    // 总预算到了：宁可承认来不及，也别让备用模型跑到半截被外层一刀切。
    if (budgetMs > 0 && Date.now() - startedAt >= budgetMs) {
      throw bail("这次的时间不够再换一条模型了。", "MODEL_BUDGET_EXCEEDED");
    }
    try {
      const outcome = await invokeOneFastModel(sdk, item, callOptions);
      return {
        ...outcome,
        modelName: item.name || "",
        modelRole: item.role || "fast",
        degraded: tried.length > 0,
        tried: [...tried],
      };
    } catch (error) {
      // 这里不做「这个错不值得换模型」的筛选：额度、限流、模型下线、空正文，
      // 换一条都可能过；真要每条都失败，最后抛的就是第一条的原因（她最该知道的那条）。
      if (!firstError) firstError = error;
      tried.push({
        role: item.role || "fast",
        name: item.name || "",
        code: String(error?.code || ""),
        message: String(error?.message || "").slice(0, 200),
      });
    }
  }

  const error = firstError instanceof Error ? firstError : new Error("快速档模型没有返回正文。");
  error.triedModels = tried;
  throw error;
}
