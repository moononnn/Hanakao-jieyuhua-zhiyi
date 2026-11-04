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
import { invokeFastTextModel, cancelFastModel, FAST_TASK_MODEL_KEY, BACKUP_MODEL_KEY } from "./fast-model.js";
import { readRuntimeState, writeRuntimeState } from "./runtime-state.js";

const TITLE_CTX_BUDGET = 6000;
const TITLE_CTX_HEAD = 1500;
// 宿主 session:history 的上限就是 200 条，而且它是从会话开头往数（不是倒着取最近），
// 所以这个值同时充当「够不够看全」的探针：返回不足 200 条说明这段会话已经被读全了，
// 正好 200 条就说明后面还有，得换 session:entries 去拿尾部。
const HISTORY_LIMIT = 200;
// 只要十来个字的名字，给 300 个 token 的额度纯属让模型拿去凑解释。
const TITLE_MAX_TOKENS = 64;
const SESSION_LIST_TIMEOUT_MS = 8000;
const TITLE_TIMEOUT_MS = 30_000;
// 同一段对话没新消息时，两分钟内再点一次直接回上次的名字，不重复烧模型。
// 别设太长：她要是觉得名字不对再点一下，总得能重新拟。
const TITLE_CACHE_TTL_MS = 2 * 60 * 1000;
const MODEL_CATALOG_TTL_MS = 60 * 1000;
let requestSequence = 0;
// 模型目录按 sdk 实例缓存一分钟：每次起名都把全量目录拉一遍，是这条链上最冤的一段等待。
const modelCatalogCache = new WeakMap();

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

// 附件包装：`[SessionFile] {"fileId":...}`、`[attached_image: x.png]`、`<file name="x">` 这类开头。
// 以前这些消息在 cleanContextText 里会因为「开头方括号没闭合」被整条判空，
// 于是「发张图 + 一句话」的发言对标题零贡献。这里只剥包装，剩下的正文照常走后面的清洗。
export function stripAttachmentWrapper(text) {
  const pattern = /^\s*(?:\[SessionFile\]\s*\{[\s\S]*?\}|\[attached_image:[^\]]*\]|<attached_image\b[^>]*>[\s\S]*?<\/attached_image>|<file\b[^>]*>[\s\S]*?<\/file>)/i;
  let out = String(text || "");
  for (let round = 0; round < 3; round++) {
    const next = out.replace(pattern, " ");
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

// 题目要盖住整个窗口，所以不能只拿尾巴。把回合按时间切成几段，每段抽一条有代表性的助手发言，
// 末尾几轮再完整展开一遍（现状靠它定调）。这是「全程脉络 + 近况」两头的折中。
const TITLE_SAMPLE_SEGMENTS = 4;
const TITLE_TAIL_TURNS = 2;
// 完整展开的那几轮里，一轮最多留多少条助手发言。
const TITLE_TURN_ASSISTANT_KEEP = 3;
// 单轮特别长的（一个大任务干到底那种），展开时改成全程等距抽样，不然只能看到最后几步。
const TITLE_LONG_TURN_KEEP = 6;
const TITLE_LONG_TURN_THRESHOLD = 8;

/** 剥掉发言开头的会话编号（`sess_xxx 你读下这个窗口`），别让它被当成主题。 */
export function stripSessionAddress(text) {
  return String(text || "").replace(/^\s*(?:sess_[a-z0-9_]{6,}\s+)+/i, "").trim();
}

export function cleanContextText(text) {
  let out = stripSessionAddress(stripAttachmentWrapper(text || ""));
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
    "你是对话标题生成器。下面按时间顺序抽了这段对话的几个片段：开头、中间几处和最近几轮。用一句极短的话概括整段对话在做什么。",
    "规则：",
    "1. 标题约 10 个字（中文）或 5 个单词（英文），保持极短",
    langLine,
    "3. 要盖住整段对话，不是只看最后几轮；中途换过方向的话，写出最后落到的那个方向，前面几段当来路",
    "4. 要写出具体在做的东西（对象、功能、话题），不要用空泛的词凑字数",
    "5. 不要出现这些词：继续、对话、窗口、处理、调整、讨论、帮忙",
    "6. 不要加引号、句号或其他标点",
    "7. 直接输出标题，不要解释",
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

/**
 * 把整段历史压成「开头一轮背景 + 最近几轮」，这是标题取料的主开关。
 *
 * 为什么不能直接把历史全邒：宿主投影出来的消息里，一个回合会因为每次工具调用
 * 拆成好几条只带工具、没有字的 assistant 消息（实机抽样：184 条里只有 8 条有句子）。
 * 按条数限额的话，名额会被这些空消息吃光，模型最后只看到几百字碎片。
 * 这里改成按回合收，而且同一回合只留最后一条 assistant（那条是结论，
 * 前面「现在处理 X」「我先看一下」都是过程播报）。
 */
/** 取一轮里的助手发言：短轮取尾部，超长轮全程等距抽（最后一句话总在里面）。 */
function sampleTurnAssistant(turn, limit) {
  const lines = turn.assistant;
  // 判长短看的是这一轮总共多少条消息（含那些只有工具调用的空条目），不是有效发言数。
  // 一个大任务干到底的轮里，几十上百条消息可能只拼得出五六句正文。
  if (turn.messageCount <= TITLE_LONG_TURN_THRESHOLD) return lines.slice(-limit);
  const count = Math.min(lines.length, Math.max(limit, TITLE_LONG_TURN_KEEP));
  if (count <= 1) return lines.slice(-1);
  const indexes = [];
  for (let i = 0; i < count; i += 1) {
    indexes.push(Math.round(i * (lines.length - 1) / (count - 1)));
  }
  return [...new Set(indexes)].map((index) => lines[index]);
}

/** 把消息归成回合。空正文的消息直接丢，不占任何名额（但算进这一轮的长度）。 */
function collectTitleTurns(messages) {
  const turns = [];
  let current = null;
  for (const message of messages) {
    const role = message?.role === "user" ? "user" : "assistant";
    const raw = stripHiddenMetaBlocks(messagePlainText(message));
    const text = cleanContextText(raw);
    if (role === "user") {
      current = { user: text, assistant: [], messageCount: 1 };
      turns.push(current);
      continue;
    }
    if (!current) {
      current = { user: "", assistant: [], messageCount: 0 };
      turns.push(current);
    }
    current.messageCount += 1;
    if (!text) continue;
    // rawLength 用清洗前的长度，用来判哪条发言信息量最大（清洗后都被截到 250 字，比不出高下）。
    current.assistant.push({ text, rawLength: raw.length });
  }
  return turns.filter((turn) => turn.user || turn.assistant.length);
}

export function selectTitleMessages(messages, { segments = TITLE_SAMPLE_SEGMENTS, tailTurns = TITLE_TAIL_TURNS } = {}) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const turns = collectTitleTurns(messages);
  if (!turns.length) return [];

  // plan: 轮次索引 -> 这一轮要带几条助手发言（0 表示只要用户那句）
  const plan = new Map();
  const note = (index, assistants) => {
    const prev = plan.get(index);
    plan.set(index, prev === undefined ? assistants : Math.max(prev, assistants));
  };

  const total = turns.length;
  const segCount = Math.min(Math.max(1, segments), total);
  // 开头那轮必留：标题总得说清这段是从哪儿起的。
  note(0, 1);
  for (let i = 0; i < segCount; i++) {
    const start = Math.floor(i * total / segCount);
    const end = Math.max(start, Math.floor((i + 1) * total / segCount) - 1);
    // 段尾那轮的用户发言代表这一段聊到哪儿了；助手那边取本段信息量最大的一条。
    note(end, 0);
    let bestIndex = -1;
    let bestLength = 0;
    for (let j = start; j <= end; j += 1) {
      for (const line of turns[j].assistant) {
        if (line.rawLength > bestLength) {
          bestLength = line.rawLength;
          bestIndex = j;
        }
      }
    }
    if (bestIndex >= 0) note(bestIndex, 1);
  }
  // 最近几轮完整展开：现在落到哪个方向，全靠这一段。
  for (let i = Math.max(0, total - tailTurns); i < total; i += 1) {
    note(i, TITLE_TURN_ASSISTANT_KEEP);
  }

  const picked = [];
  for (const index of [...plan.keys()].sort((a, b) => a - b)) {
    const turn = turns[index];
    if (turn.user) picked.push({ role: "user", content: turn.user });
    const wants = plan.get(index) || 0;
    if (wants <= 0) continue;
    const lines = wants >= turn.assistant.length
      ? turn.assistant
      : sampleTurnAssistant(turn, wants);
    for (const line of lines) picked.push({ role: "assistant", content: line.text });
  }
  return picked;
}

/** session:entries 给的是原始 jsonl 条目，这里只挑出能当对话看的 message。 */
export function projectSessionEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const messages = [];
  for (const entry of entries) {
    if (!entry || entry.type !== "message") continue;
    const role = entry?.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    messages.push({ role, content: entry.message.content });
  }
  return messages;
}

/**
 * 读一段会话能用来起名的消息。
 *
 * session:history 的 limit 是从会话开头往数的（不是倒着取最近），
 * 所以长会话里它只给得到开头的 200 条。拿满 200 就说明后面还有，
 * 这时换 session:entries 把全量拿回来，尾巴才看得到。
 * 短会话（不足 200 条）一次 history 就够，不多跑一趟。
 */
export async function readTitleMessages(sdk, sessionId) {
  let history = null;
  try {
    history = await sdk.sessions.history({ sessionId, scope: "all", limit: HISTORY_LIMIT });
  } catch (error) {
    throw new Error(`读不到这段对话的内容：${error?.message || error}`);
  }
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  if (messages.length < HISTORY_LIMIT) return messages;
  try {
    const result = await sdk.sessions.entries({ sessionId, scope: "all" });
    const full = projectSessionEntries(result?.entries);
    if (full.length > messages.length) return full;
  } catch {
    // entries 不可用就继续用开头那批，总比什么都没有强。
  }
  return messages;
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
  const cached = modelCatalogCache.get(sdk);
  const catalog = cached && Date.now() - cached.at < MODEL_CATALOG_TTL_MS
    ? cached.catalog
    : await sdk.models.list().then((value) => {
      modelCatalogCache.set(sdk, { at: Date.now(), catalog: value });
      return value;
    });
  const options = chatModelOptions(catalog);
  if (!options.length) throw new Error("Hana 模型列表为空，请先配置可用的文本模型。");
  const readRef = async (key) => normalizeModelRef(await sdk.storage.global.get(key, null));
  // 顺序就是降级顺序：快速档优先（标题要的是快，不是想得透），
  // 后面依次是 Ask 判断、内容模型、速览专用、备用模型，凑成一条链。
  // 以前只取第一条，那条没法用（额度、限流、下线）标题就彻底没了。
  const candidates = [
    await readRef(FAST_TASK_MODEL_KEY),
    await readRef("askJudgeModel"),
    await readRef("recommendationModel"),
    await readRef("summaryModel"),
    await readRef(BACKUP_MODEL_KEY),
  ];
  const chain = [];
  const seen = new Set();
  for (const ref of candidates) {
    if (!ref) continue;
    const key = `${ref.provider}/${ref.model}`;
    if (seen.has(key)) continue;
    const match = options.find((item) => item.provider === ref.provider && item.model === ref.model);
    if (!match) continue;
    seen.add(key);
    const resolved = await resolveTaskModel(sdk, { hostModel: match }).catch(() => null);
    if (resolved) chain.push(resolved);
  }
  // 一条都没配：跟以前一样，让 resolveAskModel 自己挑一条能用的。
  if (!chain.length) {
    const chosen = resolveAskModel(catalog, null);
    if (!chosen) throw new Error("还没有可用的文本模型：先去解语花的「内容模型」里选一条。");
    const resolved = await resolveTaskModel(sdk, { hostModel: chosen }).catch(() => null);
    if (resolved) chain.push(resolved);
  }
  if (!chain.length) throw new Error("还没有可用的文本模型：先去解语花的「内容模型」里选一条。");
  return chain;
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

const TITLE_CACHE_LIMIT = 12;

/** 同一段对话没新消息就不该再烧一次模型；指纹用条数加最后一句的开头。 */
export function titleFingerprint(messages) {
  if (!Array.isArray(messages) || !messages.length) return "0";
  const last = messages[messages.length - 1];
  const text = messagePlainText(last).replace(/\s+/g, " ").slice(0, 80);
  return `${messages.length}:${text}`;
}

export async function readTitleCache(sdk, sessionId, fingerprint) {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id) return null;
  const all = (await readRuntimeState(sdk, "titleCache", {})) || {};
  const entry = all[id];
  if (!entry || entry.fingerprint !== fingerprint) return null;
  const at = Date.parse(String(entry.at || ""));
  if (!Number.isFinite(at) || Date.now() - at > TITLE_CACHE_TTL_MS) return null;
  const title = String(entry.title || "").trim();
  return title ? entry : null;
}

async function writeTitleCache(sdk, sessionId, { fingerprint, title, model, degraded }) {
  const id = typeof sessionId === "string" ? sessionId.trim() : "";
  if (!id || !title) return;
  const all = (await readRuntimeState(sdk, "titleCache", {})) || {};
  const next = { ...all };
  next[id] = { fingerprint, title, model: model || null, degraded: degraded === true, at: new Date().toISOString() };
  const keys = Object.keys(next);
  if (keys.length > TITLE_CACHE_LIMIT) {
    keys
      .sort((a, b) => String(next[a]?.at || "").localeCompare(String(next[b]?.at || "")))
      .slice(0, keys.length - TITLE_CACHE_LIMIT)
      .forEach((key) => { delete next[key]; });
  }
  await writeRuntimeState(sdk, "titleCache", next);
}

export async function summarizeSessionTitle(sdk, { sessionId = "" } = {}) {
  const target = sessionId
    ? { sessionId, sessionPath: "", agentId: "", agentName: "", currentTitle: "" }
    : await pickMostActiveSession(sdk);

  // 只能按 sessionId 读：实机确认光给 sessionPath 会被宿主拒。
  const messages = await readTitleMessages(sdk, target.sessionId);
  // 语料只取「首轮背景 + 最近几轮」，不再把工具轮次的白吴点算进来。
  const picked = selectTitleMessages(messages);
  const contextText = buildTitleContext(picked);
  const fingerprint = titleFingerprint(messages);

  const cached = await readTitleCache(sdk, target.sessionId, fingerprint);
  if (cached) {
    return {
      ok: true,
      title: cached.title,
      fallback: false,
      model: cached.model || null,
      degraded: cached.degraded === true,
      cached: true,
      error: "",
      session: {
        sessionPath: target.sessionPath,
        sessionId: target.sessionId,
        agentId: target.agentId,
        agentName: target.agentName,
        currentTitle: target.currentTitle,
      },
    };
  }

  let title = null;
  let fallback = false;
  let error = null;
  let usedModel = null;
  let degraded = false;
  if (contextText) {
    try {
      const chain = await pickTitleModel(sdk);
      const requestId = `zhiyi_title_${Date.now().toString(36)}_${(++requestSequence).toString(36)}`;
      let timer;
      let timedOut = false;
      try {
        // 标题是典型的「要快不要想」：走快速档，先试关思考，不吃就退。
        // pickTitleModel 给的是一条降级链，快速档不可用时会自己往下换；
        // 链自己留 5 秒余地，不要跑到半截被外层 30 秒一刀切。
        const outcome = await Promise.race([
          invokeFastTextModel(sdk, chain, {
            requestId,
            budgetMs: TITLE_TIMEOUT_MS - 5000,
            systemPrompt: "你只输出一个极短的对话标题，不加标点、不解释。",
            messages: [{ role: "user", content: buildTitlePrompt(contextText) }],
            temperature: 0.2,
            maxTokens: TITLE_MAX_TOKENS,
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              reject(new Error("标题生成超时了。"));
            }, TITLE_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
        title = cleanTitleOutput(outcome.text);
        usedModel = outcome.modelName || null;
        degraded = outcome.degraded === true;
      } catch (streamError) {
        // 真正发出去的号带 _aN 后缀，拿基号 cancel 是取消不到的；这条会把链也叫停。
        if (timedOut) { try { await cancelFastModel(sdk, requestId); } catch {} }
        error = streamError;
      } finally {
        clearTimeout(timer);
      }
    } catch (streamError) {
      error = streamError;
    }
  }

  if (!title) {
    // 兜底取最近一条有实义的用户发言，不是历史里最后一条用户消息——
    // 那条常常是「继续」「好」或者一张图的附件壳子，拿来当名字等于没起名。
    for (const message of [...picked].reverse()) {
      if (message?.role !== "user") continue;
      const candidate = cleanTitleFallbackText(messagePlainText(message));
      if (candidate) { title = candidate; break; }
    }
    fallback = true;
  }

  if (title && !fallback) {
    await writeTitleCache(sdk, target.sessionId, { fingerprint, title, model: usedModel, degraded });
  }

  return {
    ok: !!title,
    title,
    fallback,
    // 标题换过模型就带上实际那条，面板上要写一句「这个名是备用拟的」。
    model: usedModel,
    degraded,
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
