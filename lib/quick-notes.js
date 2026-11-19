import { randomUUID } from "node:crypto";

export const QUICK_NOTES_KEY = "quickNotes";
export const QUICK_NOTES_VERSION = 1;
export const QUICK_NOTES_TEXT_MAX = 20000;
export const QUICK_NOTES_GROUP_MAX = 40;
const DELIVERY_STATES = ["none", "sending", "uncertain", "sent", "rejected"];
const emptyDelivery = () => ({ state: "none", sessionId: "", at: 0, message: "" });

export class QuickNotesError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "QuickNotesError";
    this.code = code;
    Object.assign(this, extra);
  }
}

export function validateQuickNoteText(value) {
  if (typeof value !== "string") throw new QuickNotesError("invalid_text", "内容得是文字。");
  if (!value.trim()) throw new QuickNotesError("empty_text", "还没写内容。");
  if (value.length > QUICK_NOTES_TEXT_MAX) throw new QuickNotesError("too_long", `内容最多 ${QUICK_NOTES_TEXT_MAX} 字，稿子还留着。`);
  return value; // 保留空格与换行，发送和复制都用原文。
}

export function validateQuickNoteGroup(value = "") {
  if (typeof value !== "string") throw new QuickNotesError("invalid_group", "分组得是文字。");
  if (value.trim().length > QUICK_NOTES_GROUP_MAX) throw new QuickNotesError("group_too_long", `分组最多 ${QUICK_NOTES_GROUP_MAX} 字。`);
  return value.trim();
}

export function sortQuickNotes(items) {
  return [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
}

// ponytail: 一个 App 进程一份库，串行写入即可防多窗口覆盖，不另建数据库。
export function createQuickNotesStore(sdk, { now = Date.now, makeId = randomUUID } = {}) {
  let items = null;
  let chain = Promise.resolve();
  let storageOk = true;
  function serialize(task) {
    const result = chain.then(task);
    chain = result.catch(() => {});
    return result;
  }
  async function ensureLoaded() {
    if (items !== null) return;
    let raw;
    try { raw = await sdk.storage.global.get(QUICK_NOTES_KEY, null); }
    catch { throw new QuickNotesError("storage_read_failed", "随手记暂时读不出来。这不是空库，没有覆盖原有内容。"); }
    if (raw == null) { items = []; return; }
    // 不丢弃坏条目或不认识的版本，避免下次保存时静默抹掉它们。
    const valid = raw.version === QUICK_NOTES_VERSION && Array.isArray(raw.items)
      && raw.items.every((item) => item && typeof item.id === "string" && item.id
        && typeof item.text === "string" && item.text.trim() && typeof item.group === "string"
        && Number.isSafeInteger(item.revision) && item.revision > 0
        && typeof item.done === "boolean" && typeof item.pinned === "boolean"
        && Number.isFinite(item.createdAt) && Number.isFinite(item.updatedAt)
        && DELIVERY_STATES.includes(item.delivery?.state));
    if (!valid || new Set(raw.items.map((item) => item.id)).size !== raw.items.length) {
      throw new QuickNotesError("storage_corrupt", "随手记数据格式不对，没有覆盖它。请先检查或恢复备份。");
    }
    items = structuredClone(raw.items).map((item) => item.delivery.state === "sending"
      ? { ...item, delivery: { ...item.delivery, state: "uncertain" } } : item);
  }
  function find(id, revision) {
    const item = items.find((row) => row.id === id);
    if (!item) throw new QuickNotesError("not_found", "这条已经不在了。");
    if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
      throw new QuickNotesError("invalid_revision", "请刷新记录后再试。");
    }
    if (item.revision !== revision) throw new QuickNotesError("conflict", "这条在别处被改过了，请刷新后再试；未保存的编辑稿还留着。", { item: structuredClone(item) });
    return item;
  }
  async function commit(next, { keepOnFailure = false } = {}) {
    try {
      await sdk.storage.global.set(QUICK_NOTES_KEY, { version: QUICK_NOTES_VERSION, items: structuredClone(next) });
      items = next;
      storageOk = true;
      return true;
    } catch {
      storageOk = false;
      // 宿主已经接收后的状态不能回滚成“可以再发”。磁盘上的 sending 也会阻止重发。
      if (keepOnFailure) { items = next; return false; }
      throw new QuickNotesError("not_persisted", "没存上，原稿还留着。请稍后重试，或先复制留存。");
    }
  }
  function unlocked(item) {
    if (["sending", "uncertain"].includes(item.delivery.state)) {
      throw new QuickNotesError("delivery_locked", "这条的发送结果尚未确认，请先检查对话。可以复制或手动收好，暂不修改和重发。", { item: structuredClone(item) });
    }
  }
  async function change(payload, patch) {
    return serialize(async () => {
      await ensureLoaded();
      const item = find(payload?.id, payload?.revision);
      const next = { ...item, ...patch(item), revision: item.revision + 1, updatedAt: now() };
      await commit(items.map((row) => row.id === item.id ? next : row));
      return { item: structuredClone(next), persisted: true };
    });
  }
  const list = () => serialize(async () => {
    await ensureLoaded();
    return { items: structuredClone(sortQuickNotes(items)), storageOk };
  });
  const create = (payload) => serialize(async () => {
    await ensureLoaded();
    const item = {
      id: makeId(), text: validateQuickNoteText(payload?.text), group: validateQuickNoteGroup(payload?.group),
      createdAt: now(), updatedAt: now(), revision: 1, pinned: false, done: false, delivery: emptyDelivery(),
    };
    await commit([...items, item]);
    return { item: structuredClone(item), persisted: true };
  });
  const update = (payload) => change(payload, (item) => {
    unlocked(item);
    const text = payload.text === undefined ? item.text : validateQuickNoteText(payload.text);
    const group = payload.group === undefined ? item.group : validateQuickNoteGroup(payload.group);
    // 明确改过一条已发送记录后，它才成为新的待发送内容。
    return { text, group, delivery: text !== item.text ? emptyDelivery() : item.delivery };
  });
  const setPinned = (payload) => change(payload, () => {
    if (typeof payload.pinned !== "boolean") throw new QuickNotesError("invalid_boolean", "置顶状态不对。");
    return { pinned: payload.pinned };
  });
  const setDone = (payload) => change(payload, (item) => {
    if (typeof payload.done !== "boolean") throw new QuickNotesError("invalid_boolean", "收好状态不对。");
    if (item.delivery.state === "sending") throw new QuickNotesError("delivery_locked", "正在发送，请等发送结果。");
    return { done: payload.done };
  });
  const beginDelivery = (payload) => change(payload, (item) => {
    unlocked(item);
    if (item.done || item.delivery.state === "sent") throw new QuickNotesError("already_sent", "这条已经收好或送出了，先拿回来再编辑。");
    if (typeof payload.sessionId !== "string" || !payload.sessionId.trim()) throw new QuickNotesError("no_session", "没认出当前对话，这次没发。");
    return { delivery: { state: "sending", sessionId: payload.sessionId, at: now(), message: "" } };
  });
  const finishDelivery = (payload, state) => serialize(async () => {
    await ensureLoaded();
    const item = items.find((row) => row.id === payload.id);
    if (!item || item.delivery.state !== "sending" || item.delivery.sessionId !== payload.sessionId) {
      throw new QuickNotesError("delivery_locked", "发送状态已变化，请刷新后检查对话。");
    }
    const next = { ...item, revision: item.revision + 1, updatedAt: now(), done: state === "sent" || item.done,
      delivery: { state, sessionId: payload.sessionId, at: now(), message: String(payload.message || "").slice(0, 200) } };
    const persisted = await commit(items.map((row) => row.id === item.id ? next : row), { keepOnFailure: true });
    return { item: structuredClone(next), persisted };
  });
  return {
    list, load: list, create, update, setPinned, setDone, beginDelivery,
    completeDelivery: (payload) => finishDelivery(payload, "sent"),
    rejectDelivery: (payload) => finishDelivery(payload, "rejected"),
    markUncertain: (payload) => finishDelivery(payload, "uncertain"),
  };
}
