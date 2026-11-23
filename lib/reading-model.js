// 自动整理只使用现有快速档 → 备用档，不维护独立模型设置。
// configuredModel 仅保留调用兼容，不把旧速览/Ask 模型当成快速档。

import { resolveFastModelChain } from "./fast-model.js";

export async function resolveReadingModelChain(sdk, configuredModel = null) {
  void configuredModel;
  const chain = await resolveFastModelChain(sdk, null, { includeContent: false, includeCustom: false }).catch(() => []);
  if (!chain.length) {
    const error = new Error("Hana 模型目录里没有可用的文本模型，暂时不能自动整理。");
    error.code = "MODEL_NOT_FOUND";
    throw error;
  }
  return chain;
}
