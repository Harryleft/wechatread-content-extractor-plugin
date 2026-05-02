/**
 * Canvas Hook - 在 main world 中桥接微信读书页面数据
 *
 * 该文件通过 manifest 的 world: "MAIN" 运行，绕过微信读书页面的 CSP inline-script 限制。
 * 优先提供完整章节内容，Canvas fillText() 捕获只作为兜底。
 */

(function () {
  'use strict';

  if (window.__wereadCanvasHookInstalled) return;
  window.__wereadCanvasHookInstalled = true;

  let captured = [];
  let captureBatch = 0;
  let currentFontSize = 0;
  let lastChapterUid = null;
  const seenLineTexts = new Set();
  const proxyMap = new WeakMap();
  const positionMap = new Map();
  const chapterResponseCache = [];
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalFetch = window.fetch;
  const originalXhrOpen = typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest.prototype.open : null;
  const originalXhrSend = typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest.prototype.send : null;
  const maxCacheItems = 30;
  const maxResponseTextLength = 2000000;

  // ── 页面状态 ──

  function collectPageState() {
    try {
      const state = window.__INITIAL_STATE__;
      const readerVm = findReaderVm();
      const reader = state?.reader || {};
      const currentChapter = readerVm?.currentChapter || reader.currentChapter || state?.currentChapter || {};
      const bookInfo = state?.bookInfo || reader.bookInfo || readerVm?.bookInfo || {};
      const chapterInfos = state?.chapterInfos || reader.chapterInfos || readerVm?.chapterInfos || [];

      if (!state && !readerVm) return null;

      return {
        bookId: state?.bookId || reader.bookId || bookInfo.bookId || '',
        bookInfo,
        chapterInfos: normalizeChapterInfos(chapterInfos),
        currentChapter: {
          title: currentChapter.title || '',
          chapterUid: currentChapter.chapterUid || reader.chapterUid || readerVm?.chapterUid || '',
          chapterIdx: currentChapter.chapterIdx
        },
        reader: {
          bookVersion: reader.bookVersion,
          chapterUid: reader.chapterUid || currentChapter.chapterUid || readerVm?.chapterUid || '',
          bookId: reader.bookId || state?.bookId || bookInfo.bookId || ''
        }
      };
    } catch (e) {
      return null;
    }
  }

  function normalizeChapterInfos(chapterInfos) {
    if (!Array.isArray(chapterInfos)) return [];

    return chapterInfos.map(function (chapter) {
      return {
        title: chapter.title,
        level: chapter.level,
        chapterUid: chapter.chapterUid,
        chapterIdx: chapter.chapterIdx
      };
    });
  }

  // ── Canvas fillText 拦截 ──

  function detectChapterChange() {
    try {
      let state = window.__INITIAL_STATE__;
      let currentUid = (state?.reader?.chapterUid || state?.currentChapter?.chapterUid || '');
      if (currentUid && lastChapterUid && String(currentUid) !== String(lastChapterUid)) {
        captured = [];
        captureBatch = 0;
        seenLineTexts.clear();
        positionMap.clear();
      }
      if (currentUid) {
        lastChapterUid = String(currentUid);
      }
    } catch (e) { /* 忽略 */ }
  }

  function recordText(text, x, y) {
    detectChapterChange();
    if (typeof text !== 'string') return;
    if (!text.trim()) return;
    if (text.startsWith('abcdefghijklmn')) return;

    // 基于时间间隔检测翻页：渲染间隔 >500ms 视为新页面
    var now = Date.now();
    if (lastFillTextTime > 0 && (now - lastFillTextTime) > BATCH_GAP_MS) {
      captureBatch++;
      positionMap.clear();
    }
    lastFillTextTime = now;

    var posKey = Math.round(parseFloat(x) || 0) + '|' + Math.round(parseFloat(y) || 0) + '|' + currentFontSize;
    var existingIdx = positionMap.get(posKey);

    if (existingIdx !== undefined && captured[existingIdx]) {
      if (captured[existingIdx].t === text) return;
      captured[existingIdx].dead = true;
    }

    positionMap.set(posKey, captured.length);
    captured.push({
      t: text,
      x: parseFloat(x) || 0,
      y: parseFloat(y) || 0,
      s: currentFontSize,
      b: captureBatch,
      dead: false
    });
  }

  function buildCanvasText() {
    detectChapterChange();
    const deadCount = captured.filter(function(item) { return item.dead; }).length;
    const snapshot = captured.filter(function(item) { return !item.dead; });
    const sorted = snapshot.sort(function (a, b) {
      return a.b - b.b || a.y - b.y || a.x - b.x;
    });

    const batches = new Set();
    for (let i = 0; i < sorted.length; i += 1) batches.add(sorted[i].b);

    const lines = [];
    let currentLine = null;
    let lastBatch = -1;

    for (let i = 0; i < sorted.length; i += 1) {
      const item = sorted[i];
      const batchChanged = item.b !== lastBatch;

      if (!currentLine || batchChanged || Math.abs(item.y - currentLine.y) > 3) {
        if (currentLine) lines.push(Object.assign({}, currentLine, { batch: lastBatch }));
        currentLine = {
          y: item.y,
          parts: [{ x: item.x, t: item.t }],
          fontSize: item.s
        };
        lastBatch = item.b;
      } else {
        currentLine.parts.push({ x: item.x, t: item.t });
      }
    }

    if (currentLine) lines.push(Object.assign({}, currentLine, { batch: lastBatch }));

    const result = [];
    const emitted = new Set();
    let previousBatch = -1;
    let skippedDupes = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const parts = dedupeLineParts(line.parts);
      parts.sort(function (a, b) {
        return a.x - b.x;
      });

      const text = parts.map(function (part) {
        return part.t;
      }).join('');

      var emitKey = line.batch + '|' + text;
      if (emitted.has(emitKey)) {
        skippedDupes += 1;
        continue;
      }
      emitted.add(emitKey);

      if (previousBatch >= 0 && line.batch !== previousBatch) {
        result.push('');
      }

      if (line.fontSize >= 27) {
        result.push('## ' + text);
      } else if (line.fontSize >= 23) {
        result.push('### ' + text);
      } else {
        result.push(text);
      }

      previousBatch = line.batch;
    }

    // 扫描 Canvas 区域内的 DOM 元素（图片、代码块、文本等）
    var domImgCount = 0;
    var domTextBlocks = 0;
    var domTextChars = 0;
    var domImgSamples = [];
    try {
      var canvasEls = document.querySelectorAll('canvas');
      var canvasRect = null;
      for (var ci = 0; ci < canvasEls.length; ci++) {
        if (canvasEls[ci].offsetWidth > 100) {
          canvasRect = canvasEls[ci].getBoundingClientRect();
          break;
        }
      }
      if (canvasRect) {
        // 扫描图片
        var imgs = document.querySelectorAll('img');
        for (var ii = 0; ii < imgs.length; ii++) {
          var ir = imgs[ii].getBoundingClientRect();
          if (ir.width > 30 && ir.height > 30
              && ir.top >= canvasRect.top - 50 && ir.bottom <= canvasRect.bottom + 50
              && ir.left >= canvasRect.left - 50 && ir.right <= canvasRect.right + 50) {
            domImgCount++;
            if (domImgSamples.length < 5) {
              domImgSamples.push('img[' + Math.round(ir.top) + ',' + Math.round(ir.height) + 'px] src=' + (imgs[ii].src || '').slice(0, 80));
            }
          }
        }
        // 扫描文本节点
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: function (node) {
            var el = node.parentElement;
            if (!el) return NodeFilter.FILTER_REJECT;
            var tag = el.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return NodeFilter.FILTER_REJECT;
            var text = (node.textContent || '').trim();
            if (text.length < 10) return NodeFilter.FILTER_REJECT;
            var rect = el.getBoundingClientRect();
            if (rect.top >= canvasRect.top - 50 && rect.bottom <= canvasRect.bottom + 50
                && rect.left >= canvasRect.left - 50 && rect.right <= canvasRect.right + 50) {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_REJECT;
          }
        });
        while (walker.nextNode()) {
          domTextBlocks++;
          domTextChars += (walker.currentNode.textContent || '').trim().length;
        }
      }
    } catch (e) { /* 忽略 */ }

    console.log('[WereadExtractor][canvas] captured=' + captured.length + ' dead=' + deadCount + ' alive=' + snapshot.length + ' batches=' + batches.size + ' lines=' + lines.length + ' skippedDupes=' + skippedDupes + ' | clearRect=' + clearRectCount + ' fillRect=' + fillRectCount + ' drawImage=' + drawImageCount + ' strokeText=' + strokeTextCount + ' | domImgs=' + domImgCount + ' domTextBlocks=' + domTextBlocks + ' domTextChars=' + domTextChars);
    if (domImgSamples.length > 0) {
      console.log('[WereadExtractor][canvas-imgs] ' + domImgSamples.join(' | '));
    }

    return {
      raw: sorted,
      text: result.join('\n'),
      count: sorted.length,
      batches: batches.size,
      deadCount: deadCount,
      totalCaptured: captured.length,
      clearRectCount: clearRectCount,
      fillRectCount: fillRectCount,
      drawImageCount: drawImageCount,
      strokeTextCount: strokeTextCount,
      domImgCount: domImgCount,
      domTextBlocks: domTextBlocks,
      domTextChars: domTextChars
    };
  }

  function dedupeLineParts(parts) {
    const result = [];
    const seen = new Set();

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const key = Math.round(part.x) + '|' + part.t;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(part);
    }

    return result;
  }

  let fillRectCount = 0;
  let drawImageCount = 0;
  let clearRectCount = 0;
  let canvasResizeCount = 0;
  let offscreenFillTextCount = 0;
  let offscreenCreated = 0;
  let strokeTextCount = 0;
  let lastFillTextTime = 0;
  const BATCH_GAP_MS = 500;

  function createOffscreenProxyHandler() {
    return {
      get: function (target, prop) {
        const value = target[prop];

        if (prop === 'fillText') {
          return function (text, x, y) {
            offscreenFillTextCount++;
            recordText(text, x, y);
            return value.apply(target, arguments);
          };
        }

        if (prop === 'font') {
          return value;
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
    };
  }

  function installOffscreenCanvasHook() {
    if (typeof OffscreenCanvas === 'undefined') return;

    const originalOffscreenGetContext = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function () {
      const context = originalOffscreenGetContext.apply(this, arguments);
      if (arguments[0] !== '2d' || !context) return context;

      offscreenCreated++;
      return new Proxy(context, createOffscreenProxyHandler());
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

          if (prop === 'strokeText') {
            return function (text, x, y) {
              strokeTextCount++;
              recordText(text, x, y);
              return value.apply(target, arguments);
            };
          }

          if (prop === 'clearRect') {
            return function (x, y, width, height) {
              clearRectCount++;
              var canvas = target.canvas;
              var isSubstantial = !canvas
                || (width >= canvas.width * 0.5 && height >= canvas.height * 0.5);
              if (isSubstantial) {
                captureBatch++;
                positionMap.clear();
              }
              return value.apply(target, arguments);
            };
          }

          if (prop === 'fillRect') {
            return function (x, y, width, height) {
              var canvas = target.canvas;
              if (canvas && width >= canvas.width * 0.5 && height >= canvas.height * 0.5) {
                fillRectCount++;
                captureBatch++;
                positionMap.clear();
              }
              return value.apply(target, arguments);
            };
          }

          if (prop === 'drawImage') {
            return function () {
              drawImageCount++;
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

  // ── 完整章节内容提取 ──

  function installNetworkHook() {
    if (typeof originalFetch === 'function') {
      window.fetch = function () {
        const url = normalizeRequestUrl(arguments[0]);

        return originalFetch.apply(this, arguments).then(function (response) {
          inspectFetchResponse(url, response);
          return response;
        });
      };
    }

    if (originalXhrOpen && originalXhrSend) {
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__wereadRequestUrl = normalizeRequestUrl(url);
        return originalXhrOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function () {
        this.addEventListener('load', function () {
          inspectXhrResponse(this);
        });
        return originalXhrSend.apply(this, arguments);
      };
    }
  }

  function normalizeRequestUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  function inspectFetchResponse(url, response) {
    if (!isPotentialChapterUrl(url) || !response || typeof response.clone !== 'function') return;

    try {
      response.clone().text().then(function (text) {
        rememberChapterResponse(url, text);
      }).catch(function () {});
    } catch (e) { /* 忽略 */ }
  }

  function inspectXhrResponse(xhr) {
    const url = xhr.__wereadRequestUrl || '';
    if (!isPotentialChapterUrl(url)) return;
    if (xhr.responseType && xhr.responseType !== 'text' && xhr.responseType !== 'json') return;

    try {
      const text = typeof xhr.response === 'string' ? xhr.response : xhr.responseText;
      rememberChapterResponse(url, text);
    } catch (e) { /* 忽略 */ }
  }

  function isPotentialChapterUrl(url) {
    return /\/(?:web\/)?book\/chapterContent\b|\/book\/chapterInfos\b|chapterContent/i.test(url || '');
  }

  function rememberChapterResponse(url, text) {
    if (typeof text !== 'string' || !text.trim()) return;
    if (text.length > maxResponseTextLength) return;

    const expectedChapterUid = getUrlParam(url, 'chapterUid') || getUrlParam(url, 'c');
    const parsed = parseJsonMaybe(text);
    const payload = parsed || text;
    const candidates = collectContentCandidates(payload, {
      expectedChapterUid,
      source: 'network:' + url,
      forceBase64: /\bbase64=1\b/.test(url)
    });

    candidates.forEach(function (candidate) {
      chapterResponseCache.push({
        ...candidate,
        url,
        chapterUid: candidate.chapterUid || expectedChapterUid || ''
      });
    });

    while (chapterResponseCache.length > maxCacheItems) {
      chapterResponseCache.shift();
    }
  }

  async function getFullChapterContent(request) {
    const expectedChapterUid = String(request?.chapterUid || '').trim();
    const readerContent = getChapterContentFromReader(expectedChapterUid);
    if (readerContent) return okChapterContent(readerContent);

    const cachedContent = getChapterContentFromCache(expectedChapterUid);
    if (cachedContent) return okChapterContent(cachedContent);

    const fetchedContent = await fetchChapterContent(request);
    if (fetchedContent) return okChapterContent(fetchedContent);

    return {
      success: false,
      error: '未在页面阅读器实例或章节接口响应中找到完整章节内容。'
    };
  }

  function okChapterContent(content) {
    return {
      success: true,
      content
    };
  }

  function getChapterContentFromReader(expectedChapterUid) {
    const vm = findReaderVm();
    if (!vm) return null;

    const currentChapter = vm.currentChapter || {};
    const chapterUid = String(currentChapter.chapterUid || vm.chapterUid || '').trim();
    if (expectedChapterUid && chapterUid && expectedChapterUid !== chapterUid) return null;

    const title = currentChapter.title || getChapterTitle(expectedChapterUid) || '';
    const candidates = [];
    const fields = [
      ['chapterContentForEPub', vm.chapterContentForEPub],
      ['chapterContent', vm.chapterContent],
      ['currentChapter.content', currentChapter.content],
      ['currentChapter.html', currentChapter.html],
      ['currentChapter.body', currentChapter.body],
      ['currentChapter.text', currentChapter.text]
    ];

    fields.forEach(function (entry) {
      const found = collectContentCandidates(entry[1], {
        expectedChapterUid,
        fallbackTitle: title,
        source: 'reader.' + entry[0]
      });
      candidates.push(...found);
    });

    return chooseBestCandidate(candidates, expectedChapterUid);
  }

  function findReaderVm() {
    const directCandidates = [
      window.book,
      window.reader,
      window.__wereadReader,
      window.__WEREAD_READER__
    ];

    for (let i = 0; i < directCandidates.length; i += 1) {
      const candidate = unwrapVueCandidate(directCandidates[i]);
      if (isReaderVm(candidate)) return candidate;
    }

    const selectors = [
      'div.readerContent.routerView',
      '.readerContent.routerView',
      '.readerContent',
      '[class*="readerContent"]',
      '[class*="Reader"]'
    ];

    for (let i = 0; i < selectors.length; i += 1) {
      const elements = document.querySelectorAll(selectors[i]);
      for (let j = 0; j < elements.length; j += 1) {
        const candidate = findVueCandidate(elements[j]);
        if (candidate) return candidate;
      }
    }

    const allElements = document.querySelectorAll('*');
    for (let i = 0; i < allElements.length && i < 2000; i += 1) {
      if (!allElements[i].__vue__ && !allElements[i].__vueParentComponent) continue;

      const candidate = findVueCandidate(allElements[i]);
      if (candidate) return candidate;
    }

    return null;
  }

  function findVueCandidate(element) {
    const queue = [
      element?.__vue__,
      element?.__vueParentComponent
    ];
    const seen = new WeakSet();
    let cursor = 0;

    while (cursor < queue.length && cursor < 200) {
      const raw = queue[cursor];
      cursor += 1;
      if (!raw || typeof raw !== 'object') continue;
      if (seen.has(raw)) continue;
      seen.add(raw);

      const candidate = unwrapVueCandidate(raw);
      if (isReaderVm(candidate)) return candidate;

      pushObject(queue, raw.proxy);
      pushObject(queue, raw.ctx);
      pushObject(queue, raw.parent);
      pushObject(queue, raw.root);
      pushObject(queue, raw.subTree);
      pushObject(queue, raw.component);

      if (Array.isArray(raw.children)) {
        raw.children.forEach(function (child) {
          pushObject(queue, child);
        });
      }
    }

    return null;
  }

  function unwrapVueCandidate(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return raw.proxy || raw.ctx || raw;
  }

  function pushObject(queue, value) {
    if (value && typeof value === 'object') queue.push(value);
  }

  function isReaderVm(candidate) {
    if (!candidate || typeof candidate !== 'object') return false;

    return Boolean(
      candidate.chapterContentForEPub
      || candidate.chapterContent
      || candidate.currentChapter
      || candidate.chapterInfos
      || candidate.bookInfo
      || candidate.handleNextChapter
      || candidate.changeChapter
    );
  }

  function getChapterContentFromCache(expectedChapterUid) {
    for (let i = chapterResponseCache.length - 1; i >= 0; i -= 1) {
      const candidate = chapterResponseCache[i];
      if (!expectedChapterUid || !candidate.chapterUid || String(candidate.chapterUid) === expectedChapterUid) {
        return candidate;
      }
    }

    return null;
  }

  async function fetchChapterContent(request) {
    const bookId = String(request?.bookId || '').trim();
    const chapterUid = String(request?.chapterUid || '').trim();
    if (!bookId || !chapterUid || typeof originalFetch !== 'function') return null;

    const urls = [
      `/web/book/chapterContent?bookId=${encodeURIComponent(bookId)}&chapterUid=${encodeURIComponent(chapterUid)}&base64=1`,
      `/web/book/chapterContent?bookId=${encodeURIComponent(bookId)}&chapterUid=${encodeURIComponent(chapterUid)}`,
      `https://i.weread.qq.com/book/chapterContent?bookId=${encodeURIComponent(bookId)}&chapterUid=${encodeURIComponent(chapterUid)}`
    ];

    for (let i = 0; i < urls.length; i += 1) {
      try {
        const response = await originalFetch(urls[i], {
          credentials: 'include',
          headers: {
            Accept: 'application/json, text/plain, */*'
          }
        });
        if (!response || !response.ok) continue;

        const text = await response.text();
        rememberChapterResponse(urls[i], text);
        const candidate = getChapterContentFromCache(chapterUid);
        if (candidate) return candidate;
      } catch (e) { /* 忽略 */ }
    }

    return null;
  }

  function collectContentCandidates(value, options) {
    const candidates = [];
    const seen = new WeakSet();

    collectFromValue(value, {
      ...options,
      path: options?.source || 'unknown',
      depth: 0,
      seen,
      candidates
    });

    return candidates
      .filter(function (candidate) {
        return getCandidateLength(candidate) >= 20;
      })
      .sort(function (a, b) {
        return scoreCandidate(b) - scoreCandidate(a);
      });
  }

  function collectFromValue(value, context) {
    if (value == null || context.depth > 6) return;

    if (typeof value === 'string') {
      addStringCandidate(value, context);
      return;
    }

    if (Array.isArray(value)) {
      addArrayCandidate(value, context);
      value.forEach(function (item, index) {
        collectFromValue(item, {
          ...context,
          path: context.path + '[' + index + ']',
          depth: context.depth + 1
        });
      });
      return;
    }

    if (typeof value !== 'object') return;
    if (context.seen.has(value)) return;
    context.seen.add(value);

    const chapterUid = getObjectChapterUid(value) || context.expectedChapterUid || '';
    if (context.expectedChapterUid && chapterUid && String(chapterUid) !== String(context.expectedChapterUid)) {
      return;
    }

    const title = value.title || value.chapterTitle || context.fallbackTitle || '';
    const keys = [
      'chapterContentForEPub',
      'contentForEPub',
      'chapterContent',
      'content',
      'html',
      'body',
      'text',
      'paragraphs',
      'contents'
    ];

    keys.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        collectFromValue(value[key], {
          ...context,
          path: context.path + '.' + key,
          fallbackTitle: title,
          chapterUid,
          depth: context.depth + 1
        });
      }
    });

    Object.keys(value).forEach(function (key) {
      if (keys.includes(key)) return;
      if (!shouldWalkKey(key)) return;

      collectFromValue(value[key], {
        ...context,
        path: context.path + '.' + key,
        fallbackTitle: title,
        chapterUid,
        depth: context.depth + 1
      });
    });
  }

  function addStringCandidate(value, context) {
    const decoded = decodeMaybeBase64(value, context.forceBase64);
    const text = String(decoded || '').trim();
    if (!text) return;

    const candidate = buildCandidate(text, context);
    context.candidates.push(candidate);
  }

  function addArrayCandidate(value, context) {
    if (value.length === 0) return;

    if (value.every(function (item) { return typeof item === 'string'; })) {
      const raw = value.join(looksLikeHtml(value.join('')) ? '' : '\n');
      addStringCandidate(raw, context);
      return;
    }

    const stringParts = value.map(function (item) {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        return item.html || item.content || item.text || item.body || '';
      }
      return '';
    }).filter(Boolean);

    if (stringParts.length > 0) {
      const raw = stringParts.join(looksLikeHtml(stringParts.join('')) ? '' : '\n');
      addStringCandidate(raw, context);
    }
  }

  function buildCandidate(value, context) {
    const isHtml = looksLikeHtml(value);

    return {
      html: isHtml ? value : '',
      text: isHtml ? '' : value,
      title: context.fallbackTitle || '',
      chapterUid: context.chapterUid || context.expectedChapterUid || '',
      source: context.path || 'unknown'
    };
  }

  function shouldWalkKey(key) {
    return [
      'data',
      'payload',
      'chapter',
      'currentChapter',
      'reader',
      'book',
      'updated',
      'items',
      'list',
      'chapters'
    ].includes(key);
  }

  function getObjectChapterUid(value) {
    return value.chapterUid
      || value.chapterUID
      || value.chapterId
      || value.chapter?.chapterUid
      || value.currentChapter?.chapterUid
      || '';
  }

  function chooseBestCandidate(candidates, expectedChapterUid) {
    const matched = candidates.filter(function (candidate) {
      return !expectedChapterUid || !candidate.chapterUid || String(candidate.chapterUid) === String(expectedChapterUid);
    });

    if (matched.length === 0) return null;
    return matched.sort(function (a, b) {
      return scoreCandidate(b) - scoreCandidate(a);
    })[0];
  }

  function scoreCandidate(candidate) {
    const length = getCandidateLength(candidate);
    const sourceBonus = /chapterContentForEPub|chapterContent/i.test(candidate.source || '') ? 100000 : 0;
    const htmlBonus = candidate.html ? 1000 : 0;
    return length + sourceBonus + htmlBonus;
  }

  function getCandidateLength(candidate) {
    return (candidate.html || candidate.text || '').replace(/\s/g, '').length;
  }

  function parseJsonMaybe(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function decodeMaybeBase64(value, forceBase64) {
    const text = String(value || '').trim();
    if (!forceBase64 && !looksLikeBase64(text)) return text;

    try {
      const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
      const binary = atob(padded);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const decoded = new TextDecoder('utf-8').decode(bytes).trim();
      return decoded || text;
    } catch (e) {
      return text;
    }
  }

  function looksLikeBase64(text) {
    if (text.length < 80 || text.length % 4 === 1) return false;
    if (!/^[A-Za-z0-9+/_=-]+$/.test(text)) return false;
    return !/[<>{}\u4e00-\u9fff]/.test(text);
  }

  function looksLikeHtml(text) {
    return /<\/?[a-z][\s\S]*>/i.test(text || '');
  }

  function getUrlParam(url, key) {
    try {
      return new URL(url, window.location.origin).searchParams.get(key) || '';
    } catch (e) {
      return '';
    }
  }

  function getChapterTitle(chapterUid) {
    const state = collectPageState();
    const chapterInfos = state?.chapterInfos || [];
    const matched = chapterInfos.find(function (chapter) {
      return String(chapter.chapterUid) === String(chapterUid);
    });

    return matched?.title || state?.currentChapter?.title || '';
  }

  function getReactFiberKeys(element) {
    if (!element) return [];
    return Object.keys(element).filter(function (key) {
      return key.startsWith('__reactFiber')
        || key.startsWith('__reactInternalInstance')
        || key.startsWith('__reactContainer');
    });
  }

  function getReactFiberFromElement(element) {
    const keys = getReactFiberKeys(element);
    if (keys.length === 0) return null;
    return element[keys[0]] || null;
  }

  function getDisplayName(type) {
    if (!type) return '';
    if (typeof type === 'string') return type;
    return type.displayName || type.name || type._context?.displayName || '';
  }

  function summarizeInterestingValue(value, depth) {
    if (value == null || depth > 2) return null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      return trimmed.length > 160 ? trimmed.slice(0, 160) + '...' : trimmed;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return 'Array[' + value.length + ']';
    if (typeof value !== 'object') return typeof value;

    const summary = {};
    Object.keys(value).slice(0, 20).forEach(function (key) {
      if (!isInterestingStateKey(key)) return;
      const child = summarizeInterestingValue(value[key], depth + 1);
      if (child !== null) summary[key] = child;
    });

    return Object.keys(summary).length > 0 ? summary : 'Object{' + Object.keys(value).slice(0, 10).join(',') + '}';
  }

  function isInterestingStateKey(key) {
    return /book|reader|chapter|content|html|text|page|store|state|title|uid|id|current|catalog/i.test(key || '');
  }

  function collectInterestingFields(value, path, output, seen, depth) {
    if (!value || typeof value !== 'object' || depth > 4 || output.length >= 40) return;
    if (seen.has(value)) return;
    seen.add(value);

    Object.keys(value).slice(0, 60).forEach(function (key) {
      let child;
      try {
        child = value[key];
      } catch (e) {
        return;
      }

      const childPath = path + '.' + key;
      if (isInterestingStateKey(key)) {
        output.push({
          path: childPath,
          type: Array.isArray(child) ? 'array' : typeof child,
          value: summarizeInterestingValue(child, 0)
        });
      }

      if (child && typeof child === 'object') {
        collectInterestingFields(child, childPath, output, seen, depth + 1);
      }
    });
  }

  function summarizeReactFiber(fiber) {
    if (!fiber || typeof fiber !== 'object') return null;
    const fields = [];
    const seen = new WeakSet();
    collectInterestingFields(fiber.memoizedProps, 'memoizedProps', fields, seen, 0);
    collectInterestingFields(fiber.memoizedState, 'memoizedState', fields, seen, 0);
    collectInterestingFields(fiber.updateQueue, 'updateQueue', fields, seen, 0);

    return {
      tag: fiber.tag,
      key: fiber.key || '',
      type: getDisplayName(fiber.elementType || fiber.type),
      hasStateNode: !!fiber.stateNode,
      interestingFields: fields.slice(0, 12)
    };
  }

  function collectReactFiberDiagnostics() {
    const roots = [];
    const elements = document.querySelectorAll('*');
    for (let i = 0; i < elements.length && roots.length < 20; i += 1) {
      const fiber = getReactFiberFromElement(elements[i]);
      if (fiber) roots.push(fiber);
    }

    const queue = roots.slice();
    const seen = new WeakSet();
    const componentSamples = [];
    const stateSignals = [];
    let visited = 0;

    while (queue.length > 0 && visited < 600) {
      const fiber = queue.shift();
      if (!fiber || typeof fiber !== 'object' || seen.has(fiber)) continue;
      seen.add(fiber);
      visited++;

      const summary = summarizeReactFiber(fiber);
      if (summary && (summary.type || summary.interestingFields.length > 0)) {
        componentSamples.push(summary);
      }
      if (summary && summary.interestingFields.length > 0) {
        stateSignals.push({
          type: summary.type,
          fields: summary.interestingFields
        });
      }

      if (fiber.child) queue.push(fiber.child);
      if (fiber.sibling) queue.push(fiber.sibling);
      if (fiber.return) queue.push(fiber.return);
    }

    return {
      rootsFound: roots.length,
      visited,
      componentSamples: componentSamples.slice(0, 20),
      stateSignals: stateSignals.slice(0, 10)
    };
  }

  function collectStoreDiagnostics() {
    const diag = {
      hasReactDevtoolsHook: !!window.__REACT_DEVTOOLS_GLOBAL_HOOK__,
      hasReduxDevtools: !!window.__REDUX_DEVTOOLS_EXTENSION__,
      globalStoreKeys: [],
      domStoreProps: []
    };

    Object.getOwnPropertyNames(window).forEach(function (key) {
      if (/store|redux|recoil|zustand|mobx|valtio|jotai/i.test(key)) {
        diag.globalStoreKeys.push(key);
      }
    });

    const elements = document.querySelectorAll('*');
    for (let i = 0; i < elements.length && diag.domStoreProps.length < 20; i += 1) {
      Object.keys(elements[i]).forEach(function (key) {
        if (!key.startsWith('__reactProps')) return;
        const props = elements[i][key];
        const fields = [];
        collectInterestingFields(props, 'props', fields, new WeakSet(), 0);
        const hasStoreShape = fields.some(function (field) {
          return /store|state|dispatch|getState/i.test(field.path);
        });
        if (hasStoreShape) {
          diag.domStoreProps.push({
            tag: elements[i].tagName,
            cls: (elements[i].className || '').toString().slice(0, 60),
            fields: fields.slice(0, 8)
          });
        }
      });
    }

    diag.globalStoreKeys = diag.globalStoreKeys.slice(0, 30);
    return diag;
  }

  function collectModuleRuntimeDiagnostics() {
    const diag = {
      chunkKeys: [],
      webpackRequireKeys: [],
      scriptSamples: []
    };

    Object.getOwnPropertyNames(window).forEach(function (key) {
      if (/webpack|chunk|jsonp|vite|require/i.test(key)) {
        diag.chunkKeys.push({
          key,
          type: typeof window[key],
          size: Array.isArray(window[key]) ? window[key].length : ''
        });
      }
      if (/webpack_require/i.test(key)) {
        diag.webpackRequireKeys.push(key);
      }
    });

    const scripts = document.querySelectorAll('script[src]');
    for (let i = 0; i < scripts.length && diag.scriptSamples.length < 20; i += 1) {
      const src = scripts[i].src || '';
      if (/reader|book|chapter|app|main|chunk|weread/i.test(src)) {
        diag.scriptSamples.push(src);
      }
    }

    return diag;
  }

  // ── 诊断：webpack 模块缓存探测 ──

  function exploreWebpackModules() {
    var result = { webpackJsonpType: typeof window.webpackJsonp, chunks: [] };

    try {
      var jsonp = window.webpackJsonp;
      if (!jsonp) return result;

      // webpackJsonp 通常是数组，每个元素是 [chunkIds, moreModules, runtime]
      // 尝试从 webpackJsonp.push 或主 bundle 中找到 __webpack_require__
      result.jsonpLength = Array.isArray(jsonp) ? jsonp.length : 'not-array';
      result.jsonpKeys = Object.keys(jsonp).slice(0, 10);

      // 尝试通过劫持 webpackJsonp.push 捕获 runtime
      // 检查 jsonp.push 是否已被 webpack runtime 覆盖
      if (typeof jsonp.push === 'function') {
        result.pushString = jsonp.push.toString().slice(0, 200);
      }

      // 检查是否有全局的 __webpack_require__
      if (typeof __webpack_require__ !== 'undefined') {
        result.hasWebpackRequire = true;
      }

      // 遍历已加载的 script 标签，查找主 bundle 中的关键导出
      var scripts = document.querySelectorAll('script:not([src])');
      var inlineSnippets = [];
      for (var si = 0; si < scripts.length && si < 20; si++) {
        var txt = scripts[si].textContent || '';
        if (txt.length < 10) continue;
        // 搜索包含 reader/book/chapter 的内联脚本
        if (/reader|bookInfo|chapterContent|getChapter/i.test(txt)) {
          inlineSnippets.push(txt.slice(0, 300));
        }
      }
      result.inlineScriptHits = inlineSnippets;

      // 尝试从 webpackJsonp 的各 chunk 中提取模块信息
      if (Array.isArray(jsonp)) {
        for (var ci = 0; ci < jsonp.length && ci < 10; ci++) {
          var chunk = jsonp[ci];
          if (!Array.isArray(chunk) || chunk.length < 2) continue;
          var modules = chunk[1];
          if (typeof modules !== 'object') continue;
          var modKeys = Object.keys(modules);
          var interestingMods = [];
          for (var mi = 0; mi < modKeys.length && mi < 50; mi++) {
            var modSrc = typeof modules[modKeys[mi]] === 'function'
              ? modules[modKeys[mi]].toString()
              : String(modules[modKeys[mi]]);
            if (/reader|chapter|book|getContent|fetchChapter|chapterData/i.test(modSrc)) {
              interestingMods.push({
                moduleId: modKeys[mi],
                matchSnippet: modSrc.match(/.{0,40}(?:reader|chapter|book|getContent|fetchChapter|chapterData).{0,40}/i)[0]
              });
            }
          }
          if (interestingMods.length > 0) {
            result.chunks.push({ chunkId: chunk[0], interestingMods: interestingMods });
          }
        }
      }

      // 检查 window 上所有函数，搜索包含 'chapter' 的函数名
      var funcNames = [];
      var allKeys = Object.getOwnPropertyNames(window);
      for (var fi = 0; fi < allKeys.length; fi++) {
        var key = allKeys[fi];
        try {
          if (typeof window[key] === 'function' && /chapter|reader|weread/i.test(key)) {
            funcNames.push(key);
          }
        } catch (e) {}
      }
      result.interestingFuncNames = funcNames;

    } catch (e) {
      result.error = e.message;
    }

    return result;
  }

  // ── 诊断：深度探查页面结构 ──

  function runDiagnosis() {
    var diag = {};

    // 1. __INITIAL_STATE__
    var state = window.__INITIAL_STATE__;
    diag.hasInitialState = !!state;
    if (state) {
      diag.stateKeys = Object.keys(state);
      diag.stateBookId = state.bookId || '';
      diag.stateReaderUid = state.reader?.chapterUid || '';
      diag.stateCurrentChapter = state.currentChapter ? {
        title: state.currentChapter.title,
        chapterUid: state.currentChapter.chapterUid,
        chapterIdx: state.currentChapter.chapterIdx
      } : null;
      diag.stateChapterInfosCount = Array.isArray(state.chapterInfos) ? state.chapterInfos.length : 0;
      diag.stateBookInfo = state.bookInfo ? { title: state.bookInfo.title, author: state.bookInfo.author } : null;
    }

    // 2. 全局变量扫描
    diag.globalCandidates = {};
    var globalNames = ['book', 'reader', '__wereadReader', '__WEREAD_READER__', '__VUE_APP__', '__vue_app__'];
    globalNames.forEach(function (name) {
      var val = window[name];
      diag.globalCandidates[name] = val ? typeof val : 'undefined';
    });

    // 3. findReaderVm 详细过程
    diag.findReaderVmSteps = [];

    // 直接候选
    var directCandidates = [window.book, window.reader, window.__wereadReader, window.__WEREAD_READER__];
    directCandidates.forEach(function (c, i) {
      diag.findReaderVmSteps.push('direct[' + i + ']=' + (c ? typeof c : 'null'));
      if (c) {
        var unwrapped = c.proxy || c.ctx || c;
        diag.findReaderVmSteps.push('direct[' + i + '].unwrapped=' + typeof unwrapped);
        diag.findReaderVmSteps.push('direct[' + i + '].isReaderVm=' + isReaderVm(unwrapped));
        if (isReaderVm(unwrapped)) {
          diag.findReaderVmSteps.push('direct[' + i + '].chapterUid=' + (unwrapped.chapterUid || unwrapped.currentChapter?.chapterUid || ''));
        }
      }
    });

    // 选择器扫描
    var selectors = ['div.readerContent.routerView', '.readerContent.routerView', '.readerContent', '[class*="readerContent"]', '[class*="Reader"]'];
    selectors.forEach(function (sel) {
      var els = document.querySelectorAll(sel);
      diag.findReaderVmSteps.push('selector "' + sel + '" count=' + els.length);
      els.forEach(function (el, i) {
        if (el.__vue__) {
          diag.findReaderVmSteps.push('  el[' + i + '].__vue__ found');
        } else if (el.__vueParentComponent) {
          diag.findReaderVmSteps.push('  el[' + i + '].__vueParentComponent found');
        } else {
          diag.findReaderVmSteps.push('  el[' + i + '] no vue');
        }
      });
    });

    // 4. Vue 实例深度扫描（前200个元素）
    var vueElements = [];
    var allEls = document.querySelectorAll('*');
    for (var ei = 0; ei < allEls.length && ei < 2000; ei++) {
      if (allEls[ei].__vue__ || allEls[ei].__vueParentComponent) {
        vueElements.push(allEls[ei].tagName + '.' + (allEls[ei].className || '').toString().slice(0, 40));
      }
    }
    diag.vueElementCount = vueElements.length;
    diag.vueElementSamples = vueElements.slice(0, 10);

    // 5. 网络缓存
    diag.networkCacheCount = chapterResponseCache.length;
    diag.networkCacheSamples = chapterResponseCache.slice(0, 3).map(function (c) {
      return { source: c.source, chars: (c.html || c.text || '').length, chapterUid: c.chapterUid };
    });

    // 6. 当前 URL
    diag.currentUrl = location.href;

    // 7. __INITIAL_STATE__.reader 深度检查
    if (state && state.reader) {
      var readerKeys = Object.keys(state.reader);
      diag.readerDeep = {
        keys: readerKeys,
        keyCount: readerKeys.length
      };
      // 逐个检查关键 key 的值
      readerKeys.forEach(function (k) {
        var v = state.reader[k];
        var t = typeof v;
        if (t === 'function') return;
        if (t === 'object' && v !== null) {
          if (Array.isArray(v)) {
            diag.readerDeep['reader.' + k] = 'Array[' + v.length + ']';
          } else {
            diag.readerDeep['reader.' + k] = 'Object{' + Object.keys(v).slice(0, 15).join(',') + '}';
          }
        } else {
          diag.readerDeep['reader.' + k] = String(v).slice(0, 100);
        }
      });
    }

    // 8. React Fiber 扫描
    diag.reactFiber = {};
    var reactRoot = document.getElementById('root') || document.getElementById('app');
    if (reactRoot) {
      diag.reactFiber.rootId = reactRoot.id;
      var fiberKeys = Object.keys(reactRoot).filter(function (k) {
        return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance');
      });
      diag.reactFiber.fiberKeysOnRoot = fiberKeys;
    }
    // 扫描前100个元素寻找 React fiber
    var reactElements = [];
    var sampleEls = document.querySelectorAll('*');
    for (var ri = 0; ri < sampleEls.length && ri < 100; ri++) {
      var elKeys = Object.keys(sampleEls[ri]);
      var fKeys = elKeys.filter(function (k) {
        return k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance') || k.startsWith('__reactEvents');
      });
      if (fKeys.length > 0) {
        reactElements.push({
          tag: sampleEls[ri].tagName,
          cls: (sampleEls[ri].className || '').toString().slice(0, 60),
          fiberKeys: fKeys
        });
      }
    }
    diag.reactFiber.elementsWithFiber = reactElements.length;
    diag.reactFiber.fiberSamples = reactElements.slice(0, 5);
    try {
      diag.reactFiber.deep = collectReactFiberDiagnostics();
    } catch (e) {
      diag.reactFiber.deepError = e.message;
    }

    // 9. 全局 window 属性扫描（找 reader/book/chapter 相关）
    diag.globalScan = {};
    var interestingWords = ['reader', 'book', 'chapter', 'weread', 'content', 'page', 'render'];
    try {
      var ownKeys = Object.getOwnPropertyNames(window);
      interestingWords.forEach(function (word) {
        var matches = ownKeys.filter(function (k) {
          return k.toLowerCase().indexOf(word) !== -1;
        });
        if (matches.length > 0) {
          diag.globalScan[word] = matches.slice(0, 20);
        }
      });
    } catch (e) {
      diag.globalScanError = e.message;
    }

    // 9.1 Store / DevTools / 模块运行时探测
    try {
      diag.storeScan = collectStoreDiagnostics();
    } catch (e) {
      diag.storeScanError = e.message;
    }
    try {
      diag.moduleRuntime = collectModuleRuntimeDiagnostics();
    } catch (e) {
      diag.moduleRuntimeError = e.message;
    }

    // 9.2 webpack 模块深度探测
    try {
      diag.webpackExplore = exploreWebpackModules();
    } catch (e) {
      diag.webpackExploreError = e.message;
    }

    // 10. DOM 结构分析
    diag.domStructure = {};
    // Canvas 信息
    var canvases = document.querySelectorAll('canvas');
    diag.domStructure.canvasCount = canvases.length;
    canvases.forEach(function (c, i) {
      diag.domStructure['canvas' + i] = {
        width: c.width,
        height: c.height,
        offsetW: c.offsetWidth,
        offsetH: c.offsetHeight
      };
    });
    // readerContent 子元素
    var rc = document.querySelector('.readerContent') || document.querySelector('[class*="readerContent"]');
    if (rc) {
      diag.domStructure.readerContentChildren = rc.children.length;
      var childInfo = [];
      for (var ci = 0; ci < rc.children.length && ci < 20; ci++) {
        childInfo.push({
          tag: rc.children[ci].tagName,
          cls: (rc.children[ci].className || '').toString().slice(0, 80),
          childCount: rc.children[ci].children.length
        });
      }
      diag.domStructure.readerContentChildSamples = childInfo;
    }
    // 检查是否有 React root
    var appEl = document.querySelector('#root') || document.querySelector('#app');
    diag.domStructure.hasRootApp = !!appEl;
    diag.domStructure.rootAppId = appEl ? appEl.id : 'none';

    // 11. 章节内容 DOM 搜索 — 从 webpack 模块发现的 CSS 类名
    diag.chapterDomSearch = {};
    var chapterSelectors = [
      '.chapterContent_p',
      '.readerChapterContent',
      '[class*="chapterContent"]',
      '[class*="ChapterContent"]',
      '[class*="chapter_content"]',
      '.readerContent .app_content',
      '.readerContent .app_content > div',
      '.wr_readerContent',
      '[data-wr-co]',
      '.readerChapterContent_container',
      '[class*="readerChapter"]'
    ];
    chapterSelectors.forEach(function (sel) {
      try {
        var els = document.querySelectorAll(sel);
        if (els.length > 0) {
          diag.chapterDomSearch[sel] = {
            count: els.length,
            samples: []
          };
          for (var j = 0; j < els.length && j < 3; j++) {
            var el = els[j];
            diag.chapterDomSearch[sel].samples.push({
              tag: el.tagName,
              text: (el.textContent || '').slice(0, 200),
              html: (el.innerHTML || '').slice(0, 300),
              visible: el.offsetWidth > 0 || el.offsetHeight > 0,
              display: getComputedStyle(el).display,
              visibility: getComputedStyle(el).visibility
            });
          }
        }
      } catch (e) {}
    });

    // 12. Vue 3 实例探测（扩展扫描范围）
    diag.vue3Scan = {};
    var appEl2 = document.querySelector('#app');
    if (appEl2) {
      var appKeys = Object.keys(appEl2);
      diag.vue3Scan.appElementKeys = appKeys.filter(function (k) {
        return k.startsWith('__') || k.startsWith('_');
      });
      diag.vue3Scan.allAppKeys = appKeys.slice(0, 30);
      // Vue 3 app 实例通常挂在 _instance 或 __vue_app__
      if (appEl2.__vue_app__) {
        diag.vue3Scan.hasVueApp = true;
        diag.vue3Scan.vueAppConfig = Object.keys(appEl2.__vue_app__);
      }
      if (appEl2._instance) {
        diag.vue3Scan.hasInstance = true;
      }
    }
    // 扫描 app_content 的 Vue 3 属性
    var appContent = document.querySelector('.app_content');
    if (appContent) {
      var acKeys = Object.keys(appContent);
      diag.vue3Scan.appContentPrivateKeys = acKeys.filter(function (k) {
        return k.startsWith('__') || k.startsWith('_');
      });
    }
    // 扫描所有带 __vue 前缀属性的元素
    var vueMarkers = [];
    var allEls2 = document.querySelectorAll('*');
    for (var vi = 0; vi < allEls2.length && vi < 2000; vi++) {
      var ek = Object.keys(allEls2[vi]);
      var vm = ek.filter(function (k) { return k.indexOf('vue') !== -1 || k.indexOf('Vue') !== -1; });
      if (vm.length > 0) {
        vueMarkers.push({ tag: allEls2[vi].tagName, cls: (allEls2[vi].className || '').toString().slice(0, 50), keys: vm });
      }
    }
    diag.vue3Scan.vueMarkers = vueMarkers.slice(0, 10);

    console.log('[WereadExtractor][DIAGNOSIS] ' + JSON.stringify(diag, null, 2));
    return diag;
  }

  // ── 消息桥接 ──

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
        count: result.count,
        batches: result.batches,
        deadCount: result.deadCount,
        totalCaptured: result.totalCaptured
      }, '*');
    }

    if (event.data.type === 'WEREAD_REQ_CHAPTER_CONTENT') {
      getFullChapterContent(event.data).then(function (result) {
        window.postMessage({
          type: 'WEREAD_CHAPTER_CONTENT',
          requestId: event.data.requestId,
          ...result
        }, '*');
      });
    }

    if (event.data.type === 'WEREAD_REQ_DIAGNOSIS') {
      var diag = runDiagnosis();
      window.postMessage({
        type: 'WEREAD_DIAGNOSIS',
        requestId: event.data.requestId,
        diagnosis: diag
      }, '*');
    }
  });

  window.__wereadDiagnose = runDiagnosis;

  installOffscreenCanvasHook();
  installCanvasHook();
  installNetworkHook();
})();
