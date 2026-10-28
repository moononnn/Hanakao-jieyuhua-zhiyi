import { defineApp } from "./sdk/app-contract/server-client.js";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createBallManager } from "./lib/ball.js";
import { createBallAskWatcher } from "./lib/ball-ask-watch.js";
import { registerFusionService } from "./lib/fusion-service.js";
import { createBallBridge, RECOMMEND_POLL_MS } from "./lib/ball-bridge.js";
import { createCardAskRegistry } from "./lib/card-handoff.js";
import { appendAskGuidance } from "./lib/ask-guidance.js";
// 「活干完帮我关」的守门人：采样在 lib/idle-watch.js，判定在 lib/sleep-guard.js。
import { armSleepGuard, buildShutdownEnv, cancelSleepGuard, describeSleepGuard, isRealEnabled, readSleepGuard, readSleepGuardConfig, readSleepTimeline, restoreSleepGuard, saveSleepGuardConfig, setActivityLedger, setRealEnabled } from "./lib/sleep-guard.js";
// 开发期只读探针：连续拍忙闲快照，肉眼对时间线用。
// 发布前连同 lib/idle-probe.js 与下面的工具注册一起删掉（见 PENDING_CHANGES），不影响守门功能。
import { listIdleWatches, reportIdleWatch, startIdleWatch, stopIdleWatch } from "./lib/idle-probe.js";
// 宿主事件账本：守门人的第三层眼睛，也是唯一看得见 Code 页会话的那一层。
import { createActivityLedger } from "./lib/activity-ledger.js";
import { sampleIdleSnapshot, summarizeSnapshot } from "./lib/idle-watch.js";
import { ContinueLoopRegistry, describeLoop, planManualResume, shouldJudgeLoop } from "./lib/continue-loop.js";
// 排队话单：球上写一句或一串话，等 ta 这一轮说完就送进去；一串话一轮一条往下推。
import { QueuePlanRegistry, buildQueueItems, describeQueuePlan, normalizeQueueRounds } from "./lib/queue-plan.js";
import {
  DEFAULT_MIN_CHARS,
  MAX_MIN_CHARS,
  buildSummaryBlock,
  hasToolCalls,
  lastUserMessage,
  normalizeMinChars,
  normalizeSummaryConfig,
  readBodyText,
  recordSummaryFailure,
  replaceSummaryBlock,
  saveOriginalArchive,
  stripMoodBlock,
  shouldSummarize,
  stripSummaryBlocks,
  stripSummaryFromPayload,
  stripSummaryInMessage,
  resolveSummaryModelRef,
  summarizeReply,
} from "./lib/length-summary.js";
import { chatModelOptions, hasDecisionCue, normalizeModelRef, reviewAskNeed, testAskModelConnection } from "./lib/ask-model.js";
import { FAST_TASK_MODEL_KEY, invokeFastTextModel, resolveFastModel } from "./lib/fast-model.js";
import { POLISH_LEVEL_OPTIONS, polishText, suggestPolishFixes } from "./lib/polish.js";
import { applySessionTitle, readTitleUndo, summarizeSessionTitle, undoSessionTitle } from "./lib/session-title.js";
import { inputZoomStatus, installInputZoom, uninstallInputZoom } from "./lib/input-zoom.js";
import { encryptionAvailable, encryptionStatus, protectKey } from "./lib/crypto.js";
import {
  MAX_REPLY_CHARS,
  VOICE_PRESETS,
  isMaskedKey,
  isValidClipId,
  maskVoiceConfig,
  clipExists,
  clipFile,
  normalizeVoiceConfig,
  readClip,
  readClipMeta,
  resolveVoiceIdForAgent,
  saveClip,
  saveClipMeta,
  synthesizeVoice,
  voicesForProtocol,
} from "./lib/voice.js";
import { listSpeakableReplies, prepareDraftText, prepareSpeakText, readFullReplyText, resolveSpeakTarget } from "./lib/voice-replies.js";
import { normalizeBallTargetState } from "./lib/ball-target.js";
import {
  applyDrops,
  createDraft,
  isDraftAlive,
  reselectStyles,
  restoreDefaultStyles,
  validatePlanStyles,
  refineStyles,
  refineChat,
} from "./lib/style-refine.js";
import { buildShowStyleCardInput, buildShowStyleCardInstruction, buildStyleRefineCardDocument } from "./lib/style-card.js";
import { chatFeedback, FEEDBACK_LIMITS } from "./lib/feedback-chat.js";
import {
  maskCustomModelConfig,
  mergeCustomModelConfig,
  testCustomModel,
} from "./lib/custom-model.js";
import {
  RESUME_TEXT,
  assistantTextOf,
  buildResumeExplanation,
  buildSessionIndex,
  classifyResumeBlocker,
  createResumeTracker,
  describeResumeSource,
  isSubagentSessionPath,
  isSubagentSessionTarget,
  isUserInitiatedAbortReason,
  lookupSession,
  normalizeResumeConfig,
  openedAtSnippet,
  parseAutoRetryStart,
  parseResumeSignal,
  reviewStuckCandidate,
  sessionIdFromPath,
} from "./lib/resume-watch.js";
import { friendlySendError, newestSession, sendToConversation } from "./lib/send.js";
import {
  COUNT_CHOICES,
  DEFAULT_STYLES,
  DISPLAY_MODES,
  normalizeQuickReplies,
  normalizeRecommendationConfig,
} from "./lib/recommendation-config.js";
import { generateRecommendations, resolveSessionIdByPath } from "./lib/recommendation.js";
import {
  SUGGEST_INPUT_STATUS_ID,
  SUGGEST_PANEL_ID,
  SUGGEST_PANEL_ROUTE,
  SUGGEST_PANEL_STATE_KEY,
  buildPanelPresentation,
  buildPanelState,
  estimatePanelHeight,
  normalizeSuggestionTexts,
  pickEditableText,
  readPanelState,
} from "./lib/suggest-panel.js";
import {
  ASK_TOOL_SCHEMA,
  buildAskMessage,
  buildRequestedSchema,
  formatAskAnswer,
  normalizeAskRequest,
} from "./lib/ask.js";

export const name = "jiegehua-zhiyi";

// 输入栏那个 🌸 按钮：点一下就把面板摆出来，不再自己记「现在开着还是关着」。
// 以前这里是开关，靠一张 openSuggestPanels 表记状态；那张表活在 App 进程内存里，
// 而宿主关面板的路径有好多条（宿主自己的关闭、切会话、App 重载），
// 唯一能把表清掉的通知是面板 iframe 的 pagehide/visibilitychange——它经常不发。
// 结果就是表里写着「开着」、宿主那边其实早关了：点一下只走 dismiss（空操作），
// 界面上什么都没发生，得再点一下才出来。这就是「有时候点不开」。
// 宿主 userInteraction.show 本身就是按 (session, app, id) 原地 upsert 的，
// 重复调用是幂等的，所以没必要自己记状态：一律 show，收起交给面板里的「收起」。
// 发出去之后就不可撤销，别让它落到「点了没反应」那条路上。
// 关面板的唯一入口是面板里的「收起」按钮和宿主自己的关闭，两者都直连 dismiss。

// ─── 断点续接的对外可见性（2026-10-19 与用户定下）───
// 冻结的是「界面上看不看得见」，不是这套功能本身：判定、记账、日志全部照跑，
// 只是不再往设置页和球上送。当前 Hana 版本里真断联极少，弹出来的绝大多数是
// 子代理会话、模型限流、宿主自己重试——都不该打扰用户，先收起来观察。
// 解除入口留在设置页（标题连点五次），暗号只存哈希：源码里不落明文。
// ─── 语音收藏（2026-10-17 补回）───
// 只存引用不复制音频：合成好的 clip 已经落在本机，收藏只记 clipId + 文本 + 音色 +
// 来源伙伴，试听直接读原 clip。旧版是把 base64 音频再存一份，这里没那个必要。
const VOICE_FAVORITES_KEY = "voiceFavorites";
const VOICE_FAVORITES_LIMIT = 200;

async function listVoiceFavorites(sdk) {
  const raw = await sdk.storage.global.get(VOICE_FAVORITES_KEY, []);
  return Array.isArray(raw) ? raw.filter((item) => item && typeof item === "object" && item.clipId) : [];
}

async function favoriteVoiceClip(sdk, body) {
  const clipId = String(body?.clipId || "");
  const text = String(body?.text || "").trim();
  const format = String(body?.format || "mp3") === "wav" ? "wav" : "mp3";
  if (!isValidClipId(clipId)) {
    const error = new Error("这段音频没法收藏，重新朗读一次。");
    error.code = "VOICE_FAV_BAD_ID";
    throw error;
  }
  if (!readClip(sdk, clipId, format)) {
    const error = new Error("这段音频已经不在了，重新朗读一次。");
    error.code = "VOICE_FAV_NOT_FOUND";
    throw error;
  }
  const items = await listVoiceFavorites(sdk);
  // 同一段重复收藏就当已收藏，不让列表堆重复条目。
  const existing = items.find((item) => item.clipId === clipId && item.text === text);
  if (existing) return { already: true, item: existing, message: "这段已经收藏过了" };
  const item = {
    id: `fav_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    clipId,
    text: text.slice(0, 500),
    format,
    voiceId: String(body?.voiceId || ""),
    agentId: String(body?.agentId || ""),
    agentName: String(body?.agentName || ""),
    createdAt: Date.now(),
  };
  await sdk.storage.global.set(VOICE_FAVORITES_KEY, [...items, item].slice(-VOICE_FAVORITES_LIMIT));
  await sdk.logger?.info?.(`已收藏一段语音：${item.id}`);
  return { item, message: "已收藏 ♡ 设置页「语音收藏」里能听" };
}

const ASK_TOOL_NAME = "jiegehua_zhiyi_ask";
const STYLE_REFINE_TOOL_NAME = "jiegehua_zhiyi_refine_recommendation_styles";
const STYLE_APPLY_TOOL_NAME = "jiegehua_zhiyi_apply_recommendation_styles";
// 临时开关：验完立刻改回 false。
// 临时开关：已验完并删除（结论见 PROJECT_LOG）。
const DIAG_SESSION_PROBE = false;
const CARD_BIND_TOOL = "jiegehua_zhiyi_bind_card";
const CARD_RESOLVE_TOOL = "jiegehua_zhiyi_resolve_card";
const CARD_FALLBACK_TOOL = "jiegehua_zhiyi_native_fallback";
const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));

// 朗读合成：页面与传音樱共用同一条路，定位失败就报，不静默改念另一句。
//
// 缓存：同一段话、同一个音色与语速合成的音频不该重复收费。key 走「清洗后文本 +
// 实际音色 + 会影响声音的配置」的哈希；命中时只读回原来那份 clip 与 sidecar 里的词级时间戳，
// 不重新合成、不改声音。音频文件没了、配置变了（换音色/语速/协议/模型）就照常重合成。
const VOICE_CLIP_CACHE_KEY = "voiceClipCache";
const VOICE_CLIP_CACHE_LIMIT = 80;

function voiceFingerprint(text, voiceId, config) {
  return createHash("sha256")
    .update(JSON.stringify({
      text,
      voiceId,
      protocol: config.protocol,
      baseUrl: config.baseUrl,
      model: config.model,
      groupId: config.groupId,
      speed: config.speed,
      scope: config.scope,
    }))
    .digest("base64url")
    .slice(0, 40);
}

async function readClipCacheIndex(sdk) {
  const raw = await sdk.storage.global.get(VOICE_CLIP_CACHE_KEY, {});
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

async function rememberCachedSpeak(sdk, fingerprint, clipId) {
  const index = await readClipCacheIndex(sdk);
  const entries = Object.entries(index).filter(([key]) => key !== fingerprint);
  entries.push([fingerprint, clipId]);
  // 只留最近这些；被挤掉的旧音频文件不删（语音收藏还引用着它的 clipId）。
  await sdk.storage.global.set(VOICE_CLIP_CACHE_KEY, Object.fromEntries(entries.slice(-VOICE_CLIP_CACHE_LIMIT)));
}

async function readCachedSpeak(sdk, fingerprint) {
  const clipId = String((await readClipCacheIndex(sdk))[fingerprint] || "");
  if (!clipId) return null;
  const meta = readClipMeta(sdk, clipId);
  if (!meta || meta.fingerprint !== fingerprint) return null;
  if (!clipExists(sdk, clipId, meta.format || "mp3")) return null;
  // clipId 就是 sidecar 的文件名，读回来时补上。
  return { ...meta, clipId };
}

async function speakByEntry(sdk, { sessionId = "", entryId = "", entryIds = [], text = "", draft = false, allowCache = true } = {}) {
  const config = normalizeVoiceConfig(await sdk.storage.global.get("voiceConfig", {}));
  const target = await resolveSpeakTarget(sdk, { sessionId, entryId, entryIds, text });
  // draft：前端改过稿的正文。那是她亲手删过的，不能再套字数上限或「只念引号」。
  const prepared = draft ? prepareDraftText(target.raw) : prepareSpeakText(target.raw, config);
  if (!prepared.text) throw new Error("清洗之后没有可以朗读的内容。");
  const voiceId = resolveVoiceIdForAgent(config, target.agentId);
  const fingerprint = voiceFingerprint(prepared.text, voiceId, config);
  const shape = {
    voiceId,
    agentId: target.agentId,
    sessionId: target.sessionId,
    // 改稿走文字通道时 target.entryId 是空的，但回执还得带上原编号：
    // 传音樱靠它认领回包，不然球上永远等不到结果。
    entryId: target.entryId || entryId,
    text: prepared.text,
    matched: prepared.matched,
    truncated: prepared.truncated,
  };
  if (allowCache) {
    const hit = await readCachedSpeak(sdk, fingerprint);
    if (hit) {
      await sdk.logger.info(`朗读命中缓存：${String(hit.clipId)} / ${hit.format} / 词级标记 ${hit.timings?.length ?? 0} 条 / 音频约 ${Math.round(Number(hit.durationMs) || 0)} ms / 时间戳首尾 ${Math.round(Number(hit.timings?.[0]?.start) || 0)}-${Math.round(Number(hit.timings?.at?.(-1)?.end) || 0)}`);
      return { ...shape, clipId: hit.clipId, file: clipFile(sdk, hit.clipId, hit.format || "mp3"), format: hit.format || "mp3", durationMs: hit.durationMs, timings: hit.timings || null, cached: true };
    }
  }
  const result = await synthesizeVoice(sdk, { text: prepared.text, config, voiceId });
  const clipId = `clip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const file = saveClip(sdk, clipId, result.audio, result.format);
  saveClipMeta(sdk, clipId, { fingerprint, format: result.format, durationMs: result.durationMs, timings: result.timings || null, voiceId });
  if (allowCache) await rememberCachedSpeak(sdk, fingerprint, clipId);
  const timings = result.timings || [];
  await sdk.logger.info(`朗读已合成：${prepared.text.length} 字 / ${result.format} / 词级标记 ${timings.length} 条 / 音频约 ${Math.round(Number(result.durationMs) || 0)} ms / 时间戳首尾 ${Math.round(Number(timings[0]?.start) || 0)}-${Math.round(Number(timings.at(-1)?.end) || 0)}`);
  return {
    clipId,
    file,
    format: result.format,
    durationMs: result.durationMs,
    timings: result.timings || null,
    cached: false,
    ...shape,
  };
}

// 传音樱朗读：球只能轮询桥、不能回调 App，所以这条推送链由 App 主动。
// 球打开朗读窗 → 桥报 readOpen → App 下发回复列表；球选中 → 桥报 selectionSeq 变化 → App 合成并回填结果。
const VOICE_BRIDGE_POLL_MS = 1500;
const VOICE_BRIDGE_LIST_TTL_MS = 60_000;
let voiceBridgeTimer = null;
const voiceBridgeState = { lastSelectionSeq: 0, pushedAt: 0, lastFavSeq: 0, lastForcePushAt: 0, lastTextSeq: 0 };

function scheduleVoiceBridgeTick(sdk, ball) {
  if (voiceBridgeTimer) return;
  voiceBridgeTimer = setTimeout(() => { voiceBridgeTimer = null; void voiceBridgeTick(sdk, ball); }, 200);
  voiceBridgeTimer.unref?.();
}

async function voiceBridgeTick(sdk, ball) {
  if (!ball.state().running) { voiceBridgeState.pushedAt = 0; return; }
  try {
    const state = await ball.bridgeRequest("/voice/state");
    // 语音收藏：球点了「♡ 收藏」就挂在朗读这条桥上，不另开通道。
    const favSeq = Number(state?.favSeq) || 0;
    const fav = state?.fav || null;
    // 球重启后 favSeq 从 0 重数，App 这边还记着旧号会永远不满足 >，收藏点击就好像没反应。
    if (favSeq < voiceBridgeState.lastFavSeq) voiceBridgeState.lastFavSeq = 0;
    if (fav && favSeq > voiceBridgeState.lastFavSeq) {
      voiceBridgeState.lastFavSeq = favSeq;
      let favResult;
      try {
        const added = await favoriteVoiceClip(sdk, fav);
        favResult = {
          ok: true, seq: favSeq, already: added.already,
          message: added.message || "已收藏 ♡ 设置页「语音收藏」里能听",
        };
      } catch (error) {
        await sdk.logger.warn("球内语音收藏失败", { code: error?.code || "VOICE_FAVORITE_ERROR" });
        favResult = { ok: false, seq: favSeq, error: String(error?.message || "收藏失败了，再试一次").slice(0, 200) };
      }
      try {
        await ball.bridgeRequest("/voice/fav-result", { method: "POST", body: favResult });
      } catch (error) {
        await sdk.logger.debug?.("语音收藏结果未送达传音樱", { error: String(error?.message || error).slice(0, 120) });
      }
    }
    if (state?.readOpen) {
      // 球点「改稿」要全文：列表里的 text 只带前 1200 字，这里按请求把整条取回。
      const textRequest = state?.textRequest;
      const textSeq = Number(state?.textSeq) || 0;
      if (textSeq < voiceBridgeState.lastTextSeq) voiceBridgeState.lastTextSeq = 0; // 桥重启后序号归零
      if (textRequest && typeof textRequest === "object" && textSeq > voiceBridgeState.lastTextSeq) {
        voiceBridgeState.lastTextSeq = textSeq;
        const requestSessionId = String(textRequest.sessionId || state?.sessionId || "");
        const requestEntryId = String(textRequest.entryId || "");
        try {
          const full = await readFullReplyText(sdk, { sessionId: requestSessionId, entryId: requestEntryId });
          await ball.bridgeRequest("/voice/text-result", {
            method: "POST",
            body: { seq: textSeq, text: full.text, chars: full.chars },
          });
        } catch (error) {
          await ball.bridgeRequest("/voice/text-result", {
            method: "POST",
            body: { seq: textSeq, error: String(error?.message || error).slice(0, 200) },
          });
        }
      }
      // 球上换了目标（或点了刷新）会给一个 forcePushAt 时间戳：比上次大就重拉，不吃 60 秒缓存。
      // 以前是一个「读到即清」的布尔，但球自己也读这个接口，抢先把信号吃掉，App 就永远不重拉。
      const forcePushAt = Number(state?.forcePushAt) || 0;
      if (forcePushAt > voiceBridgeState.lastForcePushAt || !voiceBridgeState.pushedAt || Date.now() - voiceBridgeState.pushedAt > VOICE_BRIDGE_LIST_TTL_MS) {
        // 以前这里永远不传 sessionId，于是不管球上固定了哪段对话，列表都取「最近活跃」那条。
        // 实机：固定了 A，朗读窗里却念出了 B 的内容。现在按球上的固定状态取，跟随最近才取最近。
        const targetState = normalizeBallTargetState(await sdk.storage.global.get("ballTarget", {}));
        const pinnedSessionId = targetState.mode === "pinned" && targetState.pinned ? targetState.pinned.sessionId : "";
        const listed = await listSpeakableReplies(sdk, { sessionId: pinnedSessionId, limit: 8 });
        await ball.bridgeRequest("/voice/push", {
          method: "POST",
          body: {
            sessionId: listed.session.sessionId,
            agentId: listed.session.agentId,
            replies: listed.replies,
          },
        });
        voiceBridgeState.pushedAt = Date.now();
        voiceBridgeState.lastForcePushAt = Math.max(voiceBridgeState.lastForcePushAt, forcePushAt);
      }
      const seq = Number(state.selectionSeq) || 0;
      // 同理：球重启后 selectionSeq 归零，不重建基线的话，在朗读窗里点什么都不会合成。
      if (seq < voiceBridgeState.lastSelectionSeq) voiceBridgeState.lastSelectionSeq = 0;
      if (state.selectedEntryId && seq > voiceBridgeState.lastSelectionSeq) {
        voiceBridgeState.lastSelectionSeq = seq;
        // 球上改过稿就带着稿子来：走文字通道，不再拿 entryId 去拼原文。
        const draftText = String(state.selectedText || "").trim();
        try {
          const spoken = await speakByEntry(sdk, {
            sessionId: String(state.sessionId || ""),
            entryId: String(state.selectedEntryId || ""),
            text: draftText,
            draft: Boolean(draftText),
          });
          await ball.bridgeRequest("/voice/result", {
            method: "POST",
            body: { entryId: spoken.entryId || state.selectedEntryId, ok: true, selectionSeq: seq, ...spoken },
          });
        } catch (error) {
          await ball.bridgeRequest("/voice/result", {
            method: "POST",
            body: { entryId: state.selectedEntryId, ok: false, selectionSeq: seq, error: String(error?.message || error).slice(0, 200) },
          });
        }
      }
    } else {
      voiceBridgeState.pushedAt = 0;
    }
  } catch (error) {
    // 桥暂时不可用（球正在退出）不是错误，安静跳过；真要说话时球那边会自己报未连接。
    await sdk.logger.debug?.("传音樱朗读桥轮询跳过", { error: String(error?.message || error).slice(0, 120) });
  }
  scheduleVoiceBridgeTick(sdk, ball);
}

// 球内推荐与目标跟随：和朗读同一条路（球轮询桥、App 主动推）。
// 这里管调度与生命周期，具体读名单/生成推荐在 lib/ball-bridge.js。
let ballBridgeTimer = null;
let ballBridge = null;
function scheduleBallBridgeTick(sdk, ball) {
  if (ballBridgeTimer) return;
  ballBridgeTimer = setTimeout(() => {
    ballBridgeTimer = null;
    void ballBridgeTick(sdk, ball);
  }, 300);
  ballBridgeTimer.unref?.();
}

async function ballBridgeTick(sdk, ball) {
  if (!ball.state().running) { ballBridge = null; return; }
  try {
    if (!ballBridge) ballBridge = createBallBridge({ sdk, ball, logger: sdk.logger });
    await ballBridge.tick();
  } catch (error) {
    await sdk.logger.debug?.(`球推荐桥调度跳过：${String(error?.message || error).slice(0, 120)}`);
  }
  scheduleBallBridgeTick(sdk, ball);
}

// ── 守门人状态推给传音樱 ──
// 球不能回调 App，只能轮询自己的桥；所以这边定时把快照推过去，球只管显示。
// 只在球跑着的时候推，且状态没变就不推。
const sleepBallState = { lastKey: "", timer: null, lastActionSeq: 0, ready: false, bootId: "" };

/** 真关机开关的读值缓存：1.5 秒一轮，不能每轮都去打宿主 RPC。 */
let sleepRealCache = { at: 0, value: false };
async function readRealEnabledCached(sdk) {
  if (Date.now() - sleepRealCache.at < 3_000) return sleepRealCache.value;
  const value = await isRealEnabled(sdk);
  sleepRealCache.at = Date.now();
  sleepRealCache.value = value;
  return value;
}

/** 球上一级按钮按下的意图：arm 就挂，cancel 就撤。 */
async function applyBallSleepAction(sdk, kind) {
  if (kind === "cancel") {
    await cancelSleepGuard(sdk, "在传音樱上按了取消");
    await sdk.logger.info("传音樱取消守门");
    return;
  }
  if (describeSleepGuard().armed) return;
  await armSleepGuard(sdk, { armedBy: "ball", note: "传音樱一级按钮" });
  await sdk.logger.info("传音樱挂上静候（真关机）");
}

/** 拼一份要推给球的快照。 */
async function buildSleepBody(sdk) {
  const described = describeSleepGuard();
  const state = described.state || {};
  const body = {
    armed: described.armed === true,
    status: state.status || "idle",
    idleSeconds: Math.round((described.idleForMs || 0) / 1000),
    needSeconds: Math.round((state.idleMs || 0) / 1000),
    countdownSeconds: Math.round((described.countdownLeftMs || 0) / 1000),
    realEnabled: await readRealEnabledCached(sdk),
    busyCount: 0,
  };
  const summary = state.lastSummary;
  if (summary && typeof summary === "object") {
    body.busyCount = Number(summary.busyCount || 0) + Number(summary.tasks?.active || 0);
  }
  return body;
}

/** 推一次状态；状态指纹没变就不发（force 时例外，按钮按完要立刻看得见）。 */
async function pushSleepState(sdk, ball, force = false) {
  const body = await buildSleepBody(sdk);
  const key = `${body.armed}|${body.status}|${Math.floor(body.idleSeconds / 5)}|${body.busyCount}|${body.realEnabled}`;
  if (!force && key === sleepBallState.lastKey) return;
  sleepBallState.lastKey = key;
  await ball.bridgeRequest("/sleep/state", { method: "POST", body });
}

function startSleepBallPush(sdk, ball) {
  if (sleepBallState.timer) return;
  // 已执行到哪一号从盘上取：App 重载后不会把球上的旧按键再跑一遍。
  void (async () => {
    try {
      const saved = Number(await sdk.storage.global.get("sleepBallActionSeq", 0));
      const savedBoot = String(await sdk.storage.global.get("sleepBallBootId", "") || "");
      sleepBallState.bootId = savedBoot;
      if (Number.isFinite(saved) && saved > sleepBallState.lastActionSeq) {
        sleepBallState.lastActionSeq = saved;
      }
    } catch {}
    sleepBallState.ready = true;
  })();
  const tick = async () => {
    if (!ball.state().running) return;
    try {
      // 先读球上的按钮意图：球不能回调 App，只能把「人按了」写在自己的桥上。
      let remote = null;
      try {
        remote = await ball.bridgeRequest("/sleep/state", { method: "GET" });
      } catch {
        remote = null;
      }
      if (sleepBallState.ready && remote && remote.ok === true) {
        // 球换了（重启/重装）就从头算：它的 seq 又从 1 开始了。
        const bootId = String(remote.bootId || "");
        if (bootId && bootId !== sleepBallState.bootId) {
          sleepBallState.bootId = bootId;
          sleepBallState.lastActionSeq = 0;
          void sdk.storage.global.set("sleepBallBootId", bootId).catch(() => {});
        }
        const seq = Number(remote.actionSeq || 0);
        if (seq > sleepBallState.lastActionSeq) {
          sleepBallState.lastActionSeq = seq;
          void sdk.storage.global.set("sleepBallActionSeq", seq).catch(() => {});
          const kind = String(remote.action?.kind || "");
          if (kind === "arm" || kind === "cancel") {
            await applyBallSleepAction(sdk, kind);
            // 按完立刻把新状态推回去，不让它干等下一轮。
            sleepRealCache.at = 0;
            await pushSleepState(sdk, ball, true);
          }
        }
      }

      await pushSleepState(sdk, ball);
    } catch (error) {
      await sdk.logger.debug?.(`守门状态未送达传音樱：${String(error?.message || error).slice(0, 120)}`);
    }
  };
  sleepBallState.timer = setInterval(() => { void tick(); }, 1_500);
  sleepBallState.timer.unref?.();
  void tick();
}

// ── 断联续接（2026-10-14 与用户定下的分工）──
// 异常提醒归提个醒（它已经在做模型异常中断通知），知意只管续接：
// 订阅宿主事件做判定 → 自动或手动发一句「继续哈」 → 连续几次没成才在球里报一次。
// 所以这段代码不生产「出错了」类通知，只在续接用尽时推一条小条给传音樱。
function makeResumeTracker(config) {
  return createResumeTracker({
    autoResume: config.autoResume,
    maxConsecutive: config.maxConsecutive,
    cooldownMs: config.cooldownMs,
    stuckTimeoutMs: config.stuckTimeoutMs,
    // 等一发的回复上限与卡住阈值同口径：都是「多久没说话算异常」。
    awaitingTimeoutMs: config.stuckTimeoutMs,
  });
}

// 「这一轮是不是我们自己发的『继续哈』」——光看文字不够。用户自己打这三个字时
// 也会被当成 App 发的，那笔旧故障账就永远不清；而循环也靠它分辨「该不该让位给活人」。
// 所以要求两头对上：文字里有它，且最近一小段时间内我们真的往这段对话发过。
// 记在发送之前而不是之后：钩子可能在发送请求刚落地时就已经跑了，记晚了会漏。
const RESUME_OWN_WINDOW_MS = 30_000;
const lastResumeSentAt = new Map();
function rememberOwnResume(sessionId) {
  const id = String(sessionId || "");
  if (!id) return;
  lastResumeSentAt.set(id, Date.now());
  if (lastResumeSentAt.size > 200) {
    const oldest = lastResumeSentAt.keys().next();
    if (!oldest.done) lastResumeSentAt.delete(oldest.value);
  }
}
function forgetOwnResume(sessionId) {
  lastResumeSentAt.delete(String(sessionId || ""));
}
function isOwnResumePrompt(sessionId, prompt) {
  const text = String(prompt || "").trim();
  if (!text.includes(RESUME_TEXT)) return false;
  const at = lastResumeSentAt.get(String(sessionId || "")) || 0;
  return at > 0 && Date.now() - at < RESUME_OWN_WINDOW_MS;
}

async function readResumeConfig(sdk) {
  return normalizeResumeConfig(await sdk.storage.global.get("resumeConfig", {}));
}

function normalizeNativeAskAnswer(answer, request) {  if (request.selectionMode !== "multiple" || answer?.action !== "confirmed") return answer;
  const value = answer?.value && typeof answer.value === "object" ? answer.value : {};
  const choice = request.options.flatMap((option, index) => value[`option_${index + 1}`] === true ? [option.label] : []);
  return { ...answer, value: { ...value, choice } };
}
let activeBallManager = null;
let shutdownHooksInstalled = false;
let activeFusionServiceDispose = null;

// 关键 Ask 卡的开关。默认开启，跟之前的行为一致；只有显式关掉才收起来。
// 关掉的目标是「模型完全不知道这张卡存在」：引导不注入、工具不注册、执行入口也拦一道。
function normalizeAskConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return { enabled: source.enabled !== false };
}

function installBallShutdownHooks() {
  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;
  // 卸载/重载时球必须停，但这是 App 自己的动作，不代表用户不想让它开着。
  // 标成 forShutdown 的停止不会把「球想要开着」这个意图改掉，新实例起来会自己恢复。
  process.once("SIGTERM", () => { void activeBallManager?.stop({ forShutdown: true }); });
  process.once("SIGINT", () => { void activeBallManager?.stop({ forShutdown: true }); });
  process.once("exit", () => {
    try { if (activeBallManager?.state().running) activeBallManager.stop({ forShutdown: true }); } catch {}
    try { activeFusionServiceDispose?.(); } catch {}
  });
}

export default defineApp(async (sdk) => {
  await sdk.logger.info("jiegehua-zhiyi loaded");
  // 钩子每轮都要读几份配置，而宿主给 App 的反向 RPC 只有 128 个并发槽（bundle 里的
  // MAX_PENDING）。钩子里只要有一个调用排在队尾撞上限，宿主就把**整条判定**丢掉
  // （日志里是 adjudicator threw ... App RPC concurrency limit reached），一次 Ask 引导
  // 或一段速览就这样静默没了——用户体验就是「时有时无」。所以现在的规矩是：
  //   钩子主路径只读内存快照，不发 RPC；读不到就后台补一次，本轮先按已知值走；
  //   readConfig 留给非钩子路径（设置页、手动操作），那边本来就该报错。
  // 设置页写配置走 saveConfig：写成功就连快照一起更新，用户改完下一次钩子立即生效。
  // 日志不能把正事带崩：logger 自己也走 RPC，撑上限时它会抛。
  // 早先那句 warn 一抛，整条判定就跟着没了，界面上只剩一句假报错。这里包一层：日志挂了也不影响正事。
  // 顺手带上一个节流：高频且提示意义不强的行（比如「这轮不够长不贴卡」）不必每轮占一个 RPC 仓。
  const safeLog = {
    info: (msg, fields) => { try { void Promise.resolve(sdk.logger.info?.(msg, fields)).catch(() => {}); } catch { /* 日志挂了就算了 */ } },
    warn: (msg, fields) => { try { void Promise.resolve(sdk.logger.warn?.(msg, fields)).catch(() => {}); } catch { /* 同上 */ } },
    debug: (msg, fields) => { try { void Promise.resolve(sdk.logger.debug?.(msg, fields)).catch(() => {}); } catch { /* 同上 */ } },
  };
  const logThrottleAt = new Map();
  /** 同一个 key 在 ms 内只返回 true 一次，给高频日志限流用。 */
  function logThrottled(key, ms = 60_000) {
    const now = Date.now();
    const last = logThrottleAt.get(key) || 0;
    if (now - last < ms) return false;
    logThrottleAt.set(key, now);
    if (logThrottleAt.size > 64) {
      const oldest = [...logThrottleAt.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) logThrottleAt.delete(oldest[0]);
    }
    return true;
  }
  const CONFIG_TTL_MS = 4_000;
  const configCache = new Map();
  const configRefreshing = new Set();
  // 速览配置的长期快照：钩子里只认这一份，saveConfig 写 "summaryConfig" 时清掉重读。
  let summaryConfigCache = null;
  function rpcBusy(error) {
    const text = `${error?.code || ""} ${error?.message || ""}`;
    return /concurrency limit|IPC_BUSY|RPC_BUSY/i.test(text);
  }
  function refreshConfigInBackground(key, fallback) {
    if (configRefreshing.has(key)) return;
    configRefreshing.add(key);
    void (async () => {
      try {
        const value = await sdk.storage.global.get(key, fallback);
        configCache.set(key, { at: Date.now(), value });
      } catch {
        // 读不到就继续用旧值，下一次钩子会再试。不让它冒到钩子外面去。
      } finally {
        configRefreshing.delete(key);
      }
    })();
  }
  /** 钩子专用：立刻给值，不在 RPC 上等。缓存没有就先返回 fallback，同时后台补一份。 */
  function peekConfig(key, fallback = null) {
    const hit = configCache.get(key);
    if (hit) return hit.value;
    refreshConfigInBackground(key, fallback);
    return fallback;
  }
  async function readConfig(key, fallback = null) {
    const hit = configCache.get(key);
    if (hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.value;
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const value = await sdk.storage.global.get(key, fallback);
        configCache.set(key, { at: Date.now(), value });
        return value;
      } catch (error) {
        lastError = error;
        if (!rpcBusy(error)) break;
        await new Promise((resolve) => { const timer = setTimeout(resolve, 150 + attempt * 200); timer.unref?.(); });
      }
    }
    if (hit) return hit.value;
    throw lastError;
  }
  async function saveConfig(key, value) {
    await sdk.storage.global.set(key, value);
    // 写成功立刻把快照换成新值：改完设置下一次钩子就按新值走，既不必等 TTL，也不发 RPC。
    configCache.set(key, { at: Date.now(), value });
    if (key === "summaryConfig") summaryConfigCache = null;
  }
  // 子代理会话不是用户窗口。知意挂在这两条会话钩子上的东西——Ask 引导注入、速览小卡、
  // 话单/循环/续接记账——全是给人看、等人回应的；落进伙伴派出去干活的那段会话里只剩噪音：
  // 模型要逐字读完，用户拿不到它，Ask 预检还要白跑一次模型调用。
  // 2026-10-26 实测：子代理的收尾回复被贴上「🌸 知意速览」，会话文件里能看到那张卡。
  const isSubagentHook = (invocation) => isSubagentSessionPath(
    String(invocation?.session?.path || invocation?.session?.sessionPath || ""),
  );
  // 载入时把钩子要用的配置一次读进快照，之后钩子主路径就不再排 RPC 队了。
  for (const key of ["askConfig", "askJudgeModel", "summaryConfig", "summaryModel", "styleRefineRequested"]) {
    try {
      configCache.set(key, { at: Date.now(), value: await sdk.storage.global.get(key, null) });
    } catch {
      // 读不到就先留空：钩子会拿 fallback 并自己后台补。
    }
  }
  // Ask 预检是钩子里最重的一笔：要占一次模型流，最长五秒。同一时间只放一个进飞，
  // 同一段输入的结论缓十分钟。连发同题不再重复问模型，并发的新会话也不会各自挂一条流，
  // 把仓存贴满——那正是「引导时有时无」的来源之一。
  const ASK_REVIEW_TTL_MS = 10 * 60_000;
  const askReviewCache = new Map();
  let askReviewInFlight = false;
  async function takeAskReview(configuredModel, prompt, onEvent = null) {
    if (!hasDecisionCue(prompt)) return null;
    const cacheKey = `${configuredModel?.provider || ""}/${configuredModel?.model || ""}\u0000${String(prompt || "")}`;
    const hit = askReviewCache.get(cacheKey);
    if (hit && Date.now() - hit.at < ASK_REVIEW_TTL_MS) return hit.review;
    // 已经有一次在飞：这一轮不排队，直接按「没有必问分岔」走（基础引导照旧注入）。
    if (askReviewInFlight) return null;
    askReviewInFlight = true;
    try {
      const review = await reviewAskNeed(sdk, prompt, configuredModel, onEvent);
      if (review) {
        askReviewCache.set(cacheKey, { at: Date.now(), review });
        if (askReviewCache.size > 64) {
          const oldest = [...askReviewCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (oldest) askReviewCache.delete(oldest[0]);
        }
      }
      return review;
    } catch {
      return null;
    } finally {
      askReviewInFlight = false;
    }
  }
  // 速览判据要读「用户这条到底要什么」：每读一次就是一次历史读取（RPC + 文件解析）。
  // 同一段对话十秒内复用上一份，足够新，也省下一次排队。
  const lastUserCache = new Map();
  async function lastUserMessageCached(session) {
    const key = typeof session === "string" ? session : (session?.sessionPath ?? session?.path ?? "");
    const hit = lastUserCache.get(key);
    if (hit && Date.now() - hit.at < 10_000) return hit.text;
    const text = await lastUserMessage(sdk, session);
    if (lastUserCache.size > 32) lastUserCache.clear();
    lastUserCache.set(key, { at: Date.now(), text });
    return text;
  }
  const askEnabledAtLoad = normalizeAskConfig(configCache.get("askConfig")?.value).enabled;  await sdk.logger.info("Ask card registration decided at load", { enabled: askEnabledAtLoad });
  await sdk.hooks.onDecision("agent/before-start", async (invocation) => {
    // 子代理会话整条跳过：不注入、不记账、不预检。
    if (isSubagentHook(invocation)) return undefined;
    // 循环续接：用户自己开口就停（循环自己补发的那句要排除在外）。
    const loopSessionId = String(invocation?.session?.sessionId || "");
    const incomingPrompt = String(invocation?.prompt || "");
    if (loopSessionId && loopRegistry.get(loopSessionId) && !isOwnResumePrompt(loopSessionId, incomingPrompt)) {
      const stoppedLoop = loopRegistry.onUserMessage(loopSessionId);
      if (stoppedLoop) {
        await sdk.logger.info("用户接过话，循环续接已停");
        await pushLoopState(null);
      }
    }
    // 排队话单在这里只做一件事：判断这一轮是不是用户自己开口（活人接手，话单当场停）。
    // 「该发下一句」不再靠这里：这一轮到底结束没结束，由 pumpQueue 看会话忙闲决定。
    if (loopSessionId) {
      const plan = queuePlans.get(loopSessionId) || queuePlans.resolve(loopSessionId);
      if (plan && plan.status === "running") {
        if (queuePlans.isOwnPrompt(plan.sessionId, incomingPrompt)) {
          queuePlans.markDelivered(plan.sessionId);
          safeLog.info("排队话单：这一轮是我们排的那句", { sessionId: plan.sessionId });
          await pushQueueState(queuePlans.get(plan.sessionId));
        } else if (plan.sessionId === loopSessionId) {
          // 同一段对话里用户自己开口：活人接手，不跟人抢麦。
          const stoppedPlan = queuePlans.onUserMessage(plan.sessionId);
          if (stoppedPlan) {
            await sdk.logger.info("用户接过话，排队话单已停");
            await pushQueueState(null, { message: "你自己接过话了，话单停了" });
          }
        } else {
          // 编号对不上（认的是「唯一在跑」那份）时不敢停：
          // 那可能是另一段对话在说话，拿它去停话单属于误杀。
          safeLog.debug("排队话单：编号对不上，这轮不当作用户插话", { got: loopSessionId, use: plan.sessionId });
        }
      }
    }
    // 卡住兜底的时间起点：这一轮开始了。
    // 用户自己开口 = 旧故障作废，新开一轮。「继续哈」是 App 自己发的，
    // 不能当成用户说话去清自己的账，否则刚发出去的续接会被自己抹掉。
    const isResumePrompt = isOwnResumePrompt(loopSessionId, incomingPrompt);
    // 子代理会话不记账：事件侧的 sessionPath 有时是空的，钩子这层再挡一道。
    const resumeSessionPath = String(invocation?.session?.path || invocation?.session?.sessionPath || "");
    if (resumeConfig.enabled && invocation?.session?.sessionId && !isSubagentSessionPath(resumeSessionPath)) {
      if (!isResumePrompt) {
        resumeTracker.forget(invocation.session.sessionId);
        resumeSignals.delete(resumeTracker.canonicalId(invocation.session.sessionId));
        // 用户自己接过了手：手动连发那笔账也就到头了，别让它一直挂在面板上。
        manualRounds.delete(resumeTracker.canonicalId(invocation.session.sessionId));
        const hadNotice = resumeNoticeKey === resumeTracker.canonicalId(invocation.session.sessionId);
        if (hadNotice && resumeNoticeSource !== "loop_confirm") void pushResumeNotice(null);
      }
      // 顺手把两套编号对上：钩子这一层同时握着 sessionId 和 path，是全流程里
      // 唯一不必问宿主就能建映射的地方。事件路径（turn_end）靠它省下一次名单。
      rememberSessionPath(resumeSessionPath, invocation.session.sessionId);
      resumeTracker.markStarted(invocation.session.sessionId);
    }
    // 每轮都现读开关：关掉后不必等重新加载，引导立刻不再注入。
    // 这里全部走内存快照（peekConfig 不发 RPC）：只要钩子在 RPC 上等一次，就可能撞上
    // 宿主并发上限、整条判定被丢，引导就这样时而有一回没一回。
    const askEnabled = normalizeAskConfig(peekConfig("askConfig", null)).enabled;
    let prompt = invocation?.systemPrompt;
    if (askEnabled) {
      try {
        const configuredModel = peekConfig("askJudgeModel", null);
        // 诊断事件先收在内存里，预检跑完只发一条日志：每条 event 都打一次是白占 RPC 仓。
        const events = [];
        const review = await takeAskReview(configuredModel, invocation?.prompt, (event) => { events.push(event); });
        if (events.length) void sdk.logger.debug?.("Ask model precheck", events[events.length - 1]);
        prompt = appendAskGuidance(prompt, review);
      } catch (error) {
        // 预检出意外也要把基础引导带上：宁可没预检，不能连引导一起没。
        prompt = appendAskGuidance(prompt, null);
        safeLog.debug("Ask 预检出错，本轮只注入基础引导", { error: String(error?.message || error).slice(0, 120) });
      }
    }
    // 推荐回复只活在传音樱里，主对话不再出卡，也就没有推荐引导可注。
    // 设置页点了「方向不太对？和小花聊聊」→ 这一轮先把意图交给伙伴，只注一次。
    let refineHint = "";
    if (peekConfig("styleRefineRequested", false) === true) {
      await saveConfig("styleRefineRequested", false);
      refineHint = "（知意）用户刚在设置里点了「方向不太对，和你聊聊」。先用一两句话问清楚他想怎么改，别急着调工具；他说完你再调 jiegehua_zhiyi_refine_recommendation_styles 出建议。";
    }
    return { systemPrompt: `${prompt}${refineHint}` };
  });

  // ── 历史速览卡的消毒 ──
  // 旧版解语花是靠**系统提示词**让主模型自己在正文末尾写速览的（见旧插件
  // extensions/observer.js 的 replySummaryInstructions，more 档写着「大约 300 字以上」，
  // 还另开一条「需要用户拍板就加，哪怕没到字数门槛」），所以历史里那些卡实际上是
  // **模型自己写的东西**。现在那套提示已经不在跑了，但卡还留在会话历史里，
  // 而模型每轮都会读到历史——它看到的是自己以前这么写过，于是接着这么写。
  // 在下游清卡治不了根：清掉的是显示，模型看的还是带卡的历史，下一轮又写一张。
  // 所以在这里把发给模型的历史也洗干净：它看不见这个格式，就慢慢不会再写。
  await sdk.hooks.onDecision("provider/before-request", async (invocation) => {
    const payload = invocation?.payload;
    if (!payload || typeof payload !== "object") return undefined;
    const cleaned = stripSummaryFromPayload(payload);
    return cleaned === payload ? undefined : { payload: cleaned };
  });
  // 长回复速览：正文达到阈值时生成几行要点，以引用块小卡接在原文末尾。
  // 原文完整保留，速览只是附在后面的一段。
  let summarizing = false;
  // 这份配置的快照存在文件顶部（summaryConfigCache），钩子里只读它；saveConfig 写盘时清。
  async function readSummaryConfig() {
    if (summaryConfigCache) return summaryConfigCache;
    try {
      summaryConfigCache = normalizeSummaryConfig(await readConfig("summaryConfig", {}));
    } catch (error) {
      // 读不到就这一轮不做速览（默认值是开着的，不能拿默认值当真相，那会白花一次模型调用）。
      await sdk.logger.debug?.("长回复速览配置读取失败，这轮跳过", {
        error: String(error?.message || error?.code || error).slice(0, 120),
      });
      return { enabled: false, minChars: DEFAULT_MIN_CHARS };
    }
    return summaryConfigCache;
  }
  // check 必须在 try 外面声明：catch 里要读它，写在 try 块内会在错误处理时再抛一次。
  let check = null;
  await sdk.hooks.onDecision("messages/post-assistant", async (invocation) => {
    // 子代理会话整条跳过：不贴速览卡、不跑速览模型、不记账。
    if (isSubagentHook(invocation)) return undefined;
    // 排队话单：这一轮说完了，把下一句送进去。
    // 带工具调用的那条不算「说完了」：那是一轮里的中间段，提前送下一句会把 ta 打断。
    //
    // 放在钩子最前面：钩子是一次性判定，宿主对 App RPC 有并发上限，撞上限时整条钩子会被丢掉。
    // 前面任何一段抛了，排队这一段就轮不到——话单会一直停在「排队中 第 n/N 轮」。
    if (invocation?.session?.sessionId && !hasToolCalls(invocation?.message)) {
      try {
        await fireQueuePlan(String(invocation.session.sessionId), readBodyText(invocation?.message), { source: "hook" });
      } catch (error) {
        safeLog.warn(`排队话单钩子判定出错：${String(error?.message || error).slice(0, 160)}`);
      }
    }
    // 这一轮真的说完了才算恢复：工具中间轮只是把卡住计时作废，不能清失败计数，
    // 也不能收掉那条小条。bus 的 turn_end 偶尔会缺，这一处是兵底。
    if (resumeConfig.enabled && invocation?.session?.sessionId
      && !isSubagentSessionPath(invocation?.session?.path || invocation?.session?.sessionPath || "")) {
      const sessionKey = invocation.session.sessionId;
      const agentId = String(invocation?.session?.agentId || "");
      const parts = Array.isArray(invocation?.message?.content) ? invocation.message.content : [];
      const hasToolCall = parts.some((part) => part && (part.type === "tool-call" || part.type === "toolCall" || part.toolCall || part.tool_use));
      const stopReason = String(invocation?.message?.stopReason || "");
      if (!hasToolCall && (!stopReason || stopReason === "stop")) {
        const canonicalKey = resumeTracker.canonicalId(sessionKey);
        resumeTracker.markRecovered(sessionKey, agentId);
        resumeSignals.delete(canonicalKey);
        if (resumeNoticeKey === canonicalKey && resumeNoticeSource !== "loop_confirm") void pushResumeNotice(null);
        void pushResumeProgress();
      } else {
        resumeTracker.markProduced(sessionKey, agentId);
      }
    }
    // 循环续接：这一轮说完了，决定要不要再推一句「继续哈」。
    if (!loopFiring && invocation?.session?.sessionId) {
      try {
        await fireContinueLoop(String(invocation.session.sessionId), readBodyText(invocation?.message), {
          agentId: String(invocation?.session?.agentId || ""),
          source: "hook",
        });
      } catch (error) {
        safeLog.warn(`循环续接钩子判定出错：${String(error?.message || error).slice(0, 160)}`);
      }
    }
    try {
      const config = await readSummaryConfig();
      if (!config.enabled) return undefined;
      if (summarizing) return undefined;

      // 这一轮可能是「正文 → 工具调用 → 正文」多段拼起来的：中间那条 assistant 消息
      // 带着 toolCall，后面一定还有正文。这时就插速览，卡片会夹在回复中间（实测就是
      // 这样：速览出现在段落之间，后面还接着写）。带工具调用的那条一律跳过，等最后一条。
      // 中间段的提示最多 30 秒说一次：多步工具调用的回合里，这句会连着打几遍，白占 RPC 仓。
      if (hasToolCalls(invocation?.message)) {
        if (logThrottled("summary-skip-toolcall", 30_000)) {
          safeLog.debug("长回复速览跳过：这条消息还带工具调用，后面还有正文");
        }
        return undefined;
      }

      const rawText = readBodyText(invocation?.message);
      if (!rawText) return undefined;

      // ── 先无条件把卡全部摘掉，再谈要不要贴新卡 ──
      // 以前只在「不够长」时摘，结果两条路都漏：
      //   ① 够长时直接 replace，靠 replaceSummaryBlock 自己剥；
      //   ② 不够长又没卡时啥也不做。
      // 真正漏掉的是第三种：**模型自己写的卡**。实测同一条消息里挖出过 4 张
      // `> **速览** · 原文 N 字`（607/890/309/1216 四个不同数字，而正文只有 1359 字），
      // 而 replaceSummaryBlock 每次先剥再贴，绝不可能留下 4 张——能叠成这样只有一种解释：
      // 模型在写正文时顺手写进去了。它甚至把字数也自己编一个。
      // 所以清卡不能再依附于「够不够长」这个分支，得无条件执行。
      const issuedByModel = (rawText.match(/^>[ \t]*\*\*(?:🌸[ \t]*)?(?:知意)?速览\*\*/gmu) || []).length;
      const withoutCards = stripSummaryInMessage(invocation?.message);
      const bodySource = readBodyText(withoutCards) ?? rawText;
      const text = stripMoodBlock(bodySource);
      const hadCards = withoutCards !== invocation?.message;
      if (hadCards && issuedByModel > 1) {
        // 超过一张说明不是我们贴的（我们永远只留一张），日志留个脚印好查。
        await sdk.logger.info(`正文里有 ${issuedByModel} 张速览卡，不是知意贴的，已清掉`);
      }

      const userText = await lastUserMessageCached(invocation?.session);
      check = shouldSummarize({ text, minChars: config.minChars, userText });
      if (!check.ok) {
        // 不够线就不该有卡：不管是早先贴的旧卡，还是模型自己写的，一并清掉。
        if (hadCards) {
          await sdk.logger.info(`撒掉不应存在的速览卡：${check.reason}（现 ${text.length} 字）`);
          return { message: withoutCards };
        }
        // 不足阈值是最常见的路，每分钟说一次就够；以前每轮一条 info，光日志就占一个 RPC 仓。
        if (logThrottled(`summary-under:${check.reason}`, 60_000)) {
          safeLog.info(`长回复速览跳过：${check.reason}（${text.length} 字）`);
        }
        return undefined;
      }

      summarizing = true;
      try {
        // 模型配置也走内存快照：钩子里每多一次 RPC 等，就多一分被并发上限丢掉的可能。
        const configuredModel = resolveSummaryModelRef(
          peekConfig("summaryModel", null),
          peekConfig("askJudgeModel", null),
        );
        const events = [];
        const { lines, elapsedMs, effort, attempts, reasoningTokens } = await summarizeReply(sdk, text, configuredModel, (event) => {
          events.push(event);
        });
        if (events.length) safeLog.debug("长回复速览模型流", events[events.length - 1]);
        const sessionPath = typeof invocation?.session === "string"
          ? invocation.session
          : (invocation?.session?.sessionPath ?? invocation?.session?.path ?? "");
        saveOriginalArchive(sdk.dataDir, { sessionPath, chars: check.chars, text, lines });
        const next = replaceSummaryBlock(invocation.message, buildSummaryBlock(lines, check.chars));
        if (!next) return undefined;
        // effort / reasoningTokens 记进日志：下次再空正文，日志会直接写“思考吃了多少”，不用猜。
        await sdk.logger.info(`长回复已附速览小卡（${check.chars} 字，${lines.length} 行，耗时 ${elapsedMs}ms）`, { chars: check.chars, lines: lines.length, elapsedMs, model: invocation?.message?.model ?? null, effort: effort || "(默认档)", attempts, reasoningTokens });
        return { message: next };
      } finally {
        summarizing = false;
      }
    } catch (error) {
      // 任何一步失败都保留原文，宁可啰嗦也不让内容丢失。
      const detail = recordSummaryFailure(sdk.dataDir, error, { chars: check?.chars ?? null });
      // 失败日志限流：短句、模型慢的时候这条会连着刷，刷到最后只剩噪音。
      if (logThrottled(`summary-fail:${detail.code ?? "none"}`, 60_000)) {
        safeLog.warn(`长回复速览失败，保留原文：${detail.code ?? "no-code"} ${detail.message}`);
      }
      return undefined;
    }
  });

  // 「球是不是用户想让它开着」这个意图必须落盘：App 重载会把子进程一起带走，
  // 不记事的话每次改完东西球就没了，得人手点一次（2026-10-19 实机反复踩）。
  // 同时给意外退出一个自愈机会：只有用户本来就要它开着时，才自动拉起来。
  let ballDesired = false;
  let ballRestartAttempts = 0;
  let ballRestartTimer = null;
  const BALL_RESTART_DELAYS = [2_000, 5_000, 10_000];

  // 宿主重开过没有？用 ppid 问，不另找接口。
  // app 是宿主主 server 直接 spawn 的子进程（中间没有别的），所以 ppid 就是这一次的宿主身份。
  // 关键：它能把两件混在一起的事分开——
  //   改代码 / reload  → ppid 不变 → 球回来（2026-10-19 那个坑不能再踩）；
  //   退出 Hana 再开 / 电脑重启 → ppid 变了 → 不自己冒出来（2026-10-20 用户明确不要的）。
  const HOST_PID = typeof process !== "undefined" && Number.isInteger(process.ppid) ? process.ppid : 0;
  /** true=同一宿主该恢复，false=宿主重开过不恢复，null=拿不到 ppid 判不了。 */
  async function sameHostAsLastRun() {
    if (!HOST_PID) return null;
    const remembered = Number(await sdk.storage.global.get("ballHostPid", 0));
    // 没记过：当新宿主处理。宁可少自动一次，也不要在用户不知情时弹球。
    if (!Number.isInteger(remembered) || remembered <= 0) return false;
    return remembered === HOST_PID;
  }
  function rememberCurrentHost() {
    if (!HOST_PID) return;
    void saveConfig("ballHostPid", HOST_PID).catch(() => {});
  }

  const ball = createBallManager({
    sdk,
    appRoot: APP_ROOT,
    onStarted: () => {
      ballDesired = true;
      ballRestartAttempts = 0;
      if (ballRestartTimer) { clearTimeout(ballRestartTimer); ballRestartTimer = null; }
      void saveConfig("ballDesired", true).catch(() => {});
      rememberCurrentHost();
    },
    onExited: ({ code, intentional }) => {
      // 卸载/重载：新实例会按 ballDesired 把它接回来，这里什么都不改。
      if (intentional === "shutdown") return;
      if (intentional === "user") {
        ballDesired = false;
        void saveConfig("ballDesired", false).catch(() => {});
        return;
      }
      if (!ballDesired) return;
      if (ballRestartAttempts >= 3) {
        void sdk.logger.warn("传音樱连续意外退出三次，已停止自动重启；需要的话手动再开一次。");
        return;
      }
      const wait = BALL_RESTART_DELAYS[Math.min(ballRestartAttempts, BALL_RESTART_DELAYS.length - 1)];
      ballRestartAttempts += 1;
      if (ballRestartTimer) clearTimeout(ballRestartTimer);
      void sdk.logger.warn(`传音樱意外退出（${code ?? "未知状态"}），${Math.round(wait / 1000)} 秒后自动重启（第 ${ballRestartAttempts}/3 次）`);
      ballRestartTimer = setTimeout(() => {
        ballRestartTimer = null;
        void ball.start().catch(() => {});
      }, wait);
      ballRestartTimer.unref?.();
    },
  });
// 球上作答的回传通道：工具把题送到就返回，答案由这里轮询接收、补回原会话。
// 为什么不在这里等：宿主给工具执行的 RPC 只有 30 秒，球上却能挂十分钟。
const ballAsks = createBallAskWatcher({
  logger: sdk.logger,
  readAskResult: (askId) => ball.readAskResult(askId),
  send: async (text, sessionId) => {
    // steer 而不是 followUp：用户点球的那一刻，这一轮早就结束了、会话是空闲的。
    // followUp 的语义是「等 ta 说完再发」，安在空闲会话上会排队等一个永远不会来的
    // 轮次结束，实际表现就是「点了没反应」。steer 立刻发，直接把新回合拉起来。
    try {
      await sendToConversation(sdk, { text, mode: "steer", sessionId });
    } catch (error) {
      // 把宿主的原始拒绝带出来：只写「回传失败」等于什么都没说。
      const detail = String(error?.cause?.message || error?.message || error);
      await sdk.logger.warn(`回传发送被拒 code=${error?.code || "none"} raw=${detail.slice(0, 300)}`);
      throw error;
    }
  },
});
// App 重载后把球上还挂着的题接回来。不接的话，用户在那之后才作答，答案就没人接了——
// 题在球上画着、人点了、对话里却什么消息都没有，比直接报错更难查。
// 只认桥上带了 sessionId 的题（旧版入队的没带，回传地址不可知）。
async function adoptPendingBallAsks() {
  const rows = await ball.listPendingAsks();
  let adopted = 0;
  for (const row of rows) {
    const askId = String(row?.askId || "");
    const sessionId = String(row?.sessionId || "");
    if (!askId || !sessionId || ballAsks.has(askId)) continue;
    const options = Array.isArray(row?.options)
      ? row.options.map((option) => ({ label: String(option?.label || ""), detail: String(option?.description || "") }))
      : [];
    ballAsks.add({
      askId,
      sessionId,
      request: {
        title: String(row?.header || ""),
        question: String(row?.question || ""),
        options,
        selectionMode: row?.selectionMode === "multiple" ? "multiple" : "single",
      },
    });
    adopted += 1;
  }
  if (adopted) await sdk.logger.info(`已把球上 ${adopted} 道待答题接回回传队列`);
}
// 传音樱可能在上一次会话里已经开着；载入时就把朗读推送链接上。
if (ball.state().running) scheduleVoiceBridgeTick(sdk, ball);
// 目标跟随与球内推荐同样在载入时接上（球开着才有意义）。
if (ball.state().running) scheduleBallBridgeTick(sdk, ball);
if (ball.state().running) startSleepBallPush(sdk, ball);
// 重载前发出的题可能还挂在球上，接回来才能收到答案。
if (ball.state().running) void adoptPendingBallAsks().catch(() => {});
// 闲不住的融合协调器靠这个服务拿到球的坐标与桥地址；没授权就静默单侧运行。
const disposeFusionService = await registerFusionService({ sdk, ball });
activeFusionServiceDispose = disposeFusionService;

  // ── 断联续接 ──
  let resumeConfig = await readResumeConfig(sdk);
  // 冻结那层已经拆了（2026-10-23 用户拍板）：不再藏界面、不再要暗号，
  const resumeUiFrozen = false;
  let resumeTracker = makeResumeTracker(resumeConfig);
  // 手动「这次接几轮」的账：用户当场选了几轮、已经发出几句。
  // 这跟断点续接的失败计数（那是「重试了几次」）是两笔账，混在一行里显示只会误导——
  // 球上那一行以前写「已发送继续哈 0/3」，0 是手动时恒为零的失败计数，3 是全局重试上限，
  // 跟用户选的「连着接几轮」一点关系都没有。
  const manualRounds = new Map();
  // 循环续接（旧版「继续后自动循环」）：正常说完一轮也接着推「继续哈」，
  // 跑满设定轮数自己停；ta 说收工话时先屏住问用户。
  const loopRegistry = new ContinueLoopRegistry();
  let loopFiring = false;
  // 一轮结束现在有两条路会来判定（钩子、turn_end），两者相隔毫秒级。
  // 谁先判完就记一笔，短时间内另一路不再重复判，不然会连发两声「继续哈」。
  // 窗口只用于分辨「同一轮的两个信号」，所以取小值；正常轮次间隔远大于它。
  //
  // 按会话记：一段对话的一轮只有一两次判定机会，被别的对话挡掉就少接一句，
  // 而且不会补。早先这里是一个全局时间戳，两段对话同时续接时互相吞判定。
  const lastLoopDecidedAt = new Map();
  const LOOP_JUDGE_MEMORY = 200;

  /**
   * 循环续接判定：这一轮说完了，要不要再推一句「继续哈」。
   * 钩子（messages/post-assistant）与 turn_end 事件共用这一条路。
   */
  async function fireContinueLoop(sessionId, assistantText, { agentId = "", source = "" } = {}) {
    const id = String(sessionId || "").trim();
    if (!id || loopFiring || !loopRegistry.get(id)) return null;
    // 手动「这次接几轮」也走循环机制发后续那几句，但进度显示归那一行自己管，
    // 不再推循环状态（一级面板会出现两行进度，写着不同的轮数）。
    const manualKey = resumeTracker.canonicalId(id);
    const manual = manualRounds.get(manualKey) || null;
    // 失败轮（模型报错、被按停）：普通循环不该被它推进——宿主重试会连着来好几次，
    // 每次都推进就等于连发好几句。手动「接几轮」是另一回事：用户就是要 N 句，
    // 这一轮也确实走完了，所以放行；但几秒内不放行第二次（重试风暴会连着发）。
    if (!assistantText) {
      const last = manual?.lastAdvanceAt || 0;
      if (!manual || manual.status !== "running" || Date.now() - last < 10_000) return null;
      manual.lastAdvanceAt = Date.now();
    }
    if (!shouldJudgeLoop(lastLoopDecidedAt.get(id) || 0, Date.now())) {
      await sdk.logger.debug?.(`循环续接判定去重（${source}）：同一轮已经判过`);
      return null;
    }
    lastLoopDecidedAt.set(id, Date.now());
    if (lastLoopDecidedAt.size > LOOP_JUDGE_MEMORY) {
      const oldest = lastLoopDecidedAt.keys().next();
      if (!oldest.done) lastLoopDecidedAt.delete(oldest.value);
    }
    const decision = loopRegistry.decideAfterTurn(id, { assistantText });
    if (decision?.action === "continue") {
      loopFiring = true;
      rememberOwnResume(id);
      try {
        await sendToConversation(sdk, { text: RESUME_TEXT, mode: "steer", sessionId: id });
        const after = loopRegistry.markFired(id);
        if (manual && manual.status === "running") {
          manual.sent += 1;
          // 计划的几轮都发完了：这一行该写「已连着接 N/N」，不是还在等。
          if (after?.exhausted) manual.status = "finished";
        }
        await sdk.logger.info(`循环续接：已发出一条继续哈（第 ${after?.done ?? decision.state.done + 1}/${decision.state.total} 轮）`);
        if (manual) await pushResumeProgress();
        else await pushLoopState(loopRegistry.get(id));
      } catch (error) {
        forgetOwnResume(id);
        await sdk.logger.warn(`循环续接发送失败，循环停止：${String(error?.message || error).slice(0, 160)}`);
        loopRegistry.stop(id, "发送失败");
        if (manual) {
          manual.status = "failed";
          await pushResumeProgress();
        } else {
          await pushLoopState(null);
        }
      } finally {
        loopFiring = false;
      }
    } else if (decision?.action === "confirm") {
      if (manual) {
        manual.status = "paused";
        await pushResumeProgress();
      } else {
        await pushLoopState(decision.state);
      }
      await pushResumeNotice({
        source: "loop_confirm",
        sessionId: id,
        agentId: String(agentId || ""),
        reason: "ta 好像做完了。还接着续吗？",
      });
    } else if (decision?.action === "finished") {
      await sdk.logger.info("循环续接已完成设定轮数");
      if (manual) {
        manual.status = "finished";
        await pushResumeProgress();
      } else {
        await pushLoopState(null);
      }
    }
    return decision;
  }

  // ── 排队话单 ──
  // 球上写一句（或一串话），等 ta 这一轮说完再送进去；一串话就一轮一句往下推。
  // 与「循环续接」互斥：同一段对话上只留一样，免得两条一起往里塞话。
  const queuePlans = new QueuePlanRegistry();
  // 正在发的那几段对话：按会话记，不做全局开关——一段对话在发的时候，
  // 不该把另一段对话的轮末判定也一起挡住。
  const queueFiring = new Set();
  // 轮末也有两条信号（钩子、turn_end），同一段对话的同一轮只判一次，不然会连发两句。
  // 按会话记：全局记会让两段对话挨着结束时互相挡掉。
  const queueDecidedAt = new Map();
  // 同一段对话的轮末信号只判一次（钩子、turn_end、轮询三处都会喊）。
  const QUEUE_SEND_COOLDOWN_MS = 4_000;
  // 会话忙闲查不到时的等待：比冷却长得多，避免在 ta 写到一半时插进去。
  const QUEUE_UNKNOWN_STATE_WAIT_MS = 20_000;

  // 日志统一走顶部那份 safeLog（带节流），这里不重复定义。
  // 连续送不出去几次才真的停：宿主 RPC 撞上限时一次失败不代表话单坏了。
  const QUEUE_SEND_FAIL_MAX = 3;
  // 送失败几次（按会话）；以及明确没送出去时排的重试定时器。
  const queueSendFailures = new Map();
  const queueRetryTimers = new Map();
  // 当前这份话单属于桥上的第几次请求：推给球的状态里带着它，
  // 球据此认「这份回包是我的」，不会把别的推送当成回执。
  let queueStateRequestSeq = 0;

  /** 发送失败是不是「说不准有没有送到」？超时说不准，其余都说明根本没送出去。 */
  function isAmbiguousSendError(error) {
    return /timeout|超时|ETIMEDOUT/i.test(`${error?.code || ""} ${error?.message || ""}`);
  }

  /**
   * 输入框上方那条排队提示：排队在跑的时候挂上，写清楚排的是什么、排到第几轮。
   * 跟球开没开无关——不开传音樱的人也该看得见自己在排队。
   * 用户自己把这条关掉后，这一轮排队内不再重挂（不跟人抢）。
   */
  const QUEUE_BANNER_ID = "zhiyi-queue";
  const queueBannerPaths = new Map();   // sessionId → sessionPath（挂提示条要路径）
  const queueBannerShown = new Map();   // 已经挂出去的：sessionId → sessionPath（收的时候靠它）
  const queueBannerMuted = new Set();   // 用户手动关过的会话

  async function resolveQueueBannerPath(sessionId) {
    const id = String(sessionId || "");
    if (!id) return "";
    const cached = queueBannerPaths.get(id);
    if (cached) return cached;
    try {
      const target = await resolveResumeTarget({ sessionId: id });
      const path = String(target?.path || "");
      if (path) queueBannerPaths.set(id, path);
      return path;
    } catch {
      return "";
    }
  }

  /** 一条提示只讲两件事：排到第几轮、排的是什么。 */
  function describeQueueBanner(plan) {
    const items = Array.isArray(plan?.items) ? plan.items : [];
    const preview = items
      .map((item) => String(item?.text || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" / ");
    const done = Number(plan?.done || 0);
    const total = Number(plan?.total || 0);
    // 说「已发几句 / 共几轮」，不说「第几轮」：说第几轮时，发完第一句还是第 1 轮，
    // 看着像一句都没发出去（实机反馈）。已发数每送一句就动一下，进度才看得见。
    const head = total ? `排队中 已发 ${Math.min(done, total)}/${total} 轮` : "排队中";
    const body = preview.length > 80 ? `${preview.slice(0, 80)}…` : preview;
    return body ? `${head} · ${body}` : head;
  }

  /**
   * 提示条对齐：以「现在还在跑的话单」为准。
   * 以前是拿着传进来的 plan 去挂/收，可排队跑完时 plan 已经被清掉了，
   * 拿不到会话路径 → 收不掉 → 便签停在最后一次的样子（实机：一直显示 1/2）。
   * 现在反过来：先看哪些在跑，该挂的挂、该收的收。
   */
  async function syncQueueBanner({ finishing = false } = {}) {
    const running = queuePlans.list().filter((item) => item.status === "running");
    const wantIds = new Set();
    for (const plan of running) {
      const id = String(plan.sessionId || "");
      if (!id || queueBannerMuted.has(id)) continue;
      const path = await resolveQueueBannerPath(id);
      if (!path) continue;
      wantIds.add(id);
      queueBannerShown.set(id, path);
      try {
        await sdk.inputBanner.set({ sessionPath: path, bannerId: QUEUE_BANNER_ID, text: describeQueueBanner(plan) });
      } catch (error) {
        // 挂不上就算了：这只是提示，不能因为一条提示条把排队本身带坏。
        safeLog.debug("排队提示条没挂上", { error: String(error?.message || error).slice(0, 120) });
      }
    }
    // 不在跑的那些（发完了、停了、被替掉了）把提示收掉。
    for (const [id, path] of [...queueBannerShown]) {
      if (wantIds.has(id)) continue;
      queueBannerShown.delete(id);
      // 发完了不要一下子就不见（实机：用户还没看清就消失了）：
      // 先挂一句「已发完」，三秒后再收。
      if (finishing) {
        try {
          await sdk.inputBanner.set({ sessionPath: path, bannerId: QUEUE_BANNER_ID, text: "排队已发完" });
        } catch (error) {
          safeLog.debug("排队完成提示没挂上", { error: String(error?.message || error).slice(0, 120) });
        }
        setTimeout(() => {
          void sdk.inputBanner.dismiss({ sessionPath: path, bannerId: QUEUE_BANNER_ID }).catch(() => {});
        }, 3_000);
        continue;
      }
      try {
        await sdk.inputBanner.dismiss({ sessionPath: path, bannerId: QUEUE_BANNER_ID });
      } catch (error) {
        safeLog.debug("排队提示条没收掉", { error: String(error?.message || error).slice(0, 120) });
      }
    }
  }

  /** 用户把提示条关掉了：这一轮排队内不再重挂。 */
  function noteQueueBannerDismissed(event, sessionPath) {
    const kind = String(event?.kind || "");
    if (kind !== "dismissed") return false;
    // 别把关机那条的关闭事件当成排队那条：两条并存时它们会互相误伤。
    const payload = event?.payload ?? event?.data ?? event ?? {};
    const bannerId = String(payload?.bannerId ?? event?.bannerId ?? "");
    if (bannerId && bannerId !== QUEUE_BANNER_ID) return false;
    const id = String(event?.sessionId || "");
    if (id) {
      queueBannerMuted.add(id);
      return true;
    }
    for (const [sid, path] of queueBannerPaths) {
      if (path && path === String(sessionPath || "")) {
        queueBannerMuted.add(sid);
        return true;
      }
    }
    return true;
  }

  /* ── 关机提示条 ──
   * 挂在会话上的输入栏提示。要的是“切到哪个窗口都看得见”，
   * 所以不只挂一条跟着人走，而是给最近用过的几段对话各挂一条。
   * 她关掉哪一条，那一段就不再冒；关机取消时全部收掉。
   */
  const SHUTDOWN_BANNER_ID = "zhiyi-shutdown";
  const SHUTDOWN_BANNER_MAX = 4;
  /** 已经挂过的会话：path → 最后挂上去的文本 */
  const shutdownBannerTexts = new Map();
  /** 她手动关掉的会话（这次开机内不再重挂） */
  const shutdownMutedPaths = new Set();
  let shutdownBannerLoggedAt = 0;

  // 「我挂过哪几条」得落盘。
  //
  // 为什么：这张表原来只在内存里。App 一重载（升级、改代码、宿主重启）它就空了，
  // 可宿主上那几条提示条还在。App 不再知道它们存在，就不会去收，
  // 于是关机早取消了、横幅还一直挂在某个窗口上。
  // 2026-10-28 玥儿截了个图问「为啥还挂着」，就是这个。
  const SHUTDOWN_BANNER_KEY = "shutdownBannerMounted";
  let shutdownBannerRestored = false;

  async function persistMountedBanners() {
    try {
      // 没恢复成功就不写。
      // 否则会出现这个事故：启动时存储还没就绪、恢复失败，名单是空的，
      // 然后把空的写回去——磁盘上那份记录就真被抹掉了，下次重载也救不回来。
      if (!shutdownBannerRestored) return;
      await sdk.storage.global.set(SHUTDOWN_BANNER_KEY, {
        at: new Date().toISOString(),
        paths: [...shutdownBannerTexts.keys()].filter((p) => String(p).endsWith(".jsonl")),
      });
    } catch { /* 存不进去不影响主流程 */ }
  }

  /** 启动时把上次挂过的名单读回来，好让取消/收起时能真的把它们收掉。 */
  async function restoreMountedBanners() {
    if (shutdownBannerRestored) return;
    let raw = null;
    try {
      raw = await sdk.storage.global.get(SHUTDOWN_BANNER_KEY, null);
    } catch (error) {
      // 这次没读到就下次再试，不置标记。
      void sdk.storage.global.set("shutdownBannerRestoreDebug", {
        at: new Date().toISOString(), step: "get-failed",
        error: String(error?.message || error).slice(0, 120),
      }).catch?.(() => {});
      return;
    }
    const paths = Array.isArray(raw?.paths) ? raw.paths : [];
    let restored = 0;
    for (const path of paths) {
      const value = String(path || "").trim();
      // 只恢复看起来像会话路径的。
      // 账本里既有真实 sessionPath，也有裸的 sessionId（sess_xxx），
      // 后者拿去调 dismiss 是无效的，还会永远滞在名单里清不掉。
      if (!value || !value.endsWith(".jsonl")) continue;
      // 只恢复“知道它存在”，不恢复文本：文本每轮都会重新算。
      if (!shutdownBannerTexts.has(value)) shutdownBannerTexts.set(value, "");
      restored += 1;
    }
    void sdk.storage.global.set("shutdownBannerRestoreDebug", {
      at: new Date().toISOString(), step: "ok",
      rawIsNull: raw === null, rawPaths: paths.length, restored,
    }).catch?.(() => {});
    // 只有真读成功才标记完成。
    // 以前这行写在 try 外面，于是「启动时存储还没就绪、读抛错」
    // 也会把标记置上，之后永远不再重试——旧横幅就永远收不掉了。
    shutdownBannerRestored = true;
  }

  function describeShutdownBanner() {
    const described = describeSleepGuard();
    if (described.armed !== true) return "";
    const state = described.state || {};
    // 提醒尾巴：挂在输入框上方那条提示条是这个功能最长驻、最显眼的展示位。
    // 宿主横幅 text 上限 200 字符，所以这句得短，不能把整段警告塞进来。
    const saveTail = "· 别的内容请先存好";
    if (state.status === "shutdown-issued") {
      // 命令已经发出去了。这 30 秒里还能抢回来，所以提示条不能消失。
      // 以前 armed 不包含这个状态，提示条会直接收掉，人以为没事了。
      const left = Math.max(0, Math.round((described.abortLeftMs || 0) / 1000));
      return left > 0
        ? `关机已发出，约 ${left} 秒后关（还能撤）· 点一下取消`
        : "关机已发出，可撤销窗口已过";
    }
    if (state.status === "countdown") {
      const left = Math.max(0, Math.round((described.countdownLeftMs || 0) / 1000));
      return state.dryRun === true
        ? `${left} 秒后结束演练（不关机） ${saveTail}`
        : `${left} 秒后关机 ${saveTail}`;
    }
    const idleMin = Math.max(1, Math.round((state.idleMs || 0) / 60_000));
    // 尾巴上那个时间不只是给她看的：内容每次都在变，宿主不会因为“一模一样”跳过重画。
    const totalSec = Math.max(0, Math.round((described.sinceArmedMs || 0) / 1000));
    const mm = Math.floor(totalSec / 60);
    const ss = String(totalSec % 60).padStart(2, "0");
    if (state.dryRun === true) {
      return `演练中（不会真关）：Hana 空满 ${idleMin} 分钟走一遍流程 ${saveTail} · 已开 ${mm}:${ss}`;
    }
    return `会自动关机：Hana 没动静满 ${idleMin} 分钟就开始倒数 ${saveTail} · 已开 ${mm}:${ss}`;
  }

  /** 最近用过的几段对话：先查索引，查不到就直接问宿主要名单。 */
  /** 把这一轮提示条的名单与结果落盘一份，排查用。失败不影响任何主流程。 */
  async function recordBannerRound(text, paths) {
    try {
      const mounted = [...shutdownBannerTexts.keys()];
      await sdk.storage.global.set("shutdownBannerDebug", {
        at: new Date().toISOString(),
        text: String(text || "").slice(0, 200),
        candidates: Array.isArray(paths) ? paths.map((p) => String(p)) : [],
        mounted,
        muted: [...shutdownMutedPaths.keys()],
        ledgerPaths: (() => { try { return activityLedger?.paths?.() || []; } catch { return []; } })(),
      });
    } catch { /* 排查信息写不进去就算了 */ }
  }

  async function pickRecentSessionPaths(limit = SHUTDOWN_BANNER_MAX) {
    const out = [];
    const push = (path) => {
      const value = String(path || "").trim();
      if (value && !out.includes(value)) out.push(value);
    };
    try {
      const snapshot = await readResumeSessionIndex();
      const rows = [...(snapshot?.index?.byId?.values?.() || [])]
        .filter((info) => info?.path && info.kind !== "subagent_child")
        .sort((a, b) => Number(b.modified || 0) - Number(a.modified || 0));
      for (const row of rows) {
        if (out.length >= limit) break;
        push(row.path);
      }
    } catch {
      // 索引拿不到就走下面那条
    }
    if (!out.length) {
      try {
        const listed = await sdk.bus.request("session:list", { scope: "all", lifecycle: "active" }, { timeoutMs: 6_000 });
        const rows = Array.isArray(listed) ? listed : listed?.sessions || [];
        for (const row of rows) {
          if (out.length >= limit) break;
          push(row?.path || row?.sessionPath);
        }
      } catch {
        // 拿不到就算了，下一轮再试
      }
    }
    // 补上账本里知道的会话。
    //
    // 上面两条路都只看得见 home/app（宿主给 v2 App 的 session:list 把 namespace
    // 写死成这两样），Code 页的 namespace 是 code，根本不在名单里。
    // 于是「在 Code 页挂了关机，那边输入框上方一条提示都不出」——人看不见，也就
    // 没法及时反悔。账本靠全局事件，不受 namespace 限制，正好补上这个缺口。
    //
    // 账本里的排在前面：它们是真正「有过动静」的会话，比冷会话更可能正是她现在看的那个。
    try {
      const tracked = activityLedger?.paths?.() || [];
      if (tracked.length) {
        const tail = out.filter((path) => !tracked.includes(path));
        out.length = 0;
        for (const path of tracked) {
          if (out.length >= limit) break;
          push(path);
        }
        for (const path of tail) {
          if (out.length >= limit) break;
          push(path);
        }
      }
    } catch {
      // 账本读不到不影响已有的名单
    }
    return out.slice(0, limit);
  }

  async function dismissShutdownBanner(path) {
    shutdownBannerTexts.delete(path);
    await sdk.inputBanner.dismiss({ sessionPath: path, bannerId: SHUTDOWN_BANNER_ID }).catch(() => {});
    void persistMountedBanners();
  }

  async function syncShutdownBanner() {
    // 先确保知道“上次挂过哪些”：否则重载后取消时，那些孤儿横幅永远收不掉。
    await restoreMountedBanners();
    const text = describeShutdownBanner();
    // 把每次同步的轨迹落一笔（只记阶段与数量，不记正文）。
    void sdk.storage.global.set("shutdownBannerTrace", {
      at: new Date().toISOString(),
      step: text ? "has-text" : "no-text",
      known: shutdownBannerTexts.size,
      armed: describeSleepGuard().armed === true,
    }).catch?.(() => {});
    // 先把“这一轮之前挂了什么”拍个快照：下面循环里会改这张表，
    // 改完再比就看不出变化了，名单就落不成盘。
    const before = shutdownBannerTexts.size;
    if (!text) {
      // 没在守了：把知道的全收掉。
      // 这里必须无条件全收，不能先看候选名单——重载后候选名单可能是空的，
      // 而旧横幅还在宿主上挂着，那就永远收不掉（2026-10-28 那个「取消了还挂着」就是这个）。
      for (const path of [...shutdownBannerTexts.keys()]) await dismissShutdownBanner(path);
      return;
    }
    const paths = await pickRecentSessionPaths();
    // 把这一轮名单落盘一份，排查用。
    //
    // 为什么需要：2026-10-28 「Code 页挂了关机、横幅不出来」那个问题，
    // 当时完全没有现场可看：不知道名单里到底有没有那段会话、
    // 是没算进去还是算进去了但写失败。只能读代码推。
    // 这个文件只写路径与结果，不写正文，也不参与任何判断。
    void recordBannerRound(text, paths);
    if (!paths.length) {
      safeLog.debug("关机提示条没有会话可挂", {});
      return;
    }
    let changed = false;
    for (const path of paths) {
      if (shutdownMutedPaths.has(path)) continue;
      try {
        await sdk.inputBanner.set({
          sessionPath: path,
          bannerId: SHUTDOWN_BANNER_ID,
          text,
          // 按了就当场取消这次关机；点 × 只是收起这条提示，两件事分开。
          buttons: [{ id: "cancel", title: "取消关机", action: { kind: "notify-plugin" } }],
        });
        if (shutdownBannerTexts.get(path) !== text) {
          shutdownBannerTexts.set(path, text);
          changed = true;
        }
      } catch (error) {
        safeLog.warn("关机提示条没挂上", { error: String(error?.message || error).slice(0, 120) });
      }
    }
    // 掉出“最近”名单的那些收掉，别让它们在冷会话里长住。
    for (const path of [...shutdownBannerTexts.keys()]) {
      if (paths.includes(path)) continue;
      await dismissShutdownBanner(path);
    }
    // 文本每秒都在变，日志每 5 分钟留一条就够，否则会把日志刷满。
    if (changed || shutdownBannerTexts.size !== before) {
      // 挂过的名单得落盘：重载之后靠这份记录才能把它们收掉。
      void persistMountedBanners();
      if (changed && Date.now() - shutdownBannerLoggedAt > 5 * 60_000) {
        shutdownBannerLoggedAt = Date.now();
        safeLog.info(`关机提示条挂到 ${paths.length} 段对话：${text}`);
      }
    }
  }

  /** 她换窗口说话了：确保那一段也在名单里。 */
  function noteShutdownActiveSession(sessionPath) {
    const path = String(sessionPath || "");
    if (!path || shutdownBannerTexts.has(path)) return;
    void syncShutdownBanner();
  }

  /** 用户把关机条关掉了：只关这一条，别的窗口里那条还在。 */
  function noteShutdownBannerEvent(event, sessionPath) {
    const payload = event?.payload ?? event?.data ?? event ?? {};
    const kind = String(payload?.kind ?? event?.kind ?? "");
    if (kind !== "dismissed" && kind !== "button") return false;
    const bannerId = String(payload?.bannerId ?? event?.bannerId ?? "");
    if (bannerId && bannerId !== SHUTDOWN_BANNER_ID) return false;
    if (!shutdownBannerTexts.size) return false;

    // 按了「取消关机」：真的把这次计划取消。宿主只管通知，条子要我们自己摘。
    if (kind === "button") {
      safeLog.info("提示条上点了取消关机，开始取消");
      void (async () => {
        try {
          await cancelSleepGuard(sdk, "在提示条上点了取消");
          safeLog.info("关机已取消（来自提示条）");
        } catch (error) {
          safeLog.warn("从提示条取消失败", { error: String(error?.message || error).slice(0, 120) });
        }
        await syncShutdownBanner();
      })();
      return true;
    }

    // 点 ×：只是收起这条提示，关机还在。
    const path = String(payload?.sessionPath || event?.sessionPath || sessionPath || "");
    safeLog.info(`关机提示条被收起（${path ? String(path).split(/[\\/]/).pop() : "未知会话"}）`);
    if (path && shutdownBannerTexts.has(path)) {
      shutdownMutedPaths.add(path);
      void dismissShutdownBanner(path);
      return true;
    }
    // 认不出是哪一段：保守一点，全线收掉，不再自己冒。
    for (const known of [...shutdownBannerTexts.keys()]) {
      shutdownMutedPaths.add(known);
      void dismissShutdownBanner(known);
    }
    return true;
  }

  /** 把话单状态推给球：主面板靠它显示「排队中 第 n/N 轮」和停止按钮。 */
  async function pushQueueState(state, extra = {}) {
    const current = state || queuePlans.list().find((item) => item.status === "running") || null;
    const active = Boolean(current && current.status === "running");
    // 提示条先挂：它不依赖球是否开着。
    // 发完那一下不是直接收，先挂「已发完」再收（不然人还没看清就没了）。
    void syncQueueBanner({ finishing: String(extra?.message || "") === "排的都发完了" });
    // 这一轮排队结束后才清「用户关过」的标记；跑着的时候不碰，否则关了又马上重挂。
    if (!active) queueBannerMuted.clear();
    if (!ball.state().running) return;
    const body = {
      // ok 必须带上：球那边拿到回包先看 ok，少了这个字段就一直当成「没排上」——
      // 明明排上了，弹窗里也会报一句「知意那边没回话」。
      ok: true,
      error: "",
      active,
      status: current?.status || "",
      text: active ? describeQueuePlan(current) : "",
      done: Number(current?.done || 0),
      total: Number(current?.total || 0),
      sessionId: current?.sessionId || "",
      agentName: current?.agentName || "",
      title: current?.title || "",
      // 这份状态属于桥上的第几次请求：球按它认回包（只认自己的那次，不认别人的推送）。
      requestSeq: Number(queueStateRequestSeq || 0),
      ...extra,
    };
    try {
      await ball.bridgeRequest("/queue/push", { method: "POST", body });
    } catch (error) {
      safeLog.debug("排队状态未送达传音樱", { error: String(error?.message || error).slice(0, 120) });
    }
  }

  /**
   * 把球上给的会话编号收成宿主那一套（sess_xxx）。
   * 球上常常传的是文件名式编号，而钩子与事件给的是 sess_xxx；两套混着记账，
   * 就会出现「钩子每次都要靠唯一在跑兜底」「轮末认不出话单」这类静默失败。
   */
  async function normalizeQueueSessionId(raw) {
    const id = String(raw || "").trim();
    if (!id) return "";
    if (STABLE_SESSION_ID.test(id)) return id;
    try {
      const target = await resolveResumeTargetLite({ sessionId: id, sessionPath: id });
      const stable = String(target?.sessionId || "");
      if (stable && STABLE_SESSION_ID.test(stable)) return stable;
    } catch (error) {
      safeLog.debug("排队话单：会话编号没能归一", { error: String(error?.message || error).slice(0, 120) });
    }
    return id;
  }

  /**
   * 读会话现在的忙闲。
   * known=false 表示这条查询没成功（编号对不上、宿主 RPC 撞上限），
   * 那时「忙」和「闲」都说不准，调用方要自己决定多小心。
   */
  async function readSessionActivity(sessionId) {
    try {
      const context = await sdk.bus.request("session:context", { sessionId, scope: "all" }, { timeoutMs: 4_000 });
      if (context?.isStreaming === true) return { busy: true, known: true };
      if (Number(context?.pendingMessageCount || 0) > 0) return { busy: true, known: true };
      return { busy: false, known: true };
    } catch (error) {
      await sdk.logger.warn("查不到会话忙闲", { code: String(error?.code || "") });
      return { busy: false, known: false };
    }
  }

  async function sessionIsBusy(sessionId) {
    return (await readSessionActivity(sessionId)).busy;
  }

  /**
   * 话单判定：这一轮说完了，该不该把下一句送进去。
   * 钩子（messages/post-assistant）与 turn_end 事件共用这一条路。
   */
  /**
   * 话单往前推一句：会话闲下来了、也过了冷却，就把下一句直接发进去。
   *
   * 为什么改成自己盯会话忙闲：
   * 旧版靠宿主排队语义（followUp）+ 猜「有没有被接走」。而钩子给的会话编号
   * 与球上给的常常不是同一套，一失手就两个后果——pending 永远清不掉（90 秒后被
   * 误判成「没被接走」，面板弹假红字），以及轮末认不出这份话单（认不出就静默
   * return，于是「排 2 轮只发 1 轮」）。
   * 现在：ta 说完这轮（宿主不再 streaming、也没有待处理输入）就送下一句，
   * 送完等 ta 回，回完再送；猜的那一环整个不要了。
   */
  async function pumpQueue(sessionId, { source = "" } = {}) {
    const raw = String(sessionId || "").trim();
    if (!raw) return null;
    // 编号对不上时按唯一在跑兜底：钩子、事件、球桥三处编号不总是同一套。
    const plan = queuePlans.resolve(raw);
    if (!plan || plan.status !== "running") return null;
    const id = plan.sessionId;
    if (queueFiring.has(id)) return null;
    // 同一段对话上，「循环续接」和「排队话单」只留一样。
    if (loopRegistry.get(id)) return null;
    // 冷却：刚送过一句就别连着送，让 ta 先开口。
    if (plan.lastFiredAt && Date.now() - plan.lastFiredAt < QUEUE_SEND_COOLDOWN_MS) return null;
    // 先上锁再查忙闲：下面全是 await，钩子 / turn_end / 2 秒心跳会在这段时间挤进来。
    // 两个调用都通过了「没在发」的检查、都拿到同一句，就会把同一句话连发两次
    // （实机：选两轮却发了三次，第二轮连发两下）。
    queueFiring.add(id);
    try {
      // ta 还在回话就等下一次心跳；这一条取代了老版「排进宿主 + 猜有没有被接走」。
      const activity = await readSessionActivity(id);
      if (activity.busy) return null;
      // 忙闲查不到（编号对不上、宿主 RPC 撞上限）时不能一直等，也不能太急：
      // 至少隔一段足够长的时间再发，宁可多等也别扯断 ta 正在写的话。
      if (!activity.known && plan.lastFiredAt && Date.now() - plan.lastFiredAt < QUEUE_UNKNOWN_STATE_WAIT_MS) return null;
      const text = queuePlans.peekText(id);
      if (!text) {
        safeLog.info("排队话单已发完");
        await pushQueueState(null, { message: "排的都发完了" });
        return null;
      }
      // 先记成「这是我们发的话」，再发。发消息会立刻起一轮，宿主在那之前就可能跑
      // before-start 钩子；钩子靠 sentTexts 认「这是我们自己的」——认错了就当成用户
      // 插话，把整份话单停了（排 2 轮只发 1 轮就是这么来的）。记在发送之后就晚了半拍。
      queuePlans.markSending(id, text);
      // 轮末这一发走直接发（steer）：排队语义挂上去会等一个不会再来的轮次结束。
      await sendToConversation(sdk, { text, mode: "steer", sessionId: id });
      const after = queuePlans.markFired(id);
      queueSendFailures.delete(id);
      safeLog.info(`排队话单：已送出第 ${after?.done ?? 0}/${after?.total ?? 0} 轮`);
      await pushQueueState(queuePlans.get(id), after?.status === "finished" ? { message: "排的都发完了" } : {});
    } catch (error) {
      const reason = String(error?.message || error).slice(0, 160);
      if (isAmbiguousSendError(error)) {
        // 超时是「说不准」：可能已经送到了，只是回包没回来。再发一遍就会重一句。
        // 这种不赌，直接停，并把话说清楚。
        queuePlans.stop(id, "发送超时");
        safeLog.warn(`排队话单这一轮没送出去（超时，不确定送到没有，话单停了）：${reason}`);
        await pushQueueState(null, { ok: false, error: "这一轮没发出去（发送超时，话单停了）", message: "这一轮没发出去，话单停了" });
      } else {
        // 明确没送出去（限流、busy、没权限）：重试是安全的，不会重一句。
        const fails = (queueSendFailures.get(id) || 0) + 1;
        queueSendFailures.set(id, fails);
        safeLog.warn(`排队话单这一轮没送出去（第 ${fails} 次）：${reason}`);
        if (fails >= QUEUE_SEND_FAIL_MAX) {
          queuePlans.stop(id, "发送失败");
          await pushQueueState(null, { ok: false, error: `没送出去，话单停了（${reason}）`, message: "没送出去，话单停了" });
        } else {
          // 自己 5 秒后再试一次，不等下一个信号：这一轮没送到，ta 不会回话，信号不会来。
          scheduleQueueRetry(id);
          await pushQueueState(queuePlans.get(id), {});
        }
      }
    } finally {
      queueFiring.delete(id);
    }
    return true;
  }

  /**
   * 轮末这条信号只管「本轮只判一次」，具体发不发交给 pumpQueue。
   * assistantText 留着是为了以后可能用它判断「ta 真的说完了」，目前不参与判定。
   */
  async function fireQueuePlan(sessionId, assistantText, { source = "" } = {}) {
    const id = String(sessionId || "").trim();
    if (!id) return null;
    if (!shouldJudgeLoop(queueDecidedAt.get(id) || 0, Date.now())) {
      safeLog.debug(`排队话单判定去重（${source}）：同一轮已经判过`);
      return null;
    }
    queueDecidedAt.set(id, Date.now());
    return pumpQueue(id, { source });
  }

  /** 明确没送出去时的重试：5 秒后自己再送一次，不等信号。 */
  function scheduleQueueRetry(sessionId) {
    const id = String(sessionId || "");
    const existing = queueRetryTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      queueRetryTimers.delete(id);
      const plan = queuePlans.get(id);
      if (!plan || plan.status !== "running") return;
      void pumpQueue(id, { source: "retry" });
    }, 5_000);
    timer.unref?.();
    queueRetryTimers.set(id, timer);
  }

  /**
   * 话单自愈：轮末的信号会整轮丢掉。
   *
   * 钩子（messages/post-assistant）和 turn_end 都是一次性判定。宿主对 App RPC 有并发上限，
   * 撞上限时整条钩子被丢掉（一天上千次，日志里全是
   * 「adjudicator threw: App RPC concurrency limit reached」）；turn_end 那条兜底路
   * 又要靠 session:list 认会话，认不出就静默作罢。信号一丢，话单就永远停在
   * 「排队中 第 n/N 轮」——球上看着像还在排，其实一句都没往下走。
   *
   * 所以这里自己盯着：话单在跑、ta 已经不在回话、而且连续闲了一阵子，就自己把下一句补上。
   * 查忙闲失败按「还在回话」处理——宁可晚一轮，也不打断 ta 正在写的话。
   */
  const resumeSignals = new Map();
  let lastBallActionSeq = 0;
  let resumeActionBaselineAdopted = false;
  let resumeEventsAvailable = false;
  // 已经推上桥的那条提醒属于哪个会话。多个窗口同时出状况时，
  // 一个窗口自己好了不能把别的窗口那条提醒也收掉。
  let resumeNoticeKey = "";
  // 球上当前挂着的小条是断点的还是「循环续接问要不要接着来」的。
  // 断点总开关关掉时只能收断点那一条，循环自己的提示不能被它带走。
  let resumeNoticeSource = "";
  // 配置变更/总开关的代次。pump 在 await 前后各对一次号，避免「关了之后又发送」。
  let resumeEpoch = 0;
  let pumpingResume = false;

  // 宿主的两套编号（事件里的文件名、钩子里的 sess_xxx）靠这张索引对齐；
  // 顺带也是「这条提醒到底来自哪个窗口」的唯一来源——别再对着不存在的字段要名字。
  //
  // 2026-10-22 实机：这份索引一天拉了 3994 次（几乎卡着 20 秒 CD 跑满），每次要列
  // 三百多个会话、三四百毫秒、偶尔五秒（宿主日志 sessions_list_timing）。而它和宿主
  // 的事件循环是同一条路上的：拉的时候整个循环一起等，钩子在这段时间里排队、堆到
  // App RPC 的 128 并发上限，被拒的那条就被当成「没有决策」。断点续接认的是「正在
  // 聊的那几段对话」，不需要这么实时的全景。所以：只列活跃会话、缓存放长、失败退避、
  // 同一时刻只飞一个请求。
  const RESUME_INDEX_TTL_MS = 300_000;
  // 复核要新证据（modified 变了没有），但不必每 5 秒拉一次全景。
  const RESUME_INDEX_FORCE_MIN_MS = 20_000;
  // 读失败后也得继续试，只是不能比复核节流还密：宿主要么在限流、要么正忙，
  // 添乱只会让它更忙，但也不能停跳（那样卡住就一直没人看了）。
  const RESUME_INDEX_FAIL_BACKOFF_MS = RESUME_INDEX_FORCE_MIN_MS;
  let resumeSessionIndex = { at: 0, freshAt: 0, index: null, stale: false };
  let resumeIndexInflight = null;
  let resumeIndexNextForceAt = 0;
  let resumeIndexFailUntil = 0;
  // 会话文件名（或裸 UUID）→ 稳定编号。钩子那边同时握有两套编号（invocation.session
  // 的 sessionId 与 path），所以这张表是顺手就能填上的；填上以后事件路径就不必再去拉
  // 名单核对了。表在内存里，App 重载后从空开始，第一轮先查一次，之后都走本地。
  const resumePathAlias = new Map();
  function rememberSessionPath(sessionPath, sessionId) {
    const pathId = sessionIdFromPath(sessionPath);
    const stable = String(sessionId || "");
    if (!pathId || !stable || pathId === stable) return;
    resumePathAlias.set(pathId, stable);
    if (resumePathAlias.size > 400) {
      // 只是缓存，长了就从头扔，不留脏数据也不用去做 LRU。
      const oldest = resumePathAlias.keys().next();
      if (!oldest.done) resumePathAlias.delete(oldest.value);
    }
  }
  async function readResumeSessionIndex({ force = false } = {}) {
    const stamp = Date.now();
    const cachedFresh = Boolean(resumeSessionIndex.index) && stamp - resumeSessionIndex.at < RESUME_INDEX_TTL_MS;
    if (!force && cachedFresh) return resumeSessionIndex;
    // force 也得上限：卡住复核每 5 秒问一次，问得比名单自己变还勤没意义。
    if (force && cachedFresh && stamp < resumeIndexNextForceAt) return resumeSessionIndex;
    if (stamp < resumeIndexFailUntil) return resumeSessionIndex;
    // 并发合并：同一次刷新只发一个请求，其余调用等它的结果。
    if (resumeIndexInflight) return resumeIndexInflight;
    resumeIndexInflight = (async () => {
    try {
      const listed = await sdk.bus.request("session:list", { scope: "all", lifecycle: "active" }, { timeoutMs: 6_000 });
      const rows = Array.isArray(listed) ? listed : listed?.sessions;
      resumeSessionIndex = { at: stamp, freshAt: stamp, index: buildSessionIndex(rows), stale: false };
      resumeIndexNextForceAt = stamp + RESUME_INDEX_FORCE_MIN_MS;
    } catch (error) {
      resumeIndexFailUntil = stamp + RESUME_INDEX_FAIL_BACKOFF_MS;
      resumeIndexNextForceAt = stamp + RESUME_INDEX_FORCE_MIN_MS;
      // 读不到就沿用旧索引；连旧的都没有时留给调用方按「查不到」处理，不编名字。
      // stale 是给复核用的：这份索引的 modified 是过期值，不能拿它证明「这一轮没进展」。
      // 并发时两次读取可能先后写同一个缓存，所以这里连同 at 一起返回给调用方绑定，
      // 不让调用方事后再去读全局字段——那样可能拿到另一次请求写进去的 stale。
      const cacheFreshAt = resumeSessionIndex.freshAt || 0;
      resumeSessionIndex = { at: stamp, freshAt: cacheFreshAt, index: resumeSessionIndex.index, stale: true };
      // 只记时间与错误码，不记任何正文或标题。
      await sdk.logger.debug?.("续接读不到会话名单", {
        code: String(error?.code || "").slice(0, 40),
        cacheFreshAt,
        error: String(error?.message || error).slice(0, 120),
      });
    }
    return resumeSessionIndex;
    })();
    try {
      return await resumeIndexInflight;
    } finally {
      resumeIndexInflight = null;
    }
  }
  // 事件自己带着稳定编号（sess_xxx）时就不必去拉名单：那是宿主最慢的一条路，
  // 每轮都拉一次等于把 App 的钩子挂在它后面排队。名单只用来干两件事——
  // 把「只有路径/裸 UUID」的事件对到稳定编号，以及拿标题/首句做提醒文案；
  // 编号已经够用时这两件都不需要。
  const STABLE_SESSION_ID = /^sess_/i;
  async function resolveResumeTargetLite({ sessionId = "", sessionPath = "" } = {}) {
    const id = String(sessionId || "");
    // 稳定编号在位时它是权威：事件里那个 sessionPath 只是个文件名，拿它对编号就得拉名单。
    if (STABLE_SESSION_ID.test(id)) return { sessionId: id };
    // 钩子早就把两套编号对上过：本地查得到就不再问宿主。
    const pathId = sessionIdFromPath(sessionPath);
    const mapped = pathId ? resumePathAlias.get(pathId) : "";
    if (mapped) return { sessionId: mapped };
    return resolveResumeTarget({ sessionId: id, sessionPath });
  }
  async function resolveResumeTarget({ sessionId = "", sessionPath = "" } = {}, { force = false } = {}) {
    const snapshot = await readResumeSessionIndex({ force });
    const indexStale = snapshot.stale === true;
    const hit = lookupSession(snapshot.index, { sessionId, sessionPath });
    // 两套编号归位：事件里可能只有裸 UUID（sessionPath 为空时尤其常见），钩子里是
    // sess_xxx。查到稳定编号后把这层对应关系交给状态机，否则同一个对话会记成两本账——
    // 开头记在 sess_xxx 上，事件收尾只清掉 uuid 那本，90 秒后好好的会话被判成断联。
    if (hit?.sessionId) {
      rememberSessionPath(sessionPath, hit.sessionId);
      for (const alias of [sessionId, sessionPath ? String(sessionPath).split(/[\\/]/).pop().replace(/\.jsonl$/i, "") : ""]) {
        if (alias) resumeTracker.registerAlias(alias, hit.sessionId);
      }
    }
    // 把「这份索引是不是新鲜」一起带走：查得到不等于这份证据算数。
    return hit ? { ...hit, indexStale } : hit;
  }

  /** 把循环续接的状态推到球上：主面板靠它显示「正在续 第 n/N 轮」和停止按钮。 */
  async function pushLoopState(state) {
    if (!ball.state().running) return;
    const body = {
      ...(state
        ? {
            active: state.status === "running" || state.status === "awaiting",
            text: describeLoop(state)
              || (state.status === "awaiting" ? "ta 好像做完了，等你决定还要不要接着续" : ""),
            sessionId: state.sessionId || "",
            agentName: state.agentName || "",
            title: state.title || "",
            total: state.total || 0,
            done: state.done || 0,
            status: state.status || "",
          }
        : {}),
    };
    try {
      await ball.bridgeRequest("/resume/loop", { method: "POST", body });
    } catch (error) {
      await sdk.logger.debug?.("循环状态未送达传音樱", { error: String(error?.message || error).slice(0, 120) });
    }
  }

  async function pushResumeNotice(payload) {
    if (!ball.state().running) return;
    if (resumeUiFrozen) return;
    resumeNoticeKey = payload ? String(payload.sessionId || "") : "";
    // loop_confirm 走的是同一条桥，但它属于正常聊天的循环业务，不归断点管。
    resumeNoticeSource = payload ? String(payload.source || "break") : "";
    try {
      await ball.bridgeRequest("/resume/notice", { method: "POST", body: payload || {} });
    } catch (error) {
      await sdk.logger.debug?.("断联续接小条未送达传音樱", { error: String(error?.message || error).slice(0, 120) });
    }
  }

  /** 给一段会话取抬头用的那几样东西（窗口名、伙伴名、开头那句、开始时间）。 */
  async function describeSession(sessionId, signal = null) {
    const target = await resolveResumeTarget({ sessionId, sessionPath: signal?.sessionPath || "" });
    return {
      title: target?.title || signal?.title || "",
      agentName: target?.agentName || signal?.agentName || "",
      firstMessage: target?.firstMessage || signal?.firstMessage || "",
      openedAt: openedAtSnippet(target?.path || signal?.sessionPath || sessionId),
      target,
    };
  }

  /** 设置页和球使用同一份带来源的进度；异步读取途中换代即作废。 */
  async function describeResumeProgress() {
    const epoch = resumeEpoch;
    const bySession = new Map();
    if (resumeConfig.enabled) {
      for (const item of resumeTracker.progressItems()) {
        const signal = resumeSignals.get(item.sessionId) || null;
        const { target: _target, ...described } = await describeSession(item.sessionId, signal);
        if (!resumeConfig.enabled || resumeEpoch !== epoch) return [];
        // 一行只讲一件事：已发出几句 / 计划几轮。
        // 自动续接的分母是全局重试上限；手动单发没有计划，就不摆分数（以前的 0/3 是
        // 拿失败计数冒充进度，看着像已经失败三次）。
        const sent = item.sent ?? item.attempt ?? 0;
        const total = resumeConfig.autoResume ? (item.maxConsecutive || resumeConfig.maxConsecutive) : 0;
        bySession.set(item.sessionId, { ...item, ...described, sessionId: item.sessionId, sent, total });
      }
      // 手动「这次接几轮」也算进度：它不在失败计数的账上，但用户要看得见发到第几句了。
      for (const [key, manual] of manualRounds) {
        const base = bySession.get(key) || { sessionId: key, ...manual };
        bySession.set(key, {
          ...base,
          sessionId: key,
          sent: manual.sent,
          total: manual.planned,
          manualState: manual.status,
          status: manual.status === "finished" ? "done" : "waiting",
        });
      }
    }
    return [...bySession.values()];
  }

  /** 把断点进度全量推给球：items 为空也发，让球知道总开关。冻结期一律不发。 */
  async function pushResumeProgress() {
    if (!ball.state().running) return;
    if (resumeUiFrozen) return;
    const items = await describeResumeProgress();
    try {
      await ball.bridgeRequest("/resume/progress", {
        method: "POST",
        body: {
          enabled: resumeConfig.enabled,
          autoResume: resumeConfig.autoResume,
          maxConsecutive: resumeConfig.maxConsecutive,
          items,
        },
      });
    } catch (error) {
      await sdk.logger.debug?.("断点进度未送达传音樱", { error: String(error?.message || error).slice(0, 120) });
    }
  }

  /**
   * 冻结/解冻的当场收放：冻结时要把球上可能已经挂着的小条、闪报、进度收干净，
   * 不然用户会看到一张“冻结前就弹出来”的旧提醒。循环续接不归这条管（球桥会保留它）。
   */
  async function syncResumeVisibility() {
    if (!ball.state().running) return;
    if (!resumeUiFrozen) {
      await pushResumeProgress();
      return;
    }
    try {
      await ball.bridgeRequest("/resume/progress", {
        method: "POST",
        body: {
          enabled: false,
          autoResume: false,
          maxConsecutive: resumeConfig.maxConsecutive,
          items: [],
        },
      });
      resumeNoticeKey = "";
      resumeNoticeSource = "";
    } catch (error) {
      await sdk.logger.debug?.("冻结后清理球上旧提醒失败", { error: String(error?.message || error).slice(0, 120) });
    }
  }

  /**
   * 球重开时把还挂着的那条断点提醒重新挂回去。
   * 球的存储是进程内的，重启即空；App 侧还记着，就说明这条确实还没被用户处理过。
   * 循环续接的提示不归这里管，它有自己的生命周期。
   */
  async function syncPendingResumeNotice() {
    if (!resumeNoticeKey || resumeNoticeSource !== "break") return;
    const signal = resumeSignals.get(resumeNoticeKey) || null;
    const { target: _target, ...described } = await describeSession(resumeNoticeKey, signal);
    await pushResumeNotice({
      sessionId: resumeNoticeKey,
      ...described,
      reason: buildResumeExplanation(signal),
      attempt: resumeTracker.snapshot(resumeNoticeKey).consecutive,
      maxConsecutive: resumeConfig.maxConsecutive,
      autoResume: resumeConfig.autoResume,
      at: Date.now(),
    });
  }

  /**
   * 改续接配置。只有总开关会清场：改自动/上限不重建状态机，计数必须留着，
   * 否则「把上限从 3 调到 5」会当成重新开始，白白多发两次。
   */
  async function applyResumeConfig(patch) {
    // 只传要改的字段；undefined 会把现有值洗掉（normalize 会当成 false）。
    const clean = Object.fromEntries(Object.entries(patch || {}).filter(([, value]) => value !== undefined));
    resumeConfig = normalizeResumeConfig({ ...resumeConfig, ...clean });
    await saveConfig("resumeConfig", resumeConfig);
    resumeEpoch += 1;
    // 行为参数要在同一个状态机上生效：不重建是为了保住计数，configure 才是让新值生效的那一步。
    resumeTracker.configure(resumeConfig);
    if (!resumeConfig.enabled) {
      resumeTracker.clearAll();
      resumeSignals.clear();
      // 手动「这次接几轮」起的循环是从这个开关里发起的：关掉总开关就不该再往对话里发
      // 「继续哈」。以前只清断点那本账，循环照跑，等于开关只管住了半件事。
      // 按状态机自己的键去停（两边编号未必一字不差，别拿账上的键去猜）。
      for (const state of loopRegistry.list()) {
        if (state.status === "running" || state.status === "awaiting") {
          loopRegistry.stop(state.sessionId, "断点续接已关闭");
        }
      }
      for (const key of lastLoopDecidedAt.keys()) lastLoopDecidedAt.delete(key);
      manualRounds.clear();
      stuckProbeAt.clear();
      if (!resumeNoticeSource || resumeNoticeSource === "break") void pushResumeNotice(null);
    }
    await pushResumeProgress();
    return resumeConfig;
  }

  // 自动续接成功的短暂反馈：只亮几秒，不占常驻小条，也不用等用户处理。
  async function pushResumeFlash(payload) {
    if (!ball.state().running) return;
    if (resumeUiFrozen) return;
    try {
      await ball.bridgeRequest("/resume/flash", { method: "POST", body: payload || {} });
    } catch (error) {
      await sdk.logger.debug?.("自动续接反馈未送达传音樱", { error: String(error?.message || error).slice(0, 120) });
    }
  }

  // 传音樱上的三个按钮（继续哈 / 不用管 / 自动续接开关）也是球→App，
  // 球只能轮询桥，所以这边单独一个 2 秒的读取器；序号自增，用过即丢。
  const resumeBridgeTimer = setInterval(async () => {
    // 球不在时把序号基线丢掉：球重开后 actionSeq 从 0 重数，
    // 沿用旧基线会让新动作被判成「序号倒退的旧桥」。
    if (!ball.state().running) { resumeActionBaselineAdopted = false; return; }
    let state;
    try { state = await ball.bridgeRequest("/resume/state"); } catch { return; }
    const actionSeq = Number(state?.actionSeq) || 0;
    const action = state?.action || null;
    // 桥里的 action 是「读过就一直留着」（旧版是同步 POST，根本没有这层），
    // 而 lastBallActionSeq 每次 App 进程启动都归零。所以这里必须先立基线：
    // 第一次读到只记序号不执行，否则 App 每次重载都会把上一次的动作重放一遍——
    // 用户点过一次「继续哈」，之后每重载一次就会在那个会话里再插一句。
    // 序号倒退 = 球重启、桥重建，同样按新基线处理，否则新动作会被旧序号卡死。
    if (!resumeActionBaselineAdopted) {
      resumeActionBaselineAdopted = true;
      lastBallActionSeq = actionSeq;
      // 首轮就把总开关/自动/上限推过去：球刚起或 App 刚重载时手里什么都没有，
      // 默认值是「关」，不同步就会把手动弹出来的那条 notice 误藏起来。
      void pushResumeProgress();
      return;
    }
    // 球重启、桥重建：序号从 0 重数。归零后继续往下判，不能把当次动作一起吞了。
    if (actionSeq < lastBallActionSeq) lastBallActionSeq = 0;
    if (!action || actionSeq <= lastBallActionSeq) return;
    lastBallActionSeq = actionSeq;
    const sessionId = String(action.sessionId || "");
    if (action.action === "auto") {
      await applyResumeConfig({ autoResume: action.enabled === true });
      await sdk.logger.info(`自动续接已${resumeConfig.autoResume ? "打开" : "关闭"}`);
    } else if (action.action === "config") {
      const patch = action.config || {};
      await applyResumeConfig({
        autoResume: typeof patch.autoResume === "boolean" ? patch.autoResume : undefined,
        maxConsecutive: Number(patch.maxConsecutive) || undefined,
      });
      await sdk.logger.info(`断点续接设置已更新：自动 ${resumeConfig.autoResume ? "开" : "关"} · 上限 ${resumeConfig.maxConsecutive}`);
    } else if (action.action === "continue") {
      // 手动发送也受总开关和逐次请求守卫约束，提交成功仍须等待真实恢复。
      if (!sessionId || !resumeConfig.enabled) return;
      // 「这次接几轮」：1 轮 = 只发一句「继续哈」（原行为）；
      // N 轮 = 第一句发完，之后每轮说完自动接上，ta 说收工就停下来问用户。
      const plan = planManualResume(action.rounds);
      if (plan.mode === "loop") {
        // 同一段对话上只留一样：连着接几轮与排队话单互斥。
        if (queuePlans.get(sessionId)) {
          queuePlans.stop(sessionId, "改用连着接几轮");
          await pushQueueState(null, { message: "改用连着接几轮，排队话单停了" });
        }
        // 先起循环（往后那几轮归它管），再发第一句；
        // 第一句没送出去就把循环收掉，别让它空转着等一个不会来的回复。
        const { target: _target, ...described } = await describeSession(sessionId, null);
        const started = loopRegistry.start({
          sessionId,
          rounds: plan.loopRounds,
          agentName: described.agentName,
          title: described.title,
        });
        if (!started.ok) {
          await sdk.logger.warn(`连着接 ${plan.loopRounds + 1} 轮没起步：${String(started.error || "").slice(0, 120)}`);
        } else if (await sendResumeContinue(sessionId, "", { epoch: resumeEpoch })) {
          const planned = plan.loopRounds + 1;
          manualRounds.set(resumeTracker.canonicalId(sessionId), {
            planned, sent: 1, status: "running", lastAdvanceAt: Date.now(), ...described,
          });
          await sdk.logger.info(`手动续接：这次接 ${planned} 轮`);
          if (resumeNoticeKey === sessionId && resumeNoticeSource !== "loop_confirm") await pushResumeNotice(null);
          // 进度由这一行自己显示（sent/planned），别再推循环状态来抢一行显示。
          await pushResumeProgress();
        } else {
          loopRegistry.stop(sessionId, "第一句没发出去");
        }
      } else if (await sendResumeContinue(sessionId, "", { epoch: resumeEpoch })) {
        if (resumeNoticeKey === sessionId && resumeNoticeSource !== "loop_confirm") await pushResumeNotice(null);
      }
      await pushResumeProgress();
    } else if (action.action === "loop-stop") {
      const stopped = loopRegistry.stop(sessionId, "用户按了停");
      if (stopped.ok) await sdk.logger.info("循环续接已被用户停止");
      await pushLoopState(null);
    } else if (action.action === "loop-resume") {
      const resumed = loopRegistry.resumeAfterConfirm(sessionId);
      if (resumed) {
        rememberOwnResume(sessionId);
        try {
          await sendToConversation(sdk, { text: RESUME_TEXT, mode: "steer", sessionId });
          const after = loopRegistry.markFired(sessionId);
          // 手动「接几轮」被「ta 好像做完了」屏住过一次：用户点「接着来」之后
          // 循环是真的在跑，但那笔账还停在 paused、句数也不动，面板永远显示暂停时的数字。
          const manual = manualRounds.get(resumeTracker.canonicalId(sessionId));
          if (manual && manual.status !== "finished") {
            manual.status = after?.exhausted ? "finished" : "running";
            manual.sent = (manual.sent || 0) + 1;
            manual.lastAdvanceAt = Date.now();
          }
          if (manual) await pushResumeProgress();
          else await pushLoopState(loopRegistry.get(sessionId));
        } catch (error) {
          forgetOwnResume(sessionId);
          await sdk.logger.warn(`接着来没发出去：${String(error?.message || error).slice(0, 160)}`);
          loopRegistry.stop(sessionId, "发送失败");
          const manual = manualRounds.get(resumeTracker.canonicalId(sessionId));
          if (manual) {
            manual.status = "failed";
            await pushResumeProgress();
          } else {
            await pushLoopState(null);
          }
        }
      }
    } else if (action.action === "loop-finish") {
      loopRegistry.stop(sessionId, "用户说就到这吧");
      await pushLoopState(null);
      await pushResumeNotice(null);
    } else if (action.action === "dismiss") {
      if (!sessionId || !resumeConfig.enabled) return;
      // 信号表是按规范编号存的，清的时候也得用同一个键，否则旧信号会一直留在表里。
      const key = resumeTracker.canonicalId(sessionId);
      resumeTracker.forget(sessionId);
      resumeSignals.delete(key);
      if (resumeNoticeKey === key && resumeNoticeSource !== "loop_confirm") await pushResumeNotice(null);
      await pushResumeProgress();
    }
  }, 2_000);
  resumeBridgeTimer.unref?.();

  // 润色弹窗在球上，App 的 /polish 路由它够不着，走桥上这一对请求/结果。
  // 首轮只记基线（和续接一样）：桥里的 request 是“读过就一直留着”，不设基线的话，
  // App 每次重载都会把上一次捋好的那段再发一遍。
  let lastPolishRequestSeq = 0;
  let polishBaselineAdopted = false;
  const polishBridgeTimer = setInterval(async () => {
    if (!ball.state().running) return;
    let state;
    try { state = await ball.bridgeRequest("/polish/state"); } catch { return; }
    const requestSeq = Number(state?.requestSeq) || 0;
    const request = state?.request || null;
    if (!polishBaselineAdopted) {
      polishBaselineAdopted = true;
      lastPolishRequestSeq = requestSeq;
      return;
    }
    // 球重启后序号从 0 重数：归零再判，不然重启后第一次点「捋一捋」会被当成旧请求吞掉。
    if (requestSeq < lastPolishRequestSeq) lastPolishRequestSeq = 0;
    if (!request || requestSeq <= lastPolishRequestSeq) return;
    lastPolishRequestSeq = requestSeq;
    const text = String(request.text || "");
    const sessionId = String(request.sessionId || "");
    let result;
    try {
      if (request.kind === "send") {
        // 球上分两个按钮：「发送」是插话（steer），「排队」是等这一轮说完再发（followUp）。
        // 宿主自带这两种语义，发一次就完，球上不维护队列。
        const deliverAs = request.deliverAs === "followUp" ? "followUp" : "steer";
        await sendToConversation(sdk, { text, mode: deliverAs, sessionId: sessionId || undefined });
        result = { ok: true, message: deliverAs === "followUp" ? "已排队，等 ta 说完就发" : "已发送" };
      } else if (request.kind === "suggest") {
        // 候选方向：捋完一版后问一句“还能往哪儿改”。拿不到就是空列表，不当失败报。
        const items = await suggestPolishFixes(sdk, text);
        result = { ok: true, items: items || [] };
      } else {
        // source / previous / instruction 三个都是可选：
        //   source = 最初那版原话（安全校验永远对着它）
        //   previous = 上一版结果（有这个才走“只改点名处”的迭代）
        //   instruction = 用户这次额外提的整理方向
        result = { ok: true, ...(await polishText(sdk, text, {
          level: request.level || "balanced",
          source: String(request.source || ""),
          previous: String(request.previous || ""),
          instruction: String(request.instruction || ""),
        })) };
        // 成功也要留一笔：不记内容，只记长度和模型是否真的动了字。以前只在失败时写日志，
        // 用户回一句「没效果」就无从下手。
        await sdk.logger.info("球内理顺完成", {
          chars: String(result.text || "").length,
          unchanged: result.unchanged === true,
          revising: result.revising === true,
          fellBack: result.fellBack === true,
          reason: result.reason || "",
          model: result.model || "",
        });
      }
    } catch (error) {
      const code = error?.code || "POLISH_ERROR";
      await sdk.logger.warn("球内理顺失败", { code });
      result = { ok: false, error: String(error?.message || "理顺失败了，原文没动。").slice(0, 200) };
    }
    try {
      // kind 必须带上：捋和候选方向共用这条结果通道，先回来的那个会被另一边
      // 当成自己的结果（捋拿到 {items} 会把输入框清空）。球侧靠它认领。
      await ball.bridgeRequest("/polish/push", { method: "POST", body: { ...result, seq: requestSeq, kind: request.kind } });
    } catch (error) {
      await sdk.logger.debug?.("球内理顺结果未送达传音樱", { error: String(error?.message || error).slice(0, 120) });
    }
  }, 2_000);
  polishBridgeTimer.unref?.();

  // 会话标题：球上点「生成新标题 / 还原」，起名与写回都在 App 侧做
  // （session:update 只有 App 够得着），结果走桥回传。和润色同一套请求/结果对，
  // 同样首轮只记基线，避免重载时把上一次的请求再执行一遍。
  let lastTitleRequestSeq = 0;
  let titleBaselineAdopted = false;
  const titleBridgeTimer = setInterval(async () => {
    if (!ball.state().running) return;
    let state;
    try { state = await ball.bridgeRequest("/title/state"); } catch { return; }
    const requestSeq = Number(state?.requestSeq) || 0;
    const request = state?.request || null;
    if (!titleBaselineAdopted) {
      titleBaselineAdopted = true;
      lastTitleRequestSeq = requestSeq;
      return;
    }
    // 同润色：球重启后序号归零，归零再判，不吞重启后第一次请求。
    if (requestSeq < lastTitleRequestSeq) lastTitleRequestSeq = 0;
    if (!request || requestSeq <= lastTitleRequestSeq) return;
    lastTitleRequestSeq = requestSeq;
    const kind = String(request.kind || "");
    const sessionId = String(request.sessionId || "");
    let result;
    try {
      if (kind === "undo") {
        const undone = await undoSessionTitle(sdk, { sessionId });
        result = {
          ok: true,
          kind,
          sessionId: undone.sessionId || sessionId,
          restoredTitle: undone.restoredTitle || "",
          agentName: "",
        };
      } else if (kind === "rename") {
        const drafted = await summarizeSessionTitle(sdk, { sessionId });
        const title = String(drafted?.title || "").trim();
        // 兜底不报错，所以得自己记一笔原因，不然下次只能看见「兜底标题」四个字。
        if (drafted?.fallback) {
          await sdk.logger.warn(`会话标题退回兜底：${drafted?.error || "没拼出可用上下文"}`);
        }
        if (!title) throw new Error("这次没起出名字，再试一次。");
        const targetId = String(drafted?.session?.sessionId || sessionId || "");
        // 旧标题必须自己读出来交给写入方：不给的话「还原」只能退回「未命名对话」。
        const previous = await resolveResumeTarget({ sessionId: targetId }, { force: true });
        const written = await applySessionTitle(sdk, {
          sessionId: targetId,
          title,
          previousTitle: previous?.title || "",
        });
        result = {
          ok: true,
          kind,
          sessionId: targetId,
          title: written.title || title,
          fallback: drafted?.fallback === true,
          agentName: String(drafted?.session?.agentName || ""),
        };
      } else {
        result = { ok: false, kind, sessionId, error: "不认识的请求类型。" };
      }
    } catch (error) {
      await sdk.logger.warn("球内起标题失败", { code: error?.code || "TITLE_ERROR", kind });
      result = {
        ok: false,
        kind,
        sessionId,
        error: String(error?.message || "没改成，再试一次。").slice(0, 200),
      };
    }
    try {
      await ball.bridgeRequest("/title/push", { method: "POST", body: { ...result, seq: requestSeq } });
    } catch (error) {
      await sdk.logger.debug?.("球内标题结果未送达传音樱", { error: String(error?.message || error).slice(0, 120) });
    }
  }, 2_000);
  titleBridgeTimer.unref?.();

  // 球上右键菜单翻的开关：它先写桥，这里读到后存盘并回推，两边保持一致。
  let lastSettingsToggleSeq = 0;
  let settingsToggleBaseline = false;
  const settingsBridgeTimer = setInterval(async () => {
    if (!ball.state().running) return;
    let state;
    try { state = await ball.bridgeRequest("/settings/state"); } catch { return; }
    const toggle = state?.toggle || null;
    const seq = Number(toggle?.seq) || 0;
    if (!settingsToggleBaseline) {
      settingsToggleBaseline = true;
      lastSettingsToggleSeq = seq;
      return;
    }
    if (seq < lastSettingsToggleSeq) lastSettingsToggleSeq = 0;
    if (!toggle || seq <= lastSettingsToggleSeq) return;
    lastSettingsToggleSeq = seq;
    if (toggle.key === "popupOnTop") {
      const enabled = toggle.value === true;
      await sdk.storage.global.set("popupOnTopDuringFullscreen", enabled);
      await pushPopupOnTop(enabled);
      safeLog.info(`开关从传音樱改过来了：全屏时弹窗${enabled ? "浮上来" : "让到后面"}`);
    }
  }, 1_500);
  settingsBridgeTimer.unref?.();
  // ── 排队话单：球上写一句/一串话 → 排进对话；话单状态再推回球上显示 ──
  let lastQueueRequestSeq = 0;
  let queueBaselineAdopted = false;
  /**
   * 球上来了一份话单：建档、发第一句、把状态推回球上。
   * 第一发按 ta 在不在回话决定：还在回话 → 排队（followUp，等这轮说完）；
   * 已经说完了 → 直接发（steer），否则排队语义会等一个不会再来的轮次结束。
   */
  async function startQueuePlan(request) {
    let sessionId = String(request?.sessionId || "").trim();
    if (!sessionId) {
      // 没指定对话就按「最近活跃」算，但必须在这里定死：
      // 话单是按会话记的账，后面每一轮都要发进同一段，不能每轮各找一次。
      try {
        const target = await newestSession(sdk);
        sessionId = String(target?.sessionId || "").trim();
      } catch (error) {
        return { ok: false, error: "找不到要排进哪段对话" };
      }
    }
    if (!sessionId) return { ok: false, error: "找不到要排进哪段对话" };
    // 先把编号归一，后面建单、轮询、钩子认账才可能对得上。
    sessionId = await normalizeQueueSessionId(sessionId);
    const built = buildQueueItems(request?.text, { rounds: normalizeQueueRounds(request?.rounds) });
    if (!built.ok) return { ok: false, error: built.error };
    // 同一段对话上只留一样：话单和「循环续接」不能一起往里塞话。
    if (loopRegistry.get(sessionId)) {
      loopRegistry.stop(sessionId, "改排队话单");
      await pushLoopState(null);
    }
    // 同一段对话上再排一份：旧的那份会被新的一份静默顶掉，轮数一起没。
    // 先明确停掉旧的，并告诉球换了。
    const previousPlan = queuePlans.get(sessionId);
    if (previousPlan && previousPlan.status === "running") {
      queuePlans.stop(sessionId, "被新的排队话单替掉了");
      safeLog.warn("同一段对话上已有排队话单，被新的替掉了", { sessionId });
    }
    const started = queuePlans.start({
      sessionId,
      agentId: String(request?.agentId || ""),
      agentName: String(request?.agentName || ""),
      title: String(request?.title || ""),
      items: built.items,
    });
    if (!started.ok) return { ok: false, error: started.error };
    // 第一句也交给 pumpQueue：会话闲着就立刻发，ta 还在回话就等它这轮说完。
    // 旧版在这里直接发了（并用 followUp 排队语义），后面就得猜「被没被接走」，
    // 猜错一次整份话单就卡死。
    const sent = await pumpQueue(sessionId, { source: "start" });
    const after = queuePlans.get(sessionId);
    await sdk.logger.info(`排队话单已开始：共 ${after?.total ?? built.total} 轮${sent ? "，第一句已送出" : "，等 ta 这一轮说完"}`);
    const message = sent ? "已发出，ta 这轮说完就接下一句" : "已排上，等 ta 说完这轮就发";
    await pushQueueState(after, { message });
    return { ok: true, message, total: Number(after?.total || built.total), done: Number(after?.done || 0) };
  }

  const queueBridgeTimer = setInterval(async () => {
    if (!ball.state().running) return;
    // 话单自己的心跳：ta 这轮说完了就把下一句送进去。
    // 这是不依赖钩子的那条路——宿主对 App RPC 有并发上限，钩子会被整条丢掉，
    // 只靠钩子的话「排 2 轮只发 1 轮」隔三差五就来一次。
    for (const state of queuePlans.list()) {
      if (state.status !== "running") continue;
      try {
        await pumpQueue(state.sessionId, { source: "timer" });
      } catch (error) {
        safeLog.debug("排队话单心跳出错", { error: String(error?.message || error).slice(0, 120) });
      }
    }
    let state;
    try { state = await ball.bridgeRequest("/queue/state"); } catch { return; }
    const requestSeq = Number(state?.requestSeq) || 0;
    const request = state?.request || null;
    if (!queueBaselineAdopted) {
      queueBaselineAdopted = true;
      lastQueueRequestSeq = requestSeq;
      return;
    }
    // 球重启后序号从 0 重数：归零再判，不然重启后第一次排会被当成旧请求吞掉。
    if (requestSeq < lastQueueRequestSeq) lastQueueRequestSeq = 0;
    if (!request || requestSeq <= lastQueueRequestSeq) return;
    lastQueueRequestSeq = requestSeq;
    // 这次请求的号：推给球的状态里带着它，球据此认「这份回包是我的」。
    queueStateRequestSeq = requestSeq;
    const kind = String(request.kind || "");
    const sessionId = String(request.sessionId || "");
    let result;
    try {
      if (kind === "queue-cancel") {
        // 先按球上给的会话找；找不到就停当前唯一在跑的那份。
        // 用户按「停」的意思是「别再往下发了」，不一定是精确指认了哪一段。
        let targetId = sessionId;
        if (!queuePlans.get(targetId)) {
          const running = queuePlans.list().filter((item) => item.status === "running");
          if (running.length === 1) targetId = running[0].sessionId;
        }
        const stopped = queuePlans.stop(targetId, "用户按了停");
        if (stopped.ok) {
          await sdk.logger.info("排队话单已被用户停止");
          result = { ok: true, message: "停了，不再往下发了" };
        } else {
          result = { ok: true, message: "本来就没在排" };
        }
        await pushQueueState(null, { message: result.message });
      } else if (kind === "queue") {
        result = await startQueuePlan(request);
      } else {
        result = { ok: false, error: "不认识的请求类型。" };
      }
    } catch (error) {
      await sdk.logger.warn("球内排队话单失败", { code: error?.code || "QUEUE_ERROR", kind });
      result = { ok: false, error: String(error?.message || "没排上，再试一次。").slice(0, 200) };
    }
    try {
      const running = queuePlans.list().find((item) => item.status === "running") || null;
      await ball.bridgeRequest("/queue/push", {
        method: "POST",
        body: {
          ok: result.ok !== false,
          message: String(result.message || ""),
          error: result.ok === false ? String(result.error || "") : "",
          seq: requestSeq,
          active: Boolean(running),
          status: running?.status || "",
          text: running ? describeQueuePlan(running) : "",
          done: Number(running?.done || 0),
          total: Number(running?.total || 0),
          sessionId: running?.sessionId || sessionId,
          agentName: running?.agentName || "",
          title: running?.title || "",
        },
      });
    } catch (error) {
      await sdk.logger.debug?.("球内排队结果未送达传音樱", { error: String(error?.message || error).slice(0, 120) });
    }
  }, 2_000);
  queueBridgeTimer.unref?.();

  async function sendResumeContinue(sessionId, agentId = "", token = null) {
    // 空编号会回退到 sendToConversation 的「最近会话」，等于插话插到别的窗口。
    if (!sessionId) {
      await sdk.logger.warn("续接没发出去：没解析出稳定的会话编号");
      return false;
    }
    if (!resumeConfig.enabled) return false;
    // 代次对号：这是发起时那一轮的凭据。中途关过、或换了策略，这一发就不该出去。
    const alive = () => resumeConfig.enabled && (!token || resumeEpoch === token.epoch);
    if (!alive()) return false;
    // 先记一笔「这句是我们发的」：宿主可能在我们拿到回包前就把钩子跑了。
    rememberOwnResume(sessionId);
    try {
      await sendToConversation(sdk, {
        text: RESUME_TEXT,
        mode: "steer",
        sessionId,
        // 每次真正发出去之前都回头看一眼：busy 退避要等好几秒，期间用户可能把总开关关了。
        // 已经交给宿主的请求撤不回来，但这道门能拦住尚未发送的那几次重试。
        beforeSend: alive,
      });
      await sdk.logger.info(`已续接：${sessionId}`);
      // 发出去了不等于恢复了：交给 markAwaiting 等真实结果，不能立刻当失败。
      // 发完再对一次号：期间若总开关被关过或重建过，就别把这一发写回新状态里。
      if (!alive()) {
        await sdk.logger.debug?.("续接发出后配置已变，这一发不记进状态", { sessionId });
        return false;
      }
      resumeTracker.markAwaiting(sessionId, agentId);
      return true;
    } catch (error) {
      // 没发出去就不能占用户的上限名额，也不能每 5 秒重试一次付费发送。
      forgetOwnResume(sessionId);
      if (!alive()) return false;
      resumeTracker.rollbackResume(sessionId, agentId);
      resumeTracker.failAwaiting(sessionId, agentId, String(error?.message || error));
      await sdk.logger.warn(`续接没发出去：${String(error?.message || error).slice(0, 160)}`);
      return false;
    }
  }

  async function applyResumeDecision(decision, token = null) {
    if (!decision || decision.action === "ignore" || decision.action === "wait") return;
    // 这一发是谁发起的、发起时是第几代配置：中间任何 await 之后都要对号。
    // 「关 → 又开」会拉高代次，旧决策不能把新开关下的东西发出去。
    const alive = () => resumeConfig.enabled && (!token || resumeEpoch === token.epoch);
    if (!alive()) return;
    const signal = resumeSignals.get(decision.sessionId) || null;
    // 双保险：状态机已经拦了一道，决策可能是在拦之前就排好的，发之前再对一次号。
    if (decision.action === "resume" && resumeTracker.isBlocked(decision.sessionId)) return;
    const { target, ...described } = await describeSession(decision.sessionId, signal);
    if (!alive()) return;
    // 两套编号统一落到稳定编号上再发，不然写进别的键里，对话里看不到。
    const sessionId = target?.sessionId || decision.sessionId;
    const agentId = signal?.agentId || target?.agentId || "";
    const source = { sessionId, ...described };
    if (decision.action === "resume") {
      if (!await sendResumeContinue(sessionId, agentId, token)) return;
      if (resumeNoticeKey === sessionId && resumeNoticeSource !== "loop_confirm") await pushResumeNotice(null);
      // 自动续接走的是同一条决策路径，但用户不在场（手动那条走球上按钮的
      // /resume/action 分支）。以前这里什么都不推，球侧那条提示又被 App 模式
      // 藏着，于是「刚才自动发过一句」完全无感知。
      await pushResumeFlash({ ...source, at: Date.now() });
      await pushResumeProgress();
      return;
    }
    await pushResumeNotice({
      ...source,
      reason: buildResumeExplanation(signal),
      attempt: decision.attempt,
      // 球上那句提示要能自己写清楚「这已经是第几次 / 上限多少 / 自动开没开」。
      maxConsecutive: resumeConfig.maxConsecutive,
      autoResume: resumeConfig.autoResume,
      at: Date.now(),
    });
    await pushResumeProgress();
    const sourceText = describeResumeSource({ ...described, sessionId });
    // 冻结期这条小条不会真的推到球上，日志得说实话，不然以后翻日志会被带偏。
    await sdk.logger.info(
      resumeUiFrozen
        ? `续接用尽（冻结中，未推界面）：${decision.reason}｜${sourceText}`
        : `续接用尽，已在传音樱提醒：${decision.reason}｜${sourceText}`,
      { sessionId, source: sourceText },
    );
  }

  // 卡住确认的观察窗：第一次看到「没进展」先记一笔，下一轮复核仍然没进展才真的报。
  // 一轮长思考/长工具调用可能几分钟不写盘，90 秒一个窗口太短（2026-10-19 实机：
  // 10:02、12:06 两次都是把还在跑的轮次当成卡住，而报告前手里只有 RPC 限流丢钩子的记录）。
  const stuckProbeAt = new Map();

  async function pumpResume() {
    if (!resumeConfig.enabled || pumpingResume) return;
    pumpingResume = true;
    // 代次快照：中间任何 await 之后都要对号，配置变了或总开关被关了就当场收手。
    // 已经交给宿主的发送撤不回来，这是这条防线能守住的全部边界。
    const epoch = resumeEpoch;
    const stale = () => resumeEpoch !== epoch || !resumeConfig.enabled;
    try {
      const candidates = resumeTracker.stuckCandidates();
      // 已经不在候选名单里的会话，观察记录一并清掉，不留脏数据。
      const activeKeys = new Set(candidates.map((item) => item.sessionId));
      for (const key of stuckProbeAt.keys()) if (!activeKeys.has(key)) stuckProbeAt.delete(key);
      for (const candidate of candidates) {
        if (stale()) return;
        // 已经判明「续不回来」的会话不再走卡住兜底。它可能是额度用完又没有错误事件的那一轮：
        // 信号侧拦下的同时会把这个标记留下，两个入口共用一条账。
        if (resumeTracker.isBlocked(candidate.sessionId)) {
          stuckProbeAt.delete(candidate.sessionId);
          continue;
        }
        // 卡住兜底不能只信倒计时：宿主一次 RPC 限流就能把「这一轮已经说过话」的记账吞掉，
        // 于是正常会话被当成卡住。会话在那之后被写过，就说明有进展，不算卡住。
        const target = await resolveResumeTarget({ sessionId: candidate.sessionId }, { force: true });
        if (stale()) return;
        // 复核时再认一步：事件侧的路径可能空着，但 session:list 的条目带着 kind/path。
        // 认出来就把这条账忘掉，不计数、不弹卡。
        if (isSubagentSessionTarget(target || {})) {
          resumeTracker.forget(candidate.sessionId);
          stuckProbeAt.delete(candidate.sessionId);
          await sdk.logger.debug?.("卡住复核：这是子代理会话，不参与续接", { sessionId: candidate.sessionId });
          continue;
        }
      const review = reviewStuckCandidate(candidate, { target, indexStale: target?.indexStale === true });
      if (review.action === "wait") {
        // 拿不到证据就不记账：名单里没有这段对话，或这次拿到的是超时沿用的旧快照。
        // 旧快照的 modified 是过期值，用它判「没进展」可复现正常会话被误报；本次实机缺少复核快照，不能反推唯一原因。
        // 只记编号与时间，不写正文。
        await sdk.logger.debug?.(`卡住复核：${review.reason}，这轮不报`, {
          sessionId: candidate.sessionId,
          candidateStartedAt: candidate.startedAt,
          reviewedAt: Date.now(),
          indexStale: target?.indexStale === true,
        });
        continue;
      }
      if (review.action === "recovered") {
        resumeTracker.markProduced(candidate.sessionId, candidate.agentId);
        stuckProbeAt.delete(candidate.sessionId);
        await sdk.logger.debug?.("卡住复核：这段对话后来有正文，不用续接", { sessionId: candidate.sessionId });
        continue;
      }
      // 第一次看到「没进展」只记观察时间，再等一个阈值。真卡住最多晚一阵提醒，
      // 长任务不会因为 90 秒内没落盘就被糊一张续接卡。
      const probeAt = stuckProbeAt.get(candidate.sessionId) || 0;
      const confirmMs = Math.max(30_000, Number(resumeConfig.stuckTimeoutMs) || 90_000);
      if (!probeAt) {
        stuckProbeAt.set(candidate.sessionId, Date.now());
        await sdk.logger.debug?.("卡住复核：第一次没看到进展，再等一轮确认", { sessionId: candidate.sessionId });
        continue;
      }
      if (Date.now() - probeAt < confirmMs) {
        continue;
      }
      stuckProbeAt.delete(candidate.sessionId);
      resumeTracker.markStuck(candidate.sessionId);
      // 键统一用登记过别名之后的那个：resolve 与 pendingKeys 都是按稳定编号走的，
      // 这里若还用事件侧的旧键，待决时取不到 signal，抬头又变回空白。
      const key = resumeTracker.canonicalId(candidate.sessionId);
      resumeSignals.set(key, {
        sessionId: key,
        agentId: candidate.agentId || target?.agentId || "",
        reason: "",
        title: target?.title || "",
        agentName: target?.agentName || "",
        firstMessage: target?.firstMessage || "",
      });
    }
      for (const key of resumeTracker.pendingKeys()) {
        if (stale()) return;
        await applyResumeDecision(resumeTracker.resolve({ sessionId: key }), { epoch });
      }
    } finally {
      pumpingResume = false;
    }
  }

  async function handleResumeEvent(event, sessionPath) {
    if (!event) return;
    // 子代理会话不进断点续接：那是伙伴派出去干活的一次性会话，没有「用户窗口没说完」
    // 这回事。2026-10-19 实机：一轮里派了四个子代理，四段会话各弹了一张续接卡。
    if (isSubagentSessionPath(sessionPath)) return;
    // 循环续接的兜底判定必须走在断点续接总开关的早退之前：
    // 手动「这次接几轮」起的循环跟断点总开关是两笔账（开关只管断点那一半），
    // 而且已经发出去的那几句仍需要轮末判定才能往下接。
    //
    // 为什么要兜底：循环判定以前只挂在 messages/post-assistant 钩子上，而那是一次性判定——
    // 一轮只触发一次，撞上宿主的 App RPC 并发限制（日志里一天十几次
    // “adjudicator threw: App RPC concurrency limit reached”）就永久错过，
    // 循环会一直卡在 running、done 停在 0。turn_end 走事件总线不吃那套限流，当第二条路。
    if (event.type === "turn_end" && loopRegistry.list().length && !loopFiring) {
      void (async () => {
        try {
          if (event.aborted === true) return;
          const parts = Array.isArray(event.message?.content) ? event.message.content : [];
          const hasToolCall = parts.some((part) => part && (part.type === "tool-call" || part.type === "toolCall" || part.toolCall || part.tool_use));
          const stopReason = String(event.message?.stopReason || "");
          // 工具中间轮也会走 turn_end，那不是「说完了」。
          const aborted = event.aborted === true;
          const stopReasonBad = Boolean(stopReason) && stopReason !== "stop";
          // 没能正常收尾的轮（模型报错、被按停、stopReason 不是 stop）都算失败轮。
          // 失败轮没有正文，但「这一轮走完了」这件事是真的。
          const failedTurn = aborted || !assistantTextOf(event.message) || stopReasonBad;
          if (!failedTurn && hasToolCall) return;
          const text = failedTurn ? "" : assistantTextOf(event.message);
          const target = await resolveResumeTargetLite({ sessionId: String(event.sessionId || ""), sessionPath });
          const sid = target?.sessionId || sessionIdFromPath(sessionPath) || String(event.sessionId || "");
          if (!sid || !loopRegistry.get(sid)) return;
          // 没有正文 = 这一轮没能正常说完（模型报错、被按停）。它不算恢复，
          // 但手动「接几轮」要算它走完了一轮——不然模型挂着的时候，接几轮永远
          // 只发得出第一句，循环还一直挂着，面板上永远停在 1/2。
          await fireContinueLoop(sid, text || "", {
            agentId: String(target?.agentId || event.agentId || ""),
            source: text ? "turn_end" : "turn_end_failed",
          });
        } catch (error) {
          await sdk.logger.warn(`循环续接兜底判定出错：${String(error?.message || error).slice(0, 160)}`);
        }
      })();
    }
    // 排队话单的兜底判定：与循环续接同一个道理——钩子是一次性判定，
    // 撞上宿主的 App RPC 并发限制就会永久错过，这一轮就再也接不上下一句。
    if (event.type === "turn_end" && queuePlans.list().length) {
      void (async () => {
        try {
          const target = await resolveResumeTargetLite({ sessionId: String(event.sessionId || ""), sessionPath });
          let sid = target?.sessionId || sessionIdFromPath(sessionPath) || String(event.sessionId || "");
          if (!queuePlans.get(sid)) {
            // 认不出是哪段对话就别就此作罢：只有一份话单在跑时，它就是那份。
            // 事件给的是文件名、话单记的是 sess_xxx，两套编号对不上时最容易在这儿空转。
            const running = queuePlans.list().filter((item) => item.status === "running");
            if (running.length === 1) {
              sid = running[0].sessionId;
              safeLog.info("排队话单兜底：按唯一在跑的话单认了对话", { sessionId: sid });
            }
          }
          if (!sid || !queuePlans.get(sid)) return;
          // 会话被中止：宿主会清掉排队中的输入，排的那句不会发出去。
          // 这时要给用户回执，不然她会一直以为还在排。
          if (event.aborted === true) {
            queuePlans.stop(sid, "对话被中止");
            await pushQueueState(null, { message: "那段对话被中止了，排的话没发出去" });
            return;
          }
          const parts = Array.isArray(event.message?.content) ? event.message.content : [];
          const hasToolCall = parts.some((part) => part && (part.type === "tool-call" || part.type === "toolCall" || part.toolCall || part.tool_use));
          const stopReason = String(event.message?.stopReason || "");
          // 工具中间轮也会走 turn_end，那不是「说完了」。
          if (hasToolCall || (stopReason && stopReason !== "stop")) return;
          const text = assistantTextOf(event.message);
          if (!text) return;
          await fireQueuePlan(sid, text, { source: "turn_end" });
        } catch (error) {
          await sdk.logger.warn(`排队话单兜底判定出错：${String(error?.message || error).slice(0, 160)}`);
        }
      })();
    }
    if (!resumeConfig.enabled) return;
    // 事件处理里也有 await（读名单）。等它回来时配置可能已经变了，
    // 那时再登记异常就是把关闭期间的事又写回新状态。
    const epoch = resumeEpoch;
    const stale = () => resumeEpoch !== epoch || !resumeConfig.enabled;
    // provider 报错事件：不当异常信号调度（重试期间它会反复来），只用它认一件事——
    // 这次断联是额度/欠费/鉴权，续也续不回来。登完这个标记，后面的路（包括 90 秒卡住兜底）
    // 就都不会再补「继续哈」。2026-10-25 用户提的就是这一类：不该续的时候别续。
    if (String(event?.type || "") === "error") {
      const blocker = classifyResumeBlocker({ errorMessage: event.message, error: event.error, reason: event.reason });
      if (!blocker) return;
      const target = await resolveResumeTargetLite({ sessionId: String(event.sessionId || ""), sessionPath });
      if (stale()) return;
      if (isSubagentSessionTarget({ ...(target || {}), path: target?.path || sessionPath || "" })) return;
      const key = target?.sessionId || sessionIdFromPath(sessionPath) || String(event.sessionId || "");
      if (!key) return;
      const already = resumeTracker.isBlocked(key);
      resumeTracker.markBlocked(key, target?.agentId || event.agentId || "", blocker);
      if (already?.kind === blocker.kind) return;
      const blockedKey = resumeTracker.canonicalId(key);
      resumeSignals.delete(blockedKey);
      stuckProbeAt.delete(blockedKey);
      if (resumeNoticeKey === blockedKey && resumeNoticeSource !== "loop_confirm") void pushResumeNotice(null);
      void pushResumeProgress();
      await sdk.logger.info(`这次不续：${blocker.label}（${blocker.kind}）`, {
        sessionId: blockedKey,
        via: "error-event",
        source: target?.title || target?.agentName || "",
      });
      return;
    }
    // 事件给的是文件名、钩子给的是 sess_xxx：先归一到 sessionId，
    // 否则「开始时记了 A、恢复时清了 B」，两边永远对不上。
    const retry = parseAutoRetryStart(event, sessionPath);
    if (retry) {
      const target = await resolveResumeTarget(retry);
      if (stale()) return;
      // 子代理会话的自动重试不属于「用户窗口」，不记“正在重试”。
      if (isSubagentSessionTarget({ ...(target || {}), path: target?.path || retry.sessionPath || "" })) {
        resumeTracker.forget(target?.sessionId || retry.sessionId || "");
        return;
      }
      const key = target?.sessionId || retry.sessionId || retry.agentId;
      if (key) resumeTracker.markRetrying(key, target?.agentId || retry.agentId);
      return;
    }
    const signal = parseResumeSignal(event, sessionPath);
    if (signal) {
      if (isUserInitiatedAbortReason(signal.reason)) return;
      const target = await resolveResumeTarget(signal);
      if (stale()) return;
      // 子代理会话报错（provider 打呼、重试失败）不是「用户窗口没说完」。
      // 事件回调的 sessionPath 有时是空的，函数入口那道挡不住，必须拿到 target 再认一次：
      // 2026-10-19 那四张卡的 reason 非空（文案是「没能正常收尾」），走的就是这条信号路，
      // 不是卡住兜底——两个入口都得堵。
      if (isSubagentSessionTarget({ ...(target || {}), path: target?.path || signal.sessionPath || "" })) {
        const signalKey = resumeTracker.canonicalId(target?.sessionId || signal.sessionId || "");
        resumeTracker.forget(target?.sessionId || signal.sessionId || "");
        if (signalKey) resumeSignals.delete(signalKey);
        stuckProbeAt.delete(signalKey);
        return;
      }
      const sessionId = target?.sessionId || signal.sessionId;
      const agentId = target?.agentId || signal.agentId;
      const key = sessionId || agentId;
      if (!key) return;
      const normalized = {
        ...signal,
        sessionId,
        agentId,
        title: target?.title || "",
        agentName: target?.agentName || "",
        firstMessage: target?.firstMessage || "",
      };
      const verdict = resumeTracker.onAbnormal(normalized);
      // 额度用完、欠费、鉴权失效：这一次不是「被掉线掐断」，而是「模型那头不接」。
      // 不排队、不推卡、也不发「继续哈」—— 2026-10-25 用户提的就是这个：
      // 这种时候再补一句，只会再撞一次墙，白花一次调用。
      // 只记一条日志说明原因（不写正文），并把这条会话从待执名单里拿掉。
      if (verdict?.blocker) {
        const blockedKey = resumeTracker.canonicalId(key);
        resumeSignals.delete(blockedKey);
        stuckProbeAt.delete(blockedKey);
        if (resumeNoticeKey === blockedKey && resumeNoticeSource !== "loop_confirm") void pushResumeNotice(null);
        void pushResumeProgress();
        await sdk.logger.info(`这次不续：${verdict.reason}（${verdict.blocker}）`, {
          sessionId: blockedKey,
          source: target?.title || target?.agentName || "",
        });
        return;
      }
      // 键用登记完别名之后那个：否则信号存在 UUID 名下、决策却按稳定编号去查，
      // 两边对不上，抬头又变回空白，日志里也找不到这段对话。
      resumeSignals.set(resumeTracker.canonicalId(key), normalized);
      return;
    }
    if (event.type === "turn_end") {
      if (event.aborted === true || !assistantTextOf(event.message)) return;
      // 工具轮也会走 turn_end，那不是「说完了」。只有 stopReason 收在 stop、
      // 且正文里没有工具调用，才算真回复；否则会在一半路上把失败计数清零、把等待清掉。
      const parts = Array.isArray(event.message?.content) ? event.message.content : [];
      const hasToolCall = parts.some((part) => part && (part.type === "tool-call" || part.type === "toolCall" || part.toolCall || part.tool_use));
      const stopReason = String(event.message?.stopReason || "");
      if (hasToolCall || (stopReason && stopReason !== "stop")) return;
      const target = await resolveResumeTargetLite({ sessionId: String(event.sessionId || ""), sessionPath });
      if (stale()) return;
      const sessionId = target?.sessionId || sessionIdFromPath(sessionPath) || String(event.sessionId || "");
      if (!sessionId) return;
      // 信号表按规范编号存（onAbnormal 那边登记的），这里清也得用同一个键。
      const canonicalKey = resumeTracker.canonicalId(sessionId);
      resumeTracker.markRecovered(sessionId, target?.agentId || event.agentId || "");
      resumeSignals.delete(canonicalKey);
      // 会话自己好了，就把桥上那条提醒收掉。但别把别的窗口那条也收了——
      // 以前这里无条件清，两个窗口同时出状况时先好的那个会把另一个的提醒弄丢。
      // handleResumeEvent 是事件钩子，这里不 await，只发起不等。
      if (resumeNoticeKey === sessionId && resumeNoticeSource !== "loop_confirm") void pushResumeNotice(null);
      void pushResumeProgress();
    }
  }

  // 宿主事件账本：「谁还在跑」的第三层，也是**唯一看得见 Code 页会话**的那层。
  // 为什么需要（2026-10-27 看宿主源码确认）：v2 App 的 session:list 在宿主里写死了
  //   namespace: d ? ["home", "app"] : ...
  // Code 页的会话 namespace 是 code，根本不在名单里；v2 契约也没有 namespace 参数可传。
  // 所以守门人原来在 Code 页干活时看到的永远是「全空」。
  // 全局订阅（不给 filter.sessionPath）能收到每个会话上的事件，跟 namespace 无关，
  // 而且事件自带 sessionPath，不需要先知道 sessionId——正好绕开死路。
  const activityLedger = createActivityLedger();
  setActivityLedger(activityLedger);

  // 订阅必须显式给第二个参数：省略时经 RPC 会变成 null，宿主在装载阶段读 types 直接抛错，
  // 整条安装记录作废（kc-debug-App里bus订阅省略参数会炸装载）。
  // 宿主不支持时只降级、不报错：卡住兜底走的是两个 hook，不依赖这条订阅。
  try {
    if (typeof sdk.bus?.subscribe === "function") {
      await sdk.bus.subscribe((event, sessionPath) => {
        // 记账放在最前面：下面一堆分支都有 return，早退不能把账漏了。
        // 这里只记内存，不 await、不发请求。
        try {
          activityLedger.note(event, sessionPath);
        } catch {}
        // 新会话默认会显示输入栏那个按钮，开关关着时得补一次盖住。
        if (event === "session_created") {
          void currentInputButtonEnabled()
            .then((enabled) => syncInputStatusVisibility(enabled))
            .catch(() => {});
          return;
        }
        // 关机提示条跟着人走：她换个窗口说话，条子就挪到那段对话上。
        if (String(event?.type || "") === "turn_start" && sessionPath) {
          noteShutdownActiveSession(sessionPath);
          return;
        }
        // 输入框上方那两条提示：用户手动关掉时记一笔，不再重挂。
        if (String(event?.type || "").includes(":banner")) {
          if (noteShutdownBannerEvent(event, sessionPath)) return;
          if (noteQueueBannerDismissed(event, sessionPath)) return;
        }
        void handleResumeEvent(event, sessionPath);
      }, {});
      resumeEventsAvailable = true;
    }
  } catch (error) {
    await sdk.logger.warn(`宿主不支持事件订阅，断联续接只剩卡住兜底：${String(error?.code || error?.message || error).slice(0, 120)}`);
  }
  // 关机条上写着倒计时，隔一会儿对一次；没开的时候它自己什么都不做。
  // 启动时立刻跑一轮，不等 12 秒：上次重载前挂过、但宿上还在的那些横幅，
  // 得尽快收掉。等定时器到点的话，人就对着一条早该消失的提示发楞。
  void syncShutdownBanner();
  const shutdownBannerTimer = setInterval(() => { void syncShutdownBanner(); }, 12_000);
  shutdownBannerTimer.unref?.();
  const resumeTimer = setInterval(() => { void pumpResume(); }, 5_000);
  resumeTimer.unref?.();
  const cardAsks = createCardAskRegistry();
  activeBallManager = ball;
  installBallShutdownHooks();

  await sdk.routes.register((app) => {
    // 任何路由抛出都换成 JSON + 一行日志。
    // 不对劲的地方：宿主对未捕获异常只回纯文本 "Internal Server Error"，
    // 前端 response.json() 就抛一句英文 SyntaxError，用户看到的是乱码般的报错。
    app.use("*", async (c, next) => {
      try {
        await next();
      } catch (error) {
        try {
          await sdk.logger.error(`路由出错 ${c.req.path}：${String(error?.message || error).slice(0, 200)}`, {
            path: c.req.path,
            stack: String(error?.stack || "").slice(0, 800),
          });
        } catch { /* 日志失败不能盖住原始错误 */ }
        return c.json({ ok: false, error: "后台这次没成，再点一次试试。" }, 500);
      }
    });

    app.get("/input-zoom", async (c) => {
      try {
        return c.json(await inputZoomStatus());
      } catch (error) {
        return c.json({ ok: false, code: "FAILED", error: String(error?.message || error).slice(0, 160) }, 503);
      }
    });
    app.post("/input-zoom/install", async (c) => {
      try {
        return c.json(await installInputZoom());
      } catch (error) {
        return c.json({ ok: false, code: "FAILED", error: String(error?.message || error).slice(0, 160) }, 500);
      }
    });
    app.post("/input-zoom/uninstall", async (c) => {
      try {
        return c.json(await uninstallInputZoom());
      } catch (error) {
        return c.json({ ok: false, code: "FAILED", error: String(error?.message || error).slice(0, 160) }, 500);
      }
    });
    app.get("/permission-status", async (c) => {
      try {
        const result = await sdk.capabilities.get({});
        return c.json({
          ok: true,
          capabilities: Array.isArray(result?.capabilities) ? result.capabilities : [],
        });
      } catch {
        return c.json({ ok: false, error: "暂时读取不到 Hana 的权限记录。" }, 503);
      }
    });
    app.get("/summary-config", async (c) => c.json({
      ...normalizeSummaryConfig(await sdk.storage.global.get("summaryConfig", {})),
      bounds: { min: 1, max: MAX_MIN_CHARS, default: DEFAULT_MIN_CHARS },
    }));
    app.put("/summary-config", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "参数读不出来。" }, 400); }
      const next = normalizeSummaryConfig({
        enabled: body?.enabled,
        minChars: body?.minChars,
      });
      await saveConfig("summaryConfig", next);
      summaryConfigCache = next;
      return c.json({ ok: true, ...next });
    });
    app.get("/summary-model", async (c) => {
      try {
        const catalog = await sdk.models.list();
        return c.json({
          ok: true,
          models: chatModelOptions(catalog),
          modelRef: normalizeModelRef(await sdk.storage.global.get("summaryModel", null)),
        });
      } catch {
        return c.json({ ok: false, models: [], modelRef: null,
          error: "读取 Hana 已配置模型失败；请在应用权限中允许知意使用模型。" });
      }
    });
    app.put("/summary-model", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "模型设置读不出来。" }, 400); }
      const modelRef = body?.modelRef === null ? null : normalizeModelRef(body?.modelRef);
      if (body?.modelRef !== null && !modelRef) return c.json({ ok: false, error: "模型选项无效。" }, 400);
      try {
        if (modelRef) {
          const catalog = await sdk.models.list();
          const exists = chatModelOptions(catalog).some((row) => row.provider === modelRef.provider && row.model === modelRef.model);
          if (!exists) return c.json({ ok: false, error: "这条模型已不在 Hana 配置列表中，请重新选择。" }, 400);
        }
        await saveConfig("summaryModel", modelRef);
        return c.json({ ok: true, modelRef });
      } catch {
        return c.json({ ok: false, error: "保存模型失败；请确认知意已获模型使用权限。" }, 403);
      }
    });
    app.post("/summary-model/test", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "模型测试参数读不出来。" }, 400); }
      const modelRef = body?.modelRef === null ? null : normalizeModelRef(body?.modelRef);
      if (body?.modelRef !== null && !modelRef) return c.json({ ok: false, error: "模型选项无效。" }, 400);
      try {
        const result = await testAskModelConnection(sdk, modelRef, (event) => {
          void sdk.logger.debug?.("速览模型测试流", event);
        });
        await sdk.logger.info(`速览模型连通正常：${result.provider}/${result.model}`);
        return c.json({ ok: true, ...result });
      } catch (error) {
        // 以前这里直接回一句「没有正文」，日志里连个水花都没有，下一轮排查只能靠猜。
        await sdk.logger.warn(`速览模型测试失败：${modelRef ? `${modelRef.provider}/${modelRef.model}` : "跟随 Ask 判断模型"} ${error?.code ?? "no-code"} ${error?.message ?? String(error)}`);
        const message = error?.code === "MODEL_TIMEOUT"
          ? "连接超时；这条模型可能太慢，速览等不住，换个更快的试试。"
          : error?.code === "MODEL_NOT_FOUND"
            ? "Hana 模型目录里没有可用的文本模型。"
            : error?.code === "MODEL_EMPTY"
              ? "模型已连接，但没有返回正文；推理模型可能把输出额度用在了思考上，换条非推理的模型试试。"
              : "连接失败，请检查模型配置和应用权限。";
        return c.json({ ok: false, error: message, code: error?.code || "MODEL_ERROR" }, 502);
      }
    });
    // ── 断联续接 ──
    app.get("/custom-model", async (c) => {
      const config = await sdk.storage.global.get("customTextModel", {});
      return c.json({ ok: true, config: maskCustomModelConfig(config), encrypted: encryptionAvailable() });
    });
    app.put("/custom-model", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "自定义模型设置读不出来。" }, 400); }
      const current = await sdk.storage.global.get("customTextModel", {});
      const next = await mergeCustomModelConfig(current, body?.config || {});
      await sdk.storage.global.set("customTextModel", next);
      return c.json({
        ok: true,
        config: maskCustomModelConfig(next),
        encrypted: encryptionAvailable(),
        encryptionNote: encryptionAvailable() ? "" : (encryptionStatus().reason || "系统加密不可用"),
      });
    });
    app.post("/custom-model/test", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "测试参数读不出来。" }, 400); }
      try {
        const result = await testCustomModel(sdk, body?.config || {});
        await sdk.logger.info(`自定义模型连通正常：${result.model}`);
        return c.json(result);
      } catch (error) {
        await sdk.logger.warn(`自定义模型测试失败：${String(error?.message || error).slice(0, 160)}`);
        return c.json({ ok: false, error: String(error?.message || error).slice(0, 240), code: error?.code || "CUSTOM_TEST_ERROR" }, 502);
      }
    });

    app.get("/resume-config", async (c) => c.json({ ok: true, config: resumeConfig, text: RESUME_TEXT, frozen: resumeUiFrozen }));
    // 旧的 /resume-freeze（暗号解冻）随冻结层一起拆掉：少一个能改界面可见性的入口。
    app.put("/resume-config", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "续接设置读不出来。" }, 400); }
      // 改自动或上限不重建状态机：已经续过几次要留着，不然调个上限就白送几次。
      // 只有总开关转成「关」时才清场。
      const config = await applyResumeConfig(body?.config || {});
      return c.json({ ok: true, config });
    });
    app.get("/resume-status", async (c) => {
      const sessionId = String(c.req.query("sessionId") || "");
      return c.json({
        ok: true,
        config: resumeConfig,
        eventsAvailable: resumeEventsAvailable,
        session: sessionId ? resumeTracker.snapshot(sessionId) : null,
        // 没有球的时候靠这里查结果：达到了上限就安静停着，不弹任何窗。
        progress: await describeResumeProgress(),
      });
    });
    app.post("/resume/continue", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "续接参数读不出来。" }, 400); }
      const sessionId = String(body?.sessionId || "").trim();
      if (!sessionId) return c.json({ ok: false, error: "没解析出这段对话的编号，这次不续接。" }, 400);
      if (!resumeConfig.enabled) return c.json({ ok: false, error: "断点续接已关闭。" }, 409);
      const sent = await sendResumeContinue(sessionId, "", { epoch: resumeEpoch });
      if (!sent) return c.json({ ok: false, error: "续接未能确认发送，原提醒保留，请检查设置后重试。" }, 502);
      if (resumeNoticeKey === sessionId && resumeNoticeSource !== "loop_confirm") await pushResumeNotice(null);
      await pushResumeProgress();
      return c.json({ ok: true, sessionId, text: RESUME_TEXT });
    });
    app.post("/resume/dismiss", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "参数读不出来。" }, 400); }
      const sessionId = String(body?.sessionId || "").trim();
      if (!sessionId) return c.json({ ok: false, error: "缺少对话编号。" }, 400);
      const key = resumeTracker.canonicalId(sessionId);
      resumeTracker.forget(sessionId);
      resumeSignals.delete(key);
      if (resumeNoticeKey === key && resumeNoticeSource !== "loop_confirm") await pushResumeNotice(null);
      await pushResumeProgress();
      return c.json({ ok: true });
    });

    // ── 守门人（活干完再关机）──
    // 面板和传音樱都从这三个口子读：状态、参数、撤掉。
    app.get("/sleep-guard", async (c) => {
      const status = await readSleepGuard(sdk, { withLog: true });
      const timeline = await readSleepTimeline(sdk, 120);
      const config = await readSleepGuardConfig(sdk);
      const realEnabled = await isRealEnabled(sdk);
      const state = status.state || {};
      return c.json({
        ok: true,
        armed: status.armed === true,
        status: state.status || "idle",
        idleSeconds: Math.round((status.idleForMs || 0) / 1000),
        needSeconds: Math.round((state.idleMs || 0) / 1000),
        countdownSeconds: Math.round((status.countdownLeftMs || 0) / 1000),
        sinceArmedSeconds: Math.round((status.sinceArmedMs || 0) / 1000),
        result: state.result || null,
        cancelReason: state.cancelReason || null,
        note: state.note || "",
        realEnabled,
        dryRun: state.armed ? state.dryRun !== false : null,
        config,
        log: (status.log || []).slice(-8),
        timeline: timeline.slice(-60),
      });
    });
    app.post("/sleep-guard/config", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "参数读不出来。" }, 400); }
      const config = await saveSleepGuardConfig(sdk, body || {});
      return c.json({ ok: true, config });
    });
    app.post("/sleep-guard/real", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "参数读不出来。" }, 400); }
      const realEnabled = await setRealEnabled(sdk, body?.enabled === true);
      await sdk.logger.info(`真关机开关（面板）：${realEnabled ? "已打开" : "已关闭"}`);
      return c.json({ ok: true, realEnabled });
    });
    app.get("/sleep-guard/banner-debug", async (c) => {
      // 排查专用：看关机提示条到底挂到了哪几段会话上。
      //
      // 为什么需要它：2026-10-28 玥儿在 Code 页挂了关机，输入框上方一条提示都没出。
      // 根因是候选名单只看 session:list（它看不见 Code 页），但当时根本无从查起，
      // 只能读代码推。有了这个接口，下次一条命令就能看出名单里有没有那段会话。
      const candidates = await pickRecentSessionPaths();
      return c.json({
        ok: true,
        bannerText: describeShutdownBanner(),
        // 当前已经挂上的（App 记住的那几段）
        mounted: [...shutdownBannerTexts.keys()],
        // 这一轮算出来的候选名单（实际会往这些挂）
        candidates,
        // 被手动收起过、暂时不再挂的
        muted: [...shutdownMutedPaths.keys()],
        // 账本里知道的全量会话路径（不看忙闲）
        ledgerPaths: (() => {
          try { return activityLedger?.paths?.() || []; } catch { return []; }
        })(),
        ledgerSize: (() => {
          try { return activityLedger?.size ?? 0; } catch { return 0; }
        })(),
      });
    });

    app.post("/sleep-guard/banner-reset", async (c) => {
      // 急救用：把当前知道的会话上的关机横幅全部摘掉，不管 App 记不记得挂过。
      //
      // 为什么需要：已挂名单以前只在内存，重载就丢。宿主的横幅不会因为 App 重载而消失，
      // 于是会出现「取消了还挂着」的孤儿横幅，而 App 自己没任何办法把它收掉。
      // 现在虽然加了持久化与启动回收，但已经漏在外面的那些得有个手动出口。
      const candidates = await pickRecentSessionPaths();
      const extra = [...shutdownBannerTexts.keys()];
      const all = [...new Set([...candidates, ...extra])];
      let dismissed = 0;
      for (const path of all) {
        const value = String(path || "");
        if (!value) continue;
        await dismissShutdownBanner(value);
        dismissed += 1;
      }
      return c.json({ ok: true, dismissed, paths: all });
    });

    app.post("/sleep-guard/cancel", async (c) => {
      const result = await cancelSleepGuard(sdk, "在知意面板上手动取消");
      void syncShutdownBanner();
      // 已经发出过关机命令时，面板得能看出「撤没撤成」。
      // 以前这里无条件报 ok，机器却照关，那是最坑人的一种反馈。
      if (result.wasIssued && result.abort?.ok !== true) {
        return c.json({
          ok: false,
          error: `关机已经发出去了，撤销没成功（${result.abort?.detail || "原因不明"}），机器还会关。`,
          ...result,
        }, 409);
      }
      return c.json({ ok: true, ...result });
    });
    // 面板上的启动入口：以前只有传音樱和模型工具能挂，面板只能取不能开。
    // 这个功能就是关机，没有演练档：挂上之前先把真关机打开。
    app.post("/sleep-guard/arm", async (c) => {
      if (describeSleepGuard().armed) {
        void syncShutdownBanner();
        return c.json({ ok: true, already: true });
      }
      await setRealEnabled(sdk, true);
      // 新开一次：之前被她关掉的会话也重新算。
      shutdownMutedPaths.clear();
      shutdownBannerTexts.clear();
      await armSleepGuard(sdk, { armedBy: "panel", note: "知意面板", graceMs: 60_000 });
      await sdk.logger.info("面板上开启关机");
      void syncShutdownBanner();
      return c.json({ ok: true, armed: true });
    });

    // 「打开知意页面时自动开球」：只存一个意向，真正开球由页面加载时去调 /ball/start。
    // 默认关，跟 ballDesired 一样不代替人做决定。
    app.get("/ball-auto-open", async (c) => {
      const enabled = await sdk.storage.global.get("ballAutoOpenOnPage", false);
      return c.json({ enabled: enabled === true });
    });
    app.post("/ball-auto-open", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "参数读不出来。" }, 400); }
      const enabled = body?.enabled === true;
      await sdk.storage.global.set("ballAutoOpenOnPage", enabled);
      return c.json({ ok: true, enabled });
    });

    // 「全屏时弹窗也浮上来」：关着就跟球一个级别，全屏时先让到后面。
    // 设置存在 App 这边，通过桥上那条 /settings/push 送给球。
    app.get("/popup-on-top", async (c) => {
      const enabled = await sdk.storage.global.get("popupOnTopDuringFullscreen", false);
      return c.json({ enabled: enabled === true });
    });
    app.post("/popup-on-top", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "参数读不出来。" }, 400); }
      const enabled = body?.enabled === true;
      await sdk.storage.global.set("popupOnTopDuringFullscreen", enabled);
      await pushPopupOnTop(enabled);
      return c.json({ ok: true, enabled });
    });

    // 主题深浅：界面上检测到就报上来，由这里转给球。
    // 球是独立进程，读不到宿主主题（它只能看 Windows 系统配色，跟 Hana 自己的主题不是一回事）。
    app.post("/ui-theme", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "参数读不出来。" }, 400); }
      const mode = body?.appearance === "dark" ? "dark" : body?.appearance === "light" ? "light" : "";
      const source = String(body?.source || "unknown");
      const background = String(body?.background || "");
      safeLog.info(`主题深浅：${mode || "拿不到"}（来源 ${source}${background ? `，底色 ${background}` : ""}）`);
      if (!mode) return c.json({ ok: false, error: "深浅只认 dark / light。" }, 400);
      const previous = await sdk.storage.global.get("uiAppearance", "");
      if (previous !== mode) {
        await sdk.storage.global.set("uiAppearance", mode);
        await pushUiAppearance(mode);
      }
      return c.json({ ok: true, appearance: mode });
    });

    async function pushUiAppearance(mode) {
      try {
        await ball.bridgeRequest("/settings/push", { method: "POST", body: { themeMode: mode === "dark" ? "dark" : "light" } });
      } catch (error) {
        safeLog.warn(`主题深浅没送到球上：${String(error?.message || error).slice(0, 120)}`);
      }
    }

    async function pushPopupOnTop(enabled) {
      try {
        await ball.bridgeRequest("/settings/push", { method: "POST", body: { popupOnTop: enabled === true } });
      } catch (error) {
        safeLog.warn(`全屏弹窗设置没送到球上：${String(error?.message || error).slice(0, 120)}`);
      }
    }

    app.get("/ball/status", (c) => c.json(ball.state()));
    app.post("/ball/start", async (c) => {
      const result = await ball.start();
      if (result?.running) {
        ballDesired = true;
        void saveConfig("ballDesired", true).catch(() => {});
        rememberCurrentHost();
      }
      if (result?.running) scheduleVoiceBridgeTick(sdk, ball);
      if (result?.running) {
        // 球刚起来：把当前的全屏弹窗设置补推一次，别让它按旧默认走。
        const onTop = await sdk.storage.global.get("popupOnTopDuringFullscreen", false);
        void pushPopupOnTop(onTop === true);
        const appearance = await sdk.storage.global.get("uiAppearance", "");
        if (appearance === "dark" || appearance === "light") void pushUiAppearance(appearance);
      }
      if (result?.running) scheduleBallBridgeTick(sdk, ball);
      if (result?.running) startSleepBallPush(sdk, ball);
      if (result?.running) void adoptPendingBallAsks().catch(() => {});
      if (result?.running) {
        // 球刚起来时它手里没有任何全局状态（默认按「关」算），不同步就会把手动弹出来的
        // 那条 notice 误藏起来。序号基线也得重立，否则球重开后新动作会被旧序号卡死。
        resumeActionBaselineAdopted = false;
        // 冻结期这里走的是清理分支：把球上可能还挂着的旧小条收掉，不然重载后用户还看得见一张旧提醒。
        void syncResumeVisibility();
        void syncPendingResumeNotice();
      }
      return c.json(result);
    });
    app.post("/ball/stop", async (c) => {
      // 用户亲手关的：记住这个意图，下次 App 重载不要再自作主张拉起来。
      ballDesired = false;
      void saveConfig("ballDesired", false).catch(() => {});
      return c.json(await ball.stop());
    });

    // ── 语音朗读 ──
    // 配置一条朗读模型 + 朗读偏好 + 按伙伴分的音色；Key 落盘前用系统加密保护。

    // 伙伴名单：先问宿主要完整名单（茶话会走的就是 agent:list），拿不到再退回会话名单。
    async function readVoicePartners(sdk) {
      try {
        const listed = await sdk.bus.request("agent:list", { scope: "all", lifecycle: "active" }, { timeoutMs: 8_000 });
        const rows = Array.isArray(listed) ? listed : listed?.agents;
        const partners = (Array.isArray(rows) ? rows : [])
          .map((row) => ({
            agentId: String(row?.id || row?.agentId || "").trim(),
            agentName: String(row?.name || row?.displayName || row?.agentName || "").trim(),
          }))
          .filter((row) => row.agentId)
          .map((row) => ({ agentId: row.agentId, agentName: row.agentName || row.agentId }));
        return { partners, partnersNote: "" };
      } catch (error) {
        await sdk.logger.warn(`朗读伙伴名单（agent:list）读取失败，退回会话名单：${error?.message ?? String(error)}`);
        try {
          const listed = await sdk.bus.request("session:list", { scope: "all" }, { timeoutMs: 8_000 });
          const sessions = Array.isArray(listed) ? listed : listed?.sessions;
          const seen = new Map();
          for (const item of Array.isArray(sessions) ? sessions : []) {
            const agentId = String(item?.agentId || "").trim();
            if (!agentId || seen.has(agentId)) continue;
            seen.set(agentId, {
              agentId,
              agentName: String(item?.agentName || "").trim(),
              modified: Number(item?.modified ?? 0) || 0,
            });
          }
          const partners = [...seen.values()]
            .sort((a, b) => b.modified - a.modified)
            .slice(0, 12)
            .map(({ agentId, agentName }) => ({ agentId, agentName: agentName || agentId }));
          return { partners, partnersNote: "这份名单是从最近聊过的对话里凑的，没聊过的伙伴不会出现在这儿。" };
        } catch (fallbackError) {
          const partnersNote = `伙伴名单读不到（${String(fallbackError?.message || fallbackError).slice(0, 80)}），暂时不能按伙伴分音色。`;
          await sdk.logger.warn(`朗读伙伴名单读取失败：${fallbackError?.message ?? String(fallbackError)}`);
          return { partners: [], partnersNote };
        }
      }
    }

    // GET 与 PUT 回同一份形状。少了这份，页面每次保存后都会把音色库和伙伴名单清空：
    // 面板拿到精简响应就把 voiceLibrary 当成空，音色下拉里只剩「跟随默认」。
    async function buildVoiceConfigPayload(sdk, config) {
      const { partners, partnersNote } = await readVoicePartners(sdk);
      return {
        ok: true,
        config: maskVoiceConfig(config),
        presets: VOICE_PRESETS,
        voices: voicesForProtocol(config.protocol),
        voiceLibrary: { t2a: voicesForProtocol("t2a"), chat: voicesForProtocol("chat"), speech: voicesForProtocol("speech") },
        partners,
        partnersNote,
        encrypted: encryptionAvailable(),
        encryptionNote: encryptionAvailable() ? "" : (encryptionStatus().reason || "系统加密不可用"),
        limits: { maxChars: MAX_REPLY_CHARS * 10 },
      };
    }

    app.get("/voice-config", async (c) => {
      const config = normalizeVoiceConfig(await sdk.storage.global.get("voiceConfig", {}));
      return c.json(await buildVoiceConfigPayload(sdk, config));
    });
    app.put("/voice-config", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "语音设置读不出来。" }, 400); }
      const current = normalizeVoiceConfig(await sdk.storage.global.get("voiceConfig", {}));
      const submitted = normalizeVoiceConfig(body?.config);
      // 页面回传掩码时保留旧 Key，不许被 "********" 覆盖成真值。
      const rawKey = isMaskedKey(body?.config?.apiKey) ? current.apiKey : submitted.apiKey;
      const next = { ...submitted, apiKey: rawKey === current.apiKey ? current.apiKey : await protectKey(rawKey) };
      await sdk.storage.global.set("voiceConfig", next);
      // 回完整的一份：只回 config 的话，页面保存后会把音色库和伙伴名单当成空的。
      return c.json(await buildVoiceConfigPayload(sdk, next));
    });
    app.post("/voice-config/test", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "测试参数读不出来。" }, 400); }
      const stored = normalizeVoiceConfig(await sdk.storage.global.get("voiceConfig", {}));
      const submitted = normalizeVoiceConfig(body?.config);
      const probe = {
        ...stored,
        ...submitted,
        enabled: true,
        apiKey: isMaskedKey(body?.config?.apiKey) ? stored.apiKey : submitted.apiKey,
      };
      try {
        const result = await synthesizeVoice(sdk, {
          text: "这段是知意的朗读试听，能听到就说明配置通了。",
          config: probe,
          voiceId: String(body?.voiceId || "").trim() || probe.defaultVoiceId,
        });
        await sdk.logger.info(`语音模型连通正常：${probe.protocol}/${probe.model}`);
        return c.json({
          ok: true,
          format: result.format,
          durationMs: result.durationMs,
          timings: result.timings,
          audio: result.audio.toString("base64"),
        });
      } catch (error) {
        await sdk.logger.warn(`语音模型测试失败：${probe.protocol}/${probe.model} ${error?.message ?? String(error)}`);
        return c.json({ ok: false, error: String(error?.message || error).slice(0, 240) }, 502);
      }
    });
    // 音色试听：合成一句固定的话给人听，音色调好了再决定用哪个。
    // 跟 /voice-config/test 的区别是：这条按音色缓存，同一个音色再点不重复花钱。
    app.post("/voice/preview", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "试听参数读不出来。" }, 400); }
      const stored = normalizeVoiceConfig(await sdk.storage.global.get("voiceConfig", {}));
      // 页面没传配置时不能拿空配置去盖住已存的那份：
      // normalizeVoiceConfig({}) 会填出一套默认值（空的 Key、默认地址），盖上去就说「没配齐」。
      const submitted = body?.config ? normalizeVoiceConfig(body.config) : {};
      const probe = {
        ...stored,
        ...submitted,
        enabled: true,
        apiKey: isMaskedKey(body?.config?.apiKey)
          ? stored.apiKey
          : (String(submitted.apiKey || "").trim() || stored.apiKey),
      };
      const voiceId = String(body?.voiceId || "").trim() || probe.defaultVoiceId;
      const text = "这是这个音色的试听，听听看合不合适。";
      const fingerprint = voiceFingerprint(text, voiceId, probe);
      const hit = await readCachedSpeak(sdk, fingerprint);
      if (hit) {
        return c.json({
          ok: true,
          cached: true,
          clipId: hit.clipId,
          format: hit.format || "mp3",
          durationMs: hit.durationMs,
          timings: hit.timings || null,
          text,
        });
      }
      try {
        const result = await synthesizeVoice(sdk, { text, config: probe, voiceId });
        const clipId = `clip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        saveClip(sdk, clipId, result.audio, result.format);
        saveClipMeta(sdk, clipId, { fingerprint, format: result.format, durationMs: result.durationMs, timings: result.timings || null, voiceId });
        await rememberCachedSpeak(sdk, fingerprint, clipId);
        await sdk.logger.info(`音色试听已合成：${probe.protocol}/${probe.model} / ${voiceId || "默认音色"} / ${result.format}`);
        return c.json({
          ok: true,
          cached: false,
          clipId,
          format: result.format,
          durationMs: result.durationMs,
          timings: result.timings || null,
          text,
        });
      } catch (error) {
        await sdk.logger.warn(`音色试听失败：${probe.protocol}/${probe.model} ${error?.message ?? String(error)}`);
        return c.json({ ok: false, error: String(error?.message || error).slice(0, 240) }, 502);
      }
    });
    app.get("/voice/replies", async (c) => {
      try {
        const result = await listSpeakableReplies(sdk, {
          sessionId: String(c.req.query("sessionId") || ""),
          limit: Number(c.req.query("limit")) || 8,
        });
        return c.json({ ok: true, ...result });
      } catch (error) {
        return c.json({ ok: false, error: String(error?.message || error).slice(0, 240) }, 502);
      }
    });
    // 列表里的 text 只带前 1200 字（桥的 64KB 上限）；进「改稿」时要一次全文，
    // 不然长回复在编辑器里只有前半截，删完保存就把后半截默默丢了。
    app.get("/voice/reply-text", async (c) => {
      try {
        const rawIds = String(c.req.query("entryIds") || "");
        const entryIds = rawIds.split(",").map((value) => value.trim()).filter(Boolean);
        const result = await readFullReplyText(sdk, {
          sessionId: String(c.req.query("sessionId") || ""),
          entryId: String(c.req.query("entryId") || ""),
          entryIds,
        });
        return c.json({ ok: true, ...result });
      } catch (error) {
        return c.json({ ok: false, error: String(error?.message || error).slice(0, 240) }, 502);
      }
    });
    app.post("/voice/speak", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "朗读参数读不出来。" }, 400); }
      try {
        return c.json({ ok: true, ...(await speakByEntry(sdk, {
          sessionId: String(body?.sessionId || ""),
          entryId: String(body?.entryId || ""),
          entryIds: Array.isArray(body?.entryIds) ? body.entryIds : [],
          text: String(body?.text || ""),
          draft: body?.draft === true,
        })) });
      } catch (error) {
        return c.json({ ok: false, error: String(error?.message || error).slice(0, 240) }, 502);
      }
    });
    // ─── 语音收藏：只存引用，不复制音频 ───
    // 合成好的音频已经落在 clip 里（voice/clip/:clipId 能取），所以收藏只记
    // clipId + 文本 + 音色 + 来源伙伴，试听直接读原 clip，不用再占一份磁盘。
    app.get("/voice/favorites", async (c) => {
      const items = await listVoiceFavorites(sdk);
      return c.json({ ok: true, items: items.slice().reverse() });
    });
    app.post("/voice/favorites", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { body = {}; }
      try {
        return c.json({ ok: true, ...(await favoriteVoiceClip(sdk, body)) });
      } catch (error) {
        const status = error?.code === "VOICE_FAV_NOT_FOUND" ? 404 : 400;
        return c.json({ ok: false, error: String(error?.message || "收藏失败了，再试一次") }, status);
      }
    });
    // 路由对象只有 get/post/put，没有 delete（SDK 实测）；删除走 POST + body 里的 id，
    // 与旧插件的 /tts/favorites/delete 同一约定。
    app.post("/voice/favorites/delete", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { body = {}; }
      const id = String(body?.id || "");
      if (!id) return c.json({ ok: false, error: "缺收藏 id" }, 400);
      const items = await listVoiceFavorites(sdk);
      const next = items.filter((item) => item.id !== id);
      if (next.length === items.length) return c.json({ ok: false, error: "这条收藏不在了。" }, 404);
      await sdk.storage.global.set(VOICE_FAVORITES_KEY, next);
      return c.json({ ok: true, message: "已删除" });
    });

    app.get("/voice/clip/:clipId", (c) => {
      const clipId = String(c.req.param("clipId") || "");
      if (!isValidClipId(clipId)) return c.json({ ok: false, error: "音频编号不合法。" }, 400);
      const format = String(c.req.query("format") || "mp3") === "wav" ? "wav" : "mp3";
      const audio = readClip(sdk, clipId, format);
      if (!audio) return c.json({ ok: false, error: "这段音频已经不在了，重新合成一次。" }, 404);
      return c.body(audio, 200, {
        "content-type": format === "wav" ? "audio/wav" : "audio/mpeg",
        "cache-control": "private, max-age=600",
      });
    });
    app.get("/recommendation-config", async (c) => {
      const config = normalizeRecommendationConfig(await sdk.storage.global.get("recommendationConfig", {}));
      return c.json({
        ...config,
        choices: {
          display: DISPLAY_MODES,
          counts: COUNT_CHOICES,
        },
        defaultStyles: DEFAULT_STYLES.map((style) => ({ ...style })),
        limits: { maxStyles: 6, nameChars: 20, intentChars: 60 },
      });
    });
    // 反馈小窗：把大白话和截图整理成一条 issue。模型只整理，不发送。
    app.post("/feedback/chat", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "没读懂这句。" }, 400); }
      try {
        const result = await chatFeedback(sdk, { messages: body?.messages });
        return c.json({ ok: true, ...result });
      } catch (error) {
        const raw = String(error?.message || "");
        void sdk.logger.warn(`反馈小窗失败：${raw || error?.code || "unknown"}`);
        return c.json({ ok: false, error: raw || "没整理成，再说一次。" });
      }
    });
    // 宿主没给「打开外部链接」授权时，反馈里的跳转走这里：交给系统默认程序，不经能力台账。
    app.post("/open-url", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "没读到地址。" }, 400); }
      const target = String(body?.url || "").trim();
      if (!/^(https?:|mailto:)/i.test(target)) return c.json({ ok: false, error: "只支持 http、https 和 mailto。" }, 400);
      try {
        const { spawn } = await import("node:child_process");
        const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
        const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", target] : [target];
        await new Promise((resolve, reject) => {
          const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
          child.once("error", reject);
          child.once("spawn", () => { child.unref(); resolve(); });
        });
        return c.json({ ok: true });
      } catch (error) {
        return c.json({ ok: false, error: String(error?.message || error || "系统没接住这个地址。") }, 500);
      }
    });
    // 同样的道理：宿主不给写剪贴板，就让后端写（clip.exe / pbcopy / xclip）。
    app.post("/copy-text", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "没读到内容。" }, 400); }
      const text = String(body?.text || "");
      if (!text) return c.json({ ok: false, error: "内容为空。" }, 400);
      try {
        const { spawn } = await import("node:child_process");
        const command = process.platform === "win32" ? "clip.exe" : process.platform === "darwin" ? "pbcopy" : "xclip";
        const args = process.platform === "win32" || process.platform === "darwin" ? [] : ["-selection", "clipboard"];
        await new Promise((resolve, reject) => {
          const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
          child.once("error", reject);
          child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`复制返回 ${code}`))));
          child.stdin.end(text, "utf8");
        });
        return c.json({ ok: true });
      } catch (error) {
        return c.json({ ok: false, error: String(error?.message || error || "写不进剪贴板。") }, 500);
      }
    });
    app.post("/recommendation-config/refine-request", async (c) => {
      await saveConfig("styleRefineRequested", true);
      return c.json({ ok: true, hint: "下一轮对话里知意会问你，想好怎么改再回它。" });
    });
    // 设置页那个小窗：在里面说人话，聊够了才回一份可应用的清单。
    app.post("/recommendation-config/refine-chat", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "没读懂这句。" }, 400); }
      try {
        const result = await refineChat(sdk, { messages: body?.messages, force: body?.force === true });
        return c.json({ ok: true, ...result });
      } catch (error) {
        const raw = String(error?.message || "");
        // 底层接口的报错是英文原文，不能原样端到用户面前；原文只进日志。
        const readable = /[\u4e00-\u9fa5]/.test(raw) ? raw : "知意这边接口出了点岔子，等一下再试。";
        void sdk.logger.warn(`推荐方向小窗失败：${raw || error?.code || "unknown"}`);
        return c.json({ ok: false, error: readable });
      }
    });
    // 小窗里点了「就这样改」才走到这儿；写盘前再校一次，别让半截清单落地。
    app.post("/recommendation-config/refine-apply", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "没收到要改的内容。" }, 400); }
      const checked = validatePlanStyles(body?.styles);
      if (!checked.ok) return c.json({ ok: false, error: checked.error }, 400);
      const config = normalizeRecommendationConfig(await sdk.storage.global.get("recommendationConfig", {}));
      const next = reselectStyles(config, checked.styles);
      await sdk.storage.global.set("recommendationConfig", next);
      return c.json({ ok: true, ...next });
    });
    app.post("/recommendation-config/restore", async (c) => {
      const config = normalizeRecommendationConfig(await sdk.storage.global.get("recommendationConfig", {}));
      const next = restoreDefaultStyles(config);
      await sdk.storage.global.set("recommendationConfig", next);
      return c.json({ ok: true, ...next });
    });
    app.put("/recommendation-config", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "推荐设置读不出来。" }, 400); }
      const config = normalizeRecommendationConfig({
        display: body?.display,
        count: body?.count,
        inputButton: body?.inputButton,
        quickReplies: body?.quickReplies,
        styles: body?.styles,
        selectedByCount: body?.selectedByCount,
      });
      await sdk.storage.global.set("recommendationConfig", config);
      // 开关一改，输入栏那一格得立刻跟着变。
      void syncInputStatusVisibility(config.inputButton !== false);
      return c.json({ ok: true, ...config });
    });
    app.get("/content-model", async (c) => {
      try {
        const catalog = await sdk.models.list();
        const models = chatModelOptions(catalog);
        const sources = {
          recommendation: normalizeModelRef(await sdk.storage.global.get("recommendationModel", null)),
          ask: normalizeModelRef(await sdk.storage.global.get("askJudgeModel", null)),
          summary: normalizeModelRef(await sdk.storage.global.get("summaryModel", null)),
        };
        const keys = Object.values(sources).filter(Boolean);
        const distinct = new Set(keys.map((ref) => `${ref.provider}/${ref.model}`));
        return c.json({
          ok: true,
          models,
          modelRef: keys[0] || null,
          merged: distinct.size > 1,
        });
      } catch {
        return c.json({ ok: false, models: [], modelRef: null, merged: false,
          error: "读取 Hana 已配置模型失败；请在应用权限中允许知意使用模型。" });
      }
    });
    app.post("/content-model/test", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "模型测试参数读不出来。" }, 400); }
      const modelRef = body?.modelRef === null ? null : normalizeModelRef(body?.modelRef);
      if (body?.modelRef !== null && !modelRef) return c.json({ ok: false, error: "模型选项无效。" }, 400);
      try {
        const result = await testAskModelConnection(sdk, modelRef, (event) => {
          void sdk.logger.debug?.("内容模型测试流", event);
        });
        return c.json({ ok: true, ...result });
      } catch (error) {
        await sdk.logger.warn(`内容模型测试失败：${modelRef ? `${modelRef.provider}/${modelRef.model}` : "跟随当前模型"} ${error?.code ?? "no-code"} ${error?.message ?? String(error)}`);
        const message = error?.code === "MODEL_TIMEOUT"
          ? "连接超时，请检查模型服务状态。"
          : error?.code === "MODEL_NOT_FOUND"
            ? "Hana 模型目录里没有可用的文本模型。"
            : error?.code === "MODEL_EMPTY"
              ? "模型已连接，但没有返回正文；推理模型可能把输出额度用在了思考上。"
              : "连接失败，请检查模型配置和应用权限。";
        return c.json({ ok: false, error: message, code: error?.code || "MODEL_ERROR" }, 502);
      }
    });
    app.put("/content-model", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "模型设置读不出来。" }, 400); }
      const modelRef = body?.modelRef === null ? null : normalizeModelRef(body?.modelRef);
      if (body?.modelRef !== null && !modelRef) return c.json({ ok: false, error: "模型选项无效。" }, 400);
      try {
        if (modelRef) {
          const catalog = await sdk.models.list();
          const exists = chatModelOptions(catalog).some((row) => row.provider === modelRef.provider && row.model === modelRef.model);
          if (!exists) return c.json({ ok: false, error: "这条模型已不在 Hana 配置列表中，请重新选择。" }, 400);
        }
        // 推荐回复、Ask 判断、长回复速览共用一条内容模型：一次写入，三个调用点同步。
        for (const key of ["recommendationModel", "askJudgeModel", "summaryModel"]) {
          await saveConfig(key, modelRef);
        }
        return c.json({ ok: true, modelRef });
      } catch {
        return c.json({ ok: false, error: "保存模型失败；请确认知意已获模型使用权限。" }, 403);
      }
    });
    app.get("/ask-model", async (c) => {
      try {
        const catalog = await sdk.models.list();
        const models = chatModelOptions(catalog);
        const configured = normalizeModelRef(await sdk.storage.global.get("askJudgeModel", null));
        return c.json({ ok: true, models, modelRef: configured });
      } catch (error) {
        return c.json({ ok: false, models: [], modelRef: null,
          error: "读取 Hana 已配置模型失败；请在应用权限中允许知意使用模型。" });
      }
    });
    app.get("/recommendation-model", async (c) => {
      try {
        const catalog = await sdk.models.list();
        const models = chatModelOptions(catalog);
        const modelRef = normalizeModelRef(await sdk.storage.global.get("recommendationModel", null));
        return c.json({ ok: true, models, modelRef });
      } catch {
        return c.json({ ok: false, models: [], modelRef: null,
          error: "读取 Hana 已配置模型失败；请在应用权限中允许知意使用模型。" });
      }
    });
    app.post("/recommendation-model/test", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "模型测试参数读不出来。" }, 400); }
      const modelRef = body?.modelRef === null ? null : normalizeModelRef(body?.modelRef);
      if (body?.modelRef !== null && !modelRef) return c.json({ ok: false, error: "模型选项无效。" }, 400);
      try {
        const result = await testAskModelConnection(sdk, modelRef, (event) => {
          void sdk.logger.debug?.("推荐回复模型测试流", event);
        });
        return c.json({ ok: true, ...result });
      } catch (error) {
        await sdk.logger.warn(`推荐回复模型测试失败：${modelRef ? `${modelRef.provider}/${modelRef.model}` : "跟随 Ask 判断模型"} ${error?.code ?? "no-code"} ${error?.message ?? String(error)}`);
        const message = error?.code === "MODEL_TIMEOUT"
          ? "连接超时，请检查模型服务状态。"
          : error?.code === "MODEL_NOT_FOUND"
            ? "Hana 模型目录里没有可用的文本模型。"
            : error?.code === "MODEL_EMPTY"
              ? "模型已连接，但没有返回正文；推理模型可能把输出额度用在了思考上。"
              : "连接失败，请检查模型配置和应用权限。";
        return c.json({ ok: false, error: message, code: error?.code || "MODEL_ERROR" }, 502);
      }
    });
    app.put("/recommendation-model", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "模型设置读不出来。" }, 400); }
      const modelRef = body?.modelRef === null ? null : normalizeModelRef(body?.modelRef);
      if (body?.modelRef !== null && !modelRef) return c.json({ ok: false, error: "模型选项无效。" }, 400);
      try {
        if (modelRef) {
          const catalog = await sdk.models.list();
          const exists = chatModelOptions(catalog).some((row) => row.provider === modelRef.provider && row.model === modelRef.model);
          if (!exists) return c.json({ ok: false, error: "这条模型已不在 Hana 配置列表中，请重新选择。" }, 400);
        }
        await saveConfig("recommendationModel", modelRef);
        return c.json({ ok: true, modelRef });
      } catch {
        return c.json({ ok: false, error: "保存模型失败；请确认知意已获模型使用权限。" }, 403);
      }
    });
    // 备用模型：主模型连着撞不动的时候才上。单独一条 key，不跟「内容模型」三个调用点绑在一起，
    // 因为它只在推荐回复这一条路上有明确定义（速览、Ask 判断没有“再换个人问”的需求）。
    app.get("/fallback-model", async (c) => {
      try {
        const catalog = await sdk.models.list();
        return c.json({
          ok: true,
          models: chatModelOptions(catalog),
          modelRef: normalizeModelRef(await sdk.storage.global.get("recommendationFallbackModel", null)),
        });
      } catch {
        return c.json({ ok: false, models: [], modelRef: null,
          error: "读取 Hana 已配置模型失败；请在应用权限中允许知意使用模型。" });
      }
    });
    app.put("/fallback-model", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "模型设置读不出来。" }, 400); }
      const modelRef = body?.modelRef === null ? null : normalizeModelRef(body?.modelRef);
      if (body?.modelRef !== null && !modelRef) return c.json({ ok: false, error: "模型选项无效。" }, 400);
      try {
        if (modelRef) {
          const catalog = await sdk.models.list();
          const exists = chatModelOptions(catalog).some((row) => row.provider === modelRef.provider && row.model === modelRef.model);
          if (!exists) return c.json({ ok: false, error: "这条模型已不在 Hana 配置列表中，请重新选择。" }, 400);
          const primary = normalizeModelRef(await sdk.storage.global.get("recommendationModel", null));
          if (primary && primary.provider === modelRef.provider && primary.model === modelRef.model) {
            return c.json({ ok: false, error: "备用模型跟主模型是同一条，兜不住；换一条别的。" }, 400);
          }
        }
        await saveConfig("recommendationFallbackModel", modelRef);
        return c.json({ ok: true, modelRef });
      } catch {
        return c.json({ ok: false, error: "保存模型失败；请确认知意已获模型使用权限。" }, 403);
      }
    });
    app.post("/ask-model/test", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "模型测试参数读不出来。" }, 400); }
      const modelRef = body?.modelRef === null ? null : normalizeModelRef(body?.modelRef);
      if (body?.modelRef !== null && !modelRef) return c.json({ ok: false, error: "模型选项无效。" }, 400);
      try {
        const result = await testAskModelConnection(sdk, modelRef, (event) => {
          void sdk.logger.debug?.("Ask 判断模型测试流", event);
        });
        return c.json({ ok: true, ...result });
      } catch (error) {
        await sdk.logger.warn(`Ask 判断模型测试失败：${modelRef ? `${modelRef.provider}/${modelRef.model}` : "跟随当前模型"} ${error?.code ?? "no-code"} ${error?.message ?? String(error)}`);
        const message = error?.code === "MODEL_TIMEOUT"
          ? "连接超时，请检查模型服务状态。"
          : error?.code === "MODEL_NOT_FOUND"
            ? "Hana 模型目录里没有可用的文本模型。"
            : error?.code === "MODEL_EMPTY"
              ? "模型已连接，但没有返回正文；推理模型可能把输出额度用在了思考上。"
              : "连接失败，请检查模型配置和应用权限。";
        return c.json({ ok: false, error: message, code: error?.code || "MODEL_ERROR" }, 502);
      }
    });
    app.put("/ask-model", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "模型设置读不出来。" }, 400); }
      const modelRef = body?.modelRef === null ? null : normalizeModelRef(body?.modelRef);
      if (body?.modelRef !== null && !modelRef) return c.json({ ok: false, error: "模型选项无效。" }, 400);
      try {
        if (modelRef) {
          const catalog = await sdk.models.list();
          const exists = chatModelOptions(catalog).some((row) => row.provider === modelRef.provider && row.model === modelRef.model);
          if (!exists) return c.json({ ok: false, error: "这条模型已不在 Hana 配置列表中，请重新选择。" }, 400);
        }
        await saveConfig("askJudgeModel", modelRef);
        return c.json({ ok: true, modelRef });
      } catch (error) {
        return c.json({ ok: false, error: "保存模型失败；请确认知意已获模型使用权限。" }, 403);
      }
    });
    // ── 快速档：速览、会话标题这类要快不要精的小功能专用一条模型 ──
    app.get("/fast-model", async (c) => {
      try {
        const catalog = await sdk.models.list();
        const modelRef = normalizeModelRef(await sdk.storage.global.get(FAST_TASK_MODEL_KEY, null));
        return c.json({ ok: true, models: chatModelOptions(catalog), modelRef });
      } catch {
        return c.json({ ok: false, models: [], modelRef: null, error: "读取 Hana 已配置模型失败；请在应用权限中允许知意使用模型。" });
      }
    });
    app.post("/fast-model/test", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "模型测试参数读不出来。" }, 400); }
      const modelRef = body?.modelRef === null ? null : normalizeModelRef(body?.modelRef);
      if (body?.modelRef !== null && !modelRef) return c.json({ ok: false, error: "模型选项无效。" }, 400);
      const startedAt = Date.now();
      try {
        const resolved = await resolveFastModel(sdk, modelRef
          || normalizeModelRef(await sdk.storage.global.get("askJudgeModel", null)), { useStored: false });
        // 测的就是真实短任务：压缩一段真文字，看它到底能不能又快又出正文。
        const outcome = await invokeFastTextModel(sdk, resolved, {
          requestId: `zhiyi_fast_test_${Date.now().toString(36)}`,
          systemPrompt: "你只做一件事：把下面这段话压缩成两行要点。只输出要点本身。",
          messages: [{ role: "user", content: "今天修好了通知链路，超时上限从二十秒放宽到四十五秒，另外把注册表里那条失效的图标路径改成了真实存在的文件，整个过程没有换模型，也没有动发布版本号。" }],
          maxTokens: 400,
        });
        const name = modelRef ? `${modelRef.provider}/${modelRef.model}` : "跟随 Ask 判断那条";
        return c.json({
          ok: true,
          sample: outcome.text.slice(0, 120),
          modelRef,
          modelName: name,
          effort: outcome.effort,
          attempts: outcome.attempts,
          reasoningTokens: outcome.reasoningTokens,
          elapsedMs: Date.now() - startedAt,
        });
      } catch (error) {
        await sdk.logger.warn(`快速档模型测试失败：${error?.code ?? "no-code"} ${error?.message ?? String(error)}`);
        return c.json({
          ok: false,
          code: error?.code || "MODEL_ERROR",
          error: error?.code === "MODEL_EMPTY"
            ? "连上了但没有返回正文；思考可能吃光了输出额度。"
            : "快速档测试失败，请检查模型配置和应用权限。",
          reasoningTokens: error?.reasoningTokens ?? null,
        }, 502);
      }
    });
    app.put("/fast-model", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "模型设置读不出来。" }, 400); }
      const modelRef = body?.modelRef === null ? null : normalizeModelRef(body?.modelRef);
      if (body?.modelRef !== null && !modelRef) return c.json({ ok: false, error: "模型选项无效。" }, 400);
      try {
        if (modelRef) {
          const catalog = await sdk.models.list();
          const exists = chatModelOptions(catalog).some((row) => row.provider === modelRef.provider && row.model === modelRef.model);
          if (!exists) return c.json({ ok: false, error: "这条模型已不在 Hana 配置列表中，请重新选择。" }, 400);
        }
        await saveConfig(FAST_TASK_MODEL_KEY, modelRef);
        return c.json({ ok: true, modelRef });
      } catch {
        return c.json({ ok: false, error: "保存快速档模型失败；请确认知意已获模型使用权限。" }, 403);
      }
    });
    app.get("/ask-config", async (c) => c.json({
      ...normalizeAskConfig(await sdk.storage.global.get("askConfig", {})),
      registeredAtLoad: askEnabledAtLoad,
      guidancePerTurn: true,
    }));    app.put("/ask-config", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "Ask 开关读不出来。" }, 400); }
      const config = normalizeAskConfig({ enabled: body?.enabled !== false });
      await saveConfig("askConfig", config);
      await sdk.logger.info("Ask card switch saved", {
        enabled: config.enabled,
        toolsStillRegistered: askEnabledAtLoad,
      });
      return c.json({ ok: true, ...config, registeredAtLoad: askEnabledAtLoad, guidancePerTurn: true });
    });
    app.get("/polish/levels", async (c) => c.json({ ok: true, levels: POLISH_LEVEL_OPTIONS }));
    app.post("/polish", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "理顺请求读不出来。" }, 400); }
      try {
        const result = await polishText(sdk, body?.text, {
          level: body?.level,
          source: String(body?.source || ""),
          previous: String(body?.previous || ""),
          instruction: String(body?.instruction || ""),
        });
        return c.json({ ok: true, ...result });
      } catch (error) {
        await sdk.logger.warn("Polish failed", { code: error?.code || "POLISH_ERROR" });
        return c.json({ ok: false, error: error?.message || "理顺失败，原文没动。" }, 400);
      }
    });
    // 候选方向：直接问“这段还能往哪儿改”。拿不到就回空列表，不报错。
    app.post("/polish/suggest", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "请求读不出来。" }, 400); }
      try {
        const items = await suggestPolishFixes(sdk, String(body?.text || ""));
        return c.json({ ok: true, items: items || [] });
      } catch (error) {
        await sdk.logger.warn("Polish suggest failed", { code: error?.code || "POLISH_SUGGEST_ERROR" });
        return c.json({ ok: true, items: [] });
      }
    });
    app.post("/session-title", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { body = {}; }
      try {
        const result = await summarizeSessionTitle(sdk, { sessionId: body?.sessionId || "" });
        return c.json({ ok: true, ...result });
      } catch (error) {
        await sdk.logger.warn("Session title failed", { code: error?.code || "TITLE_ERROR" });
        return c.json({ ok: false, error: error?.message || "起不了标题，原话没动。" }, 400);
      }
    });
    app.post("/session-title/apply", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "请求读不出来。" }, 400); }
      try {
        const result = await applySessionTitle(sdk, { sessionId: body?.sessionId, title: body?.title });
        return c.json({ ok: true, ...result });
      } catch (error) {
        await sdk.logger.warn("Session title apply failed", { code: error?.code || "TITLE_APPLY_ERROR" });
        return c.json({ ok: false, error: error?.message || "标题没写进去。" }, 400);
      }
    });
    app.get("/session-title/undo", async (c) => {
      try {
        const result = await readTitleUndo(sdk, c.req?.query?.get?.("sessionId") || "");
        return c.json(result);
      } catch (error) {
        return c.json({ ok: false, error: error?.message || "读不出来。" }, 400);
      }
    });
    app.post("/session-title/undo", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "请求读不出来。" }, 400); }
      try {
        const result = await undoSessionTitle(sdk, { sessionId: body?.sessionId });
        await sdk.logger.info(`标题已撤回：${result.title}`);
        return c.json({ ok: true, ...result });
      } catch (error) {
        await sdk.logger.warn("Session title undo failed", { code: error?.code || "TITLE_UNDO_ERROR" });
        return c.json({ ok: false, error: error?.message || "没撤回成。" }, 400);
      }
    });
    // 面板头部的「起名」：按输入框所在的这段对话起名并写回。
    // 一定要用面板报上来的会话编号，不能走「最近活跃那段」——面板就杵在某个窗口上，
    // 该改的是她正在看的这段，拿「最近动过的那段」去改名是最烦人的一种错。
    app.post("/suggest-panel/rename", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "请求读不出来。" }, 400); }
      const sessionId = String(body?.sessionId || "").trim();
      if (!sessionId) return c.json({ ok: false, error: "不知道这是哪段对话。收起面板，重新点一次输入栏的知意按钮。" }, 400);
      try {
        const drafted = await summarizeSessionTitle(sdk, { sessionId });
        const title = String(drafted?.title || "").trim();
        // 兜底不报错，所以要自己记一笔原因，不然下次只能看见「兜底名字」四个字。
        if (drafted?.fallback) {
          await sdk.logger.warn(`面板起名退回兜底：${drafted?.error || "没拼出可用上下文"}`);
        }
        if (!title) throw new Error("这次没起出名字，再试一次。");
        const targetId = String(drafted?.session?.sessionId || sessionId);
        // 旧标题必须自己读出来交给写入方：不给的话「还原」只能退回「未命名对话」。
        const previous = await resolveResumeTarget({ sessionId: targetId }, { force: true });
        const written = await applySessionTitle(sdk, {
          sessionId: targetId,
          title,
          previousTitle: previous?.title || "",
        });
        await sdk.logger.info("面板起名完成", { sessionId: targetId, fallback: drafted?.fallback === true });
        return c.json({ ok: true, sessionId: targetId, title: written.title || title, fallback: drafted?.fallback === true });
      } catch (error) {
        await sdk.logger.warn("面板起名失败", { code: error?.code || "TITLE_ERROR" });
        return c.json({ ok: false, error: String(error?.message || "没改成，再试一次。").slice(0, 200) }, 400);
      }
    });

    app.post("/send", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "请求读不出来。" }, 400); }
      const mode = body?.mode === "steer" ? "steer" : "followUp";
      try {
        const result = await sendToConversation(sdk, { text: body?.text, mode, sessionId: body?.sessionId || "" });
        await sdk.logger.info("Message sent", { mode: result.mode, sessionId: result.sessionId });
        return c.json({ ok: true, ...result });
      } catch (error) {
        await sdk.logger.warn("Send failed", { code: error?.code || "SEND_ERROR", mode });
        const message = error instanceof Error && error.name === "SendError" ? error.message : friendlySendError(error);
        return c.json({ ok: false, error: message }, 400);
      }
    });

    // 面板里的「收起」：宿主那个关闭入口在 iframe 外面（背景还是透明的），
    // 我们自己再给一个清楚的按钮，把这块面板撤掉。
    app.post("/suggest-panel/dismiss", async (c) => {
      try {
        const raw = await sdk.storage.global.get(SUGGEST_PANEL_STATE_KEY, {});
        const state = readPanelState(raw);
        if (state.sessionId) {
          await sdk.userInteraction.dismiss({ sessionId: state.sessionId, id: SUGGEST_PANEL_ID });
        }
        await sdk.storage.global.set(SUGGEST_PANEL_STATE_KEY, buildPanelState({ sessionId: state.sessionId }));
        return c.json({ ok: true });
      } catch (error) {
        await sdk.logger.warn("面板收起失败", { code: error?.code || "PANEL_DISMISS_ERROR" });
        return c.json({ ok: false, error: "没收起，再点一次。" }, 400);
      }
    });

    // 面板被宿主收起/关掉时前端会报一声。现在 App 不再自己记开关状态，
    // 这个入口只留着不报错：旧版面板页面（浏览器缓存里的）还会往这里发，
    // 接住就行，不做事。
    app.post("/suggest-panel/hidden", async (c) => {
      return c.json({ ok: true });
    });

    // 面板页读候选：输入框上那块板子自己来问，不等谁推给它。
    app.get("/suggest-panel/state", async (c) => {
      try {
        const raw = await sdk.storage.global.get(SUGGEST_PANEL_STATE_KEY, {});
        const state = readPanelState(raw);
        // 常用回复实时读配置：她在设置里改了，面板里立刻就是新的。
        const recConfig = normalizeRecommendationConfig(await sdk.storage.global.get("recommendationConfig", {}));
        return c.json({
          ok: state.ok,
          suggestions: state.suggestions,
          quickReplies: recConfig.quickReplies,
          createdAt: state.createdAt,
        });
      } catch (error) {
        await sdk.logger.warn("面板候选读取失败", { code: error?.code || "PANEL_STATE_ERROR" });
        return c.json({ ok: false, suggestions: [], quickReplies: [], error: "没读到内容。" }, 500);
      }
    });

    // 面板里的「排队发送」：跟球上那个弹窗共用同一份话单，两边看到的是同一个状态。
    // 面板是 App 自己的页面，能自己带输入框，所以不受「宿主不告诉 App 输入框草稿」的限制。
    app.get("/queue-plan/state", async (c) => {
      const sessionId = String(c.req?.query?.("sessionId") || "").trim();
      let plan = sessionId ? queuePlans.get(sessionId) : null;
      // 面板可能挂在另一段对话上：只有一份在跑时按它显示，跟球那边同一套认法。
      if (!plan) {
        const running = queuePlans.list().filter((item) => item.status === "running");
        if (running.length === 1) plan = running[0];
      }
      return c.json({
        ok: true,
        active: Boolean(plan && plan.status === "running"),
        status: plan?.status || "",
        text: plan ? describeQueuePlan(plan) : "",
        done: Number(plan?.done || 0),
        total: Number(plan?.total || 0),
        sessionId: plan?.sessionId || "",
      });
    });
    app.post("/queue-plan/start", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "参数读不出来。" }, 400); }
      const sessionId = String(body?.sessionId || "").trim();
      if (!sessionId) return c.json({ ok: false, error: "没认出这是哪段对话。" }, 400);
      try {
        const result = await startQueuePlan({
          sessionId,
          text: String(body?.text || ""),
          rounds: body?.rounds,
        });
        if (result?.ok === false) return c.json({ ok: false, error: String(result.error || "没排上。") }, 400);
        return c.json({
          ok: true,
          message: String(result?.message || ""),
          total: Number(result?.total || 0),
          done: Number(result?.done || 0),
        });
      } catch (error) {
        await sdk.logger.warn("面板排队话单失败", { code: error?.code || "QUEUE_ERROR" });
        return c.json({ ok: false, error: String(error?.message || "没排上，再试一次。").slice(0, 200) }, 500);
      }
    });
    app.post("/queue-plan/stop", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "参数读不出来。" }, 400); }
      // 按面板给的会话找；找不到就停当前唯一在跑的那份（跟球上同一个意思：
      // 用户按「停」是「别再往下发了」，不一定精确指认了哪一段）。
      let targetId = String(body?.sessionId || "").trim();
      if (!queuePlans.get(targetId)) {
        const running = queuePlans.list().filter((item) => item.status === "running");
        if (running.length === 1) targetId = running[0].sessionId;
      }
      const stopped = queuePlans.stop(targetId, "用户按了停");
      if (stopped.ok) await sdk.logger.info("排队话单已被面板停止");
      await pushQueueState(null, { message: stopped.ok ? "停了，不再往下发了" : "本来就没在排" });
      return c.json({ ok: true, stopped: stopped.ok === true });
    });

    // 面板里直接改常用回复：增、删、改都落到同一份设置里（设置页那边刷新也看得到）。
    app.post("/suggest-panel/quick-replies", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "请求读不出来。" }, 400); }
      try {
        const raw = await sdk.storage.global.get("recommendationConfig", {});
        const config = normalizeRecommendationConfig(raw);
        const list = normalizeQuickReplies(Array.isArray(body?.list) ? body.list : []);
        await sdk.storage.global.set("recommendationConfig", { ...config, quickReplies: list });
        await sdk.logger.info("常用回复已更新", { count: list.length });
        return c.json({ ok: true, quickReplies: list });
      } catch (error) {
        await sdk.logger.warn("常用回复保存失败", { code: error?.code || "QUICK_REPLY_SAVE_ERROR" });
        return c.json({ ok: false, error: "没存上，再试一次。" }, 400);
      }
    });

    // 面板里点「生成推荐回复」：这时才调模型（这一下才花钱），生成完把面板调高。
    app.post("/suggest-panel/generate", async (c) => {
      try {
        const raw = await sdk.storage.global.get(SUGGEST_PANEL_STATE_KEY, {});
        const state = readPanelState(raw);
        const sessionId = state.sessionId;
        if (!sessionId) {
          return c.json({ ok: false, error: "不知道这是哪段对话。关掉面板，重新点一次输入栏的知意按钮。" }, 400);
        }
        const recConfig = normalizeRecommendationConfig(await sdk.storage.global.get("recommendationConfig", {}));
        const result = await generateRecommendations(sdk, { sessionId });
        const suggestions = normalizeSuggestionTexts(result.suggestions);
        if (!suggestions.length) {
          return c.json({ ok: false, error: "这轮没拟出合适的句子，再点一次试试。" }, 400);
        }
        // 方向按设置页里选中的那组顺序标（不采信模型自己写的 direction）。
        const chosenDirections = (recConfig.selectedByCount?.[String(recConfig.count)] || [])
          .map((index) => recConfig.styles?.[index]?.name || "")
          .filter(Boolean);
        const labeled = suggestions.map((item, index) => ({
          text: item.text,
          direction: chosenDirections[index] || item.direction || "",
        }));
        await sdk.storage.global.set(SUGGEST_PANEL_STATE_KEY, {
          ...state,
          suggestions: labeled,
          quickReplies: recConfig.quickReplies,
          createdAt: Date.now(),
        });
        // 内容多了，面板得跟着长高（updatePanel 不用重挂，不会闪）。
        if (state.panelId) {
          try {
            await sdk.userInteraction.updatePanel({
              sessionId,
              panelId: state.panelId,
              presentation: buildPanelPresentation({
                height: estimatePanelHeight({ quickCount: recConfig.quickReplies.length, suggestionCount: labeled.length }),
              }),
            });
          } catch (error) {
            await sdk.logger.warn("面板高度没调上去", { code: error?.code || "PANEL_PRESENTATION_ERROR" });
          }
        }
        await sdk.logger.info("面板推荐已生成", { count: labeled.length, sessionId, fallback: result.model?.usedFallback === true });
        // 走了备用就要说出来：面板上要写一句，这不算小事，不能默默换掉。
        return c.json({ ok: true, suggestions: labeled, model: result.model || null });
      } catch (error) {
        const message = String(error?.message || "这次没拟出来，再点一次试试。");
        // 只记 code 等于把线索丢了：今天这一整轮排障，最后还是从 usage-ledger 里把
        // provider 原话挖出来的。日志里带一句原文，下次一眼就能看出是哪类失败。
        await sdk.logger.warn("面板推荐生成失败", {
          code: error?.code || "PANEL_GENERATE_ERROR",
          message: message.slice(0, 300),
          raw: String(error?.rawMessage || "").slice(0, 300),
        });
        return c.json({ ok: false, error: message.slice(0, 200) }, 400);
      }
    });

    // 面板页点「发这句」：以她的口吻把那句发进这段对话。
    // 面板里的句子可以改过，所以优先用面板传来的文字，没传才按序号取原始推荐语。
    app.post("/suggest-panel/send", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "请求读不出来。" }, 400); }
      const index = Number(body?.index);
      try {
        const raw = await sdk.storage.global.get(SUGGEST_PANEL_STATE_KEY, {});
        const state = readPanelState(raw);
        const edited = pickEditableText(body?.text);
        const picked = Number.isInteger(index) ? state.suggestions[index] : null;
        const text = edited || (picked && typeof picked === "string" ? picked : picked?.text) || "";
        if (!text) {
          return c.json({ ok: false, error: state.ok ? "这句话现在是空的。" : "这几句已经不在了，再点一次输入栏的知意按钮。" }, 400);
        }
        const result = await sendToConversation(sdk, { text, mode: "followUp", sessionId: state.sessionId });
        await sdk.logger.info("面板推荐已发送", { mode: result.mode, sessionId: result.sessionId });
        return c.json({ ok: true, text: result.text });
      } catch (error) {
        const message = error instanceof Error && error.name === "SendError" ? error.message : friendlySendError(error);
        await sdk.logger.warn("面板推荐发送失败", { code: error?.code || "PANEL_SEND_ERROR" });
        return c.json({ ok: false, error: message }, 400);
      }
    });
  });

  // 输入栏那个按钮的显隐：宿主里 inputStatus 是静态声明 + 按会话动态覆盖，
  // 所以「关掉」得挨个会话盖 visible=false；新开的会话没有覆盖、默认是显示的，
  // 所以还得分会话创建事件补一次。这个坑不补，开关就会对新窗口失效。
  async function currentInputButtonEnabled() {
    try {
      const raw = await sdk.storage.global.get("recommendationConfig", {});
      return normalizeRecommendationConfig(raw).inputButton !== false;
    } catch {
      return true;
    }
  }

  // 失败计数：宿主还没把本 App 的 inputStatus 声明投影进贡献表时，
  // 写一条就报一个错。一条失败不能把整趟循环拖死，也不能把整个 App 装载带崩。
  // （这一点以前只当成注释写了，实际上第一条报错就会被上层当成装载失败，
  // 日志里是「plugin "jiegehua-zhiyi" failed to load」。2026-10-28 实机撞上）
  let hideSyncFailures = 0;

  async function syncInputStatusVisibility(enabled) {
    let rows = [];
    try {
      const result = await sdk.bus.request("session:list", { scope: "all" }, { timeoutMs: 8000 });
      const list = Array.isArray(result) ? result : result?.sessions;
      rows = (Array.isArray(list) ? list : [])
        .map((row) => ({ sessionId: String(row?.sessionId || "").trim(), modified: Number(row?.modified ?? 0) || 0 }))
        .filter((row) => row.sessionId)
        .sort((a, b) => b.modified - a.modified)
        .slice(0, 30);
    } catch (error) {
      await sdk.logger.warn("列会话失败，输入栏按钮显隐没同步", { code: error?.code || "SESSION_LIST_ERROR" });
      return;
    }
    for (const row of rows) {
      try {
        await sdk.inputStatus.set({ sessionId: row.sessionId, id: SUGGEST_INPUT_STATUS_ID, visible: enabled });
      } catch (error) {
        hideSyncFailures += 1;
        await sdk.logger.warn("输入栏按钮显隐同步失败", { code: error?.code || "INPUT_STATUS_ERROR" });
        // 「has no declared input status item」说明声明还没投影进宿主的贡献表。
        // 这种错每个会话都会报一次，继续往下写只是刷日志——当场停。
        if (/no declared input status/i.test(String(error?.message || ""))) return;
        continue;
      }
    }
  }

  // 输入栏里那个 sync 按钮：点一下就把面板挂出来。
  // 面板里有常用回复（点一下就发）和一个「生成推荐回复」按钮——生成这一步由她点，
  // 才轮到调模型，也才轮到花钱；点按钮本身不花钱。
  // 走 ui-actions 通道，不进模型车道：模型看不见这个工具，只有人点得到。
  await sdk.tools.register({
    name: "jiegehua.zhiyi_suggest",
    description: "在输入栏的「知意」按钮上被点开时：在输入框上方摆出知意面板（已经摆着就原地刷新），里面有常用回复和「生成推荐回复」按钮。",
    sessionPermission: { readOnly: true },
    parameters: { type: "object", additionalProperties: false, properties: {} },
    execute: async (args) => {
      const context = args?.context || {};
      const sessionPath = String(context.sessionPath || "").trim();
      if (!sessionPath) {
        return { isError: true, content: [{ type: "text", text: "没认出这是哪段对话。" }] };
      }
      try {
        // 宿主在 ui-actions 通道里已经给过校验过的 sessionId，优先用它。
        // 以前这里只按路径去 session:list 反查，而宿主给 App 的 session:list 只开
        // home/app 两个命名空间，Code 页的会话不在里头——于是 Code 会话里点这个按钮
        // 永远回「没认出这是哪段对话」。反查只留作聊天会话那条路的兜底。
        const hostSessionId = String(context.sessionId || "").trim();
        const sessionId = hostSessionId || await resolveSessionIdByPath(sdk, sessionPath);
        if (!sessionId) {
          return { isError: true, content: [{ type: "text", text: "没认出这是哪段对话。" }] };
        }

        // 先读常用回复（只为了报高度）：读不到也不能链式拖垮整次点击。
        // 之前这整条是一个串行链：storage.get → storage.set → show → storage.get
        // → storage.set → logger，六次串行 RPC。宿主 RPC 有并发上限（128），
        // 实测日志里一天拒了 3046 次（APP_RPC_BUSY）。
        // 那条链上**任何一环**被拒，整次点击就变成一个报错——表现就是点了没反应。
        // 但人点这个按钮只想要一件事：面板出来。其余全是记账。
        let quickCount = 0;
        try {
          const recConfig = normalizeRecommendationConfig(await sdk.storage.global.get("recommendationConfig", {}));
          quickCount = recConfig.quickReplies.length;
        } catch {
          // 读不到就按 0 条估高度：面板矮一点、里面自己会滚动，总比不开好。
        }

        // 面板要用的状态先落到存储（面板 iframe 要读）；写入失败就算了，
        // 面板仍然照开，里面读不到状态只是这一轮没有推荐句。
        try {
          await sdk.storage.global.set(SUGGEST_PANEL_STATE_KEY, buildPanelState({
            sessionId,
            suggestions: [],
          }));
        } catch {}

        // 核心动作：摆面板。它失败才算真失败，才值得报错给用户。
        // 宿主 show 是按 (session, app, id) 原地 upsert 的幂等操作，
        // 所以不再自己记「现在开着还是关着」——那张内存表跟宿主真实状态
        // 一旦分歧，点一下只会跑一个空 dismiss，人就看到「点了没反应」。
        const shown = await sdk.userInteraction.show({
          sessionId,
          id: SUGGEST_PANEL_ID,
          title: "知意",
          message: "常用回复点一下就发；要现成的点「生成推荐回复」",
          contentFrame: { route: SUGGEST_PANEL_ROUTE },
          // 必须显式写 expanded: true。宿主 show 是「参数完全一致就直接返回」，
          // 而人有可能在宿主那边把它折叠起来（折起来还占着位置、内容看不见）。
          // 这时候如果传的还是默认展开，参数一模一样，宿主直接返回、什么都不动，
          // 于是看着就是「点了没反应」。传 true 就一定能把它重新摊开。
          presentation: buildPanelPresentation({
            height: estimatePanelHeight({ quickCount }),
            expanded: true,
          }),
        });

        // 以下全是记账，一律失败不响：面板已经出来了，不能因为记不上一个 panelId
        // 就回一句报错。panelId 只用于生成后调高度，丢了最多是那一轮高度不变。
        try {
          const state = readPanelState(await sdk.storage.global.get(SUGGEST_PANEL_STATE_KEY, {}));
          await sdk.storage.global.set(SUGGEST_PANEL_STATE_KEY, { ...state, panelId: shown?.panelId || "" });
        } catch {}
        try {
          await sdk.logger.info("输入栏面板已挂上", { sessionPath, quick: quickCount });
        } catch {}
        return { content: [{ type: "text", text: "面板打开了：常用回复点一下就发，要现成的点里面的「生成推荐回复」。" }] };
      } catch (error) {
        const message = String(error?.message || "面板没挂上，再点一次试试。");
        // 宿主 RPC 满仓时给一句人话，别把 APP_RPC_BUSY 这种英文甩到界面上。
        const busy = error?.code === "APP_RPC_BUSY" || /concurrency limit/i.test(message);
        try {
          await sdk.logger.warn(`输入栏面板失败：${message.slice(0, 160)}`, { code: error?.code || "" });
        } catch {}
        return {
          isError: true,
          content: [{ type: "text", text: busy ? "这会儿忙不过来，等一秒再点一下。" : message.slice(0, 200) }],
        };
      }
    },
  });

  // 启动时对一遍输入栏按钮的显隐：上次关着的会话得盖回去。
  //
  // 这段很容易把整个 App 装载搞崩（2026-10-28 实机撞上两次）：
  // 宿主的 inputStatus.set 会查贡献表快照里有没有本 App 的声明：
  //   `uiContributions.snapshot().find(pluginId===app)?.contributions.inputStatus?.find(id===...)`
  // 而 App 刚 reload 那阵子，旧声明可能已经撤了、新声明还没投影进来，
  // 这个查找就是空 → 抛「has no declared input status item」。
  // 更麻烦的是：这个异常会从 apply 的异步任务里冒出去，宿主就判定
  // 「plugin failed to load」，把整份 App 下掉（工具全部消失）。
  //
  // 所以三道防：
  //   ① 不写成顶层 await，也不让异常漏出去（自己吞掉并记一笔）；
  //   ② 一条写失败就当场停掉整趟（说明声明还没就位，继续写只会继续报）；
  //   ③ 隔一会儿再试一次，那时声明一般已经投影完了。
  // 失败本身不影响功能：按钮默认就是显示的，这个同步只在「用户把按钮关了」时才有意义。
  const scheduleInputStatusSync = () => {
    const runOnce = async (attempt) => {
      try {
        const enabled = await currentInputButtonEnabled();
        await syncInputStatusVisibility(enabled);
      } catch {
        // 自己吞：绝不让它冒到 apply 的 Promise 上。
      }
      // 声明还没就位就隔久一点再试一趟，试两次还不够就算了，下一轮启动会再来。
      if (hideSyncFailures > 0 && attempt < 1) {
        const retry = setTimeout(() => { void runOnce(attempt + 1); }, 15_000);
        retry.unref?.();
        return;
      }
      if (hideSyncFailures > 0) {
        try {
          await sdk.logger.info(`输入栏按钮显隐这次没对成（声明还没就位），下次启动再说`, { failures: hideSyncFailures });
        } catch {}
      }
    };
    const timer = setTimeout(() => { void runOnce(0); }, 4000);
    timer.unref?.();
  };
  scheduleInputStatusSync();

  // 开发期探针：只采样、只记录，不发关机命令，也不改任何设置。
  // 真正的守门人在下面那个工具里，这个只是开发时肉眼对时间线用的壳。
  await sdk.tools.register({
    name: "jiegehua_zhiyi_idle_probe",
    description: "（开发期只读探针）采样 Hana 所有活跃会话与后台任务的忙闲状态，只记录不动作，不发关机命令。",
    sessionPermission: { readOnly: true },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["snapshot", "watch", "report", "stop", "list"],
          description: "snapshot 采一次就回；watch 连续采样；report 取记录；stop 停掉；list 看有哪些在跑。",
        },
        durationMs: { type: "number", description: "watch 持续多久，默认 10 分钟。" },
        intervalMs: { type: "number", description: "watch 采样间隔，默认 5 秒。" },
        recentMs: { type: "number", description: "只细查最近多久内有动静的会话，默认 10 分钟；更早的直接跳过。" },
        maxProbe: { type: "number", description: "单次最多细查多少个会话，默认 40。" },
        watchId: { type: "string", description: "watch 的编号，默认 default；同一个编号再 watch 会覆盖旧的。" },
        offset: { type: "number", description: "report 从第几条开始取，默认 0。" },
        limit: { type: "number", description: "report 一次取多少条，默认 200，最多 400。" },
        label: { type: "string", description: "给这次采样起个名字，方便事后对时间线。" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = String(args?.action || "snapshot");
      try {
        if (action === "watch") {
          const started = startIdleWatch(sdk, {
            durationMs: args?.durationMs,
            intervalMs: args?.intervalMs,
            recentMs: args?.recentMs,
            maxProbe: args?.maxProbe,
            watchId: args?.watchId,
            label: args?.label,
          });
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ ok: true, action, ...started }, null, 2),
            }],
          };
        }
        if (action === "report") {
          const report = reportIdleWatch(args?.watchId, { offset: args?.offset, limit: args?.limit });
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, action, ...report }) }] };
        }
        if (action === "stop") {
          const stopped = stopIdleWatch(args?.watchId);
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, action, ...stopped }, null, 2) }] };
        }
        if (action === "list") {
          return { content: [{ type: "text", text: JSON.stringify({ ok: true, action, watches: listIdleWatches() }, null, 2) }] };
        }
        const snapshot = await sampleIdleSnapshot(sdk, {
          recentMs: args?.recentMs,
          maxProbe: args?.maxProbe,
        });
        const summary = summarizeSnapshot(snapshot);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: true, action: "snapshot", summary, errors: snapshot.errors.slice(0, 8) }, null, 2),
          }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `探针没跑成：${String(error?.message || error).slice(0, 200)}` }],
        };
      }
    },
  });

  // 「活干完了帮我关」的入口。
  // 挂上就是真关机（演练已于 2026-10-21 退役）；仍有可撤销的倒计时窗口。
  // 描述必须跟代码一致：以前这里写「默认只演练」「先调 enable-real」，
  // 而那套开关早就退役了，会让人误以为还有一道拦截。
  await sdk.tools.register({
    name: "jiegehua_zhiyi_sleep_guard",
    description: "守门人：聊天页和 Code 页的所有对话、以及所有后台任务都停下来一段时间后，才执行关机。用户说「干完帮我关」「我睡了以后自己关」时用。挂上就是真关机（没有演练模式）；动手前有一段时间可撤销的倒计时，期间一有动静就自动收手。只有用户明确说要真关机才调 arm。",
    sessionPermission: { readOnly: true },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["arm", "rehearse", "status", "cancel", "enable-real", "disable-real", "selftest", "probe-shutdown", "test-shutdown"],
          description: "arm 挂上守门（真关机）；rehearse 演练：整个流程真跑但不执行关机命令，拿不准时先用这个；status 看现在守着没、空了多久、历史上的记录，以及是哪一层在拦（会话层/任务层/事件层）；cancel 撤掉；enable-real / disable-real 已废弃（演练退役后总开关不再拦任何东西）；selftest 验起进程的能力；probe-shutdown 在 App 进程里试一下 shutdown.exe 能不能跑（跑 /a，无副作用）；test-shutdown 真发一次关机但留 120 秒撤销窗口（仅供验证，不要当正规路径）。",
        },
        idleMinutes: { type: "number", description: "要连续空多久才算真的干完，默认 10 分钟。" },
        maxWaitMinutes: { type: "number", description: "最多守多久，超过就放弃并提醒，默认 240 分钟。" },
        graceMinutes: { type: "number", description: "真关机前的可撤销窗，默认 5 分钟；这期间一有动静就自动取消。" },
        real: { type: "boolean", description: "已废弃：现在挂上就是真关机，这个参数不再起作用。" },
        note: { type: "string", description: "为什么守着，写一句，方便事后看记录。" },
        reason: { type: "string", description: "cancel 时说明原因。" },
        timelineLimit: { type: "number", description: "status 时带多少条复盘时间线，默认 60。" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = String(args?.action || "status");
      try {
        if (action === "enable-real" || action === "disable-real") {
          return {
            content: [{ type: "text", text: "真关机开关已经退役：现在挂上就是真关机，不用再开开关。" }],
          };
        }
        if (action === "selftest") {
          try {
            const { spawn } = await import("node:child_process");
            const child = spawn("cmd.exe", ["/c", "exit", "0"], { stdio: "ignore", windowsHide: true });
            const outcome = await new Promise((resolve) => {
              child.on("exit", (code) => resolve(`退出码 ${code}`));
              child.on("error", (error) => resolve(`起不来：${String(error?.message || error).slice(0, 120)}`));
              const timer = setTimeout(() => resolve("超时没回话"), 5_000);
              timer.unref?.();
            });
            return {
              content: [{ type: "text", text: `起进程能力自检：${outcome}` }],
              details: { sleepGuard: { selftest: outcome } },
            };
          } catch (error) {
            return { isError: true, content: [{ type: "text", text: `自检没跑成：${String(error?.message || error).slice(0, 160)}` }] };
          }
        }
        if (action === "probe-shutdown") {
          try {
            const { spawn } = await import("node:child_process");
            const absolute = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "shutdown.exe");
            const runOnce = (exe, args, options) => new Promise((resolve) => {
              const child = spawn(exe, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...options });
              let stdout = "";
              let stderr = "";
              child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
              child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
              child.on("error", (error) => resolve(`起不来：${String(error?.message || error).slice(0, 140)}`));
              child.on("exit", (code) => resolve(`退码 ${code}｜out=${stdout.trim().slice(0, 80)}｜err=${stderr.trim().slice(0, 120)}`));
              const timer = setTimeout(() => resolve("超时没回话"), 6_000);
              timer.unref?.();
            });
            const attempts = [
              { label: "裸名 shutdown.exe", outcome: await runOnce("shutdown.exe", ["/a"], {}) },
              { label: "绝对路径", outcome: await runOnce(absolute, ["/a"], {}) },
              { label: "绝对路径 + 继承环境变量", outcome: await runOnce(absolute, ["/a"], { env: process.env }) },
              { label: "经 cmd 转一道", outcome: await runOnce("cmd.exe", ["/c", "shutdown.exe /a"], {}) },
              { label: "补 SESSIONNAME=Console", outcome: await runOnce(absolute, ["/a"], { env: { ...process.env, SESSIONNAME: "Console" } }) },
              {
                label: "补全常见变量",
                outcome: await runOnce(absolute, ["/a"], {
                  env: {
                    ...process.env,
                    SESSIONNAME: "Console",
                    COMPUTERNAME: process.env.COMPUTERNAME || "",
                    SystemDrive: process.env.SystemDrive || "C:",
                    SystemRoot: process.env.SystemRoot || "C:\\WINDOWS",
                    windir: process.env.windir || "C:\\WINDOWS",
                    USERPROFILE: process.env.USERPROFILE || process.env.PUBLIC || "",
                    TEMP: process.env.TEMP || process.env.TMP || "",
                  },
                }),
              },
              { label: "子进程看到的 SESSIONNAME", outcome: await runOnce("cmd.exe", ["/c", "echo [%SESSIONNAME%][%COMPUTERNAME%]"], {}) },
              { label: "PowerShell 能不能跑", outcome: await runOnce("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Stop-Computer -WhatIf"], {}) },
            ];
            const envSummary = ["SESSIONNAME", "USERNAME", "USERDOMAIN", "SystemRoot", "windir"]
              .map((key) => `${key}=${process.env[key] ?? "（空）"}`)
              .concat(`PATH=${process.env.PATH ? "有" : "（空）"}`)
              .join("；");
            const text = attempts.map((item) => `${item.label}：${item.outcome}`).join("\n");
            return {
              content: [{ type: "text", text: `关机命令探针（全跑 /a，无副作用）：\n${text}\n\nApp 进程环境：${envSummary}` }],
              details: { sleepGuard: { probeShutdown: attempts, envSummary } },
            };
          } catch (error) {
            return { isError: true, content: [{ type: "text", text: `探针没跑成：${String(error?.message || error).slice(0, 160)}` }] };
          }
        }
        if (action === "test-shutdown") {
          // 真发一次关机请求，但留 120 秒撤销窗口；只给验证用，不能当正式路径。
          try {
            const { spawn } = await import("node:child_process");
            const outcome = await new Promise((resolve) => {
              const child = spawn("shutdown.exe", ["/s", "/t", "120"], { env: buildShutdownEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
              let stderr = "";
              child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
              child.on("error", (error) => resolve(`起不来：${String(error?.message || error).slice(0, 140)}`));
              child.on("exit", (code) => resolve(`退码 ${code}｜err=${stderr.trim().slice(0, 120)}`));
              const timer = setTimeout(() => resolve("超时没回话"), 6_000);
              timer.unref?.();
            });
            return {
              content: [{ type: "text", text: `已尝试发起关机（120 秒后生效）：${outcome}` }],
              details: { sleepGuard: { testShutdown: outcome } },
            };
          } catch (error) {
            return { isError: true, content: [{ type: "text", text: `测试没跑成：${String(error?.message || error).slice(0, 160)}` }] };
          }
        }
        if (action === "arm" || action === "rehearse") {
          // rehearse = 演练：整套流程真跑，只有最后一步（发 shutdown.exe）不跑。
          // 为什么留这条路：分享版里真关机是个高后果动作（会中断正在写的文件），
          // 拿不准的时候应该能先把流程跑一遍看清楚。
          // 演练不是「模拟数据」：采样、判定、倒计时、撤销、通知、记录全是真的，
          // 唯一区别就是 executeShutdown 里那一支 dryRun 分支——它只记一笔。
          const rehearse = action === "rehearse";
          const result = await armSleepGuard(sdk, {
            idleMs: Number(args?.idleMinutes) > 0 ? Number(args.idleMinutes) * 60_000 : undefined,
            maxWaitMs: Number(args?.maxWaitMinutes) > 0 ? Number(args.maxWaitMinutes) * 60_000 : undefined,
            graceMs: Number(args?.graceMinutes) > 0 ? Number(args.graceMinutes) * 60_000 : undefined,
            note: args?.note,
            armedBy: "model",
            // 显式传 true 才演练，跟 lib 层那个约定一致。
            dryRun: rehearse ? true : false,
          });
          const state = result.state || {};
          const minutes = Math.round((state.idleMs || 0) / 6000) / 10;
          const graceMinutes = Math.round((state.graceMs || 0) / 60_000);
          if (rehearse) {
            return {
              content: [{
                type: "text",
                text: [
                  "演练挂上了：整套流程会真跑，但最后一步不执行关机命令。",
                  `空满 ${minutes} 分钟后进 ${graceMinutes} 分钟倒计时；倒计时走完只记一笔「本来这时候会关」，不会关机器。`,
                  "采样、判定、撤销、通知都是真的，所以这一次就是真实流程的完整彩排。",
                ].join("\n"),
              }],
              details: { sleepGuard: result },
            };
          }
          return {
            content: [{
              type: "text",
              text: [
                `静候已挂上：所有窗口和后台任务都停下来之后满 ${minutes} 分钟，才算真的结束。`,
                `最多守 ${Math.round((state.maxWaitMs || 0) / 6000) / 10} 分钟，超过就放弃并提醒。`,
                `到点会先进 ${graceMinutes} 分钟可撤销倒计时，期间一有动静就当场取消，然后真的关机。`,
              ].join("\n"),
            }],
            details: { sleepGuard: result },
          };
        }
        if (action === "bannerReset") {
          // 急救：把现在知道的会话上的关机横幅全摘掉。
          // 场景：以前已挂名单只在内存，重载就丢，而宿主的横幅不会跟着消失，
          // 于是会出现「关机早取消了、某个窗口里还挂着」的孤儿横幅。
          const candidates = await pickRecentSessionPaths();
          const extra = [...shutdownBannerTexts.keys()];
          const all = [...new Set([...candidates, ...extra])];
          let dismissed = 0;
          for (const path of all) {
            const value = String(path || "");
            if (!value) continue;
            await dismissShutdownBanner(value);
            dismissed += 1;
          }
          return {
            content: [{ type: "text", text: `已把 ${dismissed} 段会话上的关机横幅摘掉。` }],
            details: { dismissed, paths: all },
          };
        }
        if (action === "cancel") {
          const result = await cancelSleepGuard(sdk, args?.reason || "手动取消");
          // 已经发出过关机命令的话，光说「撤了」是谎：得把 /a 的结果如实报。
          let text;
          if (result.wasIssued) {
            text = result.abort?.ok
              ? "关机命令已经发出去了，不过我发了撤销，机器不会关了。"
              : `关机命令已经发出去了，撤销没成功（${result.abort?.detail || "原因不明"}），机器还会关。`;
          } else {
            text = result.cancelled ? "守门已经撤掉了，不会再触发。" : "现在没有在守门，不用撤。";
          }
          return { content: [{ type: "text", text }], details: { sleepGuard: result } };
        }
        const status = await readSleepGuard(sdk, { withLog: true });
        const timeline = await readSleepTimeline(sdk, Number(args?.timelineLimit) > 0 ? Number(args.timelineLimit) : 60);
        // 这里得自己读一次：`realEnabled` 以前是个没声明的变量，
        // 一走到 details 就抛 ReferenceError，整个 status 分支直接崩。
        // 而工具层把任何异常都包成「守门没弄成：…」，所以看起来像是「守门挂了」，
        // 实际上只是这一个查询字段没定义。（2026-10-28 演练时撞出来的）
        const realEnabled = await isRealEnabled(sdk).catch(() => null);
        const state = status.state || {};
        const labels = {
          idle: "没在守",
          watching: "正在守",
          countdown: "活已完，正在倒计时",
          "preview-done": "演练走完了整个流程（没真关）",
          "shutdown-issued": "已经发出关机命令",
          fired: "已经触发过（演练）",
          expired: "等太久放弃了",
          cancelled: "已撤掉",
        };
        const line = state.status
          ? `当前：${labels[state.status] || state.status}`
          : "当前：没在守";
        const idleLine = state.status === "countdown"
          ? `还剩 ${Math.round((status.countdownLeftMs || 0) / 1000)} 秒${dryRun ? "结束演练" : "关机"}，这期间一有动静就取消。`
          : state.status === "shutdown-issued"
            // 这一段是最要紧的警告：命令已经出去了，但还有几秒能拉回来。
            ? (status.abortLeftMs > 0
              ? `关机命令已经发出，还有约 ${Math.round(status.abortLeftMs / 1000)} 秒可撤。要取消就现在点。`
              : "关机命令已经发出，可撤销窗口已过，现在拦不住了。")
            : status.armed && status.busyCount !== null && status.busyCount > 0
              // 有活在跑就没在计时。以前这里写「已经空了 0 秒」，
              // 跟时间线上那句「忙 N 处」正面矛盾，看着像坏了。
              ? `还有 ${status.busyCount} 处在跑，所以还没开始算空。`
              : status.armed
                ? `已经空了 ${Math.round(status.idleForMs / 1000)} 秒，需要满 ${Math.round((state.idleMs || 0) / 1000)} 秒。`
                : "";
        // 这一行必须按实际情况报。以前是写死的「现在是真关机」，
        // 演练挂上也会这么写——那就把「演练」说成了「真关机」，
        // 正是最不能错的那种谎。演练时人看到这句话会不敢测，也分不清到底会不会关。
        const dryRun = state.dryRun === true;
        const switchLine = !status.armed
          ? "没在守门，不会做任何事。"
          : dryRun
            ? "演练中：流程全真，最后一步不执行关机命令。"
            : "现在是真关机：判定成立后会真的关机器。";
        const timeText = (iso) => {
          const d = new Date(iso);
          return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
        };
        const timelineLines = timeline.slice(-40).map((entry) => {
          const who = (entry.busy || []).map((item) => (item.kind === "task"
            ? `任务 ${item.id || "?"}（${item.type || "?"}/${item.status || "?"}）`
            : `窗口 ${item.id || "?"}（${item.agent || "?"}）`)).join("、");
          if (entry.kind === "idle") return `${timeText(entry.at)} 全空`;
          return `${timeText(entry.at)} 忙 ${entry.count} 处：${who || "（没拿到明细）"}`;
        });
        return {
          content: [{
            type: "text",
            text: [
              line,
              idleLine,
              switchLine,
              status.armed ? "" : `上一轮结果：${state.result || "无"}`,
              "",
              "最近事件：",
              JSON.stringify(status.log || [], null, 2),
              "",
              `复盘时间线（最近 ${timelineLines.length} 条）：`,
              timelineLines.length ? timelineLines.join("\n") : "（还没有记录）",
            ].filter(Boolean).join("\n"),
          }],
          details: { sleepGuard: { ...status, realEnabled, timeline } },
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: `守门没弄成：${String(error?.message || error).slice(0, 200)}` }],
        };
      }
    },
  });

  // Ask 关闭时整组工具都不注册，模型在工具列表里也看不到它们。
  // 保存开关后到下一次重新加载之间，走的是上面的执行侧门禁。
  if (askEnabledAtLoad) {
  await sdk.tools.register({
    name: ASK_TOOL_NAME,
    description: "当任务遇到实质改变行动、风险、成本或结果的关键分岔时使用。调用时必须明确填写 selectionMode：互斥答案用 single；可以同时成立、要勾选一组的项目用 multiple。该字段只表示答案形式，不表示执行授权。多选最少选择数默认 1，显式指定也必须至少为 1。传音樱运行时等待用户作答；无球时工具只登记待办，返回「知意待发卡」，你须用知意 Ask 配方在本对话展示卡片、绑定后暂停，等卡片事件开启新回合再核验并继续原任务；收到待发卡后不得重调本工具改题。低风险可逆细节自行采用合理默认值。卸载、删除、覆盖等高影响选项必须说明具体目标、实际后果、备份情况和替代方案；不要用含混措辞，也不要把未知写成确定。Ask 只澄清决定，不授权外部或破坏性操作。",
    parameters: ASK_TOOL_SCHEMA,
    sessionPermission: { readOnly: true },
    execute: async (args) => {
      // 子代理会话不许发问：那段会话里用户不在场，题发出去没人答，球上还会多挂一道。
      if (isSubagentSessionPath(args?.context?.sessionPath)) {
        return {
          content: [{ type: "text", text: "这一段是伙伴派出去干活的子代理会话，用户不在场、也答不了这道题，所以没有生成卡片、没有弹窗。不要改用文字假装征询：可逆的低风险细节自己定，真正需要用户拍板的点写进汇报，交给上级去问。" }],
          details: { ask: { created: false, reason: "subagent_session" } },
        };
      }
      // 执行侧门禁：关掉之后到下一次重新加载之间，工具可能还挂在列表里。
      // 这里再读一次开关，真正不生成任何卡片。读失败落到外层 catch，按不生成处理。
      if (!normalizeAskConfig(await sdk.storage.global.get("askConfig", {})).enabled) {
        await sdk.logger.info("Ask card skipped: switch is off");
        return {
          content: [{ type: "text", text: "关键 Ask 卡已在设置中关闭，没有生成任何卡片，也没有向用户提问。请直接在正文里问用户，或自行采用合理默认值；不要改用别的卡片形态绕开。" }],
          details: { ask: { created: false, reason: "disabled" } },
        };
      }
      if (!Object.hasOwn(args ?? {}, "selectionMode")) {
        return {
          isError: true,
          content: [{ type: "text", text: "这次 Ask 必须明确选择单选或多选；尚未向用户发问。请按选项是否能同时成立判断，并在调用时填写 selectionMode。" }],
        };
      }
      let request;
      try {
        request = normalizeAskRequest(args);
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : "问题参数无效。" }],
        };
      }

      const sessionPath = args?.context?.sessionPath;
      if (typeof sessionPath !== "string" || !sessionPath.trim()) {
        return {
          isError: true,
          content: [{ type: "text", text: "这次调用没有可挂载提问的会话，未向用户发出问题；不要把它当作已取得决定。" }],
        };
      }

      try {
        // 球开着：把题送上去，送到就结束这次工具调用，不等作答。
        // 以前这里一直等到用户点完（最长十分钟），而宿主给工具执行的 RPC 只有 30 秒，
        // 两头尺度对不上，用户稍一犹豫工具就先报 timed out，球上的题还挂着。
        // 现在答案由 ballAsks 轮询接收，作为一条新消息补回这段对话，那边会再开一轮接着做。
        if (ball.state().running) {
          const target = await resolveResumeTarget({ sessionPath });
          const sent = await ball.enqueueAsk(request, {
            sessionId: target?.sessionId || "",
            sessionTitle: target?.title || "",
            agentName: target?.agentName || "",
          });
          if (sent?.busy) {
            return {
              isError: true,
              content: [{ type: "text", text: "传音樱上还压着一道没作答的题，这次没有继续发问。先等用户把那道题答完或跳过，别自己替用户选。" }],
            };
          }
          if (sent?.askId) {
            if (!target?.sessionId) {
              // 题已经在球上了，但回传地址没解析出来：先告诉模型实情，不让它以为拿到了选择。
              return {
                isError: true,
                content: [{ type: "text", text: "题已经送到传音樱上了，但没能定位这段对话（回传地址解析失败）。用户作答后答案回不到这一轮，请不要当作已取得选择；先告诉用户这个情况。" }],
              };
            }
            ballAsks.add({ askId: sent.askId, request, sessionId: target.sessionId });
            return {
              content: [{ type: "text", text: "已经在传音樱上向用户发出了这道题，现在还没有答案。这一轮先停在这里，不要自行选一个、也不要继续做依赖这个选择的事。用户答完之后会有一条新消息把选择送回来，到那时再接着做。" }],
            };
          }
        }
        // 没有球（或刚启动失败、或正在退出）：走配方卡交接，跟以前一样。
        const handoff = cardAsks.prepare(request, sessionPath);
        return {
          content: [{ type: "text", text: `知意待发卡（还没有收到用户决定；不要继续依赖这个选择的操作）：${JSON.stringify(handoff)}\n下一步用已安装的知意 Ask 配方 show_card 发到当前会话，拿到宿主卡片实例编号后调用 ${CARD_BIND_TOOL}。若配方不可用，调用 ${CARD_FALLBACK_TOOL} 回退原生确认卡，绝不能假称已发卡。` }],
        };
      } catch (error) {
        await sdk.logger.warn("Ask interaction failed", {
          code: error?.code ?? null,
        });
        return {
          isError: true,
          content: [{ type: "text", text: "这次 Ask 的回答结果无法确认。不要把工具错误当作用户决定，也不要继续依赖该选择执行；向用户说明状态未确认，并等待明确处理。" }],
        };
      }
    },
  });

  await sdk.tools.register({
    name: CARD_BIND_TOOL,
    description: "仅在 show_card 返回知意 Ask 卡片实例编号后调用。将当前对话的待选择项绑定到该卡片；未绑定前卡片不得开放作答。",
    sessionPermission: { readOnly: true },
    parameters: { type: "object", additionalProperties: false, required: ["askId", "cardInstanceId"], properties: {
      askId: { type: "string" }, cardInstanceId: { type: "string" },
    } },
    execute: async (args) => {
      const result = cardAsks.bind({ askId: args.askId, cardId: args.cardInstanceId, sessionPath: args.context?.sessionPath });
      return { isError: !result.ok, content: [{ type: "text", text: result.text }] };
    },
  });

  await sdk.tools.register({
    name: CARD_RESOLVE_TOOL,
    description: "收到知意 Ask 卡片的真实点击事件后，把事件的 askId、action、choice、note 与 cardInstanceId 原样传进来；本工具自行核验卡片归属、会话、有效期和选项合法性，回报有效才续上任务。ui_inspect 只是可选旁证，它说卡不在 open instances 不构成拒绝作答的理由。重复、跨会话、过期、非法选项均拒绝；没有真实事件禁止自行构造选择。",
    sessionPermission: { readOnly: true },
    parameters: { type: "object", additionalProperties: false, required: ["askId", "cardInstanceId", "action"], properties: {
      askId: { type: "string" }, cardInstanceId: { type: "string" },
      action: { type: "string", enum: ["confirmed", "custom", "rejected"] },
      choice: { anyOf: [
        { type: "string", maxLength: 500 },
        { type: "array", minItems: 1, maxItems: 5, items: { type: "string", maxLength: 100 } },
      ] },
      note: { type: "string", maxLength: 500 },
    } },
    execute: async (args) => {
      const result = cardAsks.resolve({ askId: args.askId, cardId: args.cardInstanceId,
        sessionPath: args.context?.sessionPath, action: args.action, choice: args.choice, note: args.note });
      return { isError: !result.ok || result.isError === true,
        content: [{ type: "text", text: result.ok ? `${result.text}\n本题：${result.request.question}` : result.text }] };
    },
  });

  await sdk.tools.register({
    name: CARD_FALLBACK_TOOL,
    description: "知意配方卡无法展示或绑定时，释放待发卡状态并在同一原会话使用 Hana 原生确认卡。卡片已绑定时禁止调用。",
    sessionPermission: { readOnly: true },
    parameters: { type: "object", additionalProperties: false, required: ["askId"], properties: { askId: { type: "string" } } },
    execute: async (args) => {
      const sessionPath = args.context?.sessionPath;
      const request = cardAsks.cancel({ askId: args.askId, sessionPath });
      if (!request) return { isError: true, content: [{ type: "text", text: "这道题已经展示、过期或不属于本会话，不能重复回退。" }] };
      try {
        const rawAnswer = await sdk.userInteraction.ask({ sessionPath, title: request.title,
          message: buildAskMessage(request), requestedSchema: buildRequestedSchema(request) });
        const answer = normalizeNativeAskAnswer(rawAnswer, request);
        const result = formatAskAnswer(answer, request);
        return { isError: result.isError, content: [{ type: "text", text: result.text }] };
      } catch {
        return { isError: true, content: [{ type: "text", text: "原生确认卡也未能确认结果；不要把这次失败当作用户决定。" }] };
      }
    },
  });
  } else {
    await sdk.logger.info("Ask card tools not registered: switch was off at load");
  }

  // 推荐方向的对话式修订：伙伴商量完才调它，出来的是建议，不是修改。
  await sdk.tools.register({
    name: STYLE_REFINE_TOOL_NAME,
    description: "用户想调整知意推荐回复的方向时调用。先在心里跟用户聊明白要改成什么样，再用 request 写清诉求；本工具只产出建议卡，不会改任何设置。必须立即调用内置 show_card 把返回的参数原样传入，并让 show_card 作为最后一步；不要把卡片内容复述给用户。用户只是问「现在是什么方向」时不要调用。",
    sessionPermission: { readOnly: true },
    parameters: { type: "object", additionalProperties: false, properties: {
      request: { type: "string", maxLength: 400, description: "用户想怎么改推荐方向，用用户的原话概括。" },
    } },
    execute: async (args) => {
      try {
        const plan = await refineStyles(sdk, { request: String(args?.request || "") });
        const draft = createDraft(plan);
        await sdk.storage.global.set("styleRefineDraft", draft);
        const cardDirectory = path.join(sdk.dataDir, "style-refine-cards");
        fs.mkdirSync(cardDirectory, { recursive: true });
        const cardPath = path.join(cardDirectory, `${randomUUID()}.html`);
        try {
          fs.writeFileSync(cardPath, buildStyleRefineCardDocument(draft, plan.config), "utf8");
          const staged = await sdk.resources.stage({ path: cardPath, name: "知意改推荐方向.html", mime: "text/html" });
          const fileId = staged?.resource?.fileId || staged?.file?.fileId;
          if (typeof fileId !== "string" || !fileId.trim()) throw new Error("建议卡没有成功交给当前会话。");
          await sdk.logger.info(`推荐方向建议已生成：${draft.items.length} 条 / ${plan.model}`);
          return {
            content: [{ type: "text", text: buildShowStyleCardInstruction(buildShowStyleCardInput(fileId)) }],
            details: { styleRefine: { draftId: draft.planId, count: draft.items.length, protocol: "show_card" } },
          };
        } finally {
          try { fs.unlinkSync(cardPath); } catch {}
        }
      } catch (error) {
        await sdk.logger.warn(`推荐方向建议失败：${String(error?.code || "STYLE_REFINE_ERROR")}`);
        return { isError: true, content: [{ type: "text", text: String(error?.message || error).slice(0, 200) }] };
      }
    },
  });

  // 建议卡上的「确认修改」。写盘后必须回读核对，核对不上就当失败——
  // 卡片不会关，用户可以再点一次；不确认就当成功是这一套最不能犯的错。
  await sdk.tools.register({
    name: STYLE_APPLY_TOOL_NAME,
    description: "仅由知意「改推荐方向」卡片上的「确认修改」按钮调用，不要主动调用。",
    sessionPermission: { readOnly: false },
    parameters: { type: "object", additionalProperties: false, required: ["planId"], properties: {
      planId: { type: "string", maxLength: 80, description: "建议卡带过来的方案编号。" },
      droppedKeys: { type: "string", maxLength: 2000, description: "用户在卡上点了「这条不要」的方向键，逗号分隔。" },
    } },
    execute: async (args) => {
      try {
        const draft = await sdk.storage.global.get("styleRefineDraft", null);
        if (!isDraftAlive(draft) || String(draft.planId) !== String(args?.planId)) {
          throw new Error("这份建议已经过期或不是当前这份了。请再和知意聊一句，重新出一张卡。");
        }
        const droppedKeys = String(args?.droppedKeys || "").split(",").map((item) => item.trim()).filter(Boolean);
        const kept = applyDrops(draft.items, droppedKeys);
        const checked = validatePlanStyles(kept);
        if (!checked.ok) throw new Error(checked.error);
        const config = normalizeRecommendationConfig(await sdk.storage.global.get("recommendationConfig", {}));
        const next = reselectStyles(config, checked.styles);
        await sdk.storage.global.set("recommendationConfig", next);
        const written = normalizeRecommendationConfig(await sdk.storage.global.get("recommendationConfig", {}));
        const saved = JSON.stringify(written.styles);
        if (saved !== JSON.stringify(next.styles)) {
          throw new Error("没能确认已经写进去，卡还开着，请再点一次「确认修改」。");
        }
        await sdk.logger.info(`推荐方向已更新：${written.styles.length} 条，剔除 ${droppedKeys.length} 条`);
        return {
          content: [{ type: "text", text: "推荐方向已按用户确认的改好，不要重复修改。" }],
          details: { styleRefine: { applied: true, count: written.styles.length } },
        };
      } catch (error) {
        await sdk.logger.warn(`推荐方向落盘失败：${String(error?.message || error).slice(0, 160)}`);
        return { isError: true, content: [{ type: "text", text: String(error?.message || error).slice(0, 200) }] };
      }
    },
  });

  // 守门人接上一轮：App 重载、宿主重启之后，上次还在守的接着守。
  // 计时从重挂开始重算——中间断过那段根本看不见，不能凭空算数。
  void (async () => {
    try {
      // 给 App 自己的初始化让一步，刚加载时 bus 还没铺完。
      await new Promise((resolve) => { const timer = setTimeout(resolve, 1_500); timer.unref?.(); });
      const restored = await restoreSleepGuard(sdk);
      if (restored.restored) await sdk.logger.info("守门人已接上一轮");
    } catch (error) {
      await sdk.logger.warn(`守门人恢复跳过：${String(error?.message || error).slice(0, 120)}`);
    }
  })();

  // App 启动后把用户上次开着的球恢复回来。重载、宿主重启都走这里。
  // 只认用户明确开过的（ballDesired）：默认不开，不代替人做决定。
  void (async () => {
    try {
      const wanted = await sdk.storage.global.get("ballDesired", false);
      ballDesired = wanted === true;
      if (!ballDesired || ball.state().running) return;
      const sameHost = await sameHostAsLastRun();
      if (sameHost === null) {
        await sdk.logger.warn("传音樱没自动恢复：读不到宿主进程号，分不清重载还是重开，这次按老规矩恢复。");
      } else if (!sameHost) {
        ballDesired = false;
        await saveConfig("ballDesired", false);
        await sdk.logger.info("传音樱没自动恢复：Hana 已经重开过，球不自己冒出来，要用请手动开一次。");
        return;
      }
      // 给 App 自己的初始化让一步：刚加载时 routes、钩子都还在铺，抢资源只会两头慢。
      await new Promise((resolve) => { const timer = setTimeout(resolve, 1_200); timer.unref?.(); });
      if (ball.state().running) return;
      const result = await ball.start();
      if (!result?.ok) {
        await sdk.logger.warn(`传音樱自动恢复失败：${result?.error || "未知原因"}`);
        return;
      }
      await sdk.logger.info("传音樱已按上次的状态自动恢复");
      scheduleVoiceBridgeTick(sdk, ball);
      scheduleBallBridgeTick(sdk, ball);
      startSleepBallPush(sdk, ball);
      void adoptPendingBallAsks().catch(() => {});
      resumeActionBaselineAdopted = false;
      void syncResumeVisibility();
      void syncPendingResumeNotice();
    } catch (error) {
      await sdk.logger.warn(`传音樱自动恢复跳过：${String(error?.message || error).slice(0, 120)}`);
    }
  })();
});
