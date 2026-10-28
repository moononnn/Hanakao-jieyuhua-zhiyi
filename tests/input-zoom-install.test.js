import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const helper = path.join(appRoot, "assets", "install-input-zoom.ps1");
const isWindows = process.platform === "win32";

function makeRenderer() {
  const base = mkdtempSync(path.join(tmpdir(), "hdiz-test-"));
  const root = path.join(base, "renderer");
  const dir = path.join(root, "1.2.3-test");
  mkdirSync(path.join(dir, "modules"), { recursive: true });
  writeFileSync(
    path.join(dir, "index.html"),
    '<!DOCTYPE html><html><body><div id="react-root"></div></body></html>',
    "utf8"
  );
  return { base, root, dir };
}

function runHelper(args, options = {}) {
  const raw = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, ...args],
    { encoding: "utf8", ...options }
  );
  const start = raw.lastIndexOf("{");
  assert.ok(start >= 0, `安装助手没有回 JSON：${raw}`);
  return JSON.parse(raw.slice(start));
}

test("安装助手必须是带 BOM 的纯 ASCII 文件，否则 5.1 会把注释后面的行吃掉", { skip: !isWindows }, () => {
  const bytes = readFileSync(helper);
  assert.deepEqual(
    [bytes[0], bytes[1], bytes[2]],
    [0xef, 0xbb, 0xbf],
    "缺少 UTF-8 BOM：Windows PowerShell 5.1 会按系统 ANSI 代码页读脚本"
  );
  const body = bytes.subarray(3);
  const bad = body.find((byte) => byte > 0x7f);
  assert.equal(bad, undefined, `脚本里有非 ASCII 字节（${bad}）：ANSI 解码时可能吞掉换行`);
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === 0x0a) {
      assert.equal(body[i - 1], 0x0d, `第 ${i} 个字节是裸 LF：换行必须用 CRLF`);
    }
  }
});

test("装一次，文件真的写进去了", { skip: !isWindows }, () => {
  const { base, root, dir } = makeRenderer();
  try {
    const result = runHelper(["-Action", "install", "-Root", root]);
    assert.equal(result.ok, true);
    assert.equal(result.installed, true);
    assert.equal(result.justInstalled, true);
    assert.equal(result.code, "OK");
    assert.match(readFileSync(path.join(dir, "index.html"), "utf8"), /data-hdiz="1"/);
    assert.ok(existsSync(path.join(dir, "modules", "draft-image-zoom.js")), "脚本文件没落盘");
    assert.ok(existsSync(path.join(dir, "index.html.hdiz.bak")), "原 index.html 没备份");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("再装一次不会插第二行", { skip: !isWindows }, () => {
  const { base, root, dir } = makeRenderer();
  try {
    runHelper(["-Action", "install", "-Root", root]);
    runHelper(["-Action", "install", "-Root", root]);
    const html = readFileSync(path.join(dir, "index.html"), "utf8");
    assert.equal(html.match(/data-hdiz="1"/g).length, 1);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("参数没绑上也要靠环境变量兜住，不能退化成只读状态", { skip: !isWindows }, () => {
  const { base, root, dir } = makeRenderer();
  try {
    const result = runHelper(["-Root", root], { env: { ...process.env, HDIZ_ACTION: "install" } });
    assert.equal(result.action, "install");
    assert.equal(result.installed, true);
    assert.match(readFileSync(path.join(dir, "index.html"), "utf8"), /data-hdiz="1"/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("不认识的命令要明说，不能装作跑过了", { skip: !isWindows }, () => {
  const { base, root } = makeRenderer();
  try {
    const result = runHelper(["-Action", "wat", "-Root", root]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "BAD_ACTION");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("卸载能把注入和脚本都撤掉", { skip: !isWindows }, () => {
  const { base, root, dir } = makeRenderer();
  try {
    runHelper(["-Action", "install", "-Root", root]);
    const result = runHelper(["-Action", "uninstall", "-Root", root]);
    assert.equal(result.ok, true);
    assert.equal(result.installed, false);
    assert.doesNotMatch(readFileSync(path.join(dir, "index.html"), "utf8"), /data-hdiz="1"/);
    assert.ok(!existsSync(path.join(dir, "modules", "draft-image-zoom.js")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("界面不许在没装上的情况下写「装好了」", () => {
  const script = readFileSync(path.join(appRoot, "ui", "assets", "panel-layout.js"), "utf8");
  assert.match(script, /payload\.installed !== true/, "安装结果必须先验再报成功");
  assert.match(script, /装好了。完全退出 Hana 再启动/);
  // 「装好了」只能挂在 installed 为真的分支后面，不能是无条件赋值。
  const installBlock = script.slice(script.indexOf("/input-zoom/install"));
  const claim = installBlock.indexOf("装好了。完全退出 Hana 再启动");
  const guard = installBlock.indexOf("payload.installed !== true");
  assert.ok(guard >= 0 && claim > guard, "成功文案必须写在校验之后");
});
