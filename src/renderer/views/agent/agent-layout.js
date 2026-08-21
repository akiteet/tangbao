'use strict';
/* 自 agent.js 拆分（v1.1.7 批次 E）：公共辅助与 agent.js 主体同源，各拆分文件独立声明。
 * 通过 Object.assign 挂到 window.App.agent，保持对象字面量方法定义形式不变。 */
(function () {
  window.App = window.App || {};
  const $ = (id) => document.getElementById(id);
  const agentBase = () => (App.rt ? App.rt.agentBase() : '');
  const authHeaders = (extra) => (App.rt ? App.rt.authHeaders(extra) : (extra || {}));
  const MAX_THREAD_HISTORY = 60;
  const WORKSPACE_ERROR_MESSAGES = {
    invalid_root_path: '选择的路径无效，请重新选择文件夹。',
    root_not_found: '选择的文件夹不存在，或当前账户没有访问权限。',
    root_not_directory: '选择的路径不是文件夹，请重新选择。',
    duplicate_root_path: '这个文件夹已经添加到当前项目，无需重复添加。',
    nested_root_path: '不能添加互相包含的文件夹。请选择与现有项目文件夹相互独立的目录。',
    root_owned_by_other_workspace: '这个文件夹已属于另一个糖码项目，不能重复挂载。',
    workspace_busy: '当前有运行中的任务，暂不能修改项目文件夹。请先停止或等待任务完成。',
    unknown_workspace: '当前项目的工作区登记已失效，请重新选择项目文件夹。',
    workspace_has_no_roots: '项目至少需要保留一个文件夹。',
    last_root: '项目至少需要保留一个文件夹，不能移除最后一个文件夹。',
    unknown_root: '没有找到要操作的项目文件夹，请刷新项目设置后重试。',
    ipc_failed: '糖包暂时无法完成文件夹操作，请完整重启后重试。',
  };
  const workspaceErrorMessage = (result, fallback) => {
    const code = result && result.code ? String(result.code) : '';
    return WORKSPACE_ERROR_MESSAGES[code] || (result && result.error ? String(result.error) : '') || fallback || '项目文件夹操作失败，请重试。';
  };

  Object.assign(window.App.agent, {
    renderStamp() {
      const prov = App.getProvider('agent');
      const proj = App.agent.activeProject();
      return [
        App.state.agentModel || prov.model || '',
        ((prov.models && prov.models.length) ? prov.models : (prov.model ? [prov.model] : [])).join(','),
        proj ? [proj.id || '', proj.name || '', proj.cwd || '', (Array.isArray(proj.roots) ? proj.roots : []).map((r) => r.rootId).join('+'), proj.primaryRootId || '', proj.auto ? 1 : 0, proj.planMode ? 1 : 0].join('~') : '',
        App.state.activeThreadId || '',
        App.agent._backendOk ? 1 : 0,
        App.agent.running ? 1 : 0,
        App.state.settings.agentThinkLevel || '',
        (App.state.agentProjectsCollapsed ? 1 : 0) + '' + (App.state.agentSessionsCollapsed ? 1 : 0),
        (window.matchMedia && window.matchMedia('(max-width: 900px)').matches) ? 1 : 0,
        ((App.state.agentProjects || []).length) + ':' + ((App.state.agentThreads || []).length),
      ].join('|');
    },
    render(opts) {
      const wrap = document.getElementById('agentView');
      if (!wrap) return;
      if (opts && opts.reentry && wrap.dataset.rendered === '1'
        && this.renderStamp && this.renderStamp() === this._renderStamp) {
        return; // 重进且结构未变：复用现有 DOM
      }
      // 重建前把文字与 Skill 气泡保存到当前会话草稿。
      App.agent.saveComposerDraft();
      const agentProv = App.getProvider('agent');
      const models = (agentProv.models && agentProv.models.length) ? agentProv.models : (agentProv.model ? [agentProv.model] : []);
      // v2（UX 修复）：用户上次选中的模型优先——持久化在 App.state.agentModel，重建/切项目不自动回退默认模型
      const savedModel = (typeof App.state.agentModel === 'string' && App.state.agentModel) ? App.state.agentModel : '';
      const sel = (savedModel && models.includes(savedModel)) ? savedModel : (agentProv.model || models[0] || '');
      const modelOpts = models.length
        ? models.map(m => `<option value="${App.escapeHtml(m)}"${m === sel ? ' selected' : ''}>${App.escapeHtml(m)}</option>`).join('')
        : '<option value="" disabled selected>未配置糖码模型</option>';
      const proj = App.agent.activeProject();
      const roots = Array.isArray(proj.roots) ? proj.roots : [];
      const activeThread = App.agent.activeThread();
      const draftRootScope = (activeThread && activeThread.draftRootScope && typeof activeThread.draftRootScope === 'object') ? activeThread.draftRootScope : { mode: 'primary', rootId: '' };
      const rootScopeValue = draftRootScope.mode === 'single' ? ('single:' + String(draftRootScope.rootId || '')) : (draftRootScope.mode === 'all' ? 'all' : 'primary');
      const rootScopeOptions = ['<option value="primary"' + (rootScopeValue === 'primary' ? ' selected' : '') + '>主文件夹</option>']
        .concat(roots.map((root) => '<option value="single:' + App.escapeHtml(root.rootId) + '"' + (rootScopeValue === 'single:' + root.rootId ? ' selected' : '') + '>指定：' + App.escapeHtml(root.name || '文件夹') + '</option>'))
        .concat(roots.length > 1 ? ['<option value="all"' + (rootScopeValue === 'all' ? ' selected' : '') + '>全部文件夹</option>'] : [])
        .join('');
      const cwdDisp = proj.cwd || '(后端默认目录)';
      const rootDisp = roots.length > 1 ? (roots.find((root) => root.rootId === proj.primaryRootId) || roots[0]).name + ' + ' + (roots.length - 1) + ' 个文件夹' : cwdDisp;
      const autoLabel = proj.auto ? '自动执行' : '每步确认';
      const cwdFull = proj.name + '  ·  ' + (roots.length > 1 ? roots.map((root) => root.name + ': ' + root.path).join('\n') : cwdDisp);
      const compactSidebar = !!(window.matchMedia && window.matchMedia('(max-width: 900px)').matches);
      if (this._sidebarCompactMode !== compactSidebar) {
        this._sidebarCompactMode = compactSidebar;
        if (!compactSidebar) this._compactSidebarOpen = null;
      }
      const compactOpen = compactSidebar && (this._compactSidebarOpen === 'projects' || this._compactSidebarOpen === 'sessions')
        ? this._compactSidebarOpen
        : '';
      // 窄窗只使用不持久化的浮层状态，避免覆盖桌面宽度下的折叠偏好。
      const projCollapsed = compactSidebar ? compactOpen !== 'projects' : !!App.state.agentProjectsCollapsed;
      const sessCollapsed = compactSidebar ? compactOpen !== 'sessions' : !!App.state.agentSessionsCollapsed;

      wrap.innerHTML = `
        <div class="agent-layout${compactSidebar ? ' agent-layout-compact' : ''}" data-sidebar-mode="${compactSidebar ? 'compact' : 'wide'}"${compactOpen ? ` data-compact-open="${compactOpen}"` : ''}>
          ${(projCollapsed && sessCollapsed) ? `
          <div class="agent-tabs-row" id="agentTabsRow">
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
              <div class="agent-top-row">
              <div class="agent-field grow">
                <label>当前项目 / 工作目录</label>
                <div class="agent-cwd-row">
                  <div class="agent-cwd-disp" id="agentCwdDisp" title="${App.escapeHtml(cwdFull)}"><span class="cwd-proj">${App.escapeHtml(proj.name)}</span>  ·  ${App.escapeHtml(rootDisp)}</div>
                  <button class="btn-ghost mini" id="agentProjectSettings">⚙ 设置</button>
                </div>
              </div>
              <div style="display:flex;flex-direction:column;align-items:center;gap:4px;">
                <button class="btn-ghost" id="agentTest">测试连接</button>
                <!-- v1.1.0（Fix）：按上次已知连接状态初始化，不再硬编码「未连接」误报 -->
                <span class="agent-status ${App.agent._backendOk ? 'on' : 'off'}" id="agentStatus">${App.agent._backendOk ? '已连接' : '未连接'}</span>
              </div>
              <span class="agent-auto-badge ${proj.auto ? 'on' : 'off'}" id="agentAutoBadge">${autoLabel}</span>
              <!-- v1.1.0：Plan 模式一行化（badge 并入 switch） -->
              <label class="switch plan-switch"><input type="checkbox" id="agentPlanToggle" ${proj.planMode ? 'checked' : ''} />
                <span class="agent-status plan-badge ${proj.planMode ? 'on' : 'off'}" id="agentPlanBadge">Plan ${proj.planMode ? '只读探索' : '可执行'}</span></label>
              </div>
              <div class="agent-top-row op">
              <div class="agent-ctx-row">
                <div class="ctx-bar" id="agentCtxBar"><div class="ctx-bar-fill"></div><span class="ctx-bar-label"></span></div>
                <button class="btn-ghost mini" id="agentCompactBtn" title="压缩较早上下文（或输入 /compact 定向压缩）">压缩</button>
                <button class="btn-ghost mini" id="agentClearCtxBtn" title="清空当前线程上下文（重置对话历史与摘要）">清空</button>
                <button class="btn-ghost mini" id="agentMemoryBtn" title="编辑项目记忆（糖码记忆.md）">项目记忆</button>
                <button class="btn-ghost mini" id="agentHistoryBtn" title="查看本会话运行历史（计划 / TODO / 工具调用 / 测试结果）">历史</button>
                <button class="btn-ghost mini" id="agentEvalBtn" title="在独立 fixture 中运行安全评测，不接触当前项目">安全评测</button>
                <button class="btn-ghost mini agent-engine-launcher" id="agentEngineBtn" type="button" aria-haspopup="dialog" aria-controls="agentEngineMask" title="打开运行观测">
                  运行观测 <span class="agent-engine-launcher-state" id="agentEngineLauncherState">待运行</span>
                </button>
              </div>
              </div>
            </div>
            <div class="agent-meta" id="agentMeta" style="display:none"></div>
            <div class="agent-offline" id="agentOffline" style="display:none">
              <strong>后端未运行</strong>
              <p>糖码需要一个本地后端来执行命令与文件操作。请在终端运行：</p>
              <pre>node server/agent-server.js</pre>
              <p class="hint">桌面版会自动拉起后端（本机随机端口，仅本机可访问）。启动后再点「测试连接」。</p>
            </div>
            <!-- v2（UX）：统一状态摘要条——默认一行当前状态，异常时展开下一步动作（渐进披露） -->
            <div class="agent-status-summary" id="agentStatusSummary" role="status" aria-live="polite" hidden></div>
            <div class="agent-thread" id="agentThread"></div>
            <!-- v1.1.0：模型/思考选择器移到输入框上方靠右（id 不变，逻辑零改动） -->
            <div class="agent-composer-tools">
              <select class="img-model-pick" id="agentRootScope" title="限制本次任务可以访问的项目文件夹">${rootScopeOptions}</select>
              <select class="img-model-pick" id="agentModel">${modelOpts}</select>
              <select class="img-model-pick" id="agentThink" title="糖码独立思考强度（不影响聊天）">
                <option value="off">思考关闭</option>
                <option value="low">思考低</option>
                <option value="medium">思考中</option>
                <option value="high">思考高</option>
              </select>
            </div>
            <div class="agent-composer">
              <div class="agent-composer-input-wrap">
                <div class="agent-skill-chips" id="agentSkillChips" hidden></div>
                <textarea id="agentInput" data-thread-id="${App.escapeHtml(App.state.activeThreadId || '')}" rows="1" wrap="soft" placeholder="给糖码下达任务（Enter 发送，/ 查看命令与技能，Shift+Enter 换行）"></textarea>
                <div class="agent-suggest" id="agentSuggest" hidden></div>
              </div>
              <button class="btn-ghost mini agent-polish" id="agentPolish" title="输入增强：一键润色草稿后回填输入框">✎ 增强</button>
              <button id="agentSend" disabled>➤</button>
            </div>
          </div>
        </div>`;
      App.agent.bind();
      // v1.1.0（Fix 6）：恢复糖码独立思考强度选择器（不联动聊天 settings.thinkLevel）
      const thinkSel = document.getElementById('agentThink');
      if (thinkSel) thinkSel.value = App.state.settings.agentThinkLevel || 'medium';
      // v1.1.0（Fix）：render 重建后静默探测连接状态（切项目/会话不再误报「未连接」）
      setTimeout(() => App.agent.autoProbe(), 300);
      App.agent.renderProjects();
      App.agent.renderSessions();
      App.agent.restoreThread();
      App.agent.updateCtxBar();
      // 恢复当前会话独立的文字与 Skill 气泡草稿。
      App.agent.restoreComposerDraft();
      // v1.1.0（修复）：运行中重建后恢复运行态 UI（■ 停止按钮 + 「运行中」meta 条）
      if (App.agent.running) {
        try {
          App.agent.setRunning(true);
          const rp = App.agent.activeProject();
          if (rp && App.agent.showMeta) App.agent.showMeta({ cwd: rp.cwd, auto: rp.auto, planMode: rp.planMode });
          // v2（UX）：重建后恢复统一状态摘要（运行中一行式）
          App.agent.showStatusRunning();
        } catch (_e) {}
      } else {
        App.agent.hideStatusSummary();
      }
      App.agent.renderEngineStrip();
      App.agent.refreshEngineStrip();
      // v2（UX）：发送前就绪检查改为轻量 toast（不再弹就地提示条）
      wrap.dataset.rendered = '1';
      this._renderStamp = this.renderStamp(); // 构建成功后落戳，供 onShow 重进守卫比对
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
          <button class="agent-session-ren" title="设置" data-pset="${p.id}">⚙</button>
          <button class="agent-session-del" title="删除" data-pdel="${p.id}">✕</button>
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
        return `<div class="agent-session${t.id === active ? ' active' : ''}" data-id="${t.id}">
          <span class="agent-session-title" title="${App.escapeHtml(t.title)}">${App.escapeHtml(t.title || '新会话')}</span>
          <button class="agent-session-ren" title="重命名" data-ren="${t.id}">✎</button>
          <button class="agent-session-del" title="删除" data-del="${t.id}">✕</button>
          ${t._running ? '<span class="agent-session-badge" title="任务运行中">⏳</span>' : ''}
        </div>`;
      }).join('');
    },
    restoreThread() {
      const thread = document.getElementById('agentThread');
      if (!thread) return;
      thread.innerHTML = '';
      // v1.1.0（修复）：重置 _liveUI（render 重建后由事件/渲染重建）
      App.agent._liveUI = null;
      const t = App.agent.activeThread();
      const hist = (t && t.history) || [];
      // v1.1.0（修复）：运行中的实时事件/回答（切会话/重建后可见）
      const liveEvents = (t && t._liveEvents) || [];
      const liveAnswer = (t && t._liveAnswer) || '';
      if (!hist.length && !liveEvents.length && !liveAnswer) {
        // v1.1.0（Fix 2）：空线程早退前必须重建 _liveUI，否则运行中 SSE 事件访问 null 抛 TypeError 误判断连
        App.agent._liveUI = { threadId: t ? t.id : '', answerEl: null, blocks: new Map(), subagents: new Map() };
        const d = document.createElement('div');
        d.className = 'agent-empty';
        d.innerHTML = '暂无消息';
        thread.appendChild(d);
        return;
      }
      for (const h of hist) {
        if (h.role === 'user') {
          thread.appendChild(App.agent.createUserMessage(h.content, h.skills));
        } else if (h.role === 'assistant') {
          const node = document.createElement('div');
          node.className = 'agent-msg assistant';
          node.innerHTML = '<div class="agent-answer">' + App.renderMarkdown(h.content || '') + '</div>';
          App.agent.addCrossActions(node, h.content || '');
          thread.appendChild(node);
        }
      }
      // v1.1.0（修复）：运行中折叠/重建后，补渲染尚未落库的当前用户消息（_pendingUser，finish 后清除）
      if (t && t._pendingUser) {
        const pending = typeof t._pendingUser === 'string' ? { content: t._pendingUser, skills: [] } : t._pendingUser;
        if (!hist.some(h => h.role === 'user' && h.content === pending.content)) {
          thread.appendChild(App.agent.createUserMessage(pending.content, pending.skills));
        }
      }
      // 运行中实时内容渲染（thinking / 工具块 / 子代理 / 已生成回答）
      const ui = { threadId: t ? t.id : '', answerEl: null, blocks: new Map(), subagents: new Map() };
      for (const ev of liveEvents) {
        if (ev.type === 'thinking') {
          const node = document.createElement('div');
          // v1.1.0（修复 M2）：与 appendThinking 保持同一 class，restore 时仍是「思维链小字」样式
          node.className = 'agent-think';
          node.textContent = String(ev.text || '');
          thread.appendChild(node);
        } else if (ev.type === 'tool_call') {
          const block = App.agent.newToolBlock(ev.name, ev.args);
          block._callId = ev.id;
          block.dataset.callid = ev.id;
          ui.blocks.set(ev.id, block);
          // 已有 tool_result 补结果
          const res = liveEvents.find(x => x.type === 'tool_result' && x.id === ev.id);
          if (res) App.agent.setToolResult(block, res.result, '完成');
          const diff = liveEvents.find(x => x.type === 'tool_diff' && x.id === ev.id);
          if (diff && diff.path) App.agent.applyToolDiff(ev.id, diff.path, []);
        } else if (ev.type === 'subagent_queued' || ev.type === 'subagent_start') {
          const sb = App.agent.newSubagentBlock(ev);
          ui.subagents.set(ev.subId, sb);
          const res = liveEvents.find(x => x.type === 'subagent_result' && x.subId === ev.subId);
          if (res) App.agent.setSubagentResult(ev.subId, res);
        } else if (ev.type === 'todo_update') {
          App.agent.renderTodo(ev.todos || []);
        }
      }
      if (liveAnswer) {
        ui.answerEl = App.agent.newAssistant();
        ui.answerEl.innerHTML = App.renderMarkdown(liveAnswer);
        const pa = ui.answerEl.parentElement;
        if (pa) App.agent.addCrossActions(pa, liveAnswer);
      }
      App.agent._liveUI = ui;
      if (t && t._running) {
        const tag = document.createElement('div');
        tag.className = 'agent-live-tag';
        tag.textContent = '⏳ 任务运行中（切会话不中断，完成后自动归入历史）';
        thread.appendChild(tag);
      }
      thread.scrollTop = thread.scrollHeight;
    },
    renderSkillChips() {
      const box = document.getElementById('agentSkillChips');
      if (!box) return;
      const skills = App.agent.selectedSkills();
      box.hidden = !skills.length;
      box.innerHTML = skills.map((s) => '<span class="agent-skill-chip" title="' + App.escapeHtml(s.description || s.name) + '"><span class="agent-skill-chip-mark">✦</span><span class="agent-skill-chip-name">' + App.escapeHtml(s.name) + '</span><button type="button" class="agent-skill-chip-remove" data-skill-remove="' + App.escapeHtml(s.name) + '" aria-label="移除技能 ' + App.escapeHtml(s.name) + '">×</button></span>').join('');
      box.querySelectorAll('[data-skill-remove]').forEach((btn) => btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        App.agent.removeSkillChip(btn.dataset.skillRemove || '');
      }));
    }
  });
})();
