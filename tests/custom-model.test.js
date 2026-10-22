import test from "node:test";
import assert from "node:assert/strict";
import {
  MASKED_KEY,
  invokeTextModel,
  isMaskedKey,
  maskCustomModelConfig,
  mergeCustomModelConfig,
  normalizeCustomModelConfig,
  resolveTaskModel,
  testCustomModel,
} from "../lib/custom-model.js";

function createSdk({ stored = {}, fetchResult = null, fetchCalls = [] } = {}) {
  const values = new Map(Object.entries(stored));
  return {
    values,
    fetchCalls,
    sdk: {
      storage: { global: { get: (key, fallback) => (values.has(key) ? values.get(key) : fallback) } },
      network: { fetch: async (url, init) => {
        fetchCalls.push({ url, init });
        if (!fetchResult) throw new Error("测试里没有给网络回包");
        return typeof fetchResult === "function" ? fetchResult(url, init) : fetchResult;
      } },
    },
  };
}

const ready = { enabled: true, baseUrl: "https://api.example.com/v1", model: "mini-1", apiKey: "sk-plain" };

function chatOk(text) {
  return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

test("归一化与脱敏：页面永远拿不到真 Key", () => {
  const config = normalizeCustomModelConfig({ enabled: "yes", baseUrl: " https://x.y/v1/ ", model: " m ", apiKey: " k " });
  assert.equal(config.enabled, false, "只有严格的 true 才算开启");
  assert.equal(config.baseUrl, "https://x.y/v1");
  assert.equal(isMaskedKey(MASKED_KEY), true);
  assert.equal(maskCustomModelConfig(ready).apiKey, MASKED_KEY);
  assert.equal(JSON.stringify(maskCustomModelConfig(ready)).includes("sk-plain"), false);
});

test("合并：掩码与空串都不覆盖已存 Key，只有显式清除才删", async () => {
  const kept = await mergeCustomModelConfig(ready, { baseUrl: "https://b.z/v1", apiKey: MASKED_KEY });
  assert.equal(kept.apiKey, "sk-plain", "掩码回传不能把真 Key 冲掉");
  assert.equal(kept.baseUrl, "https://b.z/v1");
  const blank = await mergeCustomModelConfig(ready, { apiKey: "" });
  assert.equal(blank.apiKey, "sk-plain", "空串也不能覆盖");
  const cleared = await mergeCustomModelConfig(ready, { clearApiKey: true });
  assert.equal(cleared.apiKey, "");
  const replaced = await mergeCustomModelConfig(ready, { apiKey: "sk-new" });
  assert.notEqual(replaced.apiKey, "sk-plain");
  assert.ok(replaced.apiKey.length > 0);
});

test("三档分派：先 Hana 选中的，其次自定义档，都没就报错说去哪选", async () => {
  const host = await resolveTaskModel(createSdk({ stored: { customTextModel: ready } }).sdk, {
    hostModel: { provider: "p", model: "m", name: "Hana 选中的" },
  });
  assert.equal(host.kind, "host", "选了 Hana 模型就该用 Hana 模型");

  const custom = await resolveTaskModel(createSdk({ stored: { customTextModel: ready } }).sdk, {});
  assert.equal(custom.kind, "custom");

  const none = await resolveTaskModel(createSdk({ stored: {} }).sdk, {});
  assert.equal(none, null);
  await assert.rejects(
    () => resolveTaskModel(createSdk({ stored: { customTextModel: { ...ready, model: "" } } }).sdk, {}),
    /还没配齐/,
  );
  await assert.rejects(
    () => resolveTaskModel(createSdk({ stored: { customTextModel: { ...ready, baseUrl: "ftp://x" } } }).sdk, {}),
    /不合法/,
  );
});

test("自定义档直连：走受控网络，带鉴权头与回包上限", async () => {
  const calls = [];
  const { sdk } = createSdk({ stored: { customTextModel: ready }, fetchCalls: calls, fetchResult: () => chatOk("好") });
  const resolved = await resolveTaskModel(sdk, {});
  const text = await invokeTextModel(sdk, resolved, {
    requestId: "req-1",
    messages: [{ role: "user", content: "回一个字" }],
    systemPrompt: "简短",
    maxTokens: 32,
  });
  assert.equal(text, "好");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/chat\/completions$/);
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-plain");
  assert.ok(calls[0].init.maxResponseBytes >= 1024 * 1024);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "mini-1");
  assert.equal(body.messages[0].role, "system", "系统提示词要排在最前");
});

test("自定义档：HTTP 错误说人话，连上但没正文也明说，不假装成功", async () => {
  const failing = createSdk({ stored: { customTextModel: ready }, fetchResult: () => new Response(JSON.stringify({ error: { message: "invalid key" } }), { status: 401 }) });
  const resolved1 = await resolveTaskModel(failing.sdk, {});
  await assert.rejects(() => invokeTextModel(failing.sdk, resolved1, { requestId: "r", messages: [] }), /invalid key/);

  const empty = createSdk({ stored: { customTextModel: ready }, fetchResult: () => chatOk("") });
  const resolved2 = await resolveTaskModel(empty.sdk, {});
  await assert.rejects(
    () => invokeTextModel(empty.sdk, resolved2, { requestId: "r", messages: [] }),
    /没有返回正文/,
  );
});

// 会话纽带：宿主只在收到 providerSessionKey 时才给底层 provider 传 sessionId。
// 这个字段没写在公开契约里，所以得同时验两件事：带上了，以及宿主不认时能脱掉重发。
// 也因为它没写在契约里，这个测试是在提醒后人：这层是“能用但未承诺”的。
test("Hana 模型可以带会话纽带，宿主不认时自动脱掉重发", async () => {
  const calls = [];
  const makeSdk = (streamImpl) => ({
    models: { stream: async (...args) => { calls.push(args); return streamImpl(args); } },
  });
  const okStream = () => new Response([
    JSON.stringify({ type: "text-delta", delta: "好的" }),
    JSON.stringify({ type: "done", stopReason: "stop", assistant: { content: [{ type: "text", text: "好的" }] } }),
    "",
  ].join("\n"));

  const sdk1 = makeSdk(okStream);
  const text = await invokeTextModel(sdk1, { kind: "host", model: { provider: "p", model: "m" } }, {
    requestId: "r1",
    messages: [{ role: "user", content: "嗨" }],
    transport: { providerSessionKey: "sess_x", cacheRetention: "short" },
  });
  assert.equal(text, "好的");
  assert.equal(calls[0].length, 2, "第二个参数要真的传出去");
  assert.deepEqual(calls[0][1], { providerSessionKey: "sess_x", cacheRetention: "short" });

  // 老宿主或将来收紧校验的宿主：一次拒绝就回到单参数，别让增强变成新的失败源。
  calls.length = 0;
  let attempt = 0;
  const sdk2 = makeSdk(() => {
    attempt += 1;
    if (attempt === 1) {
      const error = new Error("The environment supplied unsupported model transport options.");
      error.code = "APP_MODEL_INVALID_REQUEST";
      throw error;
    }
    return okStream();
  });
  const text2 = await invokeTextModel(sdk2, { kind: "host", model: { provider: "p", model: "m" } }, {
    requestId: "r2",
    messages: [{ role: "user", content: "嗨" }],
    transport: { providerSessionKey: "sess_x" },
  });
  assert.equal(text2, "好的");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].length, 1, "降级时只传一个参数");
});

test("连通测试：缺项直接说缺哪个，测完不写任何配置", async () => {
  const bare = createSdk({ stored: {} });

  await assert.rejects(() => testCustomModel(bare.sdk, { baseUrl: "", model: "", apiKey: "" }), /还差/);

  const calls = [];
  const ok = createSdk({ stored: { customTextModel: ready }, fetchCalls: calls, fetchResult: () => chatOk("好") });
  const result = await testCustomModel(ok.sdk, { ...ready, apiKey: MASKED_KEY });
  assert.equal(result.ok, true);
  assert.equal(result.sample, "好");
  assert.deepEqual(ok.values.get("customTextModel"), ready, "测试不许改配置");
  assert.equal(calls.length, 1);
});
