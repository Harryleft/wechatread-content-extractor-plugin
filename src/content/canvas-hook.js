/**
 * Canvas Hook - 在 document_start 注入，拦截 Canvas fillText
 *
 * 原理：Proxy 包装 CanvasRenderingContext2D，在文字变成像素之前
 * 截获 fillText(text, x, y) 的绘制参数，存储文本+坐标+字号。
 * 通过 postMessage 桥接 page context ↔ content script。
 */

(function () {
  'use strict';

  // 注入到 page context 的 hook 代码
  const hookCode = `
(function() {
  var CAPTURED = [];
  var FONT_SIZE = 0;
  var LAST_Y = 0;

  var origGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function(type, attrs) {
    var ctx = origGetContext.call(this, type, attrs);
    if (type !== '2d') return ctx;

    return new Proxy(ctx, {
      get: function(target, prop) {
        var value = target[prop];

        if (prop === 'fillText') {
          return function(text, x, y) {
            // 过滤反爬标记
            if (typeof text === 'string' && text.startsWith('abcdefghijklmn')) {
              return value.apply(target, arguments);
            }
            // 只捕获有意义的文本
            if (text && typeof text === 'string' && text.trim().length > 0) {
              CAPTURED.push({
                t: text,
                x: parseFloat(x) || 0,
                y: parseFloat(y) || 0,
                s: FONT_SIZE
              });
            }
            return value.apply(target, arguments);
          };
        }

        if (prop === 'clearRect') {
          return function() {
            CAPTURED = [];
            return value.apply(target, arguments);
          };
        }

        if (prop === 'restore') {
          return function() {
            // restore 时标记一批绘制完成
            return value.apply(target, arguments);
          };
        }

        // 其他方法直接透传
        if (typeof value === 'function') {
          return value.bind(target);
        }
        return value;
      },

      set: function(target, prop, val) {
        if (prop === 'font') {
          var parts = (val || '').split(' ');
          for (var i = 0; i < parts.length; i++) {
            if (parts[i].endsWith('px')) {
              FONT_SIZE = parseInt(parts[i]) || 0;
              break;
            }
          }
        }
        target[prop] = val;
        return true;
      }
    });
  };

  // 监听 content script 的数据请求
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.type !== 'WEREAD_REQ_CANVAS') return;

    // 排序并组装文本
    var sorted = CAPTURED.slice().sort(function(a, b) {
      return a.y - b.y || a.x - b.x;
    });

    // 按 Y 坐标分组成行（Y 差距 < 3px 视为同一行）
    var lines = [];
    var cur = null;
    for (var i = 0; i < sorted.length; i++) {
      var item = sorted[i];
      if (!cur || Math.abs(item.y - cur.y) > 3) {
        if (cur) lines.push(cur);
        cur = { y: item.y, parts: [{ x: item.x, t: item.t }], fs: item.s };
      } else {
        cur.parts.push({ x: item.x, t: item.t });
      }
    }
    if (cur) lines.push(cur);

    // 行内按 X 排序，拼接文本
    var result = [];
    var prevY = 0;
    for (var j = 0; j < lines.length; j++) {
      var line = lines[j];
      line.parts.sort(function(a, b) { return a.x - b.x; });
      var text = line.parts.map(function(p) { return p.t; }).join('');

      // 大 Y 间距 → 段落分隔
      if (prevY > 0 && line.y - prevY > 35) {
        result.push('');
      }

      // 字号判断标题
      if (line.fs >= 27) {
        result.push('## ' + text);
      } else if (line.fs >= 23) {
        result.push('### ' + text);
      } else {
        result.push(text);
      }
      prevY = line.y;
    }

    var output = result.join('\\n');

    window.postMessage({
      type: 'WEREAD_CANVAS_DATA',
      raw: sorted,
      text: output,
      count: sorted.length
    }, '*');
  });
})();
`;

  // 注入到 page context
  const script = document.createElement('script');
  script.textContent = hookCode;
  (document.head || document.documentElement).appendChild(script);
  script.remove();

  // 暴露给 extractor.js 的数据读取函数
  window.__wereadGetCanvasText = function () {
    return new Promise(function (resolve) {
      var handler = function (e) {
        if (e.data && e.data.type === 'WEREAD_CANVAS_DATA') {
          window.removeEventListener('message', handler);
          resolve({
            text: e.data.text || '',
            count: e.data.count || 0,
            raw: e.data.raw || []
          });
        }
      };
      window.addEventListener('message', handler);

      // 请求 page context 返回捕获的数据
      window.postMessage({ type: 'WEREAD_REQ_CANVAS' }, '*');

      // 超时
      setTimeout(function () {
        window.removeEventListener('message', handler);
        resolve({ text: '', count: 0, raw: [] });
      }, 2000);
    });
  };
})();
