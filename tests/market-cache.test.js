import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCatalogCache, resetCatalogCacheForTest, writeCatalogCache } from "../lib/market-cache.js";

const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
const payload = {
  index: { schemaVersion: 2, items: [{ kind: "app", id: "alpha", name: "甲" }] },
  registry: { schemaVersion: 1, entries: [{ kind: "app", id: "alpha", repository: "o/alpha" }] },
  approvals: { schemaVersion: 1, approvals: [{ kind: "app", id: "alpha", tag: "v1.0.0", sha256: "c".repeat(64) }] },
};

function tempSdk() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyi-catalog-cache-"));
  return { dataDir };
}

test("同一个 commit 写进去的目录读得回来", async (t) => {
  const sdk = tempSdk();
  t.after(() => { resetCatalogCacheForTest(); fs.rmSync(sdk.dataDir, { recursive: true, force: true }); });
  await writeCatalogCache(sdk, COMMIT, payload);
  assert.deepEqual(await readCatalogCache(sdk, COMMIT), payload);
});

test("别的 commit 不命中，免得拿旧目录冒充新目录", async (t) => {
  const sdk = tempSdk();
  t.after(() => { resetCatalogCacheForTest(); fs.rmSync(sdk.dataDir, { recursive: true, force: true }); });
  await writeCatalogCache(sdk, COMMIT, payload);
  assert.equal(await readCatalogCache(sdk, OTHER), null);
});

test("三份文件缺一份就当没缓存", async (t) => {
  const sdk = tempSdk();
  t.after(() => { resetCatalogCacheForTest(); fs.rmSync(sdk.dataDir, { recursive: true, force: true }); });
  await writeCatalogCache(sdk, COMMIT, payload);
  fs.rmSync(path.join(sdk.dataDir, "market-cache", "approvals.json"));
  assert.equal(await readCatalogCache(sdk, COMMIT), null);
});

test("坏 JSON 当没缓存，不抛错", async (t) => {
  const sdk = tempSdk();
  t.after(() => { resetCatalogCacheForTest(); fs.rmSync(sdk.dataDir, { recursive: true, force: true }); });
  await writeCatalogCache(sdk, COMMIT, payload);
  fs.writeFileSync(path.join(sdk.dataDir, "market-cache", "index.v2.json"), "{\"items\":[", "utf8");
  assert.equal(await readCatalogCache(sdk, COMMIT), null);
});

test("元数据版本对不上就整批作废", async (t) => {
  const sdk = tempSdk();
  t.after(() => { resetCatalogCacheForTest(); fs.rmSync(sdk.dataDir, { recursive: true, force: true }); });
  await writeCatalogCache(sdk, COMMIT, payload);
  const metaFile = path.join(sdk.dataDir, "market-cache", "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
  fs.writeFileSync(metaFile, JSON.stringify({ ...meta, version: 999 }), "utf8");
  assert.equal(await readCatalogCache(sdk, COMMIT), null);
});

test("写新的会把旧 commit 顶掉，不留第二份大文件", async (t) => {
  const sdk = tempSdk();
  t.after(() => { resetCatalogCacheForTest(); fs.rmSync(sdk.dataDir, { recursive: true, force: true }); });
  await writeCatalogCache(sdk, COMMIT, payload);
  await writeCatalogCache(sdk, OTHER, { ...payload, index: { schemaVersion: 2, items: [] } });
  assert.equal(await readCatalogCache(sdk, COMMIT), null);
  const next = await readCatalogCache(sdk, OTHER);
  assert.deepEqual(next.index.items, []);
  const files = fs.readdirSync(path.join(sdk.dataDir, "market-cache")).sort();
  assert.deepEqual(files, ["approvals.json", "index.v2.json", "meta.json", "registry.json"], "不留临时文件");
});

test("宿主没给数据目录时静默降级", async () => {
  assert.equal(await readCatalogCache({}, COMMIT), null);
  await writeCatalogCache({}, COMMIT, payload);
});
