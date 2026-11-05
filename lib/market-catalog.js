// 市场目录：只读公开数据。不下载安装包、不执行候选代码、不写任何仓库侧的外部状态。
// 待审扫描的结论会按不变的 head+base 存在本机 dataDir（lib/market-pending-cache.js），
// 目的是不再每开一次雷达都重下几十份审批表；那份缓存丢了只会重扫，不会改变判定。
//
// 数据链路固定在同一 main commit：
//   GET api.github.com/repos/liliMozi/hana-marketplace/git/ref/heads/main -> commit
//   GET raw.githubusercontent.com/liliMozi/hana-marketplace/{commit}/index.v2.json
//                                                        .../{commit}/registry.json
//                                                        .../{commit}/approvals.json
// 三份同 commit，避免目录与审批摘要来自不同快照。
//
// 待审 PR 取 PR 自己的 base.sha 与 head.sha 各一份 registry+approvals 做差集。
// 不拿候选 head 直接和当前 main 比：base 落后 main 时，那种比法会把 base 期间
// 别人合并的旧差异算到这个 PR 头上。
import { githubHeaders, isRateLimited, rateLimitMessage } from "./github-token.js";
import { flushPendingCache, readPendingCache, writePendingCache } from "./market-pending-cache.js";
import { readCatalogCache, writeCatalogCache } from "./market-cache.js";
import { readPendingIcon, safeDataIcon } from "./market-icons.js";

const MARKET_REPO = "liliMozi/hana-marketplace";
const MARKET_BRANCH = "main";
const API_HOST = "api.github.com";
const RAW_HOST = "raw.githubusercontent.com";
const CACHE_TTL_MS = 10 * 60 * 1000;
// 并发按「同时在飞的请求」算，不按「同时在处理的申请」算。
// 实测同一批 raw 请求：并发 10 跑 40 个 approvals 要 4.6 秒，并发 20 只要 2.4 秒，
// 说明瓶颈是请求的往返次数，不是带宽。按申请分轮排队会让每个申请白等上一轮结束。
const REQUEST_CONCURRENCY = 16;
const PENDING_DEADLINE_MS = 40000;
const PR_PAGE_SIZE = 100;
// 扫描上限放到 100：开放申请一般就几十个，一次能看完，不再因为「只看了 40 个」
// 而把较早的申请当不存在。超过 100 的少数情况仍会明说不全。
const PR_SCAN_LIMIT = 100;
const MAX_PR_PAGES = 2;
const MAX_INDEX_BYTES = 7 * 1024 * 1024;
const MAX_SMALL_JSON_BYTES = 2 * 1024 * 1024;
const MAX_WARNINGS = 60;
const MAX_CANDIDATES_PER_PR = 30;
const MAX_ICONS_PER_CALL = 12;
const SNAPSHOT_CACHE_LIMIT = 48;
const SNAPSHOTS = Object.freeze(["index.v2.json", "registry.json", "approvals.json"]);
// 只有网络抖断和 5xx 值得重发一次；限流、404、JSON 坏了重发也还是那样，白占额度。
// 超时不重发：封顶已经等到头了，再等一轮只会把页面拖得更久。
const RETRYABLE_FAILURE = /读取市场数据失败：|HTTP 5\d\d/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_RE = /^[a-f0-9]{40}$/i;

function warningsBucket(limit = MAX_WARNINGS) {
  const list = [];
  const seen = new Set();
  let dropped = 0;
  return {
    add(text) {
      const value = String(text || "").trim();
      if (!value || seen.has(value)) return;
      if (list.length >= limit) { dropped += 1; return; }
      seen.add(value);
      list.push(value);
    },
    snapshot() {
      return dropped ? [...list, `另有 ${dropped} 条提示未列出。`] : [...list];
    },
  };
}

// 一个最小的并发闸门：超过上限的请求排队，前面的落地一个就放一个进去。
// 它不管业务，只管「同时间最多几个请求在路上」，所以申请之间不再互相排队。
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < max && queue.length) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(job.task)
        .then(job.resolve, job.reject)
        .finally(() => { active -= 1; pump(); });
    }
  };
  return (task) => new Promise((resolve, reject) => { queue.push({ task, resolve, reject }); pump(); });
}

export class MarketCatalogError extends Error {}
function fail(message) { return new MarketCatalogError(message); }

// 同时约束 SDK 调用和响应体读取，不能只依赖远端 fetch 的超时选项。
function bounded(task, timeoutMs, message) {
  let timer;
  return Promise.race([
    Promise.resolve().then(task),
    new Promise((_, reject) => { timer = setTimeout(() => reject(fail(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function describeError(error) {
  return error instanceof MarketCatalogError ? error.message : "网络不可用、权限被拒或远端返回异常";
}

function assertRepo(repo) {
  if (typeof repo !== "string" || !REPO_RE.test(repo) || repo.includes("..")) throw fail("这个应用的仓库名无效。");
  return repo;
}

function assertCommit(commit) {
  if (typeof commit !== "string" || !COMMIT_RE.test(commit)) throw fail("市场快照的提交标识无效。");
  return commit;
}

// 只允许本模块自己拼出的三份文件与 api.github.com/repos 路径，key 永远不参与拼接。
function rawUrl(repo, commit, file) {
  if (!SNAPSHOTS.includes(file)) throw fail("市场文件不在允许范围内。");
  return `https://${RAW_HOST}/${assertRepo(repo)}/${assertCommit(commit)}/${file}`;
}

function apiUrl(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/repos/") || /[\r\n]/.test(pathname)) throw fail("市场接口路径无效。");
  return `https://${API_HOST}${pathname}`;
}

async function fetchJson(sdk, url, maxBytes) {
  const timeoutMs = maxBytes === MAX_INDEX_BYTES ? 35000 : 15000;
  return bounded(() => readJson(sdk, url, maxBytes, timeoutMs), timeoutMs, maxBytes === MAX_INDEX_BYTES ? "市场索引读取超时，请稍后重试。" : "读取市场数据超时，请稍后重试。");
}

async function readJson(sdk, url, maxBytes, timeoutMs) {
  const fetchFn = sdk?.network?.fetch;
  if (typeof fetchFn !== "function") throw fail("Hana 尚未提供受控网络接口，无法读取市场目录。");
  let response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      redirect: "error",
      headers: githubHeaders(sdk, { Accept: "application/vnd.github+json" }, url),
      timeoutMs,
      maxResponseBytes: maxBytes,
    });
  } catch (error) {
    throw fail(`读取市场数据失败：${describeError(error)}`);
  }
  if (!response?.ok) {
    const status = Number(response?.status) || 0;
    throw fail(isRateLimited(status) ? rateLimitMessage() : `读取市场数据失败（HTTP ${status || "未知"}）。`);
  }
  try {
    return await response.json();
  } catch {
    throw fail("市场数据不是有效 JSON。");
  }
}

export function parseMarketVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value.trim());
  if (!match) return null;
  const core = match.slice(1, 4);
  const prerelease = match[4] ? match[4].split(".") : [];
  if (core.some((part) => /^0\d/.test(part) || !Number.isSafeInteger(Number(part)))
    || prerelease.some((part) => !part || /^0\d+$/.test(part))) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

// 严格 semver 比较：预发布段按段比，数字段按数值、字母段按字典序，数字段小于字母段，
// 无预发布大于有预发布。任何一段解析不了就返回 null（调用方置 unknown，不猜）。
export function compareMarketVersions(left, right) {
  const a = parseMarketVersion(left);
  const b = parseMarketVersion(right);
  if (!a || !b) return null;
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const l = a.prerelease[index];
    const r = b.prerelease[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (lNum && rNum) {
      if (l !== r) return l.length !== r.length ? (l.length > r.length ? 1 : -1) : l > r ? 1 : -1;
    } else if (lNum) return -1;
    else if (rNum) return 1;
    else if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

function tagFromReleaseUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 6 || parts[2] !== "releases" || parts[3] !== "download") return null;
    const tag = decodeURIComponent(parts[4] || "");
    return tag && tag.length <= 200 ? tag : null;
  } catch {
    return null;
  }
}

function repoFromUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 2) return null;
    const repo = `${parts[0]}/${parts[1]}`;
    return REPO_RE.test(repo) && !repo.includes("..") ? repo : null;
  } catch {
    return null;
  }
}

function versionFromTag(tag) {
  const parsed = parseMarketVersion(String(tag || "").replace(/^v/i, ""));
  if (!parsed) return null;
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease.length ? `${base}-${parsed.prerelease.join(".")}` : base;
}

function readmeSummary(readme) {
  const text = typeof readme === "string" ? readme.replace(/<[^>]+>/g, " ") : "";
  const nameLines = [];
  const bodyLines = [];
  let chars = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,2}\s+(.+)$/.exec(line);
    if (heading) { if (!nameLines.length) nameLines.push(heading[1].trim()); continue; }
    if (/^#{1,6}\s+/.test(line)) continue;
    if (/^(?:[>|<`*\-_]|\d+\.\s)/.test(line)) continue;
    bodyLines.push(line.replace(/\s+/g, " "));
    chars += line.length;
    if (chars > 220) break;
  }
  return {
    name: (nameLines[0] || "").slice(0, 80),
    description: bodyLines.join(" ").slice(0, 220),
  };
}

export function createMarketCatalog(sdk) {
  const state = {
    cache: null,
    expiresAt: 0,
    loading: null,
    pendingLoading: null,
    installed: null,
    snapshots: new Map(),
    pendingIndex: new Map(),
    limit: createLimiter(REQUEST_CONCURRENCY),
  };

  // 所有网络请求都走这一道：先排队拿并发名额，再跑。
  // 单次封顶不变（索引 35 秒、小文件 15 秒）；网络抖断与 5xx 再多给一次机会，超时不重发。
  async function fetchWithRetry(url, maxBytes) {
    const once = () => state.limit(() => fetchJson(sdk, url, maxBytes));
    try {
      return await once();
    } catch (error) {
      if (!(error instanceof MarketCatalogError) || !RETRYABLE_FAILURE.test(error.message)) throw error;
      return once();
    }
  }

  // 待审条目自己口袋里的坐标：要在前端补图标时，需要的只是仓库和发布标签。
  // 标签是应用仓库里的那个版本号，不是市场仓库里 PR 的提交号——两者不是一回事。
  function rememberPendingRows(rows) {
    for (const row of rows || []) {
      if (!row || typeof row.key !== "string" || !row.repo || !row.tag) continue;
      state.pendingIndex.set(row.key, { repo: row.repo, ref: row.tag, id: row.id });
    }
  }

  // 前端只给当前页里看得见的待审条目要图标，一次最多一批。
  // 没拉到的（没登记、已经过期、仓库读不到）返回空字符串，页面继续用首字占位。
  async function pendingIcons(keys) {
    if (!Array.isArray(keys) || !keys.length) throw fail("没有要读取图标的条目。");
    if (keys.length > MAX_ICONS_PER_CALL) throw fail(`一次最多取 ${MAX_ICONS_PER_CALL} 个图标。`);
    const targets = [];
    const seen = new Set();
    for (const key of keys) {
      if (typeof key !== "string" || key.length > 240 || !key.startsWith("pending:app:") || seen.has(key)) continue;
      const row = state.pendingIndex.get(key);
      if (!row) continue;
      seen.add(key);
      targets.push({ key, ...row });
    }
    const icons = {};
    await Promise.all(targets.map(async (target) => {
      icons[target.key] = await readPendingIcon(sdk, target);
    }));
    return { icons };
  }

  function rememberSnapshot(key, value) {
    state.snapshots.set(key, value);
    while (state.snapshots.size > SNAPSHOT_CACHE_LIMIT) {
      const oldest = state.snapshots.keys().next().value;
      state.snapshots.delete(oldest);
    }
  }

  async function readMainCommit() {
    const payload = await fetchWithRetry(apiUrl(`/repos/${MARKET_REPO}/git/ref/heads/${MARKET_BRANCH}`), MAX_SMALL_JSON_BYTES);
    const commit = payload?.object?.sha;
    if (!COMMIT_RE.test(String(commit || ""))) throw fail("市场主分支的提交标识无效，未读取目录。");
    return String(commit);
  }

  // mode 控制读哪几份：目录要三份全读；比对候审只需要审批表，
  // 登记表等确认了这个申请真带应用之后再补读，无关申请就不必下载它。
  const SNAPSHOT_FILES = Object.freeze({
    full: SNAPSHOTS,
    approvals: ["approvals.json"],
    registry: ["registry.json"],
  });

  function readSnapshot(repo, commit, bucket, mode = "full") {
    const files = SNAPSHOT_FILES[mode] || SNAPSHOT_FILES.full;
    const key = `${repo}@${commit}@${mode}`;
    const cached = state.snapshots.get(key);
    if (cached) return cached;
    const task = (async () => {
      // 目录那一次先看本地有没有这个 commit 的存档：市场一天才同步一次，
      // 命中就直接读盘，省疯近 5MB 的索引下载。
      const local = mode === "full" && repo === MARKET_REPO ? await readCatalogCache(sdk, commit) : null;
      const map = local
        ? new Map([["index.v2.json", local.index], ["registry.json", local.registry], ["approvals.json", local.approvals]])
        : await downloadSnapshot(repo, commit, files);
      // 不阻塞本次返回；写失败只影响下次速度。
      if (!local && mode === "full" && repo === MARKET_REPO) {
        void writeCatalogCache(sdk, commit, {
          index: map.get("index.v2.json"),
          registry: map.get("registry.json"),
          approvals: map.get("approvals.json"),
        });
      }
      return {
        commit,
        index: map.get("index.v2.json") || null,
        registry: map.has("registry.json") ? indexRegistry(map.get("registry.json"), bucket) : null,
        approvals: map.has("approvals.json") ? indexApprovals(map.get("approvals.json"), bucket) : null,
      };
    })();
    task.catch(() => state.snapshots.delete(key));
    rememberSnapshot(key, task);
    return task;
  }

  async function downloadSnapshot(repo, commit, files) {
    const payloads = await Promise.all(files.map(async (file) => {
      const maxBytes = file === "index.v2.json" ? MAX_INDEX_BYTES : MAX_SMALL_JSON_BYTES;
      return [file, await fetchWithRetry(rawUrl(repo, commit, file), maxBytes)];
    }));
    return new Map(payloads);
  }

  function indexRegistry(raw, bucket) {
    const map = new Map();
    const entries = raw?.entries;
    if (!Array.isArray(entries)) { bucket.add("登记表格式不完整，已按空表处理。"); return map; }
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.kind !== "app") continue;
      if (typeof entry.id !== "string" || !entry.id) continue;
      map.set(`app:${entry.id}`, { id: entry.id, repo: repoFromUrl(`https://github.com/${entry.repository || ""}`), publisher: entry.publisher });
    }
    return map;
  }

  function indexApprovals(raw, bucket) {
    const map = new Map();
    const rows = raw?.approvals;
    if (!Array.isArray(rows)) { bucket.add("审批表格式不完整，已按空表处理。"); return map; }
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      if (row.kind !== "app") continue;
      if (typeof row.id !== "string" || !row.id) continue;
      if (typeof row.tag !== "string" || !row.tag) continue;
      if (!/^[a-f0-9]{64}$/.test(String(row.sha256 || ""))) continue;
      map.set(`app:${row.id}`, { id: row.id, tag: row.tag, sha256: String(row.sha256), readme: typeof row.readme === "string" ? row.readme : "" });
    }
    return map;
  }

  function displayIcon(value) {
    // 只展示索引里自带的 data 图：不请求第三方图像，也不认远端 URL 或文件路径。
    // 具体尺子与待审图标共用一份（lib/market-icons.js 的 safeDataIcon）。
    return safeDataIcon(value);
  }

  let installedPending = null;
  // 目录与候审现在会同时发起，两边都要本机安装信息；共享一次调用，不各读一遍。
  function installedLookup() {
    if (installedPending) return installedPending;
    const fn = sdk?.environments?.listInstalledSources;
    if (typeof fn !== "function") return Promise.resolve({ status: "unavailable", byId: new Map() });
    installedPending = bounded(() => fn.call(sdk.environments, { kind: "app" }), 3000, "读取安装信息超时。")
      .then((rows) => {
        if (!Array.isArray(rows)) return { status: "unavailable", byId: new Map() };
        const byId = new Map();
        const names = new Map();
        for (const row of rows) {
          if (!row || typeof row.id !== "string" || !row.id || (row.kind && row.kind !== "app")) continue;
          byId.set(row.id, typeof row.version === "string" && row.version ? row.version : "版本未知");
          names.set(row.id, typeof row.name === "string" && row.name ? row.name : row.id);
        }
        return { status: "available", byId, names };
      })
      .catch(() => ({ status: "unavailable", byId: new Map() }))
      .finally(() => { installedPending = null; });
    return installedPending;
  }

  function statusFor(item, installed) {
    if (installed.status !== "available") return { installed: null, installedVersion: null, updateStatus: "unknown" };
    if (!installed.byId.has(item.id)) return { installed: false, installedVersion: null, updateStatus: "unknown" };
    const installedVersion = installed.byId.get(item.id);
    if (!item.version) return { installed: true, installedVersion, updateStatus: "unknown" };
    const compared = compareMarketVersions(item.version, installedVersion);
    const updateStatus = compared === null ? "unknown" : compared > 0 ? "newer" : compared === 0 ? "current" : "different";
    return { installed: true, installedVersion, updateStatus };
  }

  function marketItem(entry, registry, approvals, bucket, installed) {
    const key = `app:${entry.id}`;
    const registered = registry.get(key);
    const approval = approvals.get(key);
    if (!registered?.repo) {
      bucket.add(`目录条目 ${entry.id} 在登记表里找不到对应仓库，已跳过。`);
      return null;
    }
    const tag = tagFromReleaseUrl(entry?.archive?.url);
    if (!tag) {
      bucket.add(`目录条目 ${entry.id} 的下载地址不是 GitHub Release 资产，已跳过。`);
      return null;
    }
    if (!/^[a-f0-9]{64}$/.test(String(entry?.archive?.sha256 || ""))) {
      bucket.add(`目录条目 ${entry.id} 缺少有效的包校验值，已跳过。`);
      return null;
    }
    if (!approval) bucket.add(`目录条目 ${entry.id} 没有审批记录，校验值未获独立核对。`);
    else {
      if (approval.tag !== tag) bucket.add(`目录条目 ${entry.id} 的发布标签与审批记录不一致。`);
      if (approval.sha256 !== entry.archive.sha256) bucket.add(`目录条目 ${entry.id} 的包校验值与审批记录不一致。`);
    }
    const version = typeof entry.version === "string" && entry.version ? entry.version : null;
    if (!version) bucket.add(`目录条目 ${entry.id} 没有版本号，更新状态无法判断。`);
    return {
      key: `market:${key}`,
      id: entry.id,
      name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
      version,
      description: typeof entry.description === "string" ? entry.description : "",
      source: "market",
      icon: displayIcon(entry.icon),
      reviewable: true,
      statusLabel: "官方目录已收录",
      sourceUrl: `https://github.com/${registered.repo}/releases/tag/${encodeURIComponent(tag)}`,
      prNumber: null,
      repo: registered.repo,
      tag,
      archiveSha256: entry.archive.sha256,
      prHead: "",
      headSha: "",
      ...statusFor({ id: entry.id, version }, installed),
    };
  }

  // 一页拉满，不够再翻；超过扫描上限的部分要说出来，不能悄悄少算。
  async function readOpenPulls(bucket) {
    const pulls = [];
    for (let page = 1; page <= MAX_PR_PAGES; page += 1) {
      const payload = await fetchWithRetry(
        apiUrl(`/repos/${MARKET_REPO}/pulls?state=open&per_page=${PR_PAGE_SIZE}&page=${page}`),
        MAX_SMALL_JSON_BYTES,
      );
      if (!Array.isArray(payload)) {
        bucket.add("待审申请列表格式不完整，已跳过待审部分。");
        break;
      }
      pulls.push(...payload);
      if (payload.length < PR_PAGE_SIZE) break;
      // GitHub API caps per_page at 100: reaching the cap means there may be another page.
      if (pulls.length >= PR_SCAN_LIMIT) {
        bucket.add(`只读取了最近 ${PR_SCAN_LIMIT} 个开放申请，可能不是全量；请到仓库页面核对。`);
        break;
      }
    }
    if (pulls.length > PR_SCAN_LIMIT) {
      bucket.add(`待审只读取了最近 ${PR_SCAN_LIMIT} 个开放申请，不是全量；更早的申请请到仓库页面查看。`);
      pulls.length = PR_SCAN_LIMIT;
    }
    return pulls;
  }

  // 缓存只按不可变的东西做键：申请编号 + head + base + 草稿与否。
  // 这四项没变，扫出来的结论就不会变；任一项变了就重新读。
  async function pendingItem(pull, bucket) {
    const number = Number(pull?.number);
    const headSha = String(pull?.head?.sha || "");
    const baseSha = String(pull?.base?.sha || "");
    const cacheKey = Number.isInteger(number) && COMMIT_RE.test(headSha) && COMMIT_RE.test(baseSha)
      ? `${number}:${headSha}:${baseSha}:${pull?.draft === true ? "draft" : "ready"}`
      : "";
    if (cacheKey) {
      const cached = readPendingCache(sdk, cacheKey);
      // 空数组是「扫过、没东西」的标记，跟「没扫过」必须分开，不能把前者当后者。
      if (cached) return cached.length ? cached.map((row) => ({ ...row })) : null;
    }
    const rows = await readPendingItem(pull, bucket);
    if (cacheKey) writePendingCache(sdk, cacheKey, rows || []);
    return rows;
  }

  async function readPendingItem(pull, bucket) {
    const number = Number(pull?.number);
    const headSha = String(pull?.head?.sha || "");
    const baseSha = String(pull?.base?.sha || "");
    if (!Number.isInteger(number) || !COMMIT_RE.test(headSha) || !COMMIT_RE.test(baseSha)) {
      bucket.add(`有一个开放申请缺少可核实的提交信息，已跳过。`);
      return null;
    }
    const [base, head] = await Promise.all([
      readSnapshot(MARKET_REPO, baseSha, bucket, "approvals"),
      readSnapshot(MARKET_REPO, headSha, bucket, "approvals"),
    ]);
    const changed = [];
    const readmeOnly = [];
    for (const [key, approval] of head.approvals) {
      const before = base.approvals.get(key);
      if (before && before.tag === approval.tag && before.sha256 === approval.sha256) {
        if (before.readme !== approval.readme) readmeOnly.push(key);
        continue;
      }
      changed.push({ key, approval });
    }
    if (!changed.length) {
      if (readmeOnly.length) bucket.add(`申请 #${number} 只改了 ${readmeOnly.join("、")} 的介绍文字，没有新版本，未列为待审版本。`);
      return null;
    }
    // 登记表到这里才读：上面已经确定这个申请真带应用版本，才值得为它多跑一个请求。
    const registry = (await readSnapshot(MARKET_REPO, headSha, bucket, "registry")).registry;
    const kept = [];
    for (const { key, approval } of changed) {
      const registered = registry.get(key);
      if (!registered?.repo) { bucket.add(`申请 #${number} 的 ${key} 没有对应登记，官方同步会整批失败，已跳过。`); continue; }
      kept.push({ key, registered, approval });
    }
    if (!kept.length) return null;
    if (kept.length > MAX_CANDIDATES_PER_PR) {
      bucket.add(`申请 #${number} 改动条目过多，只列前 ${MAX_CANDIDATES_PER_PR} 个。`);
      kept.length = MAX_CANDIDATES_PER_PR;
    }
    const draft = pull?.draft === true;
    return kept.map(({ key, registered, approval }) => {
      const version = versionFromTag(approval.tag);
      if (!version) bucket.add(`申请 #${number} 的 ${key} 无法从标签推断版本，版本标为未知。`);
      const summary = readmeSummary(approval.readme);
      return {
        key: `pending:${key}:pr${number}`,
        id: approval.id,
        name: summary.name || approval.id,
        version,
        description: summary.description || `申请 #${number} 未附可读简介。`,
        source: "pending",
        statusLabel: draft ? `草稿申请 #${number}（作者尚未标记完成）` : `待审申请 #${number}，是否上架以维护者为准`,
        sourceUrl: typeof pull?.html_url === "string" ? pull.html_url : `https://github.com/${MARKET_REPO}/pull/${number}`,
        prNumber: number,
        repo: registered.repo,
        tag: approval.tag,
        archiveSha256: approval.sha256,
        prHead: headSha,
        headSha,
        // 申请针对的市场主干提交；只在市场仓库内有意义，不能当应用源码的对比基线。
        baseSha,
      };
    });
  }

  async function collectPending(bucket, installed) {
    // 扫描预算：开放申请不止二十个，目标应用的申请很容易排在后面。
    // 并发交给请求级闸门；这里只管两件事：先拿到申请名单，再等整批落地或到期。
    const deadline = Date.now() + PENDING_DEADLINE_MS;
    let pulls;
    try {
      pulls = await bounded(() => readOpenPulls(bucket), 15000, "待审申请列表读取超时，未确认待审结果。");
    } catch (error) {
      bucket.add(`待审申请读取失败：${describeError(error)}。本次没有待审条目。`);
      return [];
    }
    const settled = [];
    let stopped = false;
    let nextPull = 0;
    // Bound in-flight PR processing, not just the individual network requests.
    const worker = async () => {
      while (!stopped && Date.now() < deadline && nextPull < pulls.length) {
        const pull = pulls[nextPull++];
        try {
          const rows = await pendingItem(pull, bucket);
          if (!rows?.length) continue;
          for (const row of rows) settled.push({ ...row, ...statusFor(row, installed) });
        } catch (error) {
          bucket.add(`申请 #${Number(pull?.number) || "?"} 读取失败：${describeError(error)}。`);
        }
      }
    };
    const workers = Array.from({ length: Math.min(4, pulls.length) }, () => worker());
    try {
      await bounded(() => Promise.all(workers), Math.max(1, deadline - Date.now()), "待审申请扫描超时，仅保留本次已读取的条目；不代表没有其他待审应用。");
    } catch (error) {
      bucket.add(describeError(error));
    } finally {
      stopped = true;
      // 这一轮读到的东西一次性落盘，别每条申请都重写一遍文件。
      void flushPendingCache(sdk);
    }
    return [...settled];
  }

  async function build(refresh, includePending) {
    const bucket = warningsBucket();
    bucket.add(includePending ? "当前读取官方 Global 目录与该仓库的候审提案；中国大陆源独立审核，本版未读取。" : "当前先读官方 Global 目录，候审提案随后自动补读；中国大陆源本版未读取。");
    const installed = state.installed && !refresh ? state.installed : await installedLookup();
    if (installed.status !== "available") {
      bucket.add("本机安装信息不可用，可能是没有 app/environments.manage 授权或读取失败；已安装与更新状态不推断。");
    }
    state.installed = installed;
    const commit = await readMainCommit();
    const snapshot = await readSnapshot(MARKET_REPO, commit, bucket, "full");
    const items = [];
    const catalogItems = Array.isArray(snapshot.index?.items) ? snapshot.index.items : [];
    if (!Array.isArray(snapshot.index?.items)) bucket.add("市场索引格式不完整，本次没有已上架条目。");
    for (const entry of catalogItems) {
      if (!entry || typeof entry !== "object" || entry.kind !== "app") continue;
      if (typeof entry.id !== "string" || !entry.id) { bucket.add("市场索引里有一条记录缺少应用 ID，已跳过。"); continue; }
      const item = marketItem(entry, snapshot.registry, snapshot.approvals, bucket, installed);
      if (item) items.push(item);
    }
    // 已安装但市场未收录的应用也要可见；只读取安装身份，不探查本机源码或运行数据。
    const represented = new Set(items.map((item) => item.id));
    if (installed.status === "available") {
      for (const [id, installedVersion] of installed.byId) {
        if (represented.has(id)) continue;
        items.push({
          key: `installed:app:${id}`, id, name: installed.names.get(id), version: null,
          installed: true, installedVersion, updateStatus: "unknown", source: "installed",
          icon: "", reviewable: false, repo: "", tag: "", sourceUrl: "",
          description: "已安装，但当前市场目录未收录可核实的公开来源，暂无法检查源码或判断更新。",
          statusLabel: "已安装 · 未匹配市场来源",
        });
      }
    }
    if (includePending) {
      const pending = await collectPending(bucket, installed);
      rememberPendingRows(pending);
      const icons = new Map(items.filter((item) => item.icon).map((item) => [item.id, item.icon]));
      // 同一应用已上架那一版的标签，就是待审版本的天然对比基线。
      const listed = new Map(items.filter((item) => item.source === 'market').map((item) => [item.id, item]));
      items.push(...pending.map((item) => {
        const before = listed.get(item.id);
        return {
          ...item,
          icon: icons.get(item.id) || '',
          reviewable: true,
          listedVersion: before?.version || null,
          listedTag: before?.tag || '',
        };
      }));
    }
    // 同一应用的市场条目与候审条目并列展示，用 source 与 key 前缀区分，不合并、不互相覆盖。
    const sourceOrder = { market: 0, installed: 1, pending: 2 };
    items.sort((a, b) => (sourceOrder[a.source] - sourceOrder[b.source]) || a.id.localeCompare(b.id));
    return {
      items,
      warnings: bucket.snapshot(),
      updatedAt: new Date().toISOString(),
      installedStatus: installed.status,
      pendingLoaded: includePending,
      commit,
    };
  }

  async function catalog({ refresh = false, includePending = true } = {}) {
    if (!refresh && state.cache && Date.now() < state.expiresAt && (!includePending || state.cache.pendingLoaded)) return state.cache;
    if (state.loading) {
      await state.loading;
      return catalog({ includePending });
    }
    state.loading = (async () => {
      const result = await build(refresh, includePending);
      state.cache = result;
      state.expiresAt = Date.now() + CACHE_TTL_MS;
      return result;
    })();
    try {
      return await state.loading;
    } finally {
      state.loading = null;
    }
  }

  // 只读候审：默认页首屏先把市场清单出了，再单独把「待审最新版」补进来。
  // 走这条路不必重读 5MB 的市场索引，只需扫描开放申请。
  async function pending({ refresh = false } = {}) {
    if (!refresh && state.cache?.pendingLoaded && Date.now() < state.expiresAt) {
      return {
        items: state.cache.items.filter((item) => item.source === "pending"),
        warnings: state.cache.warnings,
        installedStatus: state.cache.installedStatus,
        pendingLoaded: true,
      };
    }
    if (state.pendingLoading) return state.pendingLoading;
    state.pendingLoading = (async () => {
      const bucket = warningsBucket();
      bucket.add("本次只按需读取候审提案，未重读市场索引；中国大陆源本版未读取。");
      const installed = state.installed || await installedLookup();
      state.installed = installed;
      if (installed.status !== "available") {
        bucket.add("本机安装信息不可用，可能是没有 app/environments.manage 授权或读取失败；已安装与更新状态不推断。");
      }
      const rows = await collectPending(bucket, installed);
      rememberPendingRows(rows);
      const icons = new Map((state.cache?.items || []).filter((item) => item.icon).map((item) => [item.id, item.icon]));
      // 已上架那一版就是待审版本的天然对比基线。补上它，审待审版才能算出「多了什么」；
      // 不补的话 version_diff 是空的，模型只能对着单版源码干讲。
      const listed = new Map((state.cache?.items || []).filter((item) => item.source === "market").map((item) => [item.id, item]));
      const items = rows.map((row) => {
        const base = listed.get(row.id);
        return { ...row, icon: icons.get(row.id) || "", reviewable: true, listedVersion: base?.version || null, listedTag: base?.tag || "" };
      });
      if (state.cache) {
        state.cache = {
          ...state.cache,
          items: [...state.cache.items.filter((item) => item.source !== "pending"), ...items],
          warnings: [...state.cache.warnings, ...bucket.snapshot()],
          pendingLoaded: true,
        };
      }
      return { items, warnings: bucket.snapshot(), installedStatus: installed.status, pendingLoaded: true };
    })();
    try {
      return await state.pendingLoading;
    } finally {
      state.pendingLoading = null;
    }
  }

  async function recheckPending(item, bucket) {
    const payload = await fetchWithRetry(apiUrl(`/repos/${MARKET_REPO}/pulls/${item.prNumber}`), MAX_SMALL_JSON_BYTES);
    if (payload?.state !== "open") throw fail("这个应用的上架申请已经关闭或合并，请刷新目录后重试。");
    const headSha = String(payload?.head?.sha || "");
    if (!COMMIT_RE.test(headSha)) throw fail("这个应用的申请提交标识无效，暂时无法继续检查。");
    if (headSha === item.prHead) return item;
    // 应用与 PR 的 key 保持稳定，内容变化由完整 prHead 指纹判过期，旧记录仍可打开。
    const rows = await pendingItem(payload, bucket);
    const rebuilt = (rows || []).find((row) => row.id === item.id);
    if (!rebuilt) throw fail("这个应用的上架申请已没有可检查的新版本，请刷新目录后重试。");
    rememberPendingRows([rebuilt]);
    const installed = state.installed || await installedLookup();
    // 重建后要补回已上架基线，否则版本对比会丢掉对比对象。
    const listed = state.cache?.items?.find((row) => row.source === "market" && row.id === item.id);
    const next = { ...rebuilt, ...statusFor(rebuilt, installed), listedVersion: listed?.version || null, listedTag: listed?.tag || "" };
    if (state.cache) {
      const index = state.cache.items.findIndex((row) => row.key === item.key);
      if (index >= 0) state.cache.items[index] = next;
    }
    return next;
  }

  async function resolve(key) {
    if (typeof key !== "string" || !key || key.length > 240) throw fail("这个应用标识无效，无法继续检查。");
    if (!key.startsWith("market:app:") && !key.startsWith("pending:app:")) throw fail("这个应用标识无效，无法继续检查。");
    const includePending = key.startsWith("pending:app:");
    if (!state.cache || Date.now() >= state.expiresAt || (includePending && !state.cache.pendingLoaded)) await catalog({ includePending });
    const found = state.cache?.items?.find((row) => row.key === key);
    if (!found) throw fail("这个应用不在当前目录里，请刷新目录后重试。");
    if (found.source !== "pending") return found;
    const bucket = warningsBucket();
    try {
      return await recheckPending(found, bucket);
    } catch (error) {
      if (error instanceof MarketCatalogError) throw error;
      throw fail("这个应用的申请状态暂时无法核实，请稍后重试。");
    }
  }

  // 指纹由 lib/market-review.js 统一维护（repo/tag/archiveSha256/prHead/version），
  // 这里只负责把这几项填准，不另立一份定义。
  return { catalog, pending, resolve, pendingIcons };
}
