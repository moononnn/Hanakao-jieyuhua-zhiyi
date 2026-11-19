export const QUICK_NOTES_DRAFT_PREFIX = "zhiyi.quickNotes.draft.";
export const QUICK_NOTES_TEXT_MAX = 20000;
export const QUICK_NOTES_GROUP_MAX = 40;
export const quickNotesDraftKey = (sessionId) => QUICK_NOTES_DRAFT_PREFIX + (sessionId || "none");
const isLocked = (item) => ["sending", "uncertain"].includes(item?.delivery?.state);
const sortItems = (items) => [...items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);

// 控制器不依赖 DOM，测试不会真的发消息或写系统剪贴板。
export function createQuickNotesController({ api, clipboard, storage, onChange = () => {} } = {}) {
  const state = { items: [], sessionId: "", draft: "", draftGroup: "", edits: {}, tab: "todo", query: "",
    expandedId: "", status: "", statusTone: "plain", storageWarning: storage ? "" : "草稿暂时只能留在内存，关闭页面前请记下或复制。",
    loading: false, saving: false, pending: new Set() };
  const memoryDrafts = new Map();
  let initialized = false;
  const notify = () => onChange(state);
  function status(message, tone = "plain") { state.status = message; state.statusTone = tone; }
  function writeDraft() {
    const draft = { text: state.draft, group: state.draftGroup, edits: structuredClone(state.edits) };
    memoryDrafts.set(state.sessionId, draft);
    try { storage?.setItem(quickNotesDraftKey(state.sessionId), JSON.stringify(draft)); }
    catch { state.storageWarning = "草稿没有存上，仍留在内存。关闭页面前请记下或复制。"; }
  }
  function setSession(sessionId) {
    const next = typeof sessionId === "string" ? sessionId.trim() : "";
    if (initialized && next === state.sessionId) return;
    if (initialized) writeDraft();
    state.sessionId = next;
    let draft = memoryDrafts.get(next);
    if (!draft) {
      try { draft = JSON.parse(storage?.getItem(quickNotesDraftKey(next)) || "null"); }
      catch { state.storageWarning = "草稿暂时读不出来。请勿清理浏览器数据，记下的笔记不受影响。"; }
    }
    state.draft = typeof draft?.text === "string" ? draft.text : "";
    state.draftGroup = typeof draft?.group === "string" ? draft.group : "";
    state.edits = {};
    for (const [id, edit] of Object.entries(draft?.edits || {})) {
      if (edit && typeof edit.text === "string" && typeof edit.group === "string" && Number.isSafeInteger(edit.revision)) state.edits[id] = edit;
    }
    state.expandedId = "";
    state.status = "";
    initialized = true;
    notify();
  }
  function mergeItem(item) {
    if (!item?.id) return;
    state.items = sortItems([...state.items.filter((row) => row.id !== item.id), item]);
  }
  function editDraft(item, patch) {
    const edit = state.edits[item.id] || { text: item.text, group: item.group, revision: item.revision };
    state.edits[item.id] = { ...edit, ...patch };
    writeDraft();
  }
  const dirty = (item) => {
    const edit = state.edits[item.id];
    return !!edit && (edit.text !== item.text || edit.group !== item.group);
  };
  async function load() {
    if (state.loading) return;
    state.loading = true; notify();
    try {
      const payload = await api.request("/quick-notes");
      if (payload?.ok !== true) throw new Error(payload?.error || "随手记暂时读不出来，原稿还留着。");
      state.items = sortItems(payload.items);
      if (payload.storageOk === false) status("有状态尚未存好，请稍后重试；不要重复发送。", "warn");
      return payload;
    } catch (error) { status(error.message || "读取失败，请重试。", "warn"); }
    finally { state.loading = false; notify(); }
  }
  async function save() {
    if (state.saving) return { ok: false, code: "saving" };
    if (!state.draft.trim()) { status("先写点什么。", "warn"); notify(); return { ok: false }; }
    const sessionId = state.sessionId;
    const text = state.draft, group = state.draftGroup;
    state.saving = true; status("正在记下…"); notify();
    try {
      const payload = await api.request("/quick-notes/create", { method: "POST", body: { text, group } });
      if (!payload?.ok) throw new Error(payload?.error || "没记上，原稿还留着。");
      mergeItem(payload.item);
      // 请求期间继续写字或切换会话时，不清掉后来的稿子。
      if (state.sessionId === sessionId) {
        if (state.draft === text && state.draftGroup === group) { state.draft = ""; state.draftGroup = ""; writeDraft(); }
        status("已记下。", "ok");
      } else {
        const draft = memoryDrafts.get(sessionId);
        if (draft?.text === text && draft?.group === group) {
          const cleared = { ...draft, text: "", group: "" }; memoryDrafts.set(sessionId, cleared);
          try { storage?.setItem(quickNotesDraftKey(sessionId), JSON.stringify(cleared)); } catch { /* 原稿留存比误清安全 */ }
        }
      }
      return payload;
    } catch (error) { if (state.sessionId === sessionId) status(error.message, "warn"); return { ok: false }; }
    finally { state.saving = false; notify(); }
  }
  async function action(item, kind) {
    if (state.pending.has(item.id)) return { ok: false, code: "pending" };
    const sessionId = state.sessionId;
    if (kind === "send" && (!sessionId || dirty(item) || isLocked(item) || item.done || item.delivery.state === "sent")) {
      status(!sessionId ? "没认出当前对话，这次没发。" : "请先保存修改或检查上次的发送结果。", "warn"); notify(); return { ok: false };
    }
    const edit = state.edits[item.id];
    const body = { id: item.id, revision: kind === "update" && edit ? edit.revision : item.revision };
    if (kind === "update") Object.assign(body, { text: edit?.text ?? item.text, group: edit?.group ?? item.group });
    if (kind === "send") body.sessionId = sessionId;
    if (kind === "pin") body.pinned = !item.pinned;
    if (kind === "done") body.done = !item.done;
    state.pending.add(item.id);
    status(kind === "send" ? "正在交给当前对话…" : kind === "done"
      ? item.done ? "正在移回待处理…" : "正在标记已处理…"
      : "正在保存…");
    notify();
    let received = false;
    try {
      const payload = await api.request(`/quick-notes/${kind}`, { method: "POST", body });
      received = true;
      if (payload?.item) mergeItem(payload.item);
      if (kind === "send" && payload?.sent === true && !payload.item) {
        mergeItem({ ...item, delivery: { ...item.delivery, state: "sent" } });
      }
      if (kind === "send" && payload?.uncertain && !payload.item) {
        mergeItem({ ...item, delivery: { ...item.delivery, state: "uncertain" } });
      }
      if (!payload?.ok) throw new Error(payload?.error || "没完成，请重试。");
      if (kind === "update" && state.sessionId === sessionId && state.edits[item.id] === edit) {
        delete state.edits[item.id]; writeDraft();
      }
      if (state.sessionId === sessionId && (kind === "send" || kind === "done")) state.expandedId = "";
      if (state.sessionId === sessionId) {
        const done = payload?.item?.done ?? body.done ?? !item.done;
        status(kind === "send"
          ? payload.archived ? "已交给当前对话，并标记已处理。" : payload.error || "已发送，但已处理状态未确认，请勿重发。"
          : kind === "done" ? done ? "已移到『已处理』。" : "已移回待处理。"
            : "已保存。", payload.archived === false ? "warn" : "ok");
      }
      return payload;
    } catch (error) {
      // HTTP 断线时后台可能已经收到，前端同样先锁住，刷新后以持久化状态为准。
      if (kind === "send" && !received) {
        mergeItem({ ...item, delivery: { ...item.delivery, state: "uncertain" } });
      }
      if (state.sessionId === sessionId) status(error.message || "操作未确认，请刷新查看。", "warn");
      return { ok: false };
    } finally { state.pending.delete(item.id); notify(); }
  }
  async function copy(item) {
    try {
      if (!clipboard?.writeText) throw new Error("当前界面不能访问剪贴板。");
      await clipboard.writeText({ text: state.edits[item.id]?.text ?? item.text });
      status("已复制，可以粘贴到输入框修改。", "ok"); notify(); return { ok: true };
    } catch (error) { status(error.message || "复制失败，请重试。", "warn"); notify(); return { ok: false }; }
  }
  return { state, load, save, copy, action, setSession, dirty, editDraft, mergeItem, notify,
    setDraft(text) { state.draft = text; writeDraft(); },
    setDraftGroup(group) { state.draftGroup = group; writeDraft(); },
    discardEdit(id) { delete state.edits[id]; writeDraft(); notify(); },
    setTab(tab) { state.tab = tab; notify(); }, setQuery(query) { state.query = query; notify(); },
    setExpanded(id) { state.expandedId = state.expandedId === id ? "" : id; notify(); },
    visibleItems() { const query = state.query.toLowerCase().trim(); return state.items.filter((item) => item.done === (state.tab === "done") && `${item.text}\n${item.group}`.toLowerCase().includes(query)); },
  };
}

/* 面板这一层：业务归控制器，这里只管长什么样。
 *
 * 结构分两层：
 *   列表 —— 页面头、输入框、操作区钉着不动，只有列表滚；
 *   详情 —— 默认是阅读（正文原样显示，保留换行和空格），
 *           点「编辑」才出正文框和分组框，保存/还原在编辑态里；
 *           详情里再点「返回记录」回到列表，列表里的「小工具」回到格子页。
 *
 * editingId 只活在这一次打开面板里，不进控制器：切会话就清掉，
 * 免得把上一段对话的编辑态带过来。
 */
export function initQuickNotes({ hana, getSessionId, onLayout } = {}) {
  const doc = document;
  const byId = (id) => doc.getElementById(`notes-${id}`);
  const view = byId("view"), input = byId("input"), groupInput = byId("group"), save = byId("save"), list = byId("list");
  let storage = null;
  try { storage = globalThis.localStorage; } catch { /* 控制器显示草稿不可持久化提示 */ }
  let visible = false, lastListKey = "", editingId = "";
  const controller = createQuickNotesController({
    api: { async request(path, init = {}) {
      const response = await hana.api.fetch(path, { method: init.method || "GET",
        headers: init.body ? { "content-type": "application/json" } : undefined,
        body: init.body ? JSON.stringify(init.body) : undefined });
      const payload = await response.json();
      if (!response.ok && payload?.ok === true) throw new Error("后台状态异常，请刷新确认。");
      return payload;
    } }, clipboard: hana.clipboard, storage, onChange: render,
  });
  function button(text, run, className = "notes-btn", disabled = false) {
    const node = doc.createElement("button"); node.type = "button"; node.className = className;
    node.textContent = text; node.disabled = disabled; node.addEventListener("click", run); return node;
  }
  function chip(text, variant = "") {
    const node = doc.createElement("span"); node.className = variant ? `notes-chip ${variant}` : "notes-chip";
    node.textContent = text; return node;
  }
  function timeLabel(item) {
    const date = new Date(item.createdAt);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  const firstLine = (text) => String(text || "").trim().split("\n")[0].slice(0, 80);

  /* 列表里的一条：标题一行，下面是标签、时间、置顶这些小字。 */
  function buildListItem(item) {
    const li = doc.createElement("li"); li.className = "notes-item"; li.dataset.id = item.id;
    li.classList.toggle("is-done", !!item.done); li.dataset.pinned = String(!!item.pinned);
    const open = button(firstLine(item.text), () => openDetail(item.id), "notes-item-open");
    open.setAttribute("aria-expanded", "false");
    li.append(open);
    const meta = doc.createElement("div"); meta.className = "notes-item-meta";
    if (item.group) meta.append(chip(item.group));
    const time = doc.createElement("span"); time.className = "notes-time"; time.textContent = timeLabel(item);
    meta.append(time);
    if (item.pinned) meta.append(chip("置顶", "notes-chip-pin"));
    if (controller.dirty(item)) meta.append(chip("未保存", "notes-chip-dirty"));
    li.append(meta);
    return li;
  }

  /* 详情：默认阅读态，正文用 textContent 写进去，换行和空格都留着。 */
  function buildDetail(item) {
    const li = doc.createElement("li"); li.className = "notes-item is-detail"; li.dataset.id = item.id;
    li.dataset.pinned = String(!!item.pinned);
    const pending = controller.state.pending.has(item.id), locked = isLocked(item);
    const edit = controller.state.edits[item.id];
    const editing = editingId === item.id;
    let selectionTarget;

    const head = doc.createElement("div"); head.className = "notes-detail-head";
    const back = button("‹ 返回记录", () => closeDetail(), "notes-detail-back");
    back.setAttribute("aria-label", "返回记录列表");
    const meta = doc.createElement("div"); meta.className = "notes-detail-meta";
    if (item.group) meta.append(chip(item.group));
    const time = doc.createElement("span"); time.className = "notes-time"; time.textContent = timeLabel(item);
    meta.append(time);
    if (item.pinned) meta.append(chip("置顶", "notes-chip-pin"));
    head.append(back, meta);
    if (!editing) {
      const editBtn = button("编辑", () => { editingId = item.id; controller.notify(); }, "notes-btn notes-edit-trigger");
      head.append(editBtn);
    }
    li.append(head);

    const send = button(pending ? "处理中…" : "发送", () => {
      applySession(getSessionId());
      void controller.action(item, "send");
    }, "notes-btn notes-btn-primary", pending || locked || item.done || item.delivery.state === "sent" || controller.dirty(item));
    send.title = "发到当前对话；伙伴忙时等本轮结束后送入";
    const doneBtn = button(item.done ? "移回待处理" : "标记已处理", () => void controller.action(item, "done"), "notes-btn notes-btn-done",
      pending || item.delivery.state === "sending");
    const selectAll = button("全选", () => {
      const target = selectionTarget;
      if (!target || target.disabled) {
        controller.state.status = "当前无法选中正文。";
        controller.state.statusTone = "warn";
        controller.notify();
        return;
      }
      target.focus({ preventScroll: true });
      if (editing) {
        if (typeof target.select === "function") target.select();
        else target.setSelectionRange(0, target.value.length);
      } else {
        const selection = doc.defaultView?.getSelection?.();
        if (!selection) {
          controller.state.status = "无法选中正文，请重试。";
          controller.state.statusTone = "warn";
          controller.notify();
          return;
        }
        const range = doc.createRange();
        range.selectNodeContents(target);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      controller.state.status = "正文已全选，按 Ctrl+C 复制。";
      controller.state.statusTone = "ok";
      controller.notify();
    }, "notes-btn notes-select-all", editing && (pending || locked));
    selectAll.title = "全选笔记正文，按 Ctrl+C 复制";
    const note = doc.createElement("p"); note.className = "notes-item-note";

    if (editing) {
      const text = doc.createElement("textarea"); text.className = "notes-edit-text"; text.rows = 6;
      text.value = edit?.text ?? item.text; text.spellcheck = false;
      text.setAttribute("aria-label", "笔记正文"); text.maxLength = QUICK_NOTES_TEXT_MAX;
      selectionTarget = text;
      const group = doc.createElement("input"); group.className = "notes-edit-group";
      group.value = edit?.group ?? item.group;
      group.setAttribute("aria-label", "笔记分组"); group.placeholder = "分组（可不填）"; group.maxLength = QUICK_NOTES_GROUP_MAX;
      text.disabled = pending || locked; group.disabled = pending || locked;
      const saveEdit = button("保存修改", () => void saveEditDraft(item), "notes-btn notes-btn-primary", pending || locked || !controller.dirty(item));
      const discard = button("取消编辑", () => discardEdit(item), "notes-btn", pending);
      const editRow = doc.createElement("div"); editRow.className = "notes-edit-actions";
      editRow.append(saveEdit, discard);
      li.append(text, group, editRow);
      function refreshHint() {
        note.textContent = controller.dirty(item)
          ? "有修改待保存，请先保存再发送。"
          : "改完点「保存修改」；不想要了就「取消编辑」。";
      }
      function changed() {
        controller.editDraft(item, { text: text.value, group: group.value });
        saveEdit.disabled = pending || locked || !controller.dirty(item);
        discard.disabled = pending;
        send.disabled = pending || locked || item.done || item.delivery.state === "sent" || controller.dirty(item);
        refreshHint();
      }
      text.addEventListener("input", changed); group.addEventListener("input", changed);
      refreshHint();
    } else {
      const body = doc.createElement("div"); body.className = "notes-body";
      body.tabIndex = 0; body.setAttribute("aria-label", "笔记正文");
      body.textContent = item.text;
      selectionTarget = body;
      li.append(body);
      note.textContent = locked ? "发送结果未确认，请先检查对话；可以手动标记已处理。"
        : controller.dirty(item) ? "有修改待保存，请先保存再发送。"
        : item.delivery.state === "sent" ? "宿主已接收这条消息。"
        : item.done ? "已处理。" : "发到当前对话，接收后自动标记已处理；伙伴忙时会排队。";
    }

    const actions = doc.createElement("div"); actions.className = "notes-detail-actions";
    actions.append(send, selectAll, doneBtn);
    const secondary = doc.createElement("div"); secondary.className = "notes-secondary-actions";
    secondary.append(button(item.pinned ? "取消置顶" : "置顶", () => void controller.action(item, "pin"), "notes-link", pending));
    li.append(actions, secondary, note);
    return li;
  }

  function openDetail(id) {
    const item = controller.state.items.find((row) => row.id === id);
    // 恢复出来的草稿还挂在这条上，就直接回到编辑态。
    editingId = item && controller.state.edits[id] ? id : "";
    if (controller.state.expandedId !== id) controller.setExpanded(id);
    else controller.notify();
  }
  function closeDetail() {
    editingId = "";
    if (controller.state.expandedId) controller.setExpanded(controller.state.expandedId);
    else controller.notify();
  }
  async function saveEditDraft(item) {
    const sessionId = controller.state.sessionId;
    const result = await controller.action(item, "update");
    // 只收起本次保存的编辑器；旧会话的回包不能关闭后来打开的稿子。
    if (result?.ok === true && controller.state.sessionId === sessionId
      && editingId === item.id && !controller.state.edits[item.id]) {
      editingId = ""; controller.notify();
    }
  }
  function discardEdit(item) {
    editingId = "";
    controller.discardEdit(item.id);
  }
  function applySession(id) {
    // 换会话就清掉局部编辑态：上一段对话的编辑不该跟着走。
    const next = typeof id === "string" ? id.trim() : "";
    if (next !== controller.state.sessionId) editingId = "";
    controller.setSession(next);
  }

  function render() {
    const s = controller.state;
    // 草稿状态只在用户操作或会话切换时变化，保存后立即清空可见输入框。
    if (input.value !== s.draft) input.value = s.draft;
    if (groupInput.value !== s.draftGroup) groupInput.value = s.draftGroup;
    save.disabled = s.saving; save.textContent = s.saving ? "正在记下…" : "记下";
    byId("status").textContent = s.status; byId("status").dataset.tone = s.statusTone;
    byId("storage-note").textContent = s.storageWarning; byId("storage-note").hidden = !s.storageWarning;
    for (const tab of ["todo", "done"]) {
      const node = byId(`tab-${tab}`); node.classList.toggle("active", s.tab === tab);
      node.setAttribute("aria-pressed", String(s.tab === tab));
    }
    const rows = controller.visibleItems();
    const expanded = rows.find((item) => item.id === s.expandedId);
    view.querySelector('.notes-editor').hidden = !!expanded;
    view.querySelector('.notes-toolbar').hidden = !!expanded;
    // 只有列表内容真的变了才重建：编辑草稿不进 key，
    // 否则每敲一个字都会换掉 textarea，光标和滚动就没了。
    const key = JSON.stringify([s.items, s.tab, s.query, s.expandedId, [...s.pending].sort(), s.sessionId, editingId]);
    if (key !== lastListKey) {
      const scrollTop = list.scrollTop;
      list.replaceChildren(...(expanded ? [buildDetail(expanded)] : rows.map(buildListItem)));
      list.scrollTop = scrollTop;
      lastListKey = key;
    }
    const empty = byId("empty"); empty.hidden = rows.length > 0;
    empty.textContent = s.loading ? "正在读取…" : s.query ? "没找到，换个词试试。" : s.tab === "done" ? "已处理的想法会收在这里。" : "还没记东西，先把刚才的想法留下。";
    if (visible) onLayout?.();
  }
  input.addEventListener("input", () => controller.setDraft(input.value));
  groupInput.addEventListener("input", () => controller.setDraftGroup(groupInput.value));
  save.addEventListener("click", () => void controller.save());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.ctrlKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void controller.save(); }
  });
  for (const tab of ["todo", "done"]) byId(`tab-${tab}`).addEventListener("click", () => controller.setTab(tab));
  byId("search").addEventListener("input", (event) => controller.setQuery(event.target.value));
  byId("refresh").addEventListener("click", () => void controller.load());
  return { controller,
    show() {
      visible = true; view.hidden = false;
      applySession(getSessionId());
      const expandedId = controller.state.expandedId;
      editingId = expandedId && controller.state.edits[expandedId] ? expandedId : "";
      render();
      if (!expandedId) input.focus();
      void controller.load();
    },
    hide() { visible = false; view.hidden = true; },
    setSession(id) { applySession(id); },
  };
}
