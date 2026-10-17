import test from "node:test";
import assert from "node:assert/strict";
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
  const subscribed = [];
  const sendCalls = [];
  const registered = new Map();
  const context = {
    dataDir,
    bus: {
      subscribe: (callback, filter) => { subscribed.push({ callback, filter }); return () => {}; },
      request: async (verb, input) => {
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
  return { context, fetchCalls, listCalls, subscribed, sendCalls, tool(name) { return registered.get(name); }, route(method, routePath) { return routes.get(`${method} ${routePath}`); }, stored(key) { return storage.get(key); } };
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

test("会话名单读不到时如实说明，而不是给一个空伙伴列表装没事", async () => {
  const mock = await boot({ sessionListError: new Error("没有授权") });
  const response = await mock.route("GET", "/voice-config")(jsonRoute());
  assert.deepEqual(response.data.partners, []);
  assert.match(response.data.partnersNote, /伙伴名单读不到/);
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
      return audioResponse({ data: { audio: "4944330300000000" } });
    },
  });
  const response = await mock.route("POST", "/voice/speak")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ sessionId: "sess_1", entryId: "a1" }) },
  });
  assert.equal(response.data.ok, true);
  assert.match(response.data.text, /^「浇过啦，」/);
  assert.equal(response.data.text.includes("Vibe"), false);
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

test("手动「继续哈」以用户身份发进那段对话，并清掉待决状态", async () => {
  const mock = await boot();
  const response = await mock.route("POST", "/resume/continue")({
    json: (payload, status) => ({ data: payload, status }),
    req: { json: async () => ({ sessionId: "sess_1" }) },
  });
  assert.equal(response.data.ok, true);
  assert.equal(mock.sendCalls.at(-1).text, "继续哈");
  assert.equal(mock.sendCalls.at(-1).deliverAs, "steer");
  assert.equal(mock.sendCalls.at(-1).sessionId, "sess_1");
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
