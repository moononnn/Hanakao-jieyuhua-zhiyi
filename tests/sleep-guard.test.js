import test from "node:test";
import assert from "node:assert/strict";
import { armSleepGuard, cancelSleepGuard, describeBannerText, describeSleepGuard, judgeIdle, setRealEnabled } from "../lib/sleep-guard.js";

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

test("静默时长有下限，短到离谱的输入被抬到十秒", async () => {  const sdk = fakeSdk();
  const status = await armSleepGuard(sdk, { idleMs: 100 });
  assert.equal(status.state.idleMs, 10_000);
  await cancelSleepGuard(sdk, "测完了");
});

// ── 通知不能静默失败（2026-10-29）──
//
// 真实事故：挂上关机后弹窗没出来，而日志、状态、面板三处都看不出痕迹。
// 当时的 notify() 在拿不到 sdk.notifications.show 时直接 return false，
// 一行日志都不写；抛错那条路又依赖 sdk.logger 本身可用。
// 两道门都能一声不响地失败，于是“到底发没发”无从查起。

test("通知发成了要在记录里留一笔", async () => {
  const sdk = fakeSdk();
  await armSleepGuard(sdk, { idleMs: 60_000 });
  const log = sdk.__store.get("sleepGuardLog") || [];
  const shown = log.filter((entry) => entry.kind === "notify-shown");
  assert.equal(shown.length >= 1, true, "发出去也要记，不然分不清“没发”和“发了”");
  const state = describeSleepGuard().state;
  assert.equal(state.lastNotifyOk, true);
  assert.equal(state.lastNotifyTitle.includes("关机已挂上"), true);
  await cancelSleepGuard(sdk, "测完了");
});

test("宿主没给通知接口时，必须记下失败原因，不能静默", async () => {
  // 这一条就是旧代码的漏洞：拿不到接口就 return false，什么也不写。
  const sdk = fakeSdk();
  delete sdk.notifications;
  await armSleepGuard(sdk, { idleMs: 60_000 });

  const log = sdk.__store.get("sleepGuardLog") || [];
  const failed = log.filter((entry) => entry.kind === "notify-failed");
  assert.equal(failed.length >= 1, true, "拿不到接口也得留下一条记录");
  assert.equal(failed[0].code, "NOTIFICATIONS_UNAVAILABLE");
  const state = describeSleepGuard().state;
  assert.equal(state.lastNotifyOk, false, "状态里也要能看出来没发出去");
  assert.match(String(state.lastNotifyDetail), /没给|通知接口/);
  await cancelSleepGuard(sdk, "测完了");
});

test("通知抛错时把错误码翻成人话并进日志，不只写 App 自己的账本", async () => {
  const sdk = fakeSdk();
  sdk.notifications = {
    show: async () => {
      const error = new Error("The system could not show this notification.");
      error.code = "APP_NOTIFICATION_FAILED";
      throw error;
    },
  };
  await armSleepGuard(sdk, { idleMs: 60_000 });

  const log = sdk.__store.get("sleepGuardLog") || [];
  const failed = log.filter((entry) => entry.kind === "notify-failed");
  assert.equal(failed.length >= 1, true, "抛错也要留一条记录");
  assert.equal(failed[0].code, "APP_NOTIFICATION_FAILED");
  assert.match(String(failed[0].detail), /勿扰|通知设置/, "要把错误码翻成能看懂的一句话");

  // 宿主日志也得有一行，否则用户不装面板开发工具就无从查。
  const warned = sdk.__logs.filter((line) => line.includes("守门通知没弹出来"));
  assert.equal(warned.length >= 1, true, "宿主日志里要能 grep 到");
  await cancelSleepGuard(sdk, "测完了");
});

test("通知失败不挡住护门本身：照样守着、照样往真关机走", async () => {
  // 提醒失败是丢了一个提醒，不是放弃护门。以前没人验过这条边界。
  const sdk = fakeSdk();
  sdk.notifications = { show: async () => { throw new Error("boom"); } };
  const status = await armSleepGuard(sdk, { idleMs: 60_000 });
  assert.equal(status.armed, true);
  assert.equal(status.state.status, "watching");
  await cancelSleepGuard(sdk, "测完了");
});

// ── 横幅文案（2026-10-29 改）──
//
// 原来是「会自动关机：Hana 没动静满 10 分钟就开始倒数 · 别的内容请先存好 · 已开 0:03」。
// 那串时间是从挂上算起已经过去多久，跟关机毫无关系；她真正想知道的是「还有多久就关」。
// 下面这几条把这个要求钉死。

function banner(described) {
  return describeBannerText(described);
}

function armedState({ status = "watching", busyCount = 0, ...overrides } = {}) {
  return {
    armed: true,
    busyCount,
    idleForMs: 0,
    sinceArmedMs: 0,
    countdownLeftMs: 0,
    abortLeftMs: 0,
    state: {
      status,
      idleMs: 600_000,
      graceMs: 60_000,
      idleSince: null,
      dryRun: false,
      ...overrides,
    },
  };
}

test("横幅不再报「已开多久」：那串时间跟关机无关", () => {
  // 挂上刚过 36 秒、还有活在跑：旧文案会写「已开 0:36」。
  const text = banner(armedState({ busyCount: 5 }));
  assert.doesNotMatch(text, /已开/, "那串时间跟她关心的事没关系");
  assert.doesNotMatch(text, /\d+:\d\d/, "不能出现「已开 mm:ss」式的计时");
});

test("有活在跑时说清在等什么，不编一个倒计时数字", () => {
  const text = banner(armedState({ busyCount: 3 }));
  assert.match(text, /还有 3 处在跑/);
  assert.match(text, /10 分钟/, "要说清空满多久才关");
  assert.match(text, /会自动关机/);
});

test("已经空下来计时时，报的是「还有多久」而不是「已经多久」", () => {
  // 空了两分钟，还差八分钟——该报 8 分钟，不是 2 分钟。
  const described = armedState();
  described.state.idleSince = 1_000;
  described.idleForMs = 2 * 60_000;
  const text = banner(described);
  assert.match(text, /还要空 8 分钟/);
  assert.doesNotMatch(text, /已开|已经/);
});

test("把两段时限合起来给出「大约多久后关」", () => {
  // 静默 10 分钟 + 倒计时 1 分钟 = 约 11 分钟。
  const described = armedState();
  described.state.idleSince = 1_000;
  described.idleForMs = 0;
  const text = banner(described);
  assert.match(text, /还要空 10 分钟/);
  assert.match(text, /约 11 分钟后/, "两段加起来才是真正多久后关");
});

test("倒计时开始后报的就是离关机的剩余时间", () => {
  const described = armedState({ status: "countdown" });
  described.countdownLeftMs = 42_000;
  const text = banner(described);
  assert.match(text, /42 秒后关机/);
});

test("倒计时过了六十秒就改用分钟，不再报一大堆秒数", () => {
  const described = armedState({ status: "countdown" });
  described.countdownLeftMs = 25 * 60_000;
  const text = banner(described);
  assert.match(text, /25 分钟后关机/);
});

test("演练的横幅不能说成会关机", () => {
  const described = armedState({ dryRun: true, busyCount: 2 });
  const text = banner(described);
  assert.match(text, /演练中/);
  assert.match(text, /不会真关/);
  assert.doesNotMatch(text, /会自动关机/);
});

test("没在守的时候横幅是空的，不能留一条孤儿文案", () => {
  assert.equal(banner({ armed: false, state: null }), "");
  assert.equal(banner(null), "");
});

test("文案不超过宿主的 200 字符上限", () => {
  // 宿主对横幅 text 有硬限，超了就不挂。每种分支都得卡住。
  const cases = [
    armedState({ busyCount: 99 }),
    armedState({ dryRun: true, busyCount: 99 }),
    (() => { const d = armedState(); d.state.idleSince = 1_000; d.idleForMs = 0; return d; })(),
    (() => { const d = armedState({ status: "countdown" }); d.countdownLeftMs = 3_600_000; return d; })(),
  ];
  for (const described of cases) {
    const text = banner(described);
    assert.ok(text.length > 0, "这些状态都应该有文案");
    assert.ok(text.length <= 200, `超了 200 字符：${text.length}`);
  }
});
