// 球上作答回传的纯逻辑回归（node:test，零依赖）。
// 这条链路代替了原来「工具里死等十分钟」的做法：工具送到就返回，答案由这里
// 轮询接收、作为一条新消息补回原会话。

import test from "node:test";
import assert from "node:assert/strict";
import { buildBallAnswerText, createBallAskWatcher } from "../lib/ball-ask-watch.js";

const request = {
  title: "选择迁移方式",
  question: "采用哪种方式？",
  options: [
    { label: "直接迁移", detail: "保留旧界面" },
    { label: "重写界面", detail: "使用 App 原生 UI" },
  ],
  selectionMode: "single",
  minSelections: 1,
  maxSelections: 1,
};

function harness({ results = {}, sendError = null } = {}) {
  const sent = [];
  const logs = [];
  const watcher = createBallAskWatcher({
    logger: {
      info: async (message, detail) => logs.push({ level: "info", message, detail }),
      warn: async (message, detail) => logs.push({ level: "warn", message, detail }),
      debug: async (message, detail) => logs.push({ level: "debug", message, detail }),
    },
    readAskResult: async (askId) => {
      if (results[askId] instanceof Error) throw results[askId];
      return results[askId] ?? { status: "pending" };
    },
    send: async (text, sessionId) => {
      if (sendError) throw sendError;
      sent.push({ text, sessionId });
    },
  });
  return { watcher, sent, logs };
}

test("单选答案写成一句能看懂的回传，并带上「接着做」的指令", () => {
  const text = buildBallAnswerText({ request }, { action: "confirmed", value: { choice: "直接迁移", note: "今晚就弄" } });
  assert.match(text, /采用哪种方式/);
  assert.match(text, /用户选了：直接迁移/);
  assert.match(text, /补充：今晚就弄/);
  assert.match(text, /接着这个选择/);
});

test("多选答案逐条列出来", () => {
  const text = buildBallAnswerText({ request }, { action: "confirmed", value: { choice: ["直接迁移", "重写界面"] } });
  assert.match(text, /- 直接迁移/);
  assert.match(text, /- 重写界面/);
});

test("多选与补充说明同时出现，两样都在回传里", () => {
  const text = buildBallAnswerText({ request }, {
    action: "confirmed",
    value: { choice: ["直接迁移", "重写界面"], note: "先迁移，界面下个版本再说" },
  });
  assert.match(text, /- 直接迁移/);
  assert.match(text, /- 重写界面/);
  assert.match(text, /补充：先迁移，界面下个版本再说/);
});

test("自定义回答走自己的说法，不假装是选项里的那一个", () => {
  const text = buildBallAnswerText({ request }, { action: "confirmed", value: { customChoice: "先不动，等下周" } });
  assert.match(text, /自定义回答：先不动，等下周/);
  assert.doesNotMatch(text, /用户选了：/);
});

test("跳过、超时、关闭都不算同意", () => {
  for (const action of ["rejected", "timeout", "aborted"]) {
    const text = buildBallAnswerText({ request }, { action });
    assert.match(text, /不等于同意|没收到选择|没有拿到选择/, `${action} 必须明确不是同意`);
  }
});

test("答上来就回传一次，同一道题不会被回传第二遍", async () => {
  const { watcher, sent } = harness({ results: { a1: { status: "answered", answer: { action: "confirmed", value: { choice: "直接迁移" } } } } });
  watcher.add({ askId: "a1", request, sessionId: "sess_x" });
  assert.equal(watcher.size(), 1);

  await watcher.tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, "sess_x");
  assert.match(sent[0].text, /用户选了：直接迁移/);
  assert.equal(watcher.size(), 0, "回传后不再挂着");

  await watcher.tick();
  assert.equal(sent.length, 1, "重复轮询不该再发一遍");
});

test("还没答的时候什么都不发，题继续挂着", async () => {
  const { watcher, sent } = harness({ results: { a1: { status: "pending" } } });
  watcher.add({ askId: "a1", request, sessionId: "sess_x" });
  await watcher.tick();
  assert.equal(sent.length, 0);
  assert.equal(watcher.size(), 1);
});

test("跳过、超时这类结局只记账，不往对话里塞东西", async () => {
  const { watcher, sent, logs } = harness({ results: { a1: { status: "rejected" } } });
  watcher.add({ askId: "a1", request, sessionId: "sess_x" });
  await watcher.tick();
  assert.equal(sent.length, 0, "拒绝不是同意，绝不能发出去");
  assert.equal(watcher.size(), 0);
  assert.ok(logs.some((item) => /未作答/.test(item.message)));
});

test("桥暂时不通时保留这道题，等下一轮再试", async () => {
  const { watcher, sent } = harness({ results: { a1: new Error("bridge down") } });
  watcher.add({ askId: "a1", request, sessionId: "sess_x" });
  await watcher.tick();
  assert.equal(sent.length, 0);
  assert.equal(watcher.size(), 1, "传输失败不等于用户没答，题要留着");
});

test("回传失败要留一条 warn，不能静默吞掉用户的选择", async () => {
  const { watcher, logs } = harness({
    results: { a1: { status: "answered", answer: { action: "confirmed", value: { choice: "直接迁移" } } } },
    sendError: new Error("session is busy"),
  });
  watcher.add({ askId: "a1", request, sessionId: "sess_x" });
  await watcher.tick();
  assert.ok(logs.some((item) => item.level === "warn" && /回传失败/.test(item.message)));
});

test("过期不再等待，也不回传", async () => {
  let now = 1_000;
  const sent = [];
  const watcher = createBallAskWatcher({
    now: () => now,
    ttlMs: 5_000,
    readAskResult: async () => ({ status: "answered", answer: { action: "confirmed", value: { choice: "直接迁移" } } }),
    send: async (text, sessionId) => sent.push({ text, sessionId }),
  });
  watcher.add({ askId: "a1", request, sessionId: "sess_x" });
  now += 6_000;
  await watcher.tick();
  assert.equal(sent.length, 0, "过期之后才答的不再回传");
  assert.equal(watcher.size(), 0);
  watcher.stop();
});

test("没有 askId 或没有会话编号的题压根不登记", () => {
  const { watcher } = harness();
  assert.equal(watcher.add({ askId: "", request, sessionId: "sess_x" }), false);
  assert.equal(watcher.add({ askId: "a1", request, sessionId: "" }), false);
  assert.equal(watcher.size(), 0);
  watcher.stop();
});

test("stop 之后不再轮询", async () => {
  const { watcher, sent } = harness({ results: { a1: { status: "answered", answer: { action: "confirmed", value: { choice: "直接迁移" } } } } });
  watcher.add({ askId: "a1", request, sessionId: "sess_x" });
  watcher.stop();
  assert.equal(watcher.size(), 0);
  await watcher.tick();
  assert.equal(sent.length, 0);
});
