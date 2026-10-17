import test from "node:test";
import assert from "node:assert/strict";
import {
  RECENT_SESSION_LIMIT,
  normalizeBallTargetState,
  normalizeSessionCandidate,
  pickRecentSessions,
  resolveTargetSession,
  toPinnedRecord,
} from "../lib/ball-target.js";

function session(id, modified, extra = {}) {
  return { sessionId: id, path: `sessions/${id}.jsonl`, title: `标题 ${id}`, agentName: "小花", modified, ...extra };
}

test("只保留球要用到的字段，认不出编号的直接丢", () => {
  assert.equal(normalizeSessionCandidate({ title: "没有编号" }), null);
  assert.equal(normalizeSessionCandidate(null), null);
  const row = normalizeSessionCandidate({
    sessionId: "sess_1", path: "sessions/a.jsonl", title: "今天", agentName: "小花",
    modified: 1234, secretContent: "不该带出来",
  });
  assert.deepEqual(Object.keys(row).sort(), ["agentId", "agentName", "modified", "sessionId", "sessionPath", "title"].sort());
  assert.equal(row.sessionPath, "sessions/a.jsonl");
  assert.equal(row.modified, 1234);
});

test("最近候选按 modified 倒序、去重、限长", () => {
  const list = [
    session("sess_old", 10),
    session("sess_new", 900),
    session("sess_mid", 500),
    session("sess_new", 950), // 重复编号只留一条
    { title: "无编号" },
  ];
  const picked = pickRecentSessions(list);
  assert.equal(picked.length, 3);
  assert.deepEqual(picked.map((row) => row.sessionId), ["sess_new", "sess_mid", "sess_old"]);
  assert.equal(picked[0].modified, 900, "重复编号取先遇到的那条，不重复计数");
  assert.equal(pickRecentSessions(list, 2).length, 2);
  assert.equal(pickRecentSessions(null).length, 0);
  assert.equal(RECENT_SESSION_LIMIT, 5);
});

test("modified 支持 ISO 字符串时间", () => {
  const picked = pickRecentSessions([
    session("sess_a", "2026-10-15T10:00:00Z"),
    session("sess_b", "2026-10-15T12:00:00Z"),
  ]);
  assert.deepEqual(picked.map((row) => row.sessionId), ["sess_b", "sess_a"]);
});

test("固定状态归一：没有编号的固定一律退回跟随", () => {
  assert.deepEqual(normalizeBallTargetState(null), { mode: "auto", pinned: null });
  assert.deepEqual(normalizeBallTargetState({ mode: "pinned", pinned: {} }), { mode: "auto", pinned: null });
  const pinned = normalizeBallTargetState({ mode: "pinned", pinned: { sessionId: "sess_1", title: "甲" } });
  assert.equal(pinned.mode, "pinned");
  assert.equal(pinned.pinned.sessionId, "sess_1");
});

test("跟随模式取最近活跃的一条", () => {
  const target = resolveTargetSession({ mode: "auto" }, [session("sess_old", 1), session("sess_new", 9)]);
  assert.equal(target.sessionId, "sess_new");
  assert.equal(target.mode, "auto");
  assert.equal(target.stale, false);
  assert.equal(resolveTargetSession({ mode: "auto" }, []), null);
});

test("固定且仍在最近 5 个里：用名单里那条（标题可能是新的）", () => {
  const target = resolveTargetSession(
    { mode: "pinned", pinned: { sessionId: "sess_2", title: "旧标题" } },
    [session("sess_1", 9), session("sess_2", 5, { title: "新标题" })],
  );
  assert.equal(target.sessionId, "sess_2");
  assert.equal(target.title, "新标题");
  assert.equal(target.stale, false);
});

test("固定但已掉出最近 5 个：仍按固定走并标记 stale", () => {
  const list = Array.from({ length: 6 }, (_, i) => session(`sess_${i}`, 100 - i));
  const target = resolveTargetSession(
    { mode: "pinned", pinned: { sessionId: "sess_gone", title: "老对话" } },
    list,
  );
  assert.equal(target.sessionId, "sess_gone");
  assert.equal(target.stale, true);
  assert.equal(target.mode, "pinned");
});

test("写盘记录只留可重建字段，不夹带会话内容", () => {
  const record = toPinnedRecord({ sessionId: "sess_1", title: "甲", agentName: "小花", path: "sessions/a.jsonl" });
  assert.deepEqual(record, {
    sessionId: "sess_1", sessionPath: "sessions/a.jsonl", title: "甲", agentId: "", agentName: "小花",
  });
  assert.equal(toPinnedRecord({ title: "没有编号" }), null);
});
