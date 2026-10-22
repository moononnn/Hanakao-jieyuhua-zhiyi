// 排队话单的状态机测试。
// 覆盖四件容易出错的事：写一句、写一串话、同一句排 N 轮，
// 以及「你自己开口它就停」（人优先，误判方向单向）。
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildQueueItems,
  describeQueuePlan,
  normalizeQueueRounds,
  planTotalRounds,
  QUEUE_MAX_ROUNDS,
  QueuePlanRegistry,
  watchdogDecision,
} from "../lib/queue-plan.js";

test("轮数收敛到 1~50", () => {
  assert.equal(normalizeQueueRounds(1), 1);
  assert.equal(normalizeQueueRounds(50), 50);
  assert.equal(normalizeQueueRounds(999), 50);
  assert.equal(normalizeQueueRounds(0), 1);
  assert.equal(normalizeQueueRounds("abc"), 1);
  assert.equal(normalizeQueueRounds("7"), 7);
});

test("写一句就是一句话，排一轮", () => {
  const built = buildQueueItems("那我们先吃饭，回头再聊这个？");
  assert.equal(built.ok, true);
  assert.equal(built.items.length, 1);
  assert.equal(built.items[0].text, "那我们先吃饭，回头再聊这个？");
  assert.equal(built.items[0].repeat, 1);
  assert.equal(built.total, 1);
});

test("写几句按行拆开，一轮一句", () => {
  const built = buildQueueItems("第一句\n第二句\n\n  第三句  ");
  assert.equal(built.ok, true);
  assert.equal(built.items.length, 3, "空行要丢掉，行内多余空白要收掉");
  assert.equal(built.items[0].text, "第一句");
  assert.equal(built.items[2].text, "第三句");
  assert.equal(built.total, 3);
});

test("同一句排 N 轮：每一句都重复 N 次", () => {
  const built = buildQueueItems("请继续", { rounds: 3 });
  assert.equal(built.ok, true);
  assert.equal(built.items.length, 1);
  assert.equal(built.items[0].repeat, 3);
  assert.equal(built.total, 3);
});

test("空内容与超长内容都拒掉", () => {
  const empty = buildQueueItems("   \n  ");
  assert.equal(empty.ok, false);
  assert.match(empty.error, /先写一句/);
  const tooLong = buildQueueItems("字".repeat(501));
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.error, /500/);
});

test("总轮数超过上限就拒掉，不静默截断", () => {
  const built = buildQueueItems("一句\n两句\n三句", { rounds: 20 });
  assert.equal(built.ok, false);
  assert.match(built.error, /上限/);
  assert.equal(built.total, 60);
  const ok = buildQueueItems("一句\n两句", { rounds: 25 });
  assert.equal(ok.ok, true);
  assert.equal(ok.total, 50);
  assert.equal(QUEUE_MAX_ROUNDS, 50);
});

test("话单按顺序往下走：先这句 N 轮，再下一句", () => {
  const registry = new QueuePlanRegistry();
  const built = buildQueueItems("请继续\n换个话题", { rounds: 2 });
  const started = registry.start({ sessionId: "s1", items: built.items });
  assert.equal(started.ok, true);
  assert.equal(started.state.total, 4);

  assert.equal(registry.nextText("s1"), "请继续");
  registry.markFired("s1");
  assert.equal(registry.nextText("s1"), "请继续", "同一句还要再排一轮");
  registry.markFired("s1");
  assert.equal(registry.nextText("s1"), "换个话题", "这句排够了，换下一句");
  registry.markFired("s1");
  assert.equal(registry.nextText("s1"), "换个话题");
  const after = registry.markFired("s1");
  assert.equal(after.status, "finished", "发满就该收工");
  assert.equal(after.done, 4);
  assert.equal(registry.nextText("s1"), null);
});

test("你自己开口它就停：人优先，不跟人抢麦", () => {
  const registry = new QueuePlanRegistry();
  const built = buildQueueItems("请继续", { rounds: 3 });
  registry.start({ sessionId: "s1", items: built.items });
  registry.markFired("s1");
  const stopped = registry.onUserMessage("s1");
  assert.equal(stopped.status, "stopped");
  assert.equal(registry.get("s1"), null, "停了之后就不该再有下一句");
  assert.equal(registry.nextText("s1"), null);
});

test("自己发的那句不算插话（单向误判：宁可不停）", () => {
  const registry = new QueuePlanRegistry();
  const built = buildQueueItems("请继续", { rounds: 2 });
  registry.start({ sessionId: "s1", items: built.items });
  registry.markFired("s1");
  assert.equal(registry.isOwnPrompt("s1", "请继续"), true);
  assert.equal(registry.isOwnPrompt("s1", "我们换个话题吧"), false);
  assert.equal(registry.isOwnPrompt("s2", "请继续"), false, "别的对话不算");
});

test("还挂在宿主排队的那一句没被接走时，不再送下一句", () => {
  const registry = new QueuePlanRegistry();
  const built = buildQueueItems("第一句\n第二句", { rounds: 1 });
  registry.start({ sessionId: "s1", items: built.items });
  registry.markFired("s1");
  registry.markQueued("s1");
  assert.equal(registry.isPending("s1"), true);
  assert.equal(registry.nextText("s1"), null, "还没被接走就送下一句，两句会挤在一起");
  registry.markDelivered("s1");
  assert.equal(registry.isPending("s1"), false);
  assert.equal(registry.nextText("s1"), "第二句");
});

test("状态条那句话写的是排到第几轮", () => {
  const registry = new QueuePlanRegistry();
  const built = buildQueueItems("一句\n两句\n三句", { rounds: 1 });
  registry.start({ sessionId: "s1", items: built.items });
  assert.equal(describeQueuePlan(registry.get("s1")), "排队中 第 1/3 轮");
  registry.markFired("s1");
  assert.equal(describeQueuePlan(registry.get("s1")), "排队中 第 2/3 轮");
  assert.equal(describeQueuePlan(null), "");
});

test("没有会话编号就不给建单", () => {
  const registry = new QueuePlanRegistry();
  const built = buildQueueItems("一句话");
  const started = registry.start({ sessionId: "", items: built.items });
  assert.equal(started.ok, false);
  assert.match(started.error, /哪段对话/);
});

test("总轮数是每句次数之和", () => {
  assert.equal(planTotalRounds([{ repeat: 2 }, { repeat: 3 }]), 5);
  assert.equal(planTotalRounds([]), 0);
});

// 看门狗：轮末信号被宿主丢掉时，靠它自己把下一句补上。
// 2026-10-22 实机踩的坑：钩子被 App RPC 并发限流整条丢掉，话单卡在第 2/2 轮不动。

test("看门狗：ta 还在回话时不补发", () => {
  const decision = watchdogDecision({
    status: "running", busy: true, idleSince: 0, lastFiredAt: 0, startedAt: 0, now: 100_000,
  });
  assert.equal(decision.fire, false);
  assert.equal(decision.idleSince, 0, "ta 一忙，之前那段闲就不作数");
});

test("看门狗：第一次看见闲只记起点，不急着发", () => {
  const decision = watchdogDecision({
    status: "running", busy: false, idleSince: 0, lastFiredAt: 0, startedAt: 0, now: 100_000,
  });
  assert.equal(decision.fire, false);
  assert.equal(decision.idleSince, 100_000, "要连续闲一阵子才动");
});

test("看门狗：刚发完不久不补发", () => {
  const decision = watchdogDecision({
    status: "running", busy: false, idleSince: 90_000, lastFiredAt: 99_000, startedAt: 0, now: 100_000,
  });
  assert.equal(decision.fire, false, "上一轮刚送出去，得等 ta 真的说完");
  assert.equal(decision.idleSince, 90_000);
});

test("看门狗：连续闲够一阵子才补发下一句", () => {
  const decision = watchdogDecision({
    status: "running", busy: false, idleSince: 80_000, lastFiredAt: 0, startedAt: 0, now: 100_000,
  });
  assert.equal(decision.fire, true);
  assert.equal(decision.idleSince, 0);
});

test("看门狗：还有一句挂在宿主那儿排着时不补发", () => {
  const decision = watchdogDecision({
    status: "running", pending: true, busy: false, idleSince: 80_000, lastFiredAt: 0, startedAt: 0, now: 100_000,
  });
  assert.equal(decision.fire, false, "两句挤在一起会把 ta 打断");
});

test("看门狗：话单已经不在跑就不管了", () => {
  const decision = watchdogDecision({
    status: "finished", busy: false, idleSince: 80_000, lastFiredAt: 0, startedAt: 0, now: 100_000,
  });
  assert.equal(decision.fire, false);
  assert.equal(decision.idleSince, 0);
});

test("看门狗：查不到忙闲时按「还在回话」处理", () => {
  // sessionIsBusy 查不到就返回 true（宁可晚一轮也不打断 ta）。
  const decision = watchdogDecision({
    status: "running", busy: true, idleSince: 80_000, lastFiredAt: 0, startedAt: 0, now: 100_000,
  });
  assert.equal(decision.fire, false);
  assert.equal(decision.idleSince, 0);
});
