import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REPLY_CHARS,
  audioDurationMs,
  buildT2aUrl,
  cleanReadableText,
  extractReadableText,
  isMaskedKey,
  maskVoiceConfig,
  normalizeVoiceConfig,
  parseSubtitleFile,
  resolveVoiceIdForAgent,
  stripHiddenMetaBlocks,
  synthesizeVoice,
  voiceIsConfigured,
  voiceRequestHeaders,
  voicesForProtocol,
} from "../lib/voice.js";

function responseOf(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function createFetch(result) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return typeof result === "function" ? result(url, init) : result;
  };
  return { fetch, calls };
}

const readyConfig = {
  enabled: true,
  protocol: "t2a",
  baseUrl: "https://api.minimaxi.com",
  model: "speech-2.8-hd",
  groupId: "123",
  apiKey: "plain-key",
  speed: 1,
  scope: "all",
  maxChars: 800,
  defaultVoiceId: "female-shaonv",
  voiceByAgent: {},
};

test("朗读配置归一化：缺字段补默认，越界值夹回范围，掩码不丢真 Key", () => {
  const config = normalizeVoiceConfig({ speed: "9", scope: "weird", maxChars: 1e9, voiceByAgent: { "a b": "x", "": "y", c: "" } });
  assert.equal(config.speed, 2);
  assert.equal(config.scope, "all");
  assert.equal(config.maxChars, MAX_REPLY_CHARS * 10);
  assert.deepEqual(config.voiceByAgent, { "a b": "x" });
  assert.equal(isMaskedKey("********"), true);
  assert.equal(isMaskedKey("sk-123"), false);
  const masked = maskVoiceConfig({ ...readyConfig, apiKey: "dpapi:abc" });
  assert.equal(masked.apiKey, "********");
});

test("伙伴专属音色优先，其次默认音色", () => {
  const config = { ...readyConfig, defaultVoiceId: "female-yujie", voiceByAgent: { xiaohua: "qiaopi_mengmei" } };
  assert.equal(resolveVoiceIdForAgent(config, "xiaohua"), "qiaopi_mengmei");
  assert.equal(resolveVoiceIdForAgent(config, "agent-other"), "female-yujie");
  assert.equal(voiceIsConfigured(config), true);
  assert.equal(voiceIsConfigured({ ...readyConfig, apiKey: "" }), false);
  assert.ok(voicesForProtocol("chat").some((item) => item.id === "mimo_default"));
});

test("朗读文本只取可见正文：隐藏块、代码块、Markdown 都不进语音", () => {
  const raw = "<mood>\nVibe: 心里一暖\n</mood>\n先看土壤干湿。\n```js\nconst a = 1;\n```\n**重点**是别浇太多，[文档](https://x.y) 也看一眼。";
  assert.equal(stripHiddenMetaBlocks(raw).includes("心里一暖"), false);
  const cleaned = cleanReadableText(raw);
  assert.equal(cleaned.includes("const a"), false);
  assert.equal(cleaned.includes("**"), false);
  assert.match(cleaned, /重点是别浇太多，文档 也看一眼。/);
  // 未闭合的隐藏块同样不能带进朗读
  assert.equal(stripHiddenMetaBlocks("前面这句。<mood>后面这些").includes("后面这些"), false);
});

test("只念引号台词：没有引号时回退整条并如实标记", () => {
  const withQuote = extractReadableText("我念一句：「今天浇水了吗？」剩下的不念。", "quoted", 800);
  assert.equal(withQuote.matched, true);
  assert.equal(withQuote.text, "今天浇水了吗？");
  const withoutQuote = extractReadableText("今天没有引号台词。", "quoted", 800);
  assert.equal(withoutQuote.matched, false);
  assert.equal(withoutQuote.text, "今天没有引号台词。");
  const long = extractReadableText("一二三四五六七八九十".repeat(40), "all", 20);
  assert.equal(long.truncated, true);
  assert.ok(long.text.length <= 20);
});

test("字幕解析认新旧两套字段名，也认 SRT，认不出就返回 null", () => {
  const wordLevel = parseSubtitleFile(JSON.stringify({
    subtitle: [{
      timestamped_words: [
        { word: "今天", time_begin: 43, time_end: 320 },
        { word: "浇水", begin_time: 320, end_time: 610 },
      ],
    }],
  }));
  assert.deepEqual(wordLevel, [
    { start: 43, end: 320, text: "今天" },
    { start: 320, end: 610, text: "浇水" },
  ]);
  const sentenceLevel = parseSubtitleFile(JSON.stringify([{ text: "整句。", time_begin: 0, time_end: 900 }]));
  assert.equal(sentenceLevel.length, 1);
  const srt = parseSubtitleFile("1\n00:00:00,500 --> 00:00:02,000\n你好\n");
  assert.deepEqual(srt, [{ start: 500, end: 2000, text: "你好" }]);
  assert.equal(parseSubtitleFile("随便一段不是字幕"), null);
});

test("WAV 时长从 data 块算，MP3 至少能给出一个估计", () => {
  const byteRate = 32000;
  const dataSize = byteRate * 2;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt32LE(byteRate, 28);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  assert.equal(audioDurationMs(Buffer.concat([header, Buffer.alloc(dataSize)]), "wav"), 2000);
  assert.equal(audioDurationMs(Buffer.alloc(0), "wav"), null);
});

test("接口地址与鉴权头按协议来", () => {
  assert.equal(buildT2aUrl("https://api.minimaxi.com/", " 123 "), "https://api.minimaxi.com/v1/t2a_v2?GroupId=123");
  assert.deepEqual(voiceRequestHeaders({ providerId: "mimo" }, "k"), { "api-key": "k" });
  assert.deepEqual(voiceRequestHeaders({ providerId: "minimax" }, "k"), { Authorization: "Bearer k" });
  assert.throws(() => buildT2aUrl("ftp://x", ""), /地址/);
});

test("没配齐就不合成，也不发任何请求", async () => {
  const { fetch, calls } = createFetch(new Response("{}", { status: 200 }));
  await assert.rejects(
    () => synthesizeVoice({ network: { fetch } }, { text: "念我", config: { ...readyConfig, apiKey: "" } }),
    /API Key/,
  );
  await assert.rejects(
    () => synthesizeVoice({ network: { fetch } }, { text: "念我", config: { ...readyConfig, enabled: false } }),
    /还没打开/,
  );
  await assert.rejects(
    () => synthesizeVoice({ network: { fetch } }, { text: "   ", config: readyConfig }),
    /没有可朗读/,
  );
  assert.equal(calls.length, 0);
});

test("MiniMax 合成：HEX 音频解对、词级字幕解对、请求带上限与超时", async () => {
  const net = createFetch((url) => {
    if (String(url).includes("aliyuncs.com")) {
      return new Response(JSON.stringify({ subtitle: [{ timestamped_words: [{ word: "念我", time_begin: 10, time_end: 90 }] }] }), { status: 200 });
    }
    return responseOf({
      data: {
        audio: "4944330300000000",
        subtitle_file: "https://minimax-algeng-chat-tts.oss-cn-wulanchabu.aliyuncs.com/x.json",
      },
    });
  });
  const result = await synthesizeVoice({ network: net }, { text: "念我", config: readyConfig, voiceId: "female-yujie" });
  assert.equal(result.format, "mp3");
  assert.ok(result.audio.equals(Buffer.from("4944330300000000", "hex")));
  assert.deepEqual(result.timings, [{ start: 10, end: 90, text: "念我" }]);
  const synthCall = net.calls[0];
  assert.match(synthCall.url, /api\.minimaxi\.com\/v1\/t2a_v2\?GroupId=123/);
  assert.equal(synthCall.init.timeoutMs, 30_000);
  assert.equal(synthCall.init.maxResponseBytes, 8 * 1024 * 1024);
  const body = JSON.parse(synthCall.init.body);
  assert.equal(body.voice_setting.voice_id, "female-yujie");
  assert.equal(body.subtitle_type, "word");
  assert.equal(synthCall.init.headers.Authorization, "Bearer plain-key");
  assert.match(net.calls[1].url, /aliyuncs\.com/);
});

test("字幕拉不到就安静退回整段点亮，不影响音频本身", async () => {
  const net = createFetch(() => responseOf({ data: { audio: "49443303", subtitle_file: "https://x.oss-cn-wulanchabu.aliyuncs.com/x.json" } }));
  const result = await synthesizeVoice({ network: net }, { text: "念我", config: readyConfig });
  assert.equal(result.timings, null);
  assert.ok(result.audio.length > 0);
  assert.equal(net.calls.length, 2);
});

test("OpenAI 兼容合成缺音频时报人话，不把报错文本当音频", async () => {
  const net = createFetch(() => responseOf({ choices: [{ message: { content: "抱歉，我不能合成语音" } }] }));
  await assert.rejects(
    () => synthesizeVoice({ network: net }, { text: "念我", config: { ...readyConfig, protocol: "chat", providerId: "mimo", model: "mimo-v2.5-tts", baseUrl: "https://api.xiaomimimo.com/v1" } }),
    /没有返回可播放的音频/,
  );
});

test("宿主报响应超限时给人话，不把英文原文甩到面板上", async () => {
  const net = {
    calls: [],
    async fetch() {
      throw new Error("Plugin network.fetch response exceeded 8388608");
    },
  };
  await assert.rejects(
    () => synthesizeVoice({ network: net }, { text: "念我", config: readyConfig }),
    (error) => {
      assert.match(String(error?.message), /这段太长/);
      assert.ok(!/response exceeded/i.test(String(error?.message)), "英文原文不能原样冒出去");
      return true;
    },
  );
});

// ─── speech 协议（自建 / 第三方标准 TTS）───
const speechConfig = {
  enabled: true,
  protocol: "speech",
  baseUrl: "http://127.0.0.1:9880/",
  model: "tts-1",
  authStyle: "none",
  apiKey: "",
  speed: 1,
  scope: "all",
  maxChars: 800,
  defaultVoiceId: "zh-CN-XiaoxiaoNeural",
  voiceByAgent: {},
};

test("speech 协议：不要求 Key，音色手填，走 /audio/speech 取二进制", async () => {
  const audio = Buffer.from("4944330400000000", "hex");
  const net = createFetch(() => new Response(audio, { status: 200, headers: { "content-type": "audio/mpeg" } }));
  assert.equal(voiceIsConfigured(speechConfig), true, "自建 TTS 不校验 Key，缺 Key 也算配齐");
  const result = await synthesizeVoice({ network: net }, { text: "念我", config: speechConfig });
  assert.equal(result.format, "mp3");
  assert.ok(result.audio.equals(audio));
  assert.equal(result.timings, null, "这套协议没有字幕能力，不编一份出来");
  const call = net.calls[0];
  assert.equal(call.url, "http://127.0.0.1:9880/audio/speech");
  const body = JSON.parse(call.init.body);
  assert.equal(body.response_format, "mp3");
  assert.equal(body.voice, "zh-CN-XiaoxiaoNeural");
  assert.equal(body.input, "念我");
  assert.equal(call.init.headers.Authorization, undefined, "鉴权选 none 就不该带 Authorization");
});

test("speech 协议：不支持 mp3 时退一次 wav，404 不重试", async () => {
  const wav = Buffer.from("5249464600000000", "hex");
  const net = createFetch((url, init) => {
    const body = JSON.parse(init.body);
    if (body.response_format === "mp3") {
      return new Response(JSON.stringify({ error: "unsupported format" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(wav, { status: 200, headers: { "content-type": "audio/wav" } });
  });
  const result = await synthesizeVoice({ network: net }, { text: "念我", config: speechConfig });
  assert.equal(result.format, "wav");
  assert.equal(net.calls.length, 2, "退格式只多打一次，不反复试");

  const notFound = createFetch(() => new Response("{}", { status: 404, headers: { "content-type": "application/json" } }));
  await assert.rejects(
    () => synthesizeVoice({ network: notFound }, { text: "念我", config: speechConfig }),
    /没有 \/audio\/speech 接口/,
  );
  assert.equal(notFound.calls.length, 1, "404 换格式也没用，不该再打一次");
});

test("鉴权方式显式化，没选过的老配置仍按 providerId 猜", () => {
  assert.deepEqual(voiceRequestHeaders({ authStyle: "bearer" }, "k"), { Authorization: "Bearer k" });
  assert.deepEqual(voiceRequestHeaders({ authStyle: "api-key" }, "k"), { "api-key": "k" });
  assert.deepEqual(voiceRequestHeaders({ authStyle: "none" }, "k"), {});
  const legacyMimo = normalizeVoiceConfig({ protocol: "chat", providerId: "mimo", baseUrl: "https://x", model: "mimo-v2.5-tts" });
  assert.equal(legacyMimo.authStyle, "", "老配置不该被默默改成 bearer");
  assert.deepEqual(voiceRequestHeaders(legacyMimo, "k"), { "api-key": "k" });
});

test("协议归一化认识 speech，认不出的值仍落回 chat，音色目录给空", () => {
  assert.equal(normalizeVoiceConfig({ protocol: "speech" }).protocol, "speech");
  assert.equal(normalizeVoiceConfig({ protocol: "weird" }).protocol, "chat");
  assert.deepEqual(voicesForProtocol("speech"), []);
  assert.equal(voiceIsConfigured({ ...speechConfig, baseUrl: "" }), false);
});

test("宿主 Response 没暴露 arrayBuffer 时退回文本读法，拿到文字就报错", async () => {
  const audio = Buffer.from([0x49, 0x44, 0x33, 0x00, 0xff, 0x10]);
  const asText = {
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: [["content-type", "audio/mpeg"]],
      text: async () => audio.toString("latin1"),
    }),
  };
  const result = await synthesizeVoice({ network: asText }, { text: "念我", config: speechConfig });
  assert.ok(result.audio.equals(audio), "latin1 一对一还原字节");

  const broken = {
    fetch: async () => ({ ok: true, status: 200, headers: [["content-type", "audio/mpeg"]], text: async () => "这是文字" }),
  };
  await assert.rejects(
    () => synthesizeVoice({ network: broken }, { text: "念我", config: speechConfig }),
    /二进制音频/,
  );
});
