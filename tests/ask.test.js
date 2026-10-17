import test from "node:test";
import assert from "node:assert/strict";
import {
  ASK_TOOL_SCHEMA,
  buildAskMessage,
  buildRequestedSchema,
  formatAskAnswer,
  normalizeAskRequest,
} from "../lib/ask.js";

const sample = {
  title: "决定实现顺序",
  question: "先处理哪一块？",
  background: "两块工作互不依赖。",
  recommendation: "先做数据校验",
  reason: "能更早发现输入问题。",
  options: [
    { label: "数据校验", detail: "先补输入检查。" },
    { label: "界面打磨" },
  ],
};

test("normalizes choices and defaults to single selection", () => {
  const result = normalizeAskRequest(sample);
  assert.equal(result.title, sample.title);
  assert.deepEqual(result.options.map(({ label }) => label), ["数据校验", "界面打磨"]);
  assert.deepEqual([result.selectionMode, result.minSelections, result.maxSelections], ["single", 1, 1]);
});

test("normalizes multiple selection ranges and declares checkbox form fields", () => {
  const request = normalizeAskRequest({ ...sample, selectionMode: "multiple", minSelections: 1, maxSelections: 2 });
  assert.deepEqual([request.selectionMode, request.minSelections, request.maxSelections], ["multiple", 1, 2]);
  assert.match(buildAskMessage(request), /可多选：至少 1 项，最多 2 项/);
  const schema = buildRequestedSchema(request);
  assert.equal(schema.properties.option_1.type, "boolean");
  assert.equal(schema.properties.option_1.title, "数据校验");
  assert.equal(schema.properties.option_2.type, "boolean");
});

test("rejects missing, out-of-range, blank and duplicate choices", () => {
  assert.throws(() => normalizeAskRequest(null), /对象/);
  assert.throws(() => normalizeAskRequest({ ...sample, options: [sample.options[0]] }), /2 到 5/);
  assert.throws(() => normalizeAskRequest({ ...sample, options: ["  ", "另一个"] }), /没有标题/);
  assert.throws(() => normalizeAskRequest({ ...sample, options: ["继续", "继续"] }), /不能重名/);
  assert.throws(() => normalizeAskRequest({ ...sample, options: ["A", "B", "C", "D", "E", "F"] }), /2 到 5/);
  assert.throws(() => normalizeAskRequest({ ...sample, title: "题".repeat(61) }), /不能超过 60/);
  assert.throws(() => normalizeAskRequest({ ...sample, options: ["甲".repeat(101), "另一个"] }), /不能超过 100/);
  assert.throws(() => normalizeAskRequest({ ...sample, options: [{ label: "甲", detail: "字".repeat(241) }, "另一个"] }), /不能超过 240/);
  assert.throws(() => normalizeAskRequest({ ...sample, selectionMode: "maybe" }), /single 或 multiple/);
  assert.throws(() => normalizeAskRequest({ ...sample, selectionMode: "multiple", minSelections: 3 }), /最少选择数/);
  assert.throws(() => normalizeAskRequest({ ...sample, selectionMode: "multiple", minSelections: 2, maxSelections: 1 }), /不能超过/);
  assert.throws(() => normalizeAskRequest({ ...sample, minSelections: 2 }), /单选题/);
});

test("turns choices into a host-supported enum and includes context", () => {
  const request = normalizeAskRequest(sample);
  const schema = buildRequestedSchema(request);
  assert.deepEqual(schema.properties.choice.enum, ["数据校验", "界面打磨"]);
  assert.deepEqual(schema.required, ["choice"]);
  assert.equal(schema.properties.note.type, "string");
  const message = buildAskMessage(request);
  assert.match(message, /两块工作互不依赖/);
  assert.match(message, /先做数据校验/);
  assert.match(message, /先补输入检查/);
});

test("returns the selected option and note to the original task", () => {
  const request = normalizeAskRequest(sample);
  const result = formatAskAnswer({ action: "confirmed", value: { choice: "数据校验", note: "今天先做它" } }, request);
  assert.equal(result.isError, false);
  assert.match(result.text, /用户选择：数据校验/);
  assert.match(result.text, /今天先做它/);
  assert.match(result.text, /继续原任务/);
  assert.match(result.text, /Ask 的选择本身不构成执行授权/);
  assert.match(result.text, /尚无授权时须另行确认/);
});

test("formats a validated multiple selection as a list", () => {
  const request = normalizeAskRequest({ ...sample, selectionMode: "multiple", minSelections: 2, maxSelections: 2 });
  const result = formatAskAnswer({ action: "confirmed", value: { choice: ["数据校验", "界面打磨"], note: "两项都需要" } }, request);
  assert.equal(result.isError, false);
  assert.match(result.text, /- 数据校验\n- 界面打磨/);
  assert.match(result.text, /两项都需要/);
  assert.match(result.text, /Ask 的选择本身不构成执行授权/);
  for (const choice of [["数据校验"], ["数据校验", "数据校验"], ["数据校验", "不存在"]]) {
    assert.equal(formatAskAnswer({ action: "confirmed", value: { choice } }, request).isError, true);
  }
});

test("preserves a user's explicit custom choice as a distinct answer", () => {
  const request = normalizeAskRequest(sample);
  const result = formatAskAnswer({
    action: "confirmed",
    value: { customChoice: "保留视觉，重写通信层" },
  }, request);
  assert.equal(result.isError, false);
  assert.match(result.text, /自定义选择：保留视觉，重写通信层/);
  assert.match(result.text, /继续原任务/);
  assert.match(result.text, /Ask 的选择本身不构成执行授权/);
  assert.equal(formatAskAnswer({
    action: "confirmed",
    value: { customChoice: "" },
  }, request).isError, true);
});

test("a confirmed choice guides the task but does not authorize an external or irreversible action", () => {
  const request = normalizeAskRequest({ ...sample, question: "是否选择删除本地目录作为更新方式？", options: ["删除本地目录", "使用重新加载"] });
  const result = formatAskAnswer({ action: "confirmed", value: { choice: "删除本地目录" } }, request);
  assert.equal(result.isError, false);
  assert.match(result.text, /用户选择：删除本地目录/);
  assert.match(result.text, /Ask 的选择本身不构成执行授权/);
  assert.match(result.text, /先核对是否已有针对具体动作及后果的明确授权/);
  assert.match(result.text, /尚无授权时须另行确认/);
});

test("does not turn rejection, timeout or close into consent", () => {
  const request = normalizeAskRequest(sample);
  for (const action of ["rejected", "timeout", "aborted"]) {
    const result = formatAskAnswer({ action }, request);
    assert.equal(result.isError, false);
    assert.match(result.text, /不要把.*当作同意|没有收到用户决定/);
  }
});

test("rejects malformed or unknown answers rather than guessing", () => {
  const request = normalizeAskRequest(sample);
  assert.equal(formatAskAnswer({ action: "confirmed", value: { choice: "不存在" } }, request).isError, true);
  const longNote = "注".repeat(1001);
  const longNoteResult = formatAskAnswer({ action: "confirmed", value: { choice: "数据校验", note: longNote } }, request);
  assert.equal(longNoteResult.isError, false);
  assert.ok(longNoteResult.text.includes(longNote));
  assert.equal(formatAskAnswer({ action: "unexpected" }, request).isError, true);
});

test("requires model-selected single or multiple mode and bounds its options", () => {
  assert.ok(ASK_TOOL_SCHEMA.required.includes("selectionMode"));
  assert.match(ASK_TOOL_SCHEMA.properties.question.description, /具体动作及目标/);
  assert.match(ASK_TOOL_SCHEMA.properties.background.description, /核实的备份版本与可行替代方案/);
  assert.deepEqual(ASK_TOOL_SCHEMA.properties.selectionMode.enum, ["single", "multiple"]);
  assert.equal(ASK_TOOL_SCHEMA.properties.minSelections.minimum, 1);
  assert.equal(ASK_TOOL_SCHEMA.properties.maxSelections.maximum, 5);
  assert.equal(ASK_TOOL_SCHEMA.properties.options.minItems, 2);
  assert.equal(ASK_TOOL_SCHEMA.properties.options.maxItems, 5);
});
