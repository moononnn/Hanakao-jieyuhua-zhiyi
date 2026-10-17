// 会话标题生成的纯函数回归（node:test，零依赖）。
// 数据链路（session:list / session:history / 模型调用）在 app-tool.test.js 里。

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTitleContext,
  buildTitlePrompt,
  cleanContextText,
  cleanTitleFallbackText,
  cleanTitleOutput,
  detectConversationLang,
  stripHiddenMetaBlocks,
} from "../lib/session-title.js";

test("隐藏元信息块不进标题", () => {
  assert.equal(stripHiddenMetaBlocks("<vibe>先吃饭</vibe>\n\n今天改代码"), "今天改代码");
  assert.equal(stripHiddenMetaBlocks("[mood]\n烦躁\n[/mood]\n正文"), "正文");
  // 未闭合的隐藏块后面全部丢弃，不冒险送进模型
  assert.equal(stripHiddenMetaBlocks("<mood>只有情绪没有正文"), "");
});

test("上下文清洗去掉注入块、引用块和单行标记", () => {
  assert.equal(cleanContextText("帮我看看这个"), "帮我看看这个");
  assert.equal(cleanContextText("<mood>x</mood>正文"), "正文");
  assert.equal(cleanContextText("[hana_reference]一大段[/hana_reference]正文"), "正文");
  // 未闭合的注入残留在开头 → 整条丢弃
  assert.equal(cleanContextText("[hana_reference]一大段"), "");
  assert.equal(cleanContextText("【隐藏视角】xxx\n用户: 你好"), "用户: 你好");
});

test("标题清洗剥代码块、成对引号、结尾标点并限长", () => {
  assert.equal(cleanTitleOutput("```text\n今天改代码\n```"), "今天改代码");
  assert.equal(cleanTitleOutput("「今天改代码。」"), "今天改代码", "全角成对引号必须剥得掉");
  assert.equal(cleanTitleOutput("《今天改代码》"), "今天改代码");
  assert.equal(cleanTitleOutput("『今天改代码』"), "今天改代码");
  assert.equal(cleanTitleOutput("“今天改代码”"), "今天改代码");
  assert.equal(cleanTitleOutput("今天改代码。"), "今天改代码");
  assert.equal(cleanTitleOutput('"今天改代码"'), "今天改代码");
  assert.equal(cleanTitleOutput("「「今天改代码」」"), "今天改代码", "嵌套两层也要剥干净");
  assert.equal(cleanTitleOutput("长".repeat(40)).length, 30);
  assert.equal(cleanTitleOutput("   "), null);
});

test("附件包装和元数据不许当成标题", () => {
  assert.equal(cleanTitleOutput("[SessionFile] 有一个文件"), null);
  assert.equal(cleanTitleOutput('[attached_image: a.png] 这张图'), null);
  assert.equal(cleanTitleOutput('{"fileId":"abc"}'), null);
});

test("兜底标题剥掉附件包装再取用户原话", () => {
  assert.equal(cleanTitleFallbackText("<file name=\"a.png\">xx</file>帮我改改这个"), "帮我改改这个");
  assert.equal(cleanTitleFallbackText("[attached_image: a.png] 这张图"), "这张图");
  assert.equal(cleanTitleFallbackText("[SessionFile] {fileId:\"x\"} 看看这个"), "看看这个");
});

test("语言判定按中英比例，标题语言跟着对话走", () => {
  assert.equal(detectConversationLang("今天我们改一下这个功能"), "zh");
  assert.equal(detectConversationLang("we are refactoring the parser today"), "en");
  assert.equal(buildTitlePrompt("今天改代码").includes("标题必须用中文输出"), true);
  assert.equal(buildTitlePrompt("we are refactoring the parser today").includes("标题必须用英文输出"), true);
});

test("标题上下文按开头+最近截断，不把中段挤掉", () => {
  const short = [{ role: "user", content: "帮我看看这个" }, { role: "assistant", content: "好的" }];
  assert.equal(buildTitleContext(short), "用户: 帮我看看这个\n助手: 好的");
  assert.equal(buildTitleContext([]), "");

  const long = Array.from({ length: 200 }, (_, i) => ({ role: "user", content: `消息${i}` }));
  const context = buildTitleContext(long);
  assert.ok(context.length <= 6000, `上下文超预算：${context.length}`);
  assert.match(context, /消息0/, "开头要留住，定调靠它");
  assert.match(context, /消息199/, "最近也要留住，现状靠它");
});

test("上下文清洗会挡掉只有元信息的会话", () => {
  assert.equal(buildTitleContext([{ role: "user", content: "<mood>只有情绪</mood>" }]), "");
});
