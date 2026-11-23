// lib/reading-model.js — 自动整理（回复整理版）专用模型档。
//
// 为什么单独一个键：整理判定原先借 resolveSummaryChain，它默认 useStored=true，
// 共用快速档 fastTaskModel 会盖过 summaryModel；而那条共用快速档还供会话起名等
// 功能使用，不能为了整理直接换它。所以整理有自己的 replyReadingModel：
// 设了就只认它（useStored=false，共用快速档不再插队），没设就原样走旧的速览链，
// 既有行为一字不动。本模块只读写自己的键，不碰主对话、共用快速档、内容/备用模型、
// 起名、Ask 判断或任何 Provider 配置。

import { chatModelOptions, normalizeModelRef } from "./ask-model.js";
import { resolveFastModelChain } from "./fast-model.js";
import { resolveSummaryChain, resolveSummaryModelRef } from "./length-summary.js";

export const READING_MODEL_KEY = "replyReadingModel";
export const READING_MODEL_TOOL_NAME = "jiegehua_zhiyi_reading_model";

/** 宿主 APP_MODEL_* 与本 App 固定 MODEL_* 码原样保留（便于分辨 off 被拒/空正文/超时等），其余用本功能固定码。 */
export function readingErrorCode(error, fallback) {
  const code = String(error?.code || "");
  return /^(?:APP_MODEL_|MODEL_)[A-Z0-9_]{1,54}$/.test(code) ? code : fallback;
}

/**
 * 整理专用解析链：
 * - 设了 replyReadingModel：resolveFastModelChain(sdk, ref, {useStored:false})，
 *   共用快速档不参与；内容/备用仍按既有降级链兜底。
 * - 没设（或读不到）：原样调用既有 resolveSummaryChain，与旧版行为完全一致。
 * 空链一律用既有 MODEL_NOT_FOUND 固定码。
 */
export async function resolveReadingModelChain(sdk, configuredModel = null) {
  let raw = null;
  try { raw = await sdk.storage.global.get(READING_MODEL_KEY, null); } catch { raw = null; }
  const independent = normalizeModelRef(raw);
  if (!independent) return resolveSummaryChain(sdk, configuredModel);
  const chain = await resolveFastModelChain(sdk, independent, { useStored: false }).catch(() => []);
  if (!chain.length) {
    const error = new Error("Hana 模型目录里没有可用的文本模型，暂时不能自动简写。");
    error.code = "MODEL_NOT_FOUND";
    throw error;
  }
  return chain;
}

/** 链上只暴露安全字段；自定义档的 config（含 Key）一律不带出去。 */
export function safeModelEntry(entry) {
  const row = { role: String(entry?.role || ""), kind: String(entry?.kind || ""), name: String(entry?.name || "").slice(0, 120) };
  if (entry?.kind === "host" && entry.model) {
    row.provider = String(entry.model.provider || "");
    row.model = String(entry.model.model || "");
  }
  return row;
}

/** 只读回落参考：与 index 钩子 readModel 同口径（summaryModel → askJudgeModel）。 */
export async function readReadingFallbackRef(sdk) {
  const read = async (key) => { try { return await sdk.storage.global.get(key, null); } catch { return null; } };
  return resolveSummaryModelRef(await read("summaryModel"), await read("askJudgeModel"));
}

/**
 * 正式业务入口：自动整理专用模型的 list/status/set/reset。
 * 注册本身不读配置、不读模型目录、不发模型请求；配置变更只能经此工具发生，
 * 且 set/reset 必须 confirm:true（代表用户已明确要求）。只写 replyReadingModel 一个键。
 */
export async function registerReadingModelTool(sdk) {
  await sdk.tools.register({
    name: READING_MODEL_TOOL_NAME,
    description: "知意自动整理（回复整理版）专用模型入口。只有用户明确要求更改自动整理所用模型时才允许 set/reset，且必须 confirm:true；list/status 只读。本工具只读写知意自己的 replyReadingModel 键：不改主对话模型、共用快速档、内容/备用模型、会话起名、Ask 判断或任何 Provider 配置，也不发模型请求。set 的 modelRef 必须精确存在于当前 Hana 可用文本模型目录；reset 只清这一个键，清完回到原有模型链。",
    sessionPermission: { readOnly: false },
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["list", "status", "set", "reset"],
          description: "list 列可用文本模型与本功能当前选择；status 看当前选择与解析链；set 保存独立模型（须 confirm:true 与目录内 modelRef）；reset 清除独立选择回到旧链（须 confirm:true）。",
        },
        confirm: { type: "boolean", description: "set/reset 必须显式 true，代表用户已明确要求这次更改。" },
        modelRef: {
          type: "object",
          additionalProperties: false,
          required: ["provider", "model"],
          properties: { provider: { type: "string", maxLength: 200 }, model: { type: "string", maxLength: 200 } },
          description: "set 必填：要用于自动整理的模型，provider 与 model 都须精确匹配当前目录。",
        },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = String(args?.action || "");
      const reply = (payload, isError = false) => ({ isError, content: [{ type: "text", text: JSON.stringify(payload) }] });
      try {
        if (action === "list") {
          const catalog = await sdk.models.list();
          // 白名单字段：目录行里即便夹带配置/凭据也不带出去。key 是界面用的复合 id，调用者用不上，不出口。
          const models = chatModelOptions(catalog).map((row) => ({
            provider: row.provider, model: row.model, name: row.name,
            providerLabel: row.providerLabel, providerChannel: row.providerChannel, isCurrent: row.isCurrent,
          }));
          const modelRef = normalizeModelRef(await sdk.storage.global.get(READING_MODEL_KEY, null));
          return reply({ ok: true, action, models, modelRef });
        }
        if (action === "status") {
          const modelRef = normalizeModelRef(await sdk.storage.global.get(READING_MODEL_KEY, null));
          let chain = [];
          let chainCode = null;
          try { chain = (await resolveReadingModelChain(sdk, await readReadingFallbackRef(sdk))).map(safeModelEntry); }
          catch (error) { chainCode = readingErrorCode(error, "MODEL_NOT_FOUND"); }
          return reply({ ok: true, action, modelRef, chain, chainCode });
        }
        if (action === "set") {
          if (args?.confirm !== true) {
            return reply({ ok: false, action, code: "READING_MODEL_CONFIRM_REQUIRED", error: "set 需要 confirm:true：只有用户明确要求更改自动整理模型时才能保存。" }, true);
          }
          const modelRef = normalizeModelRef(args?.modelRef);
          if (!modelRef) return reply({ ok: false, action, code: "READING_MODEL_BAD_REF", error: "modelRef 需要 {provider, model} 两个非空字段。" }, true);
          const catalog = await sdk.models.list();
          const exists = chatModelOptions(catalog).some((row) => row.provider === modelRef.provider && row.model === modelRef.model);
          if (!exists) return reply({ ok: false, action, code: "READING_MODEL_NOT_IN_CATALOG", error: "这条模型已不在 Hana 配置列表中，请重新选择。" }, true);
          await sdk.storage.global.set(READING_MODEL_KEY, modelRef);
          // 写成功必须回读核对，核对不上就当失败，不冒称已保存。
          const written = normalizeModelRef(await sdk.storage.global.get(READING_MODEL_KEY, null));
          if (!written || written.provider !== modelRef.provider || written.model !== modelRef.model) {
            return reply({ ok: false, action, code: "READING_MODEL_WRITE_UNCONFIRMED", error: "没能确认已经写进去，本次不算保存成功。" }, true);
          }
          try { await sdk.logger.info(`自动整理独立模型已保存：${written.provider}/${written.model}`); } catch {}
          return reply({ ok: true, action, modelRef: written, saved: true });
        }
        if (action === "reset") {
          if (args?.confirm !== true) {
            return reply({ ok: false, action, code: "READING_MODEL_CONFIRM_REQUIRED", error: "reset 需要 confirm:true：只有用户明确要求清除自动整理独立模型时才能重置。" }, true);
          }
          await sdk.storage.global.set(READING_MODEL_KEY, null);
          const written = normalizeModelRef(await sdk.storage.global.get(READING_MODEL_KEY, null));
          if (written) return reply({ ok: false, action, code: "READING_MODEL_WRITE_UNCONFIRMED", error: "没能确认已经清除，本次不算重置成功。" }, true);
          try { await sdk.logger.info("自动整理独立模型已清除，回到原有模型链"); } catch {}
          return reply({ ok: true, action, modelRef: null, saved: true });
        }
        return reply({ ok: false, code: "READING_MODEL_BAD_ACTION", error: "action 只认 list/status/set/reset。" }, true);
      } catch (error) {
        return reply({ ok: false, action, code: readingErrorCode(error, "READING_MODEL_FAILED"), error: "自动整理模型操作失败；设置或模型目录未能确认。" }, true);
      }
    },
  });
}