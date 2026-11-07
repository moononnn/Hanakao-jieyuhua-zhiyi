// Hana 更新手记页面。
//
// 两件事撑起这个页面：卡片墙（一次拿全，前端分期展开）和常驻输入框（随时追问）。
// 页面不给任何「正在生成」的假进度：读的时候说在读哪版，读完了说读到几条，失败就说没读出来。
// 卡片上的每个字都能追回官方原文，点开就看见出处。

import { hana } from './sdk.js';

const $ = (id) => document.getElementById(id);
const WALL_TIMEOUT = 120000;
const ASK_TIMEOUT = 90000;
const VISIBLE_ROWS = 8;

const state = { data: null, tags: [], current: null, history: [], showAll: false, chat: false, ovAll: false };
// 已经打过招呼的卡片：同一条不重复开场白。
const greeted = new Set();

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function request(path, body, timeoutMs) {
  await hana.ready();
  const controller = new AbortController();
  let timer;
  try {
    const options = body === undefined
      ? { method: 'GET', signal: controller.signal }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal };
    const work = (async () => {
      const response = await hana.api.fetch(path, options);
      let payload;
      try {
        // 后台用流式回包：开头可能有空白心跳，JSON.parse 会跳过前导空白。
        payload = await response.json();
      } catch {
        throw new Error('返回内容读不出来，稍后再试。');
      }
      if (!response.ok || payload?.ok !== true) {
        throw new Error(typeof payload?.error === 'string' && payload.error ? payload.error : '这次没读出来，稍后再试。');
      }
      return payload;
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('等太久了，没等到结果。再试一次。'));
      }, timeoutMs);
    });
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function setStatus(text, { busy = false, error = false } = {}) {
  const bar = $('hb-status');
  $('hb-status-text').textContent = text;
  bar.hidden = !text;
  bar.classList.toggle('is-busy', busy);
  bar.classList.toggle('is-error', error);
  $('hb-rebuild').hidden = !error;
}

function tagOf(card, index) {
  if (card.hurt) return { text: '以前可能烦过你', hurt: true };
  if (index === 0) return { text: '最值得开', hurt: false };
  if (index === 1) return { text: '每天都碰到', hurt: false };
  return { text: card.topic || '其他', hurt: false };
}

function detailHtml(card) {
  const sources = Array.isArray(card.sources) ? card.sources : [];
  const merged = Array.isArray(card.mergedFrom) && card.mergedFrom.length
    ? `<span class="hb-merged">后来又扩过一次（${esc(card.mergedFrom.join('、'))}）</span>`
    : '';
  return `<div class="hb-body-in">
    ${card.why ? `<p class="hb-why">${esc(card.why)}</p>` : ''}
    ${sources.map((row) => `<p class="hb-orig"><b>原文 · ${esc(row.section || '')}</b>${esc(row.title)}${row.detail ? `：${esc(row.detail)}` : ''}</p>`).join('')}
    <div class="hb-actions">
      <button class="hb-ask" type="button" data-ask="${esc(card.id)}">接着问这条</button>
      <span class="hb-where">在 ${esc(card.where)}</span>
      ${merged}
    </div>
  </div>`;
}

function leadHtml(card, index) {
  const tag = tagOf(card, index);
  return `<button class="hb-lead" type="button" data-card="${esc(card.id)}">
    <span class="hb-lead-k"><span class="hb-tag${tag.hurt ? ' hurt' : ''}">${esc(tag.text)}</span></span>
    <h3 class="hb-wk">${esc(card.title)}</h3>
    <p>${esc(card.now || card.why || '')}</p>
    <span class="hb-go">展开看原文 →</span>
  </button>`;
}

function rowHtml(card) {
  const hurt = card.hurt ? '<span class="hurt">以前可能烦过你</span>' : '';
  const swap = [card.before ? `<i>以前</i>${esc(card.before)}` : '', card.now ? `<i class="arrow">→</i><i>现在</i>${esc(card.now)}` : ''].join('');
  return `<div class="hb-row" data-card="${esc(card.id)}">
    <div class="hb-row-h" role="button" tabindex="0">
      <div class="hb-row-t">
        <h3>${esc(card.title)}</h3>
        ${swap ? `<p class="hb-swap">${swap}</p>` : ''}
      </div>
      <div class="hb-row-v">${hurt}${esc(card.version || '')}</div>
    </div>
    <div class="hb-row-body">${detailHtml(card)}</div>
  </div>`;
}

function renderVersionLine(data, overview) {
  const box = $('hb-ver');
  if (!overview) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const note = data.upToDate
    ? '你装的就是这一版'
    : data.installed
      ? `你装的是 ${data.installed}，这一版还没装上`
      : '你装的是哪版没读到';
  box.innerHTML = `<span class="hb-ver-tag">${esc(overview.version)}</span><span class="hb-ver-note">${esc(note)}</span>`;
  box.hidden = false;
}

/**
 * 最新一版的速览：还是卡片，不是原文长文。
 * 三张头条先摆着，其余的收在「还有 N 张」后面，点开才铺开。
 */
function renderOverview(overview) {
  const box = $('hb-overview');
  const cards = Array.isArray(overview?.cards) ? overview.cards : [];
  if (!cards.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const rest = cards.slice(3);
  const expanded = state.ovAll;
  const rows = expanded ? rest.map(rowHtml).join('') : '';
  const more = rest.length
    ? `<div class="hb-more"><button type="button" id="hb-ov-more-btn"${expanded ? ' disabled' : ''}>${expanded ? '已经全展开了' : `这一版还有 ${rest.length} 张，展开`}</button><span>${expanded ? `共 ${cards.length} 张` : `已展开 ${Math.min(3, cards.length)}/${cards.length}`}</span></div>`
    : '';
  box.innerHTML = `<header class="hb-ov-head"><h2>${esc(overview.version)} 这一版更新了啥</h2><span class="n">${cards.length} 张卡</span></header>
    <div class="hb-ov-cards" id="hb-ov-cards">${cards.slice(0, 3).map((card, index) => leadHtml(card, index)).join('')}</div>
    <div class="hb-ov-rest" id="hb-ov-rest">${rows}</div>
    ${more}`;
  box.hidden = false;
  const moreBtn = $('hb-ov-more-btn');
  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      state.ovAll = true;
      renderOverview(state.data?.overview);
    });
  }
}

function render() {
  const data = state.data;
  const lede = $('hb-lede');
  // 头条展开块是挂在 top3 后面的，重渲染前先收掉，否则会留在页面上指向旧卡。
  const staleOpen = $('hb-lead-open');
  if (staleOpen) staleOpen.remove();

  // 本版速览有卡片就算有东西看：墙空了（已是最新）也不该摆空态。
  const hasOverview = Boolean(data?.overview?.cards?.length);
  const hasWall = Boolean(data && (data.wall.highlights.length || data.wall.rest.length));
  if (!data || (!hasWall && !hasOverview)) {
    $('hb-top3').hidden = true;
    $('hb-groups').hidden = true;
    $('hb-wall-h').hidden = true;
    $('hb-empty').hidden = false;
    renderVersionLine(data || {}, data?.overview);
    renderOverview(data?.overview);
    const failed = data?.versions?.find((row) => row.error);
    $('hb-empty').innerHTML = failed
      ? `<b>这版没读出来</b>${esc(failed.error)}<br>确认网络通了、内容模型也选好了，点上面的「再试一次」。`
      : '<b>暂时没有可看的更新</b>你装的可能已经是最新的，或者这次没读到说明。';
    lede.textContent = data?.installed ? `你装的是 ${data.installed}。` : '';
    return;
  }

  if (data.baseline) {
    lede.innerHTML = data.upToDate
      ? `你装的是 <b>${esc(data.installed || data.baseline.version)}</b>，已经是最新的。<em>下面是这一版你能摸到的东西。</em>`
      : `你上次看是 <b>${esc(data.baseline.version)}</b>，跨了 <b>${data.newerCount} 个版本</b>，挑出 <b>${data.totalCards} 条</b>你摸得到的。<em>其余是内部修整和兼容处理。</em>`;
  } else if (data.upToDate) {
    lede.innerHTML = `已经是最新的。<em>下面是这一版你能摸到的东西。</em>`;
  } else {
    lede.innerHTML = `不知道你上次看的是哪版，先把最近 <b>${data.versions.length} 个版本</b>讲一遍，挑出 <b>${data.totalCards} 条</b>你摸得到的。`;
  }

  $('hb-empty').hidden = true;
  renderVersionLine(data, data.overview);
  renderOverview(data.overview);

  const highlights = data.wall.highlights.slice(0, 3);
  $('hb-top3').innerHTML = highlights.map(leadHtml).join('');
  $('hb-top3').hidden = highlights.length === 0;
  $('hb-wall-h').hidden = !(highlights.length || data.wall.rest.length);

  // 清单：头条之外的部分按主题分组，顺序跟常量一致，没人看的话题自然消失。
  const order = ['聊天与对话', '卡片与市场', 'Code 与工具', '界面与手感', '其他'];
  const rest = data.wall.rest.slice();
  const groups = order
    .map((topic) => ({ topic, rows: rest.filter((card) => (card.topic || '其他') === topic) }))
    .filter((group) => group.rows.length);

  const hiddenCount = state.showAll ? 0 : Math.max(0, rest.length - VISIBLE_ROWS);
  let seen = 0;
  $('hb-groups').innerHTML = groups.map((group) => {
    const rows = group.rows.map((card) => {
      const index = seen;
      seen += 1;
      const hide = !state.showAll && index >= VISIBLE_ROWS;
      return hide ? rowHtml(card).replace('<div class="hb-row"', '<div class="hb-row" hidden') : rowHtml(card);
    }).join('');
    return `<section class="hb-group">
      <div class="hb-group-h"><span class="dot"></span><h2>${esc(group.topic)}</h2><span class="n">${group.rows.length} 条</span></div>
      ${rows}
    </section>`;
  }).join('');

  $('hb-groups').hidden = rest.length === 0;

  const more = hiddenCount > 0
    ? `<div class="hb-more"><button type="button" id="hb-more-btn">还有 ${hiddenCount} 张，展开</button><span>已展开 ${Math.min(VISIBLE_ROWS, rest.length)}/${rest.length}</span></div>`
    : rest.length > VISIBLE_ROWS
      ? `<div class="hb-more"><button type="button" disabled>已经全展开了</button><span>共 ${rest.length} 条</span></div>`
      : '';
  $('hb-groups').insertAdjacentHTML('beforeend', more);

  const moreBtn = $('hb-more-btn');
  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      state.showAll = true;
      render();
    });
  }

  const failed = data.versions.filter((row) => row.error);
  setStatus(failed.length ? `${failed.length} 个版本没读出来：${failed.map((row) => row.version).join('、')}` : '', { error: failed.length > 0 });
}

function findCard(id) {
  if (!state.data) return null;
  const all = [...(state.data.overview?.cards || []), ...state.data.wall.highlights, ...state.data.wall.rest];
  return all.find((card) => card.id === id) || null;
}

function cite(card) {
  state.current = card || null;
  const ref = $('hb-ref');
  if (!card) {
    ref.classList.remove('on');
    return;
  }
  $('hb-reftxt').textContent = card.title;
  ref.classList.add('on');
}

function onLeadClick(event) {
  const lead = event.target.closest('.hb-lead');
  if (!lead) return;
  const card = findCard(lead.dataset.card);
  if (!card) return;
  const host = $('hb-lead-open');
  // 一次点击可能被两个监听器都接到（容器换过、脚本装过两遍）。
  // 只认「上一次点开的」才算收起，否则点一下等于开了又关，看上去就是没反应。
  const sameEvent = host && host.dataset.stamp === String(event.timeStamp);
  const already = host && !sameEvent && host.dataset.card === card.id && !host.hidden;
  if (host && !sameEvent) host.remove();
  if (already) return;
  const box = document.createElement('div');
  box.id = 'hb-lead-open';
  box.dataset.card = card.id;
  box.dataset.stamp = String(event.timeStamp);
  box.style.marginTop = '12px';
  box.innerHTML = `<div class="hb-lead-open"><div class="hb-row open" style="border:0;border-radius:0;background:transparent">${detailHtml(card)}</div></div>`;
  // 展开块跟着它那张卡走：本版速览里的卡就展开在本版速览下面。
  const container = lead.closest('.hb-ov-cards') || $('hb-top3');
  container.parentElement.insertAdjacentElement('afterend', box);
  cite(card);
  // 展开在下面，别让人以为没反应：把它滚到眼前。
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function onRowClick(event) {
  const ask = event.target.closest('.hb-ask');
  if (ask) {
    const card = findCard(ask.dataset.ask);
    cite(card);
    openChat(card);
    // 等翻页那口气过去再落光标，不然光标会在看不见的地方闪。
    window.setTimeout(() => $('hb-ta').focus(), TURN_MS + 40);
    return;
  }
  const head = event.target.closest('.hb-row-h');
  if (!head) return;
  const row = head.closest('.hb-row');
  const open = row.classList.toggle('open');
  document.querySelectorAll('.hb-row.open').forEach((other) => {
    if (other !== row) other.classList.remove('open');
  });
  cite(open ? findCard(row.dataset.card) : null);
}

// 知意那一侧的每条消息：名头（头像 + 名字） + 正文，跟应用雷达的对话窗一个样。
function assistantMessage(text) {
  const wrap = document.createElement('div');
  wrap.className = 'hb-msg';
  const name = document.createElement('div');
  name.className = 'hb-name';
  const avatar = document.createElement('img');
  avatar.className = 'hb-avatar';
  avatar.setAttribute('src', 'assets/market-avatar.png');
  avatar.setAttribute('alt', '');
  avatar.setAttribute('width', '20');
  avatar.setAttribute('height', '20');
  const label = document.createElement('span');
  label.textContent = '知意';
  name.append(avatar, label);
  const body = document.createElement('div');
  body.className = 'hb-bub sys';
  body.textContent = text;
  wrap.append(name, body);
  return wrap;
}

// 等模型的三点动画，跟应用雷达同一套：名头与三点并在一排，只动不写字。
// 旁逸再挂一行说明字是同一件事说两道，而且字一出现，卡就又被撞宽了。
function showTyping() {
  removeTyping();
  const wrap = document.createElement('div');
  wrap.className = 'hb-msg is-typing';
  wrap.id = 'hb-typing';
  const name = document.createElement('div');
  name.className = 'hb-name';
  const avatar = document.createElement('img');
  avatar.className = 'hb-avatar';
  avatar.setAttribute('src', 'assets/market-avatar.png');
  avatar.setAttribute('alt', '');
  avatar.setAttribute('width', '20');
  avatar.setAttribute('height', '20');
  const label = document.createElement('span');
  label.textContent = '知意';
  name.append(avatar, label);
  const row = document.createElement('div');
  row.className = 'hb-typing-row';
  const dots = document.createElement('span');
  dots.className = 'hb-typing-dots';
  dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
  row.append(dots);
  wrap.append(name, row);
  $('hb-thread').appendChild(wrap);
  scrollToThread();
}

function removeTyping() {
  const node = $('hb-typing');
  if (node) node.remove();
}

function pushBubble(kind, text) {
  if (kind === 'sys') {
    $('hb-thread').appendChild(assistantMessage(text));
    scrollToThread();
    return null;
  }
  const bubble = document.createElement('div');
  bubble.className = `hb-bub ${kind}`;
  bubble.textContent = text;
  $('hb-thread').appendChild(bubble);
  scrollToThread();
  return bubble;
}

// 翻页：先把整页淡出下沉，换完内容再淡回来。
// 清单退场和对话进场之间没有硬切，只有一口气。
const TURN_MS = 190;
function turnPage(swap) {
  const page = document.querySelector('.hb-page');
  if (!page) {
    swap();
    return;
  }
  page.classList.add('is-turning');
  window.setTimeout(() => {
    swap();
    page.classList.remove('is-turning');
  }, TURN_MS);
}

// 追问模式：清单整块退场，换成一条干净的对话流。
// 像翻到另一页，而不是把气泡挤在清单底下浮着。
function openChat(card, afterTurn) {
  const chat = $('hb-chat');
  const apply = () => {
    $('view-handbook').classList.add('is-chat');
    chat.hidden = false;
    if (card) cite(card);
    $('hb-chat-t').textContent = card ? `追问：${card.title}` : '追问答疑';
    // 开场白：点开哪条，就先把这条讲清楚，别丢一个空窗口给人家。
    if (card && !greeted.has(card.id)) {
      greeted.add(card.id);
      const intro = cardIntro(card);
      if (intro) pushBubble('sys', intro);
    }
    scrollToThread();
    if (typeof afterTurn === 'function') afterTurn();
  };
  if (state.chat) {
    apply();
    return;
  }
  state.chat = true;
  turnPage(apply);
}

/** 点开一张卡时知意的开场白：用卡片自己的话讲，不另调模型。 */
function cardIntro(card) {
  const body = [card.now, card.why].filter(Boolean).join("，");
  const parts = [];
  if (card.title) parts.push(`这条是「${card.title}」。`);
  if (body) parts.push(/[。！!？?]$/.test(body) ? body : `${body}。`);
  if (card.where) parts.push(`在${card.where}就能碰到。`);
  parts.push("想细问哪一点，直接说哈。");
  return parts.join("\n");
}

function closeChat() {
  if (!state.chat) return;
  state.chat = false;
  turnPage(() => {
    $('view-handbook').classList.remove('is-chat');
    $('hb-chat').hidden = true;
    $('hb-ta').blur();
  });
}

// 对话流在页面里正常排版，滚到底就是最新一条。
function scrollToThread() {
  const scroller = document.querySelector('.workspace');
  if (!scroller) return;
  try {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
  } catch {
    scroller.scrollTop = scroller.scrollHeight;
  }
}

async function ask() {
  const ta = $('hb-ta');
  const question = ta.value.trim();
  if (!question) return;
  const card = state.current;
  const text = card ? `（问「${card.title}」）${question}` : question;
  ta.value = '';
  ta.style.height = '38px';
  state.history.push({ role: 'user', content: question });
  $('hb-send').disabled = true;
  setStatus('正在翻原文…', { busy: true });
  const send = async () => {
    pushBubble('me', text);
    showTyping();
    try {
      const payload = await request('/handbook/ask', {
        question,
        card,
        tags: state.tags,
        history: state.history.slice(-8),
      }, ASK_TIMEOUT);
      removeTyping();
      pushBubble('sys', payload.content);
      state.history.push({ role: 'assistant', content: payload.content });
      setStatus('');
    } catch (error) {
      removeTyping();
      pushBubble('sys', error?.message || '这次没答上来，再问一次。');
      setStatus('');
    } finally {
      $('hb-send').disabled = false;
    }
  };
  // 第一次发送就是「翻页」：先把开场白摆上，再上你的话，顺序不能反。
  if (!state.chat) {
    openChat(card, () => { void send(); });
    return;
  }
  await send();
}

async function loadWall({ rebuild = false } = {}) {
  setStatus(rebuild ? '正在重新挑这一版的卡片…' : '正在读 Hana 的更新说明…', { busy: true });
  $('hb-rebuild').hidden = true;
  try {
    const data = await request(`/handbook/wall${rebuild ? '?rebuild=1' : ''}`, undefined, WALL_TIMEOUT);
    state.data = data;
    state.tags = data.versions.map((row) => row.tag);
    state.showAll = false;
    state.ovAll = false;
    render();
    if (data.upToDate) setStatus(data.installed ? `你装的 ${data.installed} 已经是最新的。` : '已经是最新的。');
    else if (data.totalCards) setStatus(`读到 ${data.versions.filter((row) => row.cardCount > 0).length} 个版本，挑出 ${data.totalCards} 条。`);
  } catch (error) {
    state.data = null;
    render();
    setStatus(error?.message || '这次没读出来，稍后再试。', { error: true });
  }
}

function bind() {
  // 事件委托：卡片装在哪个容器里都算。
  // 展开块是插到容器外面去的（「接着问这条」按钮就在里面），所以监听必须挂在整页上，
  // 否则展开块里的按钮点了没反应。
  $('hb-page').addEventListener('click', onLeadClick);
  $('hb-page').addEventListener('click', onRowClick);
  $('hb-groups').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if (!event.target.closest('.hb-row-h')) return;
    event.preventDefault();
    onRowClick(event);
  });
  $('hb-refx').addEventListener('click', () => cite(null));
  $('hb-chat-back').addEventListener('click', () => closeChat());
  $('hb-send').addEventListener('click', ask);
  $('hb-rebuild').addEventListener('click', () => loadWall({ rebuild: true }));
  $('hb-ta').addEventListener('input', function onInput() {
    this.style.height = 'auto';
    this.style.height = `${Math.min(this.scrollHeight, 120)}px`;
  });
  $('hb-ta').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void ask();
    }
  });
}

// 首次切到这个视图才去读，不在知意一打开时就打 GitHub 和模型：
// 用户可能一辈子不点这一页，没必要为它付一次调用。
let started = false;
const section = $('view-handbook');
async function activate() {
  if (started) return;
  started = true;
  await loadWall();
}

window.addEventListener('zhiyi:view-change', (event) => {
  if (event.detail?.view === 'handbook') void activate();
});

bind();
if (section && section.classList.contains('on')) void activate();
