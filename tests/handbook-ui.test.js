import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../ui/panel.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../ui/assets/handbook.css', import.meta.url), 'utf8');

// 规则：从 .hb-composer 到下一个顶层块。
const block = (selector) => {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `样式表里找不到 ${selector}`);
  const end = css.indexOf('\n}', start);
  return css.slice(start, end);
};

test('更新手记的标题改成「这版更新了啥」', () => {
  const title = html.match(/<h1[^>]*id="hb-title"[^>]*>([^<]*)</);
  assert.ok(title, 'panel.html 里找不到 hb-title');
  assert.equal(title[1], '这版更新了啥');
});

test('常驻输入是浮在页面上的一块板子，不是一条贴边的白带', () => {
  const composer = block('.hb-composer');
  assert.match(composer, /border-radius:\s*18px/, '浮板要有圆角');
  assert.match(composer, /box-shadow:/, '浮板要有投影');
  assert.match(composer, /border:\s*1px solid/, '浮板要有实边，跟页面内容分开');
  assert.doesNotMatch(composer, /calc\(-1 \* clamp/, '不再满幅贴边');
});

test('追问按钮和发送按钮都不贴着边框，留出呼吸空间', () => {
  assert.match(block('.hb-actions'), /margin:/, '追问按钮这一行要留白');
  assert.match(block('.hb-body-in'), /padding:[^;]*\d+px[^;]*\d+px/, '正文块要留出上下左右余量');
  const box = block('.hb-box');
  const padding = box.match(/padding:\s*([^;]+);/);
  assert.ok(padding, '.hb-box 要有 padding');
  const parts = padding[1].trim().split(/\s+/).map((v) => parseFloat(v));
  const right = parts.length === 4 ? parts[1] : parts[0];
  assert.ok(right >= 10, `发送按钮离右边框至少 10px，现在只有 ${right}px`);
});
