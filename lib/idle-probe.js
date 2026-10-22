// 知意 · 空闲探针（开发期，只读）
//
// 用途只剩一个：把「Hana 这一刻到底空不空」连续拍下来，肉眼对时间线用。
// 采样本身已经搬去 lib/idle-watch.js（正式模块），自动关机的判定在 lib/sleep-guard.js，
// 这个文件只是一层开发期的观察壳，发布前可以整份删掉，不影响守门功能。
//
// 它不发任何关机命令，不写任何会话，不改任何设置。

import { sampleIdleSnapshot, summarizeSnapshot } from "./idle-watch.js";

const DEFAULT_RECENT_MS = 10 * 60 * 1000;
const DEFAULT_MAX_PROBE = 40;
const MAX_SAMPLES = 600;

const watchers = new Map();

function errorBrief(error) {
  return {
    code: String(error?.code || "").slice(0, 48),
    message: String(error?.message || error).slice(0, 160),
  };
}

function watchIdOf(input) {
  const raw = String(input || "").trim();
  return raw || "default";
}

/** 后台定时采样，结果留在内存里。只采样，不做任何动作。 */
export function startIdleWatch(sdk, options = {}) {
  const intervalMs = Math.max(2_000, Number(options.intervalMs) || 5_000);
  const durationMs = Math.max(intervalMs, Number(options.durationMs) || 10 * 60 * 1000);
  const recentMs = Number(options.recentMs) > 0 ? Number(options.recentMs) : DEFAULT_RECENT_MS;
  const maxProbe = Number(options.maxProbe) > 0 ? Number(options.maxProbe) : DEFAULT_MAX_PROBE;
  const id = watchIdOf(options.watchId);
  const label = String(options.label || "").slice(0, 60);

  const previous = watchers.get(id);
  if (previous) clearInterval(previous.timer);

  const record = {
    id,
    label,
    startedAt: Date.now(),
    intervalMs,
    durationMs,
    recentMs,
    finished: false,
    samples: [],
  };

  const write = (entry) => {
    record.samples.push(entry);
    if (record.samples.length > MAX_SAMPLES) record.samples.splice(0, record.samples.length - MAX_SAMPLES);
  };

  write({ kind: "start", at: new Date(record.startedAt).toISOString(), label, intervalMs, durationMs, recentMs });

  async function tick() {
    try {
      const snapshot = await sampleIdleSnapshot(sdk, { recentMs, maxProbe });
      write({ kind: "sample", ...summarizeSnapshot(snapshot), errors: snapshot.errors.slice(0, 6) });
    } catch (error) {
      write({ kind: "sample-error", at: new Date().toISOString(), ...errorBrief(error) });
    }
  }

  const timer = setInterval(() => {
    if (Date.now() - record.startedAt >= durationMs) {
      clearInterval(timer);
      record.finished = true;
      write({ kind: "stop", at: new Date().toISOString(), elapsedMs: Date.now() - record.startedAt });
      return;
    }
    void tick();
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  record.timer = timer;
  watchers.set(id, record);
  void tick();

  return { watchId: id, intervalMs, durationMs, startedAt: record.startedAt, note: "结果只放内存，用 report 取；App 重载会清空。" };
}

export function stopIdleWatch(watchIdInput) {
  const id = watchIdOf(watchIdInput);
  const record = watchers.get(id);
  if (!record) return { stopped: false, watchId: id };
  clearInterval(record.timer);
  record.finished = true;
  record.samples.push({ kind: "stop", at: new Date().toISOString(), elapsedMs: Date.now() - record.startedAt });
  return { stopped: true, watchId: id, sampleCount: record.samples.length };
}

/** 取回某个 watch 的记录。offset 用来分页，返回 nextOffset。 */
export function reportIdleWatch(watchIdInput, options = {}) {
  const id = watchIdOf(watchIdInput);
  const record = watchers.get(id);
  if (!record) return { found: false, watchId: id };
  const offset = Math.max(0, Number(options.offset) || 0);
  const limit = Math.min(400, Math.max(1, Number(options.limit) || 200));
  const slice = record.samples.slice(offset, offset + limit);
  return {
    found: true,
    watchId: id,
    label: record.label,
    startedAt: record.startedAt,
    finished: record.finished,
    sampleCount: record.samples.length,
    offset,
    nextOffset: offset + slice.length < record.samples.length ? offset + slice.length : null,
    samples: slice,
  };
}

export function listIdleWatches() {
  return [...watchers.values()].map((item) => ({
    watchId: item.id,
    label: item.label,
    startedAt: item.startedAt,
    finished: item.finished,
    sampleCount: item.samples.length,
  }));
}
