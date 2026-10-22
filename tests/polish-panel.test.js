import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildPolishRequest,
  normalizePolishSuggestions,
  polishStatusText,
} from "../ui/assets/polish-draft.js";

const appRoot = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, appRoot), "utf8");
}

test("第一次理顺：不算迭代，不带上一版和原话锚点", () => {
  const draft = buildPolishRequest({ text: "  帮我看看这个  ", instruction: " 语气客气点 " });
  assert.equal(draft.onPrevious, false);
  assert.equal(draft.request.text, "帮我看看这个");
  assert.equal(draft.request.level, "balanced");
  assert.equal(draft.request.instruction, "语气客气点");
  assert.equal(draft.request.previous, "");
  assert.equal(draft.request.source, "");
});

test("框里还是上一版结果：算迭代，带上上一版和最初原话", () => {
  const draft = buildPolishRequest({
    text: "帮我看看这个，重点看啰嗦的地方",
    lastResult: "帮我看看这个，重点看啰嗦的地方",
    source: "帮我看看这个",
  });
  assert.equal(draft.onPrevious, true);
  assert.equal(draft.request.previous, "帮我看看这个，重点看啰嗦的地方");
  assert.equal(draft.request.source, "帮我看看这个");
});

test("用户自己改过输入框：重新起头，锚点不再带上一版", () => {
  const draft = buildPolishRequest({
    text: "我自己改过的一段话",
    lastResult: "上一版结果",
    source: "最初原话",
  });
  assert.equal(draft.onPrevious, false);
  assert.equal(draft.request.previous, "");
  assert.equal(draft.request.source, "");
});

test("回包的三种说法都要分开：退回、没改动、理顺好了", () => {
  assert.equal(polishStatusText({ ok: true, fellBack: true }).tone, "warn");
  assert.match(polishStatusText({ ok: true, fellBack: true }).text, /退回/);
  assert.match(polishStatusText({ ok: true, unchanged: true }).text, /没改/);
  assert.equal(polishStatusText({ ok: true }).tone, "ok");
  assert.equal(polishStatusText({ ok: false, error: "模型没接住" }).text, "模型没接住");
  assert.equal(polishStatusText(null).tone, "warn");
});

test("候选方向只留有标签也有做法的那几条", () => {
  const items = normalizePolishSuggestions([
    { label: " 删掉垫话 ", prompt: " 去掉开头那句 " },
    { label: "只有标签" },
    { prompt: "只有做法" },
    null,
  ]);
  assert.deepEqual(items, [{ label: "删掉垫话", prompt: "去掉开头那句" }]);
  assert.deepEqual(normalizePolishSuggestions(undefined), []);
});

test("输入框面板有第三个页签：帮我理顺", async () => {
  const html = await read("ui/suggest-panel.html");
  const script = await read("ui/assets/suggest-panel.js");
  const css = await read("ui/assets/suggest-panel.css");

  assert.match(html, /id="tab-polish"[^>]*role="tab"/);
  // 页签名改成「帮我理顺」：单说「理顺」看不出点完会得到什么。
  assert.match(html, /id="tab-polish"[^>]*>帮我理顺</);
  assert.match(html, /id="polish-page"[^>]*role="tabpanel"[^>]*hidden/);
  assert.match(html, /id="polish-input"/);
  assert.match(html, /id="polish-require"/);
  assert.match(html, /id="polish-run"/);
  assert.match(html, /id="polish-queue"/);
  assert.match(html, /id="polish-send"/);
  assert.match(html, /id="polish-suggest-list"/);

  // 页签顺序：推荐回复 / 小工具 / 帮我理顺（小工具在理顺左边）。
  const tabOrder = ["tab-recommend", "tab-tools", "tab-polish"].map((id) => html.indexOf(`id="${id}"`));
  assert.ok(tabOrder.every((pos) => pos >= 0), "三个页签都得在");
  assert.ok(tabOrder[0] < tabOrder[1] && tabOrder[1] < tabOrder[2], "页签顺序是 推荐回复 → 小工具 → 帮我理顺");

  // 三个页签都在同一张板上切换，别新开一块面板。
  assert.match(script, /const PANEL_PAGES = \[/);
  assert.match(script, /key: 'recommend'/);
  assert.match(script, /key: 'tools'/);
  assert.match(script, /key: 'polish'/);
  assert.match(script, /polishTab\.addEventListener/);

  // 三条后端路：理顺、候选方向、发送。
  assert.match(script, /hana\.api\.fetch\('\/polish'/);
  assert.match(script, /hana\.api\.fetch\('\/polish\/suggest'/);
  assert.match(script, /hana\.api\.fetch\('\/send'/);
  assert.match(script, /mode, sessionId: panelSessionId\(\)/);

  assert.match(css, /\.polish-input\s*\{/);
  assert.match(css, /\.polish-run\s*\{/);
  assert.match(css, /\.polish-suggest-btn\s*\{/);
});

test("输入栏只留一个知意按钮：理顺是面板里的页签，不另起一个按钮", async () => {
  const manifest = JSON.parse(await read("manifest.json"));
  const index = await read("index.js");
  const panelState = await read("lib/suggest-panel.js");

  // 实机（2026-10-22）：多出来那个「把话理顺」按钮把输入栏挤成四个小图标，
  // 还跟表情包的 🪄 撞了同一个图标。理顺只当面板里的第三个页签。
  assert.equal(manifest.contributes.ui.inputStatus.length, 1);
  assert.equal(manifest.contributes.ui.inputStatus[0].id, "zhiyi-suggest");
  assert.doesNotMatch(index, /jiegehua\.zhiyi_polish/);
  assert.doesNotMatch(panelState, /startPage/);
  assert.doesNotMatch(await read("ui/assets/suggest-panel.js"), /startPage/);
});
