// 市场目录的本地缓存。
//
// 为什么能缓存：一个 commit 的内容永远不变。目录（index/registry/approvals）只在市场
// 有人合并之后才换 commit，而市场主分支一天才同步一次——所以同一个 commit 反复下载
// 那个近 5MB 的索引，纯属白跑。
//
// 缓存键就是 commit：先问一次主分支的提交标识（几百字节），对得上就直接读本地三份文件，
// 对不上才重新下载。这个「先问再定」不省那次 API 请求，但省掉整份索引的下载与解析。
//
// 存的是原始 JSON，不存我们加工过的 Map：读取时仍走同一条解析路径，
// 目录的校验与跳过规则不会因为「来自缓存」而变松。

import fs from "node:fs/promises";
import path from "node:path";

const DIR_NAME = "market-cache";
const VERSION = 1;
const FILES = { index: "index.v2.json", registry: "registry.json", approvals: "approvals.json", meta: "meta.json" };
const writing = new Map(); // 目录路径 -> 上一次写的 Promise

function dirOf(sdk) {
  const base = typeof sdk?.dataDir === "string" ? sdk.dataDir.trim() : "";
  return base ? path.join(base, DIR_NAME) : "";
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

/**
 * 读某个 commit 的目录缓存。
 * 命中返回 { index, registry, approvals }；任何一项读不出、或格式对不上，都返回 null（当没缓存）。
 */
export async function readCatalogCache(sdk, commit) {
  const dir = dirOf(sdk);
  if (!dir || typeof commit !== "string" || !commit) return null;
  try {
    const meta = await readJson(path.join(dir, FILES.meta));
    if (meta?.version !== VERSION || meta?.commit !== commit) return null;
    const [index, registry, approvals] = await Promise.all([
      readJson(path.join(dir, FILES.index)),
      readJson(path.join(dir, FILES.registry)),
      readJson(path.join(dir, FILES.approvals)),
    ]);
    if (!index || !registry || !approvals) return null;
    return { index, registry, approvals };
  } catch {
    // 文件不在、写了一半、JSON 坏了、磁盘读不了：都当没缓存，重新下载即可。
    return null;
  }
}

/** 写目录缓存。失败只影响下次速度，不影响本次结果。 */
export async function writeCatalogCache(sdk, commit, payload) {
  const dir = dirOf(sdk);
  if (!dir || typeof commit !== "string" || !commit || !payload) return;
  const prev = writing.get(dir) || Promise.resolve();
  const next = prev.then(async () => {
    try {
      await fs.mkdir(dir, { recursive: true });
      // 三份正文先落盘，meta 最后写：meta 一旦指向新 commit，三份就一定齐了。
      await writeAtomic(path.join(dir, FILES.index), payload.index);
      await writeAtomic(path.join(dir, FILES.registry), payload.registry);
      await writeAtomic(path.join(dir, FILES.approvals), payload.approvals);
      await writeAtomic(path.join(dir, FILES.meta), { version: VERSION, commit, savedAt: new Date().toISOString() });
    } catch (error) {
      void sdk?.logger?.debug?.("市场目录缓存没写下去", { error: String(error?.message || error).slice(0, 120) });
    }
  });
  writing.set(dir, next);
  await next;
}

async function writeAtomic(file, value) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), "utf8");
  // 先写临时文件再改名：写到一半断电也不会把上一份好文件顶掉。
  await fs.rename(tmp, file);
}

/** 测试用：清掉进程内状态。 */
export function resetCatalogCacheForTest() {
  writing.clear();
}
