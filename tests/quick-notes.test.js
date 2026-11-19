// 随手记：库 + 路由（node:test，零依赖）。
//
// 这里不碰真实存储、不碰真实总线：存储和 session:send 都是假的。
// 重点盯住几件事：
//   1. 记下的东西真的落盘，重开还在；
//   2. 两个人同时记不互相覆盖；带版本号的编辑对不上就拒绝，不覆盖别人改过的；
//   3. 存储出错不许装作空库，也不许丢原文；
//   4. 发送：原文带换行照发、会话编号一个字不差、没会话就不发；
//   5. 明确接住才划掉；明确拒绝/权限失败解锁；超时/结果不明保留锁；
//   6. 收好落盘失败要说清楚，并且留下持久化的 sending 防下次误重发。

import test from "node:test";
import assert from "node:assert/strict";
import {
  QUICK_NOTES_GROUP_MAX,
  QUICK_NOTES_TEXT_MAX,
  QuickNotesError,
  createQuickNotesStore,
} from "../lib/quick-notes.js";
import { registerQuickNotesRoutes } from "../lib/quick-notes-routes.js";

function createSdk({ failGet = false, failSet = false, send } = {}) {
  const disk = new Map();
  const calls = [];
  const sdk = {
    disk,
    calls,
    storage: {
      global: {
        get: async (key, fallback = null) => {
          if (failGet) throw new Error("storage is down");
          return disk.has(key) ? JSON.parse(disk.get(key)) : fallback;
        },
        set: async (key, value) => {
          if (failSet) throw new Error("disk full");
          disk.set(key, JSON.stringify(value));
        },
      },
    },
    bus: {
      request: async (type, payload) => {
        calls.push({ type, payload });
        if (type === "session:send") {
          if (typeof send === "function") return send(payload);
          return { ok: true, accepted: true, sessionId: payload.sessionId };
        }
        throw new Error(`unexpected bus call: ${type}`);
      },
    },
  };
  return sdk;
}

function createHarness(sdk) {
  const routes = new Map();
  const app = {
    get: (path, handler) => routes.set(`GET ${path}`, handler),
    post: (path, handler) => routes.set(`POST ${path}`, handler),
  };
  const store = registerQuickNotesRoutes(app, sdk);
  const call = async (method, path, body) => {
    const handler = routes.get(`${method} ${path}`);
    if (!handler) throw new Error(`route not registered: ${method} ${path}`);
    const context = {
      req: { json: async () => body, query: () => undefined },
      json: (payload, status = 200) => ({ payload, status }),
    };
    return handler(context);
  };
  return { app, store, call };
}

test("记一条就落盘，重开还在", async () => {
  const sdk = createSdk();
  const { store } = createHarness(sdk);
  const created = await store.create({ text: "第一行\n第二行", group: "买" });
  assert.equal(created.persisted, true);
  assert.equal(created.item.text, "第一行\n第二行");
  assert.equal(created.item.group, "买");
  assert.equal(created.item.done, false);
  assert.equal(created.item.revision, 1);
  assert.ok(created.item.id);

  // 换个进程（同一条存储）再读：还在。
  const reopened = createQuickNotesStore(sdk);
  const listed = await reopened.list();
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].text, "第一行\n第二行");
  assert.equal(listed.items[0].group, "买");
});

test("改一条要带对的版本号：对不上就拒绝，原文不被覆盖", async () => {
  const sdk = createSdk();
  const { store } = createHarness(sdk);
  const { item } = await store.create({ text: "原稿" });

  const updated = await store.update({ id: item.id, revision: item.revision, text: "改过的" });
  assert.equal(updated.item.text, "改过的");
  assert.equal(updated.item.revision, item.revision + 1);

  // 拿旧版本号再改一次：拒绝，内容还是改过的那版。
  await assert.rejects(
    store.update({ id: item.id, revision: item.revision, text: "抢改的" }),
    (error) => {
      assert.equal(error.code, "conflict");
      return true;
    },
  );
  const listed = await store.list();
  assert.equal(listed.items[0].text, "改过的");
});

test("两个人同时记，互不覆盖", async () => {
  const sdk = createSdk();
  const { store } = createHarness(sdk);
  const [a, b] = await Promise.all([
    store.create({ text: "甲写的" }),
    store.create({ text: "乙写的" }),
  ]);
  assert.notEqual(a.item.id, b.item.id);
  const listed = await store.list();
  const texts = listed.items.map((row) => row.text).sort();
  assert.deepEqual(texts, ["乙写的", "甲写的"]);
  // 落盘的那份也得是两条，不是一条。
  const disk = JSON.parse(sdk.disk.get("quickNotes"));
  assert.equal(disk.items.length, 2);
});

test("空、太长、类型不对都要挡下来", async () => {
  const sdk = createSdk();
  const { store } = createHarness(sdk);
  await assert.rejects(store.create({ text: "   " }), (error) => error.code === "empty_text");
  await assert.rejects(store.create({ text: 123 }), (error) => error.code === "invalid_text");
  await assert.rejects(store.create({ text: "好" , group: 42 }), (error) => error.code === "invalid_group");
  await assert.rejects(
    store.create({ text: "字".repeat(QUICK_NOTES_TEXT_MAX + 1) }),
    (error) => error.code === "too_long",
  );
  await assert.rejects(
    store.create({ text: "好", group: "分".repeat(QUICK_NOTES_GROUP_MAX + 1) }),
    (error) => error.code === "group_too_long",
  );
  // 边界值是合法的。
  const ok = await store.create({ text: "字".repeat(QUICK_NOTES_TEXT_MAX) });
  assert.equal(ok.item.text.length, QUICK_NOTES_TEXT_MAX);
});

test("读存储失败不许装作空库", async () => {
  const sdk = createSdk({ failGet: true });
  const { call } = createHarness(sdk);
  const response = await call("GET", "/quick-notes");
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.code, "storage_read_failed");
  assert.match(response.payload.error, /不是空库/);
  assert.equal(response.payload.items, undefined, "读失败时不能端一个空数组当没有笔记");
});

test("写失败不提交半条记录，调用方仍可用原稿重试", async () => {
  const sdk = createSdk({ failSet: true });
  const { store, call } = createHarness(sdk);
  await assert.rejects(
    store.create({ text: "重要的那句" }),
    (error) => {
      assert.equal(error.code, "not_persisted");
      assert.equal(error.item, undefined);
      return true;
    },
  );
  // 路由也要如实报，并且把这条一起带回来。
  const response = await call("POST", "/quick-notes/create", { text: "另一句" });
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.code, "not_persisted");
  assert.equal(response.payload.item, undefined);
  const listed = await store.list();
  assert.equal(listed.storageOk, false);
  assert.equal(listed.items.length, 0, "没落盘不能作为已保存记录返回");
});

test("置顶、收好、拿回来都按版本号来", async () => {
  const sdk = createSdk();
  const { store } = createHarness(sdk);
  const { item } = await store.create({ text: "一条" });
  const pinned = await store.setPinned({ id: item.id, revision: item.revision, pinned: true });
  assert.equal(pinned.item.pinned, true);
  const done = await store.setDone({ id: item.id, revision: pinned.item.revision, done: true });
  assert.equal(done.item.done, true);
  const back = await store.setDone({ id: item.id, revision: done.item.revision, done: false });
  assert.equal(back.item.done, false);
  // 置顶的排前面。
  const second = await store.create({ text: "两条" });
  const listed = await store.list();
  assert.equal(listed.items[0].id, item.id);
  assert.notEqual(second.item.id, item.id);
});

test("路由：列表 / 新建 / 改 / 置顶 / 收好", async () => {
  const sdk = createSdk();
  const { call } = createHarness(sdk);
  const created = await call("POST", "/quick-notes/create", { text: "第一句", group: "g" });
  assert.equal(created.payload.ok, true);
  const item = created.payload.item;

  const listed = await call("GET", "/quick-notes");
  assert.equal(listed.payload.ok, true);
  assert.equal(listed.payload.items.length, 1);
  assert.equal(listed.payload.storageOk, true);

  const edited = await call("POST", "/quick-notes/update", {
    id: item.id, revision: item.revision, text: "改过的", group: "",
  });
  assert.equal(edited.payload.ok, true);
  assert.equal(edited.payload.item.text, "改过的");

  const pinned = await call("POST", "/quick-notes/pin", {
    id: item.id, revision: edited.payload.item.revision, pinned: true,
  });
  assert.equal(pinned.payload.item.pinned, true);

  const done = await call("POST", "/quick-notes/done", {
    id: item.id, revision: pinned.payload.item.revision, done: true,
  });
  assert.equal(done.payload.item.done, true);

  // 版本号对不上：409，别覆盖。
  const conflict = await call("POST", "/quick-notes/update", {
    id: item.id, revision: item.revision, text: "抢改的",
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.payload.code, "conflict");
});

test("发送：原文带换行照发，会话编号一个字不差", async () => {
  const sdk = createSdk();
  const { call, store } = createHarness(sdk);
  const { item } = await store.create({ text: "第一行\n第二行\n\n第四行" });
  const response = await call("POST", "/quick-notes/send", {
    id: item.id, revision: item.revision, sessionId: "sess-abc",
  });
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.sent, true);
  assert.equal(response.payload.archived, true);
  const sent = sdk.calls.find((row) => row.type === "session:send");
  assert.ok(sent, "应该真的调了 session:send");
  assert.equal(sent.payload.text, "第一行\n第二行\n\n第四行", "原文不能被压平");
  assert.equal(sent.payload.sessionId, "sess-abc");
  assert.equal(sent.payload.scope, "all");
  assert.equal(sent.payload.deliverAs, "followUp");
  // 明确接住才划掉收好。
  const listed = await store.list();
  assert.equal(listed.items[0].done, true);
  assert.equal(listed.items[0].delivery.state, "sent");
});

test("没有会话编号就不发（总线一次都不能被叫）", async () => {
  const sdk = createSdk();
  const { call, store } = createHarness(sdk);
  const { item } = await store.create({ text: "一句" });
  const response = await call("POST", "/quick-notes/send", { id: item.id, revision: item.revision });
  assert.equal(response.status, 400);
  assert.equal(response.payload.code, "no_session");
  assert.equal(sdk.calls.filter((row) => row.type === "session:send").length, 0);
  const listed = await store.list();
  assert.equal(listed.items[0].done, false);
});

test("明确拒绝：不划掉，解锁能再试", async () => {
  const sdk = createSdk({ send: () => ({ ok: false, accepted: false, error: "对方没接住" }) });
  const { call, store } = createHarness(sdk);
  const { item } = await store.create({ text: "一句" });
  const response = await call("POST", "/quick-notes/send", {
    id: item.id, revision: item.revision, sessionId: "sess-1",
  });
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.sent, false);
  const listed = await store.list();
  assert.equal(listed.items[0].done, false, "没送出去不许划掉");
  assert.equal(listed.items[0].delivery.state, "rejected", "明确拒绝要解锁");
});

test("权限失败：不划掉，也不当成已送达", async () => {
  const denied = Object.assign(new Error("Missing capability app/session.start-turn"), {
    code: "APP_CAPABILITY_DENIED",
  });
  const sdk = createSdk({ send: () => { throw denied; } });
  const { call, store } = createHarness(sdk);
  const { item } = await store.create({ text: "一句" });
  const response = await call("POST", "/quick-notes/send", {
    id: item.id, revision: item.revision, sessionId: "sess-1",
  });
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.sent, false);
  const listed = await store.list();
  assert.equal(listed.items[0].done, false);
  assert.equal(listed.items[0].delivery.state, "rejected");
});

test("超时/结果不明：保留锁，不自动重发", async () => {
  const timeout = Object.assign(new Error("发送超时了。"), { code: "timeout" });
  const sdk = createSdk({ send: () => { throw timeout; } });
  const { call, store } = createHarness(sdk);
  const { item } = await store.create({ text: "一句" });
  const response = await call("POST", "/quick-notes/send", {
    id: item.id, revision: item.revision, sessionId: "sess-1",
  });
  assert.equal(response.payload.ok, false);
  assert.equal(response.payload.uncertain, true);
  assert.match(response.payload.error, /先.*对话|别重复发/);
  const listed = await store.list();
  assert.equal(listed.items[0].done, false);
  assert.equal(listed.items[0].delivery.state, "uncertain");

  // 再点一次：被锁挡住，总线不能再被叫一次。
  const again = await call("POST", "/quick-notes/send", {
    id: item.id, revision: listed.items[0].revision, sessionId: "sess-1",
  });
  assert.equal(again.status, 409);
  assert.equal(again.payload.code, "delivery_locked");
  assert.equal(sdk.calls.filter((row) => row.type === "session:send").length, 1);
});

test("收好落盘失败：sent 为真、archived 为假，存盘里仍是 sending", async () => {
  const sdk = createSdk();
  const { call, store } = createHarness(sdk);
  const { item } = await store.create({ text: "一句" });
  // 归档那一次写盘让它失败。
  let writes = 0;
  const originalSet = sdk.storage.global.set;
  sdk.storage.global.set = async (key, value) => {
    writes += 1;
    if (writes >= 2) throw new Error("disk full");
    return originalSet(key, value);
  };
  const response = await call("POST", "/quick-notes/send", {
    id: item.id, revision: item.revision, sessionId: "sess-1",
  });
  assert.equal(response.payload.ok, true);
  assert.equal(response.payload.sent, true);
  assert.equal(response.payload.archived, false);
  assert.match(response.payload.error, /没存上/);
  // 存盘里的状态还是 sending：下次不会误重发。
  const disk = JSON.parse(sdk.disk.get("quickNotes"));
  assert.equal(disk.items[0].delivery.state, "sending");
  assert.equal(disk.items[0].done, false);
  void store;
});

test("App 重启看到 sending：按未确认显示，不自动发送", async () => {
  const sdk = createSdk();
  const { store } = createHarness(sdk);
  const { item } = await store.create({ text: "一句" });
  await store.beginDelivery({ id: item.id, revision: item.revision, sessionId: "sess-1" });
  // 进程在这里没了（没写完 delivery）。
  const reopened = createQuickNotesStore(sdk);
  const listed = await reopened.list();
  assert.equal(listed.items[0].delivery.state, "uncertain");
  assert.equal(listed.items[0].done, false);
  assert.equal(sdk.calls.filter((row) => row.type === "session:send").length, 0);
});

test("未知接收结果保留锁，不当成明确拒绝解锁", async () => {
  for (const reply of [null, {}, { ok: true }, { accepted: true, sessionId: "other-session" }]) {
    const sdk = createSdk({ send: () => reply });
    const { call, store } = createHarness(sdk);
    const { item } = await store.create({ text: "保持换行\n和空格  原样" });
    const result = await call("POST", "/quick-notes/send", { id: item.id, revision: item.revision, sessionId: "current" });
    assert.equal(result.payload.uncertain, true);
    const current = (await store.list()).items[0];
    assert.equal(current.done, false);
    const repeat = await call("POST", "/quick-notes/send", { id: item.id, revision: current.revision, sessionId: "current" });
    assert.equal(repeat.status, 409);
    assert.equal(sdk.calls.length, 1);
  }
});

test("双窗口同时发送只交给宿主一次，发送期间不可修改原文", async () => {
  let release;
  const sdk = createSdk({ send: () => new Promise((resolve) => { release = resolve; }) });
  const { call, store } = createHarness(sdk);
  const { item } = await store.create({ text: "旧稿" });
  const sending = call("POST", "/quick-notes/send", { ...item, sessionId: "session-a" });
  await new Promise((resolve) => setImmediate(resolve));
  const locked = (await store.list()).items[0];
  const duplicate = await call("POST", "/quick-notes/send", { ...locked, sessionId: "session-b" });
  assert.equal(duplicate.status, 409);
  await assert.rejects(store.update({ ...locked, text: "抢改" }), (error) => error.code === "delivery_locked");
  release({ accepted: true, ok: true });
  assert.equal((await sending).payload.archived, true);
  assert.equal(sdk.calls.length, 1);
  assert.equal(sdk.calls[0].payload.sessionId, "session-a");
});

test("读取损坏库或未知版本时不丢弃条目、不允许覆盖", async () => {
  for (const raw of [{ version: 2, items: [] }, { version: 1 }, { version: 1, items: [{ id: "broken" }] }]) {
    const sdk = createSdk();
    sdk.disk.set("quickNotes", JSON.stringify(raw));
    const store = createQuickNotesStore(sdk);
    await assert.rejects(store.create({ text: "新增" }), (error) => error.code === "storage_corrupt");
    assert.deepEqual(JSON.parse(sdk.disk.get("quickNotes")), raw);
  }
});

test("校验失败和写失败不泄漏半完成编辑；快照不能绕过版本校验", async () => {
  const sdk = createSdk();
  const store = createQuickNotesStore(sdk);
  const { item } = await store.create({ text: "原文", group: "原组" });
  await assert.rejects(store.update({ ...item, text: "半成品", group: 42 }));
  assert.equal((await store.list()).items[0].text, "原文");
  const originalSet = sdk.storage.global.set;
  sdk.storage.global.set = async () => { throw new Error("full"); };
  await assert.rejects(store.update({ ...item, text: "未落盘" }));
  const snapshot = (await store.list()).items[0];
  assert.equal(snapshot.text, "原文");
  snapshot.text = "外部篡改";
  assert.equal((await store.list()).items[0].text, "原文");
  sdk.storage.global.set = originalSet;
  const edited = await store.update({ ...item, text: "重试" });
  assert.equal(edited.item.text, "重试");
});

test("发送前的锁无法落盘时不调用宿主；发送后归档失败重启也不重发", async () => {
  const sdk = createSdk();
  const { store, call } = createHarness(sdk);
  const { item } = await store.create({ text: "原文" });
  const set = sdk.storage.global.set;
  sdk.storage.global.set = async () => { throw new Error("full"); };
  const refused = await call("POST", "/quick-notes/send", { ...item, sessionId: "target" });
  assert.equal(refused.payload.ok, false);
  assert.equal(sdk.calls.length, 0);
  let writes = 0;
  sdk.storage.global.set = async (...args) => { if (++writes > 1) throw new Error("full"); return set(...args); };
  const accepted = await call("POST", "/quick-notes/send", { ...item, sessionId: "target" });
  assert.equal(accepted.payload.sent, true);
  assert.equal(accepted.payload.archived, false);
  const reopened = createQuickNotesStore(sdk);
  const current = (await reopened.list()).items[0];
  await assert.rejects(reopened.beginDelivery({ ...current, sessionId: "target" }), (error) => error.code === "delivery_locked");
  assert.equal(sdk.calls.length, 1);
});

test("布尔值、版本、会话类型不对时拒绝，不强制转换", async () => {
  const sdk = createSdk();
  const { store, call } = createHarness(sdk);
  const { item } = await store.create({ text: "一句" });
  assert.equal((await call("POST", "/quick-notes/pin", { ...item, pinned: "true" })).status, 400);
  assert.equal((await call("POST", "/quick-notes/done", { ...item, done: "false" })).status, 400);
  assert.equal((await call("POST", "/quick-notes/send", { ...item, sessionId: {} })).status, 400);
  await assert.rejects(store.update({ ...item, revision: "1", text: "wrong" }), (error) => error.code === "invalid_revision");
});

test("QuickNotesError 带上自己的错误码", () => {
  const error = new QuickNotesError("conflict", "冲突了");
  assert.equal(error.name, "QuickNotesError");
  assert.equal(error.code, "conflict");
  assert.equal(error.message, "冲突了");
});
