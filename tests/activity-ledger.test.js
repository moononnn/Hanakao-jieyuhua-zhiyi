// 宿主事件账本：「谁还在跑」的第三层，也是唯一看得见 Code 页的那一层。
//
// 为什么这批测试重要（2026-10-27）：
//   守门人原来只问 session:list 和 tasks.list。可宿主给 v2 App 的 session:list
//   把 namespace 写死成 ["home","app"]，Code 页会话（namespace=code）不在里头，
//   v2 契约也没有任何参数能把它传进去。于是 Code 页正在跑的时候，
//   快照会报「全空」——守门人以为活干完了，直接关机。
//   这一层是修这个洞的，所以要把它钉死。

import test from "node:test";
import assert from "node:assert/strict";
import { createActivityLedger, IDLE_GRACE_MS, STALE_MS } from "../lib/activity-ledger.js";
import { judgeIdle } from "../lib/sleep-guard.js";
import { sampleIdleSnapshot, summarizeSnapshot } from "../lib/idle-watch.js";

const CODE_PATH = "L:/小花的git工作台/.hana/worktrees/sess-1-code/x.jsonl";

test("一轮开始就记成忙：turn_start 之后不能算空", () => {
  const ledger = createActivityLedger();
  ledger.note({ type: "turn_start" }, CODE_PATH, 1_000);
  const view = ledger.snapshot(1_000);
  assert.equal(view.busyCount, 1);
  assert.equal(view.busy[0].sessionPath, CODE_PATH);
  assert.equal(view.busy[0].busy, true);
});

test("agent_end 之后才放行，中途的 message_end 不算说完", () => {
  const ledger = createActivityLedger();
  ledger.note({ type: "turn_start" }, CODE_PATH, 1_000);
  ledger.note({ type: "message_end" }, CODE_PATH, 2_000);
  assert.equal(ledger.snapshot(2_000).busyCount, 1, "一条消息完了不代表这一轮完了");

  ledger.note({ type: "agent_end" }, CODE_PATH, 3_000);
  // 收尾还有一小段宽限，兜住没被逐个建模的事件尾巴。
  assert.equal(ledger.snapshot(3_000).busyCount, 1, "刚结束还在宽限期内");
  assert.equal(ledger.snapshot(3_000 + IDLE_GRACE_MS + 1).busyCount, 0, "宽限期过了才算真空");
});

test("willRetry 的 agent_end 不算结束：宿主还要重试", () => {
  const ledger = createActivityLedger();
  ledger.note({ type: "turn_start" }, CODE_PATH, 1_000);
  ledger.note({ type: "agent_end", willRetry: true }, CODE_PATH, 2_000);
  assert.equal(ledger.snapshot(2_000 + IDLE_GRACE_MS + 1).busyCount, 1, "重试中的轮次不能当成跑完了");
});

test("会话关掉就把账销掉，不会一直拦着关机", () => {
  const ledger = createActivityLedger();
  ledger.note({ type: "turn_start" }, CODE_PATH, 1_000);
  assert.equal(ledger.snapshot(1_000).busyCount, 1);
  ledger.note({ type: "session_closed" }, CODE_PATH, 2_000);
  assert.equal(ledger.snapshot(2_000).busyCount, 0);
});

test("标着忙但久无动静的，不再拦关机，但要单独报出来", () => {
  const ledger = createActivityLedger();
  ledger.note({ type: "turn_start" }, CODE_PATH, 1_000);
  const staleAt = 1_000 + STALE_MS + 1;
  const view = ledger.snapshot(staleAt);
  assert.equal(view.busyCount, 0, "这么久没动静，大概是会话没了，不能一直拦着");
  assert.equal(view.staleCount, 1, "但要让日志/面板看得见它被放过了");
  assert.equal(view.stale[0].sessionPath, CODE_PATH);
});

test("没有路径的事件记不了账，直接忽略而不是崩", () => {
  const ledger = createActivityLedger();
  assert.equal(ledger.note({ type: "turn_start" }, "", 1_000), false);
  assert.equal(ledger.note({ type: "turn_start" }, "   ", 1_000), false);
  assert.equal(ledger.note(null, CODE_PATH, 1_000), false);
  assert.equal(ledger.size, 0);
});

test("账本满了先丢最旧的，不会无限长", () => {
  const ledger = createActivityLedger({ maxTracked: 2 });
  ledger.note({ type: "turn_start" }, "a.jsonl", 1_000);
  ledger.note({ type: "turn_start" }, "b.jsonl", 2_000);
  ledger.note({ type: "turn_start" }, "c.jsonl", 3_000);
  const paths = ledger.snapshot(3_000).busy.map((row) => row.sessionPath);
  assert.equal(paths.length, 2);
  assert.equal(paths.includes("a.jsonl"), false, "最旧的那条被挤掉了");
});

test("判定层：会话层读不到也按忙算（不再只看任务层）", () => {
  // 这条是补 2026-10-27 发现的第二个洞：judgeIdle 以前只校验 tasks.readable，
  // session:list 抛错时会话层整体瞎掉，只要任务层空着就往下走到关机。
  const now = 2_000;
  const base = { idleMs: 0, maxWaitMs: 3_600_000, armedAt: 1_000, idleSince: 1_000 };
  const summary = {
    sessions: { readable: false, total: 0 },
    tasks: { readable: true, total: 5, active: 0 },
    busyCount: 0,
  };
  const verdict = judgeIdle(base, summary, now);
  assert.equal(verdict.busy, true, "会话层瞎掉时不能当成「都空着」");
  assert.equal(verdict.sessionsKnown, false);
  assert.equal(verdict.fire, false);
});

test("账本刚开张时的空不能当真：App 重载不会让正在跑的活停下来", () => {
  // 真实场景：升级/改代码/宿主重启把 App 重载了，账本清零。
  // 可那时候 Code 页可能正跑着一段几十分钟的活，它不会因为你重载就停。
  // 这段时间里账本一片空白，如果当成「没人干活」，就会误关机。
  const ledger = createActivityLedger({ warmupMs: 60_000 });
  const justBorn = Date.now();
  assert.equal(ledger.snapshot(justBorn).busyCount, 0, "账本确实是空的");
  assert.equal(ledger.snapshot(justBorn).warmingUp, true, "但要报成「还不确定」，不能报成「没人」");

  // 过了预热期还是空的，才允许说真空。
  assert.equal(ledger.snapshot(justBorn + 60_001).warmingUp, false);
});

test("预热期的空会让判定按忙算，不会误关机", () => {
  const now = Date.now();
  const summary = {
    sessions: { readable: true, total: 94 },
    tasks: { readable: true, total: 1407, active: 0 },
    events: { readable: true, tracked: 0, busyCount: 0, warmingUp: true },
    busyCount: 0,
  };
  const state = { idleMs: 10 * 60 * 1000, maxWaitMs: 240 * 60 * 1000, armedAt: now - 600000, idleSince: now - 900000 };
  const verdict = judgeIdle(state, summary, now);
  assert.equal(verdict.busy, true, "账本刚开张就说「全空」太危险");
  assert.equal(verdict.fire, false);
  assert.equal(verdict.eventsUncertain, true);
});

test("预热期里账本真报出了忙，就按那个忙算（不是一律阻着）", () => {
  const now = Date.now();
  const summary = {
    sessions: { readable: true, total: 94 },
    tasks: { readable: true, total: 1407, active: 0 },
    events: { readable: true, tracked: 1, busyCount: 1, warmingUp: true },
    busyCount: 1,
  };
  const state = { idleMs: 10 * 60 * 1000, maxWaitMs: 240 * 60 * 1000, armedAt: now - 600000, idleSince: now - 900000 };
  const verdict = judgeIdle(state, summary, now);
  assert.equal(verdict.busy, true);
  assert.equal(verdict.eventsUncertain, false, "这是确切的忙，不是不确定");
});

test("预热期过了、账本也真空了，才允许真关机", () => {
  const now = Date.now();
  const summary = {
    sessions: { readable: true, total: 94 },
    tasks: { readable: true, total: 1407, active: 0 },
    events: { readable: true, tracked: 5, busyCount: 0, warmingUp: false },
    busyCount: 0,
  };
  const state = { idleMs: 10 * 60 * 1000, maxWaitMs: 240 * 60 * 1000, armedAt: now - 1200000, idleSince: now - 900000 };
  const verdict = judgeIdle(state, summary, now);
  assert.equal(verdict.busy, false);
  assert.equal(verdict.fire, true);
});

test("判定层：Code 页那段在跑，会话层和任务层都空也要拦住", () => {
  // 真实场景复现：session:list 只给 home/app，Code 会话不在名单（sessions.total 有值、
  // busyCount 0），tasks 全 completed，但 Code 页其实正在跑。
  // 账本这一层把它报进 busy 之后，判定就必须是忙。
  const now = 2_000;
  const base = { idleMs: 0, maxWaitMs: 3_600_000, armedAt: 1_000, idleSince: 1_000 };
  const summary = {
    sessions: { readable: true, total: 94 },
    tasks: { readable: true, total: 1407, active: 0 },
    events: { readable: true, tracked: 1, busyCount: 1 },
    busyCount: 1, // 采样层把账本里的忙并进来了
  };
  const verdict = judgeIdle(base, summary, now);
  assert.equal(verdict.busy, true);
  assert.equal(verdict.fire, false);
});

test("采样层把账本里的忙并进 busy，而且给出来源标记", async () => {
  const ledger = createActivityLedger();
  ledger.note({ type: "turn_start" }, CODE_PATH, Date.now());

  const sdk = {
    bus: { request: async (type) => (type === "session:list" ? { sessions: [] } : null) },
    tasks: { list: async () => [] },
  };
  const snapshot = await sampleIdleSnapshot(sdk, { activityLedger: () => ledger });
  assert.equal(snapshot.events.readable, true);
  assert.equal(snapshot.events.busyCount, 1);
  assert.equal(snapshot.busy.length, 1);
  assert.equal(snapshot.busy[0].path, CODE_PATH);
  assert.equal(snapshot.busy[0].source, "events", "要看得出这条忙是事件层报的，不是会话层");
});

test("采样层不重复算：会话层已经报过忙的，账本不再加一条", async () => {
  const ledger = createActivityLedger();
  const now = Date.now();
  ledger.note({ type: "turn_start" }, "/tmp/s1.jsonl", now);

  const sdk = {
    bus: {
      request: async (type) => {
        if (type === "session:list") {
          return { sessions: [{ sessionId: "sess_s1", path: "/tmp/s1.jsonl", modified: now }] };
        }
        if (type === "session:context") return { isStreaming: true, pendingMessageCount: 0 };
        return null;
      },
    },
    tasks: { list: async () => [] },
  };
  const snapshot = await sampleIdleSnapshot(sdk, { activityLedger: () => ledger });
  assert.equal(snapshot.busy.length, 1, "同一段会话只能报一次");
  assert.equal(snapshot.busy[0].source, undefined, "保留会话层那条（信息更全）");
});

test("没注入账本时采样层照常工作，标记成读不到", async () => {
  const sdk = {
    bus: { request: async (type) => (type === "session:list" ? { sessions: [] } : null) },
    tasks: { list: async () => [] },
  };
  const snapshot = await sampleIdleSnapshot(sdk, {});
  assert.equal(snapshot.events.readable, false);
  assert.equal(snapshot.events.busyCount, 0);
  // 关键：账本读不到**不能**变成拦关机的理由（它只是 Code 页的补充眼睛，
  // 宿主根本不支持全局订阅时也不能让人永远关不了机）。
  const summary = summarizeSnapshot(snapshot);
  assert.equal(summary.events.readable, false);
  const verdict = judgeIdle({ idleMs: 0, maxWaitMs: 3_600_000, armedAt: 1, idleSince: 1 }, summary, 2);
  assert.equal(verdict.busy, false, "账本缺席不该拦关机");
});

test("压成一行时带上事件层，好让人一眼分得出是哪层在拦", async () => {
  const ledger = createActivityLedger();
  ledger.note({ type: "turn_start" }, CODE_PATH, Date.now());
  const sdk = {
    bus: { request: async (type) => (type === "session:list" ? { sessions: [] } : null) },
    tasks: { list: async () => [] },
  };
  const summary = summarizeSnapshot(await sampleIdleSnapshot(sdk, { activityLedger: () => ledger }));
  assert.equal(summary.events.busyCount, 1);
  assert.equal(summary.busy[0].source, "events");
  assert.equal(summary.busy[0].path, CODE_PATH);
});
