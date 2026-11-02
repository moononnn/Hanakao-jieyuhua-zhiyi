import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const load = async (relative) => (await readFile(new URL(`../${relative}`, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

test("按钮显隐同步仅在声明注册完后安排，临时网络探针不留在入口", async () => {
  const source = await load("index.js");
  const calls = [...source.matchAll(/^\s+scheduleInputStatusSync\(\);/gm)];
  assert.equal(calls.length, 1);
  assert.ok(calls[0].index > source.lastIndexOf("await sdk.tools.register("));
  assert.doesNotMatch(source, /jiegehua_zhiyi_market_probe/);
});

test("知意主页直接嵌入同一份雷达控件，不套iframe或打开系统窗口", async () => {
  const [panel, radar, layout, manifestText] = await Promise.all([
    load("ui/panel.html"), load("ui/market.html"), load("ui/assets/panel-layout.js"), load("manifest.json"),
  ]);
  const standalone = radar.match(/<main id="market-main"[^>]*>([\s\S]*?)<\/main>/)?.[1];
  const embedded = panel.match(/<div id="market-main"[^>]*>([\s\S]*?)\n  <\/div>\n        <\/section>/)?.[1];
  assert.ok(standalone && embedded);
  assert.equal(embedded.trim(), standalone.trim(), "雷达页与主页内嵌控件应保持一致");
  assert.match(panel, /class="view market-body" id="view-market"/);
  assert.match(panel, /stylesheet" href="\.\/assets\/market\.css"/);
  assert.match(panel, /type="module" src="\.\/assets\/market\.js"/);
  assert.doesNotMatch(embedded, /<iframe|<dialog|market-open-window/);
  assert.doesNotMatch(layout, /market-open-window|\/market\/open-window/);
  assert.match(layout, /dispatchEvent\(new CustomEvent\('zhiyi:view-change', \{ detail: \{ view: id \} \}\)\)/);
  assert.equal(JSON.parse(manifestText).capabilities.includes("app/windows.manage"), false);
  const ids = [...panel.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, "内嵌模块不能与原页面控件ID冲突");
});
