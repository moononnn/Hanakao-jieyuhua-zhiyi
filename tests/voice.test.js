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
  assert.equal(resolveVoiceIdForAgent(config, "yumi"), "female-yujie");
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
  assert.equal(synthCall.init.maxResponseBytes, 4 * 1024 * 1024);
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
