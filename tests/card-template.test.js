import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';

const source = new URL('../recipes/zhiyi-ask/assets/ask.card.html', import.meta.url);

class FakeElement {
  constructor() { this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.disabled = false; this.hidden = false; this.textContent = ''; this.value = ''; }
  append(...items) { this.children.push(...items); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  click() { if (!this.disabled) this.listeners.get('click')?.({ target: this }); }
}

test('recipe template is self-contained, has a readable snapshot and valid client JavaScript', async () => {
  const html = await readFile(source, 'utf8');
  assert.match(html, /data-card-manifest/);
  assert.match(html, /data-card-state/);
  const initial = JSON.parse(html.match(/<script type="application\/json" data-card-state>([\s\S]*?)<\/script>/)[1]);
  assert.ok(initial.title && initial.question);
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .filter(([tag]) => !tag.includes('type="application/json"'));
  assert.equal(scripts.length, 1);
  new Script(scripts[0][1]);
  assert.match(scripts[0][1], /card\.emit\('zhiyi_ask_answer'/);
  assert.match(scripts[0][1], /data\.onChange\(applyData\)/);
  assert.match(scripts[0][1], /data\.ready!==true/);
  assert.match(scripts[0][1], /Date\.now\(\)>=snapshot\.expiresAt/);
  assert.match(scripts[0][1], /snapshot\.selectionMode==='multiple'/);
  assert.match(scripts[0][1], /aria-checked/);
  assert.match(scripts[0][1], /selected\.size<minSelections/);
  assert.match(scripts[0][1], /confirm\.addEventListener\('click'/);
});

test('multi-select recipe waits for confirmation and emits the selected labels as an array', async () => {
  const html = await readFile(source, 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .find(([tag]) => !tag.includes('type="application/json"'))[1];
  const state = {
    askId: 'multi-ask', title: '选择偏好', question: '需要哪些功能？', background: '', recommendation: '', reason: '',
    selectionMode: 'multiple', minSelections: 1, maxSelections: 2, expiresAt: Date.now() + 60_000,
    options: [{ label: '同步' }, { label: '加密' }, { label: '导出' }],
  };
  const elements = new Map();
  const document = {
    querySelector: () => ({ textContent: JSON.stringify(state) }),
    getElementById: (id) => { if (!elements.has(id)) elements.set(id, new FakeElement()); return elements.get(id); },
    createElement: () => new FakeElement(),
  };
  let emitted = null;
  const window = {
    card: {
      capabilities: async () => ({ ok: true, result: { capabilities: { emit: 'available' } } }),
      data: { get: async () => ({ ok: true, result: { data: { askId: 'multi-ask', ready: true, homeSessionId: 'session-1' } } }), onChange() {} },
      state: { get: async () => ({ ok: true, result: { value: false } }), set: async () => ({ ok: true }) },
      emit: async (...args) => { emitted = args; return { ok: true }; },
    },
  };
  new Script(script).runInNewContext({ document, window, Date, Set, Number, Array, String, Promise });
  await new Promise((resolve) => setImmediate(resolve));
  const buttons = elements.get('options').children;
  buttons[0].click();
  buttons[1].click();
  assert.equal(emitted, null, 'checking options must not submit before confirmation');
  buttons[2].click();
  assert.match(elements.get('status').textContent, /最多选择 2 项/);
  elements.get('confirm').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(emitted[0], 'zhiyi_ask_answer');
  assert.deepEqual(Array.from(emitted[1].choice), ['同步', '加密']);
  assert.equal(emitted[2], 'session-1');
});
