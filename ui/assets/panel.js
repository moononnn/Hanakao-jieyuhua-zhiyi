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
      ? currentBallState.error || '传音樱已启动：关键提问、送推荐、捋一捋、起标题、念给我听都在传音樱里。'
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

async function contentModelRequest(method = 'GET', body = null) {
  const response = await hana.api.fetch('/content-model', {
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
    const payload = await contentModelRequest('POST', { modelRef });
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

const recSection = document.querySelector('#recommendation-behavior');
const recStatus = document.querySelector('#rec-status');
const recDisplay = document.querySelector('#rec-display');
const recCount = document.querySelector('#rec-count');
const recStyles = document.querySelector('#rec-styles');
const recRefineButton = document.querySelector('#rec-refine');
const recRestoreButton = document.querySelector('#rec-restore');
const recRefineStatus = document.querySelector('#rec-refine-status');
let recommendationBehavior = { display: 'ball', count: 3, styles: [], selectedByCount: {} };
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

function renderRecommendationBehavior() {
  const config = recommendationBehavior;
  const on = config.display === 'card';
  recSection?.classList.toggle('is-off', !on);
  setSegmentValue(recDisplay, config.display);
  setSegmentValue(recCount, config.count);
  renderStyleList();
  if (!recStatus) return;
  recStatus.textContent = on
    ? `已开启：只在你掀开传音樱时生成，每次 ${config.count} 条，点一条复制走。`
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

async function loadRecommendationBehavior() {
  if (!recSection) return;
  try {
    const response = await hana.api.fetch('/recommendation-config');
    if (!response.ok) throw new Error('读取失败');
    const payload = await response.json();
    recommendationBehavior = {
      display: payload.display,
      count: payload.count,
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

// ── 异常中断续接 ──
// 分工：异常提醒归提个醒，这里只管续接。所以这块 UI 不解释「出错了」，
// 只讲知意自己做了什么、等不等你。
const resumeSection = document.querySelector('#resume-section');
const resumeEnabledGroup = document.querySelector('#resume-enabled');
const resumeAutoGroup = document.querySelector('#resume-auto');
const resumeMaxGroup = document.querySelector('#resume-max');
const resumeCooldownGroup = document.querySelector('#resume-cooldown');
const resumeStuckGroup = document.querySelector('#resume-stuck');
const resumeStatus = document.querySelector('#resume-status');
const resumeStatusHint = document.querySelector('#resume-status-hint');
const resumeContinueButton = document.querySelector('#resume-continue');
const resumeDismissButton = document.querySelector('#resume-dismiss');
const RESUME_HINT = '发现那一轮停在半路了';
let resumeConfig = null;
let resumeSessionId = '';
let resumeTimer = null;

function setResumeStatus(text) { if (resumeStatus) resumeStatus.textContent = text; }

async function resumeRequest(path, options = {}) {
  const response = await hana.api.fetch(path, options);
  let payload;
  try { payload = await response.json(); } catch { throw new Error('续接设置读不出来。'); }
  if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '续接操作失败。');
  return payload;
}

function renderResumeConfig(config) {
  resumeConfig = config;
  setSegmentValue(resumeEnabledGroup, config.enabled ? 'on' : 'off');
  setSegmentValue(resumeAutoGroup, config.autoResume ? 'on' : 'off');
  setSegmentValue(resumeMaxGroup, String(config.maxConsecutive));
  setSegmentValue(resumeCooldownGroup, String(config.cooldownMs));
  setSegmentValue(resumeStuckGroup, String(config.stuckTimeoutMs));
  const on = config.enabled;
  for (const row of document.querySelectorAll('.resume-only-on')) row.hidden = !on;
  if (resumeContinueButton) resumeContinueButton.disabled = !on || !resumeSessionId;
  if (resumeDismissButton) resumeDismissButton.disabled = !on || !resumeSessionId;
}

async function saveResumeConfig(patch) {
  try {
    const payload = await resumeRequest('/resume-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { ...(resumeConfig || {}), ...patch } }),
    });
    renderResumeConfig(payload.config);
    setResumeStatus('已保存。');
  } catch (error) {
    setResumeStatus(error?.message || '保存失败。');
    await loadResumeConfig();
  }
}

async function loadResumeConfig() {
  if (!resumeSection) return;
  try {
    const payload = await resumeRequest('/resume-config');
    renderResumeConfig(payload.config);
    if (resumeStatusHint) {
      resumeStatusHint.textContent = payload.text
        ? `发现那一轮停在半路了，知意可以往那段对话发一句「${payload.text}」。`
        : '发现那一轮停在半路了。';
    }
    await refreshResumeStatus();
    startResumePolling();
  } catch (error) {
    setResumeStatus(error?.message || '读取续接设置失败。');
  }
}

async function refreshResumeStatus() {
  if (!resumeSection) return;
  try {
    const query = resumeSessionId ? `?sessionId=${encodeURIComponent(resumeSessionId)}` : '';
    const payload = await resumeRequest(`/resume-status${query}`);
    if (!payload.eventsAvailable) {
      if (resumeStatusHint) resumeStatusHint.textContent = '当前宿主不支持事件订阅，只能靠「开头多久没说话」这一条判断，准确度会低一些。';
    }
    const snapshot = payload.session;
    if (snapshot && (snapshot.consecutive > 0 || snapshot.pending)) {
      setResumeStatus(`这段对话已经续接 ${snapshot.consecutive} 次${snapshot.pending ? '，还在等这一轮收尾' : ''}。`);
    } else if (!snapshot) {
      setResumeStatus('现在没有需要续接的对话。');
    }
  } catch (error) {
    setResumeStatus(error?.message || '状态读取失败。');
  }
}

function startResumePolling() {
  if (resumeTimer || !resumeSection) return;
  resumeTimer = setInterval(() => { void refreshResumeStatus(); }, 15_000);
}

for (const [group, key, transform] of [
  [resumeEnabledGroup, 'enabled', (value) => value === 'on'],
  [resumeAutoGroup, 'autoResume', (value) => value === 'on'],
  [resumeMaxGroup, 'maxConsecutive', (value) => Number(value)],
  [resumeCooldownGroup, 'cooldownMs', (value) => Number(value)],
  [resumeStuckGroup, 'stuckTimeoutMs', (value) => Number(value)],
]) {
  group?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    setSegmentValue(group, button.dataset.value);
    void saveResumeConfig({ [key]: transform(button.dataset.value) });
  });
}

resumeContinueButton?.addEventListener('click', async () => {
  resumeContinueButton.disabled = true;
  setResumeStatus('正在发「继续哈」…');
  try {
    const payload = await resumeRequest('/resume/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: resumeSessionId }),
    });
    setResumeStatus(`已发进那段对话：${payload.text || '继续哈'}`);
  } catch (error) {
    setResumeStatus(error?.message || '没发出去，再试一次。');
  } finally {
    resumeContinueButton.disabled = false;
  }
});

resumeDismissButton?.addEventListener('click', async () => {
  resumeDismissButton.disabled = true;
  try {
    await resumeRequest('/resume/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: resumeSessionId }),
    });
    setResumeStatus('已不管这段了。');
  } catch (error) {
    setResumeStatus(error?.message || '没能取消，再试一次。');
  } finally {
    resumeDismissButton.disabled = false;
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
const voiceHanaKeyGroup = document.querySelector('#voice-hana-key');
const voiceKeyNote = document.querySelector('#voice-key-note');
const voiceTestButton = document.querySelector('#voice-test');
const voiceSaveButton = document.querySelector('#voice-save');
const voiceModelStatus = document.querySelector('#voice-model-status');
const voiceScopeGroup = document.querySelector('#voice-scope');
const voiceSpeedGroup = document.querySelector('#voice-speed');
const voiceToneTrigger = document.querySelector('#voice-tone-trigger');
const voiceToneOptionsHost = document.querySelector('#voice-tone-options');
const voicePartnersHost = document.querySelector('#voice-partners');
const voicePartnerRefresh = document.querySelector('#voice-partner-refresh');
const voiceStatus = document.querySelector('#voice-status');
const voicePlayer = document.querySelector('#voice-player');
const voiceAudio = document.querySelector('#voice-audio');
const voiceCaption = document.querySelector('#voice-caption');

const VOICE_MODEL_KEYS = ['protocol', 'providerId', 'baseUrl', 'model', 'groupId', 'apiKey'];
const MASKED_KEY = '********';
let voiceSaved = null;
let voiceDraft = null;
let voiceVoices = [];
let voiceLibrary = { t2a: [], chat: [] };
let voicePresets = [];
let voicePartners = [];
let voiceAudioUrl = '';
let voiceCaptionSpans = [];
let voicePrefTimer = null;

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
      voiceDraft = { ...voiceDraft, providerId: preset.providerId || '' };
      renderVoicePresets();
      syncVoiceControls();
    });
    voicePresetGroup.appendChild(button);
  }
}

function renderVoiceTones() {
  if (!voiceToneTrigger || !voiceToneOptionsHost) return;
  voiceToneOptionsHost.replaceChildren();
  const current = String(voiceDraft?.defaultVoiceId || '');
  const known = voiceVoices.some((item) => item.id === current);
  const choices = known ? voiceVoices : [...voiceVoices, { id: current, name: `${current}（不在当前音色列表里）` }];
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
    const choices = [follow, ...voiceVoices];
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
    });
    row.append(name, trigger, options);
    voicePartnersHost.appendChild(row);
  }
}

function syncVoiceControls() {
  const dirty = voiceModelDirty();
  if (voiceSaveButton) {
    voiceSaveButton.disabled = !voiceSaved || !dirty;
    voiceSaveButton.classList.toggle('is-saved', !dirty);
    voiceSaveButton.textContent = dirty ? '保存' : '已保存 ✓';
  }
  if (voiceTestButton) voiceTestButton.disabled = !voiceSaved;
  if (voiceGroupIdField) voiceGroupIdField.hidden = (voiceProtocolGroup?.querySelector('button[aria-pressed="true"]')?.dataset.value || 't2a') !== 't2a';
}

function applyVoicePayload(payload) {
  voiceSaved = payload.config;
  voiceDraft = { ...payload.config };
  voiceVoices = Array.isArray(payload.voices) ? payload.voices : [];
  voiceLibrary = payload.voiceLibrary && typeof payload.voiceLibrary === 'object'
    ? { t2a: Array.isArray(payload.voiceLibrary.t2a) ? payload.voiceLibrary.t2a : [], chat: Array.isArray(payload.voiceLibrary.chat) ? payload.voiceLibrary.chat : [] }
    : { t2a: voiceVoices, chat: voiceVoices };
  voicePresets = Array.isArray(payload.presets) ? payload.presets : [];
  if (Array.isArray(payload.partners)) { voicePartners = payload.partners; renderVoicePartners(); }
  if (payload.partnersNote) setVoiceModelStatus(payload.partnersNote);
  if (voiceBaseUrlInput) voiceBaseUrlInput.value = voiceSaved.baseUrl || '';
  if (voiceModelInput) voiceModelInput.value = voiceSaved.model || '';
  if (voiceGroupIdInput) voiceGroupIdInput.value = voiceSaved.groupId || '';
  if (voiceApiKeyInput) voiceApiKeyInput.value = voiceSaved.apiKey || '';
  setSegmentValue(voiceHanaKeyGroup, voiceSaved.useHanaCredential ? 'on' : 'off');
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
    ? `当前：${voiceSaved.protocol === 't2a' ? 'MiniMax' : 'OpenAI 兼容'} · ${voiceSaved.model}`
    : '还没配好朗读模型：接口地址、模型名、API Key 三样缺一不可。');
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
for (const input of [voiceBaseUrlInput, voiceModelInput, voiceGroupIdInput]) {
  input?.addEventListener('input', () => { syncVoiceControls(); renderVoicePresets(); });
}

// 点外面收起：只挂一个委托监听，不要每渲染一行就往document 上叠一个。
document.addEventListener('click', (event) => {
  if (voicePartnersHost && !voicePartnersHost.contains(event.target)) {
    for (const open of voicePartnersHost.querySelectorAll('.partner-voice-options')) open.hidden = true;
    for (const trigger of voicePartnersHost.querySelectorAll('.partner-voice-trigger')) trigger.setAttribute('aria-expanded', 'false');
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

hana.theme?.subscribe?.(syncHostTheme);
void (async () => {
  await hana.ready();
  syncHostTheme();
  initPermissionStatus();
  await Promise.all([
    refreshBallStatus(),
    loadAskCardSwitch(),
    loadContentModel(),
    loadRecommendationBehavior(),
    loadVoiceConfig(),
    loadCustomModel(),
    loadResumeConfig(),
  ]);
  document.documentElement.dataset.ready = 'true';
})();
