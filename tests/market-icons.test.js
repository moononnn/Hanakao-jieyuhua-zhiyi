import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPendingIcon, safeDataIcon } from "../lib/market-icons.js";

const REPO = "o/alpha";
const REF = "v1.0.0";
const TOKEN = "t".repeat(30);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
const PNG_DATA = `data:image/png;base64,${PNG.toString("base64")}`;

function tempSdk(routes = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyi-icons-"));
  const calls = [];
  return {
    dataDir,
    calls,
    sdk: {
      dataDir,
      network: {
        fetch: async (url) => {
          calls.push(url);
          const route = routes[url];
          if (route === undefined) return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
          if (route instanceof Error) throw route;
          return {
            ok: true,
            status: 200,
            json: async () => route.json,
            arrayBuffer: async () => route.buffer,
          };
        },
      },
    },
  };
}

const manifestUrl = (icon) => `https://raw.githubusercontent.com/${REPO}/${REF}/manifest.json`;
const assetUrl = (file) => `https://raw.githubusercontent.com/${REPO}/${REF}/${file}`;

test("manifest 里的相对图标路径会被取回并转成内嵌图", async (t) => {
  const h = tempSdk({
    [manifestUrl()]: { json: { icon: "assets/icon.png" } },
    [assetUrl("assets/icon.png")]: { buffer: PNG },
  });
  t.after(() => fs.rmSync(h.dataDir, { recursive: true, force: true }));
  const icon = await readPendingIcon(h.sdk, { repo: REPO, ref: REF, id: "alpha" });
  assert.equal(icon, PNG_DATA);
  assert.deepEqual(h.calls, [manifestUrl(), assetUrl("assets/icon.png")]);
});

test("同一个候选提交只拉一次，第二次读本地", async (t) => {
  const h = tempSdk({
    [manifestUrl()]: { json: { icon: "assets/icon.png" } },
    [assetUrl("assets/icon.png")]: { buffer: PNG },
  });
  t.after(() => fs.rmSync(h.dataDir, { recursive: true, force: true }));
  await readPendingIcon(h.sdk, { repo: REPO, ref: REF, id: "alpha" });
  const before = h.calls.length;
  const second = await readPendingIcon(h.sdk, { repo: REPO, ref: REF, id: "alpha" });
  assert.equal(second, PNG_DATA);
  assert.equal(h.calls.length, before, "命中缓存不再发请求");
});

test("没有图标的结论也缓存，不用每次白跑一遍", async (t) => {
  const h = tempSdk({ [manifestUrl()]: { json: {} } });
  t.after(() => fs.rmSync(h.dataDir, { recursive: true, force: true }));
  assert.equal(await readPendingIcon(h.sdk, { repo: REPO, ref: REF, id: "alpha" }), "");
  const before = h.calls.length;
  assert.equal(await readPendingIcon(h.sdk, { repo: REPO, ref: REF, id: "alpha" }), "");
  assert.equal(h.calls.length, before);
});

test("仓库路径、外部地址、向上跳目录一律不认", async (t) => {
  for (const icon of ["https://evil.example/x.png", "../../etc/passwd", "/abs/icon.png", "javascript:alert(1)"]) {
    const h = tempSdk({ [manifestUrl()]: { json: { icon } } });
    t.after(() => fs.rmSync(h.dataDir, { recursive: true, force: true }));
    assert.equal(await readPendingIcon(h.sdk, { repo: REPO, ref: REF, id: "alpha" }), "", icon);
    assert.equal(h.calls.length, 1, `只该读 manifest，不该去取 ${icon}`);
  }
});

test("不认识的扩展名直接放过，不去下载", async (t) => {
  const h = tempSdk({ [manifestUrl()]: { json: { icon: "assets/icon.bmp" } } });
  t.after(() => fs.rmSync(h.dataDir, { recursive: true, force: true }));
  assert.equal(await readPendingIcon(h.sdk, { repo: REPO, ref: REF, id: "alpha" }), "");
  assert.equal(h.calls.length, 1);
});

test("带脚本或外链的 SVG 不收", async (t) => {
  const unsafe = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const h = tempSdk({
    [manifestUrl()]: { json: { icon: "assets/icon.svg" } },
    [assetUrl("assets/icon.svg")]: { buffer: unsafe },
  });
  t.after(() => fs.rmSync(h.dataDir, { recursive: true, force: true }));
  assert.equal(await readPendingIcon(h.sdk, { repo: REPO, ref: REF, id: "alpha" }), "");
});

test("干净的 SVG 照收", async (t) => {
  const clean = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
  const h = tempSdk({
    [manifestUrl()]: { json: { icon: "./assets/icon.svg" } },
    [assetUrl("assets/icon.svg")]: { buffer: clean },
  });
  t.after(() => fs.rmSync(h.dataDir, { recursive: true, force: true }));
  const icon = await readPendingIcon(h.sdk, { repo: REPO, ref: REF, id: "alpha" });
  assert.match(icon, /^data:image\/svg\+xml;base64,/);
});

test("manifest 本身就带内嵌图时直接用它", async (t) => {
  const h = tempSdk({ [manifestUrl()]: { json: { icon: PNG_DATA } } });
  t.after(() => fs.rmSync(h.dataDir, { recursive: true, force: true }));
  assert.equal(await readPendingIcon(h.sdk, { repo: REPO, ref: REF, id: "alpha" }), PNG_DATA);
  assert.equal(h.calls.length, 1);
});

test("仓库读不到就返回空，不抛错", async (t) => {
  const h = tempSdk({});
  t.after(() => fs.rmSync(h.dataDir, { recursive: true, force: true }));
  assert.equal(await readPendingIcon(h.sdk, { repo: REPO, ref: REF, id: "alpha" }), "");
});

test("manifest 在子目录时，用树接口找一次，图标相对 manifest 目录解析", async (t) => {
  const treeUrl = `https://api.github.com/repos/${REPO}/git/trees/${encodeURIComponent(REF)}?recursive=1`;
  const h = tempSdk({
    [treeUrl]: { json: { tree: [{ path: "README.md" }, { path: "packages/app/src/manifest.json" }, { path: "packages/app/src/index.js" }] } },
    [assetUrl("packages/app/src/manifest.json")]: { json: { icon: "../assets/icon.png" } },
    [assetUrl("packages/app/assets/icon.png")]: { buffer: PNG },
  });
  // 填了令牌才会去花 API 额度查树。
  h.sdk.config = { get: (key) => (key === "githubToken" ? TOKEN : "") };
  t.after(() => fs.rmSync(h.dataDir, { recursive: true, force: true }));
  const icon = await readPendingIcon(h.sdk, { repo: REPO, ref: REF, id: "alpha" });
  assert.equal(icon, PNG_DATA);
  assert.deepEqual(h.calls, [
    manifestUrl(),
    treeUrl,
    assetUrl("packages/app/src/manifest.json"),
    assetUrl("packages/app/assets/icon.png"),
  ]);
});

test("没填令牌时不动用树接口，免得把匿名额度吃光", async (t) => {
  const h = tempSdk({});
  t.after(() => fs.rmSync(h.dataDir, { recursive: true, force: true }));
  assert.equal(await readPendingIcon(h.sdk, { repo: REPO, ref: REF, id: "alpha" }), "");
  assert.deepEqual(h.calls, [manifestUrl()], "只试了根路径那次");
});

test("图标超出体积上限就不收，700KB 以内照收", async (t) => {
  const big = Buffer.alloc(800 * 1024, 7);
  const okBig = Buffer.alloc(600 * 1024, 7);
  const h = tempSdk({
    [manifestUrl()]: { json: { icon: "assets/icon.png" } },
    [assetUrl("assets/icon.png")]: { buffer: big },
  });
  t.after(() => fs.rmSync(h.dataDir, { recursive: true, force: true }));
  assert.equal(await readPendingIcon(h.sdk, { repo: REPO, ref: REF, id: "alpha" }), "");

  const h2 = tempSdk({
    [manifestUrl()]: { json: { icon: "assets/icon.png" } },
    [assetUrl("assets/icon.png")]: { buffer: okBig },
  });
  t.after(() => fs.rmSync(h2.dataDir, { recursive: true, force: true }));
  const icon = await readPendingIcon(h2.sdk, { repo: REPO, ref: REF, id: "alpha" });
  assert.ok(icon.startsWith("data:image/png;base64,"));
});

test("仓库名或提交号不像样就不发请求", async (t) => {
  const h = tempSdk({});
  t.after(() => fs.rmSync(h.dataDir, { recursive: true, force: true }));
  assert.equal(await readPendingIcon(h.sdk, { repo: "not-a-repo", ref: REF, id: "x" }), "");
  assert.equal(await readPendingIcon(h.sdk, { repo: REPO, ref: "a/b", id: "x" }), "");
  assert.equal(h.calls.length, 0);
});

test("宿主没给数据目录时照常返回图，只是不缓存", async () => {
  const sdk = { network: { fetch: async () => ({ ok: true, json: async () => ({ icon: "assets/icon.png" }), arrayBuffer: async () => PNG }) } };
  assert.equal(await readPendingIcon(sdk, { repo: REPO, ref: REF, id: "alpha" }), PNG_DATA);
});

test("safeDataIcon 只放行内嵌图，远端地址与脚本 SVG 都不要", () => {
  assert.equal(safeDataIcon(PNG_DATA), PNG_DATA);
  assert.equal(safeDataIcon("https://example.com/a.png"), "");
  assert.equal(safeDataIcon("data:image/png;base64,@@@"), "");
  const bad = Buffer.from('<svg onload="alert(1)"></svg>').toString("base64");
  assert.equal(safeDataIcon(`data:image/svg+xml;base64,${bad}`), "");
});
