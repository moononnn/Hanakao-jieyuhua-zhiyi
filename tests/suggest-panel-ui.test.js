import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appRoot = new URL("../", import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, appRoot), "utf8");
}

test("朗读页有收藏按钮，收藏走的是现有的 /voice/favorites", async () => {
  const html = await read("ui/suggest-panel.html");
  const script = await read("ui/assets/suggest-panel.js");
  assert.match(html, /id="voice-favorite"[^>]*>♡ 收藏/);
  assert.match(html, /id="voice-favorite"[^>]*hidden/);
  assert.match(script, /\/voice\/favorites/);
  assert.match(script, /clipId: currentReadClip\.clipId/);
  assert.match(script, /voiceFavoriteButton\.hidden = !currentReadClip\.clipId/);
});

test("「最新」标记认后端给的字段，不许再按数组下标自己猜", async () => {
  const script = await read("ui/assets/suggest-panel.js");
  // 实机（2026-10-22）：列表里标着「最新」的那条，点开念的却是最旧一轮。
  // 病根：后端从后往前收、最新的排第一，前端还沿用「最后一条最新」的旧假设。
  assert.match(script, /item\?\.isLatest/);
  assert.doesNotMatch(script, /items\.length - 1 \? '最新/);
});

test("列表按钮叫「查看」，进页不合成；改稿只影响这一次朗读", async () => {
  const html = await read("ui/suggest-panel.html");
  const script = await read("ui/assets/suggest-panel.js");
  // 实机（2026-10-22）：以前点列表就默默合成、直接花钱。现在只进页看稿。
  assert.match(script, /readButton\.textContent = '查看'/);
  assert.doesNotMatch(script, /readReply\(/);
  assert.match(html, /id="reader-draft"/);
  assert.match(html, /id="reader-speak"[^>]*>朗读这篇/);
  assert.match(html, /id="reader-edit"[^>]*>改稿/);
  assert.match(html, /id="reader-restore"[^>]*hidden>还原原文/);
  // 改过稿就走文字通道并带 draft，不然会被「只念引号」和字数上限再砍一刀。
  assert.match(script, /text, draft: true/);
  assert.match(script, /readerEdited/);
});

test("播放/静音图标是 svg：显隐只能走 toggleAttribute", async () => {
  const html = await read("ui/suggest-panel.html");
  const script = await read("ui/assets/suggest-panel.js");

  // 图标确实都是 svg（svg.hidden 是普通 JS 属性，CSS 的 [hidden] 选不中）。
  for (const cls of ["play-icon", "pause-icon", "volume-on-icon", "volume-off-icon"]) {
    assert.match(html, new RegExp(`<svg class="${cls}"`), `${cls} 应该是 svg`);
  }
  for (const icon of ["playIcon", "pauseIcon", "volumeOnIcon", "volumeOffIcon"]) {
    assert.doesNotMatch(script, new RegExp(`${icon}\\.hidden\\s*=`), `${icon} 不能靠 .hidden 属性切换`);
    assert.match(script, new RegExp(`${icon}\\.toggleAttribute\\('hidden'`), `${icon} 必须用 toggleAttribute`);
  }
  assert.match(script, /setPlayerPlaying/);
  assert.match(script, /syncPlayerButtonState/);
});

test("起名搬进「小工具」页：头部只剩编辑常用与收起，结果行还能还原", async () => {
  const html = await read("ui/suggest-panel.html");
  const script = await read("ui/assets/suggest-panel.js");
  const css = await read("ui/assets/suggest-panel.css");

  // 头部那排：编辑常用（只在推荐页）、收起。起名不再占头部。
  const head = html.slice(html.indexOf('class="head-actions"'), html.indexOf('class="page-tabs"'));
  assert.doesNotMatch(head, /id="rename-slug"/, "起名已经不在头部了");
  assert.match(head, /id="edit-quick"/);
  assert.match(head, /id="close-panel"/);

  // 起名是小工具页里的一格入口，不是页签、也不在头部。
  assert.match(html, /id="tools-page"[^>]*role="tabpanel"/);
  assert.match(html, /id="tools-grid"/);
  assert.match(html, /id="rename-slug"[^>]*class="tool-tile"/);
  assert.ok(
    html.indexOf('id="tools-page"') < html.indexOf('id="rename-slug"'),
    "起名那一格得在小工具页里",
  );
  // 页面重名也不让用户去找「会话标题」这个词。
  assert.match(html, /tool-tile-label">重新命名标题</);
  // 结果行没内容就整行收起来（空着留一条白像少了一块）；高度由后端估高时预留。
  assert.match(html, /id="slug-note"[^>]*role="status"/);
  assert.match(css, /\.slug-note:empty\s*\{[^}]*display:\s*none/, "空着不能占一块白");
  // 面板估高要把这行算进去，不然它一出现就多一条滚动条。
  assert.match(await read("lib/suggest-panel.js"), /起名结果那一行/);

  // 必须用面板报告的会话编号，不许走「最近活跃那段」。
  assert.match(script, /\/suggest-panel\/rename/);
  assert.match(script, /body: JSON.stringify\(\{ sessionId \}\)/);
  assert.doesNotMatch(script, /\/session-title\b(?!\/undo)/, "起名不再走那条「不知道改哪段」的旧接口");
  // 点下去得立刻有回音：这一格改字并禁用，不能静悄悄。格子是复合结构，
  // 改字只能改它那行小字（rename-hint），不能拿 textContent 覆掉整格。
  assert.match(script, /setRenameState\('起名中…'\)/);
  assert.match(script, /renameButton\.disabled = true/);
  assert.match(html, /id="rename-hint"/);
  // 成功才给「还原」，兜底要标出来。
  assert.match(script, /slug-undo/);
  assert.match(script, /\/session-title\/undo/);
  assert.match(script, /（兜底）/);
  // 换会话时上一段的名字结果不能跟过来。
  assert.match(script, /setSlugNote\(''\)/);
});

test("小工具页是入口格：朗读降为二级，退路要留全", async () => {
  const html = await read("ui/suggest-panel.html");
  const script = await read("ui/assets/suggest-panel.js");
  const css = await read("ui/assets/suggest-panel.css");

  // 页签三个：推荐回复 / 小工具 / 帮我理顺。朗读不再占一级页签。
  assert.match(html, /role="tablist"/);
  assert.match(html, /推荐回复/);
  assert.match(html, /id="tab-tools"[^>]*>小工具</);
  assert.match(html, /id="tab-polish"[^>]*>帮我理顺</);
  assert.doesNotMatch(html, /id="tab-voice"/, "朗读不再是一级页签");
  assert.match(html, /id="recommend-page"[^>]*role="tabpanel"/);
  assert.match(html, /id="tools-page"[^>]*role="tabpanel"[^>]*hidden/);
  assert.match(html, /id="open-voice"/);
  // 朗读的列表与播放器都收在小工具页里，进去以后能退回格子。
  assert.match(html, /id="voice-list-view"/);
  assert.match(html, /id="voice-reader-view"[^>]*hidden/);
  assert.match(html, /id="voice-back"[^>]*aria-label="返回小工具"/);
  assert.match(html, /id="reader-back"/);
  assert.match(script, /showToolsView\('voice'\)/);
  assert.match(script, /showToolsView\('grid'\)/);
  // 格子用网格排：以后加功能就是加一格，不会排成一条长条。
  assert.match(css, /\.tools-grid\s*\{[^}]*display:\s*grid/);
  assert.match(css, /\.tool-tile\s*\{/);
});

test("输入框面板提供逐词朗读页与自定义播放器", async () => {
  const html = await read("ui/suggest-panel.html");
  const script = await read("ui/assets/suggest-panel.js");
  const css = await read("ui/assets/suggest-panel.css");

  assert.match(html, /id="reader-text"/);
  assert.match(html, /id="player-toggle"/);
  assert.match(html, /id="player-progress"/);
  assert.match(html, /id="volume-range"/);
  assert.match(html, /id="speed-menu"/);
  assert.match(html, /<audio id="reply-audio" preload="none"/);
  assert.doesNotMatch(html, /<audio[^>]*\scontrols(?:\s|>)/);
  assert.match(script, /hana\.inputPanel\?\.getContext\?\.\(\)/);
  assert.match(script, /\/voice\/replies\?sessionId=/);
  assert.match(script, /\/voice\/speak/);
  assert.match(script, /\/voice\/clip\//);
  assert.match(script, /payload\.timings/);
  assert.match(script, /activeTimingIndex\(/);
  assert.match(script, /voiceListSequence/);
  assert.match(script, /requestSequence !== voiceListSequence/);
  assert.match(script, /paper\.scrollTop/);
  assert.match(script, /readerPaper\.scrollTop = 0/);
  assert.match(script, /volumeRange\.style\.setProperty\('--range-progress'/);
  assert.match(script, /URL\.createObjectURL\(blob\)/);
  assert.match(css, /\.reader-mark\.is-active/);
  assert.match(css, /\.speed-menu/);
  const quickButtonRule = css.match(/\.quick-btn\s*\{([^}]+)\}/)?.[1] || "";
  assert.match(quickButtonRule, /flex:\s*0\s+0\s+auto/);
  assert.match(quickButtonRule, /white-space:\s*normal/);
  assert.match(quickButtonRule, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(quickButtonRule, /text-overflow:\s*ellipsis/);
});

test("小工具页的「排队发送」：跟球上那个弹窗同一套控件，共用 /queue-plan 三条路由", async () => {
  const html = await read("ui/suggest-panel.html");
  const script = await read("ui/assets/suggest-panel.js");
  const css = await read("ui/assets/suggest-panel.css");
  // 格子入口 + 子视图的控件：输入框、每句排几轮、停、就这么发。
  assert.match(html, /id="open-queue"[^>]*class="tool-tile"/);
  assert.match(html, /id="queue-input"/);
  assert.match(html, /id="queue-rounds-down"/);
  assert.match(html, /id="queue-rounds-up"/);
  assert.match(html, /id="queue-stop"/);
  assert.match(html, /id="queue-send"[^>]*>就这么发/);
  // 三条路由都要接上，不然面板排不了、也看不到进度。
  assert.match(script, /\/queue-plan\/state/);
  assert.match(script, /\/queue-plan\/start/);
  assert.match(script, /\/queue-plan\/stop/);
  // 轮数跟球上一致：1..50。
  assert.match(script, /Math\.max\(1, Math\.min\(50,/);
  // 排队那层要能自己关掉：display:flex 会把 hidden 属性盖掉，必须显式处理。
  assert.match(css, /\.queue-view\[hidden\]\s*\{\s*display:\s*none/);
});
