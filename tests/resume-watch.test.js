import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RESUME_CONFIG,
  RESUME_MAX_CONSECUTIVE,
  buildResumeExplanation,
  buildSessionIndex,
  classifyResumeBlocker,
  createResumeTracker,
  describeResumeSource,
  isSubagentSessionPath,
  isSubagentSessionTarget,
  isUserInitiatedAbortReason,
  lookupSession,
  normalizeResumeConfig,
  openingSnippet,
  openedAtSnippet,
  parseAutoRetryFailure,
  parseResumeSignal,
  parseSessionAbort,
  parseTurnFailure,
  reviewStuckCandidate,
  sessionIdFromPath,
  sessionUuidOf,
  sessionWrittenSince,
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

test("卡住候选只报不记：复核通过才 markStuck，未复核前不动状态", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true, stuckTimeoutMs: 90_000 });
  tracker.markStarted("sess_abc", "hanako");
  clock += 95_000;
  const candidates = tracker.stuckCandidates(clock);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sessionId, "sess_abc");
  assert.equal(candidates[0].agentId, "hanako");
  // 还没确认，就不该留在待决队列里
  assert.equal(tracker.snapshot("sess_abc").pending, null);
  assert.equal(tracker.pendingKeys().length, 0);
  tracker.markStuck("sess_abc");
  assert.equal(tracker.snapshot("sess_abc").pending, "stuck");
  // 复核不通过时上层直接 markProduced，候选下次不再出现
  tracker.markProduced("sess_abc", "hanako");
  clock += 1_000;
  assert.equal(tracker.stuckCandidates(clock).length, 0);
});

test("会话索引：sessionId 和事件里的文件名都能落到同一条", () => {
  const index = buildSessionIndex([
    { sessionId: "sess_abc", path: PATH, title: "解语花为什么弹提醒", agentId: "hanako", agentName: "小花", modified: 1792212000000 },
    { sessionId: "sess_def", path: "D:/x/agents/xiansheng/sessions/sess_def.jsonl", title: "另一个人", agentName: "星眠", modified: 1792211000 },
  ]);
  assert.equal(lookupSession(index, { sessionId: "sess_abc" }).title, "解语花为什么弹提醒");
  assert.equal(lookupSession(index, { sessionPath: PATH }).sessionId, "sess_abc");
  assert.equal(lookupSession(index, { sessionPath: "E:/other/sess_abc.jsonl" }).agentName, "小花");
  // 秒级时间戳归一成毫秒
  assert.equal(lookupSession(index, { sessionId: "sess_def" }).modified, 1792211000 * 1000);
  assert.equal(lookupSession(index, { sessionId: "sess_none" }), null);
  assert.equal(lookupSession(null, { sessionId: "sess_abc" }), null);
});

test("卡住复核：会话后来被写过就当有进展", () => {
  const startedAt = 1792212000000;
  assert.equal(sessionWrittenSince({ modified: startedAt + 5_000 }, startedAt), true);
  assert.equal(sessionWrittenSince({ modified: startedAt + 500 }, startedAt), false);
  assert.equal(sessionWrittenSince({ modified: 0 }, startedAt), false);
  assert.equal(sessionWrittenSince(null, startedAt), false);
  // 秒级 modified 也要能对上
  assert.equal(sessionWrittenSince({ modified: Math.round((startedAt + 60_000) / 1000) }, startedAt), true);
});

test("卡住复核：名单是旧快照时宁可不报，也不把「没拿到新证据」当成「没有进展」", () => {
  // 合成场景：session:list 超时后沿用比本轮更早的 modified，旧判断会把它误当没有进展。
  // 现场只证实工具轮中误报，未记录该次复核快照，不能把本测试数据当成实机取证。
  const startedAt = 1792212000000;
  const candidate = { sessionId: "sess_abc", agentId: "hanako", startedAt };
  const stale = { sessionId: "sess_abc", title: "重做拾光记页面交互", agentName: "小花", modified: startedAt - 60_000 };
  assert.deepEqual(reviewStuckCandidate(candidate, { target: stale, indexStale: true }), {
    action: "wait", reason: "stale-index",
  });
  // 拿到新鲜名单且确实没被写过，才轮到报。
  assert.deepEqual(reviewStuckCandidate(candidate, { target: stale, indexStale: false }), {
    action: "report", reason: "no-progress",
  });
  // 新鲜名单 + 后来有正文：算恢复，不报。
  const fresh = { ...stale, modified: startedAt + 5_000 };
  assert.deepEqual(reviewStuckCandidate(candidate, { target: fresh, indexStale: false }), {
    action: "recovered", reason: "written-since",
  });
  // 名单里根本没有这段对话：维持旧行为，不报也不记账。
  assert.deepEqual(reviewStuckCandidate(candidate, { target: null, indexStale: true }), {
    action: "wait", reason: "unknown-session",
  });
  for (const modified of [undefined, 0, "不明时间"]) {
    assert.deepEqual(reviewStuckCandidate(candidate, { target: { ...fresh, modified }, indexStale: false }), {
      action: "wait", reason: "missing-timing",
    });
  }
  assert.deepEqual(reviewStuckCandidate({ ...candidate, startedAt: 0 }, { target: fresh }), {
    action: "wait", reason: "missing-timing",
  });
});

test("断点续接默认关：没显式打开的一律按关处理", () => {
  assert.equal(DEFAULT_RESUME_CONFIG.enabled, false);
  assert.equal(normalizeResumeConfig({}).enabled, false);
  assert.equal(normalizeResumeConfig({ autoResume: true }).enabled, false, "开了自动但没开总开关，仍然算关");
  assert.equal(normalizeResumeConfig({ enabled: true }).enabled, true);
  assert.equal(normalizeResumeConfig({ enabled: true }).autoResume, false, "总开关开了，自动仍然是手动");
});

test("发出去的那一发在等到真实回复前不补发，计数也不会自己跳", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true, maxConsecutive: 3, cooldownMs: 0, stuckTimeoutMs: 30_000, awaitingTimeoutMs: 30_000 });
  tracker.onAbnormal({ sessionId: "sess_abc", agentId: "hanako" });
  clock += 5_000;
  assert.equal(tracker.resolve({ sessionId: "sess_abc" }).action, "resume");
  tracker.markAwaiting("sess_abc", "hanako");
  // 发送成功不等于恢复：这期间又来异常信号，也只能等。
  for (let round = 0; round < 3; round += 1) {
    clock += 5_000;
    tracker.onAbnormal({ sessionId: "sess_abc", agentId: "hanako" });
    const decision = tracker.resolve({ sessionId: "sess_abc" });
    assert.equal(decision.action, "wait", "还没拿到正文就不许再发");
    assert.equal(decision.attempt, 1, "等待期间计数不动");
  }
  // 等到上限仍然没正文：这一次才算没成，但也不在同一个 tick 里补发。
  clock += 30_000;
  const next = tracker.resolve({ sessionId: "sess_abc" });
  assert.equal(next.action, "resume");
  assert.equal(next.attempt, 2);
});

test("发送 RPC 失败：不占成功次数，也不后台一轮轮重发", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true, maxConsecutive: 3, cooldownMs: 0 });
  tracker.onAbnormal({ sessionId: "sess_abc", agentId: "hanako" });
  clock += 5_000;
  assert.equal(tracker.resolve({ sessionId: "sess_abc" }).attempt, 1);
  tracker.markAwaiting("sess_abc", "hanako");
  tracker.rollbackResume("sess_abc", "hanako");
  tracker.failAwaiting("sess_abc", "hanako", "no such session");
  const failed = tracker.resolve({ sessionId: "sess_abc" });
  assert.equal(failed.action, "report", "发不出去就报给人，不自己接着发");
  assert.equal(failed.attempt, 0, "没送出去的不占上限名额");
  tracker.onAbnormal({ sessionId: "sess_abc", agentId: "hanako" });
  clock += 5_000;
  assert.equal(tracker.resolve({ sessionId: "sess_abc" }).action, "ignore", "报过一次就停手");
});

test("发出几句就是几句：手动单发也算一句，没送出去的那句不算", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: false, maxConsecutive: 3, cooldownMs: 0 });
  // 手动：失败计数恒为 0，但确实发出去一句。
  tracker.onAbnormal({ sessionId: "sess_m", agentId: "hanako" });
  clock += 5_000;
  tracker.resolve({ sessionId: "sess_m" });
  tracker.markAwaiting("sess_m", "hanako");
  let item = tracker.progressItems()[0];
  assert.equal(item.attempt, 0, "手动模式不消耗失败重试次数");
  assert.equal(item.sent, 1, "发出去一句就算一句");
  // 这句没送出去 → 退回，不能让它冒充已发。
  tracker.failAwaiting("sess_m", "hanako", "no such session");
  item = tracker.progressItems()[0] || {};
  assert.equal(item.sent, 0, "没送出去的不算已发");
});

test("进度项告诉面板现在到哪一步，恢复后自己消失，总开关关时清场", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true, maxConsecutive: 2, cooldownMs: 0 });
  tracker.onAbnormal({ sessionId: "sess_w", agentId: "hanako" });
  clock += 5_000;
  tracker.resolve({ sessionId: "sess_w" });
  tracker.markAwaiting("sess_w", "hanako");
  assert.deepEqual(tracker.progressItems(), [
    { sessionId: "sess_w", attempt: 1, maxConsecutive: 2, status: "waiting", at: clock, sent: 1 },
  ]);
  tracker.markRecovered("sess_w", "hanako");
  assert.deepEqual(tracker.progressItems(), [], "恢复了就不该再占一条");
  tracker.onAbnormal({ sessionId: "sess_w", agentId: "hanako" });
  clock += 5_000;
  tracker.resolve({ sessionId: "sess_w" });
  tracker.markAwaiting("sess_w", "hanako");
  tracker.clearAll();
  assert.deepEqual(tracker.progressItems(), [], "总开关关掉后不能留下任何待办");
});

test("宿主开始跑「继续哈」那一轮不算清故障；用户新消息（forget）才清", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true, cooldownMs: 0, stuckTimeoutMs: 30_000, awaitingTimeoutMs: 30_000 });
  tracker.onAbnormal({ sessionId: "sess_abc", agentId: "hanako" });
  clock += 5_000;
  tracker.resolve({ sessionId: "sess_abc" });
  tracker.markAwaiting("sess_abc", "hanako");
  // 宿主开始处理我们发的那一句：仍在等它的结果。
  tracker.markStarted("sess_abc", "hanako");
  clock += 5_000;
  const waiting = tracker.resolve({ sessionId: "sess_abc" });
  assert.equal(waiting.action, "wait", "新一轮刚开始不该继承成「立刻补发」");
  assert.equal(tracker.progressItems()[0].status, "waiting", "进度不能在刚开始时就消失");
  // 用户自己开口 = 旧故障作废，上层用 forget 清。
  tracker.forget("sess_abc");
  assert.deepEqual(tracker.progressItems(), []);
});

test("宿主在自己重试时按住本地倒计时，宿主明确失败后才继续判", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true, maxConsecutive: 3, cooldownMs: 0, awaitingTimeoutMs: 30_000 });
  tracker.onAbnormal({ sessionId: "sess_abc", agentId: "hanako" });
  clock += 5_000;
  assert.equal(tracker.resolve({ sessionId: "sess_abc" }).action, "resume");
  tracker.markAwaiting("sess_abc", "hanako");
  clock += 1_000;
  tracker.markRetrying("sess_abc", "hanako");
  // 远超本地等待上限，但宿主正在自己重试：不能抢在它前面下结论。
  clock += 60_000;
  const held = tracker.resolve({ sessionId: "sess_abc" });
  assert.equal(held.action, "ignore");
  assert.match(held.reason, /宿主自己在重试/);
  // 宿主又报了异常 = 那次重试确实没成，按住的地方松开。
  tracker.onAbnormal({ sessionId: "sess_abc", agentId: "hanako" });
  clock += 5_000;
  const next = tracker.resolve({ sessionId: "sess_abc" });
  assert.equal(next.action, "resume");
  assert.equal(next.attempt, 2);
});

test("改自动与上限在同一台状态机上生效，已续几次不清零", () => {
  let clock = 1_000;
  const manual = createResumeTracker({ now: () => clock, autoResume: false, maxConsecutive: 3, cooldownMs: 0, awaitingTimeoutMs: 30_000 });
  manual.onAbnormal({ sessionId: "sess_m", agentId: "hanako" });
  clock += 5_000;
  assert.equal(manual.resolve({ sessionId: "sess_m" }).action, "report", "手动模式只报不发");
  manual.forget("sess_m");
  manual.onAbnormal({ sessionId: "sess_m", agentId: "hanako" });
  clock += 5_000;
  manual.configure({ autoResume: true });
  assert.equal(manual.resolve({ sessionId: "sess_m" }).action, "resume", "切到自动后同一条待决就该发得出去");

  const capped = createResumeTracker({ now: () => clock, autoResume: true, maxConsecutive: 3, cooldownMs: 0, awaitingTimeoutMs: 30_000 });
  const fire = () => { capped.onAbnormal({ sessionId: "sess_c", agentId: "hanako" }); clock += 5_000; return capped.resolve({ sessionId: "sess_c" }); };
  for (let round = 0; round < 3; round += 1) {
    assert.equal(fire().action, "resume", `第 ${round + 1} 次应该还能发`);
    capped.markAwaiting("sess_c", "hanako");
    clock += 31_000; // 上一发等不到回复
  }
  assert.equal(capped.snapshot("sess_c").consecutive, 3);
  capped.configure({ maxConsecutive: 1 });
  assert.equal(fire().action, "report", "上限调到 1 之后必须真的停");
  assert.equal(fire().action, "ignore", "报过就不再来第二次");
  assert.equal(capped.snapshot("sess_c").consecutive, 3, "改上限不能把已续次数洗掉");
});

test("手动首次提醒不伪装成自动次数已用尽", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock });
  tracker.onAbnormal({ sessionId: "sess_manual" });
  clock += 5_000;
  assert.equal(tracker.resolve({ sessionId: "sess_manual" }).action, "report");
  assert.deepEqual(tracker.progressItems(), []);
  assert.equal(tracker.snapshot("sess_manual").consecutive, 0);
});

test("工具中间正文只延后等待，不丢自动续接的最终结果检查", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true, maxConsecutive: 1, cooldownMs: 0, awaitingTimeoutMs: 30_000 });
  tracker.onAbnormal({ sessionId: "sess_progress" });
  clock += 5_000;
  assert.equal(tracker.resolve({ sessionId: "sess_progress" }).action, "resume");
  tracker.markAwaiting("sess_progress");
  clock += 20_000;
  tracker.markProduced("sess_progress");
  assert.ok(tracker.pendingKeys().includes("sess_progress"));
  clock += 20_000;
  assert.equal(tracker.resolve({ sessionId: "sess_progress" }).action, "wait");
  clock += 11_000;
  assert.equal(tracker.resolve({ sessionId: "sess_progress" }).action, "report");
});

test("宿主重试后正常恢复，下一次故障不继承旧暂停锁", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true, cooldownMs: 0 });
  tracker.markRetrying("sess_retry");
  tracker.markRecovered("sess_retry");
  tracker.onAbnormal({ sessionId: "sess_retry" });
  clock += 5_000;
  assert.equal(tracker.resolve({ sessionId: "sess_retry" }).action, "resume");
});

test("小条抬头：窗口名优先，没有就写伙伴名，不用「某个窗口」", () => {
  assert.equal(describeResumeSource({ title: "解语花调试", agentName: "小花" }), "来自窗口：解语花调试（小花）");
  assert.equal(describeResumeSource({ title: "解语花调试" }), "来自窗口：解语花调试");
  assert.equal(describeResumeSource({ agentName: "小花" }), "来自：小花 的对话");
  assert.equal(describeResumeSource({}).includes("某个窗口"), false);
});

test("既没标题也没伙伴名时，用对话开头那句当身份证，不写空话", () => {
  const text = describeResumeSource({ firstMessage: "小花，你帮我看看断联续接为什么没标题" });
  assert.match(text, /还没起名的对话/);
  assert.match(text, /小花，你帮我看看断联续接/);
  assert.equal(text.includes("还没标题的对话"), false);
  assert.equal(openingSnippet("一二三四五六七八九十一二三四五六七八", 16), "一二三四五六七八九十一二三四五六…");
  assert.equal(openingSnippet("  多  空格  "), "多 空格");
  assert.equal(openingSnippet(""), "");
  assert.equal(describeResumeSource({}).includes("还没起名的对话"), true);
});

test("连开头也没有时，用会话文件的开启时间当身份证", () => {
  // 文件名开头是 UTC 时间，转本地后要能对上侧栏排序里那个时间
  const local = new Date(Date.UTC(2026, 9, 17, 8, 44, 31, 721));
  const hh = String(local.getHours()).padStart(2, "0");
  const mm = String(local.getMinutes()).padStart(2, "0");
  const text = openedAtSnippet(
    "C:/x/agents/hanako/sessions/2026-10-17T08-44-31-721Z_01a14908-bc69-71c9-b629-2b6e8d424530.jsonl",
    Date.UTC(2026, 9, 17, 12, 0, 0),
  );
  assert.equal(text, `今天 ${hh}:${mm}`);
  // 跨天的会话带月日
  assert.match(
    openedAtSnippet("2026-10-16T01-02-03-000Z_abc.jsonl", Date.UTC(2026, 9, 17, 12, 0, 0)),
    /^10 月 16 日 /,
  );
  // 认不出来就不编时间
  assert.equal(openedAtSnippet("sess_0mvc7z5bx_8d43b7057117984aeba0"), "");
  assert.equal(openedAtSnippet(""), "");
  assert.match(
    describeResumeSource({ openedAt: "今天 16:44" }),
    /今天 16:44 开的那段对话/,
  );
});

test("sessionPath 为空、事件只给裸 UUID 时，也能落到同一条会话上", () => {
  const uuid = "01a14908-bc69-71c9-b629-2b6e8d424530";
  const index = buildSessionIndex([{
    sessionId: "sess_0mvc7z5bx_8d43b7057117984aeba0",
    path: `C:/Users/me/.hanako/agents/hanako/sessions/2026-10-17T08-44-31-721Z_${uuid}.jsonl`,
    title: "",
    firstMessage: "小花，你帮我看看断联续接",
    agentName: "小花",
    modified: 1792231469044,
  }]);
  assert.equal(sessionUuidOf(uuid), uuid);
  assert.equal(sessionUuidOf(`2026-10-17T08-44-31-721Z_${uuid}.jsonl`), uuid);
  assert.equal(sessionUuidOf("sess_0mvc7z5bx_8d43b7057117984aeba0"), "");
  // 只有 UUID，没有路径
  assert.equal(lookupSession(index, { sessionId: uuid }).agentName, "小花");
  // 大写也要能对上
  assert.equal(lookupSession(index, { sessionId: uuid.toUpperCase() }).agentName, "小花");
  assert.equal(lookupSession(index, { sessionPath: `x/${uuid}.jsonl` }).agentName, "小花");
  assert.equal(lookupSession(index, { sessionId: "01a00000-0000-0000-0000-000000000000" }), null);
});

test("两套编号登记成一家人：开头记在稳定编号上，UUID 侧收尾也能清掉", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, stuckTimeoutMs: 90_000 });
  const uuid = "01a14908-bc69-71c9-b629-2b6e8d424530";
  const stable = "sess_0mvc7z5bx_8d43b7057117984aeba0";
  tracker.markStarted(stable, "hanako");
  tracker.registerAlias(uuid, stable);
  assert.equal(tracker.canonicalId(uuid), stable);
  clock += 95_000;
  // 收尾走的是 UUID，必须落到同一本账上
  tracker.markRecovered(uuid, "hanako");
  assert.equal(tracker.stuckCandidates(clock).length, 0, "收尾清不到账就会把好会话判成断联");
});

test("登记别名时把旧键上的进度搬过去，不把已经续过的次数清零", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true, maxConsecutive: 3, cooldownMs: 0 });
  tracker.onAbnormal({ sessionId: "uuid-only", agentId: "hanako" });
  clock += 5_000;
  assert.equal(tracker.resolve({ sessionId: "uuid-only" }).action, "resume");
  tracker.registerAlias("uuid-only", "sess_stable");
  assert.equal(tracker.snapshot("sess_stable").consecutive, 1);
  assert.equal(tracker.pendingKeys().includes("uuid-only"), false);
});
test("子代理会话不进断点续接：路径、kind、provenance 任一条都能认出来", () => {
  // 2026-10-19 实机：一次派发四个子代理，四段会话各自在 90 秒后被判卡住。
  assert.equal(isSubagentSessionPath("C:/Users/me/.hanako/agents/hanako/subagent-sessions/direct/2026-10-19T05-04-44-870Z_01a1528c-3d46-7a9e-8e34-d0d68e8ae95a.jsonl"), true);
  assert.equal(isSubagentSessionPath("C:/Users/me/.hanako/agents/hanako/sessions/2026-10-19T05-19-18-546Z_01a15299.jsonl"), false);
  assert.equal(isSubagentSessionPath(""), false);
  assert.equal(isSubagentSessionTarget({ kind: "subagent_child" }), true);
  assert.equal(isSubagentSessionTarget({ kind: "chat" }), false);
  assert.equal(isSubagentSessionTarget({ path: "C:/x/subagent-sessions/direct/a.jsonl" }), true);
  assert.equal(isSubagentSessionTarget({ provenance: { createdBy: "subagent" } }), true);
  assert.equal(isSubagentSessionTarget({}), false);
  assert.equal(isSubagentSessionTarget(null), false);
});

test("会话条目带着 kind 一路带进索引，复核时不用再猜", () => {
  const index = buildSessionIndex([
    {
      sessionId: "sess_sub",
      path: "C:/Users/me/.hanako/agents/hanako/subagent-sessions/direct/2026-10-19T05-04-44-870Z_01a1528c.jsonl",
      kind: "subagent_child",
      modified: 1792230000000,
    },
    {
      sessionId: "sess_chat",
      path: "C:/Users/me/.hanako/agents/hanako/sessions/2026-10-19T05-19-18-546Z_01a15299.jsonl",
      kind: "chat",
      title: "修知意断点续接",
      modified: 1792230000000,
    },
  ]);
  assert.equal(lookupSession(index, { sessionId: "sess_sub" }).kind, "subagent_child");
  assert.equal(isSubagentSessionTarget(lookupSession(index, { sessionId: "sess_sub" })), true);
  assert.equal(isSubagentSessionTarget(lookupSession(index, { sessionId: "sess_chat" })), false);
});

// ── 额度/欠费/鉴权：续也续不回来（2026-10-25）──

test("额度用完、欠费、鉴权失效这三类认成「续不回来」，普通掉线不算", () => {
  // 实机原话：ChatGPT plan 的周额度提示（2026-10-25 会话记录里出现过这条）。
  assert.equal(classifyResumeBlocker({ errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~31 min." }).kind, "quota");
  assert.equal(classifyResumeBlocker({ errorMessage: "OpenAI API error (402): Insufficient Balance" }).kind, "quota");
  assert.equal(classifyResumeBlocker({ errorMessage: "insufficient_quota" }).kind, "quota");
  assert.equal(classifyResumeBlocker({ finalError: "账户余额不足，请充值后重试" }).kind, "quota");
  assert.equal(classifyResumeBlocker({ reason: "本月额度已用完" }).kind, "quota");
  assert.equal(classifyResumeBlocker({ errorMessage: "401 Unauthorized: invalid_api_key" }).kind, "auth");
  // 可恢复的那几类不能误判：断网、连接被切、容量限流都还能接回来。
  assert.equal(classifyResumeBlocker({ errorMessage: "Connection error." }), null);
  assert.equal(classifyResumeBlocker({ errorMessage: "WebSocket closed 1012" }), null);
  assert.equal(classifyResumeBlocker({ errorMessage: "OpenAI API error (429): [ttft_admission_refused] the cell is at capacity; retry shortly" }), null);
  assert.equal(classifyResumeBlocker({ errorMessage: "You have hit the rate limit, slow down." }), null);
  assert.equal(classifyResumeBlocker({ reason: "user_cancel" }), null);
  assert.equal(classifyResumeBlocker({}), null);
  assert.equal(classifyResumeBlocker(null), null);
});

test("额度用完不排队、不续发，也不让卡住兜底补一句", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true, cooldownMs: 0 });
  tracker.markStarted("sess_abc", "hanako");
  const verdict = tracker.onAbnormal({ sessionId: "sess_abc", errorMessage: "You have hit your ChatGPT usage limit (plus plan)." });
  assert.equal(verdict.action, "ignore");
  assert.equal(verdict.blocker, "quota");
  // 过了判断点也不发，不是「等一会儿再说」。
  clock += 60_000;
  assert.equal(tracker.resolve({ sessionId: "sess_abc" }).action, "ignore");
  // 卡住兜底同样不能碰它：那一条也是补发「继续哈」。
  assert.equal(tracker.stuckCandidates(clock).length, 0);
  // 面板上也不摆进度，免得看着像还在努力。
  assert.equal(tracker.progressItems(clock).length, 0);
});

test("刚发出去那句撞上欠费：不再等它，也不会超时后补第二句", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true, cooldownMs: 0, awaitingTimeoutMs: 30_000 });
  tracker.onAbnormal({ sessionId: "sess_abc", reason: "connection_reset" });
  clock += 5_000;
  assert.equal(tracker.resolve({ sessionId: "sess_abc" }).action, "resume");
  tracker.markAwaiting("sess_abc");
  clock += 2_000;
  const verdict = tracker.onAbnormal({ sessionId: "sess_abc", errorMessage: "insufficient_balance" });
  assert.equal(verdict.blocker, "quota");
  clock += 120_000;
  assert.equal(tracker.resolve({ sessionId: "sess_abc" }).action, "ignore");
});

test("用户自己开口，或者真的回上话了，额度那道封锁才解开", () => {
  let clock = 1_000;
  const tracker = createResumeTracker({ now: () => clock, autoResume: true, cooldownMs: 0 });
  tracker.onAbnormal({ sessionId: "sess_abc", errorMessage: "余额不足" });
  clock += 5_000;
  assert.equal(tracker.resolve({ sessionId: "sess_abc" }).action, "ignore");
  // 用户换了模型/充了值，自己先开一句：这一轮的账从这里重来。
  tracker.forget("sess_abc");
  assert.equal(tracker.isBlocked("sess_abc"), null);
  tracker.markStarted("sess_abc", "hanako");
  tracker.markRecovered("sess_abc", "hanako");
  tracker.onAbnormal({ sessionId: "sess_abc", reason: "connection_reset" });
  clock += 5_000;
  assert.equal(tracker.resolve({ sessionId: "sess_abc" }).action, "resume");
});
