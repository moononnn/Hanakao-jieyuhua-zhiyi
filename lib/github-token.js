// 可选的 GitHub 令牌。
//
// 默认不填：读公开数据走 GitHub 公共接口，每小时 60 次，够用但容易撞限流。
// 用户自己填一个只读令牌后，api.github.com 的读请求带上认证，额度提到每小时 5000 次。
//
// 纪律：令牌只来自知意自己（面板上的输入框，或本机预置文件），不从环境变量猜、
// 不落盘到仓库、不写进日志、不出现在页面回包与错误文案里；
// 只用于读公开数据，不用于任何写操作。
//
// 2026-11-05：这个令牌原来是 Hana 应用设置里唯一的一项，孤零零占一格。
// 现在挪进知意自己的面板，值改成 DPAPI 加密后存进 App 存储（githubTokenSealed）。
// 以前存在 Hana 设置里的老值会在启动时读出来迁过去，人不用重填一遍。
import fs from "node:fs";
import path from "node:path";
import { protectKey, unprotectKey } from "./crypto.js";

const TOKEN_KEY = "githubToken";
const SEALED_KEY = "githubTokenSealed";
const API_ORIGIN = "https://api.github.com";
// github_pat_ / ghp_ / gho_ 等都是 40 位以上的字母数字下划线组合。
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const FILE_NAME = "github-token.txt";
let fileCache = { dir: "", stamp: "", value: "" };

// 解出来的明文只活在内存里。githubHeaders 是同步函数（十几处调用），
// 不能为了解密把它改成异步，所以启动时解一次，之后都走这份缓存。
let memory = { token: "", loaded: false };

// 本机预置：把只读令牌放进知意自己的数据目录（sdk.dataDir/github-token.txt），
// 不必打开面板也能用；面板里存的值优先。文件变了（修改时间或大小）就重读。
function readTokenFile(sdk) {
  const dir = typeof sdk?.dataDir === "string" ? sdk.dataDir : "";
  if (!dir) return "";
  let stat = null;
  let value = "";
  try {
    const file = path.join(dir, FILE_NAME);
    stat = fs.statSync(file);
    if (stat.isFile() && stat.size <= 4096) value = fs.readFileSync(file, "utf8").trim();
  } catch {
    stat = null;
    value = "";
  }
  const stamp = stat ? `${stat.mtimeMs}:${stat.size}` : "";
  if (fileCache.dir === dir && fileCache.stamp === stamp) return fileCache.value;
  fileCache = { dir, stamp, value };
  return value;
}

/** 老位置：Hana 应用设置里那一项（0.3.2 及以前）。读不到就返回空。 */
function readLegacyConfigToken(sdk) {
  try {
    const configured = sdk?.config?.get?.(TOKEN_KEY);
    if (typeof configured !== "string") return "";
    return configured.trim();
  } catch {
    return "";
  }
}

/**
 * App 启动时调一次：把已保存的令牌解进内存，顺手把老位置的值迁过来。
 * 返回是否拿到了可用令牌。系统加密不可用时不清旧值，下一次启动还能再试。
 */
export async function loadGithubToken(sdk) {
  memory = { token: "", loaded: true };
  let sealed = "";
  try {
    sealed = String((await sdk?.storage?.global?.get?.(SEALED_KEY, "")) || "");
  } catch {
    sealed = "";
  }
  if (sealed) {
    const plain = await unprotectKey(sealed).catch(() => "");
    if (plain && TOKEN_RE.test(plain)) {
      memory.token = plain;
      return true;
    }
  }
  const legacy = readLegacyConfigToken(sdk);
  if (!legacy || !TOKEN_RE.test(legacy)) return false;
  try {
    await sdk?.storage?.global?.set?.(SEALED_KEY, await protectKey(legacy));
  } catch {
    // 系统加密这会儿不可用：本次照旧用它，旧位置的值留着，别把人家的令牌弄丢。
  }
  memory.token = legacy;
  return true;
}

/** 同步读当前的令牌：内存 → 老设置 → 本机文件。拿不到就是空串。 */
export function readGithubToken(sdk) {
  if (memory.token) return memory.token;
  const legacy = readLegacyConfigToken(sdk);
  if (legacy && TOKEN_RE.test(legacy)) return legacy;
  const fromFile = readTokenFile(sdk);
  return fromFile && TOKEN_RE.test(fromFile) ? fromFile : "";
}

/**
 * 保存或清除令牌。空串表示清掉。
 * 加密失败会抛错（crypto.protectKey 的约定），调用方要如实告诉人没存上。
 */
export async function saveGithubToken(sdk, raw) {
  const value = String(raw ?? "").trim();
  if (!value) {
    await sdk?.storage?.global?.set?.(SEALED_KEY, "");
    memory = { token: "", loaded: true };
    return { ok: true, configured: false };
  }
  if (!TOKEN_RE.test(value)) {
    return { ok: false, error: "这串不像 GitHub 令牌：应是 20 位以上的字母、数字或下划线，不含空格。" };
  }
  const sealed = await protectKey(value);
  await sdk?.storage?.global?.set?.(SEALED_KEY, sealed);
  memory = { token: value, loaded: true };
  return { ok: true, configured: true };
}

/** 给界面看的状态：只说有没有、从哪儿来、末四位，不回显明文。 */
export function describeGithubToken(sdk) {
  const token = readGithubToken(sdk);
  if (!token) return { configured: false, source: "none", tail: "" };
  let source = "file";
  if (memory.token) source = "app";
  else if (readLegacyConfigToken(sdk)) source = "legacy";
  return { configured: true, source, tail: token.slice(-4) };
}

// 只有打向 api.github.com 的请求才带令牌；raw.githubusercontent.com 是公开静态文件，不需要。
export function githubHeaders(sdk, base = {}, url = "") {
  const headers = { ...base };
  let isGithubApi = false;
  try {
    const parsed = new URL(String(url || ""));
    isGithubApi = parsed.origin === API_ORIGIN && !parsed.username && !parsed.password;
  } catch { /* Invalid URLs must never receive a token. */ }
  if (isGithubApi) {
    const token = readGithubToken(sdk);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function isRateLimited(status) {
  return status === 403 || status === 429;
}

export function rateLimitMessage() {
  return "GitHub 拒绝了这次请求。公共接口每小时只有 60 次请求额度，撞上限就是这样；可在知意面板「模型和接口 → GitHub 的通行证」里填一个只读令牌，额度提高到每小时 5000 次。";
}
