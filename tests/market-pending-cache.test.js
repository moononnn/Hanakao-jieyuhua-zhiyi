import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { flushPendingCache, readPendingCache, resetPendingCacheForTest, writePendingCache } from "../lib/market-pending-cache.js";

function tempSdk() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyi-pending-cache-"));
  return { dataDir };
}

function readFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "market-pending-cache.json"), "utf8"));
}

test("写进去的条目读得回来，落盘后重新加载还在", async (t) => {
  const sdk = tempSdk();
  t.after(() => { resetPendingCacheForTest(); fs.rmSync(sdk.dataDir, { recursive: true, force: true }); });
  const rows = [{ key: "pending:app:alpha:pr7", id: "alpha", version: "0.2.0" }];
  writePendingCache(sdk, "7:c:c:b:b:ready", rows);
  await flushPendingCache(sdk);
  assert.deepEqual(readPendingCache(sdk, "7:c:c:b:b:ready"), rows);

  // 换一个进程内状态，模拟重启后重新读盘。
  resetPendingCacheForTest();
  assert.deepEqual(readPendingCache(sdk, "7:c:c:b:b:ready"), rows);
});

test("扫过但没东西和根本没扫过分开记", async (t) => {
  const sdk = tempSdk();
  t.after(() => { resetPendingCacheForTest(); fs.rmSync(sdk.dataDir, { recursive: true, force: true }); });
  writePendingCache(sdk, "8:head:base:ready", []);
  assert.deepEqual(readPendingCache(sdk, "8:head:base:ready"), [], "空数组表示扫过、没东西");
  assert.equal(readPendingCache(sdk, "9:head:base:ready"), null, "没扫过必须是 null，不能当成没东西");
});

test("文件版本对不上就整批作废", async (t) => {
  const sdk = tempSdk();
  t.after(() => { resetPendingCacheForTest(); fs.rmSync(sdk.dataDir, { recursive: true, force: true }); });
  writePendingCache(sdk, "1:a:b:ready", [{ id: "alpha" }]);
  await flushPendingCache(sdk);
  const file = path.join(sdk.dataDir, "market-pending-cache.json");
  const payload = readFile(sdk.dataDir);
  fs.writeFileSync(file, JSON.stringify({ ...payload, version: 999 }), "utf8");

  resetPendingCacheForTest();
  assert.equal(readPendingCache(sdk, "1:a:b:ready"), null);
});

test("坏文件不影响使用，只当没有缓存", async (t) => {
  const sdk = tempSdk();
  t.after(() => { resetPendingCacheForTest(); fs.rmSync(sdk.dataDir, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(sdk.dataDir, "market-pending-cache.json"), "{ 上半截写坏了", "utf8");
  assert.equal(readPendingCache(sdk, "1:a:b:ready"), null);
  writePendingCache(sdk, "2:a:b:ready", [{ id: "beta" }]);
  await flushPendingCache(sdk);
  assert.deepEqual(readPendingCache(sdk, "2:a:b:ready"), [{ id: "beta" }]);
});

test("条目超上限先丢最旧的", async (t) => {
  const sdk = tempSdk();
  t.after(() => { resetPendingCacheForTest(); fs.rmSync(sdk.dataDir, { recursive: true, force: true }); });
  for (let i = 0; i < 245; i += 1) writePendingCache(sdk, `${i}:a:b:ready`, [{ id: `app${i}` }]);
  await flushPendingCache(sdk);
  assert.equal(readPendingCache(sdk, "0:a:b:ready"), null, "最旧的应该被淘汰");
  assert.deepEqual(readPendingCache(sdk, "244:a:b:ready"), [{ id: "app244" }]);
});

test("宿主没给数据目录时静默降级，不抛错", async () => {
  const sdk = {};
  assert.equal(readPendingCache(sdk, "1:a:b:ready"), null);
  writePendingCache(sdk, "1:a:b:ready", [{ id: "x" }]);
  await flushPendingCache(sdk);
});
