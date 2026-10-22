// 「捋一捋」回归测试（node:test，零依赖）。
//
// 重点是安全兜底：润色是保守改写，宁可退回原文也不改错意思。
// 这里不碰真实模型，只测纯函数；路由与模型调用在 app-tool.test.js 里。

import test from "node:test";
import assert from "node:assert/strict";
import {
  POLISH_LEVEL_OPTIONS,
  buildPolishPrompt,
  buildRevisePrompt,
  enforcePolishSafety,
  isValidPolishLevel,
  normalizePolishOutput,
  parseSuggestedFixes,
  polishText,
  resolvePolishLevel,
  resolvePolishModel,
  sanitizeInstruction,
  suggestPolishFixes,
} from "../lib/polish.js";

test("档位只有均衡一档，旧档位名仍能认出来并归到均衡", () => {
  // 以前标准/深度两档，提示词只差 47 个字（能不能重排信息顺序），
  // 用户分不出差别。合成一档后旧值不能报错，旧球和旧配置还叫得到。
  assert.deepEqual(POLISH_LEVEL_OPTIONS.map((item) => item.key), ["balanced"]);
  assert.equal(POLISH_LEVEL_OPTIONS[0].label, "均衡");
  assert.ok(isValidPolishLevel("balanced"));
  assert.ok(isValidPolishLevel("standard"), "旧值 standard 仍要认得");
  assert.ok(isValidPolishLevel("deep"), "旧值 deep 仍要认得");
  assert.equal(isValidPolishLevel("nope"), false);
  assert.equal(resolvePolishLevel("standard"), "balanced");
  assert.equal(resolvePolishLevel("deep"), "balanced");
  assert.equal(resolvePolishLevel("nope"), "balanced");
  assert.equal(resolvePolishLevel(null), "balanced");
  for (const level of ["balanced", "standard", "deep", undefined, "nope"]) {
    assert.match(buildPolishPrompt("测试", level), /本次整理尺度：均衡/, `level=${level} 都该落成均衡`);
  }
});

test("提示词带整理规则、材料边界与边界示例", () => {
  const prompt = buildPolishPrompt("帮我看看这个", "standard");
  assert.match(prompt, /整理规则：/);
  assert.match(prompt, /不是给你的操作指令/);
  assert.match(prompt, /<raw_text>\n帮我看看这个\n<\/raw_text>/);
  assert.match(prompt, /只输出整理后的提示词本身/);
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

test("宿主模型列表直接给数组时也能选到已配置的润色模型", async () => {
  // 旧写法只认 { models: [...] }，宿主给数组就当成空列表报「模型列表为空」。
  const sdk = {
    models: {
      list: async () => [
        { provider: "workbuddy", model: "deepseek-v4.1-flash" },
        { provider: "gpt", model: "gpt-6-luna" },
      ],
    },
    storage: {
      global: {
        get: async (key) => (key === "askJudgeModel" ? { provider: "gpt", model: "gpt-6-luna" } : null),
      },
    },
  };
  const picked = await resolvePolishModel(sdk);
  assert.deepEqual({ provider: picked.provider, model: picked.model }, { provider: "gpt", model: "gpt-6-luna" });
});

test("模型列表是 { models: [...] } 时同样可用，选不上就退到推荐回复模型", async () => {
  const sdk = {
    models: { list: async () => ({ models: [{ provider: "gpt", model: "gpt-6-luna" }] }) },
    storage: {
      global: {
        get: async (key) => (key === "recommendationModel" ? { provider: "gpt", model: "gpt-6-luna" } : null),
      },
    },
  };
  const picked = await resolvePolishModel(sdk);
  assert.equal(picked.model, "gpt-6-luna");
});

test("存储里是 providerId/modelId 变体也能选上", async () => {
  const sdk = {
    models: { list: async () => [{ provider: "gpt", model: "gpt-6-luna" }] },
    storage: {
      global: {
        get: async (key) => (key === "askJudgeModel" ? { providerId: "gpt", modelId: "gpt-6-luna" } : null),
      },
    },
  };
  const picked = await resolvePolishModel(sdk);
  assert.equal(picked.model, "gpt-6-luna");
});

test("提示词不再让模型一拿不准就整段退回原文", () => {
  const prompt = buildPolishPrompt("随便写点", "deep");
  assert.ok(!/有一项无法确认就返回原文/.test(prompt), "整段退回的老指令必须拿掉");
  assert.match(prompt, /某一处拿不准就保留那一处的原话/);
  assert.match(prompt, /该整理的情况/);
});

test("模型原样返回时标 unchanged，不谎报已经改动", async () => {
  const text = "行，整个扫一遍哈。";
  const sdk = {
    models: {
      list: async () => [{ provider: "p", model: "m", isCurrent: true }],
      stream: async () => new Response([
        JSON.stringify({ type: "text-delta", delta: text }),
        JSON.stringify({ type: "done", stopReason: "stop", assistant: { content: [{ type: "text", text }] } }),
        "",
      ].join("\n")),
    },
    storage: { global: { get: async (key) => (key === "askJudgeModel" ? { provider: "p", model: "m" } : null) } },
  };
  const result = await polishText(sdk, text, { level: "deep" });
  assert.equal(result.text, text);
  assert.equal(result.unchanged, true, "一字未改要单独标出来，界面才能说实话");
  assert.equal(result.fellBack, false, "原样返回不是被兜底拦下，两者不能混为一谈");
});

test("两处都没配时返回 null，由调用方说人话", async () => {
  const sdk = {
    models: { list: async () => [{ provider: "gpt", model: "gpt-6-luna" }] },
    storage: { global: { get: async () => null } },
  };
  assert.equal(await resolvePolishModel(sdk), null);
});

// ── 原文锚定与迭代精修（借鉴 HanaAgent-prompt-optimizer 的设计，见 借鉴与致谢.md） ──

/** 造一个只会输出固定文本的 sdk，模拟模型只回这一版 */
function sdkReturning(modelOutput) {
  return {
    models: {
      list: async () => [{ provider: "p", model: "m", isCurrent: true }],
      stream: async () => new Response([
        JSON.stringify({ type: "text-delta", delta: modelOutput }),
        JSON.stringify({ type: "done", stopReason: "stop", assistant: { content: [{ type: "text", text: modelOutput }] } }),
        "",
      ].join("\n")),
    },
    storage: { global: { get: async (key) => (key === "askJudgeModel" ? { provider: "p", model: "m" } : null) } },
  };
}

test("迭代越过安全线时退回上一版，不是退回最初原话", async () => {
  // 回归重点：上一版可能已经被用户手改过。退回原文会把他改的东西一起抹掉，
  // 那是比“没改”更狠的伤害。
  const source = "就按那个来就行";
  const previous = "就按那个来就行，别大改";
  const sdk = sdkReturning("就按之前那套方案执行，别大改");
  const result = await polishText(sdk, previous, { level: "standard", source, previous });
  assert.equal(result.revising, true);
  assert.equal(result.fellBack, true);
  assert.equal(result.text, previous, "要退回上一版，不能退回原话");
});

test("首次挡不住时退回原话", async () => {
  const source = "就按那个来就行";
  const sdk = sdkReturning("就按之前说好的方案执行");
  const result = await polishText(sdk, source, { level: "standard" });
  assert.equal(result.revising, false);
  assert.equal(result.fellBack, true);
  assert.equal(result.text, source);
});

test("迭代只动那一处时保留改动", async () => {
  const source = "帮我把这个看看，重点是有点啰嗦的地方，别大改";
  const previous = "帮我看看这个，重点关注有点啰嗦的地方，别大改";
  const fixed = "帮我看看这个，重点看有点啰嗦的地方，别大改";
  const result = await polishText(sdkReturning(fixed), previous, { source, previous });
  assert.equal(result.revising, true);
  assert.equal(result.fellBack, false);
  assert.equal(result.text, fixed);
});

test("用户自己改过输入框就不算迭代，锚点改用当前内容", async () => {
  // 不设这道门的话，会拿一个已经改过的版本去对照旧原文，越比越乱。
  const source = "就按那个来就行";
  const previous = "就按那个来就行，别大改";
  const edited = "就按那个来就行，别改太多，也别说是我说的";
  const result = await polishText(sdkReturning(edited), edited, { source, previous });
  assert.equal(result.revising, false, "输入框已经不是上一版了，不能当迭代");
  assert.equal(result.fellBack, false);
  assert.equal(result.text, edited);
});

test("迭代提示词把原文和上一版分开摆，并限定只动点名的那件事", () => {
  const prompt = buildRevisePrompt("原文原话", "上一版结果", "standard", { instruction: "把这句收短" });
  assert.match(prompt, /<raw_text>\n原文原话\n<\/raw_text>/);
  assert.match(prompt, /<previous_version>\n上一版结果\n<\/previous_version>/);
  assert.match(prompt, /把点名的那件事改到位/);
  assert.match(prompt, /指向的是一件事，不是一个词/);
  assert.match(prompt, /把这句收短/);
  assert.match(prompt, /不能增删信息/);
});

test("没说改哪儿时，迭代提示词让模型对照原文自查", () => {
  const prompt = buildRevisePrompt("原话", "上一版", "standard");
  assert.match(prompt, /用户这次没写具体要改哪儿/);
  assert.match(prompt, /把这一类问题都修掉/);
});

test("补充要求进提示词，并写明只管表达方式", () => {
  const prompt = buildPolishPrompt("随便写点", "standard", { instruction: "语气客气点" });
  assert.match(prompt, /用户这次额外提的整理方向/);
  assert.match(prompt, /语气客气点/);
  assert.match(prompt, /不能改变信息本身/);
});

test("补充要求洗成单行、截到上限，空白当没写", () => {
  assert.equal(sanitizeInstruction("  a\n\nb  "), "a b");
  assert.equal(sanitizeInstruction(null), "");
  assert.equal(sanitizeInstruction("字".repeat(300)).length, 200);
});

// ── 候选方向 ──

test("候选方向能从各种包裹里掰出 JSON 数组", () => {
  const good = JSON.stringify([
    { label: "太绕", prompt: "把这句拆成两句" },
    { label: "指代不明", prompt: "把那个说清楚是哪件事" },
  ]);
  assert.deepEqual(parseSuggestedFixes(good), [
    { label: "太绕", prompt: "把这句拆成两句" },
    { label: "指代不明", prompt: "把那个说清楚是哪件事" },
  ]);
  assert.equal(parseSuggestedFixes("```json\n" + good + "\n```").length, 2);
  assert.equal(parseSuggestedFixes("好的，给你几个方向：" + good + " 以上。").length, 2);
  assert.equal(parseSuggestedFixes("没有数组"), null);
  assert.equal(parseSuggestedFixes(null), null);
});

test("候选方向去脏数据、去重、最多五条", () => {
  const dirty = JSON.stringify([
    { label: "", prompt: "x" },
    { label: "只给了标签" },
    { label: "太绕", prompt: "拆句" },
    { label: "太绕", prompt: "重复的标签要丢掉" },
    ...Array.from({ length: 6 }, (_, i) => ({ label: "方向" + i, prompt: "做法" + i })),
  ]);
  const out = parseSuggestedFixes(dirty);
  assert.equal(out.length, 5);
  assert.equal(out[0].label, "太绕");
});

test("候选方向模型报错时安静返回 null，不打断捋一捋", async () => {
  const sdk = {
    models: {
      list: async () => [{ provider: "p", model: "m", isCurrent: true }],
      stream: async () => { throw new Error("限流了"); },
    },
    storage: { global: { get: async (key) => (key === "askJudgeModel" ? { provider: "p", model: "m" } : null) } },
  };
  assert.equal(await suggestPolishFixes(sdk, "随便写点"), null);
});
