'use strict';
(function () {
  window.App = window.App || {};

  const $ = (id) => document.getElementById(id);

  // 糖码后端地址：主进程用随机端口 + 仅 127.0.0.1 启动，端口在运行时才确定，不能写死
  const agentBase = () => (App.rt ? App.rt.agentBase() : '');
  // 本地服务请求统一带启动令牌
  const authHeaders = (extra) => (App.rt ? App.rt.authHeaders(extra) : (extra || {}));
  const MAX_THREAD_HISTORY = 60; // 单线程历史硬上限（超出裁剪，摘要偏移同步前移）
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

  App.agent = {
    running: false,
    _ctrl: null,
    _engineStripData: { threadId: '', run: null, metrics: null },
    _engineStripRequest: 0,
    _sidebarCompactMode: false,
    _compactSidebarOpen: null,

    onShow() { App.agent.render({ reentry: true }); },

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
        id: App.uid(), name: '新项目', cwd: '', workspaceId: '', roots: [], primaryRootId: '', auto: false,
        // v2（权限大改）：默认 Default 逐项确认；旧注释语义已并入 5 档权限模式
        approveTools: [], cmdWhitelist: [],
        planMode: false,
        permissionMode: 'default', permissionRules: [], // v2：5 档权限模式 + 项目规则
        maxSteps: 96, // v1.1.0（Fix 3）：单次运行步数上限（1-200），预算耗尽可「继续任务」接力
        createdAt: Date.now(), lastUsedAt: Date.now(),
      };
      App.agent.projects().unshift(p);
      App.state.activeProjectId = p.id;
      if (persist !== false) App.persist();
      return p;
    },
    switchProject(id) {
      App.agent.saveComposerDraft();
      const p = App.agent.projects().find(x => x.id === id);
      if (!p) return;
      p.lastUsedAt = Date.now();
      App.state.activeProjectId = id;
      // 切到该项目的首个会话
      const t = App.agent.threads()[0];
      App.state.activeThreadId = t ? t.id : null;
      App.persist();
      App.agent.render();
      // v2（UX 修复）：切换项目后若设置弹窗仍打开，技能面板跟随刷新（项目级技能按项目变化）
      try {
        const sm = document.getElementById('settingsModal');
        if (sm && !sm.hidden && App.ui && App.ui.renderSkillsPanel) App.ui.renderSkillsPanel();
      } catch (_) {}
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
        <div class="modal modal-sm" role="dialog" aria-modal="true">
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
      const hasDialog = !!(App.services.shell && App.services.shell.showDirDialog);
      // v2（权限大改）：5 档权限模式选项
      const PERM_MODES = [
        { v: 'plan', label: 'Plan 只读', hint: '只能探索，禁止修改文件与执行命令' },
        { v: 'default', label: 'Default 逐项确认', hint: '所有修改与命令逐项批准' },
        { v: 'acceptEdits', label: 'Accept Edits', hint: '文件编辑自动批准，命令逐项确认' },
        { v: 'auto', label: 'Auto 自动', hint: '自动执行；危险命令（rm -rf/npm install 等）仍强制审批' },
        { v: 'sandbox', label: 'Sandbox 隔离自动', hint: '同 Auto；网络命令与越界路径命令直接拒绝（受限工作区）' },
        { v: 'bypass', label: 'Bypass 全放行', hint: '不询问（仅建议本地/隔离项目）' },
      ];
      const curMode = (p.permissionMode && ['plan', 'default', 'acceptEdits', 'auto', 'bypass', 'sandbox'].includes(p.permissionMode))
        ? p.permissionMode : (p.planMode ? 'plan' : (p.auto ? 'auto' : 'default'));
      const curRules = Array.isArray(p.permissionRules) ? p.permissionRules : [];
      if (!Array.isArray(p.roots)) p.roots = [];
      if (!p.roots.length && p.cwd) p.roots = [{ rootId: p.primaryRootId || '', name: p.name || '主文件夹', path: p.cwd }];
      // v2（权限大改⑥）：旧 approveTools/cmdWhitelist 迁移为规则展示（保存时落盘新字段）
      const migRules = curRules.slice();
      (p.approveTools || []).forEach((t) => {
        if (!migRules.some(r => r.tool === t && r.allow === false)) migRules.push({ id: App.uid(), tool: t, pattern: '', path: '', allow: false, scope: 'project' });
      });
      const ruleRowHtml = (r, i) => `
        <div class="proj-rule-row" data-i="${i}">
          <select data-r="tool" title="工具">
            ${['*', 'run_command', 'git_command', 'write_file', 'edit_file', 'apply_patch', 'restore_changeset', 'run_tests', 'run_lint', 'run_typecheck'].map(t => `<option ${(r.tool || '*') === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
          <input data-r="pattern" placeholder="命令前缀 / 文件 glob" value="${App.escapeHtml(r.pattern || '')}" />
          <input data-r="path" placeholder="路径限制(可选)" value="${App.escapeHtml(r.path || '')}" />
          <select data-r="allow"><option value="true" ${r.allow !== false ? 'selected' : ''}>允许</option><option value="false" ${r.allow === false ? 'selected' : ''}>拒绝</option></select>
          <label class="mini-chk" title="勾选后即使危险命令也放行（慎用）"><input type="checkbox" data-r="force" ${r.force ? 'checked' : ''} />强制</label>
          <button class="icon-btn" data-del title="删除">✕</button>
        </div>`;
      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.id = 'projectModalMask';
      modal.innerHTML = `
        <div class="modal modal-lg" role="dialog" aria-modal="true">
          <div class="modal-header"><span>项目设置</span>
            <button class="icon-btn" id="projClose"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
          </div>
          <div class="modal-body">
            <div class="agent-form">
              <label class="field"><span class="field-label">项目名称</span>
                <input type="text" id="projName" value="${App.escapeHtml(p.name)}" /></label>
              <div class="field"><span class="field-label">项目文件夹</span>
                <div id="projRoots" style="display:flex;flex-direction:column;gap:6px">
                  ${(p.roots || []).map((root) => `<div class="agent-cwd-row" data-root-id="${App.escapeHtml(root.rootId || '')}"><input type="text" value="${App.escapeHtml(root.name || root.path)}" readonly /><span class="hint-inline" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${App.escapeHtml(root.path)}">${App.escapeHtml(root.path)}</span><button class="btn-ghost mini" data-root-primary>${root.rootId === p.primaryRootId ? '主文件夹' : '设为主文件夹'}</button><button class="btn-ghost mini" data-root-rename>重命名</button><button class="btn-ghost mini" data-root-remove>移除</button></div>`).join('') || '<p class="hint">尚未添加项目文件夹</p>'}
                </div>
                ${hasDialog ? '<button class="btn-ghost mini" id="projBrowse">+ 添加文件夹</button>' : ''}
                <p class="hint" id="projRootError" role="alert" aria-live="polite" style="display:none;color:var(--danger,#d93025);margin-top:6px"></p>
                <p class="hint">可挂载多个互不包含的独立目录。默认工具调用使用主文件夹；项目记忆、权限规则和项目级 Skill 仍归主文件夹。</p></div>
              <div class="field"><span class="field-label">权限模式</span>
                <div class="proj-perms">
                  ${PERM_MODES.map(m => `<label class="mod-row"><input type="radio" name="projPermMode" value="${m.v}" ${curMode === m.v ? 'checked' : ''} /> <span>${m.label}</span><span class="hint-inline">${m.hint}</span></label>`).join('')}
                </div></div>
              <div class="field"><span class="field-label">权限规则（Allow / Deny）</span>
                <div id="projRules">${migRules.map(ruleRowHtml).join('')}</div>
                <button class="btn-ghost mini" id="projAddRule">+ 添加规则</button>
                <p class="hint">优先级：拒绝 &gt; 允许；项目规则 &gt; 全局规则。危险命令（rm -rf / npm install 等）即使命中允许规则仍会审批，除非勾选「强制」。</p></div>
              <label class="field"><span class="field-label">命令白名单（快速添加为「允许」规则）</span>
                <textarea id="projWhitelist" rows="3" placeholder="每行一条，如：&#10;git status&#10;npm test">${App.escapeHtml((p.cmdWhitelist || []).join('\n'))}</textarea>
                <p class="hint">保存时每行自动转为 run_command 允许规则；也可直接在规则表里增删。</p></label>
              <label class="field"><span class="field-label">最大步数（单次运行）</span>
                <input type="number" id="projMaxSteps" min="1" max="200" step="1" value="${p.maxSteps || 96}" />
                <p class="hint">单次任务的模型-工具循环上限（默认 96）。达到上限会生成检查点并弹出「继续任务」接力提示。</p></label>
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
      const rootsBox = modal.querySelector('#projRoots');
      const rootError = modal.querySelector('#projRootError');
      const showRootError = (result, fallback) => {
        if (!rootError) return;
        if (!result || result.ok || result.canceled) {
          rootError.textContent = '';
          rootError.style.display = 'none';
          return;
        }
        rootError.textContent = workspaceErrorMessage(result, fallback);
        rootError.style.display = 'block';
      };
      const refreshRoots = (result) => {
        if (!result || !result.ok) return;
        showRootError(result);
        p.workspaceId = result.workspaceId || p.workspaceId;
        p.cwd = result.cwd || p.cwd;
        p.primaryRootId = result.primaryRootId || p.primaryRootId;
        p.roots = Array.isArray(result.roots) ? result.roots.map((root) => ({ rootId: root.rootId, name: root.name, path: root.path })) : p.roots;
        rootsBox.innerHTML = (p.roots || []).map((root) => `<div class="agent-cwd-row" data-root-id="${App.escapeHtml(root.rootId || '')}"><input type="text" value="${App.escapeHtml(root.name || root.path)}" readonly /><span class="hint-inline" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${App.escapeHtml(root.path)}">${App.escapeHtml(root.path)}</span><button class="btn-ghost mini" data-root-primary>${root.rootId === p.primaryRootId ? '主文件夹' : '设为主文件夹'}</button><button class="btn-ghost mini" data-root-rename>重命名</button><button class="btn-ghost mini" data-root-remove>移除</button></div>`).join('');
      };
      if ((p.workspaceId || p.cwd) && App.services.workspace) {
        App.services.workspace.ensureProject(p).then((result) => {
          if (result && result.ok) refreshRoots(result.result || result);
          else showRootError(result, '读取项目文件夹失败，请重新选择项目文件夹。');
        }).catch((error) => showRootError({ ok: false, code: 'ipc_failed', error: error && error.message }, '读取项目文件夹失败，请重新选择项目文件夹。'));
      }
      const browse = modal.querySelector('#projBrowse');
      if (browse) browse.onclick = async () => {
        browse.disabled = true;
        showRootError({ ok: true });
        try {
          const result = p.workspaceId
            ? await App.services.workspace.run(p, (workspaceId) => App.services.shell.addWorkspaceRoot(workspaceId))
            : await App.services.shell.showDirDialog();
          if (result && result.ok) {
            if (result.cwd) p.cwd = result.cwd;
            p.workspaceId = result.workspaceId || p.workspaceId || '';
            p.primaryRootId = result.primaryRootId || p.primaryRootId || '';
            p.roots = Array.isArray(result.roots) ? result.roots : p.roots;
            refreshRoots(result);
          } else {
            showRootError(result, '添加文件夹失败，请重新选择。');
          }
        } catch (error) {
          showRootError({ ok: false, code: 'ipc_failed', error: error && error.message }, '添加文件夹失败，请重新选择。');
        } finally {
          browse.disabled = false;
        }
      };
      rootsBox.addEventListener('click', async (event) => {
        const row = event.target.closest('[data-root-id]'); if (!row || !p.workspaceId) return;
        const rootId = row.dataset.rootId;
        let result = null;
        if (event.target.closest('[data-root-primary]')) result = await App.services.workspace.run(p, (workspaceId) => App.services.shell.setPrimaryWorkspaceRoot(workspaceId, rootId));
        else if (event.target.closest('[data-root-rename]')) { const name = window.prompt('文件夹显示名称', (p.roots.find((root) => root.rootId === rootId) || {}).name || ''); if (name) result = await App.services.workspace.run(p, (workspaceId) => App.services.shell.renameWorkspaceRoot(workspaceId, rootId, name)); }
        else if (event.target.closest('[data-root-remove]')) { if (!window.confirm('移除该文件夹？正在运行的任务可能因此无法恢复。')) return; result = await App.services.workspace.run(p, (workspaceId) => App.services.shell.removeWorkspaceRoot(workspaceId, rootId)); }
        if (result && result.ok) refreshRoots(result);
        else if (!(result && result.canceled)) {
          showRootError(result, '项目文件夹操作失败，请重试。');
          App.ui.toast(workspaceErrorMessage(result, '项目文件夹操作失败'));
        }
      });
      modal.querySelector('#projAddRule').onclick = () => {
        const wrap = modal.querySelector('#projRules');
        const idx = wrap.children.length;
        wrap.insertAdjacentHTML('beforeend', ruleRowHtml({ tool: 'run_command', pattern: '', path: '', allow: true, scope: 'project' }, idx));
      };
      modal.querySelector('#projRules').addEventListener('click', (e) => {
        const del = e.target.closest('[data-del]');
        if (del) del.closest('.proj-rule-row').remove();
      });
      modal.querySelector('#projSave').onclick = async () => {
        p.name = (modal.querySelector('#projName').value || '').trim() || '未命名项目';
        const legacyCwd = (modal.querySelector('#projCwd') || {}).value || '';
        if (!p.roots.length && legacyCwd.trim()) p.cwd = legacyCwd.trim();
        // v2（权限大改）：收集规则 + 白名单转规则
        const rules = [];
        modal.querySelectorAll('#projRules .proj-rule-row').forEach((row) => {
          const g = (k) => row.querySelector('[data-r="' + k + '"]');
          const tool = (g('tool') || {}).value || '';
          const pattern = ((g('pattern') || {}).value || '').trim();
          const path = ((g('path') || {}).value || '').trim();
          if (!tool && !pattern && !path) return;
          rules.push({ id: App.uid(), tool: tool || '*', pattern, path, allow: (g('allow') || {}).value !== 'false', force: !!(g('force') || {}).checked, scope: 'project' });
        });
        (modal.querySelector('#projWhitelist').value || '').split('\n').map(s => s.trim()).filter(Boolean).forEach((c) => {
          if (!rules.some(r => r.tool === 'run_command' && r.pattern === c)) rules.push({ id: App.uid(), tool: 'run_command', pattern: c, allow: true, scope: 'project' });
        });
        const modeEl = modal.querySelector('input[name="projPermMode"]:checked');
        p.permissionMode = modeEl ? modeEl.value : 'default';
        p.permissionRules = rules;
        // 兼容旧字段（旧版前端/后端路径）：auto/planMode/approveTools/cmdWhitelist 同步写
        p.auto = p.permissionMode === 'auto' || p.permissionMode === 'bypass' || p.permissionMode === 'sandbox';
        p.planMode = p.permissionMode === 'plan';
        p.approveTools = rules.filter(r => r.allow === false).map(r => r.tool).filter(t => t !== '*');
        p.cmdWhitelist = rules.filter(r => r.allow === true && r.tool === 'run_command' && r.pattern).map(r => r.pattern);
        const maxStepsEl = modal.querySelector('#projMaxSteps');
        p.maxSteps = Math.min(Math.max(Number(maxStepsEl ? maxStepsEl.value : 0) || 48, 1), 200);
        // 多根工作区：已有 workspaceId 时保留其完整根列表；仅旧单根/新建项目走兼容登记。
        if ((p.cwd || (p.roots && p.roots.length)) && App.services.workspace) {
          const ensured = await App.services.workspace.ensureProject(p);
          if (!ensured.ok) {
            showRootError(ensured, '项目文件夹不可用，请重新选择项目文件夹。');
            return;
          }
        }
        const primary = (p.roots || []).find((root) => root.rootId === p.primaryRootId) || (p.roots || [])[0];
        if (primary) p.cwd = primary.path;
        // v2（权限大改）：项目规则落盘 <cwd>/.tangbao/permissions.json（后端权威源）
        if (p.cwd) {
          try {
            const b = agentBase();
            const hdrs = authHeaders({ 'Content-Type': 'application/json' });
            await fetch(b + '/api/permissions', { method: 'PUT', headers: hdrs, body: JSON.stringify({ cwd: p.cwd, workspaceId: p.workspaceId, rules }) }).catch(() => null);
          } catch (e) {}
        }
        p.roots = Array.isArray(p.roots) ? p.roots : [];
        if (!p.roots.length && p.cwd) p.roots = [{ rootId: p.primaryRootId || '', name: p.name, path: p.cwd }];
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
      const t = { id: App.uid(), projectId: App.state.activeProjectId, title: '新会话', updatedAt: Date.now(), history: [], summary: '', summaryCount: 0, draftText: '', draftSkills: [], draftRootScope: { mode: 'primary', rootId: '' }, lastRunId: '' };
      App.state.agentThreads.push(t);
      App.state.activeThreadId = t.id;
      if (persist !== false) App.persist();
      return t;
    },

    // ===== 渲染 =====
    // v1.1.5：重进戳——枚举 render 反映的结构性输入（模型/项目/根/折叠态/线程/运行态等）。
    // onShow 重进时戳不变则跳过全量 innerHTML 重建（保留滚动、草稿与输入焦点）；
    // 文件内部 11 处状态变更后的 render() 调用不带 reentry，仍走全量重建，行为不变。




    // ===== 会话 CRUD =====
    // v1.1.0（修复）：实时事件节流持久化（1500ms 或已累积 20 条立即落盘；done/error 时强制）
    scheduleLivePersist() {
      if (App.agent._liveDirty) return;
      App.agent._liveDirty = true;
      const doPersist = () => { App.agent._liveDirty = false; try { App.persist(); } catch (e) {} };
      if (App.agent._liveEventCount >= 20) { App.agent._liveEventCount = 0; doPersist(); return; }
      if (App.agent._liveTimer) clearTimeout(App.agent._liveTimer);
      App.agent._liveTimer = setTimeout(doPersist, 1500);
    },
    switchThread(id) {
      App.agent.saveComposerDraft();
      App.state.activeThreadId = id;
      App.persist();
      App.agent.renderProjects();
      App.agent.renderSessions();
      App.agent.restoreThread();
      App.agent.restoreComposerDraft();
      App.agent.updateCtxBar();
      App.agent.renderEngineStrip();
      App.agent.refreshEngineStrip();
    },
    newChat() {
      App.agent.saveComposerDraft();
      App.agent.createThread(true);
      App.agent.renderProjects();
      App.agent.renderSessions();
      App.agent.restoreThread();
      App.agent.restoreComposerDraft();
      App.agent.renderEngineStrip();
      App.agent.refreshEngineStrip();
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
      App.agent.renderProjects();
      App.agent.renderSessions();
      App.agent.restoreThread();
      App.ui.toast('已删除会话');
    },
    renameThread(id) {
      // v1.1.0（回退）：选择器改回两栏会话项
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
        App.agent.renderProjects();
      App.agent.renderSessions();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { App.agent.renderProjects();
      App.agent.renderSessions(); }
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
          App.router.go('create', { force: true });
          App.create.importPrompt(text);
          App.ui.toast('已发送到创作中心');
        } else if (kind === 'doc' && canDoc) {
          App.doc.importText(text, '糖码结果');
          App.router.go('doc', { force: true });
          App.ui.toast('已发送到糖读');
        }
      });
      assistantNode.appendChild(row);
    },

    // ===== v5：按会话保存的 Skill 气泡与输入草稿 =====
    selectedSkills() {
      const t = App.agent.activeThread();
      if (!t) return [];
      if (!Array.isArray(t.draftSkills)) t.draftSkills = [];
      return t.draftSkills;
    },

    saveComposerDraft(persist) {
      const input = document.getElementById('agentInput');
      if (!input) return;
      const inputThreadId = input.dataset.threadId || App.state.activeThreadId;
      const t = App.state.agentThreads.find((x) => x.id === inputThreadId);
      if (!t) return;
      t.draftText = input.value || '';
      const scopeEl = document.getElementById('agentRootScope');
      if (scopeEl) {
        const value = String(scopeEl.value || 'primary');
        t.draftRootScope = value === 'all' ? { mode: 'all', rootId: '' } : (value.startsWith('single:') ? { mode: 'single', rootId: value.slice(7) } : { mode: 'primary', rootId: '' });
      }
      if (!Array.isArray(t.draftSkills)) t.draftSkills = [];
      if (persist) { try { App.persist(); } catch (_e) {} }
    },

    restoreComposerDraft() {
      const t = App.agent.activeThread();
      const input = document.getElementById('agentInput');
      if (!t || !input) return;
      input.dataset.threadId = t.id;
      input.value = typeof t.draftText === 'string' ? t.draftText : '';
      const scopeEl = document.getElementById('agentRootScope');
      if (!t.draftRootScope || typeof t.draftRootScope !== 'object') t.draftRootScope = { mode: 'primary', rootId: '' };
      const roots = ((App.agent.activeProject() || {}).roots || []);
      if (t.draftRootScope.mode === 'single' && !roots.some((root) => root.rootId === t.draftRootScope.rootId)) t.draftRootScope = { mode: 'primary', rootId: '' };
      if (scopeEl) scopeEl.value = t.draftRootScope.mode === 'single' ? ('single:' + t.draftRootScope.rootId) : (t.draftRootScope.mode === 'all' && roots.length > 1 ? 'all' : 'primary');
      if (!Array.isArray(t.draftSkills)) t.draftSkills = [];
      App.agent.renderSkillChips();
      App.agent.autoSizeInput(input);
    },

    addSkillChip(skill) {
      const t = App.agent.activeThread();
      if (!t || !skill || !skill.key) return;
      if (!Array.isArray(t.draftSkills)) t.draftSkills = [];
      if (!t.draftSkills.some((s) => s.name === skill.key) && t.draftSkills.length < 8) {
        t.draftSkills.push({ name: skill.key, description: skill.desc || '', level: skill.level || 'user' });
      }
      const input = document.getElementById('agentInput');
      if (input) input.value = '';
      t.draftText = '';
      App.agent.renderSkillChips();
      App.agent.autoSizeInput(input);
      try { App.persist(); } catch (_e) {}
      if (input) input.focus();
    },

    removeSkillChip(name) {
      const t = App.agent.activeThread();
      if (!t || !Array.isArray(t.draftSkills)) return;
      t.draftSkills = t.draftSkills.filter((s) => s.name !== name);
      App.agent.renderSkillChips();
      try { App.persist(); } catch (_e) {}
      const input = document.getElementById('agentInput');
      if (input) input.focus();
    },


    // v1.1.0（修复）：输入框纵向自适应（参考聊天 autoSize；max 160px 防过高）
    autoSizeInput(el) {
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 160) + 'px';
      const send = document.getElementById('agentSend');
      if (send) send.disabled = App.agent.running ? false : !el.value.trim();
      App.agent.updateApprovalBarPosition(); // v2（补全）：输入区增高后审批条跟随上移
    },

    // v1.1.0（修复）：输入增强——调聊天模型润色草稿后回填输入框
    async polishInput() {
      const input = document.getElementById('agentInput');
      if (!input) return;
      const text = input.value.trim();
      if (!text) { App.ui.toast('请先输入草稿再增强'); return; }
      const btn = document.getElementById('agentPolish');
      if (btn) { btn.disabled = true; btn.textContent = '增强中…'; }
      try {
        const p = App.getProvider('agent');
        if (!p.ref || !p.hasKey || !p.model) { App.ui.toast('尚未配置糖码 API 与账户模型（到「设置 → 账户」完成配置）'); return; }
        const modelSel = document.getElementById('agentModel');
        const model = modelSel ? modelSel.value : p.model;
        const res = await App.rt.gatewayFetch({
          ref: p.ref, kind: 'chat',
          telemetry: { scope: 'agent', callType: 'prompt_enhance' },
          payload: {
            model, stream: false,
            messages: [
              { role: 'system', content: '你是任务描述润色助手。把用户的草稿润色成清晰、具体、可执行的任务描述：保留意图、补全缺失的关键信息（目标、范围、验收标准），用简体中文，直接输出润色后的文本，不要解释。' },
              { role: 'user', content: text },
            ],
          },
        });
        const polished = (res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content)
          || (res && res.data && res.data.choices && res.data.choices[0] && res.data.choices[0].message && res.data.choices[0].message.content)
          || '';
        if (!polished.trim()) { App.ui.toast('增强失败：模型未返回内容'); return; }
        input.value = polished.trim();
        App.agent.autoSizeInput(input);
        input.focus();
      } catch (e) {
        App.ui.toast('输入增强失败：' + (e.message || e));
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = '✎ 增强'; }
      }
    },

    // ===== 事件绑定 =====
    bind() {
      const input = document.getElementById('agentInput');
      const send = document.getElementById('agentSend');
      if (input && send) {
        // v1.1.0（修复）：输入自动增高（纵向自适应）+ v4：/ 触发命令/技能下拉
        input.addEventListener('input', () => {
          if (!App.agent.running) send.disabled = !input.value.trim();
          App.agent.autoSizeInput(input);
          App.agent.saveComposerDraft();
          App.agent.onInputSuggest(input);
        });
        input.addEventListener('keydown', (e) => {
          // v4：下拉可见时接管键盘（↑↓/Enter·Tab/Esc），避免误发送
          if (App.agent.suggestVisible()) {
            if (e.key === 'ArrowDown') { e.preventDefault(); App.agent.moveSuggest(1); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); App.agent.moveSuggest(-1); return; }
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); App.agent.confirmSuggest(); return; }
            if (e.key === 'Escape') { e.preventDefault(); App.agent.closeSuggest(); return; }
          }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); App.agent.send(); }
        });
        send.addEventListener('click', () => { if (App.agent.running) App.agent.stop(); else App.agent.send(); });
      }
      // v1.1.0（修复）：输入增强（一键润色回填）
      const polish = document.getElementById('agentPolish');
      if (polish) polish.addEventListener('click', () => App.agent.polishInput());
      // v1.1.0（Fix 6）：糖码思考强度（独立设置，不联动聊天）
      const thinkSel = document.getElementById('agentThink');
      if (thinkSel) thinkSel.addEventListener('change', () => {
        App.state.settings.agentThinkLevel = thinkSel.value;
        App.persist();
        const lbl = thinkSel.value === 'off' ? '关闭' : (thinkSel.value === 'low' ? '低' : thinkSel.value === 'high' ? '高' : '中');
        App.ui.toast('糖码思考强度：' + lbl);
      });
      // v2（UX 修复）：糖码模型选择持久化——切换后写入 App.state.agentModel，render 重建/切项目不再回退默认模型
      const agentRootScopeSel = document.getElementById('agentRootScope');
      if (agentRootScopeSel) agentRootScopeSel.addEventListener('change', () => {
        App.agent.saveComposerDraft(true);
      });
      const agentModelSel = document.getElementById('agentModel');
      if (agentModelSel) agentModelSel.addEventListener('change', () => {
        App.state.agentModel = agentModelSel.value;
        App.persist();
      });
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
      const compactBtn = document.getElementById('agentCompactBtn');
      if (compactBtn) compactBtn.addEventListener('click', () => App.agent.compactNow(''));
      const clearBtn = document.getElementById('agentClearCtxBtn');
      if (clearBtn) clearBtn.addEventListener('click', () => App.agent.clearContext());
      const memBtn = document.getElementById('agentMemoryBtn');
      if (memBtn) memBtn.addEventListener('click', () => App.agent.openMemoryEditor());
      // v1.1.0（M1）：运行历史面板
      const histBtn = document.getElementById('agentHistoryBtn');
      if (histBtn) histBtn.addEventListener('click', () => App.agent.showRunHistory());
      const evalBtn = document.getElementById('agentEvalBtn');
      if (evalBtn) evalBtn.addEventListener('click', () => App.agent.showSafeEval());
      const engineBtn = document.getElementById('agentEngineBtn');
      if (engineBtn) engineBtn.addEventListener('click', () => App.agent.openEngineObserver());
      // Plan 模式开关
      const planToggle = document.getElementById('agentPlanToggle');
      if (planToggle) planToggle.addEventListener('change', () => {
        const proj = App.agent.activeProject();
        proj.planMode = !!planToggle.checked;
        App.persist();
        const badge = document.getElementById('agentPlanBadge');
        if (badge) { badge.textContent = 'Plan ' + (proj.planMode ? '只读探索' : '可执行'); badge.className = 'agent-status plan-badge ' + (proj.planMode ? 'on' : 'off'); }
      });
      // 宽窗持久化两栏折叠；窄窗只更新临时浮层状态。
      const cp = document.getElementById('agentCollapseProjects');
      if (cp) cp.addEventListener('click', () => {
        if (App.agent._sidebarCompactMode) App.agent._compactSidebarOpen = null;
        else { App.state.agentProjectsCollapsed = true; App.persist(); }
        App.agent.render();
      });
      const ep = document.getElementById('agentExpandProjects');
      if (ep) ep.addEventListener('click', () => {
        if (App.agent._sidebarCompactMode) App.agent._compactSidebarOpen = 'projects';
        else { App.state.agentProjectsCollapsed = false; App.persist(); }
        App.agent.render();
      });
      const cs = document.getElementById('agentCollapseSessions');
      if (cs) cs.addEventListener('click', () => {
        if (App.agent._sidebarCompactMode) App.agent._compactSidebarOpen = null;
        else { App.state.agentSessionsCollapsed = true; App.persist(); }
        App.agent.render();
      });
      const es = document.getElementById('agentExpandSessions');
      if (es) es.addEventListener('click', () => {
        if (App.agent._sidebarCompactMode) App.agent._compactSidebarOpen = 'sessions';
        else { App.state.agentSessionsCollapsed = false; App.persist(); }
        App.agent.render();
      });
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
        const res = await fetch(agentBase() + '/api/health', { cache: 'no-store', headers: authHeaders() });
        const j = await res.json().catch(() => ({}));
        if (j.ok) {
          status.textContent = '已连接'; status.className = 'agent-status on';
          App.agent._backendOk = true; // v1.1.0（Fix）：真实连接状态（render 重建后不再误报未连接）
          if (offline) offline.style.display = 'none';
          // 若当前项目 cwd 为空，用后端目录回填
          const proj = App.agent.activeProject();
          if (proj && !proj.cwd && j.cwd) { proj.cwd = j.cwd; App.persist(); App.agent.render(); }
          App.ui.toast('已连接到糖码后端');
        } else { status.textContent = '异常'; status.className = 'agent-status off'; App.agent._backendOk = false; }
      } catch (e) {
        status.textContent = '未连接'; status.className = 'agent-status off';
        App.agent._backendOk = false;
        if (offline) offline.style.display = 'block';
      }
    },

    // v1.1.0（Fix）：静默健康探测——render 重建后自动修正连接状态（无 toast，不打扰）
    async autoProbe() {
      try {
        const res = await fetch(agentBase() + '/api/health', { cache: 'no-store', headers: authHeaders() });
        const j = await res.json().catch(() => ({}));
        const status = document.getElementById('agentStatus');
        if (j.ok) {
          App.agent._backendOk = true;
          if (status) { status.textContent = '已连接'; status.className = 'agent-status on'; }
          const offline = document.getElementById('agentOffline');
          if (offline) offline.style.display = 'none';
        } else {
          App.agent._backendOk = false;
          if (status) { status.textContent = '异常'; status.className = 'agent-status off'; }
        }
      } catch (e) {
        App.agent._backendOk = false;
        const status = document.getElementById('agentStatus');
        if (status) { status.textContent = '未连接'; status.className = 'agent-status off'; }
      }
    },

    showMeta(meta) {
      // v1.1.0：meta 事件带 runId——存入运行状态（药丸跳转用）
      if (App.agent._runState && meta && meta.runId) App.agent._runState.runId = meta.runId;
      // v15（续段）：runId 同时写入线程级 lastRunId 并持久化，任务结束后仍可精确恢复
      if (meta && meta.runId) {
        const t = App.agent.activeThread();
        if (t) { t.lastRunId = String(meta.runId); try { App.persist(); } catch (_e) {} }
      }
      // v1.1.0（优化 Plan 模式）：计划批准/退出后同步徽章文案
      if (meta && (meta.modeChanged === 'plan_approve' || meta.modeChanged === 'plan_exit')) {
        App.agent._planApproved = true;
        App.agent.setPlanBadge('已批准 · 执行中');
      }
      // v15（单状态卡）：Meta 信息并入统一状态卡，不再作为第二张运行状态条
      App.agent.showStatusRunning();
    },
    hideMeta() {
      // v15（单状态卡）：Meta 条已并入状态卡，此函数保留为空操作以兼容调用点
    },

    // 建议菜单最近使用（localStorage，最多 8 条）
    _rememberUsed(item) {
      try {
        let list = JSON.parse(localStorage.getItem('tangbao.agent.usedItems') || '[]');
        if (!Array.isArray(list)) list = [];
        list = list.filter((u) => !(u && u.type === item.type && u.key === item.key));
        list.unshift({ type: item.type, key: item.key, at: Date.now() });
        localStorage.setItem('tangbao.agent.usedItems', JSON.stringify(list.slice(0, 8)));
      } catch (_e) {}
    },
    _recentUsed() {
      try { const list = JSON.parse(localStorage.getItem('tangbao.agent.usedItems') || '[]'); return Array.isArray(list) ? list : []; } catch (_e) { return []; }
    },
    // v2（UX 指标）：本地累计关键交互次数（模板/就地校验/状态条/审批/历史/诊断），用于迭代依据，不采集任何内容
    _uxTrack(key) {
      try {
        const store = JSON.parse(localStorage.getItem('tangbao.agent.uxMetrics') || '{}');
        if (!store || typeof store !== 'object') return;
        store[key] = (store[key] || 0) + 1;
        localStorage.setItem('tangbao.agent.uxMetrics', JSON.stringify(store));
      } catch (_e) {}
    },
    _uxStats() {
      try { const store = JSON.parse(localStorage.getItem('tangbao.agent.uxMetrics') || '{}'); return store && typeof store === 'object' ? store : {}; } catch (_e) { return {}; }
    },





    // v2（补全）：审批条/接力条动态定位——悬浮于输入区上方，textarea 增高/窗口缩放均跟随
    updateApprovalBarPosition() {
      const bars = document.querySelectorAll('.agent-approval-bar');
      if (!bars.length) return;
      const comp = document.querySelector('.agent-composer');
      const c = comp ? comp.getBoundingClientRect() : null;
      const bottom = (c && c.height > 0) ? Math.max(96, Math.round(window.innerHeight - c.top + 16)) : 96;
      bars.forEach((b) => { b.style.bottom = bottom + 'px'; });
    },

    // v1.1.0（M3+）：底部悬浮审批条——不遮屏、不打断输入；命令+可展开 Diff+操作（批准/本任务免问/总是允许/拒绝）
    // v2（UX）：审批卡补充工具类型、影响文件、Skill 来源与可撤销性，并支持「拒绝并说明原因」

    async approveRequest(callId, decision, reason, persistRule) {
      try {
        await fetch(agentBase() + '/api/agent/approve', {
          method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ callId, approved: decision !== 'reject', decision, reason: reason || '', persistRule: !!persistRule }),
        });
      } catch (e) {}
    },

    // v2（P2-8）：糖码记忆确认卡片——确认后写入项目 糖码记忆.md（未确认不落盘）


    // ===== v1.1.0（优化 Plan 模式）：计划待批准 / 完成门拦截 / 用户提问 三张卡片 =====
    removeCard(id) {
      const card = document.getElementById(id);
      if (card) card.remove();
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
        const mark = t.status === 'completed' ? '✓' : (t.status === 'in_progress' ? '◐' : '○');
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
      const pathLabel = filePath ? `<div class="agent-diff-path">📄 ${App.escapeHtml(filePath)}</div>` : '';
      diffEl.innerHTML = pathLabel + lines;
      thread.scrollTop = thread.scrollHeight;
    },

    // ===== P0 Eval：受控 fixture 评测（主进程持有 token/密钥，UI 不接受 cwd）=====
    async showSafeEval() {
      const storage = App.services.storage;
      const provider = App.getProvider('agent');
      const modelEl = document.getElementById('agentModel');
      const model = modelEl ? modelEl.value : provider.model;
      if (!storage || !storage.listAgentEvalTasks || !storage.runAgentEval) { App.ui.toast('当前版本不支持安全评测'); return; }
      if (!provider.ref || !provider.hasKey || !model) { App.ui.toast('请先配置糖码模型账户'); return; }
      let tasks = [];
      try {
        const response = await storage.listAgentEvalTasks();
        if (!response || !response.ok) throw new Error((response && response.error) || '读取评测任务失败');
        tasks = response.tasks || [];
      } catch (error) { App.ui.toast('读取评测任务失败：' + (error.message || error)); return; }
      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.id = 'agentEvalMask';
      const options = tasks.map((task) => `<option value="${App.escapeHtml(task.id)}">${App.escapeHtml(task.id + ' · ' + task.title)}</option>`).join('');
      modal.innerHTML = `
        <div class="modal modal-mid" role="dialog" aria-modal="true">
          <div class="modal-header"><span>糖码安全评测</span><button class="icon-btn" id="agentEvalClose" aria-label="关闭">✕</button></div>
          <div class="modal-body">
            <p class="hint" style="margin-top:0">仅运行内置白名单 fixture。评测会复制到独立目录，不接触当前项目，不向渲染层暴露启动令牌或密钥。</p>
            <label class="field"><span class="field-label">评测任务</span><select id="agentEvalTask">${options}</select></label>
            <div class="agent-status-summary" id="agentEvalStatus" role="status">就绪 · ${tasks.length} 个安全任务</div>
            <pre id="agentEvalResult" style="white-space:pre-wrap;max-height:260px;overflow:auto" hidden></pre>
          </div>
          <div class="modal-footer"><button class="btn-ghost" id="agentEvalCancel">关闭</button><button class="btn-ghost" id="agentEvalRunAll" ${tasks.length ? '' : 'disabled'}>全部运行</button><button class="btn-primary" id="agentEvalRun" ${tasks.length ? '' : 'disabled'}>运行评测</button></div>
        </div>`;
      document.body.appendChild(modal);
      const close = () => modal.remove();
      modal.querySelector('#agentEvalClose').onclick = close;
      modal.querySelector('#agentEvalCancel').onclick = close;
      modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
      modal.querySelector('#agentEvalRun').onclick = async () => {
        const run = modal.querySelector('#agentEvalRun');
        const taskId = modal.querySelector('#agentEvalTask').value;
        const status = modal.querySelector('#agentEvalStatus');
        const output = modal.querySelector('#agentEvalResult');
        run.disabled = true; run.textContent = '运行中…'; status.textContent = '运行中 · 使用独立 fixture，请勿关闭应用'; output.hidden = true;
        try {
          const response = await storage.runAgentEval({ taskId, ref: provider.ref, model });
          if (!response || !response.ok) throw new Error((response && response.error) || '评测失败');
          const result = response.result || {};
          status.textContent = result.machinePassed ? '机器判分通过' : ('未通过 · ' + (result.status || 'unknown'));
          output.hidden = false;
          output.textContent = JSON.stringify({ task: result.id, status: result.status, machinePassed: result.machinePassed, steps: result.steps, toolCalls: result.toolCalls, failures: result.failures, durationMs: result.durationMs, error: result.error || '' }, null, 2);
          App.ui.toast(result.machinePassed ? '安全评测通过' : '安全评测未通过，请查看结果');
        } catch (error) {
          status.textContent = '评测失败'; output.hidden = false; output.textContent = String(error.message || error); App.ui.toast('安全评测失败：' + (error.message || error));
        } finally { run.disabled = false; run.textContent = '再次运行'; }
      };
      // v16（Eval 批量提速）：3 路并发池运行未通过任务（主进程并发上限 3），跳过历史已通过；实时进度与逐任务结果，运行中互斥禁用按钮
      modal.querySelector('#agentEvalRunAll').onclick = async () => {
        const runBtn = modal.querySelector('#agentEvalRun');
        const allBtn = modal.querySelector('#agentEvalRunAll');
        const status = modal.querySelector('#agentEvalStatus');
        const output = modal.querySelector('#agentEvalResult');
        const runtimeSkipped = tasks.filter((t) => !t.alreadyPassed && t.infrastructureSkipped);
        const metricRetests = tasks.filter((t) => t.alreadyPassed && t.metricIncomplete && !t.infrastructureSkipped);
        const capabilityRetests = tasks.filter((t) => !t.alreadyPassed && !t.infrastructureSkipped);
        const pending = capabilityRetests.concat(metricRetests);
        const skipped = tasks.filter((t) => t.alreadyPassed && !t.metricIncomplete).length;
        const results = [];
        runBtn.disabled = true; allBtn.disabled = true;
        output.hidden = false; output.textContent = '';
        const fmt = (taskId, result, errorText) => JSON.stringify({
          task: taskId, status: (result && result.status) || 'failed', machinePassed: !!(result && result.machinePassed),
          infrastructureFailure: !!(result && result.infrastructureFailure), attempts: (result && result.attempts && result.attempts.length) || 1,
          steps: (result && result.steps) || 0, failures: (result && result.failures) || 0,
          error: (errorText || (result && result.error) || '').toString().slice(0, 200),
        }, null, 2);
        const appendResult = (taskId, result, errorText) => {
          results.push({ id: taskId, machinePassed: !!(result && result.machinePassed), status: (result && result.status) || 'failed', infrastructureFailure: !!(result && result.infrastructureFailure) });
          output.textContent += (output.textContent ? '\n---\n' : '') + fmt(taskId, result, errorText);
          output.scrollTop = output.scrollHeight;
          status.textContent = '批量运行中 · ' + results.length + '/' + pending.length + ' 完成 · 3 路并发 · 请勿关闭应用';
        };
        const runOne = async (task) => {
          try {
            const response = await storage.runAgentEval({ taskId: task.id, ref: provider.ref, model });
            if (!response || !response.ok) throw new Error((response && response.error) || '评测失败');
            appendResult(task.id, response.result || {}, '');
          } catch (error) {
            appendResult(task.id, null, String(error.message || error));
          }
        };
        const CONCURRENCY = 3;
        if (runtimeSkipped.length) {
          output.textContent = runtimeSkipped.map((task) => fmt(task.id, { status: 'infrastructure_skipped', infrastructureFailure: true }, '缺少运行时：' + (task.missingRuntimes || []).join(', '))).join('\n---\n');
        }
        if (pending.length === 0) {
          status.textContent = runtimeSkipped.length
            ? '没有可运行任务 · 环境跳过 ' + runtimeSkipped.length + ' 个'
            : '全部任务已通过，无需运行' + (skipped ? '' : '（' + tasks.length + ' 个）');
          App.ui.toast(runtimeSkipped.length ? '安全评测：部分任务因缺少运行时已跳过' : '安全评测：全部任务已通过');
        } else {
          status.textContent = '批量运行中 · 能力复测 ' + capabilityRetests.length + ' 个 · 指标补测 ' + metricRetests.length + ' 个' + (skipped ? '（跳过 ' + skipped + ' 个历史完整通过）' : '') + (runtimeSkipped.length ? ' · 环境跳过 ' + runtimeSkipped.length + ' 个' : '') + ' · 3 路并发 · 请勿关闭应用';
          for (let i = 0; i < pending.length; i += CONCURRENCY) {
            const batch = pending.slice(i, i + CONCURRENCY);
            await Promise.all(batch.map((t) => runOne(t)));
          }
          const passed = results.filter((r) => r.machinePassed).length;
          const infrastructureFailed = results.filter((r) => r.infrastructureFailure).length;
          const behavioralFailed = results.length - passed - infrastructureFailed;
          const summary = passed + ' 通过 · ' + behavioralFailed + ' 行为失败 · ' + infrastructureFailed + ' 基础设施失败' + (runtimeSkipped.length ? ' · ' + runtimeSkipped.length + ' 环境跳过' : '');
          status.textContent = '批量完成 · ' + summary + (skipped ? '（跳过 ' + skipped + ' 个历史已通过）' : '');
          App.ui.toast('安全评测批量完成：' + summary);
        }
        runBtn.disabled = false; runBtn.textContent = '再次运行'; allBtn.disabled = false;
      };
    },

    // ===== v1.1.0（M7）：子代理卡片（explore 蓝 / test 橙 / review 紫） =====


    // v1.1.1：协作卡支持排队、结构化 findings/checks 与证据详情。

    // v15（单状态卡）：不再创建独立接力条；「继续任务」统一并入状态卡（data-status-resume → resumeRun）

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
          <span class="agent-job-ico">⏵</span>
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
      if (ico) ico.textContent = '⏹';
      const title = node.querySelector('.agent-job-title');
      if (title) title.textContent = '后台任务已结束（exit ' + (code == null ? '?' : code) + '）';
      const thread = document.getElementById('agentThread');
      if (thread) thread.scrollTop = thread.scrollHeight;
    },




    // v4（命令对齐）：内置命令表（/ 快捷菜单与 /help 共用；与 send() 命令解析保持一致）
    BUILTIN_CMDS: [
      { k: '/compact', d: '手动压缩当前上下文', p: '[focus]' },
      { k: '/clear', d: '清空当前会话上下文（保留线程）' },
      { k: '/help', d: '显示命令帮助' },
      { k: '/memory', d: '写入用户长期记忆（不带内容则查看）', p: '<内容>' },
      { k: '/skills', d: '让模型列出所有可用技能' },
      { k: '/skill', d: '显式加载指定技能并按指引执行', p: '<名称>' },
    ],

    // v4（命令对齐）：/help——在会话区插入可用命令说明块（不消耗模型）
    showHelp() {
      const thread = document.getElementById('agentThread');
      const node = document.createElement('div');
      node.className = 'agent-msg assistant';
      const rows = (App.agent.BUILTIN_CMDS || [])
        .map((c) => '<li><code>' + App.escapeHtml(c.k + (c.p ? ' ' + c.p : '')) + '</code> — ' + App.escapeHtml(c.d) + '</li>')
        .join('');
      node.innerHTML = '<div class="agent-answer"><b>可用命令</b><ul style="margin:6px 0 0 16px;line-height:1.7">' + rows + '</ul></div>';
      thread.appendChild(node);
      thread.scrollTop = thread.scrollHeight;
    },

    // ===== v4：/ 命令+技能快捷下拉 =====
    suggestVisible() {
      const box = document.getElementById('agentSuggest');
      return !!(box && !box.hidden);
    },
    closeSuggest() {
      App.agent._suggestItems = null;
      App.agent._suggestActive = 0;
      const box = document.getElementById('agentSuggest');
      if (box) box.hidden = true;
    },
    // 输入以 / 开头 → 打开并过滤（命令 + 技能），否则关闭
    onInputSuggest(input) {
      const v = String(input.value || '');
      if (v.trim().startsWith('/')) {
        // 技能列表懒加载（每项目一次；失败降级为仅命令）
        if (App.agent._skills === undefined) App.agent.loadSkills();
        const q = v.trim().slice(1).toLowerCase();
        const cmds = (App.agent.BUILTIN_CMDS || [])
          .filter((c) => !q || c.k.slice(1).toLowerCase().includes(q) || String(c.d || '').toLowerCase().includes(q))
          .map((c) => ({ type: 'cmd', key: c.k, param: c.p || '', desc: c.d }));
        const selected = new Set(App.agent.selectedSkills().map((s) => s.name));
        const skills = (App.agent._skills || [])
          .filter((s) => s && s.name && (!q || String(s.name).toLowerCase().includes(q) || String(s.description || '').toLowerCase().includes(q)))
          .map((s) => ({ type: 'skill', key: s.name, desc: s.description || '', level: s.level || 'user', selected: selected.has(s.name) }));
        const items = cmds.concat(skills);
        if (items.length) App.agent.openSuggest(items);
        else App.agent.closeSuggest();
      } else {
        App.agent.closeSuggest();
      }
    },
    // 异步拉取技能列表（GET /api/skills?workspaceId=），失败缓存空数组
    // v2（热刷新）：生命周期变更后清缓存并重拉；loadSkills 内已有"加载后重绘菜单"逻辑
    refreshSkillCache() {
      App.agent._skills = undefined;
      if (App.agent.loadSkills) App.agent.loadSkills();
    },
    async loadSkills() {
      try {
        const proj = App.agent.activeProject();
        const result = await App.services.workspace.run(proj, async (wid) => {
          const url = App.rt.agentBase() + '/api/skills' + (wid ? '?workspaceId=' + encodeURIComponent(wid) : '');
          const res = await fetch(url, { headers: authHeaders({ 'Content-Type': 'application/json' }) });
          const j = await res.json().catch(() => ({}));
          if (!res.ok) return Object.assign({ ok: false }, j, { code: j.code || 'skills_request_failed' });
          return j;
        });
        if (!result || result.ok === false) throw new Error((result && (result.error || result.code)) || '技能列表读取失败');
        const j = result;
        App.agent._skills = (j && Array.isArray(j.skills)) ? j.skills : [];
        // 首次加载完成后立即刷新当前菜单，不要求用户再次输入。
        const input = document.getElementById('agentInput');
        if (input && input.value.trim().startsWith('/')) App.agent.onInputSuggest(input);
      } catch (_e) { App.agent._skills = []; }
    },
    openSuggest(items) {
      const box = document.getElementById('agentSuggest');
      if (!box) return;
      // v2（UX）：最近使用分组——按历史使用顺序前置命中项（键盘导航全量顺序跟随）
      const used = App.agent._recentUsed();
      const usedHits = used.map((u) => items.find((i) => i.type === u.type && i.key === u.key)).filter(Boolean);
      const usedKeys = new Set(usedHits.map((i) => i.type + '::' + i.key));
      const rest = items.filter((i) => !usedKeys.has(i.type + '::' + i.key));
      const order = usedHits.concat(rest);
      App.agent._suggestItems = order;
      App.agent._suggestActive = 0;
      const cmds = rest.map((item, idx) => ({ item, idx: order.indexOf(item) })).filter((x) => x.item.type === 'cmd');
      const skills = rest.map((item, idx) => ({ item, idx: order.indexOf(item) })).filter((x) => x.item.type === 'skill');
      let html = '<div class="suggest-head"><span>快捷命令</span><kbd>↑↓</kbd><kbd>Enter</kbd><kbd>Esc</kbd></div>';
      if (usedHits.length) html += '<div class="suggest-group"><span>最近使用</span><b>' + usedHits.length + '</b></div>' + usedHits.map((item) => App.agent.suggestRow(item, order.indexOf(item))).join('');
      if (cmds.length) html += '<div class="suggest-group"><span>命令</span><b>' + cmds.length + '</b></div>' + cmds.map((x) => App.agent.suggestRow(x.item, x.idx)).join('');
      if (skills.length) html += '<div class="suggest-group"><span>技能</span><b>' + skills.length + '</b></div>' + skills.map((x) => App.agent.suggestRow(x.item, x.idx)).join('');
      box.innerHTML = html;
      const first = box.querySelector('.suggest-item[data-idx="0"]');
      if (first) first.classList.add('active');
      box.onclick = (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('.suggest-item') : null;
        if (!btn) return;
        App.agent._suggestActive = Number(btn.dataset.idx || 0);
        App.agent.confirmSuggest();
      };
      box.hidden = false;
    },
    suggestRow(item, idx) {
      if (item.type === 'cmd') {
        const param = item.param ? '<span class="suggest-param">' + App.escapeHtml(item.param) + '</span>' : '';
        return '<button type="button" class="suggest-item suggest-command" data-idx="' + idx + '"><span class="suggest-mark">/</span><span class="suggest-copy"><span class="suggest-title"><code>' + App.escapeHtml(item.key.slice(1)) + '</code>' + param + '</span><span class="suggest-desc">' + App.escapeHtml(item.desc) + '</span></span></button>';
      }
      const level = item.level === 'project' ? '项目' : (item.level === 'builtin' ? '内置' : '用户');
      const chosen = item.selected ? '<span class="suggest-selected">已添加</span>' : '';
      return '<button type="button" class="suggest-item suggest-skill' + (item.selected ? ' is-selected' : '') + '" data-idx="' + idx + '"><span class="suggest-mark">✦</span><span class="suggest-copy"><span class="suggest-title"><code>' + App.escapeHtml(item.key) + '</code><span class="suggest-source">' + level + '</span>' + chosen + '</span><span class="suggest-desc">' + App.escapeHtml(item.desc || '加载该技能指引') + '</span></span></button>';
    },
    moveSuggest(delta) {
      const n = (App.agent._suggestItems || []).length;
      if (!n) return;
      App.agent._suggestActive = (App.agent._suggestActive + delta + n) % n;
      const box = document.getElementById('agentSuggest');
      if (box) {
        let active = null;
        box.querySelectorAll('.suggest-item').forEach((el) => {
          const on = Number(el.dataset.idx || 0) === App.agent._suggestActive;
          el.classList.toggle('active', on);
          if (on) active = el;
        });
        if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
      }
    },
    confirmSuggest() {
      const it = App.agent._suggestItems && App.agent._suggestItems[App.agent._suggestActive];
      if (!it) return;
      // v2（UX）：记录最近使用（技能/命令）
      App.agent._rememberUsed({ type: it.type, key: it.key });
      const input = document.getElementById('agentInput');
      App.agent.closeSuggest();
      if (it.type === 'skill') {
        App.agent.addSkillChip(it);
        return;
      }
      // 命令：无参命令直接执行；带参命令回填前缀待补参
      const noArg = ['/clear', '/help', '/skills'];
      if (noArg.includes(it.key)) { input.value = it.key; App.agent.send(); }
      else { input.value = it.key + ' '; input.focus(); }
    },

    setRunning(on) {
      App.agent.running = on;
      // v1.1.0（修复）：仅开始运行标记线程；结束时由 finish 对目标任务线程置 false（切走后 activeThread 可能不同）
      if (on) {
        const t = App.agent.activeThread();
        if (t) t._running = true;
      }
      const send = document.getElementById('agentSend');
      const input = document.getElementById('agentInput');
      if (send) {
        send.disabled = on ? false : !(input && input.value.trim());
        send.textContent = on ? '■' : '➤';
        send.classList.toggle('stopping', on);
        send.title = on ? '停止' : '发送';
      }
    },

    // v1.1.2：运行观测按需打开，首屏只保留紧凑入口。




    stop() {
      if (App.agent._ctrl) { try { App.agent._ctrl.abort(); } catch (e) {} }
    },

    async send() {
      if (App.agent.running) return;
      const input = document.getElementById('agentInput');
      const prompt = input.value.trim();
      const selectedSkills = App.agent.selectedSkills().map((s) => ({ name: s.name, description: s.description || '', level: s.level || 'user' }));
      if (!prompt) return;
      // /memory 命令：写入用户长期记忆（不进入对话）
      if (prompt.startsWith('/memory')) {
        App.agent.writeMemory(prompt.slice(7).trim());
        return;
      }
      // v4（命令对齐）：/clear 直清当前会话（不弹窗，保留 toast）
      if (prompt.startsWith('/clear')) {
        App.agent.doClearThread();
        return;
      }
      // v4（命令对齐）：/help 展示命令说明（不消耗模型）
      if (prompt.startsWith('/help')) {
        App.agent.showHelp();
        return;
      }
      // 手动压缩：/compact [focus]（定向保留重点）
      if (prompt.startsWith('/compact')) {
        const focus = prompt.slice(8).trim();
        App.agent.compactNow(focus);
        return;
      }
      // v3（Skill 明确化）：/skills 让模型列出可用技能；/skill <name> 显式加载指定技能（都走正常对话，模型用 list_skills/use_skill 工具）
      if (prompt.startsWith('/skills')) {
        input.value = '请用 list_skills 工具列出当前所有可用技能，说明每个技能的名称、用途与来源级别（项目/用户/内置）。';
        return App.agent.send();
      }
      if (prompt.startsWith('/skill ')) {
        const name = prompt.slice(7).trim();
        if (!name) { App.ui.toast('用法：/skill <技能名>，如 /skill git-commit-standards（先用 /skills 查看）'); return; }
        if (App.agent._skills === undefined) await App.agent.loadSkills();
        const skill = (App.agent._skills || []).find((s) => s && s.name === name);
        if (!skill) { App.ui.toast('未找到或未启用技能：' + name); return; }
        App.agent.addSkillChip({ type: 'skill', key: skill.name, desc: skill.description || '', level: skill.level || 'user' });
        return;
      }
      const p = App.getProvider('agent');
      if (!p.ref || !p.hasKey || !p.model) {
        App.ui.toast('尚未配置糖码 API 与账户模型（到「设置 → 账户」完成配置）');
        return;
      }
      const modelSel = document.getElementById('agentModel');
      const model = modelSel ? modelSel.value : p.model;
      // M6：不给不支持工具调用的模型发工具定义（糖码依赖工具运行，直接拦截并给可行动提示）
      if (App.ModelCapabilities && App.ModelCapabilities.capsOfModelApp) {
        const caps = App.ModelCapabilities.capsOfModelApp(model);
        if (!caps.toolCalling) {
          App.ui.toast('当前模型不支持工具调用（在账户设置中为模型选择「工具」能力，或切换支持工具的模型）');
          return;
        }
      }
      const proj = App.agent.activeProject();
      // v2（UX）：未选项目直接 toast 提示（不弹就地提示条）
      if (!proj || !proj.cwd) {
        App.ui.toast('尚未选择项目工作目录（左上角「新建项目」或选择已有项目）');
        return;
      }
      const cwd = proj.cwd || '';
      // M7（#253）：优先用不透明 workspaceId；缺失但有 cwd 时惰性登记并持久化，使旧项目自动迁移
      const workspace = App.services.workspace && await App.services.workspace.ensureProject(proj);
      if (!workspace || !workspace.ok) {
        App.agent.renderStatusSummary('error', { message: (workspace && workspace.error) || '项目工作区已失效，请重新选择项目文件夹。' });
        App.ui.toast((workspace && workspace.error) || '项目工作区已失效，请重新选择项目文件夹。');
        return;
      }
      const workspaceId = workspace.workspaceId;
      const auto = !!proj.auto;
      const planMode = !!proj.planMode;
      const approveTools = proj.approveTools || [];
      const cmdWhitelist = proj.cmdWhitelist || [];

      const thread = App.agent.activeThread();
      const rootScope = (thread && thread.draftRootScope && typeof thread.draftRootScope === 'object')
        ? { mode: ['primary', 'single', 'all'].includes(thread.draftRootScope.mode) ? thread.draftRootScope.mode : 'primary', rootId: thread.draftRootScope.mode === 'single' ? String(thread.draftRootScope.rootId || '') : '' }
        : { mode: 'primary', rootId: '' };
      if (rootScope.mode === 'single' && !(proj.roots || []).some((root) => root.rootId === rootScope.rootId)) {
        App.agent.renderStatusSummary('error', { message: '所选任务文件夹已被移除，请重新选择任务文件夹。' });
        return;
      }

      const pendingUserNode = App.agent.appendUser(prompt, selectedSkills);
      App.agent.setRunning(true);
      // v2（UX）：统一状态摘要——运行中一行式状态
      App.agent.showStatusRunning();
      // v1.1.0：全局运行状态对象（顶栏药丸驱动）——切走会话/模块仍实时更新
      App.agent._runState = {
        threadId: thread.id, projectId: App.state.activeProjectId, runId: '',
        phase: 'understanding', toolName: '', step: 0, segmentIndex: 0,
        startedAt: Date.now(), goal: String(prompt || '').slice(0, 50), status: 'running',
      };
      if (App.agent._runPillTimer) clearInterval(App.agent._runPillTimer);
      App.agent._runPillTimer = setInterval(() => App.agent.renderRunPill(), 1000);
      App.agent.renderRunPill();
      App.agent.renderEngineStrip();
      // v1.1.0（Fix 4）+ v15（单状态卡）：新任务开始——隐藏旧状态卡、记录目标（供「继续任务」）、恢复在线状态
      App.agent.hideStatusSummary();
      const offBox = document.getElementById('agentOffline');
      if (offBox) offBox.style.display = 'none';
      thread._lastPrompt = prompt;
      thread._pendingUser = { content: prompt, skills: selectedSkills }; // 运行中重建保留正文与 Skill 标签
      // v1.1.0（修复）：_liveUI 单例（抗 render 重建）+ 线程实时事件记录（切会话不丢消息）
      App.agent._liveUI = { threadId: thread.id, answerEl: null, blocks: new Map(), subagents: new Map() };
      thread._liveEvents = thread._liveEvents || [];
      thread._liveAnswer = thread._liveAnswer || '';
      App.agent._liveDirty = false;
      // 每轮运行重置：清空上一轮的任务清单与后台任务面板
      const oldTodo = document.getElementById('agentTodo');
      if (oldTodo) oldTodo.remove();
      App.agent._jobPanels = {};

      if (thread.title === '新会话' && !thread.history.length) {
        thread.title = prompt.length > 18 ? prompt.slice(0, 18) + '…' : prompt;
        App.agent.renderProjects();
      App.agent.renderSessions();
      }

      // v1.1.0（M2）：上下文预算基于糖码实际选中的模型（#agentModel），而非聊天账户默认模型
      const agentSys = (App.state.settings.prompts && App.state.settings.prompts.agent) || (App.AgentPrompt && App.AgentPrompt.SYSTEM_PROMPT) || '';
      const ctxWindow = App.context.contextWindowOf(model);
      const msgList = (thread.history || []).map(h => ({ role: h.role, content: h.content }));
      // M2+G4：摘要输入含执行轨迹——把最近 Run 的元信息/工具事件/变更文件格式化并入压缩范围（摘要不再只基于纯聊天文本）
      const TRACE_PER_RESULT = 500;  // G4：单条工具结果截断（原 300）
      const TRACE_TOTAL = 4000;      // G4：traceMsg 总量预算（原 2500）
      let traceMsg = null;
      let lastEventSeq = 0; // v3（P3）：最近 run 事件最大 seq，供摘要落库与 traceMsg 过滤
      try {
        if (App.services.storage && App.services.storage.listAgentRuns) {
          const runsRes = await App.services.storage.listAgentRuns(thread.id, 1);
          const runs = runsRes && runsRes.ok ? runsRes.runs : [];
          if (runs && runs.length) {
            const runMeta = runs[0];
            const evRes = await App.services.storage.listAgentEvents(runMeta.id);
            const events = evRes && evRes.ok ? evRes.events : [];
            // v3（P3）：已进摘要的事件（seq ≤ summaryToSeq）不再重复进 traceMsg/摘要
            lastEventSeq = events.length ? Math.max.apply(null, events.map((e) => Number(e.seq) || 0)) : 0;
            const freshEvents = (thread.summaryToSeq ? events.filter((ev) => (Number(ev.seq) || 0) > thread.summaryToSeq) : events);
            // G4：按价值给事件打分（错误/收敛/受阻最高 → 含错结果 → 普通结果 → 阶段/验证 → 调用 → Diff），稳定排序后取前段
            const scoreOf = (ev) => {
              if (ev.type === 'error' || ev.type === 'convergence_notice' || ev.type === 'blocked' || ev.type === 'gate_blocked') return 0;
              if (ev.type === 'tool_result') {
                const rp = (ev.payload && ev.payload.result);
                return (rp && (rp.error || rp.status === 'error' || rp.failed)) ? 0 : 2;
              }
              if (ev.type === 'verification_skipped' || ev.type === 'phase') return 3;
              if (ev.type === 'tool_call') return 4;
              if (ev.type === 'tool_diff') return 5;
              return 6;
            };
            const lineOf = (ev) => {
              const pl = ev.payload || {};
              if (ev.type === 'tool_call') {
                const argText = JSON.stringify(pl.args || {});
                return '[工具] ' + pl.name + ' ' + argText.slice(0, 300);
              }
              if (ev.type === 'tool_result') {
                const rp = pl.result;
                const rtxt = (rp && typeof rp === 'object') ? (rp.summary || (rp.error && rp.error.message) || '') : String(rp || '');
                return '→ 结果(' + (pl.name || '') + '): ' + rtxt.slice(0, TRACE_PER_RESULT);
              }
              if (ev.type === 'tool_diff') return '[Diff] ' + (pl.path || '');
              if (ev.type === 'error') return '[错误] ' + String(pl.message || ev.message || '').slice(0, TRACE_PER_RESULT);
              if (ev.type === 'convergence_notice') return '[收敛] ' + String(pl.text || pl.message || '').slice(0, 300);
              if (ev.type === 'blocked' || ev.type === 'gate_blocked') return '[受阻] ' + String(pl.reason || pl.message || '').slice(0, 300);
              if (ev.type === 'phase') return '[阶段] ' + String(pl.phase || pl.name || '');
              if (ev.type === 'verification_skipped') return '[验证跳过] ' + String(pl.reason || '');
              return null;
            };
            const changedFiles = [];
            const ranked = [];
            for (const ev of freshEvents) {
              const ln = lineOf(ev);
              if (ln) { ranked.push({ s: scoreOf(ev), t: ln }); if (ev.type === 'tool_diff' && ev.payload && ev.payload.path) changedFiles.push(String(ev.payload.path)); }
            }
            ranked.sort((a, b) => a.s - b.s);
            // 头部：run 元信息（目标/阶段/状态）
            let body = 'Run #' + String(runMeta.id || '').slice(0, 8)
              + ' 状态:' + (runMeta.status || '') + (runMeta.phase ? ' 阶段:' + runMeta.phase : '')
              + (runMeta.userGoal ? ' 目标:' + String(runMeta.userGoal).slice(0, 200) : '');
            let hasBody = false;
            for (const it of ranked) {
              const add = (body ? '\n' : '') + it.t;
              if (body.length + add.length > TRACE_TOTAL) break;
              body += add; hasBody = true;
            }
            const filesLine = changedFiles.length ? '\n[变更文件] ' + Array.from(new Set(changedFiles)).slice(0, 30).join(', ') : '';
            if (body.length + filesLine.length <= TRACE_TOTAL) body += filesLine;
            if (hasBody || changedFiles.length) traceMsg = { role: 'user', content: '【上一轮执行轨迹】\n' + body };
          }
        }
      } catch (_) {}
      let compact = App.context.getCompactMessages({
        messages: msgList,
        summary: thread.summary || '',
        summaryCount: thread.summaryCount || 0,
        recentKeep: App.context.RECENT_KEEP_AGENT,
        systemContent: agentSys,
        util: App.context.COMPACT_UTIL_AGENT,
        toolReserve: App.context.AGENT_TOOL_RESERVE || 0, // v2（P1-D）：工具输出/最终回答预留
        window: ctxWindow,
      });
      // M2：三段阈值——紧急保护只发摘要+最近问题；硬压缩无摘要时同步生成
      const usageTokens = App.context.messagesTokens(msgList) + App.context.estimateTokens(agentSys) + ((App.AgentPrompt && App.AgentPrompt.EST_SYSTEM_OVERHEAD) || 0);
      const level = App.context.agentUtilLevel(usageTokens, ctxWindow);
      let history;
      // v2（P0-1）：紧急模式——裁剪 + 请求体带 emergency 标志（后端保存 Checkpoint 并注入续跑指令）
      let emergency = false;
      if (level === 'emergency') {
        history = msgList.filter(m => m.role === 'user').slice(-2);
        emergency = true;
        App.ui.toast('上下文接近模型上限，已按紧急模式压缩（仅保留摘要与最近问题）');
      } else {
        history = compact.finalMessages.filter(m => m.role !== 'system');
      }
      const wantCompress = compact.needsCompress && compact.middleMsgs.length;
      // G4：压缩时注入系统状态参考（用户长期记忆 + 活跃 Skill 名），避免摘要脱离系统态
      const extraCtxParts = [];
      const userMemoryStr = (App.state.settings.userMemory || '').trim();
      if (userMemoryStr) extraCtxParts.push('用户长期记忆：' + userMemoryStr.slice(0, 600));
      if (selectedSkills && selectedSkills.length) extraCtxParts.push('本次激活技能：' + selectedSkills.map((s) => s && s.name).filter(Boolean).join('、'));
      const extraContext = extraCtxParts.length ? extraCtxParts.join('\n') : '';
      if (wantCompress && !thread._compressing) {
        thread._compressing = true;
        const middleForSum = traceMsg ? compact.middleMsgs.concat([traceMsg]) : compact.middleMsgs;
        if (!thread.summary) {
          // M2+G3（v1.1.0）：首次压缩（pre/hard/emergency 一致）改同步——先出摘要再发送，消除「先丢历史、下一轮才有摘要」断层
          const newSummary = await App.context.compressAsync(thread.summary || '', middleForSum, p, ctxWindow, null, extraContext).catch(() => null);
          if (newSummary) {
            thread.summary = newSummary;
            thread.summaryCount = compact.newSummaryCount;
            App.persist();
            App.agent.persistSummary(thread, newSummary, lastEventSeq || 0); // v2（P0-3）：自动压缩同步落库（v3 P3 带真实 seq）
          }
          thread._compressing = false;
          if (newSummary && level !== 'emergency') {
            const compact2 = App.context.getCompactMessages({
              messages: msgList, summary: thread.summary, summaryCount: thread.summaryCount || 0,
              recentKeep: App.context.RECENT_KEEP_AGENT, systemContent: agentSys,
              util: App.context.COMPACT_UTIL_AGENT, window: ctxWindow,
            });
            history = compact2.finalMessages.filter(m => m.role !== 'system');
          } else if (!newSummary && level !== 'emergency') {
            // G3：压缩失败回退全量发送，不丢中间段；summaryCount 保持 0 供下轮重试
            history = msgList;
          }
        } else {
          // 预压缩 / 已有摘要：后台异步生成候选摘要，结果下一轮生效
          const vCheck = () => compact.newSummaryCount === (thread.summaryCount || 0) + compact.middleMsgs.length;
          App.context.compressAsync(thread.summary || '', middleForSum, p, ctxWindow, vCheck, extraContext).then((newSummary) => {
            if (newSummary) {
              thread.summary = newSummary;
              thread.summaryCount = compact.newSummaryCount;
              App.persist();
              App.agent.persistSummary(thread, newSummary, lastEventSeq || 0); // v2（P0-3）：预压缩异步结果也落库（v3 P3 带真实 seq）
              App.agent.updateCtxBar(model);
              App.ui.toast('已自动压缩较早对话上下文');
            }
            thread._compressing = false;
          });
        }
      }
      // /context 明细：system=系统提示，history=摘要+近期对话，memory=后端注入的 userMemory
      const userMemTok = App.context.estimateTokens(App.state.settings.userMemory || '');
      const agentBd = App.context.breakdownFromFinal(compact.finalMessages, userMemTok);
      if (App.context.renderUsage) App.context.renderUsage($('agentCtxBar'), App.context.messagesTokens(compact.finalMessages) + userMemTok, ctxWindow, agentBd);

      // v1.1.0（修复）：渲染引用改为 _liveUI 单例（见事件处理）；这里保留 answerAcc 兜底（旧路径）
      let answerAcc = '';
      let aborted = false;

      const ctrl = new AbortController();
      App.agent._ctrl = ctrl;
      let requestAccepted = false;

      try {
        // 只发密钥引用；接口地址与 Key（含联网搜索 Key）都由后端从主进程密钥库取
        const res = await fetch(agentBase() + '/api/agent', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          signal: ctrl.signal,
          body: JSON.stringify({
            prompt, selectedSkills: selectedSkills.map((s) => s.name),
            cwd, workspaceId, rootScope, ref: p.ref, model, auto, planMode, history, contextWindow: ctxWindow,
            approveTools, cmdWhitelist,
            // v2（权限大改）：权限模式 + 全局规则（项目规则由后端读 <cwd>/.tangbao/permissions.json）
            permissionMode: proj.permissionMode || 'default',
            globalRules: (App.state.settings.permissionRules || []),
            threadId: thread.id, // v1.1.0（M1）：后端据此恢复上一轮 WorkingState 与摘要
            resumeRunId: App.agent._resumeRunId || '', // v2（P0-A）：从 Checkpoint 恢复（历史面板「继续该任务」）
            resumeMode: App.agent._resumeRunId ? 'checkpoint' : '', // v15（续段）：显式声明按 Checkpoint 精确恢复
            emergency, // v2（P0-1）：紧急保护——后端保存 Checkpoint + 注入续跑指令
            didCompress: wantCompress, // v2（P1-6）：压缩次数指标
            maxSteps: proj.maxSteps || 96, // v1.1.0（Fix 3）：步数上限（项目可配置）
            summary: thread.summary || '',
            userMemory: (App.state.settings.userMemory || ''),
            systemPrompt: (App.state.settings.prompts && App.state.settings.prompts.agent) || (App.AgentPrompt && App.AgentPrompt.SYSTEM_PROMPT) || '',
            thinkLevel: (App.state.settings.agentThinkLevel || 'medium'), // v1.1.0（Fix 6）：糖码独立设置
            thinkType: (App.thinkSupport(model) || 'none'),
          }),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          const errText = '后端返回错误（' + res.status + '）：' + txt.slice(0, 240);
          App.agent.setError(errText);
          App.agent.renderStatusSummary('error', { message: errText });
          if (pendingUserNode && pendingUserNode.remove) pendingUserNode.remove();
          delete thread._pendingUser;
          App.agent.clearRunState();
          App.agent.setRunning(false);
          return;
        }
        // 后端已接受运行：此时才正式消费并清空当前会话草稿。
        requestAccepted = true;
        input.value = '';
        thread.draftText = '';
        thread.draftSkills = [];
        App.agent.renderSkillChips();
        App.agent.autoSizeInput(input);
        try { App.persist(); } catch (_e) {}
        // v1.1.0（Fix 5）：后端可达则隐藏离线提示
        const offBox2 = document.getElementById('agentOffline');
        if (offBox2) offBox2.style.display = 'none';
        // v2（P0-A）：resumeRunId 已消费
        App.agent._resumeRunId = null;
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
            // 线程安全：仅当当前活跃线程仍是本任务的线程时才操作 DOM；事件始终落库（切会话不丢）
            const isActive = () => App.state.activeThreadId === thread.id;
            // v1.1.0（修复）：实时事件记录（节流持久化）——tool_call/result/thinking/message 等
            const live = thread._liveEvents;
            if (ev.type === 'thinking' || ev.type === 'tool_call' || ev.type === 'tool_result' || ev.type === 'tool_diff'
              || ev.type === 'todo_update' || ev.type === 'subagent_queued' || ev.type === 'subagent_start' || ev.type === 'subagent_result' || ev.type === 'subagent_summary' || ev.type === 'done') {
              const slim = {};
              if (ev.type === 'tool_result') {
                const rp = ev.result;
                slim.result = (rp && typeof rp === 'object')
                  ? { ok: rp.ok, summary: String(rp.summary || '').slice(0, 400), exitCode: rp.exitCode, truncated: rp.truncated }
                  : { ok: true, summary: String(rp || '').slice(0, 400) };
                slim.name = ev.name; slim.id = ev.id;
              } else if (ev.type === 'tool_call') {
                slim.name = ev.name; slim.id = ev.id; slim.args = ev.args;
              } else if (ev.type === 'thinking') { slim.text = String(ev.text || '').slice(0, 500); }
              else if (ev.type === 'todo_update') { slim.todos = (ev.todos || []).map(t => ({ content: t.content, status: t.status })); }
              else if (ev.type === 'tool_diff') { slim.id = ev.id; slim.path = ev.path; }
              else if (ev.type === 'subagent_queued') { slim.subId = ev.subId; slim.type = ev.type; slim.goal = String(ev.goal || '').slice(0, 200); }
              else if (ev.type === 'subagent_start') { slim.subId = ev.subId; slim.type = ev.type; slim.goal = String(ev.goal || '').slice(0, 200); }
              else if (ev.type === 'subagent_result') { slim.subId = ev.subId; slim.ok = ev.ok; slim.summary = String(ev.summary || '').slice(0, 300); slim.result = ev.result || null; }
              else if (ev.type === 'subagent_summary') { slim.status = ev.status; slim.aggregate = ev.aggregate || null; }
              else { Object.assign(slim, ev); }
              live.push(Object.assign({ type: ev.type, at: Date.now() }, slim));
              if (live.length > 200) live.splice(0, live.length - 200); // MAX_LIVE_EVENTS=200 裁剪
              App.agent._liveEventCount = (App.agent._liveEventCount || 0) + 1;
              App.agent.scheduleLivePersist();
            }
            if (ev.type === 'meta') { App.agent.showMeta(ev); }
            else if (ev.type === 'thinking') { if (isActive()) App.agent.appendThinking(ev.text); }
            else if (ev.type === 'tool_call') {
              // v1.1.0：运行状态——当前工具名（无条件更新，切走也刷新药丸）
              if (App.agent._runState) { App.agent._runState.toolName = String(ev.name || ''); App.agent.renderRunPill(); }
              // v2（Skill 工具权限归因 + UX）：记录最近工具调用的归因（Skill 来源/声明/哈希），审批卡展示
              App.agent._lastAttribution = ev.skillContext || null;
              // v2（UX）：统一状态摘要同步刷新
              App.agent.showStatusRunning();
              if (isActive()) {
                const block = App.agent.newToolBlock(ev.name, ev.args);
                block._callId = ev.id;
                block.dataset.callid = ev.id;
                const ui = App.agent._liveUI;
                if (ui) ui.blocks.set(ev.id, block);
              }
            }
            // v1.1.0（M7）：子代理事件
            else if (ev.type === 'subagent_queued') {
              if (isActive()) {
                const sb = App.agent.newSubagentBlock(ev);
                const ui = App.agent._liveUI;
                if (ui) ui.subagents.set(ev.subId, sb);
              }
            }
            else if (ev.type === 'subagent_start') {
              if (isActive()) {
                const sb = App.agent.newSubagentBlock(ev);
                const ui = App.agent._liveUI;
                if (ui) ui.subagents.set(ev.subId, sb);
              }
            }
            else if (ev.type === 'subagent_result') {
              if (isActive()) App.agent.setSubagentResult(ev.subId, ev);
            }
            else if (ev.type === 'subagent_summary') {
              if (isActive() && ev.status && ev.status !== 'completed') App.ui.toast('子代理协作：' + ev.status + '，请查看汇总结果');
            }
            else if (ev.type === 'require_approval') {
              // v1.1.0（M3+）：全局弹窗兜底（工具块内嵌审批框照旧，双保险保证用户一定能看到）
              if (isActive()) App.agent.showApprovalGlobal(ev.callId, ev.command, ev);
              // v1.1.0（Fix 2）：空守卫——切到空会话时 _liveUI 可能为 null，不能抛 TypeError 误判断连
              const ui = App.agent._liveUI;
              const toolBlock = (ui && ui.blocks) ? ui.blocks.get(ev.id) : null;
              if (isActive() && toolBlock) App.agent.wireApproval(toolBlock, ev.callId, ev);
            }
            // v1.1.0（M4）：phase 推进——只更新运行状态（不再覆盖 #agentStatus 连接状态）
            else if (ev.type === 'phase') {
              if (App.agent._runState && ev.phase) { App.agent._runState.phase = ev.phase; App.agent.renderRunPill(); }
              App.agent.showStatusRunning();
            }
            else if (ev.type === 'context_compacted') {
              // v2（UX）：统一状态摘要——自动压缩提示（5 秒自动隐藏）
              App.agent.showStatusCompact(ev);
            }
            else if (ev.type === 'gate_blocked') {
              if (isActive()) App.ui.toast('完成检查未通过，糖码将继续修复缺口');
            }
            // v1.1.0（优化 Plan 模式）：计划待批准 / 完成门拦截 / 用户提问卡片
            else if (ev.type === 'plan_approval_request') {
              if (isActive()) App.agent.showPlanApproval(ev);
            }
            else if (ev.type === 'plan_exit_request') {
              if (isActive()) App.agent.showPlanExit(ev);
            }
            else if (ev.type === 'user_decision_requested') {
              if (isActive()) App.agent.showDecisionCard(ev);
            }
            else if (ev.type === 'blocked') {
              if (App.agent._runState) { App.agent._runState.status = 'blocked'; App.agent.renderRunPill(); }
              // v15（单状态卡）：受阻/预算耗尽统一由一张状态卡呈现（含继续任务/复制诊断），不再额外弹接力条或重复 Toast
              App.agent.renderStatusSummary(/预算|budget/i.test(ev.reason || '') ? 'budget' : 'blocked', { reason: ev.reason });
              if (App.agent._planApproved) App.agent.resetPlanBadge();
            }
            else if (ev.type === 'memory_suggestion') {
              // v2（P2-8）：糖码提议记忆 → 确认卡片（确认后写入 糖码记忆.md）
              if (isActive()) App.agent.showMemorySuggestion(String(ev.text || ''));
            }
            else if (ev.type === 'tool_result') {
              // v1.1.0：运行状态——已执行工具数递增
              if (App.agent._runState) { App.agent._runState.step = (App.agent._runState.step || 0) + 1; App.agent.renderRunPill(); }
              App.agent.showStatusRunning();
              // v1.1.0（Fix 2）：空守卫——切到空会话时 _liveUI 可能为 null，不能抛 TypeError 误判断连
              const ui = App.agent._liveUI;
              const toolBlock = (ui && ui.blocks) ? ui.blocks.get(ev.id) : null;
              if (isActive() && toolBlock) App.agent.setToolResult(toolBlock, ev.result, '完成');
              // v1.1.0（M3）：result 已结构化——后台任务 jobId 提取需先取 summary 文本
              const rp = ev.result;
              const rText = (rp && typeof rp === 'object') ? (rp.summary || '') : String(rp || '');
              const m = rText.match(/jobId=(job_[a-z0-9]+)[）)]\s*[:：]?\s*([\s\S]*)$/);
              if (m) App.agent.labelJob(m[1], m[2]);
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
              thread._liveAnswer = (thread._liveAnswer || '') + ev.text;  // v1.1.0（修复）：落库累积（切会话不丢）
              App.agent.scheduleLivePersist();
              if (isActive()) {
                const ui = App.agent._liveUI;
                if (!ui.answerEl) ui.answerEl = App.agent.newAssistant();
                ui.answerEl.innerHTML = App.renderMarkdown(thread._liveAnswer);
                const th = document.getElementById('agentThread');
                th.scrollTop = th.scrollHeight;
              }
            }
            else if (ev.type === 'done') { if (App.agent._runState) { App.agent._runState.status = 'completed'; App.agent.renderRunPill(); } try { App.persist(); } catch (_) {} App.agent.hideStatusSummary(); const off = document.getElementById('agentOffline'); if (off) off.style.display = 'none'; if (App.agent._planApproved) App.agent.resetPlanBadge(); }
            else if (ev.type === 'error') { if (App.agent._runState) { App.agent._runState.status = 'error'; App.agent.renderRunPill(); } App.agent.renderStatusSummary('error', { message: ev.message || '未知错误' }); if (isActive()) App.agent.setError(ev.message || '未知错误'); try { App.persist(); } catch (_) {} if (App.agent._planApproved) App.agent.resetPlanBadge(); }
            else if (ev.type === 'segment_completed') {
              // v15（续段）：自动续段——状态卡原位刷新，不新增节点
              if (App.agent._runState) { App.agent._runState.segmentIndex = Number(ev.segmentIndex) || (App.agent._runState.segmentIndex || 0) + 1; App.agent.renderRunPill(); }
              App.agent.showStatusRunning();
            }
          }
        }
      } catch (e) {
        if (!requestAccepted) {
          if (pendingUserNode && pendingUserNode.remove) pendingUserNode.remove();
          delete thread._pendingUser;
          // v2（UX）：发送前失败——离线/错误统一摘要（正文与 Skill 气泡已保留，可重试）
          App.agent.renderStatusSummary('offline', { message: String(e && e.message ? e.message : e) });
          App.agent.clearRunState();
          App.agent.setRunning(false);
        }
        if (e && e.name === 'AbortError') {
          aborted = true;
          App.agent.appendThinking('已停止本次运行。');
          if (App.agent._runState) { App.agent._runState.status = 'stopped'; App.agent.renderRunPill(); }
          // v2（UX）：停止后状态卡——明确当前状态并提供继续/复制诊断
          App.agent.renderStatusSummary('blocked', { reason: '已停止本次运行（用户中断）。已保存进度，可「继续任务」接力或重新发起。' });
        } else {
          // v1.1.0（Fix 5）+ v2（补全 1）：仅网络类错误判定「无法连接」；渲染/解析等 TypeError 不再误报 offline
          const isNetwork = /fetch|network|Failed to fetch|ECONN|ECONNREFUSED|ECONNRESET/i.test(String(e && e.message ? e.message : e));
          App.agent.setError(isNetwork ? '无法连接糖码后端（' + (e.message || e) + '）。请确认后端已运行。' : ('运行中断（' + (e.message || e) + '）'));
          if (isNetwork) {
            const offline = document.getElementById('agentOffline');
            if (offline) offline.style.display = 'block';
          } else {
            console.error('[糖码] SSE 处理异常：', e);
          }
        }
        // B5（P2）：请求已接受后流异常中断（解析/网络/中断）——补清理运行标记，避免 _running/_runState 残留（药丸/按钮卡死）
        if (requestAccepted) {
          try {
            App.agent.clearRunState();
            App.agent.setRunning(false);
            App.agent._ctrl = null;
            if (App.agent._runPillTimer) { clearInterval(App.agent._runPillTimer); App.agent._runPillTimer = null; }
            if (thread) { thread._running = false; thread._liveEvents = []; thread._liveAnswer = ''; }
            App.agent._liveUI = null;
          } catch (_) {}
        }
      }

      if (!requestAccepted) return;
      const ui = App.agent._liveUI;
      if (ui && ui.answerEl && thread._liveAnswer) {
        App.agent.addCrossActions(ui.answerEl.parentElement, thread._liveAnswer);
      }
      // v1.1.0（修复）：无条件保存已生成回答（中断也保留），并清理 live 状态
      App.agent.finish(thread, prompt, thread._liveAnswer || answerAcc || '', selectedSkills);
      thread._liveEvents = [];
      thread._liveAnswer = '';
      App.agent._liveUI = null;
      try { App.persist(); } catch (_) {}
    },

    // v1.1.0：全局运行状态药丸——渲染（由 _runState 驱动，1s 定时器补耗时）

    // v1.1.0：清空全局运行状态（任务结束统一收敛点）

    /* ===== v2（UX）：统一状态摘要条——默认一行当前状态，异常时展开下一步动作 ===== */
    hideStatusSummary() {
      const box = document.getElementById('agentStatusSummary');
      if (box) { box.hidden = true; box.innerHTML = ''; }
    },
    // 继续上次任务：携带来源 Run 精确恢复（历史面板/状态卡/接力条统一入口）
    // 兼容旧调用（状态卡 continue 按钮）；统一走 resumeRun
    // 复制诊断信息（错误/受阻原因 + 运行状态 JSON）
    copyStatusDiagnostics(extra) {
      const rs = App.agent._runState || {};
      const text = [
        extra && extra.title ? extra.title : '',
        extra && extra.message ? extra.message : '',
        '--- 运行状态 ---',
        JSON.stringify({ threadId: rs.threadId, runId: rs.runId, phase: rs.phase, toolName: rs.toolName, step: rs.step, status: rs.status, goal: rs.goal, startedAt: rs.startedAt }, null, 2),
      ].filter(Boolean).join('\n');
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
        .then(() => App.ui.toast('诊断信息已复制'))
        .catch(() => { try { window.prompt('复制以下诊断信息：', text); } catch (_e) {} });
    },
    // 统一渲染：mode = running | blocked | budget | error | offline | compact
    // 运行中：一行式实时状态（由 phase / tool_call / tool_result / segment 事件驱动，原位刷新同一张卡）
    // 上下文压缩：短暂提示，5 秒自动隐藏（用户也可手动关闭）

    // v1.1.0：点击药丸跳回运行中的会话
    jumpToRunThread() {
      const rs = App.agent._runState;
      if (!rs) return;
       try { if (App.router && App.router.go) App.router.go('agent', { force: true }); } catch (e) {}
      const curProj = App.state.activeProjectId;
      const curThr = App.state.activeThreadId;
      if (rs.projectId && rs.projectId !== curProj) { App.agent.switchProject(rs.projectId); return; }
      if (rs.threadId && rs.threadId !== curThr) App.agent.switchThread(rs.threadId);
    },

    finish(thread, prompt, answerAcc, skills) {
      thread._running = false; // v1.1.0（修复）：任务结束清除运行标记
      App.agent.clearRunState(); // v1.1.0：任务结束清空全局运行状态（顶栏药丸消失）
      thread.history.push({ role: 'user', content: prompt, skills: Array.isArray(skills) ? skills : [] });
      if (answerAcc) thread.history.push({ role: 'assistant', content: answerAcc });
      delete thread._pendingUser; // v1.1.0（修复）：已落库，重建不再补渲染（防重复）
      // 超出硬上限时裁剪，并同步前移摘要偏移（摘要文本保留，仍承载更早内容）
      if (thread.history.length > MAX_THREAD_HISTORY) {
        const dropped = thread.history.length - MAX_THREAD_HISTORY;
        thread.history = thread.history.slice(-MAX_THREAD_HISTORY);
        const sc = thread.summaryCount || 0;
        thread.summaryCount = sc > dropped ? sc - dropped : 0;
      }
      thread.updatedAt = Date.now();
      // 更新项目 lastUsedAt
      const proj = App.agent.projects().find(p => p.id === thread.projectId);
      if (proj) proj.lastUsedAt = Date.now();
      App.persist();
      App.agent.renderProjects();
      App.agent.renderSessions();
      App.agent._ctrl = null;
      App.agent.hideMeta();
      App.agent.setRunning(false);
      App.agent.renderEngineStrip();
      App.agent.refreshEngineStrip();
    },

    // 手动压缩当前会话上下文：整段生成摘要并持久化，保留全部 UI 历史
    async compactNow(focus) {
      const thread = App.agent.activeThread();
      if (!thread || !thread.history.length) { App.ui.toast('当前没有可压缩的对话'); return; }
      const p = App.getProvider('agent');
      if (!p.ref || !p.hasKey || !p.model) { App.ui.toast('请先配置糖码 API'); return; }
      App.ui.toast('正在压缩上下文…');
      // v3（P3）：手动压缩同样记录真实事件 seq（覆盖到全部事件）
      let lastSeq = 0;
      try {
        if (App.services.storage && App.services.storage.listAgentRuns) {
          const rr = await App.services.storage.listAgentRuns(thread.id, 1);
          const runs = rr && rr.ok ? rr.runs : [];
          if (runs && runs.length) {
            const er = await App.services.storage.listAgentEvents(runs[0].id);
            const evs = er && er.ok ? er.events : [];
            lastSeq = evs.length ? Math.max.apply(null, evs.map((e) => Number(e.seq) || 0)) : 0;
          }
        }
      } catch (_) {}
      const allMsgs = thread.history.map(h => ({ role: h.role, content: h.content }));
      const summary = await App.context.summarizeFull(allMsgs, focus || '', p);
      if (!summary) { App.ui.toast('压缩失败，稍后再试'); return; }
      thread.summary = summary;
      thread.summaryCount = Math.max(0, allMsgs.length - App.context.RECENT_KEEP_AGENT);
      App.persist();
      // v2（P0-3）：统一落库入口（修复：真实方法在 App.services.storage，fs 是空操作）
      App.agent.persistSummary(thread, summary, lastSeq);
      if (App.context.renderUsage) App.context.renderUsage($('agentCtxBar'), App.context.messagesTokens(allMsgs.slice(-App.context.RECENT_KEEP_AGENT)), App.context.contextWindowOf(p.model));
      App.agent.updateCtxBar();
      App.ui.toast(focus ? '已按重点压缩上下文' : '已压缩当前上下文');
    },

    // v2（P0-3）：摘要落库 SQLite（重启后后端读回注入；手动 /compact 与自动压缩共用）
    // v3（P3）：落真实事件 seq——coveredFromSeq = 上份 coveredToSeq+1，coveredToSeq = 本次覆盖最大事件 seq（无事件回退 summaryCount）
    persistSummary(thread, summary, coveredToSeq) {
      if (!thread || !summary) return;
      try {
        if (App.services.storage && App.services.storage.saveAgentSummary) {
          const from = (thread.summaryToSeq || 0) > 0 ? (thread.summaryToSeq + 1) : 0;
          const to = (coveredToSeq && coveredToSeq > 0) ? coveredToSeq : (thread.summaryCount || 0);
          App.services.storage.saveAgentSummary({
            threadId: thread.id, runId: '', coveredFromSeq: from, coveredToSeq: to,
            summary, version: (thread.summaryVersion || 0) + 1,
          });
          thread.summaryVersion = (thread.summaryVersion || 0) + 1;
          thread.summaryToSeq = to; // 已覆盖到的事件序号，后续 traceMsg 过滤不再重复
        }
      } catch (_e) {}
    },

    // 清空当前线程上下文（重置对话历史与摘要）
    clearContext() {
      const thread = App.agent.activeThread();
      if (!thread) { App.ui.toast('没有活跃线程'); return; }
      if (!thread.history || !thread.history.length) { App.ui.toast('上下文已为空'); return; }
      // 确认弹窗（防误操作）
      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.innerHTML = `
        <div class="modal modal-sm" role="dialog" aria-modal="true">
          <div class="modal-header"><span>清空上下文</span>
            <button class="icon-btn" id="clrCtxClose"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
          </div>
          <div class="modal-body"><p style="font-size:14px;line-height:1.6;color:var(--text);margin:0">清空当前线程「${App.escapeHtml(thread.title || '新会话')}」的对话历史和摘要吗？<br/><br/>此操作不可撤销，但线程本身会保留。</p></div>
          <div class="modal-footer">
            <button class="btn-ghost" id="clrCtxCancel">取消</button>
            <button class="btn-danger" id="clrCtxConfirm">清空</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      const close = () => { if (modal.parentNode) modal.remove(); };
      modal.querySelector('#clrCtxClose').addEventListener('click', close);
      modal.querySelector('#clrCtxCancel').addEventListener('click', close);
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
      modal.querySelector('#clrCtxConfirm').addEventListener('click', () => {
        close();
        App.agent.doClearThread();
      });
    },

    // v4（命令对齐）：/clear 与清空弹窗共用——直清当前线程（保留线程本身）
    doClearThread() {
      const thread = App.agent.activeThread();
      if (!thread) { App.ui.toast('没有活跃线程'); return; }
      if (!thread.history || !thread.history.length) { App.ui.toast('上下文已为空'); return; }
      thread.history = [];
      thread.summary = '';
      thread.summaryCount = 0;
      App.persist();
      App.agent.restoreThread();
      App.agent.renderProjects();
      App.agent.renderSessions();
      App.agent.updateCtxBar();
      App.ui.toast('上下文已清空');
    },

    // /memory 命令：写入用户长期记忆（userMemory），糖包与糖码共用同一份；不进入对话
    writeMemory(content) {
      if (!content) {
        const cur = (App.state.settings.userMemory || '').trim();
        App.ui.toast(cur ? ('当前用户长期记忆：\n' + cur) : '用法：/memory 要记住的内容');
        return;
      }
      const cur = (App.state.settings.userMemory || '').trim();
      const lines = cur ? cur.split('\n') : [];
      if (lines.includes(content)) { App.ui.toast('该记忆已存在'); return; }
      App.state.settings.userMemory = cur ? (cur + '\n' + content) : content;
      App.persist();
      App.agent.updateCtxBar();
      App.ui.toast('已写入用户长期记忆');
    },

    // 渲染糖码上下文用量条（显示实际发送给模型的 token 数）
    updateCtxBar(model) {
      if (!model) model = App.getProvider('agent').model || '';
      const el = $('agentCtxBar'); if (!el) return;
      const t = App.agent.activeThread();
      if (!t || !t.history) { if (el.style) el.style.display = 'none'; return; }
      if (el.style) el.style.display = '';
      const ctxWindow = App.context.contextWindowOf(model);
      const allMsgs = (t.history || []).map(h => ({ role: h.role, content: h.content }));
      const agentSys = (App.state.settings.prompts && App.state.settings.prompts.agent) || (App.AgentPrompt && App.AgentPrompt.SYSTEM_PROMPT) || '';
      const compact = App.context.getCompactMessages({
        messages: allMsgs, summary: t.summary || '', summaryCount: t.summaryCount || 0,
        recentKeep: App.context.RECENT_KEEP_AGENT, systemContent: agentSys,
        util: App.context.COMPACT_UTIL_AGENT, window: ctxWindow,
      });
      const tokens = App.context.messagesTokens(compact.finalMessages);
      const userMemTok = App.context.estimateTokens(App.state.settings.userMemory || '');
      const bd = App.context.breakdownFromFinal(compact.finalMessages, userMemTok);
      if (App.context.renderUsage) App.context.renderUsage(el, tokens + userMemTok, ctxWindow, bd);
    },

    // 项目记忆编辑器（读写 cwd/糖码记忆.md）
    async openMemoryEditor() {
      const proj = App.agent.activeProject();
      const cwd = proj.cwd || '';
      if (!cwd) { App.ui.toast('请先在项目设置中指定工作目录'); return; }
      // M7（#253）：优先用不透明 workspaceId；缺失时惰性登记，与 send() 行为一致
      const workspace = App.services.workspace && await App.services.workspace.ensureProject(proj);
      if (!workspace || !workspace.ok) {
        App.ui.toast((workspace && workspace.error) || '项目工作区已失效，请重新选择项目文件夹。');
        return;
      }
      const workspaceId = workspace.workspaceId;
      const file = '糖码记忆.md';
      let content = '';
      try {
        const j = await App.services.workspace.run(proj, async (id) => {
          const r = await fetch(agentBase() + '/api/memory?cwd=' + encodeURIComponent(cwd) + '&workspaceId=' + encodeURIComponent(id) + '&file=' + encodeURIComponent(file), { cache: 'no-store', headers: authHeaders() });
          return Object.assign({ ok: r.ok }, await r.json().catch(() => ({})));
        });
        if (j && j.ok) content = j.content || '';
        else throw new Error((j && (j.error || j.code)) || '读取项目记忆失败');
      } catch (e) {
        App.ui.toast('读取项目记忆失败：' + (e && e.message ? e.message : e));
        return;
      }
      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.innerHTML = `
        <div class="modal">
          <div class="modal-header"><span>项目记忆（${App.escapeHtml(file)}）</span>
            <button class="modal-close" id="memClose" title="关闭">×</button></div>
          <div class="modal-body">
            <p class="hint">该文件位于项目工作目录 <code>${App.escapeHtml(cwd)}</code>，会作为长期记忆注入糖码的系统提示。保存即写入磁盘。</p>
            <textarea id="memContent" class="mem-editor" rows="14" style="font-family:var(--font-mono)">${App.escapeHtml(content)}</textarea>
          </div>
          <div class="modal-footer">
            <button class="btn-ghost" id="memCancel">取消</button>
            <button class="btn-primary" id="memSave">保存</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      const close = () => modal.remove();
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
      modal.querySelector('#memClose').addEventListener('click', close);
      modal.querySelector('#memCancel').addEventListener('click', close);
      modal.querySelector('#memSave').addEventListener('click', async () => {
        const txt = modal.querySelector('#memContent').value;
        const btn = modal.querySelector('#memSave'); btn.disabled = true; btn.textContent = '保存中…';
        try {
          const j = await App.services.workspace.run(proj, async (id) => {
            const r = await fetch(agentBase() + '/api/memory', {
              method: 'PUT',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ cwd, workspaceId: id, file, content: txt }),
            });
            return Object.assign({ ok: r.ok }, await r.json().catch(() => ({})));
          });
          if (j && j.ok) App.ui.toast('项目记忆已保存');
          else App.ui.toast('保存失败：' + ((j && j.error) || '未知错误'));
        } catch (e) { App.ui.toast('保存失败：' + (e.message || e)); }
        close();
      });
    },
  };

  // 退出前强制保存当前会话（防止运行中退出丢失本轮对话）
  window.addEventListener('beforeunload', () => {
    try { if (window.App && window.App.persist) App.persist(); } catch (_) {}
  });
  // v2（补全）：窗口缩放时审批条/接力条位置跟随（不在 bind() 内，避免每 render 重复堆叠）
  window.addEventListener('resize', () => {
    try {
      if (window.App && App.agent && App.agent.updateApprovalBarPosition) App.agent.updateApprovalBarPosition();
      if (!window.App || !App.agent || !window.matchMedia) return;
      const compact = window.matchMedia('(max-width: 900px)').matches;
      if (App.agent._sidebarCompactMode === compact) return;
      App.agent._sidebarCompactMode = compact;
      App.agent._compactSidebarOpen = null;
      const section = document.querySelector('[data-view="agent"]');
      if (section && !section.hidden) App.agent.render();
    } catch (_) {}
  });
  // v1.1.0：顶栏运行状态药丸点击跳回（一次性绑定，agentView 外的常驻元素）
  try {
    const pill = document.getElementById('agentRunPill');
    if (pill) pill.addEventListener('click', () => App.agent.jumpToRunThread());
  } catch (_e) {}
})();
