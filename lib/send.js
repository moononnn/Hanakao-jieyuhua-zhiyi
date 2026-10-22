// 往当前对话里发一句话：等 ta 说完再发，或立刻插话。
//
// 从旧插件 lib/send.js（claimAndSend）和 lib/queue-insert.js（QueueInsertManager）搬过来，
// 但**状态机整个删掉了**。理由：旧版要自己写轮询、退避、认领、语境漂移作废、超时对账，
// 是因为当时 `session:send` 没有排队语义。现在宿主自带 `deliverAs`：
//   'followUp' → 排队，等这一轮结束后再发（旧的「等 ta 说完再发」）
//   'steer'    → 立刻插话，不等
// 所以发一次，宿主排；旧版那 300 行自己维护的队列可以直接不要。
//
// 仍然保留的两条旧经验：
//   1. 会话忙是常态不是错误，按 2s/5s/10s 退避重试三次；
//   2. 定位会话只能用 sessionId（sessionPath 会被宿主拒，见 session-title.js 的注释）。

export const QUEUE_TEXT_MAX = 500;
const SEND_TIMEOUT_MS = 12_000;
const BUSY_RETRY_DELAYS = [2000, 5000, 10000];
const SESSION_LIST_TIMEOUT_MS = 8000;

export class SendError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SendError";
    this.code = code;
  }
}

export function friendlySendError(error) {
  const raw = `${error?.code || ""} ${error?.message || ""}`;
  if (/send_aborted/.test(raw)) return "这次没发出去：断点续接已经关掉，或那几轮已经不算数了。";
  if (/app\/session\.start-turn/i.test(raw)) {
    return "知意尚未获准发起新一轮对话，请在 Hana 的应用权限中查看这项授权。";
  }
  if (/APP_CAPABILITY_DENIED|APP_PERMISSION|capability|not_asked|denied/i.test(raw)) {
    return "知意还没有「管理会话」这项权限。去 Hana「设置 → 应用 → 解语花·知意 → 应用权限」里允许后再试。";
  }
  if (/busy/i.test(raw)) return "ta 还在回复，等这一轮结束了再发。";
  if (/not.?found|no such|不存在|已归档/i.test(raw)) return "找不到要发进的那段对话了。";
  if (/timeout|超时/i.test(raw)) return "发送超时了，再试一次。";
  return "没发出去，再试一次。";
}

export function normalizeQueuedText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function resolveDeliverAs(mode) {
  return mode === "steer" ? "steer" : "followUp";
}

export async function newestSession(sdk) {
  let result;
  try {
    result = await Promise.race([
      sdk.bus.request("session:list", { scope: "all" }, { timeoutMs: SESSION_LIST_TIMEOUT_MS }),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new SendError("timeout", "会话名单超时了。")), SESSION_LIST_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    throw new SendError(error?.code || "list_failed", `读不到会话名单：${friendlySendError(error)}`);
  }
  const sessions = Array.isArray(result) ? result : result?.sessions;
  const rows = (Array.isArray(sessions) ? sessions : [])
    .map((item) => ({
      sessionId: String(item?.sessionId || item?.session_id || "").trim(),
      agentId: String(item?.agentId || ""),
      agentName: String(item?.agentName || "").trim(),
      modified: Number(item?.modified ?? 0) || 0,
    }))
    .filter((row) => row.sessionId);
  if (!rows.length) throw new SendError("no_session", "找不到可以发话的对话。");
  return rows.reduce((a, b) => (b.modified > a.modified ? b : a));
}

/**
 * 带 busy 退避的发送。
 * guard：每次**真正**发出去之前跑一次，返回 false 就当场收手。
 * 只在进入前检查一次是不够的——busy 退避要等好几秒，这期间总开关可能已经被关掉。
 */
export async function sendWithBusyRetry(sdk, payload, { onRetry = null, guard = null } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (typeof guard === "function" && !(await guard())) {
      throw new SendError("send_aborted", "这次不发了。");
    }
    try {
      return await Promise.race([
        sdk.bus.request("session:send", payload, { timeoutMs: SEND_TIMEOUT_MS }),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new SendError("timeout", "发送超时了。")), SEND_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      const busy = /busy/i.test(`${error?.code || ""} ${error?.message || ""}`);
      if (!busy || attempt >= BUSY_RETRY_DELAYS.length) throw error;
      if (typeof onRetry === "function") onRetry(attempt, BUSY_RETRY_DELAYS[attempt]);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, BUSY_RETRY_DELAYS[attempt]);
        timer.unref?.();
      });
    }
  }
}

/**
 * 往一段对话里发话。
 * mode='followUp'（默认）= 等 ta 说完再发；mode='steer' = 立刻插话。
 */
export async function sendToConversation(sdk, { text, mode = "followUp", sessionId = "", beforeSend = null } = {}) {
  const body = normalizeQueuedText(text);
  if (!body) throw new SendError("empty", "写点什么再发嘛。");
  if (body.length > QUEUE_TEXT_MAX) throw new SendError("too_long", `太长了，精简到 ${QUEUE_TEXT_MAX} 字以内吧。`);

  const target = sessionId ? { sessionId, agentName: "" } : await newestSession(sdk);
  const payload = {
    sessionId: target.sessionId,
    scope: "all",
    text: body,
    deliverAs: resolveDeliverAs(mode),
  };

  let result;
  try {
    result = await sendWithBusyRetry(sdk, payload, { guard: beforeSend });
  } catch (error) {
    throw new SendError(error?.code || "send_failed", friendlySendError(error), error);
  }
  if (result?.ok === false || result?.accepted === false) {
    throw new SendError("send_failed", String(result?.error || "没发出去，再试一次。"));
  }
  return {
    ok: true,
    text: body,
    mode: payload.deliverAs,
    sessionId: String(result?.sessionId || target.sessionId),
    agentName: target.agentName || "",
  };
}
