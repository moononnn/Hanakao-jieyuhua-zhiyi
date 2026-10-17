import test from "node:test";
import assert from "node:assert/strict";
import { chatModelOptions, hasDecisionCue, parseAskReview, readModelText, resolveAskModel } from "../lib/ask-model.js";

const CATALOG = [
  { provider: "p1", model: "slow-chat", name: "常用模型" },
  { provider: "p2", model: "small-chat", name: "当前模型", isCurrent: true },
  { provider: "p3", model: "text-embedding", name: "向量模型" },
];

test("model options keep chat models only and put Hana's current model first", () => {
  const options = chatModelOptions(CATALOG);
  assert.deepEqual(options.map((item) => item.key), ["p2/small-chat", "p1/slow-chat"]);
});

test("selected model wins, missing selection falls back to Hana's current model", () => {
  assert.deepEqual(resolveAskModel(CATALOG, { provider: "p1", model: "slow-chat" }), {
    provider: "p1", model: "slow-chat", source: "selected",
  });
  assert.deepEqual(resolveAskModel(CATALOG, { provider: "gone", model: "missing" }), {
    provider: "p2", model: "small-chat", source: "current",
  });
});

test("candidate filter catches explicit tradeoffs but leaves ordinary chat alone", () => {
  assert.equal(hasDecisionCue("第一版只能选云同步或本地保存，我还没决定更看重哪边。"), true);
  assert.equal(hasDecisionCue("帮我解释一下端到端加密是什么意思。"), false);
  assert.equal(hasDecisionCue("这句话读起来还是稍微有点生硬。"), false);
});

test("Ask review parser accepts only a boolean JSON verdict", () => {
  assert.deepEqual(parseAskReview('```json\n{"mustAsk":true,"reason":"会改变隐私边界"}\n```'), {
    mustAsk: true, reason: "会改变隐私边界",
  });
  assert.equal(parseAskReview('{"mustAsk":"yes"}'), null);
  assert.equal(parseAskReview("not json"), null);
});

function streamOf(lines) {
  return new Response(lines.join("\n"), { headers: { "content-type": "application/x-ndjson" } });
}

test("stream reader joins text deltas and ignores reasoning", async () => {
  const events = [];
  const text = await readModelText(streamOf([
    JSON.stringify({ type: "start", requestId: "r1" }),
    JSON.stringify({ type: "reasoning-delta", requestId: "r1", delta: "想一下…" }),
    JSON.stringify({ type: "text-delta", requestId: "r1", delta: "第一行；" }),
    JSON.stringify({ type: "text-delta", requestId: "r1", delta: "第二行。" }),
    JSON.stringify({ type: "done", requestId: "r1", stopReason: "stop", assistant: { role: "assistant", content: [{ type: "text", text: "第一行；第二行。" }] } }),
  ]), (event) => events.push(event));
  assert.equal(text, "第一行；第二行。");
  assert.equal(events.length, 1);
  assert.equal(events[0].ok, true);
  assert.equal(events[0].stopReason, "stop");
  assert.ok(events[0].types.includes("reasoning-delta"));
});

test("a reasoning-only stream is reported as empty instead of failing silently", async () => {
  // 推理模型把 maxTokens 全用在思考上就是这个形状：请求成功，正文一个字没有。
  const events = [];
  const text = await readModelText(streamOf([
    JSON.stringify({ type: "start", requestId: "r2" }),
    JSON.stringify({ type: "reasoning-delta", requestId: "r2", delta: "思考…" }),
    JSON.stringify({ type: "done", requestId: "r2", stopReason: "length", assistant: { role: "assistant", content: [{ type: "reasoning", reasoning: "思考…", signature: "s" }] } }),
  ]), (event) => events.push(event));
  assert.equal(text, "");
  assert.equal(events[0].ok, false);
  assert.equal(events[0].finalChars, 0);
});

test("diagnostics never carry model output text", async () => {
  const events = [];
  await readModelText(streamOf([
    JSON.stringify({ type: "text-delta", requestId: "r3", delta: "机密内容" }),
  ]), (event) => events.push(event));
  assert.equal(JSON.stringify(events[0]).includes("机密内容"), false);
});

test("unparsable lines are counted but do not break the read", async () => {
  const events = [];
  const text = await readModelText(streamOf([
    "data: 不是 JSON",
    JSON.stringify({ type: "text-delta", requestId: "r4", delta: "还在" }),
  ]), (event) => events.push(event));
  assert.equal(text, "还在");
  assert.ok(events[0].types.includes("unparsable"));
});
