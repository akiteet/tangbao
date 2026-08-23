'use strict';
(function () {
  window.App = window.App || {};
  const $ = (id) => document.getElementById(id);
  const esc = (s) => App.escapeHtml(s == null ? '' : String(s));

  const PRESET_AGENTS = [
    { id: 'write', name: '写作助手', icon: '✍️', desc: '文章、文案、邮件、脚本', category: 'write', recommended: true, systemPrompt: '你是一位擅长中文写作的助手，能够根据用户要求撰写各类文章、文案、邮件和脚本，语言流畅、结构清晰。', model: '', temperature: 0.7, topP: 1, web: false, tone: '', tags: ['写作', '文案'], starters: ['帮我写一篇关于人工智能的科普文章', '写一封请假邮件给老板'] },
    { id: 'translate', name: '翻译官', icon: '🌐', desc: '中英互译，地道自然', category: 'translate', recommended: true, systemPrompt: '你是一位专业翻译，擅长中英文互译。翻译要准确、地道，保留原文语气，并根据上下文选择合适表达。', model: '', temperature: 0.3, topP: 1, web: false, tone: '', tags: ['翻译'], starters: ['把下面这段中文翻译成英文', '把这段英文翻译成中文，保持专业语气'] },
    { id: 'code', name: '代码专家', icon: '💻', desc: '编程、调试、代码讲解', category: 'code', recommended: true, systemPrompt: '你是一位资深软件工程师，擅长多种编程语言。请提供清晰、可维护的代码，并解释关键逻辑。', model: '', temperature: 0.2, topP: 1, web: false, tone: '', tags: ['编程', '调试'], starters: ['用 Python 写一个快速排序', '帮我 review 这段代码并给出改进'] },
    { id: 'report', name: '周报生成器', icon: '📝', desc: '一键整理工作周报', category: 'career', recommended: false, systemPrompt: '你是一位擅长总结工作内容的助手。请把用户提供的信息整理成结构清晰、重点突出的工作周报。', model: '', temperature: 0.5, topP: 1, web: false, tone: '', tags: ['职场'], starters: ['帮我写一份本周工作周报'] },
    { id: 'xhs', name: '小红书文案', icon: '📕', desc: '种草笔记与爆款标题', category: 'write', recommended: true, systemPrompt: '你是一位擅长小红书风格的文案写手。输出种草感强、emoji 丰富、适合社交媒体传播的文案。', model: '', temperature: 0.9, topP: 1, web: false, tone: '亲切', tags: ['文案', '社媒'], starters: ['写一篇关于咖啡店探店的小红书笔记', '给我 5 个吸引人的标题'] },
    { id: 'resume', name: '简历优化', icon: '📄', desc: '简历润色与面试辅导', category: 'write', recommended: false, systemPrompt: '你是一位 HR 与职业规划专家。请帮助用户优化简历，突出亮点，并提供面试建议。', model: '', temperature: 0.4, topP: 1, web: false, tone: '专业', tags: ['职场', '简历'], starters: ['帮我优化这段简历描述', '针对这个岗位给我面试建议'] },
    { id: 'code-review', name: '代码评审', icon: '🔍', desc: 'Review 代码质量', category: 'code', recommended: false, systemPrompt: '你是一位严格的代码评审员。请检查用户代码，指出潜在问题、可读性缺陷，并给出改进建议。', model: '', temperature: 0.3, topP: 1, web: false, tone: '专业', tags: ['编程'], starters: ['review 这段代码的质量'] },
    { id: 'teacher', name: '学习导师', icon: '📚', desc: '分步骤讲解知识点', category: 'learn', recommended: false, systemPrompt: '你是一位耐心的学习导师。请用通俗易懂的语言分步骤讲解知识点，并给出示例。', model: '', temperature: 0.6, topP: 1, web: false, tone: '亲切', tags: ['学习'], starters: ['用通俗语言讲讲相对论', '帮我制定一个学习计划的步骤'] },
  ];

  const TONES = [
    { v: '', label: '跟随默认' },
    { v: '专业', label: '专业' },
    { v: '亲切', label: '亲切' },
    { v: '幽默', label: '幽默' },
    { v: '简洁', label: '简洁' },
    { v: '文艺', label: '文艺' },
  ];

  const ICON_CHOICES = ['🤖', '✍️', '🌐', '💻', '📝', '📕', '📄', '🔍', '📚', '💡', '🎯', '🧠'];

  function shortModel(m) { return m || ''; }

  let taskSessionOpen = false;
  let taskSessionConversationId = '';
  let libraryTab = 'presets';
  let libraryCollapsed = false;
  let createResizeFrame = 0;
  let lastCreateDesktop = null;

  function taskSessionDrawer() {
    // Legacy DOM contract retained for extensions: createTaskDrawer.
    return $('createTaskDrawer');
  }

  function mountTaskSessionSurface() {
    const host = $('createSessionPane');
    const surface = $('createChatSurface');
    if (!surface || !taskSessionOpen) return false;
    if (host) host.hidden = false;
    if (App.chat && App.chat.mountSurface) {
      App.chat.mountSurface({
        root: surface,
        owner: 'create',
        mode: 'create',
        conversationId: taskSessionConversationId || (App.chat.activeConversationId ? App.chat.activeConversationId('create') : null),
      });
      if (App.chat.syncImgBtn) App.chat.syncImgBtn();
    }
    return true;
  }

  function closeTaskSession() {
    taskSessionOpen = false;
    taskSessionConversationId = '';
    const surface = App.chat && App.chat.surface ? App.chat.surface() : null;
    if (surface && surface.owner === 'create' && App.chat.unmountSurface) App.chat.unmountSurface();
    const host = $('createSessionPane');
    if (host) host.hidden = true;
  }

  function createConversationList() {
    return App.chat && typeof App.chat.conversationList === 'function'
      ? App.chat.conversationList('create')
      : [];
  }

  function createSessionTitle(conv) {
    const title = String(conv && conv.title || '').trim();
    if (conv && conv.titleMode === 'manual' && title) return title;
    const firstUser = Array.isArray(conv && conv.messages)
      ? conv.messages.find((item) => item && item.role === 'user' && String(item.content || '').trim())
      : null;
    if (firstUser) return String(firstUser.content).replace(/\s+/g, ' ').trim().slice(0, 28) || '新会话';
    return title && title !== '新对话' ? title : '新会话';
  }

  function createTabbedLibraryMarkup(content) {
    const presetActive = libraryTab === 'presets';
    return `<div class="create-library-head"><div><b>糖创</b><small>任务型智能体与工作流</small></div><button type="button" class="icon-btn create-library-collapse-btn" data-create-library-toggle aria-label="收起糖创库" title="收起糖创库">‹</button></div>
      <div class="create-library-tabs">
        <button type="button" class="${presetActive ? 'active' : ''}" data-create-library-tab="presets">预设</button>
        <button type="button" class="${!presetActive ? 'active' : ''}" data-create-library-tab="sessions">会话</button>
        <button type="button" class="create-library-collapsed-tab" data-create-library-tab="presets" data-create-library-expand aria-label="展开预设">预设</button>
        <button type="button" class="create-library-collapsed-tab" data-create-library-tab="sessions" data-create-library-expand aria-label="展开会话">会话</button>
      </div>
      <div class="create-library-content">${content}</div>`;
  }

  function createLibraryMarkup(content, options) {
    const opts = options && typeof options === 'object' ? options : {};
    if (opts.tabs !== false) return createTabbedLibraryMarkup(content);
    const title = opts.title || '糖创';
    const subtitle = opts.subtitle || '任务型智能体与工作流';
    const expandLabel = opts.expandLabel || title;
    return `<div class="create-library-head"><div><b>${esc(title)}</b><small>${esc(subtitle)}</small></div><button type="button" class="icon-btn create-library-collapse-btn" data-create-library-toggle aria-label="收起${esc(title)}" title="收起${esc(title)}">‹</button><button type="button" class="create-library-collapsed-tab" data-create-library-expand aria-label="展开${esc(title)}">${esc(expandLabel)}</button></div>
      <div class="create-library-content">${content}</div>`;
  }

  function wrapCreateGenericLibrary(root, options) {
    if (!root) return;
    root.innerHTML = createLibraryMarkup(root.innerHTML, Object.assign({ tabs: false }, options || {}));
    bindCreateLibraryControls(root);
  }

  function bindCreateLibraryControls(root) {
    if (!root) return;
    root.querySelectorAll('[data-create-library-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        libraryTab = button.dataset.createLibraryTab === 'sessions' ? 'sessions' : 'presets';
        if (button.hasAttribute('data-create-library-expand')) libraryCollapsed = false;
        App.create.render();
      });
    });
    root.querySelectorAll('[data-create-library-toggle]').forEach((button) => {
      button.addEventListener('click', () => {
        if (window.innerWidth > 900) {
          libraryCollapsed = !libraryCollapsed;
          App.create.render();
        }
      });
    });
  }

  async function renameCreateSession(id) {
    const conv = createConversationList().find((item) => item && item.id === String(id || ''));
    if (!conv) return;
    const value = await App.ui.promptModal({ title: '重命名会话', label: '会话名称', value: createSessionTitle(conv), maxLength: 120 });
    if (value == null) return;
    const title = String(value).trim();
    if (!title) { App.ui.toast('会话名称不能为空'); return; }
    conv.title = title;
    conv.titleMode = 'manual';
    conv.updatedAt = Date.now();
    App.chat.persistConversation(conv);
    App.create.render();
  }

  function deleteCreateSession(id) {
    const conv = createConversationList().find((item) => item && item.id === String(id || ''));
    if (!conv || !window.confirm('\u5220\u9664\u6b64\u4f1a\u8bdd\uff1f\u5220\u9664\u540e\u65e0\u6cd5\u6062\u590d\u3002')) return false;
    const activeId = App.chat.activeConversationId ? App.chat.activeConversationId('create') : null;
    const result = App.chat.deleteConversation(conv.id, { owner: 'create' });
    if (activeId === conv.id) taskSessionConversationId = result && result.activeId ? result.activeId : '';
    App.create.render();
    return !!(result && result.ok !== false);
  }

  function clearCreateSession(id) {
    const conv = createConversationList().find((item) => item && item.id === String(id || ''));
    if (!conv || !window.confirm('清空此会话的全部消息？此操作不可撤销。')) return;
    conv.messages = [];
    conv.updatedAt = Date.now();
    App.chat.persistConversation(conv);
    App.create.render();
  }

  function exportCreateSession(id) {
    const conv = createConversationList().find((item) => item && item.id === String(id || ''));
    if (!conv || !App.ui || !App.ui._convToMarkdown) return;
    const markdown = App.ui._convToMarkdown(conv);
    const safeName = String(createSessionTitle(conv) || 'create-session').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeName || 'create-session'}.md`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    App.ui.toast('会话已导出');
  }

  function bindCreateSessionActions(root) {
    if (!root) return;
    root.querySelectorAll('[data-create-session-open]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.dataset.createSessionOpen;
        taskSessionConversationId = String(id || '');
        taskSessionOpen = true;
        App.chat.activate(id, { owner: 'create', stay: 'create', persist: false, render: false });
        App.create.render();
      });
    });
    root.querySelectorAll('[data-create-session-rename]').forEach((button) => {
      button.addEventListener('click', () => renameCreateSession(button.dataset.createSessionRename));
    });
    root.querySelectorAll('[data-create-session-delete]').forEach((button) => {
      button.addEventListener('click', () => deleteCreateSession(button.dataset.createSessionDelete));
    });
    root.querySelectorAll('[data-create-session-clear]').forEach((button) => {
      button.addEventListener('click', () => clearCreateSession(button.dataset.createSessionClear));
    });
    root.querySelectorAll('[data-create-session-export]').forEach((button) => {
      button.addEventListener('click', () => exportCreateSession(button.dataset.createSessionExport));
    });
  }

  App.create = {
    stateSearch: '',
    tab: 'agents',
    editingId: null,

    onShow() {
      if (!App.create._resizeBound) {
        App.create._resizeBound = true;
        lastCreateDesktop = window.innerWidth > 900;
        window.addEventListener('resize', () => {
          if (App.state.view !== 'create' || createResizeFrame) return;
          createResizeFrame = requestAnimationFrame(() => {
            createResizeFrame = 0;
            const desktop = window.innerWidth > 900;
            if (desktop !== lastCreateDesktop) {
              lastCreateDesktop = desktop;
              App.create.render();
            }
          });
        });
      }
      App.create.render();
    },

    /* ============ 顶层渲染：子标签 ============ */
    render() {
      const wrap = $('createView');
      if (!wrap) return;
      const surface = App.chat && App.chat.surface ? App.chat.surface() : null;
      if (surface && surface.owner === 'create' && App.chat.unmountSurface) {
        App.chat.unmountSurface({ preserveActiveId: true });
      }
      if (!taskSessionConversationId && App.chat && App.chat.activeConversationId) taskSessionConversationId = App.chat.activeConversationId('create') || '';
      // Create owns its session surface. A catalog refresh (tab/account/model
      // changes) must not collapse the active conversation back into Chat.
      taskSessionOpen = true;
      wrap.classList.toggle('create-library-is-collapsed', libraryCollapsed && window.innerWidth > 900);
      wrap.innerHTML = `
        <div class="create-shell">
          <div class="create-tabs" id="createTabs">
            <button class="create-tab active" data-tab="agents">任务智能体</button> <!-- v1.1.8 T3：工作流 tab 隐藏（数据与渲染函数保留） -->
          </div>
          <div class="create-workspace">
            <section class="create-catalog" id="createContent"></section>
            <section class="create-session-pane" id="createSessionPane" aria-label="糖创会话">
              <header class="create-session-header">
                <div><b>任务会话</b><small>任务型智能体与工作流的独立对话</small></div>
                <div class="create-session-actions"><button type="button" class="btn-ghost" data-create-new-session>新会话</button></div>
              </header>
              <div class="create-chat-surface" id="createChatSurface"></div>
            </section>
          </div>
        </div>`;
      $('createTabs').addEventListener('click', (e) => {
        const b = e.target.closest('[data-tab]');
        if (!b) return;
        App.create.tab = b.dataset.tab;
        App.create.render();
      });
      App.create.tab = 'agents'; /* T3：工作流入口已隐藏，tab 恒为 agents */
      App.create.renderLibrary();
      const newSession = wrap.querySelector('[data-create-new-session]');
      // Legacy close hook name retained for module extensions: data-create-task-close.
      if (newSession) newSession.addEventListener('click', () => App.create.newSession());
      if (!App.create._taskEscBound) {
        App.create._taskEscBound = true;
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape' && App.state.view === 'create' && taskSessionOpen) closeTaskSession();
        });
      }
      if (taskSessionOpen) mountTaskSessionSurface();
      if (App.ui && App.ui.syncModelSelect) App.ui.syncModelSelect();
    },

    openTaskSession(id) {
      taskSessionConversationId = String(id || (App.chat.activeConversationId ? App.chat.activeConversationId('create') : '') || '');
      taskSessionOpen = true;
      if (!mountTaskSessionSurface()) App.create.render();
      if (App.ui && App.ui.syncModelSelect) App.ui.syncModelSelect();
    },

    closeTaskSession,

    getAgent(id) {
      const target = String(id || '');
      if (!target) return null;
      return [...PRESET_AGENTS, ...(App.state.settings.agents || [])].find((item) => item && item.id === target) || null;
    },

    newSession() {
      const conv = App.chat.newConversation(null, { owner: 'create', stay: 'create', originModule: 'create', inheritActive: true });
      if (conv) {
        taskSessionConversationId = conv.id;
        libraryTab = 'sessions';
        App.create.render();
      }
      return conv;
    },

    renderTaskWelcome(welcome, conv) {
      if (!welcome) return;
      const agent = conv && conv.agentId ? [...PRESET_AGENTS, ...(App.state.settings.agents || [])].find((item) => item.id === conv.agentId) : null;
      welcome.innerHTML = `<div class="create-task-welcome"><div class="create-task-mark">创</div><h2>${esc(agent ? agent.name : (conv && conv.title) || '任务会话')}</h2><p>这里是糖创的任务型会话；模型、提示词和工作流上下文只在糖创内继续。</p></div>`;
    },

    /* ============ 智能体 tab ============ */
    renderLibrary() {
      if (libraryTab === 'sessions') App.create.renderSessions();
      else App.create.renderAgents();
    },

    renderAgents() {
      const c = $('createContent');
      if (!c) return;
      c.innerHTML = createLibraryMarkup(`<div class="create-sec"><div class="create-toolbar"><input type="text" class="create-search" id="createSearch" placeholder="搜索任务智能体…" value="${esc(App.create.stateSearch)}" /></div></div><div class="agent-grid" id="agentGrid"></div>`);

      const search = $('createSearch');
      if (search) search.addEventListener('input', (e) => {
        App.create.stateSearch = e.target.value.trim().toLowerCase();
        App.create.renderGrid();
      });
      bindCreateLibraryControls(c);
      App.create.renderGrid();
    },

    renderSessions() {
      const c = $('createContent');
      if (!c) return;
      const activeId = App.chat.activeConversationId ? App.chat.activeConversationId('create') : '';
      const sessions = createConversationList().slice().sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
      const content = sessions.length
        ? `<div class="create-session-list tg-session-list">${sessions.map((conv) => `<div class="create-session-row tg-session-row${conv.id === activeId ? ' active' : ''}" data-create-session-row="${esc(conv.id)}"><button type="button" class="create-session-open tg-session-open" data-create-session-open="${esc(conv.id)}"><b>${esc(createSessionTitle(conv))}</b><small>${Array.isArray(conv.messages) ? conv.messages.length : 0} 条消息</small></button><div class="create-session-row-actions tg-session-actions"><button type="button" class="btn-ghost mini" data-create-session-rename="${esc(conv.id)}">重命名</button><button type="button" class="btn-ghost mini" data-create-session-delete="${esc(conv.id)}">删除</button><button type="button" class="btn-ghost mini" data-create-session-clear="${esc(conv.id)}">清空</button><button type="button" class="btn-ghost mini" data-create-session-export="${esc(conv.id)}">导出</button></div></div>`).join('')}</div>`
        : '<div class="create-empty">还没有糖创会话。打开一个预设，或直接新建会话。</div>';
      c.innerHTML = createLibraryMarkup(content);
      bindCreateLibraryControls(c);
      bindCreateSessionActions(c);
    },

    renderGrid() {
      const grid = $('agentGrid');
      if (!grid) return;
      const kw = App.create.stateSearch;
      const usage = App.state.settings.agentUsage || {};
      const custom = App.state.settings.agents || [];
      let all = [
        ...PRESET_AGENTS.map(a => Object.assign({ custom: false }, a)),
        ...custom.map(a => Object.assign({ custom: true }, a)),
      ];
      let filtered = all.filter(a => {
        const hitKw = !kw || (a.name + ' ' + (a.desc || '')).toLowerCase().includes(kw);
        return hitKw;
      });

      if (!filtered.length) {
        grid.innerHTML = '<div class="create-empty">没有匹配的任务智能体，换个关键词或分类试试～</div>';
        return;
      }
      grid.innerHTML = filtered.map(a => App.create.agentCard(a)).join('') +
        `<button class="lib-bar lib-bar--add" id="addAgentBtn">
           <span class="lib-bar-icon">＋</span>
           <span class="lib-bar-main"><b class="lib-bar-name">新建任务智能体</b><span class="lib-bar-desc">自定义任务设定与提示词</span></span>
         </button>`;

      grid.querySelectorAll('[data-agent]').forEach(card => card.addEventListener('click', () => {
        const id = card.dataset.agent;
        const agent = [...PRESET_AGENTS, ...(App.state.settings.agents || [])].find(a => a.id === id);
        if (agent) App.create.openPreview(agent);
      }));
      grid.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        App.create.confirmDelete(btn.dataset.del);
      }));
      grid.querySelectorAll('[data-edit]').forEach(btn => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const agent = (App.state.settings.agents || []).find(a => a.id === btn.dataset.edit);
        if (agent) App.create.openAgentForm(agent);
      }));
      grid.querySelectorAll('[data-clone]').forEach(btn => btn.addEventListener('click', (e) => {
        e.stopPropagation();
        App.create.cloneAgent(btn.dataset.clone);
      }));
      const addBtn = $('addAgentBtn');
      if (addBtn) addBtn.addEventListener('click', (e) => { e.stopPropagation(); App.create.openAgentForm(); });
    },

    agentCard(a) {
      const usage = (App.state.settings.agentUsage || {})[a.id] || 0;
      const reco = (a.recommended && !a.custom) ? '<span class="tag-chip" title="推荐" style="color: var(--warning); border-color: transparent;">★</span>' : '';
      const tag = (a.tags && a.tags.length) ? `<span class="tag-chip">${esc(a.tags[0])}</span>` : '';
      const actions = a.custom
        ? `<button data-edit="${a.id}" title="编辑">✎</button>
           <button class="danger" data-del="${a.id}" title="删除">×</button>`
        : `<button data-clone="${a.id}" title="克隆">⧉</button>`;
      // 行1 图标+名称+操作；行2 描述；标签单独一行，避免和描述抢宽被挤出卡片
      return `<div class="lib-bar" data-agent="${a.id}">
        <div class="lib-bar-row1">
          <span class="lib-bar-icon">${a.icon || '🤖'}</span>
          <b class="lib-bar-name">${esc(a.name)}</b>
          <span class="lib-bar-ops">${actions}</span>
        </div>
        <div class="lib-bar-row2">
          <span class="lib-bar-desc">${esc(a.desc || '')}${usage ? ` · 用了 ${usage} 次` : ''}</span>
        </div>
        <div class="lib-bar-tags">${reco}${tag}</div>
      </div>`;
    },

    allTags() {
      const set = new Set();
      [...PRESET_AGENTS, ...(App.state.settings.agents || [])].forEach(a => (a.tags || []).forEach(t => set.add(t)));
      return Array.from(set);
    },

    trackUsage(id) {
      if (!id) return;
      const u = App.state.settings.agentUsage || (App.state.settings.agentUsage = {});
      u[id] = (u[id] || 0) + 1;
      App.persist();
    },

    cloneAgent(id) {
      const src = [...PRESET_AGENTS, ...(App.state.settings.agents || [])].find(a => a.id === id);
      if (!src) return;
      const copy = {
        id: 'a-' + App.uid().slice(1),
        name: src.name + ' 副本',
        desc: src.desc || '',
        icon: src.icon || '🤖',
        systemPrompt: src.systemPrompt || '',
        category: src.category || 'custom',
        model: src.model || '',
        temperature: typeof src.temperature === 'number' ? src.temperature : null,
        topP: typeof src.topP === 'number' ? src.topP : null,
        web: typeof src.web === 'boolean' ? src.web : null,
        tone: src.tone || '',
        tags: (src.tags || []).slice(),
        starters: (src.starters || []).slice(),
        custom: true,
        recommended: false,
      };
      App.state.settings.agents = App.state.settings.agents || [];
      App.state.settings.agents.push(copy);
      App.persist();
      App.create.render();
      App.ui.toast('已克隆为自定义任务智能体');
    },

    /* ---------- 新建 / 编辑 弹窗 ---------- */
    // 跨模块导入：把一段文本作为系统提示词，打开「新建智能体」表单预填
    importPrompt(text) {
      const t = String(text == null ? '' : text).slice(0, 4000);
      if (!t.trim()) return;
      App.create.tab = 'agents';
      App.create.render();
      App.create.openAgentForm(null, { systemPrompt: t });
    },

    openAgentForm(agent, prefill) {
      App.create.editingId = agent ? agent.id : null;
      const isEdit = !!agent;
      const el = (k, d) => (agent && agent[k] != null ? agent[k]
        : (prefill && prefill[k] != null ? prefill[k] : d));
      const chatProv = App.getProvider('create');
      const chatModels = (chatProv.models && chatProv.models.length) ? chatProv.models : (chatProv.model ? [chatProv.model] : []);
      const modelOpts = `<option value="">跟随默认</option>` + chatModels.map(m =>
        `<option value="${esc(m)}"${m === el('model', '') ? ' selected' : ''}>${esc(m)}</option>`).join('');
      const toneOpts = TONES.map(t => `<option value="${esc(t.v)}"${t.v === el('tone', '') ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
      const tempDefault = el('temperature', null) == null;
      const topPDefault = el('topP', null) == null;
      const starters = (Array.isArray(agent && agent.starters) ? agent.starters : []);

      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.id = 'agentModalMask';
      modal.innerHTML = `
        <div class="modal agent-modal" role="dialog" aria-modal="true">
          <div class="modal-header">
            <span>${isEdit ? '编辑任务智能体' : '新建任务智能体'}</span>
            <button class="icon-btn" id="agentFormClose" aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modal-body">
            <div class="agent-form">
              <label class="field"><span class="field-label">名称 <em>*</em></span>
                <input type="text" id="afName" value="${esc(el('name', ''))}" placeholder="如 旅行规划师" autocomplete="off" />
              </label>
              <label class="field"><span class="field-label">一句话描述</span>
                <input type="text" id="afDesc" value="${esc(el('desc', ''))}" placeholder="这个任务智能体适合处理什么" autocomplete="off" />
              </label>
                <label class="field"><span class="field-label">任务系统提示词</span>
                <textarea id="afPrompt" rows="4" placeholder="你是一位……">${esc(el('systemPrompt', ''))}</textarea>
              </label>
              <div class="field"><span class="field-label">模型</span>
                <select class="create-model-pick" id="afModel">${modelOpts}</select>
              </div>
              <div class="field">
                <span class="field-label">温度（创造性）</span>
                <div class="range-row">
                  <input type="range" min="0" max="1" step="0.1" id="afTemp" value="${tempDefault ? 0.7 : el('temperature', 0.7)}" ${tempDefault ? 'disabled' : ''} />
                  <span class="range-val" id="afTempVal">${tempDefault ? '默认' : el('temperature', 0.7)}</span>
                  <label class="switch-min"><input type="checkbox" id="afTempDefault" ${tempDefault ? 'checked' : ''}/>跟随默认</label>
                </div>
              </div>
              <div class="field">
                <span class="field-label">Top-P（候选词范围）</span>
                <div class="range-row">
                  <input type="range" min="0" max="1" step="0.05" id="afTopP" value="${topPDefault ? 1 : el('topP', 1)}" ${topPDefault ? 'disabled' : ''} />
                  <span class="range-val" id="afTopPVal">${topPDefault ? '默认' : el('topP', 1)}</span>
                  <label class="switch-min"><input type="checkbox" id="afTopPDefault" ${topPDefault ? 'checked' : ''}/>跟随默认</label>
                </div>
              </div>
              <div class="field"><span class="field-label">联网搜索</span>
                <label class="switch"><input type="checkbox" id="afWeb" ${el('web', false) ? 'checked' : ''}/><span class="switch-track"></span></label>
              </div>
              <div class="field"><span class="field-label">语气风格</span>
                <select class="create-model-pick" id="afTone">${toneOpts}</select>
              </div>
              <label class="field"><span class="field-label">标签（逗号分隔）</span>
                <input type="text" id="afTags" value="${esc((el('tags', []) || []).join('，'))}" placeholder="如 写作，文案" autocomplete="off" />
              </label>
              <div class="field">
                <span class="field-label">任务启动问题（点击即可继续）</span>
                <div id="afStarters">${starters.map(s => App.create.starterRowHtml(s)).join('')}</div>
                <button type="button" class="mini add-starter" id="afAddStarter">+ 添加引导问题</button>
              </div>
              <div class="field"><span class="field-label">图标</span>
                <div class="icon-choices" id="afIcons">
                  ${ICON_CHOICES.map(ic => `<button type="button" class="icon-choice" data-ic="${ic}">${ic}</button>`).join('')}
                </div>
                <input type="text" id="afIconCustom" class="icon-custom" value="${ICON_CHOICES.includes(el('icon', '')) ? '' : esc(el('icon', ''))}" placeholder="或自定义 emoji" maxlength="4" />
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-ghost" id="agentFormCancel">取消</button>
            <button class="btn-primary" id="agentFormSave">保存</button>
          </div>
        </div>`;
      document.body.appendChild(modal);

      // 图标选择
      const chosenIcon = { v: el('icon', '🤖') };
      const markIcon = () => modal.querySelectorAll('.icon-choice').forEach(b => b.classList.toggle('active', b.dataset.ic === chosenIcon.v));
      markIcon();
      modal.querySelectorAll('.icon-choice').forEach(b => b.addEventListener('click', () => {
        chosenIcon.v = b.dataset.ic;
        const c = modal.querySelector('#afIconCustom'); if (c) c.value = '';
        markIcon();
      }));
      const customInput = modal.querySelector('#afIconCustom');
      if (customInput) customInput.addEventListener('input', () => {
        if (customInput.value.trim()) { chosenIcon.v = customInput.value.trim(); markIcon(); }
      });

      // 滑块跟随默认
      const tempEl = modal.querySelector('#afTemp'), tempVal = modal.querySelector('#afTempVal'), tempDef = modal.querySelector('#afTempDefault');
      const topPEl = modal.querySelector('#afTopP'), topPVal = modal.querySelector('#afTopPVal'), topPDef = modal.querySelector('#afTopPDefault');
      tempEl.addEventListener('input', () => { tempVal.textContent = tempEl.value; });
      topPEl.addEventListener('input', () => { topPVal.textContent = topPEl.value; });
      tempDef.addEventListener('change', () => { tempEl.disabled = tempDef.checked; tempVal.textContent = tempDef.checked ? '默认' : tempEl.value; });
      topPDef.addEventListener('change', () => { topPEl.disabled = topPDef.checked; topPVal.textContent = topPDef.checked ? '默认' : topPEl.value; });

      // 引导问题增删
      modal.querySelector('#afAddStarter').addEventListener('click', () => {
        const box = modal.querySelector('#afStarters');
        box.insertAdjacentHTML('beforeend', App.create.starterRowHtml(''));
        box.lastElementChild.querySelector('.starter-del').addEventListener('click', (e) => {
          e.stopPropagation(); e.target.closest('.starter-row').remove();
        });
      });
      modal.querySelectorAll('#afStarters .starter-del').forEach(b => b.addEventListener('click', (e) => {
        e.stopPropagation(); e.target.closest('.starter-row').remove();
      }));

      const nameInput = modal.querySelector('#afName');
      const saveBtn = modal.querySelector('#agentFormSave');
      const close = () => modal.remove();
      const save = () => {
        const name = modal.querySelector('#afName').value.trim();
        if (!name) { App.ui.toast('请填写名称'); nameInput.focus(); return; }
        const tempD = tempDef.checked, topPD = topPDef.checked;
        const data = {
          name,
          desc: modal.querySelector('#afDesc').value.trim(),
          systemPrompt: modal.querySelector('#afPrompt').value.trim(),
          icon: chosenIcon.v || '🤖',
          model: modal.querySelector('#afModel').value,
          temperature: tempD ? null : parseFloat(tempEl.value),
          topP: topPD ? null : parseFloat(topPEl.value),
          web: modal.querySelector('#afWeb').checked,
          tone: modal.querySelector('#afTone').value,
          tags: modal.querySelector('#afTags').value.split(/[,，\s]+/).map(s => s.trim()).filter(Boolean),
          starters: Array.from(modal.querySelectorAll('#afStarters .starter-row input')).map(i => i.value.trim()).filter(Boolean),
        };
        App.state.settings.agents = App.state.settings.agents || [];
        if (isEdit) {
          const t = App.state.settings.agents.find(x => x.id === App.create.editingId);
          if (t) Object.assign(t, data, {
            category: (typeof t.category === 'string' && t.category && t.category !== 'all') ? t.category : 'custom', // v1.1.8 P5：原引用未定义的 CATEGORIES（仅存在于主进程）
            custom: true, recommended: false,
          });
        } else {
          App.state.settings.agents.push(Object.assign({ id: 'a-' + App.uid().slice(1) }, data, { category: 'custom', custom: true, recommended: false }));
        }
        App.persist();
        App.create.editingId = null;
        close();
        App.create.render();
        App.ui.toast(isEdit ? '已更新任务智能体' : '已创建任务智能体');
      };

      modal.querySelector('#agentFormClose').addEventListener('click', close);
      modal.querySelector('#agentFormCancel').addEventListener('click', close);
      saveBtn.addEventListener('click', save);
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
      setTimeout(() => nameInput.focus(), 30);
    },

    starterRowHtml(v) {
      return `<div class="starter-row"><input type="text" value="${esc(v)}" placeholder="如 帮我写一首诗" /><button type="button" class="starter-del" title="删除">×</button></div>`;
    },

    /* ---------- 预览弹窗 ---------- */
    openPreview(agent) {
      const usage = (App.state.settings.agentUsage || {})[agent.id] || 0;
      const cfg = [];
      if (agent.model) cfg.push('模型：' + agent.model);
      if (typeof agent.temperature === 'number') cfg.push('温度：' + agent.temperature);
      if (typeof agent.topP === 'number') cfg.push('Top-P：' + agent.topP);
      if (typeof agent.web === 'boolean') cfg.push('联网：' + (agent.web ? '开' : '关'));
      if (agent.tone) cfg.push('语气：' + agent.tone);
      const tags = (agent.tags && agent.tags.length)
        ? `<div class="pv-tags">${agent.tags.map(t => `<span class="tag-chip">${esc(t)}</span>`).join('')}</div>` : '';
      const starters = (agent.starters && agent.starters.length)
        ? `<div class="pv-starters">
            <div class="pv-prompt-label">引导问题（点击直接开聊）</div>
            <div class="starter-list">${agent.starters.map(s => `<button class="starter-chip" data-starter="${esc(s)}">${esc(s)}</button>`).join('')}</div>
          </div>` : '';
      const reco = (agent.recommended && !agent.custom) ? `<span class="agent-reco big" title="推荐">★ 推荐</span>` : '';
      const cfgHtml = cfg.length ? `<div class="pv-cfg">${cfg.map(x => `<span class="cfg-item">${esc(x)}</span>`).join('')}</div>` : '';
      const previewPrompt = (agent.systemPrompt || '').length > 160
        ? (agent.systemPrompt || '').slice(0, 160) + '…'
        : (agent.systemPrompt || '');

      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.id = 'agentPreviewMask';
      modal.innerHTML = `
        <div class="modal agent-modal" role="dialog" aria-modal="true">
          <div class="modal-header">
              <span>任务智能体详情</span>
            <button class="icon-btn" id="pvClose" aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modal-body">
            <div class="agent-preview">
              <div class="pv-icon">${agent.icon || '🤖'}</div>
              <div class="pv-name">${esc(agent.name)} ${reco}</div>
              <div class="pv-desc">${esc(agent.desc || '')}</div>
              ${tags}
              ${cfgHtml}
              <div class="pv-prompt-label">任务设定</div>
              <div class="pv-prompt">${esc(previewPrompt)}</div>
              ${starters}
            </div>
          </div>
          <div class="modal-footer">
            ${agent.custom ? '<button class="btn-ghost" id="pvEdit">编辑</button><button class="btn-ghost danger" id="pvDel">删除</button>' : '<button class="btn-ghost" id="pvClone">克隆</button>'}
            <button class="btn-primary" id="pvStart">打开任务会话</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      const close = () => modal.remove();
      modal.querySelector('#pvClose').addEventListener('click', close);
      modal.querySelector('#pvStart').addEventListener('click', () => { close(); App.chat.startWithAgent(agent); });
      const pvClone = modal.querySelector('#pvClone');
      if (pvClone) pvClone.addEventListener('click', () => { close(); App.create.cloneAgent(agent.id); });
      const pvEdit = modal.querySelector('#pvEdit');
      if (pvEdit) pvEdit.addEventListener('click', () => { close(); App.create.openAgentForm(agent); });
      const pvDel = modal.querySelector('#pvDel');
      if (pvDel) pvDel.addEventListener('click', () => { close(); App.create.confirmDelete(agent.id); });
      modal.querySelectorAll('.starter-chip').forEach(b => b.addEventListener('click', () => {
        close();
        App.chat.startWithStarter(agent, b.dataset.starter);
      }));
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    },

    /* ---------- 删除确认 ---------- */
    confirmDelete(id) {
      const agent = (App.state.settings.agents || []).find(a => a.id === id);
      const name = agent ? agent.name : '该任务智能体';
      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.id = 'agentDelMask';
      modal.innerHTML = `
        <div class="modal agent-modal" role="dialog" aria-modal="true">
          <div class="modal-header"><span>删除任务智能体</span>
            <button class="icon-btn" id="delClose" aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modal-body"><p class="del-text">确定删除「${esc(name)}」？此操作不可撤销。</p></div>
          <div class="modal-footer">
            <button class="btn-ghost" id="delCancel">取消</button>
            <button class="btn-danger" id="delOk">删除</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      const close = () => modal.remove();
      const del = () => {
        App.state.settings.agents = (App.state.settings.agents || []).filter(a => a.id !== id);
        App.persist();
        close();
        App.create.render();
      App.ui.toast('已删除任务智能体');
      };
      modal.querySelector('#delClose').addEventListener('click', close);
      modal.querySelector('#delCancel').addEventListener('click', close);
      modal.querySelector('#delOk').addEventListener('click', del);
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    },

    /* ============ 工作流 tab ============ */
    renderWorkflows() {
      const c = $('createContent');
      if (!c) return;
      const wfs = App.state.settings.workflows || [];
      c.innerHTML = `
        <div class="create-sec">
          <div class="create-toolbar">
            <div class="toolbar-row between">
          <div class="module-sub">任务工作流（多步串联）</div>
              <button class="btn-primary sm" id="addWfBtn">+ 新建工作流</button>
            </div>
            <div class="wf-hint">每一步可使用上一步的结果作为上下文，按顺序合成最终答案。</div>
          </div>
        </div>
        <div class="wf-grid" id="wfGrid"></div>`;
      wrapCreateGenericLibrary(c, { title: '\u5de5\u4f5c\u6d41', subtitle: '\u591a\u6b65\u9aa4\u4efb\u52a1\u4e32\u8054', expandLabel: '\u5de5\u4f5c\u6d41' });
      $('addWfBtn').addEventListener('click', () => App.create.openWorkflowForm());
      const grid = $('wfGrid');
      if (!wfs.length) {
        grid.innerHTML = '<div class="create-empty">还没有工作流，点“新建工作流”搭建多步任务吧～</div>';
        return;
      }
      grid.innerHTML = wfs.map(w => {
        const steps = w.steps || [];
        const first = steps[0] && steps[0].prompt ? String(steps[0].prompt).slice(0, 40) : '尚未配置步骤';
        return `
        <div class="lib-bar" data-wf="${w.id}">
          <div class="lib-bar-row1">
            <span class="lib-bar-icon">⚙</span>
            <b class="lib-bar-name">${esc(w.name)}</b>
            <span class="lib-bar-ops">
              <button data-run="${w.id}" title="运行工作流">▶</button>
              <button data-edit="${w.id}" title="编辑">✎</button>
              <button data-hist="${w.id}" title="历史">≡</button>
              <button class="danger" data-del="${w.id}" title="删除">×</button>
            </span>
          </div>
          <div class="lib-bar-row2"><span class="lib-bar-desc">${esc(first)}</span><span class="tag-chip">${steps.length} 步</span></div>
        </div>`; }).join('');
      grid.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => {
        const w = (App.state.settings.workflows || []).find(x => x.id === b.dataset.run);
        if (w) App.create.runWorkflow(w);
      }));
      grid.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
        const w = (App.state.settings.workflows || []).find(x => x.id === b.dataset.edit);
        if (w) App.create.openWorkflowForm(w);
      }));
      grid.querySelectorAll('[data-hist]').forEach(b => b.addEventListener('click', () => {
        const w = (App.state.settings.workflows || []).find(x => x.id === b.dataset.hist);
        if (w) App.create.showRunHistory(w);
      }));
      grid.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
        App.state.settings.workflows = (App.state.settings.workflows || []).filter(x => x.id !== b.dataset.del);
        App.persist(); App.create.renderWorkflows(); App.ui.toast('已删除工作流');
      }));
    },

    openWorkflowForm(wf) {
      const isEdit = !!wf;
      const el = (k, d) => (wf && wf[k] != null ? wf[k] : d);
      const steps = (Array.isArray(wf && wf.steps) ? wf.steps : [{ title: '', prompt: '', usePrev: false }]);
      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.id = 'wfModalMask';
      modal.innerHTML = `
        <div class="modal agent-modal" role="dialog" aria-modal="true">
          <div class="modal-header"><span>${isEdit ? '编辑工作流' : '新建工作流'}</span>
            <button class="icon-btn" id="wfClose" aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modal-body">
            <div class="agent-form">
              <label class="field"><span class="field-label">工作流名称 <em>*</em></span>
                <input type="text" id="wfName" value="${esc(el('name', ''))}" placeholder="如 选题→大纲→成稿" autocomplete="off" /></label>
              <div class="field"><span class="field-label">步骤（可拖拽排序）</span>
                <div id="wfSteps">${steps.map((s, i) => App.create.wfStepHtml(s, i)).join('')}</div>
                <button type="button" class="mini" id="wfAddStep">+ 添加步骤</button>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-ghost" id="wfCancel">取消</button>
            <button class="btn-primary" id="wfSave">保存</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      const box = modal.querySelector('#wfSteps');
      modal.querySelector('#wfAddStep').addEventListener('click', () => {
        box.insertAdjacentHTML('beforeend', App.create.wfStepHtml({ title: '', prompt: '', usePrev: false }));
        box.lastElementChild.querySelector('.wf-step-del').addEventListener('click', (e) => {
          e.stopPropagation(); e.target.closest('.wf-step').remove();
          App.create.updateWfNos(box);
        });
        App.create.updateWfNos(box);
      });
      modal.querySelectorAll('#wfSteps .wf-step-del').forEach(b => b.addEventListener('click', (e) => {
        e.stopPropagation(); e.target.closest('.wf-step').remove();
        App.create.updateWfNos(box);
      }));
      App.create.bindWfDrag(box);
      App.create.updateWfNos(box);
      box.addEventListener('change', (e) => {
        const cb = e.target.closest('.wf-step-usePrev'); if (!cb) return;
        const step = cb.closest('.wf-step');
        let badge = step.querySelector('.wf-usePrev-badge');
        if (cb.checked && !badge) {
          badge = document.createElement('span');
          badge.className = 'wf-usePrev-badge'; badge.textContent = '↩ 接上一步';
          step.appendChild(badge);
        } else if (!cb.checked && badge) { badge.remove(); }
      });
      const nameInput = modal.querySelector('#wfName');
      const close = () => modal.remove();
      const save = () => {
        const name = modal.querySelector('#wfName').value.trim();
        if (!name) { App.ui.toast('请填写名称'); nameInput.focus(); return; }
        const stepEls = Array.from(modal.querySelectorAll('#wfSteps .wf-step'));
        const stepsOut = stepEls.map(row => {
          const st = {
            title: row.querySelector('.wf-step-title').value.trim(),
            prompt: row.querySelector('.wf-step-prompt').value.trim(),
            usePrev: row.querySelector('.wf-step-usePrev').checked,
          };
          // M7：步骤级模型 + 失败策略
          const mdl = row.querySelector('.wf-step-model');
          if (mdl && mdl.value) st.model = mdl.value;
          const oe = row.querySelector('.wf-step-onerror');
          if (oe && oe.value && oe.value !== 'continue') st.onError = oe.value;
          if (st.onError === 'retry') st.retries = 2;
          return st;
        }).filter(s => s.prompt.trim());
        if (!stepsOut.length) { App.ui.toast('请至少填写一步的提示词'); return; }
        App.state.settings.workflows = App.state.settings.workflows || [];
        if (isEdit) {
          const t = App.state.settings.workflows.find(x => x.id === wf.id);
          if (t) { t.name = name; t.steps = stepsOut; }
        } else {
          App.state.settings.workflows.push({ id: 'w-' + App.uid().slice(1), name, steps: stepsOut });
        }
        App.persist();
        close();
        if (App.create.tab !== 'workflows') { App.create.tab = 'workflows'; App.create.render(); }
        else App.create.renderWorkflows();
        App.ui.toast(isEdit ? '已更新工作流' : '已创建工作流');
      };
      modal.querySelector('#wfClose').addEventListener('click', close);
      modal.querySelector('#wfCancel').addEventListener('click', close);
      modal.querySelector('#wfSave').addEventListener('click', save);
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
      setTimeout(() => nameInput.focus(), 30);
    },

    bindWfDrag(box) {
      if (!box) return;
      let dragEl = null;
      const getAfter = (y) => {
        const items = Array.from(box.querySelectorAll('.wf-step:not(.dragging)'));
        let closest = null, closestOff = -Infinity;
        for (const el of items) {
          const r = el.getBoundingClientRect();
          const off = y - r.top - r.height / 2;
          if (off < 0 && off > closestOff) { closestOff = off; closest = el; }
        }
        return closest;
      };
      box.addEventListener('dragstart', (e) => {
        const item = e.target.closest('.wf-step'); if (!item) return;
        dragEl = item; item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', ''); } catch (_) {}
      });
      box.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!dragEl) return;
        const after = getAfter(e.clientY);
        if (after == null) box.appendChild(dragEl);
        else box.insertBefore(dragEl, after);
      });
      box.addEventListener('dragend', () => {
        if (dragEl) dragEl.classList.remove('dragging');
        dragEl = null;
        App.create.updateWfNos(box);
      });
    },

    updateWfNos(box) {
      if (!box) return;
      Array.from(box.querySelectorAll('.wf-step')).forEach((el, i) => {
        const no = el.querySelector('.wf-step-no'); if (no) no.textContent = i + 1;
      });
    },

    wfStepHtml(s, idx) {
      const no = (typeof idx === 'number') ? idx + 1 : '';
      // M7：步骤级模型 + 失败策略
      const chatProv = App.getProvider('create');
      const models = (chatProv && chatProv.models && chatProv.models.length) ? chatProv.models : [];
      const onErr = s.onError || 'continue';
      return `<div class="wf-step" draggable="true">
        <div class="wf-step-head">
          <span class="wf-step-drag" title="拖拽排序">⠿</span>
          <span class="wf-step-no">${no}</span>
          <input type="text" class="wf-step-title" value="${esc(s.title || '')}" placeholder="步骤标题（可选）" />
          <button type="button" class="wf-step-del" title="删除">×</button>
        </div>
        <textarea class="wf-step-prompt" rows="2" placeholder="这一步的提示词（支持 {{变量名}}）">${esc(s.prompt || '')}</textarea>
        <div class="wf-step-opts">
          <label class="switch-min"><input type="checkbox" class="wf-step-usePrev" ${s.usePrev ? 'checked' : ''}/>用上一步结果作为上下文</label>
          <select class="wf-step-model" title="本步使用的模型（留空=工作流默认模型）"><option value="">默认模型</option>${models.map(m =>
            `<option value="${esc(m)}"${s.model === m ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select>
          <select class="wf-step-onerror" title="本步失败时的处理">
            <option value="continue"${onErr === 'continue' ? ' selected' : ''}>失败继续</option>
            <option value="stop"${onErr === 'stop' ? ' selected' : ''}>失败停止</option>
            <option value="retry"${onErr === 'retry' ? ' selected' : ''}>失败重试×2</option>
          </select>
        </div>
        ${s.usePrev ? '<span class="wf-usePrev-badge">↩ 接上一步</span>' : ''}
      </div>`;
    },

    async runWorkflow(wf) {
      const s = App.getProvider('create');
      if (!s.ref || !s.hasKey || !s.model) { App.ui.toast('请先在设置里配置糖创账户和模型'); return; }
      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.id = 'wfRunMask';
      modal.innerHTML = `
        <div class="modal agent-modal" role="dialog" aria-modal="true">
          <div class="modal-header"><span>运行工作流：${esc(wf.name)}</span>
            <button class="icon-btn" id="wfRunClose" aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modal-body"><div class="wf-run" id="wfRun"></div></div>
          <div class="modal-footer">
            <button class="btn-ghost" id="wfRunCancel">关闭</button>
            <button class="btn-primary" id="wfRunChat" style="display:none">在糖创继续会话</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      const runBox = modal.querySelector('#wfRun');
      const close = () => { modal.remove(); document.removeEventListener('keydown', onKey); };
      modal.querySelector('#wfRunClose').addEventListener('click', close);
      modal.querySelector('#wfRunCancel').addEventListener('click', close);
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      document.addEventListener('keydown', onKey);

      const steps = (wf.steps || []).filter(st => (st.prompt || '').trim());
      if (!steps.length) { runBox.innerHTML = '<div class="wf-step-out">工作流没有有效步骤。</div>'; return; }
      // M7（v1.0.8）：运行历史记录（独立持久化，SQLite 不可用时静默跳过）
      const run = {
        id: 'wr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        workflowId: wf.id, workflowName: wf.name,
        status: 'running', steps: [],
        startedAt: Date.now(), finishedAt: 0,
      };
      const saveRun = () => {
        try { if (App.services.fs && App.services.fs.saveWorkflowRun) App.services.fs.saveWorkflowRun(run); } catch (_) {}
      };
      saveRun();
      const results = [];
      let prev = '';
      // M7：输入变量——解析全部步骤 prompt 的 {{var}}，运行前收集（无变量则跳过）
      const varNames = [];
      for (const st of steps) {
        const re = /\{\{([^}]+)\}\}/g; let m;
        while ((m = re.exec(st.prompt))) { const v = m[1].trim(); if (v && !varNames.includes(v)) varNames.push(v); }
      }
      const varValues = {};
      if (varNames.length) {
        runBox.insertAdjacentHTML('afterbegin',
          '<div class="wf-vars"><div class="wf-vars-title">输入变量</div>' +
          varNames.map(v => `<label class="wf-var-row"><span>${esc(v)}</span><input type="text" class="wf-var-input" data-var="${esc(v)}" placeholder="输入 ${esc(v)} 的值" autocomplete="off"/></label>`).join('') +
          '<button class="mini" id="wfVarsOk">开始运行</button></div>');
        await new Promise((resolve) => {
          const collect = () => {
            runBox.querySelectorAll('.wf-var-input').forEach(inp => { varValues[inp.dataset.var] = inp.value.trim(); });
            const boxEl = runBox.querySelector('.wf-vars'); if (boxEl) boxEl.remove();
            resolve();
          };
          const okBtn = runBox.querySelector('#wfVarsOk');
          if (okBtn) okBtn.addEventListener('click', collect);
          runBox.querySelectorAll('.wf-var-input').forEach(inp => {
            inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') collect(); });
          });
          const first = runBox.querySelector('.wf-var-input');
          if (first) first.focus();
        });
      }
      const renderPrompt = (tpl) => tpl.replace(/\{\{([^}]+)\}\}/g, (mm, name) => (name.trim() in varValues ? varValues[name.trim()] : mm));
      const models = (s.models && s.models.length) ? s.models : [];
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        runBox.insertAdjacentHTML('beforeend', `<div class="wf-step-out"><div class="wf-step-title">步骤 ${i + 1}：${esc(st.title || '未命名')}</div><div class="wf-step-status">运行中…</div></div>`);
        const statusEl = runBox.lastElementChild.querySelector('.wf-step-status');
        const stepModel = (st.model && models.includes(st.model)) ? st.model : s.model;
        let promptText = renderPrompt(st.prompt || '');
        if (st.usePrev && prev) promptText += '\n\n【上一步的结果】\n' + prev;
        const stepStart = Date.now();
        // M7：单步执行（带 60s 超时），返回 { ok, out } 或 { ok:false, error }
        const attempt = async () => {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 60000);
          try {
            const res = await App.rt.gatewayFetch({
              ref: s.ref, kind: 'chat', telemetry: { scope: 'workflows', callType: 'workflow_step' },
              payload: { model: stepModel, messages: [{ role: 'user', content: promptText }], stream: false },
              signal: ctrl.signal,
            });
            if (!res.ok) {
              const txt = await App.rt.gatewayError(res);
              return { ok: false, error: String(txt) };
            }
            const data = await res.json();
            const out = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
              || (data.choices && data.choices[0] && data.choices[0].text) || '';
            return { ok: true, out };
          } catch (e) {
            return { ok: false, error: (e && e.name === 'AbortError') ? '超时（60s）' : ((e && e.message) || String(e)) };
          } finally { clearTimeout(timer); }
        };
        // 失败策略：continue 默认；retry 重试 retries 次（间隔 800ms）；stop 或重试仍失败 → 终止
        let outcome = await attempt();
        const retries = Math.max(0, parseInt(st.retries, 10) || 0);
        if (!outcome.ok && st.onError === 'retry' && retries > 0) {
          for (let r = 1; r <= retries; r++) {
            statusEl.innerHTML = `<span class="warn">失败，${r}/${retries} 重试中…</span>`;
            await new Promise((res) => setTimeout(res, 800));
            outcome = await attempt();
            if (outcome.ok) break;
          }
        }
        if (!outcome.ok) {
          const msg = outcome.error || '未知错误';
          statusEl.innerHTML = `<span class="error">失败：${esc(String(msg).slice(0, 120))}</span>`;
          run.steps.push({ title: st.title || ('步骤 ' + (i + 1)), status: 'error', error: String(msg).slice(0, 300), startedAt: stepStart, finishedAt: Date.now() });
          prev = '';
          if (st.onError === 'stop' || (st.onError === 'retry' && retries > 0)) { run.status = 'failed'; break; }
          continue;
        }
        const out = outcome.out;
        prev = out;
        results.push({ title: st.title || ('步骤 ' + (i + 1)), content: out });
        run.steps.push({ title: st.title || ('步骤 ' + (i + 1)), status: 'done', content: out, startedAt: stepStart, finishedAt: Date.now() });
        statusEl.innerHTML = '<span class="ok">完成</span>';
        runBox.insertAdjacentHTML('beforeend', `<div class="wf-step-body">${esc(out.length > 600 ? out.slice(0, 600) + '…' : out)}</div>`);
      }
      // 收尾：标记运行状态并落库
      run.status = (run.steps.length === steps.length && run.steps.every(x => x.status === 'done')) ? 'done' : 'failed';
      run.finishedAt = Date.now();
      saveRun();
      const chatBtn = modal.querySelector('#wfRunChat');
      if (results.length) {
        chatBtn.style.display = '';
          chatBtn.addEventListener('click', () => {
            const summary = results.map(r => `## ${r.title}\n${r.content}`).join('\n\n');
            const conv = App.chat.newConversation(null, { stay: 'create', originModule: 'create' });
            if (!conv) return;
            conv.systemPrompt = '你是一个任务助手。下面是多步工作流的执行结果，用户可以基于它继续追问或要求修改。';
          conv.messages.push({ role: 'assistant', content: summary });
          App.chat.persistConversation(conv, { activeId: conv.id });
          App.create.openTaskSession(conv.id);
          App.chat.renderMessages();
          close();
        });
      } else {
        chatBtn.style.display = 'none';
      }
    },

    // M7（v1.0.8）：工作流运行历史查看（数据来自 SQLite workflow_runs 表）
    async showRunHistory(wf) {
      let runs = [];
      try {
        if (App.services.fs && App.services.fs.listWorkflowRuns) {
          const r = await App.services.fs.listWorkflowRuns(wf.id, 20);
          if (r && r.ok) runs = r.runs || [];
        }
      } catch (_) {}
      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.id = 'wfHistMask';
      modal.innerHTML = `
        <div class="modal agent-modal" role="dialog" aria-modal="true">
          <div class="modal-header"><span>运行历史：${esc(wf.name)}</span>
            <button class="icon-btn" id="wfHistClose" aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modal-body"><div class="wf-run" id="wfHistList"></div></div>
          <div class="modal-footer"><button class="btn-ghost" id="wfHistOk">关闭</button></div>
        </div>`;
      document.body.appendChild(modal);
      const box = modal.querySelector('#wfHistList');
      const close = () => modal.remove();
      modal.querySelector('#wfHistClose').addEventListener('click', close);
      modal.querySelector('#wfHistOk').addEventListener('click', close);
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
      if (!runs.length) {
        box.innerHTML = '<div class="wf-step-out">暂无运行记录（运行后自动保存）。</div>';
        return;
      }
      const fmtTime = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '';
      const fmtDur = (a, b) => (a && b && b >= a) ? ((b - a) / 1000).toFixed(1) + 's' : '';
      box.innerHTML = runs.map((run, ri) => {
        const badge = run.status === 'done' ? '<span class="ok">完成</span>'
          : run.status === 'failed' ? '<span class="error">失败</span>'
          : run.status === 'stopped' ? '<span class="warn">已停止</span>' : `<span class="warn">${esc(run.status || 'running')}</span>`;
        const steps = run.steps || [];
        const errs = steps.filter(x => x.status === 'error');
        const detail = steps.length ? steps.map((st, si) => `
          <div class="wf-hist-step">
            <div class="wf-hist-step-head"><span>${si + 1}. ${esc(st.title || '未命名')}</span>
              ${st.status === 'done' ? '<span class="ok">完成</span>' : `<span class="error">${esc(st.error || '错误')}</span>`}
            </div>
            ${st.content ? `<div class="wf-hist-step-body">${esc(st.content.length > 400 ? st.content.slice(0, 400) + '…' : st.content)}</div>` : ''}
          </div>`).join('')
          : '<div class="wf-step-out">无步骤记录</div>';
        return `<details class="wf-hist-item" data-ri="${ri}"${ri === 0 ? ' open' : ''}>
          <summary>
            <span class="wf-hist-badge">${badge}</span>
            <span class="wf-hist-meta">${fmtTime(run.startedAt)} · ${steps.length} 步 · ${fmtDur(run.startedAt, run.finishedAt)}${errs.length ? ' · ' + errs.length + ' 步失败' : ''}</span>
          </summary>
          <div class="wf-hist-detail">${detail}</div>
        </details>`;
      }).join('');
    },
  };

  const renderCreateGrid = App.create.renderGrid;
  App.create.renderGrid = function () {
    renderCreateGrid();
    const grid = $('agentGrid');
    if (!grid) return;
    let add = $('addAgentBtn');
    if (!add) {
      grid.innerHTML = '';
      add = document.createElement('button');
      add.className = 'lib-bar lib-bar--add';
      add.id = 'addAgentBtn';
      add.innerHTML = '<span class="agent-icon">+</span><span class="agent-name">\u65b0\u5efa\u4efb\u52a1\u667a\u80fd\u4f53</span><span class="agent-desc">\u81ea\u5b9a\u4e49\u4efb\u52a1\u8bbe\u5b9a\u4e0e\u63d0\u793a\u8bcd</span>';
      add.addEventListener('click', (event) => { event.stopPropagation(); App.create.openAgentForm(); });
      grid.appendChild(add);
    } else if (grid.firstElementChild !== add) {
      grid.insertBefore(add, grid.firstElementChild);
    }
  };
})();
