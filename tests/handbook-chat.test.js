import test from "node:test";
import assert from "node:assert/strict";
import { askHandbook, buildChatMaterials, selectRelevantItems } from "../lib/handbook-chat.js";
import { resetHandbookListCacheForTest } from "../lib/handbook-service.js";

const releases = [
  {
    tag: "v1.5.48-beta",
    sections: [
      {
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
        title: "Bug Fixes · 问题修复",
        groups: [{ name: "", items: [{ id: "v1.5.48-beta:3", title: "错误提示保留到能够读完", detail: "不再定时消失。" }] }],
      },
    ],
    upgradeNotes: [{ title: "旧版回退限制", detail: "数据版本从 2 提升到 3。" }],
  },
  {
    tag: "v1.5.7-beta",
    sections: [
      {
        title: "Features · 新功能",
        groups: [{ name: "", items: [{ id: "v1.5.7-beta:1", title: "闲聊语音", detail: "按住输入框说话，松开转成文字。" }] }],
      },
    ],
    upgradeNotes: [],
  },
];

test("没点卡时按问题捞相关条目", () => {
  const rows = selectRelevantItems(releases, ["v1.5.48-beta", "v1.5.7-beta"], "闲聊能不能单独换个模型");
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].title, "闲聊独立模型");
  assert.ok(rows.every((row) => row.tag.startsWith("v")));
});

test("只在这一轮的窗口版本里找，不翻别人的版本", () => {
  const rows = selectRelevantItems(releases, ["v1.5.48-beta"], "闲聊语音");
  assert.ok(rows.every((row) => row.tag === "v1.5.48-beta"));
});

test("问题跟更新无关时不硬凑条目", () => {
  assert.deepEqual(selectRelevantItems(releases, ["v1.5.48-beta"], "今天天气咋样"), []);
  assert.deepEqual(selectRelevantItems(releases, ["v1.5.48-beta"], ""), []);
});

test("材料里写明用户点的是哪张卡、问的是什么", () => {
  const text = buildChatMaterials({
    question: "这个我要开吗",
    card: { title: "闲聊可以单独挑模型", tag: "v1.5.48-beta", now: "能在设置里分开挑" },
    sources: [{ tag: "v1.5.48-beta", title: "闲聊独立模型", detail: "在闲聊设置中为闲聊单独选择模型。" }],
    upgradeNotes: releases[0].upgradeNotes,
  });
  assert.match(text, /用户点开的是这张卡/);
  assert.match(text, /用户问：这个我要开吗/);
  assert.match(text, /闲聊独立模型/);
  assert.match(text, /旧版回退限制/);
});

test("一条都没匹配到时，明说这版没提到", () => {
  const text = buildChatMaterials({ question: "这个我要开吗", card: null, sources: [], upgradeNotes: [] });
  assert.match(text, /这一版没提到/);
});

test("空问题直接拒绝，不浪费一次模型调用", async () => {
  await assert.rejects(() => askHandbook({}, { question: "   " }), /还没写问题/);
});

test("没选模型时给的是可执行的下一步，不是空转", async () => {
  resetHandbookListCacheForTest();
  const sdk = {
    dataDir: "",
    network: { fetch: async () => ({ ok: true, json: async () => [] }) },
    storage: { global: { get: async () => null } },
    models: { list: async () => [] },
    logger: { debug() {} },
  };
  await assert.rejects(() => askHandbook(sdk, { question: "闲聊独立模型是啥", tags: ["v1.5.48-beta"] }), /先在知意|内容模型/);
});
