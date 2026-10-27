import test from "node:test";
import assert from "node:assert/strict";
import { generateRecommendations, pathForSessionId, resolveRecommendationModel } from "../lib/recommendation.js";

function createSdk({ selectedModel = null, currentModel = { provider: "test-provider", modelId: "test-model" }, history = null, modelText = '[{"text":"那你再讲讲刚才的办法？","direction":"追问/延伸"},{"text":"我也想试试这个","direction":"行动/请求"}]', sessionList = null, streamImpl = null, fallbackModel = null, getImpl = null } = {}) {
  const modelCalls = [];
  const historyCalls = [];
  const contextCalls = [];
  const listCalls = [];
  const getCalls = [];
  const sessions = sessionList || [
    { path: "D:/hana/agents/hanako/sessions/current.jsonl", sessionId: "sess_current" },
  ];
  const values = new Map([
    ["recommendationModel", selectedModel],
    ["recommendationFallbackModel", fallbackModel],
    ["recommendationConfig", { count: 2 }],
  ]);
  return {
    modelCalls,
    historyCalls,
    contextCalls,
    listCalls,
    getCalls,
    values,
    sdk: {
      bus: { request: async (type, input) => {
        if (type === "session:get") {
          getCalls.push(input);
          if (getImpl) return getImpl(input);
          const want = String(input?.sessionId || "").trim();
          const row = sessions.find((item) => item.sessionId === want);
          return { session: row ? { ...row } : null };
        }
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
          if (streamImpl) return streamImpl(request, modelCalls.length);
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

test("gives reasoning models enough output budget and retries once with double", async () => {
  // 实机踩过的坑：gpt-6-luna 这类推理模型的思考 token 与正文共用一份 maxTokens，
  // 给少了会出现「模型已返回但没有正文」或服务商那句含糊的 could not complete。
  const flaky = createSdk({
    streamImpl: (request, callNo) => {
      if (callNo === 1) {
        return new Response([
          JSON.stringify({ type: "error", code: "PROVIDER_INCOMPLETE", message: "The model provider could not complete the request." }),
          "",
        ].join("\n"));
      }
      return new Response([
        JSON.stringify({ type: "text-delta", delta: '[{"text":"那我试试","direction":"行动/请求"},{"text":"再讲讲","direction":"追问/延伸"}]' }),
        JSON.stringify({ type: "done", stopReason: "stop", assistant: { content: [{ type: "text", text: "ok" }] } }),
        "",
      ].join("\n"));
    },
  });
  const result = await generateRecommendations(flaky.sdk, { sessionPath: "sessions/current.jsonl", callToken: "t" });
  assert.equal(result.suggestions.length, 2, "第一次失败不该直接判死");
  assert.equal(flaky.modelCalls.length, 2);
  assert.equal(flaky.modelCalls[0].maxTokens, 1800);
  assert.equal(flaky.modelCalls[1].maxTokens, 3600, "重试要翻倍额度");
});

test("both attempts failing still says something a person can act on", async () => {
  const dead = createSdk({
    streamImpl: () => new Response([
      JSON.stringify({ type: "error", code: "PROVIDER_INCOMPLETE", message: "The model provider could not complete the request." }),
      "",
    ].join("\n")),
  });
  await assert.rejects(
    generateRecommendations(dead.sdk, { sessionPath: "sessions/current.jsonl", callToken: "t" }),
    (error) => {
      assert.match(error.message, /服务商这次没接住/);
      assert.match(error.message, /换一条内容模型/, "连续失败要给出路，而不是只说再试");
      assert.doesNotMatch(error.message, /could not complete/, "面板上不放英文原文，那里放不下");
      assert.match(error.rawMessage, /could not complete/, "原文要留着，好对账");
      return true;
    },
  );
  assert.equal(dead.modelCalls.length, 3, "三次都撞上，才算真的没路");
  assert.equal(dead.modelCalls[1].maxTokens, 3600);
});

// 会话凭证、模型不在列表这类错误，重发一百次也还是同一个结果。
// 拦在重试之外，一是别让人白白坐等，二是别把真正该修的问题拖成「网络不好，回头再试」。
test("unfixable errors are not retried", async () => {
  const mock = createSdk({ currentModel: null });
  await assert.rejects(
    generateRecommendations(mock.sdk, { sessionPath: "sessions/current.jsonl", callToken: "t" }),
    /不会擅自改用另一条模型/,
  );
  assert.equal(mock.modelCalls.length, 0);
});

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
  assert.equal(mock.modelCalls.length, 3, "全是套话也算没成，三次都试过再说");
});

test("App 侧直给会话编号：不反查名单，也不要求工具调用凭证", async () => {
  const mock = createSdk();
  const result = await generateRecommendations(mock.sdk, { sessionId: "sess_current" });
  assert.equal(result.suggestions.length, 2);
  // 拿位置改成先走 session:get（按编号直查，Code 会话也查得到），名单只做兜底。
  assert.equal(mock.getCalls.length, 1, "应该先用 session:get 直查位置");
  assert.equal(mock.listCalls.length, 0, "直查拿到了就不必再翻名单");
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

// 备用模型是用户显式选的，不是知意自己挑一条顶上；用上了还得把话说出口。
test("主模型全撞墙时用上备用，并把“这次是备用”交代清楚", async () => {
  const mock = createSdk({
    selectedModel: { provider: "test-provider", model: "test-model" },
    fallbackModel: { provider: "other-provider", model: "other-model" },
    streamImpl: (request) => {
      if (request.provider === "test-provider") {
        return new Response([
          JSON.stringify({ type: "error", code: "PROVIDER_INCOMPLETE", message: "The model provider could not complete the request." }),
          "",
        ].join("\n"));
      }
      return new Response([
        JSON.stringify({ type: "text-delta", delta: '[{"text":"那我自己去查查","direction":"行动/请求"},{"text":"你先忙吧","direction":"分享/感慨"}]' }),
        JSON.stringify({ type: "done", stopReason: "stop", assistant: { content: [{ type: "text", text: "ok" }] } }),
        "",
      ].join("\n"));
    },
  });
  const result = await generateRecommendations(mock.sdk, { sessionId: "sess_current" });
  assert.equal(result.model.usedFallback, true);
  assert.equal(result.model.source, "fallback");
  assert.equal(result.model.model, "other-model");
  assert.equal(result.model.primaryName, "当前模型", "得能说清备用顶替的是谁");
  assert.equal(mock.modelCalls.filter((call) => call.provider === "test-provider").length, 3, "主模型先把三次用完再换");
  assert.equal(mock.modelCalls.at(-1).provider, "other-provider");
});

// 备用跟主模型是同一条等于没兜住，不该白花一次请求。
test("备用跟主模型重复时不切换，直接说失败", async () => {
  const mock = createSdk({
    selectedModel: { provider: "test-provider", model: "test-model" },
    fallbackModel: { provider: "test-provider", model: "test-model" },
    streamImpl: () => new Response([
      JSON.stringify({ type: "error", code: "PROVIDER_INCOMPLETE", message: "The model provider could not complete the request." }),
      "",
    ].join("\n")),
  });
  await assert.rejects(
    generateRecommendations(mock.sdk, { sessionId: "sess_current" }),
    /服务商这次没接住/,
  );
  assert.equal(mock.modelCalls.length, 3, "重复的备用不该多跑一轮");
});

// Code 页的会话不在宿主给 App 的 session:list 里（只开 home/app），
// 所以拿会话位置不能只靠名单，否则「跟随当前对话模型」在 Code 会话里永远拿不到位置。
test("会话位置优先用 session:get 取，名单里没有也能拿到", async () => {
  const mock = createSdk({ sessionList: [] });
  const path = await pathForSessionId(mock.sdk, "sess_code");
  // 名单空、session:get 也查不到 -> 空串，但前提是两条路都问过了
  assert.equal(path, "");
  assert.equal(mock.getCalls.length, 1, "应该先用 session:get 直查");
  assert.equal(mock.listCalls.length, 1, "再落回名单兜底");
});

test("session:get 拿到位置就不必再翻名单", async () => {
  const mock = createSdk({
    sessionList: [],
    getImpl: () => ({ session: { sessionId: "sess_code", path: "D:/hana/agents/hanako/sessions/code-s1.jsonl" } }),
  });
  const path = await pathForSessionId(mock.sdk, "sess_code");
  assert.equal(path, "D:/hana/agents/hanako/sessions/code-s1.jsonl");
  assert.equal(mock.listCalls.length, 0, "直查拿到了就不该再多问一次");
});
