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
// 目标没变、也没人点刷新时，隔一段时间还是重生成一次，免得球里挂着很旧的推荐。
const GENERATE_TTL_MS = 120_000;

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

  async function push(body) {
    return ball.bridgeRequest("/recommend/push", { method: "POST", body });
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
    const config = normalizeRecommendationConfig(await sdk.storage.global.get("recommendationConfig", {}));
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
      if (seq > lastRequestSeq) {
        lastRequestSeq = seq;
        if (request.kind === "pin" || request.kind === "auto") {
          if (await applyPin(request)) forceGenerate = true;
        } else if (request.kind === "refresh") {
          forceGenerate = true;
        }
      }

      let sessions = [];
      let listError = "";
      try {
        sessions = await readSessionList(sdk);
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
      const targetChanged = targetId !== lastPushedTargetId;
      const ttlExpired = Date.now() - lastGeneratedAt > GENERATE_TTL_MS;

      let noticeParts = [];
      if (listError) noticeParts.push(`读不到会话名单：${listError}`);
      else if (!sessions.length) noticeParts.push("还没找到可用的对话。");
      else if (targetState.mode === "pinned" && target?.stale) noticeParts.push("固定的那段对话已经不在最近 5 个里了。");

      const shouldGenerate = Boolean(target) && (forceGenerate || targetChanged || ttlExpired);
      let suggestions = lastSuggestions;
      // 展示方式每轮现读：关掉之后立即停生成，球上那一块也整块收起来。
      const config = normalizeRecommendationConfig(await sdk.storage.global.get("recommendationConfig", {}));
      const enabled = config.display !== "off";
      if (!enabled) {
        suggestions = [];
        lastSuggestions = [];
        lastGeneratedAt = 0;
      }

      if (shouldGenerate && enabled) {
        // 先推一个「正在生成」，球上立刻能显示；生成完再推结果。
        await push({ target: describeTarget(target), candidates, suggestions: [], notice: noticeParts.join("；"), generating: true, enabled, ackSeq: seq });
        const generated = await generate(target);
        suggestions = generated.suggestions;
        // 目标层的提示（名单读不到 / 固定目标掉队）优先保留，生成失败的原因缀在后面，不互相覆盖。
        if (generated.notice) noticeParts.push(generated.notice);
        lastSuggestions = suggestions;
        lastGeneratedAt = Date.now();
        lastPushedTargetId = targetId;
      }

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
