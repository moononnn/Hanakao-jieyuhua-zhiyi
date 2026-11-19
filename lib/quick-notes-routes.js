// 随手记的路由。
//
// 路由只管收发，数据在 lib/quick-notes.js 那边；发送用 lib/send.js 的
// sendWithBusyRetry（带 busy 退避），不走 sendToConversation——那个会把换行压平、
// 还有 500 字上限，随手记的原文不能被削。
//
// 发送的判定口径（别改松）：
//   明确接住（result.accepted === true 且 result.ok !== false）才算送出去了；
//   明确拒绝或权限失败 → 解锁，让用户能再试；
//   超时/结果不明 → 保留 uncertain 锁，提示先看对话，不给自动重试。

import { QuickNotesError, createQuickNotesStore } from "./quick-notes.js";
import { friendlySendError, sendWithBusyRetry } from "./send.js";

const DENIED_PATTERN = /APP_CAPABILITY_DENIED|APP_PERMISSION|capability|not_asked|denied|权限/i;
const GONE_PATTERN = /no.?such|not.?found|不存在|已归档|no_session/i;
const BUSY_PATTERN = /busy|还在回复/i;

/** 这次失败是「明确没发出去」还是「不知道发没发出去」。 */
export function classifySendFailure(error) {
  const raw = `${error?.code || ""} ${error?.message || ""}`;
  if (DENIED_PATTERN.test(raw)) return "rejected";
  if (GONE_PATTERN.test(raw)) return "rejected";
  if (BUSY_PATTERN.test(raw)) return "rejected";
  return "uncertain";
}

function statusForCode(code) {
  switch (code) {
    case "bad_body":
    case "invalid_boolean":
    case "invalid_text":
    case "empty_text":
    case "too_long":
    case "invalid_group":
    case "group_too_long":
    case "invalid_revision":
    case "no_session":
      return 400;
    case "not_found":
      return 404;
    case "conflict":
    case "delivery_locked":
    case "already_sent":
      return 409;
    default:
      return 503;
  }
}

async function readBody(c) {
  try {
    return await c.req.json();
  } catch {
    throw new QuickNotesError("bad_body", "参数读不出来。");
  }
}

export function registerQuickNotesRoutes(app, sdk, store) {
  const notes = store || createQuickNotesStore(sdk);

  const fail = (c, error) => {
    const code = error instanceof QuickNotesError ? error.code : "failed";
    const message = error instanceof QuickNotesError
      ? error.message
      : "随手记这次没成，再试一次。";
    const payload = { ok: false, code, error: message };
    if (error?.item) payload.item = error.item;
    return c.json(payload, statusForCode(code));
  };

  app.get("/quick-notes", async (c) => {
    try {
      const result = await notes.list();
      return c.json({
        ok: true,
        items: result.items,
        storageOk: result.storageOk !== false,
        error: result.error || undefined,
      });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/quick-notes/create", async (c) => {
    try {
      const body = await readBody(c);
      const result = await notes.create({ text: body?.text, group: body?.group });
      return c.json({ ok: true, item: result.item });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/quick-notes/update", async (c) => {
    try {
      const body = await readBody(c);
      const result = await notes.update({
        id: body?.id,
        revision: body?.revision,
        text: body?.text,
        group: body?.group,
      });
      return c.json({ ok: true, item: result.item });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/quick-notes/pin", async (c) => {
    try {
      const body = await readBody(c);
      const result = await notes.setPinned({
        id: body?.id,
        revision: body?.revision,
        pinned: body?.pinned,
      });
      return c.json({ ok: true, item: result.item });
    } catch (error) {
      return fail(c, error);
    }
  });

  app.post("/quick-notes/done", async (c) => {
    try {
      const body = await readBody(c);
      const result = await notes.setDone({
        id: body?.id,
        revision: body?.revision,
        done: body?.done,
      });
      return c.json({ ok: true, item: result.item });
    } catch (error) {
      return fail(c, error);
    }
  });

  // 发到当前对话。sessionId 由前端在点击那一刻取真实面板会话带上来，
  // 这里只认这一个值：空的直接拒发，绝不替它挑一段「最近的对话」。
  app.post("/quick-notes/send", async (c) => {
    let body;
    try {
      body = await readBody(c);
    } catch (error) {
      return fail(c, error);
    }
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
    if (!sessionId) {
      return c.json({
        ok: false,
        code: "no_session",
        error: "没认出这是哪段对话，这次没发。收起面板重新打开再来。",
      }, 400);
    }

    let locked;
    try {
      locked = await notes.beginDelivery({
        id: body?.id,
        revision: body?.revision,
        sessionId,
      });
    } catch (error) {
      return fail(c, error);
    }
    const item = locked.item;

    let result;
    try {
      // 原文照发：换行不压平，长度不砍（sendToConversation 会做那两件事，这里不能用）。
      result = await sendWithBusyRetry(sdk, {
        sessionId,
        scope: "all",
        text: item.text,
        deliverAs: "followUp",
      });
    } catch (error) {
      const kind = classifySendFailure(error);
      if (kind === "uncertain") {
        const pending = await notes.markUncertain({ id: item.id, sessionId,
          message: "发送结果未确认，请先检查对话，避免重复发送。" }).catch(() => null);
        return c.json({ ok: false, code: "uncertain", uncertain: true, item: pending?.item,
          error: "没确认送没送出去。先去对话里看一眼，别重复发。" }, 202);
      }
      const rejected = await notes.rejectDelivery({ id: item.id, sessionId,
        message: friendlySendError(error) }).catch(() => null);
      return c.json({
        ok: false,
        code: "rejected",
        item: rejected?.item,
        sent: false,
        error: friendlySendError(error),
      }, 502);
    }

    const accepted = result?.accepted === true && result?.ok !== false
      && (!result.sessionId || result.sessionId === sessionId);
    if (!accepted && result?.ok !== false && result?.accepted !== false) {
      const pending = await notes.markUncertain({ id: item.id, sessionId,
        message: "宿主没有确认接收，请先检查对话，避免重复发送。" });
      return c.json({ ok: false, code: "uncertain", uncertain: true, item: pending.item,
        error: "宿主没有确认接收，请先检查对话，避免重复发送。" }, 202);
    }
    if (!accepted) {
      const rejected = await notes.rejectDelivery({ id: item.id, sessionId,
        message: String(result?.error || "对方没接住。") }).catch(() => null);
      return c.json({
        ok: false,
        code: "rejected",
        item: rejected?.item,
        sent: false,
        error: String(result?.error || "没送出去，再试一次。"),
      }, 502);
    }

    // 明确接住了才标记已处理；状态没落盘要如实说，不能装作已经更新。
    let done;
    try { done = await notes.completeDelivery({ id: item.id, sessionId }); }
    catch { return c.json({ ok: true, sent: true, archived: false,
      error: "宿主已接收，但已处理状态未确认。请先检查对话，不要重复发送。" }); }
    if (done.persisted === false) {
      return c.json({
        ok: true,
        sent: true,
        archived: false,
        item: done.item,
        error: "已发送，但「已处理」状态没存上。请先检查对话，不要重复发送。",
      });
    }
    return c.json({ ok: true, sent: true, archived: true, item: done.item });
  });

  return notes;
}
