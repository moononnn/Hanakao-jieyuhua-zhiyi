// lib/reading-diagnostics.js — 自动整理的诊断计数（仅后台，不进前端）
//
// 想知道「自动整理到底有没有在干活、为什么没干活」，但又不能把聊天正文、会话编号、
// 模型原文写进任何地方。所以这里只收固定白名单里的事件名，累加整数计数，攒够一批
// 再合成一条日志写出去。
//
// 边界：
//   · 只写一条后台日志（走 sdk.logger），不进前端、不加路由、不加开关；
//   · 只聚合整数计数，不接受消息正文、原始 sessionId/path、prompt、模型输出、错误原文；
//   · 每个事件不单独发 RPC：宿主对 App 的 RPC 有并发上限，逐条写会把仓占满；
//   · 写日志失败（同步抛错或异步拒绝）一律吞掉，不影响正事，也不重试；
//   · 没有事件就不排定时器，也就什么都不会写；
//   · 计数表按事件名固定有界，不落盘、不做额外持久化。

/**
 * 固定白名单：不在表里的名字一律不记。
 * 这样即使有人拿聊天正文、sessionId、模型输出去 record()，也只会石沉大海。
 */
export const READING_DIAGNOSTIC_EVENTS = Object.freeze([
  // 轮次层面
  "start", "finish", "no_turn", "already_ended", "missing_message",
  "accumulate_phase", "accumulate_tool",
  "source_overflow", "source_overflow_chars", "source_overflow_messages",
  "disabled", "superseded", "applied", "error",
  // 来源取材层面
  "source_rejected", "source_rejected_empty", "source_rejected_no_question",
  "source_rejected_longform", "source_rejected_simple", "source_rejected_stop",
  // 模型判断层面
  "under_300", "model_start", "model_done", "model_skip", "output_invalid",
  "insufficient_reduction", "duplicate", "prepared",
]);

const EVENT_SET = new Set(READING_DIAGNOSTIC_EVENTS);
const DEFAULT_INTERVAL_MS = 30_000;

/**
 * @param {(payload:{schema:number, counts:Record<string, number>}) => unknown} write 写一条汇总
 * @param {{intervalMs?: number}} options intervalMs 只给独立单测缩短用；生产固定 30 秒。
 * @returns {{record:(event:string) => void, flush:() => Promise<void>}}
 */
export function createReadingDiagnostics(write, { intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  const counts = new Map();
  let timer = null;

  /** 只认白名单里的事件名；其余（正文、编号、对象、自由字符串）一律不记。 */
  function record(event) {
    if (typeof event !== "string" || !EVENT_SET.has(event)) return;
    counts.set(event, (counts.get(event) || 0) + 1);
    if (timer) return;
    timer = setTimeout(() => { timer = null; void flush(); }, intervalMs);
    timer.unref?.();
  }

  /** 把攒下的计数写成一条；没有事件就不写。写失败吞掉，不重试。 */
  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!counts.size) return;
    const snapshot = {};
    for (const [event, count] of counts) snapshot[event] = count;
    counts.clear();
    const payload = { schema: 1, counts: snapshot };
    try {
      await Promise.resolve(write?.(payload));
    } catch {
      // 日志挂了就算了：诊断不能影响正事，也不重试（否则会连着占 RPC 仓）。
    }
  }

  return { record, flush };
}
