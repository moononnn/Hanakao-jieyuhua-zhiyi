import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeWall, listReleases, loadWall, readHostVersion, readVersionFromHomes, resetHandbookListCacheForTest, sourcesForCard } from "../lib/handbook-service.js";
import { writeCardsCache, resetCardsCacheForTest } from "../lib/handbook-cache.js";
import { CARD_PROMPT_VERSION } from "../lib/handbook-cards.js";
import { parseReleaseBody } from "../lib/handbook-releases.js";

const body = (tag, base) => `# HanaAgent ${tag}

包含自 **${base}** 以来的更新。

## Features · 新功能

### 记忆与闲聊

- **更充足的记忆容量**：扩大今日、近期、长期记忆的整理容量。
- **闲聊独立模型**：在闲聊设置中为闲聊单独选择模型。

## Bug Fixes · 问题修复

- **错误提示保留到能够读完**：不再定时消失。
${"补充说明。".repeat(120)}
`;

const RAW = [
  { tag_name: "v1.5.48-beta", name: "HanaAgent 1.5.48-beta", published_at: "2026-11-01T23:32:45Z", body: body("1.5.48-beta", "v1.5.7-beta") },
  { tag_name: "v1.5.7-beta", name: "HanaAgent 1.5.7-beta", published_at: "2026-10-29T20:33:05Z", body: body("1.5.7-beta", "v1.3.6-beta") },
  { tag_name: "v1.3.6-beta", name: "HanaAgent 1.3.6-beta", published_at: "2026-10-26T12:02:38Z", body: body("1.3.6-beta", "v1.2.1-beta") },
];

function tempSdk() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "handbook-svc-"));
  return {
    dataDir,
    network: { fetch: async () => ({ ok: true, status: 200, json: async () => RAW }) },
    storage: { global: { get: async () => null } },
    models: { list: async () => [] },
    logger: { debug() {} },
  };
}

const card = (title, items) => ({
  topic: "聊天与对话",
  kind: "feature",
  title,
  before: "以前",
  now: "现在",
  why: "对你来说",
  where: "设置 → 闲聊",
  rank: 4,
  hurt: false,
  items,
});

test("本机版本从 server-info.json 读，读不到换落盘文件", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "handbook-home-"));
  assert.equal(readVersionFromHomes([home]), "");
  fs.writeFileSync(path.join(home, "server-info.json"), JSON.stringify({ version: "1.5.48-beta" }), "utf8");
  assert.equal(readVersionFromHomes([home]), "1.5.48-beta");
  fs.rmSync(path.join(home, "server-info.json"));
  fs.writeFileSync(path.join(home, "last-update-version"), "1.5.7-beta\n", "utf8");
  assert.equal(readVersionFromHomes([home]), "1.5.7-beta");
  // 第一个目录什么都没有时接着找第二个。
  assert.equal(readVersionFromHomes([path.join(home, "空"), home]), "1.5.7-beta");
  assert.equal(readHostVersion({}), readHostVersion({}));
});

test("已是最新时给出 upToDate，不硬凑卡片", async () => {
  resetHandbookListCacheForTest();
  const sdk = tempSdk();
  const state = await loadWall(sdk, { installedVersion: "1.5.48-beta" });
  assert.equal(state.upToDate, true);
  assert.equal(state.totalCards, 0);
  assert.equal(state.baseline.version, "1.5.48-beta");
});

test("缓存命中直接用，没命中而模型不可用时只影响那一版", async () => {
  resetHandbookListCacheForTest();
  resetCardsCacheForTest();
  const sdk = tempSdk();
  await writeCardsCache(sdk, "v1.5.48-beta", {
    cards: [card("闲聊可以单独挑模型", ["v1.5.48-beta:2"])],
    publishedAt: "2026-11-01T23:32:45Z",
    model: "缓存模型",
    promptVersion: CARD_PROMPT_VERSION,
  });
  const state = await loadWall(sdk, { installedVersion: "1.3.6-beta" });
  assert.equal(state.upToDate, false);
  assert.equal(state.totalCards, 1);
  const cached = state.versions.find((v) => v.tag === "v1.5.48-beta");
  assert.equal(cached.cached, true);
  // 1.5.7 这版没有缓存，模型调不通：它自己带 error，另一版照样出墙。
  const failed = state.versions.find((v) => v.tag === "v1.5.7-beta");
  assert.equal(failed.cardCount, 0);
  assert.ok(failed.error);
  // 最新一版的卡片单独摆一块（本版速览），墙留给更早的版本。
  assert.equal(state.overview.cards.length, 1);
  assert.equal(state.overview.version, "1.5.48-beta");
  assert.equal(state.wall.highlights.length, 0);
  assert.equal(state.wall.rest.length, 0);
});

test("墙面数据带版本来源，能说清从哪版来的", async () => {
  resetHandbookListCacheForTest();
  resetCardsCacheForTest();
  const sdk = tempSdk();
  await writeCardsCache(sdk, "v1.5.48-beta", {
    cards: [card("闲聊可以单独挑模型", ["v1.5.48-beta:2"])],
    publishedAt: "2026-11-01T23:32:45Z",
    model: "缓存模型",
    promptVersion: CARD_PROMPT_VERSION,
  });
  const state = await loadWall(sdk, { installedVersion: "1.3.6-beta" });
  const hit = state.overview.cards[0];
  assert.equal(hit.tag, "v1.5.48-beta");
  assert.equal(hit.version, "1.5.48-beta");
  assert.equal(hit.publishedAt, "2026-11-01T23:32:45Z");
});

test("追问只取这张卡引用的条目", async () => {
  resetHandbookListCacheForTest();
  const sdk = tempSdk();
  await listReleases(sdk);
  const rows = await sourcesForCard(sdk, { tag: "v1.5.48-beta", items: ["v1.5.48-beta:2"] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "闲聊独立模型");
  assert.equal(rows[0].id, "v1.5.48-beta:2");
  assert.deepEqual(await sourcesForCard(sdk, { tag: "不存在", items: ["x"] }), []);
});

test("状态句说事实，不说套话", async () => {
  resetHandbookListCacheForTest();
  resetCardsCacheForTest();
  const sdk = tempSdk();
  await writeCardsCache(sdk, "v1.5.48-beta", {
    cards: [card("闲聊可以单独挑模型", ["v1.5.48-beta:2"])],
    publishedAt: "2026-11-01T23:32:45Z",
    model: "缓存模型",
    promptVersion: CARD_PROMPT_VERSION,
  });
  const state = await loadWall(sdk, { installedVersion: "1.5.7-beta" });
  assert.match(describeWall(state), /1\.5\.48-beta/);
  assert.match(describeWall(state), /挑出 1 条/);
  assert.equal(describeWall(null), "");
});

test("条目 id 与解析层对得上：卡片能翻回原文", () => {
  const parsed = parseReleaseBody(body("1.5.48-beta", "v1.5.7-beta"), { tag: "v1.5.48-beta" });
  const ids = parsed.sections.flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.id)));
  assert.deepEqual(ids, ["v1.5.48-beta:1", "v1.5.48-beta:2", "v1.5.48-beta:3"]);
});
