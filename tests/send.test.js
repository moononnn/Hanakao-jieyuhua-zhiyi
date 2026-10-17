// 「等 ta 说完再发」的纯函数回归（node:test，零依赖）。
// 总线链路（session:list / session:send）在 app-tool.test.js 里。

import test from "node:test";
import assert from "node:assert/strict";
import {
  QUEUE_TEXT_MAX,
  SendError,
  friendlySendError,
  normalizeQueuedText,
  resolveDeliverAs,
} from "../lib/send.js";

test("两种投递语义：followUp 是排队，steer 是插话", () => {
  assert.equal(resolveDeliverAs("followUp"), "followUp");
  assert.equal(resolveDeliverAs("steer"), "steer");
  // 认不出的值一律当排队，不给「不小心变成插话」留口子
  assert.equal(resolveDeliverAs(undefined), "followUp");
  assert.equal(resolveDeliverAs("whatever"), "followUp");
  assert.equal(resolveDeliverAs(""), "followUp");
});

test("发出去的话先压空白再判长度，不吞内容", () => {
  assert.equal(normalizeQueuedText("  等你说完   我有件事  "), "等你说完 我有件事");
  assert.equal(normalizeQueuedText("换\n行\t也算空白"), "换 行 也算空白");
  assert.equal(normalizeQueuedText(null), "");
  assert.equal(normalizeQueuedText(123), "");
  assert.ok("字".repeat(QUEUE_TEXT_MAX).length === 500);
});

test("内部错误码翻成人话，原始码不外泄", () => {
  const denied = friendlySendError(new SendError("APP_CAPABILITY_DENIED", "APP_CAPABILITY_DENIED"));
  assert.match(denied, /管理会话/);
  assert.match(denied, /应用权限/);
  assert.doesNotMatch(denied, /APP_CAPABILITY_DENIED/);

  assert.match(friendlySendError(new Error("session is busy")), /还在回复/);
  assert.match(friendlySendError(new Error("no such session")), /找不到要发进的那段对话/);
  assert.match(friendlySendError(new Error("请求超时了")), /超时/);
  assert.match(friendlySendError(new Error("unknown weirdness")), /再试一次/);
});

test("SendError 带自己的错误码，别和宿主返回的混为一谈", () => {
  const error = new SendError("too_long", "太长了。");
  assert.equal(error.name, "SendError");
  assert.equal(error.code, "too_long");
  assert.equal(error.message, "太长了。");
});
