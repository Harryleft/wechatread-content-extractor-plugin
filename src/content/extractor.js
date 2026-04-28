/**
 * WereadExtract - 内容提取核心模块
 *
 * 整章走页面阅读器/章节接口，可见内容走选区或 Canvas 已绘制文本
 */

/* eslint-disable no-undef */

class WereadExtractor {
  constructor() {
    this._state = null;
    this._statePromise = null;
  }

  // ── 页面状态 ──

  async getPageState() {
    if (this._state) return this._state;
    if (this._statePromise) return this._statePromise;

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

  async extractChapter() {
    const meta = await this.getBookMeta();
    const chapterResult = await this._extractFullChapterContent(meta);
    const content = chapterResult.rawContent || '';
    const method = chapterResult.source || 'full-chapter';

    if (!content) {
      return {
        success: false,
        error: chapterResult.error || '无法获取完整章节内容。请刷新阅读页后重试。',
        meta
      };
    }

    if (chapterResult.title && !meta.chapterTitle) meta.chapterTitle = chapterResult.title;
    if (chapterResult.chapterUid && !meta.chapterUid) meta.chapterUid = chapterResult.chapterUid;

    const formatted = this._toMarkdown(content, meta);
    return {
      success: true,
      content: formatted,
      rawContent: content,
      meta,
      format: 'markdown',
      method,
      charCount: formatted.length,
      wordCount: content.replace(/\s/g, '').length
    };
  }

  async extractVisible() {
    const meta = await this.getBookMeta();

    // 优先用选区
    const selection = this._extractSelection();
    let content = selection || '';
    let method = selection ? 'selection' : '';

    // 其次用 Canvas Hook
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
      method,
      charCount: formatted.length,
      wordCount: content.replace(/\s/g, '').length
    };
  }

  // ── 提取策略 ──

  _requestPageBridge(requestType, responseType, timeout = 2000, payload = {}) {
    return new Promise((resolve) => {
      const requestId = `weread-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let settled = false;

      const finish = (payload) => {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', handler);
        clearTimeout(timer);
        resolve(payload);
      };

      const handler = (event) => {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.type !== responseType || data.requestId !== requestId) return;
        finish(data);
      };

      const timer = setTimeout(() => finish(null), timeout);
      window.addEventListener('message', handler);
      window.postMessage({ ...payload, type: requestType, requestId }, '*');
    });
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

  async _extractFromCanvas() {
    try {
      const result = await this._requestPageBridge('WEREAD_REQ_CANVAS', 'WEREAD_CANVAS_DATA');
      if (result && result.text && result.text.trim().length > 0) {
        return result.text.trim();
      }
    } catch (e) {
      console.warn('[WereadExtract] Canvas hook 提取失败:', e);
    }
    return '';
  }

  _extractSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return '';
    return sel.toString().trim();
  }

  _normalizeChapterPayload(payload) {
    if (typeof payload === 'string') {
      return {
        rawContent: this._normalizePlainText(payload),
        source: 'full-chapter'
      };
    }

    const html = payload?.html || '';
    const text = payload?.text || '';
    const rawContent = text
      ? this._normalizePlainText(text)
      : this._htmlToText(html);

    return {
      rawContent,
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
        node.appendChild(document.createTextNode('\n\n'));
      });

    return this._normalizePlainText(container.textContent || '');
  }

  _normalizePlainText(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ── 格式化 ──

  _toMarkdown(content, meta) {
    let md = '';
    if (meta.title) {
      md += `# ${meta.title}`;
      if (meta.author) md += ` - ${meta.author}`;
      md += '\n\n';
    }
    if (meta.chapterTitle) md += `## ${meta.chapterTitle}\n\n`;
    md += content;
    md += '\n\n---\n';
    md += `> 提取自微信读书 · ${new Date().toLocaleString('zh-CN')}`;
    return md;
  }
}

window.__wereadExtractor = new WereadExtractor();
