import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadingPrompt, normalizeReadingConfig, parseReadingText, sourceFromAgentEnd } from '../lib/reply-reading.js';
import { createInlineReading } from '../lib/reading-card.js';
import { stripSummaryBlocks, stripSummaryFromPayload } from '../lib/length-summary.js';

const u = content => ({ role: 'user', content });
const a = content => ({ role: 'assistant', content, stopReason: 'stop' });
const end = (...messages) => ({ type: 'agent_end', messages });

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
