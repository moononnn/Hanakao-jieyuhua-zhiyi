// 发出前清掉历史里的速览卡（纯函数回归）。
//
// 背景：旧版解语花是靠**系统提示词**让主模型自己在正文末尾写速览的
// （旧插件 extensions/observer.js 的 replySummaryInstructions，more 档写着
// 「大约 300 字以上」，还另开一条「需要用户拍板就加，哪怕没到字数门槛」）。
// 那套提示现在已经不在跑了，但那些卡还留在会话历史里，而模型每轮都读历史，
// 看到「自己」以前这么写过就接着写。
// 在下游清卡治不了根：清掉的只是显示，模型看的还是带卡的历史，下一轮又写一张。
// 所以在 provider/before-request 把发给模型的请求体也洗干净。

import test from "node:test";
import assert from "node:assert/strict";
import { stripSummaryFromPayload } from "../lib/length-summary.js";

const card = (chars) => `> **🌸 知意速览** · 原文 ${chars} 字\n> - 一条要点\n> - 两条要点`;

test("请求体里夹着的速览卡会被洗掉，其余字段原样保留", () => {
  const payload = {
    model: "test-model",
    messages: [
      { role: "user", content: "帮我看看这个问题。" },
      { role: "assistant", content: `改完了。\n\n${card(383)}` },
    ],
  };
  const cleaned = stripSummaryFromPayload(payload);
  assert.notEqual(cleaned, payload, "洗出了变化就要返回新对象");
  assert.equal(cleaned.model, "test-model", "别的字段别动");
  assert.equal(cleaned.messages[0].content, "帮我看看这个问题。");
  assert.equal(cleaned.messages[1].content, "改完了。");
  assert.doesNotMatch(cleaned.messages[1].content, /速览/);
});

test("一条消息里叠了好几张卡也一起洗掉", () => {
  const payload = {
    messages: [{ role: "assistant", content: `正文。\n\n${card(607)}\n\n${card(890)}\n\n${card(309)}` }],
  };
  const cleaned = stripSummaryFromPayload(payload);
  assert.equal(cleaned.messages[0].content, "正文。");
});

test("旧版「速览」抬头也认", () => {
  const payload = { messages: [{ role: "assistant", content: "正文。\n\n> **速览** · 原文 318 字\n> - 旧格式" }] };
  const cleaned = stripSummaryFromPayload(payload);
  assert.equal(cleaned.messages[0].content, "正文。");
});

test("数组形式的 content 里每个 text 片段都洗", () => {
  const payload = {
    messages: [{
      role: "assistant",
      content: [
        { type: "text", text: `第一段。\n\n${card(500)}` },
        { type: "toolCall", name: "read" },
      ],
    }],
  };
  const cleaned = stripSummaryFromPayload(payload);
  assert.equal(cleaned.messages[0].content[0].text, "第一段。");
  assert.equal(cleaned.messages[0].content[1].name, "read", "工具调用片段保持原样");
});

test("没有速览卡的请求体原样返回同一个对象，不制造无谓的改动", () => {
  const payload = { model: "m", messages: [{ role: "user", content: "普通一句话" }] };
  assert.equal(stripSummaryFromPayload(payload), payload);
});

test("正文里自己写的引用不会被误洗", () => {
  const payload = { messages: [{ role: "assistant", content: "> 这是我自己引用别人说的话\n\n正文。" }] };
  assert.equal(stripSummaryFromPayload(payload), payload);
});

test("嵌套很深的奇怪结构也不会炸，且能走到里面的正文", () => {
  const payload = { a: { b: [{ c: { messages: [{ content: `正文。\n\n${card(214)}` }] } }] } };
  const cleaned = stripSummaryFromPayload(payload);
  assert.equal(cleaned.a.b[0].c.messages[0].content, "正文。");
});

test("null、数字、布尔这些非字符串叶子原样穿过", () => {
  const payload = { n: 1, b: true, nil: null, messages: [{ content: `正文。\n\n${card(334)}` }] };
  const cleaned = stripSummaryFromPayload(payload);
  assert.equal(cleaned.n, 1);
  assert.equal(cleaned.b, true);
  assert.equal(cleaned.nil, null);
  assert.equal(cleaned.messages[0].content, "正文。");
});
