// 快速档的“先试后退”是这套东西的全部：能关思考就关，关不掉就退，绝不静默换模型。
// 全程不发真实模型请求、不碰网络、不读用户配置。
import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeFastTextModel, resolveFastModel, resolveFastModelChain, cancelFastModel, isUnsupportedReasoning, FAST_TASK_MODEL_KEY } from "../lib/fast-model.js";

function ndjson(lines) {
  return new Response(lines.map((line) => JSON.stringify(line)).join("\n"), {
    headers: { "content-type": "application/x-ndjson" }
  });
}

function createSdk({ stored = {}, models = [{ provider: "deepseek", model: "deepseek-flash", name: "DS Flash" }], onStream }) {
  const calls = [];
  const sdk = {
    calls,
    storedValues: stored,
    models: {
      list: async () => models,
      stream: async (request) => {
        calls.push(request);
        if (onStream) return onStream(request, calls.length);
        return ndjson([
          { type: "start", requestId: request.requestId },
          { type: "text-delta", requestId: request.requestId, delta: "要点一" },
          { type: "done", requestId: request.requestId, stopReason: "stop", usage: { reasoning: 0 } }
        ]);
      }
    },
    network: {
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "直连正文" } }] }), {
        status: 200, headers: { "Content-Type": "application/json" }
      })
    },
    storage: { global: { get: async (key) => stored[key] ?? null, set: async (key, value) => { stored[key] = value; } } }
  };
  return sdk;
}

const host = { kind: "host", model: { provider: "deepseek", model: "deepseek-flash" }, name: "DS Flash" };

test("默认就带 off 去要思考档位，而不是默默沿用模型默认", async () => {
  const sdk = createSdk({});
  const out = await invokeFastTextModel(sdk, host, { requestId: "r", messages: [{ role: "user", content: "压成两行" }] });
  assert.equal(sdk.calls[0].reasoningEffort, "off");
  assert.equal(out.effort, "off");
  assert.equal(out.attempts, 1);
  assert.match(out.text, /要点一/);
});

test("模型不吃这档时脱掉重发，仍用同一条模型，不静默换", async () => {
  const seen = [];
  const sdk = createSdk({
    onStream: (request, n) => {
      seen.push(request.model);
      if (n === 1) {
        const error = new Error("The selected model does not support that reasoning effort.");
        error.code = "APP_MODEL_UNSUPPORTED_REASONING";
        throw error;
      }
      return ndjson([{ type: "text-delta", requestId: request.requestId, delta: "退回默认档也有正文" },
        { type: "done", requestId: request.requestId, stopReason: "stop" }]);
    }
  });
  const out = await invokeFastTextModel(sdk, host, { requestId: "r", messages: [{ role: "user", content: "x" }] });
  assert.equal(sdk.calls.length, 2);
  assert.equal(sdk.calls[0].reasoningEffort, "off");
  assert.equal(sdk.calls[1].reasoningEffort, undefined, "退档后不能再带这个字段");
  assert.deepEqual(new Set(seen), new Set(["deepseek-flash"]), "重试必须留在同一条模型上");
  assert.equal(out.effort, "");
});

test("别的原因报错直接抛，不当成“不支持思考”退一步", async () => {
  const sdk = createSdk({
    onStream: () => { const e = new Error("连接被拒"); e.code = "PROVIDER_REFUSED"; throw e; }
  });
  await assert.rejects(
    () => invokeFastTextModel(sdk, host, { requestId: "r", messages: [{ role: "user", content: "x" }] }),
    /连接被拒/
  );
  assert.equal(sdk.calls.length, 1);
});

test("空正文时同模型加预算再来一次，并把“只输出正文”写进提示词", async () => {
  const prompts = [];
  const sdk = createSdk({
    onStream: (request) => {
      prompts.push(request.systemPrompt);
      if (prompts.length === 1) {
        // 只思考没正文：真实场景就是这样，正文预算被思考吃光。
        return ndjson([{ type: "reasoning-delta", requestId: request.requestId, delta: "想了想…" },
          { type: "done", requestId: request.requestId, stopReason: "length", usage: { reasoning: 612 } }]);
      }
      return ndjson([{ type: "text-delta", requestId: request.requestId, delta: "要点一" },
        { type: "done", requestId: request.requestId, stopReason: "stop" }]);
    }
  });
  const out = await invokeFastTextModel(sdk, host, { requestId: "r", messages: [{ role: "user", content: "x" }], maxTokens: 800 });
  assert.equal(sdk.calls.length, 2);
  assert.ok(sdk.calls[1].maxTokens > sdk.calls[0].maxTokens, "重试必须给更大的输出预算");
  assert.match(prompts[1], /只输出最终可见正文/);
  assert.equal(out.reasoningTokens, 612, "思考吃了多少要带回来，不能只说“没正文”");
});

test("两次都没正文才报错，并把思考用量挂在错误上", async () => {
  const sdk = createSdk({
    onStream: (request) => ndjson([{ type: "done", requestId: request.requestId, stopReason: "length", usage: { reasoning: 800 } }])
  });
  await assert.rejects(
    () => invokeFastTextModel(sdk, host, { requestId: "r", messages: [{ role: "user", content: "x" }] }),
    (error) => error.code === "MODEL_EMPTY" && error.reasoningTokens === 800
  );
});

test("自定义直连档不发思考档位：那条路上没有这层概念", async () => {
  const sdk = createSdk({});
  const resolved = { kind: "custom", config: { baseUrl: "https://example.test/v1", model: "m", apiKey: "plain" }, name: "自定义" };
  const out = await invokeFastTextModel(sdk, resolved, { requestId: "r", messages: [{ role: "user", content: "x" }] });
  assert.equal(out.effort, "", "直连档没有思考档位可关，不该假装关了");
  assert.equal(out.attempts, 1);
  assert.match(out.text, /直连正文/);
});

test("快速档模型：设置里选了就用，没选就跟随兜底那条", async () => {
  const models = [
    { provider: "deepseek", model: "deepseek-flash" },
    { provider: "minimax", model: "MiniMax-M3.1-Flash-Preview" }
  ];
  const picked = createSdk({ stored: { [FAST_TASK_MODEL_KEY]: { provider: "minimax", model: "MiniMax-M3.1-Flash-Preview" } }, models });
  const a = await resolveFastModel(picked, { provider: "deepseek", model: "deepseek-flash" });
  assert.equal(a.model.provider, "minimax");
  assert.equal(a.model.model, "MiniMax-M3.1-Flash-Preview");

  const follow = createSdk({ stored: {}, models });
  const b = await resolveFastModel(follow, { provider: "deepseek", model: "deepseek-flash" });
  assert.equal(b.model.provider, "deepseek");

  const empty = createSdk({ stored: {}, models });
  assert.equal(await resolveFastModel(empty, null), null);
});

test("选了一条已经不在目录里的模型，回落而不是硬传", async () => {
  const sdk = createSdk({ stored: {}, models: [{ provider: "deepseek", model: "deepseek-flash" }] });
  const resolved = await resolveFastModel(sdk, { provider: "minimax", model: "已经删掉的模型" });
  assert.equal(resolved, null);
});

test("快速模型被限流时就换内容模型，再不行换备用模型", async () => {
  // 2026-11-04：以前快速档只会在同一条模型里调参数，额度用完/被限流就彻底失败。
  const models = [
    { provider: "deepseek", model: "deepseek-flash", name: "DS Flash" },
    { provider: "minimax", model: "MiniMax-M2", name: "MiniMax M2" },
    { provider: "moonshot", model: "kimi-k2", name: "Kimi K2" },
  ];
  const attempts = [];
  const sdk = createSdk({
    stored: {
      [FAST_TASK_MODEL_KEY]: { provider: "deepseek", model: "deepseek-flash" },
      recommendationModel: { provider: "minimax", model: "MiniMax-M2" },
      recommendationFallbackModel: { provider: "moonshot", model: "kimi-k2" },
    },
    models,
    onStream: (request) => {
      attempts.push(request.model);
      if (request.model === "deepseek-flash") {
        const error = new Error("429 Too Many Requests");
        error.code = "APP_PROVIDER_RATE_LIMITED";
        throw error;
      }
      return ndjson([
        { type: "start", requestId: request.requestId },
        { type: "text-delta", requestId: request.requestId, delta: "要点一" },
        { type: "done", requestId: request.requestId, stopReason: "stop", usage: { reasoning: 0 } }
      ]);
    },
  });

  const chain = await resolveFastModelChain(sdk);
  assert.deepEqual(chain.map((item) => item.model.model), ["deepseek-flash", "MiniMax-M2", "kimi-k2"], "降级链要按快速、内容、备用排开");
  assert.deepEqual(chain.map((item) => item.role), ["fast", "content", "backup"]);

  const out = await invokeFastTextModel(sdk, chain, { requestId: "r", messages: [{ role: "user", content: "压成两行" }] });
  assert.equal(out.modelRole, "content", "换上的是内容模型");
  assert.equal(out.degraded, true, "换过模型这件事要写在结果里，不能默默换");
  assert.equal(out.tried.length, 1);
  assert.equal(out.tried[0].code, "APP_PROVIDER_RATE_LIMITED");
  assert.deepEqual(attempts, ["deepseek-flash", "MiniMax-M2"]);
});

test("降级链一路到底都失败：抛第一条的原因，并把试过哪几条带出来", async () => {
  const models = [
    { provider: "deepseek", model: "deepseek-flash" },
    { provider: "minimax", model: "MiniMax-M2" },
  ];
  const sdk = createSdk({
    stored: {
      [FAST_TASK_MODEL_KEY]: { provider: "deepseek", model: "deepseek-flash" },
      recommendationModel: { provider: "minimax", model: "MiniMax-M2" },
    },
    models,
    onStream: (request) => {
      const error = new Error(request.model === "deepseek-flash" ? "额度用完了" : "服务商 503");
      error.code = request.model === "deepseek-flash" ? "APP_PROVIDER_QUOTA" : "APP_PROVIDER_UNAVAILABLE";
      throw error;
    },
  });
  const chain = await resolveFastModelChain(sdk);
  await assert.rejects(
    () => invokeFastTextModel(sdk, chain, { requestId: "r", messages: [{ role: "user", content: "x" }] }),
    (error) => {
      assert.equal(error.code, "APP_PROVIDER_QUOTA", "抛第一条的原因，那是她最该知道的");
      assert.equal(error.triedModels.length, 2);
      return true;
    }
  );
});

test("链里同一条模型只试一次：快速模型就是内容模型时不会重复打两遍", async () => {
  const models = [{ provider: "deepseek", model: "deepseek-flash" }];
  const sdk = createSdk({
    stored: {
      [FAST_TASK_MODEL_KEY]: { provider: "deepseek", model: "deepseek-flash" },
      recommendationModel: { provider: "deepseek", model: "deepseek-flash" },
    },
    models,
  });
  const chain = await resolveFastModelChain(sdk);
  assert.equal(chain.length, 1);
});

test("只有自定义 HTTP 档的也能进链：目录里没有条目不该直接报“没模型”", async () => {
  const sdk = createSdk({
    stored: { customTextModel: { enabled: true, baseUrl: "https://example.test/v1", model: "my-model", apiKey: "plain" } },
    models: [],
  });
  const chain = await resolveFastModelChain(sdk);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].role, "custom");
  assert.match(chain[0].name, /my-model/);
});

test("链有总预算：来不及再换一条就认输，不硬拖", async () => {
  const models = [
    { provider: "deepseek", model: "deepseek-flash" },
    { provider: "minimax", model: "MiniMax-M2" },
  ];
  const sdk = createSdk({
    stored: {
      [FAST_TASK_MODEL_KEY]: { provider: "deepseek", model: "deepseek-flash" },
      recommendationModel: { provider: "minimax", model: "MiniMax-M2" },
    },
    models,
    onStream: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const error = new Error("429 Too Many Requests");
      error.code = "APP_PROVIDER_RATE_LIMITED";
      throw error;
    },
  });
  const chain = await resolveFastModelChain(sdk);
  await assert.rejects(
    () => invokeFastTextModel(sdk, chain, { requestId: "r", budgetMs: 10, messages: [{ role: "user", content: "x" }] }),
    (error) => error.code === "MODEL_BUDGET_EXCEEDED" && error.triedModels.length === 1
  );
});

test("取消要拿实际发出去的号：带 _aN 后缀，并顺手叫停整条链", async () => {  const cancelled = [];
  const sdk = createSdk({
    models: [{ provider: "deepseek", model: "deepseek-flash" }],
    onStream: (request) => new Promise((resolve) => {
      setTimeout(() => resolve(ndjson([
        { type: "start", requestId: request.requestId },
        { type: "text-delta", requestId: request.requestId, delta: "要点一" },
        { type: "done", requestId: request.requestId, stopReason: "stop", usage: { reasoning: 0 } }
      ])), 120);
    }),
  });
  sdk.models.cancel = async (id) => { cancelled.push(id); return { ok: true }; };

  const running = invokeFastTextModel(sdk, host, { requestId: "r", messages: [{ role: "user", content: "x" }] });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await cancelFastModel(sdk, "r");
  assert.deepEqual(cancelled, ["r_a1"], "要取消真正发出去的那个号，不是基号");
  await running;
});

test("识别宿主拒绝思考档位的两种形态", () => {
  assert.equal(isUnsupportedReasoning({ code: "APP_MODEL_UNSUPPORTED_REASONING" }), true);
  assert.equal(isUnsupportedReasoning({ code: "X", message: "该模型不支持这个思考档位" }), true);
  assert.equal(isUnsupportedReasoning({ code: "MODEL_TIMEOUT", message: "超时" }), false);
  assert.equal(isUnsupportedReasoning(null), false);
});

test("被放弃之后，同一条模型里的翻倍重试也不再发", async () => {
  // 2026-11-04 审包实测抓到的口子：链层拦住了换模型，但 run() 还会再发 _a2/_a3。
  // 基号用独立的一个：取消标记是模块级记忆（60 秒），别跟前一条测试撞号。
  const base = "r_cancel_retry";
  let attempts = 0;
  let sdk = null;
  sdk = createSdk({
    models: [{ provider: "deepseek", model: "deepseek-flash" }],
    onStream: async (request) => {
      attempts += 1;
      // 第一轮只回思考、不回正文（会触发同模型翻倍重试），并在结算前把这条基号标成已放弃。
      if (attempts === 1) await cancelFastModel(sdk, base);
      return ndjson([
        { type: "start", requestId: request.requestId },
        { type: "done", requestId: request.requestId, stopReason: "stop", usage: { reasoning: 12 } }
      ]);
    },
  });
  await assert.rejects(
    () => invokeFastTextModel(sdk, host, { requestId: base, messages: [{ role: "user", content: "x" }] }),
    (error) => error.code === "MODEL_CANCELLED"
  );
  assert.equal(attempts, 1, "已经放弃了就不该再发第二次");
});
