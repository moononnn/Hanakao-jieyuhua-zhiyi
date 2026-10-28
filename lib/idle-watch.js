// lib/idle-watch.js — 「Hana 有没有在干活」的采样层
//
// 自动关机这个功能的核心不是关机，是判断到底空没空。这一层只做一件事：
// 把「所有窗口」和「所有后台任务」的忙闲拍一张快照出来，不下任何结论。
//
// 分工来自 2026-10-19 的实机验证：
//   ① 会话层会漏——子代理在跑的时候，主会话空了两分十五秒，扫描什么都没看见；
//   ② 任务层靠得住——同一个子代理在 tasks.list 里从头到尾挂着 running。
// 所以判定一律以任务层为主、会话层为辅；任务层读不到时按「不空」处理，
// 宁可永不触发，也不能凭瞎猜关掉机器。

import { getActivityLedger } from "./activity-ledger.js";

/** 默认只细查最近十分钟内有动静的会话，更早的连状态都不用问。 */
const DEFAULT_RECENT_MS = 10 * 60 * 1000;
/** 单次快照最多细查多少个会话，防止一次消息把 IPC 打满。 */
const DEFAULT_MAX_PROBE = 40;
/** 任务里哪些状态算「还在干活」。 */
const LIVE_TASK_STATE = /^(running|pending|paused|blocked|recovering)$/;

function toMillis(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function readRows(listed) {
  if (Array.isArray(listed)) return listed;
  const rows = listed?.sessions;
  return Array.isArray(rows) ? rows : [];
}

function errorBrief(error) {
  return {
    code: String(error?.code || "").slice(0, 48),
    message: String(error?.message || error).slice(0, 160),
  };
}

function describeSession(row) {
  return {
    // 只留编号和归属，不把会话正文写进记录。
    id: row?.sessionId || null,
    path: row?.path || row?.sessionPath || null,
    agent: row?.agentName || row?.agentId || null,
    owner: row?.ownerPluginId || null,
    kind: row?.kind || null,
    modified: row?.modified ?? null,
    modifiedAt: toMillis(row?.modified) || null,
  };
}

/**
 * 采样一次全局状态。
 * 返回 { sessions, tasks, events, busy, recent, errors }：busy 里只有真正在跑的会话。
 *
 * events 是第三层：宿主事件账本（lib/activity-ledger.js）。它不是备份，是
 * 唯一能看见 Code 页的那一层——session:list 在宿主里写死了 namespace: ["home","app"]，
 * Code 会话不在里头，也不存在任何能把 namespace 传进去的 v2 参数。
 */
export async function sampleIdleSnapshot(sdk, options = {}) {
  const recentMs = Number(options.recentMs) > 0 ? Number(options.recentMs) : DEFAULT_RECENT_MS;
  const maxProbe = Number(options.maxProbe) > 0 ? Number(options.maxProbe) : DEFAULT_MAX_PROBE;
  const now = Date.now();
  const out = {
    at: now,
    atIso: new Date(now).toISOString(),
    sessions: { total: 0, readable: false, scopeUsed: "all", recentCount: 0, probedCount: 0 },
    tasks: { readable: false, total: 0, active: 0, states: {} },
    events: { readable: false, tracked: 0, busyCount: 0, staleCount: 0, warmingUp: false },
    busy: [],
    recent: [],
    errors: [],
  };

  // 一、会话名单。scope=all 是关键：只能拿到自己的会话，这个功能就作废。
  let rows = [];
  try {
    const listed = await sdk.bus.request(
      "session:list",
      { scope: "all", lifecycle: "active" },
      { timeoutMs: 6_000 },
    );
    rows = readRows(listed);
    out.sessions.readable = true;
    out.sessions.total = rows.length;
  } catch (error) {
    out.errors.push({ stage: "session:list", ...errorBrief(error) });
  }

  // 二、按最后修改时间过筛。大部分会话几小时没动过，没必要挨个问。
  const recent = rows
    .map((row) => ({ row, modifiedAt: toMillis(row?.modified) }))
    .filter((item) => item.modifiedAt && now - item.modifiedAt <= recentMs)
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, maxProbe);

  out.sessions.recentCount = recent.length;

  // 三、只问有动静的那批：正在回话、正在压缩、还有排队消息，都算忙。
  for (const { row, modifiedAt } of recent) {
    const described = describeSession(row);
    try {
      const context = await sdk.bus.request(
        "session:context",
        {
          sessionId: row?.sessionId || undefined,
          sessionPath: row?.path || row?.sessionPath || undefined,
          scope: "all",
        },
        { timeoutMs: 4_000 },
      );
      out.sessions.probedCount += 1;
      const pending = Number(context?.pendingMessageCount || 0);
      const streaming = context?.isStreaming === true;
      const compacting = context?.isCompacting === true;
      const entry = {
        ...described,
        streaming,
        compacting,
        pending,
        idleMs: now - modifiedAt,
      };
      out.recent.push(entry);
      if (streaming || compacting || pending > 0) out.busy.push(entry);
    } catch (error) {
      out.errors.push({ stage: "session:context", id: described.id, ...errorBrief(error) });
    }
  }

  // 四、后台任务这一层不挂在会话上，得单独问。需要跨 App 权限，
  // 故意放最后：权限没给也只是这一项失败，不影响上面的会话结论。
  try {
    if (typeof sdk.tasks?.list === "function") {
      const all = await sdk.tasks.list({ scope: "all" });
      const list = Array.isArray(all) ? all : [];
      out.tasks.readable = true;
      out.tasks.total = list.length;
      for (const task of list) {
        const status = String(task?.status || "unknown");
        out.tasks.states[status] = (out.tasks.states[status] || 0) + 1;
        if (LIVE_TASK_STATE.test(status)) {
          out.tasks.active += 1;
          out.recent.push({
            task: String(task?.taskId || "").slice(0, 12),
            owner: task?.pluginId || null,
            type: task?.type || null,
            status,
            parent: task?.parentSessionId || null,
          });
        }
      }
    }
  } catch (error) {
    out.errors.push({ stage: "tasks.list", ...errorBrief(error) });
  }

  // 五、宿主事件账本：唯一能看见 Code 页会话的那一层。
  // 它不向宿主问任何东西，只读 App 自己订阅时攒下的账，所以不会失败、也不会报错。
  // 账本来处分两种：options.activityLedger 显式传（测试/特殊场景），
  // 否则用模块级那一份（setActivityLedger 装的）——不能让不同入口看到不同结果。
  try {
    const fromOptions = typeof options.activityLedger === "function" ? options.activityLedger() : options.activityLedger;
    const ledger = fromOptions && typeof fromOptions.snapshot === "function" ? fromOptions : getActivityLedger();
    if (ledger) {
      const view = ledger.snapshot(now);
      out.events.readable = true;
      out.events.tracked = view.tracked;
      out.events.busyCount = view.busyCount;
      out.events.staleCount = view.staleCount;
      // 刚开张、账本还是空的：报成「看不清」而不是「没人」。
      // 否则 App 重载后那几分钟，Code 页在跑也看不到，判定直接当成全空。
      // 注：warmingUp 不影响 readable（宿主订阅确实装上了），它单列。
      out.events.warmingUp = view.warmingUp === true;
      if (view.warmingUp === true && view.busyCount === 0) {
        out.events.uncertain = true;
      }
      for (const row of view.busy) {
        // 会话层已经报过忙的就不重复算，只补它没看到的那些（主要是 Code 页）。
        if (out.busy.some((item) => item.path && item.path === row.sessionPath)) continue;
        out.busy.push({
          path: row.sessionPath,
          source: "events",
          streaming: row.busy === true,
          pending: 0,
          lastType: row.lastType,
          idleMs: row.silentMs,
        });
      }
    }
  } catch (error) {
    out.errors.push({ stage: "activity-ledger", ...errorBrief(error) });
  }

  return out;
}

/** 把一次快照压成一行：只看结论，不留正文。 */
export function summarizeSnapshot(snapshot) {
  // 后台任务也要单拎出来：会话不会说「还有人在干活」，任务会。
  const activeTasks = snapshot.recent
    .filter((item) => item && item.task)
    .map((item) => ({
      id: item.task || null,
      type: item.type || null,
      status: item.status || null,
      owner: item.owner || null,
      parent: item.parent || null,
    }));
  return {
    at: snapshot.atIso,
    sessions: snapshot.sessions,
    tasks: snapshot.tasks,
    // 事件账本要单列：它是唯一看得见 Code 页的一层，出了问题得能一眼分得出。
    events: snapshot.events || { readable: false, tracked: 0, busyCount: 0, staleCount: 0 },
    busyCount: snapshot.busy.length,
    busy: snapshot.busy.map((item) => ({
      id: item.id || item.task || null,
      path: item.path || null,
      source: item.source || "sessions",
      agent: item.agent || null,
      kind: item.kind || item.type || null,
      streaming: item.streaming ?? null,
      pending: item.pending ?? null,
      idleMs: Number.isFinite(item.idleMs) ? item.idleMs : null,
    })),
    activeTasks,
    recentCount: snapshot.recent.filter((item) => !item?.task).length,
    errorCount: snapshot.errors.length,
  };
}
