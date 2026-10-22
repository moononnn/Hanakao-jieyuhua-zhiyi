// lib/voice.js — 知意「朗读回复」：朗读文本清洗 + 语音合成（多协议）+ 逐词字幕
//
// 能力范围照旧版解语花 lib/tts.js，逐词字幕是茶话会那边后来补的，本项目一起接过来。
// 迁移时改了三处，都是旧版那条路在 v2 App 里已经走不通的：
//   ① 出网不再用 node fetch，全部走 ctx.network.fetch（宿主按 manifest 白名单强校验）；
//   ② 不再 fs 扫 ~/.hanako 找语音模型候选；朗读模型由用户在设置页自己填一条，
//      Key 用 lib/crypto.js 的系统加密保护后落盘，不经过宿主 provider 凭据（未申请该授权）；
//   ③ 合成结果落 App 数据目录，由 App 自己回包音频，不再塞回包给球桥。
//
// 三条协议：
//   t2a （MiniMax）：POST {base}/v1/t2a_v2?GroupId=xxx → data.audio（mp3，HEX 或 base64）
//   chat（MiMo 等 OpenAI 兼容）：POST {base}/chat/completions → choices[0].message.audio.data（wav base64）
//   speech（自建 / 第三方标准 TTS）：POST {base}/audio/speech → 二进制音频（默认 mp3，退 wav）
// speech 是 2026-10-20 加的：本地部署与兼容 OpenAI TTS 的服务基本都实现这一层。

import fs from "node:fs";
import path from "node:path";
import { unprotectKey } from "./crypto.js";

export const DEFAULT_TTS_BASE_URL = "https://api.minimaxi.com";
export const DEFAULT_TTS_MODEL = "speech-2.8-hd";
export const SYNTH_TIMEOUT_MS = 30_000;
export const SUBTITLE_TIMEOUT_MS = 8_000;
// 合成回包是整段音频的 base64，长回复的 mp3 轻松过 1MB；单请求放宽，不动全局上限。
// 单次合成能取回的上限。真机踩过：manifest 只给 1 MB 时，一段长朗读直接被宿主网络层拒掉
// （"Plugin network.fetch response exceeded 1048576"），而这里请求的是 4 MB，两边对不上。
// 现在两边统一为 8 MB：800 字 mp3 ≈ 3 MB，加上 JSON 里的 base64 膨胀仍在范围内。
// manifest.network.maxResponseBytes 必须不小于这个值，改一处就得改另一处。
export const SYNTH_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// 读历史时要扫多深。60 太浅：Hana 的一轮回复会被拆成好几条 entry（先 mood、再工具调用、
// 再正文），工具结果和自定义 entry 也占配额，所以 60 条里常常只剩一两条能念的正文，
// 面板看着就像「只回复过两轮」。放宽到 400，只要统计数字，不记正文。
export const REPLY_HISTORY_LIMIT = 400;
export const MAX_REPLY_CHARS = 1000;

export function clampNum(value, min, max, fallback) {
  const n = typeof value === "string" ? parseFloat(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ─── 音色 ───
// t2a 协议音色（MiniMax 官方 voice_id，照旧版核对过的官方目录，别凭印象写 ID，会报 2054）
export const T2A_VOICES = [
  { id: "female-shaonv", name: "少女（清亮温柔）" },
  { id: "female-yujie", name: "御姐（成熟优雅）" },
  { id: "female-chengshu", name: "成熟女性（沉稳）" },
  { id: "female-tianmei", name: "甜美女性（甜软）" },
  { id: "male-qn-qingse", name: "青涩青年（少年感）" },
  { id: "male-qn-jingying", name: "精英青年（清爽干练）" },
  { id: "male-qn-badao", name: "霸道青年（强势）" },
  { id: "male-qn-daxuesheng", name: "青年大学生" },
  { id: "presenter_male", name: "男主持人（播音腔）" },
  { id: "presenter_female", name: "女主持人（播音腔）" },
  { id: "audiobook_male_1", name: "男声有声书" },
  { id: "audiobook_female_1", name: "女声有声书" },
  { id: "Chinese (Mandarin)_News_Anchor", name: "新闻女声（专业）" },
  { id: "Chinese (Mandarin)_Warm_Girl", name: "温暖少女" },
  { id: "Chinese (Mandarin)_Gentleman", name: "温润男声（儒雅）" },
  { id: "Chinese (Mandarin)_Southern_Young_Man", name: "南方小哥（带南方口音）" },
  { id: "Chinese (Mandarin)_Warm_Bestie", name: "温暖闺蜜（亲近）" },
  { id: "junlang_nanyou", name: "俊朗男友（苏感）" },
  { id: "diadia_xuemei", name: "嗲嗲学妹" },
  { id: "qiaopi_mengmei", name: "俏皮萌妹（活泼）" },
];

// chat 协议（MiMo V2.5 预置音色；可用自然语言描述音色风格）
export const CHAT_VOICES = [
  { id: "mimo_default", name: "默认音色" },
  { id: "冰糖", name: "冰糖（清甜）" },
  { id: "茉莉", name: "茉莉（温柔）" },
  { id: "苏打", name: "苏打（清爽）" },
  { id: "白桦", name: "白桦（沉稳）" },
];

export function voicesForProtocol(protocol) {
  // speech 的音色由用户那个服务决定，没有内置目录；前端给一个可自由输入的框。
  if (protocol === "speech") return [];
  return protocol === "t2a" ? T2A_VOICES : CHAT_VOICES;
}

// 协议与鉴权方式的取值集合。读写都要过这一层，认不出的落回默认值。
const VOICE_PROTOCOLS = new Set(["t2a", "chat", "speech"]);
const VOICE_AUTH_STYLES = new Set(["bearer", "api-key", "none"]);

// ─── 朗读配置 ───
// 一条朗读模型配置 + 朗读偏好 + 按伙伴分的音色，全部存在 App 全局存储的 voiceConfig 里。
export const DEFAULT_VOICE_CONFIG = Object.freeze({
  enabled: false,
  // 勾上以后 Key 不填也使得：每次合成先去宿主要一次凭据（app/provider.credentials.read）。
  useHanaCredential: false,
  protocol: "t2a",
  providerId: "minimax",
  // 空字符串 = 还没选过，按老规则（providerId / 模型名猜）发头；老配置不会因为升级而多出一个字段。
  authStyle: "",
  baseUrl: DEFAULT_TTS_BASE_URL,
  model: DEFAULT_TTS_MODEL,
  groupId: "",
  apiKey: "",
  speed: 1,
  scope: "all",
  maxChars: 800,
  defaultVoiceId: "female-shaonv",
  voiceByAgent: {},
});

/** 新建朗读模型时可以套的开箱模板，只填协议和默认地址；Key 与 GroupId 仍要用户自己补。 */
export const VOICE_PRESETS = [
  { id: "minimax", label: "MiniMax", protocol: "t2a", providerId: "minimax", baseUrl: "https://api.minimaxi.com", model: "speech-2.8-hd" },
  { id: "minimax-turbo", label: "MiniMax 省一半", protocol: "t2a", providerId: "minimax", baseUrl: "https://api.minimaxi.com", model: "speech-2.8-turbo" },
  { id: "mimo", label: "MiMo", protocol: "chat", providerId: "mimo", baseUrl: "https://api.xiaomimimo.com/v1", model: "mimo-v2.5-tts" },
  { id: "openai", label: "OpenAI 兼容", protocol: "chat", providerId: "", baseUrl: "", model: "" },
  // 本地 / 自建 TTS 的占位模板：地址与模型名只是常见默认值，用户按自己部署的改。
  // 这类服务一般不要 Key，所以默认不发鉴权头。
  { id: "local-tts", label: "本地 / 自建 TTS", protocol: "speech", providerId: "", authStyle: "none", baseUrl: "http://127.0.0.1:9880", model: "tts-1" },
];

export function normalizeVoiceModelConfig(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    useHanaCredential: raw.useHanaCredential === true,
    providerId: String(raw.providerId ?? "").trim().slice(0, 120),
    model: String(raw.model ?? "").trim().slice(0, 200),
    protocol: VOICE_PROTOCOLS.has(raw.protocol) ? raw.protocol : "chat",
    authStyle: VOICE_AUTH_STYLES.has(raw.authStyle) ? raw.authStyle : "",
    baseUrl: String(raw.baseUrl ?? "").trim().replace(/\/+$/, "").slice(0, 500),
    groupId: String(raw.groupId ?? "").trim().slice(0, 160),
    apiKey: String(raw.apiKey ?? ""),
  };
}
export function normalizeVoiceConfig(value) {
  const raw = value && typeof value === "object" ? value : {};
  const model = normalizeVoiceModelConfig(raw);
  const voiceByAgent = {};
  const overrides = raw.voiceByAgent && typeof raw.voiceByAgent === "object" && !Array.isArray(raw.voiceByAgent)
    ? raw.voiceByAgent
    : {};
  for (const [agentId, voiceId] of Object.entries(overrides)) {
    const key = String(agentId || "").trim().slice(0, 120);
    const voice = String(voiceId || "").trim().slice(0, 120);
    if (key && voice) voiceByAgent[key] = voice;
  }
  return {
    ...model,
    enabled: raw.enabled !== false,
    speed: clampNum(raw.speed, 0.5, 2, DEFAULT_VOICE_CONFIG.speed),
    scope: raw.scope === "quoted" ? "quoted" : "all",
    maxChars: Math.round(clampNum(raw.maxChars, 20, MAX_REPLY_CHARS * 10, DEFAULT_VOICE_CONFIG.maxChars)),
    defaultVoiceId: String(raw.defaultVoiceId ?? DEFAULT_VOICE_CONFIG.defaultVoiceId).trim().slice(0, 120),
    voiceByAgent,
  };
}

/** 掩掉 Key 再给页面；页面回传 "********" 时要还原成旧值，不能被掩码覆盖真 Key。 */
export function maskVoiceConfig(config) {
  const normalized = normalizeVoiceConfig(config);
  return { ...normalized, apiKey: normalized.apiKey ? "********" : "" };
}

export function isMaskedKey(value) {
  return String(value || "").trim() === "********";
}

/** 朗读用的音色 id：伙伴专属优先，其次全局默认；都空时由协议兜底。 */
export function resolveVoiceIdForAgent(config, agentId = "") {
  const normalized = normalizeVoiceConfig(config);
  const override = normalized.voiceByAgent[String(agentId || "").trim()];
  return String(override || normalized.defaultVoiceId || "").trim();
}

export function voiceIsConfigured(config) {
  const normalized = normalizeVoiceConfig(config);
  // 自建 TTS 大多不校验 Key（GPT-SoVITS、kokoro-fastapi 之类），不能拿 Key 当必填卡住用户。
  if (normalized.protocol === "speech") return Boolean(normalized.baseUrl && normalized.model);
  if (normalized.useHanaCredential) return Boolean(normalized.baseUrl && normalized.model);
  return Boolean(normalized.baseUrl && normalized.model && normalized.apiKey);
}

// 「用 Hana 里的 Key」：不自己填，每次合成前向宿主要一次凭据。
// 拿不到就说拿不到，绝不静默回落到空 Key 去发一个必然失败的请求。
export async function resolveHanaCredential(sdk, providerId) {
  const id = String(providerId || "").trim();
  if (!id) throw new Error("要用 Hana 里的 Key，得先选一个预置模板（MiniMax 那一行）。");
  if (!sdk?.providers?.getCredentials) throw new Error("这个 Hana 版本没提供读取凭据的能力。");
  let result;
  try {
    result = await sdk.providers.getCredentials({ providerId: id });
  } catch (error) {
    const denied = /APP_CAPABILITY_DENIED|APP_PERMISSION|capability|denied|not_asked/i
      .test(String(error?.code || "") + String(error?.message || ""));
    if (denied) {
      throw new Error("还没允许知意读取凭据。去 Hana「设置 → 应用 → 解语花·知意 → 应用权限」里允许「读取凭据」后重试。");
    }
    throw new Error(`没拿到凭据：${error?.message || error}`);
  }
  const apiKey = String(result?.apiKey || "");
  if (!apiKey) throw new Error(`Hana 里没有 ${id} 的可用 Key，先在 Hana 的模型设置里把它配好。`);
  return { apiKey, baseUrl: String(result?.baseUrl || "") || null, api: result?.api || null };
}

// ─── 朗读文本清洗 ───
// Hana 回复里的这些标签属于界面隐藏的内部元信息，不能进入朗读。
// 兼容尖括号、方括号，以及模型输出的混搭闭合形式。
const HIDDEN_META_TAGS = [
  "think", "thinking", "analysis", "reasoning", "echo", "read",
  "pulse", "will", "sparks", "reflections", "vibe", "mood",
];

export function stripHiddenMetaBlocks(text) {
  let t = String(text || "");
  for (const tag of HIDDEN_META_TAGS) {
    const open = `(?:<${tag}\\s*>|\\[${tag}\\])`;
    const close = `(?:</${tag}\\s*>|\\[/${tag}\\])`;
    // 先清完整块；内层标签排在 mood 之前处理，避免嵌套时过早遇到内层闭合。
    t = t.replace(new RegExp(`\\s*${open}[\\s\\S]*?${close}\\s*`, "gi"), " ");
  }
  // 出现未闭合的隐藏块时，后面的内容也不能冒险送去合成。
  const names = HIDDEN_META_TAGS.join("|");
  t = t.replace(new RegExp(`\\s*(?:<(?:${names})\\s*>|\\[(?:${names})\\])[\\s\\S]*$`, "gi"), " ");
  return t.trim();
}

/** 去掉隐藏元信息与 Markdown 痕迹，折叠空白；「全文」只代表可见正文。 */
export function cleanReadableText(text) {
  let t = stripHiddenMetaBlocks(text);
  t = t.replace(/```[\s\S]*?```/g, " ");        // 代码块整段去掉
  t = t.replace(/`([^`\n]+)`/g, "$1");           // 行内代码只留文字
  t = t.replace(/\*\*([^*\n]+)\*\*/g, "$1");     // 粗体
  t = t.replace(/\*([^*\n]+)\*/g, "$1");         // 斜体
  t = t.replace(/__([^_\n]+)__/g, "$1");         // 下划线强调
  t = t.replace(/~~([^~\n]+)~~/g, "$1");         // 删除线
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"); // 链接只留文字
  t = t.replace(/^#{1,6}\s*/gm, "");             // 标题符号
  t = t.replace(/^>\s?/gm, "");                  // 引用符
  t = t.replace(/^[-*+]\s+/gm, "");              // 列表符号（保留内容）
  t = t.replace(/^\d+[.、]\s*/gm, "");           // 有序列表符号
  t = t.replace(/[|]/g, " ");                    // 表格竖线
  t = t.replace(/\r\n?/g, "\n");
  t = t.replace(/[ \t]+/g, " ");
  t = t.replace(/\n\s*\n+/g, "\n");
  t = t.split("\n").map((line) => line.trim()).join("\n");
  return t.trim();
}

/** 只取引号里的内容，方便只念台词。 */
export function extractQuotedText(text) {
  const re = /["“]([^"”]+)["”]|「([^」]+)」|『([^』]+)』/g;
  const parts = [];
  let m;
  while ((m = re.exec(text)) !== null && parts.length < 10) {
    const piece = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (piece) parts.push(piece);
  }
  return parts.join("，");
}

/**
 * 按 scope 提取朗读文本。
 * quoted 模式没找到引号内容时回退整条，并把 matched=false 交回去——界面要能说「这句没有引号台词」，
 * 不能悄悄换了个范围还装作是用户选的。
 */
export function extractReadableText(raw, scope, maxLen) {
  const cleaned = cleanReadableText(raw);
  let text = cleaned;
  let matched = true;
  if (scope === "quoted") {
    const quoted = extractQuotedText(cleaned);
    if (quoted) text = quoted;
    else { text = cleaned; matched = false; }
  }
  const limit = Math.round(clampNum(maxLen, 20, MAX_REPLY_CHARS * 10, DEFAULT_VOICE_CONFIG.maxChars));
  const truncated = text.length > limit;
  if (truncated) text = text.slice(0, Math.max(1, limit - 1)) + "…";
  return { text, matched, truncated };
}

// ─── 逐词字幕 ───
/** 官方字幕的时间戳字段名换过版本（time_begin 与 begin_time 都出现过），挨个认。 */
function subtitleStamp(row, side) {
  const keys = side === "start"
    ? ["time_begin", "begin_time", "start", "begin"]
    : ["time_end", "end_time", "end"];
  for (const key of keys) {
    const value = Number(row?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/** 认 JSON 时间戳和 SRT；认不出来返回 null，不硬猜，前端退回按句点亮。 */
export function parseSubtitleFile(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (text.startsWith("{") || text.startsWith("[")) {
    let data = null;
    try { data = JSON.parse(text); } catch { return null; }
    const rows = Array.isArray(data) ? data
      : Array.isArray(data?.subtitle) ? data.subtitle
        : Array.isArray(data?.data) ? data.data : [];
    const out = [];
    for (const row of rows) {
      // 逐词明细优先：官方把词级时间放在 timestamped_words 里，比整段准得多。
      const words = Array.isArray(row?.timestamped_words) ? row.timestamped_words : [];
      if (words.length) {
        for (const item of words) {
          const start = subtitleStamp(item, "start");
          const end = subtitleStamp(item, "end");
          const label = String(item?.word ?? item?.text ?? "").trim();
          if (start === null || end === null || end <= start || !label) continue;
          out.push({ start: Math.round(start), end: Math.round(end), text: label });
        }
        continue;
      }
      const start = subtitleStamp(row, "start");
      const end = subtitleStamp(row, "end");
      const label = String(row?.text ?? row?.word ?? "").trim();
      if (start === null || end === null || end <= start || !label) continue;
      out.push({ start: Math.round(start), end: Math.round(end), text: label });
    }
    return out.length ? out : null;
  }
  if (text.includes("-->")) {
    const out = [];
    const stamp = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g;
    for (const block of text.split(/\r?\n\r?\n/)) {
      const lines = block.split(/\r?\n/);
      const index = lines.findIndex((item) => item.includes("-->"));
      if (index < 0) continue;
      const toMs = (value) => {
        stamp.lastIndex = 0;
        const m = stamp.exec(value);
        if (!m) return null;
        return Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1_000 + Number(String(m[4]).padEnd(3, "0"));
      };
      const [left, right] = lines[index].split("-->");
      const start = toMs(left || "");
      const end = toMs(right || "");
      if (start === null || end === null || end <= start) continue;
      const body = lines.slice(index + 1).join(" ").trim();
      if (body) out.push({ start, end, text: body });
    }
    return out.length ? out : null;
  }
  return null;
}

/**
 * 官方词级字幕在非流式下是另一个文件，要再跑一次请求。
 * 拉不到、格式认不出或超时一律安静当作「没有字幕」，由前端按句点亮顶上。
 */
async function fetchWordTimings(ctx, url) {
  if (!url || !ctx?.network?.fetch) return null;
  try {
    const response = await ctx.network.fetch(String(url), {
      method: "GET",
      timeoutMs: SUBTITLE_TIMEOUT_MS,
      maxResponseBytes: SYNTH_MAX_RESPONSE_BYTES,
    });
    if (!response.ok) return null;
    return parseSubtitleFile(await response.text());
  } catch { return null; }
}

/** MiniMax 的 data.audio 可能是 HEX（按 base64 解会播成电锯声），这里两种都认。 */
function decodeAudio(value) {
  const raw = String(value ?? "").replace(/\s+/g, "");
  if (!raw) return null;
  const bytes = /^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  return bytes.length ? bytes : null;
}

/** 合成完就把时长算出来，不等用户第一次播放才临时知道。 */
export function audioDurationMs(audio, format = "wav") {
  const bytes = Buffer.isBuffer(audio) ? audio : Buffer.from(audio || []);
  if (!bytes.length) return null;
  if (String(format).toLowerCase() === "wav" && bytes.length >= 44
    && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") {
    let offset = 12;
    let byteRate = 0;
    let dataSize = 0;
    while (offset + 8 <= bytes.length) {
      const size = bytes.readUInt32LE(offset + 4);
      const end = Math.min(bytes.length, offset + 8 + size);
      if (bytes.toString("ascii", offset, offset + 4) === "fmt " && offset + 20 <= bytes.length) {
        byteRate = bytes.readUInt32LE(offset + 16);
      } else if (bytes.toString("ascii", offset, offset + 4) === "data") {
        dataSize = Math.min(size, Math.max(0, bytes.length - offset - 8));
        break;
      }
      offset = end + (size % 2);
    }
    if (byteRate > 0 && dataSize > 0) return Math.round(dataSize / byteRate * 1000);
  }
  if (String(format).toLowerCase() === "mp3") {
    const bitrates = {
      1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
      2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    };
    for (let offset = 0; offset + 4 < bytes.length; offset += 1) {
      if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) continue;
      const versionBits = (bytes[offset + 1] >> 3) & 3;
      const layer = (bytes[offset + 1] >> 1) & 3;
      const bitrateIndex = (bytes[offset + 2] >> 4) & 15;
      if (layer !== 1 || versionBits === 1 || bitrateIndex === 0 || bitrateIndex === 15) continue;
      const bitrate = bitrates[versionBits === 3 ? 1 : 2][bitrateIndex] * 1000;
      if (bitrate > 0) return Math.max(1, Math.round(bytes.length * 8 / bitrate * 1000));
    }
  }
  return null;
}

// ─── 合成 ───
function normalizeBaseUrl(baseUrl) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("朗读接口地址没填");
  if (!/^https?:\/\//i.test(base)) throw new Error("朗读接口地址不合法，要以 http(s):// 开头");
  return base;
}

export function buildT2aUrl(baseUrl, groupId = "") {
  const base = `${normalizeBaseUrl(baseUrl)}/v1/t2a_v2`;
  const group = String(groupId || "").trim();
  return group ? `${base}?GroupId=${encodeURIComponent(group)}` : base;
}

/** 三项鉴权显式化：bearer / api-key / none；没选过时仍按老规则猜（照旧兼容）。 */
export function voiceRequestHeaders(config, key) {
  const style = String(config?.authStyle || "").trim();
  if (style === "none") return {};
  if (style === "api-key") return key ? { "api-key": key } : {};
  if (style === "bearer") return key ? { Authorization: `Bearer ${key}` } : {};
  const provider = String(config?.providerId || "").toLowerCase();
  const model = String(config?.model || "").toLowerCase();
  return provider === "mimo" || model.includes("mimo")
    ? { "api-key": key }
    : { Authorization: `Bearer ${key}` };
}

async function postJson(ctx, url, headers, body) {
  if (!ctx?.network?.fetch) throw new Error("Hana 尚未提供受控网络接口。");
  try {
    return await ctx.network.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      timeoutMs: SYNTH_TIMEOUT_MS,
      maxResponseBytes: SYNTH_MAX_RESPONSE_BYTES,
    });
  } catch (error) {
    // 宿主抛的是英文原文（…response exceeded N），直接显示在面板上没人看得懂。
    const text = `${error?.code || ""} ${error?.message || error}`;
    if (/response exceeded/i.test(text)) {
      throw new Error("这段太长，合成出来的音频超过了单次能取回的大小。截短一段再读，或者把设置里的「最长朗读字数」调小。");
    }
    throw error;
  }
}

// ─── 二进制回包（speech 协议）───
// 跟 postJson 分开：那个走 response.json()，这里要的是原始字节。
// 宿主网络层内部已经 await response.arrayBuffer()（2026-10-20 查过 bundle），
// 但 App 侧包成什么形状得实测，所以取字节这几步都带兜底。
function headerOf(response, name) {
  const headers = response?.headers;
  const target = String(name || "").toLowerCase();
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(target) ?? "");
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      if (Array.isArray(pair) && String(pair[0] ?? "").toLowerCase() === target) return String(pair[1] ?? "");
    }
    return "";
  }
  if (typeof headers === "object") {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === target) return String(value ?? "");
    }
  }
  return "";
}

function responseOk(response) {
  if (typeof response?.ok === "boolean") return response.ok;
  const status = Number(response?.status);
  return Number.isFinite(status) ? status >= 200 && status < 300 : false;
}

async function readAudioBinary(response) {
  if (typeof response?.arrayBuffer === "function") return Buffer.from(await response.arrayBuffer());
  if (response?.body instanceof ArrayBuffer) return Buffer.from(response.body);
  if (ArrayBuffer.isView(response?.body)) {
    return Buffer.from(response.body.buffer, response.body.byteOffset, response.body.byteLength);
  }
  if (typeof response?.text === "function") {
    // 文本通道会把非 ASCII 字节做 UTF-8 解码，还原不回来。发现越界字符就报错，不拼一段坏音频。
    const text = await response.text();
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) > 0xff) throw new Error("这个 Hana 版本没法从朗读接口取回二进制音频。");
    }
    return Buffer.from(text, "latin1");
  }
  throw new Error("这个 Hana 版本没法从朗读接口取回二进制音频。");
}

async function readErrorDetail(response) {
  try {
    if (typeof response?.json === "function") return apiError(await response.json(), "");
    if (typeof response?.text === "function") return String(await response.text()).trim().slice(0, 200);
  } catch { /* 读不出来就按状态码说话 */ }
  return "";
}

function speechHttpError(status, detail) {
  const suffix = detail ? `（服务说：${detail}）` : "";
  const error = new Error(`语音合成失败（HTTP ${status}）${suffix}`);
  error.retryable = false;
  if (status === 404 || status === 405 || status === 501) {
    error.message = `这个地址没有 /audio/speech 接口。确认填的是 TTS 服务，不是聊天模型；有些服务要求变量里带 /v1，试试在地址后面补上。${suffix}`;
  } else if (status === 401 || status === 403) {
    error.message = "这个服务的 Key 没被认。要么 Key 填错了，要么它根本不需要 Key：把 Key 清空、鉴权方式选「不要鉴权」再试。";
  } else if (status === 429) {
    error.message = "这个服务被限流了，等一会儿再试。";
  } else if (status === 400 || status === 415 || status === 422) {
    error.message = `这个服务不接受当前的合成参数（HTTP ${status}）${suffix}`;
    error.retryable = true;
  } else if (status >= 500) {
    error.message = `TTS 服务自己出错了（HTTP ${status}），不是知意这边的问题${suffix}`;
  }
  return error;
}

async function postBinary(ctx, url, headers, body) {
  if (!ctx?.network?.fetch) throw new Error("Hana 尚未提供受控网络接口。");
  let response;
  try {
    response = await ctx.network.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      timeoutMs: SYNTH_TIMEOUT_MS,
      maxResponseBytes: SYNTH_MAX_RESPONSE_BYTES,
    });
  } catch (error) {
    const text = `${error?.code || ""} ${error?.message || error}`;
    if (/response exceeded/i.test(text)) {
      throw new Error("这段太长，合成出来的音频超过了单次能取回的大小。截短一段再读，或者把设置里的「最长朗读字数」调小。");
    }
    throw error;
  }
  const status = Number(response?.status) || 0;
  if (!responseOk(response)) throw speechHttpError(status, await readErrorDetail(response));
  if (/json/i.test(headerOf(response, "content-type"))) {
    // 200 却回 JSON：多半是路径不对，或者这个服务不认当前格式。
    const detail = await readErrorDetail(response);
    const error = new Error(`这个地址回的是 JSON，不是音频${detail ? `：${detail}` : ""}。确认填的是 /audio/speech 一类的 TTS 地址。`);
    error.retryable = true;
    throw error;
  }
  const audio = await readAudioBinary(response);
  if (!audio?.length) throw new Error("TTS 服务没有返回音频内容。");
  return audio;
}

async function responseJson(response) {
  try { return await response.json(); } catch { return {}; }
}

function apiError(data, fallback) {
  const values = [data?.base_resp?.status_msg, data?.message, data?.error?.message, data?.error];
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 200);
  }
  return fallback;
}

async function synthesizeT2a(ctx, config, text, plainKey = "") {
  const key = plainKey || await unprotectKey(String(config.apiKey || ""));
  if (!key) throw new Error("还没有配置 MiniMax API Key。");
  const response = await postJson(ctx, buildT2aUrl(config.baseUrl || DEFAULT_TTS_BASE_URL, config.groupId), { Authorization: `Bearer ${key}` }, {
    model: config.model || DEFAULT_TTS_MODEL,
    text: String(text ?? ""),
    stream: false,
    language_boost: "auto",
    // 字幕不额外计费：能拿到词级时间戳就拿，拿不到也不影响音频本身。
    subtitle_enable: true,
    subtitle_type: "word",
    voice_setting: {
      voice_id: config.voiceId || "female-shaonv",
      speed: clampNum(config.speed, 0.5, 2, 1),
      vol: 1,
      pitch: 0,
    },
    // 64kbps：语音够用，体积比 128kbps 小一半。回给宿主的 details.audio 是 base64，
    // 800 字在 64kbps 下约 1.5MB（base64 约 2MB），不容易卡在播放器那边。
    audio_setting: { sample_rate: 32000, bitrate: 64000, format: "mp3", channel: 1 },
  });
  const data = await responseJson(response);
  if (!response.ok) throw new Error(apiError(data, `语音合成失败（HTTP ${response.status}）`));
  const audio = decodeAudio(data?.data?.audio);
  if (!audio) throw new Error("MiniMax 没有返回可播放的音频。");
  const inline = parseSubtitleFile(JSON.stringify({ subtitle: data?.data?.subtitle ?? [] }));
  const timings = inline || await fetchWordTimings(ctx, data?.data?.subtitle_file);
  return { audio, format: "mp3", durationMs: audioDurationMs(audio, "mp3"), model: config.model, timings };
}

async function synthesizeChat(ctx, config, text, plainKey = "") {
  const key = plainKey || await unprotectKey(String(config.apiKey || ""));
  if (!key) throw new Error("还没有配置朗读模型的 API Key。");
  const base = normalizeBaseUrl(config.baseUrl);
  if (!config.model) throw new Error("还没有填写朗读模型名。");
  const response = await postJson(ctx, `${base}/chat/completions`, voiceRequestHeaders(config, key), {
    model: config.model,
    messages: [
      { role: "user", content: "用自然、亲近、语速正常的语气说下面这句话。" },
      { role: "assistant", content: String(text ?? "").slice(0, MAX_REPLY_CHARS) },
    ],
    // MiMo 实测：audio.voice 必填，缺了直接 500；空音色用默认。
    audio: { voice: config.voiceId || "mimo_default" },
  });
  const data = await responseJson(response);
  if (!response.ok) throw new Error(apiError(data, `语音合成失败（HTTP ${response.status}）`));
  const message = data?.choices?.[0]?.message;
  const audio = decodeAudio(message?.audio?.data ?? data?.data?.audio);
  if (!audio) throw new Error("语音模型没有返回可播放的音频：模型不可用或没有语音权限，换个模型试试。");
  const format = data?.data?.format === "mp3" ? "mp3" : "wav";
  return { audio, format, durationMs: audioDurationMs(audio, format), model: config.model, timings: null };
}

/** 标准 OpenAI TTS 层：POST {base}/audio/speech，回二进制音频。 */
async function synthesizeSpeech(ctx, config, text, plainKey = "") {
  const key = plainKey || await unprotectKey(String(config.apiKey || ""));
  const base = normalizeBaseUrl(config.baseUrl);
  if (!config.model) throw new Error("还没有填写朗读模型名。");
  const payload = {
    model: config.model,
    input: String(text ?? "").slice(0, MAX_REPLY_CHARS),
    voice: String(config.voiceId || config.defaultVoiceId || "").trim() || "default",
    speed: clampNum(config.speed, 0.5, 2, 1),
  };
  // mp3 体积小，宿主播放器与球都认；被拒了再退 wav。
  // pcm 不试：裸数据没文件头，算不出时长，宁可不提供这个选项。
  let lastError = null;
  for (const format of ["mp3", "wav"]) {
    try {
      const audio = await postBinary(ctx, `${base}/audio/speech`, voiceRequestHeaders(config, key), {
        ...payload,
        response_format: format,
      });
      return { audio, format, durationMs: audioDurationMs(audio, format), model: config.model, timings: null };
    } catch (error) {
      lastError = error;
      // 401 / 404 / 5xx 换格式也没用，别多发一次请求。
      if (!error?.retryable) throw error;
    }
  }
  throw lastError || new Error("语音合成失败。");
}

/**
 * 统一入口。三样缺一不可就直说是哪一样，不静默回落。
 * voiceId 传空时由 resolveVoiceIdForAgent 的结果或协议默认值兜底。
 */
export async function synthesizeVoice(ctx, { text, config, voiceId = "", sdk = null } = {}) {
  const normalized = normalizeVoiceConfig(config);
  if (!normalized.enabled) throw new Error("语音朗读还没打开。");
  if (!voiceIsConfigured(normalized)) {
    // speech 协议不把 Key 当必填，提示里也就不列它，免得用户对着一个不存在的必填项发愁。
    const keyRequired = !normalized.useHanaCredential && normalized.protocol !== "speech";
    const missing = [!normalized.baseUrl && "接口地址", !normalized.model && "模型名", keyRequired && !normalized.apiKey && "API Key"]
      .filter(Boolean).join("、");
    throw new Error(`朗读模型还没配齐：缺 ${missing}。去「设置 → 知意设置 → 语音朗读」补上。`);
  }
  const body = String(text || "").trim();
  if (!body) throw new Error("没有可朗读的内容。");
  const safeConfig = { ...normalized, voiceId: String(voiceId || "").trim() || normalized.defaultVoiceId };
  // 勾了「用 Hana 里的 Key」就先要凭据：要不到就把理由原样抛出去，不发空 Key 的请求。
  let plainKey = "";
  if (normalized.useHanaCredential) {
    const credential = await resolveHanaCredential(sdk || ctx, normalized.providerId);
    plainKey = credential.apiKey;
    // 宿主给的地址优先；但预设里写死的官方地址更稳，所以只在宿主没给时回退。
    if (!safeConfig.baseUrl && credential.baseUrl) safeConfig.baseUrl = credential.baseUrl;
  }
  if (safeConfig.protocol === "t2a") return synthesizeT2a(ctx, safeConfig, body, plainKey);
  if (safeConfig.protocol === "speech") return synthesizeSpeech(ctx, safeConfig, body, plainKey);
  return synthesizeChat(ctx, safeConfig, body, plainKey);
}

// ─── 合成结果落盘 ───
// 音频只留在 App 自己的数据目录，回包给页面/球的是片段 id，不是一次性 base64。
export function clipDirectory(sdk) {
  return path.join(sdk.dataDir, "voice-clips");
}

export function isValidClipId(value) {
  return /^[A-Za-z0-9_-]{1,80}$/.test(String(value || ""));
}

export function clipFile(sdk, clipId, format = "mp3") {
  const safeFormat = format === "wav" ? "wav" : "mp3";
  return path.join(clipDirectory(sdk), `${String(clipId)}.${safeFormat}`);
}

export function saveClip(sdk, clipId, audio, format = "mp3") {
  const dir = clipDirectory(sdk);
  fs.mkdirSync(dir, { recursive: true });
  const file = clipFile(sdk, clipId, format);
  fs.writeFileSync(file, audio);
  return file;
}

export function readClip(sdk, clipId, format = "mp3") {
  if (!isValidClipId(clipId)) return null;
  const file = clipFile(sdk, clipId, format);
  if (!fs.existsSync(file)) return null;
  try { return fs.readFileSync(file); } catch { return null; }
}

export function clipExists(sdk, clipId, format = "mp3") {
  return isValidClipId(clipId) && fs.existsSync(clipFile(sdk, clipId, format));
}

// 逐词时间戳跟着音频存在旁边的 json 里，不用塞进全局存储：
// 一段长回复的 timings 就能到几百 KB，攒几十条会把 storage 撑肿；
// 命中缓存时读 sidecar 就能把字幕原样还回页面，高亮不会退化成全文。
export function clipMetaFile(sdk, clipId) {
  return path.join(clipDirectory(sdk), `${String(clipId)}.json`);
}

export function saveClipMeta(sdk, clipId, meta) {
  const dir = clipDirectory(sdk);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(clipMetaFile(sdk, clipId), JSON.stringify(meta));
}

export function readClipMeta(sdk, clipId) {
  if (!isValidClipId(clipId)) return null;
  try {
    return JSON.parse(fs.readFileSync(clipMetaFile(sdk, clipId), "utf8"));
  } catch {
    return null;
  }
}
