/**
 * WereadExtract - 内容提取核心模块
 *
 * 微信读书通过 Canvas fillText() 渲染正文，DOM 中不存在可读文本。
 * 通过 postMessage 桥接与 MAIN world 的 canvas-hook.js 通信，获取 fillText 截获的文本。
 */

/* eslint-disable no-undef */

class WereadExtractor {
  constructor() {
    this._state = null;
    this._statePromise = null;
    this._lastStateUrl = null;
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
    const meta = await this.getBookMeta();
    const content = await this._extractFromCanvas();

    if (!content || content.length <= 20) {
      return { success: false, error: '当前页面无可提取内容。', meta };
    }

    const formatted = this._toMarkdown(content, meta);
    return {
      success: true,
      content: formatted,
      copyContent: this._buildReadingPrompt(formatted),
      rawContent: content,
      meta,
      format: 'markdown',
      charCount: formatted.length,
      wordCount: content.replace(/\s/g, '').length
    };
  }

  // ── Canvas Hook 文本提取 ──

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
    let md = '';
    if (meta.title) {
      md += `# ${meta.title}`;
      if (meta.author) md += ` - ${meta.author}`;
      md += '\n\n';
    }
    // 去掉内容中 Canvas 渲染已带有的章节标题（字号大被转为 ##），避免重复
    let body = content;
    if (meta.chapterTitle) {
      const esc = meta.chapterTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      body = body.replace(new RegExp('^## ' + esc + '\\n*'), '')
                 .replace(new RegExp('^### ' + esc + '\\n*'), '');
    }
    if (meta.chapterTitle) md += `## ${meta.chapterTitle}\n\n`;
    md += body;
    md += '\n\n---\n';
    md += `> 提取自微信读书 · ${new Date().toLocaleString('zh-CN')}`;
    return md;
  }

  _buildReadingPrompt(markdownContent) {
    const singlePrompt = [
      '你是一个严谨、有洞察力、善于联想的读书伙伴。',
      '',
      '我会给你一段从微信读书中提取的章节内容。请你帮助我理解这章，不只是总结表面内容，也要帮我发现我可能忽略的结构、暗线、隐含前提和跨领域联想。',
      '',
      '请按以下结构输出：',
      '',
      '## 1. 本章一句话主旨',
      '用一句话说明这一章真正想表达什么。',
      '',
      '## 2. 章节结构梳理',
      '用条目梳理本章的展开顺序、关键段落功能和论证链。',
      '',
      '## 3. 关键概念与重要句子',
      '提取本章最值得记住的概念、判断或表达，并解释为什么重要。',
      '',
      '## 4. 我可能忽略的东西',
      '请重点分析：',
      '- 作者没有明说但隐含的前提',
      '- 章节中反复出现的主题、对比或暗线',
      '- 容易被快速阅读跳过的细节',
      '- 这章和全书主题可能存在的关系',
      '',
      '## 5. 向外联想',
      '请基于本章内容，联想到其他领域、书籍、历史事件、现实案例、心理机制、产品设计或人生经验。',
      '要求：',
      '- 每条联想都说明"为什么能联想到这里"',
      '- 明确标注哪些是原文依据，哪些是你的推测或类比',
      '- 不要为了联想而牵强附会',
      '',
      '## 6. 反向思考',
      '请提出本章可能存在的局限、反例、盲点，或者可以被质疑的地方。',
      '',
      '## 7. 给我的思考问题',
      '最后给出 5 个高质量问题，帮助我继续思考、写作或和别人讨论。',
      '',
      '约束：',
      '- 不要编造原文没有的信息。',
      '- 如果某个判断来自你的推测，请明确写出"这是推测"。',
      '- 保持清晰、具体、有启发，不要写空泛鸡汤。',
      '',
      '下面是章节内容：',
      '',
      '--- 章节开始 ---',
      '',
      markdownContent,
      '',
      '--- 章节结束 ---'
    ].join('\n');

    return [singlePrompt, singlePrompt].join('\n\n');
  }
}

window.__wereadExtractor = new WereadExtractor();
