import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadingDiagnostics, READING_DIAGNOSTIC_EVENTS } from '../lib/reading-diagnostics.js';

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('事件攒成一条日志：每个事件不单独写，计数是整数', async () => {
  const writes = [];
  const diagnostics = createReadingDiagnostics(payload => { writes.push(payload); }, { intervalMs: 30_000 });
  diagnostics.record('start');
  diagnostics.record('start');
  diagnostics.record('under_300');
  assert.equal(writes.length, 0, '每个事件不单独发一条');
  await diagnostics.flush();
  assert.equal(writes.length, 1, '攒一批只写一条');
  assert.deepEqual(writes[0], { schema: 1, counts: { start: 2, under_300: 1 } });
  for (const value of Object.values(writes[0].counts)) assert.equal(Number.isInteger(value), true);
});

test('白名单之外的一律不记：正文、编号、自由字符串、对象都进不来', async () => {
  const writes = [];
  const diagnostics = createReadingDiagnostics(payload => { writes.push(payload); }, { intervalMs: 30_000 });
  diagnostics.record('start');
  diagnostics.record('这段是聊天正文');
  diagnostics.record('sess_0123456789abcdef');
  diagnostics.record('D:/me/.hanako/agents/hanako/sessions/chat.jsonl');
  diagnostics.record({ message: '正文', sessionId: 'sess_x' });
  diagnostics.record(['start']);
  diagnostics.record(null);
  diagnostics.record(undefined);
  diagnostics.record(42);
  diagnostics.record('start\n正文');
  diagnostics.record('START');
  diagnostics.record('toString');
  await diagnostics.flush();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].counts, { start: 1 }, '只有白名单里的事件名算数');
  assert.deepEqual(Object.keys(writes[0].counts), ['start'], '写出去的内容只有事件名和整数');
});

test('写日志失败不影响业务：同步抛错与异步拒绝都被吞掉', async () => {
  const thrown = createReadingDiagnostics(() => { throw new Error('日志挂了'); }, { intervalMs: 30_000 });
  thrown.record('start');
  await assert.doesNotReject(() => thrown.flush());

  const rejected = createReadingDiagnostics(() => Promise.reject(new Error('异步失败')), { intervalMs: 30_000 });
  rejected.record('start');
  await assert.doesNotReject(() => rejected.flush());
});

test('没有事件就不写，也不排定时器', async () => {
  const writes = [];
  const diagnostics = createReadingDiagnostics(payload => { writes.push(payload); }, { intervalMs: 20 });
  await diagnostics.flush();
  await wait(80);
  assert.equal(writes.length, 0, '静默时不该有任何写入');
});

test('定时批量写：多条事件只发一条', async () => {
  const writes = [];
  const diagnostics = createReadingDiagnostics(payload => { writes.push(payload); }, { intervalMs: 20 });
  diagnostics.record('start');
  diagnostics.record('finish');
  assert.equal(writes.length, 0);
  await wait(120);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].counts, { start: 1, finish: 1 });
});

test('写失败不重试：不会连着占 RPC 仓', async () => {
  let attempts = 0;
  const diagnostics = createReadingDiagnostics(() => { attempts++; throw new Error('日志挂了'); }, { intervalMs: 20 });
  diagnostics.record('start');
  await wait(150);
  assert.equal(attempts, 1, '失败一次就停，不定时重试');
});

test('白名单是固定且有界的', () => {
  assert.ok(READING_DIAGNOSTIC_EVENTS.includes('start'));
  assert.ok(READING_DIAGNOSTIC_EVENTS.includes('prepared'));
  assert.equal(new Set(READING_DIAGNOSTIC_EVENTS).size, READING_DIAGNOSTIC_EVENTS.length);
  assert.ok(READING_DIAGNOSTIC_EVENTS.length < 64, '事件名固定有界');
});
