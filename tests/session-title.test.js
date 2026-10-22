// 会话标题生成的纯函数回归（node:test，零依赖）。
// 数据链路（session:list / session:history / 模型调用）在 app-tool.test.js 里。

import test from "node:test";
import assert from "node:assert/strict";
import {
  applySessionTitle,
  buildTitleContext,
  buildTitlePrompt,
  cleanContextText,
  cleanTitleFallbackText,
  cleanTitleOutput,
  detectConversationLang,
  messagePlainText,
  pickTitleModel,
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

test("消息 content 是数组时也要拼出上下文（只认字符串会让标题永远只能兜底）", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "帮我看看这个标题" }] },
    { role: "assistant", content: [{ type: "text", text: "好的" }, { type: "tool_use", id: "t1", name: "read" }] },
  ];
  assert.equal(buildTitleContext(messages), "用户: 帮我看看这个标题\n助手: 好的");
  // 兜底路径同样要能从数组里取到用户原话
  assert.equal(messagePlainText({ content: [{ type: "text", text: "我觉得都做一下哈" }] }), "我觉得都做一下哈");
  assert.equal(cleanTitleFallbackText(messagePlainText({ content: [{ type: "text", text: "我觉得都做一下哈" }] })), "我觉得都做一下哈");
  assert.equal(messagePlainText({ content: "纯字符串" }), "纯字符串");
  assert.equal(messagePlainText({ content: [{ type: "image" }] }), "");
  assert.equal(messagePlainText({}), "");
});

test("模型列表直接返回数组时也能选到标题模型（以前只看 catalog.models）", async () => {
  const sdk = {
    models: { list: async () => [{ provider: "openai-codex", model: "gpt-6-luna", isCurrent: true }] },
    storage: { global: { get: async () => null } },
  };
  assert.deepEqual(await pickTitleModel(sdk), { provider: "openai-codex", model: "gpt-6-luna" });
});

test("选过内容模型就用选的那条，没选则跟随当前模型", async () => {  const catalog = {
    models: [
      { provider: "openai-codex", model: "gpt-6-luna", isCurrent: true },
      { provider: "deepseek", model: "deepseek-flash" },
    ],
  };
  const withChoice = {
    models: { list: async () => catalog },
    storage: { global: { get: async (key) => (key === "askJudgeModel" ? { provider: "deepseek", model: "deepseek-flash" } : null) } },
  };
  assert.deepEqual(await pickTitleModel(withChoice), { provider: "deepseek", model: "deepseek-flash" });

  const followCurrent = {
    models: { list: async () => catalog },
    storage: { global: { get: async () => null } },
  };
  assert.deepEqual(await pickTitleModel(followCurrent), { provider: "openai-codex", model: "gpt-6-luna" });

  const empty = { models: { list: async () => [] }, storage: { global: { get: async () => null } } };
  await assert.rejects(() => pickTitleModel(empty), /模型列表为空/);
});

test("写入标题要把旧值记下来，否则「还原」永远报没改过", async () => {
  // 实机（2026-10-22）：起过名之后点还原，永远得到「这段对话没有改过标题」。
  // 病根：记账那段的条件写反了，只有「没传旧标题」才记，而两个真入口都会传。
  const store = new Map();
  const sdk = {
    storage: { global: {
      get: async (key, fallback) => (store.has(key) ? store.get(key) : fallback),
      set: async (key, value) => { store.set(key, value); },
    } },
    bus: { request: async () => ({ ok: true, sessionId: "sess_1" }) },
  };
  await applySessionTitle(sdk, { sessionId: "sess_1", title: "新名字", previousTitle: "旧名字" });
  const record = store.get("titleUndo");
  assert.equal(record.sess_1.previousTitle, "旧名字");
  assert.equal(record.sess_1.currentTitle, "新名字");

  // 确实没有旧标题时记 null（表示从没起过），不能因此就不记。
  await applySessionTitle(sdk, { sessionId: "sess_2", title: "另一段", previousTitle: "" });
  assert.equal(store.get("titleUndo").sess_2.previousTitle, "");
});
