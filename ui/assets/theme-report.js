// theme-report.js — 把宿主的深浅报给 App 后端，再转给传音樱。
//
// 网页自己只要一个 data-appearance 属性就够；球是独立的 Python 进程，
// 它读不到宿主的主题（只能看 Windows 系统配色，那跟 Hana 自己的主题不是一回事），
// 所以得有人在界面上看到、顺手报上去。
import { hana } from './sdk.js';

let reported = '';

/** 读页面实际渲染出来的底色，用它判断深浅（宿主没给 appearance 时的兜底）。 */
function readBackground() {
  try {
    const value = getComputedStyle(document.body).backgroundColor || '';
    const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
    if (!match) return { mode: '', value };
    const r = Number(match[1]);
    const g = Number(match[2]);
    const b = Number(match[3]);
    // 人眼感知亮度，0 黑 1 白。
    const lightness = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return { mode: lightness < 0.5 ? 'dark' : 'light', value };
  } catch {
    return { mode: '', value: '' };
  }
}

function resolve(snapshot) {
  const declared = snapshot?.appearance === 'dark' ? 'dark' : snapshot?.appearance === 'light' ? 'light' : '';
  if (declared) return { mode: declared, source: 'appearance', background: '' };
  const { mode, value } = readBackground();
  return { mode, source: mode ? 'background' : 'none', background: value };
}

function report(resolved) {
  const key = `${resolved.mode || "none"}:${resolved.source}`;
  if (key === reported) return;
  reported = key;
  void hana.api
    .fetch('/ui-theme', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        appearance: resolved.mode,
        source: resolved.source,
        background: resolved.background,
      }),
    })
    .catch(() => {
      // 报不上去不影响页面，下次主题变了再试。
    });
}

/** 订阅宿主主题：设上 data-appearance，并把深浅报给 App。 */
export function followHostTheme() {
  try {
    hana.theme.subscribe((snapshot) => {
      const resolved = resolve(snapshot);
      if (!resolved.mode) return;
      if (document.documentElement.getAttribute('data-appearance') !== resolved.mode) {
        document.documentElement.setAttribute('data-appearance', resolved.mode);
      }
      report(resolved);
    });
  } catch {
    // 拿不到主题就维持原样，不影响页面本身。
  }
}
