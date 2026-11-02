import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOverview } from '../lib/handbook-service.js';

const release = {
  tag: 'v1.5.48-beta',
  version: '1.5.48-beta',
  publishedAt: '2026-11-01T23:32:45Z',
  url: 'https://github.com/liliMozi/openhanako/releases/tag/v1.5.48-beta',
  itemCount: 42,
  sections: [
    {
      key: 'features',
      title: 'Features · 新功能与改进',
      groups: [
        {
          name: 'Code、模型与界面',
          items: [
            { id: 'r1:1', title: '中文信息流名称调整', detail: '「报纸」更名为「日报」。' },
            { id: 'r1:2', title: '闲聊独立模型', detail: '在闲聊设置中为闲聊单独选择模型。' },
          ],
        },
        { name: '记忆与闲聊', items: [{ id: 'r1:3', title: '闲聊显示助手身份', detail: '顶部新增当前助手的头像和名称。' }] },
      ],
    },
    {
      key: 'fixes',
      title: 'Bug Fixes · 问题修复',
      groups: [{ name: '聊天、会话与闲聊', items: [{ id: 'r2:1', title: '错误提示保留到能够读完', detail: '不再定时消失。' }] }],
    },
  ],
};

test('本版总览按 新功能/修复 分组摆出这一版改了什么', () => {
  const overview = buildOverview(release);
  assert.equal(overview.version, '1.5.48-beta');
  assert.equal(overview.totalItems, 42);
  assert.deepEqual(overview.groups.map((group) => group.key), ['features', 'fixes']);
  assert.equal(overview.groups[0].title, '新功能与改进');
  assert.equal(overview.groups[0].total, 3);
  assert.equal(overview.groups[0].items.length, 3);
  assert.equal(overview.groups[1].title, '问题修复');
});

test('改名这种只写在界面调整里的条目也摆得出来，不按「你摸得到」筛', () => {
  const overview = buildOverview(release);
  const titles = overview.groups.flatMap((group) => group.items.map((item) => item.title));
  assert.ok(titles.includes('中文信息流名称调整'), '「报纸更名为日报」这种条目要能出现在本版总览里');
  const item = overview.groups[0].items.find((row) => row.title === '中文信息流名称调整');
  assert.equal(item.detail, '「报纸」更名为「日报」。');
  assert.equal(item.section, 'Features · 新功能与改进');
  assert.equal(item.group, 'Code、模型与界面');
});

test('条目多了要收着，别把整版说明全铺出来', () => {
  const many = {
    ...release,
    sections: [
      {
        key: 'features',
        title: 'Features',
        groups: [{ name: 'g', items: Array.from({ length: 40 }, (_, i) => ({ id: `x${i}`, title: `条目 ${i}`, detail: '' })) }],
      },
    ],
  };
  const overview = buildOverview(many);
  assert.equal(overview.groups[0].items.length, 14, '新功能最多摆 14 条');
  assert.equal(overview.groups[0].total, 40, '总数照实说');
});

test('没有这一版就老实返回空，别编', () => {
  assert.equal(buildOverview(null), null);
  assert.equal(buildOverview({ sections: [] }).groups.length, 0);
});
