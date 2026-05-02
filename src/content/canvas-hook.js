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
    const snapshot = captured.filter(function(item) { return !item.dead; });
    const sorted = snapshot.sort(function (a, b) {
      return a.b - b.b || a.y - b.y || a.x - b.x;
    });

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

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const parts = dedupeLineParts(line.parts);
      parts.sort(function (a, b) {
        return a.x - b.x;
      });

      const text = parts.map(function (part) {
        return part.t;
      }).join('');

      if (emitted.has(text)) continue;
      emitted.add(text);

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

    return {
      raw: sorted,
      text: result.join('\n'),
      count: sorted.length
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
            return function (x, y, width, height) {
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
        count: result.count
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
  });

  installCanvasHook();
  installNetworkHook();
})();
