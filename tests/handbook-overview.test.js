import test from 'node:test';
import assert from 'node:assert/strict';

import { buildVersionOverview } from '../lib/handbook-service.js';

const release = { tag: 'v1.5.48-beta', version: '1.5.48-beta', publishedAt: '2026-11-01T23:32:45Z' };
const card = (tag, title) => ({ id: `${tag}#${title}`, tag, version: tag.replace(/^v/i, ''), title, topic: '聊天与对话', now: '', why: '', where: '桌面侧边栏' });

test('本版速览只摆最新版自己挑出来的卡片', () => {
  const cards = [card('v1.5.48-beta', '报纸更名为日报'), card('v1.5.48-beta', '闲聊独立模型'), card('v1.5.47-beta', '更老的卡片')];
  const overview = buildVersionOverview(release, cards);
  assert.equal(overview.version, '1.5.48-beta');
  assert.equal(overview.cards.length, 2);
  assert.ok(overview.cards.some((row) => row.title === '报纸更名为日报'));
  assert.ok(!overview.cards.some((row) => row.title === '更老的卡片'), '老版本的卡片不往这块里塞');
});

test('速览里摆的是卡片，不是原文条目', () => {
  const overview = buildVersionOverview(release, [card('v1.5.48-beta', '报纸更名为日报')]);
  const item = overview.cards[0];
  assert.equal(typeof item.title, 'string');
  assert.equal(typeof item.where, 'string', '卡片要带「在哪碰到它」，追问才追得到出处');
  assert.equal(item.detail, undefined, '速览里不摆原文正文');
});

test('这一版没挑出卡片就老实空着，不硬凑', () => {
  assert.deepEqual(buildVersionOverview(release, []).cards, []);
  assert.deepEqual(buildVersionOverview(release, [card('v1.5.47-beta', '别的版本')]).cards, []);
  assert.equal(buildVersionOverview(null, []), null);
});
