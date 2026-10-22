import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 2026-10-20 实机事故：用户在 Ask 卡里选了「两边同步手动排序」并点了确认发送，
// 事件已经带完整 payload 回到原对话，但伙伴按配方第 4 条先做 ui_inspect 核验，
// 宿主对「已发出事件、不再是 open instance」的对话内嵌卡回 CARD_NOT_FOUND，
// 伙伴就误判成没收到，把有效选择扔掉，改口要用户手打一遍。
// 回归点：核验的唯一裁判必须是 resolve_card，ui_inspect 只是可选旁证。
const recipe = new URL('../recipes/zhiyi-ask/SKILL.md', import.meta.url);
const handoff = new URL('../skills/zhiyi-ask-handoff/SKILL.md', import.meta.url);
const entry = new URL('../index.js', import.meta.url);

test('recipe hands the answer straight to resolve_card instead of gating on ui_inspect', async () => {
  const text = await readFile(recipe, 'utf8');
  assert.match(text, /`jiegehua_zhiyi_resolve_card`/, '配方必须点名 resolve_card');
  assert.match(text, /唯一裁判/, '必须写明 resolve_card 是有效性的唯一裁判');
  assert.match(text, /不在 open instances/, '必须解释 CARD_NOT_FOUND 不等于没收到选择');
  assert.doesNotMatch(text, /如果卡片已关闭或来源不符，停止/, '不能再把“卡片已关闭”当成停止条件');
});

test('handoff skill tells the partner not to drop a delivered choice', async () => {
  const text = await readFile(handoff, 'utf8');
  assert.match(text, /唯一裁判/);
  assert.match(text, /open instances/);
});

test('resolve tool description no longer makes ui_inspect a precondition', async () => {
  const text = await readFile(entry, 'utf8');
  const at = text.indexOf('收到知意 Ask 卡片的真实点击事件');
  assert.ok(at > 0, 'resolve 工具必须仍然注册');
  const around = text.slice(Math.max(0, at - 200), at + 1200);
  assert.match(around, /唯一裁判|自行核验/, '工具描述要说清由它自己核验');
  assert.doesNotMatch(around, /用 ui_inspect 核验来源后调用/, '不能再要求先 ui_inspect 才调用');
});
