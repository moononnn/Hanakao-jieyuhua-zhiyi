// 朗读列表的数据源：长对话要拿尾部（session:history 只回开头 200 条）
import test from 'node:test';
import assert from 'node:assert/strict';

const { listSpeakableReplies } = await import('../lib/voice-replies.js');

function text(content) {
  return [{ type: 'text', text: content }];
}

// 一条线的形状：user → assistant → user → assistant（工具调用，没正文）→ assistant（正文）
// 另挂一条旧分支：同一轮里被改掉的旧回复，不该出现在列表里。
const ENTRIES = [
  { type: 'message', id: 'e1', parentId: '', timestamp: '2026-10-22T00:48:05.000Z', role: 'user', content: text('第一问') },
  { type: 'message', id: 'e2', parentId: 'e1', timestamp: '2026-10-22T00:49:00.000Z', role: 'assistant', content: text('开头那轮的回复，早就该被埋回去了。') },
  { type: 'message', id: 'e2-old', parentId: 'e1', timestamp: '2026-10-22T00:49:10.000Z', role: 'assistant', content: text('被改掉的旧分支回复') },
  { type: 'message', id: 'e3', parentId: 'e2', timestamp: '2026-10-22T02:00:00.000Z', role: 'user', content: text('第二问') },
  { type: 'message', id: 'e4', parentId: 'e3', timestamp: '2026-10-22T02:01:00.000Z', role: 'assistant', content: [{ type: 'tool_use', name: 'read' }] },
  { type: 'message', id: 'e5', parentId: 'e4', timestamp: '2026-10-22T02:02:00.000Z', role: 'assistant', content: text('这才是最新那轮的正文。') },
];

const sdk = {
  logger: { info: async () => {} },
  bus: { request: async (verb) => (verb === 'session:entries' ? { entries: ENTRIES } : []) },
  sessions: {
    history: async () => { throw new Error('有 entries 时不该再走 history'); },
  },
};

test('朗读列表优先用 session:entries，沿 parentId 走当前分支并取到最新一轮', async () => {
  const result = await listSpeakableReplies(sdk, { sessionId: 'sess_test', limit: 8 });
  assert.equal(result.replies.length, 2, '应该列出两轮');
  assert.equal(result.replies[0].isLatest, true);
  assert.match(result.replies[0].text, /这才是最新那轮的正文/);
  assert.doesNotMatch(result.replies[0].text, /开头那轮/, '最新一列不该是开头的旧回复');
  assert.equal(result.replies[1].text.includes('开头那轮的回复'), true);
  assert.equal(result.replies.some((reply) => reply.text.includes('被改掉的旧分支')), false, '旧分支不该进列表');
});

test('entries 拿不到时回落 history，不让朗读列表直接空掉', async () => {
  const fallback = {
    logger: { info: async () => {} },
    bus: { request: async () => { throw new Error('no entries'); } },
    sessions: {
      history: async () => ({ messages: [
        { role: 'user', entryId: 'm1', content: text('问') },
        { role: 'assistant', entryId: 'm2', content: text('回') },
      ] }),
    },
  };
  const result = await listSpeakableReplies(fallback, { sessionId: 'sess_test', limit: 4 });
  assert.equal(result.replies.length, 1);
  assert.match(result.replies[0].text, /回/);
});
