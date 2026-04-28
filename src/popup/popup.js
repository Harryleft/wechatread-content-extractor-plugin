/**
 * WereadExtract - Popup 逻辑
 */

(function () {
  'use strict';

  // ── DOM 引用 ──
  const statusBar = document.getElementById('status-bar');
  const statusText = document.getElementById('status-text');
  const btnExtractVisible = document.getElementById('btn-extract-visible');
  const btnCopy = document.getElementById('btn-copy');
  const metaSection = document.getElementById('meta-section');
  const metaBook = document.getElementById('meta-book');
  const metaChapter = document.getElementById('meta-chapter');
  const previewSection = document.getElementById('preview-section');
  const previewContent = document.getElementById('preview-content');
  const charCount = document.getElementById('char-count');
  const errorSection = document.getElementById('error-section');

  let currentResult = null;
  let selectedFormat = 'markdown';

  // ── 初始化 ──
  async function init() {
    // 加载格式偏好
    chrome.storage?.local?.get(['wereadExtractFormat'], (result) => {
      if (result?.wereadExtractFormat) {
        selectedFormat = result.wereadExtractFormat;
        updateFormatButtons();
      }
    });

    // 检测当前是否在微信读书页面
    await checkWereadTab();
  }

  // ── 检测微信读书标签页 ──
  async function checkWereadTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url?.includes('weread.qq.com')) {
        setStatus('inactive', '当前页面不是微信读书');
        return;
      }

      // 尝试 ping content script
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'PING' }).catch(() => null);

      if (response?.ok) {
        setStatus('active', '微信读书已就绪');
        btnExtractVisible.disabled = false;

        // 获取书籍元信息
        const meta = await chrome.tabs.sendMessage(tab.id, { type: 'GET_META' }).catch(() => null);
        if (meta) {
          showMeta(meta);
        }
      } else {
        setStatus('inactive', '请刷新微信读书页面');
      }
    } catch (e) {
      setStatus('inactive', '请打开微信读书阅读页');
    }
  }

  // ── 设置状态 ──
  function setStatus(type, text) {
    statusBar.className = `status-bar status-${type}`;
    statusText.textContent = text;
  }

  // ── 显示元信息 ──
  function showMeta(meta) {
    if (!meta) return;
    metaSection.style.display = 'flex';
    if (meta.title) {
      metaBook.textContent = `📖 ${meta.title}${meta.author ? ' · ' + meta.author : ''}`;
    }
    if (meta.chapterTitle) {
      metaChapter.textContent = `📋 ${meta.chapterTitle}`;
    }
  }

  // ── 格式按钮 ──
  function updateFormatButtons() {
    document.querySelectorAll('.fmt-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.format === selectedFormat);
    });
  }

  document.querySelectorAll('.fmt-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedFormat = btn.dataset.format;
      updateFormatButtons();
      chrome.storage?.local?.set({ wereadExtractFormat: selectedFormat });

      // 如果已有结果，重新格式化
      if (currentResult?.success && currentResult.rawContent) {
        reformat();
      }
    });
  });

  // ── 提取可见内容 ──
  btnExtractVisible.addEventListener('click', async () => {
    await extract();
  });

  // ── 通用提取方法 ──
  async function extract() {
    const btn = btnExtractVisible;
    btn.disabled = true;
    btn.textContent = '提取中...';
    hideError();

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url?.includes('weread.qq.com')) {
        showError('请先打开微信读书阅读页面');
        return;
      }

      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'EXTRACT_VISIBLE',
        format: selectedFormat
      });

      if (!response) {
        showError('未收到响应，请刷新页面后重试');
        return;
      }

      currentResult = response;

      if (response.success) {
        showPreview(response);
        showMeta(response.meta);
        btnCopy.disabled = false;
      } else {
        showError(response.error || '提取失败');
      }
    } catch (e) {
      showError('通信失败: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> 提取可见内容';
    }
  }

  // ── 显示预览 ──
  function showPreview(result) {
    previewSection.style.display = 'block';
    const text = result.content;
    const displayText = text.length > 800
      ? text.substring(0, 800) + '\n\n...'
      : text;

    previewContent.textContent = displayText;
    charCount.textContent = `${result.wordCount} 字 · ${result.charCount} 字符`;
  }

  // ── 重新格式化 ──
  function reformat() {
    if (!currentResult?.rawContent) return;
    // 重新发送提取请求（使用已有 rawContent，仅改变格式）
    // 这里简化处理，让 content script 重新提取
    extract();
  }

  // ── 复制到剪贴板 ──
  btnCopy.addEventListener('click', async () => {
    if (!currentResult?.content) return;
    try {
      await navigator.clipboard.writeText(currentResult.content);
      btnCopy.textContent = '已复制!';
      btnCopy.classList.add('copied');
      setTimeout(() => {
        btnCopy.textContent = '复制到剪贴板';
        btnCopy.classList.remove('copied');
      }, 2000);
    } catch (e) {
      // fallback
      const textarea = document.createElement('textarea');
      textarea.value = currentResult.content;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      btnCopy.textContent = '已复制!';
      setTimeout(() => {
        btnCopy.textContent = '复制到剪贴板';
      }, 2000);
    }
  });

  // ── 错误显示 ──
  function showError(message) {
    errorSection.style.display = 'block';
    errorSection.textContent = message;
  }

  function hideError() {
    errorSection.style.display = 'none';
  }

  // ── 启动 ──
  init();
})();
