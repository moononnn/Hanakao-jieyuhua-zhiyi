import test from "node:test";
import assert from "node:assert/strict";
import { activeTimingIndex, buildReaderSegments, formatTimeLabel } from "../ui/assets/voice-reader.js";

test("词级时间戳只包住对应词，原文标点和空格完整保留", () => {
  const text = "早上好，玥儿。";
  const result = buildReaderSegments(text, [
    { start: 0, end: 320, text: "早上好" },
    { start: 360, end: 700, text: "玥儿" },
  ]);
  assert.equal(result.segments.map((part) => part.text).join(""), text);
  assert.equal(result.marks.length, 2);
  assert.deepEqual(result.segments.map((part) => part.type), ["mark", "text", "mark", "text"]);
});

test("标点、换行和表情不稀释词级字幕覆盖率", () => {
  const text = "「早上好，玥儿！」\n——我在这儿。✨";
  const result = buildReaderSegments(text, [
    { start: 0, end: 300, text: "早上好" },
    { start: 360, end: 620, text: "玥儿" },
    { start: 850, end: 1250, text: "我在这儿" },
  ]);
  assert.equal(result.marks.length, 3);
  assert.equal(result.segments.map((part) => part.text).join(""), text);
});

test("时间戳缺失或覆盖不足时保留全文，不冒险显示残缺字幕", () => {
  const text = "这是一整段较长的朗读内容。";
  const missing = buildReaderSegments(text, null);
  const insufficient = buildReaderSegments(text, [{ start: 0, end: 200, text: "这" }]);
  assert.deepEqual(missing.marks, []);
  assert.deepEqual(missing.segments, [{ type: "text", text }]);
  assert.deepEqual(insufficient.marks, []);
  assert.deepEqual(insufficient.segments, [{ type: "text", text }]);
});

test("当前播放时间只点亮对应的词，停顿间隙不误点", () => {
  const marks = [
    { start: 0, end: 320 },
    { start: 400, end: 700 },
  ];
  assert.equal(activeTimingIndex(marks, 0), 0);
  assert.equal(activeTimingIndex(marks, 319), 0);
  assert.equal(activeTimingIndex(marks, 320), -1);
  assert.equal(activeTimingIndex(marks, 450), 1);
  assert.equal(activeTimingIndex(marks, 700), -1);
});

test("播放器时间用分秒格式显示", () => {
  assert.equal(formatTimeLabel(0), "0:00");
  assert.equal(formatTimeLabel(65.9), "1:05");
  assert.equal(formatTimeLabel(-2), "0:00");
});
