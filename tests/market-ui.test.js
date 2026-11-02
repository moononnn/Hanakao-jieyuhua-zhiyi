import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../ui/market.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../ui/assets/market.css', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../ui/assets/market.js', import.meta.url), 'utf8');

// Small DOM double: fail immediately if third-party text is ever routed through HTML.
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.events = {}; this.attributes = {};
    this.dataset = {}; this.value = ''; this.disabled = false; this.hidden = false;
  }
  set innerHTML(_) { throw new Error('Unsafe HTML write'); }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map((c) => c.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  scrollIntoView(options) { this.scrolled = options || true; }
  addEventListener(type, listener) { (this.events[type] ||= []).push(listener); }
  emit(type) { for (const fn of this.events[type] || []) fn({ preventDefault() {} }); }
  focus() { this.focused = true; }
}
const tick = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const item = (n, source = 'market') => ({
  key: `${source}:app-${n}`, id: `app-${n}`, name: `应用 ${n}`, version: '1.0.0',
  description: '<img src=x onerror=alert(1)>公开简介', source, statusLabel: source === 'market' ? '已上架' : '申请待审',
  sourceUrl: 'javascript:alert(1)', installedVersion: null, installed: false, updateStatus: 'unknown', prNumber: source === 'pending' ? 12 : undefined,
});
// Locally installed entries: no public source, not reviewable, may arrive without a version string.
const installed = (n, extra = {}) => ({
  key: `installed:app:${n}`, id: `app-${n}`, name: `应用 ${n}`, version: '1.0.0',
  description: '本机已安装', source: 'installed', statusLabel: '已安装', sourceUrl: '',
  installedVersion: '1.0.0', installed: true, reviewable: false, repository: '', updateStatus: 'unknown', ...extra,
});
// 上了市场、本机也确实装了的应用：默认分类只列这部分。
const owned = (n, extra = {}) => ({ ...item(n), installed: true, installedVersion: '1.0.0', ...extra });
const snapshotSession = (key, options = {}) => ({
  key, messages: [{ role: 'assistant', content: '<script>not executable</script>\n源码说明' }],
  snapshot: { commit: 'abc123', repo: 'owner/repo', files: [{ path: 'index.js', chars: 120 }], warnings: ['未读取全部文件'], checkedAt: '2026-10-31T06:00:00Z' },
  model: 'test-model', ...options,
});
async function mount(handler, ready = Promise.resolve(), panel = null, reducedMotion = false, timers = { setTimeout, clearTimeout }) {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map((m) => [m[1], new Element()]));
  const requests = [];
  const httpRequests = [];
  let readyResolved = false;
  let windowRequests = 0;
  if (panel !== null) {
    const section = new Element();
    section.classList = { contains: (name) => name === 'on' && panel === 'market' };
    elements.set('view-market', section);
  }
  elements.get('market-detail').hidden = true;
  const events = new Map();
  const hana = {
    ready: async () => { requests.push({ ready: true }); await ready; readyResolved = true; },
    api: { fetch: async (path, options) => {
      assert.equal(readyResolved, true, 'hana.ready() must resolve before HTTP requests');
      const query = new URLSearchParams(path.split('?')[1] || '');
      const body = options.body ? JSON.parse(options.body) : undefined;
      // Derived operation is only a test convenience; transport is the real HTTP contract.
      const call = { operation: path.split('?')[0].split('/').at(-1),
        ...(body || (path.startsWith('/market/catalog') ? { refresh: query.get('refresh') === '1', includePending: query.get('includePending') !== '0' } : { key: query.get('key') })) };
      requests.push(call);
      httpRequests.push({ path, method: options.method, body });
      const result0 = await handler(call);
      // 目录与待审现在是并行发出的，图标还是第二段：用例没显式给结果时，给个空结果，
      // 免得每个用例都得为一个补充请求单独写桩。显式给了字段的用例不受影响。
      const gave = (field) => result0 && typeof result0 === 'object' && field in result0;
      let result = result0;
      if (call.operation === 'pending' && !gave('pendingLoaded')) {
        result = { ok: true, items: [], warnings: [], installedStatus: 'unavailable', pendingLoaded: true };
      } else if (call.operation === 'pending-icons' && !gave('icons')) {
        result = { ok: true, icons: {} };
      }
      return { ok: result.httpOk !== false, json: typeof result.json === 'function' ? result.json : async () => result };
    } },
    window: { request: () => { windowRequests += 1; throw new Error('Embedded page must not use window.request'); } },
  };
  vm.runInNewContext(js
    .replace(/^import \{ hana \} from '\.\/sdk\.js';\s*/, '')
    .replace(/^import \{ followHostTheme \} from '\.\/theme-report\.js';\s*/, ''), {
    hana, followHostTheme: () => {}, document: { getElementById: (id) => elements.get(id) || null, createElement: (tag) => new Element(tag),
      createTextNode: (text) => ({ textContent: String(text), children: [] }) },
    window: { addEventListener: (name, listener) => { events.set(name, listener); },
      matchMedia: (query) => ({ matches: reducedMotion && query.includes('reduced-motion'), media: query }) },
    URLSearchParams, Date, console, AbortController, atob, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  await tick();
  return { el: (id) => elements.get(id), requests, httpRequests, windowRequests: () => windowRequests,
    view: async (view) => { events.get('zhiyi:view-change')?.({ detail: { view } }); await tick(); },
    tab: async (name) => { elements.get(`filter-${name}`).emit('click'); await tick(); },
    open: async (index = 0) => { elements.get('market-list').children[index].children[0].emit('click'); await tick(); },
    card: (index = 0) => elements.get('market-list').children[index].children[0] };
}
const catalog = (items = [item(1)], extra = {}) => ({
  ok: true, items, warnings: [], updatedAt: '2026-10-31T06:00:00Z', installedStatus: 'unavailable', pendingLoaded: true, ...extra,
});

for (const stage of ['fetch', 'body']) {
  test(`catalog timeout covers ${stage}, unlocks refresh and ignores late response`, async () => {
    const pending = deferred();
    const callbacks = new Map();
    let seq = 0, catalogCalls = 0;
    const timers = { setTimeout: (fn) => { callbacks.set(++seq, fn); return seq; }, clearTimeout: (id) => callbacks.delete(id) };
    // 目录与待审并行发出，所以按 operation 分派，不按第几次调用判断。
    const app = await mount((call) => {
      if (call.operation === 'pending') return { ok: true, items: [], warnings: [], installedStatus: 'unavailable', pendingLoaded: true };
      catalogCalls += 1;
      if (catalogCalls > 1) return catalog([owned(2)]);
      return stage === 'fetch' ? pending.promise : { ok: true, json: () => pending.promise };
    }, Promise.resolve(), null, false, timers);
    assert.equal(app.el('market-refresh').disabled, true);
    for (const fn of [...callbacks.values()]) fn();
    await tick();
    assert.match(app.el('catalog-status').textContent, /超时/);
    assert.equal(app.el('market-refresh').disabled, false);
    app.el('market-refresh').emit('click');
    await tick();
    assert.match(app.el('market-list').textContent, /应用 2/);
    pending.resolve(catalog([owned(1)]));
    await tick();
    assert.match(app.el('market-list').textContent, /应用 2/);
    assert.doesNotMatch(app.el('market-list').textContent, /应用 1/);
    assert.equal(callbacks.size, 0);
  });
}

test('first screen lists what you installed, pending versions included', async () => {
  const pendingInstalled = { ...item(2, 'pending'), installed: true, installedVersion: '1.0.0' };
  const app = await mount((call) => (call.operation === 'pending'
    ? { ok: true, items: [pendingInstalled], warnings: [], installedStatus: 'available', pendingLoaded: true }
    : { ...catalog([owned(1), item(3), installed(4)]), pendingLoaded: false }));
  await app.tab('market');
  assert.equal(app.el('filter-market').attributes['aria-pressed'], 'true');
  assert.equal(app.el('filter-installed').attributes['aria-pressed'], 'false');
  await app.tab('installed');
  await tick();
  assert.equal(app.el('filter-installed').attributes['aria-pressed'], 'true');
  assert.equal(app.requests.find((call) => call.operation === 'catalog').includePending, false, '首屏先读快的市场索引');
  // 上架且装了的、以及待审且装了的都在；只上架没装的不进。
  assert.match(app.el('market-list').textContent, /应用 1/);
  assert.doesNotMatch(app.el('market-list').textContent, /应用 3/);
  assert.doesNotMatch(app.el('market-list').textContent, /应用 4/);
  // 待审单独补读，不重读整个索引；同一个应用只占一行，并优先显示待审版本。
  assert.equal(app.requests.filter((call) => call.operation === 'catalog').length, 1);
  assert.equal(app.requests.filter((call) => call.operation === 'pending').length, 1);
  for (let i = 0; i < 6 && app.el('market-list').children.length < 2; i += 1) await tick();
  const text = app.el('market-list').textContent;
  assert.match(text, /待审/);
  assert.equal(app.el('market-list').children.length, 2, '已装的应用 1 / 待审的应用 2');
});

test('已上架列表里有待审新版时，点进去审的是待审那一版', async () => {
  const pendingItem = { ...item(1, 'pending'), version: '2.0.0', listedVersion: '1.0.0', installed: true, installedVersion: '1.0.0' };
  const app = await mount((call) => {
    if (call.operation === 'pending') return { ok: true, items: [pendingItem], warnings: [], installedStatus: 'available', pendingLoaded: true };
    if (call.operation === 'session') return { ok: true, session: null };
    return { ...catalog([item(1)]), pendingLoaded: false };
  });
  await app.tab('market');
  for (let i = 0; i < 6 && !app.requests.some((call) => call.operation === 'pending'); i += 1) await tick();
  assert.match(app.el('market-list').textContent, /待审/, '卡片上要摆出待审版号');
  await app.open(0);
  const sessionCall = app.requests.find((call) => call.operation === 'session');
  assert.equal(sessionCall.key, 'pending:app-1', '点有待审新版的卡片，应进入待审条目去审');
});

test('pending read arriving before the catalog is not wiped out by it', async () => {
  const initial = deferred();
  const pendingInstalled = { ...item(2, 'pending'), installed: true, installedVersion: '1.0.0' };
  const app = await mount((call) => (call.operation === 'pending'
    ? { ok: true, items: [pendingInstalled], warnings: [], pendingLoaded: true }
    : initial.promise));
  await app.tab('pending');
  assert.match(app.el('market-list').textContent, /应用 2/);
  initial.resolve({ ...catalog([owned(1)]), pendingLoaded: false }); await tick();
  assert.match(app.el('market-list').textContent, /应用 2/, '目录后到也不能把已读到的待审条目抹掉');
});

test('first pending tab upgrades once; all tab keeps the loaded pending data', async () => {
  const app = await mount((call) => (call.operation === 'pending'
    ? { ok: true, items: [item(2, 'pending')], warnings: [], pendingLoaded: true }
    : { ...catalog([item(1)]), pendingLoaded: false }));
  await app.tab('pending');
  assert.equal(app.requests.filter((call) => call.operation === 'pending').length, 1);
  assert.match(app.el('market-list').textContent, /应用 2/);
  await app.tab('all');
  assert.equal(app.requests.filter((call) => call.operation === 'catalog').length, 1);
  assert.equal(app.requests.filter((call) => call.operation === 'pending').length, 1);
  assert.match(app.el('market-list').textContent, /应用 2/);
});

test('pending selected during primary load upgrades after primary completion', async () => {
  const initial = deferred();
  const app = await mount((call) => (call.operation === 'pending'
    ? { ok: true, items: [item(2, 'pending')], warnings: [], pendingLoaded: true }
    : initial.promise));
  await app.tab('pending');
  initial.resolve({ ...catalog([item(1)]), pendingLoaded: false }); await tick();
  assert.match(app.el('market-list').textContent, /应用 2/);
  assert.equal(app.requests.filter((call) => call.operation === 'pending').length, 1);
});

test('static contract: embedded HTTP bridge, safe DOM and responsive conversation', () => {
  assert.match(js, /import \{ hana \} from '\.\/sdk\.js'/);
  assert.match(js, /await hana\.ready\(\)/);
  assert.match(js, /await hana\.ready\(\);[\s\S]*await hana\.api\.fetch\(path, options\)/);
  assert.match(js, /await hana\.ready\(\);\s*if \(!section \|\| section\.classList\.contains\('on'\)\) await activate\(\)/);
  assert.doesNotMatch(js, /hana\.window|showModal|\.close\(|localStorage|sessionStorage|appSurfaceSession/);
  assert.match(html, /theme-follow\.js/);
  assert.match(html, /panel\.css/);
  assert.doesNotMatch(html, /<dialog/);
  assert.match(html, /<section id="market-detail" class="market-conversation"[^>]+hidden/);
  assert.match(html, /id="market-home"/);
  assert.match(html, /id="market-quick"/);
  assert.match(html, /知意解答伙伴/);
  assert.match(html, /看中哪款，点进去直接问它/);
  assert.doesNotMatch(html, /先检查才能|先检查源码，再|尚未检查，暂不能/);
  assert.match(css, /max-width: 900px/);
  assert.match(css, /\.market-body \[hidden\]/);
  assert.match(html, /公开源码、你的提问和最近几轮对话发给当前配置的模型，产生用量/);
  assert.match(html, /没查的部分/);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|window\.open|location\.(?:href|assign)|eval\(/);
  assert.doesNotMatch(html, /<iframe|<a\s|https?:\/\/|<select/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /focus-visible/);
  assert.match(css, /max-width: 600px/);
  assert.match(css, /minmax\(0, 1fr\)/);
  assert.match(css, /overflow-x: clip/);
  assert.match(css, /@container market \(max-width: 900px\)/);
  assert.match(css, /container-type: inline-size/);
  assert.match(css, /\.market-conversation \{[^}]*display: flex; flex-direction: column[^}]*height: calc\(100dvh - 40px\)/);
  // 单独打开时卡片撑满高度，下边不再空一大截；审查正文占满可用宽度。
  assert.match(css, /body\.market-body \.market-conversation \{ height: calc\(100dvh - 48px\); \}/);
  assert.match(css, /\.market-message \{ max-width: min\(100%, 1180px\)/);
  assert.match(css, /\.market-message\[data-role="assistant"\] \{[^}]*width: 100%/);
  assert.match(css, /\.workspace-inner:has\(#view-market\.on\) \{ max-width: 1360px; \}/);
  assert.match(css, /\.workspace:has\(#view-market\.on\) \{ padding: 20px 24px; \}/);
  // 输入区收紧，把纵向空间让给审查正文。
  assert.match(css, /\.detail-footer \{[^}]*padding: 8px 16px 8px/);
  assert.match(css, /\.pending-notice \{[^}]*padding: 10px 14px/);
  // 两条信息折叠条钉在顶部，滚动时不动。
  assert.match(html, /<div class="detail-folds" id="detail-folds">/);
  assert.match(css, /\.detail-folds \{[^}]*position: sticky; top: 0/);
  // 「读回记录」要说清它做什么：读回本机记录，不调模型、不产生用量。
  assert.match(html, /id="session-retry"[^>]*title="从本机读回这份对话记录/);
  assert.match(html, />读回记录</);
  assert.match(css, /\.detail-scroll \{[^}]*flex: 1 1 auto[^}]*min-height: 0[^}]*overflow: auto/);
  assert.match(css, /\.detail-footer \{[^}]*flex: none/);
  assert.doesNotMatch(css, /\.market-body \{[^}]*@media/);
});

test('static contract: compact grid, installed first tab and no local asset guessing', () => {
  assert.match(html, /id="filter-installed" type="button" aria-pressed="true"/);
  assert.match(html, /id="filter-market" type="button" aria-pressed="false"/);
  assert.match(html, /id="filter-pending" type="button" aria-pressed="false"/);
  assert.match(html, /id="filter-all" type="button" aria-pressed="false"/);
  assert.match(css, /grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 220px\), 1fr\)\)/);
  assert.match(css, /button\.market-item \{[^}]*height: 104px/);
  assert.match(css, /\.market-workspace \{[^}]*grid-template-columns: minmax\(0, 1fr\)[^}]*\}/);
  assert.match(css, /\.quick-row \{/);
  assert.match(css, /\.rich h4, \.rich h5/);
  assert.match(css, /\.market-message\[data-role="user"\]/);
  assert.match(css, /\.market-item \.item-icon \{[^}]*width: 44px;[^}]*height: 44px/);
  assert.match(css, /\.market-item \.item-icon-img \{[^}]*object-fit: cover/);
  assert.match(css, /\.market-item \.item-icon-img\[hidden\] \{ display: none/);
  assert.match(js, /const filters = \['installed', 'market', 'pending', 'all'\]/);
  assert.match(js, /source: 'installed'/);
  assert.match(js, /function safeIconSrc\(/);
  assert.match(js, /data:image/);
  assert.match(js, /ICON_MAX_CHARS = 1024 \* 1024/);
  assert.match(js, /svg\\\+xml/);
  assert.doesNotMatch(js, /https?:\/\//); // icons never trigger a network request
  assert.doesNotMatch(js, /setAttribute\('src', item\.icon\)/);
  assert.match(js, /setAttribute\('src', src\)/);
});

test('installed tab keeps applications that have a public source, unlisted ones stay out', async () => {
  const app = await mount(async () => catalog([
    owned(1), item(2), installed(3), owned(4, { installedVersion: '版本未知' }),
  ]));
  assert.equal(app.el('market-list').children.length, 2);
  assert.match(app.el('market-list').textContent, /应用 1/);
  assert.match(app.el('market-list').textContent, /应用 4/);
  assert.doesNotMatch(app.el('market-list').textContent, /应用 2/);
  assert.doesNotMatch(app.el('market-list').textContent, /应用 3/, '市场没收录的本机应用不进默认页');
  assert.match(app.el('market-list').textContent, /版本未知/);
});

test('pending version takes the row for an installed application instead of doubling it', async () => {
  const pendingOne = { ...item(1, 'pending'), installed: true, installedVersion: '1.0.0' };
  const app = await mount(async () => catalog([
    pendingOne,
    owned(1),
  ]));
  assert.equal(app.el('market-list').children.length, 1, '应用 1 只占一行');
  assert.match(app.card(0).attributes['aria-label'], /待审/);
  // 加粗落在待审版本那一行，本机版本只做对照。
  const meta = app.card(0).children[2].children[0];
  assert.equal(meta.textContent, '待审 v1.0.0');
  assert.equal(meta.className, 'item-meta is-pending');
  assert.equal(app.card(0).children[3].textContent, '本机 1.0.0');
});

test('opening a pending row reviews that pending version, not the listed one', async () => {
  const pendingOne = { ...item(1, 'pending'), installed: true, installedVersion: '1.0.0' };
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog([owned(1), pendingOne])
    : { ok: true, session: snapshotSession(pendingOne.key) }));
  await app.open(0);
  assert.match(app.el('detail-context').textContent, /待审版本/);
  assert.match(app.el('detail-facts').textContent, /上架申请（审核中）/);
  assert.match(app.el('detail-facts').textContent, /PR #12/);
  assert.match(app.el('conversation-empty').textContent, /作者头一回往市场递/, '首次申请只说装不装');
  assert.doesNotMatch(app.el('conversation-empty').textContent, /升不升/);
  assert.equal(app.requests.at(-1).key, pendingOne.key);
});

test('installed-only application shows no public source and cannot be inspected or asked', async () => {
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog([installed(1)]) : { ok: true, session: snapshotSession(r.key) }));
  // 市场没收录的本机应用不在默认分类里，从「全部」进去看它的说明。
  await app.tab('all');
  await app.open();
  assert.equal(app.el('market-detail').hidden, false);
  assert.equal(app.el('market-home').hidden, true);
  assert.match(app.el('detail-context').textContent, /已安装 1\.0\.0 · 应用 ID app-1/);
  assert.match(app.el('detail-facts').textContent, /暂无公开来源/);
  assert.match(app.el('detail-status').textContent, /暂无公开来源/);
  assert.match(app.el('conversation-empty').textContent, /目录里没有它的公开源码/);
  assert.equal(app.el('market-inspect').disabled, true);
  assert.equal(app.el('market-question').disabled, true);
  assert.equal(app.el('market-send').disabled, true);
  assert.equal(app.el('session-retry').disabled, true);
  assert.equal(app.requests.filter((r) => r.operation === 'session').length, 0);
  assert.equal(app.requests.filter((r) => ['inspect', 'chat'].includes(r.operation)).length, 0);
});

test('icon renders a validated data image, keeps safe SVG and falls back to a glyph', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
  const app = await mount(async () => catalog([
    owned(1, { icon: png }),
    owned(2, { icon: `data:image/svg+xml;base64,${b64('<svg xmlns="http://www.w3.org/2000/svg"></svg>')}` }),
    owned(3, { icon: 'https://raw.githubusercontent.com/owner/repo/main/icon.png' }),
    owned(4, { icon: 'data:image/png;base64,not-base64!' }),
    owned(5, { icon: `data:image/png;base64,${'A'.repeat(1100 * 1024)}` }),
    owned(6, { icon: `data:image/svg+xml;base64,${b64('<svg><script>alert(1)</script></svg>')}` }),
    owned(7, { icon: `data:image/svg+xml;base64,${b64('<svg><image href="https://example.test/x.png"/></svg>')}` }),
  ]));
  const box = app.card(0).children[0];
  const img = box.children[1];
  assert.equal(box.children[0].textContent, '应');
  assert.equal(img.attributes.src, png);
  assert.equal(img.attributes.class, 'item-icon-img');
  // 图默认就显示，不靠 load 事件：有的宿主不派发 load，那样图标永远出不来。
  assert.equal(img.attributes.hidden, undefined);
  img.emit('error');
  assert.equal(img.attributes.hidden, '');
  assert.equal(app.card(1).children[0].children.length, 2, '无脚本的 SVG 图标要能显示');
  for (const index of [2, 3, 4, 5, 6]) assert.equal(app.card(index).children[0].children.length, 1);
});

test('picking an application opens its own chat page instead of expanding below the list', async () => {
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog([item(1)])
    : { ok: true, session: snapshotSession(item(1).key) }));
  await app.tab('market');
  await app.open();
  assert.equal(app.el('official-details').open, undefined);
  assert.equal(app.el('inspection-details').open, undefined);
  assert.match(app.el('detail-context').textContent, /目录版本 1\.0\.0 · 应用 ID app-1/);
  assert.equal(app.el('market-detail').scrolled.behavior, 'smooth');
  assert.equal(app.el('market-detail').scrolled.block, 'start');
  assert.equal(app.el('market-detail').hidden, false);
  assert.equal(app.el('market-home').hidden, true);
  assert.equal(app.el('market-question').disabled, false);
});

test('已上架应用递的新版：开场白写清架上版与待审版，快捷问题仍问更新', async () => {
  const upgrade = { ...item(1, 'pending'), version: '2.0.0', listedVersion: '1.0.0', installed: true, installedVersion: '1.0.0' };
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog([upgrade]) : { ok: true, session: snapshotSession(upgrade.key) }));
  await app.open(0);
  const greeting = app.el('conversation-empty').textContent;
  assert.match(greeting, /正好是市场上架那版/, '装的正好是架上版时，不要再说一遍那个号');
  assert.match(greeting, /2\.0\.0 还在门外等着/);
  assert.equal(greeting.match(/1\.0\.0/g).length, 1, '同一个版本号只说一次');
  const labels = app.el('market-quick').children.slice(1).map((chip) => chip.textContent);
  assert.ok(labels.includes('这版更新了什么'), '有旧版可比就该问更新');
});

test('装的就是目录里这版时，开场白直说不用再比对', async () => {
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog([owned(1)]) : { ok: true, session: snapshotSession(owned(1).key) }));
  await app.open(0);
  assert.match(app.el('conversation-empty').textContent, /已经是目录里最新那版了哈/);
  assert.doesNotMatch(app.el('conversation-empty').textContent, /急什么|没得升/, '不要用质问句驳回用户的期待');
});

test('首次上架的申请：快捷问题问功能，不问更新也不提升级', async () => {
  const first = { ...item(2, 'pending'), version: '0.1.0', installed: true };
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog([first]) : { ok: true, session: snapshotSession(first.key) }));
  await app.open(0);
  const labels = app.el('market-quick').children.slice(1).map((chip) => chip.textContent);
  assert.ok(labels.includes('它能干什么'));
  assert.ok(!labels.includes('这版更新了什么'), '没有旧版可比就不该问更新');
});

test('已有对话时，重新审查要点两下，第一下只提醒记录会被顶掉', async () => {
  const key = item(1).key;
  let inspects = 0;
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const messages = [
    { role: 'user', content: '它能干什么' },
    { role: 'assistant', content: '它把包存在本地' },
    { role: 'user', content: '安全吗' },
    { role: 'assistant', content: '看不出外发' },
  ];
  const app = await mount((r) => {
    if (r.operation === 'inspect') { inspects += 1; return gate; }
    if (r.operation === 'catalog') return catalog([owned(1)]);
    return { ok: true, session: snapshotSession(key, { messages }) };
  });
  await app.open(0);
  await tick();
  app.el('market-inspect').emit('click');
  await tick();
  assert.equal(inspects, 0, '第一下不该直接重审');
  assert.match(app.el('market-inspect').textContent, /再点一次/);
  assert.match(app.el('detail-status').textContent, /顶掉/);
  app.el('market-inspect').emit('click');
  await tick();
  assert.equal(inspects, 1, '第二下才真的重审');
  release({ ok: true, session: snapshotSession(key) });
  await tick();
});

test('chat page renders a greeting and quick questions for the picked application', async () => {
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog([item(1)])
    : { ok: true, session: snapshotSession(item(1).key) }));
  await app.tab('market');
  await app.open();
  const greeting = app.el('conversation-empty').textContent;
  assert.match(greeting, /知意在这儿/);
  assert.match(greeting, /应用 1/);
  assert.doesNotMatch(greeting, /升不升/, '已上架条目也不谈升');
  const chips = app.el('market-quick').children;
  assert.equal(chips[0], app.el('market-inspect'));
  const labels = chips.slice(1).map((chip) => chip.textContent);
  assert.ok(labels.includes('权限与风险'));
  assert.ok(labels.includes('怎么用'));
  assert.ok(labels.includes('这版更新了什么'));
  // 本机没装这款时不出「比已装版多什么」，避免按钮名不副实。
  assert.equal(labels.includes('比已装版多什么'), false);
});

test('quick question sends through the chat route and reuses the bound snapshot', async () => {
  const key = item(1).key;
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog([item(1)])
    : { ok: true, session: snapshotSession(key) }));
  await app.tab('market');
  await app.open();
  const chip = app.el('market-quick').children.find((node) => node.dataset?.chip === 'risk');
  assert.ok(chip);
  chip.emit('click'); await tick();
  const sent = app.httpRequests.at(-1);
  assert.equal(sent.path, '/market/chat');
  assert.match(sent.body.text, /权限/);
});

test('快捷问题按玥儿自己的口气写，不摆三段式公文', async () => {
  // 这几句话是代替她打出去的，会原样存在聊天记录里。写成「用大白话说清它是干什么的、
  // 第一次上手要做什么、有什么地方得先留意」这种模板，她翻记录时会认不出是自己说的。
  const entry = { ...item(1), installed: true, installedVersion: '0.9.0' };
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog([entry])
    : { ok: true, session: snapshotSession(entry.key) }));
  await app.open(0);
  const sent = [];
  for (const id of ['diff', 'risk', 'howto', 'whatsnew']) {
    const chip = app.el('market-quick').children.find((node) => node.dataset?.chip === id);
    assert.ok(chip, `缺了 ${id} 这颗问题按钮`);
    chip.emit('click'); await tick();
    sent.push(app.httpRequests.at(-1).body.text);
  }
  for (const text of sent) {
    assert.doesNotMatch(text, /用大白话说清它是|第一次上手要做|有什么地方得先留意|对我有什么影响/, `这句还是公文腔：${text}`);
    assert.ok(text.length <= 60, `这句太长，不像人打字：${text}`);
  }
});

test('installed version comparison becomes a real quick question', async () => {
  const entry = { ...item(1), installed: true, installedVersion: '0.9.0' };
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog([entry])
    : { ok: true, session: snapshotSession(entry.key) }));
  await app.tab('market');
  await app.open();
  const chip = app.el('market-quick').children.find((node) => node.dataset?.chip === 'diff');
  assert.equal(chip?.textContent, '比已装版多什么');
  chip.emit('click'); await tick();
  assert.match(app.httpRequests.at(-1).body.text, /0\.9\.0.*1\.0\.0/s);
});

test('model answers render as readable blocks, not raw markdown', async () => {
  const reply = '# 标题\n\n**结论**：能装。\n\n- 第一条\n- 第二条\n\n---\n\n`index.js` 里没有网络请求。';
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog([item(1)])
    : { ok: true, session: snapshotSession(item(1).key, { messages: [{ role: 'assistant', content: reply }] }) }));
  await app.tab('market');
  await app.open();
  const body = app.el('market-messages').children[0].children[1];
  const tags = body.children.map((piece) => piece.tagName);
  assert.deepEqual(tags, ['h4', 'p', 'ul', 'hr', 'p']);
  assert.doesNotMatch(body.textContent, /\*\*|^#/m);
  assert.equal(body.children[0].textContent, '标题');
  assert.equal(body.children[2].children.length, 2);
  assert.equal(body.children[4].children[0].tagName, 'code');
});

test('用户那条不挂名头，知意的回答前面带一张小头像', async () => {
  const key = item(1).key;
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog([item(1)])
    : { ok: true, session: snapshotSession(key, { messages: [
      { role: 'user', content: '这版更新了什么？' },
      { role: 'assistant', content: '改了三个文件。' },
    ] }) }));
  await app.tab('market');
  await app.open();
  const [user, assistant] = app.el('market-messages').children;
  assert.equal(user.dataset.role, 'user');
  assert.equal(user.children.length, 1, '自己说的话只有正文，不写「你」');
  assert.doesNotMatch(user.textContent, /^你/);
  const head = assistant.children[0];
  assert.equal(head.className, 'market-name');
  const avatar = head.children[0];
  assert.equal(avatar.tagName, 'img');
  assert.equal(avatar.className, 'market-avatar');
  assert.equal(avatar.attributes.src, 'assets/market-avatar.png');
  assert.equal(avatar.attributes.alt, '', '头像不重复念名字');
  assert.equal(head.children[1].textContent, '知意');
  assert.equal(assistant.children[1].className, 'rich', '头像下面仍是正文');
});

test('待上架栏只列还没上架过的新应用，已上架的新版本不在这里重复', async () => {
  const alphaPending = { ...item(1, 'pending'), version: '2.0.0', listedVersion: '1.0.0' };
  const betaPending = { ...item(2, 'pending'), version: '0.1.0', listedVersion: null };
  const app = await mount((call) => {
    if (call.operation === 'pending') {
      return { ok: true, items: [alphaPending, betaPending], warnings: [], installedStatus: 'unavailable', pendingLoaded: true };
    }
    return catalog([item(1)]);
  });
  await app.tab('pending');
  const text = app.el('market-list').textContent;
  assert.match(text, /应用 2/, '纯新应用照常列出');
  assert.doesNotMatch(text, /应用 1/, '已上架应用的新版本不在这一栏重复');
  await app.tab('market');
  assert.match(app.el('market-list').textContent, /待审/, '那一版在「已上架」里用待审标记摆出来');
});

test('待审条目的图标单独补，上架应用的图随目录一起到', async () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const pendingOne = { ...item(1, 'pending'), version: '2.0.0', icon: '' };
  const app = await mount((call) => {
    if (call.operation === 'pending') return { ok: true, items: [pendingOne], warnings: [], installedStatus: 'unavailable', pendingLoaded: true };
    if (call.operation === 'pending-icons') return { ok: true, icons: { [pendingOne.key]: png } };
    return catalog([{ ...owned(2), icon: png }]);
  });
  await app.tab('all');
  // 图标是目录渲完之后异步补的，给几个回合让它落地。
  for (let i = 0; i < 8; i += 1) await tick();
  const cards = app.el('market-list').children.map((li) => li.children[0]);
  assert.equal(cards.length, 2);
  const iconOf = (card) => card.children[0].children.find((n) => n.tagName === 'img');
  assert.equal(iconOf(cards[0])?.attributes.src, png, '上架的图来自目录，立刻就有');
  assert.equal(iconOf(cards[1])?.attributes.src, png, '待审的图由第二段补上');
  const iconCalls = app.requests.filter((r) => r.operation === 'pending-icons');
  assert.equal(iconCalls.length, 1, '只为待审条目要图标');
  assert.deepEqual(iconCalls[0].keys, [pendingOne.key]);
});

test('clearing the record takes two clicks and empties the conversation', async () => {  const key = item(1).key;
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog([owned(1)])
    : r.operation === 'clear' ? { ok: true, session: null }
      : { ok: true, session: snapshotSession(key) }));
  await app.open();
  assert.equal(app.el('detail-clear').hidden, false);
  assert.equal(app.el('market-messages').children.length, 1);
  app.el('detail-clear').emit('click');
  await tick();
  // 第一下只是上膛，不能真删。
  assert.match(app.el('detail-clear').textContent, /再点一次确认/);
  assert.equal(app.requests.filter((r) => r.operation === 'clear').length, 0);
  app.el('detail-clear').emit('click');
  await tick();
  assert.deepEqual(app.httpRequests.at(-1), { path: '/market/clear', method: 'POST', body: { key } });
  assert.equal(app.el('market-messages').children.length, 0);
  assert.match(app.el('detail-status').textContent, /记录已清空/);
  assert.equal(app.el('detail-clear').hidden, true);
});

test('market tab shows the listed version and the pending one side by side', async () => {
  const listed = owned(1);
  const pendingOne = { ...item(1, 'pending'), version: '2.0.0' };
  const app = await mount(async (r) => (r.operation === 'pending'
    ? { ok: true, items: [pendingOne], warnings: [], pendingLoaded: true }
    : { ...catalog([listed]), pendingLoaded: false }));
  await app.tab('market');
  for (let i = 0; i < 6 && !/待审/.test(app.card(0)?.attributes['aria-label'] || ''); i += 1) await tick();
  assert.equal(app.el('market-list').children.length, 1, '已上架列表不因待审另加一条');
  const card = app.card(0);
  assert.match(card.attributes['aria-label'], /已上架 · v1\.0\.0/);
  assert.match(card.attributes['aria-label'], /待审 v2\.0\.0/);
  const metaRow = card.children[2];
  assert.equal(metaRow.children.length, 2);
  assert.equal(metaRow.children[0].textContent, '上架 v1.0.0', '有待审时第一段用紧凑写法');
  assert.equal(metaRow.children[1].textContent, '待审 v2.0.0');
  assert.equal(metaRow.children[1].className, 'item-meta is-pending');
  assert.equal(card.children[3].textContent, '本机 1.0.0', '有待审时第三行只留本机版本');
});

test('reduced motion uses instant scroll instead of smooth', async () => {
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog([item(1)])
    : { ok: true, session: snapshotSession(item(1).key) }), Promise.resolve(), null, true);
  await app.tab('market');
  await app.open();
  assert.equal(app.el('market-detail').scrolled.behavior, 'auto');
  assert.equal(app.el('market-detail').scrolled.block, 'start');
});

test('HTTP requests wait for ready and never use native window.request', async () => {
  const ready = deferred();
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog()
    : r.operation === 'pending' ? { ok: true, items: [], warnings: [], installedStatus: 'unavailable', pendingLoaded: true }
      : { ok: true, session: snapshotSession(item(1).key) }), ready.promise);
  assert.equal(app.requests[0].ready, true);
  assert.equal(app.requests.filter((r) => r.operation).length, 0);
  app.el('market-refresh').emit('click'); await tick();
  assert.equal(app.requests.filter((r) => r.operation).length, 0);
  ready.resolve(); await tick();
  await app.tab('market');
  await app.open();
  app.el('market-inspect').emit('click'); await tick();
  app.el('market-question').value = '检查网络访问'; app.el('market-question').emit('input');
  app.el('market-chat').emit('submit'); await tick();
  // 目录与待审并行发出，两者的先后是调度结果，不作断言；付费动作的先后仍然要管。
  const ops = app.requests.filter((r) => r.operation).map((r) => r.operation);
  assert.deepEqual(ops.filter((o) => o !== 'pending' && o !== 'catalog'), ['session', 'inspect', 'chat']);
  assert.deepEqual(ops.filter((o) => o === 'pending' || o === 'catalog').sort(), ['catalog', 'pending']);
  assert.equal(app.windowRequests(), 0);
  const paths = app.httpRequests.map((r) => r.path);
  assert.deepEqual(paths.filter((p) => !p.startsWith('/market/catalog') && !p.startsWith('/market/pending')), [
    `/market/session?key=${encodeURIComponent(item(1).key)}`,
    '/market/inspect',
    '/market/chat',
  ]);
  assert.deepEqual(paths.filter((p) => p.startsWith('/market/catalog') || p.startsWith('/market/pending')).sort(), [
    '/market/catalog?includePending=1&refresh=1',
    '/market/pending',
  ]);
});

test('panel waits for first market tab, does not reload on tab changes, supports manual refresh', async () => {
  const app = await mount(async () => catalog(), Promise.resolve(), 'home');
  assert.equal(app.httpRequests.length, 0);
  assert.equal(app.el('market-detail').hidden, true);
  await app.view('home');
  assert.equal(app.httpRequests.length, 0);
  await app.view('market');
  assert.equal(app.httpRequests.filter((r) => r.path.startsWith('/market/catalog')).length, 1);
  assert.equal(app.httpRequests.filter((r) => r.path.startsWith('/market/pending')).length, 1, '目录与待审一起发');
  await app.view('home'); await app.view('market');
  assert.equal(app.httpRequests.length, 2);
  app.el('market-refresh').emit('click'); await tick();
  assert.equal(app.httpRequests.length, 3);
  assert.equal(app.httpRequests.at(-1).path, '/market/catalog?includePending=1&refresh=1');
  const visible = await mount(async () => catalog(), Promise.resolve(), 'market');
  assert.equal(visible.httpRequests.length, 2);
});

test('inline selection preserves each application draft, close restores placeholder and history', async () => {
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog([item(1), item(2)])
    : { ok: true, session: snapshotSession(r.key) }));
  await app.tab('market');
  await app.open(0);
  assert.equal(app.el('market-detail').hidden, false);
  assert.equal(app.el('market-home').hidden, true);
  assert.match(app.el('market-messages').textContent, /知意/);
  app.el('market-question').value = '应用一的疑问'; app.el('market-question').emit('input');
  await app.open(1);
  assert.equal(app.el('market-question').value, '');
  app.el('market-question').value = '应用二的疑问'; app.el('market-question').emit('input');
  await app.open(0);
  assert.equal(app.el('market-question').value, '应用一的疑问');
  app.el('detail-close').emit('click');
  assert.equal(app.el('market-detail').hidden, true);
  assert.equal(app.el('market-home').hidden, false);
  await app.open(1);
  assert.equal(app.el('market-question').value, '应用二的疑问');
  assert.match(app.el('market-messages').textContent, /源码说明/);
});

test('catalog filters, search, pagination, manual refresh and unavailable installation state', async () => {
  const apps = [...Array.from({ length: 30 }, (_, i) => (i < 2 ? owned(i) : item(i))), item(20, 'pending'), installed(90), installed(91)];
  const app = await mount(async () => catalog(apps));
  assert.equal(app.requests[0].ready, true);
  assert.deepEqual(app.requests.find((r) => r.operation === 'catalog'), { operation: 'catalog', refresh: false, includePending: false });
  assert.equal(app.el('market-list').children.length, 2);
  assert.match(app.el('market-list').textContent, /应用 0/);
  await app.tab('market');
  assert.equal(app.el('market-list').children.length, 24);
  assert.match(app.el('market-list').textContent, /安装状态不可用/);
  app.el('page-next').emit('click');
  assert.equal(app.el('market-list').children.length, 6);
  await app.tab('pending');
  assert.equal(app.el('market-list').children.length, 1);
  await app.tab('all');
  assert.equal(app.el('market-list').children.length, 24);
  app.el('market-search').value = '应用 20';
  app.el('market-search').emit('input');
  assert.equal(app.el('market-list').children.length, 2); // market entry and pending entry share the name
  app.el('market-refresh').emit('click'); await tick();
  assert.ok(app.requests.some((r) => r.operation === 'catalog' && r.refresh === true));
  assert.equal(app.requests.filter((r) => ['inspect', 'chat'].includes(r.operation)).length, 0);
});

test('null session allows first question via chat, binds snapshot and supports repeated chat', async () => {
  const key = item(1).key;
  const first = deferred(); let chats = 0;
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog()
    : r.operation === 'pending' ? { ok: true, items: [], warnings: [], installedStatus: 'unavailable', pendingLoaded: true }
      : r.operation === 'session' ? { ok: true, session: null }
        : ++chats === 1 ? first.promise : { ok: true, session: snapshotSession(key) }));
  await app.tab('market');
  await app.open();
  assert.equal(app.el('market-send').disabled, true);
  assert.equal(app.el('market-inspect').disabled, false);
  assert.match(app.el('inspection-state').textContent, /尚无/);
  assert.match(app.el('detail-facts').textContent, /javascript:alert/); // inert text only
  assert.equal(app.requests.filter((r) => ['inspect', 'chat'].includes(r.operation)).length, 0);
  assert.deepEqual(app.requests.filter((r) => r.operation === 'session').at(-1), { operation: 'session', key });
  assert.equal(app.el('market-question').disabled, false);
  assert.match(app.el('chat-hint').textContent, /第一次提问会先读公开源码/);
  app.el('market-question').value = '这次更新需要哪些权限？'; app.el('market-question').emit('input');
  assert.equal(app.el('market-send').disabled, false);
  app.el('market-chat').emit('submit'); await tick();
  assert.deepEqual(app.httpRequests.at(-1), { path: '/market/chat', method: 'POST', body: { key, text: '这次更新需要哪些权限？' } });
  assert.equal(app.requests.some((r) => r.operation === 'inspect'), false);
  assert.equal(app.el('market-question').disabled, true);
  assert.equal(app.el('market-send').disabled, true);
  assert.equal(app.el('market-question').value, '', '发出去就清空，不等回答回来');
  assert.match(app.el('market-messages').textContent, /这次更新需要哪些权限/, '自己那句要立刻上屏');
  assert.match(String(app.el('market-messages').children.at(-1).className), /is-typing/, '同时把知意标成在想（三点动画）');
  app.el('market-chat').emit('submit'); await tick();
  assert.equal(chats, 1);
  first.resolve({ ok: true, session: snapshotSession(key) }); await tick();
  assert.equal(app.el('market-question').value, '');
  assert.match(app.el('inspection-facts').textContent, /abc123/);
  assert.match(app.el('inspection-facts').textContent, /test-model/);
  assert.match(app.el('inspection-files').textContent, /index\.js · 读取 120 字符/);
  assert.match(app.el('market-messages').textContent, /<script>not executable<\/script>/);
  for (const text of ['会发出网络请求吗？', '那本地数据呢？']) {
    app.el('market-question').value = text; app.el('market-question').emit('input');
    assert.equal(app.el('market-send').disabled, false);
    app.el('market-chat').emit('submit'); await tick();
    assert.equal(app.el('market-question').value, '');
    const sent = app.requests.at(-1);
    assert.deepEqual(sent, { operation: 'chat', key, text });
  }
});

test('busy record blocks new paid actions but keeps re-read available', async () => {
  const key = item(1).key;
  let busy = true;
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog()
    : busy ? { ok: true, busy: true, session: snapshotSession(key) } : { ok: true, session: snapshotSession(key) }));
  await app.tab('market');
  await app.open();
  assert.equal(app.el('market-question').disabled, true);
  assert.equal(app.el('market-send').disabled, true);
  assert.equal(app.el('market-inspect').disabled, true);
  assert.match(app.el('detail-status').textContent, /上一轮仍在处理，稍后点「读回记录」/);
  assert.match(app.el('inspection-state').textContent, /上一轮仍在处理/);
  assert.match(app.el('chat-hint').textContent, /上一轮仍在处理/);
  assert.equal(app.el('session-retry').disabled, false);
  busy = false;
  app.el('session-retry').emit('click'); await tick();
  assert.equal(app.el('market-question').disabled, false);
  assert.equal(app.el('market-send').disabled, true);
  assert.doesNotMatch(app.el('detail-status').textContent, /上一轮仍在处理/);
});

test('failed request blocks further paid actions until the record is re-read', async () => {
  const key = item(1).key;
  let failed = true;
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog()
    : r.operation === 'session' ? { ok: true, session: snapshotSession(key) }
      : failed ? { ok: false, error: '连接中断' } : { ok: true, session: snapshotSession(key) }));
  await app.tab('market');
  await app.open();
  app.el('market-question').value = '断线时的提问'; app.el('market-question').emit('input');
  app.el('market-chat').emit('submit'); await tick();
  assert.match(app.el('detail-status').textContent, /提问失败.*连接中断.*先「读回记录」核实/);
  assert.equal(app.el('market-question').value, '断线时的提问');
  assert.equal(app.el('market-send').disabled, true);
  assert.equal(app.el('market-inspect').disabled, true);
  assert.match(app.el('inspection-facts').textContent, /abc123/);
  app.el('market-chat').emit('submit'); await tick();
  assert.equal(app.requests.filter((r) => r.operation === 'chat').length, 1);
  failed = false;
  app.el('session-retry').emit('click'); await tick();
  assert.equal(app.el('market-question').disabled, false);
  app.el('market-question').value = '核实后的提问'; app.el('market-question').emit('input');
  assert.equal(app.el('market-send').disabled, false);
  app.el('market-chat').emit('submit'); await tick();
  assert.equal(app.requests.filter((r) => r.operation === 'chat').length, 2);
});

test('POST failures are not success; draft retained and no automatic paid retries', async () => {
  const key = item(1).key;
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog()
    : r.operation === 'session' ? { ok: true, session: snapshotSession(key) }
      : { ok: false, error: '<b>模型不可用</b>' }));
  await app.tab('market');
  await app.open();
  app.el('market-question').value = '保留这份草稿'; app.el('market-question').emit('input');
  app.el('market-chat').emit('submit'); await tick();
  assert.match(app.el('detail-status').textContent, /提问失败.*<b>模型不可用<\/b>/);
  assert.equal(app.el('market-question').value, '保留这份草稿');
  assert.equal(app.el('market-send').disabled, true);
  assert.match(app.el('inspection-state').textContent, /尚未确认/);
  assert.equal(app.requests.filter((r) => ['inspect', 'chat'].includes(r.operation)).length, 1);
  app.el('session-retry').emit('click'); await tick();
  assert.equal(app.el('market-send').disabled, false);
  app.el('detail-close').emit('click'); await app.open();
  assert.equal(app.el('market-question').value, '保留这份草稿');
});

test('slow prior application session never overwrites the next application', async () => {
  const old = deferred();
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog([item(1), item(2)])
    : r.key === item(1).key ? old.promise
      : { ok: true, session: snapshotSession(item(2).key) }));
  await app.tab('market');
  await app.open(0);
  app.el('detail-close').emit('click'); await app.open(1);
  old.resolve({ ok: true, session: snapshotSession(item(1).key, { model: 'wrong-model' }) }); await tick();
  assert.equal(app.el('detail-name').textContent, '应用 2');
  assert.doesNotMatch(app.el('inspection-facts').textContent, /wrong-model/);
});

test('duplicate requests blocked; closing keeps request running and reopening re-reads record', async () => {
  const pending = deferred(); let session = null;
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog()
    : r.operation === 'session' ? { ok: true, session }
      : pending.promise));
  await app.tab('market');
  await app.open();
  app.el('market-inspect').emit('click'); app.el('market-inspect').emit('click'); await tick();
  assert.equal(app.requests.filter((r) => ['inspect', 'chat'].includes(r.operation)).length, 1);
  assert.equal(app.el('market-inspect').disabled, true);
  app.el('detail-close').emit('click'); await app.open();
  assert.equal(app.el('market-inspect').disabled, true);
  session = snapshotSession(item(1).key);
  pending.resolve({ ok: true, session }); await tick();
  assert.match(app.el('inspection-facts').textContent, /abc123/);
  assert.equal(app.el('market-question').disabled, false);
});

test('chat finishing after close/reopen clears only the submitted draft', async () => {
  const key = item(1).key;
  const pending = deferred();
  const app = await mount(async (r) => (r.operation === 'catalog' ? catalog()
    : r.operation === 'session' ? { ok: true, session: snapshotSession(key) } : pending.promise));
  await app.tab('market');
  await app.open();
  app.el('market-question').value = '这条已经发送'; app.el('market-question').emit('input');
  app.el('market-chat').emit('submit'); await tick();
  app.el('detail-close').emit('click'); await app.open();
  assert.equal(app.el('market-question').disabled, true);
  pending.resolve({ ok: true, session: snapshotSession(key) }); await tick();
  assert.equal(app.el('market-question').value, '');
  assert.equal(app.el('market-send').disabled, true);
});

test('stale, malformed and failed reads never unlock follow-up', async () => {
  for (const result of [
    { ok: true, session: snapshotSession(item(1).key, { stale: true }) },
    { ok: true, session: snapshotSession('wrong:key') },
    { ok: false, error: '离线' },
    { ok: true, httpOk: false, session: snapshotSession(item(1).key) },
    { session: snapshotSession(item(1).key) },
    { ok: 'true', session: snapshotSession(item(1).key) },
    { ok: true, session: snapshotSession(item(1).key, { snapshot: {} }) },
  ]) {
    const app = await mount(async (r) => (r.operation === 'catalog' ? catalog() : result));
    await app.tab('market');
    await app.open();
    assert.equal(app.el('market-question').disabled, true);
    assert.equal(app.el('market-send').disabled, true);
    if (result.session?.stale) assert.match(app.el('inspection-state').textContent, /过期/);
    else assert.match(app.el('detail-status').textContent, /读取失败/);
  }
});

test('failed catalog refresh retains previous catalog with explicit error', async () => {
  const app = await mount(async (r) => (r.refresh === true ? { ok: false, error: '目录离线' } : catalog([owned(1)])));
  app.el('market-refresh').emit('click'); await tick();
  assert.match(app.el('catalog-status').textContent, /读取失败.*保留上次目录/);
  assert.match(app.el('market-list').textContent, /应用 1/);
  assert.equal(app.el('market-refresh').disabled, false);
});





test("待审应用的二级页摆出未过审提醒，已上架的不摆", async () => {
  const app = await mount((call) => (call.operation === "pending"
    ? { ok: true, items: [item(2, "pending")], warnings: [], pendingLoaded: true }
    : { ...catalog([item(1)]), pendingLoaded: false }));
  await app.tab("pending");
  for (let i = 0; i < 6 && !app.el("market-list").children.length; i += 1) await tick();
  await app.open();
  assert.equal(app.el("pending-notice").hidden, false, "待审页必须说清没过市场审核");
  assert.match(html, /这一版没有经过市场审核/);
  assert.match(html, /市场不兜底/);
  await app.tab("market");
  await app.open(0);
  assert.equal(app.el("pending-notice").hidden, true, "已上架的不堆免责");
});

test("长版本号不会把待审标记挤没，完整版本留在悬停提示里", async () => {
  const listed = { ...owned(1), version: "1.2.1+dsh-0.2.1-rc.2" };
  const pendingOne = { ...item(1, "pending"), version: "1.2.6+dsh-0.2.1-rc.5" };
  const app = await mount(async (r) => (r.operation === "pending"
    ? { ok: true, items: [pendingOne], warnings: [], pendingLoaded: true }
    : { ...catalog([listed]), pendingLoaded: false }));
  await app.tab("market");
  for (let i = 0; i < 6 && !/待审/.test(app.card(0)?.attributes["aria-label"] || ""); i += 1) await tick();
  const row = app.card(0).children[2];
  assert.equal(row.children[0].textContent, "上架 v1.2.1", "构建元数据不占卡片宽度");
  assert.equal(row.children[1].textContent, "待审 v1.2.6");
  assert.match(app.card(0).attributes.title, /1\.2\.1\+dsh-0\.2\.1-rc\.2/, "完整版本留在悬停提示");
  assert.match(app.card(0).attributes.title, /1\.2\.6\+dsh-0\.2\.1-rc\.5/);
});

test('雷达这边的「正在想…」也只包住自己，跟更新手记一致', () => {
  // 两张卡都收成自己的宽度，免得同一个 App 里两处等待动画长得不一样。
  assert.match(css, /\.market-message\[data-role="assistant"\]\.is-typing \{ width: fit-content/, '等待卡要收成自己的宽度');
  assert.match(css, /\.market-message\[data-role="assistant"\] \{ justify-self: start; width: 100%/, '回答正文那张卡照旧整幅宽');
});
