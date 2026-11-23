// 自动整理独立模型档 + 正式业务工具的离线回归。
// 全程假宿主、假模型：不发真实请求、不读真实配置、不写真实存储。
// 夹具一律中性命名，不含真实会话样例与本机私有路径。
// 这里的断言只覆盖「解析链归属」与「配置存取契约」，不是对整理质量的评价。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  READING_MODEL_KEY, READING_MODEL_TOOL_NAME, registerReadingModelTool, resolveReadingModelChain,
} from '../lib/reading-model.js';
import { resolveSummaryChain } from '../lib/length-summary.js';
import { prepareReading } from '../lib/reply-reading.js';

const INDEPENDENT = { provider: 'fixture-provider', model: 'reading-pick' };
const SHARED_FAST = { provider: 'fixture-provider', model: 'shared-fast' };
const CONTENT = { provider: 'fixture-provider', model: 'content-model' };
const BACKUP = { provider: 'fixture-provider', model: 'backup-model' };

// 目录行故意夹带敏感字段：白名单出口一个字都不许带出去。
const catalogRow = (ref, name) => ({ ...ref, name, apiKey: 'secret-key-do-not-leak', baseUrl: 'https://secret.example/v1', token: 'secret-token-do-not-leak' });
const DEFAULT_CATALOG = [catalogRow(INDEPENDENT, '整理候选模型'), catalogRow(SHARED_FAST, '共用快速模型'), catalogRow(CONTENT, '内容模型'), catalogRow(BACKUP, '备用模型')];

const longSource = {
  question: '这件事现在怎么样了？',
  earlier: ['前段记录：已经核对过配置与调用位置，确认触发环节在整理判定。'.repeat(6)],
  final: '结果已经确认：旧判定把精简方案也当成值得整理，候选改成优先跳过已精简内容。验证还要跑定向测试，真实模型效果待父代理实测裁决。'.repeat(6),
  mode: 'result',
};

function ndjson(lines) {
  return new Response(lines.map((line) => JSON.stringify(line)).join('\n'), { headers: { 'content-type': 'application/x-ndjson' } });
}

function createSdk({ stored = {}, catalog = DEFAULT_CATALOG, streamText = 'SKIP', onStream = null, onGet = null } = {}) {
  const calls = { get: [], set: [], list: 0, stream: [], cancel: [], logs: [] };
  const sdk = {
    calls,
    toolSpecs: new Map(),
    storage: {
      global: {
        get: async (key, fallback = null) => {
          calls.get.push(key);
          if (onGet) onGet(key);
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
    tools: { register: async (spec) => { sdk.toolSpecs.set(spec.name, spec); } },
    logger: {
      info: async (message) => { calls.logs.push(message); },
      warn: async (message) => { calls.logs.push(message); },
    },
  };
  sdk.stored = stored;
  return sdk;
}

const parse = (res) => JSON.parse(res.content[0].text);

// ── 解析链 ──

test('独立模型优先于共用快速档，prepareReading 真实请求也走它', async () => {
  const sdk = createSdk({ stored: { fastTaskModel: SHARED_FAST, [READING_MODEL_KEY]: INDEPENDENT, recommendationModel: CONTENT } });
  const chain = await resolveReadingModelChain(sdk, null);
  assert.equal(chain[0].kind, 'host');
  assert.equal(chain[0].model.provider, INDEPENDENT.provider);
  assert.equal(chain[0].model.model, INDEPENDENT.model);
  assert.equal(chain[0].role, 'fast');
  // 对照：旧链确实会被共用快速档盖过去——这正是要单独一个键的原因。
  const old = await resolveSummaryChain(sdk, null);
  assert.equal(old[0].model.model, SHARED_FAST.model);
  // 真实 prepareReading 管道（SKIP 输出）：请求身份必须是独立模型。
  assert.equal(await prepareReading(sdk, longSource, null, 'req-independent'), null);
  assert.equal(sdk.calls.stream.length, 1);
  assert.equal(sdk.calls.stream[0].provider, INDEPENDENT.provider);
  assert.equal(sdk.calls.stream[0].model, INDEPENDENT.model);
});

test('整理走独立模型：中性 mock 只验请求身份与材料透传，不是语义评估', async () => {
  // 本条只回答两件事：整理用的模型是不是独立模型那条、材料有没有原样透传。
  // 模型返回的是预置文本，不构成对整理质量、跳过与否或压缩效果的判断。
  const neutralSource = {
    question: '这件事现在到哪一步了？',
    earlier: ['前段：核对过配置与调用位置，确认触发环节在整理判定。'.repeat(6)],
    final: '结果：判定环节已确认，改动尚未提交，等复核。'.repeat(12),
    mode: 'result',
  };
  const sdk = createSdk({ stored: { [READING_MODEL_KEY]: INDEPENDENT, fastTaskModel: SHARED_FAST }, streamText: 'SKIP' });
  assert.equal(await prepareReading(sdk, neutralSource, null, 'req-neutral'), null);
  assert.equal(sdk.calls.stream.length, 1);
  const request = sdk.calls.stream[0];
  assert.equal(request.provider, INDEPENDENT.provider);
  assert.equal(request.model, INDEPENDENT.model, '独立模型优先，共用快速档不插队');
  assert.ok(request.messages[0].content.includes(neutralSource.question), '提问原样透传给模型');
  assert.ok(request.messages[0].content.includes('结果：判定环节已确认'), '末段原样透传给模型');
  assert.ok(request.messages[0].content.includes('前段：核对过配置与调用位置'), '前段原样透传给模型');
});

test('未设独立模型时与旧链逐条一致；坏值按未设处理', async () => {
  for (const stored of [
    { fastTaskModel: SHARED_FAST, recommendationModel: CONTENT, recommendationFallbackModel: BACKUP },
    { recommendationModel: CONTENT },
    { [READING_MODEL_KEY]: { provider: '', model: 'x' } },
    { [READING_MODEL_KEY]: '不是对象' },
  ]) {
    const sdk = createSdk({ stored });
    const mine = await resolveReadingModelChain(sdk, CONTENT);
    const old = await resolveSummaryChain(sdk, CONTENT);
    assert.deepEqual(mine, old);
  }
});

test('独立键读不到时回落旧链，不新增失败源', async () => {
  const sdk = createSdk({
    stored: { fastTaskModel: SHARED_FAST },
    onGet: (key) => { if (key === READING_MODEL_KEY) { const e = new Error('RPC 满仓'); e.code = 'APP_RPC_BUSY'; throw e; } },
  });
  const mine = await resolveReadingModelChain(sdk, null);
  assert.equal(mine[0].model.model, SHARED_FAST.model);
});

test('空链沿用既有 MODEL_NOT_FOUND 固定码', async () => {
  const withRef = createSdk({ stored: { [READING_MODEL_KEY]: INDEPENDENT }, catalog: [] });
  await assert.rejects(() => resolveReadingModelChain(withRef, null), (e) => e.code === 'MODEL_NOT_FOUND');
  const withoutRef = createSdk({ stored: {}, catalog: [] });
  await assert.rejects(() => resolveReadingModelChain(withoutRef, null), (e) => e.code === 'MODEL_NOT_FOUND');
});

test('短源（去空白 <300）仍在任何 SDK 访问前返回', async () => {
  const forbidden = () => { throw new Error('短源不应访问 SDK'); };
  const sdk = { storage: { global: { get: forbidden } }, models: { list: forbidden, stream: forbidden } };
  const shortSource = { question: '问', earlier: [], final: `${'甲'.repeat(299)} \n\t`, mode: 'single' };
  assert.equal(await prepareReading(sdk, shortSource, null, 'req-short'), null);
});

// ── 正式业务工具 ──

test('工具注册零读取；list 只回白名单字段与本功能当前选择', async () => {
  const sdk = createSdk({ stored: { [READING_MODEL_KEY]: INDEPENDENT, fastTaskModel: SHARED_FAST } });
  await registerReadingModelTool(sdk);
  assert.equal(sdk.calls.get.length + sdk.calls.list + sdk.calls.stream.length + sdk.calls.set.length, 0, '注册本身不读配置/目录');
  const tool = sdk.toolSpecs.get(READING_MODEL_TOOL_NAME);
  assert.ok(tool, '工具应注册在案');
  const list = parse(await tool.execute({ action: 'list' }));
  assert.equal(list.ok, true);
  assert.deepEqual(list.modelRef, INDEPENDENT);
  assert.equal(list.models.length, 4);
  for (const row of list.models) {
    assert.deepEqual(Object.keys(row).sort(), ['isCurrent', 'model', 'name', 'provider', 'providerChannel', 'providerLabel'].sort());
  }
  assert.ok(!JSON.stringify(list).includes('secret'), '目录夹带的敏感字段不许出口');
});

test('status 回本功能 ref 与安全链字段；自定义档不泄 Key/地址', async () => {
  const host = createSdk({ stored: { [READING_MODEL_KEY]: INDEPENDENT, fastTaskModel: SHARED_FAST } });
  await registerReadingModelTool(host);
  const status = parse(await host.toolSpecs.get(READING_MODEL_TOOL_NAME).execute({ action: 'status' }));
  assert.deepEqual(status.modelRef, INDEPENDENT);
  assert.equal(status.chain[0].provider, INDEPENDENT.provider);
  assert.equal(status.chain[0].model, INDEPENDENT.model);
  assert.ok(!JSON.stringify(status).includes('secret'));

  const custom = createSdk({
    stored: { customTextModel: { enabled: true, baseUrl: 'https://example.test/v1', model: 'custom-m', apiKey: 'protected-secret-value' } },
    catalog: [],
  });
  await registerReadingModelTool(custom);
  const customStatus = parse(await custom.toolSpecs.get(READING_MODEL_TOOL_NAME).execute({ action: 'status' }));
  assert.equal(customStatus.chain[0].kind, 'custom');
  assert.ok(!JSON.stringify(customStatus).includes('protected-secret-value'));
  assert.ok(!JSON.stringify(customStatus).includes('example.test'));
  for (const entry of customStatus.chain) assert.ok(!Object.hasOwn(entry, 'config'));
});

test('set 必须 confirm:true；非法与目录外模型拒绝且不写盘', async () => {
  const sdk = createSdk({ stored: { fastTaskModel: SHARED_FAST } });
  await registerReadingModelTool(sdk);
  const tool = sdk.toolSpecs.get(READING_MODEL_TOOL_NAME);
  for (const args of [
    { action: 'set', modelRef: INDEPENDENT },
    { action: 'set', confirm: false, modelRef: INDEPENDENT },
  ]) {
    const res = await tool.execute(args);
    assert.equal(res.isError, true);
    assert.equal(parse(res).code, 'READING_MODEL_CONFIRM_REQUIRED');
  }
  assert.equal(parse(await tool.execute({ action: 'set', confirm: true, modelRef: { provider: 'fixture-provider' } })).code, 'READING_MODEL_BAD_REF');
  assert.equal(parse(await tool.execute({ action: 'set', confirm: true, modelRef: '字符串' })).code, 'READING_MODEL_BAD_REF');
  assert.equal(parse(await tool.execute({ action: 'set', confirm: true, modelRef: { provider: 'fixture-provider', model: 'not-exist' } })).code, 'READING_MODEL_NOT_IN_CATALOG');
  assert.equal(sdk.calls.set.length, 0, '拒绝路径一个字都不许写');
  assert.deepEqual(sdk.stored.fastTaskModel, SHARED_FAST);
});

test('set 合法写入归一化 ref 并回读核对；只动自己的键', async () => {
  const sdk = createSdk({ stored: { fastTaskModel: SHARED_FAST, recommendationModel: CONTENT, summaryModel: CONTENT, askJudgeModel: BACKUP } });
  const before = { ...sdk.stored };
  await registerReadingModelTool(sdk);
  const tool = sdk.toolSpecs.get(READING_MODEL_TOOL_NAME);
  const res = await tool.execute({ action: 'set', confirm: true, modelRef: { provider: ' fixture-provider ', model: ' reading-pick ' } });
  const out = parse(res);
  assert.equal(out.ok, true);
  assert.equal(out.saved, true);
  assert.deepEqual(out.modelRef, INDEPENDENT);
  assert.deepEqual(sdk.stored[READING_MODEL_KEY], INDEPENDENT);
  assert.ok(sdk.calls.set.every((row) => row.key === READING_MODEL_KEY), '只允许写 replyReadingModel');
  for (const key of ['fastTaskModel', 'recommendationModel', 'summaryModel', 'askJudgeModel']) {
    assert.deepEqual(sdk.stored[key], before[key], `${key} 不许动`);
  }
  // 保存后解析链立刻认新值（解析器直读存储，不依赖钩子缓存）。
  const chain = await resolveReadingModelChain(sdk, null);
  assert.equal(chain[0].model.model, INDEPENDENT.model);
});

test('set 回读核对不上不算成功', async () => {
  const sdk = createSdk({ stored: {} });
  const originalGet = sdk.storage.global.get;
  sdk.storage.global.get = async (key, fallback) => (key === READING_MODEL_KEY ? null : originalGet(key, fallback));
  await registerReadingModelTool(sdk);
  const res = await sdk.toolSpecs.get(READING_MODEL_TOOL_NAME).execute({ action: 'set', confirm: true, modelRef: INDEPENDENT });
  assert.equal(res.isError, true);
  assert.equal(parse(res).code, 'READING_MODEL_WRITE_UNCONFIRMED');
});

test('reset 必须 confirm:true，只清自己的键，清完回旧链', async () => {
  const sdk = createSdk({ stored: { [READING_MODEL_KEY]: INDEPENDENT, fastTaskModel: SHARED_FAST, recommendationModel: CONTENT } });
  await registerReadingModelTool(sdk);
  const tool = sdk.toolSpecs.get(READING_MODEL_TOOL_NAME);
  const denied = await tool.execute({ action: 'reset' });
  assert.equal(denied.isError, true);
  assert.equal(parse(denied).code, 'READING_MODEL_CONFIRM_REQUIRED');
  assert.equal(sdk.calls.set.length, 0);
  const out = parse(await tool.execute({ action: 'reset', confirm: true }));
  assert.equal(out.ok, true);
  assert.equal(out.modelRef, null);
  assert.equal(sdk.stored[READING_MODEL_KEY], null);
  assert.ok(sdk.calls.set.every((row) => row.key === READING_MODEL_KEY));
  assert.deepEqual(sdk.stored.fastTaskModel, SHARED_FAST);
  assert.deepEqual(sdk.stored.recommendationModel, CONTENT);
  const chain = await resolveReadingModelChain(sdk, null);
  assert.equal(chain[0].model.model, SHARED_FAST.model, '清完回到共用快速档旧链');
});
