/**
 * WereadExtract - Popup 逻辑
 *
 * 提取内容 + 模板选择 + 模板管理
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
  const templateSelect = document.getElementById('template-select');
  const btnManageTemplates = document.getElementById('btn-manage-templates');
  const templateSection = document.getElementById('template-section');

  // 管理面板
  const popupMain = document.getElementById('popup-main');
  const popupManage = document.getElementById('popup-manage');
  const popupEdit = document.getElementById('popup-edit');
  const btnBackMain = document.getElementById('btn-back-main');
  const templateList = document.getElementById('template-list');
  const btnAddTemplate = document.getElementById('btn-add-template');

  // 编辑面板
  const btnBackManage = document.getElementById('btn-back-manage');
  const editTitle = document.getElementById('edit-title');
  const editName = document.getElementById('edit-name');
  const editTemplate = document.getElementById('edit-template');
  const btnEditCancel = document.getElementById('btn-edit-cancel');
  const btnEditSave = document.getElementById('btn-edit-save');

  // ── 状态 ──
  let currentResult = null;
  let tabId = null;
  let builtinTemplates = [];
  let customTemplates = [];
  let selectedTemplateId = 'builtin-default';
  let editingTemplateId = null; // null = 新建

  // ── 初始化 ──
  async function init() {
    await checkWereadTab();
    if (tabId) {
      await loadTemplates();
      populateTemplateSelect();
    }
  }

  // ── 检测微信读书标签页 ──
  async function checkWereadTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url?.includes('weread.qq.com')) {
        setStatus('inactive', '当前页面不是微信读书');
        return;
      }

      const response = await chrome.tabs.sendMessage(tab.id, { type: 'PING' }).catch(() => null);

      if (response?.ok) {
        tabId = tab.id;
        setStatus('active', '微信读书已就绪');
        btnExtractVisible.disabled = false;

        const meta = await chrome.tabs.sendMessage(tab.id, { type: 'GET_META' }).catch(() => null);
        if (meta) showMeta(meta);
      } else {
        setStatus('inactive', '请刷新微信读书页面');
      }
    } catch (e) {
      setStatus('inactive', '请打开微信读书阅读页');
    }
  }

  // ── 模板操作 ──

  async function loadTemplates() {
    if (!tabId) return;
    try {
      const data = await chrome.tabs.sendMessage(tabId, { type: 'GET_TEMPLATES' });
      if (data) {
        builtinTemplates = data.builtin || [];
        customTemplates = data.custom || [];
        selectedTemplateId = data.selectedId || 'builtin-default';
      }
    } catch (e) {
      console.warn('[Popup] 加载模板失败:', e);
    }
  }

  function getAllTemplates() {
    return [...builtinTemplates, ...customTemplates];
  }

  function populateTemplateSelect() {
    templateSelect.innerHTML = '';
    getAllTemplates().forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      if (t.id === selectedTemplateId) opt.selected = true;
      templateSelect.appendChild(opt);
    });
  }

  async function setSelectedTemplate(id) {
    selectedTemplateId = id;
    if (tabId) {
      await chrome.tabs.sendMessage(tabId, {
        type: 'SET_SELECTED_TEMPLATE',
        templateId: id
      }).catch(() => {});
    }
  }

  // ── 管理面板 ──

  function showPanel(panelId) {
    popupMain.style.display = panelId === 'main' ? '' : 'none';
    popupManage.style.display = panelId === 'manage' ? '' : 'none';
    popupEdit.style.display = panelId === 'edit' ? '' : 'none';
  }

  function renderTemplateList() {
    templateList.innerHTML = '';
    getAllTemplates().forEach((t) => {
      const item = document.createElement('div');
      item.className = 'template-item' + (t.builtin ? ' template-builtin' : '');

      const info = document.createElement('div');
      info.className = 'template-info';
      info.innerHTML = `<div class="template-name">${escapeHtml(t.name)}</div>
        <div class="template-desc">${t.builtin ? '内置模板' : '自定义模板'}</div>`;

      const actions = document.createElement('div');
      actions.className = 'template-actions';

      if (!t.builtin) {
        const editBtn = document.createElement('button');
        editBtn.className = 'btn-sm';
        editBtn.textContent = '编辑';
        editBtn.addEventListener('click', () => openEditPanel(t));
        actions.appendChild(editBtn);

        const delBtn = document.createElement('button');
        delBtn.className = 'btn-sm btn-sm-danger';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', async () => {
          const resp = await chrome.tabs.sendMessage(tabId, {
            type: 'DELETE_TEMPLATE',
            templateId: t.id
          }).catch(() => null);
          if (resp?.ok) {
            customTemplates = resp.templates || [];
            if (selectedTemplateId === t.id) {
              selectedTemplateId = 'builtin-default';
            }
            populateTemplateSelect();
            renderTemplateList();
          }
        });
        actions.appendChild(delBtn);
      } else {
        const badge = document.createElement('span');
        badge.className = 'template-badge';
        badge.textContent = '内置';
        actions.appendChild(badge);
      }

      item.appendChild(info);
      item.appendChild(actions);
      templateList.appendChild(item);
    });
  }

  function openEditPanel(template) {
    editingTemplateId = template ? template.id : null;
    editTitle.textContent = template ? '✏️ 编辑模板' : '✏️ 新建模板';
    editName.value = template ? template.name : '';
    editTemplate.value = template ? template.template : '';
    showPanel('edit');
  }

  // ── 状态 ──

  function setStatus(type, text) {
    statusBar.className = `status-bar status-${type}`;
    statusText.textContent = text;
    templateSection.style.display = type === 'active' ? '' : 'none';
  }

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

  // ── 提取 ──

  btnExtractVisible.addEventListener('click', async () => {
    await extract();
  });

  async function extract() {
    const btn = btnExtractVisible;
    btn.disabled = true;
    btn.textContent = '提取中...';
    hideError();

    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_VISIBLE' });
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

  function showPreview(result) {
    previewSection.style.display = 'block';
    const text = result.content;
    const displayText = text.length > 800
      ? text.substring(0, 800) + '\n\n...'
      : text;

    previewContent.textContent = displayText;
    charCount.textContent = `${result.wordCount} 字 · ${result.charCount} 字符`;
  }

  // ── 复制 ──

  btnCopy.addEventListener('click', async () => {
    if (!currentResult?.content) return;
    const copyContent = getCopyContent();
    try {
      await navigator.clipboard.writeText(copyContent);
      btnCopy.textContent = '已复制!';
      btnCopy.classList.add('copied');
      setTimeout(() => {
        btnCopy.textContent = '复制到剪贴板';
        btnCopy.classList.remove('copied');
      }, 2000);
    } catch (e) {
      const textarea = document.createElement('textarea');
      textarea.value = copyContent;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      btnCopy.textContent = '已复制!';
      setTimeout(() => { btnCopy.textContent = '复制到剪贴板'; }, 2000);
    }
  });

  function getCopyContent() {
    if (!currentResult?.content) return '';
    const all = getAllTemplates();
    const tmpl = all.find((t) => t.id === selectedTemplateId) || all[0];
    if (!tmpl) return currentResult.content;
    return tmpl.template.replace(/\{\{content\}\}/g, currentResult.content);
  }

  // ── 模板选择 ──

  templateSelect.addEventListener('change', async (e) => {
    await setSelectedTemplate(e.target.value);
  });

  // ── 管理面板导航 ──

  btnManageTemplates.addEventListener('click', async () => {
    await loadTemplates();
    renderTemplateList();
    showPanel('manage');
  });

  btnBackMain.addEventListener('click', () => {
    populateTemplateSelect();
    showPanel('main');
  });

  btnAddTemplate.addEventListener('click', () => {
    openEditPanel(null);
  });

  btnBackManage.addEventListener('click', () => {
    renderTemplateList();
    showPanel('manage');
  });

  // ── 保存模板 ──

  btnEditSave.addEventListener('click', async () => {
    const name = editName.value.trim();
    const tmpl = editTemplate.value.trim();

    if (!name) { alert('请输入模板名称'); return; }
    if (!tmpl) { alert('请输入提示词模板'); return; }
    if (!tmpl.includes('{{content}}')) { alert('模板中必须包含 {{content}} 占位符'); return; }

    const resp = await chrome.tabs.sendMessage(tabId, {
      type: 'SAVE_TEMPLATE',
      template: { id: editingTemplateId, name, template: tmpl }
    }).catch(() => null);

    if (resp?.ok) {
      customTemplates = resp.templates || [];
      populateTemplateSelect();
      renderTemplateList();
      showPanel('manage');
    } else {
      alert('保存失败');
    }
  });

  btnEditCancel.addEventListener('click', () => {
    renderTemplateList();
    showPanel('manage');
  });

  // ── 错误显示 ──

  function showError(message) {
    errorSection.style.display = 'block';
    errorSection.textContent = message;
  }

  function hideError() {
    errorSection.style.display = 'none';
  }

  // ── 工具 ──

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ── 启动 ──
  init();
})();
