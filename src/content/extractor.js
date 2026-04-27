/**
 * WereadExtract - 内容提取核心模块
 *
 * 多策略提取：用户选区 → DOM → 页面状态 → 可见文本
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

    this._statePromise = new Promise((resolve) => {
      const handler = (event) => {
        if (event.data?.type === 'WEREAD_STATE') {
          this._state = event.data.data;
          window.removeEventListener('message', handler);
          resolve(this._state);
        }
      };
      window.addEventListener('message', handler);

      const script = document.createElement('script');
      script.textContent = `
        (function() {
          try {
            var state = window.__INITIAL_STATE__;
            if (state) {
              var data = {
                bookId: state.bookId || '',
                bookInfo: state.bookInfo || {},
                chapterInfos: (state.chapterInfos || []).map(function(c) {
                  return { title: c.title, level: c.level, chapterUid: c.chapterUid };
                }),
                currentChapter: state.currentChapter || {},
                reader: state.reader ? {
                  bookVersion: state.reader.bookVersion,
                  chapterUid: state.reader.chapterUid,
                  bookId: state.reader.bookId
                } : {}
              };
              window.postMessage({ type: 'WEREAD_STATE', data: data }, '*');
            } else {
              window.postMessage({ type: 'WEREAD_STATE', data: null }, '*');
            }
          } catch(e) {
            window.postMessage({ type: 'WEREAD_STATE', data: null }, '*');
          }
        })();
      `;
      document.documentElement.appendChild(script);
      script.remove();

      setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(null);
      }, 3000);
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
    }

    // DOM 章节标题（和 wereader 一致的选择器）
    const chapterEl = document.querySelector('.readerTopBar_title_chapter')
                   || document.querySelector('.chapterItem.chapterItem_current');
    if (chapterEl) {
      meta.chapterTitle = chapterEl.textContent.replace(/^\s*|\s*$/, '');
    }

    return meta;
  }

  // ── 提取入口 ──

  async extractChapter(format = 'markdown') {
    const meta = await this.getBookMeta();
    let content = '';
    let method = '';

    // 策略 0: 用户手动选区
    const selection = this._extractSelection();
    if (selection) {
      content = selection;
      method = 'selection';
    }

    // 策略 1: DOM 提取
    if (!content) {
      content = this._extractFromDOM();
      if (content) method = 'dom';
    }

    // 策略 2: pre 元素
    if (!content || content.length < 50) {
      const preContent = this._extractFromPreElements();
      if (preContent && preContent.length > content.length) {
        content = preContent;
        method = 'pre-elements';
      }
    }

    // 策略 3: 全部可见文本
    if (!content || content.length < 50) {
      content = this._extractVisibleText();
      if (content) method = 'visible-text';
    }

    if (!content) {
      const canvasHint = meta.isCanvasMode
        ? ' 当前为 Canvas 渲染模式，请在阅读器设置中切换为竖排模式后重试。'
        : '';
      return {
        success: false,
        error: '无法提取内容。请确认当前页面是微信读书阅读页。' + canvasHint,
        meta
      };
    }

    const formatted = this._format(content, format, meta);
    return {
      success: true,
      content: formatted,
      rawContent: content,
      meta,
      format,
      method,
      charCount: formatted.length,
      wordCount: content.replace(/\s/g, '').length
    };
  }

  async extractVisible(format = 'markdown') {
    const meta = await this.getBookMeta();

    // 优先用选区
    const selection = this._extractSelection();
    const content = selection || this._extractVisibleText();

    if (!content) {
      return { success: false, error: '当前页面无可提取内容。', meta };
    }

    const formatted = this._format(content, format, meta);
    return {
      success: true,
      content: formatted,
      rawContent: content,
      meta,
      format,
      method: selection ? 'selection' : 'visible-text',
      charCount: formatted.length,
      wordCount: content.replace(/\s/g, '').length
    };
  }

  // ── 提取策略 ──

  _extractSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return '';
    return sel.toString().trim();
  }

  _extractFromDOM() {
    const selectors = [
      '.readerChapterContent',
      '.passage-content',
      '#renderTargetContent',
      '.readerContent',
      '.app_reader_content'
    ];

    for (const selector of selectors) {
      const container = document.querySelector(selector);
      if (container) {
        const text = container.innerText?.trim();
        if (text && text.length > 50) return text;
      }
    }
    return '';
  }

  _extractFromPreElements() {
    const pres = document.querySelectorAll(
      '.readerChapterContent pre, .passage-content pre, #renderTargetContent pre, .readerContent pre'
    );
    if (pres.length === 0) return '';

    const parts = [];
    pres.forEach((pre) => {
      const text = pre.innerText?.trim();
      if (text) parts.push(text);
    });
    return parts.join('\n\n');
  }

  _extractVisibleText() {
    // 尝试阅读区域
    const selectors = '.readerContent, .app_reader_content, #renderTargetContent, .readerChapterContent';
    const contentArea = document.querySelector(selectors);

    if (contentArea) {
      // TreeWalker 获取所有文本节点
      const walker = document.createTreeWalker(contentArea, NodeFilter.SHOW_TEXT, null);
      const parts = [];
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.trim();
        if (text && text.length > 0) parts.push(text);
      }
      if (parts.length > 0) return parts.join('\n');
    }

    // 最后兜底：阅读容器 innerText
    const fallback = document.querySelector('.readerContent')
                  || document.querySelector('.readerChapterContent');
    if (fallback) return fallback.innerText?.trim() || '';

    return '';
  }

  // ── 格式化 ──

  _format(content, format, meta) {
    switch (format) {
      case 'markdown': return this._toMarkdown(content, meta);
      case 'html': return this._toHTML(content, meta);
      default: return this._toPlainText(content, meta);
    }
  }

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

  _toHTML(content, meta) {
    let html = '';
    if (meta.title) {
      html += `<h1>${this._esc(meta.title)}`;
      if (meta.author) html += ` - ${this._esc(meta.author)}`;
      html += '</h1>\n';
    }
    if (meta.chapterTitle) html += `<h2>${this._esc(meta.chapterTitle)}</h2>\n`;
    content.split(/\n\n+/).forEach((p) => {
      const t = p.trim();
      if (t) html += `<p>${this._esc(t)}</p>\n`;
    });
    html += `<hr><p><em>提取自微信读书 · ${new Date().toLocaleString('zh-CN')}</em></p>`;
    return html;
  }

  _toPlainText(content, meta) {
    let text = '';
    if (meta.title) {
      text += meta.title;
      if (meta.author) text += ` - ${meta.author}`;
      text += '\n\n';
    }
    if (meta.chapterTitle) text += meta.chapterTitle + '\n\n';
    text += content;
    text += '\n\n---\n提取自微信读书 · ' + new Date().toLocaleString('zh-CN');
    return text;
  }

  _esc(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

window.__wereadExtractor = new WereadExtractor();
