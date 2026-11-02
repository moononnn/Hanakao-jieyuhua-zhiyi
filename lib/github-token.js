// 可选的 GitHub 令牌。
//
// 默认不填：读公开数据走 GitHub 公共接口，每小时 60 次，够用但容易撞限流。
// 用户自己填一个只读令牌后，api.github.com 的读请求带上认证，额度提到每小时 5000 次。
//
// 纪律：令牌只来自知意自己的设置（manifest 的 contributes.settings）或本机预置文件，
// 不从环境变量猜、不落盘到仓库、不写进日志、不出现在页面回包与错误文案里；
// 只用于读公开数据，不用于任何写操作。
import fs from "node:fs";
import path from "node:path";

const TOKEN_KEY = "githubToken";
const API_ORIGIN = "https://api.github.com";
// github_pat_ / ghp_ / gho_ 等都是 40 位以上的字母数字下划线组合。
const TOKEN_RE = /^[A-Za-z0-9_]{20,255}$/;
const FILE_NAME = "github-token.txt";
let fileCache = { dir: "", stamp: "", value: "" };

// 本机预置：把只读令牌放进知意自己的数据目录（sdk.dataDir/github-token.txt），
// 不必打开设置页也能用；设置页里的值优先。文件变了（修改时间或大小）就重读。
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

export function readGithubToken(sdk) {
  let raw = "";
  try {
    const configured = sdk?.config?.get?.(TOKEN_KEY);
    if (typeof configured === "string" && configured.trim()) raw = configured.trim();
  } catch {
    // 宿主没给设置接口：退回本机预置文件，再退回匿名。
  }
  if (!raw) raw = readTokenFile(sdk);
  if (!raw || !TOKEN_RE.test(raw)) return "";
  return raw;
}

// 只有打向 api.github.com 的请求才带令牌；raw.githubusercontent.com 是公开静态文件，不需要。
export function githubHeaders(sdk, base = {}, url = "") {
  const headers = { ...base };
  if (typeof url === "string" && url.startsWith(API_ORIGIN)) {
    const token = readGithubToken(sdk);
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function isRateLimited(status) {
  return status === 403 || status === 429;
}

export function rateLimitMessage() {
  return "GitHub 拒绝了这次请求。公共接口每小时只有 60 次请求额度，撞上限就是这样；可在知意设置里填一个只读令牌，额度提高到每小时 5000 次。";
}
