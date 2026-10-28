// panel-layout.js — 新骨架的交互层：左栏切页、概览总开关、打开页面自动开球。
//
// 这里不重写任何设置逻辑。概览上的拨杆只是去点对应页面里那个真实控件，
// 让 panel.js 本来那套保存流程照常跑，避免两套状态各说各话。

import { hana } from './sdk.js';

const VIEW_KEY = 'zhiyiPanelView';
const BALL_AUTO_KEY = 'ballAutoOpenOnPage';

const railItems = [...document.querySelectorAll('.rail-item[data-view]')];
const views = [...document.querySelectorAll('.view')];
const channel = ('BroadcastChannel' in window) ? new BroadcastChannel('zhiyi-panel-view') : null;

/* ── 切页 ── */
function showView(id, { focus = false } = {}) {
  if (!views.some((view) => view.id === `view-${id}`)) id = 'overview';
  for (const item of railItems) {
    item.setAttribute('aria-current', item.dataset.view === id ? 'page' : 'false');
  }
  for (const view of views) {
    view.classList.toggle('on', view.id === `view-${id}`);
  }
  try { localStorage.setItem(VIEW_KEY, id); } catch {}
  channel?.postMessage({ view: id, from: 'panel' });
  document.querySelector('.workspace')?.scrollTo({ top: 0 });
  if (id === 'overview') syncOverview();
  if (id === 'overview') void refreshZoomState();
  if (focus) document.querySelector(`.rail-item[data-view="${id}"]`)?.focus();
}

for (const item of railItems) {
  item.addEventListener('click', () => showView(item.dataset.view));
}

// 左栏（nav.html）点一下，主页面跟着切。只认 nav 发来的，避开自己广播回来那圈。
channel?.addEventListener('message', (event) => {
  const view = event.data?.view;
  if (event.data?.from === 'nav' && typeof view === 'string' && view) showView(view);
});
window.addEventListener('message', (event) => {
  if (event.data?.type === 'zhiyi-view' && typeof event.data.view === 'string') showView(event.data.view);
});

/* ── 概览：读真实控件，点一下就转过去 ── */
const ov = {
  ask: () => pressedValue('#ask-display'),
  rec: () => pressedValue('#rec-display'),
  summary: () => checkboxValue('#summary-enabled'),
  voice: () => pressedValue('#voice-enabled'),
};

// 各处分段的「开」值不统一（推荐用的是 ball），所以只看 off，其余一律算开。
function pressedValue(selector) {
  const host = document.querySelector(selector);
  if (!host) return null;
  const active = host.querySelector('button[aria-pressed="true"]');
  if (!active) return null;
  return active.dataset.value !== 'off';
}

function checkboxValue(selector) {
  const box = document.querySelector(selector);
  if (!box) return null;
  return box.checked === true;
}

const OVERVIEW_MAP = [
  { key: 'ask', row: 'ov-ask' },
  { key: 'rec', row: 'ov-rec' },
  { key: 'summary', row: 'ov-summary' },
  { key: 'voice', row: 'ov-voice' },
];

function syncOverview() {
  for (const { key, row } of OVERVIEW_MAP) {
    const el = document.querySelector(`#${row}`);
    if (!el) continue;
    const value = ov[key]();
    const tg = el.querySelector('.zy-tg');
    const ready = value !== null;
    el.classList.toggle('is-off', value === false);
    if (tg) {
      tg.classList.toggle('on', value === true);
      tg.disabled = !ready;
      tg.title = ready ? '' : '还没读到这个设置';
    }
  }
  // 关机不是常驻开关，只看它现在是不是在守着。
  const sgRow = document.querySelector('#ov-sleep');
  if (sgRow) {
    sgRow.classList.toggle('is-off', !sleepWatching);
    const go = sgRow.querySelector('.zy-ov-go');
    if (go) go.textContent = sleepWatching ? '关机中 · 去看看' : '去看看';
    paintSleepAction();
  }
}

function clickReal(selector, value) {
  const host = document.querySelector(selector);
  const button = host?.querySelector(`button[data-value="${value}"]`);
  if (!button || button.disabled) return false;
  button.click();
  return true;
}

const OVERVIEW_ACTIONS = {
  ask: () => clickReal('#ask-display', ov.ask() ? 'off' : 'on'),
  // 推荐那条开着的时候用的是「在球里展示」，关掉就是 off；再打开回到 ball。
  rec: () => clickReal('#rec-display', ov.rec() ? 'off' : 'ball'),
  summary: () => {
    const box = document.querySelector('#summary-enabled');
    if (!box || box.disabled) return false;
    box.click();
    return true;
  },
  voice: () => clickReal('#voice-enabled', ov.voice() ? 'off' : 'on'),
};

for (const { key, row } of OVERVIEW_MAP) {
  const el = document.querySelector(`#${row}`);
  if (!el) continue;
  const run = (event) => {
    event.preventDefault();
    OVERVIEW_ACTIONS[key]?.();
    // 让 panel.js 的异步保存先落地，再回读一次真实状态
    setTimeout(syncOverview, 450);
  };
  el.addEventListener('click', run);
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') run(event);
  });
}

document.querySelector('#ov-sleep')?.addEventListener('click', () => showView('auto'));
document.querySelector('#ov-sleep')?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') showView('auto');
});

/* ── 概览上的关机按钮：点一下就直接挂上，不用先去另一页 ── */
let sleepWatching = false;
const sleepAction = document.querySelector('#ov-sleep-action');

function paintSleepAction() {
  if (!sleepAction) return;
  sleepAction.textContent = sleepWatching ? '取消关机' : '开启关机';
  sleepAction.dataset.armed = sleepWatching ? '1' : '0';
  sleepAction.title = sleepWatching ? '取消这次关机' : '开启以后，全部停下来就关掉电脑';
}

sleepAction?.addEventListener('click', async (event) => {
  // 按钮在整行里面，不拦住就会连着“去看看”一起跳页。
  event.stopPropagation();
  sleepAction.disabled = true;
  const previous = sleepAction.textContent;
  sleepAction.textContent = sleepWatching ? '正在撤…' : '正在挂…';
  try {
    const path = sleepWatching ? '/sleep-guard/cancel' : '/sleep-guard/arm';
    const response = await hana.api.fetch(path, { method: 'POST' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '没成，再试一次。');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await refreshSleepState();
  } catch (error) {
    sleepAction.textContent = previous;
    sleepAction.title = error?.message || '没成，再试一次。';
  } finally {
    sleepAction.disabled = false;
  }
});

// 概览上的状态自己读，不依赖另一页的文本。
async function refreshSleepState() {
  try {
    const response = await hana.api.fetch('/sleep-guard');
    const snapshot = await response.json();
    sleepWatching = snapshot?.armed === true;
    const sgRow = document.querySelector('#ov-sleep');
    sgRow?.classList.toggle('is-off', !sleepWatching);
    const go = sgRow?.querySelector('.zy-ov-go');
    if (go) go.textContent = sleepWatching ? '关机中 · 去看看' : '去看看';
    paintSleepAction();
  } catch {
    // 读不到就维持现状，不要把按钮弄乱
  }
}

/* ── 概览上的「输入框图片放大」：只负责把脚本装进 Hana 当前版本，装没装自己读 ── */
const zoomRow = document.querySelector('#ov-zoom');
const zoomAction = document.querySelector('#ov-zoom-action');
const zoomDesc = document.querySelector('#ov-zoom-desc');
let zoomInstalled = null;

const ZOOM_CODE_TEXT = {
  NO_DIR: '还没找到 Hana 的界面目录，先启动一次 Hana 再来。',
  NO_SOURCE: '知意自带的放大脚本没找到，重装一次知意。',
  INSTALL_FAILED: '写进去了但没验过，这次没算装上，再点一次。',
  UNINSTALL_FAILED: '没卸干净，再点一次。',
  BAD_ACTION: '安装助手没认出这次请求，再点一次。',
  FAILED: '这次没读完，点重试再来一次。',
};

function zoomErrorText(status) {
  return status?.message || status?.error || ZOOM_CODE_TEXT[status?.code] || '读不到 Hana 的界面目录，稍后再看。';
}

function paintZoom(status) {
  if (!zoomRow || !zoomAction || !zoomDesc) return;
  if (!status || status.ok !== true) {
    zoomInstalled = null;
    zoomRow.classList.add('is-off');
    zoomDesc.textContent = zoomErrorText(status);
    zoomAction.textContent = '重试';
    return;
  }
  if (status.found === false) {
    zoomInstalled = false;
    zoomRow.classList.add('is-off');
    zoomDesc.textContent = ZOOM_CODE_TEXT[status.code] || status.reason || '还没找到 Hana 的界面目录。';
    zoomAction.textContent = '重试';
    return;
  }
  zoomInstalled = status.installed === true;
  zoomRow.classList.toggle('is-off', !zoomInstalled);
  zoomAction.textContent = zoomInstalled ? '已装好' : '装上';
  zoomDesc.textContent = zoomInstalled
    ? `当前 Hana ${status.version}。点缩略图就全屏，滚轮缩放，Esc 关。`
    : `当前 Hana ${status.version}，这个版本还没装。装上以后重启一次 Hana 才能用。`;
}

async function refreshZoomState() {
  try {
    const response = await hana.api.fetch('/input-zoom');
    const payload = await response.json().catch(() => ({}));
    paintZoom(payload);
  } catch {
    paintZoom(null);
  }
}

zoomAction?.addEventListener('click', async (event) => {
  event.stopPropagation();
  if (zoomInstalled === true) {
    zoomDesc.textContent = '已经装上了。要是点图没反应，完全退出 Hana 再启动一次。';
    return;
  }
  zoomAction.disabled = true;
  const previous = zoomAction.textContent;
  zoomAction.textContent = '正在装…';
  try {
    const response = await hana.api.fetch('/input-zoom/install', { method: 'POST' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok !== true) throw new Error(zoomErrorText(payload));
    // 只认「文件确实在位」这一条：以前这里不看安装结果就把「装好了」写在脸上，
    // 结果脚本其实什么都没写。现在装不上就照实说装不上。
    if (payload.installed !== true) {
      paintZoom(payload);
      throw new Error(zoomErrorText(payload));
    }
    paintZoom(payload);
    zoomDesc.textContent = `装好了。完全退出 Hana 再启动（托盘也要退干净），点输入框里的缩略图就能放大。当前 Hana ${payload.version || ''}。`;
  } catch (error) {
    zoomAction.textContent = previous;
    zoomDesc.textContent = error?.message || '没装成，再点一次。';
  } finally {
    zoomAction.disabled = false;
  }
});

void refreshZoomState();

// 停在概览上时，状态变了要跟着变（球可能被别处开关）。
setInterval(() => {
  if (document.querySelector('#view-overview')?.classList.contains('on')) syncOverview();
}, 3000);

// 关机状态跟别的开关不一样，自己拉一次，以免错过另一边动的时机。
setInterval(() => {
  if (document.querySelector('#view-overview')?.classList.contains('on')) void refreshSleepState();
}, 6000);

/* ── 打开页面自动开球 ── */
let manualBallOff = false;
let autoKickDone = false;

// 页头那个传音樱胶囊就是真开关（开关动作归 panel.js），这里只记一笔
// 「这次是不是手动关的」，免得切回窗口时又被「自动开球」拉起来。
document.querySelector('#ball-toggle')?.addEventListener('click', (event) => {
  manualBallOff = event.currentTarget.getAttribute('aria-pressed') === 'true';
});

async function readAutoOpen() {
  try {
    const response = await hana.api.fetch('/ball-auto-open');
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.enabled === true;
  } catch {
    return false;
  }
}

async function writeAutoOpen(enabled) {
  const response = await hana.api.fetch('/ball-auto-open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) throw new Error(payload?.error || '没存上');
  return payload?.enabled === true;
}

const autoToggle = document.querySelector('#ball-auto-open');

async function paintAutoToggle() {
  if (!autoToggle) return;
  autoToggle.classList.toggle('on', await readAutoOpen());
}

async function announceAutoOpen() {
  const note = document.querySelector('#ball-auto-open-status');
  if (!note) return;
  try {
    note.textContent = (await readAutoOpen())
      ? '开着：下次进这个页面会顺手把球亮起来。'
      : '关着：进这个页面不会动球，要用请自己开。';
  } catch {
    note.textContent = '';
  }
}

autoToggle?.addEventListener('click', async () => {
  const next = !autoToggle.classList.contains('on');
  autoToggle.classList.toggle('on', next);
  try {
    await writeAutoOpen(next);
  } catch (error) {
    autoToggle.classList.toggle('on', !next);
    const note = document.querySelector('#ball-auto-open-status');
    if (note) note.textContent = String(error?.message || '没存上，再点一次。');
    return;
  }
  await announceAutoOpen();
});

/* ── 全屏时弹窗也浮上来 ── */
// 关着的时候，球在全屏应用面前会自已躲起来，有事要弹的窗也一起让到后面；
// 开着就一律压在最上面，打游戏、看视频也能看到。
const popupToggle = document.querySelector('#popup-on-top');

async function readPopupOnTop() {
  try {
    const response = await hana.api.fetch('/popup-on-top');
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.enabled === true;
  } catch {
    return false;
  }
}

async function writePopupOnTop(enabled) {
  const response = await hana.api.fetch('/popup-on-top', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) throw new Error(payload?.error || '没存上');
  return payload?.enabled === true;
}

async function paintPopupToggle() {
  if (!popupToggle) return;
  popupToggle.classList.toggle('on', await readPopupOnTop());
}

popupToggle?.addEventListener('click', async () => {
  const next = !popupToggle.classList.contains('on');
  popupToggle.classList.toggle('on', next);
  try {
    await writePopupOnTop(next);
  } catch {
    popupToggle.classList.toggle('on', !next);
  }
});

void paintPopupToggle();

async function kickBallIfWanted() {
  if (manualBallOff || autoKickDone) return;
  autoKickDone = true;
  try {
    if (!(await readAutoOpen())) return;
    const status = await hana.api.fetch('/ball/status');
    const state = await status.json().catch(() => ({}));
    if (state?.running === true || state?.stopping === true) return;
    await hana.api.fetch('/ball/start', { method: 'POST' });
  } catch {
    // 球起不来不该把页面拖住，面板上本来就会显示状态。
  }
}

// 页面刚打开
void kickBallIfWanted();
// 从别的窗口切回来也算"打开一次"
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    autoKickDone = false;
    manualBallOff = false;
    void kickBallIfWanted();
    void paintAutoToggle();
  }
});

/* ── 启动 ── */
let remembered = '';
try { remembered = localStorage.getItem(VIEW_KEY) || ''; } catch {}
if (location.hash.startsWith('#view=')) remembered = location.hash.slice(6);
showView(remembered || 'overview');
void paintAutoToggle();
void announceAutoOpen();
void refreshSleepState();
