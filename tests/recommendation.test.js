import test from "node:test";
import assert from "node:assert/strict";
import { generateRecommendations, resolveRecommendationModel } from "../lib/recommendation.js";

function createSdk({ selectedModel = null, currentModel = { provider: "test-provider", modelId: "test-model" }, history = null, modelText = '[{"text":"那你再讲讲刚才的办法？","direction":"追问/延伸"},{"text":"我也想试试这个","direction":"行动/请求"}]', sessionList = null } = {}) {
  const modelCalls = [];
  const historyCalls = [];
  const contextCalls = [];
  const listCalls = [];
  const sessions = sessionList || [
    { path: "D:/hana/agents/hanako/sessions/current.jsonl", sessionId: "sess_current" },
  ];
  const values = new Map([
    ["recommendationModel", selectedModel],
    ["recommendationConfig", { count: 2 }],
  ]);
  return {
    modelCalls,
    historyCalls,
    contextCalls,
    listCalls,
    values,
    sdk: {
      bus: { request: async (type, input) => {
        if (type === "session:list") { listCalls.push(input); return { sessions }; }
        return null;
      } },
      models: {
        list: async () => ({ models: [
          { provider: "test-provider", model: "test-model", name: "当前模型", isCurrent: true },
          { provider: "other-provider", model: "other-model", name: "另选模型" },
        ] }),
        stream: async (request) => {
          modelCalls.push(request);
          return new Response([
            JSON.stringify({ type: "text-delta", delta: modelText }),
            JSON.stringify({ type: "done", stopReason: "stop", assistant: { content: [{ type: "text", text: modelText }] } }),
            "",
          ].join("\n"));
        },
        cancel: async () => {},
      },
      sessions: {
        context: async (request) => { contextCalls.push(request); return { model: currentModel }; },
        history: async (request) => {
          historyCalls.push(request);
          return history || { messages: [
            { role: "user", content: "帮我想想怎么给花浇水。" },
            { role: "assistant", content: "先看土壤干湿，再沿盆边慢慢浇。", thinking: "不可读取的隐藏思考" },
          ] };
        },
      },
      storage: { global: { get: async (key, fallback) => values.has(key) ? values.get(key) : fallback } },
    },
  };
}

test("recommendation follows the invoking session's model and reads only bounded visible history", async () => {
  const mock = createSdk();
  const result = await generateRecommendations(mock.sdk, {
    sessionPath: "sessions/current.jsonl", callToken: "call-token", hint: "自然一点",
  });
  assert.equal(result.model.source, "session");
  assert.equal(result.model.model, "test-model");
  assert.deepEqual(mock.contextCalls, [{ sessionPath: "sessions/current.jsonl", scope: "all" }]);
  // 实机结论：读历史只能按 sessionId，sessionPath 会被宿主拒（session_manifest_ref_required）。
  // 工具上下文只有 sessionPath，所以先从 session:list 里把编号换出来。
  assert.deepEqual(mock.listCalls, [{ scope: "all" }]);
  assert.deepEqual(mock.historyCalls, [{ sessionId: "sess_current", scope: "all", limit: 8 }]);
  assert.equal(mock.historyCalls[0].sessionPath, undefined, "不能只拿 sessionPath 去读历史");
  assert.equal(mock.modelCalls.length, 1);
  assert.equal(mock.modelCalls[0].callToken, "call-token");
  assert.match(mock.modelCalls[0].messages[0].content, /帮我想想怎么给花浇水/);
  assert.doesNotMatch(mock.modelCalls[0].messages[0].content, /不可读取的隐藏思考/);
  assert.match(mock.modelCalls[0].messages[0].content, /自然一点/);
  assert.equal(result.suggestions.length, 2);
});

test("an explicit valid model choice is used without reading session model metadata", async () => {
  const mock = createSdk({ selectedModel: { provider: "other-provider", model: "other-model" } });
  const result = await generateRecommendations(mock.sdk, { sessionPath: "sessions/current.jsonl", callToken: "call-token" });
  assert.equal(result.model.source, "selected");
  assert.equal(result.model.model, "other-model");
  assert.equal(mock.contextCalls.length, 0);
  assert.equal(mock.modelCalls[0].provider, "other-provider");
});

test("does not silently switch models when the invoking session model is unavailable", async () => {
  const mock = createSdk({ currentModel: null });
  await assert.rejects(
    resolveRecommendationModel(mock.sdk, "sessions/current.jsonl"),
    /不会擅自改用另一条模型/,
  );
});

test("rejects missing session identity or call token before reading history", async () => {
  const mock = createSdk();
  await assert.rejects(generateRecommendations(mock.sdk, { callToken: "call-token" }), /没有取得当前对话/);
  await assert.rejects(generateRecommendations(mock.sdk, { sessionPath: "sessions/current.jsonl" }), /没有有效的会话凭证/);
  assert.equal(mock.historyCalls.length, 0);
  assert.equal(mock.modelCalls.length, 0);
});

test("refuses to read or call the model when the session cannot be matched to an id", async () => {
  const mock = createSdk({ sessionList: [{ path: "D:/hana/agents/hanako/sessions/other.jsonl", sessionId: "sess_other" }] });
  await assert.rejects(
    generateRecommendations(mock.sdk, { sessionPath: "sessions/current.jsonl", callToken: "call-token" }),
    /没能从 Hana 会话名单里认出当前这段对话/,
  );
  assert.equal(mock.historyCalls.length, 0, "认不出编号就不读历史");
  assert.equal(mock.modelCalls.length, 0, "认不出编号就不花钱调模型");

  const noIdMock = createSdk({ sessionList: [{ path: "D:/hana/agents/hanako/sessions/current.jsonl" }] });
  await assert.rejects(
    generateRecommendations(noIdMock.sdk, { sessionPath: "sessions/current.jsonl", callToken: "call-token" }),
    /没能从 Hana 会话名单里认出当前这段对话/,
  );
  assert.equal(noIdMock.modelCalls.length, 0);
});

test("removes filler candidates and returns a model error if no useful candidate remains", async () => {
  const mock = createSdk({ modelText: '[{"text":"哈哈确实","direction":"空话"}]' });
  await assert.rejects(
    generateRecommendations(mock.sdk, { sessionPath: "sessions/current.jsonl", callToken: "call-token" }),
    /没有生成合适的推荐回复/,
  );
  assert.equal(mock.modelCalls.length, 2);
});

test("App 侧直给会话编号：不反查名单，也不要求工具调用凭证", async () => {
  const mock = createSdk();
  const result = await generateRecommendations(mock.sdk, { sessionId: "sess_current" });
  assert.equal(result.suggestions.length, 2);
  assert.equal(mock.listCalls.length, 1, "仍要读一次名单拿到 path 才能跟随当前模型");
  assert.deepEqual(mock.historyCalls, [{ sessionId: "sess_current", scope: "all", limit: 8 }]);
  assert.equal(mock.modelCalls[0].callToken, undefined, "没有工具凭证就不该硬塞一个空 callToken");
});

test("直给编号但名单里找不到 path 时，不静默换模型而是报错说清", async () => {
  const mock = createSdk({ sessionList: [{ path: "D:/hana/agents/hanako/sessions/other.jsonl", sessionId: "sess_other" }] });
  await assert.rejects(
    generateRecommendations(mock.sdk, { sessionId: "sess_missing" }),
    /没有取得当前对话位置|不会擅自改用另一条模型/,
  );
  assert.equal(mock.modelCalls.length, 0);
});
