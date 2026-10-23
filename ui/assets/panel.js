import { hana } from './sdk.js';
import { initPermissionStatus } from './permission-status.js';

const themeLink = document.createElement('link');
themeLink.rel = 'stylesheet';
themeLink.dataset.hostTheme = 'true';
document.head.append(themeLink);

function syncHostTheme() {
  const snapshot = hana.theme?.getSnapshot?.();
  if (snapshot?.cssUrl && themeLink.href !== snapshot.cssUrl) {
    themeLink.href = snapshot.cssUrl;
  }
  if (snapshot?.appearance === 'light' || snapshot?.appearance === 'dark') {
    document.documentElement.dataset.appearance = snapshot.appearance;
  }
}

const startButton = document.querySelector('#ball-toggle');
const ballStatus = document.querySelector('#ball-status');
const ballToggleLabel = document.querySelector('#ball-toggle-label');
const ballToggleSwitch = startButton?.querySelector('.ball-toggle-switch');
const ballModalState = document.querySelector('#ball-modal-state');
let currentBallState = { running: false, stopping: false, error: '' };

function setBallState(state) {
  if (!ballStatus) return;
  currentBallState = {
    running: state?.running === true,
    stopping: state?.stopping === true,
    error: typeof state?.error === 'string' ? state.error : '',
  };
  ballStatus.textContent = currentBallState.stopping
    ? currentBallState.error || '传音樱正在关闭，请稍候。'
    : currentBallState.running
      ? currentBallState.error || '传音樱已启动：关键提问、送推荐、理顺、起标题、念给我听都在传音樱里。'
      : currentBallState.error || '传音樱没开：伙伴会在原对话里放一张知意选择卡。';
  if (startButton) {
    startButton.setAttribute('aria-pressed', String(currentBallState.running));
    startButton.classList.toggle('is-on', currentBallState.running);
    startButton.disabled = currentBallState.stopping;
    startButton.title = currentBallState.running ? '收起桌面传音樱' : '开启桌面传音樱';
  }
  // 胶囊里的标签固定写「传音樱」，开关状态由拨杆和下面那行状态文案表达
  if (ballToggleLabel) {
    ballToggleLabel.textContent = currentBallState.stopping ? '传音樱（关闭中）' : '传音樱';
  }
  if (ballToggleSwitch) {
    ballToggleSwitch.classList.toggle('on', currentBallState.running);
  }
  if (ballModalState) {
    ballModalState.textContent = currentBallState.stopping
      ? '正在关闭'
      : currentBallState.running ? '已启动' : '未启动';
  }
}

function showBallError(error, fallback) {
  const message = error?.message || fallback;
  const returnedState = error?.state && typeof error.state.running === 'boolean'
    ? error.state
    : { ...currentBallState, error: message };
  if (!returnedState.error) returnedState.error = message;
  setBallState(returnedState);
}

async function requestBall(path) {
  const response = await hana.api.fetch(path, { method: path.endsWith('/status') ? 'GET' : 'POST' });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('传音樱状态读取失败。'); }
  if (!response.ok) {
    const error = new Error(payload?.error || '传音樱操作失败。');
    if (payload && typeof payload.running === 'boolean') error.state = payload;
    throw error;
  }
  return payload;
}

async function refreshBallStatus() {
  try { setBallState(await requestBall('/ball/status')); }
  catch (error) { showBallError(error, '传音樱状态读取失败。'); }
}

startButton?.addEventListener('click', async () => {
  const running = currentBallState.running;
  startButton.disabled = true;
  ballStatus.textContent = running ? '正在收起传音樱…' : '正在启动传音樱…';
  try { setBallState(await requestBall(running ? '/ball/stop' : '/ball/start')); }
  catch (error) { showBallError(error, running ? '收起传音樱失败。' : '传音樱启动失败。'); }
  finally { startButton.disabled = currentBallState.stopping; }
});

const summaryEnabled = document.querySelector('#summary-enabled');
const summaryMinChars = document.querySelector('#summary-min-chars');
const summaryMinCharsDown = document.querySelector('#summary-min-chars-down');
const summaryMinCharsUp = document.querySelector('#summary-min-chars-up');
const summarySave = document.querySelector('#summary-save');
const summaryStatus = document.querySelector('#summary-status');
const summaryRetry = document.querySelector('#summary-retry');
const SUMMARY_MIN_CHARS_MIN = 1;
const SUMMARY_MIN_CHARS_MAX = 20000;
const SUMMARY_MIN_CHARS_STEP = 50;
let summaryConfig = { enabled: true, minChars: 600 };
let pendingSummaryMinChars = 600;
let summaryLoaded = false;
let summarySaving = false;

function summarySettingsDirty() {
  if (!summaryLoaded) return false;
  const enabled = summaryEnabled ? summaryEnabled.checked : summaryConfig.enabled;
  return enabled !== summaryConfig.enabled || pendingSummaryMinChars !== summaryConfig.minChars;
}

function renderSummary() {
  if (summaryMinChars) summaryMinChars.textContent = String(pendingSummaryMinChars);
  if (summaryMinCharsDown) summaryMinCharsDown.disabled = !summaryLoaded || summarySaving || pendingSummaryMinChars < SUMMARY_MIN_CHARS_MIN + SUMMARY_MIN_CHARS_STEP;
  if (summaryMinCharsUp) summaryMinCharsUp.disabled = !summaryLoaded || summarySaving || pendingSummaryMinChars > SUMMARY_MIN_CHARS_MAX - SUMMARY_MIN_CHARS_STEP;
  if (summaryEnabled) summaryEnabled.disabled = !summaryLoaded || summarySaving;
  if (summarySave) {
    const dirty = summarySettingsDirty();
    summarySave.disabled = !summaryLoaded || summarySaving || !dirty;
    summarySave.classList.toggle('is-saved', !dirty);
    summarySave.textContent = dirty ? '保存' : '已保存 ✓';
  }
  if (!summaryLoaded || !summaryStatus) return;
  const enabled = summaryEnabled ? summaryEnabled.checked : summaryConfig.enabled;
  summaryStatus.textContent = enabled === false
    ? '已关闭，长回复不再附速览。'
    : `正文达到 ${pendingSummaryMinChars} 字时会在末尾附一段速览；原文完整保留。`;
}

function stepSummaryMinChars(delta) {
  if (!summaryLoaded || summarySaving) return;
  const next = Math.trunc(pendingSummaryMinChars + delta);
  if (next < SUMMARY_MIN_CHARS_MIN || next > SUMMARY_MIN_CHARS_MAX) return;
  pendingSummaryMinChars = next;
  renderSummary();
}

async function loadSummary() {
  if (!summaryEnabled && !summaryMinChars) return;
  summaryLoaded = false;
  renderSummary();
  if (summaryStatus) summaryStatus.textContent = '正在读取设置…';
  if (summaryRetry) {
    summaryRetry.hidden = true;
    summaryRetry.disabled = true;
    summaryRetry.textContent = '正在读取…';
  }
  try {
    const response = await hana.api.fetch('/summary-config');
    if (!response.ok) throw new Error('读取失败');
    const payload = await response.json();
    summaryConfig = { enabled: payload.enabled !== false, minChars: Number(payload.minChars) || 600 };
    pendingSummaryMinChars = summaryConfig.minChars;
    if (summaryEnabled) summaryEnabled.checked = summaryConfig.enabled;
    summaryLoaded = true;
    if (summaryRetry) {
      summaryRetry.hidden = true;
      summaryRetry.disabled = false;
      summaryRetry.textContent = '重试读取';
    }
    renderSummary();
  } catch {
    if (summaryStatus) summaryStatus.textContent = '读取失败，设置已锁定；重试成功后才能修改。';
    if (summaryRetry) {
      summaryRetry.hidden = false;
      summaryRetry.disabled = false;
      summaryRetry.textContent = '重试读取';
    }
    renderSummary();
  }
}

async function saveSummary() {
  if (!summaryLoaded || summarySaving || !summarySettingsDirty()) return;
  summarySaving = true;
  renderSummary();
  if (summaryStatus) summaryStatus.textContent = '正在保存…';
  try {
    const response = await hana.api.fetch('/summary-config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: summaryEnabled ? summaryEnabled.checked : true,
        minChars: pendingSummaryMinChars,
      }),
    });
    if (!response.ok) throw new Error('保存失败');
    const payload = await response.json();
    summaryConfig = { enabled: payload.enabled !== false, minChars: Number(payload.minChars) || 600 };
    pendingSummaryMinChars = summaryConfig.minChars;
    if (summaryEnabled) summaryEnabled.checked = summaryConfig.enabled;
    summarySaving = false;
    renderSummary();
    if (summaryStatus) summaryStatus.textContent = '已保存。';
  } catch {
    summarySaving = false;
    renderSummary();
    if (summaryStatus) summaryStatus.textContent = '保存失败，请重试。';
  }
}

summaryMinCharsDown?.addEventListener('click', () => stepSummaryMinChars(-SUMMARY_MIN_CHARS_STEP));
summaryMinCharsUp?.addEventListener('click', () => stepSummaryMinChars(SUMMARY_MIN_CHARS_STEP));
summarySave?.addEventListener('click', saveSummary);
summaryEnabled?.addEventListener('change', saveSummary);
summaryRetry?.addEventListener('click', loadSummary);
loadSummary();

// ── 断点续接：设置页直接可见（2026-10-23 用户拍板，拆掉冻结层）──
// 以前这里把整块设置藏着，要连点标题五次、再输对暗号才露出来。
// 现在不做这一层：开关与轮数就是普通设置，进来就能改。

// ── 断点续接：独立总开关，正常聊天循环配置不在这里写入 ──
const resumeSettings = (() => {
  const enabledGroup = document.querySelector('#resume-enabled');
  const autoGroup = document.querySelector('#resume-auto');
  const value = document.querySelector('#resume-max');
  const down = document.querySelector('#resume-max-down');
  const up = document.querySelector('#resume-max-up');
  const save = document.querySelector('#resume-save');
  const status = document.querySelector('#resume-status');
  const retry = document.querySelector('#resume-retry');
  if (!enabledGroup || !autoGroup || !value || !status) return null;
  let saved = { enabled: false, autoResume: false, maxConsecutive: 3 };
  let draft = { ...saved };
  let loaded = false;
  let busy = false;
  const normalize = (config) => ({
    enabled: config?.enabled === true,
    autoResume: config?.autoResume === true,
    maxConsecutive: Math.max(1, Math.min(10, Math.trunc(Number(config?.maxConsecutive) || 3))),
  });
  const dirty = () => Object.keys(draft).some((key) => draft[key] !== saved[key]);
  const render = () => {
    for (const [group, selected, locked] of [
      [enabledGroup, draft.enabled, !loaded || busy],
      [autoGroup, draft.autoResume, !loaded || busy || !draft.enabled],
    ]) {
      for (const button of group.querySelectorAll('button')) {
        button.setAttribute('aria-pressed', String((button.dataset.value === 'on') === selected));
        button.disabled = locked;
      }
    }
    value.textContent = String(draft.maxConsecutive);
    if (down) down.disabled = !loaded || busy || !draft.enabled || draft.maxConsecutive <= 1;
    if (up) up.disabled = !loaded || busy || !draft.enabled || draft.maxConsecutive >= 10;
    if (save) {
      save.disabled = !loaded || busy || !dirty();
      save.classList.toggle('is-saved', loaded && !dirty());
      save.textContent = busy ? '正在保存…' : dirty() ? '保存' : '已保存 ✓';
    }
  };
  const request = async (method = 'GET') => {
    const response = await hana.api.fetch('/resume-config', {
      method,
      ...(method === 'PUT' ? { headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: Object.fromEntries(
          Object.entries(draft).filter(([key, entry]) => entry !== saved[key])
        ) }) } : {}),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '续接设置不可用');
    return normalize(payload.config);
  };
  const persist = async () => {
    if (!loaded || busy || !dirty()) return;
    busy = true;
    render();
    status.textContent = '正在保存续接设置…';
    try {
      saved = await request('PUT');
      draft = { ...saved };
      status.textContent = saved.enabled
        ? `已保存：${saved.autoResume ? '后台自动续接' : '传音樱内手动提醒'}，每窗口最多连续 ${saved.maxConsecutive} 次。`
        : '已关闭：不检测、不发送、不显示断点提醒。';
      refreshResumeStatus();
    } catch (error) {
      draft = { ...saved };
      status.textContent = `${error?.message || '保存失败'}，已保留原设置，请重试。`;
    } finally { busy = false; render(); }
  };
  const load = async () => {
    loaded = false;
    busy = true;
    render();
    if (retry) retry.hidden = true;
    status.textContent = '正在读取续接设置…';
    try {
      saved = await request();
      draft = { ...saved };
      loaded = true;
      status.textContent = saved.enabled
        ? `已开启：${saved.autoResume ? '后台自动续接' : '手动提醒（需开启传音樱）'}，每窗口最多 ${saved.maxConsecutive} 次。`
        : '断点续接已关闭。';
    } catch (error) {
      status.textContent = `${error?.message || '读取失败'}；读取成功前不能修改。`;
      if (retry) retry.hidden = false;
    } finally { busy = false; render(); }
  };
  for (const [group, key] of [[enabledGroup, 'enabled'], [autoGroup, 'autoResume']]) {
    group.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-value]');
      if (!button || button.disabled || busy || !loaded) return;
      draft[key] = button.dataset.value === 'on';
      persist();
    });
  }
  for (const [button, step] of [[down, -1], [up, 1]]) {
    button?.addEventListener('click', () => {
      if (!loaded || busy || !draft.enabled) return;
      draft.maxConsecutive = Math.max(1, Math.min(10, draft.maxConsecutive + step));
      render();
      status.textContent = '上限已调整，点保存生效。';
    });
  }
  save?.addEventListener('click', persist);
  retry?.addEventListener('click', load);
  return { load };
})();

async function refreshResumeStatus() {
  const button = document.querySelector('#resume-refresh-status');
  const status = document.querySelector('#resume-result-status');
  const list = document.querySelector('#resume-results');
  if (!status || !list) return;
  if (button) button.disabled = true;
  status.textContent = '正在读取当前续接结果…';
  try {
    const response = await hana.api.fetch('/resume-status');
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '续接结果读取失败');
    const progress = Array.isArray(payload.progress) ? payload.progress : (Array.isArray(payload.items) ? payload.items : []);
    const items = payload.config?.enabled === false ? [] : progress;
    list.replaceChildren();
    for (const item of items) {
      const row = document.createElement('li');
      const source = document.createElement('strong');
      source.textContent = `${item.agentName || '伙伴'} ·「${item.title || item.firstMessage || '未命名窗口'}」`;
      const detail = document.createElement('p');
      const state = { waiting: '等待恢复', failed: '未能恢复', limit: '达到上限，已停止续接' }[item.status] || '待处理';
      detail.textContent = `已发送 ${Number(item.attempt) || 0}/${Number(item.maxConsecutive) || 3} 次 · ${state}`;
      row.append(source, detail);
      list.appendChild(row);
    }
    list.hidden = !items.length;
    status.textContent = items.length ? `${items.length} 个窗口的当前结果` : '当前没有续接记录。';
  } catch (error) {
    list.replaceChildren();
    list.hidden = true;
    status.textContent = `${error?.message || '读取失败'}，请点刷新结果重试。`;
  } finally { if (button) button.disabled = false; }
}
document.querySelector('#resume-refresh-status')?.addEventListener('click', refreshResumeStatus);

// 断点续接设置页进来就读，不再有冻结那一层拦在前面。
void Promise.resolve().then(() => {
  resumeSettings?.load();
  void refreshResumeStatus();
});

// ── 内容模型 ──
// 推荐回复、Ask 判断、长回复速览共用这一条：选一次，三个调用点都用它。
// 不选就跟随发起那一轮的当前模型，所以多数时候根本不用管。
const contentModelTrigger = document.querySelector('#content-model-trigger');
const contentModelOptionsHost = document.querySelector('#content-model-options');
const contentModelTestButton = document.querySelector('#content-model-test');
const contentModelSaveButton = document.querySelector('#content-model-save');
const contentModelStatus = document.querySelector('#content-model-status');
let contentModels = [];
let originalContentModelKey = 'follow';
let pendingContentModelKey = 'follow';

function contentModelKeyOf(ref) {
  return ref?.provider && ref?.model ? `${ref.provider}/${ref.model}` : 'follow';
}

function contentModelLabel(key) {
  if (key === 'follow') {
    const current = contentModels.find((item) => item.isCurrent);
    return current ? `跟随 Hana 当前模型（${current.name}）` : '跟随 Hana 当前模型';
  }
  const found = contentModels.find((item) => item.key === key);
  return found ? `${found.name}${found.isCurrent ? '（当前）' : ''}` : `${key}（已不在列表，需重新选）`;
}

function closeContentModelOptions() {
  contentModelOptionsHost?.setAttribute('hidden', '');
  contentModelTrigger?.setAttribute('aria-expanded', 'false');
}

function syncContentModelControls() {
  const unchanged = pendingContentModelKey === originalContentModelKey;
  const valid = !pendingContentModelKey || contentModels.some((item) => item.key === pendingContentModelKey);
  if (contentModelSaveButton) {
    contentModelSaveButton.disabled = unchanged || !valid;
    contentModelSaveButton.classList.toggle('is-saved', unchanged);
    contentModelSaveButton.textContent = unchanged ? '已保存 ✓' : '保存选择';
  }
  if (contentModelTestButton) contentModelTestButton.disabled = !contentModels.length || !valid;
}

function renderContentModelOptions() {
  if (!contentModelOptionsHost || !contentModelTrigger) return;
  contentModelOptionsHost.replaceChildren();
  const choices = [{ key: 'follow', label: contentModelLabel('follow') }, ...contentModels.map((item) => ({
    key: item.key,
    label: contentModelLabel(item.key),
  }))];
  if (originalContentModelKey !== 'follow' && !contentModels.some((item) => item.key === originalContentModelKey)) {
    choices.push({ key: originalContentModelKey, label: contentModelLabel(originalContentModelKey) });
  }
  for (const choice of choices) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'model-option';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(choice.key === pendingContentModelKey));
    const mark = document.createElement('span');
    mark.className = 'model-option-mark';
    mark.textContent = '✓';
    const label = document.createElement('span');
    label.className = 'model-option-label';
    label.textContent = choice.label;
    option.append(mark, label);
    option.addEventListener('click', () => {
      pendingContentModelKey = choice.key;
      closeContentModelOptions();
      renderContentModelOptions();
      syncContentModelControls();
    });
    contentModelOptionsHost.appendChild(option);
  }
  contentModelTrigger.textContent = contentModelLabel(pendingContentModelKey);
}

function selectedContentModelRef() {
  if (pendingContentModelKey === 'follow') return null;
  const found = contentModels.find((item) => item.key === pendingContentModelKey);
  return found ? { provider: found.provider, model: found.model } : undefined;
}

async function contentModelRequest(method = 'GET', body = null, path = '/content-model') {
  const response = await hana.api.fetch(path, {
    method,
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('模型设置读取失败。'); }
  if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '模型设置读取失败。');
  return payload;
}

async function loadContentModel() {
  if (!contentModelTrigger) return;
  try {
    const payload = await contentModelRequest();
    contentModels = Array.isArray(payload.models) ? payload.models : [];
    originalContentModelKey = contentModelKeyOf(payload.modelRef);
    pendingContentModelKey = originalContentModelKey;
    contentModelTrigger.disabled = false;
    renderContentModelOptions();
    syncContentModelControls();
    const stale = originalContentModelKey !== 'follow' && !contentModels.some((item) => item.key === originalContentModelKey);
    const current = contentModels.find((item) => item.isCurrent);
    contentModelStatus.textContent = stale
      ? '原先选的模型已不在列表；请改选一条，或切回跟随当前模型。'
      : !contentModels.length
        ? 'Hana 模型列表为空；可以先跟随当前模型。'
        : payload.merged
          ? '推荐、Ask 判断和速览原来用的是不同模型，这里取了一条；保存后三处统一。'
          : (originalContentModelKey === 'follow'
            ? (current ? `当前跟随 ${current.name}；你也可以单独指定一条。` : '尚未识别当前模型，请先从列表里选一条。')
            : '推荐、Ask 判断和速览都用你指定的这一条。');
  } catch (error) {
    contentModelTrigger.textContent = '模型列表不可用';
    contentModelTrigger.disabled = true;
    if (contentModelTestButton) contentModelTestButton.disabled = true;
    if (contentModelSaveButton) {
      contentModelSaveButton.disabled = true;
      contentModelSaveButton.classList.remove('is-saved');
      contentModelSaveButton.textContent = '状态未知';
    }
    contentModelStatus.textContent = error?.message || '读取模型列表失败；请确认知意已获模型使用权限。';
  }
}

contentModelTrigger?.addEventListener('click', () => {
  if (contentModelTrigger.disabled) return;
  const open = contentModelOptionsHost.hasAttribute('hidden');
  if (open) {
    contentModelOptionsHost.removeAttribute('hidden');
    contentModelTrigger.setAttribute('aria-expanded', 'true');
  } else closeContentModelOptions();
});

document.addEventListener('click', (event) => {
  if (!contentModelOptionsHost?.parentElement?.contains(event.target)) closeContentModelOptions();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeContentModelOptions();
});

contentModelTestButton?.addEventListener('click', async () => {
  const modelRef = selectedContentModelRef();
  if (modelRef === undefined) return;
  contentModelTestButton.disabled = true;
  contentModelTrigger.disabled = true;
  if (contentModelSaveButton) contentModelSaveButton.disabled = true;
  contentModelTestButton.textContent = '正在测试…';
  contentModelStatus.textContent = '正在做短测，不会保存选择…';
  try {
    // 测试走 /content-model/test；以前和保存共用 '/content-model'，而服务端那条没有 POST，
    // 于是每次点「测试连接」都只能拿到「模型设置读取失败」。
    const payload = await contentModelRequest('POST', { modelRef }, '/content-model/test');
    contentModelStatus.textContent = `连接正常：${payload.name || payload.model}。这次测试没有保存选择。`;
    contentModelTestButton.textContent = '重新测试';
  } catch (error) {
    contentModelStatus.textContent = error?.message || '连接测试失败，请检查模型配置和应用权限。';
    contentModelTestButton.textContent = '重试连接';
  } finally {
    contentModelTrigger.disabled = false;
    syncContentModelControls();
  }
});

contentModelSaveButton?.addEventListener('click', async () => {
  const modelRef = selectedContentModelRef();
  if (modelRef === undefined) return;
  contentModelSaveButton.disabled = true;
  contentModelTrigger.disabled = true;
  if (contentModelTestButton) contentModelTestButton.disabled = true;
  contentModelSaveButton.classList.remove('is-saved');
  contentModelSaveButton.textContent = '正在保存…';
  contentModelStatus.textContent = '正在保存…';
  try {
    const payload = await contentModelRequest('PUT', { modelRef });
    originalContentModelKey = contentModelKeyOf(payload.modelRef);
    pendingContentModelKey = originalContentModelKey;
    renderContentModelOptions();
    syncContentModelControls();
    contentModelStatus.textContent = originalContentModelKey === 'follow'
      ? '已保存：三处都跟随 Hana 当前模型。'
      : `已保存：推荐、Ask 判断和速览都用 ${originalContentModelKey}。`;
  } catch (error) {
    contentModelStatus.textContent = error?.message || '保存模型失败。';
    contentModelSaveButton.textContent = '重试保存';
    contentModelSaveButton.classList.remove('is-saved');
    syncContentModelControls();
  } finally {
    contentModelTrigger.disabled = false;
  }
});
loadContentModel();

// ── 备用模型 ──
// 主模型连着撞三次都不成时才上，尝试次数和预算由 lib/recommendation.js 控制。
// 这里只管选哪条、存下来；它自己拉一份模型列表，不指望内容模型那边加载成功。
const fallbackTrigger = document.querySelector('#fallback-model-trigger');
const fallbackOptionsHost = document.querySelector('#fallback-model-options');
const fallbackSaveButton = document.querySelector('#fallback-model-save');
const fallbackStatus = document.querySelector('#fallback-model-status');
let fallbackModels = [];
let originalFallbackKey = 'none';
let pendingFallbackKey = 'none';

function fallbackKeyOf(ref) {
  return ref?.provider && ref?.model ? `${ref.provider}/${ref.model}` : 'none';
}

function fallbackLabel(key) {
  if (key === 'none') return '不设备用（撞不动就报错）';
  const found = fallbackModels.find((item) => item.key === key);
  return found ? `${found.name}${found.isCurrent ? '（当前）' : ''}` : `${key}（已不在列表，需重新选）`;
}

function closeFallbackOptions() {
  fallbackOptionsHost?.setAttribute('hidden', '');
  fallbackTrigger?.setAttribute('aria-expanded', 'false');
}

function syncFallbackControls() {
  if (!fallbackSaveButton) return;
  const unchanged = pendingFallbackKey === originalFallbackKey;
  const valid = pendingFallbackKey === 'none' || fallbackModels.some((item) => item.key === pendingFallbackKey);
  fallbackSaveButton.disabled = unchanged || !valid;
  fallbackSaveButton.classList.toggle('is-saved', unchanged);
  fallbackSaveButton.textContent = unchanged ? '已保存 ✓' : '保存选择';
}

function renderFallbackOptions() {
  if (!fallbackOptionsHost || !fallbackTrigger) return;
  fallbackOptionsHost.replaceChildren();
  const choices = [{ key: 'none', label: fallbackLabel('none') }, ...fallbackModels.map((item) => ({
    key: item.key,
    label: fallbackLabel(item.key),
  }))];
  if (originalFallbackKey !== 'none' && !fallbackModels.some((item) => item.key === originalFallbackKey)) {
    choices.push({ key: originalFallbackKey, label: fallbackLabel(originalFallbackKey) });
  }
  for (const choice of choices) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'model-option';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(choice.key === pendingFallbackKey));
    const mark = document.createElement('span');
    mark.className = 'model-option-mark';
    mark.textContent = '✓';
    const label = document.createElement('span');
    label.className = 'model-option-label';
    label.textContent = choice.label;
    option.append(mark, label);
    option.addEventListener('click', () => {
      pendingFallbackKey = choice.key;
      closeFallbackOptions();
      renderFallbackOptions();
      syncFallbackControls();
    });
    fallbackOptionsHost.appendChild(option);
  }
  fallbackTrigger.textContent = fallbackLabel(pendingFallbackKey);
}

function selectedFallbackRef() {
  if (pendingFallbackKey === 'none') return null;
  const found = fallbackModels.find((item) => item.key === pendingFallbackKey);
  return found ? { provider: found.provider, model: found.model } : undefined;
}

async function loadFallbackModel() {
  if (!fallbackTrigger) return;
  try {
    const response = await hana.api.fetch('/fallback-model');
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '读取备用模型失败。');
    fallbackModels = Array.isArray(payload.models) ? payload.models : [];
    originalFallbackKey = fallbackKeyOf(payload.modelRef);
    pendingFallbackKey = originalFallbackKey;
    fallbackTrigger.disabled = false;
    renderFallbackOptions();
    syncFallbackControls();
    const stale = originalFallbackKey !== 'none' && !fallbackModels.some((item) => item.key === originalFallbackKey);
    fallbackStatus.textContent = stale
      ? '原先选的备用模型已不在列表；请改选一条，或者清掉。'
      : originalFallbackKey === 'none'
        ? '现在没设备用：主模型撞不动就直接报错，不会自动换。'
        : '主模型连撞三次不成功时，会自动换这条再试一次。';
  } catch (error) {
    fallbackTrigger.textContent = '模型列表不可用';
    fallbackTrigger.disabled = true;
    if (fallbackSaveButton) fallbackSaveButton.disabled = true;
    fallbackStatus.textContent = error?.message || '读取备用模型失败；请确认知意已获模型使用权限。';
  }
}

fallbackTrigger?.addEventListener('click', () => {
  if (fallbackTrigger.disabled) return;
  const open = fallbackOptionsHost.hasAttribute('hidden');
  if (open) {
    fallbackOptionsHost.removeAttribute('hidden');
    fallbackTrigger.setAttribute('aria-expanded', 'true');
  } else closeFallbackOptions();
});

document.addEventListener('click', (event) => {
  if (!fallbackOptionsHost?.parentElement?.contains(event.target)) closeFallbackOptions();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeFallbackOptions();
});

fallbackSaveButton?.addEventListener('click', async () => {
  const modelRef = selectedFallbackRef();
  if (modelRef === undefined) return;
  fallbackSaveButton.disabled = true;
  fallbackTrigger.disabled = true;
  fallbackSaveButton.classList.remove('is-saved');
  fallbackSaveButton.textContent = '正在保存…';
  fallbackStatus.textContent = '正在保存…';
  try {
    const response = await hana.api.fetch('/fallback-model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelRef }),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '保存备用模型失败。');
    originalFallbackKey = fallbackKeyOf(payload.modelRef);
    pendingFallbackKey = originalFallbackKey;
    renderFallbackOptions();
    syncFallbackControls();
    fallbackStatus.textContent = originalFallbackKey === 'none'
      ? '已清空：不再自动换模型。'
      : `已保存：主模型不成就换 ${originalFallbackKey}。`;
  } catch (error) {
    fallbackStatus.textContent = error?.message || '保存失败，再试一次。';
    fallbackSaveButton.textContent = '重试保存';
    fallbackSaveButton.classList.remove('is-saved');
    syncFallbackControls();
  } finally {
    fallbackTrigger.disabled = false;
  }
});

loadFallbackModel();

// ── 快速模型 ──
// 速览和会话标题这类「要快不要想」的小功能单独一条模型。服务端会先试关思考，
// 模型不吃就退档重发；这里只管选哪条、测一下、看保存结果。
const fastModel = (() => {
  const trigger = document.querySelector('#fast-model-trigger');
  const optionsHost = document.querySelector('#fast-model-options');
  const testButton = document.querySelector('#fast-model-test');
  const saveButton = document.querySelector('#fast-model-save');
  const status = document.querySelector('#fast-model-status');
  if (!trigger || !optionsHost || !status) return null;

  let models = [];
  let savedKey = 'follow';
  let pendingKey = 'follow';

  const keyOf = (ref) => (ref?.provider && ref?.model ? `${ref.provider}/${ref.model}` : 'follow');
  const labelOf = (key) => {
    if (key === 'follow') return '跟随内容模型（推荐、Ask 判断用的那条）';
    const found = models.find((item) => item.key === key);
    return found ? `${found.name}${found.isCurrent ? '（当前）' : ''}` : `${key}（已不在列表，需重新选）`;
  };
  const refOf = (key) => {
    if (key === 'follow') return null;
    const found = models.find((item) => item.key === key);
    return found ? { provider: found.provider, model: found.model } : undefined;
  };
  const closeOptions = () => {
    optionsHost.setAttribute('hidden', '');
    trigger.setAttribute('aria-expanded', 'false');
  };
  const sync = () => {
    const unchanged = pendingKey === savedKey;
    const valid = !pendingKey || models.some((item) => item.key === pendingKey);
    if (saveButton) {
      saveButton.disabled = unchanged || !valid;
      saveButton.classList.toggle('is-saved', unchanged);
      saveButton.textContent = unchanged ? '已保存 ✓' : '保存选择';
    }
    if (testButton) testButton.disabled = !valid;
  };
  const render = () => {
    optionsHost.replaceChildren();
    const choices = [{ key: 'follow', label: labelOf('follow') },
      ...models.map((item) => ({ key: item.key, label: labelOf(item.key) }))];
    if (savedKey !== 'follow' && !models.some((item) => item.key === savedKey)) {
      choices.push({ key: savedKey, label: labelOf(savedKey) });
    }
    for (const choice of choices) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'model-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(choice.key === pendingKey));
      const mark = document.createElement('span');
      mark.className = 'model-option-mark';
      mark.textContent = '✓';
      const label = document.createElement('span');
      label.className = 'model-option-label';
      label.textContent = choice.label;
      option.append(mark, label);
      option.addEventListener('click', () => {
        pendingKey = choice.key;
        closeOptions();
        render();
        sync();
      });
      optionsHost.appendChild(option);
    }
    trigger.textContent = labelOf(pendingKey);
  };
  const request = async (method, body, path) => {
    const response = await hana.api.fetch(path, {
      method,
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    let payload;
    try { payload = await response.json(); } catch { throw new Error('快速档设置读取失败。'); }
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '快速档设置读取失败。');
    return payload;
  };

  trigger.addEventListener('click', () => {
    if (trigger.disabled) return;
    const open = optionsHost.hasAttribute('hidden');
    if (open) { optionsHost.removeAttribute('hidden'); trigger.setAttribute('aria-expanded', 'true'); }
    else closeOptions();
  });
  document.addEventListener('click', (event) => {
    if (!optionsHost.parentElement?.contains(event.target)) closeOptions();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeOptions(); });

  testButton?.addEventListener('click', async () => {
    const modelRef = refOf(pendingKey);
    if (modelRef === undefined) return;
    testButton.disabled = true;
    trigger.disabled = true;
    if (saveButton) saveButton.disabled = true;
    testButton.textContent = '正在测试…';
    status.textContent = '正在做一段真实的短压缩测试，不会保存选择…';
    try {
      const payload = await request('POST', { modelRef }, '/fast-model/test');
      const effort = ({ off: '已请求关闭思考', minimal: '最低思考档', low: '低思考档' })[payload.effort] || '使用模型默认档';
      // 部分接口将未报告的思考用量补成 0，不能据此宣称没有思考。
      const thinking = Number.isFinite(payload.reasoningTokens) && payload.reasoningTokens > 0 ? `思考用了 ${payload.reasoningTokens} token。` : '';
      const duration = Number.isFinite(payload.elapsedMs) ? `${(payload.elapsedMs / 1000).toFixed(1)} 秒` : '耗时未报告';
      status.textContent = `测试通过 · ${duration} · ${effort}。${thinking}模型：${payload.modelName}。样例：${payload.sample}`;
      testButton.textContent = '重新测试';
    } catch (error) {
      status.textContent = error?.message || '快速档测试失败，请检查模型配置和应用权限。';
      testButton.textContent = '重试测试';
    } finally {
      trigger.disabled = false;
      sync();
    }
  });

  saveButton?.addEventListener('click', async () => {
    const modelRef = refOf(pendingKey);
    if (modelRef === undefined) return;
    saveButton.disabled = true;
    trigger.disabled = true;
    if (testButton) testButton.disabled = true;
    saveButton.classList.remove('is-saved');
    saveButton.textContent = '正在保存…';
    status.textContent = '正在保存…';
    try {
      const payload = await request('PUT', { modelRef }, '/fast-model');
      savedKey = keyOf(payload.modelRef);
      pendingKey = savedKey;
      render();
      sync();
      status.textContent = savedKey === 'follow'
        ? '已保存：速览和标题跟随内容模型。'
        : `已保存：速览和标题用 ${savedKey}。`;
    } catch (error) {
      status.textContent = error?.message || '保存快速档模型失败。';
      saveButton.textContent = '重试保存';
      saveButton.classList.remove('is-saved');
      sync();
    } finally {
      trigger.disabled = false;
    }
  });

  return {
    async load() {
      try {
        // 三个参数都要给：path 不填时 fetch 拿到 undefined，宿主会报 Invalid plugin API path。
        const payload = await request('GET', null, '/fast-model');
        models = (Array.isArray(payload.models) ? payload.models : []).map((item) => ({
          ...item,
          key: `${item.provider}/${item.model}`
        }));
        savedKey = keyOf(payload.modelRef);
        pendingKey = savedKey;
        trigger.disabled = false;
        render();
        sync();
        const stale = savedKey !== 'follow' && !models.some((item) => item.key === savedKey);
        status.textContent = stale
          ? '原先选的模型已不在列表；请改选一条，或切回跟随内容模型。'
          : savedKey === 'follow'
            ? '速览和标题现在跟随内容模型；想更快可以单独指定一条。'
            : `速览和标题都用你指定的这一条：${savedKey}。`;
      } catch (error) {
        trigger.textContent = '模型列表不可用';
        trigger.disabled = true;
        if (testButton) testButton.disabled = true;
        if (saveButton) saveButton.disabled = true;
        status.textContent = error?.message || '读取模型列表失败；请确认知意已获模型使用权限。';
      }
    }
  };
})();
fastModel?.load();

const recSection = document.querySelector('#recommendation-behavior');
const recStatus = document.querySelector('#rec-status');
const recDisplay = document.querySelector('#rec-display');
const recCount = document.querySelector('#rec-count');
const recInputButton = document.querySelector('#rec-input-button');
const recQuickTags = document.querySelector('#rec-quick-tags');
const recQuickInput = document.querySelector('#rec-quick-input');
const recQuickAdd = document.querySelector('#rec-quick-add');
const recStyles = document.querySelector('#rec-styles');
const recRefineButton = document.querySelector('#rec-refine');
const recRestoreButton = document.querySelector('#rec-restore');
const recRefineStatus = document.querySelector('#rec-refine-status');
let recommendationBehavior = { display: 'ball', count: 3, inputButton: true, quickReplies: [], styles: [], selectedByCount: {} };
let recSaveTimer = null;

function setSegmentValue(group, value) {
  if (!group) return;
  for (const button of group.querySelectorAll('button[data-value]')) {
    button.setAttribute('aria-pressed', String(button.dataset.value === String(value)));
  }
}

function selectedStyleIndexes() {
  const key = String(recommendationBehavior.count);
  const list = recommendationBehavior.selectedByCount?.[key];
  return Array.isArray(list) ? list.map(Number) : [];
}

function renderStyleList() {
  if (!recStyles) return;
  recStyles.replaceChildren();
  const selected = selectedStyleIndexes();
  for (const [index, style] of (recommendationBehavior.styles || []).entries()) {
    const row = document.createElement('div');
    row.className = 'style-item';
    const label = document.createElement('label');
    label.className = 'switch';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = selected.includes(index);
    input.addEventListener('change', () => {
      const current = new Set(selectedStyleIndexes());
      if (input.checked) current.add(index); else current.delete(index);
      const next = [...current].sort((a, b) => a - b);
      recommendationBehavior.selectedByCount = {
        ...recommendationBehavior.selectedByCount,
        [String(recommendationBehavior.count)]: next,
      };
      scheduleRecommendationSave();
    });
    const text = document.createElement('span');
    text.textContent = style.name;
    label.append(input, text);
    row.append(label);

    // 方向名和意图都能自己写。名字给推荐看的是「方向」，意图那一句是给模型看的说明。
    const nameInput = document.createElement('input');
    nameInput.className = 'text-input style-name-input';
    nameInput.type = 'text';
    nameInput.maxLength = 20;
    nameInput.value = style.name || '';
    nameInput.placeholder = '方向名，如：追问/延伸';
    nameInput.setAttribute('aria-label', `第 ${index + 1} 条方向的名字`);
    nameInput.addEventListener('change', () => {
      const value = nameInput.value.trim();
      if (!value) { nameInput.value = recommendationBehavior.styles[index]?.name || ''; return; }
      recommendationBehavior.styles[index] = { ...recommendationBehavior.styles[index], name: value };
      text.textContent = value;
      scheduleRecommendationSave();
    });

    const intentInput = document.createElement('input');
    intentInput.className = 'text-input style-intent-input';
    intentInput.type = 'text';
    intentInput.maxLength = 60;
    intentInput.value = style.intent || '';
    intentInput.placeholder = '怎么说话、往哪儿使劲（模型看这句）';
    intentInput.setAttribute('aria-label', `第 ${index + 1} 条方向的意图说明`);
    intentInput.addEventListener('change', () => {
      recommendationBehavior.styles[index] = {
        ...recommendationBehavior.styles[index],
        intent: intentInput.value.trim(),
      };
      scheduleRecommendationSave();
    });

    row.append(nameInput, intentInput);
    recStyles.append(row);
  }
}

function renderQuickTags() {
  if (!recQuickTags) return;
  recQuickTags.replaceChildren();
  for (const [index, text] of (recommendationBehavior.quickReplies || []).entries()) {
    const tag = document.createElement('span');
    tag.className = 'quick-tag';
    const label = document.createElement('span');
    label.className = 'quick-tag-text';
    label.textContent = text;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'quick-tag-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `删除「${text}」`);
    remove.addEventListener('click', () => {
      const next = [...(recommendationBehavior.quickReplies || [])];
      next.splice(index, 1);
      recommendationBehavior = { ...recommendationBehavior, quickReplies: next };
      renderQuickTags();
      scheduleRecommendationSave();
    });
    tag.append(label, remove);
    recQuickTags.append(tag);
  }
}

function addQuickReply() {
  const text = String(recQuickInput?.value || '').trim();
  if (!text) return;
  const list = [...(recommendationBehavior.quickReplies || [])];
  if (list.includes(text)) {
    if (recQuickInput) recQuickInput.value = '';
    return;
  }
  list.push(text);
  recommendationBehavior = { ...recommendationBehavior, quickReplies: list };
  if (recQuickInput) recQuickInput.value = '';
  renderQuickTags();
  scheduleRecommendationSave();
}

recQuickAdd?.addEventListener('click', addQuickReply);
recQuickInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addQuickReply();
  }
});

function renderRecommendationBehavior() {
  const config = recommendationBehavior;
  const on = config.display === 'ball';
  recSection?.classList.toggle('is-off', !on);
  setSegmentValue(recDisplay, config.display);
  setSegmentValue(recCount, config.count);
  setSegmentValue(recInputButton, config.inputButton === false ? 'off' : 'on');
  renderQuickTags();
  renderStyleList();
  if (!recStatus) return;
  const buttonState = config.inputButton === false ? '输入栏那个按钮已隐藏' : '输入框中间也有一个知意按钮';
  recStatus.textContent = on
    ? `已开启：传音樱里每次 ${config.count} 条，${buttonState}。`
    : '已关闭：传音樱面板上那一块会整块收起来。';
}

function scheduleRecommendationSave() {
  if (recSaveTimer) clearTimeout(recSaveTimer);
  recSaveTimer = setTimeout(() => { void saveRecommendationBehavior(); }, 350);
}

async function saveRecommendationBehavior() {
  if (recStatus) recStatus.textContent = '正在保存…';
  try {
    const response = await hana.api.fetch('/recommendation-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(recommendationBehavior),
    });
    let payload;
    try { payload = await response.json(); } catch { throw new Error('保存失败。'); }
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '保存失败。');
    recommendationBehavior = { ...recommendationBehavior, ...payload };
    renderRecommendationBehavior();
  } catch (error) {
    if (recStatus) recStatus.textContent = error?.message || '推荐设置保存失败，请重试。';
  }
}

function bindSegment(group, key, cast) {
  group?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    recommendationBehavior = { ...recommendationBehavior, [key]: cast(button.dataset.value) };
    renderRecommendationBehavior();
    scheduleRecommendationSave();
  });
}

bindSegment(recDisplay, 'display', (value) => value);
bindSegment(recCount, 'count', (value) => Number(value));
bindSegment(recInputButton, 'inputButton', (value) => value === 'on');

async function loadRecommendationBehavior() {
  if (!recSection) return;
  try {
    const response = await hana.api.fetch('/recommendation-config');
    if (!response.ok) throw new Error('读取失败');
    const payload = await response.json();
    recommendationBehavior = {
      display: payload.display,
      count: payload.count,
      inputButton: payload.inputButton !== false,
      quickReplies: Array.isArray(payload.quickReplies) ? payload.quickReplies : [],
      styles: Array.isArray(payload.styles) ? payload.styles : [],
      selectedByCount: payload.selectedByCount || {},
    };
    renderRecommendationBehavior();
  } catch {
    renderRecommendationBehavior();
    if (recStatus) recStatus.textContent = '读取推荐设置失败，下方显示的是默认值。';
  }
}

const askDisplay = document.querySelector('#ask-display');
const askStatus = document.querySelector('#ask-status');
let askCardEnabled = true;
let askSaveTimer = null;

function renderAskCardSwitch() {
  askDisplay?.querySelectorAll('button[data-value]').forEach((button) => {
    button.setAttribute('aria-pressed', String((button.dataset.value === 'off') !== askCardEnabled));
  });
  if (askStatus) {
    askStatus.textContent = askCardEnabled
      ? '已开启：遇到该你拍板的分岔时弹卡询问。'
      : '已关闭：不再弹这张卡，伙伴也收不到关于它的提示。需要它彻底从工具列表消失时，重新加载一次知意。';
  }
}

function scheduleAskSave() {
  if (askSaveTimer) clearTimeout(askSaveTimer);
  askSaveTimer = setTimeout(() => { void saveAskCardSwitch(); }, 350);
}

async function saveAskCardSwitch() {
  if (askStatus) askStatus.textContent = '正在保存…';
  try {
    const response = await hana.api.fetch('/ask-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: askCardEnabled }),
    });
    let payload;
    try { payload = await response.json(); } catch { throw new Error('保存失败。'); }
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '保存失败。');
    askCardEnabled = payload.enabled !== false;
    renderAskCardSwitch();
    if (!askCardEnabled && payload.registeredAtLoad) {
      if (askStatus) askStatus.textContent += ' 当前进程里工具还挂着，重新加载一次后就不会再出现在伙伴的工具列表里。';
    }
  } catch (error) {
    if (askStatus) askStatus.textContent = error?.message || 'Ask 开关保存失败，请重试。';
  }
}

askDisplay?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-value]');
  if (!button) return;
  askCardEnabled = button.dataset.value === 'on';
  renderAskCardSwitch();
  scheduleAskSave();
});

async function loadAskCardSwitch() {
  if (!askDisplay) return;
  try {
    const response = await hana.api.fetch('/ask-config');
    if (!response.ok) throw new Error('读取失败');
    const payload = await response.json();
    askCardEnabled = payload.enabled !== false;
    renderAskCardSwitch();
    if (!askCardEnabled && payload.registeredAtLoad) {
      if (askStatus) askStatus.textContent = '已关闭：当前进程里工具还挂着，重新加载一次知意就会从工具列表里消失。';
    }
  } catch {
    renderAskCardSwitch();
    if (askStatus) askStatus.textContent = '读取 Ask 开关失败，先按开启显示；保存后会以保存结果为准。';
  }
}

// ── 自定义模型 ──
const customEnabledGroup = document.querySelector('#custom-enabled');
const customBaseUrlInput = document.querySelector('#custom-baseurl');
const customModelInput = document.querySelector('#custom-model-name');
const customApiKeyInput = document.querySelector('#custom-apikey');
const customKeyNote = document.querySelector('#custom-key-note');
const customTestButton = document.querySelector('#custom-test');
const customSaveButton = document.querySelector('#custom-save');
const customClearKeyButton = document.querySelector('#custom-clear-key');
const customStatus = document.querySelector('#custom-status');
let customConfig = { enabled: false, baseUrl: '', model: '', apiKey: '' };
let customClearKey = false;

function setCustomStatus(text) { if (customStatus) customStatus.textContent = text; }

function customPayload() {
  return {
    enabled: customEnabledGroup?.querySelector('button[aria-pressed="true"]')?.dataset.value === 'on',
    baseUrl: customBaseUrlInput?.value.trim() || '',
    model: customModelInput?.value.trim() || '',
    apiKey: customApiKeyInput?.value === '********' ? '********' : (customApiKeyInput?.value.trim() || ''),
    clearApiKey: customClearKey,
  };
}

function applyCustomPayload(payload) {
  customConfig = payload.config || { enabled: false, baseUrl: '', model: '', apiKey: '' };
  customClearKey = false;
  setSegmentValue(customEnabledGroup, customConfig.enabled ? 'on' : 'off');
  if (customBaseUrlInput) customBaseUrlInput.value = customConfig.baseUrl || '';
  if (customModelInput) customModelInput.value = customConfig.model || '';
  if (customApiKeyInput) customApiKeyInput.value = customConfig.apiKey || '';
  if (customKeyNote) {
    customKeyNote.textContent = payload.encrypted === false
      ? '系统加密没能用上，这次会以原样保存'
      : (customConfig.apiKey ? '已用 Windows 系统加密保存' : '用 Windows 系统加密保存');
  }
}

async function customRequest(path, options = {}) {
  const response = await hana.api.fetch(path, options);
  let payload;
  try { payload = await response.json(); } catch { throw new Error('自定义模型设置读不出来。'); }
  if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '操作失败。');
  return payload;
}

async function loadCustomModel() {
  if (!document.querySelector('#custom-baseurl')) return;
  try {
    applyCustomPayload(await customRequest('/custom-model'));
    setCustomStatus(customConfig.enabled ? '已开启：没单独选模型的那些活会走这一条。' : '当前关闭，知意只用你在上面选过的模型。');
  } catch (error) {
    setCustomStatus(error?.message || '读取失败。');
  }
}

async function saveCustomModel() {
  try {
    const payload = await customRequest('/custom-model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: customPayload() }),
    });
    applyCustomPayload(payload);
    setCustomStatus('已保存。');
  } catch (error) {
    setCustomStatus(error?.message || '保存失败。');
  }
}

customEnabledGroup?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-value]');
  if (!button) return;
  setSegmentValue(customEnabledGroup, button.dataset.value);
  void saveCustomModel();
});

customSaveButton?.addEventListener('click', () => { void saveCustomModel(); });

customClearKeyButton?.addEventListener('click', async () => {
  customClearKey = true;
  if (customApiKeyInput) customApiKeyInput.value = '';
  await saveCustomModel();
  setCustomStatus('Key 已经删掉了，下次调用会因为没 Key 报错。');
});

customTestButton?.addEventListener('click', async () => {
  customTestButton.disabled = true;
  customTestButton.textContent = '正在试…';
  setCustomStatus('正在用这份配置试一句短话；测试不会保存。');
  try {
    const payload = await customRequest('/custom-model/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: customPayload() }),
    });
    setCustomStatus(`连上了：${payload.model}，回的是「${payload.sample}」。`);
  } catch (error) {
    setCustomStatus(error?.message || '没连上。');
  } finally {
    customTestButton.disabled = false;
    customTestButton.textContent = '测试一下';
  }
});

// ── 语音朗读 ──
// 设置分两层：模型层（地址/模型名/Key，要按「保存」）与偏好层（开关/范围/语速/音色，改完即存）。
// 两层分开是为了避免打到一半的 Key 被偏好自动保存顺手写进去。
const voiceEnabledGroup = document.querySelector('#voice-enabled');
const voicePresetGroup = document.querySelector('#voice-presets');
const voiceProtocolGroup = document.querySelector('#voice-protocol');
const voiceBaseUrlInput = document.querySelector('#voice-baseurl');
const voiceModelInput = document.querySelector('#voice-model');
const voiceGroupIdInput = document.querySelector('#voice-groupid');
const voiceGroupIdField = document.querySelector('#voice-groupid-field');
const voiceApiKeyInput = document.querySelector('#voice-apikey');
const voiceAuthStyleGroup = document.querySelector('#voice-authstyle');
const voiceHanaKeyGroup = document.querySelector('#voice-hana-key');
const voiceKeyNote = document.querySelector('#voice-key-note');
const voiceTestButton = document.querySelector('#voice-test');
const voiceSaveButton = document.querySelector('#voice-save');
const voiceModelStatus = document.querySelector('#voice-model-status');
const voiceScopeGroup = document.querySelector('#voice-scope');
const voiceSpeedGroup = document.querySelector('#voice-speed');
const voiceToneTrigger = document.querySelector('#voice-tone-trigger');
const voiceToneOptionsHost = document.querySelector('#voice-tone-options');
const voiceToneInput = document.querySelector('#voice-tone-input');
const voicePartnersHost = document.querySelector('#voice-partners');
const voicePartnerRefresh = document.querySelector('#voice-partner-refresh');
const voiceTonePreview = document.querySelector('#voice-tone-preview');
const voiceStatus = document.querySelector('#voice-status');
const voicePlayer = document.querySelector('#voice-player');
const voiceAudio = document.querySelector('#voice-audio');
const voiceCaption = document.querySelector('#voice-caption');

const VOICE_MODEL_KEYS = ['protocol', 'providerId', 'authStyle', 'baseUrl', 'model', 'groupId', 'apiKey'];
const VOICE_PROTOCOL_LABELS = { t2a: 'MiniMax', chat: 'OpenAI 兼容', speech: '自建 TTS' };
const MASKED_KEY = '********';
let voiceSaved = null;
let voiceDraft = null;
let voiceVoices = [];
let voiceLibrary = { t2a: [], chat: [], speech: [] };
let voicePresets = [];
let voicePartners = [];
let voiceAudioUrl = '';
let voiceCaptionSpans = [];
let voicePrefTimer = null;
// 当前正在播的试听按钮：同一时刻只会有一个。
let voicePreviewButton = null;

function setVoicePreviewState(button, playing) {
  if (!button) return;
  button.textContent = playing ? '■ 停止' : '▶ 试听';
  button.classList.toggle('is-playing', playing);
  button.setAttribute('aria-pressed', String(playing));
}

/**
 * 试听一个音色：用当前草稿配置合成一句固定的话。
 * 同一音色后端有缓存，再点不会重复合成、不会重复花钱。
 */
async function previewVoiceTone(voiceId, button) {
  if (!button) return;
  if (voicePreviewButton === button && voiceAudio && !voiceAudio.paused) {
    voiceAudio.pause();
    setVoicePreviewState(button, false);
    voicePreviewButton = null;
    return;
  }
  const previous = voicePreviewButton;
  setVoicePreviewState(previous, false);
  voicePreviewButton = button;
  button.disabled = true;
  setVoiceModelStatus('正在合成这句试听…');
  try {
    const payload = await voiceRequest('/voice/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: voicePayload({ model: true }), voiceId: String(voiceId || '') }),
    });
    await playVoiceClip(payload.clipId, payload.format, payload);
    setVoicePreviewState(button, true);
    setVoiceModelStatus(payload.cached ? '这段试听以前合成了，直接放给你听。' : '正在放这句试听。');
  } catch (error) {
    setVoicePreviewState(button, false);
    voicePreviewButton = null;
    setVoiceModelStatus(error?.message || '这段试听没合成出来。');
  } finally {
    button.disabled = false;
  }
}

voiceTonePreview?.addEventListener('click', () => {
  void previewVoiceTone(String(voiceDraft?.defaultVoiceId || ''), voiceTonePreview);
});

// ─── 语音收藏：只存引用，试听直接读当时的 clip ───
const voiceFavList = document.querySelector('#voice-fav-list');
const voiceFavStatus = document.querySelector('#voice-fav-status');
const voiceFavRefresh = document.querySelector('#voice-fav-refresh');
const voiceFavPlayer = document.querySelector('#voice-fav-player');
const voiceFavAudio = document.querySelector('#voice-fav-audio');
let voiceFavAudioUrl = '';

function setVoiceFavStatus(text) { if (voiceFavStatus) voiceFavStatus.textContent = text || ''; }

function releaseVoiceFavAudio() {
  if (voiceFavAudioUrl) { URL.revokeObjectURL(voiceFavAudioUrl); voiceFavAudioUrl = ''; }
  if (voiceFavPlayer) voiceFavPlayer.hidden = true;
  if (voiceFavAudio) { voiceFavAudio.pause?.(); voiceFavAudio.removeAttribute('src'); }
}

function formatFavTime(ms) {
  const value = Number(ms);
  if (!value) return '';
  try {
    return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function renderVoiceFavorites(items) {
  if (!voiceFavList) return;
  voiceFavList.textContent = '';
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'ball-status';
    empty.textContent = '还没有收藏。在传音樱里「念给我听」，念完点「♡ 收藏」，就会出现在这里。';
    voiceFavList.appendChild(empty);
    return;
  }
  for (const item of list) {
    const row = document.createElement('div');
    row.className = 'setting-row';
    const copy = document.createElement('div');
    copy.className = 'setting-copy';
    const title = document.createElement('h3');
    const text = String(item.text || '').replace(/\s+/g, ' ').trim();
    title.textContent = text.length > 60 ? `${text.slice(0, 60)}…` : (text || '（没有文本）');
    const meta = document.createElement('p');
    const bits = [item.agentName || '', item.voiceId || '', formatFavTime(item.createdAt)].filter(Boolean);
    meta.textContent = bits.join(' · ');
    copy.append(title, meta);

    const controls = document.createElement('div');
    controls.className = 'model-controls';
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'model-test';
    play.textContent = '试听';
    play.addEventListener('click', async () => {
      play.disabled = true;
      try {
        releaseVoiceFavAudio();
        // 跟旁边的试听一样的做法：取回字节再转成 Blob URL，
        // 不直接拿路由地址塞给 <audio>（那边是带鉴权的受管路由）。
        const res = await hana.api.fetch(`/voice/clip/${encodeURIComponent(item.clipId)}?format=${encodeURIComponent(item.format || 'mp3')}`);
        if (!res.ok) throw new Error('这段音频已经不在了');
        const bytes = new Uint8Array(await res.arrayBuffer());
        voiceFavAudioUrl = URL.createObjectURL(new Blob([bytes], { type: item.format === 'wav' ? 'audio/wav' : 'audio/mpeg' }));
        if (voiceFavAudio) voiceFavAudio.src = voiceFavAudioUrl;
        if (voiceFavPlayer) voiceFavPlayer.hidden = false;
        await voiceFavAudio?.play().catch(() => {});
      } catch (error) {
        setVoiceFavStatus(`试听失败：${error?.message || '再试一次'}`);
      } finally {
        play.disabled = false;
      }
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'model-save';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      if (del.dataset.confirm !== '1') {
        del.dataset.confirm = '1';
        del.textContent = '再点确认';
        setTimeout(() => { if (del.dataset.confirm === '1') { del.dataset.confirm = '0'; del.textContent = '删除'; } }, 3000);
        return;
      }
      del.disabled = true;
      try {
        const res = await hana.api.fetch('/voice/favorites/delete', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: item.id }),
        });
        const data = await res.json();
        setVoiceFavStatus(data?.message || '已删除');
        await loadVoiceFavorites();
      } catch (error) {
        setVoiceFavStatus(`删除失败：${error?.message || '再试一次'}`);
        del.disabled = false;
        del.dataset.confirm = '0';
        del.textContent = '删除';
      }
    });
    controls.append(play, del);
    row.append(copy, controls);
    voiceFavList.appendChild(row);
  }
}

async function loadVoiceFavorites() {
  if (!voiceFavList) return;
  try {
    const res = await hana.api.fetch('/voice/favorites');
    const data = await res.json();
    renderVoiceFavorites(data?.items || []);
  } catch (error) {
    voiceFavList.textContent = '';
    const p = document.createElement('p');
    p.className = 'ball-status';
    p.textContent = `语音收藏读取失败：${error?.message || '稍后再试'}`;
    voiceFavList.appendChild(p);
  }
}

function setVoiceModelStatus(text) { if (voiceModelStatus) voiceModelStatus.textContent = text; }
function setVoiceStatus(text) { if (voiceStatus) voiceStatus.textContent = text; }

function voiceModelPart(config) {
  const part = {};
  for (const key of VOICE_MODEL_KEYS) part[key] = config?.[key] ?? '';
  part.useHanaCredential = config?.useHanaCredential === true;
  return part;
}

function voicePrefPart(config) {
  return {
    enabled: config?.enabled !== false,
    scope: config?.scope === 'quoted' ? 'quoted' : 'all',
    speed: Number(config?.speed) || 1,
    defaultVoiceId: String(config?.defaultVoiceId || ''),
    voiceByAgent: { ...(config?.voiceByAgent || {}) },
  };
}

function voiceModelDraft() {
  return {
    protocol: voiceProtocolGroup?.querySelector('button[aria-pressed="true"]')?.dataset.value || 't2a',
    providerId: voiceDraft?.providerId || '',
    authStyle: voiceAuthStyleGroup?.querySelector('button[aria-pressed="true"]')?.dataset.value || '',
    useHanaCredential: voiceHanaKeyGroup?.querySelector('button[aria-pressed="true"]')?.dataset.value === 'on',
    baseUrl: voiceBaseUrlInput?.value.trim() || '',
    model: voiceModelInput?.value.trim() || '',
    groupId: voiceGroupIdInput?.value.trim() || '',
    apiKey: voiceApiKeyInput?.value === MASKED_KEY ? (voiceSaved?.apiKey || '') : (voiceApiKeyInput?.value.trim() || ''),
  };
}

function voicePayload({ model = false } = {}) {
  const prefs = voicePrefPart(voiceDraft || {});
  return model
    ? { ...prefs, ...voiceModelDraft() }
    : { ...voiceModelPart(voiceSaved || {}), ...prefs };
}

function voiceModelDirty() {
  if (!voiceSaved) return false;
  const draft = voiceModelDraft();
  return VOICE_MODEL_KEYS.some((key) => String(draft[key] ?? '') !== String(voiceSaved[key] ?? ''))
    || Boolean(draft.useHanaCredential) !== Boolean(voiceSaved.useHanaCredential);
}

function voiceConfigured() {
  const protocol = voiceDraft?.protocol || 't2a';
  // 自建 TTS 一般不要 Key，别拿一个不存在的必填项卡住用户。
  if (protocol === 'speech') return Boolean(voiceSaved?.baseUrl && voiceSaved?.model);
  const useHana = voiceHanaKeyGroup?.querySelector('button[aria-pressed="true"]')?.dataset.value === 'on';
  if (useHana) return Boolean(voiceSaved?.baseUrl && voiceSaved?.model);
  return Boolean(voiceSaved?.baseUrl && voiceSaved?.model && voiceSaved?.apiKey);
}

async function voiceRequest(path, options = {}) {
  const response = await hana.api.fetch(path, options);
  let payload;
  try { payload = await response.json(); } catch { throw new Error('朗读设置读不出来。'); }
  if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '朗读操作失败。');
  return payload;
}

function renderVoicePresets() {
  if (!voicePresetGroup) return;
  voicePresetGroup.replaceChildren();
  for (const preset of voicePresets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.value = preset.id;
    button.textContent = preset.label;
    const active = voiceDraft && voiceDraft.baseUrl === preset.baseUrl && voiceDraft.model === preset.model;
    button.setAttribute('aria-pressed', String(Boolean(active)));
    button.addEventListener('click', () => {
      if (voiceBaseUrlInput) voiceBaseUrlInput.value = preset.baseUrl || '';
      if (voiceModelInput) voiceModelInput.value = preset.model || '';
      setSegmentValue(voiceProtocolGroup, preset.protocol);
      // 以前这里只改了输入框和 providerId，没改 draft 里的 baseUrl / model / protocol，
      // 紧接着 renderVoicePresets() 又拿旧值判高亮——点了 MiniMax，视觉上还是停在上一个档。
      // 协议同理：setSegmentValue 只改高亮、不派发 click，所以音色列表跟着停在旧协议那一套
      // （MiMo 只有 5 条，MiniMax 有 22 条）。
      voiceDraft = {
        ...voiceDraft,
        providerId: preset.providerId || '',
        baseUrl: preset.baseUrl || '',
        model: preset.model || '',
        protocol: preset.protocol,
      };
      const nextVoices = voiceLibrary[preset.protocol];
      if (Array.isArray(nextVoices) && nextVoices.length) voiceVoices = nextVoices;
      renderVoicePresets();
      renderVoiceTones();
      renderVoicePartners();
      syncVoiceControls();
    });
    voicePresetGroup.appendChild(button);
  }
}

/** 当前该显示的音色：按 draft 的协议现算，不再依赖那个容易过期的 voiceVoices。 */
function currentVoiceChoices() {
  const protocol = String(voiceDraft?.protocol || 't2a');
  const fromLibrary = Array.isArray(voiceLibrary[protocol]) ? voiceLibrary[protocol] : [];
  if (fromLibrary.length) return fromLibrary;
  return Array.isArray(voiceVoices) ? voiceVoices : [];
}

function renderVoiceTones() {
  if (!voiceToneTrigger || !voiceToneOptionsHost) return;
  const manual = String(voiceDraft?.protocol || 't2a') === 'speech';
  const current = String(voiceDraft?.defaultVoiceId || '');
  // 自建 TTS 没有内置音色表，但那个下拉不能凭空消失：
  // 以前直接把它藏起来，用户只会以为“音色没了”。现在下拉一直在，只是内容换成当前值和一句说明。
  if (voiceToneInput) {
    voiceToneInput.hidden = !manual;
    if (manual && document.activeElement !== voiceToneInput) voiceToneInput.value = current;
  }
  voiceToneOptionsHost.replaceChildren();
  if (manual) {
    closeVoiceToneOptions();
    voiceToneTrigger.textContent = current ? `${current}（手填）` : '在下面填音色';
    return;
  }
  const available = currentVoiceChoices();
  const known = available.some((item) => item.id === current);
  const choices = known ? available : [...available, { id: current, name: `${current}（不在当前音色列表里）` }];
  for (const voice of choices) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'model-option';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(voice.id === current));
    const mark = document.createElement('span');
    mark.className = 'model-option-mark';
    mark.textContent = '✓';
    const label = document.createElement('span');
    label.className = 'model-option-label';
    label.textContent = voice.name;
    option.append(mark, label);
    option.addEventListener('click', () => {
      voiceDraft = { ...voiceDraft, defaultVoiceId: voice.id };
      voiceToneTrigger.textContent = voice.name;
      renderVoiceTones();
      renderVoicePartners();
      scheduleVoicePrefSave();
    });
    voiceToneOptionsHost.appendChild(option);
  }
  const picked = choices.find((item) => item.id === current);
  voiceToneTrigger.textContent = picked ? picked.name : '选择一个音色';
}

function closeVoiceToneOptions() {
  voiceToneOptionsHost?.setAttribute('hidden', '');
  voiceToneTrigger?.setAttribute('aria-expanded', 'false');
}

function renderVoicePartners() {
  if (!voicePartnersHost) return;
  voicePartnersHost.replaceChildren();
  if (!voicePartners.length) {
    const empty = document.createElement('p');
    empty.className = 'setting-hint';
    empty.textContent = '还没有可以配的伙伴——这里只列出你最近聊过的那几个。';
    voicePartnersHost.appendChild(empty);
    return;
  }
  for (const partner of voicePartners) {
    const row = document.createElement('div');
    row.className = 'partner-voice-row';
    const name = document.createElement('span');
    name.className = 'partner-voice-name';
    name.textContent = partner.agentName || partner.agentId;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'model-trigger partner-voice-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    const options = document.createElement('div');
    options.className = 'model-options partner-voice-options';
    options.setAttribute('role', 'listbox');
    options.hidden = true;
    const current = String(voiceDraft?.voiceByAgent?.[partner.agentId] || '');
    const follow = { id: '', name: '跟随默认' };
    const choices = [follow, ...currentVoiceChoices()];
    for (const voice of choices) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'model-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(voice.id === current));
      const mark = document.createElement('span');
      mark.className = 'model-option-mark';
      mark.textContent = '✓';
      const label = document.createElement('span');
      label.className = 'model-option-label';
      label.textContent = voice.name;
      option.append(mark, label);
      option.addEventListener('click', () => {
        const next = { ...(voiceDraft?.voiceByAgent || {}) };
        if (voice.id) next[partner.agentId] = voice.id;
        else delete next[partner.agentId];
        voiceDraft = { ...voiceDraft, voiceByAgent: next };
        trigger.textContent = voice.name;
        options.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        row.classList.remove('is-open');
        renderVoicePartners();
        scheduleVoicePrefSave();
      });
      options.appendChild(option);
    }
    const picked = choices.find((item) => item.id === current) || follow;
    trigger.textContent = picked.name;
    trigger.addEventListener('click', () => {
      options.hidden = !options.hidden;
      trigger.setAttribute('aria-expanded', String(!options.hidden));
      // 展开时把这行抬到邻居上面，不然下一行的边框会压住下拉
      row.classList.toggle('is-open', !options.hidden);
    });
    // 试听：这一行现在选中的音色，没单独选就听默认音色。
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'model-test partner-voice-preview';
    preview.textContent = '▶ 试听';
    preview.title = `试听${partner.agentName || partner.agentId}的音色`;
    preview.addEventListener('click', () => {
      const voiceId = String(voiceDraft?.voiceByAgent?.[partner.agentId] || '') || String(voiceDraft?.defaultVoiceId || '');
      void previewVoiceTone(voiceId, preview);
    });
    row.append(name, trigger, options, preview);
    voicePartnersHost.appendChild(row);
  }
}

function syncVoiceControls() {
  const dirty = voiceModelDirty();
  const protocol = voiceProtocolGroup?.querySelector('button[aria-pressed="true"]')?.dataset.value || 't2a';
  if (voiceSaveButton) {
    voiceSaveButton.disabled = !voiceSaved || !dirty;
    voiceSaveButton.classList.toggle('is-saved', !dirty);
    voiceSaveButton.textContent = dirty ? '保存' : '已保存 ✓';
  }
  if (voiceTestButton) voiceTestButton.disabled = !voiceSaved;
  if (voiceGroupIdField) voiceGroupIdField.hidden = protocol !== 't2a';
  if (voiceApiKeyInput) {
    voiceApiKeyInput.placeholder = protocol === 'speech' ? '本地部署一般不用填' : '粘贴朗读模型的 API Key';
  }
}

function applyVoicePayload(payload) {
  voiceSaved = payload.config;
  voiceDraft = { ...payload.config };
  // 缺哪一项就留哪一项：省一份精简响应就把整份音色库和伙伴名单清空，
  // 页面会表现成「音色下拉里只剩跟随默认、伙伴名也空了」。
  if (Array.isArray(payload.voices)) voiceVoices = payload.voices;
  if (payload.voiceLibrary && typeof payload.voiceLibrary === 'object') {
    voiceLibrary = {
      t2a: Array.isArray(payload.voiceLibrary.t2a) ? payload.voiceLibrary.t2a : [],
      chat: Array.isArray(payload.voiceLibrary.chat) ? payload.voiceLibrary.chat : [],
      speech: Array.isArray(payload.voiceLibrary.speech) ? payload.voiceLibrary.speech : [],
    };
  }
  // 三份音色库都空就是真拿不到，如实说清楚；不能默默给一个空列表，
  // 页面会表现成「音色只有一个、而且标着不在列表里」。
  // speech 本来就没目录（音色由用户那个服务定），这时不该报错。
  if (!voiceLibrary.t2a.length && !voiceLibrary.chat.length && String(voiceSaved?.protocol || '') !== 'speech') {
    setVoiceModelStatus('音色目录读不到了，刷新一下设置页再看看。');
  }
  voicePresets = Array.isArray(payload.presets) ? payload.presets : voicePresets;
  if (Array.isArray(payload.partners)) { voicePartners = payload.partners; renderVoicePartners(); }
  if (payload.partnersNote) setVoiceModelStatus(payload.partnersNote);
  if (voiceBaseUrlInput) voiceBaseUrlInput.value = voiceSaved.baseUrl || '';
  if (voiceModelInput) voiceModelInput.value = voiceSaved.model || '';
  if (voiceGroupIdInput) voiceGroupIdInput.value = voiceSaved.groupId || '';
  if (voiceApiKeyInput) voiceApiKeyInput.value = voiceSaved.apiKey || '';
  setSegmentValue(voiceHanaKeyGroup, voiceSaved.useHanaCredential ? 'on' : 'off');
  setSegmentValue(voiceAuthStyleGroup, voiceSaved.authStyle || '');
  if (voiceKeyNote) {
    voiceKeyNote.textContent = payload.encrypted
      ? '已用 Windows 系统加密保存'
      : `系统加密没能用上（${payload.encryptionNote || '原因未知'}），这次会以原样保存`;
  }
  setSegmentValue(voiceEnabledGroup, voiceSaved.enabled === false ? 'off' : 'on');
  setSegmentValue(voiceProtocolGroup, voiceSaved.protocol || 't2a');
  setSegmentValue(voiceScopeGroup, voiceSaved.scope || 'all');
  setSegmentValue(voiceSpeedGroup, String(voiceSaved.speed || 1));
  renderVoicePresets();
  renderVoiceTones();
  syncVoiceControls();
  setVoiceModelStatus(voiceConfigured()
    ? `当前：${VOICE_PROTOCOL_LABELS[voiceSaved.protocol] || '协议未选'} · ${voiceSaved.model}`
    : (voiceSaved.protocol === 'speech'
      ? '还没配好：接口地址和模型名填上就行，Key 可以不填。'
      : '还没配好朗读模型：接口地址、模型名、API Key 三样缺一不可。'));
  setVoiceStatus(voiceSaved.enabled === false ? '朗读当前是关着的。' : '朗读已允许。');
}

async function loadVoiceConfig() {
  if (!document.querySelector('#voice-section')) return;
  try {
    applyVoicePayload(await voiceRequest('/voice-config'));
  } catch (error) {
    setVoiceModelStatus(error?.message || '读取朗读设置失败。');
    if (voiceSaveButton) voiceSaveButton.disabled = true;
    if (voiceTestButton) voiceTestButton.disabled = true;
    return;
  }
}

function scheduleVoicePrefSave() {
  syncVoiceControls();
  if (voicePrefTimer) clearTimeout(voicePrefTimer);
  voicePrefTimer = setTimeout(() => { void saveVoice({ model: false }); }, 400);
}

async function saveVoice({ model = false } = {}) {
  try {
    const payload = await voiceRequest('/voice-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: voicePayload({ model }) }),
    });
    applyVoicePayload(payload);
    if (model) setVoiceModelStatus('已保存。下次合成就用这一份配置。');
  } catch (error) {
    setVoiceModelStatus(error?.message || '保存失败。');
    if (model) await loadVoiceConfig();
  }
}

async function loadVoicePartners() {
  if (!voicePartnersHost) return;
  if (voicePartnerRefresh) { voicePartnerRefresh.disabled = true; voicePartnerRefresh.textContent = '正在读…'; }
  try {
    const payload = await voiceRequest('/voice-config');
    voicePartners = Array.isArray(payload.partners) ? payload.partners : [];
    renderVoicePartners();
    if (payload.partnersNote) setVoiceModelStatus(payload.partnersNote);
  } catch (error) {
    voicePartners = [];
    renderVoicePartners();
    setVoiceModelStatus(error?.message || '伙伴名单读不到。');
  } finally {
    if (voicePartnerRefresh) { voicePartnerRefresh.disabled = false; voicePartnerRefresh.textContent = '刷新伙伴'; }
  }
}

function base64ToBlob(base64, format) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: format === 'wav' ? 'audio/wav' : 'audio/mpeg' }));
}

function releaseVoiceAudio() {
  if (voiceAudioUrl) { URL.revokeObjectURL(voiceAudioUrl); voiceAudioUrl = ''; }
  if (voiceAudio) { voiceAudio.pause(); voiceAudio.removeAttribute('src'); }
  voiceCaptionSpans = [];
}

function splitSentences(text) {
  return String(text || '').split(/(?<=[。！？!?；;\n])/).map((item) => item).filter((item) => item.trim());
}

function renderVoiceCaption(text, timings, durationMs) {
  if (!voiceCaption) return;
  voiceCaption.replaceChildren();
  voiceCaptionSpans = [];
  const hasTimings = Array.isArray(timings) && timings.length > 0;
  const segments = hasTimings
    ? timings.map((row) => ({ start: row.start, end: row.end, text: row.text }))
    : (() => {
      const parts = splitSentences(text);
      const total = parts.reduce((sum, item) => sum + item.length, 0) || 1;
      let cursor = 0;
      return parts.map((item) => {
        const span = Math.max(400, Math.round((item.length / total) * (Number(durationMs) || 0)));
        const segment = { start: cursor, end: cursor + span, text: item };
        cursor += span;
        return segment;
      });
    })();
  for (const segment of segments) {
    const span = document.createElement('span');
    span.className = 'caption-word';
    span.textContent = segment.text;
    voiceCaption.appendChild(span);
    voiceCaptionSpans.push({ span, start: segment.start, end: segment.end });
  }
  voiceCaption.dataset.mode = hasTimings ? 'word' : 'sentence';
}

function highlightVoiceCaption(timeMs) {
  for (const item of voiceCaptionSpans) {
    item.span.classList.toggle('is-now', timeMs >= item.start && timeMs < item.end);
  }
}

voiceAudio?.addEventListener('timeupdate', () => {
  highlightVoiceCaption((Number(voiceAudio.currentTime) || 0) * 1000);
});

// 播完才把「试听」按钮复位：pause 事件在换音频时也会来，
// 拿它复位会把刚放上的试听又按成「试听」状态。
voiceAudio?.addEventListener('ended', () => {
  setVoicePreviewState(voicePreviewButton, false);
  voicePreviewButton = null;
});

async function playVoiceClip(clipId, format, payload) {
  const response = await hana.api.fetch(`/voice/clip/${encodeURIComponent(clipId)}?format=${encodeURIComponent(format)}`);
  if (!response.ok) throw new Error('这段音频取不到了，重新合成一次。');
  const blob = await response.blob();
  releaseVoiceAudio();
  voiceAudioUrl = URL.createObjectURL(blob);
  if (voiceAudio) voiceAudio.src = voiceAudioUrl;
  if (voicePlayer) voicePlayer.removeAttribute('hidden');
  renderVoiceCaption(payload.text, payload.timings, payload.durationMs);
  await voiceAudio?.play?.().catch(() => {});
}

voiceTestButton?.addEventListener('click', async () => {
  voiceTestButton.disabled = true;
  voiceTestButton.textContent = '正在合成…';
  setVoiceModelStatus('正在用这份配置合成一句试听…');
  try {
    const payload = await voiceRequest('/voice-config/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: voicePayload({ model: true }), voiceId: voiceDraft?.defaultVoiceId || '' }),
    });
    releaseVoiceAudio();
    voiceAudioUrl = base64ToBlob(payload.audio, payload.format);
    if (voiceAudio) voiceAudio.src = voiceAudioUrl;
    if (voicePlayer) voicePlayer.removeAttribute('hidden');
    await voiceAudio?.play?.().catch(() => {});
    setVoiceModelStatus(`连上了：${payload.format} · 约 ${Math.round((payload.durationMs || 0) / 1000)} 秒 · 词级标记 ${payload.timings?.length || 0} 条。`);
  } catch (error) {
    setVoiceModelStatus(error?.message || '连不上。');
  } finally {
    voiceTestButton.disabled = false;
    voiceTestButton.textContent = '测试一下';
  }
});

voiceSaveButton?.addEventListener('click', () => { void saveVoice({ model: true }); });
voicePartnerRefresh?.addEventListener('click', () => { void loadVoicePartners(); });
voiceFavRefresh?.addEventListener('click', () => {
  if (!voiceFavRefresh) return;
  voiceFavRefresh.disabled = true;
  voiceFavRefresh.textContent = '读取中…';
  void loadVoiceFavorites().finally(() => {
    voiceFavRefresh.disabled = false;
    voiceFavRefresh.textContent = '刷新列表';
  });
});

voiceToneTrigger?.addEventListener('click', () => {
  if (!voiceToneOptionsHost) return;
  const open = voiceToneOptionsHost.hasAttribute('hidden');
  if (open) { voiceToneOptionsHost.removeAttribute('hidden'); voiceToneTrigger.setAttribute('aria-expanded', 'true'); }
  else closeVoiceToneOptions();
});
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeVoiceToneOptions(); });

for (const [group, key, transform] of [
  [voiceEnabledGroup, 'enabled', (value) => value === 'on'],
  [voiceScopeGroup, 'scope', (value) => value],
  [voiceSpeedGroup, 'speed', (value) => Number(value) || 1],
]) {
  group?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    voiceDraft = { ...voiceDraft, [key]: transform(button.dataset.value) };
    setSegmentValue(group, button.dataset.value);
    scheduleVoicePrefSave();
  });
}

voiceProtocolGroup?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-value]');
  if (!button) return;
  setSegmentValue(voiceProtocolGroup, button.dataset.value);
  voiceVoices = Array.isArray(voiceLibrary[button.dataset.value]) && voiceLibrary[button.dataset.value].length
    ? voiceLibrary[button.dataset.value]
    : voiceVoices;
  voiceDraft = { ...voiceDraft, protocol: button.dataset.value };
  renderVoiceTones();
  renderVoicePartners();
  syncVoiceControls();
});

voiceHanaKeyGroup?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-value]');
  if (!button) return;
  setSegmentValue(voiceHanaKeyGroup, button.dataset.value);
  syncVoiceControls();
});
voiceApiKeyInput?.addEventListener('input', () => { syncVoiceControls(); });
voiceAuthStyleGroup?.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-value]');
  if (!button) return;
  setSegmentValue(voiceAuthStyleGroup, button.dataset.value);
  syncVoiceControls();
});
// 自建 TTS 的音色是自由字符串：改了就直接进 draft，按偏好自动存。
voiceToneInput?.addEventListener('input', () => {
  voiceDraft = { ...voiceDraft, defaultVoiceId: voiceToneInput.value.trim() };
  renderVoicePartners();
  scheduleVoicePrefSave();
});
for (const input of [voiceBaseUrlInput, voiceModelInput, voiceGroupIdInput]) {
  input?.addEventListener('input', () => { syncVoiceControls(); renderVoicePresets(); });
}

// 点外面收起：只挂一个委托监听，不要每渲染一行就往document 上叠一个。
document.addEventListener('click', (event) => {
  // 默认音色、内容模型、快速模型都挂在 .model-picker 里；点到 picker 外面就收起。
  // 这些下拉以前只在选中或重新渲染时关，点空白处会一直贴在那里。
  for (const options of document.querySelectorAll('.model-picker .model-options:not([hidden])')) {
    const picker = options.closest('.model-picker');
    if (picker && picker.contains(event.target)) continue;
    options.hidden = true;
    picker?.querySelector('.model-trigger')?.setAttribute('aria-expanded', 'false');
  }
  if (voicePartnersHost && !voicePartnersHost.contains(event.target)) {
    for (const open of voicePartnersHost.querySelectorAll('.partner-voice-options')) open.hidden = true;
    for (const trigger of voicePartnersHost.querySelectorAll('.partner-voice-trigger')) trigger.setAttribute('aria-expanded', 'false');
    for (const row of voicePartnersHost.querySelectorAll('.partner-voice-row.is-open')) row.classList.remove('is-open');
  }
});

// 对话式修订入口：只把「想聊」这个意思交给主对话的伙伴，具体的建议卡由它在对话里发。
recRefineButton?.addEventListener('click', async () => {
  recRefineButton.disabled = true;
  if (recRefineStatus) recRefineStatus.textContent = '正在告诉知意……';
  try {
    const response = await hana.api.fetch('/recommendation-config/refine-request', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '没递到话。');
    recRefineButton.textContent = '已递到对话 ✓';
    if (recRefineStatus) recRefineStatus.textContent = payload.hint || '去对话里说一声吧。';
  } catch (error) {
    recRefineButton.disabled = false;
    if (recRefineStatus) recRefineStatus.textContent = error?.message || '没递到话，再点一次。';
  }
});

recRestoreButton?.addEventListener('click', async () => {
  recRestoreButton.disabled = true;
  if (recRefineStatus) recRefineStatus.textContent = '正在恢复默认方向……';
  try {
    const response = await hana.api.fetch('/recommendation-config/restore', { method: 'POST' });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '没恢复成。');
    recommendationBehavior = {
      ...recommendationBehavior,
      styles: payload.styles,
      selectedByCount: payload.selectedByCount,
    };
    renderRecommendationBehavior();
    recRestoreButton.textContent = '已恢复 ✓';
    if (recRefineStatus) recRefineStatus.textContent = '方向已经恢复成默认的四个。';
  } catch (error) {
    if (recRefineStatus) recRefineStatus.textContent = error?.message || '没恢复成，再点一次。';
  } finally {
    recRestoreButton.disabled = false;
  }
});

// ── 设置弹窗 ──
// 不常用的配置全收在这里；主页面只留常用的开关。
const settingsModal = document.querySelector('#settings-modal');
const settingsOpenButton = document.querySelector('#open-settings');
const settingsCloseButtons = [
  document.querySelector('#settings-close'),
  document.querySelector('#settings-done'),
].filter(Boolean);
let settingsLastFocus = null;

function openSettings() {
  if (!settingsModal || !settingsModal.hasAttribute('hidden')) return;
  settingsLastFocus = document.activeElement;
  settingsModal.removeAttribute('hidden');
  document.body.classList.add('modal-open');
  settingsOpenButton?.setAttribute('aria-expanded', 'true');
  settingsModal.querySelector('#settings-close')?.focus();
}

function closeSettings() {
  if (!settingsModal || settingsModal.hasAttribute('hidden')) return;
  settingsModal.setAttribute('hidden', '');
  document.body.classList.remove('modal-open');
  settingsOpenButton?.setAttribute('aria-expanded', 'false');
  if (settingsLastFocus instanceof HTMLElement) settingsLastFocus.focus();
  settingsLastFocus = null;
}

settingsOpenButton?.addEventListener('click', openSettings);
for (const button of settingsCloseButtons) button.addEventListener('click', closeSettings);
settingsModal?.addEventListener('click', (event) => {
  // 点在遮罩（而不是弹窗本体）上才关，避免选模型时误关。
  if (event.target === settingsModal) closeSettings();
});
document.addEventListener('keydown', (event) => {
  if (!settingsModal || settingsModal.hasAttribute('hidden')) return;
  if (event.key === 'Escape') { closeSettings(); return; }
  if (event.key !== 'Tab') return;
  // Tab 在弹窗里转圈，不许跑到背后的主页面去。
  const focusable = settingsModal.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex]');
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
  else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
});

// ── 守门人（活都干完再关机）────────────────────────────────
// 面板只负责看和调参：真正挂守门还是对话里说一句，或者让传音樱看着。
const sgSection = document.querySelector('#sleep-guard-section');
const sgStateText = document.querySelector('#sg-state-text');
const sgCancel = document.querySelector('#sg-cancel');
const sgIdle = document.querySelector('#sg-idle');
const sgGrace = document.querySelector('#sg-grace');
const sgTimeline = document.querySelector('#sg-timeline');
const sgStatus = document.querySelector('#sg-status');
let sleepGuardSnapshot = null;
let sleepGuardTimer = null;

function sgClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((n) => String(n).padStart(2, '0')).join(':');
}

function sgSecondsText(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

function sgDescribeBusy(entry) {
  const items = Array.isArray(entry?.busy) ? entry.busy : [];
  if (!items.length) return '';
  return items.map((item) => (item.kind === 'task'
    ? `任务 ${item.id || '?'}${item.type ? `（${item.type}${item.status ? '/' + item.status : ''}）` : ''}`
    : `窗口 ${item.id || '?'}${item.agent ? `（${item.agent}）` : ''}`)).join('、');
}

function sgStateLine(snapshot) {
  if (!snapshot) return '正在读取…';
  const status = String(snapshot.status || 'idle');
  if (status === 'watching') {
    const idle = Number(snapshot.idleSeconds) || 0;
    const need = Number(snapshot.needSeconds) || 0;
    if (idle <= 0) return `正在静候。刚刚才空下来，还差 ${sgSecondsText(need)} 才算结束。`;
    return `正在静候。已经安静了 ${sgSecondsText(idle)}，满 ${sgSecondsText(need)} 才关机。`;
  }
  if (status === 'countdown') {
    return `活儿都结束了，正在倒计时：还有 ${sgSecondsText(snapshot.countdownSeconds)} 就关机。这期间有任何动静都会当场取消。`;
  }
  if (status === 'shutdown-issued') return '已经发出关机命令，机器应该正在关。';
  if (status === 'preview-done') return '演练走完了整个流程，没有真的关机。';
  if (status === 'expired') return '等太久了，一直有活儿在跑，这次没关机。';
  if (status === 'cancelled') return `已经取消了${snapshot.cancelReason ? `：${snapshot.cancelReason}` : '。'}`;
  return '没有在静候。睡前跟知意说一句「静候关机」，它就会在这里替你盯着。';
}

function renderSleepGuard() {
  if (!sgSection) return;
  const snapshot = sleepGuardSnapshot;
  if (sgStateText) sgStateText.textContent = sgStateLine(snapshot);
  if (sgCancel) sgCancel.hidden = !(snapshot && snapshot.armed === true);

  const config = snapshot?.config || {};
  if (sgIdle && document.activeElement !== sgIdle) sgIdle.textContent = String(config.idleMinutes ?? 10);
  if (sgGrace && document.activeElement !== sgGrace) sgGrace.textContent = String(config.graceMinutes ?? 5);

  const realEnabled = snapshot?.realEnabled === true;

  if (sgTimeline) {
    sgTimeline.textContent = '';
    const rows = Array.isArray(snapshot?.timeline) ? snapshot.timeline.slice(-20).reverse() : [];
    if (!rows.length) {
      const li = document.createElement('li');
      li.textContent = '还没有记录。守门一挂上就会开始记。';
      sgTimeline.append(li);
    } else {
      for (const entry of rows) {
        const li = document.createElement('li');
        const header = document.createElement('strong');
        header.textContent = entry.kind === 'idle'
          ? `${sgClock(entry.at)} 全空`
          : `${sgClock(entry.at)} 忙 ${entry.count ?? '?'} 处`;
        li.append(header);
        const detailText = entry.kind === 'idle' ? '' : sgDescribeBusy(entry);
        if (detailText) {
          const detail = document.createElement('span');
          detail.textContent = ` ${detailText}`;
          li.append(detail);
        }
        sgTimeline.append(li);
      }
    }
  }

  if (sgStatus) {
    sgStatus.textContent = '判定成立后会先进一段可撤销的倒计时，再真的关机。';
  }
}

async function loadSleepGuard() {
  if (!sgSection) return;
  try {
    const response = await hana.api.fetch('/sleep-guard');
    if (!response.ok) throw new Error('读取失败');
    sleepGuardSnapshot = await response.json();
    renderSleepGuard();
  } catch {
    if (sgStatus) sgStatus.textContent = '读取守门状态失败，稍后再试。';
  }
  scheduleSleepGuardRefresh();
}

// 只在真的守着的时候才排下一次刷新；没在守就不留任何定时器。
function scheduleSleepGuardRefresh() {
  if (sleepGuardTimer) {
    clearTimeout(sleepGuardTimer);
    sleepGuardTimer = null;
  }
  if (!sgSection || sleepGuardSnapshot?.armed !== true) return;
  sleepGuardTimer = setTimeout(() => {
    sleepGuardTimer = null;
    if (document.hidden) {
      scheduleSleepGuardRefresh();
      return;
    }
    void loadSleepGuard();
  }, 5_000);
}

async function saveSleepGuardConfig(patch) {
  try {
    const response = await hana.api.fetch('/sleep-guard/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error || '保存失败');
    if (payload?.ok === false) throw new Error(payload?.error || '保存失败');
    sleepGuardSnapshot = { ...(sleepGuardSnapshot || {}), config: payload.config };
    renderSleepGuard();
  } catch {
    if (sgStatus) sgStatus.textContent = '没保存上，再试一次。';
  }
}

function bindSleepGuardStepper(buttonId, outputNode, key, delta, min, max) {
  document.querySelector(buttonId)?.addEventListener('click', () => {
    const current = Number(sleepGuardSnapshot?.config?.[key]) || min;
    const next = Math.min(max, Math.max(min, current + delta));
    if (next === current) return;
    if (outputNode) outputNode.textContent = String(next);
    sleepGuardSnapshot = {
      ...(sleepGuardSnapshot || {}),
      config: { ...(sleepGuardSnapshot?.config || {}), [key]: next },
    };
    void saveSleepGuardConfig({ [key]: next });
  });
}

bindSleepGuardStepper('#sg-idle-down', sgIdle, 'idleMinutes', -1, 1, 720);
bindSleepGuardStepper('#sg-idle-up', sgIdle, 'idleMinutes', 1, 1, 720);
bindSleepGuardStepper('#sg-grace-down', sgGrace, 'graceMinutes', -1, 1, 60);
bindSleepGuardStepper('#sg-grace-up', sgGrace, 'graceMinutes', 1, 1, 60);

sgCancel?.addEventListener('click', async () => {
  if (sgStatus) sgStatus.textContent = '正在撤…';
  try {
    const response = await hana.api.fetch('/sleep-guard/cancel', { method: 'POST' });
    if (!response.ok) throw new Error('撤销失败');
    await loadSleepGuard();
  } catch {
    if (sgStatus) sgStatus.textContent = '撤不掉，再试一次。';
  }
});

document.querySelector('#sg-refresh')?.addEventListener('click', () => { void loadSleepGuard(); });

// 守着的时候看一眼倒计时：由 loadSleepGuard 自己排下一轮，没定时器就不会空转。

hana.theme?.subscribe?.(syncHostTheme);
void (async () => {
  await hana.ready();
  syncHostTheme();
  initPermissionStatus();
  await Promise.all([
    refreshBallStatus(),
    loadAskCardSwitch(),
    loadContentModel(),
    loadFallbackModel(),
    fastModel?.load(),
    loadRecommendationBehavior(),
    loadVoiceConfig(),
    loadVoiceFavorites(),
    loadCustomModel(),
    loadSleepGuard(),
  ]);
  document.documentElement.dataset.ready = 'true';
})();
