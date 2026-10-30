// 运行时瞬态：面板状态、标题撤销记录这类“丢了顶多空一下”的东西。
//
// 为什么不放 sdk.storage.global：那是知意唯一一份大账本，二十多个键全在一个 JSON 里。
// Hana 的 app storage 每改一个键都要把整本重抄一遍，账本 24KB，
// 于是每写一条临时的面板状态，都要背着全部设置重写一次磁盘文件。
// 2026-10-30 那次意外断电，正好落在这样一次重写里，整本账本被写成 24861 个 0x00。
// 瞬态搬出来以后，账本只在真正改设置时才动笔，撞上断电的机会就少了一个数量级。
//
// 代价是这些数据不再享受宿主 storage 的备份与跨端同步——它们本来也不该有。

import fs from "node:fs/promises";
import path from "node:path";

const FILE_NAME = "runtime-state.json";
const cache = new Map();   // 文件路径 -> 整个对象
const writing = new Map(); // 文件路径 -> 上一次写的 Promise

function resolvePath(sdk) {
  const dir = typeof sdk?.dataDir === "string" ? sdk.dataDir.trim() : "";
  return dir ? path.join(dir, FILE_NAME) : "";
}

async function loadAll(sdk) {
  const file = resolvePath(sdk);
  if (!file) return {};
  if (cache.has(file)) return cache.get(file);
  let value = {};
  try {
    const text = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed;
  } catch {
    // 文件不存在、上半截没写完、被别的程序占着，都从空开始。
    // 这些是瞬态，宁可丢，不能把调用方拖进异常。
  }
  cache.set(file, value);
  return value;
}

/** 读一条瞬态。没有就返回 fallback。 */
export async function readRuntimeState(sdk, key, fallback = null) {
  const all = await loadAll(sdk);
  return Object.prototype.hasOwnProperty.call(all, key) ? all[key] : fallback;
}

/** 写一条瞬态。写失败不抛，只记一笔调试日志。 */
export async function writeRuntimeState(sdk, key, value) {
  const file = resolvePath(sdk);
  if (!file) return;
  const all = await loadAll(sdk);
  all[key] = value;
  // 串行：并发写同一个文件会互相截断，面板在一轮里可能连着写两次。
  const prev = writing.get(file) || Promise.resolve();
  const next = prev.then(async () => {
    try {
      await fs.writeFile(file, JSON.stringify(all, null, 2), "utf8");
    } catch (error) {
      void sdk?.logger?.debug?.("运行时状态没写下去", { error: String(error?.message || error).slice(0, 120) });
    }
  });
  writing.set(file, next);
  await next;
}
