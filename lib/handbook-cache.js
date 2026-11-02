// 更新手记的卡片缓存。
//
// 一个版本一份文件，键是 tag。能这么存是因为版本说明写死不改：同一版的 release 正文不会重写，
// 所以卡片没有过期时间，只有提示词改版（promptVersion 变了）才重算。
//
// 写盘用「先写临时文件再改名」：挑卡片这一步要等模型，中途断电会把文件写一半，
// 半份 JSON 比没有更坏——读的时候会当缓存命中去解析，然后炸在页面里。
//
// 读失败一律返回 null（当没缓存）。缓存坏了最多是多花一次模型调用，不该让页面报错。

import fs from "node:fs/promises";
import path from "node:path";

const DIR_NAME = "handbook-cache";
const VERSION = 1;
const writing = new Map();

function dirOf(sdk) {
  const base = typeof sdk?.dataDir === "string" ? sdk.dataDir.trim() : "";
  return base ? path.join(base, DIR_NAME) : "";
}

// tag 直接进文件名之前要先洗一遍：v1.5.48-beta 本身是安全的，但别指望以后也安全。
const fileOf = (tag) => `${String(tag).replace(/[^A-Za-z0-9._-]/g, "_")}.json`;

/**
 * 读某版的卡片缓存。
 * version 或 promptVersion 对不上都当没缓存：前者是文件格式变了，后者是提示词口径变了。
 */
export async function readCardsCache(sdk, tag, { promptVersion } = {}) {
  const dir = dirOf(sdk);
  if (!dir || !tag) return null;
  try {
    const file = path.join(dir, fileOf(tag));
    const row = JSON.parse(await fs.readFile(file, "utf8"));
    if (row?.version !== VERSION) return null;
    if (typeof promptVersion === "number" && row?.promptVersion !== promptVersion) return null;
    if (!Array.isArray(row?.cards) || !row.cards.length) return null;
    return { tag: row.tag || tag, publishedAt: row.publishedAt || "", model: row.model || "", cards: row.cards, builtAt: row.builtAt || "" };
  } catch {
    return null;
  }
}

/** 写某版的卡片缓存。写失败只影响下次速度，不影响这次结果。 */
export async function writeCardsCache(sdk, tag, { cards, publishedAt, model, promptVersion }) {
  const dir = dirOf(sdk);
  if (!dir || !tag || !Array.isArray(cards) || !cards.length) return;
  const prev = writing.get(dir) || Promise.resolve();
  const next = prev.then(async () => {
    try {
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, fileOf(tag));
      const tmp = `${file}.tmp`;
      await fs.writeFile(
        tmp,
        JSON.stringify({
          version: VERSION,
          promptVersion: typeof promptVersion === "number" ? promptVersion : null,
          tag,
          publishedAt: publishedAt || "",
          model: model || "",
          builtAt: new Date().toISOString(),
          cards,
        }),
        "utf8",
      );
      await fs.rename(tmp, file);
    } catch (error) {
      void sdk?.logger?.debug?.("更新手记卡片缓存没写下去", { error: String(error?.message || error).slice(0, 120) });
    }
  });
  writing.set(dir, next);
  await next;
}

/** 测试用：清掉进程内状态。 */
export function resetCardsCacheForTest() {
  writing.clear();
}
