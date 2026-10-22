// 球上作答之后，把答案送回原来那段对话。
//
// 为什么要这一层：宿主给工具执行的 RPC 只有 30 秒，而球上那套提问可以挂着
// 十分钟等用户慢慢想。两边尺度对不上，所以工具侧改成「送到就返回」，作答
// 改由这里轮询接收，答案作为一条**用户消息**补回原会话并唤醒伙伴续上原任务。
//
// 为什么走 session:send 而不是旧的 deferred 回传：deferred 能把结果直接塞回
// 同一个工具 Promise，但那条通道属于旧插件时代的总线，v2 App 的公开授权面里
// 没有它。发一条用户消息是公开、可解释、也更好查的做法——代价是原工具调用
// 已经结束了，伙伴拿到的是一个新回合。
//
// 三条纪律：
//   1. 只有 answered 才算作答；rejected / aborted / timeout 都不是同意。
//   2. 一条题只回传一次。同一 askId 处理完就从表里删掉，重复轮询不再发第二遍。
//   3. 球被关掉、App 重载、会话查不到，都安静收场，不往对话里塞半句话。

const TERMINAL = new Set(["answered", "rejected", "aborted", "timeout"]);
// 轮询间隔比球上原来的 750ms 松一点：这一路是 App 侧的后台轮询，
// 没必要跟得那么紧；用户作答之后一两秒内回传完全够用。
const POLL_INTERVAL_MS = 1200;
// 一道题最多等这么久，跟球侧桥上的 TTL（600 秒）对齐。
const ASK_TTL_MS = 10 * 60 * 1000;

/** 把一条作答变成给人看的回传正文。所有分支都由调用方决定要不要发。 */
export function buildBallAnswerText(record, answer) {
  const question = String(record?.request?.question || "").trim();
  const action = answer?.action;
  const value = answer?.value && typeof answer.value === "object" ? answer.value : {};
  const lines = ["知意把球上的选择送回来了。", ""];
  if (question) lines.push(`问题：${question}`, "");

  if (action === "confirmed") {
    const custom = typeof value.customChoice === "string" ? value.customChoice.trim() : "";
    if (custom) {
      lines.push(`用户填的自定义回答：${custom}`);
    } else if (Array.isArray(value.choice)) {
      lines.push("用户选了这几项：", ...value.choice.map((item) => `- ${item}`));
    } else {
      lines.push(`用户选了：${value.choice}`);
    }
    if (typeof value.note === "string" && value.note.trim()) lines.push("", `补充：${value.note.trim()}`);
    lines.push("", "请接着这个选择把原来的事做下去。如果后续方案跟提问时说的不一样了，先说清楚再动手。");
    return lines.join("\n");
  }
  if (action === "rejected") {
    lines.push("用户跳过了这道题，没有做选择。", "", "跳过不等于同意：先停下来，说明现状和安全默认方案，再问要不要继续。");
    return lines.join("\n");
  }
  if (action === "timeout") {
    lines.push("这道题等太久，已经过期了，没收到选择。", "", "不要把过期当同意。需要的话重新问一次，别一上来就默认自己选了某一项。");
    return lines.join("\n");
  }
  lines.push("这道题被关掉了，没有拿到选择。", "", "关掉不等于同意；先跟用户确认现在要做什么。");
  return lines.join("\n");
}

/**
 * 建一个等待应答的登记表。
 * send 是 (text, sessionId) => Promise，由调用方接到 session:send 上；
 * readAskResult 是 (askId) => Promise<{status, answer}>，由调用方接到球的桥上。
 */
export function createBallAskWatcher({ send, readAskResult, logger = null, now = Date.now, intervalMs = POLL_INTERVAL_MS, ttlMs = ASK_TTL_MS } = {}) {
  const pending = new Map();
  let timer = null;
  let ticking = false;

  function schedule() {
    if (timer || !pending.size) return;
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, intervalMs);
    timer.unref?.();
  }

  function add({ askId, request, sessionId }) {
    if (!askId || !sessionId || typeof readAskResult !== "function") return false;
    pending.set(askId, {
      askId,
      request,
      sessionId,
      expiresAt: now() + ttlMs,
    });
    schedule();
    return true;
  }

  function remove(askId) {
    pending.delete(askId);
  }

  function has(askId) {
    return pending.has(askId);
  }

  function size() {
    return pending.size;
  }

  /** 读一次所有在等的题。 */
  async function tick() {
    if (ticking || !pending.size) return;
    ticking = true;
    try {
      for (const record of [...pending.values()]) {
        if (now() >= record.expiresAt) {
          pending.delete(record.askId);
          await logger?.debug?.("球上提问已过期，未回传", { askId: record.askId });
          continue;
        }
        let result;
        try {
          result = await readAskResult(record.askId);
        } catch {
          // 球正在退出或桥暂时不通：这不算作答，下一轮再看。
          continue;
        }
        if (!result || !TERMINAL.has(result.status)) continue;
        pending.delete(record.askId);
        if (result.status !== "answered") {
          await logger?.info?.(`球上提问未作答（${result.status}），不回传`, { askId: record.askId });
          continue;
        }
        const text = buildBallAnswerText(record, result.answer);
        try {
          await send(text, record.sessionId);
          await logger?.info?.("球上选择已回传原会话", { askId: record.askId });
        } catch (error) {
          // 发送失败不能静默吞掉：用户明明点了，对话里却什么都没有，比报错更糟。
          // 错误原文要进 message，宿主日志不会展开第二个参数，只写 detail 等于没记。
          await logger?.warn?.(
            `球上选择回传失败：${String(error?.code || "no-code")} ${String(error?.message || error).slice(0, 160)}`,
            { askId: record.askId, sessionId: record.sessionId },
          );
        }
      }
    } finally {
      ticking = false;
      if (pending.size) schedule();
    }
  }

  function stop() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending.clear();
  }

  return { add, remove, has, size, tick, stop, schedule };
}
