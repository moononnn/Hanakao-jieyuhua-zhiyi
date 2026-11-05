// Run from repository/tests/nonshutdown-hardening.test.js after applying the bundle.
// All tests are deterministic and must never invoke Windows shutdown commands.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildQueueItems, QueuePlanRegistry, QUEUE_MAX_ITEMS } from "../lib/queue-plan.js";
import { sessionModifiedMillis } from "../lib/send.js";
import { ContinueLoopRegistry, LOOP_MAX_STATES } from "../lib/continue-loop.js";
import { validateCustomModelBaseUrl } from "../lib/custom-model.js";
import { githubHeaders } from "../lib/github-token.js";
import { clipFile, clipMetaFile, pruneVoiceClipFiles, synthesizeVoice } from "../lib/voice.js";
import { patchLines } from "../lib/market-review.js";
import { protectKey } from "../lib/crypto.js";

test("排队项超过上限时明确拒绝、不能静默漏掉后面的消息", () => {
  const items = Array.from({ length: QUEUE_MAX_ITEMS + 1 }, (_, i) => `第 ${i + 1} 句`);
  const result = buildQueueItems(items);
  assert.equal(result.ok, false);
  assert.equal(result.items.length, 0);
  assert.match(result.error, /最多排.*句/);
});

test("排队项直接调用 Registry.start 也不能绕过数量限制", () => {
  const registry = new QueuePlanRegistry();
  const items = Array.from({ length: QUEUE_MAX_ITEMS + 1 }, () => ({ text: "测试", repeat: 1 }));
  assert.equal(registry.start({ sessionId: "s1", items }).ok, false);
});

test("用户说「不要继续了」不能被当成 App 自动发送的「继续」", () => {
  const queue = new QueuePlanRegistry();
  const started = queue.start({ sessionId: "s", items: [{ text: "继续", repeat: 3 }] });
  assert.equal(started.ok, true);
  queue.markSending("s", "继续");
  assert.equal(queue.isOwnPrompt("s", "继续"), true);
  assert.equal(queue.isOwnPrompt("s", "不要继续了"), false);
  assert.equal(queue.isOwnPrompt("s", " 继续 "), true);
});

test("按 ISO 时间戳排序会话，不会把最新会话当成 0", () => {
  const expected = Date.parse("2026-11-05T07:00:00.000Z");
  assert.equal(sessionModifiedMillis("2026-11-05T07:00:00.000Z"), expected);
  assert.equal(sessionModifiedMillis(1793862000), 1793862000000);
  assert.equal(sessionModifiedMillis(null), 0);
});

test("40 个活跃循环不会被新建循环静默驱逐", () => {
  const loops = new ContinueLoopRegistry();
  for (let i = 0; i < LOOP_MAX_STATES; i += 1) {
    assert.equal(loops.start({ sessionId: `s${i}`, rounds: 2 }).ok, true);
  }
  assert.equal(loops.start({ sessionId: "overflow", rounds: 2 }).ok, false);
  assert.equal(loops.get("s0").status, "running");
  assert.equal(loops.list().length, LOOP_MAX_STATES);
});

test("自定义模型只允许远程 HTTPS、本机回环可 HTTP", () => {
  assert.equal(validateCustomModelBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
  assert.equal(validateCustomModelBaseUrl("http://127.0.0.1:1234/v1"), "http://127.0.0.1:1234/v1");
  assert.throws(() => validateCustomModelBaseUrl("http://api.example.com/v1"), /HTTPS/);
  assert.throws(() => validateCustomModelBaseUrl("https://evil:secret@api.example.com/v1"), /账号|密码/);
  assert.throws(() => validateCustomModelBaseUrl("https://api.example.com/v1?token=abc"), /查询参数/);
});

test("GitHub 令牌只能加在 api.github.com 精确 origin 上", () => {
  const sdk = { config: { get: () => "x".repeat(30) } };
  assert.equal(githubHeaders(sdk, {}, "https://api.github.com/repos/a/b").Authorization, `Bearer ${"x".repeat(30)}`);
  assert.equal(githubHeaders(sdk, {}, "https://api.github.com.evil.test/repos/a/b").Authorization, undefined);
  assert.equal(githubHeaders(sdk, {}, "https://api.github.com@evil.test/repos/a/b").Authorization, undefined);
  assert.equal(githubHeaders(sdk, {}, "http://api.github.com/repos/a/b").Authorization, undefined);
});

test("音频文件 ID 不能使用路径穿越与斜杠", () => {
  const sdk = { dataDir: "/tmp/demo-zhiyi" };
  assert.throws(() => clipFile(sdk, "../outside"), /Invalid voice clip ID/);
  assert.throws(() => clipMetaFile(sdk, "../../outside"), /Invalid voice clip ID/);
  assert.match(clipFile(sdk, "good_id", "wav"), /good_id\.wav$/);
});

test("Unified Diff 删除行使用旧坐标、添加行使用新坐标", () => {
  const patch = [
    "@@ -20,4 +30,4 @@",
    " context",
    "-old1",
    "-old2",
    "+new1",
    " context2",
    "" ,
  ].join("\n");
  const result = patchLines(patch);
  assert.deepEqual(result.removed.map(x => x.oldLine), [21, 22]);
  assert.deepEqual(result.added.map(x => x.newLine), [31]);
});

test("非 Windows 平台不允许静默把新 API Key 落盘成明文", async () => {
  if (process.platform === "win32") return;
  await assert.rejects(() => protectKey("secret"), { code: "API_KEY_PROTECTION_UNAVAILABLE" });
});


test("清理超过 30 天的孤儿音频，保留收藏引用与最近文件", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyi-cleanup-"));
  try {
    const sdk = { dataDir: dir };
    const clipDir = path.join(dir, "voice-clips");
    fs.mkdirSync(clipDir);
    const old = new Date(Date.now() - 45 * 86400_000);
    for (const filename of ["clip_old1.mp3", "clip_kept1.wav", "clip_recent.mp3", "unrelated.txt"]) {
      fs.writeFileSync(path.join(clipDir, filename), "x");
      if (filename !== "clip_recent.mp3") fs.utimesSync(path.join(clipDir, filename), old, old);
    }
    const count = pruneVoiceClipFiles(sdk, ["clip_kept1"]);
    assert.equal(count, 1);
    assert.equal(fs.existsSync(path.join(clipDir, "clip_old1.mp3")), false);
    assert.equal(fs.existsSync(path.join(clipDir, "clip_kept1.wav")), true);
    assert.equal(fs.existsSync(path.join(clipDir, "clip_recent.mp3")), true);
    assert.equal(fs.existsSync(path.join(clipDir, "unrelated.txt")), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("远程字幕链接不能诱导知意访问其他源或本地网关", async () => {
  const calls = [];
  const ctx = {
    network: { fetch: async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        data: { audio: "494433", subtitle: [], subtitle_file: "http://127.0.0.1:8080/private" },
      }), { status: 200 });
    } },
  };
  const result = await synthesizeVoice(ctx, {
    text: "你好", config: {
      enabled: true, protocol: "t2a", baseUrl: "https://api.minimaxi.com",
      model: "speech-2.8-hd", groupId: "123", apiKey: "plain-test",
      speed: 1, scope: "all", maxChars: 800, defaultVoiceId: "female-shaonv",
    },
  });
  assert.ok(result.audio.length > 0);
  assert.equal(calls.length, 1, "不应跟随返回体中的本地字幕 URL");
  assert.equal(calls[0].startsWith("https://api.minimaxi.com"), true);
});
