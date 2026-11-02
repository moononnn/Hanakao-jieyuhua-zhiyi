import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareMarketVersions, createMarketCatalog, parseMarketVersion } from "../lib/market-catalog.js";
import { resetPendingCacheForTest } from "../lib/market-pending-cache.js";
import { resetCatalogCacheForTest } from "../lib/market-cache.js";

const MAIN = "a".repeat(40);
const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const RAW = "https://raw.githubusercontent.com/liliMozi/hana-marketplace";
const API = "https://api.github.com/repos/liliMozi/hana-marketplace";

const sha = (seed) => seed.split("").map((c) => c.charCodeAt(0).toString(16)).join("").padEnd(64, "0").slice(0, 64);

function registry(rows) {
  return { schemaVersion: 1, entries: rows.map(([id, repo]) => ({ kind: "app", id, repository: repo, publisher: "p" })) };
}
function approvals(rows) {
  return {
    schemaVersion: 1,
    approvals: rows.map(([id, tag, digest, readme]) => ({ kind: "app", id, tag, sha256: digest, ...(readme ? { readme } : {}) })),
  };
}
function indexItem(id, { version = "1.0.0", tag = `v${version}`, digest = sha(id) } = {}) {
  return {
    kind: "app",
    id,
    name: `${id} 显示名`,
    publisher: "p",
    description: `${id} 的简介`,
    version,
    permissions: [],
    archive: { url: `https://github.com/o/${id}/releases/download/${tag}/app-${id}-${version}.zip`, sha256: digest, size: 1024, format: "zip" },
  };
}

function response(value) {
  return { ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) };
}

function createSdk({ routes = {}, installed = null } = {}) {
  const calls = [];
  const table = routes;
  const sdk = {
    network: {
      fetch: async (url, init) => {
        calls.push({ url, init });
        const route = table[url];
        if (route === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
        if (route instanceof Error) throw route;
        return response(route);
      },
    },
  };
  // null 表示宿主没给这个接口（能力未授予），与「给了接口但列表为空」要分开。
  if (installed !== null) sdk.environments = { listInstalledSources: async () => installed };
  return { sdk, calls, table };
}

function mainRoutes({ items = [], regs = [], apprs = [], pulls = [] }) {
  return {
    [`${API}/git/ref/heads/main`]: { object: { sha: MAIN, type: "commit" } },
    [`${RAW}/${MAIN}/index.v2.json`]: { schemaVersion: 2, sourceId: "official-global", name: "Hana Global Market", publishedAt: "2026-01-01T00:00:00.000Z", items },
    [`${RAW}/${MAIN}/registry.json`]: registry(regs),
    [`${RAW}/${MAIN}/approvals.json`]: approvals(apprs),
    [`${API}/pulls?state=open&per_page=100&page=1`]: pulls,
  };
}

function pull(number, head = HEAD, base = BASE, extra = {}) {
  return { number, state: "open", draft: false, html_url: `https://github.com/liliMozi/hana-marketplace/pull/${number}`, head: { sha: head }, base: { sha: base }, ...extra };
}

function pullRoutes(number, { base, head }) {
  return {
    [`${RAW}/${BASE}/registry.json`]: registry(base.regs),
    [`${RAW}/${BASE}/approvals.json`]: approvals(base.apprs),
    [`${RAW}/${HEAD}/registry.json`]: registry(head.regs),
    [`${RAW}/${HEAD}/approvals.json`]: approvals(head.apprs),
    [`${API}/pulls/${number}`]: pull(number),
  };
}

test("安装元数据不返回时三秒降级，不阻止读取市场", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sdk } = createSdk({ routes: mainRoutes({}) });
  sdk.environments = { listInstalledSources: () => new Promise(() => {}) };
  const pending = createMarketCatalog(sdk).catalog();
  t.mock.timers.tick(3000);
  const result = await pending;
  assert.equal(result.installedStatus, "unavailable");
  assert.ok(result.warnings.some((value) => value.includes("本机安装信息不可用")));
});

for (const stage of ["fetch", "body"]) {
  test(`市场 ${stage} 挂起时本地期限结束并释放目录加载锁`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { sdk } = createSdk({ routes: mainRoutes({}) });
    const original = sdk.network.fetch;
    let began;
    const started = new Promise((resolve) => { began = resolve; });
    sdk.network.fetch = async (url, init) => {
      if (url.endsWith("/index.v2.json")) {
        if (stage === "fetch") { began(); return new Promise(() => {}); }
        return { ok: true, json: () => { began(); return new Promise(() => {}); } };
      }
      return original(url, init);
    };
    const service = createMarketCatalog(sdk);
    const failed = assert.rejects(service.catalog(), /超时/);
    await started;
    t.mock.timers.tick(35000);
    await failed;
    sdk.network.fetch = original;
    assert.deepEqual((await service.catalog()).items, []);
  });
}

test("待审扫描达到总期限后保留市场结果且不再启动后续申请", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 100000 });
  const { sdk, calls } = createSdk({ routes: mainRoutes({ items: [indexItem("alpha")],
    regs: [["alpha", "o/alpha"]], apprs: [["alpha", "v1.0.0", sha("alpha")]],
    pulls: Array.from({ length: 12 }, (_, i) => pull(i + 1, (i + 1).toString(16).padStart(40, "0"))),
  }) });
  const original = sdk.network.fetch;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  sdk.network.fetch = (url, init) => {
    if (url.startsWith(RAW) && !url.includes(MAIN)) { began(); calls.push({ url, init }); return new Promise(() => {}); }
    return original(url, init);
  };
  const pending = createMarketCatalog(sdk).catalog();
  await started;
  // 候审扫描的总预算现在是 40 秒。
  t.mock.timers.tick(40000);
  const result = await pending;
  assert.equal(result.items[0].id, "alpha");
  assert.ok(result.warnings.some((value) => value.includes("超时")));
  const count = calls.length;
  t.mock.timers.tick(60000);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(calls.length, count);
});

test("大索引超过旧十五秒门槛仍可完成，小文件期限不跟着扩大", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { sdk, calls } = createSdk({ routes: mainRoutes({}) });
  const original = sdk.network.fetch;
  let began;
  const started = new Promise((resolve) => { began = resolve; });
  sdk.network.fetch = (url, init) => {
    if (url.endsWith("/index.v2.json")) {
      assert.equal(init.timeoutMs, 35000);
      began();
      return new Promise((resolve) => setTimeout(() => resolve(response({ items: [] })), 20000));
    }
    assert.equal(init.timeoutMs, 15000);
    return original(url, init);
  };
  const pending = createMarketCatalog(sdk).catalog({ includePending: false }).then((value) => ({ value }), (error) => ({ error }));
  await started;
  // 先让并行小文件的已完成 Promise 清理计时器，再推进大文件下载时钟。
  for (let i = 0; i < 30; i++) await Promise.resolve();
  t.mock.timers.tick(20000);
  const result = await pending;
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value.items, []);
  assert.equal(calls.some(({ url }) => url.includes("/pulls?")), false);
});

test("首屏和市场应用解析不扫描候审，按需升级缓存后才读取候审", async () => {
  const { sdk, calls } = createSdk({ routes: mainRoutes({ items: [indexItem("alpha")], regs: [["alpha", "o/alpha"]], apprs: [["alpha", "v1.0.0", sha("alpha")]] }) });
  const service = createMarketCatalog(sdk);
  const first = await service.catalog({ includePending: false });
  assert.equal(first.pendingLoaded, false);
  assert.equal(first.items[0].id, "alpha");
  await service.resolve("market:app:alpha");
  assert.equal(calls.some(({ url }) => url.includes("/pulls?")), false);
  const full = await service.catalog({ includePending: true });
  assert.equal(full.pendingLoaded, true);
  assert.equal(calls.filter(({ url }) => url.includes("/pulls?")).length, 1);
  const count = calls.length;
  await service.catalog({ includePending: true });
  assert.equal(calls.length, count);
});

test("并发候审请求等待首屏完成后升级，不误把部分目录当完整目录", async () => {
  const { sdk } = createSdk({ routes: mainRoutes({}) });
  const service = createMarketCatalog(sdk);
  const [first, full] = await Promise.all([service.catalog({ includePending: false }), service.catalog({ includePending: true })]);
  assert.equal(first.pendingLoaded, false);
  assert.equal(full.pendingLoaded, true);
});

test("reads index, registry and approvals from the same main commit", async () => {
  const { sdk, calls } = createSdk({
    routes: mainRoutes({
      items: [indexItem("alpha", { version: "1.2.0" })],
      regs: [["alpha", "o/alpha"]],
      apprs: [["alpha", "v1.2.0", sha("alpha")]],
    }),
  });
  const result = await createMarketCatalog(sdk).catalog();

  assert.equal(result.installedStatus, "unavailable");
  assert.equal(result.items.length, 1);
  const [item] = result.items;
  assert.equal(item.key, "market:app:alpha");
  assert.equal(item.source, "market");
  assert.equal(item.repo, "o/alpha");
  assert.equal(item.tag, "v1.2.0");
  assert.equal(item.archiveSha256, sha("alpha"));
  assert.equal(item.installedVersion, null);
  assert.equal(item.updateStatus, "unknown");

  const rawCalls = calls.filter((call) => call.url.startsWith(RAW));
  assert.equal(rawCalls.length, 3);
  for (const call of rawCalls) assert.ok(call.url.startsWith(`${RAW}/${MAIN}/`), "三份文件必须来自同一个 commit");
  assert.ok(calls.every((call) => call.init.redirect === "error"));
});

test("only app entries reach the catalog", async () => {
  const { sdk } = createSdk({
    routes: mainRoutes({
      items: [
        indexItem("alpha"),
        { ...indexItem("skillbox"), kind: "skill" },
        { ...indexItem("plug"), kind: "connector" },
      ],
      regs: [["alpha", "o/alpha"]],
      apprs: [["alpha", "v1.0.0", sha("alpha")]],
    }),
  });
  const result = await createMarketCatalog(sdk).catalog();
  assert.deepEqual(result.items.map((item) => item.id), ["alpha"]);
});

test("skips catalog entries without a matching enrollment and says so", async () => {
  const { sdk } = createSdk({
    routes: mainRoutes({ items: [indexItem("orphan")], regs: [], apprs: [] }),
  });
  const result = await createMarketCatalog(sdk).catalog();
  assert.equal(result.items.length, 0);
  assert.ok(result.warnings.some((text) => text.includes("orphan")));
});

test("warns when the catalog checksum disagrees with the approved checksum", async () => {
  const { sdk } = createSdk({
    routes: mainRoutes({
      items: [indexItem("alpha", { digest: sha("other") })],
      regs: [["alpha", "o/alpha"]],
      apprs: [["alpha", "v1.0.0", sha("alpha")]],
    }),
  });
  const result = await createMarketCatalog(sdk).catalog();
  assert.ok(result.warnings.some((text) => text.includes("校验值") && text.includes("不一致")));
});

test("compares semver strictly instead of by string order", () => {
  assert.equal(compareMarketVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareMarketVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareMarketVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareMarketVersions("1.0.0-alpha.2", "1.0.0-alpha.10"), -1);
  assert.equal(compareMarketVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareMarketVersions("1.0.0-alpha.beta", "1.0.0-alpha.2"), 1);
  assert.equal(compareMarketVersions("2.0", "2.0.0"), null);
  assert.equal(compareMarketVersions("01.0.0", "1.0.0"), null);
  assert.equal(compareMarketVersions("1.0.0-alpha..1", "1.0.0"), null);
  assert.equal(compareMarketVersions("1.0.0-01", "1.0.0"), null);
  assert.equal(compareMarketVersions("1.0.0-99999999999999999998", "1.0.0-99999999999999999999"), -1);
  assert.equal(compareMarketVersions("1.0.0", "version 未知"), null);
  assert.deepEqual(parseMarketVersion("v3.4.5-rc.1+build.9"), { major: 3, minor: 4, patch: 5, prerelease: ["rc", "1"] });
});

test("marks installed versions and update status only when the host list is available", async () => {
  const routes = mainRoutes({
    items: [indexItem("alpha", { version: "1.2.0" }), indexItem("beta", { version: "1.0.0" })],
    regs: [["alpha", "o/alpha"], ["beta", "o/beta"]],
    apprs: [["alpha", "v1.2.0", sha("alpha")], ["beta", "v1.0.0", sha("beta")]],
  });
  const installedRows = [
    { ref: "app:alpha", kind: "app", id: "alpha", version: "1.0.0" },
    { ref: "app:beta", kind: "app", id: "beta", version: "1.0.0" },
  ];
  const { sdk } = createSdk({ routes, installed: installedRows });
  const result = await createMarketCatalog(sdk).catalog();

  assert.equal(result.installedStatus, "available");
  const byId = new Map(result.items.map((item) => [item.id, item]));
  assert.equal(byId.get("alpha").installedVersion, "1.0.0");
  assert.equal(byId.get("alpha").updateStatus, "newer");
  assert.equal(byId.get("beta").updateStatus, "current");
});

test("reports installed status as unavailable without scanning directories", async () => {
  const { sdk } = createSdk({
    routes: mainRoutes({ items: [indexItem("alpha")], regs: [["alpha", "o/alpha"]], apprs: [["alpha", "v1.0.0", sha("alpha")]] }),
  });
  sdk.environments = { listInstalledSources: async () => { throw new Error("capability denied"); } };
  const result = await createMarketCatalog(sdk).catalog();
  assert.equal(result.installedStatus, "unavailable");
  assert.equal(result.items[0].installedVersion, null);
  assert.equal(result.items[0].updateStatus, "unknown");
  assert.ok(result.warnings.some((text) => text.includes("本机安装信息不可用")));
});

test("pending items compare the pull head against that pull's own base, not current main", async () => {
  const routes = {
    ...mainRoutes({
      items: [indexItem("alpha", { version: "2.0.0" })],
      // 当前 main 已经合并了 alpha 的 2.0.0
      regs: [["alpha", "o/alpha"], ["alpha2", "o/alpha2"]],
      apprs: [["alpha", "v2.0.0", sha("alpha")], ["alpha2", "v0.1.0", sha("alpha2")]],
      pulls: [pull(7)],
    }),
    ...pullRoutes(7, {
      // PR 的 base 落后 main：alpha 还停在 1.0.0
      base: { regs: [["alpha", "o/alpha"]], apprs: [["alpha", "v1.0.0", sha("alpha")]] },
      head: { regs: [["alpha", "o/alpha"], ["alpha2", "o/alpha2"]], apprs: [["alpha", "v1.0.0", sha("alpha")], ["alpha2", "v0.1.0", sha("alpha2")]] },
    }),
  };
  const { sdk } = createSdk({ routes });
  const result = await createMarketCatalog(sdk).catalog();

  const pending = result.items.filter((item) => item.source === "pending");
  assert.deepEqual(pending.map((item) => item.id), ["alpha2"], "alpha 的 2.0.0 属于别的 PR，不能算到这个申请头上");
  assert.equal(pending[0].key, "pending:app:alpha2:pr7");
  assert.equal(pending[0].prHead, HEAD);
  assert.equal(pending[0].tag, "v0.1.0");
  assert.equal(pending[0].version, "0.1.0");
  assert.equal(pending[0].prNumber, 7);
  assert.notEqual(pending[0].key, result.items.find((item) => item.id === "alpha").key);
});

test("a readme-only pull is not presented as a version update", async () => {
  const routes = {
    ...mainRoutes({
      items: [indexItem("alpha")],
      regs: [["alpha", "o/alpha"]],
      apprs: [["alpha", "v1.0.0", sha("alpha"), "# 旧介绍"]],
      pulls: [pull(9)],
    }),
    ...pullRoutes(9, {
      base: { regs: [["alpha", "o/alpha"]], apprs: [["alpha", "v1.0.0", sha("alpha"), "# 旧介绍"]] },
      head: { regs: [["alpha", "o/alpha"]], apprs: [["alpha", "v1.0.0", sha("alpha"), "# 新介绍\n\n改过文案"]] },
    }),
  };
  const { sdk } = createSdk({ routes });
  const result = await createMarketCatalog(sdk).catalog();
  assert.equal(result.items.filter((item) => item.source === "pending").length, 0);
  assert.ok(result.warnings.some((text) => text.includes("只改了") && text.includes("介绍文字")));
});

test("draft pulls are labelled as drafts, never as under review", async () => {
  const routes = {
    ...mainRoutes({ items: [], regs: [], apprs: [], pulls: [pull(11, HEAD, BASE, { draft: true })] }),
    ...pullRoutes(11, {
      base: { regs: [], apprs: [] },
      head: { regs: [["fresh", "o/fresh"]], apprs: [["fresh", "v0.2.0", sha("fresh")]] },
    }),
  };
  const { sdk } = createSdk({ routes });
  const result = await createMarketCatalog(sdk).catalog();
  const [item] = result.items;
  assert.equal(item.source, "pending");
  assert.match(item.statusLabel, /草稿/);
  assert.match(item.statusLabel, /#11/);
  assert.doesNotMatch(item.statusLabel, /审核中|正在审查/);
  assert.equal(item.name, "fresh", "没有可读标题时退回应用 ID");
});

test("truncated pull scanning is reported instead of silently dropped", async () => {
  // 扫描上限是 100，一次拉 100 条：多出来的部分必须被说出来，不能悄悄少算。
  const pulls = Array.from({ length: 105 }, (_, i) => pull(100 + i, HEAD, BASE));
  const routes = {
    ...mainRoutes({ items: [], regs: [], apprs: [], pulls }),
    ...pullRoutes(0, { base: { regs: [], apprs: [] }, head: { regs: [], apprs: [] } }),
  };
  const { sdk } = createSdk({ routes });
  const result = await createMarketCatalog(sdk).catalog();
  assert.ok(result.warnings.some((text) => text.includes("不是全量")));
  assert.ok(result.warnings.some((text) => text.includes("100")));
});

test("sequence: 单独补读候审不重读市场索引，结果并进缓存不重复扫", async () => {  const routes = {
    ...mainRoutes({
      items: [indexItem("alpha")], regs: [["alpha", "o/alpha"]], apprs: [["alpha", "v1.0.0", sha("alpha")]],
      pulls: [pull(21, HEAD, BASE)],
    }),
    ...pullRoutes(21, {
      base: { regs: [], apprs: [] },
      head: { regs: [["fresh", "o/fresh"]], apprs: [["fresh", "v0.2.0", sha("fresh")]] },
    }),
  };
  const { sdk, calls } = createSdk({ routes });
  const service = createMarketCatalog(sdk);
  const first = await service.catalog({ includePending: false });
  assert.equal(first.pendingLoaded, false);
  const indexReads = calls.filter(({ url }) => url.includes("index.v2.json")).length;
  const pending = await service.pending();
  assert.equal(pending.pendingLoaded, true);
  assert.equal(pending.items.length, 1);
  assert.equal(pending.items[0].id, "fresh");
  assert.equal(pending.items[0].source, "pending");
  assert.equal(calls.filter(({ url }) => url.includes("index.v2.json")).length, indexReads, "补读候审不重读 5MB 索引");
  const pullReads = calls.filter(({ url }) => url.includes("/pulls?")).length;
  await service.pending();
  assert.equal(calls.filter(({ url }) => url.includes("/pulls?")).length, pullReads, "缓存命中后不重复扫候审");
});

test("同一个市场提交再打开只问一次主分支，不再重下三份文件", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyi-catalog-disk-"));
  t.after(() => {
    resetPendingCacheForTest(); resetCatalogCacheForTest();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const routes = mainRoutes({ items: [indexItem("alpha")], regs: [["alpha", "o/alpha"]], apprs: [["alpha", "v1.0.0", sha("alpha")]] });
  const { sdk, calls } = createSdk({ routes });
  sdk.dataDir = dataDir;
  const first = await createMarketCatalog(sdk).catalog({ includePending: false });
  assert.equal(first.items.length, 1);
  assert.equal(calls.filter(({ url }) => url.startsWith(RAW)).length, 3);

  // 等写盘落地，再用新实例模拟「下次打开」：内存缓存也是空的。
  // 不用固定睡 50ms——写盘快慢看机器，慢一点就会误以为缓存没命中，随机红。改成等文件到位，最多 2 秒。
  const metaFile = path.join(dataDir, "market-cache", "meta.json");
  const deadline = Date.now() + 2000;
  while (!fs.existsSync(metaFile)) {
    if (Date.now() > deadline) throw new Error("缓存写了 2 秒还没落盘");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const before = calls.length;
  const second = await createMarketCatalog(sdk).catalog({ includePending: false });
  assert.equal(second.items.length, 1);
  assert.equal(second.commit, first.commit);
  const later = calls.slice(before);
  assert.equal(later.filter(({ url }) => url.startsWith(RAW)).length, 0, "命中本地目录就不再下载三份文件");
  assert.equal(later.filter(({ url }) => url.includes("/git/ref/")).length, 1, "仍要问一次主分支");
});

test("扫过的申请落盘，再扫同一个 head 不再重下审批表", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyi-catalog-cache-"));
  t.after(() => { resetPendingCacheForTest(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const routes = {
    ...mainRoutes({ items: [], regs: [], apprs: [], pulls: [pull(21, HEAD, BASE)] }),
    ...pullRoutes(21, {
      base: { regs: [], apprs: [] },
      head: { regs: [["fresh", "o/fresh"]], apprs: [["fresh", "v0.2.0", sha("fresh")]] },
    }),
  };
  const { sdk, calls } = createSdk({ routes });
  sdk.dataDir = dataDir;
  const first = await createMarketCatalog(sdk).catalog();
  assert.equal(first.items[0].id, "fresh");
  const approvalsReads = () => calls.filter(({ url }) => url === `${RAW}/${HEAD}/approvals.json`).length;
  const readsAfterFirst = approvalsReads();
  assert.equal(readsAfterFirst, 1);

  // 等写盘落地，再把进程内缓存清干净，第二次必须从盘上读回来。
  await new Promise((resolve) => setTimeout(resolve, 30));
  resetPendingCacheForTest();
  const second = await createMarketCatalog(sdk).catalog();
  assert.equal(second.items[0].id, "fresh");
  assert.equal(approvalsReads(), readsAfterFirst, "同一个 head+base 不该再下第二遍审批表");
});

test("one failing pull becomes a warning and does not sink the catalog", async () => {
  const BROKEN = "e".repeat(40);
  const routes = {
    ...mainRoutes({ items: [], regs: [], apprs: [], pulls: [pull(21, BROKEN), pull(22)] }),
    ...pullRoutes(22, {
      base: { regs: [], apprs: [] },
      head: { regs: [["ok2", "o/ok2"]], apprs: [["ok2", "v1.0.0", sha("ok2")]] },
    }),
    // 21 号 PR 的 head 快照读取失败
    [`${RAW}/${BROKEN}/registry.json`]: new Error("boom"),
  };
  const { sdk } = createSdk({ routes });
  const result = await createMarketCatalog(sdk).catalog();
  assert.deepEqual(result.items.map((item) => item.id), ["ok2"]);
  assert.ok(result.warnings.some((text) => text.includes("#21")));
});

test("候审条目补上已上架基线，审待审版才算得出「多了什么」", async () => {
  const routes = {
    ...mainRoutes({
      items: [indexItem("fresh")], regs: [["fresh", "o/fresh"]], apprs: [["fresh", "v1.0.0", sha("fresh")]],
      pulls: [pull(31, HEAD, BASE)],
    }),
    ...pullRoutes(31, {
      base: { regs: [["fresh", "o/fresh"]], apprs: [["fresh", "v1.0.0", sha("fresh")]] },
      head: { regs: [["fresh", "o/fresh"]], apprs: [["fresh", "v0.2.0", sha("fresh2")]] },
    }),
  };
  const { sdk } = createSdk({ routes });
  const service = createMarketCatalog(sdk);
  await service.catalog({ includePending: false });
  const pending = await service.pending();
  assert.equal(pending.items.length, 1);
  assert.equal(pending.items[0].id, "fresh");
  assert.equal(pending.items[0].listedVersion, "1.0.0", "待审条目要带上已上架版本作为对比基线");
  assert.equal(pending.items[0].listedTag, "v1.0.0");
});

test("resolve never turns a key into a URL and rejects foreign keys", async () => {
  const { sdk, calls } = createSdk({
    routes: mainRoutes({ items: [indexItem("alpha")], regs: [["alpha", "o/alpha"]], apprs: [["alpha", "v1.0.0", sha("alpha")]] }),
  });
  const catalog = createMarketCatalog(sdk);
  await catalog.catalog();
  const before = calls.length;

  await assert.rejects(() => catalog.resolve("https://evil.example/x"), /这个应用标识无效/);
  await assert.rejects(() => catalog.resolve("market:app:../../etc/passwd"), /这个应用不在当前目录/);
  await assert.rejects(() => catalog.resolve(""), /这个应用标识无效/);
  assert.equal(calls.length, before, "非法 key 不应触发任何网络请求");

  const item = await catalog.resolve("market:app:alpha");
  assert.equal(item.repo, "o/alpha");
});

test("catalog caches for ten minutes and refresh drops the cache", async () => {
  const { sdk, calls } = createSdk({
    routes: mainRoutes({ items: [indexItem("alpha")], regs: [["alpha", "o/alpha"]], apprs: [["alpha", "v1.0.0", sha("alpha")]] }),
  });
  const catalog = createMarketCatalog(sdk);
  await catalog.catalog();
  const first = calls.length;
  await catalog.catalog();
  assert.equal(calls.length, first, "10 分钟内直接复用缓存");
  await catalog.catalog({ refresh: true });
  assert.ok(calls.length > first, "refresh 必须重新读取");
});

test("resolve rechecks the pull head so a moved head changes the fingerprint input", async () => {
  const NEW_HEAD = "d".repeat(40);
  const routes = {
    ...mainRoutes({ items: [], regs: [], apprs: [], pulls: [pull(31)] }),
    ...pullRoutes(31, {
      base: { regs: [], apprs: [] },
      head: { regs: [["moved", "o/moved"]], apprs: [["moved", "v0.1.0", sha("moved")]] },
    }),
    [`${RAW}/${NEW_HEAD}/registry.json`]: registry([["moved", "o/moved"]]),
    [`${RAW}/${NEW_HEAD}/approvals.json`]: approvals([["moved", "v0.1.0", sha("moved")]]),
  };
  const { sdk } = createSdk({ routes });
  const catalog = createMarketCatalog(sdk);
  const first = await catalog.catalog();
  const [item] = first.items;
  assert.equal(item.prHead, HEAD);

  // 作者强推了新提交
  routes[`${API}/pulls/31`] = pull(31, NEW_HEAD);
  const again = await catalog.resolve(item.key);
  assert.equal(again.prHead, NEW_HEAD);
  assert.equal(again.key, item.key, "key 保持稳定，prHead 指纹判过期，旧记录仍可打开");
});

test("resolve rejects a pull that was closed after caching", async () => {
  const routes = {
    ...mainRoutes({ items: [], regs: [], apprs: [], pulls: [pull(41)] }),
    ...pullRoutes(41, {
      base: { regs: [], apprs: [] },
      head: { regs: [["gone", "o/gone"]], apprs: [["gone", "v0.1.0", sha("gone")]] },
    }),
  };
  const { sdk } = createSdk({ routes });
  const catalog = createMarketCatalog(sdk);
  const first = await catalog.catalog();
  routes[`${API}/pulls/41`] = { ...pull(41), state: "closed" };
  await assert.rejects(() => catalog.resolve(first.items[0].key), /关闭或合并/);
});

test("已安装主页包含市场未收录应用且不冒充可检查来源", async () => {
  const { sdk, calls } = createSdk({ routes: mainRoutes({ items: [indexItem("alpha")], regs: [["alpha", "o/alpha"]], apprs: [["alpha", "v1.0.0", sha("alpha")]] }),
    installed: [{ id: "alpha", kind: "app", version: "0.9.0" }, { id: "local", kind: "app", name: "本地应用" }, { id: "not-app", kind: "skill", version: "1.0.0" }] });
  const service = createMarketCatalog(sdk);
  const result = await service.catalog({ includePending: false });
  assert.equal(result.items.filter((item) => item.id === "alpha").length, 1);
  assert.equal(result.items.find((item) => item.id === "alpha").installed, true);
  const local = result.items.find((item) => item.id === "local");
  assert.equal(local.name, "本地应用");
  assert.equal(local.installedVersion, "版本未知");
  assert.equal(local.source, "installed");
  assert.equal(local.reviewable, false);
  assert.equal(local.repo, "");
  assert.equal(result.items.some((item) => item.id === "not-app"), false);
  const before = calls.length;
  await assert.rejects(service.resolve(local.key), /标识无效/);
  assert.equal(calls.length, before, "本机身份条目不能触发源码或模型链路");
});

test("索引图标只保留限长 data 图：栅格放行，SVG 需无脚本无外链", async () => {
  const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
  const safeSvg = `data:image/svg+xml;base64,${b64('<svg xmlns="http://www.w3.org/2000/svg"></svg>')}`;
  const scriptSvg = `data:image/svg+xml;base64,${b64('<svg><script>alert(1)</script></svg>')}`;
  const handlerSvg = `data:image/svg+xml;base64,${b64('<svg onload="alert(1)"></svg>')}`;
  const icons = ["data:image/png;base64,aGVsbG8=", safeSvg, scriptSvg, handlerSvg, "https://example.test/icon.png", "file:///private/icon.png", "data:image/png;base64,invalid<>!", `data:image/png;base64,${"a".repeat(1024 * 1024)}`];
  const ids = icons.map((_, i) => `icon-${i}`);
  const { sdk } = createSdk({ routes: mainRoutes({
    items: ids.map((id, i) => ({ ...indexItem(id), icon: icons[i] })), regs: ids.map((id) => [id, `o/${id}`]), apprs: ids.map((id) => [id, "v1.0.0", sha(id)]),
  }) });
  const { items } = await createMarketCatalog(sdk).catalog({ includePending: false });
  assert.equal(items[0].icon, icons[0]);
  assert.equal(items[1].icon, safeSvg, "无脚本的 SVG 图标要能显示");
  assert.ok(items.slice(2).every((item) => item.icon === ""), "脚本、事件、外链、远端地址、损坏或超限的图标一律不展示");
  assert.equal(items[0].installed, null, "安装信息不可用不能当作未安装");
});
