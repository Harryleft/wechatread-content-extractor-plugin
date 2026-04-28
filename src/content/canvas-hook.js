/**
 * Canvas Hook - 在 main world 中拦截 Canvas fillText
 *
 * 该文件通过 manifest 的 world: "MAIN" 运行，避免使用内联脚本注入，
 * 从而不触发微信读书页面的 CSP inline-script 限制。
 */

(function () {
  'use strict';

  if (window.__wereadCanvasHookInstalled) return;
  window.__wereadCanvasHookInstalled = true;

  let captured = [];
  let currentFontSize = 0;
  const proxyMap = new WeakMap();
  const originalGetContext = HTMLCanvasElement.prototype.getContext;

  function collectPageState() {
    try {
      const state = window.__INITIAL_STATE__;
      if (!state) return null;

      return {
        bookId: state.bookId || '',
        bookInfo: state.bookInfo || {},
        chapterInfos: (state.chapterInfos || []).map(function (chapter) {
          return {
            title: chapter.title,
            level: chapter.level,
            chapterUid: chapter.chapterUid
          };
        }),
        currentChapter: state.currentChapter || {},
        reader: state.reader ? {
          bookVersion: state.reader.bookVersion,
          chapterUid: state.reader.chapterUid,
          bookId: state.reader.bookId
        } : {}
      };
    } catch (e) {
      return null;
    }
  }

  function recordText(text, x, y) {
    if (typeof text !== 'string') return;
    if (!text.trim()) return;
    if (text.startsWith('abcdefghijklmn')) return;

    captured.push({
      t: text,
      x: parseFloat(x) || 0,
      y: parseFloat(y) || 0,
      s: currentFontSize
    });
  }

  function buildCanvasText() {
    const sorted = captured.slice().sort(function (a, b) {
      return a.y - b.y || a.x - b.x;
    });

    const lines = [];
    let currentLine = null;

    for (let i = 0; i < sorted.length; i += 1) {
      const item = sorted[i];
      if (!currentLine || Math.abs(item.y - currentLine.y) > 3) {
        if (currentLine) lines.push(currentLine);
        currentLine = {
          y: item.y,
          parts: [{ x: item.x, t: item.t }],
          fontSize: item.s
        };
      } else {
        currentLine.parts.push({ x: item.x, t: item.t });
      }
    }

    if (currentLine) lines.push(currentLine);

    const result = [];
    let previousY = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      line.parts.sort(function (a, b) {
        return a.x - b.x;
      });

      const text = line.parts.map(function (part) {
        return part.t;
      }).join('');

      if (previousY > 0 && line.y - previousY > 35) {
        result.push('');
      }

      if (line.fontSize >= 27) {
        result.push('## ' + text);
      } else if (line.fontSize >= 23) {
        result.push('### ' + text);
      } else {
        result.push(text);
      }

      previousY = line.y;
    }

    return {
      raw: sorted,
      text: result.join('\n'),
      count: sorted.length
    };
  }

  function installCanvasHook() {
    HTMLCanvasElement.prototype.getContext = function () {
      const context = originalGetContext.apply(this, arguments);
      if (arguments[0] !== '2d' || !context) return context;
      if (proxyMap.has(context)) return proxyMap.get(context);

      const proxy = new Proxy(context, {
        get: function (target, prop) {
          const value = target[prop];

          if (prop === 'fillText') {
            return function (text, x, y) {
              recordText(text, x, y);
              return value.apply(target, arguments);
            };
          }

          if (prop === 'clearRect') {
            return function () {
              captured = [];
              return value.apply(target, arguments);
            };
          }

          if (typeof value === 'function') {
            return value.bind(target);
          }

          return value;
        },

        set: function (target, prop, value) {
          if (prop === 'font') {
            const parts = String(value || '').split(' ');
            for (let i = 0; i < parts.length; i += 1) {
              if (parts[i].endsWith('px')) {
                currentFontSize = parseInt(parts[i], 10) || 0;
                break;
              }
            }
          }

          target[prop] = value;
          return true;
        }
      });

      proxyMap.set(context, proxy);
      return proxy;
    };
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window || !event.data || typeof event.data !== 'object') return;

    if (event.data.type === 'WEREAD_REQ_STATE') {
      window.postMessage({
        type: 'WEREAD_STATE',
        requestId: event.data.requestId,
        data: collectPageState()
      }, '*');
    }

    if (event.data.type === 'WEREAD_REQ_CANVAS') {
      const result = buildCanvasText();
      window.postMessage({
        type: 'WEREAD_CANVAS_DATA',
        requestId: event.data.requestId,
        raw: result.raw,
        text: result.text,
        count: result.count
      }, '*');
    }
  });

  installCanvasHook();
})();
