/**
 * WereadExtractor - 内容提取核心模块
 *
 * 优先通过 MAIN world 获取完整章节内容。
 * 完整章节不可用时，再使用 Canvas fillText() 捕获文本作为兜底。
 */

/* eslint-disable no-undef */

class WereadExtractor {
  constructor() {
    this._state = null;
    this._statePromise = null;
    this._lastStateUrl = null;
    this._extracting = false;
    this._debugEnabled = true;
  }

  // ── 页面状态 ──

  async getPageState() {
    if (this._state && location.href === this._lastStateUrl) return this._state;
    if (this._statePromise && location.href === this._lastStateUrl) return this._statePromise;

    this._lastStateUrl = location.href;
    this._state = null;
    this._statePromise = this._requestPageBridge('WEREAD_REQ_STATE', 'WEREAD_STATE', 3000)
      .then((response) => {
        this._state = response?.data || null;
        return this._state;
      });

    return this._statePromise;
  }

  // ── 元数据 ──

  async getBookMeta() {
    const state = await this.getPageState();
    const meta = {
      title: '',
      author: '',
      bookId: '',
      chapterTitle: '',
      chapterUid: '',
      chapterIndex: -1,
      isCanvasMode: false
    };

    // 检测 Canvas 模式
    const canvases = document.querySelectorAll('canvas');
    if (canvases.length > 0) {
      const visibleCanvas = Array.from(canvases).find(c => c.offsetWidth > 100 && c.offsetHeight > 100);
      if (visibleCanvas) {
        meta.isCanvasMode = true;
      }
    }

    if (state) {
      const reader = state.reader || {};
      const bookInfo = state.bookInfo || reader.bookInfo || {};
      const currentChapter = reader.currentChapter || state.currentChapter || {};

      meta.bookId = state.bookId || reader.bookId || bookInfo.bookId || '';
      if (bookInfo) {
        meta.title = bookInfo.title || '';
        meta.author = bookInfo.author || '';
      }
      meta.chapterUid = currentChapter.chapterUid || reader.chapterUid || '';
      meta.chapterIndex = currentChapter.chapterIdx ?? -1;
      meta.chapterTitle = currentChapter.title || '';

      const chapterInfos = state.chapterInfos || reader.chapterInfos || [];
      if (!meta.chapterTitle && meta.chapterUid && Array.isArray(chapterInfos)) {
        const matched = chapterInfos.find((chapter) => {
          return String(chapter.chapterUid) === String(meta.chapterUid);
        });
        if (matched?.title) meta.chapterTitle = matched.title;
      }

      this._resolveChapterMetaFromInfos(meta, chapterInfos);
    }

    // 仅作为标题兜底，不参与正文提取。
    const chapterEl = document.querySelector('.readerTopBar_title_chapter')
                   || document.querySelector('.chapterItem.chapterItem_current');
    if (!meta.chapterTitle && chapterEl) {
      meta.chapterTitle = chapterEl.textContent.replace(/^\s*|\s*$/, '');
    }

    if (state) {
      this._resolveChapterMetaFromInfos(meta, state.chapterInfos || state.reader?.chapterInfos);
    }

    return meta;
  }

  _resolveChapterMetaFromInfos(meta, chapterInfos) {
    if (!Array.isArray(chapterInfos) || chapterInfos.length === 0) return;
    if (meta.chapterUid && meta.chapterTitle) return;

    const byIndex = meta.chapterIndex >= 0
      ? chapterInfos.find((chapter) => {
        return Number(chapter.chapterIdx) === Number(meta.chapterIndex);
      })
      : null;
    const byTitle = this._findUniqueChapterByTitle(chapterInfos, meta.chapterTitle);
    const matched = byIndex || byTitle;

    if (!matched) return;
    if (!meta.chapterUid && matched.chapterUid) meta.chapterUid = String(matched.chapterUid);
    if (!meta.chapterTitle && matched.title) meta.chapterTitle = matched.title;
    if (meta.chapterIndex < 0 && matched.chapterIdx != null) meta.chapterIndex = matched.chapterIdx;
  }

  _findUniqueChapterByTitle(chapterInfos, title) {
    const normalizedTitle = this._normalizeTitle(title);
    if (!normalizedTitle) return null;

    const matched = chapterInfos.filter((chapter) => {
      return this._normalizeTitle(chapter.title) === normalizedTitle;
    });

    return matched.length === 1 ? matched[0] : null;
  }

  _normalizeTitle(title) {
    return String(title || '').replace(/\s+/g, ' ').trim();
  }

  // ── 提取入口 ──

  async extractVisible() {
    if (this._extracting) {
      return { success: false, error: '提取进行中，请稍后重试。', meta: null };
    }
    this._extracting = true;
    try {
      const meta = await this.getBookMeta();
      this._debug('extract-start', {
        bookId: meta.bookId,
        chapterUid: meta.chapterUid,
        chapterTitle: meta.chapterTitle,
        isCanvasMode: meta.isCanvasMode
      });

      const chapterResult = await this._extractFullChapterContent(meta);
      let content = chapterResult.rawContent || '';
      let method = chapterResult.source || '';
      this._debug('full-chapter-result', {
        ok: Boolean(content),
        source: chapterResult.source || '',
        error: chapterResult.error || '',
        chars: content.length,
        chapterUid: chapterResult.chapterUid || ''
      });

      if (content) {
        if (chapterResult.title && !meta.chapterTitle) meta.chapterTitle = chapterResult.title;
        if (chapterResult.chapterUid && !meta.chapterUid) meta.chapterUid = chapterResult.chapterUid;
      }

      // Canvas 兜底：当完整章节路径失败或内容偏短时，尝试 Canvas 累积数据
      const canvasResult = await this._extractFromCanvas();
      let canvasBatches = canvasResult ? canvasResult.batches : 0;
      this._debug('canvas-result', {
        ok: Boolean(canvasResult && canvasResult.text && canvasResult.text.length > 20),
        chars: canvasResult ? canvasResult.text.length : 0,
        batches: canvasBatches
      });
      if (canvasResult && canvasResult.text && canvasResult.text.length > 20) {
        if (!content || canvasResult.text.length > content.length) {
          content = canvasResult.text;
          method = 'canvas-hook';
        }
      }

      if (!content) {
        this._debug('extract-empty', {
          bookId: meta.bookId,
          chapterUid: meta.chapterUid
        });
        return { success: false, error: '当前页面无可提取内容。', meta };
      }

      const formatted = this._toMarkdown(content, meta);
      this._debug('extract-complete', {
        method: method || 'full-chapter',
        rawChars: content.length,
        formattedChars: formatted.length,
        wordCount: content.replace(/\s/g, '').length
      });
      return {
        success: true,
        content: formatted,
        rawContent: content,
        meta,
        format: 'markdown',
        method: method || 'full-chapter',
        charCount: formatted.length,
        wordCount: content.replace(/\s/g, '').length,
        canvasBatches: canvasBatches
      };
    } finally {
      this._extracting = false;
    }
  }

  // ── 诊断 ──

  async diagnose() {
    return this._requestPageBridge('WEREAD_REQ_DIAGNOSIS', 'WEREAD_DIAGNOSIS', 5000);
  }

  // ── Canvas Hook 文本提取 ──

  _requestPageBridge(requestType, responseType, timeout = 5000, payload = {}) {
    return new Promise((resolve) => {
      const requestId = `weread-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let settled = false;
      let graceTimer = null;

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', handler);
        clearTimeout(timer);
        clearTimeout(graceTimer);
        resolve(payload);
      };

      const handler = (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.type !== responseType || data.requestId !== requestId) return;
        finish(data);
      };

      const timer = setTimeout(() => {
        // Grace period: keep listener alive for another 3s before giving up
        graceTimer = setTimeout(() => finish(null), 3000);
      }, timeout);
      window.addEventListener('message', handler);
      window.postMessage({ ...payload, type: requestType, requestId }, '*');
    });
  }

  async _extractFromCanvas() {
    try {
      const result = await this._requestPageBridge('WEREAD_REQ_CANVAS', 'WEREAD_CANVAS_DATA');
      this._debug('canvas-bridge-response', {
        ok: Boolean(result && result.text),
        chars: result?.text ? result.text.length : 0,
        count: result?.count ?? 0,
        batches: result?.batches ?? 0,
        deadCount: result?.deadCount ?? 0,
        totalCaptured: result?.totalCaptured ?? 0,
        strokeText: result?.strokeTextCount ?? 0,
        domImgs: result?.domImgCount ?? 0,
        domTextBlocks: result?.domTextBlocks ?? 0,
        domTextChars: result?.domTextChars ?? 0
      });
      if (result && result.text && result.text.trim().length > 0) {
        return {
          text: this._normalizePlainText(result.text.trim()),
          batches: result.batches || 0,
          totalCaptured: result.totalCaptured || 0,
          deadCount: result.deadCount || 0
        };
      }
    } catch (e) {
      console.warn('[WereadExtractor] Canvas hook 提取失败:', e);
    }
    return null;
  }

  async _extractFullChapterContent(meta) {
    try {
      const result = await this._requestPageBridge(
        'WEREAD_REQ_CHAPTER_CONTENT',
        'WEREAD_CHAPTER_CONTENT',
        6000,
        {
          bookId: meta.bookId,
          chapterUid: meta.chapterUid
        }
      );

      if (!result?.success || !result.content) {
        this._debug('full-chapter-bridge-empty', {
          success: Boolean(result?.success),
          error: result?.error || '页面没有返回完整章节内容。'
        });
        return {
          rawContent: '',
          error: result?.error || '页面没有返回完整章节内容。'
        };
      }

      const normalized = this._normalizeChapterPayload(result.content);
      this._debug('full-chapter-bridge-response', {
        source: normalized.source,
        chars: normalized.rawContent.length,
        chapterUid: normalized.chapterUid || ''
      });
      return {
        ...normalized,
        error: normalized.rawContent ? '' : '完整章节响应为空。'
      };
    } catch (e) {
      console.warn('[WereadExtractor] 完整章节提取失败:', e);
      return {
        rawContent: '',
        error: '完整章节提取失败: ' + e.message
      };
    }
  }

  _normalizeChapterPayload(payload) {
    if (typeof payload === 'string') {
      return {
        rawContent: this._normalizePlainText(payload),
        source: 'full-chapter'
      };
    }

    const rawContent = payload?.rawContent
      || payload?.text
      || this._htmlToText(payload?.html || '');

    return {
      rawContent: this._normalizePlainText(rawContent),
      title: payload?.title || '',
      chapterUid: payload?.chapterUid || '',
      source: payload?.source || 'full-chapter'
    };
  }

  _htmlToText(html) {
    if (!html) return '';

    const container = document.createElement('div');
    container.innerHTML = html;
    container.querySelectorAll('script, style, noscript').forEach((node) => node.remove());
    container.querySelectorAll('br').forEach((node) => node.replaceWith('\n'));
    container.querySelectorAll('p, div, section, article, li, blockquote, pre, h1, h2, h3, h4, h5, h6')
      .forEach((node) => {
        node.appendChild(document.createTextNode('\n'));
      });

    return this._normalizePlainText(container.textContent || '');
  }

  _normalizePlainText(text) {
    return String(text || '')
      .replace(/ /g, ' ')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ── 格式化 ──

  _toMarkdown(content, meta) {
    var markdown = '';
    if (meta.title) {
      markdown += '# ' + meta.title;
      if (meta.author) markdown += ' - ' + meta.author;
      markdown += '\n\n';
    }
    // 去掉内容中 Canvas 渲染已带有的章节标题（字号大被转为 ##），避免重复
    let body = content;
    if (meta.chapterTitle) {
      const esc = meta.chapterTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      body = body.replace(new RegExp('^## ' + esc + '\\n*'), '')
                 .replace(new RegExp('^### ' + esc + '\\n*'), '');
    }
    if (meta.chapterTitle) markdown += '## ' + meta.chapterTitle + '\n\n';
    markdown += body;
    markdown += '\n\n---\n';
    markdown += '> 提取自微信读书 · ' + new Date().toLocaleString('zh-CN');
    return markdown;
  }

  buildPrompt(markdownContent, templateText) {
    if (!templateText) return markdownContent;
    return templateText.replace(/\{\{content\}\}/g, markdownContent);
  }

  _debug(event, data = {}) {
    if (!this._debugEnabled) return;
    if (typeof console === 'undefined' || typeof console.log !== 'function') return;

    try {
      console.log('[debug]:' + JSON.stringify({
        event,
        ...this._sanitizeDebugData(data)
      }));
    } catch (e) {
      console.log('[debug]:' + event);
    }
  }

  _sanitizeDebugData(data) {
    const safe = {};
    Object.keys(data || {}).forEach((key) => {
      const value = data[key];
      if (typeof value === 'string') {
        safe[key] = value.length > 120 ? value.slice(0, 120) + '...' : value;
        return;
      }
      safe[key] = value;
    });
    return safe;
  }
}

window.__wereadExtractor = new WereadExtractor();
