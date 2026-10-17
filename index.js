import { defineApp } from "./sdk/app-contract/server-client.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createBallManager } from "./lib/ball.js";
import { registerFusionService } from "./lib/fusion-service.js";
import { createBallBridge, RECOMMEND_POLL_MS } from "./lib/ball-bridge.js";
import { createCardAskRegistry } from "./lib/card-handoff.js";
import { appendAskGuidance } from "./lib/ask-guidance.js";
import {
  DEFAULT_MIN_CHARS,
  MAX_MIN_CHARS,
  appendSummaryBlock,
  buildSummaryBlock,
  lastUserMessage,
  normalizeMinChars,
  normalizeSummaryConfig,
  readBodyText,
  recordSummaryFailure,
  saveOriginalArchive,
  shouldSummarize,
  resolveSummaryModelRef,
  summarizeReply,
} from "./lib/length-summary.js";
import { chatModelOptions, normalizeModelRef, reviewAskNeed, testAskModelConnection } from "./lib/ask-model.js";
import { POLISH_LEVEL_OPTIONS, polishText } from "./lib/polish.js";
import { applySessionTitle, readTitleUndo, summarizeSessionTitle, undoSessionTitle } from "./lib/session-title.js";
import { encryptionAvailable, encryptionStatus, protectKey } from "./lib/crypto.js";
import {
  MAX_REPLY_CHARS,
  VOICE_PRESETS,
  isMaskedKey,
  isValidClipId,
  maskVoiceConfig,
  normalizeVoiceConfig,
  readClip,
  resolveVoiceIdForAgent,
  saveClip,
  synthesizeVoice,
  voicesForProtocol,
} from "./lib/voice.js";
import { listSpeakableReplies, prepareSpeakText, resolveSpeakTarget } from "./lib/voice-replies.js";
import {
  applyDrops,
  createDraft,
  isDraftAlive,
  reselectStyles,
  restoreDefaultStyles,
  validatePlanStyles,
  refineStyles,
} from "./lib/style-refine.js";
import { buildShowStyleCardInput, buildShowStyleCardInstruction, buildStyleRefineCardDocument } from "./lib/style-card.js";
import {
  maskCustomModelConfig,
  mergeCustomModelConfig,
  testCustomModel,
} from "./lib/custom-model.js";
import {
  RESUME_TEXT,
  assistantTextOf,
  buildResumeExplanation,
  createResumeTracker,
  isUserInitiatedAbortReason,
  normalizeResumeConfig,
  parseAutoRetryStart,
  parseResumeSignal,
  sessionIdFromPath,
} from "./lib/resume-watch.js";
import { friendlySendError, sendToConversation } from "./lib/send.js";
import {
  COUNT_CHOICES,
  DEFAULT_STYLES,
  DISPLAY_MODES,
  normalizeRecommendationConfig,
} from "./lib/recommendation-config.js";
import {
  ASK_TOOL_SCHEMA,
  buildAskMessage,
  buildRequestedSchema,
  formatAskAnswer,
  normalizeAskRequest,
} from "./lib/ask.js";

export const name = "jiegehua-zhiyi";

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
async function speakByEntry(sdk, { sessionId = "", entryId = "", text = "" } = {}) {
  const config = normalizeVoiceConfig(await sdk.storage.global.get("voiceConfig", {}));
  const target = await resolveSpeakTarget(sdk, { sessionId, entryId, text });
  const prepared = prepareSpeakText(target.raw, config);
  if (!prepared.text) throw new Error("清洗之后没有可以朗读的内容。");
  const voiceId = resolveVoiceIdForAgent(config, target.agentId);
  const result = await synthesizeVoice(sdk, { text: prepared.text, config, voiceId });
  const clipId = `clip_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const file = saveClip(sdk, clipId, result.audio, result.format);
  await sdk.logger.info(`朗读已合成：${prepared.text.length} 字 / ${result.format} / 词级标记 ${result.timings?.length ?? 0} 条`);
  return {
    clipId,
    file,
    format: result.format,
    durationMs: result.durationMs,
    timings: result.timings || null,
    voiceId,
    agentId: target.agentId,
    sessionId: target.sessionId,
    text: prepared.text,
    matched: prepared.matched,
    truncated: prepared.truncated,
  };
}

// 传音樱朗读：球只能轮询桥、不能回调 App，所以这条推送链由 App 主动。
// 球打开朗读窗 → 桥报 readOpen → App 下发回复列表；球选中 → 桥报 selectionSeq 变化 → App 合成并回填结果。
const VOICE_BRIDGE_POLL_MS = 1500;
const VOICE_BRIDGE_LIST_TTL_MS = 60_000;
let voiceBridgeTimer = null;
const voiceBridgeState = { lastSelectionSeq: 0, pushedAt: 0 };

function scheduleVoiceBridgeTick(sdk, ball) {
  if (voiceBridgeTimer) return;
  voiceBridgeTimer = setTimeout(() => { voiceBridgeTimer = null; void voiceBridgeTick(sdk, ball); }, 200);
  voiceBridgeTimer.unref?.();
}

async function voiceBridgeTick(sdk, ball) {
  if (!ball.state().running) { voiceBridgeState.pushedAt = 0; return; }
  try {
    const state = await ball.bridgeRequest("/voice/state");
    if (state?.readOpen) {
      if (!voiceBridgeState.pushedAt || Date.now() - voiceBridgeState.pushedAt > VOICE_BRIDGE_LIST_TTL_MS) {
        const listed = await listSpeakableReplies(sdk, { limit: 8 });
        await ball.bridgeRequest("/voice/push", {
          method: "POST",
          body: {
            sessionId: listed.session.sessionId,
            agentId: listed.session.agentId,
            replies: listed.replies,
          },
        });
        voiceBridgeState.pushedAt = Date.now();
      }
      const seq = Number(state.selectionSeq) || 0;      if (state.selectedEntryId && seq > voiceBridgeState.lastSelectionSeq) {
        voiceBridgeState.lastSelectionSeq = seq;
        try {
          const spoken = await speakByEntry(sdk, {
            sessionId: String(state.sessionId || ""),
            entryId: String(state.selectedEntryId || ""),
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
  });
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
  process.once("SIGTERM", () => { void activeBallManager?.stop(); });
  process.once("SIGINT", () => { void activeBallManager?.stop(); });
  process.once("exit", () => {
    try { if (activeBallManager?.state().running) activeBallManager.stop(); } catch {}
    try { activeFusionServiceDispose?.(); } catch {}
  });
}

export default defineApp(async (sdk) => {
  await sdk.logger.info("jiegehua-zhiyi loaded");
  const askEnabledAtLoad = normalizeAskConfig(await sdk.storage.global.get("askConfig", {})).enabled;
  await sdk.logger.info("Ask card registration decided at load", { enabled: askEnabledAtLoad });
  await sdk.hooks.onDecision("agent/before-start", async (invocation) => {
    // 卡住兜底的时间起点：这一轮开始了。
    if (resumeConfig.enabled && invocation?.session?.sessionId) {
      resumeTracker.markStarted(invocation.session.sessionId);
    }
    // 每轮都现读开关：关掉后不必等重新加载，引导立刻不再注入。
    // 顺带连判断模型那一次调用也省了——不引导就没必要先问模型该不该问。
    const askEnabled = normalizeAskConfig(await sdk.storage.global.get("askConfig", {})).enabled;
    let prompt = invocation?.systemPrompt;
    if (askEnabled) {
      const configuredModel = await sdk.storage.global.get("askJudgeModel", null);
      const review = await reviewAskNeed(sdk, invocation?.prompt, configuredModel, (event) => {
        void sdk.logger.debug?.("Ask model precheck", event);
      });
      prompt = appendAskGuidance(prompt, review);
    }
    // 推荐回复只活在传音樱里，主对话不再出卡，也就没有推荐引导可注。
    // 设置页点了「方向不太对？和小花聊聊」→ 这一轮先把意图交给伙伴，只注一次。
    let refineHint = "";
    if (await sdk.storage.global.get("styleRefineRequested", false)) {
      await sdk.storage.global.set("styleRefineRequested", false);
      refineHint = "（知意）用户刚在设置里点了「方向不太对，和你聊聊」。先用一两句话问清楚他想怎么改，别急着调工具；他说完你再调 jiegehua_zhiyi_refine_recommendation_styles 出建议。";
    }
    return { systemPrompt: `${prompt}${refineHint}` };
  });
  // 长回复速览：正文达到阈值时生成几行要点，以引用块小卡接在原文末尾。
  // 原文完整保留，速览只是附在后面的一段。
  let summarizing = false;
  // check 必须在 try 外面声明：catch 里要读它，写在 try 块内会在错误处理时再抛一次。
  let check = null;
  await sdk.hooks.onDecision("messages/post-assistant", async (invocation) => {
    // 出了正文就算这一轮说下去了，卡住计时立即作废（要在下面任何提前 return 之前）。
    if (invocation?.session?.sessionId) {
      resumeTracker.markProduced(invocation.session.sessionId);
    }
    try {
      const config = normalizeSummaryConfig(await sdk.storage.global.get("summaryConfig", {}));
      if (!config.enabled) return undefined;
      if (summarizing) return undefined;

      const text = readBodyText(invocation?.message);
      if (!text) return undefined;
      const userText = await lastUserMessage(sdk, invocation?.session);
      check = shouldSummarize({ text, minChars: config.minChars, userText });
      if (!check.ok) {
        await sdk.logger.info(`长回复速览跳过：${check.reason}（${text.length} 字）`);
        return undefined;
      }

      summarizing = true;
      try {
        const configuredModel = resolveSummaryModelRef(
          await sdk.storage.global.get("summaryModel", null),
          await sdk.storage.global.get("askJudgeModel", null),
        );
        const { lines, elapsedMs } = await summarizeReply(sdk, text, configuredModel, (event) => {
          void sdk.logger.debug?.("长回复速览模型流", event);
        });
        const sessionPath = typeof invocation?.session === "string"
          ? invocation.session
          : (invocation?.session?.sessionPath ?? invocation?.session?.path ?? "");
        saveOriginalArchive(sdk.dataDir, { sessionPath, chars: check.chars, text, lines });
        const next = appendSummaryBlock(invocation.message, buildSummaryBlock(lines, check.chars));
        if (!next) return undefined;
        await sdk.logger.info(`长回复已附速览小卡（${check.chars} 字，${lines.length} 行，耗时 ${elapsedMs}ms）`, { chars: check.chars, lines: lines.length, elapsedMs, model: invocation?.message?.model ?? null });
        return { message: next };
      } finally {
        summarizing = false;
      }
    } catch (error) {
      // 任何一步失败都保留原文，宁可啰嗦也不让内容丢失。
      const detail = recordSummaryFailure(sdk.dataDir, error, { chars: check?.chars ?? null });
      await sdk.logger.warn(`长回复速览失败，保留原文：${detail.code ?? "no-code"} ${detail.message}`);
      return undefined;
    }
  });

  const ball = createBallManager({ sdk, appRoot: APP_ROOT });
// 传音樱可能在上一次会话里已经开着；载入时就把朗读推送链接上。
if (ball.state().running) scheduleVoiceBridgeTick(sdk, ball);
// 目标跟随与球内推荐同样在载入时接上（球开着才有意义）。
if (ball.state().running) scheduleBallBridgeTick(sdk, ball);
// 闲不住的融合协调器靠这个服务拿到球的坐标与桥地址；没授权就静默单侧运行。
const disposeFusionService = await registerFusionService({ sdk, ball });
activeFusionServiceDispose = disposeFusionService;

  // ── 断联续接 ──
  let resumeConfig = await readResumeConfig(sdk);
  let resumeTracker = makeResumeTracker(resumeConfig);
  const resumeSignals = new Map();
  let lastBallActionSeq = 0;
  let resumeEventsAvailable = false;

  async function pushResumeNotice(payload) {
    if (!ball.state().running) return;
    try {
      await ball.bridgeRequest("/resume/notice", { method: "POST", body: payload || {} });
    } catch (error) {
      await sdk.logger.debug?.("断联续接小条未送达传音樱", { error: String(error?.message || error).slice(0, 120) });
    }
  }

  // 传音樱上的三个按钮（继续哈 / 不用管 / 自动续接开关）也是球→App，
  // 球只能轮询桥，所以这边单独一个 2 秒的读取器；序号自增，用过即丢。
  const resumeBridgeTimer = setInterval(async () => {
    if (!ball.state().running) return;
    let state;
    try { state = await ball.bridgeRequest("/resume/state"); } catch { return; }
    const actionSeq = Number(state?.actionSeq) || 0;
    const action = state?.action || null;
    if (!action || actionSeq <= lastBallActionSeq) return;
    lastBallActionSeq = actionSeq;
    const sessionId = String(action.sessionId || "");
    if (action.action === "auto") {
      resumeConfig = normalizeResumeConfig({ ...resumeConfig, autoResume: action.enabled === true });
      await sdk.storage.global.set("resumeConfig", resumeConfig);
      resumeTracker = makeResumeTracker(resumeConfig);
      await sdk.logger.info(`自动续接已${resumeConfig.autoResume ? "打开" : "关闭"}`);
    } else if (action.action === "continue") {
      try {
        await sendToConversation(sdk, { text: RESUME_TEXT, mode: "steer", sessionId });
        resumeTracker.markRecovered(sessionId);
        resumeSignals.delete(sessionId);
        await pushResumeNotice(null);
      } catch (error) {
        await sdk.logger.warn(`球里点了继续哈但没发出去：${String(error?.message || error).slice(0, 160)}`);
      }
    } else if (action.action === "dismiss") {
      resumeTracker.forget(sessionId);
      resumeSignals.delete(sessionId);
      await pushResumeNotice(null);
    }
  }, 2_000);
  resumeBridgeTimer.unref?.();

  async function sendResumeContinue(sessionId, agentId = "") {
    try {
      await sendToConversation(sdk, { text: RESUME_TEXT, mode: "steer", sessionId });
      await sdk.logger.info(`已续接：${sessionId || "最近会话"}`);
      return true;
    } catch (error) {
      // 没发出去就不能占用户的上限名额
      resumeTracker.rollbackResume(sessionId, agentId);
      await sdk.logger.warn(`续接没发出去：${String(error?.message || error).slice(0, 160)}`);
      return false;
    }
  }

  async function applyResumeDecision(decision) {
    if (!decision || decision.action === "ignore" || decision.action === "wait") return;
    const signal = resumeSignals.get(decision.sessionId) || null;
    if (decision.action === "resume") {
      if (!await sendResumeContinue(decision.sessionId, signal?.agentId || "")) return;
      resumeTracker.noteResumeFailed(decision.sessionId, signal?.agentId || "");
      await pushResumeNotice(null);
      return;
    }
    await pushResumeNotice({
      sessionId: decision.sessionId,
      title: signal?.agentName || "",
      reason: buildResumeExplanation(signal),
      attempt: decision.attempt,
      at: Date.now(),
    });
    await sdk.logger.info(`续接用尽，已在传音樱提醒：${decision.reason}`);
  }

  async function pumpResume() {
    if (!resumeConfig.enabled) return;
    for (const stuck of resumeTracker.checkStuck()) {
      resumeSignals.set(stuck.sessionId, { sessionId: stuck.sessionId, reason: "" });
      resumeTracker.onAbnormal({ sessionId: stuck.sessionId, reason: "" });
    }
    for (const key of resumeTracker.pendingKeys()) {
      await applyResumeDecision(resumeTracker.resolve({ sessionId: key }));
    }
  }

  function handleResumeEvent(event, sessionPath) {
    if (!resumeConfig.enabled || !event) return;
    const retry = parseAutoRetryStart(event, sessionPath);
    if (retry?.sessionId) {
      resumeTracker.markRetrying(retry.sessionId, retry.agentId);
      return;
    }
    const signal = parseResumeSignal(event, sessionPath);
    if (signal) {
      if (isUserInitiatedAbortReason(signal.reason)) return;
      const key = signal.sessionId || signal.agentId;
      resumeSignals.set(key, signal);
      resumeTracker.onAbnormal(signal);
      return;
    }
    if (event.type === "turn_end") {
      const sessionId = sessionIdFromPath(sessionPath) || String(event.sessionId || "");
      if (sessionId && assistantTextOf(event.message) && event.aborted !== true) {
        resumeTracker.markRecovered(sessionId, event.agentId || "");
        resumeSignals.delete(sessionId);
      }
    }
  }

  // 订阅必须显式给第二个参数：省略时经 RPC 会变成 null，宿主在装载阶段读 types 直接抛错，
  // 整条安装记录作废（kc-debug-App里bus订阅省略参数会炸装载）。
  // 宿主不支持时只降级、不报错：卡住兜底走的是两个 hook，不依赖这条订阅。
  try {
    if (typeof sdk.bus?.subscribe === "function") {
      await sdk.bus.subscribe((event, sessionPath) => { void handleResumeEvent(event, sessionPath); }, {});
      resumeEventsAvailable = true;
    }
  } catch (error) {
    await sdk.logger.warn(`宿主不支持事件订阅，断联续接只剩卡住兜底：${String(error?.code || error?.message || error).slice(0, 120)}`);
  }
  const resumeTimer = setInterval(() => { void pumpResume(); }, 5_000);
  resumeTimer.unref?.();
  const cardAsks = createCardAskRegistry();
  activeBallManager = ball;
  installBallShutdownHooks();

  await sdk.routes.register((app) => {
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
      await sdk.storage.global.set("summaryConfig", next);
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
        await sdk.storage.global.set("summaryModel", modelRef);
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

    app.get("/resume-config", async (c) => c.json({ ok: true, config: resumeConfig, text: RESUME_TEXT }));
    app.put("/resume-config", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "续接设置读不出来。" }, 400); }
      resumeConfig = normalizeResumeConfig({ ...resumeConfig, ...(body?.config || {}) });
      await sdk.storage.global.set("resumeConfig", resumeConfig);
      // 重建状态机让新上限立刻生效；已有的待决信号因此清空（用户主动改的，可接受）。
      resumeTracker = makeResumeTracker(resumeConfig);
      resumeSignals.clear();
      return c.json({ ok: true, config: resumeConfig });
    });
    app.get("/resume-status", async (c) => {
      const sessionId = String(c.req.query("sessionId") || "");
      return c.json({
        ok: true,
        config: resumeConfig,
        eventsAvailable: resumeEventsAvailable,
        session: sessionId ? resumeTracker.snapshot(sessionId) : null,
      });
    });
    app.post("/resume/continue", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "续接参数读不出来。" }, 400); }
      const sessionId = String(body?.sessionId || "");
      try {
        // 用户点的是「继续哈」，这是他明确的动作，不受自动续接开关约束。
        const sent = await sendToConversation(sdk, { text: RESUME_TEXT, mode: "steer", sessionId });
        resumeTracker.markRecovered(sessionId);
        resumeSignals.delete(sessionId);
        await pushResumeNotice(null);
        return c.json({ ok: true, ...sent });
      } catch (error) {
        return c.json({ ok: false, error: friendlySendError(error) }, 502);
      }
    });
    app.post("/resume/dismiss", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "参数读不出来。" }, 400); }
      const sessionId = String(body?.sessionId || "");
      resumeTracker.forget(sessionId);
      resumeSignals.delete(sessionId);
      await pushResumeNotice(null);
      return c.json({ ok: true });
    });

    app.get("/ball/status", (c) => c.json(ball.state()));
    app.post("/ball/start", async (c) => {
      const result = await ball.start();
      if (result?.running) scheduleVoiceBridgeTick(sdk, ball);
      if (result?.running) scheduleBallBridgeTick(sdk, ball);
      return c.json(result);
    });
    app.post("/ball/stop", async (c) => c.json(await ball.stop()));

    // ── 语音朗读 ──
    // 配置一条朗读模型 + 朗读偏好 + 按伙伴分的音色；Key 落盘前用系统加密保护。
    app.get("/voice-config", async (c) => {
      const config = normalizeVoiceConfig(await sdk.storage.global.get("voiceConfig", {}));
      // 伙伴名单不单独申请授权：从已授权的 session:list 里聚合出你最近聊过的伙伴。
      // 拿不到就明说，不静默给一个空列表让界面假装「你没聊过别人」。
      let partners = [];
      let partnersNote = "";
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
        partners = [...seen.values()]
          .sort((a, b) => b.modified - a.modified)
          .slice(0, 12)
          .map(({ agentId, agentName }) => ({ agentId, agentName: agentName || agentId }));
      } catch (error) {
        partnersNote = `伙伴名单读不到（${String(error?.message || error).slice(0, 80)}），暂时不能按伙伴分音色。`;
        await sdk.logger.warn(`朗读伙伴名单读取失败：${error?.message ?? String(error)}`);
      }
      return c.json({
        ok: true,
        config: maskVoiceConfig(config),
        presets: VOICE_PRESETS,
        voices: voicesForProtocol(config.protocol),
        voiceLibrary: { t2a: voicesForProtocol("t2a"), chat: voicesForProtocol("chat") },
        partners,
        partnersNote,
        encrypted: encryptionAvailable(),
        encryptionNote: encryptionAvailable() ? "" : (encryptionStatus().reason || "系统加密不可用"),
        limits: { maxChars: MAX_REPLY_CHARS * 10 },
      });
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
      return c.json({
        ok: true,
        config: maskVoiceConfig(next),
        encrypted: encryptionAvailable(),
        encryptionNote: encryptionAvailable() ? "" : (encryptionStatus().reason || "系统加密不可用"),
      });
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
    app.post("/voice/speak", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "朗读参数读不出来。" }, 400); }
      try {
        return c.json({ ok: true, ...(await speakByEntry(sdk, {
          sessionId: String(body?.sessionId || ""),
          entryId: String(body?.entryId || ""),
          text: String(body?.text || ""),
        })) });
      } catch (error) {
        return c.json({ ok: false, error: String(error?.message || error).slice(0, 240) }, 502);
      }
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
    app.post("/recommendation-config/refine-request", async (c) => {
      await sdk.storage.global.set("styleRefineRequested", true);
      return c.json({ ok: true, hint: "下一轮对话里知意会问你，想好怎么改再回它。" });
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
        styles: body?.styles,
        selectedByCount: body?.selectedByCount,
      });
      await sdk.storage.global.set("recommendationConfig", config);
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
          await sdk.storage.global.set(key, modelRef);
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
        await sdk.storage.global.set("recommendationModel", modelRef);
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
        await sdk.storage.global.set("askJudgeModel", modelRef);
        return c.json({ ok: true, modelRef });
      } catch (error) {
        return c.json({ ok: false, error: "保存模型失败；请确认知意已获模型使用权限。" }, 403);
      }
    });
    app.get("/ask-config", async (c) => c.json({
      ...normalizeAskConfig(await sdk.storage.global.get("askConfig", {})),
      registeredAtLoad: askEnabledAtLoad,
      guidancePerTurn: true,
    }));
    app.put("/ask-config", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "Ask 开关读不出来。" }, 400); }
      const config = normalizeAskConfig({ enabled: body?.enabled !== false });
      await sdk.storage.global.set("askConfig", config);
      await sdk.logger.info("Ask card switch saved", {
        enabled: config.enabled,
        toolsStillRegistered: askEnabledAtLoad,
      });
      return c.json({ ok: true, ...config, registeredAtLoad: askEnabledAtLoad, guidancePerTurn: true });
    });
    app.get("/polish/levels", async (c) => c.json({ ok: true, levels: POLISH_LEVEL_OPTIONS }));
    app.post("/polish", async (c) => {
      let body;
      try { body = await c.req.json(); } catch { return c.json({ ok: false, error: "润色请求读不出来。" }, 400); }
      try {
        const result = await polishText(sdk, body?.text, { level: body?.level });
        return c.json({ ok: true, ...result });
      } catch (error) {
        await sdk.logger.warn("Polish failed", { code: error?.code || "POLISH_ERROR" });
        return c.json({ ok: false, error: error?.message || "润色失败，原文没动。" }, 400);
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
        let answer = null;
        if (ball.state().running) {
          answer = await ball.ask(request);
        }
        if (answer === null) {
          const handoff = cardAsks.prepare(request, sessionPath);
          return {
            content: [{ type: "text", text: `知意待发卡（还没有收到用户决定；不要继续依赖这个选择的操作）：${JSON.stringify(handoff)}\n下一步用已安装的知意 Ask 配方 show_card 发到当前会话，拿到宿主卡片实例编号后调用 ${CARD_BIND_TOOL}。若配方不可用，调用 ${CARD_FALLBACK_TOOL} 回退原生确认卡，绝不能假称已发卡。` }],
          };
        }
        const result = formatAskAnswer(answer, request);
        return {
          isError: result.isError,
          content: [{ type: "text", text: result.text }],
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
    description: "仅在收到知意 Ask 卡片的真实点击事件，按事件 cardInstanceId 用 ui_inspect 核验来源后调用。重复、跨会话、过期、非法选项均拒绝；没有真实事件禁止自行构造选择。",
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
});
