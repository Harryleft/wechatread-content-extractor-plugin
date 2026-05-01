/**
 * WereadExtract - 内容提取核心模块
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
      meta.bookId = state.bookId || state.reader?.bookId || '';
      if (state.bookInfo) {
        meta.title = state.bookInfo.title || '';
        meta.author = state.bookInfo.author || '';
      }
      const currentChapter = state.currentChapter || {};
      meta.chapterUid = currentChapter.chapterUid || state.reader?.chapterUid || '';
      meta.chapterIndex = currentChapter.chapterIdx ?? -1;
      meta.chapterTitle = currentChapter.title || '';

      if (!meta.chapterTitle && meta.chapterUid && Array.isArray(state.chapterInfos)) {
        const matched = state.chapterInfos.find((chapter) => {
          return String(chapter.chapterUid) === String(meta.chapterUid);
        });
        if (matched?.title) meta.chapterTitle = matched.title;
      }
    }

    // 仅作为标题兜底，不参与正文提取。
    const chapterEl = document.querySelector('.readerTopBar_title_chapter')
                   || document.querySelector('.chapterItem.chapterItem_current');
    if (!meta.chapterTitle && chapterEl) {
      meta.chapterTitle = chapterEl.textContent.replace(/^\s*|\s*$/, '');
    }

    return meta;
  }

  // ── 提取入口 ──

  async extractVisible() {
    if (this._extracting) {
      return { success: false, error: '提取进行中，请稍后重试。', meta: null };
    }
    this._extracting = true;
    try {
      const meta = await this.getBookMeta();
      const chapterResult = await this._extractFullChapterContent(meta);
      let content = chapterResult.rawContent || '';
      let method = chapterResult.source || '';

      if (content) {
        if (chapterResult.title && !meta.chapterTitle) meta.chapterTitle = chapterResult.title;
        if (chapterResult.chapterUid && !meta.chapterUid) meta.chapterUid = chapterResult.chapterUid;
      }

      if (!content) {
        const canvasText = await this._extractFromCanvas();
        if (canvasText && canvasText.length > 20) {
          content = canvasText;
          method = 'canvas-hook';
        }
      }

      if (!content) {
        return { success: false, error: '当前页面无可提取内容。', meta };
      }

      const formatted = this._toMarkdown(content, meta);
      return {
        success: true,
        content: formatted,
        rawContent: content,
        meta,
        format: 'markdown',
        method: method || 'full-chapter',
        charCount: formatted.length,
        wordCount: content.replace(/\s/g, '').length
      };
    } finally {
      this._extracting = false;
    }
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
      if (result && result.text && result.text.trim().length > 0) {
        return this._normalizePlainText(result.text.trim());
      }
    } catch (e) {
      console.warn('[WereadExtract] Canvas hook 提取失败:', e);
    }
    return '';
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
        return {
          rawContent: '',
          error: result?.error || '页面没有返回完整章节内容。'
        };
      }

      const normalized = this._normalizeChapterPayload(result.content);
      return {
        ...normalized,
        error: normalized.rawContent ? '' : '完整章节响应为空。'
      };
    } catch (e) {
      console.warn('[WereadExtract] 完整章节提取失败:', e);
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
}

window.__wereadExtractor = new WereadExtractor();
