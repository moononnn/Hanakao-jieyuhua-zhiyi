import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import app from "../index.js";

// 这份只测语音朗读相关的路由。上下文照 app-tool.test.js 的形状抄一份最小可用的，
// 单独成文件是为了不去动那份已经很大的公用夹具。

function createContext({
  storageSeed = {},
  sessionList = [{ sessionId: "sess_1", path: "sessions/a.jsonl", agentId: "hanako", agentName: "小花", title: "今天", modified: 20 },
    { sessionId: "sess_0", path: "sessions/b.jsonl", agentId: "test_partner", agentName: "测试伙伴", title: "更早", modified: 10 }],
  sessionListError = null,
  agentList = [{ id: "hanako", name: "小花" }, { id: "test_partner", name: "测试伙伴" }],
  agentListError = null,
  historyMessages = [
    { role: "user", content: "今天浇水了吗？", entryId: "u1" },
    { role: "assistant", content: "<mood>Vibe: 暖</mood>「浇过啦，」我看着土还是湿的。", entryId: "a1" },
    { role: "user", content: "再念一遍", entryId: "u2" },
  ],
  fetchResult = null,
  dataDir = "",
} = {}) {
  const routes = new Map();
  const storage = new Map(Object.entries(storageSeed));
  const fetchCalls = [];
  const listCalls = [];
  const agentListCalls = [];
  const subscribed = [];
  const sendCalls = [];
  const registered = new Map();
  const context = {
    dataDir,
    bus: {
      subscribe: (callback, filter) => { subscribed.push({ callback, filter }); return () => {}; },
      request: async (verb, input) => {
        if (verb === "agent:list") {
          agentListCalls.push(input);
          if (agentListError) throw agentListError;
          return { agents: agentList };
        }
        if (verb === "session:list") {
          listCalls.push(input);
          if (sessionListError) throw sessionListError;
          return { sessions: sessionList };
        }
        if (verb === "session:history") return { messages: historyMessages };
        if (verb === "session:send") {
          sendCalls.push(input);
          return { ok: true, accepted: true, sessionId: input?.sessionId };
        }
        return null;
      },
    },
    logger: { info: async () => {}, warn: async () => {}, debug: async () => {} },
    tools: { register: async (spec) => { registered.set(spec.name, spec); return { ready: Promise.resolve() }; } },
    routes: { register: async (registrar) => {
      registrar({
        // 宿主自带 app.use 中间件链；测试只断言处理器结果，这里当空操作。
        use: () => {},
        get: (routePath, handler) => routes.set(`GET ${routePath}`, handler),
        post: (routePath, handler) => routes.set(`POST ${routePath}`, handler),
        put: (routePath, handler) => routes.set(`PUT ${routePath}`, handler),
      });
      return { ready: Promise.resolve(), dispose() {} };
    } },
    process: { resolveExecutable: async () => null },
    sessions: {
      context: async () => ({ model: { provider: "test-provider", modelId: "test-model" } }),
      history: async () => ({ messages: historyMessages }),
    },
    resources: { stage: async () => { throw new Error("不应暂存文件"); } },
    network: { fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      if (!fetchResult) throw new Error("测试里没有给网络回包");
      return typeof fetchResult === "function" ? fetchResult(url, init) : fetchResult;
    } },
    models: { list: async () => ({ models: [] }), stream: async () => new Response(""), cancel: async () => {} },
    media: {},
    providers: {},
    hooks: { onDecision: async () => ({ ready: Promise.resolve(), dispose() {} }) },
    userInteraction: { ask: async () => ({ action: "confirmed", value: { choice: "好" } }) },
    storage: { global: {
      get: (key, fallback = undefined) => (storage.has(key) ? storage.get(key) : fallback),
      set: (key, value) => { storage.set(key, value); },
    }, agent: () => ({}) },
  };
  return { context, fetchCalls, listCalls, agentListCalls, subscribed, sendCalls, tool(name) { return registered.get(name); }, route(method, routePath) { return routes.get(`${method} ${routePath}`); }, stored(key) { return storage.get(key); } };
}

function jsonRoute(data, status = 200) {
  return { json: (payload, code) => ({ data: payload, status: code || status }) };
}

const voiceConfig = {
  enabled: true,
  protocol: "t2a",
  providerId: "minimax",
  baseUrl: "https://api.minimaxi.com",
  model: "speech-2.8-hd",
  groupId: "123",
  apiKey: "sk-real-key",
  speed: 1,
  scope: "all",
  maxChars: 800,
  defaultVoiceId: "female-shaonv",
  voiceByAgent: {},
};

function audioResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

async function boot(options) {
  const mock = createContext(options);
  await app.apply(mock.context);
  return mock;
}

test("断联续接订阅宿主事件时显式给了第二个参数", async () => {
  const mock = await boot({ storageSeed: { voiceConfig } });
  assert.equal(mock.subscribed.length, 1);
  // 省略第二个参数会在装载阶段把整条安装记录搞没，这里钉住。
  assert.deepEqual(mock.subscribed[0].filter, {});
  assert.equal(typeof mock.subscribed[0].callback, "function");
});

test("朗读设置读取时掩掉 Key，并从会话名单聚合出最近聊过的伙伴", async () => {
  const mock = await boot({ storageSeed: { voiceConfig } });
  const response = await mock.route("GET", "/voice-config")(jsonRoute());
  assert.equal(response.data.ok, true);
  assert.equal(response.data.config.apiKey, "********");
  assert.deepEqual(response.data.partners, [{ agentId: "hanako", agentName: "小花" }, { agentId: "test_partner", agentName: "测试伙伴" }]);
  assert.equal(response.data.partnersNote, "");
  assert.ok(response.data.voiceLibrary.t2a.length > 0);
  assert.ok(response.data.voiceLibrary.chat.length > 0);
  assert.equal(JSON.stringify(response.data).includes("sk-real-key"), false);
});

test("两份名单都读不到时如实说明，而不是给一个空伙伴列表装没事", async () => {
  const mock = await boot({ sessionListError: new Error("没有授权"), agentListError: new Error("也没有授权") });
  const response = await mock.route("GET", "/voice-config")(jsonRoute());
  assert.deepEqual(response.data.partners, []);
  assert.match(response.data.partnersNote, /伙伴名单读不到/);
});

test("伙伴名单优先用 agent:list，没聊过的伙伴也要在", async () => {
  const mock = await boot({ agentList: [{ id: "hanako", name: "小花" }, { id: "quiet_one", name: "没聊过的那位" }] });
  const response = await mock.route("GET", "/voice-config")(jsonRoute());
  assert.deepEqual(response.data.partners, [{ agentId: "hanako", agentName: "小花" }, { agentId: "quiet_one", agentName: "没聊过的那位" }]);
  assert.equal(response.data.partnersNote, "");
  assert.ok(mock.agentListCalls.length > 0, "应该真的去问过宿主完整名单");
  assert.equal(mock.listCalls.length, 0, "拿到完整名单就不该再退回去读会话名单");
});

test("agent:list 拿不到时退回会话名单，并如实说明这份名单的来路", async () => {
  const mock = await boot({ agentListError: new Error("没授权") });
  const response = await mock.route("GET", "/voice-config")(jsonRoute());
  assert.deepEqual(response.data.partners, [{ agentId: "hanako", agentName: "小花" }, { agentId: "test_partner", agentName: "测试伙伴" }]);
  assert.match(response.data.partnersNote, /最近聊过/);
});

test("保存设置时回传掩码不会把真 Key 覆盖掉", async () => {
  const mock = await boot({ storageSeed: { voiceConfig } });
  const put = async (body) => (await mock.route("PUT", "/voice-config")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => body },
  }));
  const kept = await put({ config: { ...voiceConfig, apiKey: "********", scope: "quoted" } });
  assert.equal(kept.data.ok, true);
  assert.equal(mock.stored("voiceConfig").apiKey, "sk-real-key");
  assert.equal(mock.stored("voiceConfig").scope, "quoted");
  const replaced = await put({ config: { ...voiceConfig, apiKey: "sk-new-key", speed: 1.15 } });
  assert.equal(replaced.data.ok, true);
  assert.equal(mock.stored("voiceConfig").speed, 1.15);
  assert.ok(String(mock.stored("voiceConfig").apiKey).length > 0);
});

test("朗读列表给出最近的伙伴回复，带编号与字数", async () => {
  const mock = await boot({ storageSeed: { voiceConfig } });
  const response = await mock.route("GET", "/voice/replies")({
    json: (payload, status) => ({ data: payload, status }),
    req: { query: (key) => (key === "limit" ? "8" : "") },
  });
  assert.equal(response.data.ok, true);
  assert.equal(response.data.session.sessionId, "sess_1");
  assert.equal(response.data.replies.length, 1);
  assert.equal(response.data.replies[0].entryId, "a1");
  assert.equal(response.data.replies[0].preview.includes("Vibe"), false);
});

test("朗读列表按轮聚合：同一轮里分几次说的话合成一条，最新的排最前", async () => {
  const mock = await boot({
    storageSeed: { voiceConfig },
    historyMessages: [
      { role: "user", content: "第一个问题", entryId: "u1" },
      { role: "assistant", content: "<mood>Vibe: 暖</mood>第一轮的前半句。", entryId: "a1" },
      { role: "assistant", content: "第一轮的后半句。", entryId: "a2" },
      { role: "user", content: "第二个问题", entryId: "u2" },
      { role: "assistant", content: "<mood>Vibe: 静</mood>第二轮的一句。", entryId: "a3" },
    ],
  });
  const response = await mock.route("GET", "/voice/replies")({
    json: (payload, status) => ({ data: payload, status }),
    req: { query: (key) => (key === "limit" ? "8" : "") },
  });
  assert.equal(response.data.replies.length, 2, "两轮就该是两条，不是三条");
  assert.equal(response.data.replies[0].entryIds.length, 1);
  assert.equal(response.data.replies[0].entryId, "a3", "最新的一轮排最前");
  assert.equal(response.data.replies[1].entryIds.length, 2, "同一轮的两段要归成一条");
  assert.deepEqual(response.data.replies[1].entryIds, ["a1", "a2"]);
  assert.match(response.data.replies[1].preview, /第一轮的前半句/);
  assert.match(response.data.replies[1].preview, /后半句/);
  assert.equal(response.data.replies[0].isLatest, true, "最新一轮要自己带标记");
  assert.equal(response.data.replies[1].isLatest, false, "「最新」只能有一条");
});

test("按整轮合成：一次请求带上这一轮的所有编号，正文按顺序接起来念", async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "zhiyi-voice-round-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const mock = await boot({
    storageSeed: { voiceConfig },
    dataDir,
    historyMessages: [
      { role: "user", content: "第一个问题", entryId: "u1" },
      { role: "assistant", content: "前半句。", entryId: "a1" },
      { role: "assistant", content: "后半句。", entryId: "a2" },
    ],
    fetchResult: (url) => {
      if (String(url).includes("aliyuncs.com")) return new Response("[]", { status: 200 });
      return audioResponse({ data: { audio: "49443303" } });
    },
  });
  const response = await mock.route("POST", "/voice/speak")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ sessionId: "sess_1", entryIds: ["a1", "a2"] }) },
  });
  assert.equal(response.data.ok, true);
  assert.match(response.data.text, /前半句。/);
  assert.match(response.data.text, /后半句。/);
  const body = JSON.parse(mock.fetchCalls.find((call) => call.url.includes("api.minimaxi.com")).init.body);
  assert.match(String(body.text || body.input || ""), /前半句。[\s\S]*后半句。/, "两段要接在一起念");
});

test("认不出回复编号就停下，一次合成都不发", async () => {
  const mock = await boot({ storageSeed: { voiceConfig } });
  const response = await mock.route("POST", "/voice/speak")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ sessionId: "sess_1", entryId: "a404" }) },
  });
  assert.equal(response.status, 502);
  assert.match(response.data.error, /已经不在原对话里/);
  assert.equal(mock.fetchCalls.length, 0);
});

test("进「改稿」能要回整轮全文，不受列表 1200 字限制", async () => {
  const long = "很长的正文。".repeat(400);
  const mock = await boot({
    storageSeed: { voiceConfig },
    historyMessages: [
      { role: "user", content: "问题", entryId: "u1" },
      { role: "assistant", content: long, entryId: "a1" },
    ],
  });
  const response = await mock.route("GET", "/voice/reply-text")({
    json: (payload, status) => ({ data: payload, status }),
    req: { query: (key) => ({ sessionId: "sess_1", entryIds: "a1" }[key] || "") },
  });
  assert.equal(response.data.ok, true);
  assert.ok(response.data.text.length > 1200, "全文不能只给开头");
  assert.equal(response.data.chars, response.data.text.length);
});

test("改过稿就走文字通道：不套「只念引号」，也不按字数上限再砍一刀", async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "zhiyi-voice-draft-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  // 用户删改过的稿子：即使超过 maxChars、即使设了「只念引号」，也要完整念。
  const long = "删改后的正文。".repeat(120);
  assert.ok(long.length > 800);
  const mock = await boot({
    storageSeed: { voiceConfig: { ...voiceConfig, scope: "quoted", maxChars: 800 } },
    dataDir,
    fetchResult: (url) => String(url).includes("aliyuncs.com")
      ? new Response("[]", { status: 200 })
      : audioResponse({ data: { audio: "49443303" } }),
  });
  const response = await mock.route("POST", "/voice/speak")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ sessionId: "sess_1", entryId: "", entryIds: [], text: long, draft: true }) },
  });
  assert.equal(response.data.ok, true);
  assert.ok(response.data.text.length > 800, "改过的稿子不能被 800 字上限再截一次");
  const body = JSON.parse(mock.fetchCalls.find((call) => call.url.includes("api.minimaxi.com")).init.body);
  assert.ok(String(body.text || body.input || "").length > 800);
});

test("指定会话朗读时按该会话伙伴选择音色", async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "zhiyi-voice-partner-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const mock = await boot({
    storageSeed: { voiceConfig: { ...voiceConfig, voiceByAgent: { test_partner: "partner-voice" } } },
    dataDir,
    fetchResult: (url) => String(url).includes("aliyuncs.com")
      ? new Response("[]", { status: 200 })
      : audioResponse({ data: { audio: "4944330300000000" } }),
  });
  const response = await mock.route("POST", "/voice/speak")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ sessionId: "sess_0", entryId: "a1" }) },
  });
  assert.equal(response.data.ok, true);
  assert.equal(response.data.voiceId, "partner-voice");
  const request = mock.fetchCalls.find((call) => call.url.includes("api.minimaxi.com"));
  assert.equal(JSON.parse(request.init.body).voice_setting.voice_id, "partner-voice");
});

test("朗读开关关着时不允许合成", async () => {
  const mock = await boot({ storageSeed: { voiceConfig: { ...voiceConfig, enabled: false } } });
  const response = await mock.route("POST", "/voice/speak")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ sessionId: "sess_1", entryId: "a1" }) },
  });
  assert.equal(response.status, 502);
  assert.match(response.data.error, /还没打开/);
  assert.equal(mock.fetchCalls.length, 0);
});

test("合成成功：隐藏块不进语音，音频落盘并能按片段号取回", async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "zhiyi-voice-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const mock = await boot({
    storageSeed: { voiceConfig },
    dataDir,
    fetchResult: (url) => {
      if (String(url).includes("aliyuncs.com")) return new Response("[]", { status: 200 });
      return audioResponse({ data: {
        audio: "4944330300000000",
        subtitle: [{ timestamped_words: [
          { time_begin: 0, time_end: 280, word: "浇过啦" },
          { time_begin: 290, time_end: 450, word: "我" },
        ] }],
      } });
    },
  });
  const response = await mock.route("POST", "/voice/speak")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ sessionId: "sess_1", entryId: "a1" }) },
  });
  assert.equal(response.data.ok, true);
  assert.match(response.data.text, /^「浇过啦，」/);
  assert.equal(response.data.text.includes("Vibe"), false);
  assert.deepEqual(response.data.timings, [
    { start: 0, end: 280, text: "浇过啦" },
    { start: 290, end: 450, text: "我" },
  ]);
  assert.equal(response.data.format, "mp3");
  assert.equal(response.data.voiceId, "female-shaonv");
  assert.ok(existsSync(path.join(dataDir, "voice-clips", `${response.data.clipId}.mp3`)));

  const clip = await mock.route("GET", "/voice/clip/:clipId")({
    json: (payload, status) => ({ data: payload, status }),
    body: (bytes, status, headers) => ({ bytes, status, headers }),
    req: { param: (key) => (key === "clipId" ? response.data.clipId : ""), query: () => "mp3" },
  });
  assert.equal(clip.headers["content-type"], "audio/mpeg");
  assert.equal(clip.bytes.toString("utf8"), "ID3\x03\x00\x00\x00\x00");

  const missing = await mock.route("GET", "/voice/clip/:clipId")({
    json: (payload, status) => ({ data: payload, status }),
    body: (bytes, status) => ({ bytes, status }),
    req: { param: () => "clip_nope", query: () => "mp3" },
  });
  assert.equal(missing.status, 404);

  const illegal = await mock.route("GET", "/voice/clip/:clipId")({
    json: (payload, status) => ({ data: payload, status }),
    req: { param: () => "../../secret", query: () => "mp3" },
  });
  assert.equal(illegal.status, 400);
});

test("同一段话再合成一次直接命中缓存，不再出网，字级时间戳照样返回", async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "zhiyi-voice-cache-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const mock = await boot({
    storageSeed: { voiceConfig },
    dataDir,
    fetchResult: (url) => {
      if (String(url).includes("aliyuncs.com")) return new Response("[]", { status: 200 });
      return audioResponse({ data: {
        audio: "49443303",
        subtitle: [{ timestamped_words: [{ time_begin: 0, time_end: 280, word: "浇过啦" }] }],
      } });
    },
  });
  const speak = () => mock.route("POST", "/voice/speak")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ sessionId: "sess_1", entryId: "a1" }) },
  });

  const first = await speak();
  assert.equal(first.data.cached, false);
  const synthCalls = () => mock.fetchCalls.filter((call) => call.url.includes("api.minimaxi.com")).length;
  assert.equal(synthCalls(), 1);

  const second = await speak();
  assert.equal(second.data.ok, true);
  assert.equal(second.data.cached, true);
  assert.equal(second.data.clipId, first.data.clipId);
  assert.deepEqual(second.data.timings, [{ start: 0, end: 280, text: "浇过啦" }]);
  assert.equal(synthCalls(), 1);

  // 缓存里的音频还在，播放路由照样取得到。
  const clip = await mock.route("GET", "/voice/clip/:clipId")({
    json: (payload, status) => ({ data: payload, status }),
    body: (bytes, status, headers) => ({ bytes, status, headers }),
    req: { param: () => second.data.clipId, query: () => "mp3" },
  });
  assert.equal(clip.status, 200);
});

test("换音色后不再命中缓存，会重新合成", async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "zhiyi-voice-cache-voice-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const mock = await boot({
    storageSeed: { voiceConfig },
    dataDir,
    fetchResult: (url) => {
      if (String(url).includes("aliyuncs.com")) return new Response("[]", { status: 200 });
      return audioResponse({ data: { audio: "49443303" } });
    },
  });
  const first = await mock.route("POST", "/voice/speak")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ sessionId: "sess_1", entryId: "a1" }) },
  });
  assert.equal(first.data.cached, false);

  mock.seedStorage?.({ voiceConfig: { ...voiceConfig, speed: 1.2 } });
  await mock.route("PUT", "/voice-config")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ config: { ...voiceConfig, speed: 1.2 } }) },
  });
  const second = await mock.route("POST", "/voice/speak")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ sessionId: "sess_1", entryId: "a1" }) },
  });
  assert.equal(second.data.cached, false);
  assert.notEqual(second.data.clipId, first.data.clipId);
});

test("保存语音设置后回完整的一份：音色库和伙伴名单不能被清空", async () => {
  const mock = await boot({ storageSeed: { voiceConfig } });
  const put = await mock.route("PUT", "/voice-config")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ config: { ...voiceConfig, speed: 1.1 } }) },
  });
  assert.equal(put.data.ok, true);
  // 只回 config 的话，页面保存一次就把音色库清空，音色下拉里只剩「跟随默认」。
  assert.ok(Array.isArray(put.data.voices), "保存后也要带音色列表");
  assert.ok(Array.isArray(put.data.voiceLibrary?.t2a) && put.data.voiceLibrary.t2a.length > 0, "保存后也要带音色库");
  assert.ok(Array.isArray(put.data.partners), "保存后也要带伙伴名单");
  assert.ok(Array.isArray(put.data.presets), "保存后也要带预设");
});

test("音色试听：按指定音色合成，同一音色再点命中缓存不再出网", async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "zhiyi-voice-preview-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const mock = await boot({
    storageSeed: { voiceConfig },
    dataDir,
    fetchResult: (url) => {
      if (String(url).includes("aliyuncs.com")) return new Response("[]", { status: 200 });
      return audioResponse({ data: { audio: "49443303" } });
    },
  });
  const preview = (voiceId) => mock.route("POST", "/voice/preview")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ voiceId }) },
  });
  const synthCalls = () => mock.fetchCalls.filter((call) => call.url.includes("api.minimaxi.com")).length;

  const first = await preview("qiaopi_mengmei");
  assert.equal(first.data.ok, true);
  assert.equal(first.data.cached, false);
  assert.ok(first.data.clipId);
  const request = mock.fetchCalls.find((call) => call.url.includes("api.minimaxi.com"));
  assert.equal(JSON.parse(request.init.body).voice_setting.voice_id, "qiaopi_mengmei", "试听要用指定的那个音色");
  assert.equal(synthCalls(), 1);

  const second = await preview("qiaopi_mengmei");
  assert.equal(second.data.cached, true);
  assert.equal(second.data.clipId, first.data.clipId);
  assert.equal(synthCalls(), 1, "同一个音色再点不该重复花钱");

  const other = await preview("female-shaonv");
  assert.equal(other.data.cached, false, "换音色就是另一段");
  assert.equal(synthCalls(), 2);

  const clip = await mock.route("GET", "/voice/clip/:clipId")({
    json: (payload, status) => ({ data: payload, status }),
    body: (bytes, status, headers) => ({ bytes, status, headers }),
    req: { param: () => first.data.clipId, query: () => "mp3" },
  });
  assert.equal(clip.status, 200);
});

test("连通测试用当前表单配置合成试听，不保存也不影响已存配置", async () => {
  const mock = await boot({
    storageSeed: { voiceConfig },
    fetchResult: () => audioResponse({ data: { audio: "49443303" } }),
  });
  const response = await mock.route("POST", "/voice-config/test")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ config: { ...voiceConfig, model: "speech-2.8-turbo" }, voiceId: "qiaopi_mengmei" }) },
  });
  assert.equal(response.data.ok, true);
  assert.equal(response.data.format, "mp3");
  assert.equal(mock.stored("voiceConfig").model, "speech-2.8-hd");
  const body = JSON.parse(mock.fetchCalls[0].init.body);
  assert.equal(body.model, "speech-2.8-turbo");
  assert.equal(body.voice_setting.voice_id, "qiaopi_mengmei");
});

test("续接设置默认关自动续接，改了立即存", async () => {
  const mock = await boot();
  const config = (await mock.route("GET", "/resume-config")(jsonRoute())).data;
  assert.equal(config.ok, true);
  assert.equal(config.text, "继续哈");
  assert.equal(config.config.autoResume, false, "自动续接默认必须关着");
  assert.equal(config.config.maxConsecutive, 3);

  const saved = (await mock.route("PUT", "/resume-config")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ config: { autoResume: true, maxConsecutive: 2 } }) },
  })).data;
  assert.equal(saved.ok, true);
  assert.equal(mock.stored("resumeConfig").autoResume, true);
  assert.equal(mock.stored("resumeConfig").maxConsecutive, 2);
});

test("断点续接不再有冻结层：配置恒为未冻结，设置页直接可见", async () => {
  // 2026-10-23 用户拍板拆掉冻结与暗号：/resume-config 恒回 frozen=false。
  const mock = await boot();
  const view = (await mock.route("GET", "/resume-config")(jsonRoute())).data;
  assert.equal(view.frozen, false, "拆掉冻结层之后必须恒为未冻结");
});

test("手动「继续哈」以用户身份发进指定对话，提交后等待恢复", async () => {
  const mock = await boot({ storageSeed: { resumeConfig: { enabled: true } } });
  const response = await mock.route("POST", "/resume/continue")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ sessionId: "sess_1" }) },
  });
  assert.equal(response.data.ok, true);
  assert.equal(mock.sendCalls.at(-1).text, "继续哈");
  assert.equal(mock.sendCalls.at(-1).deliverAs, "steer");
  assert.equal(mock.sendCalls.at(-1).sessionId, "sess_1");
  const status = await mock.route("GET", "/resume-status")({ json: (data) => data, req: { query: () => "sess_1" } });
  assert.equal(status.progress[0].status, "waiting");
  assert.equal(status.progress[0].title, "今天", "无球结果同样带真实窗口来源");
});

test("断点续接总关时手动接口也不能发送", async () => {
  const mock = await boot();
  const response = await mock.route("POST", "/resume/continue")({
    json: (data, status) => ({ data, status }), req: { json: async () => ({ sessionId: "sess_1" }) },
  });
  assert.equal(response.status, 409);
  assert.equal(response.data.ok, false);
  assert.equal(mock.sendCalls.length, 0);
});

test("「不用管」不发送任何东西", async () => {
  const mock = await boot();
  const response = await mock.route("POST", "/resume/dismiss")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ sessionId: "sess_1" }) },
  });
  assert.equal(response.data.ok, true);
  assert.equal(mock.sendCalls.length, 0);
});

test("状态接口会说清宿主到底给不给事件订阅", async () => {
  const mock = await boot();
  const response = await mock.route("GET", "/resume-status")({
    json: (payload, status) => ({ data: payload, status }),
    req: { query: () => "sess_1" },
  });
  assert.equal(response.data.ok, true);
  // 测试桩里订阅会抛 APP_SDK_HOST_UNSUPPORTED，所以这里必须是 false 且不抛错
  assert.equal(response.data.eventsAvailable, false);
  assert.equal(response.data.session.consecutive, 0);
});

test("宿主不支持订阅时 App 照样起来，只掉到卡住兜底", async () => {
  const mock = await boot();
  assert.equal(mock.subscribed.length, 1, "即便宿主拒了也要先试一次");
  assert.deepEqual(mock.subscribed[0].filter, {});
  const response = await mock.route("GET", "/resume-config")(jsonRoute());
  assert.equal(response.data.ok, true);
});

test("恢复默认方向与对话式修订入口都真的落盘", async () => {
  const mock = await boot({ storageSeed: { recommendationConfig: {
    display: "ball", count: 3,
    styles: [{ name: "自嘲", intent: "a" }, { name: "冷知识", intent: "b" }],
    selectedByCount: { 2: [0, 1], 3: [0, 1, 0], 4: [0, 1, 0, 1] },
  } } });
  const restored = await mock.route("POST", "/recommendation-config/restore")({ json: (p, s) => ({ data: p, status: s }) });
  assert.equal(restored.data.ok, true);
  assert.equal(restored.data.styles.length, 4);
  assert.deepEqual(restored.data.selectedByCount["3"], [0, 1, 2]);

  const asked = await mock.route("POST", "/recommendation-config/refine-request")({ json: (p, s) => ({ data: p, status: s }) });
  assert.equal(asked.data.ok, true);
  assert.equal(mock.stored("styleRefineRequested"), true);
});

test("改方向的建议工具：先落草稿再出卡", async () => {
  const mock = await boot({ storageSeed: { voiceConfig } });
  const refine = mock.tool("jiegehua_zhiyi_refine_recommendation_styles");
  assert.ok(refine, "出建议的工具必须注册");
  assert.equal(refine.sessionPermission.readOnly, true, "出建议不写盘，应该是只读");
  assert.match(refine.description, /不会改任何设置/);
});

test("确认修改：过期、编号对不上、剔到不足两条都不许落盘", async () => {
  const draft = {
    planId: "plan_x", createdAt: Date.now(), expiresAt: Date.now() + 600_000, reply: "换了一下",
    items: [
      { key: "甲␟a", name: "甲", intent: "a" },
      { key: "乙␟b", name: "乙", intent: "b" },
    ],
    droppedKeys: [],
  };
  const mock = await boot({ storageSeed: { styleRefineDraft: draft, voiceConfig } });
  const tool = mock.tool("jiegehua_zhiyi_apply_recommendation_styles");
  assert.ok(tool, "确认修改的工具必须注册");
  assert.equal(tool.sessionPermission.readOnly, false);
  assert.match(tool.description, /不要主动调用/);

  mock.stored("styleRefineDraft").expiresAt = Date.now() - 1000;
  const expired = await tool.execute({ planId: "plan_x", droppedKeys: "" });
  assert.equal(expired.isError, true);
  assert.match(expired.content[0].text, /过期/);

  mock.stored("styleRefineDraft").expiresAt = Date.now() + 600_000;
  const wrongId = await tool.execute({ planId: "plan_other", droppedKeys: "" });
  assert.equal(wrongId.isError, true);

  const tooFew = await tool.execute({ planId: "plan_x", droppedKeys: "甲␟a,乙␟b" });
  assert.equal(tooFew.isError, true);
  assert.match(tooFew.content[0].text, /至少要留 2 条/);
  assert.equal(mock.stored("recommendationConfig"), undefined, "失败时不该写任何推荐设置");
});

test("确认修改成功：只写剩下那几条，勾选也跟着重算", async () => {
  const now = Date.now();
  const mock = await boot({ storageSeed: {
    styleRefineDraft: {
      planId: "plan_x", createdAt: now, expiresAt: now + 600_000, reply: "换了一下",
      items: [
        { key: "甲␟a", name: "甲", intent: "a" },
        { key: "乙␟b", name: "乙", intent: "b" },
        { key: "丙␟c", name: "丙", intent: "c" },
      ],
      droppedKeys: [],
    },
    voiceConfig,
  } });
  const tool = mock.tool("jiegehua_zhiyi_apply_recommendation_styles");
  const ok = await tool.execute({ planId: "plan_x", droppedKeys: "甲␟a" });
  assert.notEqual(ok.isError, true);
  const saved = mock.stored("recommendationConfig");
  assert.deepEqual(saved.styles.map((s) => s.name), ["乙", "丙"]);
  assert.deepEqual(saved.selectedByCount["3"], [0, 1, 0]);
});

test("连通测试失败时说人话，不把供应商原文当结果", async () => {
  const mock = await boot({
    storageSeed: { voiceConfig },
    fetchResult: () => new Response(JSON.stringify({ base_resp: { status_msg: "invalid api key" } }), { status: 401 }),
  });
  const response = await mock.route("POST", "/voice-config/test")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ config: voiceConfig }) },
  });
  assert.equal(response.status, 502);
  assert.match(response.data.error, /invalid api key/);
});

import { listSpeakableReplies } from "../lib/voice-replies.js";

test("朗读列表按固定目标取，不再永远抓最近活跃的那段", async () => {
  // 实机：球上固定了 A，朗读窗里念出来的却是 B 的内容 —— 因为这里从不传 sessionId。
  const sdk = {
    bus: {
      request: async () => ({ sessions: [
        { sessionId: "sess_new", path: "a.jsonl", agentId: "hanako", agentName: "小花", title: "最近活跃", modified: 200 },
        { sessionId: "sess_pin", path: "b.jsonl", agentId: "xiansheng", agentName: "星眠", title: "被固定的", modified: 10 },
      ] }),
    },
    sessions: {
      history: async ({ sessionId }) => ({ messages: [
        { role: "assistant", content: sessionId === "sess_pin" ? "这段是固定窗口的回复。" : "这段是最近窗口的回复。", entryId: "e1" },
      ] }),
    },
  };
  const pinned = await listSpeakableReplies(sdk, { sessionId: "sess_pin" });
  assert.equal(pinned.session.sessionId, "sess_pin");
  assert.equal(pinned.session.agentName, "星眠");
  assert.match(pinned.replies[0].text, /固定窗口/, "朗读前预览要用这段的字");
  assert.equal(pinned.replies[0].truncated, false);

  // 没固定时才跟随最近。
  const auto = await listSpeakableReplies(sdk, {});
  assert.equal(auto.session.sessionId, "sess_new");
});
