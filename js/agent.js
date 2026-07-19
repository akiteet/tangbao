'use strict';
(function () {
  window.App = window.App || {};

  const AGENT_BASE = 'http://localhost:3000';
  const MAX_HISTORY = 12;
  const MAX_THREAD_HISTORY = 60;

  App.agent = {
    running: false,
    _ctrl: null,

    onShow() { App.agent.render(); },

    // ===== 项目模型 =====
    projects() {
      if (!Array.isArray(App.state.projects)) App.state.projects = [];
      return App.state.projects;
    },
    activeProject() {
      const list = App.agent.projects();
      let p = list.find(x => x.id === App.state.activeProjectId);
      if (!p) {
        p = list[0] || null;
        if (!p) p = App.agent.createProject(false);
        App.state.activeProjectId = p.id;
      }
      return p;
    },
    createProject(persist) {
      const p = {
        id: App.uid(), name: '新项目', cwd: '', auto: false,
        approveTools: ['write_file', 'edit_file'], cmdWhitelist: [],
        planMode: false,
        createdAt: Date.now(), lastUsedAt: Date.now(),
      };
      App.agent.projects().unshift(p);
      App.state.activeProjectId = p.id;
      if (persist !== false) App.persist();
      return p;
    },
    switchProject(id) {
      const p = App.agent.projects().find(x => x.id === id);
      if (!p) return;
      p.lastUsedAt = Date.now();
      App.state.activeProjectId = id;
      // 切到该项目的首个会话
      const t = App.agent.threads()[0];
      App.state.activeThreadId = t ? t.id : null;
      App.persist();
      App.agent.render();
    },
    // 删除确认弹窗（防误删）
    confirmDelete(type, id, name) {
      const isProject = type === 'project';
      const title = isProject ? '删除项目' : '删除会话';
      const msg = isProject
        ? `确定删除项目「${name}」吗？该项目下所有会话将一并删除，此操作不可撤销。`
        : `确定删除会话「${name}」吗？此操作不可撤销。`;
      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" style="width:400px">
          <div class="modal-header"><span>${title}</span>
            <button class="icon-btn" id="cdClose"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
          </div>
          <div class="modal-body"><p style="font-size:14px;line-height:1.6;color:var(--text);margin:0">${App.escapeHtml(msg)}</p></div>
          <div class="modal-footer">
            <button class="btn-ghost" id="cdCancel">取消</button>
            <button class="btn-danger" id="cdConfirm">删除</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      const close = () => modal.remove();
      modal.querySelector('#cdClose').onclick = close;
      modal.querySelector('#cdCancel').onclick = close;
      modal.querySelector('#cdConfirm').onclick = () => {
        close();
        if (isProject) App.agent.deleteProject(id);
        else App.agent.deleteThread(id);
      };
    },

    deleteProject(id) {
      // 删除项目时，中止该项目下正在运行的会话
      if (App.agent.running && App.state.agentThreads.some(t => t.projectId === id && t.id === App.state.activeThreadId)) {
        App.agent.stop();
      }
      if (App.agent.projects().length <= 1) { App.ui.toast('至少保留一个项目'); return; }
      const list = App.agent.projects();
      const i = list.findIndex(p => p.id === id);
      if (i < 0) return;
      list.splice(i, 1);
      // 删除该项目下所有会话
      App.state.agentThreads = App.state.agentThreads.filter(t => t.projectId !== id);
      if (App.state.activeProjectId === id) {
        App.state.activeProjectId = list[0] ? list[0].id : null;
        const t = App.agent.threads()[0];
        App.state.activeThreadId = t ? t.id : null;
      }
      App.persist();
      App.agent.render();
    },

    // 项目设置弹窗
    openProjectSettings(id) {
      const p = App.agent.projects().find(x => x.id === id);
      if (!p) return;
      const hasDialog = !!(window.electron && window.electron.showDirDialog);
      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.id = 'projectModalMask';
      modal.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" style="width:520px">
          <div class="modal-header"><span>项目设置</span>
            <button class="icon-btn" id="projClose"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
          </div>
          <div class="modal-body">
            <div class="agent-form">
              <label class="field"><span class="field-label">项目名称</span>
                <input type="text" id="projName" value="${App.escapeHtml(p.name)}" /></label>
              <label class="field"><span class="field-label">工作目录</span>
                <div class="agent-cwd-row">
                  <input type="text" id="projCwd" value="${App.escapeHtml(p.cwd)}" placeholder="留空=后端启动目录" />
                  ${hasDialog ? '<button class="btn-ghost mini" id="projBrowse">浏览…</button>' : ''}
                </div>
                <p class="hint">糖码只能在此目录内执行命令和文件操作（安全沙箱）。</p></label>
              <label class="field proj-switch"><input type="checkbox" id="projAuto" ${p.auto ? 'checked' : ''} />
                <span>自动执行命令</span>
                <p class="hint">开启后命令自动执行无需逐条审批；仍可对下方工具强制审批。</p></label>
              <label class="field proj-switch"><input type="checkbox" id="projPlan" ${p.planMode ? 'checked' : ''} />
                <span>Plan 模式（只读探索）</span>
                <p class="hint">开启后糖码只能浏览/搜索文件、联网查资料，禁止写文件与执行命令，适合先制定方案再动手。可随时在顶栏切换。</p></label>
              <div class="field"><span class="field-label">需强制审批的工具</span>
                <div class="proj-perms">
                  <label class="mod-row"><input type="checkbox" data-tool="write_file" ${p.approveTools.includes('write_file') ? 'checked' : ''} /> <span>写文件 (write_file)</span></label>
                  <label class="mod-row"><input type="checkbox" data-tool="edit_file" ${p.approveTools.includes('edit_file') ? 'checked' : ''} /> <span>编辑文件 (edit_file)</span></label>
                </div>
                <p class="hint">勾选后即使开启自动执行，这些工具仍需逐次审批。</p></div>
              <label class="field"><span class="field-label">免审批命令白名单</span>
                <textarea id="projWhitelist" rows="4" placeholder="每行一条，如：&#10;git status&#10;ls&#10;dir">${App.escapeHtml((p.cmdWhitelist || []).join('\n'))}</textarea>
                <p class="hint">匹配的命令（含子命令）跳过审批。如 git status 匹配 "git status -s"。</p></label>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn-ghost" id="projCancel">取消</button>
            <button class="btn-primary" id="projSave">保存</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      const close = () => { modal.remove(); };
      modal.querySelector('#projClose').onclick = close;
      modal.querySelector('#projCancel').onclick = close;
      const browse = modal.querySelector('#projBrowse');
      if (browse) browse.onclick = async () => {
        try {
          const dir = await window.electron.showDirDialog();
          if (dir) modal.querySelector('#projCwd').value = dir;
        } catch (e) {}
      };
      modal.querySelector('#projSave').onclick = () => {
        p.name = (modal.querySelector('#projName').value || '').trim() || '未命名项目';
        p.cwd = (modal.querySelector('#projCwd').value || '').trim();
        p.auto = !!modal.querySelector('#projAuto').checked;
        p.planMode = !!modal.querySelector('#projPlan').checked;
        p.approveTools = Array.from(modal.querySelectorAll('input[data-tool]:checked')).map(c => c.dataset.tool);
        p.cmdWhitelist = (modal.querySelector('#projWhitelist').value || '')
          .split('\n').map(s => s.trim()).filter(Boolean);
        App.persist();
        close();
        App.agent.render();
        App.ui.toast('项目设置已保存');
      };
    },

    // ===== 会话线程模型 =====
    threads() {
      if (!Array.isArray(App.state.agentThreads)) App.state.agentThreads = [];
      const pid = App.state.activeProjectId;
      return App.state.agentThreads.filter(t => t.projectId === pid);
    },
    activeThread() {
      const list = App.agent.threads();
      let t = list.find(x => x.id === App.state.activeThreadId);
      if (!t) {
        t = list[0] || null;
        if (!t) t = App.agent.createThread(false);
        App.state.activeThreadId = t.id;
      }
      return t;
    },
    createThread(persist) {
      const t = { id: App.uid(), projectId: App.state.activeProjectId, title: '新会话', updatedAt: Date.now(), history: [] };
      App.state.agentThreads.push(t);
      App.state.activeThreadId = t.id;
      if (persist !== false) App.persist();
      return t;
    },

    // ===== 渲染 =====
    render() {
      const wrap = document.getElementById('agentView');
      if (!wrap) return;
      const chatProv = App.getProvider('chat');
      const models = (chatProv.models && chatProv.models.length) ? chatProv.models : (chatProv.model ? [chatProv.model] : []);
      const sel = chatProv.model || models[0] || '';
      const modelOpts = models.length
        ? models.map(m => `<option value="${App.escapeHtml(m)}"${m === sel ? ' selected' : ''}>${App.escapeHtml(m)}</option>`).join('')
        : '<option value="" disabled selected>未配置聊天模型</option>';
      const proj = App.agent.activeProject();
      const cwdDisp = proj.cwd || '(后端默认目录)';
      const autoLabel = proj.auto ? '自动执行' : '每步确认';
      const projCollapsed = !!App.state.agentProjectsCollapsed;
      const sessCollapsed = !!App.state.agentSessionsCollapsed;
      const cwdFull = proj.name + '  ·  ' + cwdDisp;

      wrap.innerHTML = `
        <div class="agent-layout">
          ${(projCollapsed && sessCollapsed) ? `
          <div class="agent-tabs-stack" id="agentTabsStack">
            <div class="agent-expand-tab proj-tab" id="agentExpandProjects" title="展开项目栏"><span>项目</span></div>
            <div class="agent-expand-tab sess-tab" id="agentExpandSessions" title="展开会话栏"><span>会话</span></div>
          </div>` : `
          ${projCollapsed
            ? '<div class="agent-expand-tab proj-tab" id="agentExpandProjects" title="展开项目栏"><span>项目</span></div>'
            : `<aside class="agent-projects" id="agentProjectsAside">
              <div class="agent-projects-head">
                <span>项目</span>
                <div style="display:flex;gap:4px;align-items:center">
                  <button class="btn-ghost mini" id="agentNewProject">＋ 新建</button>
                  <button class="agent-collapse-btn" id="agentCollapseProjects" title="折叠项目栏"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
                </div>
              </div>
              <div class="agent-project-list" id="agentProjectList"></div>
            </aside>`}
          ${sessCollapsed
            ? '<div class="agent-expand-tab sess-tab" id="agentExpandSessions" title="展开会话栏"><span>会话</span></div>'
            : `<aside class="agent-sessions" id="agentSessionsAside">
              <div class="agent-sessions-head">
                <span>会话</span>
                <div style="display:flex;gap:4px;align-items:center">
                  <button class="btn-ghost mini" id="agentNewChat">＋ 新建</button>
                  <button class="agent-collapse-btn" id="agentCollapseSessions" title="折叠会话栏"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
                </div>
              </div>
              <div class="agent-session-list" id="agentSessionList"></div>
            </aside>`}`}
          <div class="agent-main">
            <div class="agent-top">
              <div class="agent-field grow">
                <label>当前项目 / 工作目录</label>
                <div class="agent-cwd-row">
                  <div class="agent-cwd-disp" id="agentCwdDisp" title="${App.escapeHtml(cwdFull)}"><span class="cwd-proj">${App.escapeHtml(proj.name)}</span>  ·  ${App.escapeHtml(cwdDisp)}</div>
                  <button class="btn-ghost mini" id="agentProjectSettings">[设置]</button>
                </div>
              </div>
              <div class="agent-field">
                <label>模型</label>
                <select class="img-model-pick" id="agentModel">${modelOpts}</select>
              </div>
              <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
                <button class="btn-ghost" id="agentTest">测试连接</button>
                <span class="agent-status off" id="agentStatus">未连接</span>
              </div>
              <span class="agent-auto-badge ${proj.auto ? 'on' : 'off'}" id="agentAutoBadge">${autoLabel}</span>
              <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
                <label class="switch plan-switch"><input type="checkbox" id="agentPlanToggle" ${proj.planMode ? 'checked' : ''} /> <span>Plan 模式</span></label>
                <span class="agent-status plan-badge ${proj.planMode ? 'on' : 'off'}" id="agentPlanBadge">${proj.planMode ? '只读探索' : '可执行'}</span>
              </div>
            </div>
            <div class="agent-meta" id="agentMeta" style="display:none"></div>
            <div class="agent-offline" id="agentOffline" style="display:none">
              <strong>后端未运行</strong>
              <p>糖码需要一个本地后端来执行命令与文件操作。请在终端运行：</p>
              <pre>node server/agent-server.js</pre>
              <p class="hint">默认地址 <code>${AGENT_BASE}</code>。启动后再点「测试连接」。</p>
            </div>
            <div class="agent-thread" id="agentThread"></div>
            <div class="agent-composer">
              <textarea id="agentInput" rows="1" placeholder="给糖码下达任务（Enter 发送，Shift+Enter 换行）"></textarea>
              <button id="agentSend" disabled>发送</button>
            </div>
          </div>
        </div>`;
      App.agent.bind();
      App.agent.renderProjects();
      App.agent.renderSessions();
      App.agent.restoreThread();
    },

    renderProjects() {
      const box = document.getElementById('agentProjectList');
      if (!box) return;
      const list = App.agent.projects().slice().sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0));
      if (!list.length) { box.innerHTML = '<div class="agent-session-empty">还没有项目</div>'; return; }
      const active = App.state.activeProjectId;
      box.innerHTML = list.map(p => {
        return `<div class="agent-project${p.id === active ? ' active' : ''}" data-id="${p.id}">
          <span class="agent-project-name" title="${App.escapeHtml(p.name + (p.cwd ? ' · ' + p.cwd : ''))}">${App.escapeHtml(p.name)}</span>
          <button class="agent-session-ren" title="设置" data-pset="${p.id}">[S]</button>
          <button class="agent-session-del" title="删除" data-pdel="${p.id}">[X]</button>
        </div>`;
      }).join('');
    },

    renderSessions() {
      const box = document.getElementById('agentSessionList');
      if (!box) return;
      const list = App.agent.threads().slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (!list.length) { box.innerHTML = '<div class="agent-session-empty">还没有会话</div>'; return; }
      const active = App.state.activeThreadId;
      box.innerHTML = list.map(t => {
        const n = (t.history || []).length;
        return `<div class="agent-session${t.id === active ? ' active' : ''}" data-id="${t.id}">
          <span class="agent-session-title" title="${App.escapeHtml(t.title)}">${App.escapeHtml(t.title || '新会话')}</span>
          <span class="agent-session-count">${n}</span>
          <button class="agent-session-ren" title="重命名" data-ren="${t.id}">[R]</button>
          <button class="agent-session-del" title="删除" data-del="${t.id}">[X]</button>
        </div>`;
      }).join('');
    },

    restoreThread() {
      const thread = document.getElementById('agentThread');
      if (!thread) return;
      thread.innerHTML = '';
      const t = App.agent.activeThread();
      const hist = (t && t.history) || [];
      if (!hist.length) {
        const d = document.createElement('div');
        d.className = 'agent-empty';
        d.innerHTML = '描述你希望它完成的任务，例如：<br/>「列出当前目录的 .js 文件并统计总行数」「读取 server/agent-server.js，解释它的工具循环」「联网查一下这个报错怎么解决」';
        thread.appendChild(d);
        return;
      }
      for (const h of hist) {
        if (h.role === 'user') {
          const node = document.createElement('div');
          node.className = 'agent-msg user';
          node.textContent = h.content;
          thread.appendChild(node);
        } else if (h.role === 'assistant') {
          const node = document.createElement('div');
          node.className = 'agent-msg assistant';
          node.innerHTML = '<div class="agent-answer">' + App.renderMarkdown(h.content || '') + '</div>';
          App.agent.addCrossActions(node, h.content || '');
          thread.appendChild(node);
        }
      }
      thread.scrollTop = thread.scrollHeight;
    },

    // ===== 会话 CRUD =====
    switchThread(id) {
      App.state.activeThreadId = id;
      App.persist();
      App.agent.renderSessions();
      App.agent.restoreThread();
    },
    newChat() {
      App.agent.createThread(true);
      App.agent.renderSessions();
      App.agent.restoreThread();
      const input = document.getElementById('agentInput');
      if (input) input.focus();
    },
    deleteThread(id) {
      // 若删除的会话正在运行，先中止任务
      if (App.agent.running && App.state.activeThreadId === id) App.agent.stop();
      const all = App.state.agentThreads;
      const i = all.findIndex(t => t.id === id);
      if (i < 0) return;
      all.splice(i, 1);
      if (App.state.activeThreadId === id) {
        const t = App.agent.threads()[0];
        App.state.activeThreadId = t ? t.id : null;
      }
      App.persist();
      App.agent.renderSessions();
      App.agent.restoreThread();
      App.ui.toast('已删除会话');
    },
    renameThread(id) {
      const item = document.querySelector('.agent-session[data-id="' + id + '"]');
      if (!item) return;
      const titleEl = item.querySelector('.agent-session-title');
      const t = App.state.agentThreads.find(x => x.id === id);
      if (!titleEl || !t) return;
      const input = document.createElement('input');
      input.className = 'agent-session-input';
      input.value = t.title || '';
      titleEl.replaceWith(input);
      input.focus(); input.select();
      const commit = () => {
        const v = input.value.trim();
        t.title = v || '新会话';
        App.persist();
        App.agent.renderSessions();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { App.agent.renderSessions(); }
      });
      input.addEventListener('blur', commit);
    },

    // ===== 跨模块按钮 =====
    addCrossActions(assistantNode, text) {
      if (!text || !text.trim()) return;
      const row = document.createElement('div');
      row.className = 'agent-cross';
      const canCreate = !!(App.create && App.create.importPrompt);
      const canDoc = !!(App.doc && App.doc.importText);
      let html = '';
      if (canCreate) html += '<button class="btn-ghost mini" data-cross="create">发送到创作中心</button>';
      if (canDoc) html += '<button class="btn-ghost mini" data-cross="doc">发送到糖读</button>';
      html += '<button class="btn-ghost mini" data-cross="copy">复制</button>';
      row.innerHTML = html;
      row.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-cross]');
        if (!b) return;
        const kind = b.dataset.cross;
        if (kind === 'copy') {
          navigator.clipboard.writeText(text).then(() => App.ui.toast('已复制')).catch(() => App.ui.toast('复制失败'));
        } else if (kind === 'create' && canCreate) {
          App.router.go('create');
          App.create.importPrompt(text);
          App.ui.toast('已发送到创作中心');
        } else if (kind === 'doc' && canDoc) {
          App.doc.importText(text, '糖码结果');
          App.router.go('doc');
          App.ui.toast('已发送到糖读');
        }
      });
      assistantNode.appendChild(row);
    },

    // ===== 事件绑定 =====
    bind() {
      const input = document.getElementById('agentInput');
      const send = document.getElementById('agentSend');
      if (input && send) {
        input.addEventListener('input', () => { if (!App.agent.running) send.disabled = !input.value.trim(); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); App.agent.send(); } });
        send.addEventListener('click', () => { if (App.agent.running) App.agent.stop(); else App.agent.send(); });
      }
      const test = document.getElementById('agentTest');
      if (test) test.addEventListener('click', () => App.agent.testConn());
      const nc = document.getElementById('agentNewChat');
      if (nc) nc.addEventListener('click', () => App.agent.newChat());
      const np = document.getElementById('agentNewProject');
      if (np) np.addEventListener('click', () => {
        App.agent.createProject(true);
        App.agent.render();
        App.agent.openProjectSettings(App.state.activeProjectId);
      });
      const pset = document.getElementById('agentProjectSettings');
      if (pset) pset.addEventListener('click', () => App.agent.openProjectSettings(App.state.activeProjectId));
      // Plan 模式开关
      const planToggle = document.getElementById('agentPlanToggle');
      if (planToggle) planToggle.addEventListener('change', () => {
        const proj = App.agent.activeProject();
        proj.planMode = !!planToggle.checked;
        App.persist();
        const badge = document.getElementById('agentPlanBadge');
        if (badge) { badge.textContent = proj.planMode ? '只读探索' : '可执行'; badge.className = 'agent-status plan-badge ' + (proj.planMode ? 'on' : 'off'); }
      });
      // 侧栏折叠/展开
      const cp = document.getElementById('agentCollapseProjects');
      if (cp) cp.addEventListener('click', () => { App.state.agentProjectsCollapsed = true; App.persist(); App.agent.render(); });
      const ep = document.getElementById('agentExpandProjects');
      if (ep) ep.addEventListener('click', () => { App.state.agentProjectsCollapsed = false; App.persist(); App.agent.render(); });
      const cs = document.getElementById('agentCollapseSessions');
      if (cs) cs.addEventListener('click', () => { App.state.agentSessionsCollapsed = true; App.persist(); App.agent.render(); });
      const es = document.getElementById('agentExpandSessions');
      if (es) es.addEventListener('click', () => { App.state.agentSessionsCollapsed = false; App.persist(); App.agent.render(); });
      // 项目列表事件委托
      const plist = document.getElementById('agentProjectList');
      if (plist) plist.addEventListener('click', (e) => {
        const del = e.target.closest('[data-pdel]');
        if (del) { e.stopPropagation(); App.agent.confirmDelete('project', del.dataset.pdel, del.parentElement.querySelector('.agent-project-name').textContent); return; }
        const set = e.target.closest('[data-pset]');
        if (set) { e.stopPropagation(); App.agent.openProjectSettings(set.dataset.pset); return; }
        const item = e.target.closest('.agent-project');
        if (item) App.agent.switchProject(item.dataset.id);
      });
      // 会话列表事件委托
      const list = document.getElementById('agentSessionList');
      if (list) list.addEventListener('click', (e) => {
        const del = e.target.closest('[data-del]');
        if (del) { e.stopPropagation(); App.agent.confirmDelete('thread', del.dataset.del, del.parentElement.querySelector('.agent-session-title').textContent); return; }
        const ren = e.target.closest('[data-ren]');
        if (ren) { e.stopPropagation(); App.agent.renameThread(ren.dataset.ren); return; }
        const item = e.target.closest('.agent-session');
        if (item) App.agent.switchThread(item.dataset.id);
      });
    },

    async testConn() {
      const status = document.getElementById('agentStatus');
      const offline = document.getElementById('agentOffline');
      try {
        const res = await fetch(AGENT_BASE + '/api/health', { cache: 'no-store' });
        const j = await res.json().catch(() => ({}));
        if (j.ok) {
          status.textContent = '已连接'; status.className = 'agent-status on';
          if (offline) offline.style.display = 'none';
          // 若当前项目 cwd 为空，用后端目录回填
          const proj = App.agent.activeProject();
          if (proj && !proj.cwd && j.cwd) { proj.cwd = j.cwd; App.persist(); App.agent.render(); }
          App.ui.toast('已连接到糖码后端');
        } else { status.textContent = '异常'; status.className = 'agent-status off'; }
      } catch (e) {
        status.textContent = '未连接'; status.className = 'agent-status off';
        if (offline) offline.style.display = 'block';
      }
    },

    showMeta(meta) {
      const bar = document.getElementById('agentMeta');
      if (!bar) return;
      const cwd = meta.cwd || '(后端目录)';
      const plan = meta.planMode ? ' · <b class="meta-plan">Plan 模式（只读探索）</b>' : '';
      bar.innerHTML = `<span class="agent-meta-dot"></span>运行中 · 目录 <code>${App.escapeHtml(cwd)}</code> · ${meta.auto ? '自动执行' : '每步确认'}${plan}`;
      bar.style.display = 'flex';
    },
    hideMeta() {
      const bar = document.getElementById('agentMeta');
      if (bar) bar.style.display = 'none';
    },

    appendUser(text) {
      const thread = document.getElementById('agentThread');
      const empty = thread.querySelector('.agent-empty'); if (empty) empty.remove();
      const node = document.createElement('div');
      node.className = 'agent-msg user';
      node.textContent = text;
      thread.appendChild(node);
      thread.scrollTop = thread.scrollHeight;
      return node;
    },

    newToolBlock(name, args) {
      const thread = document.getElementById('agentThread');
      const block = document.createElement('div');
      block.className = 'agent-tool';
      const argStr = (args && Object.keys(args).length) ? JSON.stringify(args, null, 2) : '';
      block.innerHTML = `
        <div class="agent-tool-head">
          <span class="agent-tool-ico">[工具]</span>
          <span class="agent-tool-name">${App.escapeHtml(name)}</span>
          <span class="agent-tool-status">运行中...</span>
          <button class="agent-tool-toggle">v</button>
        </div>
        <div class="agent-tool-body">
          ${argStr ? `<pre class="agent-tool-args">${App.escapeHtml(argStr)}</pre>` : ''}
          <pre class="agent-tool-out">等待执行…</pre>
          <div class="agent-approve" style="display:none">
            <span class="agent-approve-tip">该操作需要你的批准：</span>
            <button class="btn-primary mini" data-ap="1">运行</button>
            <button class="btn-ghost mini" data-ap="0">跳过</button>
          </div>
        </div>`;
      thread.appendChild(block);
      thread.scrollTop = thread.scrollHeight;
      block.querySelector('.agent-tool-toggle').addEventListener('click', () => {
        block.classList.toggle('collapsed');
      });
      block._startTime = Date.now(); // 记录开始时间，用于 setToolResult 展示耗时
      return block;
    },

    setToolResult(block, result, statusText) {
      if (!block) return;
      const out = block.querySelector('.agent-tool-out');
      if (out) out.textContent = result || '(空)';
      const st = block.querySelector('.agent-tool-status');
      if (st) {
        const elapsed = block._startTime ? ((Date.now() - block._startTime) / 1000).toFixed(1) + 's' : '';
        const isError = /error|fail|拒绝|denied|403|404|500/i.test(String(result || ''));
        const icon = isError ? '[失败]' : '[完成]';
        st.textContent = (statusText || '完成') + (elapsed ? ' (' + elapsed + ')' : '');
        st.title = icon + ' ' + st.textContent;
      }
      const ico = block.querySelector('.agent-tool-ico');
      if (ico) ico.textContent = /error|fail|拒绝/i.test(String(result || '')) ? '[失败]' : '[完成]';
    },

    wireApproval(block, callId) {
      const box = block.querySelector('.agent-approve');
      if (!box) return;
      box.style.display = 'flex';
      box.querySelectorAll('button[data-ap]').forEach(b => {
        b.addEventListener('click', async () => {
          const approved = b.dataset.ap === '1';
          box.style.display = 'none';
          const st = block.querySelector('.agent-tool-status');
          if (st) st.textContent = approved ? '已批准，执行中…' : '已拒绝';
          try {
            await fetch(AGENT_BASE + '/api/agent/approve', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ callId, approved }),
            });
          } catch (e) {}
        });
      });
    },

    // ===== 任务清单（todo_write）渲染 =====
    renderTodo(todos) {
      const thread = document.getElementById('agentThread');
      if (!thread) return;
      let box = document.getElementById('agentTodo');
      if (!box) {
        box = document.createElement('div');
        box.id = 'agentTodo';
        box.className = 'agent-todo';
        thread.appendChild(box);
      }
      if (!todos.length) { box.style.display = 'none'; return; }
      box.style.display = 'block';
      const done = todos.filter(t => t.status === 'completed').length;
      const items = todos.map(t => {
        const cls = t.status === 'completed' ? 'done' : (t.status === 'in_progress' ? 'doing' : 'pending');
        const mark = t.status === 'completed' ? '[\u221A]' : (t.status === 'in_progress' ? '[>]' : '[ ]');
        const af = (t.status === 'in_progress' && t.activeForm) ? ` <span class="agent-todo-af">${App.escapeHtml(t.activeForm)}</span>` : '';
        return `<div class="agent-todo-item ${cls}"><span class="agent-todo-mark">${mark}</span><span class="agent-todo-text">${App.escapeHtml(t.content)}${af}</span></div>`;
      }).join('');
      box.innerHTML = `<div class="agent-todo-head"><span class="agent-todo-title">任务清单</span><span class="agent-todo-count">${done}/${todos.length}</span></div>${items}`;
      thread.scrollTop = thread.scrollHeight;
    },

    // ===== 文件差异（write_file/edit_file 行级 diff）渲染 =====
    applyToolDiff(callId, filePath, diff) {
      const thread = document.getElementById('agentThread');
      if (!thread) return;
      const block = Array.from(thread.querySelectorAll('.agent-tool')).find(b => b._callId === callId);
      if (!block) return;
      let diffEl = block.querySelector('.agent-diff');
      if (!diffEl) {
        diffEl = document.createElement('div');
        diffEl.className = 'agent-diff';
        const body = block.querySelector('.agent-tool-body');
        if (body) body.appendChild(diffEl);
      }
      const lines = (diff || []).map(d => {
        const sign = d.type === '+' ? '+' : (d.type === '-' ? '-' : ' ');
        const cls = d.type === '+' ? 'add' : (d.type === '-' ? 'del' : 'ctx');
        return `<div class="agent-diff-line ${cls}">${sign} ${App.escapeHtml(d.text)}</div>`;
      }).join('');
      const pathLabel = filePath ? `<div class="agent-diff-path">[文件] ${App.escapeHtml(filePath)}</div>` : '';
      diffEl.innerHTML = pathLabel + lines;
      thread.scrollTop = thread.scrollHeight;
    },

    // ===== 后台命令（run_in_background）面板 =====
    ensureJobPanel(jobId) {
      const thread = document.getElementById('agentThread');
      if (!thread) return null;
      if (!App.agent._jobPanels) App.agent._jobPanels = {};
      if (App.agent._jobPanels[jobId]) return App.agent._jobPanels[jobId];
      const node = document.createElement('div');
      node.className = 'agent-job';
      node.innerHTML = `
        <div class="agent-job-head">
          <span class="agent-job-ico">[运行]</span>
          <span class="agent-job-title">后台任务运行中</span>
          <span class="agent-job-id">${App.escapeHtml(jobId)}</span>
        </div>
        <div class="agent-job-cmd"></div>
        <pre class="agent-job-out"></pre>`;
      thread.appendChild(node);
      App.agent._jobPanels[jobId] = node;
      thread.scrollTop = thread.scrollHeight;
      return node;
    },
    appendJobLog(jobId, chunk) {
      const node = App.agent.ensureJobPanel(jobId);
      if (!node) return;
      const out = node.querySelector('.agent-job-out');
      if (out) { out.textContent += chunk; out.scrollTop = out.scrollHeight; }
    },
    labelJob(jobId, cmd) {
      const node = App.agent.ensureJobPanel(jobId);
      if (!node) return;
      const c = node.querySelector('.agent-job-cmd');
      if (c) c.textContent = cmd || '';
    },
    finishJob(jobId, code) {
      const node = App.agent._jobPanels && App.agent._jobPanels[jobId];
      if (!node) return;
      node.classList.add('done');
      const ico = node.querySelector('.agent-job-ico');
      if (ico) ico.textContent = '[结束]';
      const title = node.querySelector('.agent-job-title');
      if (title) title.textContent = '后台任务已结束（exit ' + (code == null ? '?' : code) + '）';
      const thread = document.getElementById('agentThread');
      if (thread) thread.scrollTop = thread.scrollHeight;
    },

    newAssistant() {
      const thread = document.getElementById('agentThread');
      const node = document.createElement('div');
      node.className = 'agent-msg assistant';
      node.innerHTML = '<div class="agent-answer"></div>';
      thread.appendChild(node);
      thread.scrollTop = thread.scrollHeight;
      return node.querySelector('.agent-answer');
    },

    appendThinking(text) {
      const thread = document.getElementById('agentThread');
      const node = document.createElement('div');
      node.className = 'agent-think';
      node.textContent = text;
      thread.appendChild(node);
      thread.scrollTop = thread.scrollHeight;
    },

    setError(msg) {
      const thread = document.getElementById('agentThread');
      const node = document.createElement('div');
      node.className = 'agent-msg assistant';
      node.innerHTML = `<div class="agent-answer error">${App.escapeHtml(msg)}</div>`;
      thread.appendChild(node);
      thread.scrollTop = thread.scrollHeight;
    },

    setRunning(on) {
      App.agent.running = on;
      const send = document.getElementById('agentSend');
      const input = document.getElementById('agentInput');
      if (send) {
        send.disabled = on ? false : !(input && input.value.trim());
        send.textContent = on ? '[停止]' : '发送';
        send.classList.toggle('stopping', on);
        send.title = on ? '停止' : '发送';
      }
    },

    stop() {
      if (App.agent._ctrl) { try { App.agent._ctrl.abort(); } catch (e) {} }
    },

    async send() {
      if (App.agent.running) return;
      const input = document.getElementById('agentInput');
      const prompt = input.value.trim();
      if (!prompt) return;
      const p = App.getProvider('chat');
      if (!p.apiBase || !p.apiKey || !p.model) {
        App.ui.toast('请先在设置配置聊天 API（糖码复用聊天账户）');
        return;
      }
      const modelSel = document.getElementById('agentModel');
      const model = modelSel ? modelSel.value : p.model;
      const proj = App.agent.activeProject();
      const cwd = proj.cwd || '';
      const auto = !!proj.auto;
      const planMode = !!proj.planMode;
      const approveTools = proj.approveTools || [];
      const cmdWhitelist = proj.cmdWhitelist || [];

      const thread = App.agent.activeThread();

      App.agent.appendUser(prompt);
      input.value = '';
      App.agent.setRunning(true);
      // 每轮运行重置：清空上一轮的任务清单与后台任务面板
      const oldTodo = document.getElementById('agentTodo');
      if (oldTodo) oldTodo.remove();
      App.agent._jobPanels = {};

      if (thread.title === '新会话' && !thread.history.length) {
        thread.title = prompt.length > 18 ? prompt.slice(0, 18) + '…' : prompt;
        App.agent.renderSessions();
      }

      const history = (thread.history || []).slice(-MAX_HISTORY).map(h => ({ role: h.role, content: h.content }));

      let answerEl = null;
      let answerAcc = '';
      let toolBlock = null;
      let aborted = false;

      const ctrl = new AbortController();
      App.agent._ctrl = ctrl;
      const searchApiKey = (App.state.settings.search && App.state.settings.search.apiKey) || '';

      try {
        const res = await fetch(AGENT_BASE + '/api/agent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: ctrl.signal,
          body: JSON.stringify({
            prompt, cwd, apiBase: p.apiBase, apiKey: p.apiKey, model, auto, planMode, history, searchApiKey,
            approveTools, cmdWhitelist,
            systemPrompt: (App.state.settings.prompts && App.state.settings.prompts.agent) || '',
          }),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          App.agent.setError('后端返回错误（' + res.status + '）：' + txt.slice(0, 240));
          App.agent.finish(thread, prompt, '');
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n');
          buf = parts.pop();
          for (const line of parts) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let ev; try { ev = JSON.parse(data); } catch (e) { continue; }
            // 线程安全：仅当当前活跃线程仍是本任务的线程时才操作 DOM；否则仅累积 answerAcc，后台跑
            const isActive = () => App.state.activeThreadId === thread.id;
            if (ev.type === 'meta') { App.agent.showMeta(ev); }
            else if (ev.type === 'thinking') { if (isActive()) App.agent.appendThinking(ev.text); }
            else if (ev.type === 'tool_call') {
              if (isActive()) {
                toolBlock = App.agent.newToolBlock(ev.name, ev.args);
                toolBlock._callId = ev.id;
                toolBlock.dataset.callid = ev.id;
              }
            }
            else if (ev.type === 'require_approval') {
              if (isActive() && toolBlock) App.agent.wireApproval(toolBlock, ev.callId);
            }
            else if (ev.type === 'tool_result') {
              if (isActive() && toolBlock && toolBlock._callId === ev.id) App.agent.setToolResult(toolBlock, ev.result, '完成');
              const m = (ev.result || '').match(/jobId=(job_[a-z0-9]+)[）)]\s*[:：]?\s*([\s\S]*)$/);
              if (m) App.agent.labelJob(m[1], m[2]);
              // 关键数据保存（工具执行结果可能影响后续逻辑）
              try { App.persist(); } catch (_) {}
            }
            else if (ev.type === 'todo_update') {
              if (isActive()) App.agent.renderTodo(ev.todos || []);
            }
            else if (ev.type === 'tool_diff') {
              if (isActive()) App.agent.applyToolDiff(ev.id, ev.path, ev.diff || []);
            }
            else if (ev.type === 'job_log') {
              if (isActive()) { App.agent.ensureJobPanel(ev.jobId); App.agent.appendJobLog(ev.jobId, ev.chunk || ''); }
            }
            else if (ev.type === 'job_done') {
              if (isActive()) App.agent.finishJob(ev.jobId, ev.code);
            }
            else if (ev.type === 'message') {
              answerAcc += ev.text;  // 始终累积（finish 时写入 history）
              // 增量保存：每条消息段落下后保存，防止意外退出丢失
              try { App.persist(); } catch (_) {}
              if (isActive()) {
                if (!answerEl) answerEl = App.agent.newAssistant();
                answerEl.innerHTML = App.renderMarkdown(answerAcc);
                const th = document.getElementById('agentThread');
                th.scrollTop = th.scrollHeight;
              }
            }
            else if (ev.type === 'done') { try { App.persist(); } catch (_) {} }
            else if (ev.type === 'error') { if (isActive()) App.agent.setError(ev.message || '未知错误'); try { App.persist(); } catch (_) {} }
          }
        }
      } catch (e) {
        if (e && e.name === 'AbortError') {
          aborted = true;
          App.agent.appendThinking('已停止本次运行。');
        } else {
          App.agent.setError('无法连接糖码后端（' + (e.message || e) + '）。请确认后端已运行。');
          const offline = document.getElementById('agentOffline');
          if (offline) offline.style.display = 'block';
        }
      }

      if (answerEl && answerAcc) {
        App.agent.addCrossActions(answerEl.parentElement, answerAcc);
      }
      App.agent.finish(thread, prompt, aborted ? '' : answerAcc);
    },

    finish(thread, prompt, answerAcc) {
      thread.history.push({ role: 'user', content: prompt });
      if (answerAcc) thread.history.push({ role: 'assistant', content: answerAcc });
      if (thread.history.length > MAX_THREAD_HISTORY) thread.history = thread.history.slice(-MAX_THREAD_HISTORY);
      thread.updatedAt = Date.now();
      // 更新项目 lastUsedAt
      const proj = App.agent.projects().find(p => p.id === thread.projectId);
      if (proj) proj.lastUsedAt = Date.now();
      App.persist();
      App.agent.renderSessions();
      App.agent._ctrl = null;
      App.agent.hideMeta();
      App.agent.setRunning(false);
    },
  };

  // 退出前强制保存当前会话（防止运行中退出丢失本轮对话）
  window.addEventListener('beforeunload', () => {
    try { if (window.App && window.App.persist) App.persist(); } catch (_) {}
  });
})();
