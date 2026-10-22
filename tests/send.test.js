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
  sendToConversation,
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

test("发送失败保留原始宿主错误供诊断，不只留下友好提示", async () => {
  const original = Object.assign(new Error('Missing capability app/session.start-turn'), { code: 'APP_HOST_ERROR' });
  const sdk = { bus: { request: async () => { throw original; } } };
  await assert.rejects(sendToConversation(sdk, { text: '测试回答', sessionId: 'test-source' }), (error) => {
    assert.equal(error.cause, original);
    assert.match(error.cause.message, /app\/session\.start-turn/);
    assert.match(error.message, /发起.*对话|开启.*对话/);
    return true;
  });
});

test("busy 退避期间守卫转 false：尚未发送的重试被当场拦住", async () => {
  // 总开关是在退避等待里被关掉的。只在进入前查一次的话，这次还是会插进用户的对话。
  let allowed = true;
  const calls = [];
  const sdk = {
    bus: {
      request: async (type) => {
        calls.push(type);
        if (type !== 'session:send') return { sessions: [] };
        if (calls.filter((name) => name === 'session:send').length === 1) {
          allowed = false;
          const busy = new Error('session is busy');
          busy.code = 'BUSY';
          throw busy;
        }
        return { ok: true, accepted: true, sessionId: 'sess_guard' };
      },
    },
  };
  await assert.rejects(
    sendToConversation(sdk, { text: '继续哈', sessionId: 'sess_guard', beforeSend: () => allowed }),
    (error) => {
      assert.equal(error.name, 'SendError');
      assert.match(error.message, /没发出去|关掉/);
      return true;
    },
  );
  assert.equal(calls.filter((name) => name === 'session:send').length, 1, '守卫拦下之后不能再发第二次');
});

test("SendError 带自己的错误码，别和宿主返回的混为一谈", () => {
  const error = new SendError("too_long", "太长了。");
  assert.equal(error.name, "SendError");
  assert.equal(error.code, "too_long");
  assert.equal(error.message, "太长了。");
});
