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

// 我们自己发的那句，要**在发之前**就记上。
// 2026-10-22 实机踩的坑：发消息会立刻起一轮，宿主在那之前就可能跑 before-start 钩子，
// 钩子靠 sentTexts 认「这是我们自己的」——认错了就当成用户插话，把整份话单停了。

test("发之前就记下「这是我们发的话」", () => {
  const registry = new QueuePlanRegistry();
  const built = buildQueueItems("来试试？");
  registry.start({ sessionId: "s1", items: built.items });
  assert.equal(registry.isOwnPrompt("s1", "来试试？"), false, "还没发，不能算我们的话");
  registry.markSending("s1", "来试试？");
  assert.equal(registry.isOwnPrompt("s1", "来试试？"), true);
  assert.equal(registry.isOwnPrompt("s1", "你好呀"), false, "用户自己说的话不算我们的");
});

test("发之前记下的那句话不占轮数", () => {
  const registry = new QueuePlanRegistry();
  const built = buildQueueItems("一句", { rounds: 2 });
  registry.start({ sessionId: "s1", items: built.items });
  registry.markSending("s1", "一句");
  assert.equal(registry.get("s1").done, 0, "记下不等于发出，轮数不能动");
  registry.markFired("s1");
  assert.equal(registry.get("s1").done, 1);
  assert.equal(describeQueuePlan(registry.get("s1")), "排队中 第 2/2 轮");
});

test("用户自己开口时话单停：我们发的那句不算用户插话", () => {
  const registry = new QueuePlanRegistry();
  const built = buildQueueItems("来试试？");
  registry.start({ sessionId: "s1", items: built.items });
  registry.markSending("s1", "来试试？");
  // 宿主把 our 提示接走时跑的就是这个钩子：认得出是我们的话 → 只清「在排」标记。
  registry.markDelivered("s1");
  assert.equal(registry.get("s1").status, "running", "我们自己的话不能把话单停了");
  // 用户插话则相反：话单当场停。
  const stopped = registry.onUserMessage("s1");
  assert.equal(stopped.status, "stopped");
  assert.equal(registry.get("s1"), null, "停掉的话单不留在表里");
});
