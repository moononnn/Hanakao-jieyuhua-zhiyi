import { hana } from './sdk.js';

const panel = document.querySelector('details');
const article = document.querySelector('article');
const status = document.querySelector('#status');
const foot = document.querySelector('small');
let currentId = '';
function resize() { void Promise.resolve(hana.ui.resize({ height: Math.ceil(document.body.getBoundingClientRect().height) + 2 })).catch(() => {}); }

function fragments(text, node) {
  for (const [i, piece] of text.split(/\*\*([^*\n]+)\*\*/).entries()) {
    if (i % 2) {
      const strong = document.createElement('strong');
      strong.textContent = piece;
      node.append(strong);
    } else node.append(document.createTextNode(piece));
  }
}

async function load() {
  const context = hana.surface.getContext();
  const url = new URL(location.href);
  const id = [context?.cardInstanceId, context?.instanceKey, ...url.searchParams.values()]
    .find(value => typeof value === 'string' && /^a_[0-9a-f]{20}$/.test(value));
  if (!id || id === currentId) return;
  currentId = id;
  try {
    const res = await hana.api.fetch('/reply-reading?id=' + encodeURIComponent(id));
    const { record } = await res.json();
    if (id !== currentId) return;
    if (!res.ok || !record?.text) throw new Error('no record');
    const collected = record.mode === 'result';
    panel.querySelector('summary').textContent = collected ? '这件事的结果 · 知意整理' : '读整理版 · 知意速览';
    article.replaceChildren();
    for (const block of record.text.split(/\n\s*\n/)) {
      const p = document.createElement('p');
      fragments(block, p);
      article.append(p);
    }
    foot.textContent = record.modelNote ? `由备用模型 ${record.modelNote} 整理` : '';
    foot.hidden = !foot.textContent;
    panel.open = collected;
    panel.hidden = false;
    status.hidden = true;
  } catch {
    if (id !== currentId) return;
    status.hidden = false;
    panel.hidden = true;
    status.textContent = '整理版没取到，上方原文还在。';
  }
  resize();
}

new ResizeObserver(resize).observe(document.body);
hana.surface.onContextChanged(load);
void Promise.resolve(hana.ready()).then(load).catch(() => {});
