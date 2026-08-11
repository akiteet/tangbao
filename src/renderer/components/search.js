'use strict';
(function () {
  window.App = window.App || {};

  const escapeHtml = (value) => {
    if (App.escapeHtml) return App.escapeHtml(value);
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  };

  const labels = {
    all: '全部', conversation: '会话', document: '文档', run: '运行',
    workflow: 'Workflow', skill: 'Skill',
  };

  function openResult(item, close) {
    const scope = String(item.scope || '');
    if (scope === 'conversation' && App.chat && typeof App.chat.activate === 'function') {
      close();
      App.chat.activate(item.id);
      return;
    }
    if (scope === 'document' && App.router && App.doc) {
      close();
      App.doc.activeId = item.id;
      App.router.go('doc');
      return;
    }
    if (scope === 'workflow' && App.router && App.create) {
      close();
      App.create.tab = 'workflows';
      App.router.go('create');
      return;
    }
    if (scope === 'skill' && App.ui && typeof App.ui.openSettings === 'function') {
      close();
      App.ui.openSettings();
      App.ui.selectSettingsPanel('skills');
      const skillSearch = document.getElementById('skillSearch');
      if (skillSearch) {
        skillSearch.value = String(item.title || '');
        skillSearch.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return;
    }
    if (scope !== 'run' || !App.router || !App.agent || typeof App.agent.showRunHistory !== 'function') return;
    close();
    const threadId = String(item.threadId || '');
    if (threadId && Array.isArray(App.state && App.state.agentThreads)) {
      const thread = App.state.agentThreads.find((candidate) => candidate && candidate.id === threadId);
      if (thread) {
        App.state.activeThreadId = thread.id;
        if (thread.projectId) App.state.activeProjectId = thread.projectId;
        App.persist();
      }
    }
    App.router.go('agent');
    setTimeout(() => App.agent.showRunHistory({ openRunId: item.id }), 0);
  }

  function openSearch() {
    const previous = document.getElementById('localSearchMask');
    if (previous) {
      previous.remove();
      return;
    }

    const mask = document.createElement('div');
    mask.id = 'localSearchMask';
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal local-search-modal" role="dialog" aria-modal="true" aria-labelledby="localSearchTitle">
        <div class="modal-header">
          <span id="localSearchTitle">本地搜索</span>
          <button class="icon-btn" type="button" data-search-close aria-label="关闭">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="modal-body local-search-body">
          <div class="local-search-controls">
            <input type="search" data-search-input placeholder="搜索会话、文档、Run 或 Skill" aria-label="搜索" autocomplete="off" />
            <select data-search-scope aria-label="搜索范围">
              <option value="">全部</option>
              <option value="conversation">会话</option>
              <option value="document">文档</option>
              <option value="run">运行</option>
              <option value="workflow">Workflow</option>
              <option value="skill">Skill</option>
            </select>
          </div>
          <div class="local-search-status" data-search-status role="status">输入关键词开始搜索</div>
          <div class="local-search-results" data-search-results></div>
          <button class="btn-ghost local-search-more" type="button" data-search-more hidden>加载更多</button>
        </div>
      </div>`;
    document.body.appendChild(mask);

    const input = mask.querySelector('[data-search-input]');
    const scope = mask.querySelector('[data-search-scope]');
    const status = mask.querySelector('[data-search-status]');
    const results = mask.querySelector('[data-search-results]');
    const more = mask.querySelector('[data-search-more]');
    let cursor = null;
    let loading = false;
    let timer = null;
    let requestSerial = 0;

    const close = () => {
      clearTimeout(timer);
      requestSerial += 1;
      mask.remove();
    };
    const setStatus = (text) => { status.textContent = text; };
    const render = (items, replace) => {
      if (replace) results.innerHTML = '';
      if (replace && !items.length) {
        results.innerHTML = '<div class="local-search-empty">没有匹配记录</div>';
        return;
      }
      const html = items.map((item) => {
        const scopeName = labels[item.scope] || item.scope || '记录';
        return `<button class="local-search-item" type="button" data-result-id="${escapeHtml(item.id)}" data-result-scope="${escapeHtml(item.scope)}" data-result-title="${escapeHtml(item.title || '')}" data-result-thread-id="${escapeHtml(item.threadId || '')}">
          <span class="local-search-item-main"><b>${escapeHtml(item.title || '未命名')}</b><small>${escapeHtml(item.snippet || '')}</small></span>
          <em>${escapeHtml(scopeName)}</em>
        </button>`;
      }).join('');
      results.insertAdjacentHTML('beforeend', html);
    };

    const load = async (replace) => {
      const query = String(input.value || '').trim();
      if (!query) {
        requestSerial += 1;
        cursor = null;
        more.hidden = true;
        results.innerHTML = '';
        setStatus('输入关键词开始搜索');
        return;
      }
      if (loading) return;
      loading = true;
      const serial = ++requestSerial;
      if (replace) {
        cursor = null;
        more.hidden = true;
        results.innerHTML = '<div class="local-search-empty">搜索中...</div>';
      }
      setStatus('搜索中...');
      const selectedScope = scope.value;
      try {
        const response = await (App.services.search && App.services.search.query
          ? App.services.search.query({ query, scopes: selectedScope ? [selectedScope] : [], cursor, limit: 30 })
          : null);
        if (serial !== requestSerial || !document.body.contains(mask)) return;
        const page = response && response.ok !== false
          ? response
          : { items: [], nextCursor: null, total: 0, error: '搜索服务不可用' };
        render(Array.isArray(page.items) ? page.items : [], replace);
        cursor = page.nextCursor || null;
        more.hidden = !cursor;
        setStatus(page.error ? String(page.error) : `${Number(page.total || 0)} 条结果`);
      } catch (_) {
        if (serial === requestSerial) {
          render([], true);
          more.hidden = true;
          setStatus('搜索失败，请稍后重试');
        }
      } finally {
        loading = false;
      }
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => load(true), 220);
    };
    mask.querySelectorAll('[data-search-close]').forEach((button) => button.addEventListener('click', close));
    mask.addEventListener('click', (event) => { if (event.target === mask) close(); });
    mask.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
    input.addEventListener('input', schedule);
    scope.addEventListener('change', () => load(true));
    more.addEventListener('click', () => load(false));
    results.addEventListener('click', (event) => {
      const button = event.target.closest('.local-search-item');
      if (!button) return;
      openResult({
        id: button.dataset.resultId,
        scope: button.dataset.resultScope,
        title: button.dataset.resultTitle,
        threadId: button.dataset.resultThreadId,
      }, close);
    });
    input.focus();
  }

  App.search = { open: openSearch };
  const button = document.getElementById('localSearchBtn');
  if (button) button.addEventListener('click', openSearch);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearch();
    }
  });
})();
