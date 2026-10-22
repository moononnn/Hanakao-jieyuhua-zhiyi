import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createBallManager } from "../lib/ball.js";

class FakeChild extends EventEmitter {
  constructor(killDelayMs = 0) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.killed = false;
    this.killDelayMs = killDelayMs;
  }

  kill() {
    if (this.killed) return true;
    this.killed = true;
    setTimeout(() => {
      this.exitCode = 0;
      this.stdin.end();
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", 0, null);
    }, this.killDelayMs);
    return true;
  }
}

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function createHarness(fetch, {
  killDelayMs = 0,
  environment,
  resolveExecutable,
  startupTimeoutMs,
  announceReady = true,
  startupOutput,
  pyQtAvailable = true,
  onStarted,
  onExited,
} = {}) {
  const spawned = [];
  const sdk = {
    dataDir: "C:/hanako/app-data/jiegehua-zhiyi",
    logger: {},
    process: {
      resolveExecutable: resolveExecutable || (async () => ({ path: "C:/Python/python.exe", size: 1, mtimeMs: 1 })),
    },
    network: { fetch },
  };
  const manager = createBallManager({
    sdk,
    appRoot: "C:/hanako/apps/jiegehua-zhiyi",
    environment: environment || {
      PATH: "C:/Python",
      HOME: "C:/unreliable-home",
      USERPROFILE: "C:/Users/test",
      APPDATA: "C:/must-not-forward",
      TMPDIR: "C:/Temp",
      LANG: "zh_CN.UTF-8",
      HANA_LOCALE_DIR: "C:/hanako/locales",
      SystemRoot: "C:/Windows",
      WINDIR: "C:/Windows",
      PRIVATE_KEY: "do-not-forward",
    },
    startupTimeoutMs,
    onStarted,
    onExited,
    spawn: (command, args, options) => {
      const child = new FakeChild(killDelayMs);
      const scriptPath = path.join("C:/hanako/apps/jiegehua-zhiyi", "python", "zhujian_app.py");
      if (args.at(-1) !== scriptPath) {
        setImmediate(() => {
          if (args[0] === "-0p") child.stdout.write(" -V:3.14 * C:\\Python\\python.exe\n");
          const code = args[0] === "-c" && !pyQtAvailable ? 1 : 0;
          child.exitCode = code;
          child.stdout.end();
          child.stderr.end();
          child.emit("exit", code, null);
        });
        return child;
      }
      spawned.push({ child, command, args, options });
      if (startupOutput !== undefined) {
        setImmediate(() => child.stdout.write(startupOutput));
      } else if (announceReady) {
        setImmediate(() => child.stdout.write(JSON.stringify({
          type: "zhiyi-ball-ready",
          baseUrl: "http://127.0.0.1:48123",
          token: "x".repeat(48),
        }) + "\n"));
      }
      return child;
    },
  });
  return { manager, spawned, sdk };
}

const ask = {
  title: "选择迁移方式",
  question: "采用哪种方式？",
  displayQuestion: "采用哪种方式？\n\n背景：保留原界面。",
  background: "保留原界面。",
  recommendation: "直接迁移",
  reason: "能复用现有体验。",
  options: [
    { label: "直接迁移", detail: "保留旧界面" },
    { label: "重写界面", detail: "使用 App 原生 UI" },
  ],
};

test("starts the copied ball with App-owned data and waits for its ready handshake", async () => {
  const { manager, spawned } = createHarness(async () => response({ ok: true }));
  const result = await manager.start();
  assert.equal(result.ok, true);
  assert.equal(result.running, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "C:/Python/python.exe");
  assert.equal(spawned[0].args.at(-1), path.join("C:/hanako/apps/jiegehua-zhiyi", "python", "zhujian_app.py"));
  assert.equal(spawned[0].options.env.ZHIYI_APP_DATA_DIR, "C:/hanako/app-data/jiegehua-zhiyi");
  assert.equal(spawned[0].options.env.ZHIYI_APP_MODE, "ask-only");
  assert.equal(spawned[0].options.env.PATH, "C:/Python");
  assert.equal(spawned[0].options.env.HOME, "C:/unreliable-home");
  assert.equal(spawned[0].options.env.APPDATA, "C:\\Users\\test\\AppData\\Roaming");
  assert.equal(spawned[0].options.env.USERPROFILE, undefined);
  assert.equal(spawned[0].options.env.TMPDIR, "C:/Temp");
  assert.equal(spawned[0].options.env.LANG, "zh_CN.UTF-8");
  assert.equal(spawned[0].options.env.HANA_LOCALE_DIR, undefined);
  assert.equal(spawned[0].options.env.SystemRoot, undefined);
  assert.equal(spawned[0].options.env.WINDIR, undefined);
  assert.equal(spawned[0].options.env.PRIVATE_KEY, undefined);
  assert.deepEqual(spawned[0].options.stdio, ["pipe", "pipe", "pipe"]);
  await manager.stop();
  assert.equal(manager.state().running, false);
});

test("selects a Windows Python launcher interpreter that can import PyQt6", async () => {
  const expectedCandidates = process.platform === "win32"
    ? ["C:\\Windows\\py.exe", "py.exe", "python.exe", "python3.exe", "python"]
    : ["python3", "python"];
  const { manager, spawned } = createHarness(async () => response({ ok: true }), {
    resolveExecutable: async ({ candidates }) => {
      assert.deepEqual(candidates, expectedCandidates);
      return { path: "C:/Windows/py.exe", size: 1, mtimeMs: 1 };
    },
  });
  const result = await manager.start();
  assert.equal(result.ok, true);
  assert.equal(spawned[0].command, "C:\\Python\\python.exe");
  assert.deepEqual(spawned[0].args, [path.join("C:/hanako/apps/jiegehua-zhiyi", "python", "zhujian_app.py")]);
  await manager.stop();
});

test("reports checked interpreters instead of launching one without PyQt6", async () => {
  const { manager, spawned } = createHarness(async () => response({ ok: true }), {
    pyQtAvailable: false,
    resolveExecutable: async () => ({ path: "C:/Windows/py.exe", size: 1, mtimeMs: 1 }),
  });
  const result = await manager.start();
  assert.equal(result.ok, false);
  assert.ok(result.error.includes("C:\\Python\\python.exe"));
  assert.equal(spawned.length, 0);
});

test("serializes stop then start and keeps the new child managed", async () => {
  const { manager, spawned } = createHarness(async () => response({ ok: true }), { killDelayMs: 25 });
  await manager.start();
  const firstChild = spawned[0].child;
  const stopPromise = manager.stop();
  const startPromise = manager.start();
  const stopped = await stopPromise;
  assert.equal(stopped.running, false);
  const started = await startPromise;
  assert.equal(started.running, true);
  assert.equal(spawned.length, 2);
  assert.equal(manager.state().running, true);
  assert.notEqual(spawned[1].child, firstChild);
  await manager.stop();
});

test("stop during Python discovery cancels startup before spawning", async () => {
  let finishLookup;
  const { manager, spawned } = createHarness(async () => response({ ok: true }), {
    resolveExecutable: () => new Promise((resolve) => { finishLookup = resolve; }),
  });
  const startPromise = manager.start();
  while (!finishLookup) await new Promise((resolve) => setImmediate(resolve));
  const stopPromise = manager.stop();
  finishLookup({ path: "C:/Python/python.exe", size: 1, mtimeMs: 1 });
  const startResult = await startPromise;
  await stopPromise;
  assert.equal(startResult.ok, false);
  assert.match(startResult.error, /取消/);
  assert.equal(spawned.length, 0);
  assert.equal(manager.state().running, false);
});

test("a stopping marker in the same stdout batch prevents a late ready handshake from reviving the bridge", async () => {
  const fetchCalls = [];
  const output = `${JSON.stringify({
    type: "zhiyi-ball-ready",
    baseUrl: "http://127.0.0.1:48123",
    token: "x".repeat(48),
  })}\n${JSON.stringify({ type: "zhiyi-ball-stopping" })}\n`;
  const { manager, spawned } = createHarness(async (url) => {
    fetchCalls.push(url);
    return response({ ok: true });
  }, { startupOutput: output });
  const started = await manager.start();
  assert.equal(started.ok, false);
  assert.equal(started.running, true);
  assert.equal(started.stopping, true);
  assert.equal(spawned.length, 1);
  assert.equal(await manager.enqueueAsk(ask), null);
  assert.deepEqual(fetchCalls, []);
  await manager.stop();
});

test("startup timeout keeps the exiting child managed and blocks duplicate spawn", async () => {
  const { manager, spawned } = createHarness(async () => response({ ok: true }), {
    killDelayMs: 25,
    startupTimeoutMs: 10,
    announceReady: false,
  });
  const failed = await manager.start();
  assert.equal(failed.ok, false);
  assert.equal(failed.running, true);
  assert.equal(failed.stopping, true);
  assert.equal(manager.state().running, true);
  const retry = await manager.start();
  assert.equal(retry.ok, false);
  assert.equal(spawned.length, 1);
  const child = spawned[0].child;
  if (child.exitCode == null) await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(manager.state().running, false);
  assert.match(manager.state().error, /超时/);
});

test("sends the question to the ball and returns an id without waiting for an answer", async () => {
  let posted;
  const { manager } = createHarness(async (url, init) => {
    const parsed = new URL(url);
    assert.equal(init.headers["X-Zhiyi-Token"], "x".repeat(48));
    if (parsed.pathname === "/ask/enqueue") {
      posted = JSON.parse(init.body);
      return response({ ok: true, askId: posted.askId });
    }
    throw new Error(`unexpected route: ${parsed.pathname}`);
  });
  await manager.start();
  const sent = await manager.enqueueAsk(ask, { sessionId: "sess_abc", sessionTitle: "来源对话标题", agentName: "测试伙伴" });
  assert.equal(posted.question, ask.question);
  assert.equal(posted.background, ask.background);
  assert.equal(posted.recommendation, ask.recommendation);
  assert.equal(posted.reason, ask.reason);
  assert.deepEqual(posted.options, ask.options);
  assert.equal(posted.sessionId, "sess_abc", "回传地址要随题一起上桥，重载后才认得回来");
  assert.equal(posted.sessionTitle, "来源对话标题");
  assert.equal(posted.agentName, "测试伙伴");
  assert.equal(posted.title, ask.title, "题名与来源标题各自保留");
  assert.equal(sent.askId, posted.askId);
  await manager.stop();
});

test("forwards multiple-selection mode and reads the ball selection array back", async () => {
  let posted;
  const { manager } = createHarness(async (url, init) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/ask/enqueue") {
      posted = JSON.parse(init.body);
      return response({ ok: true, askId: posted.askId });
    }
    if (parsed.pathname === "/ask/result") {
      return response({ ok: true, status: "answered", answer: { action: "confirmed", value: { choice: ["直接迁移", "重写界面"] } } });
    }
    throw new Error(`unexpected route: ${parsed.pathname}`);
  });
  await manager.start();
  const sent = await manager.enqueueAsk({ ...ask, selectionMode: "multiple", minSelections: 1, maxSelections: 2 });
  assert.equal(posted.selectionMode, "multiple");
  assert.equal(posted.minSelections, 1);
  assert.equal(posted.maxSelections, 2);
  const result = await manager.readAskResult(sent.askId);
  assert.deepEqual(result.answer.value.choice, ["直接迁移", "重写界面"]);
  await manager.stop();
});

test("reads pending first, then the answer once the user picks", async () => {
  let answered = false;
  const { manager } = createHarness(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/ask/enqueue") return response({ ok: true, askId: "accepted" });
    if (parsed.pathname === "/ask/result") {
      return answered
        ? response({ ok: true, status: "answered", answer: { action: "confirmed", value: { choice: "直接迁移" } } })
        : response({ ok: true, status: "pending" });
    }
    throw new Error(`unexpected route: ${parsed.pathname}`);
  });
  await manager.start();
  const sent = await manager.enqueueAsk(ask);
  assert.equal((await manager.readAskResult(sent.askId)).status, "pending");
  answered = true;
  const result = await manager.readAskResult(sent.askId);
  assert.equal(result.status, "answered");
  assert.deepEqual(result.answer, { action: "confirmed", value: { choice: "直接迁移" } });
  await manager.stop();
});

test("closing the ball turns a pending question into aborted, never consent", async () => {
  const { manager } = createHarness(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/ask/enqueue") return response({ ok: true, askId: "accepted" });
    if (parsed.pathname === "/ask/result") return response({ ok: true, status: "pending" });
    throw new Error(`unexpected route: ${parsed.pathname}`);
  });
  await manager.start();
  const sent = await manager.enqueueAsk(ask);
  assert.ok(sent.askId);
  assert.equal((await manager.readAskResult(sent.askId)).status, "pending");
  await manager.stop();
  assert.equal((await manager.readAskResult(sent.askId)).status, "aborted");
});

test("direct PyQt close handshake also turns a pending question into aborted", async () => {
  const { manager, spawned } = createHarness((url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/ask/enqueue") return Promise.resolve(response({ ok: true, askId: "accepted" }));
    if (parsed.pathname === "/ask/result") return Promise.resolve(response({ ok: true, status: "pending" }));
    throw new Error(`unexpected route: ${parsed.pathname}`);
  });
  await manager.start();
  const sent = await manager.enqueueAsk(ask);
  const child = spawned[0].child;
  let receivedAck = "";
  const ackSeen = new Promise((resolve) => {
    child.stdin.once("data", (chunk) => {
      receivedAck = String(chunk);
      resolve();
    });
  });
  child.stdout.write(JSON.stringify({ type: "zhiyi-ball-stopping" }) + "\n");
  await ackSeen;
  assert.equal(receivedAck, "zhiyi-ball-stopping-ack\n");
  assert.equal(manager.state().running, true);
  assert.equal(manager.state().stopping, true);
  // 球正在退出，不再向它要答案；这一轮按中止处理，不当成同意。
  assert.equal((await manager.readAskResult(sent.askId)).status, "aborted");
  await manager.stop();
});

test("a bridge transport error while the ball is alive stays a failure, not consent", async () => {
  const { manager } = createHarness(async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/ask/enqueue") return response({ ok: true, askId: "accepted" });
    if (parsed.pathname === "/ask/result") throw new Error("temporary bridge failure");
    throw new Error(`unexpected route: ${parsed.pathname}`);
  });
  await manager.start();
  const sent = await manager.enqueueAsk(ask);
  await assert.rejects(manager.readAskResult(sent.askId), /temporary bridge failure/);
  assert.equal(manager.state().running, true);
  await manager.stop();
});

test("a busy ball is reported as busy so the pending question is not overwritten", async () => {
  const { manager } = createHarness(async () => response({ ok: false, error: "busy" }, 409));
  await manager.start();
  assert.deepEqual(await manager.enqueueAsk(ask), { busy: true });
  await manager.stop();
});

test("missing process permission fails closed with a readable status", async () => {
  const restricted = createBallManager({
    sdk: {
      dataDir: "C:/data",
      process: { resolveExecutable: async () => { throw Object.assign(new Error("denied"), { code: "APP_CAPABILITY_DENIED" }); } },
      network: { fetch: async () => response({ ok: true }) },
    },
    appRoot: "C:/app",
    spawn: () => { throw new Error("must not spawn"); },
  });
  const result = await restricted.start();
  assert.equal(result.ok, false);
  assert.match(result.error, /外部进程启动/);
  assert.equal(restricted.state().running, false);
});

test("球启动成功会通知上层：用来记住用户希望它开着", async () => {
  const started = [];
  const { manager } = createHarness(async () => response({ ok: true }), {
    onStarted: (info) => started.push(info),
  });
  await manager.start();
  assert.equal(started.length, 1, "启动成功必须回调，否则 App 重载后不知道该不该把球恢复回来");
  await manager.stop();
});

test("球退出时分得清三种情况：用户关、App 卸载、意外", async () => {
  const exits = [];
  const { manager, spawned } = createHarness(async () => response({ ok: true }), {
    onExited: (info) => exits.push(info),
  });

  // 一、用户亲手关：要把「不再自动恢复」的意图传出去。
  await manager.start();
  await manager.stop();
  assert.equal(exits.at(-1).intentional, "user");

  // 二、App 卸载/重载：球也得停，但这不代表用户不想让它开着。
  await manager.start();
  await manager.stop({ forShutdown: true });
  assert.equal(exits.at(-1).intentional, "shutdown");

  // 三、进程自己没了：这才是需要自动重启的那种。
  await manager.start();
  const child = spawned.at(-1).child;
  child.exitCode = 9;
  child.emit("exit", 9, null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exits.at(-1).intentional, "unexpected");
  assert.equal(exits.at(-1).code, 9);
});
