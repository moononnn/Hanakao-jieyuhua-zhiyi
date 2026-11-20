import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadingPrompt, normalizeReadingConfig, parseReadingText, prepareReading, sourceFromAgentEnd } from '../lib/reply-reading.js';
import { createInlineReading } from '../lib/reading-card.js';
import { stripSummaryBlocks, stripSummaryFromPayload } from '../lib/length-summary.js';

const u = content => ({ role: 'user', content });
const a = content => ({ role: 'assistant', content, stopReason: 'stop' });
const end = (...messages) => ({ type: 'agent_end', messages });

const readingModel = { provider: 'fixture-provider', model: 'fixture-model' };
function createReadingSdk(text) {
  const calls = { storage: 0, list: 0, stream: [] };
  return {
    calls,
    storage: { global: { get: async (_key, fallback = null) => { calls.storage++; return fallback; } } },
    models: {
      list: async () => { calls.list++; return [{ ...readingModel, name: '本地测试模型' }]; },
      stream: async request => {
        calls.stream.push(request);
        const events = [
          { type: 'start', requestId: request.requestId },
          { type: 'text-delta', requestId: request.requestId, delta: text },
          { type: 'done', requestId: request.requestId, stopReason: 'stop' },
        ];
        return new Response(`${events.map(event => JSON.stringify(event)).join('\n')}\n`, {
          headers: { 'content-type': 'application/x-ndjson' },
        });
      },
    },
  };
}
function createForbiddenReadingSdk() {
  let calls = 0;
  const forbidden = () => { calls++; throw new Error('短回复不应访问模型或存储'); };
  return {
    calls: () => calls,
    storage: { global: { get: forbidden } },
    models: { list: forbidden, stream: forbidden },
  };
}

test('单条长回复和整轮结果走同一个入口，模式不同', () => {
  assert.equal(sourceFromAgentEnd(end(u('能装吗'), a('能装，但还没实测。')), 5).mode, 'single');
  const source = sourceFromAgentEnd(end(u('核对一下'), a('之前以为走 A。'), a('已证实走 B。')), 5);
  assert.equal(source.mode, 'result');
  assert.match(buildReadingPrompt(source), /之前以为走 A.+已证实走 B/);
});

test('不跨真实提问，不把工具结果、思考或旧速览当成回复', () => {
  const context = end(u('上一个问题'), a('上一次的结论'), u('这次交代'),
    { role: 'toolResult', content: [{ type: 'text', text: '工具日志' }] },
    a([{ type: 'thinking', thinking: '不能进入材料' }, { type: 'text', text: '<mood>私下</mood>前段。' }]),
    a('最终判断。\n\n> **🌸 知意速览** · 原文 22 字\n> - 旧卡'));
  assert.deepEqual(sourceFromAgentEnd(context, 2), { mode: 'result', question: '这次交代', earlier: ['前段。'], final: '最终判断。', chars: 8 });
});

test('中间轮、失败、缺边界、明确长文请求、普通短话都跳过', () => {
  const normal = end(u('讲一讲'), a('写好了。'));
  for (const event of [ { ...normal, type: 'turn_end' }, { ...normal, willRetry: true }, { ...normal, aborted: true },
    end(a('看不到这轮提问')), end(u('写一篇故事'), a('文章正文')),
    end(u('查一下'), { ...a('还在查'), stopReason: 'toolUse' }), end(u('查一下'), { ...a('报错'), errorMessage: 'oops' }) ]) {
    assert.equal(sourceFromAgentEnd(event, 1), null);
  }
  assert.equal(sourceFromAgentEnd(end(u('早安'), a('早安呀！'))), null);
  assert.equal(sourceFromAgentEnd(end(u('修好了吗'), a('启动过了。'), a('F1 没验。'))).mode, 'result');
  assert.equal(sourceFromAgentEnd(normal).mode, 'single');
  assert.equal(parseReadingText('SKIP'), null);
  assert.equal(parseReadingText('结论。\n\n条件。'), '结论。\n\n条件。');
});

test('自动整理默认关闭，只认明确的开启', () => {
  for (const raw of [undefined, {}, { enabled: false }, { enabled: 'true' }]) {
    assert.deepEqual(normalizeReadingConfig(raw), { enabled: false });
  }
  assert.deepEqual(normalizeReadingConfig({ enabled: true, minChars: 600 }), { enabled: true });
});

test('同轮只附一份正文整理；关闭或开始下一轮时不附', async () => {
  for (const mode of ['normal', 'disabled', 'advanced']) {
    let calls = 0;
    const flow = createInlineReading({}, {
      readConfig: async () => ({ enabled: mode !== 'disabled' }), readModel: () => null, reportError: assert.fail,
      prepare: async (_sdk, source) => {
        calls++;
        assert.equal(source.mode, 'result');
        if (mode === 'advanced') flow.start('session', '新问题');
        return { mode: source.mode, text: '测试通过。\n\n还没上屏。' };
      },
    });
    flow.start('session', '查一下');
    await flow.finish('session', { ...a('测试通过。'), stopReason: 'toolUse' });
    const final = a('还没上屏。');
    const reply = await flow.finish('session', final);
    assert.equal(calls, mode === 'disabled' ? 0 : 1);
    if (mode === 'normal') {
      assert.match(reply.content, /这件事的结果/);
      assert.equal(stripSummaryBlocks(reply.content), final.content);
      assert.deepEqual(stripSummaryFromPayload({ content: reply.content }), { content: final.content });
      assert.equal(await flow.finish('session', final), undefined);
    } else assert.equal(reply, undefined);
  }
});

test('中性化的短进度与自足回复调用真实 prepareReading 时不碰模型或存储', async () => {
  const question = '目前这件事怎么样？';
  const progress1 = '我先核对了一下相关流程，正在检查涉及的配置和调用位置，目前还没有修改。';
  const progress2 = '已经找到整理触发的环节，我继续确认它是否会重复最后回复。';
  const final = '原因已确认：提示词默认要求整理，进度会被再复述一遍。短回复不需要额外概括；只有重要信息分散、合并后明显省阅读时才整理。';
  const source = sourceFromAgentEnd(end(u(question), a(progress1), a(progress2), a(final)));
  assert.ok(source.chars < 300, '样例应低于内部保守底线');

  const sdk = createForbiddenReadingSdk();
  assert.equal(await prepareReading(sdk, source, readingModel, 'short-progress'), null);
  assert.equal(sdk.calls(), 0, '短回复必须在模型解析/存储访问前返回');

  const flow = createInlineReading(sdk, {
    readConfig: async () => ({ enabled: true }), readModel: () => readingModel, reportError: assert.fail,
  });
  flow.start('session', question);
  await flow.finish('session', { ...a(progress1), phase: 'commentary' });
  await flow.finish('session', { ...a(progress2), phase: 'commentary' });
  assert.equal(await flow.finish('session', a(final)), undefined, '短进度不应附加整理块');
  assert.equal(sdk.calls(), 0);
});

test('300 字底线剔除空白且不把提问算入助手正文', async () => {
  const tooShort = createForbiddenReadingSdk();
  const source299 = { question: '提问'.repeat(500), earlier: [], final: `${'甲'.repeat(299)} \n\t`, mode: 'single' };
  assert.equal(await prepareReading(tooShort, source299, readingModel, 'under-300'), null);
  assert.equal(tooShort.calls(), 0, '空白和长提问不能补足 299 字');

  const boundary = createReadingSdk('SKIP');
  const source300 = { ...source299, final: '甲'.repeat(300) };
  assert.equal(await prepareReading(boundary, source300, readingModel, 'at-300'), null);
  assert.equal(boundary.calls.stream.length, 1, '恰好 300 个非空白助手字允许进入模型判断');
});

test('长源是否值得整理仍由模型判断，提示词默认 SKIP 且自足末段跳过', async () => {
  const source = {
    question: '检查是否值得整理',
    earlier: ['前段记录了检查进度和已经确认的材料。'.repeat(15)],
    final: '最后一段已经完整、自足地交代答案和必要条件。'.repeat(15),
    mode: 'result',
  };
  assert.ok([...source.earlier, source.final].join('').length >= 300);
  const sdk = createReadingSdk('SKIP');
  assert.equal(await prepareReading(sdk, source, readingModel, 'long-skip'), null);
  assert.equal(sdk.calls.stream.length, 1, '长源要调用一次模型作语义判断');
  const prompt = sdk.calls.stream[0].messages[0].content;
  assert.match(prompt, /默认跳过并只输出 SKIP/);
  assert.match(prompt, /最后一段已经完整、自足地交代答案和必要条件时，无论长短都跳过/);
  assert.match(prompt, /进度播报、重复措辞或近义改写、简单几个要点都不值得出卡/);
});

test('整理结果超过原文 70% 拒绝，恰好 70% 保留', async () => {
  const source = { question: '整理散落信息', earlier: [], final: '原'.repeat(1000), mode: 'single' };
  const over = createReadingSdk('整'.repeat(701));
  assert.equal(await prepareReading(over, source, readingModel, 'over-70'), null);

  const exact = createReadingSdk('整'.repeat(700));
  assert.equal((await prepareReading(exact, source, readingModel, 'exact-70'))?.text, '整'.repeat(700));
});

test('与最后回复或任一前段去空白后完全重复的结果都不附加', async () => {
  const duplicateFinal = '最后回复明确写出的答案和必要条件。'.repeat(5);
  const finalSource = {
    question: '检查重复', earlier: ['前段独立记录的验证背景和过程。'.repeat(30)], final: duplicateFinal, mode: 'result',
  };
  const finalCopy = createReadingSdk(duplicateFinal.split('').join(' '));
  assert.equal(await prepareReading(finalCopy, finalSource, readingModel, 'same-final'), null);

  const duplicateEarlier = '前段原句明确记载的事实与验证结果。'.repeat(6);
  const earlierSource = {
    question: '检查重复',
    earlier: [duplicateEarlier, '另有一组与它不同的散落记录，需要保留在原文中。'.repeat(25)],
    final: '最终回复只交代了下一步安排。'.repeat(8), mode: 'result',
  };
  const earlierCopy = createReadingSdk(duplicateEarlier.split('').join(' '));
  assert.equal(await prepareReading(earlierCopy, earlierSource, readingModel, 'same-earlier'), null);
});

test('足够长的散落事实可浓缩，同时保留关键数字、验证范围与回滚条件', async () => {
  const source = {
    question: '汇总验证结果与下一步',
    earlier: [
      '已经确认，本轮验证的是连接器 A 的 2.4.1 版本，运行环境为 Windows 11。验证记录包括启动成功与基础读取正常；这些只是本机测试，不能推断其他系统也通过。两次启动都正常，基础读取每次返回 12 条记录；这只能说明当前环境的读取路径可用。',
      '回滚路径是恢复旧配置文件即可，不需要清空数据目录；如果只出现读取异常，先恢复配置再观察，不要删除现有数据。版本号和连接器名称要和测试记录保持一致。并发写入仍需单独验证，验证结束前不要扩大启用范围。目前没有性能测试结果，也没有跨系统结果；本轮只有两次启动与基础读取记录，不能推断长时间运行或多人同时操作时的表现。',
    ],
    final: '建议先在一个小范围内启用，观察一天后再决定是否扩大。并发写入没验之前不要称为完整通过；若出现异常，恢复旧配置文件，保留数据目录。',
    mode: 'result',
  };
  const originalChars = [...source.earlier, source.final].join('').replace(/\s/gu, '').length;
  assert.ok(originalChars >= 300);
  const expected = 'Windows 11 本机验证连接器 A 2.4.1：启动及基础读取（每次 12 条）通过；性能、并发写入和其他系统未验，不能称完整通过。先小范围观察一天；异常时恢复旧配置文件、保留数据目录，无需清空数据。';
  const sdk = createReadingSdk(expected);
  const reading = await prepareReading(sdk, source, readingModel, 'facts-condensed');
  assert.equal(reading?.text, expected);
  assert.ok(reading.text.includes('2.4.1') && reading.text.includes('12 条'));
  assert.match(reading.text, /并发写入和其他系统未验/);
  assert.match(reading.text, /恢复旧配置文件、保留数据目录/);
});
