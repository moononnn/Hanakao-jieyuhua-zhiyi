// Hana 更新手记：只读官方 release 说明，不下载安装包、不判断该不该升级、不碰本机任何应用文件。
//
// 数据链路只有一条：
//   GET api.github.com/repos/liliMozi/openhanako/releases?per_page=100
// 公开接口，匿名每小时 60 次，填了只读令牌提到 5000 次（沿用 lib/github-token.js 的约定）。
// 一个版本只读一次，读完把结构化结果按 tag 落在 dataDir；版本说明不会改，缓存不设过期。
//
// 两个必须过滤的噪音（都是实测出来的）：
//   1) 仓库里每个版本还配一条 train-beta-NN 的 hot-update release，正文是同一句英文模板，
//      不是给用户看的说明。按 tag 前缀剔掉。
//   2) v0.x 时期有一批正文只有一行 "**Full Changelog**: https://...compare/..." 的空壳版本。
//      按正文长度剔掉，阈值取 300 字符，比任何一条真实说明都短一个量级。
//
// 解析要迁就三种真实排版（同一个仓库换过写法，不能只认一种）：
//   A. ## Features · 新功能   ->  ### 记忆与闲聊  ->  - **标题**：正文     （v1.5.48）
//   B. ## Features · 新功能   ->  - **标题**：正文                          （v1.5.7，没有三级分组）
//   C. ## 1. Code：独立编程工作空间 -> ### 小标题 -> - 纯文本条目           （v1.1.111）
// 另外几条实测到的坑：
//   - 正文后半有一整段英文重写（`# HanaAgent x.y.z — English`），必须截掉，否则条目翻倍。
//   - 升级提示有时是 `## 升级提示` 章节，有时是正文里一句 `**升级提示**：...`，两种都要收。
//   - Bug Fixes 里的条目多数是纯文本，没有加粗标题，这时 title 直接取整行，正文留空。

import { githubHeaders, isRateLimited, rateLimitMessage } from "./github-token.js";

export const HANA_REPO = "liliMozi/openhanako";
const API_HOST = "https://api.github.com";
const PER_PAGE = 100;
// 正文低于这个长度视为占位版本：真实说明最短的一条（v1.0.11）也有三千多字符。
const MIN_BODY_CHARS = 300;
// 英文段起点。实测三种写法，别只认一种：
//   `# HanaAgent 1.5.7-beta — English`
//   `# HanaAgent 1.0.16-beta (English)`
//   `HanaAgent 1.1.7-beta (English)`（连 # 都没有）
// 三种都出现在 `---` 分隔线之后，所以先按分隔线找，再用标题兜底。
const ENGLISH_HEADING = /^(?:#\s+)?HanaAgent\b[^\n]{0,80}(?:English|英文)\s*$/im;
const RULE = /^[ \t]*---[ \t]*$/gm;
const ITEM_LINE = /^\s*[-*]\s+(.+)$/;
const BOLD_ITEM = /^\*\*(.+?)\*\*\s*[：:]\s*([\s\S]*)$/;

export class HandbookReleaseError extends Error {}

/** 版本号归一：v1.5.48-beta 与 1.5.48-beta 视为同一个。 */
export function normalizeVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

/** 这条 release 是不是给用户看的说明。 */
export function isNoiseRelease(release) {
  const tag = String(release?.tag_name || "").trim();
  if (!tag) return true;
  if (/^train-/i.test(tag)) return true;
  if (release?.draft === true) return true;
  const body = stripEnglish(String(release?.body || "")).trim();
  // 去掉 markdown 修饰后还不到 300 字，基本就是 compare 链接占位。
  return body.replace(/^#.*$/gm, "").replace(/[*_`>#\-\s]/g, "").length < MIN_BODY_CHARS;
}

/** 砍掉正文后半的英文重写段。找不到英文段就原样返回，绝不错切中文部分。 */
export function stripEnglish(body) {
  const candidates = [];
  // 规则一：分隔线之后 400 字内出现 English / Includes changes since，认定英文段从这里开始。
  RULE.lastIndex = 0;
  let rule;
  while ((rule = RULE.exec(body))) {
    const tail = body.slice(rule.index, rule.index + 400);
    if (/English|Includes changes since|英文/i.test(tail)) {
      candidates.push(rule.index);
      break;
    }
  }
  // 规则二：没有分隔线（少数版本）时，直接找英文标题行。
  const heading = ENGLISH_HEADING.exec(body);
  if (heading) candidates.push(heading.index);
  if (!candidates.length) return body;
  return body.slice(0, Math.min(...candidates)).replace(/\n---\s*$/, "").trimEnd();
}

// 章节归类。顺序有意为之：先认「修复」，再认「性能」，最后才认「新功能」，
// 否则「修复与改进」这种标题会被新功能那一条抢走。
function sectionKey(title) {
  if (/Bug\s*Fixes|问题修复|修复/i.test(title)) return "fixes";
  if (/Performance|性能|优化/i.test(title)) return "performance";
  if (/升级|Upgrade|平台说明|下载|Download/i.test(title)) return "upgrade";
  if (/Features|新功能|新增|改进/i.test(title)) return "features";
  return "other";
}

const isVersionHeading = (title) => /HanaAgent|^v?\d+\.\d+/.test(title);
// 有些历史版本的标题写成双语：`下载说明 / Download note`。取前半段就行。
const cleanHeading = (title) =>
  clean(title).replace(/\s*[\/|]\s*(?:Download note|Download|Notes?|English|中文)\s*$/i, "").trim();

function clean(text) {
  return String(text || "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * 把一段 release 正文解析成结构。
 * 只做切分和去修饰，不改写、不总结、不判断哪条重要；哪些条目值得进卡片由模型那一层决定。
 */
export function parseReleaseBody(markdown, { tag = "" } = {}) {
  const body = stripEnglish(String(markdown || ""));
  const lines = body.split(/\r?\n/);

  const sections = [];
  const upgradeNotes = [];
  let intro = "";
  let baseVersion = "";
  let section = null;
  let group = null;
  let item = null;
  let seenSection = false;
  // 空行是唯一的「新段落」信号。列表项之间没空行，段落之间有空行，靠它分。
  let prevBlank = true;

  const ensureGroup = () => {
    if (!group) {
      group = { name: "", items: [] };
      if (section) section.groups.push(group);
    }
    return group;
  };

  const pushItem = (title, detail) => {
    if (!title) return null;
    if (!section) {
      upgradeNotes.push({ title: clean(title), detail: clean(detail) });
      return null;
    }
    const target = ensureGroup();
    const created = { title: clean(title), detail: clean(detail) };
    target.items.push(created);
    return created;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      prevBlank = true;
      continue;
    }
    if (/^---+(\s*)$/.test(line.trim())) {
      prevBlank = true;
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = cleanHeading(heading[2]);
      if (level === 1) {
        // 一级标题多半是版本名，不是内容。
        if (isVersionHeading(title) || /^Includes changes/i.test(title)) {
          item = null;
          prevBlank = true;
          continue;
        }
        // v1.1.7 把分类写在 `# Feature`，真正的分类名在这里。
        section = { key: sectionKey(title), title, groups: [], level: 1 };
        sections.push(section);
        group = null;
        item = null;
        seenSection = true;
        prevBlank = true;
        continue;
      }
      if (level === 2) {
        // 上一层是 h1 分类时，所有 h2 都是它的分组（v1.1.7 的 "# Feature / ## 会话浏览器"）。
        // 这里不能改成「只有第一个 h2 当分组」：那样第二个 h2 会被当成新章节，把同一类拆散。
        if (section && section.level === 1) {
          group = { name: title, items: [] };
          section.groups.push(group);
        } else {
          section = { key: sectionKey(title), title, groups: [], level: 2 };
          sections.push(section);
          group = null;
        }
        item = null;
        seenSection = true;
        prevBlank = true;
        continue;
      }
      if (section) {
        group = { name: title, items: [] };
        section.groups.push(group);
      }
      item = null;
      prevBlank = true;
      continue;
    }

    // 正文里自带的「包含自 **v1.5.7-beta** 以来的更新」，是这个版本的比较基线。
    const base = /包含自\s*\**\s*(v?[\d.]+(?:-[0-9A-Za-z.]+)?)\s*\**\s*以来/.exec(line);
    if (base && !baseVersion) baseVersion = base[1];

    const bullet = ITEM_LINE.exec(line);
    if (bullet) {
      const text = bullet[1].trim();
      const bold = BOLD_ITEM.exec(text);
      item = bold ? pushItem(bold[1], bold[2]) : pushItem(text, "");
      prevBlank = false;
      continue;
    }

    // 升级提示有时不是章节，而是正文里一句 `**升级提示**：...`，夹在修复章节后面。
    const boldPara = /^\*\*(.+?)\*\*\s*[：:]\s*(.+)$/.exec(line);
    if (boldPara && /升级|提示|注意/.test(boldPara[1])) {
      upgradeNotes.push({ title: clean(boldPara[1]), detail: clean(boldPara[2]) });
      item = null;
      prevBlank = false;
      continue;
    }

    // 第一章之前的说明性段落。
    if (!seenSection) {
      intro = intro ? `${intro} ${clean(line)}` : clean(line);
      prevBlank = false;
      continue;
    }

    // 普通段落：空行之后开新条目，紧跟上一行则算续行。
    // v1.1.7 整篇没有列表，功能描述就是一段一段的，靠这条规则收进来。
    if (prevBlank || !item) {
      item = pushItem(line, "");
    } else {
      item.detail = item.detail ? `${item.detail} ${clean(line)}` : clean(line);
    }
    prevBlank = false;
  }

  // 补齐 id：按解析后的位置生成，同一个 tag 下永远稳定。
  // 「升级提示」章节的条目统一拉进 upgradeNotes，不再留在 sections 里：前端只需要看一处，
  // 否则同一种东西有两个出口，卡片层还得再去重一次。
  let seq = 0;
  let itemCount = 0;
  const kept = [];
  for (const sec of sections) {
    delete sec.level;
    sec.groups = sec.groups.filter((g) => g.items.length > 0);
    if (!sec.groups.length) continue;
    const isUpgrade = sec.key === "upgrade";
    for (const grp of sec.groups) {
      for (const it of grp.items) {
        seq += 1;
        itemCount += 1;
        it.id = `${tag || "release"}:${seq}`;
        it.section = sec.key;
        it.sectionTitle = sec.title;
        it.group = grp.name;
        if (isUpgrade) {
          upgradeNotes.push({ id: it.id, title: it.title, detail: it.detail, group: grp.name });
        }
      }
    }
    if (!isUpgrade) kept.push(sec);
  }

  return {
    tag,
    baseVersion: baseVersion || "",
    intro,
    sections: kept,
    upgradeNotes,
    itemCount,
  };
}

/** 把 GitHub 的 release 对象压成内部形状。 */
export function normalizeRelease(raw) {
  const tag = String(raw?.tag_name || "").trim();
  const body = stripEnglish(String(raw?.body || ""));
  const parsed = parseReleaseBody(body, { tag });
  return {
    tag,
    version: normalizeVersion(tag),
    title: clean(String(raw?.name || "").replace(/^HanaAgent\s*/i, "")) || normalizeVersion(tag),
    publishedAt: raw?.published_at || "",
    url: typeof raw?.html_url === "string" ? raw.html_url : "",
    baseVersion: normalizeVersion(parsed.baseVersion),
    intro: parsed.intro,
    sections: parsed.sections,
    upgradeNotes: parsed.upgradeNotes,
    itemCount: parsed.itemCount,
  };
}

/** 抓全部 release（只读）。分页上限两道，防止某天接口异常时无限拉。 */
export async function fetchReleases(sdk, { pages = 2 } = {}) {
  const out = [];
  for (let page = 1; page <= pages; page += 1) {
    const url = `${API_HOST}/repos/${HANA_REPO}/releases?per_page=${PER_PAGE}&page=${page}`;
    let response;
    try {
      response = await sdk.network.fetch(url, {
        method: "GET",
        redirect: "error",
        headers: githubHeaders(sdk, { Accept: "application/vnd.github+json" }, url),
        timeoutMs: 10000,
        maxResponseBytes: 4 * 1024 * 1024,
      });
    } catch {
      throw new HandbookReleaseError("读不到 Hana 的更新说明，网络没通。稍后再试。");
    }
    if (!response.ok) {
      throw new HandbookReleaseError(
        isRateLimited(response.status) ? rateLimitMessage() : `读不到 Hana 的更新说明（HTTP ${response.status}）。`,
      );
    }
    const list = await response.json();
    if (!Array.isArray(list)) throw new HandbookReleaseError("Hana 的更新说明格式变了，这次读不明白。");
    for (const raw of list) if (!isNoiseRelease(raw)) out.push(normalizeRelease(raw));
    if (list.length < PER_PAGE) break;
  }
  out.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  return out;
}

/**
 * 选出「该讲哪几版」。
 * 默认以本机已装版本为基线，取它之后发布的所有正常版本（不看发布顺序，按发布时间）。
 * 本机版本在 release 里找不到时（OTA 热更新、内测包）退回最近 maxVersions 个，并在
 * baseline 留空，前端据此说「不知道你上次看的是哪版」，而不是瞎猜一个。
 */
export function pickRecentReleases(releases, { installedVersion = "", maxVersions = 5 } = {}) {
  const list = Array.isArray(releases) ? releases : [];
  const want = normalizeVersion(installedVersion);
  const hit = want ? list.find((r) => r.version === want) : null;
  if (hit) {
    const newer = list.filter((r) => String(r.publishedAt) > String(hit.publishedAt));
    const picked = newer.slice(0, Math.max(1, maxVersions));
    return {
      releases: picked,
      baseline: { version: hit.version, publishedAt: hit.publishedAt },
      truncated: newer.length > picked.length,
      newerCount: newer.length,
    };
  }
  const picked = list.slice(0, Math.max(1, maxVersions));
  return { releases: picked, baseline: null, truncated: list.length > picked.length, newerCount: list.length };
}
