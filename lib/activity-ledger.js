// lib/activity-ledger.js — 「谁还在跑」的第三层来源：宿主事件订阅
//
// 为什么需要这一层（2026-10-27 实查）：
//   自动关机原来只问两处——
//     ① session:list 列会话，再逐个 session:context 问忙闲；
//     ② tasks.list 列后台任务。
//   但 v2 App 的 session:list 在宿主里是**写死**的：
//     `namespace: d ? ["home", "app"] : h ? "all" : "home"`
//   （Code 页的会话 namespace 是 code，压根不在 home/app 里）。
//   v2 契约的 AppSessionListRequestV2 也没有 namespace 字段，传不进去。
//   所以 Code 页的会话在守门人眼里等于不存在：它既不进名单，也不会被
//   session:context 探一次。Code 页正在跑的时候，快照会报「全空」。
//
//   唯一能看见全宿主的通道是 ctx.bus.subscribe 的**全局订阅**：
//   不给 filter.sessionPath 就是全局订阅者，能收到每个会话上的事件，
//   跟 namespace 无关。这一层就是拿它记一本「谁最近在动」的账。
//
// 为什么用事件而不是轮询 session:context：
//   session:context 需要会话编号，而编号正是 session:list 给不出来的东西；
//   事件自带 sessionPath，不需要先知道编号，绕开了整条死路。
//
// 判定取向跟 sleep-guard 一致：**宁可多拦，不可误放。**
//   拿不准的时候按「还在忙」算；但也不能无限拦着，所以有两条阀门：
//   - IDLE_GRACE_MS：收到 agent_end 之后再多算一小段时间忙，兜住没被建模的事件；
//   - STALE_MS：标了忙却长时间一点动静都没有（会话被强杀、App 崩过），
//     到点就不再拿它拦关机，并在快照里单列出来，别让人以为它还活着。

/** 账本刚建立的头这段时间按「还不确定」算：重载不会让正在跑的活停下来。 */
export const WARMUP_MS = 3 * 60 * 1000;

/** 收到 agent_end 之后再多算这么久的忙：兜住没被逐个建模的事件尾巴。 */
export const IDLE_GRACE_MS = 90_000;
/** 标了忙却这么久一点事件都没有，就不再拿它拦关机（会话大概已经没了）。 */
export const STALE_MS = 45 * 60 * 1000;
/** 账本最多记多少段会话，防止极端情况下无限长。超了先扔最旧的。 */
const MAX_TRACKED = 400;

/** 这些事件说明「这一段开始/正在干活」。 */
const BUSY_EVENT_TYPES = new Set([
  "turn_start",
  "agent_start",
  "message_start",
  "message_update",
  "tool_execution_start",
  "tool_execution_update",
  "compaction_start",
  "queue_update",
]);

/** 这些事件说明「这一段这一轮说完了」。 */
const IDLE_EVENT_TYPES = new Set(["agent_end"]);

/**
 * 纯界面事件：既不算忙，也不刷静默计时。
 *
 * 为什么必须单列（2026-10-29 实查）：知意每 12 秒刷一次关机提示条，宿主每一条
 * `inputBanner.set` 都会广播一个 `input_banner_set` 事件（bundle/index.js:
 * `g.emit({ type: "input_banner_set", sessionPath: ae, entry: ee }, ae)`）。
 * 账本对任何带路径的事件都更新 lastEventAt，于是那几段会话的「静默时间」
 * 永远只有几百毫秒、永远落在 IDLE_GRACE_MS 之内——「忙」再也解脱不了。
 * 结果：整晚一次倒计时都没开始，机器没关，而日志里每一轮都写着「忙 7 处」。
 *
 * 判据只有一条：这条事件是不是某段会话真的在生成内容。横幅是知意自己画的，
 * 输入框状态是界面渲染，会话改名是元数据——它们动了，不代表有人在干活。
 */
const UI_EVENT_TYPES = new Set([
  "input_banner_set",
  "input_banner_dismissed",
  "input_status_changed",
  "app_input_panels_changed",
  "session_info_changed",
]);

/** 插件横幅类事件：`plugin-v2:<pluginId>:banner`。同样是界面上的一条提示。 */
const UI_EVENT_PATTERN = /^plugin-v2:.+:banner$/;

function isUiOnlyEvent(type) {
  return UI_EVENT_TYPES.has(type) || UI_EVENT_PATTERN.test(type);
}

/** 只有路径没有编号也要能记：键就用路径（宿主事件第二个参数恒为 sessionPath）。 */
function keyOf(sessionPath) {
  const value = typeof sessionPath === "string" ? sessionPath.trim() : "";
  return value || "";
}

// 模块级的当前账本。
// 为什么放在这里而不是靠调用方一个个传：采样入口不止一个（守门人、开发探针、
// 以后可能还有别的），少传一处就会出现「同一步时间里，两个入口一个说有活一个说空」。
// 那个假空闲正是这次要修的东西，不能再给自己埋一个。
let currentLedger = null;

/** 装上账本（index.js 订阅挂好后调一次）。传 null 就卸掉。 */
export function setActivityLedger(ledger) {
  currentLedger = ledger && typeof ledger.snapshot === "function" ? ledger : null;
  return currentLedger;
}

/** 当前账本，没装就是 null。采样层拿不到就不把这一层算进去。 */
export function getActivityLedger() {
  return currentLedger;
}

export function createActivityLedger({ maxTracked = MAX_TRACKED, warmupMs = WARMUP_MS } = {}) {
  const entries = new Map();
  // 刚建立时这本金是空的——而空账本的意思是「什么都没在跑」，这是个危险的谎。
  // 真实场景：App 重载（升级、改代码、宿主重启）之后账本清零，可那时候
  // Code 页可能正跑着一段几十分钟的活，它不会因为你重载就停下来。
  // 这段时间里账本一片空白，判定就会当成「全空」。
  // 所以刚开张的一小段时间按「不确定」算：采样层会报成看不清，
  // 判定那边就按忙处理。过了这段才允许说「真空」。
  const startedAt = Date.now();
  const warmup = Math.max(0, Number(warmupMs) || 0);

  function touch(key, now) {
    let entry = entries.get(key);
    if (!entry) {
      entry = { sessionPath: key, busy: false, busySince: null, lastEventAt: now, lastType: "" };
      // 超出上限先丢最旧的那条：它本来就最不可能还在跑。
      if (entries.size >= maxTracked) {
        let oldestKey = null;
        let oldest = Infinity;
        for (const [candidate, value] of entries) {
          if (value.lastEventAt < oldest) {
            oldest = value.lastEventAt;
            oldestKey = candidate;
          }
        }
        if (oldestKey !== null) entries.delete(oldestKey);
      }
      entries.set(key, entry);
    }
    return entry;
  }

  /**
   * 吃一条宿主事件。event 是只读投影，只读字段，不改它。
   * 返回 true 表示这条事件动到了账本（调用方不用关心，只是方便测）。
   */
  function note(event, sessionPath, now = Date.now()) {
    const type = String(event?.type || "");
    if (!type) return false;
    const key = keyOf(sessionPath);
    // 没有路径的事件记不了账（宿主总会给第二个参数，但别假设它一定在）。
    if (!key) return false;

    // 界面在动不等于活在跑：这类事件连 lastEventAt 都不碰，否则横幅自己
    // 每 12 秒把「静默」清零一次，忙就永远消不掉（见 UI_EVENT_TYPES）。
    if (isUiOnlyEvent(type)) return false;

    // 会话没了就把这条销掉：留着它只会一直拦关机。
    if (type === "session_closed" || type === "session_deleted") {
      entries.delete(key);
      return true;
    }

    const entry = touch(key, now);
    entry.lastEventAt = now;
    entry.lastType = type;

    if (BUSY_EVENT_TYPES.has(type)) {
      if (!entry.busy) {
        entry.busy = true;
        entry.busySince = now;
      }
      return true;
    }

    if (IDLE_EVENT_TYPES.has(type)) {
      // willRetry 为真说明宿主自己要重试，这一轮没结束，不能算说完。
      if (event?.willRetry === true) {
        entry.busy = true;
        return true;
      }
      entry.busy = false;
      entry.busySince = null;
      return true;
    }

    // 别的事件（session_created、metadata、banner 之类）只算「有动静」，不改忙闲。
    return true;
  }

  /**
   * 拍一张账本快照。busy 里只放真正还在忙的；
   * stale 里放「标着忙但久无动静」的——它们已经不拦关机了，但要让人看得见。
   * warmingUp 为真表示账本刚开张、还没看足够久：这时的「空」不能当真。
   */
  function snapshot(now = Date.now(), { graceMs = IDLE_GRACE_MS, staleMs = STALE_MS } = {}) {
    const busy = [];
    const stale = [];
    let tracked = 0;
    for (const entry of entries.values()) {
      tracked += 1;
      const silentMs = now - entry.lastEventAt;
      const withinGrace = silentMs <= graceMs;
      if (!entry.busy && !withinGrace) continue;
      const row = {
        sessionPath: entry.sessionPath,
        busy: entry.busy,
        lastType: entry.lastType,
        silentMs,
        busyForMs: entry.busySince ? now - entry.busySince : null,
      };
      if (entry.busy && silentMs > staleMs) stale.push(row);
      else busy.push(row);
    }
    // 刚开张那几分钟里，账本空不能当成「没人干活」：重载不会让正在跑的东西停。
    const warmingUp = warmup > 0 && now - startedAt < warmup;
    return { tracked, busyCount: busy.length, busy, staleCount: stale.length, stale, warmingUp };
  }

  function clear() {
    entries.clear();
  }

  /**
   * 账本里所有会话路径（不按忙闲过滤）。
   *
   * 为什么需要这个：关机提示条要往「每段对话」的输入框上方挂，
   * 可候选名单一直只看 `session:list`——而宿主给 v2 App 的 `session:list`
   * 把 namespace 写死成 home/app，Code 页（namespace=code）根本不在里面。
   * 结果就是：Code 页里挂了关机，输入框上方却一条提示都不出来，
   * 人看不见没法及时反悔——这跟守门人看不见 Code 页是同一个洞。
   * 账本不受这个限制（全局订阅的事件自带 sessionPath），所以从这里补候选。
   */
  function paths() {
    const out = [];
    // 按最近动静排序：名单有人数上限，得把「刚刚还在用的」放前面，
    // 不能让一条早就安静了的会话把正在用的那个挤出去。
    const rows = [...entries.values()].sort((a, b) => Number(b.lastEventAt || 0) - Number(a.lastEventAt || 0));
    for (const row of rows) {
      if (row?.sessionPath) out.push(row.sessionPath);
    }
    return out;
  }

  return { note, snapshot, clear, paths, get size() { return entries.size; } };
}
