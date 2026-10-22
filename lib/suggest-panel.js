// 输入框上方的推荐面板（inputPanels）。
//
// 为什么不用横幅：inputBanner 是宿主渲染的一条固定高度的横条，宽度也只有那么宽，
// 完整句子放不下（实机：按钮文字被截、第二个按钮被顶出屏幕右缘）。横幅没有高度参数，
// 拉不高也拉不宽。
// inputPanels 则是本 App 自己的一块板子：ui/ 里的 HTML 用 iframe 挂在输入框上方，
// 高度自己报（24~4096），内容自己画，想写多长写多长。
//
// 契约要点（宿主 1.1.35-beta）：
//   ctx.userInteraction.show({ sessionId, id, title, message?, contentFrame:{ route, data? }, presentation? })
//   contentFrame.route 指向本 App ui/ 目录里的文件（形如 "/suggest-panel.html"）
//   presentation: { height, collapsedHeight, expanded }
//   ctx.userInteraction.updatePanel({ sessionId, panelId, presentation }) 改高度，不用重挂
//   同一个 (session, app, id) 再 show 是原地替换，不叠加
// 权限：app/input.panels（宿主设置里叫「显示输入框上方的自定义界面」）

export const SUGGEST_PANEL_ID = "zhiyi-suggest-panel";
export const SUGGEST_PANEL_ROUTE = "/suggest-panel.html";
export const SUGGEST_PANEL_STATE_KEY = "suggestPanelState";
// 跟 manifest 里 contributes.ui.inputStatus 的 id 一致：显隐就是按这个条目盖的。
export const SUGGEST_INPUT_STATUS_ID = "zhiyi-suggest";
export const SUGGEST_PANEL_HEIGHT = 220;
export const SUGGEST_PANEL_COLLAPSED_HEIGHT = 24;
// 条数跟设置页的「推荐几条」一致（2 / 3 / 4），所以这里最多留四条。
export const SUGGEST_PANEL_MAX = 4;

/**
 * 推荐语统一成 { text, direction } 列表，去空、去白，最多四条。
 * direction 是设置页里配的那个方向名（如「追问/延伸」），面板上要标出来，
 * 得跟设置里选的方向一致，不能各说各的。
 */
export function normalizeSuggestionTexts(value) {
  const list = Array.isArray(value) ? value : [];
  return list
    .map((item) => {
      if (typeof item === "string") return { text: item.trim(), direction: "" };
      const text = typeof item?.text === "string" ? item.text.trim() : "";
      const direction = typeof item?.direction === "string" ? item.direction.trim() : "";
      return { text, direction };
    })
    .filter((item) => item.text)
    .slice(0, SUGGEST_PANEL_MAX);
}

/** 存进 app-data 的面板状态。 */
export function buildPanelState({
  sessionId = "",
  suggestions = [],
  quickReplies = [],
  panelId = "",
  createdAt = 0,
} = {}) {
  return {
    sessionId: String(sessionId || ""),
    suggestions: normalizeSuggestionTexts(suggestions),
    quickReplies: Array.isArray(quickReplies)
      ? quickReplies.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
      : [],
    panelId: String(panelId || ""),
    createdAt: Number(createdAt) || Date.now(),
  };
}

/**
 * 读回面板状态。
 * sessionId 对不上就当没有（别把别的对话的句子端到眼前）。
 */
export function readPanelState(raw, sessionId = "") {
  const state = raw && typeof raw === "object" ? raw : {};
  const suggestions = normalizeSuggestionTexts(state.suggestions);
  const owner = String(state.sessionId || "");
  const quickReplies = Array.isArray(state.quickReplies) ? state.quickReplies : [];
  const panelId = String(state.panelId || "");
  const createdAt = Number(state.createdAt) || 0;
  // 没推荐不代表没会话：面板刚挂出来、还没生成时，会话归属和 panelId 还得留着。
  if (!suggestions.length) {
    return { ok: false, reason: "empty", suggestions: [], sessionId: owner, quickReplies, panelId, createdAt };
  }
  if (sessionId && owner && owner !== sessionId) {
    return { ok: false, reason: "other-session", suggestions: [], sessionId: owner, quickReplies, panelId, createdAt };
  }
  return { ok: true, suggestions, createdAt, sessionId: owner, quickReplies, panelId };
}

/** 面板高度：展开时够摊开几句，折叠时只留标题那点高度。 */
export function buildPanelPresentation({
  height = SUGGEST_PANEL_HEIGHT,
  collapsedHeight = SUGGEST_PANEL_COLLAPSED_HEIGHT,
  expanded = true,
} = {}) {
  return { height, collapsedHeight, expanded };
}

/**
 * 面板里每句都是可编辑的：发出去的是改过的那句，不是原始推荐语。
 * 编辑后为空就当没选（不发空消息）。
 */
export function pickEditableText(value) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text;
}

/** 面板每行下面标的方向名（没有方向就不标）。 */
export function pickDirection(item) {
  return typeof item?.direction === "string" ? item.direction.trim() : "";
}

/**
 * 面板高度按内容估：宿主给的是固定高度，报大了下面空一片，报小了要滚动。
 * 标题、页签都计入；常用回复按每条可能换行预留空间，再算生成按钮和推荐句。
 */
export function estimatePanelHeight({ quickCount = 0, suggestionCount = 0, editing = false } = {}) {
  const base = 110;                                 // 标题、页签、起名结果那一行 + 内边距
  const quick = quickCount > 0 ? quickCount * 40 : 0; // 每条可能换行，宁可多留一点
  const editor = editing ? 36 : 0;                 // 常用回复的编辑输入框那一行
  const actions = 34;                              // 生成按钮那一行
  const list = suggestionCount > 0 ? suggestionCount * 52 : 0;
  const empty = suggestionCount > 0 ? 0 : 24;       // “还没生成”那一行
  const total = base + quick + editor + actions + list + empty;
  return Math.min(460, Math.max(180, total));
}
