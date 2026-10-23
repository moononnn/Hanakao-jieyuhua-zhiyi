// 解语花 — 排队话单
//
// 一份话单 = 一串话，按轮次往下送：ta 每说完一轮，就送下一句过去。
// 三种用法都从这一份结构里长出来：
//   写一句            → items: [{ text, repeat: 1 }]
//   同一句排 N 轮     → items: [{ text, repeat: N }]
//   写几句，一轮一句   → items: [{ text, repeat: 1 }, { text, repeat: 1 }, ...]
//
// 为什么自己记轮数，而不是把 N 句一起排给宿主：
//   1. 宿主的一次排队只有「等这一轮结束再发」这一个语义，多排几句会挤成同一轮里的
//      一串 user 消息，不是「一轮一句」；
//   2. 轮末那一发不能走排队语义——挂在空闲会话上会等一个永远不会来的轮次结束，
//      表现就是「点了没反应」（见 index.js 里那条注释）。轮末只能直接发（steer）。
// 所以：话单在 App 侧记账，发送分两段——第一条按「ta 正在不在回话」决定排队还是直接发，
// 之后每一轮都在轮末直接发。
//
// 停止条件（四条，缺一不可）：
//   1. 话单发满；
//   2. 用户在球上点「停」；
//   3. 用户在同一段对话里自己开口（活人接手，不跟人抢麦）；
//   4. 会话被关或被中止——宿主会清掉排队中的输入，这时由调用方回执告诉用户。
//
// 误判方向是单向的：把自己发出去的那句当成「用户插话」会误杀，
// 所以判定用的是「像不像我们发的那句」，宁可不停。

export const QUEUE_MAX_ROUNDS = 50;   // 一份话单一共最多多少轮（防无人值守把 token 烧穿）
export const QUEUE_MAX_ITEMS = 20;   // 一份话单最多几句话
export const QUEUE_MAX_TEXT = 500;   // 单句上限，与 lib/send.js 的 QUEUE_TEXT_MAX 一致

const QUEUE_STATUS_RUNNING = "running";
const QUEUE_STATUS_FINISHED = "finished";
const QUEUE_STATUS_STOPPED = "stopped";

export function normalizeQueueRounds(value, max = QUEUE_MAX_ROUNDS) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

/**
 * 把用户写的东西拆成话单。
 * raw 可以是一整段（按行拆，一行一句）或字符串数组。
 * 归一化在同一个地方做：去空行、去多余空白、限轮数、限条数、限字数。
 */
export function buildQueueItems(raw, { rounds = 1, maxRounds = QUEUE_MAX_ROUNDS, maxItems = QUEUE_MAX_ITEMS } = {}) {
  const lines = Array.isArray(raw) ? raw : String(raw ?? "").split(/\r?\n/);
  const repeat = normalizeQueueRounds(rounds, maxRounds);
  const items = [];
  for (const line of lines) {
    const text = String(line ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.length > QUEUE_MAX_TEXT) {
      return { ok: false, items: [], total: 0, repeat, error: "有一句太长了，精简到 500 字以内吧" };
    }
    items.push({ text, repeat, sent: 0 });
    if (items.length >= maxItems) break;
  }
  if (!items.length) return { ok: false, items: [], total: 0, repeat, error: "先写一句再排" };
  const total = items.length * repeat;
  if (total > maxRounds) {
    return {
      ok: false,
      items: [],
      total,
      repeat,
      error: `一共 ${total} 轮，超过 ${maxRounds} 轮上限了`,
    };
  }
  return { ok: true, items, total, repeat };
}

export function planTotalRounds(items) {
  return (Array.isArray(items) ? items : []).reduce((sum, item) => sum + (Number(item?.repeat) || 1), 0);
}

function trim(text, max = 40) {
  const value = String(text || "").trim().replace(/\s+/g, " ");
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/** 球上状态条那句话：排队中 第 2/5 轮。 */
export function describeQueuePlan(state) {
  if (!state || state.status !== QUEUE_STATUS_RUNNING) return "";
  const total = Number(state.total) || 0;
  const done = Number(state.done) || 0;
  if (!total) return "排队中";
  return `排队中 第 ${Math.min(done + 1, total)}/${total} 轮`;
}

/**
 * 话单状态机。纯内存 + 单一 now()，不碰文件系统，方便直接跑测试。
 * 每个会话一份话单，状态：running / finished / stopped。
 */
export class QueuePlanRegistry {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this._states = new Map();
  }

  get(sessionId) {
    return this._states.get(String(sessionId || "")) || null;
  }

  /**
   * 按编号找话单；编号对不上时，只有一份在跑就认它。
   * 宿主给的两套编号（sess_xxx / 文件名式 UUID）在钩子、事件、球桥三个地方不总一致，
   * 收紧成一处判定，别在每个调用点各写一遍「唯一在跑就认」。
   */
  resolve(sessionId) {
    const id = String(sessionId || "");
    const direct = this._states.get(id);
    if (direct) return direct;
    const running = [...this._states.values()].filter((item) => item.status === QUEUE_STATUS_RUNNING);
    return running.length === 1 ? running[0] : null;
  }

  list() {
    return [...this._states.values()];
  }

  /** 开始一份话单。items 由 buildQueueItems 归一化过了，这里再兜一层底。 */
  start({ sessionId, agentId = "", agentName = "", title = "", items = [] } = {}) {
    const id = String(sessionId || "").trim();
    if (!id) return { ok: false, error: "找不到要排进哪段对话" };
    const list = (Array.isArray(items) ? items : [])
      .map((item) => ({
        text: String(item?.text || "").replace(/\s+/g, " ").trim(),
        repeat: normalizeQueueRounds(item?.repeat),
        sent: 0,
      }))
      .filter((item) => item.text);
    if (!list.length) return { ok: false, error: "先写一句再排" };
    const total = planTotalRounds(list);
    if (total > QUEUE_MAX_ROUNDS) return { ok: false, error: `一共 ${total} 轮，超过 ${QUEUE_MAX_ROUNDS} 轮上限了` };
    this._prune();
    const state = {
      sessionId: id,
      agentId: String(agentId || ""),
      agentName: String(agentName || ""),
      title: String(title || ""),
      items: list,
      cursor: 0,
      roundDone: 0,
      done: 0,
      total,
      status: QUEUE_STATUS_RUNNING,
      startedAt: this._now(),
      lastFiredAt: 0,
      sentTexts: [],
      // pending = 有一句已经排进宿主、还没被接走。
      // 排队语义（followUp）会先把话挂在宿主那儿，等 ta 这一轮说完才轮到自己；
      // 在它被接走之前不能再送下一句，否则两句话会一起挤进去。
      pending: false,
      pendingSince: 0,
    };
    this._states.set(id, state);
    return { ok: true, state: { ...state, items: list.map((item) => ({ ...item })) } };
  }

  /** 下一句该发什么。没有了返回 null（发满了，或还有一句在宿主那儿排着）。 */
  nextText(sessionId) {
    const state = this.get(sessionId);
    if (!state || state.status !== QUEUE_STATUS_RUNNING) return null;
    if (state.pending) return null;
    const item = state.items[state.cursor];
    if (!item) return null;
    return item.text;
  }

  /**
   * 下一句该发什么，不问「宿主那儿还排着没有」。
   * 给「自己盯会话忙闲、闲下来就发」那条路用：那一路不看 pending，
   * 只看会话此刻是否空闲、离上次发送够不够久。
   */
  peekText(sessionId) {
    const state = this.get(sessionId);
    if (!state || state.status !== QUEUE_STATUS_RUNNING) return null;
    const item = state.items[state.cursor];
    return item ? item.text : null;
  }

  /**
   * 这一句是我们发出去的——在**发之前**就记上。
   *
   * 为什么不能等发送回来再记：发消息会立刻起一轮，宿主在那之前就可能跑 before-start 钩子；
   * 钩子要靠 sentTexts 认「这是我们自己的话」，认错了就当成用户插话，把整份话单停了
   * （表现是「排 2 轮只发 1 轮」）。记在发送之后就晚了半拍。
   */
  markSending(sessionId, text) {
    const state = this.get(sessionId);
    if (!state) return null;
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (value && !state.sentTexts.includes(value)) state.sentTexts.push(value);
    return { ...state };
  }

  /** 这一句排进宿主、还没被接走。 */
  markQueued(sessionId, now) {
    const state = this.get(sessionId);
    if (!state) return null;
    state.pending = true;
    state.pendingSince = Number.isFinite(now) ? now : this._now();
    return { ...state };
  }

  /** 被接走了：ta 开始回这句话了。 */
  markDelivered(sessionId) {
    const state = this.get(sessionId);
    if (!state) return null;
    state.pending = false;
    state.pendingSince = 0;
    return { ...state };
  }

  /** 还有一句在宿主那儿排着吗？ */
  isPending(sessionId) {
    const state = this.get(sessionId);
    return Boolean(state && state.pending);
  }

  /** 真正把这一句发出去之后记账：轮数 +1，这一句发够次数就换下一句。 */
  markFired(sessionId, now) {
    const state = this.get(sessionId);
    if (!state || state.status !== QUEUE_STATUS_RUNNING) return null;
    const item = state.items[state.cursor];
    if (!item) return null;
    item.sent += 1;
    state.roundDone += 1;
    state.done += 1;
    state.lastFiredAt = Number.isFinite(now) ? now : this._now();
    if (!state.sentTexts.includes(item.text)) state.sentTexts.push(item.text);
    if (state.roundDone >= item.repeat) {
      state.cursor += 1;
      state.roundDone = 0;
    }
    if (state.cursor >= state.items.length) {
      // 发完了不立刻丢掉：最后那一句可能还挂在宿主那儿等接走，
      // 留着才知道它到底送没送到（会话被关/被中止时要有回执）。
      state.status = QUEUE_STATUS_FINISHED;
      return { ...state, items: state.items.map((row) => ({ ...row })) };
    }
    return { ...state, items: state.items.map((row) => ({ ...row })) };
  }

  /** 用户在同一段对话里自己开口：活人接手，话单当场停，不跟人抢麦。 */
  onUserMessage(sessionId) {
    const state = this.get(sessionId);
    if (!state) return null;
    this._states.delete(state.sessionId);
    return { ...state, status: QUEUE_STATUS_STOPPED, reason: "你自己接过话了" };
  }

  /** 球上点「停」，或者发送失败。 */
  stop(sessionId, reason = "") {
    const id = String(sessionId || "");
    const state = this._states.get(id);
    if (!state) return { ok: false, error: "这段对话没有在排队" };
    this._states.delete(id);
    return { ok: true, state: { ...state, status: QUEUE_STATUS_STOPPED, reason } };
  }

  /**
   * 这条用户输入是不是我们自己发出去的那句？
   * 是的话不算「用户插话」——是我们自己在往下推。
   * 误判方向是单向的：把自己发的那句当成插话会误杀，所以宁可放过。
   */
  isOwnPrompt(sessionId, prompt) {
    const state = this.get(sessionId);
    if (!state) return false;
    const text = String(prompt || "");
    if (!text) return false;
    return state.sentTexts.some((sent) => sent && text.includes(sent));
  }

  dispose() {
    this._states.clear();
  }

  /** 收掉早该消失的旧话单：发完/停掉超过十分钟的，只留最新一份在跑。 */
  _prune() {
    const cutoff = this._now() - 10 * 60 * 1000;
    for (const [id, state] of this._states) {
      if (state.status === QUEUE_STATUS_RUNNING) continue;
      if ((state.startedAt || 0) < cutoff) this._states.delete(id);
    }
  }
}

/** 状态条上那句带名字的话：「🌸 小花：排队中 第 2/5 轮」。 */
export function queuePanelText(agentName, title, state) {
  const who = trim(agentName) || trim(title) || "这个对话";
  return `💬 ${who}：${describeQueuePlan(state)}`;
}
