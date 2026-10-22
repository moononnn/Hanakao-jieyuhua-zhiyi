import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardAskRegistry } from '../lib/card-handoff.js';
import { normalizeAskRequest } from '../lib/ask.js';

const request = normalizeAskRequest({
  title: '选择方案', question: '先做什么？', options: ['先做 A', '先做 B'],
});
const cardId = 'c_probe_1_abcd';
function fixture() {
  let time = 1_000_000;
  let serial = 0;
  return { registry: createCardAskRegistry({ now: () => time, newId: () => `ask-${++serial}` }), advance: (ms) => { time += ms; } };
}

test('binds one minted card to its source session; refuses wrong card/session/choice', () => {
  const { registry } = fixture();
  const pending = registry.prepare(request, 'sessions/a.jsonl');
  assert.throws(() => registry.prepare(request, 'sessions/a.jsonl'), /已有一题/);
  assert.equal(registry.bind({ askId: pending.askId, sessionPath: 'sessions/b.jsonl', cardId }).ok, false);
  assert.equal(registry.bind({ askId: pending.askId, sessionPath: 'sessions/a.jsonl', cardId }).ok, true);
  assert.equal(registry.bind({ askId: pending.askId, sessionPath: 'sessions/a.jsonl', cardId: 'c_other_2_abcd' }).ok, false);
  assert.equal(registry.resolve({ askId: pending.askId, sessionPath: 'sessions/b.jsonl', cardId, choice: '先做 A' }).ok, false);
  assert.equal(registry.resolve({ askId: pending.askId, sessionPath: 'sessions/a.jsonl', cardId: 'c_other_2_abcd', choice: '先做 A' }).ok, false);
  assert.equal(registry.resolve({ askId: pending.askId, sessionPath: 'sessions/a.jsonl', cardId, choice: '伪造选项' }).ok, false);
  const accepted = registry.resolve({ askId: pending.askId, sessionPath: 'sessions/a.jsonl', cardId, choice: '先做 A', note: '先验输入' });
  assert.equal(accepted.ok, true);
  assert.match(accepted.text, /先验输入/);
  assert.equal(registry.resolve({ askId: pending.askId, sessionPath: 'sessions/a.jsonl', cardId, choice: '先做 B' }).ok, false);
});

test('validates and returns multiple selections as one bound answer', () => {
  const { registry } = fixture();
  const multiple = normalizeAskRequest({
    title: '选择偏好', question: '哪些功能都要？', options: ['同步', '加密', '导出'],
    selectionMode: 'multiple', minSelections: 2, maxSelections: 2,
  });
  const pending = registry.prepare(multiple, 'sessions/a.jsonl');
  registry.bind({ askId: pending.askId, sessionPath: 'sessions/a.jsonl', cardId });
  assert.equal(registry.resolve({ askId: pending.askId, sessionPath: 'sessions/a.jsonl', cardId, choice: ['同步'] }).ok, false);
  const accepted = registry.resolve({ askId: pending.askId, sessionPath: 'sessions/a.jsonl', cardId, choice: ['同步', '导出'], note: '仅在本地执行' });
  assert.equal(accepted.ok, true);
  assert.match(accepted.text, /- 同步\n- 导出/);
  assert.match(accepted.text, /补充：仅在本地执行/);
  assert.equal(registry.resolve({ askId: pending.askId, sessionPath: 'sessions/a.jsonl', cardId, choice: ['加密', '导出'] }).ok, false);
});

test('expiry, cancellation and restart fail closed; no default choice', () => {
  const { registry, advance } = fixture();
  const pending = registry.prepare(request, 'sessions/a.jsonl');
  advance(600_000);
  assert.equal(registry.bind({ askId: pending.askId, sessionPath: 'sessions/a.jsonl', cardId }).ok, false);
  const next = registry.prepare(request, 'sessions/a.jsonl');
  assert.equal(registry.cancel({ askId: next.askId, sessionPath: 'sessions/b.jsonl' }), false);
  assert.deepEqual(registry.cancel({ askId: next.askId, sessionPath: 'sessions/a.jsonl' }), request);
  assert.equal(registry.bind({ askId: next.askId, sessionPath: 'sessions/a.jsonl', cardId }).ok, false);
  assert.equal(createCardAskRegistry().resolve({ askId: pending.askId, sessionPath: 'sessions/a.jsonl', cardId, choice: '先做 A' }).ok, false);
});

test('custom answer is distinct; rejection and duplicate never authorize a choice', () => {
  const { registry } = fixture();
  const first = registry.prepare(request, 'sessions/a.jsonl');
  registry.bind({ askId: first.askId, sessionPath: 'sessions/a.jsonl', cardId });
  assert.equal(registry.resolve({ askId: first.askId, sessionPath: 'sessions/a.jsonl', cardId, action: 'custom', choice: '另做 C' }).ok, true);
  const second = registry.prepare(request, 'sessions/a.jsonl');
  registry.bind({ askId: second.askId, sessionPath: 'sessions/a.jsonl', cardId: 'c_probe_2_abcd' });
  const declined = registry.resolve({ askId: second.askId, sessionPath: 'sessions/a.jsonl', cardId: 'c_probe_2_abcd', action: 'rejected' });
  assert.equal(declined.ok, true);
  assert.match(declined.text, /暂不作此选择/);
  assert.equal(registry.resolve({ askId: second.askId, sessionPath: 'sessions/a.jsonl', cardId: 'c_probe_2_abcd', choice: '先做 A' }).ok, false);
});
