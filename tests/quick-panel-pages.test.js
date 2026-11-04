// 快捷面板页面排列的归一化（node:test，零依赖）。

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_QUICK_PANEL_PAGES,
  defaultQuickPanelPage,
  enabledQuickPanelPages,
  hasEnabledQuickPanelPage,
  isQuickPanelPageEnabled,
  normalizeQuickPanelPages,
} from "../lib/quick-panel-pages.js";

test("没配过就是老样子：三页都开、顺序不变", () => {
  for (const value of [undefined, null, {}, 0, "x"]) {
    assert.deepEqual(normalizeQuickPanelPages(value), DEFAULT_QUICK_PANEL_PAGES.map((page) => ({ ...page })));
  }
  assert.equal(defaultQuickPanelPage(undefined), "recommend");
});

test("配过就照配的排，顺序就是页序", () => {
  const pages = normalizeQuickPanelPages([
    { key: "tools", enabled: true },
    { key: "polish", enabled: true },
    { key: "recommend", enabled: false },
  ]);
  assert.deepEqual(pages.map((page) => page.key), ["tools", "polish", "recommend"]);
  assert.equal(defaultQuickPanelPage(pages), "tools");
  assert.deepEqual(enabledQuickPanelPages(pages).map((page) => page.key), ["tools", "polish"]);
});

test("一页都不选等于关掉整个快捷面板", () => {
  const none = normalizeQuickPanelPages([
    { key: "recommend", enabled: false },
    { key: "polish", enabled: false },
    { key: "tools", enabled: false },
  ]);
  assert.equal(hasEnabledQuickPanelPage(none), false);
  assert.equal(defaultQuickPanelPage(none), "");
  assert.deepEqual(enabledQuickPanelPages(none), []);
});

test("空数组是「全关」，不是「没配过」", () => {
  const empty = normalizeQuickPanelPages([]);
  assert.equal(hasEnabledQuickPanelPage(empty), false);
  assert.equal(empty.length, 3, "三页仍在清单里，只是都关着");
  assert.deepEqual(empty.map((page) => page.enabled), [false, false, false]);
});

test("认不出的页丢掉、重复的只留第一个、缺的补在末尾且算关闭", () => {
  const pages = normalizeQuickPanelPages([
    { key: "tools", enabled: true },
    { key: "bogus", enabled: true },
    { key: "tools", enabled: false },
  ]);
  assert.deepEqual(pages.map((page) => `${page.key}:${page.enabled}`), [
    "tools:true",
    "recommend:false",
    "polish:false",
  ]);
});

test("旧形状（纯字符串 / 只写 key）当启用", () => {
  const pages = normalizeQuickPanelPages(["tools", { key: "polish" }]);
  assert.deepEqual(pages.map((page) => `${page.key}:${page.enabled}`), [
    "tools:true",
    "polish:true",
    "recommend:false",
  ]);
});

test("对象包一层 pages 也认", () => {
  const pages = normalizeQuickPanelPages({ pages: [{ key: "polish", enabled: true }] });
  assert.equal(defaultQuickPanelPage(pages), "polish");
});

test("单页查询按当前配置回答", () => {
  const config = [{ key: "tools", enabled: true }, { key: "recommend", enabled: false }];
  assert.equal(isQuickPanelPageEnabled(config, "tools"), true);
  assert.equal(isQuickPanelPageEnabled(config, "recommend"), false);
  assert.equal(isQuickPanelPageEnabled(config, "polish"), false, "缺项按关闭算");
});
