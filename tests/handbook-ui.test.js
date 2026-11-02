import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../ui/panel.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../ui/assets/handbook.css', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../ui/assets/handbook.js', import.meta.url), 'utf8');

// 取某个选择器的规则块（到下一个顶层 } 为止）。
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

test('输入台那句小字去掉了', () => {
  assert.doesNotMatch(html, /hb-foot/, 'panel.html 里不该再有脚注小字');
  assert.doesNotMatch(css, /\.hb-foot/, '样式表里也不该留着这条');
});

test('浮起来的是输入台这一件东西，不是一整块板子压下来', () => {
  const field = block('.hb-field');
  assert.match(field, /border-radius:\s*20px/, '输入台要有圆角');
  assert.match(field, /border:\s*1px solid/, '输入台要有一道极浅细边');
  assert.match(field, /box-shadow:/, '输入台要有柔和投影');
  assert.match(field, /inset 0 1px 0/, '台面上沿要留一道高光，抬起感来自光不来自描边');

  const composer = block('.hb-composer');
  assert.doesNotMatch(composer, /background:/, '外层不该再画一块板子');
  assert.doesNotMatch(composer, /border(-top)?:/, '外层不该有描边');
  assert.doesNotMatch(composer, /box-shadow:/, '投影只给输入台');
});

test('滚上来的清单在上方渐隐里化掉，不被硬边切断', () => {
  const fade = block('.hb-composer::before');
  assert.match(fade, /linear-gradient\(to bottom, transparent, var\(--hb-page\)\)/, '渐隐条要用页底同色');
  assert.match(css, /--hb-page:\s*var\(--paper/, '页底色跟面板用同一个变量，浅深两态才对得上');
});

test('追问模式：清单整块退场，换成一条干净的对话流', () => {
  assert.match(html, /id="hb-chat"/, '要有追问这一页');
  assert.match(html, /id="hb-thread"/, '对话流要自己的容器');
  assert.match(html, /id="hb-chat-back"/, '要有回清单的按钮');
  assert.match(css, /\.hb-body\.is-chat \.hb-list \{ display: none; \}/, '追问时清单要退场');
  assert.match(css, /\.hb-body\.is-chat \.hb-thread \{[^}]*overflow-y: auto/, '对话流自己滚');
  assert.match(css, /\.hb-body\.is-chat \.hb-composer \{[^}]*position: static/, '输入台在追问页固定在底下');
});

test('气泡不再挤在清单底下浮着，它住在对话流里', () => {
  assert.doesNotMatch(html, /hb-stream/, '旧的浮层气泡区要拆掉');
  assert.match(js, /\$\('hb-thread'\)\.appendChild/, '气泡进对话流');
  assert.match(js, /function openChat\(card\)/, '要有翻页动作');
  assert.match(js, /function closeChat\(\)/, '要有回清单动作');
  assert.match(js, /if \(!state\.chat\) openChat\(card\);/, '点发送先翻页再发');
});

test('追问按钮和发送按钮都不贴着边框，留出呼吸空间', () => {
  assert.match(block('.hb-actions'), /margin:/, '追问按钮这一行要留白');
  assert.match(block('.hb-body-in'), /padding:[^;]*\d+px[^;]*\d+px/, '正文块要留出上下左右余量');
  const field = block('.hb-field');
  const padding = field.match(/padding:\s*([^;]+);/);
  assert.ok(padding, '.hb-field 要有 padding');
  const parts = padding[1].trim().split(/\s+/).map((v) => parseFloat(v));
  const right = parts.length === 4 ? parts[1] : parts[0];
  assert.ok(right >= 10, `发送按钮离右边框至少 10px，现在只有 ${right}px`);
});

test('动效：入场淡入上浮，翻页也淡入，减弱动效时让位', () => {
  assert.match(css, /@keyframes hb-rise/, '要有入场动效');
  assert.match(css, /@keyframes hb-chat-in/, '翻页要有过渡');
  assert.match(css, /prefers-reduced-motion[\s\S]*?\.hb-composer, \.hb-list, \.hb-chat \{ animation: none; \}/, '关掉动效偏好时要让位');
});
