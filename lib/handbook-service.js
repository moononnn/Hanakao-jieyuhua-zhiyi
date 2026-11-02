// 更新手记的组装层：把「抓哪个版本、每版挑过没有、拼成一面墙」串起来。
//
// 三个决定：
// 1) 列表在内存里放十分钟。GitHub 匿名额度是一小时 60 次，页面开关几次就撞上限太蠢。
// 2) 卡片按版本缓存，命中直接用；没命中才调模型。落后两版时两版并行算，不是排队等两次。
// 3) 某一版算失败，其余版本照常出墙，失败的那版在返回里带 error，页面自己说「这版没读出来」。
//    不让一个版本的网络抖动把整面墙拖垮。
//
// 本机已装版本不走宿主接口，直接读 Hana 落盘的两个文件：
//   <HANA_HOME>/server-info.json 的 version
//   <HANA_HOME>/last-update-version 的纯文本
// 知意的 dataDir 一般在 <HANA_HOME>/app-data/jiegehua-zhiyi，往上两级就是 HANA_HOME。
// 两个都读不到就返回空串，页面据此说「不知道你装的是哪版」，而不是猜一个。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchReleases, pickRecentReleases } from "./handbook-releases.js";
import { CARD_PROMPT_VERSION, MAX_CARDS_PER_RELEASE, attachSources, extractCards, mergeCardPools, splitHighlights } from "./handbook-cards.js";
import { readCardsCache, writeCardsCache } from "./handbook-cache.js";

const LIST_TTL_MS = 10 * 60 * 1000;
const CARD_CONCURRENCY = 2;
let listCache = { at: 0, releases: null };

export function resetHandbookListCacheForTest() {
  listCache = { at: 0, releases: null };
}

/** 版本列表，十分钟内复用。 */
export async function listReleases(sdk, { force = false } = {}) {
  const now = Date.now();
  if (!force && listCache.releases && now - listCache.at < LIST_TTL_MS) return listCache.releases;
  const releases = await fetchReleases(sdk);
  listCache = { at: now, releases };
  return releases;
}

/**
 * 本机装的 Hana 是哪一版。读不到就空串，不猜。
 *
 * 为什么试好几个地方：app 不一定能读 dataDir 以外的文件（沙箱边界因宿主版本而异）。
 * dataDir 向上两级是最短的猜法，其次是从 app 自身目录向上两级（这个一定存在），
 * 再不行看宿主有没有注入 HANA_HOME。全部失败就如实返回空串，页面说「不知道你装的是哪版」，
 * 而不是默认成最新版把已经看过的更新重讲一遍。
 */
export function readHostVersion(sdk) {
  const dataDir = typeof sdk?.dataDir === "string" ? sdk.dataDir.trim() : "";
  const homes = [];
  if (dataDir) homes.push(path.resolve(dataDir, "..", ".."));
  try {
    // lib/ 的上一层就是 app 根目录，再上两层是 HANA_HOME。
    homes.push(path.resolve(fileURLToPath(new URL("../", import.meta.url)), "..", ".."));
  } catch {
    // import.meta.url 不可用时跳过这个候选。
  }
  const env = String(process.env.HANA_HOME || "").trim();
  if (env) homes.push(env);
  return readVersionFromHomes([...new Set(homes)]);
}

/** 按顺序在几个候选目录里找版本文件。导出来是为了让测试能只喂临时目录，不去摸真实环境。 */
export function readVersionFromHomes(homes) {
  for (const home of homes) {
    try {
      const info = JSON.parse(fs.readFileSync(path.join(home, "server-info.json"), "utf8"));
      if (typeof info?.version === "string" && info.version.trim()) return info.version.trim();
    } catch {
      // 换下一个来源。
    }
    try {
      const text = fs.readFileSync(path.join(home, "last-update-version"), "utf8").trim();
      if (text) return text;
    } catch {
      // 换下一个来源。
    }
  }
  return "";
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 一个版本的卡片：先看缓存，没有再调模型。 */
async function cardsForRelease(sdk, release, { rebuild = false } = {}) {
  if (!rebuild) {
    const hit = await readCardsCache(sdk, release.tag, { promptVersion: CARD_PROMPT_VERSION });
    if (hit) {
      // 缓存里只存挑出来的字段；原文每次从 release 现拼，不落盘，因为原文本来就有。
      return { tag: release.tag, version: release.version, publishedAt: release.publishedAt, cards: attachSources(release, hit.cards), model: hit.model, cached: true };
    }
  }
  const made = await extractCards(sdk, release);
  await writeCardsCache(sdk, release.tag, {
    cards: made.cards,
    publishedAt: release.publishedAt,
    model: made.model,
    promptVersion: CARD_PROMPT_VERSION,
  });
  return { tag: release.tag, version: release.version, publishedAt: release.publishedAt, cards: attachSources(release, made.cards), model: made.model, cached: false };
}

/**
 * 生成一面墙。
 * 返回的 wall 已经排好序并切好头条；versions 里带每版是缓存命中还是现场算的，方便页面说清来路。
 */
export async function loadWall(sdk, { installedVersion = "", maxVersions = 5, rebuild = false, limit = MAX_CARDS_PER_RELEASE } = {}) {
  const releases = await listReleases(sdk);
  const installed = String(installedVersion || readHostVersion(sdk) || "").trim();
  const window = pickRecentReleases(releases, { installedVersion: installed, maxVersions });

  if (!window.releases.length) {
    // 已是最新：仍然把最新那一版端上桌。用户点进来往往不是查更新，是想知道「现在手里这版能干什么」。
    // 这一版的卡片按 tag 缓存，第二次打开就是瞬开。
    const latest = releases[0] ? [releases[0]] : [];
    if (!latest.length) {
      return { installed, baseline: window.baseline, upToDate: true, truncated: false, newerCount: 0, versions: [], wall: { highlights: [], rest: [] }, totalCards: 0 };
    }
    const pool = await mapLimit(latest, 1, async (release) => {
      try {
        return await cardsForRelease(sdk, release, { rebuild });
      } catch (error) {
        return { tag: release.tag, version: release.version, publishedAt: release.publishedAt, cards: [], error: String(error?.message || error || "这一版没读出来").slice(0, 120) };
      }
    });
    const merged = mergeCardPools(pool.filter((row) => row.cards.length).map((row) => ({ ...row, cards: row.cards.slice(0, limit) })));
    const splitLatest = splitHighlights(merged);
    return {
      installed,
      baseline: window.baseline,
      upToDate: true,
      truncated: false,
      newerCount: 0,
      versions: pool.map(({ cards, ...row }) => ({ ...row, cardCount: cards.length })),
      wall: { highlights: splitLatest.highlights, rest: splitLatest.rest },
      totalCards: merged.length,
    };
  }

  const pools = await mapLimit(window.releases, CARD_CONCURRENCY, async (release) => {
    try {
      return await cardsForRelease(sdk, release, { rebuild });
    } catch (error) {
      return {
        tag: release.tag,
        version: release.version,
        publishedAt: release.publishedAt,
        cards: [],
        error: String(error?.message || error || "这一版没读出来").slice(0, 120),
      };
    }
  });

  const usable = pools.filter((pool) => pool.cards.length);
  const merged = mergeCardPools(usable.map((pool) => ({ ...pool, cards: pool.cards.slice(0, limit) })));
  const { highlights, rest } = splitHighlights(merged);

  return {
    installed,
    baseline: window.baseline,
    upToDate: false,
    truncated: window.truncated,
    newerCount: window.newerCount,
    versions: pools.map(({ cards, ...rest2 }) => ({ ...rest2, cardCount: cards.length })),
    wall: { highlights, rest },
    totalCards: merged.length,
  };
}

/**
 * 把一张卡翻回原文。
 * 追问只喂这张卡引用的那几条，不整版灌进去：一版五十条塞进去，模型会把无关的也说成答案。
 */
export async function sourcesForCard(sdk, card) {
  if (!card?.tag) return [];
  const releases = await listReleases(sdk);
  const release = releases.find((row) => row.tag === card.tag);
  if (!release) return [];
  const wanted = new Set(Array.isArray(card.items) ? card.items : []);
  const out = [];
  for (const section of release.sections) {
    for (const group of section.groups) {
      for (const item of group.items) {
        if (!wanted.has(item.id)) continue;
        out.push({ id: item.id, section: section.title, group: group.name, title: item.title, detail: item.detail });
      }
    }
  }
  return out;
}

/** 这一版还给不给算：卡片墙按版本刷新用。 */
export function describeWall(state) {
  if (!state) return "";
  if (state.upToDate) return state.baseline ? `你装的 ${state.baseline.version} 已经是最新的。` : "已经是最新的。";
  const versions = state.versions.filter((row) => row.cardCount > 0).map((row) => row.version);
  if (!versions.length) return "这几版都没读出卡片。";
  return `${versions.join(" → ")} 这几版，挑出 ${state.totalCards} 条。`;
}
