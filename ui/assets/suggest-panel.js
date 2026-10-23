import { hana } from './sdk.js';
import { activeTimingIndex, buildReaderSegments, formatTimeLabel } from './voice-reader.js';
import { buildPolishRequest, normalizePolishSuggestions, polishStatusText } from './polish-draft.js';

const list = document.getElementById('list');
const empty = document.getElementById('empty');
const quickSection = document.getElementById('quick');
const quickList = document.getElementById('quick-list');
const quickEditor = document.getElementById('quick-editor');
const quickInput = document.getElementById('quick-input');
const quickAdd = document.getElementById('quick-add');
const editToggle = document.getElementById('edit-quick');
const renameButton = document.getElementById('rename-slug');
const renameHint = document.getElementById('rename-hint');
const slugNote = document.getElementById('slug-note');
const closeButton = document.getElementById('close-panel');
const generateButton = document.getElementById('generate');
const genNote = document.getElementById('gen-note');
const recommendTab = document.getElementById('tab-recommend');
const toolsTab = document.getElementById('tab-tools');
const polishTab = document.getElementById('tab-polish');
const recommendPage = document.getElementById('recommend-page');
const toolsPage = document.getElementById('tools-page');
const toolsGrid = document.getElementById('tools-grid');
const openVoiceButton = document.getElementById('open-voice');
const voiceBackButton = document.getElementById('voice-back');
const openQueueButton = document.getElementById('open-queue');
const queueBackButton = document.getElementById('queue-back');
const queueView = document.getElementById('queue-view');
const queueTarget = document.getElementById('queue-target');
const queueInput = document.getElementById('queue-input');
const queueRoundsDown = document.getElementById('queue-rounds-down');
const queueRoundsUp = document.getElementById('queue-rounds-up');
const queueRoundsValue = document.getElementById('queue-rounds');
const queueStatusRow = document.getElementById('queue-status-row');
const queueStatus = document.getElementById('queue-status');
const queueStopButton = document.getElementById('queue-stop');
const queueCancelButton = document.getElementById('queue-cancel');
const queueSendButton = document.getElementById('queue-send');
const polishPage = document.getElementById('polish-page');
const polishInput = document.getElementById('polish-input');
const polishRequire = document.getElementById('polish-require');
const polishSuggest = document.getElementById('polish-suggest');
const polishSuggestList = document.getElementById('polish-suggest-list');
const polishRunButton = document.getElementById('polish-run');
const polishQueueButton = document.getElementById('polish-queue');
const polishSendButton = document.getElementById('polish-send');
const polishStatus = document.getElementById('polish-status');
const voiceTarget = document.getElementById('voice-target');
const voiceNote = document.getElementById('voice-note');
const voiceSource = document.getElementById('voice-source');
const voiceList = document.getElementById('voice-list');
const voiceListView = document.getElementById('voice-list-view');
const voiceReaderView = document.getElementById('voice-reader-view');
const refreshVoiceButton = document.getElementById('refresh-voice');
const readerBackButton = document.getElementById('reader-back');
const readerPartner = document.getElementById('reader-partner');
const readerText = document.getElementById('reader-text');
const readerPaper = readerText.closest('.reader-paper');
const readerCount = document.getElementById('reader-count');
const readerDraft = document.getElementById('reader-draft');
const readerEditButton = document.getElementById('reader-edit');
const readerRestoreButton = document.getElementById('reader-restore');
const readerSpeakButton = document.getElementById('reader-speak');
const readerNote = document.getElementById('reader-note');
const retryVoiceButton = document.getElementById('retry-voice');
const voiceFavoriteButton = document.getElementById('voice-favorite');
const replyAudio = document.getElementById('reply-audio');
const playerToggle = document.getElementById('player-toggle');
const playIcon = playerToggle.querySelector('.play-icon');
const pauseIcon = playerToggle.querySelector('.pause-icon');
const playerProgress = document.getElementById('player-progress');
const playerCurrentTime = document.getElementById('player-current-time');
const playerDuration = document.getElementById('player-duration');
const volumeToggle = document.getElementById('volume-toggle');
const volumeOnIcon = volumeToggle.querySelector('.volume-on-icon');
const volumeOffIcon = volumeToggle.querySelector('.volume-off-icon');
const volumeRange = document.getElementById('volume-range');
const speedButton = document.getElementById('speed-button');
const speedMenu = document.getElementById('speed-menu');
const speedOptions = [...speedMenu.querySelectorAll('.speed-option')];

let editing = false;
let quickReplies = [];
let activePage = 'recommend';
let currentSessionId = '';
let recommendationHeight = 220;
let voiceRepliesLoaded = false;
let voiceListSequence = 0;
let voiceAudioUrl = '';
let voiceReadSequence = 0;
let currentPartnerName = '';
let currentReadItem = null;
// 朗读稿：原文只在进来时读一次，改稿后合成用稿子；没改就照旧按 entryId 念整轮。
let readerOriginalText = '';
let readerDraftText = '';
let readerEdited = false;
let activeReaderMarks = [];
let readerMarkSpans = [];
let activeReaderMark = -1;
let highlightFrame = 0;
let currentPlaybackRate = 1;
// 本次朗读没能逐词点亮时的原因（空串 = 正常高亮）。播放、暂停时都要把它留在提示行。
let readerFallbackNote = '';
// 当前这段朗读的音频信息：收藏时要用（只存引用，不复制音频）。
let currentReadClip = null;
let currentVolume = 1;
let playerMuted = false;
let volumeBeforeMute = 1;
const VOICE_LIST_PANEL_HEIGHT = 460;
const VOICE_READER_PANEL_HEIGHT = 560;
const POLISH_PANEL_HEIGHT = 420;
const TOOLS_PANEL_HEIGHT = 240;
// 排队那层比格子高：输入框、轮数行、提示、状态、按钮都要摆下。
const QUEUE_PANEL_HEIGHT = 420;
const MAX_PANEL_HEIGHT = 560;
// 面板现在有三页：推荐回复、小工具、帮我理顺。页签与页面一一对应，切页时一起换。
const PANEL_PAGES = [
  { key: 'recommend', tab: recommendTab, page: recommendPage },
  { key: 'tools', tab: toolsTab, page: toolsPage },
  { key: 'polish', tab: polishTab, page: polishPage },
];
// 小工具那页现在有三层：入口格子、朗读、排队发送。记住停在哪一层。
let toolsSubView = 'grid';

// 排队发送：跟球上那个弹窗共用同一份话单，这里只是另一个入口。
let queueRounds = 1;
let queueBusy = false;
let queuePollTimer = null;
let queuePollSeq = 0;
// 理顺这一页的状态：最初那版原话是安全锚点，上一版结果是「迭代」的依据。
// 两者都只活在这一页里，换会话就清掉。
let polishSource = '';
let polishLastResult = '';
let polishBusy = false;

function panelSessionId() {
  const context = hana.inputPanel?.getContext?.();
  return String(context?.sessionId || currentSessionId || '').trim();
}

function syncPanelContext(context) {
  const nextSessionId = String(context?.sessionId || '').trim();
  const changed = nextSessionId !== currentSessionId;
  currentSessionId = nextSessionId;
  if (activePage === 'recommend' && Number.isFinite(context?.presentation?.height) && context.presentation.height > 0) {
    recommendationHeight = context.presentation.height;
  }
  if (changed) {
    voiceRepliesLoaded = false;
    voiceListSequence += 1;
    voiceReadSequence += 1;
    currentReadItem = null;
    currentPartnerName = '';
    releaseReplyAudio();
    voiceReaderView.hidden = true;
    voiceListView.hidden = toolsSubView !== 'voice';
    readerText.textContent = '';
    readerNote.textContent = '';
    resetReaderDraft('');
    retryVoiceButton.hidden = true;
    voiceList.textContent = '';
    // 换了一段对话，理顺的草稿也不能跟着过去（那句话是写给上一段 ta 的）。
    polishSource = '';
    polishLastResult = '';
    if (polishInput) polishInput.value = '';
    if (polishRequire) polishRequire.value = '';
    clearPolishSuggestions();
    if (polishQueueButton) polishQueueButton.hidden = true;
    if (polishSendButton) polishSendButton.hidden = true;
    setPolishStatus('');
    // 换了一段对话，排队草稿也得清掉（那句话是写给上一段 ta 的）；
    // 排队本身跟对话走，面板只负责把新会话的状态重新拉一遍。
    if (queueInput) queueInput.value = '';
    setQueueStatus('');
    if (queueStopButton) queueStopButton.hidden = true;
    // 换了一段对话，上一段的起名结果不能跟过来（那句话说的是别的窗口）。
    renaming = false;
    renameButton.disabled = false;
    setRenameState(RENAME_HINT_IDLE);
    setSlugNote('');
    if (activePage === 'tools' && toolsSubView === 'voice') {
      void loadVoiceReplies({ force: true });
    } else if (activePage === 'tools' && toolsSubView === 'queue') {
      void refreshQueueState();
    } else {
      refreshVoiceButton.disabled = false;
      refreshVoiceButton.textContent = '刷新';
    }
  }
}

// 起名：现在住在小工具页里，是一格入口按钮。
// 按输入框所在的这段对话起名并写回，不依赖传音樱——球没开也能用，哪段对话点开就改哪段。
let renaming = false;
// 格子里那行小字就是这一格的状态（平时是说明，点了就变「起名中…」）。
const RENAME_HINT_IDLE = '给这段对话起个名';

function setRenameState(text) {
  if (!renameHint) return;
  renameHint.textContent = text;
}

function setSlugNote(text, { bad = false, undo = false } = {}) {
  if (!slugNote) return;
  slugNote.textContent = '';
  slugNote.classList.toggle('bad', bad === true);
  if (!text) return;
  slugNote.append(document.createTextNode(text));
  // 「还原」只给成功那次：失败的时候没有任何东西可还原。
  if (undo !== true) return;
  const undoBtn = document.createElement('button');
  undoBtn.type = 'button';
  undoBtn.className = 'slug-undo';
  undoBtn.textContent = '还原';
  undoBtn.addEventListener('click', () => void undoTypedTitle());
  slugNote.append(undoBtn);
}

async function renameCurrentSession() {
  if (renaming) return;
  const sessionId = panelSessionId();
  if (!sessionId) {
    setSlugNote('不知道这是哪段对话，收起面板重新点一次输入栏按钮。', { bad: true });
    return;
  }
  renaming = true;
  renameButton.disabled = true;
  setRenameState('起名中…');
  setSlugNote('');
  try {
    const response = await hana.api.fetch('/suggest-panel/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '没改成，再试一次。');
    const title = String(payload?.title || '').trim();
    // 兜底标出来：那是拿她自己那句原话顶上的，不是模型起的名，不装作正常完成。
    setSlugNote(payload?.fallback ? `已改为：${title}（兜底）` : `已改为：${title}`, { undo: true });
  } catch (error) {
    setSlugNote(String(error?.message || '没改成，再试一次。').slice(0, 160), { bad: true });
  } finally {
    renaming = false;
    renameButton.disabled = false;
    setRenameState(RENAME_HINT_IDLE);
  }
}

async function undoTypedTitle() {
  if (renaming) return;
  const sessionId = panelSessionId();
  if (!sessionId) return;
  renaming = true;
  renameButton.disabled = true;
  try {
    const response = await hana.api.fetch('/session-title/undo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '没撤回成。');
    setSlugNote(`已还原：${payload?.restoredTitle || '无标题'}`);
  } catch (error) {
    setSlugNote(String(error?.message || '没撤回成。').slice(0, 160), { bad: true });
  } finally {
    renaming = false;
    renameButton.disabled = false;
  }
}

renameButton?.addEventListener('click', () => void renameCurrentSession());

async function setPanelHeight(height) {
  try {
    await hana.inputPanel?.setPresentation?.({ height: Math.max(160, Math.min(MAX_PANEL_HEIGHT, Math.round(Number(height) || 220))), expanded: true });
  } catch {
    // 面板高度调整失败时仍可在当前高度内滚动使用。
  }
}

function releaseReplyAudio() {
  stopHighlightLoop();
  if (replyAudio) {
    replyAudio.pause();
    replyAudio.removeAttribute('src');
    replyAudio.load?.();
  }
  if (voiceAudioUrl) {
    URL.revokeObjectURL(voiceAudioUrl);
    voiceAudioUrl = '';
  }
  currentReadClip = null;
  if (voiceFavoriteButton) {
    voiceFavoriteButton.hidden = true;
    voiceFavoriteButton.textContent = '♡ 收藏';
    voiceFavoriteButton.disabled = false;
  }
  activeReaderMarks = [];
  readerMarkSpans = [];
  activeReaderMark = -1;
  setPlayerPlaying(false);
  playerToggle.disabled = true;
  playerProgress.disabled = true;
  volumeToggle.disabled = true;
  volumeRange.disabled = true;
  speedButton.disabled = true;
  speedMenu.hidden = true;
  speedButton.setAttribute('aria-expanded', 'false');
  playerProgress.value = '0';
  playerProgress.style.setProperty('--range-progress', '0%');
  playerCurrentTime.textContent = '0:00';
  playerDuration.textContent = '0:00';
}

function renderReaderText(text, timings = []) {
  const result = buildReaderSegments(text, timings);
  readerText.replaceChildren();
  readerPaper.scrollTop = 0;
  readerMarkSpans = [];
  activeReaderMarks = result.marks;
  activeReaderMark = -1;
  for (const segment of result.segments) {
    if (segment.type === 'mark') {
      const word = document.createElement('span');
      word.className = 'reader-mark';
      word.textContent = segment.text;
      readerText.append(word);
      readerMarkSpans.push(word);
    } else {
      readerText.append(document.createTextNode(segment.text));
    }
  }
  // 不亮的时候把原因写出来：是压根没拿到时间戳，还是拿到了却跟原文对不上。
  return {
    hasMarks: activeReaderMarks.length > 0,
    covered: result.covered || 0,
    eligibleCharacters: result.eligibleCharacters || 0,
    timedRows: Array.isArray(timings) ? timings.length : 0,
  };
}

function paintReaderMark(index) {
  if (activeReaderMark === index) return;
  readerMarkSpans[activeReaderMark]?.classList.remove('is-active');
  activeReaderMark = index;
  const currentMark = readerMarkSpans[activeReaderMark];
  currentMark?.classList.add('is-active');
  if (!currentMark) return;

  const paper = readerPaper;
  if (!paper) return;
  const markRect = currentMark.getBoundingClientRect();
  const paperTop = paper.getBoundingClientRect().top + paper.clientTop;
  const paperBottom = paperTop + paper.clientHeight;
  const inset = 16;
  if (markRect.top < paperTop + inset) {
    paper.scrollTop -= paperTop + inset - markRect.top;
  } else if (markRect.bottom > paperBottom - inset) {
    paper.scrollTop += markRect.bottom - (paperBottom - inset);
  }
}

function setPlayerPlaying(playing) {
  playerToggle.classList.toggle('is-playing', playing);
  playerToggle.setAttribute('aria-label', playing ? '暂停朗读' : '播放朗读');
  // 这几个图标是 <svg>：hidden 属性定义在 HTMLElement 上，SVGElement 没有它，
  // 所以 `svg.hidden = true` 只会挂一个普通 JS 属性，不生成 HTML 属性，
  // CSS 的 [hidden]{display:none} 就永远匹配不上——图标会卡在初始状态不动。
  // 走 Element.toggleAttribute 才是真属性。
  playIcon.toggleAttribute('hidden', playing);
  pauseIcon.toggleAttribute('hidden', !playing);
}

function syncPlayerButtonState() {
  setPlayerPlaying(!replyAudio.paused && !replyAudio.ended);
}

function updatePlayerProgress() {
  const duration = Number(replyAudio.duration);
  const current = Number(replyAudio.currentTime) || 0;
  const ratio = Number.isFinite(duration) && duration > 0 ? Math.min(1, Math.max(0, current / duration)) : 0;
  playerCurrentTime.textContent = formatTimeLabel(current);
  playerDuration.textContent = formatTimeLabel(duration);
  playerProgress.value = String(Math.round(ratio * 1000));
  playerProgress.style.setProperty('--range-progress', `${ratio * 100}%`);
  playerProgress.disabled = !Number.isFinite(duration) || duration <= 0;
}

function syncVolumeControls() {
  replyAudio.volume = currentVolume;
  replyAudio.muted = playerMuted;
  volumeRange.value = String(Math.round(currentVolume * 100));
  volumeRange.style.setProperty('--range-progress', `${currentVolume * 100}%`);
  volumeToggle.setAttribute('aria-pressed', String(playerMuted));
  volumeToggle.setAttribute('aria-label', playerMuted ? '取消静音' : '静音');
  const silent = playerMuted || currentVolume === 0;
  // 同上：SVG 图标只能用 toggleAttribute 控制显隐。
  volumeOnIcon.toggleAttribute('hidden', silent);
  volumeOffIcon.toggleAttribute('hidden', !silent);
}

function setPlaybackRate(rate) {
  currentPlaybackRate = Number(rate) || 1;
  replyAudio.playbackRate = currentPlaybackRate;
  speedButton.textContent = `${currentPlaybackRate}×`;
  speedOptions.forEach((option) => {
    const selected = Number(option.dataset.rate) === currentPlaybackRate;
    option.classList.toggle('active', selected);
    option.setAttribute('aria-checked', String(selected));
  });
}

function setPlayerControlsEnabled(enabled) {
  playerToggle.disabled = !enabled;
  volumeToggle.disabled = !enabled;
  volumeRange.disabled = !enabled;
  speedButton.disabled = !enabled;
  if (!enabled) playerProgress.disabled = true;
}

function updatePlaybackFrame() {
  updatePlayerProgress();
  const at = (Number(replyAudio.currentTime) || 0) * 1000;
  paintReaderMark(activeTimingIndex(activeReaderMarks, at));
  if (!replyAudio.paused && !replyAudio.ended) highlightFrame = requestAnimationFrame(updatePlaybackFrame);
  else highlightFrame = 0;
}

function stopHighlightLoop() {
  if (highlightFrame) cancelAnimationFrame(highlightFrame);
  highlightFrame = 0;
}

function renderVoiceReplies(replies) {
  voiceList.textContent = '';
  const items = Array.isArray(replies) ? replies : [];
  if (!items.length) return;
  items.forEach((item) => {
    const row = document.createElement('li');
    row.className = 'voice-row';

    const copy = document.createElement('div');
    copy.className = 'voice-copy';
    const preview = document.createElement('div');
    preview.className = 'voice-preview';
    preview.textContent = String(item?.preview || '（这条回复没有预览文字）');
    const meta = document.createElement('div');
    meta.className = 'voice-meta';
    meta.textContent = `${item?.isLatest ? '最新 · ' : ''}${Math.max(0, Number(item?.chars) || 0)} 字`;
    copy.append(preview, meta);

    const readButton = document.createElement('button');
    readButton.className = 'mini-btn voice-read';
    readButton.type = 'button';
    // 不叫「朗读」了：点进去只是看稿，合成要自己按一下（实机：以前一点就默默花钱合成）。
    readButton.textContent = '查看';
    if (!String(item?.entryId || '').trim()) {
      readButton.disabled = true;
      readButton.title = '这条回复暂时无法定位';
    } else {
      readButton.addEventListener('click', () => void openReply(item, readButton));
    }

    row.append(copy, readButton);
    voiceList.append(row);
  });
}

async function loadVoiceReplies({ force = false } = {}) {
  if (voiceRepliesLoaded && !force) return;
  const requestSequence = ++voiceListSequence;
  const sessionId = panelSessionId();
  if (!sessionId) {
    voiceRepliesLoaded = false;
    voiceNote.textContent = '没识别到当前对话。收起面板后，从目标对话重新打开。';
    voiceList.textContent = '';
    refreshVoiceButton.disabled = false;
    refreshVoiceButton.textContent = '刷新';
    return;
  }
  refreshVoiceButton.disabled = true;
  refreshVoiceButton.textContent = '读取中…';
  voiceNote.textContent = '正在读取这段对话的最近回复…';
  try {
    const response = await hana.api.fetch(`/voice/replies?sessionId=${encodeURIComponent(sessionId)}&limit=8`);
    const payload = await response.json();
    if (requestSequence !== voiceListSequence || sessionId !== panelSessionId()) return;
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '回复列表读不出来。');
    const replies = Array.isArray(payload.replies) ? payload.replies : [];
    currentPartnerName = String(payload.session?.agentName || '').trim();
    voiceTarget.textContent = currentPartnerName ? `${currentPartnerName}的最近回复` : '当前对话的最近回复';
    // 面板读的是「面板所在的窗口」那段对话。把窗口名写出来，
    // 免得在旧窗口里打开面板、看到的却是另一段对话还以为列表坏了。
    const sourceTitle = String(payload.session?.currentTitle || '').trim();
    if (voiceSource) {
      voiceSource.textContent = sourceTitle
        ? `读的是「${sourceTitle}」这段对话。`
        : '读的是这个窗口的对话。';
    }
    renderVoiceReplies(replies);
    voiceRepliesLoaded = true;
    voiceNote.textContent = replies.length ? '选一条回复，进入专门的朗读页面。' : '当前对话还没有可朗读的回复。';
  } catch (error) {
    if (requestSequence !== voiceListSequence || sessionId !== panelSessionId()) return;
    voiceNote.textContent = String(error?.message || '回复列表读不出来。').slice(0, 200);
    voiceRepliesLoaded = false;
  } finally {
    if (requestSequence === voiceListSequence) {
      refreshVoiceButton.disabled = false;
      refreshVoiceButton.textContent = '刷新';
    }
  }
}

function readerCharCount(text) {
  return String(text || '').replace(/\s+/g, '').length;
}

function updateReaderCount() {
  paintReaderCount(readerDraftText);
}

function paintReaderCount(text) {
  const count = readerCharCount(text);
  readerCount.textContent = count ? `${count} 字` : '';
}

function setReaderEditing(on) {
  const editing = Boolean(on);
  readerDraft.hidden = !editing;
  readerText.hidden = editing;
  readerEditButton.textContent = editing ? '保存改稿' : '改稿';
  readerSpeakButton.hidden = editing;
  readerRestoreButton.hidden = editing ? false : !readerEdited;
  if (editing) {
    readerDraft.value = readerDraftText;
    readerDraft.scrollTop = 0;
    readerDraft.focus();
    const end = readerDraft.value.length;
    readerDraft.setSelectionRange(end, end);
  }
}

function resetReaderDraft(text = '') {
  readerOriginalText = String(text || '');
  readerDraftText = readerOriginalText;
  readerEdited = false;
  readerDraft.value = '';
  setReaderEditing(false);
  updateReaderCount();
}

function saveReaderDraft() {
  const next = readerDraft.value.trim();
  if (!readerCharCount(next)) {
    readerNote.textContent = '稿子删空了，没东西可读。留一点字，或者点「还原原文」。';
    return false;
  }
  readerDraftText = next;
  readerEdited = readerDraftText !== readerOriginalText;
  renderReaderText(readerDraftText);
  setReaderEditing(false);
  updateReaderCount();
  readerNote.textContent = readerEdited
    ? '改稿只在这次念的时候生效，不会动聊天里的原回复。'
    : '和原文一样，点「朗读这篇」开始合成。';
  return true;
}

function restoreReaderOriginal() {
  readerDraftText = readerOriginalText;
  readerEdited = false;
  if (!readerDraft.hidden) {
    // 还在编辑态：先把框里的字换回原文，不替她关掉编辑。
    readerDraft.value = readerDraftText;
    return;
  }
  renderReaderText(readerDraftText);
  updateReaderCount();
  readerNote.textContent = '已还原成原文。';
}

/** 进阅读页：只看稿，不合成。合成要她自己在页里按一下。 */
async function openReply(item) {
  const sessionId = panelSessionId();
  const entryId = String(item?.entryId || '').trim();
  if (!sessionId || !entryId) {
    voiceNote.textContent = '没认出这条回复属于哪段对话，刷新列表后再试。';
    return;
  }
  const sequence = ++voiceReadSequence;
  currentReadItem = item;
  voiceListView.hidden = true;
  voiceReaderView.hidden = false;
  readerPartner.textContent = currentPartnerName ? `${currentPartnerName}的回复` : '这条回复';
  retryVoiceButton.hidden = true;
  setPlayerControlsEnabled(false);
  releaseReplyAudio();
  readerFallbackNote = '';
  resetReaderDraft(String(item?.text || item?.preview || ''));
  renderReaderText(readerDraftText);
  readerSpeakButton.disabled = !readerCharCount(readerDraftText);
  readerNote.textContent = item?.truncated
    ? '正在取完整正文…'
    : '先看稿子。不想读的段落直接删掉，再点「朗读这篇」。';
  await setPanelHeight(VOICE_READER_PANEL_HEIGHT);
  if (!item?.truncated) return;
  // 长回复：列表里的 text 只到 1200 字，编辑器要拿全文，否则后半截一删就没了。
  const previewText = readerDraftText;
  try {
    const params = new URLSearchParams({ sessionId });
    if (Array.isArray(item.entryIds) && item.entryIds.length) params.set('entryIds', item.entryIds.join(','));
    else params.set('entryId', entryId);
    const response = await hana.api.fetch(`/voice/reply-text?${params.toString()}`);
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '全文没取到。');
    if (sequence !== voiceReadSequence || sessionId !== panelSessionId()) return;
    // 她已经动手改了就不覆盖。
    if (readerDraftText !== previewText) return;
    resetReaderDraft(String(payload.text || ''));
    renderReaderText(readerDraftText);
    readerSpeakButton.disabled = !readerCharCount(readerDraftText);
    readerNote.textContent = '完整正文取回来了。不想读的段落直接删掉，再点「朗读这篇」。';
  } catch {
    if (sequence !== voiceReadSequence) return;
    readerNote.textContent = '完整正文没取到，编辑器里只有开头那一段；直接点「朗读这篇」仍会念整条。';
  }
}

/** 合成当前朗读稿：改过就走文字通道，没改过还是照 entryIds 念整轮。 */
async function speakCurrent() {
  const item = currentReadItem;
  const sessionId = panelSessionId();
  if (!item || !sessionId) return;
  // 没点保存就直接按键：先把编辑框里的字收下。
  if (!readerDraft.hidden && !saveReaderDraft()) return;
  const text = String(readerDraftText || '').trim();
  if (!readerCharCount(text)) {
    readerNote.textContent = '没有可读的内容了。';
    readerSpeakButton.disabled = true;
    return;
  }
  const entryId = String(item?.entryId || '').trim();
  const edited = readerEdited || text !== readerOriginalText;
  const sequence = ++voiceReadSequence;
  readerSpeakButton.disabled = true;
  readerSpeakButton.textContent = '合成中…';
  readerNote.textContent = '正在合成这段回复…';
  retryVoiceButton.hidden = true;
  setPlayerControlsEnabled(false);
  releaseReplyAudio();
  readerFallbackNote = '';
  try {
    await setPanelHeight(VOICE_READER_PANEL_HEIGHT);
    if (sequence !== voiceReadSequence || sessionId !== panelSessionId()) return;
    const response = await hana.api.fetch('/voice/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(edited
        ? { sessionId, entryId: '', entryIds: [], text, draft: true }
        : { sessionId, entryId, entryIds: Array.isArray(item?.entryIds) ? item.entryIds : [] }),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '这条回复没合成出来。');
    if (sequence !== voiceReadSequence || sessionId !== panelSessionId()) return;

    const clipResponse = await hana.api.fetch(`/voice/clip/${encodeURIComponent(payload.clipId)}?format=${encodeURIComponent(payload.format || 'mp3')}`);
    if (!clipResponse.ok) throw new Error('语音已经合成，但播放器没取到音频。');
    const blob = await clipResponse.blob();
    if (!blob.size) throw new Error('播放器拿到的是空音频。');
    if (sequence !== voiceReadSequence || sessionId !== panelSessionId()) return;

    voiceAudioUrl = URL.createObjectURL(blob);
    replyAudio.src = voiceAudioUrl;
    replyAudio.volume = currentVolume;
    replyAudio.muted = playerMuted;
    replyAudio.playbackRate = currentPlaybackRate;
    replyAudio.load();
    const spokenText = String(payload.text || text);
    currentReadClip = {
      clipId: String(payload.clipId || ''),
      format: payload.format === 'wav' ? 'wav' : 'mp3',
      text: spokenText,
      voiceId: String(payload.voiceId || ''),
      agentId: String(payload.agentId || ''),
    };
    if (voiceFavoriteButton) voiceFavoriteButton.hidden = !currentReadClip.clipId;
    const markInfo = renderReaderText(spokenText, payload.timings);
    const hasMarks = markInfo.hasMarks;
    const reused = payload.cached === true;
    setPlayerControlsEnabled(true);
    syncVolumeControls();
    setPlaybackRate(currentPlaybackRate);
    updatePlayerProgress();
    readerNote.textContent = hasMarks
      ? '文字会跟着声音逐词点亮。'
      : markInfo.timedRows
        // 不亮的时候把原因写出来：是压根没拿到时间戳，还是拿到了却跟原文对不上。
        ? `这段没能逐词点亮：只对上 ${markInfo.covered}/${markInfo.eligibleCharacters} 字（收到 ${markInfo.timedRows} 条时间戳）。全文照常播放。`
        : '这次语音没有逐字时间戳，全文照常播放。';
    readerFallbackNote = hasMarks ? '' : readerNote.textContent;
    try {
      await replyAudio.play();
      syncPlayerButtonState();
      if (!replyAudio.paused && !replyAudio.ended) {
        readerNote.textContent = reused
          ? '正在播放现成的语音。'
          : hasMarks ? '正在播放；文字会跟着声音逐词点亮。' : '正在播放。';
      } else {
        readerNote.textContent = replyAudio.currentTime > 0 ? '已暂停，可以继续播放或拖动进度。' : '语音已准备好，点播放键开始。';
      }
    } catch {
      syncPlayerButtonState();
      readerNote.textContent = '语音已准备好，点播放键开始。';
    }
  } catch (error) {
    if (sequence !== voiceReadSequence) return;
    readerNote.textContent = String(error?.message || '朗读失败了，再试一次。').slice(0, 200);
    retryVoiceButton.hidden = false;
  } finally {
    readerSpeakButton.textContent = '朗读这篇';
    readerSpeakButton.disabled = !readerCharCount(readerDraftText);
  }
}

// ── 排队发送（面板这一侧）──
// 跟球上那个弹窗是同一套东西：一行一句、每句排 N 轮、能看进度能停。
// 两边共用 App 里的同一份话单，所以这里排的跟球上排的是同一件事。
function renderQueueRounds() {
  if (queueRoundsValue) queueRoundsValue.textContent = String(queueRounds);
  if (queueRoundsDown) queueRoundsDown.disabled = queueRounds <= 1;
  if (queueRoundsUp) queueRoundsUp.disabled = queueRounds >= 50;
}

function stepQueueRounds(delta) {
  const next = Math.max(1, Math.min(50, queueRounds + Number(delta || 0)));
  if (next === queueRounds) return;
  queueRounds = next;
  renderQueueRounds();
}

function setQueueStatus(text, tone = '') {
  if (queueStatus) {
    queueStatus.textContent = String(text || '');
    queueStatus.dataset.tone = tone;
  }
  if (queueStatusRow) queueStatusRow.hidden = !text;
}

/** 把服务端的状态铺到界面上。排队真的在跑才亮「停」。 */
function applyQueueState(state) {
  const active = state?.active === true;
  if (active) {
    setQueueStatus(String(state?.text || '正在排队'));
    if (queueStopButton) queueStopButton.hidden = false;
    return;
  }
  // 没在排：上一次发送的回执（tone=ok）先留着，别让 2 秒后的轮询把它抹了。
  if (queueStatus?.dataset.tone === 'ok') {
    if (queueStopButton) queueStopButton.hidden = true;
    return;
  }
  setQueueStatus('');
  if (queueStopButton) queueStopButton.hidden = true;
}

async function refreshQueueState() {
  const sessionId = panelSessionId();
  if (!sessionId || toolsSubView !== 'queue') return;
  const seq = ++queuePollSeq;
  try {
    const response = await hana.api.fetch(`/queue-plan/state?sessionId=${encodeURIComponent(sessionId)}`);
    const payload = await response.json();
    if (seq !== queuePollSeq || toolsSubView !== 'queue') return;
    if (payload?.ok !== true) return;
    applyQueueState(payload);
  } catch {
    // 轮询失败安静忽略：下一轮再试，不往界面上喷错。
  }
}

function startQueuePolling() {
  stopQueuePolling();
  queuePollTimer = setInterval(() => void refreshQueueState(), 2000);
}

function stopQueuePolling() {
  if (queuePollTimer) {
    clearInterval(queuePollTimer);
    queuePollTimer = null;
  }
  queuePollSeq += 1;
}

async function sendQueuePlan() {
  const sessionId = panelSessionId();
  const text = String(queueInput?.value || '').trim();
  if (!sessionId) {
    setQueueStatus('没认出这是哪段对话。', 'warn');
    return;
  }
  if (!text) {
    setQueueStatus('先写一句要发的话。', 'warn');
    return;
  }
  if (queueBusy) return;
  queueBusy = true;
  if (queueSendButton) queueSendButton.disabled = true;
  try {
    const response = await hana.api.fetch('/queue-plan/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, text, rounds: queueRounds }),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.error || '没排上，再试一次。');
    }
    if (queueInput) queueInput.value = '';
    setQueueStatus(String(payload.message || '排上了。'), 'ok');
    await refreshQueueState();
  } catch (error) {
    setQueueStatus(String(error?.message || '没排上，再试一次。').slice(0, 200), 'warn');
  } finally {
    queueBusy = false;
    if (queueSendButton) queueSendButton.disabled = false;
  }
}

async function stopQueuePlan() {
  const sessionId = panelSessionId();
  if (queueStopButton) queueStopButton.disabled = true;
  try {
    const response = await hana.api.fetch('/queue-plan/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '停不下来。');
    setQueueStatus(payload.stopped === true ? '停了，不再往下发了' : '本来就没在排', 'ok');
    if (queueStopButton) queueStopButton.hidden = true;
  } catch (error) {
    setQueueStatus(String(error?.message || '停不下来，再试一次。').slice(0, 200), 'warn');
  } finally {
    if (queueStopButton) queueStopButton.disabled = false;
  }
}

// 小工具那页的三层：格子（grid）、朗读（voice）、排队发送（queue）。
// 切页签一律回到格子那层；里面各自管自己的退路（返回小工具）。
async function showToolsView(sub = 'grid') {
  const next = sub === 'voice' ? 'voice' : sub === 'queue' ? 'queue' : 'grid';
  toolsSubView = next;
  const inVoice = next === 'voice';
  const inQueue = next === 'queue';
  if (toolsGrid) toolsGrid.hidden = inVoice || inQueue;
  voiceListView.hidden = !inVoice;
  if (queueView) queueView.hidden = !inQueue;
  if (!inVoice) {
    // 离开朗读：朗读器收起来，别把上一段稿子留在那儿。
    voiceReaderView.hidden = true;
    readerNote.textContent = '';
    retryVoiceButton.hidden = true;
  }
  if (!inQueue) stopQueuePolling();
  if (next === 'grid') {
    await setPanelHeight(TOOLS_PANEL_HEIGHT);
    return;
  }
  if (inQueue) {
    renderQueueRounds();
    await setPanelHeight(QUEUE_PANEL_HEIGHT);
    await refreshQueueState();
    startQueuePolling();
    return;
  }
  const reading = !voiceReaderView.hidden;
  await setPanelHeight(reading ? VOICE_READER_PANEL_HEIGHT : VOICE_LIST_PANEL_HEIGHT);
  if (!reading) await loadVoiceReplies({ force: true });
}

async function showPage(page) {
  const key = PANEL_PAGES.some((item) => item.key === page) ? page : 'recommend';
  activePage = key;
  const showTools = key === 'tools';
  const showPolish = key === 'polish';
  editToggle.hidden = key !== 'recommend';
  for (const item of PANEL_PAGES) {
    const on = item.key === key;
    item.tab.classList.toggle('active', on);
    item.tab.setAttribute('aria-selected', String(on));
    item.tab.tabIndex = on ? 0 : -1;
    item.page.hidden = !on;
  }
  if (showTools) {
    await showToolsView('grid');
    return;
  }
  // 离开小工具：轮询停掉、排队层收起来，音频停掉，朗读的稿子也收起来。
  stopQueuePolling();
  if (queueView) queueView.hidden = true;
  if (!replyAudio.paused) replyAudio.pause();
  if (!voiceReaderView.hidden && !replyAudio.src) {
    voiceReadSequence += 1;
    currentReadItem = null;
    voiceReaderView.hidden = true;
    voiceListView.hidden = true;
    readerNote.textContent = '';
    retryVoiceButton.hidden = true;
  }
  toolsSubView = 'grid';
  if (toolsGrid) toolsGrid.hidden = false;
  await setPanelHeight(showPolish ? POLISH_PANEL_HEIGHT : recommendationHeight);
}

recommendTab.addEventListener('click', () => void showPage('recommend'));
toolsTab.addEventListener('click', () => void showPage('tools'));
polishTab.addEventListener('click', () => void showPage('polish'));
// 小工具里的三格：重新命名标题（就地跑）、朗读（进子视图）、排队发送（进子视图）。
openVoiceButton?.addEventListener('click', () => void showToolsView('voice'));
voiceBackButton?.addEventListener('click', () => void showToolsView('grid'));
openQueueButton?.addEventListener('click', () => void showToolsView('queue'));
queueBackButton?.addEventListener('click', () => void showToolsView('grid'));
queueCancelButton?.addEventListener('click', () => void showToolsView('grid'));
queueSendButton?.addEventListener('click', () => void sendQueuePlan());
queueStopButton?.addEventListener('click', () => void stopQueuePlan());
queueRoundsDown?.addEventListener('click', () => stepQueueRounds(-1));
queueRoundsUp?.addEventListener('click', () => stepQueueRounds(1));
refreshVoiceButton.addEventListener('click', () => void loadVoiceReplies({ force: true }));
readerBackButton.addEventListener('click', () => {
  voiceReadSequence += 1;
  currentReadItem = null;
  if (!replyAudio.paused) replyAudio.pause();
  stopHighlightLoop();
  paintReaderMark(-1);
  voiceReaderView.hidden = true;
  voiceListView.hidden = false;
  readerNote.textContent = '';
  retryVoiceButton.hidden = true;
  resetReaderDraft('');
  void setPanelHeight(VOICE_LIST_PANEL_HEIGHT);
});
retryVoiceButton.addEventListener('click', () => {
  if (currentReadItem) void speakCurrent();
});
readerSpeakButton.addEventListener('click', () => {
  void speakCurrent();
});
readerEditButton.addEventListener('click', () => {
  if (readerDraft.hidden) {
    setReaderEditing(true);
    readerNote.textContent = '不想读哪里就删哪里。删完点「保存改稿」。';
    return;
  }
  saveReaderDraft();
});
readerRestoreButton.addEventListener('click', () => {
  restoreReaderOriginal();
});
readerDraft.addEventListener('input', () => {
  paintReaderCount(readerDraft.value);
  readerSpeakButton.disabled = !readerCharCount(readerDraft.value);
});

voiceFavoriteButton?.addEventListener('click', async () => {
  if (!currentReadClip?.clipId) return;
  voiceFavoriteButton.disabled = true;
  try {
    const response = await hana.api.fetch('/voice/favorites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clipId: currentReadClip.clipId,
        text: currentReadClip.text,
        format: currentReadClip.format,
        voiceId: currentReadClip.voiceId,
        agentId: currentReadClip.agentId,
        agentName: currentPartnerName,
      }),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '这段没能收藏。');
    voiceFavoriteButton.textContent = '♥ 已收藏';
    readerNote.textContent = payload.already
      ? '这段刚才收藏过了，设置页「语音收藏」里能听。'
      : '收藏好了，设置页「语音收藏」里能听。';
  } catch (error) {
    readerNote.textContent = String(error?.message || '这段没能收藏。').slice(0, 200);
  } finally {
    voiceFavoriteButton.disabled = false;
  }
});

playerToggle.addEventListener('click', async () => {
  if (!replyAudio.src) return;
  if (!replyAudio.paused) {
    replyAudio.pause();
    syncPlayerButtonState();
    return;
  }
  if (replyAudio.ended) replyAudio.currentTime = 0;
  try {
    await replyAudio.play();
    syncPlayerButtonState();
  } catch {
    syncPlayerButtonState();
    readerNote.textContent = '播放器暂时没能启动，请再点一次播放。';
  }
});
playerProgress.addEventListener('input', () => {
  const duration = Number(replyAudio.duration);
  if (!Number.isFinite(duration) || duration <= 0) return;
  replyAudio.currentTime = duration * (Number(playerProgress.value) / 1000);
  updatePlayerProgress();
  paintReaderMark(activeTimingIndex(activeReaderMarks, replyAudio.currentTime * 1000));
});
volumeToggle.addEventListener('click', () => {
  if (playerMuted) {
    playerMuted = false;
    if (currentVolume === 0) currentVolume = volumeBeforeMute || 1;
  } else {
    if (currentVolume > 0) volumeBeforeMute = currentVolume;
    playerMuted = true;
  }
  syncVolumeControls();
});
volumeRange.addEventListener('input', () => {
  const next = Math.min(1, Math.max(0, Number(volumeRange.value) / 100));
  if (next > 0) {
    currentVolume = next;
    volumeBeforeMute = next;
    playerMuted = false;
  } else {
    if (currentVolume > 0) volumeBeforeMute = currentVolume;
    currentVolume = 0;
    playerMuted = true;
  }
  syncVolumeControls();
});
speedButton.addEventListener('click', () => {
  speedMenu.hidden = !speedMenu.hidden;
  speedButton.setAttribute('aria-expanded', String(!speedMenu.hidden));
});
speedMenu.addEventListener('click', (event) => {
  const option = event.target.closest('.speed-option');
  if (!option) return;
  setPlaybackRate(option.dataset.rate);
  speedMenu.hidden = true;
  speedButton.setAttribute('aria-expanded', 'false');
});
document.addEventListener('click', (event) => {
  if (!speedMenu.hidden && !speedMenu.contains(event.target) && !speedButton.contains(event.target)) {
    speedMenu.hidden = true;
    speedButton.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !speedMenu.hidden) {
    speedMenu.hidden = true;
    speedButton.setAttribute('aria-expanded', 'false');
    speedButton.focus();
  }
});
replyAudio.addEventListener('play', () => {
  syncPlayerButtonState();
  // 没能逐词点亮时，原因要一直留在提示行；否则 play 一响就被「正在播放」盖掉。
  readerNote.textContent = readerFallbackNote
    || (activeReaderMarks.length ? '正在播放；文字会跟着声音逐词点亮。' : '正在播放。');
  if (!highlightFrame) updatePlaybackFrame();
});
replyAudio.addEventListener('pause', () => {
  syncPlayerButtonState();
  stopHighlightLoop();
  updatePlayerProgress();
  paintReaderMark(activeTimingIndex(activeReaderMarks, (Number(replyAudio.currentTime) || 0) * 1000));
  if (voiceAudioUrl && currentReadItem && !playerToggle.disabled && replyAudio.currentTime > 0 && !replyAudio.ended) {
    readerNote.textContent = readerFallbackNote ? `已暂停。${readerFallbackNote}` : '已暂停，可以继续播放或拖动进度。';
  }
});
replyAudio.addEventListener('ended', () => {
  syncPlayerButtonState();
  stopHighlightLoop();
  updatePlayerProgress();
  paintReaderMark(-1);
  readerNote.textContent = '这一段读完了，可以拖动进度重听。';
});
replyAudio.addEventListener('loadedmetadata', updatePlayerProgress);
replyAudio.addEventListener('durationchange', updatePlayerProgress);
replyAudio.addEventListener('timeupdate', () => {
  updatePlayerProgress();
  paintReaderMark(activeTimingIndex(activeReaderMarks, (Number(replyAudio.currentTime) || 0) * 1000));
});
replyAudio.addEventListener('seeking', () => paintReaderMark(activeTimingIndex(activeReaderMarks, (Number(replyAudio.currentTime) || 0) * 1000)));
window.addEventListener('pagehide', () => {
  voiceReadSequence += 1;
  currentReadItem = null;
  releaseReplyAudio();
});


// 宿主主题（浅色/深色）跟着走，别自己写死一套颜色。
function syncTheme() {
  const snapshot = hana.theme?.getSnapshot?.();
  if (snapshot?.appearance === 'light' || snapshot?.appearance === 'dark') {
    document.documentElement.dataset.appearance = snapshot.appearance;
  }
}
syncTheme();

function currentText(editor) {
  return String(editor?.textContent || '').replace(/\s+/g, ' ').trim();
}

async function sendText(text, button) {
  if (!text) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '发送中…';
  try {
    const response = await hana.api.fetch('/suggest-panel/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error('send failed');
    button.textContent = '发好了 ✓';
    button.classList.add('done');
  } catch {
    button.disabled = false;
    button.textContent = original;
  }
}

async function saveQuickReplies(next) {
  quickReplies = next.filter((text) => typeof text === 'string' && text.trim());
  try {
    const response = await hana.api.fetch('/suggest-panel/quick-replies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ list: quickReplies }),
    });
    const payload = await response.json();
    if (response.ok && payload?.ok && Array.isArray(payload.quickReplies)) {
      quickReplies = payload.quickReplies;
    }
  } catch {
    // 存失败就还原本地状态，别让面板显示成已经存好了。
  }
  renderQuick();
}

function renderQuick() {
  const items = Array.isArray(quickReplies) ? quickReplies.filter(Boolean) : [];
  quickList.textContent = '';
  // 「编辑常用」只属于推荐页；没有常用回复时也得能从这里添上第一条。
  editToggle.hidden = activePage !== 'recommend';
  editToggle.textContent = editing ? '完成' : '编辑常用';
  quickSection.hidden = items.length === 0 && !editing;
  quickEditor.hidden = !editing;

  if (!items.length) {
    if (editing) quickEditor.hidden = false;
    return;
  }

  items.forEach((text, index) => {
    if (!editing) {
      const button = document.createElement('button');
      button.className = 'quick-btn';
      button.type = 'button';
      button.textContent = text;
      button.title = text;
      button.addEventListener('click', () => sendText(text, button));
      quickList.append(button);
      return;
    }
    const row = document.createElement('div');
    row.className = 'quick-edit-row';

    const input = document.createElement('input');
    input.className = 'quick-edit-input';
    input.type = 'text';
    input.maxLength = 30;
    input.value = text;
    input.addEventListener('blur', () => {
      const value = input.value.trim();
      if (value === text) return;
      const next = [...quickReplies];
      if (value) next[index] = value; else next.splice(index, 1);
      void saveQuickReplies(next);
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
    });

    const remove = document.createElement('button');
    remove.className = 'quick-remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `删除「${text}」`);
    remove.addEventListener('click', () => {
      const next = [...quickReplies];
      next.splice(index, 1);
      void saveQuickReplies(next);
    });

    row.append(input, remove);
    quickList.append(row);
  });
}

function addQuickReply() {
  const text = String(quickInput?.value || '').trim();
  if (!text) return;
  if (quickReplies.includes(text)) {
    if (quickInput) quickInput.value = '';
    return;
  }
  if (quickInput) quickInput.value = '';
  void saveQuickReplies([...quickReplies, text]);
}

quickAdd?.addEventListener('click', addQuickReply);
quickInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addQuickReply();
  }
});

editToggle?.addEventListener('click', () => {
  editing = !editing;
  renderQuick();
  if (editing && quickInput) quickInput.focus();
});

function renderSuggestions(suggestions) {
  list.textContent = '';
  const items = Array.isArray(suggestions) ? suggestions : [];
  if (!items.length) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  items.forEach((item, index) => {
    const text = typeof item === 'string' ? item : (item?.text || '');
    const direction = typeof item === 'object' ? (item?.direction || '') : '';
    if (!text) return;

    const row = document.createElement('li');
    row.className = 'row';

    // 每句都能直接改：改完点「发这句」，发出去的就是改过的那句。
    const editor = document.createElement('div');
    editor.className = 'text';
    editor.contentEditable = 'plaintext-only';
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-label', '推荐回复，可以直接改');
    editor.textContent = text;

    const actions = document.createElement('div');
    actions.className = 'actions';

    // 方向跟设置页里选的一致，标出来你一眼知道这句是哪一路。
    if (direction) {
      const tag = document.createElement('span');
      tag.className = 'dir';
      tag.textContent = direction;
      actions.append(tag);
    }

    const send = document.createElement('button');
    send.className = 'send';
    send.type = 'button';
    send.textContent = '发这句';
    send.addEventListener('click', () => sendText(currentText(editor), send));

    actions.append(send);
    row.append(editor, actions);
    list.append(row);
  });
}

// ── 理顺（整理润色）──
//
// 功能从传音樱的「把话理顺」搬过来：写下糙话 → 理顺 → 结果可以直接改 → 发进当前对话。
// 后端三条路都是现成的：/polish 理顺、/polish/suggest 给「还能往哪儿改」的候选方向、/send 发送。
// 传音樱那边还要选目标对话（跟随最近活跃 / 固定一段），这里不用：面板就挂在当前会话里。

function setPolishStatus(text, tone = 'plain') {
  if (!polishStatus) return;
  polishStatus.textContent = text || '';
  polishStatus.dataset.tone = tone;
}

function clearPolishSuggestions() {
  if (polishSuggestList) polishSuggestList.replaceChildren();
  if (polishSuggest) polishSuggest.hidden = true;
}

function renderPolishSuggestions(items) {
  if (!polishSuggestList) return;
  polishSuggestList.replaceChildren();
  for (const item of normalizePolishSuggestions(items)) {
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    const prompt = typeof item?.prompt === 'string' ? item.prompt.trim() : '';
    if (!label || !prompt) continue;
    const button = document.createElement('button');
    button.className = 'polish-suggest-btn';
    button.type = 'button';
    button.textContent = label;
    button.title = prompt;
    // 点一个方向 = 拿这个方向去改上一版，不另起一轮。
    button.addEventListener('click', () => {
      if (polishRequire) polishRequire.value = prompt;
      void runPolish();
    });
    polishSuggestList.append(button);
  }
  if (polishSuggest) polishSuggest.hidden = polishSuggestList.childElementCount === 0;
}

async function loadPolishSuggestions(text) {
  try {
    const response = await hana.api.fetch('/polish/suggest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const payload = await response.json();
    renderPolishSuggestions(Array.isArray(payload?.items) ? payload.items : []);
  } catch {
    // 候选方向是加分项：拿不到就算了，不能打断理顺本身。
    clearPolishSuggestions();
  }
}

async function runPolish() {
  if (polishBusy) return;
  const text = String(polishInput?.value || '').trim();
  if (!text) {
    setPolishStatus('先写点什么再理顺嘛。', 'warn');
    return;
  }
  // 框里还是上一版结果，就当「在上一版上改」；自己改过了就当新原话。
  const draft = buildPolishRequest({
    text,
    lastResult: polishLastResult,
    source: polishSource,
    instruction: String(polishRequire?.value || '').trim(),
  });
  const onPrevious = draft.onPrevious;
  polishBusy = true;
  if (polishRunButton) {
    polishRunButton.disabled = true;
    polishRunButton.textContent = onPrevious ? '改这一处…' : '理顺中…';
  }
  setPolishStatus(onPrevious ? '正在改这一处…' : '正在理顺…', 'busy');
  try {
    const response = await hana.api.fetch('/polish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(draft.request),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.error || '这次没理顺成，原话没动。');
    }
    const result = String(payload.text || '').trim();
    if (!result) throw new Error('这次没理顺成，原话没动。');
    if (polishInput) polishInput.value = result;
    polishLastResult = result;
    if (!onPrevious) polishSource = text;
    if (polishQueueButton) polishQueueButton.hidden = false;
    if (polishSendButton) polishSendButton.hidden = false;
    const status = polishStatusText(payload);
    setPolishStatus(status.text, status.tone);
    void loadPolishSuggestions(result);
  } catch (error) {
    setPolishStatus(String(error?.message || '这次没理顺成，原话没动。').slice(0, 200), 'warn');
  } finally {
    polishBusy = false;
    if (polishRunButton) {
      polishRunButton.disabled = false;
      polishRunButton.textContent = '理顺';
    }
  }
}

async function sendPolish(mode, button) {
  const text = String(polishInput?.value || '').trim();
  if (!text) {
    setPolishStatus('先写点什么再理顺嘛。', 'warn');
    return;
  }
  const original = button?.textContent || '';
  if (button) {
    button.disabled = true;
    button.textContent = '发送中…';
  }
  try {
    const response = await hana.api.fetch('/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, mode, sessionId: panelSessionId() }),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.error || '没发出去，再试一次。');
    }
    setPolishStatus(
      mode === 'steer' ? '插进去了，ta 正在看这句。' : '排上了，等 ta 这轮说完就发。',
      'ok',
    );
    if (polishInput) polishInput.value = '';
    if (polishRequire) polishRequire.value = '';
    polishSource = '';
    polishLastResult = '';
    clearPolishSuggestions();
    if (polishQueueButton) polishQueueButton.hidden = true;
    if (polishSendButton) polishSendButton.hidden = true;
  } catch (error) {
    setPolishStatus(String(error?.message || '没发出去，再试一次。').slice(0, 200), 'warn');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

polishRunButton?.addEventListener('click', () => void runPolish());
polishQueueButton?.addEventListener('click', () => void sendPolish('followUp', polishQueueButton));
polishSendButton?.addEventListener('click', () => void sendPolish('steer', polishSendButton));
polishInput?.addEventListener('input', () => {
  // 自己动过输入框：上一版结果就不再是锚点了，下一次理顺重新起头。
  if (polishLastResult && polishInput.value !== polishLastResult) {
    polishLastResult = '';
    polishSource = '';
    clearPolishSuggestions();
    if (polishQueueButton) polishQueueButton.hidden = true;
    if (polishSendButton) polishSendButton.hidden = true;
  }
});

async function load() {
  try {
    const response = await hana.api.fetch('/suggest-panel/state');
    const payload = await response.json();
    quickReplies = Array.isArray(payload?.quickReplies) ? payload.quickReplies : [];
    renderQuick();
    renderSuggestions(payload?.suggestions);
  } catch {
    empty.hidden = false;
  }
}

// 宿主自己那个「关闭面板」在 iframe 外面、背景还是透明的（宿主的容器没背景）。
// 我们自己再给一个「收起」，至少关面板的入口是清楚的一个按钮。
closeButton?.addEventListener('click', async () => {
  closeButton.disabled = true;
  try {
    await hana.api.fetch('/suggest-panel/dismiss', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch {
    closeButton.disabled = false;
  }
});

// 生成是唯一要调模型的一步，所以放在她自己点的按钮后面。
// 后台会连着重试几次（服务商拒一下、下一次就过），最长能等小半分钟。
// 按钮一直写「想一下…」会像卡死，所以隔一会儿换一句话，让她知道还在动。
generateButton.addEventListener('click', async () => {
  generateButton.disabled = true;
  generateButton.textContent = '想一下…';
  genNote.textContent = '';
  const slowTimer = setTimeout(() => { generateButton.textContent = '再等一下…'; }, 12_000);
  const slowerTimer = setTimeout(() => { generateButton.textContent = '还在试…'; }, 26_000);
  try {
    const response = await hana.api.fetch('/suggest-panel/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const payload = await response.json();
    if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || '没拟出来。');
    await load();
    // 走了备用就把话说明白，别让她以为一直在用那条主模型。
    if (payload?.model?.usedFallback) {
      genNote.textContent = `主模型没接住，这几句是备用「${payload.model.name || '备用模型'}」拟的。`;
    }
  } catch (error) {
    genNote.textContent = error?.message || '这次没拟出来，再点一次。';
  } finally {
    clearTimeout(slowTimer);
    clearTimeout(slowerTimer);
    generateButton.disabled = false;
    generateButton.textContent = '生成推荐回复';
  }
});

// 面板被宿主收起或销毁时报一声：输入栏那个 🌸 按钮下次被点才有依据判断该开还是该关。
// 用 keepalive 让请求在页面卸载过程中也能发出去；失败就算了，不骚扰用户。
function reportPanelHidden() {
  const sessionId = panelSessionId();
  if (!sessionId) return;
  try {
    void hana.api.fetch(`/suggest-panel/hidden?sessionId=${encodeURIComponent(sessionId)}`, {
      method: 'POST', keepalive: true,
    }).catch(() => {});
  } catch {}
}
try {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') reportPanelHidden(); });
  window.addEventListener('pagehide', reportPanelHidden);
} catch {}

// 宿主靠 hana.ready() 知道这块板子加载好了：没报就绪就一直显示「App 面板加载失败」。
// 先报就绪再取内容，别让取内容卡住就绪。
async function main() {
  await hana.ready();
  syncPanelContext(hana.inputPanel?.getContext?.());
  hana.inputPanel?.onContextChanged?.(syncPanelContext);
  await load();
}

main();
