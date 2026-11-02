import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CARDS_PER_RELEASE,
  buildCardMaterials,
  mergeCardPools,
  parseCards,
  rankCards,
  splitHighlights,
} from "../lib/handbook-cards.js";

// 一个缩小的 release：结构跟 parseReleaseBody 的输出一致，测的是卡片层的校验与合并。
const release = {
  tag: "v1.5.48-beta",
  version: "1.5.48-beta",
  publishedAt: "2026-11-01T23:32:45Z",
  baseVersion: "1.5.7-beta",
  intro: "包含自 v1.5.7-beta 以来的更新。",
  sections: [
    {
      key: "features",
      title: "Features · 新功能与改进",
      groups: [
        {
          name: "记忆与闲聊",
          items: [
            { id: "v1.5.48-beta:1", title: "更充足的记忆容量", detail: "扩大今日、近期、长期记忆的整理容量。" },
            { id: "v1.5.48-beta:2", title: "闲聊独立模型", detail: "在闲聊设置中为闲聊单独选择模型。" },
          ],
        },
      ],
    },
    {
      key: "fixes",
      title: "Bug Fixes · 问题修复",
      groups: [{ name: "", items: [{ id: "v1.5.48-beta:3", title: "错误提示保留到能够读完", detail: "不再定时消失。" }] }],
    },
  ],
  upgradeNotes: [{ title: "旧版回退限制", detail: "数据版本从 2 提升到 3。" }],
};

const card = (over = {}) => ({
  topic: "聊天与对话",
  kind: "feature",
  title: "闲聊可以单独挑模型",
  before: "闲聊和正经聊天共用一个模型",
  now: "能在设置里分开挑",
  why: "想省钱又不想让闲聊变呆就靠它",
  where: "设置 → 闲聊 → 模型",
  rank: 4,
  hurt: false,
  items: ["v1.5.48-beta:2"],
  ...over,
});

test("材料里带条目 id，卡片才指得回原文", () => {
  const text = buildCardMaterials(release);
  assert.match(text, /v1\.5\.48-beta:1 \| 更充足的记忆容量/);
  assert.match(text, /官方升级提示/);
  assert.match(text, /上一版 1\.5\.7-beta/);
});

test("正常回包直接通过", () => {
  const cards = parseCards(JSON.stringify([card()]), { release });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, "闲聊可以单独挑模型");
  assert.equal(cards[0].rank, 4);
});

test("模型加围栏或前言也读得出来", () => {
  const body = "好的，这是卡片：\n```json\n" + JSON.stringify([card()]) + "\n```";
  assert.equal(parseCards(body, { release }).length, 1);
  assert.equal(parseCards(`前言\n${JSON.stringify([card()])}\n后记`, { release }).length, 1);
});

test("完全读不懂就报错，不返回空墙假装成功", () => {
  assert.throws(() => parseCards("模型这次只说了句抱歉", { release }), /没给出/);
  assert.throws(() => parseCards("", { release }), /没给出/);
});

test("说不出在哪儿碰到的卡丢掉", () => {
  const rows = [card(), card({ title: "内部更稳了", where: "" })];
  const cards = parseCards(JSON.stringify(rows), { release });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, "闲聊可以单独挑模型");
});

test("指向不存在条目的卡丢掉，指回原文才留下", () => {
  const rows = [card({ items: ["v9.9.9:99"] }), card({ title: "报错能读完", items: ["v1.5.48-beta:3"] })];
  const cards = parseCards(JSON.stringify(rows), { release });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].items[0], "v1.5.48-beta:3");
});

test("越界字段被夹回来，不会原样进页面", () => {
  const rows = [card({ topic: "随便写写", rank: 9, title: "很长的标题".repeat(8) })];
  const cards = parseCards(JSON.stringify(rows), { release });
  assert.equal(cards[0].topic, "其他");
  assert.equal(cards[0].rank, 5);
  assert.ok(cards[0].title.length <= 24);
});

test("同一版里重复的卡只留一张，数量按上限封顶", () => {
  const rows = [card(), card()];
  assert.equal(parseCards(JSON.stringify(rows), { release }).length, 1);

  const many = Array.from({ length: 20 }, (_, i) => card({ title: `第${i}条`, items: ["v1.5.48-beta:1"] }));
  assert.equal(parseCards(JSON.stringify(many), { release }).length, MAX_CARDS_PER_RELEASE);
});

test("跨版本合并不重复摆同一件事，旧版本记进 mergedFrom", () => {
  const pools = [
    { tag: "v1.5.7-beta", version: "1.5.7-beta", publishedAt: "2026-10-29T20:33:05Z", cards: [card({ title: "闲聊可以单独挑模型", rank: 3 })] },
    { tag: "v1.5.48-beta", version: "1.5.48-beta", publishedAt: "2026-11-01T23:32:45Z", cards: [card({ title: "闲聊可以单独挑模型", rank: 4 })] },
  ];
  const wall = mergeCardPools(pools);
  assert.equal(wall.length, 1);
  assert.equal(wall[0].version, "1.5.48-beta");
  assert.deepEqual(wall[0].mergedFrom, ["1.5.7-beta"]);
});

test("主题不同就算标题像也各留一张", () => {
  const pools = [
    { tag: "a", version: "1.0.0", publishedAt: "2026-10-01T00:00:00Z", cards: [card({ topic: "Code 与工具" })] },
    { tag: "b", version: "1.0.1", publishedAt: "2026-10-02T00:00:00Z", cards: [card({ topic: "聊天与对话" })] },
  ];
  assert.equal(mergeCardPools(pools).length, 2);
});

test("排序先看感知度，再看是不是修了会烦人的毛病", () => {
  const wall = rankCards([
    card({ title: "低", rank: 1, items: ["v1.5.48-beta:1"] }),
    card({ title: "修好的老毛病", rank: 3, kind: "fix", hurt: true, items: ["v1.5.48-beta:3"] }),
    card({ title: "高", rank: 5, items: ["v1.5.48-beta:2"] }),
  ]);
  assert.deepEqual(wall.map((c) => c.title), ["高", "修好的老毛病", "低"]);
});

test("头条只取前三，其余留在清单里", () => {
  const cards = Array.from({ length: 7 }, (_, i) => card({ title: `第${i}条`, rank: (i % 5) + 1, items: ["v1.5.48-beta:1"] }));
  const { highlights, rest } = splitHighlights(cards);
  assert.equal(highlights.length, 3);
  assert.equal(rest.length, 4);
  assert.equal(highlights[0].rank, 5);
});
