import { hana } from './sdk.js';
import { followHostTheme } from './theme-report.js';

// 深浅跟着宿主走：既换上 data-appearance，也把宿主主题的样式表挂进来，
// 让面板底色真的跟着 Hana 的深浅主题走。
followHostTheme();

const byId = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'market-refresh', 'catalog-status', 'catalog-meta', 'catalog-warnings', 'market-list',
  'market-search', 'page-prev', 'page-next', 'page-label', 'market-detail', 'detail-scroll', 'detail-name',
  'detail-description', 'detail-facts', 'detail-close', 'inspection-state', 'inspection-facts',
  'inspection-files', 'inspection-scope', 'inspection-warnings', 'market-messages',
  'conversation-empty', 'detail-status', 'market-inspect', 'session-retry', 'market-chat',
  'market-question', 'market-send', 'chat-hint', 'detail-context', 'market-workspace',
  'market-home', 'market-quick', 'detail-clear', 'pending-notice',
].map((id) => [id, byId(id)]));
const filters = ['installed', 'market', 'pending', 'all'];
const PAGE_SIZE = 24;
const SOURCE_LABEL = { market: '已上架', pending: '待上架', installed: '已安装' };
// 这个按钮做什么用，说清楚：记录只存在本机，读回不调模型也不产生用量。
const READ_BACK_NOTE = '记录只存在本机：刷新页面或换窗口后，点「读回记录」把之前的问答接回来，不调用模型、不产生用量。';
const UPDATE_LABEL = {
  unknown: '更新状态未知', newer: '目录有较新版本', current: '与目录版本一致', different: '与目录版本不同',
};
const ICON_MIME = /^data:image\/(?:png|jpeg|jpg|webp|gif|svg\+xml);base64,/i;
const ICON_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ICON_MAX_CHARS = 1024 * 1024;
const SVG_UNSAFE = /<script|<foreignObject|on[a-z]+\s*=|xlink:href|\bhref\s*=\s*["']?https?:/i;
const UNKNOWN_VERSION = '版本未知';
const EMPTY_TEXT = {
  installed: '你装了、市场里也有来源的应用会出现在这里；有新版在审核的会直接标出来。',
  market: '目录里还没有已上架的应用。',
  pending: '这里只列还没上架过的新应用。已上架应用的新版本不在这里重复，去「已上架」看，卡片上会标出待审版号。',
  all: '这里还没有应用。换个分类或关键词看看。',
};
const state = {
  items: [], source: 'installed', page: 1, catalogLoading: false, catalogLoaded: false, pendingLoaded: false,
  selected: null, session: null, sessionLoaded: false, sessionLoading: false,
  view: 0, request: 0, mutation: null, opener: null, drafts: new Map(), busy: false, installedStatus: undefined,
  pendingLoading: false, catalogMeta: '', inspectFailed: false, pendingChat: null, inspectArmed: false, inspectTimer: null,
};

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  if (className) element.className = className;
  return element;
}
function status(id, text, error = false) {
  ui[id].textContent = text;
  ui[id].dataset.error = String(error);
}
function warnings(id, values) {
  ui[id].replaceChildren(...values.map((text) => node('li', text)));
  ui[id].hidden = values.length === 0;
}
function fact(target, label, value) {
  target.append(node('dt', label), node('dd', value));
}
// 名头：自己说的话不加标签，一屏全写「你」只是多一行噪音；知意那边带一张小头像，
// 比一行字更像在跟人说话。其他 role 继续用文字标注，不冒充对话双方。
function nameRow(label, withAvatar = false) {
  const row = node('div', undefined, 'market-name');
  if (withAvatar) {
    // 头像跟 cover.png、brand-mark.svg 放在一起（ui/assets），alt 留空，不让读屏重复念一回名字。
    const avatar = node('img', undefined, 'market-avatar');
    avatar.setAttribute('src', 'assets/market-avatar.png');
    avatar.setAttribute('alt', '');
    avatar.setAttribute('width', '20');
    avatar.setAttribute('height', '20');
    row.append(avatar);
  }
  row.append(node('span', label, 'market-name-text'));
  return row;
}
function modelName(model) {
  if (typeof model === 'string' && model) return model;
  if (model && typeof model === 'object') {
    return model.name || model.model || model.id || '未返回模型名称';
  }
  return '未返回模型名称';
}
function formatTime(value) {
  if (!value) return '未返回时间';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}
// The installed list is a local inventory: an entry counts as installed when the backend says so,
// even when no version string is available. Missing version never means "not installed".
function isInstalled(item) {
  if (!item) return false;
  if (item.source === 'installed') return true;
  if (typeof item.installed === 'boolean') return item.installed;
  return typeof item.installedVersion === 'string' && item.installedVersion.trim() !== '';
}
function isReviewable(item) {
  if (!item) return false;
  if (item.reviewable === false) return false;
  if (item.source === 'installed') return false;
  return !(typeof item.key === 'string' && item.key.startsWith('installed:'));
}
function installedVersionOf(item) {
  if (!isInstalled(item)) return '';
  const value = item.installedVersion;
  return typeof value === 'string' && value && value !== UNKNOWN_VERSION ? value : '';
}
function needsPending(source) {
  // 每个分类都可能要用待审版本：「已安装」靠它把行换成新版，「已上架」靠它并排显示两个版本号。
  return source === 'installed' || source === 'market' || source === 'pending' || source === 'all';
}
function matchesSource(item, source, listedIds = null) {
  if (source === 'all') return true;
  if (source === 'installed') {
    // 已装的应用里只留市场有公开来源的：已上架的、以及正在走审核的。
    // 待审新版正是这个雷达要回答的事；市场完全没收录的本机应用进不来，它们没法审查也谈不上升级。
    return (item.source === 'market' || item.source === 'pending') && isInstalled(item);
  }
  // 已上架应用的新版本不在待上架栏重复占位：那一版在「已上架」栏里已经用「待审 vX」标出来了。
  // 待上架栏只留真正还没上架过的新应用。目录里版本号缺失时靠 id 也算一份，不能因为没号就冒出来。
  if (source === 'pending') {
    if (item.source !== 'pending') return false;
    if (listedIds?.has(item.id)) return false;
    return !item.listedVersion;
  }
  return item.source === source;
}
// 一个应用只占一行：有待审版本就先给你看待审的那个，没有才退回已上架版本。
function mergeInstalled(items) {
  const byId = new Map();
  for (const item of items) {
    const seen = byId.get(item.id);
    if (!seen || (seen.source === 'market' && item.source === 'pending')) byId.set(item.id, item);
  }
  return [...byId.values()];
}
// Icons arrive as data URIs only: raster images plus script-free SVG, strict base64, size capped.
// No remote URL is ever rendered, so the page never issues a new network request for an icon.
function svgPayloadSafe(payload) {
  if (typeof atob !== 'function') return false;
  let text = '';
  try { text = atob(payload); } catch { return false; }
  return Boolean(text) && !SVG_UNSAFE.test(text);
}
function safeIconSrc(value) {
  if (typeof value !== 'string' || !value) return '';
  const head = value.match(ICON_MIME);
  if (!head) return '';
  const payload = value.slice(head[0].length);
  if (!payload || payload.length % 4 !== 0 || !ICON_BASE64.test(payload)) return '';
  if (payload.length > ICON_MAX_CHARS) return '';
  if (/svg\+xml/i.test(head[0]) && !svgPayloadSafe(payload)) return '';
  return value;
}
function glyphFor(name) {
  const text = String(name || '').trim();
  if (!text) return '·';
  return [...text][0].toUpperCase();
}
// 图标分级加载的本地两本账：iconMemory 存已经拿到的图（切栏来回不再要），
// iconRequested 防止同一张图反复发请求。上架应用的图都在目录里，这两本账只管待审。
const iconMemory = new Map();
const iconRequested = new Set();
function paintIcon(box, item) {
  box.replaceChildren(node('span', glyphFor(item.name), 'item-icon-glyph'));
  const src = safeIconSrc(item.icon);
  if (!src) return;
  const img = document.createElement('img');
  img.setAttribute('class', 'item-icon-img');
  img.setAttribute('alt', '');
  // data 图不走网络，不需要懒加载；懒加载 + 隐藏容器会让浏览器直接不加载。
  // 不拿 load 事件当显示开关：有点宿主不派发 load，那样图就永远不出来了。
  // 先直接放上去，真解码失败才收起来退回字形。
  img.addEventListener('error', () => img.setAttribute('hidden', ''));
  img.setAttribute('src', src);
  box.append(img);
}
function iconNode(item) {
  const box = node('span', undefined, 'item-icon');
  box.setAttribute('aria-hidden', 'true');
  paintIcon(box, item);
  return box;
}
function versionText(item) {
  if (item.version) return item.version;
  if (item.installedVersion && item.installedVersion !== UNKNOWN_VERSION) return item.installedVersion;
  return UNKNOWN_VERSION;
}
function shortVersion(value) {
  // 版本号里 + 后面是构建元数据（v1.2.1+dsh-0.2.1-rc.2）。列表卡片只留主版本，
  // 否则两个长版本号会在同一行平分宽度，双双被省略号吃掉——待审标记就这样消失过。
  const text = typeof value === 'string' ? value : '';
  return text.split('+')[0];
}
function cardMeta(item) {
  if (item.source === 'pending') {
    return item.version ? `待审 v${shortVersion(item.version)}` : '待审 · 版本未提供';
  }
  const label = SOURCE_LABEL[item.source] || '已上架';
  const version = item.version ? shortVersion(item.version) : (item.source === 'installed' ? versionText(item) : '');
  if (version) return `${label} · v${version}`;
  return `${label} · ${item.source === 'installed' ? UNKNOWN_VERSION : '版本未提供'}`;
}
function cardUpdate(item, hasPending = false) {
  if (item.source === 'installed') return '暂无公开来源';
  const installed = installedVersionOf(item);
  if (item.source === 'pending') {
    // “待审”已经在上一行说清楚了，这一行只当本机版本的对照，不再抢重点。
    if (installed) return `本机 ${installed}`;
    if (item.installedVersion === UNKNOWN_VERSION) return `本机${UNKNOWN_VERSION}`;
    return item.installed === false ? '未安装' : '';
  }
  // 已上架但审核里有新版时，第二行已经摆了两个版本号，这里只留本机版本。
  if (hasPending) return installed ? `本机 ${installed}` : '';
  if (isInstalled(item)) {
    const label = UPDATE_LABEL[item.updateStatus] || UPDATE_LABEL.unknown;
    return item.installedVersion === UNKNOWN_VERSION ? `${UNKNOWN_VERSION} · ${label}` : `本机 ${item.installedVersion} · ${label}`;
  }
  if (state.installedStatus === 'available') return '未安装';
  if (state.installedStatus === 'unavailable') return '安装状态不可用';
  return '';
}
function installedLabel(item) {
  // Installation availability and version comparisons are independent of official listing status.
  if (item.source === 'installed') return `已安装 ${versionText(item)}`;
  if (state.installedStatus !== 'available') return '安装状态不可用，无法判断本机版本';
  if (item.installedVersion === null) return '未安装';
  if (typeof item.installedVersion !== 'string' || !item.installedVersion) return '本机版本未返回，无法判断更新';
  if (item.installedVersion === UNKNOWN_VERSION) return `${UNKNOWN_VERSION} · ${UPDATE_LABEL[item.updateStatus] || UPDATE_LABEL.unknown}`;
  return `本机 ${item.installedVersion} · ${UPDATE_LABEL[item.updateStatus] || UPDATE_LABEL.unknown}`;
}
async function request(path, body) {
  const controller = new AbortController();
  let timer;
  const work = async () => {
    await hana.ready();
    const options = body === undefined ? { method: 'GET', signal: controller.signal } : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
    };
    const response = await hana.api.fetch(path, options);
    let payload;
    try { payload = await response.json(); } catch { throw new Error('返回内容无法读取，请稍后重试。'); }
    if (!response.ok || payload?.ok !== true) {
      throw new Error(typeof payload?.error === 'string' ? payload.error : '请求失败，请稍后重试。');
    }
    return payload;
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(body === undefined ? '读取超时，请重新读取；若仍失败，请反馈此提示。' : '回答等待超时，请先「读回记录」核实，勿重复发送。'));
        controller.abort();
      }, body === undefined ? (path.includes('includePending=1') ? 90000 : 60000) : 240000);
    })]);
  } finally { clearTimeout(timer); }
}
function validSession(payload, key) {
  const session = payload.session;
  if (session === null) return null;
  if (!session || session.key !== key || !Array.isArray(session.messages)
    || session.messages.some((m) => !m || typeof m.role !== 'string' || typeof m.content !== 'string')) {
    throw new Error('检查记录与当前应用不匹配或格式不完整，请「读回记录」。');
  }
  const s = session.snapshot;
  if (s !== null && (!s || typeof s.commit !== 'string' || typeof s.repo !== 'string'
    || !Array.isArray(s.files) || s.files.some((f) => !f || typeof f.path !== 'string' || !Number.isFinite(f.chars) || f.chars < 0)
    || !Array.isArray(s.warnings) || s.warnings.some((w) => typeof w !== 'string'))) {
    throw new Error('源码快照格式不完整，未确认检查结果。');
  }
  return session;
}
function canChat() {
  const s = state.session;
  return state.sessionLoaded && !state.sessionLoading && !state.mutation
    && (s === null || (s?.snapshot?.files.length > 0 && Boolean(s.snapshot.commit) && s.stale !== true));
}

/* ── 回答排版 ──
   模型给的是 markdown。以前原样塞进 pre-wrap，标题井号、分隔线、星号全露在外面，
   一屏全是符号。这里按块解析成真实元素：标题压到 h4/h5、列表、代码、引用、分隔线。
   全部走 textContent / createTextNode，第三方文本永远不进 HTML 解析。 */
const HEADING = /^(#{1,6})\s+(.+)$/;
const BULLET = /^[-*+]\s+(.+)$/;
const ORDERED = /^(\d{1,3})[.)]\s+(.+)$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const QUOTE = /^>\s?(.*)$/;
const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;

function inlineInto(target, text) {
  const source = String(text ?? '');
  let last = 0;
  INLINE.lastIndex = 0;
  for (let match = INLINE.exec(source); match; match = INLINE.exec(source)) {
    if (match.index > last) target.append(document.createTextNode(source.slice(last, match.index)));
    const token = match[0];
    target.append(token.startsWith('**') ? node('strong', token.slice(2, -2)) : node('code', token.slice(1, -1)));
    last = match.index + token.length;
  }
  if (last < source.length) target.append(document.createTextNode(source.slice(last)));
}
function isBlockStart(line) {
  const text = line.trim();
  return !text || HEADING.test(text) || BULLET.test(text) || ORDERED.test(text)
    || RULE.test(text) || text.startsWith('```') || QUOTE.test(text) || text.startsWith('|');
}
function renderRich(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!trimmed) { i += 1; continue; }
    if (RULE.test(trimmed)) { out.push(node('hr')); i += 1; continue; }
    if (trimmed.startsWith('```')) {
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) { body.push(lines[i]); i += 1; }
      i += 1;
      const pre = node('pre');
      pre.append(node('code', body.join('\n')));
      out.push(pre);
      continue;
    }
    const heading = trimmed.match(HEADING);
    if (heading) {
      const element = node(heading[1].length <= 2 ? 'h4' : 'h5');
      inlineInto(element, heading[2]);
      out.push(element);
      i += 1;
      continue;
    }
    const ordered = ORDERED.test(trimmed);
    if (ordered || BULLET.test(trimmed)) {
      const list = node(ordered ? 'ol' : 'ul');
      while (i < lines.length) {
        const current = lines[i].trim();
        const match = ordered ? current.match(ORDERED) : current.match(BULLET);
        if (!match) break;
        const item = node('li');
        inlineInto(item, ordered ? match[2] : match[1]);
        list.append(item);
        i += 1;
      }
      out.push(list);
      continue;
    }
    if (QUOTE.test(trimmed)) {
      const quote = node('blockquote');
      while (i < lines.length) {
        const match = lines[i].trim().match(QUOTE);
        if (!match) break;
        if (quote.children.length) quote.append(document.createTextNode(' '));
        inlineInto(quote, match[1]);
        i += 1;
      }
      out.push(quote);
      continue;
    }
    if (trimmed.startsWith('|')) {
      // 表格不拆列，只把每一行原样留下，避免拼错内容。
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const current = lines[i].trim();
        i += 1;
        if (/^\|?[\s:|-]+\|?$/.test(current)) continue;
        out.push(node('p', current, 'rich-row'));
      }
      continue;
    }
    let buffer = trimmed;
    i += 1;
    while (i < lines.length && !isBlockStart(lines[i])) {
      const next = lines[i].trim();
      const spacing = /[A-Za-z0-9]$/.test(buffer) && /^[A-Za-z0-9]/.test(next) ? ' ' : '';
      buffer += spacing + next;
      i += 1;
    }
    const paragraph = node('p');
    inlineInto(paragraph, buffer);
    out.push(paragraph);
  }
  return out;
}

/* ── 二级页：开场白与快捷提问 ── */
// 应用全名常常带着作者写的副标题（「A — B」），开场白里只取主体，读着才像人话。
function shortName(name) {
  const text = typeof name === 'string' ? name.trim() : '';
  if (!text) return '这个应用';
  const head = text.split(/\s+[—–]\s+/)[0].trim() || text;
  return head.length > 26 ? `${head.slice(0, 26)}…` : head;
}
// 待审条目的开场白。版本号能少说一个就少说一个：用户只关心「我现在用的」和「要看的这版」，
// 中间那个架上版只在跟本机不一样时才值得占字。
function pendingLine(name, version, listed, installed) {
  const next = version || '没给版本号的这版';
  if (!listed) {
    return `${name}${version ? ` ${version}` : ''} 作者头一回往市场递，还没审过。源码我读得到，你想从哪儿听起。`;
  }
  if (installed && version && installed === version) {
    return `${name} 待审这版 ${version} 你已经装上了，市场架上还停在 ${listed}。想听什么就说。`;
  }
  if (installed && installed === listed) {
    return `${name} 你现在装的是 ${installed}，正好是市场上架那版；${next} 还在门外等着。要不要看它改了什么，你定。`;
  }
  if (installed) {
    return `${name} 你装的 ${installed}，市场架上 ${listed}；待审的是 ${next}。想听哪一段？`;
  }
  return `${name} 市场架上 ${listed}，待审的是 ${next}，你本机还没装。要不要先看它要什么权限？`;
}

function catalogLine(name, version, installed) {
  const shown = version || '没给版本号';
  if (installed && version && installed === version) {
    return `${name} 你装的 ${installed} 已经是目录里最新那版了哈。想看看它到底在干什么，随时说。`;
  }
  if (installed) {
    return `${name} 目录里是 ${shown}，你装的是 ${installed}。要看两版差在哪儿吗？`;
  }
  return `${name} 目录里这版是 ${shown}，你本机没装。想先听听它是干什么的？`;
}
function introText(item) {
  if (!item) return '';
  if (!isReviewable(item)) {
    return `「${item.name}」是本机装的应用，目录里没有它的公开源码。查不了代码，也答不了实现细节；已上架和待上架的应用可以正常问。`;
  }
  const version = typeof item.version === 'string' && item.version ? item.version : '';
  const installed = installedVersionOf(item);
  const pending = item.source === 'pending';
  const listed = pending && typeof item.listedVersion === 'string' ? item.listedVersion : '';
  const name = shortName(item.name);
  const body = pending ? pendingLine(name, version, listed, installed) : catalogLine(name, version, installed);
  return `知意在这儿。${body}`;
}
function quickActions(item) {
  if (!isReviewable(item)) return [];
  const version = typeof item.version === 'string' ? item.version : '';
  const installed = installedVersionOf(item);
  const target = item.source === 'pending' ? '待审版本' : '目录里这版';
  // 只有「已上架的应用递了新版」才有旧版可比；首次申请问「更新了什么」只会得到一个空答案。
  const firstTime = item.source === 'pending' && !item.listedVersion;
  const rows = [];
  if (installed && version && installed !== version) {
    rows.push({
      id: 'diff', label: '比已装版多什么', title: '对比本机版本与这一版',
      question: `我本机装的是 ${installed}，${target}是 ${version}。用大白话说清多了什么、改了什么，哪几处值得注意。`,
    });
  }
  rows.push({
    id: 'risk', label: '权限与风险', title: '看它要什么权限、会不会外发数据',
    question: '它要用哪些权限？会不会读我的聊天、读我的文件，或者把东西发到网上去？用大白话说清什么时候会碰到，别讲代码。',
  });
  rows.push({ id: 'howto', label: '怎么用', title: '第一次上手做哪几步', question: '它怎么用？第一次装上要做哪几步，一步一步说，别讲代码。' });
  if (firstTime) {
    rows.push({
      id: 'features', label: '它能干什么', title: '这个应用有哪些功能',
      question: '它都能干什么？用大白话说，我会在哪儿看到它、点进去能做什么。',
    });
  } else {
    rows.push({
      id: 'whatsnew', label: '这版更新了什么', title: '看这一版改了什么',
      question: version ? `这版（${version}）更新了什么？用大白话说改了啥、对我有什么影响。` : '它最近更新了什么？用大白话说改了啥。',
    });
  }
  return rows;
}
function chipButton(row) {
  const button = node('button', row.label, 'quick-chip');
  button.type = 'button';
  button.dataset.kind = 'chat';
  button.dataset.chip = row.id;
  if (row.title) button.title = row.title;
  button.addEventListener('click', () => void askQuick(row));
  return button;
}
function renderQuick() {
  const item = state.selected;
  // 审查那颗按钮留在 HTML 里，只重绘它后面的问题按钮，避免焦点和角色标签被反复重建。
  ui['market-quick'].replaceChildren(ui['market-inspect'], ...(item ? quickActions(item).map(chipButton) : []));
  ui['market-quick'].hidden = !item;
}
function renderIntro() {
  ui['conversation-empty'].textContent = introText(state.selected);
}
function typingNode() {
  const li = node('li', undefined, 'market-message is-typing');
  li.dataset.role = 'assistant';
  li.append(nameRow('知意', true));
  const row = node('div', undefined, 'typing-row');
  const dots = node('span', undefined, 'typing-dots');
  dots.append(node('i'), node('i'), node('i'));
  row.append(dots, node('span', state.mutation?.kind === 'inspect' ? '正在看源码…' : '正在想…', 'typing-copy'));
  li.append(row);
  return li;
}
function controls() {
  const busy = Boolean(state.mutation);
  const reviewable = state.selected ? isReviewable(state.selected) : true;
  ui['market-inspect'].disabled = !reviewable || state.sessionLoading || busy || (!state.sessionLoaded && !state.inspectFailed);
  ui['detail-clear'].disabled = !state.selected || !state.sessionLoaded || state.sessionLoading || busy || !state.session;
  ui['detail-clear'].hidden = !state.session;
  ui['market-inspect'].textContent = !reviewable ? '不可审查'
    : state.inspectArmed ? '再点一次，记录会被顶掉'
      : state.mutation?.key === state.selected?.key && state.mutation.kind === 'inspect'
        ? '正在审查…' : state.inspectFailed ? '重试审查' : (state.session?.snapshot ? '重新审查' : '整体审查');
  ui['session-retry'].disabled = state.sessionLoading || busy || !reviewable;
  // 记录已经在页面上且一切正常时，这个按钮没有用处，藏起来少一样看不懂的东西。
  ui['session-retry'].hidden = Boolean(state.session) && state.sessionLoaded && !state.inspectFailed && !state.busy;
  ui['market-question'].disabled = !reviewable || !canChat();
  ui['market-send'].disabled = !reviewable || !canChat() || !ui['market-question'].value.trim();
  ui['market-send'].textContent = state.mutation?.key === state.selected?.key && state.mutation.kind === 'chat' ? '正在回答…' : '发送';
  for (const chip of ui['market-quick'].children || []) {
    if (chip === ui['market-inspect']) continue;
    chip.disabled = !reviewable || busy || state.sessionLoading || !canChat();
  }
  ui['chat-hint'].textContent = !reviewable ? '这个应用没有公开源码，不能查代码，也不能提问。'
    : busy ? '正在处理这一轮，关掉页面不会中断请求。'
      : state.inspectFailed ? '上次审查没成功，点「重试审查」再来一次。'
        : state.busy ? '上一轮仍在处理，稍后点「读回记录」。'
        : state.session?.stale ? '这份检查过期了，重新审查后才能接着问。'
          : canChat() ? (state.session === null ? `第一次提问会先读公开源码，再交给模型。${READ_BACK_NOTE}`
            : '还是同一个版本快照，接着问就行；每次都会产生用量。')
            : '记录还没确认，先「读回记录」或重新审查。';
}
function renderList() {
  const query = ui['market-search'].value.trim().toLocaleLowerCase();
  const listedIds = new Set(state.items.filter((item) => item.source === 'market').map((item) => item.id));
  let candidates = state.items.filter((item) => matchesSource(item, state.source, listedIds));
  if (state.source === 'installed') candidates = mergeInstalled(candidates);
  const items = candidates.filter((item) => [item.name, item.id, item.description]
    .some((v) => String(v ?? '').toLocaleLowerCase().includes(query)));
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  state.page = Math.min(state.page, pages);
  // 已上架列表里，同一应用如果有审核中的新版，就把两个版本号并排摆出来。
  const pendingByApp = state.source === 'market' && state.pendingLoaded
    ? new Map(state.items.filter((item) => item.source === 'pending').map((item) => [item.id, item]))
    : new Map();
  const iconSlots = [];
  const rows = items.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE).map((item) => {
    const li = node('li');
    const pendingRow = item.source === 'market' ? pendingByApp.get(item.id) : null;
    const pendingVersion = typeof pendingRow?.version === 'string' && pendingRow.version ? pendingRow.version : '';
    const marked = item.source === 'pending' || Boolean(pendingVersion);
    const button = node('button', undefined, marked ? 'market-item is-pending' : 'market-item');
    button.type = 'button';
    button.setAttribute('aria-label', `${item.name} · ${cardMeta(item)}${pendingVersion ? ` · 待审 v${pendingVersion}` : ''}`);
    const metaRow = node('div', undefined, 'item-meta-row');
    // 有待审时第一段只写「上架 vX」，把宽度留给后面那个真正要看的待审版号。
    const listedLabel = pendingVersion ? `上架 v${shortVersion(item.version)}` : cardMeta(item);
    metaRow.append(node('span', listedLabel, item.source === 'pending' ? 'item-meta is-pending' : 'item-meta'));
    if (pendingVersion) metaRow.append(node('span', `待审 v${shortVersion(pendingVersion)}`, 'item-meta is-pending'));
    button.setAttribute('title', `${item.name}${item.version ? ` · 当前 ${item.version}` : ''}${pendingVersion ? ` · 待审 ${pendingVersion}` : ''}`);
    const iconBox = iconNode(item);
    button.append(iconBox, node('strong', item.name, 'item-name'), metaRow);
    // 待审条目的图标需要另外去拉，记下卡槽等目录渲完再补；上架应用图都在目录里。
    if (item.source === 'pending') iconSlots.push({ item, box: iconBox });
    const update = cardUpdate(item, Boolean(pendingVersion));
    if (update) button.append(node('span', update, 'item-update'));
    // 有待审新版就审那份：卡片上已经摆着两个版本号，点进去再审上架版会白跑一轮。
    const target = item.source === 'market' && pendingRow ? pendingRow : item;
    button.addEventListener('click', () => openDetail(target, button));
    li.append(button);
    return li;
  });
  if (!rows.length) {
    const empty = state.catalogLoading ? '正在读取应用目录…'
      : !state.catalogLoaded ? '目录尚未加载，请刷新重试。'
        : state.source === 'installed' && state.installedStatus !== 'available'
          ? '读不到本机安装信息，暂时分不出哪些上架应用你已经装上。'
          : EMPTY_TEXT[state.source] || '这里还没有应用。换个分类或关键词看看。';
    rows.push(node('li', empty, 'market-empty'));
  }
  ui['market-list'].replaceChildren(...rows);
  void loadPendingIcons(iconSlots);
  ui['page-label'].textContent = `第 ${state.page} / ${pages} 页 · ${items.length} 项`;
  ui['page-prev'].disabled = state.catalogLoading || state.page <= 1;
  ui['page-next'].disabled = state.catalogLoading || state.page >= pages;
}
// 图标分两级：上架应用的图随目录一起到，立刻就有；待审应用的图另外要，
// 只给当前页里看得见的条目要，一批最多 8 个，失败就保持字形，不影响列表本身。
async function loadPendingIcons(slots) {
  const wanted = [];
  for (const slot of slots) {
    const { item, box } = slot;
    if (item.source !== 'pending' || safeIconSrc(item.icon)) continue;
    // 已经拿过的直接回填，切栏来回不再发请求。
    const known = iconMemory.get(item.key);
    if (known) {
      if (safeIconSrc(known)) { item.icon = known; paintIcon(box, item); }
      continue;
    }
    if (iconRequested.has(item.key)) continue;
    wanted.push(slot);
  }
  if (!wanted.length) return;
  for (const { item } of wanted) iconRequested.add(item.key);
  for (let index = 0; index < wanted.length; index += 8) {
    const batch = wanted.slice(index, index + 8);
    let icons = null;
    try {
      const payload = await request('/market/pending-icons', { keys: batch.map(({ item }) => item.key) });
      icons = payload?.icons && typeof payload.icons === 'object' ? payload.icons : {};
    } catch {
      icons = null;
    }
    if (!icons) {
      // 接口不通就停下来，并把这几个放回去，下次渲染还能再试。
      for (const { item } of batch) iconRequested.delete(item.key);
      return;
    }
    for (const { item, box } of batch) {
      const src = safeIconSrc(icons[item.key]);
      iconMemory.set(item.key, src);
      if (!src) continue;
      item.icon = src;
      paintIcon(box, item);
    }
  }
}
function pickItems(payload) {
  // The catalog contract is a single `items` array that mixes market, pending and installed entries.
  return Array.isArray(payload.items) ? payload.items : null;
}
function normalizeItem(item) {
  return {
    ...item,
    id: typeof item.id === 'string' ? item.id : '',
    description: typeof item.description === 'string' ? item.description : '',
    statusLabel: typeof item.statusLabel === 'string' ? item.statusLabel : '',
    sourceUrl: typeof item.sourceUrl === 'string' ? item.sourceUrl : '',
    version: typeof item.version === 'string' ? item.version : '',
    installedVersion: typeof item.installedVersion === 'string' && item.installedVersion.trim() ? item.installedVersion : null,
  };
}
// 只补读待审版本：不重读市场索引，读完把「待审最新版」并进当前列表。
async function loadPending() {
  if (state.pendingLoading) return;
  state.pendingLoading = true;
  status('catalog-status', '正在读取待审版本…列表可以先看，读完会自动标出来。');
  try {
    const payload = await request('/market/pending');
    const items = pickItems(payload);
    if (!Array.isArray(items) || items.some((item) => !item || typeof item.key !== 'string' || item.source !== 'pending')) {
      throw new Error('待审结果格式不完整，未更新列表。');
    }
    state.items = [...state.items.filter((item) => item.source !== 'pending'), ...items.map(normalizeItem)];
    state.pendingLoaded = true;
    if (typeof payload.installedStatus === 'string') state.installedStatus = payload.installedStatus;
    warnings('catalog-warnings', Array.isArray(payload.warnings) ? payload.warnings : []);
    if (state.catalogMeta) ui['catalog-meta'].textContent = `${state.catalogMeta} · 待审版本已读取`;
    renderList();
    status('catalog-status', items.length
      ? `待审版本已读到 ${items.length} 个，有新版的应用都已经标出来。`
      : '待审版本已读完，目前没有新的待审版本。');
  } catch (error) {
    status('catalog-status', `待审版本读取失败：${error.message} 点一下刷新目录可以重试。`, true);
  } finally {
    state.pendingLoading = false;
  }
}
async function loadCatalog(refresh = false, options = {}) {
  if (state.catalogLoading) return;
  state.catalogLoading = true;
  // 首屏先读快的市场索引，候审随后自动补读；用户主动切到待上架/全部时才同步等候审。
  const waitPending = options.waitPending ?? needsPending(state.source);
  const includePending = state.pendingLoaded || waitPending;
  let upgradePending = false;
  ui['market-refresh'].disabled = true;
  ui['market-refresh'].textContent = '正在刷新…';
  ui['market-list'].setAttribute('aria-busy', 'true');
  status('catalog-status', '正在读取目录…');
  renderList();
  try {
    const payload = await request(`/market/catalog?includePending=${includePending ? '1' : '0'}${refresh ? '&refresh=1' : ''}`);
    const items = pickItems(payload);
    if (!items || items.some((item) => !item || typeof item.key !== 'string'
      || !['market', 'pending', 'installed'].includes(item.source) || typeof item.name !== 'string')
      || !Array.isArray(payload.warnings) || payload.warnings.some((w) => typeof w !== 'string')) {
      throw new Error('目录格式不完整，未更新列表。');
    }
    // 候审可能比目录先回来；不读候审的那一次不能把已并入的待审条目抹掉。
    const incoming = items.map(normalizeItem);
    state.items = includePending ? incoming : [...incoming, ...state.items.filter((item) => item.source === 'pending')];
    state.catalogLoaded = true;
    // 待审可能已经先读回来了，不能被这次“未读候审”的结果重置成未读。
    state.pendingLoaded = state.pendingLoaded || payload.pendingLoaded === true;
    upgradePending = !includePending && needsPending(state.source) && !state.pendingLoaded;
    state.installedStatus = payload.installedStatus;
    ui['catalog-meta'].textContent = `目录更新：${formatTime(payload.updatedAt)} · ${payload.installedStatus === 'available' ? '本机安装信息可用' : '本机安装信息不可用，不推断更新状态'}`;
    state.catalogMeta = ui['catalog-meta'].textContent;
    ui['catalog-meta'].textContent = state.pendingLoaded ? `${state.catalogMeta} · 待审版本已读取` : `${state.catalogMeta} · 待审版本还在读`;
    warnings('catalog-warnings', payload.warnings);
    status('catalog-status', state.pendingLoaded
      ? '目录已读取。有待审新版的会标出来，点进去就是审那一版。'
      : '目录已读取，正在补读待审版本…');
  } catch (error) {
    status('catalog-status', `目录读取失败：${error.message}${state.catalogLoaded ? ' 当前保留上次目录，可能已过期。' : ''}`, true);
  } finally {
    state.catalogLoading = false;
    ui['market-refresh'].disabled = false;
    ui['market-refresh'].textContent = '刷新目录';
    ui['market-list'].setAttribute('aria-busy', 'false');
    renderList();
  }
  if (upgradePending) void loadPending();
}
function renderSession() {
  const session = state.session;
  const snapshot = session?.snapshot;
  renderIntro();
  renderQuick();
  if (state.selected && !isReviewable(state.selected)) {
    // Locally installed entries without a public source cannot be inspected or questioned.
    ui['inspection-state'].textContent = '已安装应用暂无公开来源，未做源码检查';
    ui['inspection-facts'].replaceChildren();
    fact(ui['inspection-facts'], '公开来源', '暂无公开来源');
    fact(ui['inspection-facts'], '源码检查', '不可用');
    fact(ui['inspection-facts'], '模型问答', '不可用');
    ui['inspection-files'].replaceChildren(node('li', '没有可读取的公开源码。'));
    ui['inspection-scope'].open = false;
    warnings('inspection-warnings', []);
    ui['market-messages'].replaceChildren();
    controls();
    return;
  }
  ui['inspection-state'].textContent = state.busy ? '上一轮仍在处理，稍后点「读回记录」'
    : !state.sessionLoaded ? '检查状态尚未确认'
      : session?.stale ? '已有检查记录已过期，需重新检查'
      : snapshot ? '已有源码检查记录（不代表安全认证）' : '尚无源码检查快照';
  ui['inspection-facts'].replaceChildren();
  fact(ui['inspection-facts'], '模型', modelName(session?.model));
  fact(ui['inspection-facts'], '绑定 commit', snapshot?.commit || '尚未绑定');
  fact(ui['inspection-facts'], '源码仓库', snapshot?.repo || '尚未读取');
  fact(ui['inspection-facts'], '检查时间', snapshot ? formatTime(snapshot.checkedAt) : '尚未检查');
  fact(ui['inspection-facts'], '发布标签', snapshot?.tag || '尚未读取');
  fact(ui['inspection-facts'], '源码清单版本', snapshot?.manifestVersion || '尚未读取');
  fact(ui['inspection-facts'], '目录包 SHA-256', snapshot?.archiveSha256 ? `${snapshot.archiveSha256}（目录记录值，未验包）` : '未提供，未验证安装包');
  ui['inspection-files'].replaceChildren(...(snapshot?.files || []).map((file) => node('li', `${file.path} · 读取 ${file.chars} 字符`)));
  if (!snapshot?.files?.length) ui['inspection-files'].append(node('li', '没有已确认的文件读取范围。'));
  ui['inspection-scope'].open = true;
  warnings('inspection-warnings', snapshot?.warnings || []);
  const messages = session?.messages || [];
  const rows = messages.map((message) => {
    const li = node('li', undefined, 'market-message');
    li.dataset.role = message.role;
    if (message.role === 'assistant') li.append(nameRow('知意', true));
    else if (message.role !== 'user') li.append(node('strong', `记录 · ${message.role}`));
    const body = node('div', undefined, 'rich');
    for (const piece of renderRich(message.content)) body.append(piece);
    li.append(body);
    return li;
  });
  // 发出去的那句先摆出来，不要让人对着空白等：模型还在想，但问的是什么得看得见。
  const pendingChat = state.pendingChat;
  if (pendingChat && pendingChat.key === state.selected?.key) {
    const li = node('li', undefined, 'market-message');
    li.dataset.role = 'user';
    const body = node('div', undefined, 'rich');
    for (const piece of renderRich(pendingChat.text)) body.append(piece);
    li.append(body);
    rows.push(li);
  }
  if (state.mutation && state.selected) rows.push(typingNode());
  ui['market-messages'].replaceChildren(...rows);
  if (state.mutation && state.selected) {
    ui['conversation-empty'].hidden = messages.length > 0 || Boolean(pendingChat);
  }
  const pane = ui['detail-scroll'];
  if (pane?.scrollHeight) pane.scrollTop = pane.scrollHeight;
  controls();
}
async function loadSession() {
  if (!state.selected) return;
  const key = state.selected.key;
  const view = state.view;
  const ticket = ++state.request;
  state.sessionLoading = true;
  state.sessionLoaded = false;
  status('detail-status', '正在读取这款应用的检查与对话记录…');
  controls();
  try {
    const payload = await request(`/market/session?key=${encodeURIComponent(key)}`);
    if (view !== state.view || ticket !== state.request) return;
    if (payload.busy === true) {
      // The backend is still working on the previous turn; keep the shown record but block new paid actions.
      state.busy = true;
      state.sessionLoaded = false;
      status('detail-status', '上一轮仍在处理，稍后点「读回记录」。');
      return;
    }
    state.busy = false;
    state.session = validSession(payload, key);
    state.sessionLoaded = true;
    state.inspectFailed = false;
    status('detail-status', state.mutation ? '仍有模型请求进行中，请等本次返回。' : '记录已读取。审查或提问只在你点击后发送。');
  } catch (error) {
    if (view !== state.view || ticket !== state.request) return;
    state.busy = false;
    state.session = null;
    status('detail-status', `记录读取失败：${error.message}`, true);
  } finally {
    if (view === state.view && ticket === state.request) {
      state.sessionLoading = false;
      renderSession();
    }
  }
}
function revealConversation() {
  const pane = ui['market-detail'];
  if (typeof pane?.scrollIntoView !== 'function') return;
  const reduced = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  pane.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
}
function openDetail(item, opener) {
  resetClear();
  if (state.selected) state.drafts.set(state.selected.key, ui['market-question'].value);
  state.view += 1;
  state.selected = item;
  state.opener = opener;
  state.session = null;
  state.sessionLoaded = false;
  const reviewable = isReviewable(item);
  ui['detail-name'].textContent = item.name;
  const listedHint = item.source === 'pending' && item.listedVersion ? `（已上架 v${shortVersion(item.listedVersion)}）` : '';
  ui['detail-context'].textContent = reviewable
    ? `${item.source === 'pending' ? '待审版本' : '目录版本'} ${item.version || '未提供'}${listedHint} · 应用 ID ${item.id}`
    : `已安装 ${versionText(item)} · 应用 ID ${item.id}`;
  // 未过审这一层只对正在审申请的应用说，不往已上架的条目上堆免责。
  ui['pending-notice'].hidden = item.source !== 'pending';
  ui['detail-description'].textContent = item.description || (reviewable ? '目录未提供简介。' : '本机已安装的应用，暂无公开来源与简介。');
  ui['detail-facts'].replaceChildren();
  fact(ui['detail-facts'], '来源', reviewable ? (item.source === 'pending' ? '上架申请（审核中）' : '官方上架目录') : '本机已安装');
  fact(ui['detail-facts'], '官方状态', item.statusLabel || (reviewable ? '未提供' : '已安装'));
  fact(ui['detail-facts'], '应用 ID', item.id);
  fact(ui['detail-facts'], reviewable ? (item.source === 'pending' ? '待审版本' : '目录版本') : '本机版本', reviewable ? (item.version || '未提供') : versionText(item));
  if (reviewable) {
    fact(ui['detail-facts'], '本机版本', installedLabel(item));
    if (item.source === 'pending' && item.listedVersion) fact(ui['detail-facts'], '已上架版本', item.listedVersion);
    fact(ui['detail-facts'], '来源地址', item.sourceUrl || '未提供');
    if (item.prNumber != null) fact(ui['detail-facts'], '上架申请', `PR #${item.prNumber}（以官方状态为准）`);
  } else {
    fact(ui['detail-facts'], '公开来源', '暂无公开来源，不能检查或提问');
    fact(ui['detail-facts'], '来源地址', item.sourceUrl || '暂无公开来源');
  }
  ui['market-question'].value = state.drafts.get(item.key) || '';
  state.inspectFailed = false;
  ui['market-home'].hidden = true;
  ui['market-detail'].hidden = false;
  renderSession();
  if (reviewable) {
    revealConversation();
    ui['detail-scroll'].scrollTop = 0;
    void loadSession();
  } else {
    status('detail-status', '已安装应用暂无公开来源，不能查源码，也不能提问。');
  }
}
function closeDetail() {
  resetClear();
  resetInspect();
  if (state.selected) state.drafts.set(state.selected.key, ui['market-question'].value);
  ui['market-detail'].hidden = true;
  ui['market-home'].hidden = false;
  state.view += 1;
  state.selected = null;
  state.opener?.focus();
}
async function mutate(kind) {
  const allowed = kind === 'inspect' ? (state.sessionLoaded || state.inspectFailed) : state.sessionLoaded;
  if (!state.selected || state.mutation || state.sessionLoading || !allowed) return;
  if (!isReviewable(state.selected)) return;
  const key = state.selected.key;
  const view = state.view;
  const text = ui['market-question'].value.trim();
  if (kind === 'chat' && (!canChat() || !text)) return;
  state.mutation = { kind, key };
  // 发出去的那句立刻上屏，并且立刻把输入框收走。两件事都做了，才不会被误认为没发出去。
  if (kind === 'chat') state.pendingChat = { key, text };
  if (kind === 'chat' && ui['market-question'].value.trim() === text) ui['market-question'].value = '';
  status('detail-status', kind === 'inspect' ? '正在读公开源码，再交给模型…' : '已送达，正在等回答…');
  renderSession();
  try {
    const payload = await request(`/market/${kind}`, kind === 'chat' ? { key, text } : { key });
    const session = validSession(payload, key);
    if (!session?.snapshot || !session.snapshot.commit || !session.snapshot.files.length) {
      throw new Error('返回记录缺少有效的源码读取范围或绑定 commit，未确认本次结果。请「读回记录」。');
    }
    if (kind === 'chat') {
      state.drafts.delete(key);
    }
    if (view !== state.view) return;
    state.session = session;
    state.sessionLoaded = true;
    state.inspectFailed = false;
    status('detail-status', session.stale ? '返回记录已过期，请重新审查。' : '刚才这轮回来了。');
  } catch (error) {
    if (view !== state.view) return;
    // 提问失败可能已经发到模型，重发会重复计费，所以锁住直到「读回记录」；
    // 审查失败大多死在读源码阶段，没必要把人关在死胡同里，直接给重试。
    if (kind === 'inspect') {
      state.inspectFailed = true;
      status('detail-status', `审查失败：${error.message} 点「重试审查」再来一次。`, true);
    } else {
      state.sessionLoaded = false;
      // 没拿到回答就把话放回输入框，免得重打；用户在这期间又打了字就不动。
      if (state.selected?.key === key && !ui['market-question'].value.trim()) ui['market-question'].value = text;
      status('detail-status', `提问失败：${error.message} 先「读回记录」核实，别马上再发，免得重复用量。草稿还在。`, true);
    }
  } finally {
    state.mutation = null;
    state.pendingChat = null;
    if (view === state.view) renderSession();
    else if (state.selected) void loadSession();
  }
}
async function askQuick(row) {
  if (state.mutation || state.sessionLoading) {
    status('detail-status', '还在读记录或上一轮没回来，等一下再点。');
    return;
  }
  if (!state.sessionLoaded || !canChat()) {
    status('detail-status', '这份记录还不能接着问，先「读回记录」或重新审查。');
    return;
  }
  if (!row?.question) return;
  ui['market-question'].value = row.question;
  state.drafts.set(state.selected.key, row.question);
  controls();
  void mutate('chat');
}

/* ── 清空对话：只删本机这份记录，不碰模型也不碰远程 ── */
let clearArmed = false;
let clearTimer = null;
// 重新审查要重新开一轮会话，旧问答会被顶掉；已经聊过就让它点两下。
function resetInspect() {
  state.inspectArmed = false;
  if (state.inspectTimer) clearTimeout(state.inspectTimer);
  state.inspectTimer = null;
}
function resetClear() {
  clearArmed = false;
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = null;
  if (!ui['detail-clear']) return;
  ui['detail-clear'].textContent = '清空记录';
  ui['detail-clear'].setAttribute('data-armed', 'false');
}
async function clearSession() {
  if (!state.selected || state.mutation || state.sessionLoading) return;
  const key = state.selected.key;
  const view = state.view;
  status('detail-status', '正在清空这款应用的记录…');
  try {
    await request('/market/clear', { key });
    if (view !== state.view) return;
    state.session = null;
    state.sessionLoaded = true;
    state.drafts.delete(key);
    ui['market-question'].value = '';
    status('detail-status', '记录已清空。再提问会重新读一遍公开源码，算一次模型用量。');
  } catch (error) {
    if (view !== state.view) return;
    status('detail-status', `清空失败：${error.message}`, true);
  } finally {
    if (view === state.view) renderSession();
  }
}

filters.forEach((source) => byId(`filter-${source}`).addEventListener('click', () => {
  state.source = source;
  state.page = 1;
  filters.forEach((value) => byId(`filter-${value}`).setAttribute('aria-pressed', String(value === source)));
  renderList();
  if (needsPending(source) && !state.pendingLoaded) void loadPending();
}));
ui['market-search'].addEventListener('input', () => { state.page = 1; renderList(); });
ui['market-refresh'].addEventListener('click', () => void loadCatalog(true));
ui['page-prev'].addEventListener('click', () => { if (state.page > 1) { state.page -= 1; renderList(); } });
ui['page-next'].addEventListener('click', () => { if (!ui['page-next'].disabled) { state.page += 1; renderList(); } });
ui['detail-close'].addEventListener('click', () => closeDetail());
ui['detail-clear'].addEventListener('click', () => {
  if (!state.selected || ui['detail-clear'].disabled) return;
  if (!clearArmed) {
    // 删了就回不来，所以要点两下：第一下只是上膛。
    clearArmed = true;
    ui['detail-clear'].textContent = '再点一次确认';
    ui['detail-clear'].setAttribute('data-armed', 'true');
    clearTimer = setTimeout(resetClear, 4000);
    return;
  }
  resetClear();
  void clearSession();
});
ui['session-retry'].addEventListener('click', () => { if (!state.mutation) void loadSession(); });
ui['market-inspect'].addEventListener('click', () => {
  if (!state.selected || state.mutation) return;
  // 重新审查会开一轮新会话，旧的问答会被顶掉。已经有对话时先说清楚，点两下才执行。
  const turns = (state.session?.messages || []).length;
  if (turns > 2 && !state.inspectArmed) {
    state.inspectArmed = true;
    if (state.inspectTimer) clearTimeout(state.inspectTimer);
    state.inspectTimer = setTimeout(resetInspect, 5000);
    status('detail-status', '重新审查会重新读一遍源码，现在这几轮对话会被新记录顶掉。再点一次确认。');
    controls();
    return;
  }
  resetInspect();
  void mutate('inspect');
});
ui['market-question'].addEventListener('input', () => {
  if (state.selected) state.drafts.set(state.selected.key, ui['market-question'].value);
  controls();
});
ui['market-question'].addEventListener('keydown', (event) => {
  // 回车发送，Shift+回车换行，跟常见对话框一致。
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  if (!ui['market-send'].disabled) void mutate('chat');
});
ui['market-chat'].addEventListener('submit', (event) => { event.preventDefault(); void mutate('chat'); });
async function start() {
  const section = byId('view-market');
  let activated = false;
  const activate = async () => {
    if (activated) return;
    activated = true;
    try {
      await hana.ready();
      // 目录和待审是两条独立链路：同时发起，谁先回来先上屏，不让它们排队等对方。
      const pendingRun = needsPending(state.source) && !state.pendingLoaded ? loadPending() : null;
      await loadCatalog(false, { waitPending: false });
      if (pendingRun) await pendingRun;
    } catch (error) {
      status('catalog-status', `知意连接失败：${error.message}。请从知意应用入口重新打开。`, true);
    }
  };
  if (section) {
    window.addEventListener('zhiyi:view-change', (event) => {
      if (event.detail?.view === 'market') void activate();
    });
  }
  try {
    await hana.ready();
    if (!section || section.classList.contains('on')) await activate();
  } catch (error) {
    status('catalog-status', `知意连接失败：${error.message}。请从知意应用入口重新打开。`, true);
  }
}
void start();

