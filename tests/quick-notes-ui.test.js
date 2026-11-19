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
