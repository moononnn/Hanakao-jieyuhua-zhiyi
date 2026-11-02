import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appRoot = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, appRoot), "utf8");
}

// 深色下主色会反过来变成浅色（--mint-deep / --primary-deep / --pink），
// 这时白字压在浅色底上只有 1.9:1，等于没有字。凡是这种组合，
// 都得有一条 html[data-appearance="dark"] 的规则把字换成深墨。
const LIGHT_ON_LIGHT = ["var(--mint-deep)", "var(--primary-deep)", "var(--pink)"];

function blocks(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(css))) {
    out.push({ selector: match[1].trim(), body: match[2] });
  }
  return out;
}

/** 取选择器末尾那个简单选择器（.foo / .foo.bar / #id），用来找它的深色覆盖。 */
function simpleSelector(selector) {
  const parts = selector.split(",")[0].trim().split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1] || "";
  return last.replace(/^(:root|html|body|\*)$/, "");
}

test("每个面板都跟着宿主主题走，不许有页面漏掉", async () => {
  const pages = [
    "ui/panel.html",
    "ui/market.html",
    "ui/suggest-panel.html",
    "ui/ask-panel.html",
    "ui/permission-panel.html",
  ];
  for (const page of pages) {
    const html = await read(page);
    assert.match(html, /assets\/theme-follow\.js/, `${page} 要引 theme-follow.js`);
  }

  const follow = await read("ui/assets/theme-follow.js");
  assert.match(follow, /hana-theme-appearance/, "要认宿主带来的 hana-theme-appearance");
  assert.match(follow, /hana\.theme\.changed/, "要接宿主主题变化的消息");
  assert.match(follow, /data-appearance/, "深浅要落到 data-appearance 上");
  assert.match(follow, /prefers-color-scheme/, "拿不到宿主消息时退回系统偏好");
});

test("所有面板都订阅宿主主题，换主题时能当场跟上", async () => {
  const report = await read("ui/assets/theme-report.js");
  assert.match(report, /hana\.theme\.subscribe/, "要订阅宿主主题变化");
  assert.match(report, /getSnapshot/, "开页时先取一次当前主题");
  assert.match(report, /data-host-theme/, "要把宿主主题样式表挂进页面");

  // 这些页面以前只靠 URL 参数开局能对，之后换主题就不动了。
  const marketJs = await read("ui/assets/market.js");
  assert.match(marketJs, /followHostTheme/, "市场页要订阅宿主主题");
  const permissionHtml = await read("ui/permission-panel.html");
  assert.match(permissionHtml, /followHostTheme/, "左侧栏要订阅宿主主题");
});

test("深色下浅底白字的实心按钮，都得有深墨字覆盖", async () => {
  const files = [
    "ui/assets/panel.css",
    "ui/assets/panel-layout.css",
    "ui/assets/suggest-panel.css",
    "ui/assets/market.css",
    "ui/assets/ask-panel.css",
    "ui/permission-panel.html",
    "ui/nav.html",
  ];

  for (const file of files) {
    const css = await read(file);
    const darkSelectors = blocks(css)
      .filter((b) => b.selector.includes('data-appearance="dark"'))
      .map((b) => b.selector);

    for (const block of blocks(css)) {
      if (!/color:\s*#fff\b/.test(block.body)) continue;
      const usesLightBackdrop = LIGHT_ON_LIGHT.some((token) => block.body.includes(token));
      if (!usesLightBackdrop) continue;

      const key = simpleSelector(block.selector);
      assert.ok(key, `${file} 里 ${block.selector} 的选择器看不出头`);
      const covered = darkSelectors.some((selector) => selector.includes(key));
      assert.ok(
        covered,
        `${file}: ${block.selector} 是浅色底 + 白字，深色下得有 html[data-appearance="dark"] 的深墨字覆盖`,
      );
    }
  }
});

test("深色下不再残留写死的白底输入框", async () => {
  for (const file of ["ui/assets/panel.css", "ui/assets/panel-layout.css"]) {
    const css = await read(file);
    // 白底在深色下是一块白斑；能用变量的一律用变量。
    assert.doesNotMatch(css, /background:\s*#fff\s*;/, `${file} 还有写死的白底`);
  }
});
