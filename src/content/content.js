/**
 * WereadExtract - Content Script 主入口
 *
 * 注入浮动按钮 + 处理消息通信 + 触发提取
 */

/* eslint-disable no-undef */

(function () {
  'use strict';

  const EXTRACTOR = window.__wereadExtractor;
  if (!EXTRACTOR) {
    console.error('[WereadExtract] extractor.js 未加载');
    return;
  }

  // 避免重复注入
  if (document.getElementById('weread-extract-fab')) return;

  // ── 配置 ──
  const CONFIG = {
    fabId: 'weread-extract-fab',
    panelId: 'weread-extract-panel'
  };

  // ── 状态 ──
  let panelVisible = false;
  let lastResult = null;

  // ── 创建浮动按钮 ──
  function createFAB() {
    const fab = document.createElement('div');
    fab.id = CONFIG.fabId;
    fab.title = 'Weread Extract - 提取内容';
    fab.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/>
        <line x1="16" y1="17" x2="8" y2="17"/>
        <polyline points="10 9 9 9 8 9"/>
      </svg>
    `;
    fab.addEventListener('click', handleFABClick);
    document.body.appendChild(fab);
    return fab;
  }

  // ── 创建提取面板 ──
  function createPanel() {
    const panel = document.createElement('div');
    panel.id = CONFIG.panelId;
    panel.innerHTML = `
      <div class="we-header">
        <span class="we-title">Weread Extract</span>
        <button class="we-close" title="关闭">&times;</button>
      </div>
      <div class="we-body">
        <div class="we-actions">
          <button class="we-btn we-btn-primary" id="we-extract-visible">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            提取可见内容
          </button>
        </div>
        <div class="we-meta" id="we-meta"></div>
        <div class="we-selection-hint" id="we-selection-hint" style="display:none;">
          📝 已检测到选中文本，提取时将优先使用选中内容
        </div>
        <div class="we-preview" id="we-preview">
          <div class="we-preview-placeholder">点击上方按钮提取内容<br><small>也可先选中文字再提取</small></div>
        </div>
        <div class="we-footer">
          <span class="we-stats" id="we-stats"></span>
          <div class="we-footer-actions">
            <button class="we-btn we-btn-copy" id="we-copy" disabled>复制到剪贴板</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    bindPanelEvents(panel);
    return panel;
  }

  // ── 绑定面板事件 ──
  function bindPanelEvents(panel) {
    // 关闭按钮
    panel.querySelector('.we-close').addEventListener('click', () => togglePanel(false));

    // 提取可见内容
    panel.querySelector('#we-extract-visible').addEventListener('click', async () => {
      const btn = panel.querySelector('#we-extract-visible');
      btn.disabled = true;
      btn.textContent = '提取中...';
      try {
        lastResult = await EXTRACTOR.extractVisible();
        displayResult(lastResult);
      } catch (e) {
        displayError(e.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          提取可见内容
        `;
      }
    });

    // 复制到剪贴板
    panel.querySelector('#we-copy').addEventListener('click', async () => {
      if (!lastResult?.content) return;
      const copyBtn = panel.querySelector('#we-copy');
      const copyContent = getCopyContent(lastResult);
      try {
        await navigator.clipboard.writeText(copyContent);
        copyBtn.textContent = '已复制!';
        copyBtn.classList.add('we-btn-copied');
        showToast('内容已复制到剪贴板');
        setTimeout(() => {
          copyBtn.textContent = '复制到剪贴板';
          copyBtn.classList.remove('we-btn-copied');
        }, 2000);
      } catch (e) {
        // fallback
        fallbackCopy(copyContent);
        showToast('内容已复制到剪贴板');
      }
    });
  }

  // ── 显示提取结果 ──
  function displayResult(result) {
    const preview = document.getElementById('we-preview');
    const meta = document.getElementById('we-meta');
    const stats = document.getElementById('we-stats');
    const copyBtn = document.getElementById('we-copy');

    if (!result.success) {
      displayError(result.error);
      return;
    }

    // 元信息
    if (result.meta) {
      let metaHtml = '';
      if (result.meta.title) metaHtml += `📖 ${escapeHtml(result.meta.title)}`;
      if (result.meta.author) metaHtml += ` · ${escapeHtml(result.meta.author)}`;
      if (result.meta.chapterTitle) metaHtml += `<br>📋 ${escapeHtml(result.meta.chapterTitle)}`;
      meta.innerHTML = metaHtml;
    }

    // 预览内容（截取前 500 字）
    const previewText = result.content.substring(0, 500);
    const contentPreview = result.content.length > 500
      ? previewText + '\n\n... (共 ' + result.content.length + ' 字符)'
      : previewText;

    preview.innerHTML = `<pre class="we-preview-text">${escapeHtml(contentPreview)}</pre>`;

    // 统计
    stats.textContent = `${result.wordCount} 字 · ${result.charCount} 字符`;

    // 启用复制按钮
    copyBtn.disabled = false;
  }

  // ── 显示错误 ──
  function displayError(message) {
    const preview = document.getElementById('we-preview');
    if (preview) {
      preview.innerHTML = `<div class="we-error">❌ ${escapeHtml(message)}</div>`;
    }
    const copyBtn = document.getElementById('we-copy');
    if (copyBtn) copyBtn.disabled = true;
  }

  // ── Toast 通知 ──
  function showToast(message, duration = 2500) {
    // 移除已有 toast
    const existing = document.getElementById('weread-extract-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'weread-extract-toast';
    toast.className = 'we-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    // 触发动画
    requestAnimationFrame(() => toast.classList.add('we-toast-show'));

    setTimeout(() => {
      toast.classList.remove('we-toast-show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // ── 面板显示/隐藏 ──
  function togglePanel(show) {
    const panel = document.getElementById(CONFIG.panelId);
    if (!panel) return;

    panelVisible = typeof show === 'boolean' ? show : !panelVisible;

    if (panelVisible) {
      panel.classList.add('we-panel-visible');
      panel.classList.remove('we-panel-hidden');
    } else {
      panel.classList.remove('we-panel-visible');
      panel.classList.add('we-panel-hidden');
    }
  }

  // ── FAB 点击处理 ──
  async function handleFABClick() {
    const fab = document.getElementById(CONFIG.fabId);
    if (!fab || fab.classList.contains('we-fab-loading')) return;

    fab.classList.add('we-fab-loading');
    try {
      const result = await EXTRACTOR.extractVisible();
      if (result.success) {
        const copyContent = getCopyContent(result);
        try {
          await navigator.clipboard.writeText(copyContent);
        } catch {
          fallbackCopy(copyContent);
        }
        showToast(`已复制 ${result.wordCount} 字`);
      } else {
        showToast(result.error || '提取失败');
      }
    } catch (e) {
      showToast('提取失败: ' + e.message);
    } finally {
      fab.classList.remove('we-fab-loading');
    }
  }

  // ── 键盘快捷键 ──
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panelVisible) {
      togglePanel(false);
    }
  });

  // ── 监听来自 popup 的消息 ──
  chrome.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'EXTRACT_CHAPTER') {
      EXTRACTOR.extractVisible().then(sendResponse);
      return true; // 异步响应
    }
    if (msg.type === 'EXTRACT_VISIBLE') {
      EXTRACTOR.extractVisible().then(sendResponse);
      return true;
    }
    if (msg.type === 'GET_META') {
      EXTRACTOR.getBookMeta().then(sendResponse);
      return true;
    }
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return false;
    }
  });

  // ── 工具函数 ──
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function getCopyContent(result) {
    return result?.copyContent || result?.content || '';
  }

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  // ── 监听选区变化 ──
  document.addEventListener('selectionchange', () => {
    const hint = document.getElementById('we-selection-hint');
    if (!hint) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) {
      hint.style.display = 'block';
    } else {
      hint.style.display = 'none';
    }
  });

  // ── 初始化 ──
  createFAB();
  console.log('[WereadExtract] 已加载 · 点击右下角按钮一键提取');
})();
