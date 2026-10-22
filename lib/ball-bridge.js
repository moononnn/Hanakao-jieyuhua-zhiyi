// 传音樱的目标跟随与球内推荐：App 侧的轮询桥。
//
// 球不能回调 App，只能轮询 app_bridge.py 的 /recommend/* 端点。这里做三件事：
//   1. 读球上的请求（刷新推荐 / 固定某段对话 / 取消固定回跟随）；
//   2. 从已授权的 session:list 里挑最近 5 段对话，按固定状态决定当前目标；
//   3. 复用 lib/recommendation.js 的 generateRecommendations 生成推荐，推回球上。
//
// 只读 path/sessionId/title/agentName/modified，不读任何对话内容。
// 生成失败或宿主不给名单时，把原因写进 notice 让人话显示，不静默吞掉。

import { generateRecommendations } from "./recommendation.js";
import { normalizeRecommendationConfig } from "./recommendation-config.js";
import { pickRecentSessions, resolveTargetSession, toPinnedRecord } from "./ball-target.js";

export const BALL_TARGET_KEY = "ballTarget";
export const RECOMMEND_POLL_MS = 1500;
const SESSION_LIST_TIMEOUT_MS = 8000;
// 会话名单和推荐配置都吃宿主 RPC，而宿主对 App RPC 有并发上限（撞上去整个钩子会被
// 丢掉，日志里就是 App RPC concurrency limit reached）。这个桥 1.5 秒轮一圈，以前每圈
// 都打一次 session:list + 两三次 storage，持续压在限额上。缓存几秒，轮询就只剩球的
// 本地 HTTP，不再跟钩子抢配额。
const SESSION_LIST_CACHE_MS = 5_000;
const CONFIG_CACHE_MS = 5_000;
// 推荐只在你亲手点「刷新推荐」时才生成：换目标、清空、单纯过了一轮，都不再偷偷调模型。

function describeTarget(target) {
  if (!target) return null;
  return {
    sessionId: target.sessionId,
    title: target.title || "",
    agentName: target.agentName || target.agentId || "",
    mode: target.mode,
    stale: target.stale === true,
  };
}

async function readSessionList(sdk) {
  const result = await Promise.race([
    sdk.bus.request("session:list", { scope: "all" }, { timeoutMs: SESSION_LIST_TIMEOUT_MS }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("会话名单超时了。")), SESSION_LIST_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
  const sessions = Array.isArray(result) ? result : result?.sessions;
  return Array.isArray(sessions) ? sessions : [];
}

/**
 * 建立球目标桥。返回 { tick }；由调用方按 RECOMMEND_POLL_MS 自行调度。
 * logger 只为排错，不写对话内容。
 */
export function createBallBridge({ sdk, ball, logger = null }) {
  let lastRequestSeq = 0;
  let lastPushedTargetId = null;
  let lastGeneratedAt = 0;
  let lastSuggestions = [];
  let inFlight = false;
  // 上面两个缓存跟着桥活，桥重建（App 重载）就清空，不会拿旧名单糊弄新会话。
  let sessionCache = { at: 0, rows: [] };
  let configCache = { at: 0, value: null };

  async function push(body) {
    return ball.bridgeRequest("/recommend/push", { method: "POST", body });
  }

  async function readRecommendConfig() {
    const now = Date.now();
    if (configCache.value && now - configCache.at < CONFIG_CACHE_MS) return configCache.value;
    const value = normalizeRecommendationConfig(await sdk.storage.global.get("recommendationConfig", {}));
    configCache = { at: now, value };
    return value;
  }

  async function readSessionsCached({ force = false } = {}) {
    const now = Date.now();
    if (!force && sessionCache.rows.length && now - sessionCache.at < SESSION_LIST_CACHE_MS) {
      return sessionCache.rows;
    }
    const rows = await readSessionList(sdk);
    sessionCache = { at: now, rows };
    return rows;
  }

  async function readTargetState() {
    const raw = await sdk.storage.global.get(BALL_TARGET_KEY, {});
    const state = raw && typeof raw === "object" ? raw : {};
    return { mode: state.mode === "pinned" ? "pinned" : "auto", pinned: state.pinned || null };
  }

  // 把一段对话钉成目标 / 取消固定。返回是否真的改了状态。
  async function applyPin(request) {
    if (request.kind === "pin") {
      const record = toPinnedRecord({ sessionId: request.sessionId });
      if (!record) return false;
      await sdk.storage.global.set(BALL_TARGET_KEY, { mode: "pinned", pinned: record });
      await logger?.info?.(`球目标已固定：${record.sessionId}`);
      return true;
    }
    if (request.kind === "auto") {
      await sdk.storage.global.set(BALL_TARGET_KEY, { mode: "auto", pinned: null });
      await logger?.info?.("球目标已回到跟随最近活跃");
      return true;
    }
    return false;
  }

  async function generate(target) {
    const config = await readRecommendConfig();
    // 关了就真的不生成、不推提示：球上那一块会直接收起来，不留「已关闭」占位。
    if (config.display === "off") {
      return { suggestions: [], notice: "", enabled: false };
    }
    try {
      const result = await generateRecommendations(sdk, { sessionId: target.sessionId });
      return { suggestions: result.suggestions || [], notice: "", enabled: true };
    } catch (error) {
      const message = String(error?.message || error).slice(0, 160);
      await logger?.warn?.(`球内推荐生成失败：${message}`);
      return { suggestions: [], notice: message || "推荐生成失败，可以再点一次刷新。", enabled: true };
    }
  }

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      const state = await ball.bridgeRequest("/recommend/state");
      const request = state?.request && typeof state.request === "object" ? state.request : {};
      const seq = Number(request.seq) || 0;

      let forceGenerate = false;
      let targetChanged = false;
      let cleared = false;
      // 球重启后桥上的 requestSeq 从 0 重数，而 App 这边还记着旧的大号：不归零就
      // 永远进不了下面那个 seq > lastRequestSeq，刷新和固定像死了一样没反应。
      if (seq < lastRequestSeq) lastRequestSeq = 0;
      if (seq > lastRequestSeq) {
        lastRequestSeq = seq;
        if (request.kind === "pin" || request.kind === "auto") {
          if (await applyPin(request)) targetChanged = true;
        } else if (request.kind === "refresh") {
          forceGenerate = true;
        } else if (request.kind === "clear") {
          cleared = true;
        }
      }

      let sessions = [];
      let listError = "";
      try {
        // 刷新推荐/固定目标这类用户动作要拿最新名单，普通轮询走缓存。
        sessions = await readSessionsCached({ force: forceGenerate || targetChanged });
      } catch (error) {
        listError = String(error?.message || error).slice(0, 160);
      }

      const targetState = await readTargetState();
      const target = sessions.length ? resolveTargetSession(targetState, sessions) : null;
      const candidates = pickRecentSessions(sessions, 5).map((row) => ({
        sessionId: row.sessionId,
        title: row.title,
        agentName: row.agentName || row.agentId || "",
        modified: row.modified,
      }));

      const targetId = target?.sessionId || "";
      const targetChangedNow = targetId !== lastPushedTargetId;

      let noticeParts = [];
      if (listError) noticeParts.push(`读不到会话名单：${listError}`);
      else if (!sessions.length) noticeParts.push("还没找到可用的对话。");
      else if (targetState.mode === "pinned" && target?.stale) noticeParts.push("固定的那段对话已经不在最近 5 个里了。");

      let suggestions = lastSuggestions;
      // 展示方式每轮现读：关掉之后立即停生成，球上那一块也整块收起来。
      const config = await readRecommendConfig();
      const enabled = config.display !== "off";
      // 换了目标或用户点了清空：旧列表已经不对应当前目标，直接丢掉，不留在面板里吓人。
      if (!enabled || cleared || targetChanged || targetChangedNow) {
        suggestions = [];
        lastSuggestions = [];
        lastGeneratedAt = 0;
      }

      // 唯一的生成入口：这一轮球上收到了「刷新推荐」。
      if (Boolean(target) && enabled && forceGenerate) {
        // 先推一个「正在生成」，球上立刻能显示；生成完再推结果。
        await push({ target: describeTarget(target), candidates, suggestions: [], notice: noticeParts.join("；"), generating: true, enabled, ackSeq: seq });
        const generated = await generate(target);
        suggestions = generated.suggestions;
        // 目标层的提示（名单读不到 / 固定目标掉队）优先保留，生成失败的原因缀在后面，不互相覆盖。
        if (generated.notice) noticeParts.push(generated.notice);
        lastSuggestions = suggestions;
        lastGeneratedAt = Date.now();
      }
      lastPushedTargetId = targetId;

      await push({ target: describeTarget(target), candidates, suggestions, notice: enabled ? noticeParts.join("；") : "", generating: false, enabled, ackSeq: seq });
    } catch (error) {
      // 桥暂时不可用（球正在退出）不是错误，安静跳过；真要推荐时球那边会自己报未连接。
      await logger?.debug?.(`球推荐桥轮询跳过：${String(error?.message || error).slice(0, 120)}`);
    } finally {
      inFlight = false;
    }
  }

  return { tick };
}
