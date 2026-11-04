// 会话标题生成的纯函数回归（node:test，零依赖）。
// 数据链路（session:list / session:history / 模型调用）在 app-tool.test.js 里。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
  projectSessionEntries,
  readTitleCache,
  selectTitleMessages,
  stripAttachmentWrapper,
  stripHiddenMetaBlocks,
  titleFingerprint,
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
  const chain = await pickTitleModel(sdk);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].model.provider, "openai-codex");
  assert.equal(chain[0].model.model, "gpt-6-luna");
});

test("选过内容模型就用选的那条，没选则跟随当前模型，而且给的是降级链", async () => {  const catalog = {
    models: [
      { provider: "openai-codex", model: "gpt-6-luna", isCurrent: true },
      { provider: "deepseek", model: "deepseek-flash" },
    ],
  };
  const withChoice = {
    models: { list: async () => catalog },
    storage: { global: { get: async (key) => (key === "askJudgeModel" ? { provider: "deepseek", model: "deepseek-flash" } : null) } },
  };
  const chosen = await pickTitleModel(withChoice);
  assert.equal(chosen[0].model.provider, "deepseek");
  assert.equal(chosen[0].model.model, "deepseek-flash");

  const followCurrent = {
    models: { list: async () => catalog },
    storage: { global: { get: async () => null } },
  };
  const followed = await pickTitleModel(followCurrent);
  assert.equal(followed[0].model.provider, "openai-codex");
  assert.equal(followed[0].model.model, "gpt-6-luna");

  // 快速档 + 内容模型 + 备用模型都配了：三条按这个顺序排开，同名去掉。
  const full = {
    models: { list: async () => catalog },
    storage: { global: { get: async (key) => ({
      fastTaskModel: { provider: "deepseek", model: "deepseek-flash" },
      recommendationModel: { provider: "deepseek", model: "deepseek-flash" },
      recommendationFallbackModel: { provider: "openai-codex", model: "gpt-6-luna" },
    }[key] ?? null) } },
  };
  const chain = await pickTitleModel(full);
  assert.deepEqual(chain.map((item) => `${item.model.provider}/${item.model.model}`), [
    "deepseek/deepseek-flash",
    "openai-codex/gpt-6-luna",
  ]);

  const empty = { models: { list: async () => [] }, storage: { global: { get: async () => null } } };
  await assert.rejects(() => pickTitleModel(empty), /模型列表为空/);
});

test("写入标题要把旧值记下来，否则「还原」永远报没改过", async () => {
  // 实机（2026-10-22）：起过名之后点还原，永远得到「这段对话没有改过标题」。
  // 病根：记账那段的条件写反了，只有「没传旧标题」才记，而两个真入口都会传。
  const dataDir = mkdtempSync(path.join(tmpdir(), "zhiyi-title-test-"));
  const sdk = {
    dataDir,
    storage: { global: {
      get: async () => null,
      set: async () => {},
    } },
    bus: { request: async () => ({ ok: true, sessionId: "sess_1" }) },
  };
  // 撤回记录 2026-10-30 起落在 dataDir/runtime-state.json，不再进全局账本。
  const readUndo = () => JSON.parse(readFileSync(path.join(dataDir, "runtime-state.json"), "utf8")).titleUndo;

  await applySessionTitle(sdk, { sessionId: "sess_1", title: "新名字", previousTitle: "旧名字" });
  const record = readUndo();
  assert.equal(record.sess_1.previousTitle, "旧名字");
  assert.equal(record.sess_1.currentTitle, "新名字");

  // 确实没有旧标题时记 null（表示从没起过），不能因此就不记。
  await applySessionTitle(sdk, { sessionId: "sess_2", title: "另一段", previousTitle: "" });
  assert.equal(readUndo().sess_2.previousTitle, "");
});

// ── 2026-11-04 起名取料改造：从「按条数截断」改成「按回合收实质发言」──

test("带附件包装的用户消息不再整条判空", () => {
  assert.equal(stripAttachmentWrapper("[SessionFile] {fileId:\"sf_1\"} 帮我看看这个面板"), "帮我看看这个面板");
  assert.equal(cleanContextText('[attached_image: a.png] 这张图歪了'), "这张图歪了");
  assert.equal(cleanContextText('<file name="a.png">xx</file>截图没截全'), "截图没截全");
  // 别的未闭合标签照旧整条丢，注入哨兵不能因为这次改造被拆掉。
  assert.equal(cleanContextText("[hana_reference]一大段"), "");
});

test("发言开头的会话编号不进语料", () => {
  assert.equal(
    cleanContextText("sess_0mw0epz2i_70c6de51dde73f4e7e70 小花你读下这个窗口然后继续哈"),
    "小花你读下这个窗口然后继续哈",
  );
});

test("取样要盖住整个窗口：开头、中段、最近都有份，空的工具轮不占名额", () => {
  const messages = [];
  for (let turn = 0; turn < 10; turn++) {
    messages.push({ role: "user", content: `第${turn}轮的要求` });
    messages.push({ role: "assistant", content: "" });
    messages.push({ role: "assistant", content: `第${turn}轮的过程` });
    messages.push({ role: "assistant", content: "" });
    messages.push({ role: "assistant", content: `第${turn}轮的结论` });
  }
  const texts = selectTitleMessages(messages).map((m) => m.content);
  assert.ok(texts.some((text) => text.startsWith("第0轮")), "开头要有");
  assert.ok(
    texts.some((text) => text.startsWith("第2轮")) || texts.some((text) => text.startsWith("第5轮")),
    "中段要有",
  );
  assert.ok(texts.some((text) => text.startsWith("第9轮")), "最近要有");
  assert.ok(!texts.some((text) => text === ""), "空消息不许占位");
  // 顺序必须是时间正序，模型才知道哪头是现在
  const order = texts.map((text) => Number(text.match(/第(\d+)轮/)[1]));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("最近几轮完整展开，单轮也最多留最后三条助手发言", () => {
  const messages = [
    { role: "user", content: "帮我改面板" },
    ...["a1", "a2", "a3", "a4", "a5"].map((text) => ({ role: "assistant", content: text })),
  ];
  const picked = selectTitleMessages(messages, { segments: 1, tailTurns: 1 });
  assert.deepEqual(picked.map((m) => m.content), ["帮我改面板", "a3", "a4", "a5"]);
});

test("一轮干到底的超长任务：助手发言要在整轮里等距抽，不能只看最后几步", () => {
  const messages = [{ role: "user", content: "把这个功能做完" }];
  for (let i = 0; i < 40; i++) messages.push({ role: "assistant", content: `第${i}步的结论` });
  const picked = selectTitleMessages(messages, { segments: 1, tailTurns: 1 });
  const texts = picked.filter((m) => m.role === "assistant").map((m) => m.content);
  assert.ok(texts.length > 3, "长轮不能只给最后三条");
  assert.ok(texts.includes("第0步的结论"), "开头要抽到");
  assert.ok(texts.includes("第39步的结论"), "最后一步要在");
  assert.ok(texts.some((text) => /^第(1\d|2\d)步/.test(text)), "中段要抽到");
});

test("session:entries 的原始条目能投影成对话消息", () => {
  const entries = [
    { type: "session", id: "s0" },
    { type: "message", message: { role: "user", content: "改面板" } },
    { type: "message", message: { role: "toolResult", content: "一大段工具输出" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "改好了" }] } },
    { type: "custom_message", content: "内部条目" },
  ];
  assert.deepEqual(projectSessionEntries(entries), [
    { role: "user", content: "改面板" },
    { role: "assistant", content: [{ type: "text", text: "改好了" }] },
  ]);
  assert.deepEqual(projectSessionEntries(null), []);
});

test("指纹随最后一条消息变，没新消息就不变", () => {
  const one = [{ role: "user", content: "改面板" }];
  const two = [{ role: "user", content: "改面板" }, { role: "assistant", content: "改好了" }];
  assert.notEqual(titleFingerprint(one), titleFingerprint(two));
  assert.equal(titleFingerprint(one), titleFingerprint([{ role: "user", content: "改面板" }]));
});

test("提示词要求盖住整段对话并列了禁词", () => {
  const prompt = buildTitlePrompt("用户: 昨天聊天气\n用户: 今天改标题取样逻辑");
  assert.match(prompt, /要盖住整段对话/);
  assert.match(prompt, /不是只看最后几轮/);
  assert.match(prompt, /不要出现这些词：继续、对话、窗口/);
  assert.match(prompt, /要写出具体在做的东西/);
});

test("同一段对话没新消息时直接回缓存的名字", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "zhiyi-title-cache-"));
  writeFileSync(
    path.join(dataDir, "runtime-state.json"),
    JSON.stringify({
      titleCache: {
        sess_1: { fingerprint: "1:改面板", title: "面板倒计时", at: new Date().toISOString() },
        sess_2: { fingerprint: "1:旧", title: "过期名字", at: "2020-01-01T00:00:00.000Z" },
      },
    }),
    "utf8",
  );
  const sdk = { dataDir };
  const hit = await readTitleCache(sdk, "sess_1", "1:改面板");
  assert.equal(hit.title, "面板倒计时");
  assert.equal(await readTitleCache(sdk, "sess_1", "2:后来又聊了几句"), null, "有新消息就不能拿旧名");
  assert.equal(await readTitleCache(sdk, "sess_2", "1:旧"), null, "太旧的缓存不要");
  assert.equal(await readTitleCache(sdk, "sess_9", "1:改面板"), null);
});
