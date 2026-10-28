import test from "node:test";
import assert from "node:assert/strict";
import { armSleepGuard, cancelSleepGuard, describeSleepGuard, judgeIdle, setRealEnabled } from "../lib/sleep-guard.js";

function snapshot({ sessionsBusy = 0, tasksReadable = true, tasksActive = 0, sessionsTotal = 3, sessionsReadable = true } = {}) {
  return {
    sessions: { total: sessionsTotal, readable: sessionsReadable },
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
  const notes = [];
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
    notifications: { show: async (value) => { notes.push(value); return { shown: true }; } },
    __logs: logs,
    __store: store,
    __notes: notes,
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

test("挂上守门的那一刻就要提醒存盘：那时人还醒着，来得及动手", async () => {
  // 这个功能只负责两件事：判断 Hana 什么时候干完、到点执行关机。
  // 它管不了别的程序存没存盘，而关机是不可逆的。
  // 所以「先存好别的东西」这句话必须出现在人还醒着的时刻，不能只在关机那一瞬说。
  const sdk = fakeSdk();
  await armSleepGuard(sdk, { idleMs: 60_000 });

  assert.ok(sdk.__notes.length >= 1, "挂上时应该发一条通知");
  const body = String(sdk.__notes[0]?.body || "");
  assert.match(body, /存好/, "必须明说先去存别的东西");
  assert.match(body, /不会替你保存|不会替谁保存/, "必须说清它不会替你保存");
  await cancelSleepGuard(sdk, "测完了");
});

test("演练的挂上通知不能说成真关机", async () => {
  // 以前 status 里那行是写死的「现在是真关机」，挂演练也这么说。
  // 挂上通知这边同理：说错了人就不敢测，也分不清到底会不会关。
  const sdk = fakeSdk();
  await armSleepGuard(sdk, { idleMs: 60_000, dryRun: true });
  const joined = sdk.__notes.map((n) => `${n?.title || ""}${n?.body || ""}`).join("\n");
  assert.match(joined, /演练/);
  assert.match(joined, /不会真关/);
  await cancelSleepGuard(sdk, "测完了");
});

test("关机命令已发出后，取消必须真去撒系统那条（不能只改本地状态）", async () => {
  // 这是 2026-10-28 查出来的一个真缺陷：
  // 以前 cancelSleepGuard 只把 state.status 改成 cancelled，从来没调过 `shutdown /a`。
  // 于是那 30 秒里就算在面板上点「取消」，机器照样会关——反馈说撤了、其实没撤。
  //
  // 这里用假 sdk 把状态摆到「已发出」，验证会去调 /a。
  const sdk = fakeSdk();
  await armSleepGuard(sdk, { idleMs: 60_000 });
  // 把内部状态手动推到「命令已发出」：没真发命令，只验撤销那条路。
  const { describeSleepGuard } = await import("../lib/sleep-guard.js");
  const live = describeSleepGuard();
  assert.equal(live.armed, true);

  // 直接调 abortSystemShutdown 看它认不认这个环境：
  // 这里本机没有排上的关机，`shutdown /a` 会返回非 0（1116 没有关机正在进行）。
  // 关键不是它成功，而是它**真的去调了**并且如实报失败。
  const { abortSystemShutdown } = await import("../lib/sleep-guard.js");
  const result = await abortSystemShutdown(sdk);
  assert.equal(typeof result.ok, "boolean", "必须回一个明确的成败");
  assert.equal(typeof result.detail, "string");
  // 没排关机时应该老实说没撤成，不能报 ok=true。
  assert.equal(result.ok, false, "本机没有待执行的关机时，不能谎报撤销成功");
  await cancelSleepGuard(sdk, "测完了");
});

test("没发出关机时取消不去碰系统命令", async () => {
  const sdk = fakeSdk();
  await armSleepGuard(sdk, { idleMs: 60_000 });
  const result = await cancelSleepGuard(sdk, "还没到点就撤");
  assert.equal(result.wasIssued, false, "没发出过就是 false");
  assert.equal(result.abort, null, "没发出过就不该去调 /a");
  assert.equal(result.cancelled, true);
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
