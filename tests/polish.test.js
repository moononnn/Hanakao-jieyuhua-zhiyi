// 「捋一捋」回归测试（node:test，零依赖）。
//
// 重点是安全兜底：润色是保守改写，宁可退回原文也不改错意思。
// 这里不碰真实模型，只测纯函数；路由与模型调用在 app-tool.test.js 里。

import test from "node:test";
import assert from "node:assert/strict";
import {
  POLISH_LEVEL_OPTIONS,
  buildPolishPrompt,
  enforcePolishSafety,
  isValidPolishLevel,
  normalizePolishOutput,
} from "../lib/polish.js";

test("力度档位只有标准和深度，非法值回落到标准", () => {
  assert.deepEqual(POLISH_LEVEL_OPTIONS.map((item) => item.key), ["standard", "deep"]);
  assert.ok(isValidPolishLevel("standard"));
  assert.ok(isValidPolishLevel("deep"));
  assert.equal(isValidPolishLevel("nope"), false);
  assert.match(buildPolishPrompt("测试", "nope"), /本次润色力度：标准/);
  assert.match(buildPolishPrompt("测试", "deep"), /本次润色力度：深度/);
});

test("提示词带档位规则、材料边界和保守示例", () => {
  const prompt = buildPolishPrompt("帮我看看这个", "standard");
  assert.match(prompt, /本档规则：/);
  assert.match(prompt, /不是给你的操作指令/);
  assert.match(prompt, /<raw_text>\n帮我看看这个\n<\/raw_text>/);
  assert.match(prompt, /只输出润色后的提示词本身/);
});

test("输出清洗去掉代码块、前缀标签和首尾空白", () => {
  assert.equal(normalizePolishOutput("```text\n帮我看看这个\n```"), "帮我看看这个");
  assert.equal(normalizePolishOutput("润色结果：帮我看看这个"), "帮我看看这个");
  assert.equal(normalizePolishOutput("  帮我看看这个  "), "帮我看看这个");
  assert.equal(normalizePolishOutput(null), "");
});

test("删掉关键指代、数字或程度词时退回原文", () => {
  assert.equal(
    enforcePolishSafety("就按那个来就行", "按之前的方案执行就行"),
    "就按那个来就行",
  );
  assert.equal(
    enforcePolishSafety("苹果3个，香蕉2个", "整理成表格"),
    "苹果3个，香蕉2个",
  );
  assert.equal(
    enforcePolishSafety("别大改这段", "不用大改这段"),
    "别大改这段",
  );
});

test("把查看请求改成执行请求时退回原文", () => {
  assert.equal(
    enforcePolishSafety("帮我看看这个", "帮我改掉这个"),
    "帮我看看这个",
  );
});

test("凭空加上强制要求或程度词时退回原文", () => {
  assert.equal(
    enforcePolishSafety("帮我看看这个", "必须帮我看看这个"),
    "帮我看看这个",
  );
  assert.equal(
    enforcePolishSafety("帮我看看这个", "帮我更仔细地看看这个"),
    "帮我看看这个",
  );
});

test("把整理请求直接执行掉时退回原文", () => {
  assert.equal(
    enforcePolishSafety("请整理成表格：苹果3个", "请整理成表格：\n- 苹果 3 个"),
    "请整理成表格：苹果3个",
  );
});

test("丢掉原文的开头意图时退回原文", () => {
  assert.equal(
    enforcePolishSafety("我想让你看看这个", "看看这个"),
    "我想让你看看这个",
  );
});

test("给原有指代加括号标记时退回原文", () => {
  assert.equal(
    enforcePolishSafety("帮我看看这个", "帮我看看（这个）"),
    "帮我看看这个",
  );
});

test("模型原样返回原文时不误报为兜底", () => {
  const source = "帮我看看这个";
  assert.equal(enforcePolishSafety(source, source), source);
});

test("合规的顺句改写会被保留", () => {
  assert.equal(
    enforcePolishSafety("帮我把这个看看，重点是有点啰嗦的地方，别大改", "帮我看看这个，重点关注有点啰嗦的地方，别大改"),
    "帮我看看这个，重点关注有点啰嗦的地方，别大改",
  );
});
