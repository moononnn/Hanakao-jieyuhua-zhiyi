import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { VOICE_STYLE } from "../lib/voice-style.js";
import { CHAT_SYSTEM } from "../lib/handbook-chat.js";
import { CARD_SYSTEM } from "../lib/handbook-cards.js";
import { buildChatSystem } from "../lib/style-refine.js";

// 口吻统一的看门测试：共享常量在、五个窗口都真的用了它、旧的那几段没留在原处。
// market-review 的 SYSTEM 和 feedback-chat 的 SYSTEM_PROMPT 没导出，这两处看源码文本。

const read = (relative) => fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const VOICE_FILE = "lib/voice-style.js";
const CALL_SITES = [
  "lib/market-review.js",
  "lib/handbook-chat.js",
  "lib/handbook-cards.js",
  "lib/feedback-chat.js",
  "lib/style-refine.js",
];

// 各窗口自己的领域规则：换口吻时这些不许跟着消失，否则等于把约束一起改掉了。
const DOMAIN_RULES = {
  "lib/market-review.js": "不许这样回答",
  "lib/handbook-chat.js": "回答只依据给你的更新说明原文",
  "lib/handbook-cards.js": "输出只有一个 JSON 数组",
  "lib/feedback-chat.js": "只输出 JSON",
  "lib/style-refine.js": "第二轮必须出清单",
};

const config = {
  display: "card",
  timing: "judge",
  count: 3,
  styles: [{ name: "追问/延伸", intent: "顺着话题往下问一句" }],
  selectedByCount: { 2: [0], 3: [0], 4: [0] },
};

test("voice-style.js 导出共享口吻，三句都在", () => {
  const source = read(VOICE_FILE);
  assert.match(source, /export const VOICE_STYLE/);
  assert.equal(typeof VOICE_STYLE, "string");
  assert.ok(VOICE_STYLE.length > 300, "常量太短，像是被截断了");
  assert.match(VOICE_STYLE, /^风格：/);
  assert.match(VOICE_STYLE, /^语气：/m);
  assert.match(VOICE_STYLE, /^语气参考（照这个密度说话，不多不少）：/m);
});

test("关键口径标记留在常量里", () => {
  assert.match(VOICE_STYLE, /不端、不贫/);
  assert.match(VOICE_STYLE, /先甩判断再补细节/);
  assert.match(VOICE_STYLE, /态度只朝事、不朝人/);
  assert.match(VOICE_STYLE, /推断必须说成推断/);
});

test("共享常量里不夹带某个窗口自己的领域词", () => {
  for (const word of ["审查", "安装", "更新说明", "应用雷达", "待审", "卡片"]) {
    assert.ok(!VOICE_STYLE.includes(word), `共享口吻里出现了窗口专属词「${word}」`);
  }
});

test("五个调用点都 import 了 voice-style 并用到 VOICE_STYLE", () => {
  for (const file of CALL_SITES) {
    const source = read(file);
    assert.match(source, /import \{ VOICE_STYLE \} from "\.\/voice-style\.js";/, `${file} 没有 import 共享口吻`);
    const body = source.replace(/^import .*voice-style\.js.*$/m, "");
    assert.ok(body.includes("VOICE_STYLE"), `${file} import 了但没用上`);
  }
});

test("提示词里真的拼进了共享口吻", () => {
  assert.ok(CHAT_SYSTEM.includes(VOICE_STYLE), "更新追问的提示词没拼进去");
  assert.ok(CARD_SYSTEM.includes(VOICE_STYLE), "卡片提示词没拼进去");
  assert.ok(buildChatSystem(config).includes(VOICE_STYLE), "方向对话的提示词没拼进去");
  assert.match(read("lib/market-review.js"), /^ {2}VOICE_STYLE,$/m);
  assert.match(read("lib/feedback-chat.js"), /^ {2}VOICE_STYLE,$/m);
});

test("旧的重复风格段没有留在任何调用点", () => {
  const residue = [
    "风格：",
    "语气：",
    "语气参考",
    "不复述问题",
    "不端、不贫",
    "先甩判断再补细节",
    "态度只朝事、不朝人",
    "语气像熟人当面讲",
    "说话像朋友",
  ];
  for (const file of CALL_SITES) {
    const source = read(file);
    for (const phrase of residue) {
      assert.ok(!source.includes(phrase), `${file} 还留着旧风格段「${phrase}」，以后会两处各改各的`);
    }
  }
});

test("各自的事实约束和边界规则还在", () => {
  for (const [file, marker] of Object.entries(DOMAIN_RULES)) {
    assert.ok(read(file).includes(marker), `${file} 丢了领域规则「${marker}」`);
  }
  // 白话与「不编」这两条最容易在搬口吻时被带走，单独盯一下。
  assert.match(read("lib/market-review.js"), /默认白话/);
  assert.match(read("lib/handbook-chat.js"), /不要用常识补/);
  assert.match(read("lib/handbook-cards.js"), /一个字都不许编/);
});
