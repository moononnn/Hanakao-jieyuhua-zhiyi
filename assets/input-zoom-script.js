/* Hana 草稿图片放大 — 给输入框里粘贴/附加的图片缩略图加点击查看
 * 不依赖 Hana 内部模块，纯 DOM 事件委托，跨版本只需要重新安装一次。
 */
(function () {
  'use strict';

  if (window.__hanaDraftImageZoomInstalled) return;
  window.__hanaDraftImageZoomInstalled = true;

  var CHIP_SELECTOR = '[class*="media-attachment-chip"]';
  var Z = 2147483000;

  var overlay = null;
  var imgView = null;
  var indexLabel = null;
  var list = [];
  var cursor = 0;
  var scale = 1;
  var tx = 0;
  var ty = 0;

  function injectStyle() {
    if (document.getElementById('hana-draft-image-zoom-style')) return;
    var style = document.createElement('style');
    style.id = 'hana-draft-image-zoom-style';
    style.textContent = [
      '.hdiz-overlay{position:fixed;inset:0;z-index:' + Z + ';display:none;align-items:center;justify-content:center;',
      'background:rgba(10,10,12,.86);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);',
      'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;user-select:none;touch-action:none;}',
      '.hdiz-overlay.hdiz-open{display:flex;}',
      '.hdiz-stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:grab;}',
      '.hdiz-stage.hdiz-dragging{cursor:grabbing;}',
      '.hdiz-image{max-width:92vw;max-height:88vh;object-fit:contain;border-radius:8px;',
      'box-shadow:0 24px 80px rgba(0,0,0,.55);transform-origin:center center;will-change:transform;pointer-events:none;}',
      '.hdiz-bar{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;justify-content:space-between;',
      'padding:14px 18px;color:#fff;font-size:13px;opacity:.9;}',
      '.hdiz-index{letter-spacing:.04em;}',
      '.hdiz-close{all:unset;cursor:pointer;width:32px;height:32px;display:flex;align-items:center;justify-content:center;',
      'border-radius:50%;font-size:22px;line-height:1;color:#fff;background:rgba(255,255,255,.12);}',
      '.hdiz-close:hover{background:rgba(255,255,255,.24);}',
      '.hdiz-nav{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;',
      'display:none;align-items:center;justify-content:center;font-size:26px;line-height:1;color:#fff;cursor:pointer;',
      'background:rgba(255,255,255,.12);}',
      '.hdiz-nav:hover{background:rgba(255,255,255,.24);}',
      '.hdiz-nav.hdiz-prev{left:20px;}',
      '.hdiz-nav.hdiz-next{right:20px;}',
      '.hdiz-nav.hdiz-visible{display:flex;}',
      '[class*="media-attachment-chip"]{cursor:zoom-in;}'
    ].join('');
    document.head.appendChild(style);
    document.documentElement.setAttribute('data-hdiz-ready', '1');
  }

  function build() {
    if (overlay) return;
    injectStyle();

    overlay = document.createElement('div');
    overlay.className = 'hdiz-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    var stage = document.createElement('div');
    stage.className = 'hdiz-stage';

    imgView = document.createElement('img');
    imgView.className = 'hdiz-image';
    imgView.alt = '';
    stage.appendChild(imgView);

    var bar = document.createElement('div');
    bar.className = 'hdiz-bar';

    indexLabel = document.createElement('span');
    indexLabel.className = 'hdiz-index';

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'hdiz-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', '关闭预览');
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      close();
    });

    bar.appendChild(indexLabel);
    bar.appendChild(closeBtn);

    var prev = document.createElement('div');
    prev.className = 'hdiz-nav hdiz-prev';
    prev.textContent = '‹';
    prev.addEventListener('click', function (e) {
      e.stopPropagation();
      step(-1);
    });

    var next = document.createElement('div');
    next.className = 'hdiz-nav hdiz-next';
    next.textContent = '›';
    next.addEventListener('click', function (e) {
      e.stopPropagation();
      step(1);
    });

    overlay.appendChild(stage);
    overlay.appendChild(bar);
    overlay.appendChild(prev);
    overlay.appendChild(next);
    document.body.appendChild(overlay);

    overlay._stage = stage;
    overlay._prev = prev;
    overlay._next = next;

    stage.addEventListener('click', function (e) {
      if (e.target === stage) close();
    });

    stage.addEventListener('wheel', function (e) {
      e.preventDefault();
      var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      scale = Math.min(8, Math.max(1, scale * factor));
      if (scale === 1) {
        tx = 0;
        ty = 0;
      }
      applyTransform();
    }, { passive: false });

    var dragging = false;
    var startX = 0;
    var startY = 0;
    var originX = 0;
    var originY = 0;

    stage.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      originX = tx;
      originY = ty;
      stage.classList.add('hdiz-dragging');
      stage.setPointerCapture(e.pointerId);
    });

    stage.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      if (scale <= 1) return;
      tx = originX + (e.clientX - startX);
      ty = originY + (e.clientY - startY);
      applyTransform();
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      stage.classList.remove('hdiz-dragging');
      try {
        stage.releasePointerCapture(e.pointerId);
      } catch (_) {}
    }

    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    stage.addEventListener('dblclick', function (e) {
      e.stopPropagation();
      if (scale > 1) {
        scale = 1;
        tx = 0;
        ty = 0;
      } else {
        scale = 2;
      }
      applyTransform();
    });

    document.addEventListener('keydown', function (e) {
      if (!overlay || !overlay.classList.contains('hdiz-open')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'ArrowLeft') {
        step(-1);
      } else if (e.key === 'ArrowRight') {
        step(1);
      } else if (e.key === '0') {
        scale = 1;
        tx = 0;
        ty = 0;
        applyTransform();
      }
    }, true);
  }

  function applyTransform() {
    if (!imgView) return;
    imgView.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
  }

  function render() {
    if (!overlay) return;
    imgView.src = list[cursor];
    scale = 1;
    tx = 0;
    ty = 0;
    applyTransform();

    var multi = list.length > 1;
    overlay._prev.classList.toggle('hdiz-visible', multi);
    overlay._next.classList.toggle('hdiz-visible', multi);
    indexLabel.textContent = multi ? (cursor + 1) + ' / ' + list.length : '';
  }

  function step(delta) {
    if (list.length < 2) return;
    cursor = (cursor + delta + list.length) % list.length;
    render();
  }

  function open(items, startIndex) {
    build();
    list = items;
    cursor = startIndex;
    render();
    overlay.classList.add('hdiz-open');
  }

  function close() {
    if (!overlay) return;
    overlay.classList.remove('hdiz-open');
    imgView.removeAttribute('src');
    list = [];
    scale = 1;
    tx = 0;
    ty = 0;
  }

  injectStyle();

  document.addEventListener('click', function (e) {
    var target = e.target;
    if (!target || target.nodeType !== 1) return;
    if (target.closest('button')) return;
    if (overlay && overlay.contains(target)) return;

    var chip = target.closest(CHIP_SELECTOR);
    if (!chip) return;

    var own = chip.querySelector('img');
    if (!own || !own.getAttribute('src')) return;

    var container = chip.parentElement;
    var chips = container ? Array.prototype.slice.call(container.querySelectorAll(CHIP_SELECTOR)) : [chip];

    var sources = [];
    var startIndex = 0;
    for (var i = 0; i < chips.length; i++) {
      var candidate = chips[i].querySelector('img');
      if (!candidate) continue;
      var src = candidate.getAttribute('src');
      if (!src) continue;
      if (chips[i] === chip) startIndex = sources.length;
      sources.push(src);
    }
    if (!sources.length) return;

    e.preventDefault();
    e.stopPropagation();
    open(sources, startIndex);
  }, true);
})();
