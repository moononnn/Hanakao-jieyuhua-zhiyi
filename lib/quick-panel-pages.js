// 输入框上方那块快捷面板的页面排列：有哪几页、按什么顺序。
//
// 顺序就是页签顺序，第一页就是打开面板时看到的那页。
// 「一页都不选」等于把输入栏那颗按钮一起收起来：这两件事本来就是一回事，
// 拆成两个开关早晚会打架，所以显示与否统一由这里算（见 index.js 的 currentInputButtonEnabled）。

export const QUICK_PANEL_PAGE_KEYS = Object.freeze(["recommend", "polish", "tools"]);

export const QUICK_PANEL_PAGE_LABELS = Object.freeze({
  recommend: "推荐回复",
  polish: "帮我理顺",
  tools: "小工具",
});

// 没配过时的样子：跟改造前一模一样，三页都开、顺序照旧。
export const DEFAULT_QUICK_PANEL_PAGES = Object.freeze([
  Object.freeze({ key: "recommend", enabled: true }),
  Object.freeze({ key: "polish", enabled: true }),
  Object.freeze({ key: "tools", enabled: true }),
]);

/**
 * 归一化成 [{ key, enabled }]，顺序即页序。
 *
 * 传 undefined / null 表示「没配过」，给默认三页；
 * 传了数组就照它排，缺的页补在末尾且按关闭算（配过的清单就是全部清单，
 * 不替用户把没写的页又打开）。
 */
export function normalizeQuickPanelPages(value) {
  const raw = Array.isArray(value) ? value : (Array.isArray(value?.pages) ? value.pages : null);
  if (!raw) return DEFAULT_QUICK_PANEL_PAGES.map((page) => ({ ...page }));

  const seen = new Set();
  const pages = [];
  for (const item of raw) {
    const key = typeof item === "string" ? item : String(item?.key || "");
    if (!QUICK_PANEL_PAGE_KEYS.includes(key) || seen.has(key)) continue;
    seen.add(key);
    // 只写 key 的旧形状当启用，写了 enabled:false 才算关。
    pages.push({ key, enabled: typeof item === "string" ? true : item?.enabled !== false });
  }
  for (const key of QUICK_PANEL_PAGE_KEYS) {
    if (!seen.has(key)) pages.push({ key, enabled: false });
  }
  return pages;
}

/** 能出现在面板上的页，按顺序。 */
export function enabledQuickPanelPages(value) {
  return normalizeQuickPanelPages(value).filter((page) => page.enabled);
}

/** 一页都没选就是没有面板：输入栏那颗按钮也收起来。 */
export function hasEnabledQuickPanelPage(value) {
  return enabledQuickPanelPages(value).length > 0;
}

/** 打开面板时先落到哪一页；一页没选返回空串。 */
export function defaultQuickPanelPage(value) {
  return enabledQuickPanelPages(value)[0]?.key || "";
}

/** 这个页签还该不该存在（面板端按它盖显隐）。 */
export function isQuickPanelPageEnabled(value, key) {
  return normalizeQuickPanelPages(value).some((page) => page.key === key && page.enabled);
}
