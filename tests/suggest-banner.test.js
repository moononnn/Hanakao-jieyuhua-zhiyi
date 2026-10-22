import test from "node:test";
import assert from "node:assert/strict";
import { buildSuggestBanner, clampBannerText, clampButtonTitle } from "../lib/suggest-banner.js";

const BANNER_TEXT_MAX = 200;
const BUTTON_TITLE_DISPLAY = 10;
const MAX_BUTTONS = 3;

test("三条建议变三个可点按钮，注入的是完整原文", () => {
  const banner = buildSuggestBanner([
    { text: "那这版铃声会不会比上一版闷？" },
    { text: "行，不改了，定稿图我存着" },
    { text: "再给我看看别的配色呗" },
  ]);
  assert.equal(banner.buttons.length, 3);
  assert.deepEqual(banner.buttons.map((b) => b.id), ["s1", "s2", "s3"]);
  for (const button of banner.buttons) {
    assert.equal(button.action.kind, "post-message");
    assert.equal(typeof button.action.text, "string");
    assert.ok(button.action.text.length > 0);
  }
  assert.equal(banner.buttons[0].action.text, "那这版铃声会不会比上一版闷？");
});

test("按钮上限三个：给四条也只挂前三条", () => {
  const banner = buildSuggestBanner([
    { text: "一" }, { text: "二" }, { text: "三" }, { text: "四" },
  ]);
  assert.equal(banner.buttons.length, MAX_BUTTONS);
  assert.equal(banner.buttons[2].action.text, "三");
});

test("标题超长截断带省略号，但发出去的仍是整句", () => {
  const long = "这".repeat(60);
  const banner = buildSuggestBanner([{ text: long }]);
  const title = banner.buttons[0].title;
  assert.equal([...title].length, BUTTON_TITLE_DISPLAY);
  assert.ok(title.endsWith("…"));
  assert.equal(banner.buttons[0].action.text, long);
});

test("按钮标题不会超过宿主硬上限 40 字", () => {
  const banner = buildSuggestBanner([{ text: "字".repeat(120) }]);
  assert.ok([...banner.buttons[0].title].length <= 40);
});

test("字符串形式的建议也收下，空的和非字符串的丢掉", () => {
  const banner = buildSuggestBanner(["可以直接发的句子", "", null, { text: "  " }, { text: "另一句" }]);
  assert.equal(banner.buttons.length, 2);
  assert.equal(banner.buttons[0].action.text, "可以直接发的句子");
  assert.equal(banner.buttons[1].action.text, "另一句");
});

test("没有可用建议时不产生按钮", () => {
  const banner = buildSuggestBanner([]);
  assert.equal(banner.buttons.length, 0);
  assert.ok(banner.text.length <= BANNER_TEXT_MAX);
});

test("横幅正文不超宿主上限", () => {
  const banner = buildSuggestBanner([{ text: "一" }], { lead: "标".repeat(500) });
  assert.ok([...banner.text].length <= BANNER_TEXT_MAX);
});

test("默认文案带上句数", () => {
  const banner = buildSuggestBanner([{ text: "一" }, { text: "二" }]);
  assert.match(banner.text, /2 句/);
});

test("截断工具按字符数算，中文一个字一个", () => {
  assert.equal(clampButtonTitle("七个字刚好啊", 10), "七个字刚好啊");
  assert.equal(clampButtonTitle("八个字多一个字啊", 7), "八个字多一个…");
  assert.equal(clampBannerText("短", 200), "短");
});

test("默认按钮标题按 16 字显示（横排放不下更长）", () => {
  assert.equal([...clampButtonTitle("这是一句比较长的推荐回复内容吧看看")].length, BUTTON_TITLE_DISPLAY);
});
