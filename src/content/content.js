/**
 * WereadExtract - Content Script 主入口
 *
 * 注入浮动按钮 + 处理消息通信 + 触发提取 + 视角模板管理
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
        <div class="we-perspective-section">
          <div class="we-perspective-label">&#127917; 视角模板</div>
          <div class="we-select-wrapper">
            <select id="we-template-select"></select>
          </div>
        </div>
        <div class="we-meta" id="we-meta"></div>
        <div class="we-preview" id="we-preview">
          <div class="we-preview-placeholder">点击上方按钮提取内容</div>
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
    populateTemplateSelect();
    bindPanelEvents(panel);
    return panel;
  }

  // ── 填充模板下拉 ──
  function populateTemplateSelect() {
    const select = document.getElementById('we-template-select');
    if (!select) return;
    select.innerHTML = '';

    const all = getAllTemplates();
    all.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      if (t.id === selectedTemplateId) opt.selected = true;
      select.appendChild(opt);
    });

    // 分隔线
    const sep = document.createElement('option');
    sep.disabled = true;
    sep.textContent = '──────────────';
    select.appendChild(sep);

    // 管理入口
    const mgmt = document.createElement('option');
    mgmt.value = '__manage__';
    mgmt.textContent = '✏️ 管理模板...';
    select.appendChild(mgmt);
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

    // 模板选择
    panel.querySelector('#we-template-select').addEventListener('change', async (e) => {
      const val = e.target.value;
      if (val === '__manage__') {
        openManageModal();
        e.target.value = selectedTemplateId;
        return;
      }
      selectedTemplateId = val;
      await saveTemplates();
      // 如果已有结果，更新 copyContent
      if (lastResult?.success) {
        displayResult(lastResult);
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

  // ── 管理模板弹窗 ──
  function openManageModal() {
    removeModal();

    const overlay = document.createElement('div');
    overlay.id = 'we-modal-overlay';
    overlay.innerHTML = `
      <div class="we-modal">
        <div class="we-modal-header">
          <span class="we-modal-title">🎭 管理视角模板</span>
          <button class="we-close" id="we-modal-close">&times;</button>
        </div>
        <div class="we-modal-body" id="we-template-list"></div>
        <div class="we-modal-footer">
          <button class="we-btn we-btn-add" id="we-add-template">+ 新建视角模板</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    renderTemplateList();
    overlay.querySelector('#we-modal-close').addEventListener('click', removeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) removeModal();
    });
    overlay.querySelector('#we-add-template').addEventListener('click', () => {
      openEditModal(null);
    });
  }

  function renderTemplateList() {
    const list = document.getElementById('we-template-list');
    if (!list) return;
    list.innerHTML = '';

    getAllTemplates().forEach((t) => {
      const item = document.createElement('div');
      item.className = 'we-template-item' + (t.builtin ? ' we-template-builtin' : '');

      const info = document.createElement('div');
      info.className = 'we-template-info';
      info.innerHTML = `<div class="we-template-name">${escapeHtml(t.name)}</div>
        <div class="we-template-desc">${t.builtin ? '内置模板' : '自定义模板'}</div>`;

      const actions = document.createElement('div');
      actions.className = 'we-template-actions';

      if (!t.builtin) {
        const editBtn = document.createElement('button');
        editBtn.textContent = '编辑';
        editBtn.addEventListener('click', () => openEditModal(t));
        actions.appendChild(editBtn);

        const delBtn = document.createElement('button');
        delBtn.textContent = '删除';
        delBtn.className = 'we-btn-danger';
        delBtn.addEventListener('click', async () => {
          customTemplates = customTemplates.filter((ct) => ct.id !== t.id);
          if (selectedTemplateId === t.id) {
            selectedTemplateId = 'builtin-default';
          }
          await saveTemplates();
          populateTemplateSelect();
          renderTemplateList();
        });
        actions.appendChild(delBtn);
      } else {
        const badge = document.createElement('button');
        badge.textContent = '内置';
        badge.disabled = true;
        actions.appendChild(badge);
      }

      item.appendChild(info);
      item.appendChild(actions);
      list.appendChild(item);
    });
  }

  // ── 编辑/新建模板弹窗 ──
  function openEditModal(template) {
    const isEdit = template !== null;
    const overlay = document.getElementById('we-modal-overlay');

    const editPanel = document.createElement('div');
    editPanel.id = 'we-edit-panel';
    editPanel.innerHTML = `
      <div class="we-modal-header">
        <span class="we-modal-title">${isEdit ? '✏️ 编辑模板' : '✏️ 新建视角模板'}</span>
        <button class="we-close" id="we-edit-close">&times;</button>
      </div>
      <div class="we-edit-form">
        <div class="we-form-group">
          <label class="we-form-label">模板名称</label>
          <input class="we-form-input" type="text" id="we-edit-name"
            placeholder="例如：🐵 孙悟空 — 修行与觉悟"
            value="${isEdit ? escapeAttr(template.name) : ''}">
        </div>
        <div class="we-form-group">
          <label class="we-form-label">提示词模板</label>
          <textarea class="we-form-textarea" id="we-edit-template"
            placeholder="在这里编写提示词，使用 {{content}} 作为章节内容占位符">${isEdit ? escapeHtml(template.template) : ''}</textarea>
          <div class="we-form-hint">使用 {{content}} 作为提取内容占位符</div>
        </div>
      </div>
      <div class="we-edit-footer">
        <button class="we-btn we-btn-cancel" id="we-edit-cancel">取消</button>
        <button class="we-btn we-btn-save" id="we-edit-save">保存模板</button>
      </div>
    `;

    // 隐藏管理列表，显示编辑面板
    const modal = overlay.querySelector('.we-modal');
    modal.innerHTML = '';
    modal.appendChild(editPanel);

    editPanel.querySelector('#we-edit-close').addEventListener('click', () => {
      // 返回管理列表
      removeModal();
      openManageModal();
    });

    editPanel.querySelector('#we-edit-cancel').addEventListener('click', () => {
      removeModal();
      openManageModal();
    });

    editPanel.querySelector('#we-edit-save').addEventListener('click', async () => {
      const name = document.getElementById('we-edit-name').value.trim();
      const tmpl = document.getElementById('we-edit-template').value.trim();

      if (!name) {
        showToast('请输入模板名称');
        return;
      }
      if (!tmpl) {
        showToast('请输入提示词模板');
        return;
      }
      if (!tmpl.includes('{{content}}')) {
        showToast('模板中必须包含 {{content}} 占位符');
        return;
      }

      if (isEdit) {
        const idx = customTemplates.findIndex((ct) => ct.id === template.id);
        if (idx !== -1) {
          customTemplates[idx].name = name;
          customTemplates[idx].template = tmpl;
        }
      } else {
        customTemplates.push({
          id: 'custom-' + Date.now(),
          name,
          builtin: false,
          template: tmpl
        });
      }

      await saveTemplates();
      populateTemplateSelect();
      removeModal();
      showToast(isEdit ? '模板已更新' : '模板已创建');
    });
  }

  function removeModal() {
    const overlay = document.getElementById('we-modal-overlay');
    if (overlay) overlay.remove();
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

  // ── 键盘快捷键 ──
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.getElementById('we-modal-overlay')) {
        removeModal();
      } else if (panelVisible) {
        togglePanel(false);
      }
    }
  });

  // ── 监听来自 popup 的消息 ──
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
  });

  // ── 工具函数 ──
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function escapeAttr(text) {
    return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function getCopyContent(result) {
    if (!result?.content) return '';
    const tmpl = getTemplateById(selectedTemplateId);
    return EXTRACTOR.buildPrompt(result.content, tmpl.template);
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

  // ── 初始化 ──
  async function init() {
    await loadTemplates();
    createFAB();
    createPanel();
    console.log('[WereadExtract] 已加载 · 点击右下角按钮一键提取');
  }

  init();
})();
