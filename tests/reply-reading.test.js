import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadingPrompt, normalizeReadingConfig, parseReadingText, sourceFromAgentEnd } from '../lib/reply-reading.js';
import { createReadingCards } from '../lib/reading-card.js';

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

test('一次挂一份，不开新回合，不把整理正文写回聊天；新轮开始则不误挂', async () => {
  for (const advance of [false, true]) {
    const calls = [];
    const store = new Map();
    const path = 'code-test.jsonl';
    const flow = createReadingCards({ storage: { global: { set: (k, v) => store.set(k, v), get: k => store.get(k) } },
      bus: { request: async (verb, data) => {
        if (verb === 'session:context') return { isStreaming: false };
        calls.push(data);
        return { ok: true, entryId: 'one-card' };
      } } }, {
      readConfig: async () => ({ enabled: true, minChars: 2 }), readModel: () => null,
      sessionForPath: async () => 'sess_example', ignoredPath: () => false, reportError: assert.fail,
      wait: async () => {}, prepare: async (_sdk, source) => {
        if (advance) await flow.note({ type: 'agent_start' }, path);
        return { mode: source.mode, text: '留在卡片存储的整理正文' };
      },
    });
    await flow.note({ type: 'agent_start' }, path);
    const first = end(u('查一下'), a('旧说法'), a('测试通过；还没上屏。'));
    await Promise.all([flow.note(first, path), flow.note({ ...first }, path)]);
    assert.equal(calls.length, advance ? 0 : 1);
    if (!advance) {
      assert.equal(calls[0].triggerTurn, false);
      assert.doesNotMatch(JSON.stringify(calls[0]), /留在卡片存储的整理正文/);
      assert.equal((await flow.read(calls[0].details.cardInstanceId)).mode, 'result');
    }
  }
});
