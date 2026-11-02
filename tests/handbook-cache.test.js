import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readCardsCache, resetCardsCacheForTest, writeCardsCache } from "../lib/handbook-cache.js";

function tempSdk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handbook-cache-"));
  return { dataDir: dir, logger: { debug() {} } };
}

const cards = [{ topic: "聊天与对话", kind: "feature", title: "闲聊可以单独挑模型", where: "设置 → 闲聊 → 模型", rank: 4, items: ["v1.5.48-beta:2"] }];

test("写进去能原样读回来", async () => {
  const sdk = tempSdk();
  await writeCardsCache(sdk, "v1.5.48-beta", { cards, publishedAt: "2026-11-01T23:32:45Z", model: "测试模型", promptVersion: 1 });
  const hit = await readCardsCache(sdk, "v1.5.48-beta", { promptVersion: 1 });
  assert.ok(hit);
  assert.equal(hit.cards.length, 1);
  assert.equal(hit.model, "测试模型");
  assert.equal(hit.publishedAt, "2026-11-01T23:32:45Z");
});

test("提示词改版后旧缓存自动失效", async () => {
  const sdk = tempSdk();
  await writeCardsCache(sdk, "v1.5.7-beta", { cards, publishedAt: "2026-10-29T20:33:05Z", model: "m", promptVersion: 1 });
  assert.ok(await readCardsCache(sdk, "v1.5.7-beta", { promptVersion: 1 }));
  assert.equal(await readCardsCache(sdk, "v1.5.7-beta", { promptVersion: 2 }), null);
});

test("没缓存、坏缓存、空卡片都当没有，不让页面炸", async () => {
  const sdk = tempSdk();
  assert.equal(await readCardsCache(sdk, "v1.0.0-beta"), null);
  await writeCardsCache(sdk, "v1.0.0-beta", { cards, publishedAt: "", model: "m", promptVersion: 1 });
  const file = path.join(sdk.dataDir, "handbook-cache", "v1.0.0-beta.json");
  fs.writeFileSync(file, "{ 写到一半", "utf8");
  assert.equal(await readCardsCache(sdk, "v1.0.0-beta"), null);
  // 空卡片不入库：宁可下次重算，也不要留一份「这版什么都没有」的假缓存。
  await writeCardsCache(sdk, "v1.0.1-beta", { cards: [], publishedAt: "", model: "m", promptVersion: 1 });
  assert.equal(fs.existsSync(path.join(sdk.dataDir, "handbook-cache", "v1.0.1-beta.json")), false);
});

test("没有 dataDir 时安静跳过，不抛错", async () => {
  assert.equal(await readCardsCache({}, "v1.5.48-beta"), null);
  await writeCardsCache({}, "v1.5.48-beta", { cards, promptVersion: 1 });
});

test("tag 里的符号不会跑出目录之外", async () => {
  const sdk = tempSdk();
  await writeCardsCache(sdk, "../../escape", { cards, publishedAt: "", model: "m", promptVersion: 1 });
  const dir = path.join(sdk.dataDir, "handbook-cache");
  const names = fs.readdirSync(dir);
  assert.equal(names.length, 1);
  assert.ok(names[0].endsWith(".json"));
  assert.ok(!names[0].includes("/") && !names[0].includes("\\"));
  resetCardsCacheForTest();
});
