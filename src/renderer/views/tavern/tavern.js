'use strict';

(function () {
  window.App = window.App || {};
  const $ = (id) => document.getElementById(id);
  const esc = (value) => App.escapeHtml(String(value == null ? '' : value));
  const call = (name, fallback, input) => {
    try {
      const fn = App.services.tavern && App.services.tavern[name];
      return fn ? fn(input) : fallback;
    } catch (_) { return fallback; }
  };
  // v1.2.1 批次 9：i18n 词条（tt = tavern translate；词典缺失时回落中文原词）
  const tt = (key, fallback) => (App.i18n && typeof App.i18n.t === 'function') ? App.i18n.t(key, fallback) : fallback;

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
  // 头像编辑覆盖：null=未改动；''=显式移除；dataURL=待保存新头像。随 collectEditor 进入签名/保存。
  let editorAvatarOverride = null;
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

  function tavernUi() {
    const settings = App.state && App.state.settings;
    if (!settings) return null;
    settings.tavernUi = settings.tavernUi && typeof settings.tavernUi === 'object'
      ? settings.tavernUi : { lastCharacterId: '', lastConversationId: '' };
    return settings.tavernUi;
  }

  // 世界书检索预算读取设置（settings.tavernUi），缺失/非法回退默认。
  // 必须是 IIFE 内的自由函数：preparePrompt 裸调 ragParams()，挂在 App.tavern 对象上会 ReferenceError
  // （v1.2.0 批次 4 曾因此让人设注入整体失败）。
  function ragParams() {
    const tu = (window.App.state && window.App.state.settings && window.App.state.settings.tavernUi) || {};
    const clamp = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
    return { tokenBudget: clamp(tu.ragTokenBudget, 1000, 128, 8000), limit: clamp(tu.ragLimit, 8, 1, 20) };
  }

  function setUiPointer(characterId, conversationId, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const ui = tavernUi();
    if (!ui) return;
    const nextCharacterId = characterId ? String(characterId) : '';
    const nextConversationId = conversationId ? String(conversationId) : '';
    if (ui.lastCharacterId === nextCharacterId && ui.lastConversationId === nextConversationId) return;
    ui.lastCharacterId = nextCharacterId;
    ui.lastConversationId = nextConversationId;
    if (opts.persist !== false) App.persist();
  }

  function isGroupConv(item) {
    return !!(item && Array.isArray(item.tavernCharacterIds) && item.tavernCharacterIds.length > 1);
  }

  // 展示过滤：单角色会话列表用。群聊由「群聊」tab 聚合展示，不混入单角色列表/头部下拉选项。
  function isValidSession(item, characterId) {
    if (isGroupConv(item)) return false;
    return !!(item
      && typeof item.id === 'string'
      && item.tavernCharacterId === String(characterId || '')
      && Array.isArray(item.messages)
      && item.messages.every((message) => message
        && typeof message === 'object'
        && (message.role === 'user' || message.role === 'assistant')
        && (message.content == null || typeof message.content === 'string')));
  }

  // 归属判定：指针恢复/校正用。群聊按首位角色归属；消息允许 system 沉默提示行（不出站给模型）。
  function belongsToCharacter(item, characterId) {
    if (!item || item.tavernCharacterId !== String(characterId || '')) return false;
    if (isGroupConv(item)) {
      return Array.isArray(item.messages) && item.messages.every((message) => message
        && typeof message === 'object'
        && (message.role === 'user' || message.role === 'assistant' || message.role === 'system')
        && (message.content == null || typeof message.content === 'string'));
    }
    return isValidSession(item, characterId);
  }

  function characterSessions(characterId) {
    const source = App.chat && App.chat.conversationList
      ? App.chat.conversationList('tavern')
      : (Array.isArray(App.state && App.state.conversations) ? App.state.conversations : []);
    return source
      .filter((item) => isValidSession(item, characterId))
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  }

  // 全部群聊会话（「群聊」tab 聚合视图数据源，跨角色、按更新时间倒序）
  function groupSessions() {
    const source = App.chat && App.chat.conversationList
      ? App.chat.conversationList('tavern')
      : (Array.isArray(App.state && App.state.conversations) ? App.state.conversations : []);
    return source
      .filter(isGroupConv)
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

  function restoreConversation(characterId, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const ui = tavernUi() || {};
    const source = App.chat && App.chat.conversationList
      ? App.chat.conversationList('tavern')
      : (Array.isArray(App.state && App.state.conversations) ? App.state.conversations : []);
    // 用归属判定而非 characterSessions：群聊会话归属首位角色，指针指向群聊时可恢复。
    // personalOnly（点击角色卡进入个人会话）时排除群聊——用户点个人角色不应被带进群聊（2026-08-26 反馈）；
    // 默认路径（启动恢复/建群跳转）仍遵循指针。
    let pool = source.filter((item) => belongsToCharacter(item, characterId));
    if (opts.personalOnly) pool = pool.filter((item) => !isGroupConv(item));
    pool.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    const preferred = pool.find((item) => item.id === ui.lastConversationId);
    const conversation = preferred || pool[0] || null;
    if (App.chat && App.chat.setActiveConversationId) App.chat.setActiveConversationId('tavern', conversation ? conversation.id : null);
    setUiPointer(characterId, conversation && conversation.id);
    return conversation;
  }

  // 群聊单成员轮次后处理：显式 [SILENCE]/[沉默] 转「沉默了」提示行；无产物/异常/空结果保持失败可见
  // （报错与沉默严格分离，2026-08-26 用户裁决）；正常发言自动署名前缀。
  // runGroupTurn 每成员轮与「重新生成」的单成员重跑共用。返回值：本轮产物消息（可能已被替换/清除）。
  function applyMemberTurnResult(conv, memberId, memberName, turnStart) {
    const produced = conv.messages.slice(turnStart).filter((m) => m && m.role === 'assistant');
    const last = produced[produced.length - 1];
    const rerender = () => { if (typeof window.App.chat.renderMessages === 'function') window.App.chat.renderMessages(); };
    const text = last ? String(last.content || '').trim() : '';
    const explicitSilence = !!last && !last.error && last.streamStatus !== 'failed'
      && (text.toLowerCase() === '[silence]' || text === '[沉默]');
    if (explicitSilence) {
      // 沉默不静默：原位留一条居中提示行（role:'system'，出站给模型前会被过滤）
      const i = conv.messages.indexOf(last);
      const notice = { role: 'system', content: '「' + memberName + '」沉默了', characterId: memberId, ts: Date.now() };
      if (i >= 0) conv.messages.splice(i, 1, notice); else conv.messages.push(notice);
      rerender();
      return null;
    }
    if (!last) {
      conv.messages.push({
        id: (window.App && window.App.uid ? window.App.uid() : 'm' + Date.now().toString(36)),
        role: 'assistant', content: '⚠️ 成员「' + memberName + '」未返回发言', think: '',
        streamStatus: 'failed', error: 'member_no_output', characterId: memberId,
      });
      rerender();
      return null;
    }
    if (!text || last.error || last.streamStatus === 'failed') {
      // 失败/空结果：保持失败态可见（saveAnswer 已写入可读文案与 error），仅补齐兜底字段
      last.streamStatus = 'failed';
      last.error = last.error || 'empty_reply';
      if (!String(last.content || '').trim()) last.content = '⚠️ 成员「' + memberName + '」本轮没有可用发言';
      last.characterId = memberId;
      rerender();
      return last;
    }
    // 正常发言：自动署名前缀
    if (!text.startsWith(memberName + '：') && !text.startsWith(memberName + ':')) {
      last.content = memberName + '：' + last.content;
    }
    last.characterId = memberId;
    rerender();
    return last;
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
    editorAvatarOverride = null;
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
    // 高亮跟随当前查看会话的归属角色（跨角色会话/群聊切换时左栏与主对话一致，2026-08-26）；selected 仅服务编辑器/头部
    const focusConv = App.chat && App.chat.activeConv ? App.chat.activeConv() : null;
    const focusCharId = String((focusConv && focusConv.tavernCharacterId) || selectedId || '');
    const active = item.id === focusCharId ? ' active' : '';
    const tags = (item.tags || []).slice(0, 3).map((tag) => `<span>${esc(tag)}</span>`).join('');
    const recentLabel = item.lastUsedAt ? '最近使用' : '尚未使用';
    // v1.1.8 R2（用户规格）：行1 = 头像+名称+操作；行2 = 标签（data-tg-recent 保留在 DOM 但视觉隐藏）
    // v1.2.0：卡片可拖拽排序（把手触发；data-tg-card-action 防把手点击误选角色）
    return `<div class="tg-character-card lib-bar${active}" data-tg-select="${esc(item.id)}" role="button" tabindex="0" draggable="true">
      <div class="lib-bar-row1">
      <span class="drag-handle" title="拖拽排序" data-tg-card-action="drag">⠿</span>
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

  // v1.2.0：角色卡拖拽排序——仅「全部」筛选且无搜索时允许（此时 DOM 顺序即完整期望顺序）
  function bindCharacterDrag(listEl) {
    const list = listEl || $('tgCharacterList') || $('tgDrawerCharacterList');
    if (!list || !App.ui || typeof App.ui.bindModuleDrag !== 'function') return;
    const liveQuery = String(($('tgLibrarySearch') && $('tgLibrarySearch').value) || ($('tgDrawerLibrarySearch') && $('tgDrawerLibrarySearch').value) || '').trim();
    if (activeCharacterFilter !== 'all' || liveQuery) { delete list._dragBound; return; }
    App.ui.bindModuleDrag(list, onCharacterReorder, '.tg-character-card');
  }
  async function onCharacterReorder() {
    const list = $('tgCharacterList') || $('tgDrawerCharacterList');
    if (!list) return;
    const visibleIds = Array.from(list.querySelectorAll('.tg-character-card')).map((el) => el.dataset.tgSelect).filter(Boolean);
    if (!visibleIds.length) return;
    // 提交完整期望顺序：可见部分按拖后 DOM 序，未展示的（分页未加载项）按原相对序接在后面
    const inVisible = new Set(visibleIds);
    const orderedIds = visibleIds.concat(characters.map((c) => c.id).filter((id) => !inVisible.has(id)));
    const result = await Promise.resolve(call('reorderCharacters', { ok: false }, { orderedIds, expectedRevision: revision }));
    if (result && result.ok) {
      revision = Number(result.revision) || revision;
      const byId = new Map(characters.map((c) => [c.id, c]));
      characters = orderedIds.map((id) => byId.get(id)).filter(Boolean);
      render();
    } else if (result && result.code === 'tavern_revision_conflict') {
      App.ui.toast('角色列表已被其他操作更新，正在重新载入');
      await loadCharacters(selectedId, { refreshList: true });
    } else {
      App.ui.toast((result && (result.error || result.code)) || '排序保存失败');
      render();
    }
  }

  function renderCharacterList(query, target) {
    const list = target || $('tgCharacterList');
    if (!list) return;
    const needle = String(query || '').trim().toLowerCase();
    const items = characters.filter((item) => characterMatches(item, needle));
    characterListQuery = String(query || '');
    list.innerHTML = characterListMarkup(items);
    bindCharacterDrag(list);
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
    editorAvatarOverride = null;
  }

  function captureEditorBaseline() {
    if (activeDrawer === 'editor') editorSnapshot = editorSignature();
  }

  function editorHtml() {
    const item = selected || { name: '', tagline: '', description: '', personality: '', scenario: '', firstMessage: '', starters: [], exampleDialogue: '', systemPrompt: '', tags: [] };
    const tagText = (item.tags || []).join(', ');
    // 头像预览：优先显示待保存覆盖（含显式移除后的首字母态），否则当前头像
    const avatarShown = editorAvatarOverride !== null ? editorAvatarOverride : String(item.avatar || '');
    const avatarInner = avatarShown && /^data:image\//i.test(avatarShown)
      ? `<img src="${esc(avatarShown)}" alt="" />`
      : esc(String(item.name || '?').trim().slice(0, 1).toUpperCase() || '?');
    const avatarBlock = `<div class="tg-avatar-editor">
      <span class="tg-avatar tg-avatar-editor-preview">${avatarInner}</span>
      <div class="tg-avatar-editor-actions">
        <div><button type="button" class="btn-ghost mini" data-tg-avatar-pick>更换头像</button><button type="button" class="btn-ghost mini" data-tg-avatar-clear ${avatarShown ? '' : 'disabled'}>移除</button></div>
        <small>支持本地图片，自动压缩至 128px，保存角色后生效</small>
      </div>
      <input id="tgAvatarInput" type="file" accept="image/*" hidden />
    </div>`;
    return `<div class="tg-editor-form">
      <section class="tg-editor-group is-open" data-tg-group="basic">
        <button type="button" class="tg-group-toggle" data-tg-group-toggle="basic" aria-expanded="true"><span>基础资料</span><span>⌃</span></button>
        <div class="tg-group-body" data-tg-group-body="basic">
          ${avatarBlock}
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
    // 会话 tab 聚合全部角色的个人会话，逐行标注所属角色（2026-08-26 用户反馈）；群聊在「群聊」tab
    const source = App.chat && App.chat.conversationList
      ? App.chat.conversationList('tavern')
      : (Array.isArray(App.state && App.state.conversations) ? App.state.conversations : []);
    const sessions = source.filter((item) => !isGroupConv(item))
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    if (sessionCharacterId !== '__all__') {
      sessionCharacterId = '__all__';
      sessionVisibleCount = 50;
    }
    const nameOf = (id) => { const c = (characters || []).find((item) => item && item.id === id); return (c && c.name) || '已删除的角色'; };
    const visibleSessions = sessions.slice(0, sessionVisibleCount);
    const activeConvId = App.chat && App.chat.activeConversationId ? App.chat.activeConversationId('tavern') : null;
    const rows = visibleSessions.length ? visibleSessions.map((item) => {
      const isActive = item.id === activeConvId;
      return `<div class="tg-session-row${isActive ? ' active' : ''}">
      <button type="button" class="tg-session-open" data-tg-session-open="${esc(item.id)}"><b>${esc(sessionTitle(item))}</b><small>与「${esc(nameOf(item.tavernCharacterId))}」的会话 · ${(item.messages || []).length} 条消息</small></button>
      <div class="tg-session-actions"><button type="button" class="btn-ghost mini" data-tg-session-rename="${esc(item.id)}">重命名</button><button type="button" class="btn-ghost mini" data-tg-session-delete="${esc(item.id)}">删除</button><button type="button" class="btn-ghost mini" data-tg-session-clear="${esc(item.id)}">清空</button><button type="button" class="btn-ghost mini" data-tg-session-export="${esc(item.id)}">导出</button></div>
    </div>`;
    }).join('') : '<div class="tg-empty">还没有会话。从「角色」tab 选择角色开始对话。</div>';
    const more = sessions.length > visibleSessions.length ? '<button type="button" class="btn-ghost mini tg-session-more" data-tg-session-more>加载更早会话</button>' : '';
    // 精简信息层级：列表内不再重复 tab 头部的职责说明（2026-08-26）
    return `<section class="tg-sessions"><div class="tg-session-list">${rows}</div>${more}</section>`;
  }

  // 「群聊」tab 聚合视图：跨角色列出全部群聊会话（与单角色会话彻底分离）
  function groupHtml() {
    const groups = groupSessions();
    const nameOf = (id) => { const c = (characters || []).find((item) => item && item.id === id); return (c && c.name) || '未知角色'; };
    const activeConvId = App.chat && App.chat.activeConversationId ? App.chat.activeConversationId('tavern') : null;
    const rows = groups.length ? groups.map((item) => {
      const members = (item.tavernCharacterIds || []).map(nameOf).join('、');
      const count = (item.messages || []).filter((m) => m && m.role !== 'system').length;
      const isActive = item.id === activeConvId;
      return `<div class="tg-session-row${isActive ? ' active' : ''}">
        <button type="button" class="tg-session-open" data-tg-group-open="${esc(item.id)}"><b>${esc(String(item.title || '群聊'))}</b><small>${esc(members)} · ${count} 条消息</small></button>
        <div class="tg-session-actions"><button type="button" class="btn-ghost mini" data-tg-group-delete="${esc(item.id)}">删除</button></div>
      </div>`;
    }).join('') : '<div class="tg-empty">还没有群聊。点击下方「＋ 新建群聊」，勾选两个以上角色即可开始。</div>';
    // 精简信息层级：列表内不再重复 tab 头部的职责说明（2026-08-26）
    return `<section class="tg-sessions"><div class="tg-session-list">${rows}</div></section>`;
  }

  function libraryHtml() {
    const compact = arguments[0] && arguments[0].compact === true;
    if (!compact && libraryCollapsed && window.innerWidth > 900) {
      return `<div class="tg-library-collapsed" aria-label="角色库已收起">
        <button type="button" class="tg-library-collapse-btn" data-tg-library-toggle aria-label="展开角色库" title="展开角色库"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        <button type="button" class="tg-library-collapsed-tab" data-tg-library-expand aria-label="展开角色库" title="角色库">角色</button>
        <button type="button" class="tg-library-collapsed-tab" data-tg-library-expand aria-label="展开会话栏" title="会话">${esc(tt('tg.libraryExpand', '会话'))}</button>
      </div>`;
    }
    const tabsRow = (activeTab) => `<div class="tg-library-tabs"><button type="button" class="${activeTab === 'characters' ? 'active' : ''}" data-tg-library-tab="characters">${esc(tt('tg.tab.characters', '角色'))}</button><button type="button" class="${activeTab === 'sessions' ? 'active' : ''}" data-tg-library-tab="sessions">${esc(tt('tg.tab.sessions', '会话'))}</button><button type="button" class="${activeTab === 'groups' ? 'active' : ''}" data-tg-library-tab="groups">${esc(tt('tg.tab.groups', '群聊'))}</button></div>`;
    const headActions = `<span class="tg-library-head-actions"><button type="button" class="icon-btn tg-desktop-only" data-tg-library-toggle aria-label="收起角色库" title="收起角色库"><svg viewBox="0 0 24 24" width="16" height="16"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button type="button" class="icon-btn tg-mobile-only" data-tg-library-close aria-label="关闭">×</button></span>`;
    // v1.2.0：操作按钮在角色/会话/群聊三 tab 统一渲染；点击走视图根节点委托，无需新增绑定
    // v1.2.1 批次 8：加「导出全部」（整库角色卡合集 JSON，可重导入）
    const libraryFooter = `<div class="tg-library-footer"><button type="button" class="btn-ghost" data-tg-new>${esc(tt('tg.new', '＋ 新建角色'))}</button><button type="button" class="btn-ghost" data-tg-new-group>${esc(tt('tg.newGroup', '＋ 新建群聊'))}</button><button type="button" class="btn-ghost" data-tg-import>${esc(tt('tg.import', '导入角色卡'))}</button><button type="button" class="btn-ghost" data-tg-export-all>${esc(tt('tg.exportAll', '导出全部'))}</button></div>`;
    const search = $('tgDrawerLibrarySearch') || $('tgLibrarySearch');
    const query = String((search && search.value) || '').trim().toLowerCase();
    if (activeLibraryTab === 'groups') {
      const groups = groupSessions();
      return `<div class="tg-library-head"><div><b>群聊</b><small>${groups.length ? groups.length + ' 个群聊 · 多角色轮流发言' : '多角色轮流发言'}</small></div>${headActions}</div>
        ${tabsRow('groups')}
        <div class="tg-library-scroll">${groupHtml()}</div>${libraryFooter}`;
    }
    if (activeLibraryTab === 'sessions') {
      const totalSessions = ((App.chat && App.chat.conversationList ? App.chat.conversationList('tavern') : []) || []).filter((item) => !isGroupConv(item)).length;
      return `<div class="tg-library-head"><div><b>会话</b><small>${totalSessions ? '全部对话记录 · ' + totalSessions + ' 条' : '全部对话记录 · 已标注所属角色'}</small></div>${headActions}</div>
        ${tabsRow('sessions')}
        <div class="tg-library-scroll">${sessionHtml() || '<div class="tg-empty">还没有会话。</div>'}</div>${libraryFooter}`;
    }
    const filtered = characters.filter((item) => {
      if (activeCharacterFilter === 'favorites' && !item.favorite) return false;
      if (activeCharacterFilter === 'recent' && !item.lastUsedAt) return false;
      return characterMatches(item, query);
    });
      const visibleCharacters = filtered.slice(0, characterVisibleCount);
      const moreCharacters = filtered.length > visibleCharacters.length
        ? '<button type="button" class="btn-ghost mini tg-character-more" data-tg-character-more>加载更多角色</button>' : '';
      return `<div class="tg-library-head"><div><b>角色库</b><small>管理角色卡与导入</small></div>${headActions}</div>
      ${tabsRow('characters')}
      <label class="tg-library-search"><span>⌕</span><input id="${compact ? 'tgDrawerLibrarySearch' : 'tgLibrarySearch'}" data-tg-library-search type="search" placeholder="搜索角色" value="${esc(query)}" autocomplete="off" /></label>
      <div class="tg-library-filters"><button type="button" class="${activeCharacterFilter === 'all' ? 'active' : ''}" data-tg-character-filter="all">全部</button><button type="button" class="${activeCharacterFilter === 'favorites' ? 'active' : ''}" data-tg-character-filter="favorites">收藏</button><button type="button" class="${activeCharacterFilter === 'recent' ? 'active' : ''}" data-tg-character-filter="recent">最近</button></div>
       <div id="${compact ? 'tgDrawerCharacterList' : 'tgCharacterList'}" class="tg-character-list tg-library-scroll">${visibleCharacters.length ? visibleCharacters.map(card).join('') : '<div class="tg-empty">还没有匹配的角色。</div>'}${moreCharacters}</div>
      ${libraryFooter}`;
  }

  function characterHeaderHtml() {
    const active = App.chat && App.chat.activeConv ? App.chat.activeConv() : null;
    // 群聊激活时渲染群聊身份块（标题+成员行），不再显示首位角色的个人信息（2026-08-26 用户反馈）
    if (active && isGroupConv(active)) {
      const memberIds = Array.isArray(active.tavernCharacterIds) ? active.tavernCharacterIds : [];
      const nameOf = (id) => { const c = (characters || []).find((item) => item && item.id === id); return (c && c.name) || '未知角色'; };
      const initials = memberIds.slice(0, 4).map((id) => '<span class="tg-header-avatar tg-avatar-initial">' + esc(String(nameOf(id)).slice(0, 1)) + '</span>').join('');
      const subtitle = memberIds.map(nameOf).join('、') + ' · 轮流发言，可沉默';
      return `<div class="tg-character-header">
      <div class="tg-character-identity"><span class="tg-header-avatar-stack">${initials}</span><div><span class="tg-mode-badge tg-mode-group">群聊</span><h1>${esc(active.title || '群聊')}</h1><p>${esc(subtitle)}</p></div></div>
      <div class="tg-header-actions"><button type="button" class="btn-ghost tg-mobile-only" data-tg-open-library>角色库</button><button type="button" class="btn-ghost" data-tg-new-session>新会话</button></div>
    </div>`;
    }
    const sessions = selected ? characterSessions(selected.id) : [];
    const current = active && active.tavernCharacterId === (selected && selected.id) ? active : null;
    const tagline = selected && (selected.tagline || selected.description) || '选择一个角色，开始一段沉浸式会话';
    return `<div class="tg-character-header">
      <div class="tg-character-identity">${avatar(selected, 'tg-header-avatar')}<div><span class="tg-mode-badge">个人会话</span><h1>${esc(selected ? selected.name : '糖馆')}</h1><p>${esc(tagline)}</p></div></div>
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
    // 群聊空会话：渲染群聊欢迎卡，绝不显示首位角色的个人开场词（2026-08-26 用户反馈）
    if (conv && Array.isArray(conv.tavernCharacterIds) && conv.tavernCharacterIds.length > 1) {
      const nameOf = (id) => { const c = (characters || []).find((item) => item && item.id === id); return (c && c.name) || '未知角色'; };
      const initials = conv.tavernCharacterIds.slice(0, 4).map((id) => '<span class="tg-header-avatar tg-avatar-initial">' + esc(String(nameOf(id)).slice(0, 1)) + '</span>').join('');
      welcome.innerHTML = `<div class="tg-welcome-card"><div class="tg-header-avatar-stack">${initials}</div><h2>${esc(conv.title || '群聊')}</h2><div class="tg-welcome-greeting">${esc(conv.tavernCharacterIds.map(nameOf).join('、'))}</div><p>直接输入即可开始；成员轮流发言，模型可回复 [SILENCE] 沉默跳过。</p></div>`;
      return;
    }
    if (!selected) {
      welcome.innerHTML = `<div class="tg-empty-state"><div class="tg-empty-mark">馆</div><h2>${esc(tt('tg.emptyTitle', '从一个角色开始'))}</h2><p>${esc(tt('tg.emptyDesc', '创建或导入角色卡，开始一段沉浸式会话。'))}</p><div><button type="button" class="btn-primary" data-tg-open-editor>${esc(tt('tg.emptyNew', '新建角色'))}</button><button type="button" class="btn-ghost" data-tg-import>${esc(tt('tg.emptyImport', '导入角色卡'))}</button></div></div>`;
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
    editorAvatarOverride = null;
    editorBase = kind === 'editor' ? cloneEditorValue(selected) : null;
    render();
    if (kind === 'editor') startEditorFocusKeeper();
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
    stopEditorFocusKeeper();
    render();
  }

  // v1.2.1（批次 2）：编辑器焦点守护——render() 整体重建抽屉，异步回流（如 loadCharacters /
  // 抽屉切换）会把刚聚焦的 tgName 节点换掉，焦点掉回 BODY（探针实测：新建后 600~1500ms 偶发）。
  // 保护窗口内仅当焦点掉回 body 时把焦点还给 tgName，绝不抢用户主动聚焦的其他元素。
  let editorFocusKeeperTimer = null;
  function startEditorFocusKeeper() {
    stopEditorFocusKeeper();
    const until = Date.now() + 3000;
    editorFocusKeeperTimer = setInterval(() => {
      if (activeDrawer !== 'editor' || Date.now() > until) { stopEditorFocusKeeper(); return; }
      const el = document.getElementById('tgName');
      if (!el) return;
      if (document.activeElement === document.body || document.activeElement === document.documentElement) {
        try { el.focus(); } catch (_) {}
      }
    }, 250);
  }
  function stopEditorFocusKeeper() {
    if (editorFocusKeeperTimer) { clearInterval(editorFocusKeeperTimer); editorFocusKeeperTimer = null; }
  }

  function render() {
    const renderStarted = App.perf && App.perf.begin ? App.perf.begin() : 0;
    const root = $('tavernView');
    if (!root) return;
    if (selected) {
      const active = App.chat && App.chat.activeConv ? App.chat.activeConv() : null;
      // 归属判定（含群聊）：否则打开群聊后任何 render 都会把会话顶回单角色旧会话
      if (!belongsToCharacter(active, selected.id)) restoreConversation(selected.id);
    } else if (App.chat && App.chat.activeConversationId && App.chat.activeConversationId('tavern')) {
      App.chat.setActiveConversationId('tavern', null);
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
    bindCharacterDrag($('tgCharacterList') || $('tgDrawerCharacterList'));
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
    if (!App.tavern._resizeBound) {
      App.tavern._resizeBound = true;
      window.addEventListener('resize', () => {
        if (App.state.view !== 'tavern' || resizeFrame) return;
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
    if (App.perf) App.perf.measure('tavernRenderMs', renderStarted, {
      desktop,
      characterCount: characters.length,
      selected: !!selected,
      drawer: activeDrawer || 'none',
    });
  }

  function syncChatSurface(surface) {
    if (!surface || !App.chat || !App.chat.mountSurface) return;
    // 群聊专属背景：随当前会话切换（单聊移除）
    const activeForSurface = App.chat.activeConv ? App.chat.activeConv() : null;
    surface.classList.toggle('is-group', isGroupConv(activeForSurface));
    const current = App.chat.surface && App.chat.surface();
    const conversationId = App.chat.activeConversationId ? App.chat.activeConversationId('tavern') : null;
    const needsMount = !current
      || current.root !== surface
      || current.mode !== 'tavern'
      || current.owner !== 'tavern'
      || (current.conversationId || null) !== conversationId;
    if (!needsMount) {
      // setActiveConversationId updates the mounted surface pointer before
      // render() reaches this function. Re-render the shared message nodes so
      // switching characters or sessions cannot leave the previous transcript
      // visible in the new header.
      App.chat.renderMessages();
      return;
    }
    App.chat.mountSurface({ root: surface, conversationId, mode: 'tavern', owner: 'tavern' });
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
      // 头像：override 未动时保留 selected 既有值（可能来自导入/克隆），'' 为显式移除
      avatar: editorAvatarOverride !== null ? editorAvatarOverride : String((selected && selected.avatar) || ''),
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
      const provider = App.getProvider('tavern') || {};
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

  // 编辑器头像上传：本地图片 → canvas 压缩至 128px JPEG（与设置页头像同规格，safeAvatar 2MB 内）。
  // 只写 editorAvatarOverride，随 collectEditor 进脏检测与保存，不直接落库。
  function onEditorAvatarFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { App.ui.toast('请选择图片文件'); return; }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 128;
        let { width: w, height: h } = img;
        const scale = Math.min(1, MAX / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        let dataUrl;
        try { dataUrl = canvas.toDataURL('image/jpeg', 0.85); } catch (_) { dataUrl = String(ev.target.result || ''); }
        editorAvatarOverride = dataUrl;
        render();
        const status = $('tgDraftStatus');
        if (status) status.textContent = '头像已更新，保存角色后生效。';
      };
      img.onerror = () => App.ui.toast('图片读取失败');
      img.src = ev.target.result;
    };
    reader.onerror = () => App.ui.toast('图片读取失败');
    reader.readAsDataURL(file);
  }

  async function saveCharacter() {
    const item = collectEditor();
    if (!item.name) { App.ui.toast('请填写角色名称'); return false; }
    const result = await Promise.resolve(call('saveCharacter', { ok: false }, { character: item, expectedRevision: revision }));
    if (!result || !result.ok) { App.ui.toast(result && result.code === 'tavern_revision_conflict' ? '角色卡已被其他窗口修改，请重新载入' : '角色卡保存失败'); return false; }
    invalidateCharacterDetail(item.id);
    editorDirty = false;
    editorAvatarOverride = null;
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
      restoreConversation(selectedId, opts);
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
    const ui = tavernUi() || {};
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
      restoreConversation(selected.id, opts);
      resetEditorBaseline();
    } else {
      memories = [];
      if (App.chat && App.chat.setActiveConversationId) App.chat.setActiveConversationId('tavern', null);
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
      if (App.chat && App.chat.setActiveConversationId) App.chat.setActiveConversationId('tavern', null);
      activeDrawer = '';
      editorDirty = false;
      editorBase = null;
    }
    revision = Number(result.revision) || revision;
    App.ui.toast('角色卡已删除，历史会话已保留');
    await loadCharacters();
    return true;
  }

  // v1.2.0 批次 5：群聊会话创建（≥2 个角色）与轮流调度器
  async function startGroupSession(ids) {
    if (!App.chat || !App.chat.newConversation || !Array.isArray(ids)) return;
    const unique = [...new Set(ids)].filter(Boolean);
    if (unique.length < 2) { App.ui.toast('群聊至少需要选择两个角色'); return; }
    const primary = unique[0];
    const used = await Promise.resolve(call('touchCharacter', { ok: false }, { id: primary, expectedRevision: revision }));
    if (used && used.ok) {
      revision = Number(used.revision) || revision;
      characters = Array.isArray(used.characters) ? used.characters : characters;
    }
    const nameOf = (id) => { const c = (characters || []).find((item) => item.id === id); return (c && c.name) || id; };
    const conv = App.chat.newConversation(null, { stay: 'tavern', tavernCharacterId: primary, persist: false });
    if (!conv) return;
    conv.tavernCharacterId = primary;
    conv.tavernCharacterIds = unique;
    conv.tavernRestricted = true;
    conv.web = false;
    conv.allowWeb = false;
    conv.allowAttachments = false;
    conv.allowTools = false;
    conv.title = '群聊·' + unique.length + '人';
    conv.titleMode = 'manual';
    conv.systemPrompt = '';
    if (App.chat.setActiveConversationId) App.chat.setActiveConversationId('tavern', conv.id);
    setUiPointer(primary, conv.id, { persist: false });
    App.chat.persistConversation(conv);
    // 创建后立即选中首位角色并恢复到新群聊：裸 render() 在「当前选中其他角色」时会被指针校正
    // 顶掉、在欢迎页时会把激活指针清空，群聊会话因此建完即失联（无任何入口可见）。
    // loadCharacters 与角色卡片点击同链路，内部 restoreConversation 按刚写入的 ui 指针恢复群聊。
    activeLibraryTab = 'groups';
    await loadCharacters(primary);
    App.ui.toast('群聊已创建并打开（' + unique.map(nameOf).join('、') + '），轮流发言');
  }

  function openGroupModal() {
    const list = (characters || []).slice();
    if (list.length < 2) { App.ui.toast('角色库里至少要有两个角色才能开群聊'); return; }
    const picked = new Set();
    const body = '<div class="tg-group-pick">'
      + list.map((c) => '<label class="row-item" style="display:flex;gap:8px;align-items:center;padding:6px 4px">'
        + '<input type="checkbox" data-group-id="' + App.escapeHtml(c.id) + '" />'
        + '<span>' + App.escapeHtml(c.name || '未命名角色') + '</span></label>').join('')
      + '</div><p class="hint">至少勾选两个角色；发言顺序按上方列表顺序轮流，模型可选择沉默跳过。</p>';
    App.ui.showModal({
      title: '新建群聊',
      body,
      buttons: [
        { label: '取消', cls: 'btn-ghost' },
        { label: '创建', cls: 'btn-primary' },
      ],
      onClose: (choice) => {
        if (choice !== '创建') return;
        startGroupSession([...picked]);
      },
    });
    // onClose 时 DOM 可能已被移除，用 change 委托实时记录勾选
    document.addEventListener('change', function onPick(e) {
      const box = e.target && e.target.closest ? e.target.closest('[data-group-id]') : null;
      if (!box) return;
      if (box.checked) picked.add(box.dataset.groupId); else picked.delete(box.dataset.groupId);
      if (!document.querySelector('[data-group-id]')) document.removeEventListener('change', onPick);
    });
  }

  async function startSession() {
    if (!selected || !App.chat || !App.chat.newConversation) return;
    const used = await Promise.resolve(call('touchCharacter', { ok: false }, { id: selected.id, expectedRevision: revision }));
    if (used && used.ok) {
      revision = Number(used.revision) || revision;
      characters = Array.isArray(used.characters) ? used.characters : characters;
      selected = characters.find((item) => item.id === selected.id) || selected;
    }
    const conv = App.chat.newConversation(null, { stay: 'tavern', tavernCharacterId: selected.id, persist: false });
    if (!conv) return;
    conv.tavernCharacterId = selected.id;
    conv.tavernRestricted = true;
    conv.web = false;
    conv.allowWeb = false;
    conv.allowAttachments = false;
    conv.allowTools = false;
    conv.title = '新会话';
    conv.titleMode = 'auto';
    conv.systemPrompt = selected.systemPrompt || '';
    if (App.chat.setActiveConversationId) App.chat.setActiveConversationId('tavern', conv.id);
    // Legacy snapshots used App.state.activeId = conv.id; module sessions now
    // keep this pointer in their own sidecar and never expose it to Chat.
    setUiPointer(selected.id, conv.id, { persist: false });
    App.chat.persistConversation(conv, { activeId: conv.id });
    render();
  }

  function findSession(id) {
    const source = App.chat && App.chat.conversationList
      ? App.chat.conversationList('tavern')
      : (Array.isArray(App.state && App.state.conversations) ? App.state.conversations : []);
    // 按 id 全量查找个人会话（排除群聊），不再绑定当前选中角色——跨角色打开/删除/重命名/导出，
    // 以及指向已删除角色的孤儿会话都可管理（2026-08-26 用户反馈：进不去、删不掉）
    return source.find((item) => item
      && item.id === String(id || '')
      && !isGroupConv(item)
      && Array.isArray(item.messages));
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
    const activeId = App.chat.activeConversationId ? App.chat.activeConversationId('tavern') : null;
    const result = App.chat.deleteConversation(conv.id, { owner: 'tavern' });
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

  // 「群聊」tab：打开群聊会话（绕过按角色过滤的 findSession，走指针恢复链路）
  async function openGroupSession(id) {
    const conv = groupSessions().find((item) => item.id === String(id || ''));
    if (!conv || !App.chat || !App.chat.activate) return;
    setUiPointer(conv.tavernCharacterId, conv.id, { persist: false });
    await loadCharacters(conv.tavernCharacterId);
  }

  function deleteGroup(id) {
    const conv = groupSessions().find((item) => item.id === String(id || ''));
    if (!conv || !window.confirm('删除此群聊？删除后无法恢复。')) return false;
    const activeId = App.chat.activeConversationId ? App.chat.activeConversationId('tavern') : null;
    const result = App.chat.deleteConversation(conv.id, { owner: 'tavern' });
    if (activeId === conv.id) loadCharacters(conv.tavernCharacterId);
    else render();
    return !!(result && result.ok !== false);
  }

  function exportSession(id) {
    const conv = findSession(id);
    if (!conv || !App.ui || !App.ui._convToMarkdown) return;
    const markdown = App.ui._convToMarkdown(conv);
    const safeName = String(conv.title || 'tavern-session').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeName || 'tavern-session'}.md`;
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
      if (App.ui && App.ui.bindModuleProvider) App.ui.bindModuleProvider(root, 'tavern', () => render());
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
      if (event.target && event.target.id === 'tgAvatarInput') {
        const file = event.target.files && event.target.files[0];
        if (file) onEditorAvatarFile(file);
        event.target.value = '';
        return;
      }
      if (event.target.closest('.tg-editor-form')) scheduleEditorDirtyCheck();
    });
    root.addEventListener('click', async (event) => {
      const target = event.target;
      const select = target.closest('[data-tg-select]');
       if (select && !target.closest('[data-tg-card-action]')) {
         await runWithEditorGuard(async () => {
           // personalOnly：点角色卡进入该角色的个人会话，绝不被带进群聊（群聊走「群聊」tab）
           await loadCharacters(select.dataset.tgSelect, { personalOnly: true });
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
      // v1.2.0 批次 5：新建群聊——多选角色（≥2）创建群聊会话
      if (target.closest('[data-tg-new-group]')) {
        openGroupModal();
        return;
      }
       if (target.closest('[data-tg-new], [data-tg-new-character]')) {
         await runWithEditorGuard(() => {
           selectedId = '';
           selected = null;
           memories = [];
           editorBase = null;
           activeDrawer = 'editor';
           if (App.chat && App.chat.setActiveConversationId) App.chat.setActiveConversationId('tavern', null);
           setUiPointer('', '');
           editorDirty = false;
           editorSnapshot = '';
           render();
           // v1.2.0 批次 1e：此前从未主动聚焦，「新建角色后打字无效」实为必然而非偶发。
           // 异步刷新（如 loadCharacters 回流）可能重绘吞掉首次聚焦，故做短周期重试
           let focusTries = 10;
           const focusNameWhenReady = () => {
             const el = document.getElementById('tgName');
             if (!el || activeDrawer !== 'editor') return;
             if (document.activeElement !== el) { try { el.focus(); } catch (_) {} }
             if (document.activeElement === el || --focusTries <= 0) return;
             requestAnimationFrame(() => setTimeout(focusNameWhenReady, 60));
           };
           requestAnimationFrame(focusNameWhenReady);
           startEditorFocusKeeper();
         });
         return;
       }
      const starter = target.closest('[data-tg-starter]');
      if (starter) {
        if (!App.chat.activeConv() || !App.chat.activeConv().tavernCharacterId) await startSession();
        const input = document.getElementById('input');
        if (input) { input.value = starter.dataset.tgStarter || ''; App.chat.autoSize(); App.chat.updateSendEnabled(); input.focus(); }
        return;
      }
      const avatarPick = target.closest('[data-tg-avatar-pick]');
      if (avatarPick) { const inp = $('tgAvatarInput'); if (inp) inp.click(); return; }
      const avatarClear = target.closest('[data-tg-avatar-clear]');
      if (avatarClear) { editorAvatarOverride = ''; render(); return; }
      if (target.closest('[data-tg-new-session]')) {
        const activeConv = App.chat && App.chat.activeConv ? App.chat.activeConv() : null;
        // 群聊激活时「新会话」= 同成员新开群聊，而不是退回首角色的单角色会话
        if (isGroupConv(activeConv)) { await startGroupSession(activeConv.tavernCharacterIds); return; }
        await startSession();
        return;
      }
      const sessionSelect = target.closest('#tgSessionSelect');
      if (sessionSelect) return;
      const sessionOpen = target.closest('[data-tg-session-open]');
      if (sessionOpen) {
        const conv = findSession(sessionOpen.dataset.tgSessionOpen);
        if (!conv) return;
        // 全量列表支持跨角色打开：先切到所属角色，再指向目标会话（2026-08-26）；
        // 归属角色已不存在（孤儿会话）时跳过切换，仅打开会话本体
        const ownerId = String(conv.tavernCharacterId || '');
        const ownerKnown = ownerId && (characters || []).some((item) => item && item.id === ownerId);
        if (ownerKnown && (!selected || ownerId !== selected.id)) await loadCharacters(ownerId);
        if (conv && App.chat && App.chat.activate) { App.chat.activate(conv.id, { stay: 'tavern', persist: false, render: false }); setUiPointer(selected ? selected.id : ownerId, conv.id); render(); }
        return;
      }
      const groupOpen = target.closest('[data-tg-group-open]');
      if (groupOpen) { openGroupSession(groupOpen.dataset.tgGroupOpen); return; }
      const groupDelete = target.closest('[data-tg-group-delete]');
      if (groupDelete) { deleteGroup(groupDelete.dataset.tgGroupDelete); return; }
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
          // v1.2.1 批次 8：合集（全部导出文件）分支——确认张数后整批导入
          if (preview.bundle) {
            const names = (preview.names || []).slice(0, 8).join('、');
            const warning = (preview.warnings || []).join('\n');
            const more = preview.count > 8 ? ` 等 ${preview.count} 张` : '';
            const skipNote = preview.skipped ? `\n（跳过 ${preview.skipped} 张无效或超限卡）` : '';
            if (!window.confirm(`导入角色卡合集：${names}${more}？${skipNote}${warning ? `\n\n${warning}` : ''}`)) return;
            const result = await Promise.resolve(call('importCharacter', { ok: false }, { previewId: preview.previewId, expectedRevision: revision }));
            if (result && result.ok) { App.ui.toast(`已导入 ${result.importedCount != null ? result.importedCount : preview.count} 张角色卡`); await loadCharacters(); }
            else App.ui.toast((result && result.error) || '角色卡导入失败');
            return;
          }
          const cardData = preview.character || {};
          const warning = (preview.warnings || []).join('\n');
          if (!window.confirm(`导入“${cardData.name || '未命名角色'}”及 ${(preview.memories || []).length} 条世界书？${warning ? `\n\n${warning}` : ''}`)) return;
          const result = await Promise.resolve(call('importCharacter', { ok: false }, { previewId: preview.previewId, expectedRevision: revision }));
          if (result && result.ok) { App.ui.toast('角色卡已导入'); await loadCharacters(result.characterId); }
          else App.ui.toast((result && result.error) || '角色卡导入失败');
        } finally { button.disabled = false; }
        return;
      }
      if (target.closest('[data-tg-export-all]')) {
        const button = target.closest('[data-tg-export-all]'); button.disabled = true;
        try {
          const result = await Promise.resolve(call('exportAllCharacters', { ok: false }, {}));
          if (result && result.ok) App.ui.toast(`已导出 ${result.count} 张角色卡`);
          else if (!result || !result.canceled) App.ui.toast((result && result.error) || '导出失败');
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
        const provider = App.getProvider('tavern') || {}; const status = $('tgDraftStatus'); button.disabled = true;
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
        if (conv && App.chat) { App.chat.activate(conv.id, { stay: 'tavern', persist: false, render: false }); setUiPointer(selected.id, conv.id); render(); }
      }
    });
    if (App.ui && App.ui.bindModuleProvider) App.ui.bindModuleProvider(root, 'tavern', () => render());
    if (!App.tavern._escBound) {
      App.tavern._escBound = true;
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && App.state.view === 'tavern' && activeDrawer) closeDrawer(); });
    }
  }

  App.tavern = {
    async ensureSession() {
      if (!selected || !App.chat || !App.chat.activeConv) return null;
      const active = App.chat.activeConv();
      // 归属判定（含群聊）：群聊激活时不得误启新的单角色会话
      if (belongsToCharacter(active, selected.id)) return active;
      await startSession();
      return App.chat.activeConv();
    },
    // 群聊消息渲染用：按 id 同步取角色名/头像（characters 列表已在内存）；未知/未加载返回 null
    characterBrief(id) {
      const key = String(id || '');
      const c = (characters || []).find((item) => item && item.id === key);
      return c ? { name: String(c.name || ''), avatar: String(c.avatar || '') } : null;
    },
    // 群聊单成员轮次后处理（署名/沉默/失败可见）；「重新生成」的单成员重跑复用（chat.js regen 调用）
    applyMemberTurnResult,
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
    // v1.2.0 批次 5：群聊轮流调度器——按成员顺序串行发言，模型可回复 [SILENCE]/[沉默] 跳过本轮；
    // 每轮临时把 conv.tavernCharacterId 切到当前成员以复用单人流式管道，结束后恢复。
    // v1.2.0 批次 5：群聊轮流调度器——按成员顺序串行发言，模型可回复 [SILENCE]/[沉默] 跳过本轮；
    // 每轮临时把 conv.tavernCharacterId 切到当前成员以复用单人流式管道，结束后恢复。
    async runGroupTurn(conv, ui, options) {
      const members = (Array.isArray(conv.tavernCharacterIds) ? conv.tavernCharacterIds : []).slice(0, 6);
      if (!members.length) return { ok: false, code: 'group_no_members' };
      const names = {};
      for (const id of members) {
        try {
          const d = await getCharacterDetail(id);
          if (d && d.ok && d.character && d.character.name) names[id] = d.character.name;
        } catch (_) {}
      }
      const prevId = conv.tavernCharacterId;
      try {
        for (const id of members) {
          const name = names[id] || id;
          conv.tavernCharacterId = id;
          // 群聊简报：让当前角色知道在场成员与最近谁说了什么，以及沉默协议（system 提示行不是发言，不进简报）
          const recent = conv.messages.filter((m) => m && m.role !== 'system').slice(-8).map((m) => {
            const t = String(m.content || '').slice(0, 140);
            if (m.role === 'user') {
              // 用户消息点名了某位成员时显式标注指向（2026-08-26 反馈：B 把对 A 说的话当成对自己说的）
              const addressed = members.map((mid) => names[mid]).find((nm) => nm && t.includes(nm));
              return (addressed ? '用户→' + addressed + '：' : '用户：') + t;
            }
            // 说话人标注优先按 characterId 精确查名（2026-08-26 加固）；
            // 旧消息无 id 时才退回「正文前缀启发式」
            const brief = (window.App.tavern && typeof window.App.tavern.characterBrief === 'function')
              ? window.App.tavern.characterBrief(String(m.characterId || '')) : null;
            if (brief && brief.name) return brief.name + '：' + t;
            const sep = t.indexOf('：');
            return (sep > 0 && sep <= 12 ? t.slice(0, sep) : '角色') + '：' + t;
          }).join('\n');
          conv.__groupBrief = [
            '# 群聊模式',
            '本会话有多位角色共同参与，在场成员：' + members.map((mid) => names[mid] || mid).join('、') + '。',
            '当前轮到「' + name + '」发言。近期发言记录：', recent,
            '标注约定：近期记录与对话历史中「名字：」开头即表示该句话出自这个名字的角色。',
            '点名规则：用户消息可能点名某位成员；点名对象不是你时，那是说给别人听的，不要当作对你说的，也不要抢答。',
            '去重规则：其他成员已经回应过的内容不要重复回应；只补充与你相关的新内容。',
            '规则：只以「' + name + '」的身份和口吻回应；不要替其他角色发言或转述他们的内心；',
            '若此刻没有值得说的，仅回复 [SILENCE]（除此之外任何内容都会作为你的发言展示）。',
          ].join('\n');
          const turnStart = conv.messages.length;
          // 生成期间头像即显示当前发言成员（此前显示糖包 logo；2026-08-26 用户反馈）
          if (window.App.chat.setStreamingMemberAvatar) window.App.chat.setStreamingMemberAvatar(ui, id);
          try {
            await window.App.chat.streamChat(conv, ui, Object.assign({}, options || {}, { __groupMember: true, __memberId: id }));
          } catch (e) {
            console.warn('[糖馆群聊] 成员 ' + name + ' 发言失败，跳过：', e && (e.message || e));
            // 僵尸占位清扫：本轮产生的仍处 streaming 的占位转为可读失败态，不留空气泡；
            // error 字段携带真实原因便于诊断（content 保持用户可读文案）
            for (const m of conv.messages.slice(turnStart)) {
              if (m && m.role === 'assistant' && m.streamStatus === 'streaming') {
                m.streamStatus = 'failed';
                m.error = m.error || ('member_turn_error: ' + String((e && e.message) || e)).slice(0, 200);
                if (!String(m.content || '').trim()) m.content = '⚠️ 成员「' + name + '」本轮调用失败：' + String((e && e.message) || e).slice(0, 80);
              }
            }
            if (typeof window.App.chat.renderMessages === 'function') window.App.chat.renderMessages();
            continue;
          }
          // 后处理只看本轮产物；报错与沉默严格分离（详见 applyMemberTurnResult）
          applyMemberTurnResult(conv, id, name, turnStart);
          await new Promise((r) => setTimeout(r, 120));
        }
      } finally {
        conv.tavernCharacterId = prevId;
        delete conv.__groupBrief;
        try { window.App.chat.persistConversation(conv); } catch (_) {}
      }
      return { ok: true };
    },
    renderWelcome,
    async preparePrompt(conv, query) {
      if (!conv || !conv.tavernCharacterId) return '';
      const detail = await getCharacterDetail(conv.tavernCharacterId);
      if (!detail || !detail.ok || !detail.character) {
        console.warn('[糖馆] 角色详情读取失败，人设注入跳过：', (detail && (detail.error || detail.code)) || '未知原因');
        return '';
      }
      const provider = App.getProvider('tavern') || {};
      const rag = ragParams();
      const result = await Promise.resolve(call('retrieveContext', { ok: false }, { characterId: detail.character.id, query: query || '', tokenBudget: rag.tokenBudget, limit: rag.limit, semantic: detail.character.embeddingEnabled === true, ref: provider.ref, model: provider.model }));
      const card = detail.character;
      const matureEnabled = matureMode && card.matureAllowed === true;
      // 双许可（全局成熟开关 + 角色卡 matureAllowed）状态中性陈述；未成年人红线无条件保留
      const contentPolicy = matureEnabled
        ? '成熟内容：已获得许可（全局开启且本卡允许），可按角色与剧情自然呈现，不涉及未成年人。'
        : '成熟内容：未开启，保持全年龄尺度。';
      const parts = ['# 角色卡（你的身份与行为准则）',
        card.name ? '名称：' + card.name : '', card.description ? '简介：' + card.description : '', card.personality ? '性格：' + card.personality : '', card.scenario ? '场景：' + card.scenario : '', card.exampleDialogue ? '示例：\n' + card.exampleDialogue : '', card.systemPrompt || '', result && result.context ? result.context : ''];
      let prompt = parts.filter(Boolean).concat(contentPolicy).join('\n');
      // 弱卡兜底：卡片只有名称（无简介/性格/场景等任何人设字段）时，注入的
      // 角色信息太薄，弱模型容易跳出人设。追加一条身份锁定指令，保证最小卡片也能生效。
      if (!card.description && !card.personality && !card.scenario && !card.exampleDialogue && !card.systemPrompt) {
        const who = String(card.name || '该角色').trim();
        const tagline = String(card.tagline || '').trim();
        prompt += '\n\n# 身份锁定\n你必须始终以「' + who + '」' + (tagline ? '（' + tagline + '）' : '') + '的身份与用户交流，不要自称糖包或 AI 助手。';
      }
      return prompt;
    },
  };

  // v1.2.1 批次 9：语言切换时重渲染糖馆视图（动态模板里的词条才会跟着换）
  try {
    document.addEventListener('i18n:changed', () => {
      try {
        const viewEl = document.querySelector('.view[data-view="tavern"]');
        if (typeof render === 'function' && viewEl && !viewEl.hidden) render();
      } catch (_) {}
    });
  } catch (_) {}
})();
