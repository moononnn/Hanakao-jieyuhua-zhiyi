// 自动整理解析链的中性 mock 回归：整理只用「现有快速档 → 现有备用档」两档。
// 全程假宿主、假模型：不发真实请求、不读真实配置、不写真实存储。
// 断言只覆盖链路构成与配置边界，不评价整理质量、跳过与否或速度。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReadingModelChain } from '../lib/reading-model.js';
import { resolveFastModelChain } from '../lib/fast-model.js';
import { prepareReading } from '../lib/reply-reading.js';

const FAST = { provider: 'fixture-provider', model: 'quick-model' };
const FAST_ALT = { provider: 'fixture-provider', model: 'quick-model-alt' };
const CONTENT = { provider: 'fixture-provider', model: 'content-model' };
const BACKUP = { provider: 'fixture-provider', model: 'backup-model' };
const BACKUP_ALT = { provider: 'fixture-provider', model: 'backup-model-alt' };
const LEGACY_INDEPENDENT = { provider: 'fixture-provider', model: 'reading-pick' };

const catalogRow = (ref, name) => ({ ...ref, name });
const DEFAULT_CATALOG = [catalogRow(FAST, '快速档模型'), catalogRow(FAST_ALT, '快速档模型二'), catalogRow(CONTENT, '内容档模型'), catalogRow(BACKUP, '备用档模型'), catalogRow(BACKUP_ALT, '备用档模型二')];

const longSource = {
  question: '这件事现在怎么样了？',
  earlier: ['前段记录：已经核对过配置与调用位置，确认触发环节在整理判定。'.repeat(6)],
  final: '结果已经确认：触发环节已定位，改动尚未提交，等复核。'.repeat(8),
  mode: 'result',
};

function ndjson(lines) {
  return new Response(lines.map((line) => JSON.stringify(line)).join('\n'), { headers: { 'content-type': 'application/x-ndjson' } });
}

function createSdk({ stored = {}, catalog = DEFAULT_CATALOG, streamText = 'SKIP', onStream = null } = {}) {
  const calls = { get: [], set: [], list: 0, stream: [], cancel: [] };
  const sdk = {
    calls,
    storage: {
      global: {
        get: async (key, fallback = null) => {
          calls.get.push(key);
          return Object.hasOwn(stored, key) ? stored[key] : fallback;
        },
        set: async (key, value) => { calls.set.push({ key, value }); stored[key] = value; },
      },
    },
    models: {
      list: async () => { calls.list += 1; return catalog; },
      stream: async (request) => {
        calls.stream.push(request);
        if (onStream) return onStream(request, calls.stream.length);
        return ndjson([{ type: 'text-delta', requestId: request.requestId, delta: streamText }, { type: 'done', requestId: request.requestId, stopReason: 'stop' }]);
      },
      cancel: async (id) => { calls.cancel.push(id); return true; },
    },
  };
  sdk.stored = stored;
  return sdk;
}

const roles = (chain) => chain.map((entry) => entry.role);
const models = (chain) => chain.map((entry) => entry.model?.model).filter(Boolean);

test('整理链只有快速档与备用档：没有内容主档，也没有自定义档', async () => {
  const sdk = createSdk({
    stored: {
      fastTaskModel: FAST,
      recommendationModel: CONTENT,
      recommendationFallbackModel: BACKUP,
      customTextModel: { enabled: true, baseUrl: 'https://example.test/v1', model: 'custom-m', apiKey: 'fixture-key' },
    },
  });
  const chain = await resolveReadingModelChain(sdk, null);
  assert.deepEqual(roles(chain), ['fast', 'backup']);
  assert.deepEqual(models(chain), [FAST.model, BACKUP.model]);
  assert.ok(chain.every((entry) => entry.kind === 'host'), '整理链只用 Hana 目录里的模型');
  assert.ok(!sdk.calls.get.includes('recommendationModel'), '内容主档不该被读');
  assert.ok(!sdk.calls.get.includes('customTextModel'), '自定义档不该被读');
});

test('改了快速档或备用档，下一次解析实时跟随', async () => {
  const sdk = createSdk({ stored: { fastTaskModel: FAST, recommendationFallbackModel: BACKUP } });
  const first = await resolveReadingModelChain(sdk, null);
  assert.deepEqual(models(first), [FAST.model, BACKUP.model]);
  sdk.stored.fastTaskModel = FAST_ALT;
  sdk.stored.recommendationFallbackModel = BACKUP_ALT;
  const second = await resolveReadingModelChain(sdk, null);
  assert.deepEqual(models(second), [FAST_ALT.model, BACKUP_ALT.model], '每次解析都重新读设置');
});

test('快速档缺失或目录里没有时，用备用档', async () => {
  const noFast = createSdk({ stored: { recommendationFallbackModel: BACKUP } });
  const onlyBackup = await resolveReadingModelChain(noFast, null);
  assert.deepEqual(roles(onlyBackup), ['backup']);
  assert.deepEqual(models(onlyBackup), [BACKUP.model]);

  const goneFromCatalog = createSdk({
    stored: { fastTaskModel: { provider: 'fixture-provider', model: 'not-in-catalog' }, recommendationFallbackModel: BACKUP },
  });
  const fallback = await resolveReadingModelChain(goneFromCatalog, null);
  assert.deepEqual(roles(fallback), ['backup']);
  assert.deepEqual(models(fallback), [BACKUP.model]);
});

test('内容与备用指向同一条模型时，备用仍保留（内容位在去重之前就被跳过）', async () => {
  const sdk = createSdk({ stored: { fastTaskModel: FAST, recommendationModel: BACKUP, recommendationFallbackModel: BACKUP } });
  const chain = await resolveReadingModelChain(sdk, null);
  assert.deepEqual(roles(chain), ['fast', 'backup']);
  assert.deepEqual(models(chain), [FAST.model, BACKUP.model]);
});

test('快速档与备用档是同一条模型时只留一条', async () => {
  const sdk = createSdk({ stored: { fastTaskModel: BACKUP, recommendationFallbackModel: BACKUP } });
  const chain = await resolveReadingModelChain(sdk, null);
  assert.equal(chain.length, 1);
  assert.deepEqual(roles(chain), ['fast']);
});

test('两档都不可用时固定 MODEL_NOT_FOUND：内容主档、Ask 与自定义档都不借用', async () => {
  const sdk = createSdk({
    stored: {
      recommendationModel: CONTENT,
      summaryModel: CONTENT,
      askJudgeModel: CONTENT,
      customTextModel: { enabled: true, baseUrl: 'https://example.test/v1', model: 'custom-m', apiKey: 'fixture-key' },
    },
  });
  await assert.rejects(() => resolveReadingModelChain(sdk, CONTENT), (error) => error.code === 'MODEL_NOT_FOUND');
});

test('旧的独立键不读也不参与', async () => {
  const sdk = createSdk({ stored: { replyReadingModel: LEGACY_INDEPENDENT, fastTaskModel: FAST, recommendationFallbackModel: BACKUP } });
  const chain = await resolveReadingModelChain(sdk, null);
  assert.deepEqual(roles(chain), ['fast', 'backup']);
  assert.ok(!models(chain).includes(LEGACY_INDEPENDENT.model), '独立键里的模型不进整理链');
  assert.ok(!sdk.calls.get.includes('replyReadingModel'), '独立键不再被读');
});

test('短源（去空白不足 300 字）在任何 SDK 访问前返回', async () => {
  const forbidden = () => { throw new Error('短源不应访问 SDK'); };
  const sdk = { storage: { global: { get: forbidden } }, models: { list: forbidden, stream: forbidden } };
  const shortSource = { question: '问', earlier: [], final: `${'甲'.repeat(299)} \n\t`, mode: 'single' };
  assert.equal(await prepareReading(sdk, shortSource, null, 'req-short'), null);
});

test('首模型报错时，生产 invoke 链转到备用档（mock 路径，不做语义判断）', async () => {
  const good = '**结论。**\n\n- ✅ **要点**：已确认触发环节。';
  const sdk = createSdk({
    stored: { fastTaskModel: FAST, recommendationFallbackModel: BACKUP },
    onStream: (request) => {
      if (request.model === FAST.model) { const e = new Error('这条模型暂时不可用'); e.code = 'PROVIDER_REFUSED'; throw e; }
      return ndjson([{ type: 'text-delta', delta: good }, { type: 'done', stopReason: 'stop' }]);
    },
  });
  const reading = await prepareReading(sdk, longSource, null, 'req-fallback');
  assert.ok(reading, '首模型失败后应由备用档出结果');
  assert.equal(reading.text, good);
  assert.deepEqual(sdk.calls.stream.map((request) => request.model), [FAST.model, BACKUP.model], '顺序是快速档再备用档');
});

test('整理链从不写任何配置：主档、快速档、备用档都不动', async () => {
  const stored = { fastTaskModel: FAST, recommendationFallbackModel: BACKUP, recommendationModel: CONTENT };
  const before = { ...stored };
  const sdk = createSdk({ stored });
  await resolveReadingModelChain(sdk, null);
  await prepareReading(sdk, longSource, null, 'req-nowrite');
  assert.equal(sdk.calls.set.length, 0, '不许写任何设置');
  assert.deepEqual(sdk.stored, before, '三个档的值一个字都没变');
});

test('默认快速档链行为不变：fast → content → backup → custom', async () => {
  const sdk = createSdk({
    stored: {
      fastTaskModel: FAST,
      recommendationModel: CONTENT,
      recommendationFallbackModel: BACKUP,
      customTextModel: { enabled: true, baseUrl: 'https://example.test/v1', model: 'custom-m', apiKey: 'fixture-key' },
    },
  });
  const chain = await resolveFastModelChain(sdk, null);
  assert.deepEqual(roles(chain), ['fast', 'content', 'backup', 'custom']);
  assert.equal(chain[3].kind, 'custom');
});
