// 快速档的“先试后退”是这套东西的全部：能关思考就关，关不掉就退，绝不静默换模型。
// 全程不发真实模型请求、不碰网络、不读用户配置。
import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeFastTextModel, resolveFastModel, isUnsupportedReasoning, FAST_TASK_MODEL_KEY } from "../lib/fast-model.js";

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

test("识别宿主拒绝思考档位的两种形态", () => {
  assert.equal(isUnsupportedReasoning({ code: "APP_MODEL_UNSUPPORTED_REASONING" }), true);
  assert.equal(isUnsupportedReasoning({ code: "X", message: "该模型不支持这个思考档位" }), true);
  assert.equal(isUnsupportedReasoning({ code: "MODEL_TIMEOUT", message: "超时" }), false);
  assert.equal(isUnsupportedReasoning(null), false);
});
