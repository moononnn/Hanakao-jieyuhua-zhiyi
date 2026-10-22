// 循环续接的状态机测试。
// 覆盖三件容易出错的事：设 N 轮就发 N 轮、发完不立刻再发、ta 说收工话先问人不自己停。
import test from "node:test";
import assert from "node:assert/strict";
import {
  ContinueLoopRegistry,
  LOOP_DEFAULT_ROUNDS,
  LOOP_JUDGE_DEDUPE_MS,
  LOOP_MIN_GAP_MS,
  looksLikeFinished,
  normalizeLoopRounds,
  shouldJudgeLoop,
} from "../lib/continue-loop.js";

test("轮数收敛到 1~50，非法值回到默认", () => {
  assert.equal(normalizeLoopRounds(1), 1);
  assert.equal(normalizeLoopRounds(50), 50);
  assert.equal(normalizeLoopRounds(999), 50);
  assert.equal(normalizeLoopRounds("abc"), 0);
  assert.equal(new ContinueLoopRegistry().start({ sessionId: "s", rounds: 999 }).state.total, 50);
  assert.equal(new ContinueLoopRegistry().start({ sessionId: "s", rounds: 0 }).state.total, LOOP_DEFAULT_ROUNDS);
});

test("设 N 轮就真的发 N 轮，最后一轮不掉回普通分支", () => {
  let now = 0;
  const loop = new ContinueLoopRegistry({ now: () => now });
  loop.start({ sessionId: "s", rounds: 3 });
  let fired = 0;
  for (let i = 0; i < 8; i += 1) {
    const decision = loop.decideAfterTurn("s", { assistantText: "继续说下去", now });
    if (decision?.action !== "continue") break;
    fired += 1;
    loop.markFired("s", now);
    now += LOOP_MIN_GAP_MS + 10;
  }
  assert.equal(fired, 3);
  assert.equal(loop.get("s"), null, "跑满之后状态应当清掉");
});

test("刚发完马上又触发时不重复发", () => {
  let now = 1_000;
  const loop = new ContinueLoopRegistry({ now: () => now });
  loop.start({ sessionId: "s", rounds: 5 });
  loop.markFired("s", now);
  const decision = loop.decideAfterTurn("s", { assistantText: "接着说", now: now + 100 });
  assert.equal(decision.action, "wait");
});

test("ta 说收工话时先屏住问人，不自己停", () => {
  const now = 0;
  const loop = new ContinueLoopRegistry({ now: () => now });
  loop.start({ sessionId: "s", rounds: 5 });
  const decision = loop.decideAfterTurn("s", { assistantText: "这件事已经完成了。", now });
  assert.equal(decision.action, "confirm");
  assert.equal(loop.get("s").status, "awaiting");
  const resumed = loop.resumeAfterConfirm("s");
  assert.equal(resumed.status, "running");
});

test("用户自己接过话就停", () => {
  const loop = new ContinueLoopRegistry({ now: () => 0 });
  loop.start({ sessionId: "s", rounds: 5 });
  assert.ok(loop.onUserMessage("s"));
  assert.equal(loop.get("s"), null);
});

test("同一轮的两个判定信号只认第一个，轮间间隔正常放行", () => {
  // 钩子与 turn_end 前后脚到达，不去重就会连发两声「继续哈」。
  assert.equal(shouldJudgeLoop(0, 1000), true, "还没判过，第一次放行");
  assert.equal(shouldJudgeLoop(1000, 1000), false, "同一瞬间的第二路：按住");
  assert.equal(shouldJudgeLoop(1000, 1000 + LOOP_JUDGE_DEDUPE_MS - 1), false, "窗口内还是按住");
  assert.equal(shouldJudgeLoop(1000, 1000 + LOOP_JUDGE_DEDUPE_MS), true, "窗口到就放行");
  // 正常一轮远不止这个间隔，不能把真实的新一轮误当成重复。
  assert.equal(shouldJudgeLoop(1000, 1000 + 45_000), true);
});

test("弱询问词只在句尾才算收工", () => {
  assert.equal(looksLikeFinished("需要我补充资料吗？我都拿到了"), false);
  assert.equal(looksLikeFinished("都弄好了，还要我做什么吗"), true);
  assert.equal(looksLikeFinished("任务完成"), true);
  assert.equal(looksLikeFinished("我接着往下做"), false);
});
