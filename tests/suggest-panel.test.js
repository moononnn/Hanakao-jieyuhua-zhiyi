import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPanelPresentation,
  buildPanelState,
  estimatePanelHeight,
  normalizeSuggestionTexts,
  readPanelState,
} from "../lib/suggest-panel.js";

test("推荐语统一成纯文本数组，去空去白", () => {
  assert.deepEqual(
    normalizeSuggestionTexts([{ text: "一句" }, "  ", null, { text: "  两句  " }, { no: "x" }]),
    [{ text: "一句", direction: "" }, { text: "两句", direction: "" }],
  );
});

test("方向跟着一起留着（面板上要标出来）", () => {
  assert.deepEqual(
    normalizeSuggestionTexts([{ text: "一句", direction: "追问/延伸" }]),
    [{ text: "一句", direction: "追问/延伸" }],
  );
});

test("最多留四条（跟设置页的 2/3/4 一致）", () => {
  assert.equal(normalizeSuggestionTexts(["一", "二", "三", "四", "五"]).length, 4);
});

test("面板状态带会话归属和时间", () => {
  const state = buildPanelState({ sessionId: "sess-1", suggestions: ["一句"], createdAt: 123 });
  assert.equal(state.sessionId, "sess-1");
  assert.deepEqual(state.suggestions, [{ text: "一句", direction: "" }]);
  assert.equal(state.createdAt, 123);
});

test("读回状态：没有内容就说没有，别端出空数组当有", () => {
  const result = readPanelState({});
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty");
});

test("读回状态：别的对话的内容不给看", () => {
  const state = buildPanelState({ sessionId: "sess-1", suggestions: ["一句"] });
  const result = readPanelState(state, "sess-2");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "other-session");
});

test("读回状态：同一段对话正常拿回", () => {
  const state = buildPanelState({ sessionId: "sess-1", suggestions: ["一句", "二句"] });
  const result = readPanelState(state, "sess-1");
  assert.equal(result.ok, true);
  assert.deepEqual(result.suggestions, [
    { text: "一句", direction: "" },
    { text: "二句", direction: "" },
  ]);
});

test("面板高度：展开够摊开三句，折叠留标题高度", () => {
  const presentation = buildPanelPresentation();
  assert.equal(presentation.expanded, true);
  assert.ok(presentation.height >= 200 && presentation.height <= 4096);
  assert.ok(presentation.collapsedHeight >= 24 && presentation.collapsedHeight < presentation.height);
});

test("没生成推荐时也留得住会话归属和 panelId", () => {
  const state = buildPanelState({ sessionId: "sess-1", quickReplies: ["在的"], panelId: "panel-9" });
  const result = readPanelState(state);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty");
  assert.equal(result.sessionId, "sess-1");
  assert.equal(result.panelId, "panel-9");
  assert.deepEqual(result.quickReplies, ["在的"]);
});

test("面板高度按内容估：内容多就高，估出来不超宿主上限", () => {
  const empty = estimatePanelHeight({});
  const busy = estimatePanelHeight({ quickCount: 4, suggestionCount: 4 });
  assert.ok(busy > empty);
  assert.ok(busy <= 460);
  assert.ok(empty >= 180, "页签并入后，空面板也要留够导航和操作区高度");
  assert.ok(estimatePanelHeight({ quickCount: 2 }) >= empty + 40, "多条常用回复会换行，估高不能还只算一排");
});
