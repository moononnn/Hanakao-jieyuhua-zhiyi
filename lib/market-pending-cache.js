// 待审扫描的本地结果缓存。
//
// 为什么可以缓存：一个 commit 的内容永远不变，同一个 head+base 扫出来的「哪些应用带了新版本」
// 也不会变。所以扫过一次就存下来，下次打开雷达只读新增或改过的申请——这一项能把
// 「每开一次都重下几十份审批表」变成「只补读新来的两三个」。
//
// 存什么、不存什么：只存我们自己算出来的摘要（应用 ID、版本、标签、校验值、抓来的简介），
// 不存 readme 全文，不存本机安装状态（安装状态每次按当下的本机情况重算）。
// 丢了顶多多扫一次，不会把「没扫到」当成「没有待审」。
//
// 版本号变了就整批作废：判定规则一改，旧结论一律不再复用。

import fs from "node:fs";
import path from "node:path";

const FILE_NAME = "market-pending-cache.json";
const FILE_VERSION = 1;
const MAX_ENTRIES = 240;
const stamped = new Map(); // 文件路径 -> { version, entries: Map }
const writing = new Map();

function resolvePath(sdk) {
  const dir = typeof sdk?.dataDir === "string" ? sdk.dataDir.trim() : "";
  return dir ? path.join(dir, FILE_NAME) : "";
}

function load(sdk) {
  const file = resolvePath(sdk);
  if (!file) return null;
  if (stamped.has(file)) return stamped.get(file);
  const state = { version: FILE_VERSION, entries: new Map() };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    // 版本对不上就当没有：宁可重扫，不能把旧规则算出的结论当新结论用。
    if (parsed?.version === FILE_VERSION && parsed.entries && typeof parsed.entries === "object") {
      for (const [key, rows] of Object.entries(parsed.entries)) {
        if (typeof key === "string" && Array.isArray(rows)) state.entries.set(key, rows);
      }
    }
  } catch {
    // 文件不在、读不动、上半截是坏 JSON：从空开始，不影响扫描本身。
  }
  stamped.set(file, state);
  return state;
}

/** 读一条缓存；没有就返回 null。 */
export function readPendingCache(sdk, key) {
  if (typeof key !== "string" || !key) return null;
  const state = load(sdk);
  const rows = state?.entries.get(key);
  return Array.isArray(rows) ? rows : null;
}

/** 写一条缓存（只进内存）。真正落盘由调用方在一轮扫完后调 `flushPendingCache`。 */
export function writePendingCache(sdk, key, rows) {
  if (typeof key !== "string" || !key || !Array.isArray(rows)) return;
  const state = load(sdk);
  if (!state) return;
  // 重新插入一次，让 Map 的顺序就是新旧顺序，淘汰时先丢最旧的。
  state.entries.delete(key);
  state.entries.set(key, rows);
  while (state.entries.size > MAX_ENTRIES) {
    const oldest = state.entries.keys().next().value;
    state.entries.delete(oldest);
  }
}

export function flushPendingCache(sdk) {
  return flush(sdk);
}

async function flush(sdk) {
  const file = resolvePath(sdk);
  const state = stamped.get(file);
  if (!file || !state) return;
  const prev = writing.get(file) || Promise.resolve();
  const next = prev.then(async () => {
    const payload = JSON.stringify({ version: state.version, entries: Object.fromEntries(state.entries) });
    try {
      await fs.promises.writeFile(file, payload, "utf8");
    } catch (error) {
      void sdk?.logger?.debug?.("待审缓存没写下去", { error: String(error?.message || error).slice(0, 120) });
    }
  });
  writing.set(file, next);
  await next;
}

/** 测试用：清掉进程内缓存，重读磁盘。 */
export function resetPendingCacheForTest() {
  stamped.clear();
  writing.clear();
}
