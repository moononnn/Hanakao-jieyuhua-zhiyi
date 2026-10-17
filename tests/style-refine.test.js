import test from "node:test";
import assert from "node:assert/strict";
import {
  STYLE_LIMITS,
  applyDrops,
  buildRefineMaterial,
  createDraft,
  diffStyles,
  isDraftAlive,
  parseRefinePlan,
  reselectStyles,
  restoreDefaultStyles,
  styleKey,
  validatePlanStyles,
} from "../lib/style-refine.js";

const config = {
  display: "card",
  timing: "judge",
  count: 3,
  sendMode: "copy",
  styles: [
    { name: "追问/延伸", intent: "顺着话题往下问一句" },
    { name: "分享/感慨", intent: "分享自己的感受" },
    { name: "行动/请求", intent: "让伙伴帮忙做点什么" },
  ],
  selectedByCount: { 2: [0, 1], 3: [0, 1, 2], 4: [0, 1, 2] },
};

test("材料里要摊开当前清单、条数与诉求，不能只丢一句话", () => {
  const material = buildRefineMaterial(config, { request: "想让它少问点，多说点自己的事" });
  assert.match(material, /追问\/延伸/);
  assert.match(material, /每次给 3 条/);
  assert.match(material, /想让它少问点/);
  assert.match(material, /"reply"/);
});

test("模型回包解析：认 JSON、限条数、去重、拒绝半截清单", () => {
  const ok = parseRefinePlan('好的\n{"reply":"换了一下","styles":[{"name":"自嘲","intent":"拿自己开玩笑"},{"name":"冷知识","intent":"丢一个有趣的事实"},{"name":"自嘲","intent":"拿自己开玩笑"}]}');
  assert.equal(ok.ok, true);
  assert.equal(ok.styles.length, 2, "重复项要去掉");
  assert.equal(ok.reply, "换了一下");

  assert.match(parseRefinePlan("随便说点").error, /JSON/);
  assert.match(parseRefinePlan('{"styles":[{"name":"只有一条","intent":"x"}]}').error, /至少要留/);
  assert.match(parseRefinePlan(`{"styles":[${Array.from({ length: 9 }, (_, i) => `{"name":"n${i}","intent":"i"}`).join(",")}]}`).error, /最多 6 条/);
  assert.equal(parseRefinePlan("").ok, false);
});

test("逐条对照分得清：保留、改过、新增", () => {
  const diff = diffStyles(config, [
    { name: "追问/延伸", intent: "顺着话题往下问一句" },
    { name: "分享/感慨", intent: "分享自己的感受" },
    { name: "行动/请求", intent: "让伙伴帮忙做点什么" },
    { name: "自嘲", intent: "拿自己开玩笑" },
  ]);
  assert.deepEqual(diff.map((item) => item.action), ["keep", "keep", "keep", "add"]);

  const changed = diffStyles(config, [
    { name: "分享/感慨", intent: "更主动地说说自己的感受和近况" },
    { name: "行动/请求", intent: "让伙伴帮忙做点什么" },
  ]);
  assert.equal(changed[0].action, "update");
  assert.equal(changed[0].before.intent, "分享自己的感受");
});

test("名字一样意图变了也算「改过」——那正是用户要看的差别", () => {
  const diff = diffStyles(config, [{ name: "追问/延伸", intent: "改成不再追问" }, { name: "分享/感慨", intent: "分享自己的感受" }]);
  assert.equal(diff[0].action, "update");
  assert.equal(styleKey({ name: "追问/延伸", intent: "顺着话题往下问一句" }) === styleKey({ name: "追问/延伸", intent: "改成不再追问" }), false);
});

test("丢掉几条后不足两条就不让落盘，并说清原因", () => {
  const plan = diffStyles(config, [
    { name: "追问/延伸", intent: "顺着话题往下问一句" },
    { name: "分享/感慨", intent: "分享自己的感受" },
    { name: "自嘲", intent: "拿自己开玩笑" },
  ]);
  const kept = applyDrops(plan, [plan[0].key, plan[1].key]);
  const check = validatePlanStyles(kept);
  assert.equal(check.ok, false);
  assert.match(check.error, /只剩 1 条/);

  const ok = validatePlanStyles(applyDrops(plan, [plan[0].key]));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.styles[0], { name: "分享/感慨", intent: "分享自己的感受" });
  assert.match(validatePlanStyles([{ name: "甲", intent: "a" }, { name: "乙", intent: "b" }, { name: "", intent: "x" }]).error, /没有名字/);
});

test("落盘前会拦重复项与超长项", () => {
  assert.match(validatePlanStyles([{ name: "a", intent: "1" }, { name: "a", intent: "1" }]).error, /重复/);
  assert.equal(validatePlanStyles([
    { name: "1", intent: "x" }, { name: "2", intent: "x" }, { name: "3", intent: "x" },
    { name: "4", intent: "x" }, { name: "5", intent: "x" }, { name: "6", intent: "x" }, { name: "7", intent: "x" },
  ]).ok, false);
});

test("换了清单要重算勾选，不能留指向旧下标的勾选", () => {
  const next = reselectStyles(config, [{ name: "甲", intent: "a" }, { name: "乙", intent: "b" }]);
  assert.deepEqual(next.selectedByCount["3"], [0, 1, 0]);
  assert.deepEqual(next.styles.map((s) => s.name), ["甲", "乙"]);
  assert.equal(STYLE_LIMITS.max, 6);
});

test("草稿有寿命，过期的不算还能应用", () => {
  const now = 1_000_000;
  const draft = createDraft({ reply: "换了一下", styles: [{ name: "甲", intent: "a" }, { name: "乙", intent: "b" }] }, now);
  assert.equal(isDraftAlive(draft, now + 1000), true);
  assert.equal(isDraftAlive(draft, now + 40 * 60 * 1000), false);
  assert.equal(isDraftAlive(null, now), false);
  assert.equal(draft.items.length, 2);
  assert.equal(draft.items[0].key, styleKey({ name: "甲", intent: "a" }));
});

test("恢复默认是把默认清单装回去并重算勾选", () => {
  const changed = { ...config, styles: [{ name: "自嘲", intent: "a" }, { name: "冷知识", intent: "b" }] };
  const restored = restoreDefaultStyles(changed);
  assert.equal(restored.styles.length, 4);
  assert.equal(restored.styles[0].name, "追问/延伸");
  assert.deepEqual(restored.selectedByCount["3"], [0, 1, 2]);
});
