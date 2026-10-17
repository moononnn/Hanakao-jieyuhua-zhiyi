import test from "node:test";
import assert from "node:assert/strict";
import {
  RESUME_MAX_CONSECUTIVE,
  buildResumeExplanation,
  createResumeTracker,
  isUserInitiatedAbortReason,
  parseAutoRetryFailure,
  parseResumeSignal,
  parseSessionAbort,
  parseTurnFailure,
  sessionIdFromPath,
} from "../lib/resume-watch.js";

const PATH = "C:/Users/me/.hanako/agents/hanako/sessions/sess_abc.jsonl";

function turnEnd(patch = {}) {
  return {
    type: "turn_end",
    message: { content: [{ type: "text", text: "这段说完了。" }], stopReason: "stop" },
    ...patch,
  };
}

test("会话与伙伴标识从 bus 给的路径里认，不去扫文件", () => {
  assert.equal(sessionIdFromPath(PATH), "sess_abc");
  assert.equal(sessionIdFromPath(null), "");
});

test("正常收尾不算异常；工具循环的中间轮也不算", () => {
  assert.equal(parseTurnFailure(turnEnd(), PATH), null);
  assert.equal(parseTurnFailure(turnEnd({ message: { content: [{ type: "toolCall", name: "read" }], stopReason: "toolUse" } }), PATH), null);
});

test("stopReason=error、非用户主动的中断、wasSuccessful=false 三条都算异常", () => {
  const byReason = parseTurnFailure(turnEnd({ message: { content: [], stopReason: "error" }, wasSuccessful: false }), PATH);
  assert.equal(byReason.sessionId, "sess_abc");
  const byAbort = parseTurnFailure(turnEnd({ aborted: true, reason: "connection_reset" }), PATH);
  assert.equal(byAbort.sessionId, "sess_abc");
  const byStatus = parseTurnFailure(turnEnd({ wasSuccessful: false }), PATH);
  assert.equal(byStatus.sessionId, "sess_abc");
});

test("用户自己按停不算故障，也不该触发续接", () => {
  assert.equal(isUserInitiatedAbortReason("user_cancel"), true);
  assert.equal(parseTurnFailure(turnEnd({ aborted: true, reason: "user_cancel" }), PATH), null);
  assert.equal(parseSessionAbort({ type: "session_status", isStreaming: false, aborted: true, reason: "abort" }, PATH), null);
});

test("宿主自动重试失败与会话被强制释放也进同一通道", () => {
  const retry = parseAutoRetryFailure({ type: "auto_retry_end", success: false, attempt: 3, finalError: "timeout" }, PATH);
  assert.equal(retry.sessionId, "sess_abc");
  assert.equal(parseAutoRetryFailure({ type: "auto_retry_end", success: true }, PATH), null);
  const released = parseSessionAbort({ type: "session_status", isStreaming: false, aborted: true, reason: "runtime_restart" }, PATH);
  assert.equal(released.errorMessage, "runtime_restart");
  assert.equal(parseResumeSignal(turnEnd({ message: { content: [], stopReason: "error" } }), PATH).sessionId, "sess_abc");
});

test("异常先等宿主重试，过一会儿才决定续不续", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true });
  const signal = parseResumeSignal(turnEnd({ message: { content: [], stopReason: "error" } }), PATH);
  assert.equal(tracker.onAbnormal(signal).action, "wait");
  assert.equal(tracker.resolve({ sessionId: "sess_abc" }).action, "wait");
  clock += 5_000;
  const decision = tracker.resolve({ sessionId: "sess_abc" });
  assert.equal(decision.action, "resume");
  assert.equal(decision.attempt, 1);
});

test("连续续接用尽后停手，并且这个会话只报一次", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true, maxConsecutive: 3, cooldownMs: 0 });
  for (let round = 1; round <= 3; round += 1) {
    tracker.onAbnormal({ sessionId: "sess_abc", agentId: "hanako" });
    clock += 5_000;
    assert.equal(tracker.resolve({ sessionId: "sess_abc" }).action, "resume", `第 ${round} 次应该继续续`);
    tracker.noteResumeFailed("sess_abc", "hanako");
  }
  tracker.onAbnormal({ sessionId: "sess_abc", agentId: "hanako" });
  clock += 5_000;
  const exhausted = tracker.resolve({ sessionId: "sess_abc" });
  assert.equal(exhausted.action, "report");
  assert.match(exhausted.reason, /3 次/);
  // 同一会话不该反复报
  assert.equal(tracker.resolve({ sessionId: "sess_abc" }).action, "ignore");
});

test("自动续接没开时只报一次，不会偷偷发「继续哈」", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: false });
  tracker.onAbnormal({ sessionId: "sess_abc", agentId: "hanako" });
  clock += 5_000;
  assert.equal(tracker.resolve({ sessionId: "sess_abc" }).action, "report");
  assert.equal(tracker.resolve({ sessionId: "sess_abc" }).action, "ignore");
  assert.equal(tracker.snapshot("sess_abc").consecutive, 0);
});

test("冷却期内不再连着发，冷却过了才允许", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true, cooldownMs: 60_000 });
  tracker.onAbnormal({ sessionId: "sess_abc" });
  clock += 5_000;
  assert.equal(tracker.resolve({ sessionId: "sess_abc" }).action, "resume");
  tracker.onAbnormal({ sessionId: "sess_abc" });
  clock += 5_000;
  assert.equal(tracker.resolve({ sessionId: "sess_abc" }).action, "wait");
  clock += 60_000;
  assert.equal(tracker.resolve({ sessionId: "sess_abc" }).action, "resume");
});

test("宿主自己在重试时不抢着续接", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true });
  tracker.markRetrying("sess_abc");
  clock += 10_000;
  assert.match(tracker.resolve({ sessionId: "sess_abc" }).reason, /宿主自己在重试/);
});

test("出了正文就恢复正常：卡住计时作废、连续失败清零", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true, stuckTimeoutMs: 90_000 });
  tracker.markStarted("sess_abc", "hanako");
  tracker.onAbnormal({ sessionId: "sess_abc" });
  clock += 5_000;
  tracker.resolve({ sessionId: "sess_abc" });
  tracker.markProduced("sess_abc", "hanako");
  tracker.markRecovered("sess_abc", "hanako");
  assert.equal(tracker.snapshot("sess_abc").consecutive, 0);
  assert.equal(tracker.snapshot("sess_abc").pending, null);
});

test("卡住兜底：开头 90 秒没正文且没有收尾信号才算一次", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true, stuckTimeoutMs: 90_000 });
  tracker.markStarted("sess_abc", "hanako");
  clock += 89_000;
  assert.equal(tracker.checkStuck(clock).length, 0);
  clock += 2_000;
  const stuck = tracker.checkStuck(clock);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].sessionId, "sess_abc");
  // 已经登记过待决信号，不该反复登记
  assert.equal(tracker.checkStuck(clock + 1_000).length, 0);
});

test("已经出过正文的会话不会被卡住规则反复盯上", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, stuckTimeoutMs: 90_000 });
  tracker.markStarted("sess_abc", "hanako");
  tracker.markProduced("sess_abc", "hanako");
  clock += 120_000;
  assert.equal(tracker.checkStuck(clock).length, 0);
});

test("对外说法只讲现象，不把错误码原话甩给用户", () => {
  const text = buildResumeExplanation({ aborted: true, reason: "ECONNRESET: socket hang up" });
  assert.equal(text.includes("ECONNRESET"), false);
  assert.match(text, /停住|没收尾|半路/);
  assert.equal(buildResumeExplanation({}).length > 0, true);
  assert.equal(RESUME_MAX_CONSECUTIVE, 3);
});