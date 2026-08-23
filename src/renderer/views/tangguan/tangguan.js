'use strict';

(function () {
  window.App = window.App || {};
  const $ = (id) => document.getElementById(id);
  const esc = (value) => App.escapeHtml(String(value == null ? '' : value));
  const call = (name, fallback, input) => {
    try {
      const fn = App.services.tangguan && App.services.tangguan[name];
      return fn ? fn(input) : fallback;
    } catch (_) { return fallback; }
  };

  let characters = [];
  let selectedId = '';
  let selected = null;
  let revision = 0;
  let memories = [];
  let presets = [];
  let loaded = false;
  let initPromise = null;
  let draftBase = null;
  let matureMode = false;
  let sessionVisibleCount = 50;
  let sessionCharacterId = '';
  let activeDrawer = '';
  let activeLibraryTab = 'characters';
  let characterVisibleCount = 50;
  let characterListQuery = '';
  let characterSearchTimer = null;
  // Desktop-only display state. It intentionally stays in memory so a narrow
  // window or a later launch never overwrites the user's full-width layout.
  let libraryCollapsed = false;
  let resizeFrame = 0;
  let lastDesktopLayout = null;
  let activeCharacterFilter = 'all';
  let editorDirty = false;
  let editorSnapshot = '';
  let editorDirtyTimer = null;
  let editorBase = null;
  let worldbookExpanded = false;
  const detailCache = new Map();
  const DETAIL_CACHE_TTL_MS = 15 * 1000;
  let characterLoadSequence = 0;
  let characterSearchIndex = new Map();

  function invalidateCharacterDetail(id) {
    if (id) detailCache.delete(String(id));
    else detailCache.clear();
  }

  function getCharacterDetail(id) {
    const key = String(id || '');
    if (!key) return Promise.resolve({ ok: false, character: null, memories: [] });
    const cached = detailCache.get(key);
    if (cached && cached.result && cached.expiresAt > Date.now()) return Promise.resolve(cached.result);
    if (cached && cached.promise) return cached.promise;
    const promise = Promise.resolve(call('getCharacter', { ok: false }, key)).then((result) => {
      const current = detailCache.get(key);
      if (current && current.promise === promise && result && result.ok) {
        detailCache.set(key, { result, expiresAt: Date.now() + DETAIL_CACHE_TTL_MS });
      }
      return result;
    }).catch(() => ({ ok: false, character: null, memories: [] }));
    detailCache.set(key, { promise, expiresAt: 0 });
    return promise;
  }

  function tangguanUi() {
    const settings = App.state && App.state.settings;
    if (!settings) return null;
    settings.tangguanUi = settings.tangguanUi && typeof settings.tangguanUi === 'object'
      ? settings.tangguanUi : { lastCharacterId: '', lastConversationId: '' };
    return settings.tangguanUi;
  }

  function setUiPointer(characterId, conversationId, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const ui = tangguanUi();
    if (!ui) return;
    const nextCharacterId = characterId ? String(characterId) : '';
    const nextConversationId = conversationId ? String(conversationId) : '';
    if (ui.lastCharacterId === nextCharacterId && ui.lastConversationId === nextConversationId) return;
    ui.lastCharacterId = nextCharacterId;
    ui.lastConversationId = nextConversationId;
    if (opts.persist !== false) App.persist();
  }

  function isValidSession(item, characterId) {
    return !!(item
      && typeof item.id === 'string'
      && item.tangguanCharacterId === String(characterId || '')
      && Array.isArray(item.messages)
      && item.messages.every((message) => message
        && typeof message === 'object'
        && (message.role === 'user' || message.role === 'assistant')
        && (message.content == null || typeof message.content === 'string')));
  }

  function characterSessions(characterId) {
    const source = App.chat && App.chat.conversationList
      ? App.chat.conversationList('tangguan')
      : (Array.isArray(App.state && App.state.conversations) ? App.state.conversations : []);
    return source
      .filter((item) => isValidSession(item, characterId))
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  function sessionTitle(item) {
    const title = String(item && item.title || '').trim();
    const roleName = String(selected && selected.name || '').trim();
    const firstUser = Array.isArray(item && item.messages)
      ? item.messages.find((message) => message && message.role === 'user' && String(message.content || '').trim())
      : null;
    if (item && item.titleMode === 'manual' && title) return title;
    if (firstUser && (!title || title === roleName || title === '新对话' || title === '新会话')) {
      return String(firstUser.content).replace(/\s+/g, ' ').trim().slice(0, 24) || '新会话';
    }
    if (!firstUser && (!title || title === roleName || title === '新对话' || title === '新会话')) {
      return '新会话';
    }
    return title || '新会话';
  }

  function characterSearchText(item) {
    const value = item || {};
    return [value.name, value.tagline, value.description, ...(Array.isArray(value.tags) ? value.tags : [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
  }

  function rebuildCharacterSearchIndex() {
    characterSearchIndex = new Map(characters.map((item) => [item.id, characterSearchText(item)]));
  }

  function characterMatches(item, needle) {
    if (!needle) return true;
    return (characterSearchIndex.get(item.id) || characterSearchText(item)).includes(needle);
  }

  function avatar(item, className) {
    const name = String((item && item.name) || '?').trim() || '?';
    const local = item && typeof item.avatar === 'string' && /^data:image\//i.test(item.avatar);
    return local
      ? `<span class="${className || 'tg-avatar'}"><img src="${esc(item.avatar)}" alt="" /></span>`
      : `<span class="${className || 'tg-avatar'} tg-avatar-initial">${esc(name.slice(0, 1).toUpperCase())}</span>`;
  }

  function restoreConversation(characterId) {
    const sessions = characterSessions(characterId);
    const ui = tangguanUi() || {};
    const preferred = sessions.find((item) => item.id === ui.lastConversationId);
    const conversation = preferred || sessions[0] || null;
    if (App.chat && App.chat.setActiveConversationId) App.chat.setActiveConversationId('tangguan', conversation ? conversation.id : null);
    setUiPointer(characterId, conversation && conversation.id);
    return conversation;
  }

  const EDITOR_SIGNATURE_FIELDS = Object.freeze([
    'name', 'tagline', 'description', 'personality', 'scenario',
    'firstMessage', 'greeting', 'starters', 'exampleDialogue',
    'systemPrompt', 'tags', 'matureAllowed',
  ]);

  // This runs for every editor input. Keep the signature limited to editable
  // fields so avatars and other card metadata never enter the keystroke path.
  function editorSignature() {
    const item = collectEditor();
    const snapshot = {};
    EDITOR_SIGNATURE_FIELDS.forEach((key) => { snapshot[key] = item[key]; });
    try { return JSON.stringify(snapshot); } catch (_) { return ''; }
  }

  function cloneEditorValue(value) {
    if (!value || typeof value !== 'object') return null;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  }

  function restoreEditorBase() {
    if (editorBase) {
      selected = cloneEditorValue(editorBase);
      selectedId = selected && selected.id || '';
    } else if (activeDrawer === 'editor') {
      selected = null;
      selectedId = '';
    }
  }

  function field(id, label, value, type) {
    const control = type === 'textarea'
      ? `<textarea id="${id}" rows="3">${esc(value)}</textarea>`
      : `<input id="${id}" type="text" value="${esc(value)}" autocomplete="off" />`;
    return `<label class="tg-field"><span>${label}</span>${control}</label>`;
  }

  function card(item) {
    const active = item.id === selectedId ? ' active' : '';
    const tags = (item.tags || []).slice(0, 3).map((tag) => `<span>${esc(tag)}</span>`).join('');
    const recentLabel = item.lastUsedAt ? '最近使用' : '尚未使用';
    // v1.1.8 R2（用户规格）：行1 = 头像+名称+操作；行2 = 标签（data-tg-recent 保留在 DOM 但视觉隐藏）
    return `<div class="tg-character-card lib-bar${active}" data-tg-select="${esc(item.id)}" role="button" tabindex="0">
      <div class="lib-bar-row1">
        ${avatar(item, 'lib-bar-icon tg-card-avatar')}
        <b class="lib-bar-name">${esc(item.name)}</b>
        <small data-tg-recent hidden>${recentLabel}</small>
        <span class="lib-bar-ops tg-card-actions"><button type="button" class="tg-card-action" data-tg-card-action data-tg-favorite="${esc(item.id)}" title="${item.favorite ? '取消收藏' : '收藏'}" aria-label="${item.favorite ? '取消收藏' : '收藏'}">${item.favorite ? '★' : '☆'}</button><button type="button" class="tg-card-action" data-tg-card-action data-tg-copy="${esc(item.id)}" title="复制角色卡" aria-label="复制角色卡">⧉</button><button type="button" class="tg-card-action danger" data-tg-card-action data-tg-delete-card="${esc(item.id)}" title="删除角色卡" aria-label="删除角色卡">×</button></span>
      </div>
      <div class="lib-bar-row2"><span class="tg-tags">${tags}</span></div>
    </div>`;
  }

  function characterListMarkup(items) {
    const visible = items.slice(0, characterVisibleCount);
    const rows = visible.length ? visible.map(card).join('') : '<div class="tg-empty">没有匹配角色。</div>';
    const more = items.length > visible.length
      ? '<button type="button" class="btn-ghost mini tg-character-more" data-tg-character-more>加载更多角色</button>'
      : '';
    return rows + more;
  }

  function renderCharacterList(query, target) {
    const list = target || $('tgCharacterList');
    if (!list) return;
    const needle = String(query || '').trim().toLowerCase();
    const items = characters.filter((item) => characterMatches(item, needle));
    characterListQuery = String(query || '');
    list.innerHTML = characterListMarkup(items);
  }

  function scheduleCharacterSearch(input, root) {
    if (characterSearchTimer) clearTimeout(characterSearchTimer);
    const query = input ? input.value : '';
    characterListQuery = String(query || '');
    characterVisibleCount = 50;
    characterSearchTimer = setTimeout(() => {
      characterSearchTimer = null;
      if (!input || !input.parentNode) return;
      const scope = input.closest('.tg-drawer') || root;
      const list = scope && scope.querySelector('#tgCharacterList, #tgDrawerCharacterList');
      renderCharacterList(query, list);
    }, 80);
  }

  function scheduleEditorDirtyCheck() {
    // Mark immediately so a click after typing cannot discard the draft. The
    // full editable-field comparison runs once after the input burst.
    editorDirty = true;
    if (editorDirtyTimer) clearTimeout(editorDirtyTimer);
    editorDirtyTimer = setTimeout(() => {
      editorDirtyTimer = null;
      if (activeDrawer === 'editor') editorDirty = editorSignature() !== editorSnapshot;
    }, 100);
  }

  function cancelEditorDirtyCheck() {
    if (editorDirtyTimer) { clearTimeout(editorDirtyTimer); editorDirtyTimer = null; }
  }

  function resetEditorBaseline() {
    // A character switch or a successful character-side write replaces the
    // editor document. Cancel the previous debounce before the old draft can
    // mark the newly rendered character as dirty again.
    cancelEditorDirtyCheck();
    editorDirty = false;
    editorBase = cloneEditorValue(selected);
    editorSnapshot = '';
  }

  function captureEditorBaseline() {
    if (activeDrawer === 'editor') editorSnapshot = editorSignature();
  }

  function editorHtml() {
    const item = selected || { name: '', tagline: '', description: '', personality: '', scenario: '', firstMessage: '', starters: [], exampleDialogue: '', systemPrompt: '', tags: [] };
    const tagText = (item.tags || []).join(', ');
    return `<div class="tg-editor-form">
      <section class="tg-editor-group is-open" data-tg-group="basic">
        <button type="button" class="tg-group-toggle" data-tg-group-toggle="basic" aria-expanded="true"><span>基础资料</span><span>⌃</span></button>
        <div class="tg-group-body" data-tg-group-body="basic">
          <div class="tg-form-grid">
            ${field('tgName', '名称', item.name)}
            ${field('tgTagline', 'Tagline', item.tagline)}
            ${field('tgDescription', '简介', item.description, 'textarea')}
            ${field('tgPersonality', '性格与行为', item.personality, 'textarea')}
            ${field('tgScenario', '场景设定', item.scenario, 'textarea')}
            ${field('tgFirstMessage', '开场白', item.firstMessage || item.greeting, 'textarea')}
            ${field('tgStarters', '快捷开场（每行一条）', (item.starters || []).join('\n'), 'textarea')}
          </div>
        </div>
      </section>
      <section class="tg-editor-group" data-tg-group="advanced">
        <button type="button" class="tg-group-toggle" data-tg-group-toggle="advanced" aria-expanded="false"><span>高级设定</span><span>⌄</span></button>
        <div class="tg-group-body" data-tg-group-body="advanced" hidden>
          <div class="tg-form-grid">
            ${field('tgExample', '示例对话', item.exampleDialogue, 'textarea')}
            ${field('tgTags', '标签', tagText)}
          </div>
        </div>
      </section>
      <section class="tg-editor-group" data-tg-group="quick">
        <button type="button" class="tg-group-toggle" data-tg-group-toggle="quick" aria-expanded="false"><span>快捷填写</span><span>⌄</span></button>
        <div class="tg-group-body" data-tg-group-body="quick" hidden>
          <div class="tg-ai-draft"><div class="tg-section-title">本地预设</div><div class="tg-preset-list">${presets.map((preset) => `<button type="button" class="btn-ghost mini tg-preset-option" data-tg-preset="${esc(preset.id)}"><b>${esc(preset.label)}</b>${preset.summary ? `<small>${esc(preset.summary)}</small>` : ''}</button>`).join('')}</div>
            <div class="tg-ai-row"><input id="tgBrief" type="text" placeholder="描述角色后生成草稿，确认前不会保存" autocomplete="off" /><button type="button" class="btn-ghost mini" data-tg-draft>AI 草稿</button></div><small id="tgDraftStatus"></small>
          </div>
        </div>
      </section>
    </div>`;
  }

  function memoryHtml() {
    if (!selected) return '<div class="tg-empty">保存角色后，可添加该角色专属世界书条目。</div>';
    const rows = memories.length ? memories.map((item) => `<div class="tg-memory-row"><div><b>${esc(item.title || '未命名条目')}</b><p>${esc(item.content)}</p><small>优先级 ${item.priority} · ${(item.tags || []).map(esc).join('、') || '无标签'}${item.enabled === false ? ' · 已停用' : ''}</small></div><div class="tg-memory-ops"><label class="mini-chk" title="启用后才会参与检索"><input type="checkbox" data-tg-memory-toggle="${esc(item.id)}" ${item.enabled === false ? '' : 'checked'} />启用</label><button type="button" class="icon-btn" title="删除" data-tg-memory-delete="${esc(item.id)}">×</button></div></div>`).join('') : '<div class="tg-empty">暂无世界书条目。只会检索当前角色的条目。</div>';
    return `<div class="tg-memory-list">${rows}</div>
      <div class="tg-memory-form"><input id="tgMemoryTitle" type="text" placeholder="条目标题" autocomplete="off" /><textarea id="tgMemoryContent" rows="2" placeholder="只写该角色需要知道的世界观、关系或长期事实"></textarea><div class="tg-memory-actions"><input id="tgMemoryTags" type="text" placeholder="标签，用逗号分隔" autocomplete="off" /><input id="tgMemoryPriority" type="number" min="0" max="100" value="60" title="优先级" /><button type="button" class="btn-ghost mini" data-tg-memory-save>添加条目</button><button type="button" class="btn-ghost mini" data-tg-memory-test>检索预览</button></div><div id="tgMemoryStatus" class="tg-status"></div></div>`;
  }

  function sessionHtml() {
    if (!selected) return '';
    const sessions = characterSessions(selected.id);
    if (sessionCharacterId !== selected.id) {
      sessionCharacterId = selected.id;
      sessionVisibleCount = 50;
    }
    const visibleSessions = sessions.slice(0, sessionVisibleCount);
    const rows = visibleSessions.length ? visibleSessions.map((item) => `<div class="tg-session-row">
      <button type="button" class="tg-session-open" data-tg-session-open="${esc(item.id)}"><b>${esc(sessionTitle(item))}</b><small>${(item.messages || []).length} 条消息</small></button>
      <div class="tg-session-actions"><button type="button" class="btn-ghost mini" data-tg-session-rename="${esc(item.id)}">重命名</button><button type="button" class="btn-ghost mini" data-tg-session-delete="${esc(item.id)}">删除</button><button type="button" class="btn-ghost mini" data-tg-session-clear="${esc(item.id)}">清空</button><button type="button" class="btn-ghost mini" data-tg-session-export="${esc(item.id)}">导出</button></div>
    </div>`).join('') : '<div class="tg-empty">还没有该角色的独立会话。</div>';
    const more = sessions.length > visibleSessions.length ? '<button type="button" class="btn-ghost mini tg-session-more" data-tg-session-more>加载更早会话</button>' : '';
    return `<section class="tg-sessions"><div class="tg-section-title">独立会话 <span>可重命名、删除、清空或导出</span></div><div class="tg-session-list">${rows}</div>${more}</section>`;
  }

  function libraryHtml() {
    const compact = arguments[0] && arguments[0].compact === true;
    if (!compact && libraryCollapsed && window.innerWidth > 900) {
      return `<div class="tg-library-collapsed" aria-label="角色库已收起">
        <button type="button" class="tg-library-collapse-btn" data-tg-library-toggle aria-label="展开角色库" title="展开角色库">☰</button>
        <button type="button" class="tg-library-collapsed-tab" data-tg-library-expand aria-label="展开角色库" title="角色库">角色</button>
        <button type="button" class="tg-library-collapsed-tab" data-tg-library-expand aria-label="展开会话栏" title="会话">会话</button>
      </div>`;
    }
    const search = $('tgDrawerLibrarySearch') || $('tgLibrarySearch');
    const query = String((search && search.value) || '').trim().toLowerCase();
    if (activeLibraryTab === 'sessions') {
      return `<div class="tg-library-head"><div><b>会话</b><small>${esc(selected ? selected.name : '未选择角色')}</small></div><span class="tg-library-head-actions"><button type="button" class="icon-btn tg-desktop-only" data-tg-library-toggle aria-label="收起角色库" title="收起角色库">‹</button><button type="button" class="icon-btn tg-mobile-only" data-tg-library-close aria-label="关闭">×</button></span></div>
        <div class="tg-library-tabs"><button type="button" data-tg-library-tab="characters">角色</button><button type="button" class="active" data-tg-library-tab="sessions">会话</button></div>
        <div class="tg-library-scroll">${sessionHtml() || '<div class="tg-empty">选择角色后查看会话。</div>'}</div>`;
    }
    const filtered = characters.filter((item) => {
      if (activeCharacterFilter === 'favorites' && !item.favorite) return false;
      if (activeCharacterFilter === 'recent' && !item.lastUsedAt) return false;
      return characterMatches(item, query);
    });
      const visibleCharacters = filtered.slice(0, characterVisibleCount);
      const moreCharacters = filtered.length > visibleCharacters.length
        ? '<button type="button" class="btn-ghost mini tg-character-more" data-tg-character-more>加载更多角色</button>' : '';
      return `<div class="tg-library-head"><div><b>角色库</b><small>角色卡与沉浸式会话</small></div><span class="tg-library-head-actions"><button type="button" class="icon-btn tg-desktop-only" data-tg-library-toggle aria-label="收起角色库" title="收起角色库">‹</button><button type="button" class="icon-btn tg-mobile-only" data-tg-library-close aria-label="关闭">×</button></span></div>
      <div class="tg-library-tabs"><button type="button" class="active" data-tg-library-tab="characters">角色</button><button type="button" data-tg-library-tab="sessions">会话</button></div>
      <label class="tg-library-search"><span>⌕</span><input id="${compact ? 'tgDrawerLibrarySearch' : 'tgLibrarySearch'}" data-tg-library-search type="search" placeholder="搜索角色" value="${esc(query)}" autocomplete="off" /></label>
      <div class="tg-library-filters"><button type="button" class="${activeCharacterFilter === 'all' ? 'active' : ''}" data-tg-character-filter="all">全部</button><button type="button" class="${activeCharacterFilter === 'favorites' ? 'active' : ''}" data-tg-character-filter="favorites">收藏</button><button type="button" class="${activeCharacterFilter === 'recent' ? 'active' : ''}" data-tg-character-filter="recent">最近</button></div>
       <div id="${compact ? 'tgDrawerCharacterList' : 'tgCharacterList'}" class="tg-character-list tg-library-scroll">${visibleCharacters.length ? visibleCharacters.map(card).join('') : '<div class="tg-empty">还没有匹配的角色。</div>'}${moreCharacters}</div>
      <div class="tg-library-footer"><button type="button" class="btn-ghost" data-tg-new>＋ 新建角色</button><button type="button" class="btn-ghost" data-tg-import>导入角色卡</button></div>`;
  }

  function characterHeaderHtml() {
    const sessions = selected ? characterSessions(selected.id) : [];
    const active = App.chat && App.chat.activeConv ? App.chat.activeConv() : null;
    const current = active && active.tangguanCharacterId === (selected && selected.id) ? active : null;
    const tagline = selected && (selected.tagline || selected.description) || '选择一个角色，开始一段沉浸式会话';
    return `<div class="tg-character-header">
      <div class="tg-character-identity">${avatar(selected, 'tg-header-avatar')}<div><h1>${esc(selected ? selected.name : '糖馆')}</h1><p>${esc(tagline)}</p></div></div>
      <div class="tg-header-actions"><button type="button" class="btn-ghost tg-mobile-only" data-tg-open-library>角色库</button><label class="tg-session-select"><span>会话</span><select id="tgSessionSelect" ${selected ? '' : 'disabled'}><option value="${current ? esc(current.id) : ''}">${current ? esc(sessionTitle(current)) : '新会话'}</option>${sessions.filter((item) => !current || item.id !== current.id).map((item) => `<option value="${esc(item.id)}">${esc(sessionTitle(item))}</option>`).join('')}</select></label><button type="button" class="btn-ghost" data-tg-new-session ${selected ? '' : 'disabled'}>新会话</button><button type="button" class="btn-ghost" data-tg-open-editor ${selected ? '' : 'disabled'}>编辑角色</button><button type="button" class="icon-btn" data-tg-open-sessions ${selected ? '' : 'disabled'} aria-label="打开会话">☰</button></div>
    </div>`;
  }

  function drawerHtml() {
    if (!activeDrawer) return '';
    if (activeDrawer === 'library') return `<div class="tg-drawer-top"><div><b>角色库</b><small>选择角色开始会话</small></div><button type="button" class="icon-btn" data-tg-close-drawer aria-label="关闭">×</button></div><div class="tg-drawer-body tg-drawer-library">${libraryHtml({ compact: true })}</div>`;
    if (activeDrawer === 'sessions') return `<div class="tg-drawer-top"><div><b>会话</b><small>${esc(selected ? selected.name : '')}</small></div><button type="button" class="icon-btn" data-tg-close-drawer aria-label="关闭">×</button></div><div class="tg-drawer-body">${sessionHtml()}</div>`;
    return `<div class="tg-drawer-top"><div><b>编辑角色</b><small>${esc(selected ? selected.name : '新角色')}</small></div><button type="button" class="icon-btn" data-tg-close-drawer aria-label="关闭">×</button></div><div class="tg-drawer-body"><div class="tg-editor-head"><p>角色卡只保存在本机，可导入或导出 JSON。</p><div class="tg-editor-actions"><button type="button" class="btn-ghost mini" data-tg-new>新建</button>${selected ? '<button type="button" class="btn-ghost mini" data-tg-export>导出</button><button type="button" class="btn-ghost mini danger" data-tg-delete>删除</button>' : ''}</div></div>${editorHtml()}<section class="tg-editor-group${worldbookExpanded ? ' is-open' : ''}" data-tg-group="worldbook"><button type="button" class="tg-group-toggle" data-tg-group-toggle="worldbook" aria-expanded="${worldbookExpanded}"><span>世界书</span><span>${worldbookExpanded ? '⌃' : '⌄'}</span></button><div class="tg-group-body" data-tg-group-body="worldbook"${worldbookExpanded ? '' : ' hidden'}>${memoryHtml()}${selected ? '<div class="tg-memory-import"><button type="button" class="btn-ghost mini" data-tg-worldbook-import>导入世界书 JSON</button><small>支持 worldbook、memories、entries 和 character_book.entries 格式。</small></div>' : ''}</div></section></div><div class="tg-drawer-footer"><button type="button" class="btn-ghost" data-tg-close-drawer>取消</button><button type="button" class="btn-primary" data-tg-save>保存角色</button></div>`;
  }

  function renderWelcome(welcome, conv) {
    if (!welcome) return;
    if (!selected) {
      welcome.innerHTML = `<div class="tg-empty-state"><div class="tg-empty-mark">馆</div><h2>从一个角色开始</h2><p>创建或导入角色卡，开始一段沉浸式会话。</p><div><button type="button" class="btn-primary" data-tg-open-editor>新建角色</button><button type="button" class="btn-ghost" data-tg-import>导入角色卡</button></div></div>`;
      return;
    }
    const greeting = selected.greeting || selected.firstMessage || '你好，今天想从哪里开始？';
    const starters = Array.isArray(selected.starters) ? selected.starters.slice(0, 4) : [];
    welcome.innerHTML = `<div class="tg-welcome-card">${avatar(selected, 'tg-welcome-avatar')}<h2>${esc(selected.name)}</h2><div class="tg-welcome-greeting">${esc(greeting)}</div>${starters.length ? `<div class="tg-starters">${starters.map((item) => `<button type="button" class="btn-ghost" data-tg-starter="${esc(item)}">${esc(item)}</button>`).join('')}</div>` : ''}</div>`;
  }

  function switchDrawer(kind) {
    if (kind === 'library') activeLibraryTab = 'characters';
    cancelEditorDirtyCheck();
    activeDrawer = kind;
    editorDirty = false;
    editorBase = kind === 'editor' ? cloneEditorValue(selected) : null;
    render();
    editorSnapshot = kind === 'editor' ? editorSignature() : '';
  }

  function openDrawer(kind) {
    if (!selected && !['editor', 'library'].includes(kind)) return;
    if (activeDrawer === kind) return;
    if (!activeDrawer) {
      switchDrawer(kind);
      return;
    }
    if (!editorDirty || activeDrawer !== 'editor') {
      switchDrawer(kind);
      return;
    }
    App.ui.showModal({
      title: '未保存修改',
      body: '<p>角色编辑器中有未保存内容，切换面板前请选择如何处理。</p>',
      buttons: [
        { label: '继续编辑', cls: 'btn-ghost' },
        { label: '放弃并切换', cls: 'btn-ghost danger' },
        { label: '保存并切换', cls: 'btn-primary' },
      ],
      onClose: (choice) => {
        if (choice === '放弃并切换') {
          restoreEditorBase();
          switchDrawer(kind);
        }
        if (choice === '保存并切换') {
          Promise.resolve(saveCharacter()).then(() => {
            if (!editorDirty) switchDrawer(kind);
          });
        }
      },
    });
  }

  function closeDrawer(force) {
    if (!activeDrawer) return;
    if (!force && editorDirty) {
      App.ui.showModal({
        title: '未保存修改',
        body: '<p>角色编辑器中有未保存内容。</p>',
        buttons: [{ label: '继续编辑', cls: 'btn-ghost' }, { label: '放弃修改', cls: 'btn-ghost danger' }, { label: '保存并关闭', cls: 'btn-primary' }],
        onClose: (choice) => {
          if (choice === '放弃修改') { restoreEditorBase(); editorDirty = false; closeDrawer(true); }
          if (choice === '保存并关闭') Promise.resolve(saveCharacter()).then(() => { if (!editorDirty) closeDrawer(true); });
        },
      });
      return;
    }
    activeDrawer = '';
    cancelEditorDirtyCheck();
    editorDirty = false;
    editorBase = null;
    render();
  }

  function render() {
    const renderStarted = App.perf && App.perf.begin ? App.perf.begin() : 0;
    const root = $('tangguanView');
    if (!root) return;
    if (selected) {
      const active = App.chat && App.chat.activeConv ? App.chat.activeConv() : null;
      if (!isValidSession(active, selected.id)) restoreConversation(selected.id);
    } else if (App.chat && App.chat.activeConversationId && App.chat.activeConversationId('tangguan')) {
      App.chat.setActiveConversationId('tangguan', null);
    }
    let shell = root.querySelector('.tg-shell');
    if (!shell) {
       root.innerHTML = `<div class="tg-shell"><div class="tg-workspace"><aside class="tg-library" id="tgLibrary"></aside><main class="tg-main"><div id="tgCharacterHeader"></div><div class="tg-chat-surface" id="tgChatSurface"></div></main><div class="tg-drawer-mask" data-tg-drawer-mask hidden></div><aside class="tg-drawer" id="tgDrawer" hidden></aside></div></div>`;
       shell = root.querySelector('.tg-shell');
     }
     const workspace = root.querySelector('.tg-workspace');
     const desktop = window.innerWidth > 900;
     if (workspace) workspace.classList.toggle('tg-library-is-collapsed', desktop && libraryCollapsed);
    const library = $('tgLibrary');
    const header = $('tgCharacterHeader');
    const drawer = $('tgDrawer');
    if (library) library.innerHTML = libraryHtml();
    if (header) header.innerHTML = characterHeaderHtml();
    if (drawer) {
      drawer.hidden = !activeDrawer;
      drawer.classList.toggle('tg-drawer-library-host', activeDrawer === 'library');
      drawer.innerHTML = drawerHtml();
    }
    const mask = root.querySelector('[data-tg-drawer-mask]');
    if (mask) mask.hidden = !activeDrawer;
    const surface = $('tgChatSurface');
    syncChatSurface(surface);
    if (App.ui && App.ui.syncModelSelect) App.ui.syncModelSelect();
    bind(root);
    if (!App.tangguan._resizeBound) {
      App.tangguan._resizeBound = true;
      window.addEventListener('resize', () => {
        if (App.state.view !== 'tangguan' || resizeFrame) return;
        resizeFrame = requestAnimationFrame(() => {
          resizeFrame = 0;
          const desktop = window.innerWidth > 900;
          if (desktop !== lastDesktopLayout) {
            lastDesktopLayout = desktop;
            render();
          }
        });
      });
    }
    lastDesktopLayout = desktop;
    if (App.perf) App.perf.measure('tangguanRenderMs', renderStarted, {
      desktop,
      characterCount: characters.length,
      selected: !!selected,
      drawer: activeDrawer || 'none',
    });
  }

  function syncChatSurface(surface) {
    if (!surface || !App.chat || !App.chat.mountSurface) return;
    const current = App.chat.surface && App.chat.surface();
    const conversationId = App.chat.activeConversationId ? App.chat.activeConversationId('tangguan') : null;
    const needsMount = !current
      || current.root !== surface
      || current.mode !== 'tangguan'
      || current.owner !== 'tangguan'
      || (current.conversationId || null) !== conversationId;
    if (!needsMount) {
      // setActiveConversationId updates the mounted surface pointer before
      // render() reaches this function. Re-render the shared message nodes so
      // switching characters or sessions cannot leave the previous transcript
      // visible in the new header.
      App.chat.renderMessages();
      return;
    }
    App.chat.mountSurface({ root: surface, conversationId, mode: 'tangguan', owner: 'tangguan' });
    if (App.chat.syncImgBtn) App.chat.syncImgBtn();
  }

  function collectEditor() {
    const valueOf = (id, fallback) => {
      const node = $(id);
      return node ? node.value : fallback;
    };
    const tags = String(valueOf('tgTags', (selected && selected.tags || []).join(', ')) || '').split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    return Object.assign({}, selected || {}, {
      name: String(valueOf('tgName', selected && selected.name || '') || '').trim(),
      tagline: String(valueOf('tgTagline', selected && selected.tagline || '') || '').trim(),
      tags,
      description: String(valueOf('tgDescription', selected && selected.description || '') || '').trim(),
      personality: String(valueOf('tgPersonality', selected && selected.personality || '') || '').trim(),
      scenario: String(valueOf('tgScenario', selected && selected.scenario || '') || '').trim(),
      firstMessage: String(valueOf('tgFirstMessage', selected && selected.firstMessage || '') || '').trim(),
      greeting: String(valueOf('tgFirstMessage', selected && (selected.greeting || selected.firstMessage) || '') || '').trim(),
      starters: String(valueOf('tgStarters', (selected && selected.starters || []).join('\n')) || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean).slice(0, 8),
      exampleDialogue: String(valueOf('tgExample', selected && selected.exampleDialogue || '') || '').trim(),
      // systemPrompt remains a compatible imported/runtime field; it is no
      // longer exposed as a duplicate editor control.
      systemPrompt: String(selected && selected.systemPrompt || '').trim(),
      matureAllowed: selected && selected.matureAllowed === true,
    });
  }

  function applyPreset(id) {
    const preset = presets.find((item) => item.id === id);
    if (!preset) return;
    selected = Object.assign({}, selected || {}, preset.patch);
    if (!selected.id) selected.id = 'draft_' + Date.now().toString(36);
    render();
    const status = $('tgDraftStatus');
    if (status) status.textContent = '已填入预设，确认内容后再保存。';
  }

  function parseDraft(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
    const value = String(raw || '').trim();
    if (!value) throw new Error('Empty JSON draft');
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Draft must be a JSON object');
    return parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed.character && typeof parsed.character === 'object' ? parsed.character : parsed;
  }

  function closeDraftPreview(modal) {
    if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
  }

  function showDraftPreview(raw, brief) {
    let draft;
    try { draft = parseDraft(raw); } catch (error) { App.ui.toast('AI draft was not valid JSON; nothing was saved.'); return; }
    draftBase = Object.assign({}, selected || {});
    const fields = ['name', 'tagline', 'description', 'personality', 'scenario', 'firstMessage', 'exampleDialogue', 'systemPrompt', 'tags'];
    const modal = document.createElement('div');
    modal.className = 'modal-mask';
    modal.innerHTML = `<div class="modal tg-draft-modal" role="dialog" aria-modal="true"><div class="modal-header"><span>AI character draft preview</span><button type="button" class="icon-btn" data-tg-draft-close aria-label="Close">×</button></div><div class="modal-body"><p class="tg-draft-notice">This draft is not saved. Review it, then confirm; generating it may consume provider credits.</p><div class="tg-draft-fields">${fields.map((key) => `<div class="tg-draft-field" data-draft-row="${key}"><div><b>${esc(key)}</b><pre data-draft-value>${esc(Array.isArray(draft[key]) ? draft[key].join(', ') : draft[key] == null ? '' : draft[key])}</pre></div><button type="button" class="btn-ghost mini" data-tg-regenerate="${key}">Regenerate field</button></div>`).join('')}</div></div><div class="modal-footer"><button type="button" class="btn-ghost" data-tg-draft-reset>Restore current</button><button type="button" class="btn-ghost" data-tg-draft-close>Cancel</button><button type="button" class="btn-primary" data-tg-draft-confirm>Use draft</button></div></div>`;
    document.body.appendChild(modal);
    const renderField = (key) => {
      const row = modal.querySelector(`[data-draft-row="${key}"] [data-draft-value]`);
      if (row) row.textContent = Array.isArray(draft[key]) ? draft[key].join(', ') : (draft[key] == null ? '' : String(draft[key]));
    };
    modal.querySelectorAll('[data-tg-draft-close]').forEach((button) => button.addEventListener('click', () => closeDraftPreview(modal)));
    modal.addEventListener('click', (event) => { if (event.target === modal) closeDraftPreview(modal); });
    modal.querySelector('[data-tg-draft-confirm]').addEventListener('click', () => {
      selected = Object.assign({}, selected || {}, draft);
      if (!selected.id) selected.id = 'draft_' + Date.now().toString(36);
      editorDirty = true;
      closeDraftPreview(modal);
      render();
      const status = $('tgDraftStatus');
      if (status) status.textContent = 'Draft applied for review; it is not saved until you click Save character.';
    });
    modal.querySelector('[data-tg-draft-reset]').addEventListener('click', () => {
      selected = Object.assign({}, draftBase || {});
      closeDraftPreview(modal);
      render();
    });
    modal.querySelectorAll('[data-tg-regenerate]').forEach((button) => button.addEventListener('click', async () => {
      const provider = App.getProvider('tangguan') || {};
      button.disabled = true;
      try {
        const response = await Promise.resolve(call('generateDraft', { ok: false }, { ref: provider.ref, model: provider.model, brief: `${brief}\nOnly improve this field: ${button.dataset.tgRegenerate}`, field: button.dataset.tgRegenerate }));
        if (!response || !response.ok) { App.ui.toast((response && response.error) || 'Field regeneration failed'); return; }
        const next = parseDraft(response.draft);
        if (Object.prototype.hasOwnProperty.call(next, button.dataset.tgRegenerate)) draft[button.dataset.tgRegenerate] = next[button.dataset.tgRegenerate];
        renderField(button.dataset.tgRegenerate);
      } catch (_) { App.ui.toast('Field regeneration returned invalid JSON; nothing was changed.'); }
      finally { button.disabled = false; }
    }));
  }

  async function saveCharacter() {
    const item = collectEditor();
    if (!item.name) { App.ui.toast('请填写角色名称'); return false; }
    const result = await Promise.resolve(call('saveCharacter', { ok: false }, { character: item, expectedRevision: revision }));
    if (!result || !result.ok) { App.ui.toast(result && result.code === 'tangguan_revision_conflict' ? '角色卡已被其他窗口修改，请重新载入' : '角色卡保存失败'); return false; }
    invalidateCharacterDetail(item.id);
    editorDirty = false;
    App.ui.toast('角色卡已保存');
    await loadCharacters(item.id, { refreshList: true });
    return true;
  }

  function runWithEditorGuard(action) {
    if (!editorDirty || activeDrawer !== 'editor') return Promise.resolve().then(action);
    return new Promise((resolve) => {
      App.ui.showModal({
        title: '未保存修改',
        body: '<p>角色编辑器中有未保存内容，继续此操作前请选择如何处理。</p>',
        buttons: [
          { label: '继续编辑', cls: 'btn-ghost' },
          { label: '放弃修改', cls: 'btn-ghost danger' },
          { label: '保存并继续', cls: 'btn-primary' },
        ],
        onClose: (choice) => {
          if (choice === '放弃修改') {
            restoreEditorBase();
            editorDirty = false;
            Promise.resolve().then(action).then(() => resolve(true), () => resolve(false));
            return;
          }
          if (choice === '保存并继续') {
            Promise.resolve(saveCharacter()).then((saved) => {
              if (!saved || editorDirty) { resolve(false); return; }
              Promise.resolve().then(action).then(() => resolve(true), () => resolve(false));
            }, () => resolve(false));
            return;
          }
          resolve(false);
        },
      });
    });
  }

  async function loadCharacters(preferredId, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const loadSequence = ++characterLoadSequence;
    const preferredKey = preferredId ? String(preferredId) : '';
    const canReuseList = preferredKey && !opts.refreshList && characters.some((item) => item && item.id === preferredKey);
    if (canReuseList) {
      selectedId = preferredKey;
      selected = characters.find((item) => item.id === selectedId) || null;
      const detail = await getCharacterDetail(selectedId);
      if (loadSequence !== characterLoadSequence) return false;
      if (detail && detail.ok) {
        selected = detail.character;
        memories = detail.memories || [];
        revision = Number(detail.revision) || revision;
        characterSearchIndex.set(selected.id, characterSearchText(selected));
      }
      restoreConversation(selectedId);
      resetEditorBaseline();
      render();
      captureEditorBaseline();
      return true;
    }
    let cursor = 0;
    let result = null;
    const all = [];
    do {
      result = await Promise.resolve(call('listCharacters', { ok: false, items: [] }, { cursor, limit: 50, summary: true }));
      if (loadSequence !== characterLoadSequence) return false;
      if (!result || !result.ok) break;
      all.push(...(result.items || []));
      cursor = result.nextCursor == null ? null : Number(result.nextCursor);
    } while (cursor != null && all.length < 200);
    characters = result && result.ok ? all : [];
    rebuildCharacterSearchIndex();
    revision = Number(result && result.revision) || revision;
    const ui = tangguanUi() || {};
    const hasCharacter = (id) => !!id && characters.some((item) => item.id === String(id));
    const explicit = hasCharacter(preferredId) ? String(preferredId) : '';
    const persisted = hasCharacter(ui.lastCharacterId) ? String(ui.lastCharacterId) : '';
    const fallback = characters.slice().sort((a, b) => Number(b.lastUsedAt || 0) - Number(a.lastUsedAt || 0))[0]
      || characters.find((item) => item.favorite) || characters[0];
    const currentId = selectedId && characters.some((item) => item.id === selectedId) ? selectedId : '';
    selectedId = explicit || persisted || (fallback && fallback.id) || currentId || '';
    selected = characters.find((item) => item.id === selectedId) || null;
    if (selected) {
      const detail = await getCharacterDetail(selected.id);
      if (loadSequence !== characterLoadSequence) return false;
      if (detail && detail.ok) { selected = detail.character; memories = detail.memories || []; revision = Number(detail.revision) || revision; }
      restoreConversation(selected.id);
      resetEditorBaseline();
    } else {
      memories = [];
      if (App.chat && App.chat.setActiveConversationId) App.chat.setActiveConversationId('tangguan', null);
      resetEditorBaseline();
      setUiPointer('', '');
    }
    if (!selected && ui.lastCharacterId) setUiPointer('', '');
    render();
    captureEditorBaseline();
    return true;
  }

  async function toggleFavorite(id) {
    const item = characters.find((entry) => entry.id === id);
    if (!item) return;
    const result = await Promise.resolve(call('toggleFavorite', { ok: false }, { id, favorite: !item.favorite, expectedRevision: revision }));
    if (!result || !result.ok) { App.ui.toast('收藏状态保存失败，请重新载入角色'); return; }
    invalidateCharacterDetail(id);
    revision = Number(result.revision) || revision;
    await loadCharacters(id, { refreshList: true });
  }

  async function cloneCharacter(id) {
    const result = await Promise.resolve(call('cloneCharacter', { ok: false }, { id, expectedRevision: revision }));
    if (!result || !result.ok) { App.ui.toast((result && result.error) || '复制角色卡失败'); return; }
    invalidateCharacterDetail(id);
    App.ui.toast('角色卡副本已创建');
    await loadCharacters(result.characterId, { refreshList: true });
  }

  async function saveMemory() {
    if (!selected) return;
    const content = (($('tgMemoryContent') && $('tgMemoryContent').value) || '').trim();
    if (!content) { App.ui.toast('请填写世界书内容'); return; }
    const result = await Promise.resolve(call('saveMemory', { ok: false }, { characterId: selected.id, expectedRevision: revision, memory: {
      title: (($('tgMemoryTitle') && $('tgMemoryTitle').value) || '').trim(), content,
      tags: (($('tgMemoryTags') && $('tgMemoryTags').value) || '').split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      priority: Number(($('tgMemoryPriority') && $('tgMemoryPriority').value) || 60), source: 'user', enabled: true,
    } }));
    if (!result || !result.ok) { App.ui.toast('世界书保存失败，请重新载入角色'); return; }
    invalidateCharacterDetail(selected.id);
    App.ui.toast('世界书条目已保存');
    await loadCharacters(selected.id, { refreshList: true });
  }

  async function deleteCharacter(id) {
    const target = characters.find((item) => item && item.id === String(id || ''));
    if (!target) return false;
    if (!window.confirm(`删除“${target.name || '未命名角色'}”及其世界书？该角色的历史会话会保留。`)) return false;
    const result = await Promise.resolve(call('deleteCharacter', { ok: false }, { id: target.id, expectedRevision: revision }));
    if (!result || !result.ok) {
      App.ui.toast((result && (result.error || result.code)) || '角色卡删除失败，原角色仍保留');
      return false;
    }
    invalidateCharacterDetail(target.id);
    setUiPointer('', '');
    if (selectedId === target.id) {
      selected = null;
      selectedId = '';
      memories = [];
      if (App.chat && App.chat.setActiveConversationId) App.chat.setActiveConversationId('tangguan', null);
      activeDrawer = '';
      editorDirty = false;
      editorBase = null;
    }
    revision = Number(result.revision) || revision;
    App.ui.toast('角色卡已删除，历史会话已保留');
    await loadCharacters();
    return true;
  }

  async function startSession() {
    if (!selected || !App.chat || !App.chat.newConversation) return;
    const used = await Promise.resolve(call('touchCharacter', { ok: false }, { id: selected.id, expectedRevision: revision }));
    if (used && used.ok) {
      revision = Number(used.revision) || revision;
      characters = Array.isArray(used.characters) ? used.characters : characters;
      selected = characters.find((item) => item.id === selected.id) || selected;
    }
    const conv = App.chat.newConversation(null, { stay: 'tangguan', tangguanCharacterId: selected.id, persist: false });
    if (!conv) return;
    conv.tangguanCharacterId = selected.id;
    conv.tangguanRestricted = true;
    conv.web = false;
    conv.allowWeb = false;
    conv.allowAttachments = false;
    conv.allowTools = false;
    conv.title = '新会话';
    conv.titleMode = 'auto';
    conv.systemPrompt = selected.systemPrompt || '';
    if (App.chat.setActiveConversationId) App.chat.setActiveConversationId('tangguan', conv.id);
    // Legacy snapshots used App.state.activeId = conv.id; module sessions now
    // keep this pointer in their own sidecar and never expose it to Chat.
    setUiPointer(selected.id, conv.id, { persist: false });
    App.chat.persistConversation(conv, { activeId: conv.id });
    render();
  }

  function findSession(id) {
    const source = App.chat && App.chat.conversationList
      ? App.chat.conversationList('tangguan')
      : (Array.isArray(App.state && App.state.conversations) ? App.state.conversations : []);
    return source
      .find((item) => item && item.id === String(id || '') && isValidSession(item, selected && selected.id));
  }

  async function renameSession(id) {
    const conv = findSession(id);
    if (!conv) return;
    const value = await App.ui.promptModal({ title: '重命名会话', label: '会话名称', value: conv.title || '', maxLength: 120 });
    if (value == null) return;
    const title = String(value).trim();
    if (!title) { App.ui.toast('会话名称不能为空'); return; }
    conv.title = title;
    conv.titleMode = 'manual';
    conv.updatedAt = Date.now();
    App.chat.persistConversation(conv);
    render();
  }

  function deleteSession(id) {
    const conv = findSession(id);
    if (!conv || !window.confirm('\u5220\u9664\u6b64\u4f1a\u8bdd\uff1f\u5220\u9664\u540e\u65e0\u6cd5\u6062\u590d\u3002')) return false;
    const activeId = App.chat.activeConversationId ? App.chat.activeConversationId('tangguan') : null;
    const result = App.chat.deleteConversation(conv.id, { owner: 'tangguan' });
    if (activeId === conv.id) setUiPointer(selected && selected.id, result && result.activeId ? result.activeId : '', { persist: false });
    render();
    return !!(result && result.ok !== false);
  }

  function clearSession(id) {
    const conv = findSession(id);
    if (!conv || !window.confirm('清空此会话的全部消息？此操作不可撤销。')) return;
    conv.messages = [];
    conv.updatedAt = Date.now();
    App.chat.persistConversation(conv);
    render();
  }

  function exportSession(id) {
    const conv = findSession(id);
    if (!conv || !App.ui || !App.ui._convToMarkdown) return;
    const markdown = App.ui._convToMarkdown(conv);
    const safeName = String(conv.title || 'tangguan-session').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeName || 'tangguan-session'}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    App.ui.toast('会话已导出');
  }

  function bind(root) {
    if (!root) return;
    const sessionHint = root.querySelector('.tg-sessions .tg-section-title span');
    if (sessionHint) sessionHint.textContent = '\u53ef\u91cd\u547d\u540d\u3001\u5220\u9664\u3001\u6e05\u7a7a\u6216\u5bfc\u51fa';
    // The header is rebuilt on every render, including after a provider/model
    // change. Rebind only the newly created selects while keeping delegated
    // workspace handlers single-bound.
    if (root.dataset.tgBound === '1') {
      if (App.ui && App.ui.bindModuleProvider) App.ui.bindModuleProvider(root, 'tangguan', () => render());
      return;
    }
    root.dataset.tgBound = '1';
    root.addEventListener('input', (event) => {
      const search = event.target.closest('[data-tg-library-search]');
      if (search) {
        scheduleCharacterSearch(search, root);
      }
      if (event.target.closest('.tg-editor-form')) {
        scheduleEditorDirtyCheck();
      }
    });
    root.addEventListener('change', (event) => {
      if (event.target.closest('.tg-editor-form')) scheduleEditorDirtyCheck();
    });
    root.addEventListener('click', async (event) => {
      const target = event.target;
      const select = target.closest('[data-tg-select]');
       if (select && !target.closest('[data-tg-card-action]')) {
         await runWithEditorGuard(async () => {
           await loadCharacters(select.dataset.tgSelect);
           if (activeDrawer === 'library') closeDrawer(true);
         });
         return;
       }
      const tab = target.closest('[data-tg-library-tab]');
      if (tab) { activeLibraryTab = tab.dataset.tgLibraryTab; render(); return; }
      const moreCharacters = target.closest('[data-tg-character-more]');
      if (moreCharacters) {
        characterVisibleCount += 50;
        const scope = moreCharacters.closest('.tg-drawer') || root;
        const list = scope.querySelector('#tgCharacterList, #tgDrawerCharacterList');
        const search = scope.querySelector('[data-tg-library-search]');
        renderCharacterList(search ? search.value : characterListQuery, list);
        return;
      }
      const filter = target.closest('[data-tg-character-filter]');
      if (filter) { activeCharacterFilter = filter.dataset.tgCharacterFilter; render(); return; }
      const preset = target.closest('[data-tg-preset]');
      if (preset) { applyPreset(preset.dataset.tgPreset); editorDirty = true; return; }
      const favorite = target.closest('[data-tg-favorite]');
      if (favorite) { event.stopPropagation(); await toggleFavorite(favorite.dataset.tgFavorite); return; }
      const copy = target.closest('[data-tg-copy]');
      if (copy) { event.stopPropagation(); await cloneCharacter(copy.dataset.tgCopy); return; }
      const deleteCard = target.closest('[data-tg-delete-card]');
      if (deleteCard) { event.stopPropagation(); await deleteCharacter(deleteCard.dataset.tgDeleteCard); return; }
      if (target.closest('[data-tg-open-library]')) { openDrawer('library'); return; }
      if (target.closest('[data-tg-library-toggle]')) {
        if (window.innerWidth > 900) { libraryCollapsed = !libraryCollapsed; render(); }
        return;
      }
      if (target.closest('[data-tg-library-expand]')) {
        if (window.innerWidth > 900) { libraryCollapsed = false; render(); }
        return;
      }
      if (target.closest('[data-tg-open-editor]')) { openDrawer('editor'); return; }
      if (target.closest('[data-tg-open-sessions]')) { if (window.innerWidth <= 900) openDrawer('sessions'); else { activeLibraryTab = 'sessions'; render(); } return; }
      if (target.closest('[data-tg-close-drawer], [data-tg-library-close], [data-tg-drawer-mask]')) { closeDrawer(); return; }
      const groupToggle = target.closest('[data-tg-group-toggle]');
      if (groupToggle) {
        const group = groupToggle.dataset.tgGroupToggle;
        const body = root.querySelector(`[data-tg-group-body="${group}"]`);
        if (body) body.hidden = !body.hidden;
        if (group === 'worldbook') worldbookExpanded = !!(body && !body.hidden);
        groupToggle.setAttribute('aria-expanded', String(body && !body.hidden));
        groupToggle.querySelector('span:last-child').textContent = body && !body.hidden ? '⌃' : '⌄';
        return;
      }
       if (target.closest('[data-tg-new], [data-tg-new-character]')) {
         await runWithEditorGuard(() => {
           selectedId = '';
           selected = null;
           memories = [];
           editorBase = null;
           activeDrawer = 'editor';
           if (App.chat && App.chat.setActiveConversationId) App.chat.setActiveConversationId('tangguan', null);
           setUiPointer('', '');
           editorDirty = false;
           editorSnapshot = '';
           render();
         });
         return;
       }
      const starter = target.closest('[data-tg-starter]');
      if (starter) {
        if (!App.chat.activeConv() || !App.chat.activeConv().tangguanCharacterId) await startSession();
        const input = document.getElementById('input');
        if (input) { input.value = starter.dataset.tgStarter || ''; App.chat.autoSize(); App.chat.updateSendEnabled(); input.focus(); }
        return;
      }
      if (target.closest('[data-tg-new-session]')) { await startSession(); return; }
      const sessionSelect = target.closest('#tgSessionSelect');
      if (sessionSelect) return;
      const sessionOpen = target.closest('[data-tg-session-open]');
      if (sessionOpen) {
        const conv = findSession(sessionOpen.dataset.tgSessionOpen);
        if (conv && App.chat && App.chat.activate) { App.chat.activate(conv.id, { stay: 'tangguan', persist: false, render: false }); setUiPointer(selected.id, conv.id); render(); }
        return;
      }
      const rename = target.closest('[data-tg-session-rename]'); if (rename) { await renameSession(rename.dataset.tgSessionRename); return; }
      const sessionDelete = target.closest('[data-tg-session-delete]'); if (sessionDelete) { deleteSession(sessionDelete.dataset.tgSessionDelete); return; }
      const clear = target.closest('[data-tg-session-clear]'); if (clear) { clearSession(clear.dataset.tgSessionClear); return; }
      const exportBtn = target.closest('[data-tg-session-export]'); if (exportBtn) { exportSession(exportBtn.dataset.tgSessionExport); return; }
      if (target.closest('[data-tg-session-more]')) { sessionVisibleCount += 50; render(); return; }
      if (target.closest('[data-tg-import]')) {
        const button = target.closest('[data-tg-import]'); button.disabled = true;
        try {
          const preview = await Promise.resolve(call('previewImport', { ok: false }, {}));
          if (!preview || !preview.ok) { if (!(preview && preview.canceled)) App.ui.toast((preview && preview.error) || '角色卡预览失败'); return; }
          const cardData = preview.character || {};
          const warning = (preview.warnings || []).join('\n');
          if (!window.confirm(`导入“${cardData.name || '未命名角色'}”及 ${(preview.memories || []).length} 条世界书？${warning ? `\n\n${warning}` : ''}`)) return;
          const result = await Promise.resolve(call('importCharacter', { ok: false }, { previewId: preview.previewId, expectedRevision: revision }));
          if (result && result.ok) { App.ui.toast('角色卡已导入'); await loadCharacters(result.characterId); }
          else App.ui.toast((result && result.error) || '角色卡导入失败');
        } finally { button.disabled = false; }
        return;
      }
      if (target.closest('[data-tg-save]')) { await saveCharacter(); return; }
      if (target.closest('[data-tg-export]') && selected) {
        const button = target.closest('[data-tg-export]'); button.disabled = true;
        try { const result = await Promise.resolve(call('exportCharacter', { ok: false }, { id: selected.id })); if (result && result.ok) App.ui.toast('角色卡已导出'); else if (!result || !result.canceled) App.ui.toast('角色卡导出失败'); } finally { button.disabled = false; }
        return;
      }
      if (target.closest('[data-tg-delete]') && selected) { await deleteCharacter(selected.id); return; }
      if (target.closest('[data-tg-draft]')) {
        const button = target.closest('[data-tg-draft]'); const brief = (($('tgBrief') && $('tgBrief').value) || '').trim();
        if (!brief) { App.ui.toast('请先描述你想要的角色'); return; }
        const provider = App.getProvider('tangguan') || {}; const status = $('tgDraftStatus'); button.disabled = true;
        if (status) status.textContent = '正在生成草稿，确认前不会写入角色卡。';
        try { const result = await Promise.resolve(call('generateDraft', { ok: false }, { ref: provider.ref, model: provider.model, brief })); if (!result || !result.ok) { if (status) status.textContent = (result && result.error) || 'AI 草稿生成失败'; return; } showDraftPreview(result.draft, brief); } finally { button.disabled = false; }
        return;
      }
      const memorySave = target.closest('[data-tg-memory-save]'); if (memorySave) { await saveMemory(); return; }
      const memoryDelete = target.closest('[data-tg-memory-delete]');
      if (memoryDelete && selected) { const result = await Promise.resolve(call('deleteMemory', { ok: false }, { characterId: selected.id, memoryId: memoryDelete.dataset.tgMemoryDelete, expectedRevision: revision })); if (result && result.ok) { invalidateCharacterDetail(selected.id); await loadCharacters(selected.id); } else App.ui.toast('世界书删除失败'); return; }
      const memoryToggle = target.closest('[data-tg-memory-toggle]');
      if (memoryToggle && selected) {
        // v1.1.7：启停世界书条目（upsert 更新 enabled）
        const item = memories.find((m) => m && m.id === memoryToggle.dataset.tgMemoryToggle);
        if (!item) return;
        const result = await Promise.resolve(call('saveMemory', { ok: false }, { characterId: selected.id, expectedRevision: revision, memory: Object.assign({}, item, { enabled: memoryToggle.checked }) }));
        if (!result || !result.ok) { App.ui.toast('世界书启停失败，请重新载入角色'); return; }
        invalidateCharacterDetail(selected.id);
        await loadCharacters(selected.id);
        return;
      }
      const memoryTest = target.closest('[data-tg-memory-test]');
      if (memoryTest && selected) { const query = window.prompt('输入要检索的内容'); if (!query) return; const result = await Promise.resolve(call('retrieveContext', { ok: false }, { characterId: selected.id, query, tokenBudget: 600, limit: 5 })); const status = $('tgMemoryStatus'); if (status) status.textContent = result && result.ok && result.items.length ? `命中 ${result.items.length} 条（${result.mode}）\n${result.context}` : '没有命中当前角色的世界书条目。'; return; }
      const worldbookImport = target.closest('[data-tg-worldbook-import]');
      if (worldbookImport && selected) {
        worldbookImport.disabled = true;
        try {
          const preview = await Promise.resolve(call('previewWorldbookImport', { ok: false }, { characterId: selected.id }));
          if (!preview || !preview.ok) {
            if (!(preview && preview.canceled)) {
              const details = [preview && preview.error].concat(preview && Array.isArray(preview.warnings) ? preview.warnings : []).filter(Boolean).join('\n');
              App.ui.toast(details || '世界书预览失败');
            }
            return;
          }
          const importCount = preview.count || (preview.memories || []).length;
          const sourceCount = Number(preview.sourceCount || importCount);
          const skippedCount = Number(preview.skippedCount || 0);
          const warningText = Array.isArray(preview.warnings) && preview.warnings.length
            ? `\n\n${preview.warnings.join('\n')}` : '';
          if (preview.canImport === false) {
            App.ui.toast((preview.warnings || []).join('\n') || '当前世界书不能导入');
            return;
          }
          const skippedText = skippedCount ? `，跳过 ${skippedCount} 条` : '';
          if (!window.confirm(`检测到 ${sourceCount} 条，实际导入 ${importCount} 条${skippedText}世界书到“${selected.name}”？${warningText}`)) return;
          const result = await Promise.resolve(call('importWorldbook', { ok: false }, { characterId: selected.id, previewId: preview.previewId, expectedRevision: revision }));
          if (result && result.ok) {
            App.ui.toast(`已导入 ${result.importedCount || preview.count || 0} 条世界书`);
            worldbookExpanded = true;
            invalidateCharacterDetail(selected.id);
            await loadCharacters(selected.id, { refreshList: true });
          } else App.ui.toast((result && result.error) || '世界书导入失败');
        } finally { worldbookImport.disabled = false; }
        return;
      }
   });
    root.addEventListener('change', (event) => {
      if (event.target.id === 'tgSessionSelect') {
        const conv = findSession(event.target.value);
        if (conv && App.chat) { App.chat.activate(conv.id, { stay: 'tangguan', persist: false, render: false }); setUiPointer(selected.id, conv.id); render(); }
      }
    });
    if (App.ui && App.ui.bindModuleProvider) App.ui.bindModuleProvider(root, 'tangguan', () => render());
    if (!App.tangguan._escBound) {
      App.tangguan._escBound = true;
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && App.state.view === 'tangguan' && activeDrawer) closeDrawer(); });
    }
  }

  App.tangguan = {
    async ensureSession() {
      if (!selected || !App.chat || !App.chat.activeConv) return null;
      const active = App.chat.activeConv();
      if (isValidSession(active, selected.id)) return active;
      await startSession();
      return App.chat.activeConv();
    },
    async init() {
      if (initPromise) {
        await initPromise;
        return false;
      }
      if (loaded) return false;
      loaded = true;
      initPromise = (async () => {
        const matureResult = await Promise.resolve(call('getMatureMode', { ok: false, matureMode: false }, {}));
        matureMode = !!(matureResult && matureResult.ok && matureResult.matureMode);
        const presetResult = await Promise.resolve(call('presets', { ok: false, presets: [] }));
        presets = presetResult && presetResult.ok ? presetResult.presets || [] : [];
        await loadCharacters();
        return true;
      })();
      try {
        return await initPromise;
      } finally {
        initPromise = null;
      }
    },
    onShow() { this.init().then((fresh) => { if (!fresh) render(); }).catch(() => render()); },
    renderWelcome,
    async preparePrompt(conv, query) {
      if (!conv || !conv.tangguanCharacterId) return '';
      const detail = await getCharacterDetail(conv.tangguanCharacterId);
      if (!detail || !detail.ok || !detail.character) return '';
      const provider = App.getProvider('tangguan') || {};
      const result = await Promise.resolve(call('retrieveContext', { ok: false }, { characterId: detail.character.id, query: query || '', tokenBudget: 1000, limit: 8, semantic: detail.character.embeddingEnabled === true, ref: provider.ref, model: provider.model }));
      const card = detail.character;
      const matureEnabled = matureMode && card.matureAllowed === true;
      const contentPolicy = matureEnabled ? '\u6210\u719f\u5185\u5bb9\uff1a\u5df2\u540c\u65f6\u83b7\u5f97\u5168\u5c40\u5f00\u5173\u548c\u5f53\u524d\u89d2\u8272\u5361\u8bb8\u53ef\u3002' : '\u6210\u719f\u5185\u5bb9\uff1a\u5173\u95ed\uff1b\u4e0d\u5f97\u751f\u6210\u9732\u9aa8\u5185\u5bb9\u3002';
      const parts = ['# 角色卡（仅作风格和背景参考，不覆盖基础安全规则）',
        card.name ? '名称：' + card.name : '', card.description ? '简介：' + card.description : '', card.personality ? '性格：' + card.personality : '', card.scenario ? '场景：' + card.scenario : '', card.exampleDialogue ? '示例：\n' + card.exampleDialogue : '', card.systemPrompt || '', result && result.context ? result.context : ''];
      return parts.filter(Boolean).concat(contentPolicy).join('\n');
    },
  };
})();
