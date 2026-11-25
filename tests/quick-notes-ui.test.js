import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createQuickNotesController, quickNotesDraftKey } from "../ui/assets/quick-notes.js";

function fixture(request, storage = new Map()) {
  const copied = [], calls = [];
  const local = { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  const controller = createQuickNotesController({
    api: { request: async (path, init) => { calls.push({ path, ...init }); return request?.(path, init); } },
    clipboard: { writeText: async ({ text }) => copied.push(text) }, storage: local,
  });
  controller.setSession("current");
  return { controller, copied, calls, storage };
}
const note = () => ({ id: "note-1", revision: 1, text: "第一行\n第二行  两空格", group: "想法", done: false, pinned: false,
  createdAt: 1, updatedAt: 1, delivery: { state: "none" } });

test("草稿按面板会话隔离，关闭后重开恢复；不会覆盖初次恢复的稿子", () => {
  const { controller: c, storage } = fixture();
  c.setDraft("A\n稿"); c.setDraftGroup("分组A");
  c.setSession("other"); assert.equal(c.state.draft, "");
  c.setDraft("B稿"); c.setSession("current");
  assert.equal(c.state.draft, "A\n稿");
  assert.equal(c.state.draftGroup, "分组A");
  const reopened = fixture(null, storage).controller;
  assert.equal(reopened.state.draft, "A\n稿");
  assert.equal(JSON.parse(storage.get(quickNotesDraftKey("other"))).text, "B稿");
});

test("localStorage读写失败仍可写字，切换回来保留内存稿并明确提示", () => {
  const c = createQuickNotesController({ storage: { getItem() { throw new Error(); }, setItem() { throw new Error(); } } });
  c.setSession("one"); c.setDraft("留着"); c.setSession("two"); c.setSession("one");
  assert.equal(c.state.draft, "留着"); assert.match(c.state.storageWarning, /草稿/);
});

test("复制使用原文和编辑稿，不改变收好状态、不发消息", async () => {
  const { controller: c, copied, calls } = fixture();
  const item = note(); c.mergeItem(item);
  await c.copy(item); assert.deepEqual(copied, [item.text]);
  c.editDraft(item, { text: "改稿\n别压平" });
  await c.copy(item); assert.equal(copied[1], "改稿\n别压平");
  assert.equal(c.state.items[0].done, false); assert.equal(calls.length, 0);
});

test("宿主拒绝输入框面板剪贴板时保留记录且不报告已复制", async () => {
  const error = 'Plugin UI capability "clipboard.writeText" is not allowed in input-panel slots.';
  const c = createQuickNotesController({ clipboard: { writeText: async () => { throw new Error(error); } } });
  c.setSession("current"); c.mergeItem(note());
  const result = await c.copy(c.state.items[0]);
  assert.equal(result.ok, false);
  assert.equal(c.state.status, error);
  assert.equal(c.state.statusTone, "warn");
  assert.equal(c.state.items[0].done, false);
});

test("新建保存失败保留草稿；再次成功才清空", async () => {
  let ok = false;
  const { controller: c } = fixture(() => ok ? { ok: true, item: note() } : { ok: false, error: "存储失败" });
  c.setDraft("未保存"); await c.save();
  assert.equal(c.state.draft, "未保存");
  ok = true; await c.save(); assert.equal(c.state.draft, "");
});

test("保存请求期间新增的字不被清空；连点记下不重复新建", async () => {
  let release;
  const { controller: c, calls } = fixture(() => new Promise((resolve) => { release = resolve; }));
  c.setDraft("先前的"); const pending = c.save();
  c.setDraft("后来补的"); assert.equal((await c.save()).code, "saving");
  release({ ok: true, item: note() }); await pending;
  assert.equal(c.state.draft, "后来补的"); assert.equal(calls.length, 1);
});

test("发送只认点击时的会话，不跟随请求期间切换；明确接收才收好", async () => {
  let release;
  const { controller: c, calls } = fixture(() => new Promise((resolve) => { release = resolve; }));
  const item = note(); c.mergeItem(item);
  const pending = c.action(item, "send");
  c.setSession("another");
  assert.equal((await c.action(item, "send")).code, "pending");
  release({ ok: true, archived: true, item: { ...item, done: true, revision: 3, delivery: { state: "sent" } } });
  await pending;
  assert.equal(calls.length, 1); assert.equal(calls[0].body.sessionId, "current");
  assert.equal(c.state.items[0].done, true);
  assert.equal(c.state.status, "", "不向新会话显示旧发送的成功提示");
});

test("发送网络结果不明不划掉，并阻止前端再次发送", async () => {
  const { controller: c, calls } = fixture(() => { throw new Error("network timeout"); });
  c.mergeItem(note()); await c.action(c.state.items[0], "send");
  assert.equal(c.state.items[0].done, false);
  assert.equal(c.state.items[0].delivery.state, "uncertain");
  await c.action(c.state.items[0], "send"); assert.equal(calls.length, 1);
});

test("拒绝后刷新版本能重试，缺会话或未保存修改不发送", async () => {
  const item = note();
  const { controller: c, calls } = fixture(() => ({ ok: false, error: "权限不足", item: { ...item, revision: 3, delivery: { state: "rejected" } } }));
  c.mergeItem(item); c.setSession(""); await c.action(item, "send"); assert.equal(calls.length, 0);
  c.setSession("current"); c.editDraft(item, { text: "还没存" }); await c.action(item, "send"); assert.equal(calls.length, 0);
  c.discardEdit(item.id); await c.action(item, "send");
  assert.equal(c.state.items[0].revision, 3); assert.equal(c.state.items[0].done, false);
});

test("编辑发生冲突不替换编辑稿，也不偷偷更新编辑的基线版本", async () => {
  const item = note();
  const { controller: c } = fixture(() => ({ ok: false, error: "别处改过了", item: { ...item, revision: 4, text: "他处新稿" } }));
  c.mergeItem(item); c.editDraft(item, { text: "我的未保存稿" }); await c.action(item, "update");
  assert.equal(c.state.edits[item.id].text, "我的未保存稿"); assert.equal(c.state.edits[item.id].revision, 1);
  assert.equal(c.state.items[0].text, "他处新稿");
});

test("明确的版本冲突不误判为发送超时；归档结果缺失仍阻止重发", async () => {
  const item = note();
  const conflict = fixture(() => ({ ok: false, code: "conflict", error: "版本冲突", item: { ...item, revision: 2 } })).controller;
  conflict.mergeItem(item); await conflict.action(item, "send");
  assert.equal(conflict.state.items[0].delivery.state, "none");
  const { controller: c, calls } = fixture(() => ({ ok: true, sent: true, archived: false, error: "收好未确认" }));
  c.mergeItem(item); await c.action(item, "send");
  assert.equal(c.state.items[0].delivery.state, "sent");
  await c.action(c.state.items[0], "send"); assert.equal(calls.length, 1);
});

test("分组/正文搜索和待处理/已收好分开", () => {
  const { controller: c } = fixture();
  c.mergeItem(note()); c.mergeItem({ ...note(), id: "done", done: true });
  c.setQuery("想法"); assert.equal(c.visibleItems().length, 1);
  c.setTab("done"); assert.equal(c.visibleItems()[0].id, "done");
  c.setQuery("不存在"); assert.equal(c.visibleItems().length, 0);
});

test("标记已处理与移回待处理给出明确反馈且不发送消息", async () => {
  const item = note();
  const { controller: c, calls } = fixture((path, init) => ({ ok: true, item: { ...item, done: init.body.done, revision: init.body.revision + 1 } }));
  c.mergeItem(item);
  await c.action(c.state.items[0], "done");
  assert.equal(c.state.items[0].done, true); assert.match(c.state.status, /已处理/);
  await c.action(c.state.items[0], "done");
  assert.equal(c.state.items[0].done, false); assert.match(c.state.status, /待处理/);
  assert.deepEqual(calls.map((call) => call.path), ["/quick-notes/done", "/quick-notes/done"]);
});

test("全选入口和处理状态文案不再使用隐晦命名", async () => {
  const html = await readFile(new URL("../ui/suggest-panel.html", import.meta.url), "utf8");
  const ui = await readFile(new URL("../ui/assets/quick-notes.js", import.meta.url), "utf8");
  const store = await readFile(new URL("../lib/quick-notes.js", import.meta.url), "utf8");
  const routes = await readFile(new URL("../lib/quick-notes-routes.js", import.meta.url), "utf8");
  assert.match(html, /id="notes-tab-done"[^>]*>已处理/);
  assert.match(ui, /notes-select-all/); assert.match(ui, /移回待处理/); assert.match(ui, /标记已处理/);
  assert.doesNotMatch(ui + store + routes, /收好|拿回来/);
});

test("面板接线、宿主剪贴板、IME快捷键、固定操作区与安全文本渲染", async () => {
  const html = await readFile(new URL("../ui/suggest-panel.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../ui/assets/quick-notes.js", import.meta.url), "utf8");
  const panel = await readFile(new URL("../ui/assets/suggest-panel.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../ui/assets/quick-notes.css", import.meta.url), "utf8");
  assert.match(html, /id="open-notes"/); assert.match(html, /id="notes-view"/); assert.match(html, /id="notes-refresh"/);
  assert.match(source, /clipboard: hana.clipboard/); assert.match(source, /!event.isComposing/);
  assert.doesNotMatch(source, /innerHTML|\/copy-text|navigator.clipboard/);
  assert.match(panel, /quickNotes.setSession\(nextSessionId\)/);
  assert.match(source, /getSessionId\(\)/); assert.match(css, /overflow-y: auto/); assert.match(css, /flex-wrap: nowrap/);
});

test("分组筛选只看当前分组的条目，选项来自已有笔记", () => {
  const { controller: c } = fixture();
  c.mergeItem({ ...note(), id: "a", group: "茶话会" });
  c.mergeItem({ ...note(), id: "b", group: "知意" });
  c.setGroup("茶话会");
  assert.deepEqual(c.visibleItems().map((item) => item.id), ["a"]);
  assert.deepEqual(c.groups(), ["茶话会", "知意"]);
  c.setQuery("第一行");
  assert.equal(c.visibleItems().length, 1, "组内还能继续搜");
  c.setGroup("");
  assert.equal(c.visibleItems().length, 2);
});

test("列表一次一页，快到底才续；换页签、换组、搜字都回第一页", () => {
  const { controller: c } = fixture();
  for (let index = 0; index < 25; index += 1) {
    c.mergeItem({ ...note(), id: "n" + index, text: "条目" + index, updatedAt: index + 1 });
  }
  assert.equal(c.pagedItems().length, 10);
  assert.equal(c.hasMore(), true);
  c.more();
  assert.equal(c.pagedItems().length, 20);
  c.more();
  assert.equal(c.pagedItems().length, 25);
  assert.equal(c.hasMore(), false);
  c.more();
  assert.equal(c.pagedItems().length, 25, "没有更多时不再往下加");
  c.setGroup("想法");
  assert.equal(c.state.limit, 10, "换组回第一页");
  c.more(); c.setQuery("条目");
  assert.equal(c.state.limit, 10, "搜字也回第一页");
});

test("重新读取后列表回到第一页，空分组被丢掉", async () => {
  const storage = new Map();
  const items = [];
  for (let index = 0; index < 12; index += 1) items.push({ ...note(), id: "m" + index, group: "知意", updatedAt: index + 1 });
  const { controller: c } = fixture(() => ({ ok: true, items, storageOk: true }), storage);
  await c.load();
  assert.equal(c.pagedItems().length, 10);
  c.more();
  assert.equal(c.state.limit, 20);
  await c.load();
  assert.equal(c.state.limit, 10, "重读后回第一页");
  c.setGroup("不存在");
  await c.load();
  assert.equal(c.state.group, "", "分组已经没了就放掉筛选项");
});

test("滚轮收起新建区：不收进存储，打开面板总是能写的样子", async () => {
  const html = await readFile(new URL("../ui/suggest-panel.html", import.meta.url), "utf8");
  const ui = await readFile(new URL("../ui/assets/quick-notes.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../ui/assets/quick-notes.css", import.meta.url), "utf8");
  assert.match(html, /id="notes-newbar"/); assert.match(html, /id="notes-group-filter"/);
  assert.match(html, /notes-editor-body/);
  assert.match(ui, /COLLAPSE_AFTER/); assert.match(ui, /view.classList.toggle\("is-collapsed"/);
  assert.match(ui, /view.classList.remove\("is-collapsed"\)/);
  assert.match(ui, /editor.contains\(doc.activeElement\)/);
  assert.match(ui, /collapseFocus/);
  // 收起后只有滚回顶才展开：不能见 dir<0 就弹回，否则布局补出的向上抖动会把它反复弹回。
  assert.match(ui, /else if \(collapsed && top <= 1 && Date\.now\(\) > holdExpandUntil\)/);
  assert.doesNotMatch(ui, /collapsed && \(dir < 0/);
  // 点「＋ 记一笔」展开后要重新武装，再往下滚仍能收回（作者 2026-11-25 要求）。
  assert.doesNotMatch(ui, /armed = false;\s*\n\s*setCollapsed\(false\);\s*\n\s*input\.focus\(\);/);
  assert.match(css, /is-collapsed \.notes-list/);
  // 收起只是面板里的一次样子，不进草稿、不进 localStorage。
  assert.doesNotMatch(ui, /writeDraft\(\)[^;]*collapsed|collapsed[^;]*writeDraft/);
});

test("页面内联的随手记样式与 assets/quick-notes.css 逐字相同", async () => {
  const html = await readFile(new URL("../ui/suggest-panel.html", import.meta.url), "utf8");
  const css = (await readFile(new URL("../ui/assets/quick-notes.css", import.meta.url), "utf8")).replace(/\r\n/g, "\n").trimEnd();
  const block = html.match(/<style data-notes-layout>\r?\n([\s\S]*?)\r?\n\s*<\/style>/);
  assert.ok(block, "内联样式块还在");
  assert.equal(block[1].replace(/\r\n/g, "\n").trimEnd(), css, "面板靠内联样式，跟 quick-notes.css 必须一致");
  assert.doesNotMatch(html, /notes-layout\.css/);
});

test("列表分组标记可点：点一下只看该组、再点取消，与下拉同步", async () => {
  const ui = await readFile(new URL("../ui/assets/quick-notes.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../ui/assets/quick-notes.css", import.meta.url), "utf8");
  // 分组标记是按钮不是死 span，点击走 setGroup 切换。
  assert.match(ui, /notes-chip notes-chip-group/);
  assert.match(ui, /controller\.setGroup\(controller\.state\.group === item\.group \? "" : item\.group\)/);
  // 点分组主动收起新建区，且有保护期躲开筛选夹顶的弹回。
  assert.match(ui, /holdExpandUntil = Date\.now\(\) \+ 400; setCollapsed\(true\)/);
  assert.match(ui, /top <= 1 && Date\.now\(\) > holdExpandUntil/);
  assert.match(ui, /aria-pressed/);
  // 可点与选中态的样式需要在（内联与外链两份都由同步测试盯着）。
  assert.match(css, /\.notes-chip-group \{[^}]*cursor: pointer/);
  assert.match(css, /\.notes-chip-group\[aria-pressed="true"\]/);
});
