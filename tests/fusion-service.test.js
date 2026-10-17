import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FUSION_METHOD, ballSnapshotFrom, registerFusionService } from "../lib/fusion-service.js";

function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zhiyi-fusion-${name}-`));
  return dir;
}

test("球在跑时快照带上坐标、面板与桥地址", () => {
  const dir = tempDir("running");
  fs.writeFileSync(path.join(dir, "zhujian-state.json"), JSON.stringify({ x: 1284, y: 471, fusionPanel: "menu" }));
  fs.writeFileSync(path.join(dir, "ball-bridge.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:51234", token: "t".repeat(40) }));
  const snap = ballSnapshotFrom(dir, { running: true });
  assert.equal(snap.running, true);
  assert.deepEqual(snap.position, { x: 1284, y: 471, width: 80, height: 80 });
  assert.equal(snap.panel, "menu");
  assert.equal(snap.proxy.baseUrl, "http://127.0.0.1:51234");
  assert.equal(snap.proxy.token.length, 40);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("球停了就不报坐标，避免拿一具尸体去算重叠", () => {
  const dir = tempDir("stopped");
  fs.writeFileSync(path.join(dir, "zhujian-state.json"), JSON.stringify({ x: 10, y: 20 }));
  fs.writeFileSync(path.join(dir, "ball-bridge.json"), JSON.stringify({ baseUrl: "http://127.0.0.1:1", token: "t".repeat(40) }));
  const snap = ballSnapshotFrom(dir, { running: false });
  assert.equal(snap.running, false);
  assert.equal(snap.position, null);
  assert.equal(snap.proxy, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("缺文件或坏数据只降级，不抛", () => {
  const dir = tempDir("broken");
  fs.writeFileSync(path.join(dir, "zhujian-state.json"), "{ 不是 json");
  assert.doesNotThrow(() => ballSnapshotFrom(dir, { running: true }));
  assert.equal(ballSnapshotFrom("", { running: true }).position, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("服务注册成 fusion 并声明 allowCrossApp，快照/启停都转给球管理器", async () => {
  const registered = [];
  const calls = [];
  const sdk = {
    dataDir: "C:/nowhere",
    logger: { info() {}, warn() {} },
    bus: {
      async handle(method, handler, options) {
        registered.push({ method, options });
        return async (payload) => handler(payload, {});
      },
    },
  };
  const ball = {
    state: () => ({ running: false }),
    async stop() { calls.push("stop"); return { ok: true }; },
    async start() { calls.push("start"); return { ok: true, running: true }; },
  };
  const dispose = await registerFusionService({ sdk, ball });
  assert.deepEqual(registered[0].method, FUSION_METHOD);
  assert.equal(registered[0].options.allowCrossApp, true);

  assert.equal((await dispose({ action: "stop" })).ok, true);
  assert.equal((await dispose({ action: "start" })).running, true);
  assert.equal((await dispose({ action: "snapshot" })).ok, true);
  assert.equal((await dispose({ action: "瞎写" })).ok, false);
  assert.deepEqual(calls, ["stop", "start"]);
});

test("没有 bus.handle 或被宿主拒绝时静默单侧，不抛", async () => {
  const warns = [];
  const sdkNoBus = { dataDir: "C:/x", logger: { warn: (m) => warns.push(m) } };
  assert.equal(await registerFusionService({ sdk: sdkNoBus, ball: {} }), null);

  const sdkDenied = {
    dataDir: "C:/x",
    logger: { info() {}, warn: (m) => warns.push(m) },
    bus: { handle: async () => { throw new Error("缺少 app/services.provide"); } },
  };
  assert.equal(await registerFusionService({ sdk: sdkDenied, ball: {} }), null);
  assert.equal(warns.length, 2);
  assert.match(warns[1], /app\/services\.provide/);
});
