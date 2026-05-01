/**
 * WereadExtract - Content Script 主入口
 *
 * 注入浮动按钮 + 处理消息通信 + 触发提取 + 模板数据中转
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

  // ── 状态 ──
  let customTemplates = [];
  let selectedTemplateId = 'builtin-default';

  // ── 模板存储 ──

  function loadTemplates() {
    return new Promise((resolve) => {
      chrome.storage?.local?.get(
        ['wereadTemplates', 'wereadSelectedTemplate'],
        (data) => {
          customTemplates = data.wereadTemplates || [];
          selectedTemplateId = data.wereadSelectedTemplate || 'builtin-default';
          resolve();
        }
      );
    }).catch(() => {});
  }

  function saveTemplates() {
    return new Promise((resolve) => {
      chrome.storage?.local?.set(
        { wereadTemplates: customTemplates, wereadSelectedTemplate: selectedTemplateId },
        resolve
      );
    }).catch(() => {});
  }

  function getAllTemplates() {
    return [...BUILTIN_TEMPLATES, ...customTemplates];
  }

  function getTemplateById(id) {
    return getAllTemplates().find((t) => t.id === id) || BUILTIN_TEMPLATES[0];
  }

  // ── 创建浮动按钮 ──
  function createFAB() {
    const fab = document.createElement('div');
    fab.id = 'weread-extract-fab';
    fab.title = 'Weread Extract - 一键提取复制';
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

  // ── FAB 点击处理 ──
  async function handleFABClick() {
    const fab = document.getElementById('weread-extract-fab');
    if (!fab || fab.classList.contains('we-fab-loading')) return;

    fab.classList.add('we-fab-loading');
    try {
      const result = await EXTRACTOR.extractVisible();
      if (result.success) {
        const tmpl = getTemplateById(selectedTemplateId);
        const copyContent = EXTRACTOR.buildPrompt(result.content, tmpl.template);
        try {
          await navigator.clipboard.writeText(copyContent);
        } catch {
          fallbackCopy(copyContent);
        }
        showToast(`已复制 ${result.wordCount} 字（${tmpl.name}）`);
      } else {
        showToast(result.error || '提取失败');
      }
    } catch (e) {
      showToast('提取失败: ' + e.message);
    } finally {
      fab.classList.remove('we-fab-loading');
    }
  }

  // ── Toast 通知 ──
  function showToast(message, duration = 2500) {
    const existing = document.getElementById('weread-extract-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'weread-extract-toast';
    toast.className = 'we-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('we-toast-show'));

    setTimeout(() => {
      toast.classList.remove('we-toast-show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // ── 消息监听 ──
  chrome.runtime?.onMessage?.addListener((msg, sender, sendResponse) => {
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

    // 模板相关消息
    if (msg.type === 'GET_TEMPLATES') {
      sendResponse({
        builtin: BUILTIN_TEMPLATES,
        custom: customTemplates,
        selectedId: selectedTemplateId
      });
      return false;
    }
    if (msg.type === 'SET_SELECTED_TEMPLATE') {
      selectedTemplateId = msg.templateId || 'builtin-default';
      saveTemplates();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'SAVE_TEMPLATE') {
      const t = msg.template;
      if (!t || !t.name || !t.template) {
        sendResponse({ ok: false, error: '缺少必填字段' });
        return false;
      }
      if (t.id) {
        const idx = customTemplates.findIndex((ct) => ct.id === t.id);
        if (idx !== -1) {
          customTemplates[idx] = { ...customTemplates[idx], name: t.name, template: t.template };
        }
      } else {
        customTemplates.push({
          id: 'custom-' + Date.now(),
          name: t.name,
          builtin: false,
          template: t.template
        });
      }
      saveTemplates();
      sendResponse({ ok: true, templates: customTemplates });
      return false;
    }
    if (msg.type === 'DELETE_TEMPLATE') {
      customTemplates = customTemplates.filter((ct) => ct.id !== msg.templateId);
      if (selectedTemplateId === msg.templateId) {
        selectedTemplateId = 'builtin-default';
      }
      saveTemplates();
      sendResponse({ ok: true, templates: customTemplates });
      return false;
    }
    if (msg.type === 'BUILD_PROMPT') {
      const tmpl = getTemplateById(msg.templateId || selectedTemplateId);
      // 需要先提取内容
      EXTRACTOR.extractVisible().then((result) => {
        if (result.success) {
          sendResponse({
            ok: true,
            prompt: EXTRACTOR.buildPrompt(result.content, tmpl.template),
            wordCount: result.wordCount,
            templateName: tmpl.name
          });
        } else {
          sendResponse({ ok: false, error: result.error });
        }
      });
      return true;
    }
  });

  // ── 工具函数 ──
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

  // ── 初始化 ──
  async function init() {
    await loadTemplates();
    createFAB();
    console.log('[WereadExtract] 已加载 · 点击右下角按钮一键提取');
  }

  init();
})();
