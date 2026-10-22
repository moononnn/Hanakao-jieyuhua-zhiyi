import test from "node:test";
import assert from "node:assert/strict";
import { createBallBridge, BALL_TARGET_KEY } from "../lib/ball-bridge.js";

const SUGGESTIONS = '[{"text":"那你再讲讲刚才的办法？","direction":"追问/延伸"},{"text":"我也想试试这个","direction":"行动/请求"}]';

function createHarness({
  sessions = [
    { sessionId: "sess_old", path: "sessions/old.jsonl", title: "旧对话", agentName: "测试伙伴", modified: 10 },
    { sessionId: "sess_new", path: "sessions/new.jsonl", title: "新对话", agentName: "小花", modified: 900 },
    { sessionId: "sess_mid", path: "sessions/mid.jsonl", title: "中间", agentName: "小花", modified: 500 },
  ],
  sessionListError = null,
  storageSeed = {},
  modelText = SUGGESTIONS,
  modelError = null,
  contextModel = { provider: "test-provider", modelId: "test-model" },
} = {}) {
  const modelCalls = [];
  const storage = new Map(Object.entries({ recommendationConfig: { count: 2 }, ...storageSeed }));
  const sdk = {
    bus: { request: async (verb, input) => {
      if (verb === "session:list") {
        if (sessionListError) throw sessionListError;
        return { sessions };
      }
      return null;
    } },
    storage: { global: {
      get: async (key, fallback = undefined) => (storage.has(key) ? storage.get(key) : fallback),
      set: async (key, value) => { storage.set(key, value); },
    } },
    models: {
      list: async () => ({ models: [
        { provider: "test-provider", model: "test-model", name: "当前模型", isCurrent: true },
      ] }),
      stream: async (request) => {
        modelCalls.push(request);
        if (modelError) throw modelError;
        return new Response([
          JSON.stringify({ type: "text-delta", delta: modelText }),
          JSON.stringify({ type: "done", stopReason: "stop", assistant: { content: [{ type: "text", text: modelText }] } }),
          "",
        ].join("\n"));
      },
      cancel: async () => {},
    },
    sessions: {
      context: async () => ({ model: contextModel }),
      history: async () => ({ messages: [
        { role: "user", content: "帮我想想怎么给花浇水。" },
        { role: "assistant", content: "先看土壤干湿，再沿盆边慢慢浇。" },
      ] }),
    },
  };
  const pushes = [];
  let request = null;
  const ball = {
    setRequest(next) { request = next; },
    async bridgeRequest(route, opts) {
      if (route === "/recommend/state") return { ok: true, request, push: null, pushSeq: 0 };
      if (route === "/recommend/push") { pushes.push(opts.body); return { ok: true }; }
      throw new Error(`unexpected route ${route}`);
    },
  };
  const bridge = createBallBridge({ sdk, ball, logger: { info: async () => {}, warn: async () => {}, debug: async () => {} } });
  return { bridge, ball, pushes, storage, modelCalls };
}

test("球重启后请求序号归零，刷新推荐仍然有效", async () => {
  const { bridge, ball, pushes, modelCalls } = createHarness();
  ball.setRequest({ kind: "refresh", seq: 5 });
  await bridge.tick();
  const first = modelCalls.length;
  assert.ok(first >= 1, "第一次刷新应该真的调一次模型");
  // 球重启：桥上的 requestSeq 从 0 重数，而 App 这边还记着 5。
  ball.setRequest({ kind: "refresh", seq: 1 });
  await bridge.tick();
  assert.equal(modelCalls.length, first + 1, "序号倒退后不能把新请求当成旧的丢掉");
  assert.equal(pushes.at(-1).suggestions.length, 2);
});

test("球重启后序号归零，固定目标也仍然生效", async () => {
  const { bridge, ball, storage } = createHarness();
  ball.setRequest({ kind: "pin", sessionId: "sess_mid", seq: 9 });
  await bridge.tick();
  assert.equal(storage.get(BALL_TARGET_KEY)?.pinned?.sessionId, "sess_mid");
  ball.setRequest({ kind: "pin", sessionId: "sess_old", seq: 2 });
  await bridge.tick();
  assert.equal(storage.get(BALL_TARGET_KEY)?.pinned?.sessionId, "sess_old", "倒退后点固定不能没反应");
});

test("跟随模式：取最近活跃的对话，候选按时间倒序", async () => {
  const { bridge, pushes } = createHarness();
  await bridge.tick();
  const last = pushes.at(-1);
  assert.equal(last.target.sessionId, "sess_new");
  assert.equal(last.target.mode, "auto");
  assert.equal(last.target.stale, false);
  assert.deepEqual(last.candidates.map((row) => row.sessionId), ["sess_new", "sess_mid", "sess_old"]);
});

test("纯手动：光开面板、不过期，都不调模型", async () => {
  const { bridge, ball, pushes, modelCalls } = createHarness();
  await bridge.tick();
  await bridge.tick();
  await bridge.tick();
  assert.equal(modelCalls.length, 0, "没点刷新就不该调模型");
  assert.deepEqual(pushes.at(-1).suggestions, [], "没生成过就没有可显示的推荐");
  // 只有球上明确来了刷新请求才生成
  ball.setRequest({ kind: "refresh", seq: 1 });
  await bridge.tick();
  assert.equal(modelCalls.length, 1);
  assert.equal(pushes.at(-1).suggestions.length, 2);
});

test("生成中先推一次空列表，生成完再推结果", async () => {
  const { bridge, ball, pushes } = createHarness();
  ball.setRequest({ kind: "refresh", seq: 1 });
  await bridge.tick();
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0].generating, true);
  assert.deepEqual(pushes[0].suggestions, []);
  assert.equal(pushes[1].generating, false);
  assert.equal(pushes[1].suggestions.length, 2);
});

test("固定模式：目标用固定那段，仍列出候选", async () => {
  const { bridge, pushes } = createHarness({
    storageSeed: { [BALL_TARGET_KEY]: { mode: "pinned", pinned: { sessionId: "sess_mid", title: "中间" } } },
  });
  await bridge.tick();
  const last = pushes.at(-1);
  assert.equal(last.target.sessionId, "sess_mid");
  assert.equal(last.target.mode, "pinned");
  assert.equal(last.candidates.length, 3);
});

test("点固定：写入固定状态，目标切到那一段", async () => {
  const { bridge, ball, pushes, storage } = createHarness();
  ball.setRequest({ kind: "pin", sessionId: "sess_old", seq: 1 });
  await bridge.tick();
  assert.equal(storage.get(BALL_TARGET_KEY).mode, "pinned");
  assert.equal(storage.get(BALL_TARGET_KEY).pinned.sessionId, "sess_old");
  assert.equal(pushes.at(-1).target.sessionId, "sess_old");
  assert.equal(pushes.at(-1).target.mode, "pinned");
});

test("取消固定：回到跟随模式，目标切回最近活跃", async () => {
  const { bridge, ball, pushes, storage } = createHarness({
    storageSeed: { [BALL_TARGET_KEY]: { mode: "pinned", pinned: { sessionId: "sess_old" } } },
  });
  ball.setRequest({ kind: "auto", seq: 1 });
  await bridge.tick();
  assert.equal(storage.get(BALL_TARGET_KEY).mode, "auto");
  assert.equal(storage.get(BALL_TARGET_KEY).pinned, null);
  assert.equal(pushes.at(-1).target.sessionId, "sess_new");
  assert.equal(pushes.at(-1).target.mode, "auto");
});

test("点刷新：同一目标也强制重新生成一次", async () => {
  const { bridge, ball, pushes, modelCalls } = createHarness();
  ball.setRequest({ kind: "refresh", seq: 1 });
  await bridge.tick();
  assert.equal(modelCalls.length, 1);
  ball.setRequest({ kind: "refresh", seq: 2 });
  await bridge.tick();
  assert.equal(modelCalls.length, 2, "刷新必须再调一次模型");
  assert.equal(pushes.at(-1).suggestions.length, 2);
});

test("点清空：球上列表清掉，且不会被下一轮推回旧的", async () => {
  const { bridge, ball, pushes, modelCalls } = createHarness();
  ball.setRequest({ kind: "refresh", seq: 1 });
  await bridge.tick();
  assert.equal(pushes.at(-1).suggestions.length, 2);

  ball.setRequest({ kind: "clear", seq: 2 });
  await bridge.tick();
  assert.deepEqual(pushes.at(-1).suggestions, [], "清空后这一轮就该是空的");

  await bridge.tick();
  await bridge.tick();
  assert.deepEqual(pushes.at(-1).suggestions, [], "清空之后不能自己长回来");
  assert.equal(modelCalls.length, 1, "清空不该再调模型");
});

test("换目标：旧列表作废，但不自动生成新的", async () => {
  const { bridge, ball, pushes, modelCalls } = createHarness();
  ball.setRequest({ kind: "refresh", seq: 1 });
  await bridge.tick();
  assert.equal(pushes.at(-1).suggestions.length, 2);

  ball.setRequest({ kind: "pin", sessionId: "sess_old", seq: 2 });
  await bridge.tick();
  assert.equal(pushes.at(-1).target.sessionId, "sess_old");
  assert.deepEqual(pushes.at(-1).suggestions, [], "旧目标的推荐不能留在新目标下");
  assert.equal(modelCalls.length, 1, "换了目标也不自动生成，要点刷新");
});

test("重复的请求序号不重复处理", async () => {
  const { bridge, ball, modelCalls } = createHarness();
  ball.setRequest({ kind: "refresh", seq: 1 });
  await bridge.tick();
  await bridge.tick(); // 同一 seq，不应再次生成
  assert.equal(modelCalls.length, 1);
});

test("读不到会话名单：给人话提示，不生成也不静默", async () => {
  const { bridge, pushes, modelCalls } = createHarness({ sessionListError: new Error("没有授权") });
  await bridge.tick();
  const last = pushes.at(-1);
  assert.equal(last.target, null);
  assert.deepEqual(last.candidates, []);
  assert.deepEqual(last.suggestions, []);
  assert.match(last.notice, /读不到会话名单/);
  assert.equal(modelCalls.length, 0, "没有目标就不该调模型");
});

test("名单为空：如实说明，不假装有目标", async () => {
  const { bridge, pushes } = createHarness({ sessions: [] });
  await bridge.tick();
  assert.equal(pushes.at(-1).target, null);
  assert.match(pushes.at(-1).notice, /还没找到可用的对话/);
});

test("固定目标掉出最近 5 个：目标保留并说明已不在最近列表", async () => {
  const sessions = Array.from({ length: 6 }, (_, i) => ({
    sessionId: `sess_${i}`, path: `sessions/${i}.jsonl`, title: `对话${i}`, agentName: "小花", modified: 100 - i,
  }));
  const { bridge, pushes } = createHarness({
    sessions,
    storageSeed: { [BALL_TARGET_KEY]: { mode: "pinned", pinned: { sessionId: "sess_gone", title: "老对话" } } },
  });
  await bridge.tick();
  const last = pushes.at(-1);
  assert.equal(last.target.sessionId, "sess_gone");
  assert.equal(last.target.stale, true);
  assert.match(last.notice, /不在最近 5 个里/);
});

test("推荐生成失败：球面提示说人话，供应商原文不挤进去", async () => {
  const { bridge, ball, pushes } = createHarness({ modelError: new Error("模型连接失败") });
  ball.setRequest({ kind: "refresh", seq: 1 });
  await bridge.tick();
  const last = pushes.at(-1);
  assert.deepEqual(last.suggestions, []);
  // 2026-10-20 起球面只给人话，原文改挂到日志；面板和球就这么高，长句会把控件挤没。
  assert.match(last.notice, /内容模型/);
  assert.equal(last.notice.includes("模型连接失败"), false, "供应商原文不塞进球面提示");
});

test("推荐在设置里关掉时：不调模型、不留提示，只告诉球把那一块收起来", async () => {
  const { bridge, pushes, modelCalls } = createHarness({
    storageSeed: { recommendationConfig: { display: "off" } },
  });
  await bridge.tick();
  const last = pushes.at(-1);
  assert.deepEqual(last.suggestions, []);
  assert.equal(last.notice, "", "关闭时不留「已关闭」之类的占位文案");
  assert.equal(last.enabled, false, "球据此整块隐藏推荐区");
  assert.equal(modelCalls.length, 0);
});

test("推荐开着时推送 enabled: true，球才显示推荐区", async () => {
  const { bridge, pushes } = createHarness();
  await bridge.tick();
  assert.equal(pushes.at(-1).enabled, true);
});

test("桥不可用时安静跳过，不抛出", async () => {
  const sdk = {
    bus: { request: async () => ({ sessions: [] }) },
    storage: { global: { get: async (k, f) => f, set: async () => {} } },
    models: { list: async () => ({ models: [] }), stream: async () => new Response(""), cancel: async () => {} },
    sessions: { context: async () => ({ model: null }), history: async () => ({ messages: [] }) },
  };
  const ball = { bridgeRequest: async () => { throw new Error("ball stopped"); } };
  const bridge = createBallBridge({ sdk, ball, logger: { debug: async () => {}, warn: async () => {}, info: async () => {} } });
  await bridge.tick(); // 不抛
});
