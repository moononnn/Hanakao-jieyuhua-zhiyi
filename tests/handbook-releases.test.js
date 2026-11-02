import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchReleases,
  isNoiseRelease,
  normalizeRelease,
  normalizeVersion,
  parseReleaseBody,
  pickRecentReleases,
  stripEnglish,
} from "../lib/handbook-releases.js";

// 样本都按真实 body 的骨架缩小写，保留排版差异本身（三级分组 / 无分组 / 编号章节 / 纯段落），
// 不保留原文长度：测的是切分规则，不是某一条文案。
const WITH_GROUPS = `# HanaAgent 1.5.48-beta

包含自 **v1.5.7-beta** 以来的更新。

## Features · 新功能与改进

### 记忆与闲聊

- **更充足的记忆容量**：扩大今日、近期、长期记忆的整理容量。
- **闲聊独立模型**：在闲聊设置中为闲聊单独选择模型。

### 扩展市场与卡片

- **表情包市场**：扩展市场新增表情包分类。

## Bug Fixes · 问题修复

### 聊天

- **会话列表更稳定**：改进大量会话的发现和分页处理。

## 升级提示

- **旧版回退限制**：本次升级将本地数据版本从 2 提升到 3。
`;

const NO_GROUPS = `# HanaAgent 1.5.7-beta

包含自 **v1.3.6-beta** 以来的更新。

## Features · 新功能

- **新增「闲聊」**：从桌面侧边栏进入，和主助手聊天。
- **闲聊语音**：按住输入框说话，松开转成文字。

## Performance · 性能优化

- **多任务运行时的会话列表**：合并连续的列表刷新请求。

## Bug Fixes · 问题修复

- 修复多助手场景下，聊天截图可能使用其他助手的名称的问题。

**升级提示**：建议使用完整安装包升级。

---

# HanaAgent 1.5.7-beta — English

Includes changes since v1.3.6-beta.

## Features
- **New Chat**: open from the sidebar.
`;

const NUMBERED = `# HanaAgent 1.1.111-beta

包含自 **v1.1.35-beta** 以来的更新。

## 1. Code：独立的编程工作空间

### 从项目开始

- 新增 Code 页，将编程会话与主页会话分开管理。

## 2. 快速动作

- 新增快速动作，把常用操作留在项目里。
`;

// 真实说明都在三千字以上，噪音过滤按长度卡阈值；过抓取链路时得先把样本撑过阈值。
const pad = (s) => `${s}\n\n${"补充说明。".repeat(120)}`;

// v1.1.7：一级标题是分类，二级标题是小节，正文是没有列表的纯段落。
const PARAGRAPHS = `HanaAgent 1.1.7-beta
包含自 v1.1.0-beta 以来的更新。

# Feature

## 会话浏览器

在会话里打开的网页会成为一个独立标签。

网页标签可以拆到独立窗口。

## 卡片与资料库

资料库卡片新增缩略图。

# Bugfix

## 设置

修复保存设置后输入框失焦的问题。

---

HanaAgent 1.1.7-beta (English)
Includes changes since v1.1.0-beta.
`;

test("带三级分组的版本按 章节→分组→条目 切开", () => {
  const parsed = parseReleaseBody(WITH_GROUPS, { tag: "v1.5.48-beta" });
  assert.equal(parsed.baseVersion, "v1.5.7-beta");
  assert.equal(parsed.itemCount, 5);
  // 升级提示单独收走，不占 sections。
  assert.deepEqual(parsed.sections.map((s) => s.key), ["features", "fixes"]);
  assert.equal(parsed.upgradeNotes.length, 1);
  assert.equal(parsed.upgradeNotes[0].title, "旧版回退限制");
  assert.deepEqual(
    parsed.sections[0].groups.map((g) => g.name),
    ["记忆与闲聊", "扩展市场与卡片"],
  );
  assert.equal(parsed.sections[0].groups[0].items[0].title, "更充足的记忆容量");
  assert.match(parsed.sections[0].groups[0].items[0].detail, /扩大今日/);
});

test("没有三级分组的版本，条目直接挂在章节下", () => {
  const parsed = parseReleaseBody(NO_GROUPS, { tag: "v1.5.7-beta" });
  assert.equal(parsed.itemCount, 4);  const features = parsed.sections.find((s) => s.key === "features");
  assert.equal(features.groups.length, 1);
  assert.equal(features.groups[0].name, "");
  assert.equal(features.groups[0].items.length, 2);
});

test("编号章节的版本保留原标题", () => {
  const parsed = parseReleaseBody(NUMBERED, { tag: "v1.1.111-beta" });
  assert.equal(parsed.sections[0].title, "1. Code：独立的编程工作空间");
  assert.equal(parsed.sections[0].groups[0].name, "从项目开始");
  assert.equal(parsed.sections[0].groups[0].items[0].title, "新增 Code 页，将编程会话与主页会话分开管理。");
});

test("纯段落排版：一段一条，一级标题当分类、二级标题当分组", () => {
  const parsed = parseReleaseBody(PARAGRAPHS, { tag: "v1.1.7-beta" });
  assert.deepEqual(parsed.sections.map((s) => s.title), ["Feature", "Bugfix"]);
  assert.deepEqual(
    parsed.sections[0].groups.map((g) => g.name),
    ["会话浏览器", "卡片与资料库"],
  );
  assert.equal(parsed.sections[0].groups[0].items.length, 2);
  assert.equal(parsed.sections[0].groups[0].items[1].title, "网页标签可以拆到独立窗口。");
});

test("英文重写段整段丢掉，不重复计数", () => {
  for (const heading of ["— English", "(English)"]) {
    const body = `# HanaAgent 1.0.0-beta\n\n- 中文条目\n\n---\n\n# HanaAgent 1.0.0-beta ${heading}\n\n- English item\n`;
    const out = stripEnglish(body);
    assert.ok(!/English item/.test(out), `${heading} 没截干净`);
    assert.match(out, /中文条目/);
  }
  const parsed = parseReleaseBody(NO_GROUPS, { tag: "v1.5.7-beta" });
  const all = parsed.sections.flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.title)));
  assert.ok(!all.some((t) => /New Chat/.test(t)), "英文条目混进来了");
});

test("升级提示两种写法都收进同一处，不粘到上一条正文里", () => {
  const asSection = parseReleaseBody(WITH_GROUPS, { tag: "x" });
  assert.equal(asSection.upgradeNotes.length, 1);
  assert.equal(asSection.upgradeNotes[0].title, "旧版回退限制");

  const asParagraph = parseReleaseBody(NO_GROUPS, { tag: "x" });
  assert.equal(asParagraph.upgradeNotes.length, 1);
  assert.equal(asParagraph.upgradeNotes[0].title, "升级提示");
  const fixes = asParagraph.sections.find((s) => s.key === "fixes");
  assert.equal(fixes.groups[0].items[0].detail, "");
});

test("条目 id 在同一个 tag 下稳定且唯一", () => {
  const a = parseReleaseBody(WITH_GROUPS, { tag: "v1.5.48-beta" });
  const b = parseReleaseBody(WITH_GROUPS, { tag: "v1.5.48-beta" });
  const ids = (p) => p.sections.flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.id)));
  assert.deepEqual(ids(a), ids(b));
  assert.equal(new Set(ids(a)).size, ids(a).length);
  assert.ok(ids(a).every((id) => id.startsWith("v1.5.48-beta:")));
});

test("噪音版本按 tag 前缀和正文长度剔掉", () => {
  const long = "说明 ".repeat(200);
  assert.equal(isNoiseRelease({ tag_name: "train-beta-44", body: long }), true);
  assert.equal(isNoiseRelease({ tag_name: "v0.450.0", body: "**Full Changelog**: https://example.com/compare/a...b" }), true);
  assert.equal(isNoiseRelease({ tag_name: "v1.5.48-beta", body: long, draft: false }), false);
  assert.equal(isNoiseRelease({ tag_name: "v1.5.48-beta", body: long, draft: true }), true);
  // 英文段很长但中文段很短时，按中文段长度判断，不能被英文撑过去。
  assert.equal(isNoiseRelease({ tag_name: "v1.0.0", body: `短\n\n---\n\n# HanaAgent (English)\n${"english ".repeat(300)}` }), true);
});

test("normalizeRelease 压成内部形状并归一版本号", () => {
  const out = normalizeRelease({
    tag_name: "v1.5.48-beta",
    name: "HanaAgent 1.5.48-beta",
    published_at: "2026-11-01T23:32:45Z",
    html_url: "https://github.com/liliMozi/openhanako/releases/tag/v1.5.48-beta",
    body: WITH_GROUPS,
  });
  assert.equal(out.version, "1.5.48-beta");
  assert.equal(out.baseVersion, "1.5.7-beta");
  assert.equal(out.itemCount, 5);
  assert.equal(normalizeVersion("v1.0.0"), "1.0.0");
});

const REL = [
  { version: "1.5.48-beta", publishedAt: "2026-11-01T23:32:45Z" },
  { version: "1.5.7-beta", publishedAt: "2026-10-29T20:33:05Z" },
  { version: "1.3.6-beta", publishedAt: "2026-10-26T12:02:38Z" },
  { version: "1.2.1-beta", publishedAt: "2026-10-25T08:59:33Z" },
  { version: "1.1.111-beta", publishedAt: "2026-10-24T14:43:45Z" },
  { version: "1.1.35-beta", publishedAt: "2026-10-19T22:27:45Z" },
];

test("按已装版本挑出之后发布的版本", () => {
  const picked = pickRecentReleases(REL, { installedVersion: "1.5.7-beta" });
  assert.deepEqual(picked.releases.map((r) => r.version), ["1.5.48-beta"]);
  assert.equal(picked.baseline.version, "1.5.7-beta");
  assert.equal(picked.truncated, false);
});

test("已装版本不在 release 里时退回最近几版，并如实说没有基线", () => {
  const picked = pickRecentReleases(REL, { installedVersion: "9.9.9-ota" });
  assert.equal(picked.baseline, null);
  assert.equal(picked.releases.length, 5);
  assert.equal(picked.truncated, true);
});

test("落后很多版时按上限截断并说明还有多少", () => {
  const picked = pickRecentReleases(REL, { installedVersion: "1.1.111-beta", maxVersions: 2 });
  assert.deepEqual(picked.releases.map((r) => r.version), ["1.5.48-beta", "1.5.7-beta"]);
  assert.equal(picked.newerCount, 4);
  assert.equal(picked.truncated, true);
});

test("抓取时把噪音版本过滤掉，并按发布时间倒序", async () => {
  const payload = [
    { tag_name: "train-beta-44", body: "Hot-update train release. ".repeat(20), published_at: "2026-11-01T23:38:58Z" },
    { tag_name: "v1.5.7-beta", name: "HanaAgent 1.5.7-beta", body: pad(NO_GROUPS.replace(/---[\s\S]*$/, "")), published_at: "2026-10-29T20:33:05Z" },
    { tag_name: "v1.5.48-beta", name: "HanaAgent 1.5.48-beta", body: pad(WITH_GROUPS), published_at: "2026-11-01T23:32:45Z" },
  ];
  const sdk = {
    network: {
      fetch: async () => ({ ok: true, status: 200, json: async () => payload }),
    },
  };
  const out = await fetchReleases(sdk);
  assert.deepEqual(out.map((r) => r.tag), ["v1.5.48-beta", "v1.5.7-beta"]);
});

test("抓取失败给的是人话，不是堆栈", async () => {
  const failing = { network: { fetch: async () => { throw new Error("ECONNRESET"); } } };
  await assert.rejects(() => fetchReleases(failing), /网络没通/);
  const limited = {
    network: { fetch: async () => ({ ok: false, status: 403 }) },
  };
  await assert.rejects(() => fetchReleases(limited), (err) => err instanceof Error && /次|额度|稍后/.test(err.message));
});
