import test from "node:test";
import assert from "node:assert/strict";
import { createMarketCatalog } from "../lib/market-catalog.js";
import { githubHeaders, isRateLimited, readGithubToken, rateLimitMessage } from "../lib/github-token.js";

const TOKEN = "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz";

function sdkWith(value) {
  return { config: { get: (key) => (key === "githubToken" ? value : undefined) } };
}

test("没填令牌时按匿名公共接口走", () => {
  assert.equal(readGithubToken(sdkWith("")), "");
  assert.equal(readGithubToken(sdkWith("   ")), "");
  assert.equal(readGithubToken({}), "");
});

test("宿主没给设置接口时不报错，退回匿名", () => {
  assert.equal(readGithubToken({ config: {} }), "");
  assert.equal(readGithubToken({ config: { get: () => { throw new Error("boom"); } } }), "");
  assert.equal(readGithubToken(null), "");
});

test("本机预置文件里的令牌可以用（数据目录）", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyi-token-"));
  fs.writeFileSync(path.join(dir, "github-token.txt"), `${TOKEN}\n`, "utf8");
  assert.equal(readGithubToken({ dataDir: dir }), TOKEN);
  fs.writeFileSync(path.join(dir, "github-token.txt"), "不是令牌", "utf8");
  assert.equal(readGithubToken({ dataDir: dir }), "");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("设置页的值优先于本机预置文件", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyi-token-"));
  fs.writeFileSync(path.join(dir, "github-token.txt"), "github_pat_filefilefilefilefilefilefilefile1234", "utf8");
  const sdk = { dataDir: dir, config: { get: (key) => (key === "githubToken" ? TOKEN : undefined) } };
  assert.equal(readGithubToken(sdk), TOKEN);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("格式明显不对的令牌不采用，不发给 GitHub", () => {
  assert.equal(readGithubToken(sdkWith("abc")), "");
  assert.equal(readGithubToken(sdkWith("有中文的令牌")), "");
  assert.equal(readGithubToken(sdkWith("a".repeat(300))), "");
  assert.equal(readGithubToken(sdkWith(123)), "");
});

test("只有 api.github.com 的请求才带认证头", () => {
  const sdk = sdkWith(TOKEN);
  const api = githubHeaders(sdk, { Accept: "application/vnd.github+json" }, "https://api.github.com/repos/o/r/pulls");
  assert.equal(api.Authorization, `Bearer ${TOKEN}`);
  assert.equal(api.Accept, "application/vnd.github+json");
  const raw = githubHeaders(sdk, { Accept: "application/vnd.github+json" }, "https://raw.githubusercontent.com/o/r/main/index.v2.json");
  assert.equal(raw.Authorization, undefined);
});

test("没有令牌时不带认证头", () => {
  const headers = githubHeaders({ config: { get: () => "" } }, { Accept: "x" }, "https://api.github.com/repos/o/r");
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers.Accept, "x");
});

test("限流判定与提示", () => {
  assert.equal(isRateLimited(403), true);
  assert.equal(isRateLimited(429), true);
  assert.equal(isRateLimited(404), false);
  assert.equal(isRateLimited(500), false);
  assert.match(rateLimitMessage(), /只读令牌/);
  assert.match(rateLimitMessage(), /5000/);
});

const MAIN = "a".repeat(40);
const API = "https://api.github.com/repos/liliMozi/hana-marketplace";
const RAW = "https://raw.githubusercontent.com/liliMozi/hana-marketplace";

function catalogSdk(token) {
  const calls = [];
  const routes = {
    [`${API}/git/ref/heads/main`]: { object: { sha: MAIN, type: "commit" } },
    [`${RAW}/${MAIN}/index.v2.json`]: { schemaVersion: 2, sourceId: "official-global", name: "Hana Global Market", publishedAt: "2026-01-01T00:00:00.000Z", items: [] },
    [`${RAW}/${MAIN}/registry.json`]: { schemaVersion: 1, entries: [] },
    [`${RAW}/${MAIN}/approvals.json`]: { schemaVersion: 1, approvals: [] },
  };
  const sdk = {
    config: { get: (key) => (key === "githubToken" ? token : undefined) },
    environments: { listInstalledSources: async () => [] },
    network: {
      fetch: async (url, init) => {
        calls.push({ url, init });
        const value = routes[url];
        if (value === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
        return { ok: true, status: 200, json: async () => value, text: async () => JSON.stringify(value) };
      },
    },
  };
  return { sdk, calls };
}

test("填了令牌时，目录请求带认证；不填时走匿名", async () => {
  const withToken = catalogSdk(TOKEN);
  await createMarketCatalog(withToken.sdk).catalog();
  const apiCall = withToken.calls.find((call) => call.url.startsWith("https://api.github.com/"));
  assert.ok(apiCall, "应当有一次打向 api.github.com 的请求");
  assert.equal(apiCall.init.headers.Authorization, `Bearer ${TOKEN}`);
  const rawCall = withToken.calls.find((call) => call.url.startsWith(RAW));
  assert.ok(rawCall);
  assert.equal(rawCall.init.headers.Authorization, undefined);

  const anonymous = catalogSdk("");
  await createMarketCatalog(anonymous.sdk).catalog();
  const anonymousApi = anonymous.calls.find((call) => call.url.startsWith("https://api.github.com/"));
  assert.ok(anonymousApi);
  assert.equal(anonymousApi.init.headers.Authorization, undefined);
});
