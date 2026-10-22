import test from "node:test";
import assert from "node:assert/strict";
import { armSleepGuard, cancelSleepGuard, describeSleepGuard, judgeIdle, setRealEnabled } from "../lib/sleep-guard.js";

function snapshot({ sessionsBusy = 0, tasksReadable = true, tasksActive = 0, sessionsTotal = 3 } = {}) {
  return {
    sessions: { total: sessionsTotal, readable: true },
    tasks: { readable: tasksReadable, total: 1118, active: tasksActive, states: {} },
    busyCount: sessionsBusy,
    busy: [],
  };
}

function base(overrides = {}) {
  return { idleMs: 600_000, maxWaitMs: 3_600_000, armedAt: 1_000, idleSince: null, ...overrides };
}

test("任务层读不到时一律按忙处理，绝不靠猜", () => {
  const verdict = judgeIdle(base(), snapshot({ tasksReadable: false }), 2_000);
  assert.equal(verdict.busy, true);
  assert.equal(verdict.fire, false);
  assert.equal(verdict.tasksKnown, false);
});

test("会话全空但后台任务还在跑，也算忙", () => {
  const verdict = judgeIdle(base(), snapshot({ sessionsBusy: 0, tasksActive: 1 }), 2_000);
  assert.equal(verdict.busy, true);
  assert.equal(verdict.fire, false);
});

test("会话正在回话时算忙", () => {
  const verdict = judgeIdle(base(), snapshot({ sessionsBusy: 2 }), 2_000);
  assert.equal(verdict.busy, true);
});

test("刚空下来只开始计时，不触发", () => {
  const verdict = judgeIdle(base(), snapshot(), 2_000);
  assert.equal(verdict.busy, false);
  assert.equal(verdict.fire, false);
  assert.equal(verdict.idleSince, 2_000, "第一次空就把起点记在这一刻");
});

test("空够时间才该动手", () => {
  const state = base({ idleSince: 1_000 });
  const verdict = judgeIdle(state, snapshot(), 1_000 + 600_000);
  assert.equal(verdict.fire, true);
  assert.equal(verdict.idleMs, 600_000);
});

test("差一秒也不动手", () => {
  const state = base({ idleSince: 1_000 });
  const verdict = judgeIdle(state, snapshot(), 1_000 + 599_999);
  assert.equal(verdict.fire, false);
});

test("忙起来就归零，之前空的时间不算数", () => {
  const verdict = judgeIdle(base({ idleSince: 1_000 }), snapshot({ sessionsBusy: 1 }), 500_000);
  assert.equal(verdict.busy, true);
  assert.equal(verdict.idleSince, null);
});

test("一直有活超了最长等待就放弃", () => {
  const state = base({ armedAt: 1_000 });
  const verdict = judgeIdle(state, snapshot({ tasksActive: 2 }), 1_000 + 3_600_000 + 1);
  assert.equal(verdict.busy, true);
  assert.equal(verdict.expire, false, "忙的时候不判放弃，放弃由空着那条路走");
});

test("空着但一直没空够、又超过最长等待，就放弃", () => {
  const state = base({ armedAt: 1_000, idleSince: 1_000 + 3_500_000 });
  const verdict = judgeIdle(state, snapshot(), 1_000 + 3_600_000 + 1);
  assert.equal(verdict.fire, false);
  assert.equal(verdict.expire, true);
});

test("刚好空够的那一下先算触发，不算放弃", () => {
  const state = base({ armedAt: 1_000, idleSince: 1_000 + 3_000_000 });
  const verdict = judgeIdle(state, snapshot(), 1_000 + 3_000_000 + 600_000);
  assert.equal(verdict.fire, true);
  assert.equal(verdict.expire, false);
});

function fakeSdk() {
  const store = new Map();
  const logs = [];
  return {
    logger: { info: async () => {}, warn: async (message) => logs.push(String(message)) },
    storage: {
      global: {
        get: async (key, fallback) => (store.has(key) ? store.get(key) : fallback),
        set: async (key, value) => { store.set(key, value); },
      },
    },
    bus: {
      request: async (type) => (type === "session:list" ? { sessions: [] } : null),
    },
    tasks: { list: async () => [] },
    notifications: { show: async () => ({ shown: true }) },
    __logs: logs,
    __store: store,
  };
}

test("挂上之后状态是守着，默认真关机", async () => {
  const sdk = fakeSdk();
  const status = await armSleepGuard(sdk, { idleMs: 60_000, note: "测一下" });
  assert.equal(status.armed, true);
  assert.equal(status.state.status, "watching");
  assert.equal(status.state.real, true);
  assert.equal(status.state.idleMs, 60_000);
  await cancelSleepGuard(sdk, "测完了");
});

test("挂上就是真关机，不需要再开什么开关", async () => {
  const sdk = fakeSdk();
  const status = await armSleepGuard(sdk, { idleMs: 60_000 });
  assert.equal(status.state.real, true);
  assert.equal(status.state.dryRun, false);
  assert.equal(status.state.graceMs, 300_000);
  await cancelSleepGuard(sdk, "测完了");
});

test("显式传 dryRun 才演练，留给开发验证用", async () => {
  const sdk = fakeSdk();
  const status = await armSleepGuard(sdk, { idleMs: 60_000, dryRun: true });
  assert.equal(status.state.real, false);
  assert.equal(status.state.dryRun, true);
  await cancelSleepGuard(sdk, "测完了");
});

test("撤掉之后不再守着", async () => {
  const sdk = fakeSdk();
  await armSleepGuard(sdk, { idleMs: 60_000 });
  const result = await cancelSleepGuard(sdk, "手撤");
  assert.equal(result.cancelled, true);
  assert.equal(describeSleepGuard().armed, false);
});

test("静默时长有下限，短到离谱的输入被抬到十秒", async () => {
  const sdk = fakeSdk();
  const status = await armSleepGuard(sdk, { idleMs: 100 });
  assert.equal(status.state.idleMs, 10_000);
  await cancelSleepGuard(sdk, "测完了");
});
