import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseFeedbackReply, FEEDBACK_LIMITS } from "../lib/feedback-chat.js";

const appRoot = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, appRoot), "utf8");
}

test("信息够：取出标题与正文，正文只按上限截，不改字", () => {
  const raw = JSON.stringify({
    reply: "整理好了，你看看还有没有漏的。",
    ready: true,
    title: "速览折叠块点不开",
    body: "遇到过什么：点速览右边的箭头没反应。\n我本来想做什么：展开看要点。\n期望怎样：点一下就能展开。",
  });
  const result = parseFeedbackReply(raw);
  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(result.title, "速览折叠块点不开");
  assert.match(result.body, /点速览右边的箭头没反应/);
});

test("信息不够：只回一句追问，不产出草稿", () => {
  const result = parseFeedbackReply('{"reply":"你是在哪一页点的时候没反应？","ready":false}');
  assert.equal(result.ok, true);
  assert.equal(result.ready, false);
  assert.equal(result.title, undefined);
  assert.match(result.reply, /哪一页/);
});

test("模型裹了解释或代码块也认得出 JSON", () => {
  const raw = '好的，这是整理结果：\n```json\n{"reply":"好了","ready":true,"title":"标题","body":"正文"}\n```';
  const result = parseFeedbackReply(raw);
  assert.equal(result.ok, true);
  assert.equal(result.title, "标题");
});

test("ready 是 true 但缺标题或正文：当没准备好，不糊弄成空草稿", () => {
  const result = parseFeedbackReply('{"reply":"再补一句","ready":true,"title":"","body":"正文"}');
  assert.equal(result.ok, true);
  assert.equal(result.ready, false);
});

test("回包不是 JSON：报一句人话，不把原始报错端给用户", () => {
  const result = parseFeedbackReply("抱歉，我没听懂");
  assert.equal(result.ok, false);
  assert.match(result.error, /再说一次/);
});

test("标题和正文都按上限截断，超长不撑爆弹窗", () => {
  const longTitle = "字".repeat(FEEDBACK_LIMITS.titleChars + 40);
  const longBody = "文".repeat(FEEDBACK_LIMITS.bodyChars + 100);
  const result = parseFeedbackReply(JSON.stringify({ reply: "好", ready: true, title: longTitle, body: longBody }));
  assert.equal(result.title.length, FEEDBACK_LIMITS.titleChars);
  assert.equal(result.body.length, FEEDBACK_LIMITS.bodyChars);
});

test("右上角有反馈按钮，弹窗元素齐全且 id 不重复", async () => {
  const html = await read("ui/panel.html");
  assert.match(html, /class="zy-fb-fab"[^>]*id="open-feedback"|id="open-feedback"[^>]*class="zy-fb-fab"/);
  for (const id of ["feedback-chat", "feedback-log", "feedback-input", "feedback-file", "feedback-github", "feedback-copy", "feedback-mail", "feedback-note", "feedback-choices", "feedback-go-chat", "feedback-go-github", "feedback-body"]) {
    assert.ok(html.includes(`id="${id}"`), `缺少 ${id}`);
  }
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const duplicated = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicated, []);
  // 图片只给模型看，界面上必须说清它不进 issue
  assert.match(html, /图只给我看懂问题，不进 issue/);
});

test("反馈弹窗接的是知意自己的 /feedback/chat，不去碰 GitHub 接口", async () => {
  const [panel, index] = await Promise.all([read("ui/assets/panel.js"), read("index.js")]);
  assert.match(panel, /hana\.api\.fetch\('\/feedback\/chat'/);
  assert.match(index, /app\.post\("\/feedback\/chat"/);
  assert.match(panel, /issues\/new/);
  assert.match(panel, /moononnn@qq\.com/);
});
