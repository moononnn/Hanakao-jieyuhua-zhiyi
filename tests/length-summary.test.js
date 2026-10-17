import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_MIN_CHARS,
  MAX_MIN_CHARS,
  MAX_SUMMARY_LINES,
  appendSummaryBlock,
  buildSummaryBlock,
  buildSummaryPrompt,
  collectTextParts,
  normalizeMinChars,
  normalizeSummaryConfig,
  parseSummary,
  readBodyText,
  recordSummaryFailure,
  requestsLongForm,
  resolveSummaryModelRef,
  saveOriginalArchive,
  shouldSummarize,
} from "../lib/length-summary.js";

test("normalizeMinChars 夹在合理区间，默认回落到 600", () => {
  assert.equal(normalizeMinChars(undefined), DEFAULT_MIN_CHARS);
  assert.equal(normalizeMinChars(null), DEFAULT_MIN_CHARS);
  assert.equal(normalizeMinChars(""), DEFAULT_MIN_CHARS);
  assert.equal(normalizeMinChars("abc"), DEFAULT_MIN_CHARS);
  assert.equal(normalizeMinChars(NaN), DEFAULT_MIN_CHARS);
  assert.equal(normalizeMinChars(0), 1);
  assert.equal(normalizeMinChars(-5), 1);
  assert.equal(normalizeMinChars(99999), MAX_MIN_CHARS);
  assert.equal(normalizeMinChars(1200.9), 1200);
});

test("normalizeSummaryConfig 默认开启，minChars 始终合法", () => {
  assert.deepEqual(normalizeSummaryConfig(undefined), { enabled: true, minChars: DEFAULT_MIN_CHARS });
  assert.deepEqual(normalizeSummaryConfig({ enabled: false, minChars: 300 }), { enabled: false, minChars: 300 });
  assert.deepEqual(normalizeSummaryConfig({ enabled: "yes", minChars: "nope" }), { enabled: true, minChars: DEFAULT_MIN_CHARS });
  // 存进来的脏值不能把阈值降到 1，否则每条消息都会被处理。
  assert.deepEqual(normalizeSummaryConfig({ minChars: null }).minChars, DEFAULT_MIN_CHARS);
  assert.deepEqual(normalizeSummaryConfig({ minChars: 0 }).minChars, 1);
});

test("collectTextParts 只取正文，thinking 和工具片段不算正文", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "内部思考" },
      { type: "text", text: "第一段" },
      { type: "tool_use", id: "t1", name: "read" },
      { type: "text", text: "第二段" },
    ],
  };
  assert.equal(collectTextParts(message).length, 2);
  assert.equal(readBodyText(message), "第一段\n第二段");
});

test("readBodyText 对字符串正文和无正文消息分别返回正文与 null", () => {
  assert.equal(readBodyText({ content: "  纯字符串  " }), "纯字符串");
  assert.equal(readBodyText({ content: [{ type: "tool_use", id: "t" }] }), null);
  assert.equal(readBodyText({}), null);
  assert.equal(readBodyText(null), null);
});

test("requestsLongForm 认明确的索取，不把普通闲聊误判成长文", () => {
  assert.equal(requestsLongForm("帮我写个几千字的小作文"), true);
  assert.equal(requestsLongForm("这次详细展开讲讲"), true);
  assert.equal(requestsLongForm("不要省略，完整写"), true);
  assert.equal(requestsLongForm("逐条讲清楚"), true);
  assert.equal(requestsLongForm("我们聊聊火锅吧"), false);
  assert.equal(requestsLongForm("这个 bug 咋个修"), false);
  assert.equal(requestsLongForm(undefined), false);
});

test("shouldSummarize 按阈值放行，用户明确要长文时跳过", () => {
  const long = "字".repeat(700);
  assert.deepEqual(shouldSummarize({ text: long, minChars: 600 }), { ok: true, chars: 700 });
  assert.deepEqual(shouldSummarize({ text: "字".repeat(600), minChars: 600 }), { ok: true, chars: 600 });
  assert.equal(shouldSummarize({ text: "字".repeat(599), minChars: 600 }).reason, "under-threshold");
  assert.equal(shouldSummarize({ text: long, minChars: 600, userText: "写个长文" }).reason, "user-asked-long");
  assert.equal(shouldSummarize({ text: "   ", minChars: 1 }).reason, "empty");
  assert.equal(shouldSummarize({ text: null }).reason, "no-text");
});

test("buildSummaryBlock 画成引用块小卡，带原文长度", () => {
  const block = buildSummaryBlock(["第一条要点", "第二条要点"], 812);
  assert.equal(block, "> **速览** · 原文 812 字\n> - 第一条要点\n> - 第二条要点");
});

test("appendSummaryBlock 保留原文，把速览接在最后一个正文片段末尾", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "内部思考" },
      { type: "text", text: "第一段原文" },
      { type: "tool_use", id: "t1", name: "read" },
      { type: "text", text: "第二段原文" },
    ],
  };
  const next = appendSummaryBlock(message, buildSummaryBlock(["要点一"], 20));
  assert.equal(next.content[0].thinking, "内部思考");
  // 两段原文都还在，速览只跟在最后一段后面。
  assert.ok(next.content[1].text === "第一段原文");
  assert.ok(next.content[3].text.startsWith("第二段原文\n\n> **速览**"));
  assert.ok(readBodyText(next).includes("第一段原文"));
  assert.ok(readBodyText(next).endsWith("> - 要点一"));
  assert.deepEqual(next.content[2], { type: "tool_use", id: "t1", name: "read" });
});

test("appendSummaryBlock 处理字符串正文，无正文时返回 null", () => {
  assert.equal(appendSummaryBlock({ content: "原文" }, "速览").content, "原文\n\n速览");
  assert.equal(appendSummaryBlock({ content: [] }, "速览"), null);
  assert.equal(appendSummaryBlock({}, "速览"), null);
});

test("saveOriginalArchive 把原文和速览一起落到本地归档", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyi-long-"));
  const file = saveOriginalArchive(dir, {
    sessionPath: "C:/sessions/abc123.jsonl",
    chars: 812,
    text: "很长的原文",
    lines: ["第一条要点", "第二条要点"],
  });
  const saved = fs.readFileSync(file, "utf8");
  assert.ok(saved.includes("很长的原文"));
  assert.ok(saved.includes("812 字"));
  assert.ok(saved.includes("abc123.jsonl"));
  assert.ok(saved.includes("速览：\n- 第一条要点\n- 第二条要点"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("saveOriginalArchive 没有速览行时不留空标题", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyi-long-"));
  const file = saveOriginalArchive(dir, { sessionPath: "", chars: 10, text: "原文" });
  const saved = fs.readFileSync(file, "utf8");
  assert.ok(saved.includes("原文"));
  assert.ok(!saved.includes("速览："));
  assert.ok(saved.includes("未知对话"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("recordSummaryFailure 把失败原因写到本机文件，带错误码与超时上限", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyi-fail-"));
  const error = Object.assign(new Error("简写超时。"), { code: "MODEL_TIMEOUT" });
  const payload = recordSummaryFailure(dir, error, { chars: 812 });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "last-summary-error.json"), "utf8"));
  assert.equal(saved.code, "MODEL_TIMEOUT");
  assert.equal(saved.message, "简写超时。");
  assert.equal(saved.chars, 812);
  assert.equal(typeof saved.timeoutMs, "number");
  assert.equal(saved.at, payload.at);
  // 写盘失败也不能影响对话，所以不抛。
  const bad = recordSummaryFailure(path.join(dir, "no-such-dir", "x"), error);
  assert.equal(bad.code, "MODEL_TIMEOUT");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolveSummaryModelRef 先用速览自己的模型，没选才跟随 Ask 判断模型", () => {
  const ask = { provider: "openai-codex", model: "gpt-6-luna" };
  const fast = { provider: "deepseek", model: "deepseek-flash" };
  assert.deepEqual(resolveSummaryModelRef(fast, ask), fast);
  assert.deepEqual(resolveSummaryModelRef(null, ask), ask);
  assert.deepEqual(resolveSummaryModelRef(null, null), null);
  // 脏值不能被当成一条可用模型，否则会拿着空 provider 去调。
  assert.deepEqual(resolveSummaryModelRef({ provider: "", model: "" }, ask), ask);
  assert.deepEqual(resolveSummaryModelRef("gpt-6-luna", ask), ask);
});

test("buildSummaryPrompt 带上限截断，不把整篇长文塞进提示", () => {
  const prompt = buildSummaryPrompt("字".repeat(20000));
  assert.ok(prompt.length < 20000);
  assert.ok(prompt.includes("[中间略]"));
  assert.ok(prompt.includes(String(MAX_SUMMARY_LINES)));
});

test("parseSummary 去掉列表符和标签，只保留约定行数", () => {
  const lines = parseSummary("以下是摘要：\n- 结论：这是结论\n2、要你定的是配色\n* 下一步：等你拍板\n第四行不该出现");
  assert.deepEqual(lines, ["这是结论", "要你定的是配色", "等你拍板"]);
});

test("parseSummary 丢掉开场白与客套行，保留真正的要点", () => {
  assert.deepEqual(parseSummary("好的，以下是简要总结：\n\n- 先改词表\n- 再跑一遍"), ["先改词表", "再跑一遍"]);
  assert.deepEqual(parseSummary("总结：\n结论已经定下来了"), ["结论已经定下来了"]);
  assert.equal(parseSummary("以下是要点：\n摘要："), null);
});

test("parseSummary 剥掉代码围栏并给超长行兜底", () => {
  assert.deepEqual(parseSummary("```\n只有一行\n```"), ["只有一行"]);
  const long = parseSummary("字".repeat(500));
  assert.equal(long.length, 1);
  assert.ok(long[0].endsWith("…"));
  assert.ok(long[0].length <= 81);
});

test("parseSummary 对空输入和纯符号返回 null", () => {
  assert.equal(parseSummary(""), null);
  assert.equal(parseSummary(null), null);
  assert.equal(parseSummary("   \n  "), null);
});
