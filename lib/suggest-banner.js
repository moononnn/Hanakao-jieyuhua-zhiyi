// 输入栏那个按钮点开之后的那条横幅：把推荐语变成几个能点的按钮。
//
// 契约来自宿主 1.1.35-beta（不是旧 SDK 文档里那套）：
//   横幅 text ≤ 200 字符；按钮 ≤ 3 个；每个按钮 title ≤ 40 字符。
//   按钮 action 只有两种：
//     post-message —— 把 text 当这条会话的新消息注入，并开启新一轮（伙伴当场接话）
//     notify-plugin —— 只通知 App，横幅留在原地，由 App 自己决定发不发
// 这里只用 post-message：她点哪条，哪条就以她的口吻直接发出去，不用她再复制粘贴。
//
// 为什么不做「换一批」按钮：notify-plugin 的点击事件走 bus，但宿主公开的事件名里
// 只有 input_banner_set / input_banner_dismissed，没有按钮点击那一档（1.1.35-beta 实查）。
// 拿不到可靠的点击回调就不硬做：想换一批，再点一次输入栏的按钮，横幅原地覆盖。

export const SUGGEST_BANNER_ID = "zhiyi-suggest";

const BANNER_TEXT_MAX = 200;
// 宿主硬上限是 40 字，但横幅按钮是横排一行，放不下就溢出屏幕（实机：第二个按钮直接被顶出右缘，
// 第一个按钮的文字还跟 App 名糊在一起）。40 是“合法上限”，不是“好看上限”——
// 这里按 10 字显示：一句完整推荐语通常 15~25 字，10 字刚好认得出说的是哪件事；
// 真正想看全句，只能换 inputPanels 那块自己画的板子，横幅这个位置天生给不了。
const BUTTON_TITLE_MAX = 40;
const BUTTON_TITLE_DISPLAY = 10;
const MAX_BUTTONS = 3;

function clip(text, max) {
  const chars = [...String(text ?? "")];
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, Math.max(0, max - 1)).join("") + "…";
}

/** 按钮标题按字符数截（中文一个字算一个），末尾加省略号。 */
export function clampButtonTitle(text, max = BUTTON_TITLE_DISPLAY) {
  return clip(String(text ?? "").trim(), max);
}

/** 横幅正文按字符数截到宿主上限内。 */
export function clampBannerText(text, max = BANNER_TEXT_MAX) {
  return clip(String(text ?? "").trim(), max);
}

/**
 * 拿推荐语造一条横幅。
 * @param {Array<{text?: string}|string>} suggestions 推荐语列表
 * @param {{bannerId?: string, lead?: string}} options
 */
export function buildSuggestBanner(suggestions, { bannerId = SUGGEST_BANNER_ID, lead = "" } = {}) {
  const items = (Array.isArray(suggestions) ? suggestions : [])
    .map((item) => (typeof item === "string" ? { text: item } : item))
    .filter((item) => item && typeof item.text === "string" && item.text.trim());
  const picked = items.slice(0, MAX_BUTTONS);
  const buttons = picked.map((item, index) => ({
    id: `s${index + 1}`,
    title: clampButtonTitle(item.text),
    // 注入的是完整原文：按钮标题是截断给人看的，发出去的是整句。
    action: { kind: "post-message", text: item.text.trim() },
  }));
  const defaultLead = `给你拟了 ${buttons.length} 句，点一条就发`;
  return {
    bannerId,
    text: clampBannerText(lead || defaultLead),
    buttons,
  };
}
