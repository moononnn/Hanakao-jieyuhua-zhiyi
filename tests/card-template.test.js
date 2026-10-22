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
  assert.match(scripts[0][1], /data\.onChange\(/);
  assert.match(scripts[0][1], /async function pullData\(\)/, '必须能自己重拉 host data');
  assert.match(scripts[0][1], /setInterval\(/, '必须做有限轮询兜住启动与写入的时序差');
  // 过期判定必须先过数值归一化：宿主会把 state 里的数字写成字符串，
  // 直接拿 snapshot.expiresAt 做严格判断的模板，卡片一出生就显示「已过期」。
  assert.match(scripts[0][1], /const expiresAt=num\(snapshot\.expiresAt\)/);
  assert.match(scripts[0][1], /Date\.now\(\)>=expiresAt/);
  assert.doesNotMatch(scripts[0][1], /Date\.now\(\)>=snapshot\.expiresAt/);
  // 2026-10-20 实机：宿主写 host-data 时把 ready 存成字符串 "true"，
  // 模板用 data.ready!==true 判，卡片永远停在「正在与原对话绑定」。布尔要两种写法都认。
  assert.match(scripts[0][1], /const yes=v=>v===true\|\|v==='true'/);
  assert.doesNotMatch(scripts[0][1], /data\.ready!==true/);
  // options 被宿主套多层 {item:{item:[...]}} 时也要能拆出来。
  assert.match(scripts[0][1], /function unwrapOptions\(value\)/);
  assert.match(scripts[0][1], /unwrapOptions\(snapshot\.options\)/);
  assert.match(scripts[0][1], /snapshot\.selectionMode==='multiple'/);
  assert.match(scripts[0][1], /aria-checked/);
  assert.match(scripts[0][1], /selected\.size<minSelections/);
  assert.match(scripts[0][1], /confirm\.addEventListener\('click'/);
});

test('restored recipe keeps the original flat layout instead of hiding options in a height-limited region', async () => {
  const html = await readFile(source, 'utf8');
  assert.doesNotMatch(html, /class="(?:scroll|footer)"/);
  assert.doesNotMatch(html, /max-height:\s*(?:280|170)px|position:\s*sticky/);
});

for (const wrapped of [false, true]) test(`multi-select recipe waits for confirmation and emits an array (wrapped state: ${wrapped})`, async () => {
  const html = await readFile(source, 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .find(([tag]) => !tag.includes('type="application/json"'))[1];
  const state = {
    askId: 'multi-ask', title: '选择偏好', question: '需要哪些功能？', background: '', recommendation: '', reason: '',
    selectionMode: 'multiple', minSelections: 1, maxSelections: 2, expiresAt: Date.now() + 60_000,
    options: [{ label: '同步' }, { label: '加密' }, { label: '导出' }],
  };
  if (wrapped) {
    state.options = { item: state.options };
    state.expiresAt = String(state.expiresAt);
    state.minSelections = String(state.minSelections);
    state.maxSelections = String(state.maxSelections);
    delete state.title;
  }  const elements = new Map();
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

async function answerCard(selectionMode, { fail = false, minSelections = 1 } = {}) {
  const html = await readFile(source, 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .find(([tag]) => !tag.includes('type="application/json"'))[1];
  const state = { askId: 'combined', selectionMode, minSelections, maxSelections: 2,
    options: [{ label: '同步' }, { label: '加密' }], expiresAt: Date.now() + 60_000 };
  const elements = new Map(), emitted = [];
  const document = {
    querySelector: () => ({ textContent: JSON.stringify(state) }),
    getElementById: (id) => { if (!elements.has(id)) elements.set(id, new FakeElement()); return elements.get(id); },
    createElement: () => new FakeElement(),
  };
  const window = { card: {
    capabilities: async () => ({ ok: true, result: { capabilities: { emit: 'available' } } }),
    data: { get: async () => ({ ok: true, result: { data: { askId: 'combined', ready: true } } }), onChange() {} },
    state: { get: async () => ({ ok: true, result: { value: false } }), set: async () => ({ ok: true }) },
    emit: async (...args) => { emitted.push(args); return { ok: !fail }; },
  } };
  new Script(script).runInNewContext({ document, window, Date, Set, Number, Array, String, Promise });
  await new Promise((resolve) => setImmediate(resolve));
  return { elements, emitted, buttons: elements.get('options').children,
    fill(text) { const note = elements.get('note'); note.value = text; note.listeners.get('input')?.(); } };
}

for (const mode of ['single', 'multiple']) {
  test(`${mode} card sends selected options together with supplementary text after confirmation`, async () => {
    const h = await answerCard(mode);
    h.buttons[0].click();
    if (mode === 'multiple') h.buttons[1].click();
    assert.equal(h.emitted.length, 0, 'selection must leave time to add a note');
    h.fill('只在本地处理');
    h.elements.get('confirm').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.emitted.length, 1);
    assert.equal(h.emitted[0][1].action, 'confirmed');
    assert.deepEqual(JSON.parse(JSON.stringify(h.emitted[0][1].choice)), mode === 'multiple' ? ['同步', '加密'] : '同步');
    assert.equal(h.emitted[0][1].note, '只在本地处理');
  });

  test(`${mode} card allows text only and retains choices and note after a failed send`, async () => {
    const h = await answerCard(mode);
    h.fill('我想另提一个方案');
    h.elements.get('confirm').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.emitted.length, 1);
    assert.equal(h.emitted[0][1].action, 'custom');
    assert.equal(h.emitted[0][1].choice, '我想另提一个方案');
    const retry = await answerCard(mode, { fail: true });
    retry.buttons[0].click(); retry.fill('保留说明');
    retry.elements.get('confirm').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(retry.elements.get('note').value, '保留说明');
    assert.equal(retry.buttons[0].attributes.get('aria-checked'), 'true');
    assert.equal(retry.elements.get('confirm').disabled, false);
    retry.elements.get('confirm').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(retry.emitted.length, 2);
    assert.equal(retry.emitted[1][1].note, '保留说明');
  });
}

test('supplementary text does not bypass a partially selected multi-select minimum', async () => {
  const h = await answerCard('multiple', { minSelections: 2 });
  h.buttons[0].click(); h.fill('说明');
  h.elements.get('confirm').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.emitted.length, 0);
});

// 2026-10-20 实机事故：绑定数据是宿主后写的，卡片若先启动，读到的是空数据；
// 之后宿主写入，onChange 未必带完整数据，卡片就永远停在「正在与原对话绑定」。
// 修法：收到变化自己重拉一次，并做有限轮询兜住启动与写入之间的时序差。
test('card pulls host data again when it starts before the binding data arrives', async () => {
  const html = await readFile(source, 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .find(([tag]) => !tag.includes('type="application/json"'))[1];
  const state = { askId: 'late-ask', title: '题', question: '选哪个？', selectionMode: 'single',
    minSelections: 1, maxSelections: 1, expiresAt: Date.now() + 600_000, options: [{ label: '甲' }, { label: '乙' }] };
  const elements = new Map();
  const document = {
    querySelector: () => ({ textContent: JSON.stringify(state) }),
    getElementById: (id) => { if (!elements.has(id)) elements.set(id, new FakeElement()); return elements.get(id); },
    createElement: () => new FakeElement(),
  };
  let hostData = {};                       // 卡片先启动：宿主还没写绑定数据
  let changeHandler = null;
  const emitted = [];
  const window = { card: {
    capabilities: async () => ({ ok: true, result: { capabilities: { emit: 'available' } } }),
    data: {
      get: async () => ({ ok: true, result: { data: hostData } }),
      onChange: (handler) => { changeHandler = handler; },
    },
    state: { get: async () => ({ ok: true, result: { value: false } }), set: async () => ({ ok: true }) },
    emit: async (...args) => { emitted.push(args); return { ok: true }; },
  } };
  new Script(script).runInNewContext({ document, window, Date, Set, Number, Array, String, Promise, setInterval, clearInterval });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get('options').children[0].disabled, true, '还没绑定时选项不能点');

  // 宿主此刻才写绑定数据，并且 onChange 不带完整数据（只有变化提示）。
  hostData = { askId: 'late-ask', ready: true, homeSessionId: 'session-1' };
  changeHandler && changeHandler();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get('options').children[0].disabled, false, '拉到绑定数据后选项必须能点');
  assert.match(elements.get('status').textContent, /选好后点/);
});

// 2026-10-20 实机事故二：宿主把 host-data 的 ready 存成字符串 "true"，
// 模板用 data.ready!==true 判就永远解锁不了。
test('card accepts a stringified ready flag from host data', async () => {
  const html = await readFile(source, 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .find(([tag]) => !tag.includes('type="application/json"'))[1];
  const state = { askId: 'str-ask', question: '选哪个？', selectionMode: 'single',
    minSelections: 1, maxSelections: 1, expiresAt: Date.now() + 600_000, options: [{ label: '甲' }, { label: '乙' }] };
  const elements = new Map();
  const document = {
    querySelector: () => ({ textContent: JSON.stringify(state) }),
    getElementById: (id) => { if (!elements.has(id)) elements.set(id, new FakeElement()); return elements.get(id); },
    createElement: () => new FakeElement(),
  };
  const hostData = { askId: 'str-ask', ready: 'true', homeSessionId: 'session-1' };
  const window = { card: {
    capabilities: async () => ({ ok: true, result: { capabilities: { emit: 'available' } } }),
    data: { get: async () => ({ ok: true, result: { data: hostData } }), onChange() {} },
    state: { get: async () => ({ ok: true, result: { value: false } }), set: async () => ({ ok: true }) },
    emit: async () => ({ ok: true }),
  } };
  new Script(script).runInNewContext({ document, window, Date, Set, Number, Array, String, Promise, setInterval, clearInterval });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get('options').children[0].disabled, false, '字符串 "true" 也必须解锁');
  assert.match(elements.get('status').textContent, /选好后点/);
});

// 2026-10-20 实机事故三：调用方多包一层 item，宿主再包一层，
// 卡片拿到 {item:{item:[...]}}，认不出数组就一个选项都没有。
test('card unwraps options wrapped in several item layers', async () => {
  const html = await readFile(source, 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .find(([tag]) => !tag.includes('type="application/json"'))[1];
  const state = { askId: 'deep-ask', question: '选哪个？', selectionMode: 'single',
    minSelections: 1, maxSelections: 1, expiresAt: Date.now() + 600_000,
    options: { item: { item: [{ label: '甲' }, { label: '乙' }] } } };
  const elements = new Map();
  const document = {
    querySelector: () => ({ textContent: JSON.stringify(state) }),
    getElementById: (id) => { if (!elements.has(id)) elements.set(id, new FakeElement()); return elements.get(id); },
    createElement: () => new FakeElement(),
  };
  const window = { card: {
    capabilities: async () => ({ ok: true, result: { capabilities: { emit: 'available' } } }),
    data: { get: async () => ({ ok: true, result: { data: { askId: 'deep-ask', ready: 'true' } } }), onChange() {} },
    state: { get: async () => ({ ok: true, result: { value: false } }), set: async () => ({ ok: true }) },
    emit: async () => ({ ok: true }),
  } };
  new Script(script).runInNewContext({ document, window, Date, Set, Number, Array, String, Promise, setInterval, clearInterval });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.get('options').children.length, 2, '多层 item 包裹也要拆出两个选项');
});
