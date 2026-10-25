/* theme-follow.js — 跟着 Hana 的主题深浅走。
 *
 * 宿主会给 iframe 的地址带上 hana-theme-appearance=light|dark，
 * 主题一变还会发一条 hana.theme.changed 的消息。
 * 两样都拿不到时退到 prefers-color-scheme（Electron 里它跟着 nativeTheme 走）。
 *
 * 样式那边早就写好了 html[data-appearance="dark"] 那一套，缺的只是有人把这个属性点上。
 */
(function () {
  var root = document.documentElement;
  // 宿主明确告诉过深浅之后，就不再让系统偏好覆盖它。
  var locked = false;

  function apply(mode, lock) {
    if (mode !== 'dark' && mode !== 'light') return;
    if (lock) locked = true;
    if (root.getAttribute('data-appearance') !== mode) {
      root.setAttribute('data-appearance', mode);
    }
  }

  var fromUrl = '';
  try {
    fromUrl = new URLSearchParams(window.location.search || '').get('hana-theme-appearance') || '';
  } catch (_) {
    fromUrl = '';
  }
  if (fromUrl) apply(fromUrl, true);

  var media = null;
  try {
    media = window.matchMedia('(prefers-color-scheme: dark)');
  } catch (_) {
    media = null;
  }

  if (!locked && media) apply(media.matches ? 'dark' : 'light', false);

  if (media && media.addEventListener) {
    media.addEventListener('change', function (event) {
      if (locked) return;
      apply(event.matches ? 'dark' : 'light', false);
    });
  }

  // 宿主主题变了：以它为准，哪怕 URL 里那个初值跟它不一样。
  window.addEventListener('message', function (event) {
    var data = event && event.data;
    if (!data || data.type !== 'hana.theme.changed') return;
    var payload = data.payload || {};
    apply(payload.appearance, true);
  });
})();
