// 会话标题生成：给最近活跃的那段对话起一个极短的名字。
//
// 从旧插件 lib/zhujian.js 的 summarizeSessionTitle、lib/session.js 的 buildTitleContext
// 与 lib/tts.js 的 stripHiddenMetaBlocks 搬过来。清洗、截断、语言判定、提示词一字未改，
// 改的是两处「怎么拿到数据」：
//   1. 旧版 fs 扫会话 JSONL → 新版走 session:history；
//   2. 旧版靠球内「固定目标」或扫目录 → 新版走 session:list 挑最近活跃（只靠已声明的 app/sessions.read）。
//
// 只生成、只显示、只复制。把标题写回宿主需要 session:update（app/sessions.manage），本版不做。

import { chatModelOptions, normalizeModelRef, resolveAskModel } from "./ask-model.js";
import { resolveTaskModel } from "./custom-model.js";
import { invokeFastTextModel, FAST_TASK_MODEL_KEY } from "./fast-model.js";
import { readRuntimeState, writeRuntimeState } from "./runtime-state.js";

const TITLE_CTX_BUDGET = 6000;
const TITLE_CTX_HEAD = 1500;
const HISTORY_LIMIT = 60;
const TITLE_MAX_TOKENS = 300;
const SESSION_LIST_TIMEOUT_MS = 8000;
const TITLE_TIMEOUT_MS = 30_000;
let requestSequence = 0;

// Hana 回复里的这些标签属于界面隐藏的内部元信息，不能进入标题。
const HIDDEN_META_TAGS = [
  "think", "thinking", "analysis", "reasoning", "echo", "read",
  "pulse", "will", "sparks", "reflections", "vibe", "mood",
];

export function stripHiddenMetaBlocks(text) {
  let t = String(text || "");
  for (const tag of HIDDEN_META_TAGS) {
    const open = `(?:<${tag}\\s*>|\\[${tag}\\])`;
    const close = `(?:</${tag}\\s*>|\\[/${tag}\\])`;
    t = t.replace(new RegExp(`\\s*${open}[\\s\\S]*?${close}\\s*`, "gi"), " ");
  }
  const names = HIDDEN_META_TAGS.join("|");
  t = t.replace(new RegExp(`\\s*(?:<(?:${names})\\s*>|\\[(?:${names})\\])[\\s\\S]*$`, "gi"), " ");
  return t.trim();
}

export function cleanContextText(text) {
  let out = text || "";
  out = out.replace(/<mood>[\s\S]*?<\/mood>/gi, "");
  out = out.replace(/\[[^\]]*\][\s\S]*?\[\/[^\]]*\]/gi, "");
  if (/^\[[^\]]*\]/.test(out) && !/\[\/[^\]]*\]/.test(out)) return "";
  out = out.replace(/\[[^\]]*\]/g, "");
  out = out.replace(/【[^】]*】[\s\S]*?【\/[^】]*】/g, "");
  out = out.replace(/【[^】]*】[\s\S]*?(?=(用户|助手):|$)/g, "");
  out = out.replace(/\s+/g, " ").trim();
  return out.slice(0, 250);
}

// 首尾成对引号：旧版用 `^(引号字符)(.*)\1$` 剥离，那个写法要求首尾是同一个字符，
// 所以「今天改代码。」这种全角成对引号永远剥不掉，最后只剩一句带句号的标题。
// 改成按真实配对逐层剥，行为只在这一个地方变。
const TITLE_QUOTE_PAIRS = [
  ['"', '"'], ["'", "'"], ["“", "”"], ["‘", "’"],
  ["「", "」"], ["『", "』"], ["《", "》"],
];

function stripWrappingQuotes(text) {
  let t = text;
  for (let round = 0; round < 3; round++) {
    let changed = false;
    for (const [open, close] of TITLE_QUOTE_PAIRS) {
      if (t.length >= 2 && t.startsWith(open) && t.endsWith(close) && !t.slice(open.length, -close.length).includes(close)) {
        t = t.slice(open.length, -close.length);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return t;
}

export function cleanTitleOutput(raw) {
  if (typeof raw !== "string") return null;
  let t = stripHiddenMetaBlocks(raw);
  t = t.replace(/^```(?:json|text)?\s*/i, "").replace(/\s*```$/, "");
  t = stripWrappingQuotes(t);
  if (/^\s*(?:\[SessionFile\]|\[attached_image:|<file\b)/i.test(t) || /["']fileId["']\s*:/i.test(t)) return null;
  t = t.replace(/[。．.，,；;：:！!？?\s]+$/, "");
  t = t.replace(/["'“”‘’「」『』《》()（）【】]/g, "");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.slice(0, 30);
}

export function cleanTitleFallbackText(raw) {
  if (typeof raw !== "string") return null;
  const text = raw
    .replace(/<file\b[^>]*>[\s\S]*?<\/file>/gi, " ")
    .replace(/\[attached_image:[^\]]*\]/gi, " ")
    .replace(/\[SessionFile\]\s*\{[\s\S]*?\}\s*/gi, " ")
    .replace(/<attached_image\b[^>]*>[\s\S]*?<\/attached_image>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleanTitleOutput(text);
}

export function detectConversationLang(contextText) {
  if (!contextText || typeof contextText !== "string") return "zh";
  const cjk = (contextText.match(/[一-鿿㐀-䶿]/g) || []).length;
  const ascii = (contextText.match(/[A-Za-z]/g) || []).length;
  return ascii > cjk * 2 ? "en" : "zh";
}

export function buildTitlePrompt(contextText) {
  const lang = detectConversationLang(contextText);
  const langLine = lang === "en"
    ? "2. 这次对话主要是英文，标题必须用英文输出，不要用中文"
    : "2. 这次对话主要是中文，标题必须用中文输出";
  return [
    "你是对话标题生成器。根据下面整段对话，用一句极短的话概括这段对话的主题。",
    "规则：",
    "1. 标题约 10 个字（中文）或 5 个单词（英文），保持极短",
    langLine,
    "3. 概括整段对话在做的事、聊的主题，不要只盯着第一句话",
    "4. 不要加引号、句号或其他标点",
    "5. 直接输出标题，不要解释",
    "对话：",
    contextText || "（对话内容不可用）",
    "输出：",
  ].join("\n");
}

/**
 * 一条消息的纯文本。
 * 宿主的 history 消息 content 是字符串或 [{type:"text",text}] 数组两种都有，
 * 以前这里只认字符串，遇到数组就当空内容跳过——整段对话拼不出上下文，
 * 于是模型那一步被跳过，标题永远只能退回「用户原话」。
 */
export function messagePlainText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function buildTitleContext(messages) {
  if (!Array.isArray(messages) || !messages.length) return "";
  const parts = [];
  for (const message of messages) {
    const text = cleanContextText(messagePlainText(message));
    if (!text) continue;
    parts.push(`${message?.role === "user" ? "用户" : "助手"}: ${text}`);
  }
  if (!parts.length) return "";
  const joined = parts.join("\n");
  if (joined.length <= TITLE_CTX_BUDGET) return joined;

  let head = "";
  let tail = "";
  for (const part of parts) {
    if (head.length >= TITLE_CTX_HEAD) break;
    head += part + "\n";
  }
  let budget = TITLE_CTX_BUDGET - head.length - 8;
  for (let i = parts.length - 1; i >= 0 && budget > 0; i--) {
    const part = parts[i];
    if (tail.length + part.length + 1 > budget) {
      tail = part.slice(0, Math.max(0, budget - tail.length - 1)) + "\n" + tail;
      break;
    }
    tail = part + "\n" + tail;
    budget -= part.length + 1;
  }
  return (head.trim() + "\n" + tail.trim()).trim();
}

// 从 session:list 的名单里挑最近有动静的会话。
// 参照 apps/biaoqingbao-app/lib/ball.js 的做法：只靠已声明的 app/sessions.read。
//
// 必须拿到 sessionId：实机诊断（2026-10-12）确认，宿主对 session:history / session:get /
// sessions:context 只认 sessionId 或 legacySessionPath，光给 sessionPath 一律回
// `session_manifest_ref_required`。而 session:list 现在是带 sessionId 的。
export async function pickMostActiveSession(sdk) {
  let result;
  try {
    result = await Promise.race([
      sdk.bus.request("session:list", { scope: "all" }, { timeoutMs: SESSION_LIST_TIMEOUT_MS }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("会话名单超时了。")), SESSION_LIST_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    throw new Error(`读不到会话名单：${error?.message || error}`);
  }
  const sessions = Array.isArray(result) ? result : result?.sessions;
  if (!Array.isArray(sessions) || !sessions.length) throw new Error("会话名单是空的，现在没有可取名的对话。");

  let best = null;
  for (const item of sessions) {
    const sessionId = String(item?.sessionId || item?.session_id || "").trim();
    if (!sessionId) continue;
    const modified = Number(item?.modified ?? item?.updatedAt ?? item?.modifiedAt) || 0;
    if (!best || modified > best.modified) {
      best = {
        sessionPath: typeof (item?.path || item?.sessionPath) === "string" ? (item.path || item.sessionPath) : "",
        sessionId,
        agentId: String(item?.agentId || ""),
        agentName: String(item?.agentName || "").trim(),
        currentTitle: String(item?.title || "").trim(),
        modified,
      };
    }
  }
  if (!best) throw new Error("会话名单里没有带编号的对话，读不了内容。");
  return best;
}

function readModelText(response) {
  return response.text().then((raw) => {
    let deltas = "";
    let finalText = "";
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === "text-delta" && typeof event.delta === "string") deltas += event.delta;
      if (event.type === "error") {
        const error = new Error(event.message || event.code || "标题模型调用失败。");
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
    return (deltas || finalText).trim();
  });
}

/**
 * 选一条起标题用的模型。
 * 以前这里只看 `catalog.models`（假定返回 {models:[...]}），而宿主给的也可能直接是数组，
 * 于是「模型列表为空」天天报——内容模型页却能正常列出模型。现在统一走 chatModelOptions：
 * 数组与对象都认；选过就用选的那条，没选就跟随当前模型。
 */
export async function pickTitleModel(sdk) {
  const catalog = await sdk.models.list();
  const options = chatModelOptions(catalog);
  if (!options.length) throw new Error("Hana 模型列表为空，请先配置可用的文本模型。");
  const readRef = async (key) => normalizeModelRef(await sdk.storage.global.get(key, null));
  // 快速档优先：标题要的是快，不是想得透。
  const configured = (await readRef(FAST_TASK_MODEL_KEY))
    || (await readRef("askJudgeModel"))
    || (await readRef("recommendationModel"))
    || (await readRef("summaryModel"));
  const chosen = resolveAskModel(catalog, configured);
  if (!chosen) throw new Error("还没有可用的文本模型：先去解语花的「内容模型」里选一条。");
  return { provider: chosen.provider, model: chosen.model };
}

// 把标题写回宿主。这是本项目第一个需要 app/sessions.manage 的动作：
// session:update 与 session:send / session:send-custom / session:fork 共用同一个授权门。
//
// 顺手做了一件事：写之前把旧标题存进 titleUndo。这样用户发现自己起错了名，
// 能一键改回去，而不是只能自己在宿主里手动改。
const TITLE_UNDO_LIMIT = 5;

export async function readTitleUndo(sdk, sessionId) {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return { ok: true, previousTitle: null };
  const record = await readRuntimeState(sdk, "titleUndo", {});
  const entry = record && typeof record === "object" ? record[id] : null;
  return {
    ok: true,
    previousTitle: typeof entry === "string" ? entry : null,
    currentTitle: typeof entry === "string" ? null : (entry?.currentTitle ?? null),
  };
}

/** 写入新标题并记下旧值。旧值为空串也算“有过标题”，用 null 表示从没起过。 */
export async function undoSessionTitle(sdk, { sessionId } = {}) {
  const record = (await readRuntimeState(sdk, "titleUndo", {})) || {};
  const keys = Object.keys(record);
  if (!keys.length) throw new Error("知意还没给哪段对话起过名。");
  // 不指定就是“刚改的那一个”：按写入时间取最新的那一条。
  const id = typeof sessionId === "string" && sessionId.trim()
    ? sessionId.trim()
    : keys.sort((a, b) => String(record[a]?.at || "").localeCompare(String(record[b]?.at || ""))).pop();
  const entry = record[id];
  const previous = typeof entry === "string" ? entry : (entry?.previousTitle ?? null);
  if (!entry) throw new Error("这段对话没有改过标题，没什么可撤回的。");

  // 撤回本身也要能被撤回：把当前标题当成新的“旧值”记下来。
  const current = typeof entry === "string" ? null : (entry.currentTitle ?? null);
  const written = await writeTitleToHost(sdk, { sessionId: id, title: previous || "未命名对话" });
  const next = { ...record };
  next[id] = { previousTitle: current, currentTitle: written.title };
  await writeRuntimeState(sdk, "titleUndo", next);
  return { ...written, restoredTitle: previous };
}

async function writeTitleToHost(sdk, { sessionId: id, title: name }) {
  let result;
  try {
    result = await sdk.bus.request(
      "session:update",
      { sessionId: id, scope: "all", title: name },
      { timeoutMs: SESSION_LIST_TIMEOUT_MS },
    );
  } catch (error) {
    // 授权被拒是这个功能最常见的失败原因，要说人话，不要把内部码原话扔给用户。
    const denied = /APP_CAPABILITY_DENIED|APP_PERMISSION|capability|denied|not_asked/i.test(String(error?.code || "") + String(error?.message || ""));
    if (denied) {
      throw new Error("知意还没有「管理会话」这项权限，写不进去。去 Hana「设置 → 应用 → 解语花·知意 → 应用权限」里允许后重试。");
    }
    throw new Error(`标题没写成：${error?.message || error}`);
  }
  return { ok: true, title: name, sessionId: result?.sessionId || id };
}

export async function applySessionTitle(sdk, { sessionId, title, previousTitle = undefined }) {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  const name = cleanTitleOutput(title);
  if (!id) throw new Error("不知道该改哪一段对话的标题。");
  if (!name) throw new Error("这个标题不能用，先重新起一个。");

  // 以前这里写成了「只有没传入旧标题时才记账」，而真正会传入旧标题的那条路（传音樱 / 面板）
  // 永远都会传——于是撤回记录一次也写不进去，两个入口的「还原」都报「没改过标题」。
  // 旧标题有没有读到是另一回事：传了就记传的，没传就记 null（表示从没起过名）。
  const record = (await readRuntimeState(sdk, "titleUndo", {})) || {};
  const kept = { ...record };
  // 只留最近几段的记录，别把存储堆成垃圾。
  const keys = Object.keys(kept);
  if (keys.length > TITLE_UNDO_LIMIT) {
    for (const key of keys.slice(0, keys.length - TITLE_UNDO_LIMIT)) delete kept[key];
  }
  kept[id] = { previousTitle: previousTitle ?? null, currentTitle: name, at: new Date().toISOString() };
  await writeRuntimeState(sdk, "titleUndo", kept);

  return writeTitleToHost(sdk, { sessionId: id, title: name });
}

export async function summarizeSessionTitle(sdk, { sessionId = "" } = {}) {
  const target = sessionId
    ? { sessionId, sessionPath: "", agentId: "", agentName: "", currentTitle: "" }
    : await pickMostActiveSession(sdk);

  // 只能按 sessionId 读：实机确认光给 sessionPath 会被宿主拒。
  let history = null;
  try {
    history = await sdk.sessions.history({ sessionId: target.sessionId, scope: "all", limit: HISTORY_LIMIT });
  } catch (error) {
    throw new Error(`读不到这段对话的内容：${error?.message || error}`);
  }
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  const contextText = buildTitleContext(messages);

  let title = null;
  let fallback = false;
  let error = null;
  if (contextText) {
    try {
      const model = await pickTitleModel(sdk);
      const requestId = `zhiyi_title_${Date.now().toString(36)}_${(++requestSequence).toString(36)}`;
      let timer;
      let timedOut = false;
      try {
        // 标题是典型的「要快不要想」：走快速档，先试关思考，不吃就退。
        const outcome = await Promise.race([
          invokeFastTextModel(sdk, await resolveTaskModel(sdk, { hostModel: model }), {
            requestId,
            systemPrompt: "你只输出一个极短的对话标题，不加标点、不解释。",
            messages: [{ role: "user", content: buildTitlePrompt(contextText) }],
            temperature: 0.2,
            maxTokens: TITLE_MAX_TOKENS,
          }).then((value) => value.text),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error("标题生成超时了。"));
            }, TITLE_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
        title = cleanTitleOutput(outcome);
      } catch (streamError) {
        if (timedOut) { try { await sdk.models.cancel(requestId); } catch {} }
        error = streamError;
      } finally {
        clearTimeout(timer);
      }
    } catch (streamError) {
      error = streamError;
    }
  }

  if (!title) {
    for (const message of [...messages].reverse()) {
      if (message?.role !== "user") continue;
      const candidate = cleanTitleFallbackText(messagePlainText(message));
      if (candidate) { title = candidate; break; }
    }
    fallback = true;
  }

  return {
    ok: !!title,
    title,
    fallback,
    error: error?.message ? String(error.message) : "",
    session: {
      sessionPath: target.sessionPath,
      sessionId: target.sessionId,
      agentId: target.agentId,
      agentName: target.agentName,
      currentTitle: target.currentTitle,
    },
  };
}
