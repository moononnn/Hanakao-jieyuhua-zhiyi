// 待审应用的图标。
//
// 为什么单独拉：图标只在上架之后才被写进市场目录（index.v2.json）。待审条目来自审批表，
// 那份里只有 id、版本标签、校验值和简介，没有图标字段。所以一个应用从提交申请到正式上架
// 之前，目录里没有它的任何图标可显示。
//
// 补的办法只有一条：去应用自己的仓库，读它候选提交里的 manifest.json，取 icon 字段。
// 纪律沿用页面既有的那套：只认 data:image 内嵌图，SVG 要过脚本与事件属性检查，
// 只读 raw.githubusercontent 的静态文件，不跟随重定向，失败一律返回空（前端退回字形）。
// 拉到的图按「仓库@提交」存本机，同一个候选版本只拉一次。

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { readGithubToken } from "./github-token.js";

const RAW_HOST = "raw.githubusercontent.com";
const CACHE_DIR = "market-icons";
// 判定规则一变就加一：旧的「没有图标」结论必须作废，否则规则放宽了也永远不会重试。
const CACHE_VERSION = 2;
const MAX_MANIFEST_BYTES = 512 * 1024;
// 单张图上限：卡面上只有 40px，但仓库里存的常常是整张原图。
// 700KB 以内容得下目前市场里最大的那几张（最大约 580KB），转 base64 后仍在一百万字符以内。
const MAX_ICON_BYTES = 700 * 1024;
// 内嵌图字符串的上限。字节上限与这个要一起看，只改一头会出现「图下来了但被拒掉」。
const MAX_ICON_CHARS = 1024 * 1024;
const MAX_CACHED_FILES = 200;
const REQUEST_TIMEOUT_MS = 15000;
const ICON_DATA_RE = /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;
// 拿图标用的是应用自己仓库的发布标签，不是市场仓库那个 PR 提交号。
// 标签不许带斜杠或跳目录，否则拼出来就是另一个路径了。
const REF_RE = /^[A-Za-z0-9._+-]{1,100}$/;
const MIME_BY_EXT = Object.freeze({
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
});

/** 页面只接受这种内嵌图：栅格图，或没有脚本与外链的 SVG。与目录图标同一把尺子。 */
export function safeDataIcon(value) {
  if (typeof value !== "string" || !value || value.length > MAX_ICON_CHARS) return "";
  if (!ICON_DATA_RE.test(value)) return "";
  if (!value.startsWith("data:image/svg+xml")) return value;
  // SVG 放进 img 不会执行脚本；这里再挡一层脚本标签、事件属性与外链。
  let text = "";
  try { text = Buffer.from(value.slice(value.indexOf(",") + 1), "base64").toString("utf8"); } catch { return ""; }
  if (!text) return "";
  return /<script|<foreignObject|on[a-z]+\s*=|xlink:href|\bhref\s*=\s*["']?https?:/i.test(text) ? "" : value;
}

function iconCacheFile(sdk, repo, ref) {
  const dir = typeof sdk?.dataDir === "string" ? sdk.dataDir.trim() : "";
  if (!dir) return "";
  const digest = crypto.createHash("sha1").update(`${repo}@${ref}`, "utf8").digest("hex").slice(0, 32);
  return path.join(dir, CACHE_DIR, `${digest}.json`);
}

async function readCache(sdk, repo, ref) {
  const file = iconCacheFile(sdk, repo, ref);
  if (!file) return null;
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (parsed?.version !== CACHE_VERSION) return null;
    // 空字符串也是结论（这个应用没有可用图标），跟「没拉过」分开记。
    return typeof parsed.icon === "string" ? parsed.icon : null;
  } catch {
    return null;
  }
}

async function writeCache(sdk, repo, ref, icon) {
  const file = iconCacheFile(sdk, repo, ref);
  if (!file) return;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: CACHE_VERSION, icon }), "utf8");
    await prune(sdk, path.dirname(file));
  } catch {
    // 存不下只影响下次速度，不影响这张图能不能显示。
  }
}

async function prune(sdk, dir) {
  try {
    const names = await fs.readdir(dir);
    if (names.length <= MAX_CACHED_FILES) return;
    const stats = await Promise.all(names.map(async (name) => {
      const file = path.join(dir, name);
      try { return { file, at: (await fs.stat(file)).mtimeMs }; } catch { return null; }
    }));
    const alive = stats.filter(Boolean).sort((a, b) => a.at - b.at);
    const drop = alive.slice(0, alive.length - Math.floor(MAX_CACHED_FILES * 0.7));
    await Promise.all(drop.map(({ file }) => fs.unlink(file).catch(() => {})));
  } catch {
    void sdk?.logger?.debug?.("图标缓存清理失败");
  }
}

async function fetchText(sdk, url, maxBytes, headers = { Accept: "*/*" }) {
  const fn = sdk?.network?.fetch;
  if (typeof fn !== "function") throw new Error("no network");
  const response = await fn(url, {
    method: "GET",
    redirect: "error",
    headers,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxResponseBytes: maxBytes,
  });
  if (!response?.ok) throw new Error(`HTTP ${Number(response?.status) || 0}`);
  return response;
}

function rawFile(repo, ref, filePath = "") {
  const tail = filePath ? `/${filePath.split("/").map((part) => encodeURIComponent(part)).join("/")}` : "";
  return `https://${RAW_HOST}/${repo}/${ref}${tail}`;
}

// manifest 里的 icon 只允许仓库内的相对路径，或者一张已经内嵌的 data 图。
function iconPathOf(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return "";
  if (trimmed.startsWith("./")) return iconPathOf(trimmed.slice(2));
  if (trimmed.includes("\\\\") || trimmed.startsWith("/")) return "";
  if (/^[a-z]+:/i.test(trimmed)) return "";
  return trimmed;
}

// 图标相对 manifest 所在目录解析；`../` 允许，但整体不能跑出仓库。
function resolveIconPath(base, rel) {
  const joined = path.posix.normalize(path.posix.join(base || ".", rel));
  if (!joined || joined === "." || joined.startsWith("..") || joined.startsWith("/")) return "";
  return joined;
}

// 有些应用的 manifest 不在仓库根（如 packages/app/src/manifest.json）。
// 先用根路径试，读不到再让 GitHub 的树接口找一次。树接口花 API 额度，
// 没填令牌时每小时只有 60 次，所以只在有令牌时才试，不把普通用户的额度吃光。
async function findManifestPath(sdk, repo, ref) {
  const token = readGithubToken(sdk);
  if (!token) return "";
  try {
    const response = await fetchText(
      sdk,
      `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
      MAX_MANIFEST_BYTES,
      { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
    );
    const tree = await response.json();
    const rows = Array.isArray(tree?.tree) ? tree.tree : [];
    const hits = rows
      .map((row) => (typeof row?.path === "string" ? row.path : ""))
      .filter((p) => /(^|\/)manifest\.json$/.test(p) && !p.includes("node_modules/"));
    if (!hits.length) return "";
    // 层级最浅的优先：根目录 > app/ > packages/app/src/。
    hits.sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length);
    return hits[0];
  } catch {
    return "";
  }
}

// 读 manifest，并带出它所在的目录（图标路径相对它解析）。
async function loadManifest(sdk, repo, ref) {
  try {
    const json = await (await fetchText(sdk, rawFile(repo, ref, "manifest.json"), MAX_MANIFEST_BYTES)).json();
    return { json, base: "" };
  } catch {
    // 根目录没有就往下找，不直接把结论定成「没有图标」。
  }
  const manifestPath = await findManifestPath(sdk, repo, ref);
  if (!manifestPath) return null;
  try {
    const json = await (await fetchText(sdk, rawFile(repo, ref, manifestPath), MAX_MANIFEST_BYTES)).json();
    return { json, base: path.posix.dirname(manifestPath) };
  } catch {
    return null;
  }
}

function mimeOf(iconPath) {
  const ext = path.extname(iconPath).toLowerCase();
  return MIME_BY_EXT[ext] || "";
}

/**
 * 读一个待审候选版本的图标。返回值一定是 data URI 或空字符串，绝不返回远端地址。
 * 拉过的按「仓库@发布标签」存本机，同一个版本只拉一次。
 */
export async function readPendingIcon(sdk, { repo, ref, id }) {
  if (typeof repo !== "string" || !repo.includes("/") || typeof ref !== "string" || !REF_RE.test(ref) || ref.includes("..")) return "";
  const cached = await readCache(sdk, repo, ref);
  if (cached !== null) return cached;

  let icon = "";
  try {
    const loaded = await loadManifest(sdk, repo, ref);
    const field = loaded?.json?.icon ?? loaded?.json?.logo ?? "";
    if (typeof field === "string" && field.startsWith("data:image/")) {
      icon = safeDataIcon(field);
    } else {
      const rel = iconPathOf(field);
      const mime = rel ? mimeOf(rel) : "";
      // 图标相对 manifest 所在目录解析：manifest 在子目录时，`../assets/x.png` 也说得通。
      const target = mime ? resolveIconPath(loaded?.base || "", rel) : "";
      if (target) {
        const raw = await fetchText(sdk, rawFile(repo, ref, target), MAX_ICON_BYTES);
        const buffer = Buffer.from(await raw.arrayBuffer());
        // 单张图标到 700KB 为止：既容得下市场里最大的那几张，也不会把一页拖垮。
        if (buffer.length > 0 && buffer.length <= MAX_ICON_BYTES) {
          icon = safeDataIcon(`data:${mime};base64,${buffer.toString("base64")}`);
        }
      }
    }
  } catch (error) {
    void sdk?.logger?.debug?.("待审图标没读到", { id: String(id || "").slice(0, 60), error: String(error?.message || error).slice(0, 80) });
    icon = "";
  }
  await writeCache(sdk, repo, ref, icon);
  return icon;
}
