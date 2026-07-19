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

  const CATEGORIES = [
    { key: 'all', label: '全部' },
    { key: 'write', label: '写作' },
    { key: 'translate', label: '翻译' },
    { key: 'code', label: '代码' },
    { key: 'career', label: '职场' },
    { key: 'learn', label: '学习' },
    { key: 'custom', label: '自定义' },
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

  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
      if (done) done();
    } catch (e) { App.ui.toast('复制失败'); }
  }

  App.create = {
    stateSearch: '',
    stateCat: 'all',
    stateSort: 'default',
    stateTag: '',
    tab: 'agents',
    editingId: null,

    onShow() {
      App.create.render();
      const t = $('chatTitle');
      if (t) t.textContent = '糖创';
    },

    /* ============ 顶层渲染：子标签 ============ */
    render() {
      const wrap = $('createView');
      if (!wrap) return;
      wrap.innerHTML = `
        <div class="module-header">
          <h2>糖创</h2>
          <p>选择或打造专属智能体，用模板与多步工作流高效创作</p>
        </div>
        <div class="create-tabs" id="createTabs">
          <button class="create-tab${App.create.tab === 'agents' ? ' active' : ''}" data-tab="agents">智能体</button>
          <button class="create-tab${App.create.tab === 'templates' ? ' active' : ''}" data-tab="templates">模板库</button>
          <button class="create-tab${App.create.tab === 'workflows' ? ' active' : ''}" data-tab="workflows">工作流</button>
        </div>
        <div id="createContent"></div>`;
      $('createTabs').addEventListener('click', (e) => {
        const b = e.target.closest('[data-tab]');
        if (!b) return;
        App.create.tab = b.dataset.tab;
        App.create.render();
      });
      if (App.create.tab === 'templates') App.create.renderTemplates();
      else if (App.create.tab === 'workflows') App.create.renderWorkflows();
      else App.create.renderAgents();
    },

    /* ============ 智能体 tab ============ */
    renderAgents() {
      const c = $('createContent');
      if (!c) return;
      const tags = App.create.allTags();
      c.innerHTML = `
        <div class="create-toolbar">
          <input type="text" class="create-search" id="createSearch" placeholder="搜索智能体…" value="${esc(App.create.stateSearch)}" />
          <div class="toolbar-row">
            <div class="cat-pills" id="catPills">
              ${CATEGORIES.map(cat => `<button class="cat-pill${cat.key === App.create.stateCat ? ' active' : ''}" data-cat="${cat.key}">${cat.label}</button>`).join('')}
            </div>
            <select class="create-sort" id="createSort">
              <option value="default"${App.create.stateSort === 'default' ? ' selected' : ''}>默认排序</option>
              <option value="usage"${App.create.stateSort === 'usage' ? ' selected' : ''}>最常用</option>
              <option value="name"${App.create.stateSort === 'name' ? ' selected' : ''}>名称</option>
            </select>
          </div>
          ${tags.length ? `<div class="tag-pills" id="tagPills">
            <button class="tag-pill${App.create.stateTag === '' ? ' active' : ''}" data-tag="">全部标签</button>
            ${tags.map(t => `<button class="tag-pill${App.create.stateTag === t ? ' active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}
          </div>` : ''}
        </div>
        <div class="agent-grid" id="agentGrid"></div>`;

      const search = $('createSearch');
      if (search) search.addEventListener('input', (e) => {
        App.create.stateSearch = e.target.value.trim().toLowerCase();
        App.create.renderGrid(); // 仅刷新网格，保留输入框焦点
      });
      $('catPills').addEventListener('click', (e) => {
        const pill = e.target.closest('[data-cat]');
        if (!pill) return;
        App.create.stateCat = pill.dataset.cat;
        App.create.renderAgents();
      });
      $('createSort').addEventListener('change', (e) => { App.create.stateSort = e.target.value; App.create.renderAgents(); });
      const tagPills = $('tagPills');
      if (tagPills) tagPills.addEventListener('click', (e) => {
        const pill = e.target.closest('[data-tag]');
        if (!pill) return;
        App.create.stateTag = pill.dataset.tag;
        App.create.renderAgents();
      });
      App.create.renderGrid();
    },

    renderGrid() {
      const grid = $('agentGrid');
      if (!grid) return;
      const kw = App.create.stateSearch;
      const cat = App.create.stateCat;
      const tag = App.create.stateTag;
      const usage = App.state.settings.agentUsage || {};
      const custom = App.state.settings.agents || [];
      let all = [
        ...PRESET_AGENTS.map(a => Object.assign({ custom: false }, a)),
        ...custom.map(a => Object.assign({ custom: true }, a)),
      ];
      let filtered = all.filter(a => {
        const hitKw = !kw || (a.name + ' ' + (a.desc || '')).toLowerCase().includes(kw);
        const hitCat = cat === 'all' || (a.category || 'custom') === cat;
        const hitTag = !tag || (a.tags || []).includes(tag);
        return hitKw && hitCat && hitTag;
      });
      if (App.create.stateSort === 'usage') filtered.sort((x, y) => ((usage[y.id] || 0) - (usage[x.id] || 0)));
      else if (App.create.stateSort === 'name') filtered.sort((x, y) => x.name.localeCompare(y.name, 'zh'));

      if (!filtered.length) {
        grid.innerHTML = '<div class="create-empty">没有匹配的智能体，换个关键词或分类试试～</div>';
        return;
      }
      grid.innerHTML = filtered.map(a => App.create.agentCard(a)).join('') +
        `<button class="agent-card add-agent" id="addAgentBtn">
           <span class="agent-icon">➕</span>
           <span class="agent-name">新建智能体</span>
           <span class="agent-desc">自定义角色与提示词</span>
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
      const modelBadge = a.model ? `<span class="agent-badge">${esc(shortModel(a.model))}</span>` : '';
      const reco = (a.recommended && !a.custom) ? `<span class="agent-reco" title="推荐">★</span>` : '';
      const tags = (a.tags && a.tags.length)
        ? `<div class="agent-tags">${a.tags.slice(0, 3).map(t => `<span class="tag-chip">${esc(t)}</span>`).join('')}</div>` : '';
      const usageLine = usage ? `<div class="agent-usage">用了 ${usage} 次</div>` : '';
      const actions = a.custom
        ? `<button class="agent-edit" data-edit="${a.id}" title="编辑">✎</button>
           <button class="agent-del" data-del="${a.id}" title="删除">×</button>`
        : `<button class="agent-clone" data-clone="${a.id}" title="克隆">⧉</button>`;
      return `<div class="agent-card" data-agent="${a.id}">
        ${reco}
        <span class="agent-icon">${a.icon || '🤖'}</span>
        <span class="agent-name">${esc(a.name)}</span>
        <span class="agent-desc">${esc(a.desc || '')}</span>
        ${tags}
        ${modelBadge}
        ${usageLine}
        ${actions}
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
      App.ui.toast('已克隆为自定义智能体');
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
      const chatProv = App.getProvider('chat');
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
            <span>${isEdit ? '编辑智能体' : '新建智能体'}</span>
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
                <input type="text" id="afDesc" value="${esc(el('desc', ''))}" placeholder="这个智能体擅长做什么" autocomplete="off" />
              </label>
              <label class="field"><span class="field-label">系统提示词（角色设定）</span>
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
                <span class="field-label">引导问题（点击即可开聊）</span>
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
            category: (CATEGORIES.some(c => c.key === (t.category || 'custom')) && t.category !== 'all') ? t.category : 'custom',
            custom: true, recommended: false,
          });
        } else {
          App.state.settings.agents.push(Object.assign({ id: 'a-' + App.uid().slice(1) }, data, { category: 'custom', custom: true, recommended: false }));
        }
        App.persist();
        App.create.editingId = null;
        close();
        App.create.render();
        App.ui.toast(isEdit ? '已更新智能体' : '已创建智能体');
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
            <span>智能体详情</span>
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
              <div class="pv-prompt-label">角色设定</div>
              <div class="pv-prompt">${esc(previewPrompt)}</div>
              ${starters}
            </div>
          </div>
          <div class="modal-footer">
            ${agent.custom ? '<button class="btn-ghost" id="pvEdit">编辑</button><button class="btn-ghost danger" id="pvDel">删除</button>' : '<button class="btn-ghost" id="pvClone">克隆</button>'}
            <button class="btn-primary" id="pvStart">开始对话</button>
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
      const name = agent ? agent.name : '该智能体';
      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.id = 'agentDelMask';
      modal.innerHTML = `
        <div class="modal agent-modal" role="dialog" aria-modal="true">
          <div class="modal-header"><span>删除智能体</span>
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
        App.ui.toast('已删除智能体');
      };
      modal.querySelector('#delClose').addEventListener('click', close);
      modal.querySelector('#delCancel').addEventListener('click', close);
      modal.querySelector('#delOk').addEventListener('click', del);
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    },

    /* ============ 模板库 tab ============ */
    renderTemplates() {
      const c = $('createContent');
      if (!c) return;
      const tpls = App.state.settings.templates || [];
      c.innerHTML = `
        <div class="create-toolbar">
          <div class="toolbar-row between">
            <div class="module-sub">提示词模板库</div>
            <button class="btn-primary sm" id="addTplBtn">+ 新建模板</button>
          </div>
        </div>
        <div class="tpl-grid" id="tplGrid"></div>`;
      $('addTplBtn').addEventListener('click', () => App.create.openTemplateForm());
      const grid = $('tplGrid');
      if (!tpls.length) {
        grid.innerHTML = '<div class="create-empty">还没有模板，点“新建模板”添加常用提示词吧～</div>';
        return;
      }
      grid.innerHTML = tpls.map(t => `
        <div class="tpl-card" data-tpl="${t.id}">
          <div class="tpl-head"><span class="tpl-ico">${esc(t.icon || '📋')}</span><span class="tpl-title">${esc(t.title)}</span>${t.category ? `<span class="tpl-cat">${esc(t.category)}</span>` : ''}</div>
          <div class="tpl-prompt">${esc((t.prompt || '').length > 120 ? (t.prompt || '').slice(0, 120) + '…' : (t.prompt || ''))}</div>
          <div class="tpl-ops">
            <button class="mini" data-use="${t.id}">使用</button>
            <button class="mini" data-copy="${t.id}">复制</button>
            <button class="mini" data-edit="${t.id}">编辑</button>
            <button class="mini danger" data-del="${t.id}">删除</button>
          </div>
        </div>`).join('');
      grid.querySelectorAll('[data-use]').forEach(b => b.addEventListener('click', () => {
        const t = (App.state.settings.templates || []).find(x => x.id === b.dataset.use);
        if (t) App.create.useTemplate(t);
      }));
      grid.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => {
        const t = (App.state.settings.templates || []).find(x => x.id === b.dataset.copy);
        if (!t) return;
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t.prompt || '').then(() => App.ui.toast('已复制提示词')).catch(() => fallbackCopy(t.prompt || ''));
        else fallbackCopy(t.prompt || '');
      }));
      grid.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
        const t = (App.state.settings.templates || []).find(x => x.id === b.dataset.edit);
        if (t) App.create.openTemplateForm(t);
      }));
      grid.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
        App.state.settings.templates = (App.state.settings.templates || []).filter(x => x.id !== b.dataset.del);
        App.persist(); App.create.renderTemplates(); App.ui.toast('已删除模板');
      }));
    },

    useTemplate(t) {
      App.chat.newConversation();
      const input = $('input');
      if (input) { input.value = t.prompt || ''; input.focus(); }
    },

    openTemplateForm(tpl) {
      const isEdit = !!tpl;
      const el = (k, d) => (tpl && tpl[k] != null ? tpl[k] : d);
      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.id = 'tplModalMask';
      modal.innerHTML = `
        <div class="modal agent-modal" role="dialog" aria-modal="true">
          <div class="modal-header"><span>${isEdit ? '编辑模板' : '新建模板'}</span>
            <button class="icon-btn" id="tplClose" aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modal-body">
            <div class="agent-form">
              <label class="field"><span class="field-label">标题 <em>*</em></span>
                <input type="text" id="tfTitle" value="${esc(el('title', ''))}" placeholder="如 周报模板" autocomplete="off" /></label>
              <label class="field"><span class="field-label">分类</span>
                <input type="text" id="tfCat" value="${esc(el('category', ''))}" placeholder="如 职场 / 写作" autocomplete="off" /></label>
              <label class="field"><span class="field-label">图标</span>
                <input type="text" id="tfIcon" class="icon-custom" value="${esc(el('icon', ''))}" placeholder="emoji，如 📋" maxlength="4" /></label>
              <label class="field"><span class="field-label">提示词 <em>*</em></span>
                <textarea id="tfPrompt" rows="5" placeholder="写下可复用的提示词…">${esc(el('prompt', ''))}</textarea></label>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-ghost" id="tplCancel">取消</button>
            <button class="btn-primary" id="tplSave">保存</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      const titleInput = modal.querySelector('#tfTitle');
      const close = () => modal.remove();
      const save = () => {
        const title = modal.querySelector('#tfTitle').value.trim();
        const prompt = modal.querySelector('#tfPrompt').value.trim();
        if (!title || !prompt) { App.ui.toast('请填写标题和提示词'); return; }
        const data = { title, category: modal.querySelector('#tfCat').value.trim(), icon: modal.querySelector('#tfIcon').value.trim() || '📋', prompt };
        App.state.settings.templates = App.state.settings.templates || [];
        if (isEdit) {
          const t = App.state.settings.templates.find(x => x.id === tpl.id);
          if (t) Object.assign(t, data);
        } else {
          App.state.settings.templates.push(Object.assign({ id: 't-' + App.uid().slice(1) }, data));
        }
        App.persist();
        close();
        if (App.create.tab !== 'templates') { App.create.tab = 'templates'; App.create.render(); }
        else App.create.renderTemplates();
        App.ui.toast(isEdit ? '已更新模板' : '已创建模板');
      };
      modal.querySelector('#tplClose').addEventListener('click', close);
      modal.querySelector('#tplCancel').addEventListener('click', close);
      modal.querySelector('#tplSave').addEventListener('click', save);
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
      setTimeout(() => titleInput.focus(), 30);
    },

    /* ============ 工作流 tab ============ */
    renderWorkflows() {
      const c = $('createContent');
      if (!c) return;
      const wfs = App.state.settings.workflows || [];
      c.innerHTML = `
        <div class="create-toolbar">
          <div class="toolbar-row between">
            <div class="module-sub">智能体工作流（多步串联）</div>
            <button class="btn-primary sm" id="addWfBtn">+ 新建工作流</button>
          </div>
          <div class="wf-hint">每一步可使用上一步的结果作为上下文，按顺序合成最终答案。</div>
        </div>
        <div class="wf-grid" id="wfGrid"></div>`;
      $('addWfBtn').addEventListener('click', () => App.create.openWorkflowForm());
      const grid = $('wfGrid');
      if (!wfs.length) {
        grid.innerHTML = '<div class="create-empty">还没有工作流，点“新建工作流”搭建多步任务吧～</div>';
        return;
      }
      grid.innerHTML = wfs.map(w => `
        <div class="wf-card" data-wf="${w.id}">
          <div class="wf-name">${esc(w.name)}</div>
          <div class="wf-sub">${(w.steps || []).length} 步</div>
          <div class="wf-ops">
            <button class="mini" data-run="${w.id}">运行</button>
            <button class="mini" data-edit="${w.id}">编辑</button>
            <button class="mini danger" data-del="${w.id}">删除</button>
          </div>
        </div>`).join('');
      grid.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => {
        const w = (App.state.settings.workflows || []).find(x => x.id === b.dataset.run);
        if (w) App.create.runWorkflow(w);
      }));
      grid.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
        const w = (App.state.settings.workflows || []).find(x => x.id === b.dataset.edit);
        if (w) App.create.openWorkflowForm(w);
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
        const stepsOut = stepEls.map(row => ({
          title: row.querySelector('.wf-step-title').value.trim(),
          prompt: row.querySelector('.wf-step-prompt').value.trim(),
          usePrev: row.querySelector('.wf-step-usePrev').checked,
        })).filter(s => s.prompt.trim());
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
      return `<div class="wf-step" draggable="true">
        <div class="wf-step-head">
          <span class="wf-step-drag" title="拖拽排序">⠿</span>
          <span class="wf-step-no">${no}</span>
          <input type="text" class="wf-step-title" value="${esc(s.title || '')}" placeholder="步骤标题（可选）" />
          <button type="button" class="wf-step-del" title="删除">×</button>
        </div>
        <textarea class="wf-step-prompt" rows="2" placeholder="这一步的提示词">${esc(s.prompt || '')}</textarea>
        <label class="switch-min"><input type="checkbox" class="wf-step-usePrev" ${s.usePrev ? 'checked' : ''}/>用上一步结果作为上下文</label>
        ${s.usePrev ? '<span class="wf-usePrev-badge">↩ 接上一步</span>' : ''}
      </div>`;
    },

    async runWorkflow(wf) {
      const s = App.getProvider('chat');
      if (!s.apiBase || !s.apiKey || !s.model) { App.ui.toast('请先在设置里配置聊天 API'); return; }
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
            <button class="btn-primary" id="wfRunChat" style="display:none">完成并开聊</button>
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
      const base = s.apiBase.replace(/\/+$/, '');
      const url = /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
      const results = [];
      let prev = '';
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        runBox.insertAdjacentHTML('beforeend', `<div class="wf-step-out"><div class="wf-step-title">步骤 ${i + 1}：${esc(st.title || '未命名')}</div><div class="wf-step-status">运行中…</div></div>`);
        const statusEl = runBox.lastElementChild.querySelector('.wf-step-status');
        let promptText = st.prompt || '';
        if (st.usePrev && prev) promptText += '\n\n【上一步的结果】\n' + prev;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60000);
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + s.apiKey },
            body: JSON.stringify({ model: s.model, messages: [{ role: 'user', content: promptText }], stream: false }),
            signal: ctrl.signal,
          });
          if (!res.ok) {
            const txt = await res.text().catch(() => '');
            statusEl.innerHTML = `<span class="error">失败（${res.status}）：${esc(txt.slice(0, 120))}</span>`;
            prev = ''; continue;
          }
          const data = await res.json();
          const out = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
            || (data.choices && data.choices[0] && data.choices[0].text) || '';
          prev = out;
          results.push({ title: st.title || ('步骤 ' + (i + 1)), content: out });
          statusEl.innerHTML = '<span class="ok">完成</span>';
          runBox.insertAdjacentHTML('beforeend', `<div class="wf-step-body">${esc(out.length > 600 ? out.slice(0, 600) + '…' : out)}</div>`);
        } catch (e) {
          clearTimeout(timer);
          if (e && e.name === 'AbortError') statusEl.innerHTML = '<span class="error">超时（60s）</span>';
          else statusEl.innerHTML = `<span class="error">错误：${esc(String((e && e.message) || e))}</span>`;
          prev = ''; continue;
        }
        clearTimeout(timer);
      }
      const chatBtn = modal.querySelector('#wfRunChat');
      if (results.length) {
        chatBtn.style.display = '';
        chatBtn.addEventListener('click', () => {
          const summary = results.map(r => `## ${r.title}\n${r.content}`).join('\n\n');
          const conv = App.chat.newConversation();
          conv.systemPrompt = '你是一个任务助手。下面是多步工作流的执行结果，用户可以基于它继续追问或要求修改。';
          conv.messages.push({ role: 'assistant', content: summary });
          App.persist();
          App.chat.showChat();
          App.chat.renderMessages();
          close();
        });
      } else {
        chatBtn.style.display = 'none';
      }
    },
  };
})();
