'use strict';
/* v1.2.1 批次 7：提示词快捷短语库。
 * 设置→提示词 维护短语（settings.promptSnippets，全模块共用）；聊天输入框旁「快捷短语」按钮
 * 弹出选择列表，点选把正文插入到 #input 光标处（textarea 选区感知）。 */
(function () {
  window.App = window.App || {};
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) => (App.escapeHtml ? App.escapeHtml(s) : String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])));

  function list() {
    return Array.isArray(App.state.settings.promptSnippets) ? App.state.settings.promptSnippets : [];
  }
  function persist(next) {
    App.state.settings.promptSnippets = Array.isArray(next) ? next : [];
    App.persist();
  }

  function insertAtCursor(text) {
    const ta = $('input');
    if (!ta) return;
    const start = typeof ta.selectionStart === 'number' ? ta.selectionStart : ta.value.length;
    const end = typeof ta.selectionEnd === 'number' ? ta.selectionEnd : ta.value.length;
    const insert = String(text || '');
    ta.value = ta.value.slice(0, start) + insert + ta.value.slice(end);
    const pos = start + insert.length;
    try { ta.focus(); ta.setSelectionRange(pos, pos); } catch (_) {}
    if (App.chat && App.chat.autoSize) App.chat.autoSize();
    if (App.chat && App.chat.updateSendEnabled) App.chat.updateSendEnabled();
  }

  function renderDropdown() {
    const dd = $('snippetDropdown');
    if (!dd) return;
    const items = list();
    if (!items.length) { dd.innerHTML = '<div class="snippet-empty">还没有短语。到 设置→提示词 添加。</div>'; return; }
    dd.innerHTML = items.map((s) =>
      '<button type="button" class="snippet-item" data-snip="' + escapeHtml(s.id) + '"><span class="snippet-item-title">' + escapeHtml(s.title || '(无标题)') + '</span><small>' + escapeHtml(String(s.content || '').slice(0, 40).replace(/\s+/g, ' ')) + '</small></button>').join('');
    dd.querySelectorAll('[data-snip]').forEach((b) => b.addEventListener('click', () => {
      const s = list().find((x) => x.id === b.dataset.snip);
      if (s) insertAtCursor(s.content || '');
      dd.hidden = true;
    }));
  }

  function bindComposer() {
    const btn = $('snippetBtn');
    const dd = $('snippetDropdown');
    if (!btn || !dd) return;
    btn.addEventListener('click', (e) => { e.stopPropagation(); renderDropdown(); dd.hidden = !dd.hidden; });
    document.addEventListener('click', (e) => { if (!dd.hidden && !dd.contains(e.target) && e.target !== btn) dd.hidden = true; });
  }

  function renderSettings() {
    const box = $('snippetList');
    if (!box) return;
    const items = list();
    if (!items.length) { box.innerHTML = '<p class="hint">还没有短语。</p>'; return; }
    box.innerHTML = items.map((s) =>
      '<div class="sc-row" style="margin:4px 0"><span class="sc-label">' + escapeHtml(s.title || '(无标题)') + '<br><small class="hint">' + escapeHtml(String(s.content || '').slice(0, 60).replace(/\s+/g, ' ')) + '</small></span><span class="sc-controls"><button type="button" class="btn-ghost mini danger" data-snip-del="' + escapeHtml(s.id) + '">删除</button></span></div>').join('');
    box.querySelectorAll('[data-snip-del]').forEach((b) => b.addEventListener('click', () => {
      persist(list().filter((x) => x.id !== b.dataset.snipDel));
      renderSettings();
      App.ui.toast('已删除短语');
    }));
  }

  function bindSettings() {
    const addBtn = $('snippetAdd');
    if (!addBtn || addBtn._snipBound) return;
    addBtn._snipBound = true;
    addBtn.addEventListener('click', () => {
      const titleEl = $('snippetTitle');
      const contentEl = $('snippetContent');
      const title = titleEl ? titleEl.value.trim() : '';
      const content = contentEl ? contentEl.value : '';
      if (!title && !content) { App.ui.toast('请填写短语名或正文'); return; }
      persist(list().concat([{ id: App.uid(), title, content }]));
      if (titleEl) titleEl.value = '';
      if (contentEl) contentEl.value = '';
      renderSettings();
      App.ui.toast('已添加短语');
    });
  }

  App.snippets = { renderDropdown, insertAtCursor, renderSettings, bindComposer, bindSettings };

  function bootSnippets() { bindComposer(); bindSettings(); renderSettings(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootSnippets);
  else bootSnippets();
})();
