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
        <div class="modal" role="dialog" aria-modal="true" style="width:660px">
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
      if (p.workspaceId && App.services.shell.getWorkspace) {
        App.services.shell.getWorkspace(p.workspaceId).then((result) => { if (result && result.ok) refreshRoots(result); else showRootError(result, '读取项目文件夹失败，请重新打开项目设置。'); }).catch((error) => showRootError({ ok: false, code: 'ipc_failed', error: error && error.message }, '读取项目文件夹失败，请重新打开项目设置。'));
      }
      const browse = modal.querySelector('#projBrowse');
      if (browse) browse.onclick = async () => {
        browse.disabled = true;
        showRootError({ ok: true });
        try {
          const result = p.workspaceId ? await App.services.shell.addWorkspaceRoot(p.workspaceId) : await App.services.shell.showDirDialog();
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
        if (event.target.closest('[data-root-primary]')) result = await App.services.shell.setPrimaryWorkspaceRoot(p.workspaceId, rootId);
        else if (event.target.closest('[data-root-rename]')) { const name = window.prompt('文件夹显示名称', (p.roots.find((root) => root.rootId === rootId) || {}).name || ''); if (name) result = await App.services.shell.renameWorkspaceRoot(p.workspaceId, rootId, name); }
        else if (event.target.closest('[data-root-remove]')) { if (!window.confirm('移除该文件夹？正在运行的任务可能因此无法恢复。')) return; result = await App.services.shell.removeWorkspaceRoot(p.workspaceId, rootId); }
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
        if (!p.workspaceId && p.cwd) {
          try {
            const r = await App.services.shell.registerWorkspace(p.cwd, p.name);
            if (r && r.ok) { p.workspaceId = r.workspaceId; p.cwd = r.cwd || p.cwd; p.primaryRootId = r.primaryRootId || p.primaryRootId; p.roots = r.roots || p.roots; } else p.workspaceId = '';
          } catch (e) { p.workspaceId = ''; }
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
    render() {
      const wrap = document.getElementById('agentView');
      if (!wrap) return;
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
      // v1.1.0（回退）：恢复两栏折叠状态（旧字段）
      const projCollapsed = !!App.state.agentProjectsCollapsed;
      const sessCollapsed = !!App.state.agentSessionsCollapsed;

      wrap.innerHTML = `
        <div class="agent-layout">
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
      // v1.1.0（回退）：两栏折叠/展开（横排 tab 各展开对应栏）
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

    createUserMessage(text, skills) {
      const node = document.createElement('div');
      node.className = 'agent-msg user';
      const safeSkills = Array.isArray(skills) ? skills.filter((s) => s && s.name) : [];
      const tags = safeSkills.length
        ? '<div class="agent-message-skills">' + safeSkills.map((s) => '<span class="agent-message-skill"><span>✦</span>' + App.escapeHtml(s.name) + '</span>').join('') + '</div>'
        : '';
      node.innerHTML = tags + '<div class="agent-message-text">' + App.escapeHtml(text || '') + '</div>';
      return node;
    },

    appendUser(text, skills) {
      const thread = document.getElementById('agentThread');
      const empty = thread.querySelector('.agent-empty'); if (empty) empty.remove();
      const node = App.agent.createUserMessage(text, skills);
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
          <span class="agent-tool-ico">⚙</span>
          <span class="agent-tool-name">${App.escapeHtml(name)}</span>
          <span class="agent-tool-status">⏳ 运行中…</span>
          <button class="agent-tool-toggle">▾</button>
        </div>
        <div class="agent-tool-body">
          ${argStr ? `<pre class="agent-tool-args">${App.escapeHtml(argStr)}</pre>` : ''}
          <pre class="agent-tool-out">等待执行…</pre>
          <div class="agent-approve" style="display:none">
            <div class="agent-approve-diff" style="display:none"></div>
            <span class="agent-approve-tip">该操作需要你的批准：</span>
            <div class="agent-approve-ops">
              <button class="btn-primary mini" data-ap="allow_once">批准</button>
              <button class="btn-ghost mini" data-ap="allow_run">本任务免问</button>
              <button class="btn-ghost mini danger" data-ap="reject_reason">拒绝并说明</button>
              <button class="btn-ghost mini danger" data-ap="reject">拒绝</button>
            </div>
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
      // v1.1.0（M3）：结构化 ToolResult——用 ok/truncated/exitCode 判定，不再正则粗判
      const isObj = result && typeof result === 'object';
      const ok = isObj ? result.ok !== false : true;
      const truncated = isObj ? !!result.truncated : false;
      const exitCode = isObj && result.exitCode != null ? result.exitCode : null;
      const text = isObj ? (result.summary || (result.error && result.error.message) || '(空)') : (result || '(空)');
      if (out) out.textContent = text + (truncated ? '\n[输出已截断]' : '') + (exitCode != null ? '\n[退出码 ' + exitCode + ']' : '');
      const st = block.querySelector('.agent-tool-status');
      if (st) {
        const elapsed = block._startTime ? ((Date.now() - block._startTime) / 1000).toFixed(1) + 's' : '';
        st.textContent = (statusText || '完成') + (elapsed ? ' (' + elapsed + ')' : '');
        st.title = (ok ? '✅' : '❌') + ' ' + st.textContent;
      }
      const ico = block.querySelector('.agent-tool-ico');
      if (ico) ico.textContent = ok ? '✅' : '❌';
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
    showApprovalGlobal(callId, command, extra) {
      App.agent._uxTrack('approval');
      const old = document.getElementById('agentApprovalBar');
      if (old) old.remove();
      const bar = document.createElement('div');
      bar.className = 'agent-approval-bar';
      bar.id = 'agentApprovalBar';
      const diffs = (extra && Array.isArray(extra.diffs) && extra.diffs.length) ? extra.diffs : null;
      const diffHtml = diffs ? diffs.map((d) => `
          <div class="agent-approval-diff-file">${App.escapeHtml(d.path)}</div>
          <div class="agent-diff">${(d.diff || []).map((ln) => {
            const sign = ln.type === '+' ? '+' : (ln.type === '-' ? '-' : ' ');
            const cls = ln.type === '+' ? 'add' : (ln.type === '-' ? 'del' : 'ctx');
            return `<div class="agent-diff-line ${cls}">${sign} ${App.escapeHtml(ln.text)}</div>`;
          }).join('')}</div>`).join('') : '';
      // v2（UX）：影响文件与 Skill 来源上下文（渐进披露：默认一行，可展开）
      const toolLabel = (extra && extra.toolName) ? '<span class="agent-approval-bar-tag">' + App.escapeHtml(String(extra.toolName).replace(/_/g, ' ')) + '</span>' : '';
      const fileHint = (extra && (extra.filePath || extra.extraPath))
        ? '<div class="agent-approval-bar-meta">影响文件：<code>' + App.escapeHtml(String(extra.filePath || extra.extraPath)) + '</code></div>' : '';
      const attr = App.agent._lastAttribution;
      let attrHtml = '';
      if (attr && (attr.activeSkills || []).length) {
        const skillNames = attr.activeSkills.map((n) => App.escapeHtml(n)).join('、');
        const modeLabel = attr.allowedBy && attr.allowedBy.length ? '（声明允许）' : '（未声明此工具）';
        const hashInfo = (attr.allowedBy && attr.allowedBy.length && attr.activeSkills.length)
          ? ' · 包哈希 ' + App.escapeHtml(String(attr.packageHash || '').slice(0, 8)) : '';
        attrHtml = '<div class="agent-approval-bar-meta">Skill 来源：<code>' + skillNames + '</code>' + modeLabel + hashInfo + '</div>';
      }
      bar.innerHTML = `
        <div class="agent-approval-bar-main">
          ${toolLabel}
          <span class="agent-approval-bar-tag">审批</span>
          <span class="agent-approval-bar-cmd" title="${App.escapeHtml(String(command || ''))}">${App.escapeHtml(String(command || '该操作需要你的批准').slice(0, 140))}</span>
          ${diffs ? '<button class="agent-approval-bar-toggle" type="button">查看变更</button>' : ''}
        </div>
        ${fileHint}
        ${attrHtml}
        ${diffs ? `<div class="agent-approval-bar-diff" style="display:none">${diffHtml}</div>` : ''}
        <div class="agent-approval-bar-ops">
          <button class="btn-primary mini" data-ap="allow_once" title="仅批准本次操作">批准</button>
          <button class="btn-ghost mini" data-ap="allow_run" title="本次任务内不再逐次询问">本任务免问</button>
          ${App.agent.activeProject() && App.agent.activeProject().cwd
            ? '<button class="btn-ghost mini" data-ap="allow_rule" title="写入项目权限规则：该工具/命令总是允许（保存到 .tangbao/permissions.json）">总是允许</button>' +
              '<button class="btn-ghost mini danger" data-ap="reject_rule" title="写入项目权限规则：该工具/命令总是拒绝">总是拒绝</button>'
            : ''}
          <button class="btn-ghost mini danger" data-ap="reject_reason" title="拒绝并填写原因，帮助糖码调整方案">拒绝并说明</button>
          <button class="btn-ghost mini danger" data-ap="reject">拒绝</button>
        </div>`;
      document.body.appendChild(bar);
      // v2（补全）：动态 bottom——悬浮于输入区上方，不遮输入
      App.agent.updateApprovalBarPosition();
      const toggle = bar.querySelector('.agent-approval-bar-toggle');
      if (toggle) toggle.addEventListener('click', () => {
        const d = bar.querySelector('.agent-approval-bar-diff');
        if (d) {
          const show = d.style.display !== 'block';
          d.style.display = show ? 'block' : 'none';
          toggle.textContent = show ? '收起变更' : '查看变更';
        }
      });
      bar.querySelectorAll('button[data-ap]').forEach((b) => {
        b.addEventListener('click', async () => {
          const decision = b.dataset.ap;
          let reason = '';
          // v2（UX）：拒绝并说明原因——先收集原因再提交
          if (decision === 'reject_reason') {
            reason = (window.prompt('拒绝原因（可选，将帮助糖码调整方案）：', '') || '').trim();
            if (!reason) { App.ui.toast('已按「拒绝」处理（未填写原因）'); }
          }
          bar.remove();
          // v2（权限大改）+G17（B1）：总是允许/总是拒绝/本任务免问——写项目规则（<cwd>/.tangbao/permissions.json）并即时生效
          if (decision === 'allow_rule' || decision === 'reject_rule' || decision === 'allow_run') {
            const proj = App.agent.activeProject();
            const tool = (extra && extra.toolName) ? extra.toolName : 'run_command';
            const pattern = (tool === 'run_command' || tool === 'git_command') ? String(command || '') : '';
            if (proj && proj.cwd) {
              const rule = { id: App.uid(), tool, pattern, path: '', allow: decision !== 'reject_rule', force: false, scope: 'project' };
              const rules = [].concat(Array.isArray(proj.permissionRules) ? proj.permissionRules : [], [rule]);
              try {
                await fetch(agentBase() + '/api/permissions', {
                  method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/json' }),
                  body: JSON.stringify({ cwd: proj.cwd, workspaceId: proj.workspaceId, rules }),
                });
                proj.permissionRules = rules;
                App.persist();
                App.ui.toast(decision === 'reject_rule' ? '已写入「总是拒绝」规则' : (decision === 'allow_run' ? '已写入「总是允许」规则（本任务免问）' : '已写入「总是允许」规则（下次运行生效）'));
              } catch (e) { App.ui.toast('规则写入失败：' + (e.message || e)); }
            }
          }
          await App.agent.approveRequest(callId, decision === 'reject_reason' ? 'reject' : decision, reason, decision === 'allow_run');
        });
      });
    },

    async approveRequest(callId, decision, reason, persistRule) {
      try {
        await fetch(agentBase() + '/api/agent/approve', {
          method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ callId, approved: decision !== 'reject', decision, reason: reason || '', persistRule: !!persistRule }),
        });
      } catch (e) {}
    },

    // v2（P2-8）：糖码记忆确认卡片——确认后写入项目 糖码记忆.md（未确认不落盘）
    showMemorySuggestion(text) {
      if (!text) return;
      const old = document.getElementById('agentMemCard');
      if (old) old.remove();
      const proj = App.agent.activeProject();
      const card = document.createElement('div');
      card.id = 'agentMemCard';
      card.className = 'agent-mem-card';
      card.innerHTML = `
        <div class="agent-mem-card-title">糖码建议记忆</div>
        <div class="agent-mem-card-text">${App.escapeHtml(text)}</div>
        <div class="agent-mem-card-ops">
          <button class="btn-primary mini" id="memConfirm">确认写入</button>
          <button class="btn-ghost mini" id="memIgnore">忽略</button>
        </div>`;
      document.body.appendChild(card);
      const close = () => card.remove();
      card.querySelector('#memIgnore').onclick = close;
      card.querySelector('#memConfirm').onclick = async () => {
        close();
        if (!proj || !proj.cwd) { App.ui.toast('当前项目无工作目录，无法写入记忆'); return; }
        try {
          const b = agentBase();
          const hdrs = authHeaders({ 'Content-Type': 'application/json' });
          const cur = await fetch(b + '/api/memory?cwd=' + encodeURIComponent(proj.cwd) + '&workspaceId=' + encodeURIComponent(proj.workspaceId || ''), { headers: hdrs }).then(r => r.json()).catch(() => ({}));
          const prev = (cur && cur.content) ? String(cur.content).trim() : '';
          const next = prev ? prev + '\n\n' + text : text;
          const put = await fetch(b + '/api/memory', { method: 'PUT', headers: hdrs, body: JSON.stringify({ cwd: proj.cwd, workspaceId: proj.workspaceId, content: next }) }).then(r => r.json()).catch(() => ({}));
          App.ui.toast((put && put.ok) ? '记忆已写入 糖码记忆.md（下次运行生效）' : '记忆写入失败');
        } catch (e) { App.ui.toast('记忆写入失败：' + (e.message || e)); }
      };
    },

    wireApproval(block, callId, extra) {
      App.agent._uxTrack('approveInline');
      const box = block.querySelector('.agent-approve');
      if (!box) return;
      // v1.1.0（M3）：写前 Diff 预览（apply_patch 审批时后端随事件下发 diffs）
      const diffBox = box.querySelector('.agent-approve-diff');
      if (diffBox && extra && Array.isArray(extra.diffs) && extra.diffs.length) {
        diffBox.style.display = 'block';
        diffBox.innerHTML = extra.diffs.map((d) => `
          <div class="agent-approve-diff-file">${App.escapeHtml(d.path)}</div>
          <div class="agent-diff">${(d.diff || []).map((ln) => {
            const sign = ln.type === '+' ? '+' : (ln.type === '-' ? '-' : ' ');
            const cls = ln.type === '+' ? 'add' : (ln.type === '-' ? 'del' : 'ctx');
            return `<div class="agent-diff-line ${cls}">${sign} ${App.escapeHtml(ln.text)}</div>`;
          }).join('')}</div>`).join('');
      }
      box.style.display = 'flex';
      box.querySelectorAll('button[data-ap]').forEach(b => {
        b.addEventListener('click', async () => {
          let decision = b.dataset.ap;
          let reason = '';
          if (decision === 'reject_reason') {
            reason = (window.prompt('拒绝原因（可选，将帮助糖码调整方案）：', '') || '').trim();
            if (!reason) { App.ui.toast('已按「拒绝」处理（未填写原因）'); }
            decision = 'reject';
          }
          const approved = decision !== 'reject';
          box.style.display = 'none';
          const st = block.querySelector('.agent-tool-status');
          if (st) st.textContent = approved ? '已批准，执行中…' : ('已拒绝' + (reason ? '：' + reason.slice(0, 60) : ''));
          try {
            await fetch(agentBase() + '/api/agent/approve', {
              method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ callId, approved, decision, reason: reason || '' }),
            });
          } catch (e) {}
        });
      });
    },

    // ===== v1.1.0（优化 Plan 模式）：计划待批准 / 完成门拦截 / 用户提问 三张卡片 =====
    setPlanBadge(text) {
      const badge = document.getElementById('agentPlanBadge');
      if (badge) { badge.textContent = 'Plan ' + (text || '可执行'); badge.className = 'agent-status plan-badge on'; }
    },
    resetPlanBadge() {
      App.agent._planApproved = false;
      const proj = App.agent.activeProject();
      const badge = document.getElementById('agentPlanBadge');
      if (badge && proj) {
        badge.textContent = 'Plan ' + (proj.planMode ? '只读探索' : '可执行');
        badge.className = 'agent-status plan-badge ' + (proj.planMode ? 'on' : 'off');
      }
    },
    removeCard(id) {
      const card = document.getElementById(id);
      if (card) card.remove();
    },
    showPlanApproval(ev) {
      App.agent.removeCard('agentPlanApprove');
      const thread = document.getElementById('agentThread');
      if (!thread) return;
      const card = document.createElement('div');
      card.id = 'agentPlanApprove';
      card.className = 'agent-plan-approve';
      const items = (ev && Array.isArray(ev.todos) && ev.todos.length)
        ? ev.todos.map((t) => '<div class="agent-plan-item">' + App.escapeHtml(String((t && t.content) || '')) + '</div>').join('')
        : '<div class="agent-plan-item">（模型尚未产出任务清单，批准后将直接进入执行模式）</div>';
      card.innerHTML = `
        <div class="agent-plan-title">📋 计划待批准</div>
        <div class="agent-plan-sub">模型将执行以下任务，批准后自动切换到执行模式：</div>
        <div class="agent-plan-list">${items}</div>
        <div class="agent-plan-ops">
          <button class="btn-primary mini" data-pa="approve">批准请求</button>
          <button class="btn-ghost mini" data-pa="reject">调整计划</button>
        </div>`;
      thread.appendChild(card);
      thread.scrollTop = thread.scrollHeight;
      card.querySelectorAll('[data-pa]').forEach((b) => b.addEventListener('click', () => {
        const callId = ev && ev.callId;
        if (!callId) return;
        const decision = b.dataset.pa === 'approve' ? 'allow_run' : 'reject';
        App.agent.approveRequest(callId, decision, '', false);
        App.agent.removeCard('agentPlanApprove');
        App.ui.toast(decision === 'allow_run' ? '已批准计划，模型开始执行' : '已通知模型调整计划');
      }));
    },
    showPlanExit(ev) {
      App.agent.removeCard('agentPlanExit');
      const thread = document.getElementById('agentThread');
      if (!thread) return;
      const card = document.createElement('div');
      card.id = 'agentPlanExit';
      card.className = 'agent-plan-approve';
      card.innerHTML = `
        <div class="agent-plan-title">⚠️ 完成门拦截</div>
        <div class="agent-plan-sub">任务持续无进展，仍处于 Plan 只读模式。可退出计划模式继续修复，或调整方案。</div>
        <div class="agent-plan-ops">
          <button class="btn-primary mini" data-pe="1">退出计划模式并继续修复</button>
          <button class="btn-ghost mini" data-pe="0">暂不退出</button>
        </div>`;
      thread.appendChild(card);
      thread.scrollTop = thread.scrollHeight;
      card.querySelectorAll('[data-pe]').forEach((b) => b.addEventListener('click', () => {
        const callId = ev && ev.callId;
        const exit = b.dataset.pe === '1';
        if (callId) App.agent.approveRequest(callId, exit ? 'allow_run' : 'reject', '', false);
        App.agent.removeCard('agentPlanExit');
        App.ui.toast(exit ? '已退出计划模式，继续修复' : '保持计划模式');
      }));
    },
    async submitDecision(id, multiSelect) {
      const card = document.getElementById('agentDecision');
      if (!card || !id) return;
      const sel = Array.from(card.querySelectorAll('input[data-opt]:checked')).map((i) => i.value);
      const customEl = card.querySelector('[data-custom]');
      const custom = customEl ? customEl.value.trim() : '';
      let answer;
      if (multiSelect) {
        answer = custom ? sel.concat(custom) : sel;
      } else {
        answer = custom || (sel.length ? sel[0] : '');
      }
      if (multiSelect && !answer.length) { App.ui.toast('请至少选择一项或填写自定义答案'); return; }
      try {
        await fetch(agentBase() + '/api/agent/decision', {
          method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ id, answer }),
        });
      } catch (e) {}
      App.agent.removeCard('agentDecision');
      App.ui.toast('已提交答复');
    },
    showDecisionCard(ev) {
      App.agent.removeCard('agentDecision');
      const thread = document.getElementById('agentThread');
      if (!thread) return;
      const multiSelect = !!(ev && ev.multiSelect);
      const opts = (ev && Array.isArray(ev.options) && ev.options.length) ? ev.options : [];
      const card = document.createElement('div');
      card.id = 'agentDecision';
      card.className = 'agent-decision';
      const optHtml = opts.length
        ? opts.map((o) => `
            <label class="agent-decision-opt">
              <input type="${multiSelect ? 'checkbox' : 'radio'}" name="agentDecisionOpt" data-opt="1" value="${App.escapeHtml(String(o))}">
              <span>${App.escapeHtml(String(o))}</span>
            </label>`).join('')
        : '';
      card.innerHTML = `
        <div class="agent-decision-title">❓ ${App.escapeHtml(String((ev && ev.question) || '请确认'))}</div>
        ${ev && ev.context ? `<div class="agent-decision-ctx">${App.escapeHtml(String(ev.context))}</div>` : ''}
        ${optHtml ? `<div class="agent-decision-opts">${optHtml}</div>` : ''}
        <div class="agent-decision-custom"><input data-custom="1" type="text" placeholder="${multiSelect ? '自定义补充（可选，追加到选择）' : '自定义答案（输入后优先采用）'}"></div>
        <div class="agent-decision-ops"><button class="btn-primary mini" data-decision-submit="1">提交答复</button></div>`;
      thread.appendChild(card);
      thread.scrollTop = thread.scrollHeight;
      const btn = card.querySelector('[data-decision-submit]');
      if (btn) btn.addEventListener('click', () => App.agent.submitDecision(ev && ev.id, multiSelect));
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
        <div class="modal" role="dialog" aria-modal="true" style="width:580px">
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

    // ===== v1.1.0（M1）：运行历史面板（仿糖创工作流历史）=====
    async showRunHistory(options) {
      const thread = App.agent.activeThread();
      if (!thread) return;
      let autoOpenRunId = options && options.openRunId ? String(options.openRunId) : '';
      const PAGE_SIZE = 30;
      let runs = [];
      let hasMore = true;
      let loadingPage = false;
      // 先显示弹窗与加载态，再异步查询历史，避免点击后等待 IPC 才出现视觉反馈。
      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.id = 'agentHistMask';
      modal.innerHTML = `
        <div class="modal agent-modal" role="dialog" aria-modal="true">
          <div class="modal-header"><span>运行历史：${App.escapeHtml(thread.title || '糖码会话')}</span>
            <button class="icon-btn" id="agentHistClose" aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modal-body">
            <div class="agent-hist-tools">
              <input id="agentHistSearch" type="text" placeholder="搜索目标关键词…" aria-label="搜索运行目标" />
              <select id="agentHistStatus" aria-label="按状态筛选">
                <option value="">全部状态</option>
                <option value="completed">已完成</option>
                <option value="failed">失败</option>
                <option value="stopped">已停止</option>
                <option value="blocked">受阻</option>
                <option value="budget_exhausted">预算耗尽</option>
                <option value="running">运行中</option>
              </select>
              <span class="agent-hist-count" id="agentHistCount"></span>
            </div>
            <div class="wf-run" id="agentHistList" tabindex="0" aria-label="运行历史列表"><div class="wf-step-out">正在加载运行历史…</div></div>
          </div>
          <div class="modal-footer"><span class="agent-hist-ux" id="agentHistUx"></span><button class="btn-ghost" id="agentHistOk">关闭</button></div>
        </div>`;
      document.body.appendChild(modal);
      const box = modal.querySelector('#agentHistList');
      const close = () => modal.remove();
      modal.querySelector('#agentHistClose').addEventListener('click', close);
      modal.querySelector('#agentHistOk').addEventListener('click', close);
      modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
      // v2（可访问性）：ESC 关闭 + 打开后聚焦搜索框
      modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
      const histSearch = modal.querySelector('#agentHistSearch');
      if (histSearch) histSearch.focus();
      // v2（UX 指标）：展示本机累计交互统计（不采集内容）
      App.agent._uxTrack('history');
      const uxBox = modal.querySelector('#agentHistUx');
      if (uxBox) {
        const ux = App.agent._uxStats();
        const label = (k, v) => ({ template: '模板', inlineCheck: '就地校验', status: '状态条', approval: '审批', approveInline: '内联审批', diagnose: '复制诊断', history: '历史' }[k] || k) + ' ' + v;
        const parts = Object.keys(ux).filter((k) => ux[k] > 0).map((k) => label(k, ux[k]));
        uxBox.textContent = parts.length ? 'UX 统计：' + parts.join(' · ') : 'UX 统计：暂无';
      }
      const loadPage = async () => {
        if (loadingPage || !hasMore) return [];
        loadingPage = true;
        try {
          if (!(App.services.storage && App.services.storage.listAgentRuns)) { hasMore = false; return []; }
          const r = await App.services.storage.listAgentRuns(thread.id, PAGE_SIZE, runs.length);
          const page = (r && r.ok && Array.isArray(r.runs)) ? r.runs : [];
          const known = new Set(runs.map((run) => run.id));
          page.forEach((run) => { if (run && !known.has(run.id)) runs.push(run); });
          hasMore = page.length === PAGE_SIZE;
          return page;
        } catch (_) {
          hasMore = false;
          return [];
        } finally { loadingPage = false; }
      };
      await loadPage();
      if (!runs.length) {
        box.innerHTML = '<div class="wf-step-out">暂无运行记录（每次发送任务后自动保存完整轨迹）。</div>';
        return;
      }
      const fmtTime = (ts) => ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '';
      const fmtDur = (a, b) => (a && b && b >= a) ? ((b - a) / 1000).toFixed(1) + 's' : '';
      // v2（UX）：可过滤渲染——搜索目标关键词 + 状态筛选；每次重渲染重建事件绑定
      const renderList = (list) => {
        box.innerHTML = list.map((run, ri) => {
          const u = run.usage || {};
          const badge = (run.status === 'completed' || run.status === 'done') ? '<span class="ok">完成</span>'
            : run.status === 'failed' ? '<span class="error">失败</span>'
            : run.status === 'stopped' ? '<span class="warn">已停止</span>'
            : run.status === 'blocked' ? '<span class="warn">受阻</span>'
            : run.status === 'budget_exhausted' ? '<span class="warn">预算耗尽</span>'
            : `<span class="warn">${App.escapeHtml(run.status || 'running')}</span>`;
          const phaseTag = run.phase ? ` <span class="wf-hist-phase">${App.escapeHtml(run.phase)}</span>` : '';
          const roleLabel = run.parentRunId ? ({ explore: 'Explore', test: 'Test', review: 'Review' }[run.role] || 'Child') : 'Main';
          const roleTag = ` <span class="wf-hist-phase">${roleLabel}${run.parentRunId ? ' · 只读' : ''}</span>`;
          const meta = fmtTime(run.startedAt)
            + ` · ${u.steps || 0} 步 · ${fmtDur(run.startedAt, run.finishedAt)}`
            + (u.tokens ? ` · ${Math.round(u.tokens / 1000)}k tok` : '')
            + (u.failures ? ` · ${u.failures} 次失败` : '')
            + (u.repeatedReads ? ` · 重复读 ${u.repeatedReads}` : '')
            + (u.approvals ? ` · 审批 ${u.approvals}` : '')
            + (u.compressions ? ` · 压缩 ${u.compressions}` : '')
            + (u.inputTokens ? ` · 入 ${Math.round(u.inputTokens / 1000)}k` : '')
            + (u.outputTokens ? ` / 出 ${Math.round(u.outputTokens / 1000)}k` : '')
            + (u.estimatedCost ? ` · 约 $${u.estimatedCost}` : '');
          return `<details class="wf-hist-item" data-ri="${ri}"${ri === 0 ? ' open' : ''}>
          <summary>
            <span class="wf-hist-main"><span class="wf-hist-badge">${badge}${phaseTag}${roleTag}</span><span class="wf-hist-goal">${App.escapeHtml(run.userGoal || '（未记录任务目标）')}</span></span>
            <span class="wf-hist-meta">${meta}</span>
          </summary>
          <div class="wf-hist-detail"><div class="agent-hist-events" data-run="${App.escapeHtml(run.id)}"><div class="wf-step-out">加载中…</div></div>
            <div class="agent-hist-resume">
              <button class="btn-ghost mini" data-inspector="${App.escapeHtml(run.id)}">Trace Inspector</button>
              <button class="btn-ghost mini" data-export-run="${App.escapeHtml(run.id)}">导出 JSONL</button>
              <button class="btn-ghost mini" data-diagnose="${App.escapeHtml(run.id)}">复制诊断</button>
              ${ri > 0 ? `<button class="btn-ghost mini" data-compare="${App.escapeHtml(run.id)}">对比上次</button>` : ''}
              ${run.parentRunId ? '' : `<button class="btn-ghost mini" data-resume="${App.escapeHtml(run.id)}">继续该任务</button>`}
            </div>
          </div>
        </details>`;
        }).join('') + (hasMore
          ? '<div class="agent-hist-load-more"><button class="btn-ghost" id="agentHistLoadMore">加载更多历史</button></div>'
          : '<div class="agent-hist-all-loaded">已加载全部运行历史</div>');
        const loadMoreBtn = box.querySelector('#agentHistLoadMore');
        if (loadMoreBtn) loadMoreBtn.addEventListener('click', async () => {
          loadMoreBtn.disabled = true;
          loadMoreBtn.textContent = '正在加载…';
          const page = await loadPage();
          if (!page.length && hasMore) App.ui.toast('暂时无法加载更多历史');
          applyFilter();
        });
        // 事件按需加载（展开时拉取，避免一次拉 30 个 run 的事件）
        const loadEvents = async (detailEl, runId) => {
          const holder = detailEl.querySelector('.agent-hist-events');
          if (!holder || holder.dataset.loaded) return;
          holder.dataset.loaded = '1';
          let events = [];
          try {
            if (App.services.storage && App.services.storage.listAgentEvents) {
              const r = await App.services.storage.listAgentEvents(runId);
              if (r && r.ok) events = r.events || [];
            }
          } catch (_) {}
          holder.innerHTML = App.agent.renderRunEvents(events);
        };
        box.querySelectorAll('details').forEach((d) => {
          const loadWhenOpen = () => {
            if (d.open) loadEvents(d.querySelector('.wf-hist-detail'), d.querySelector('.agent-hist-events').dataset.run);
          };
          d.addEventListener('toggle', loadWhenOpen);
          loadWhenOpen();
        });
        box.querySelectorAll('.wf-hist-detail').forEach((detail) => {
          const item = detail.closest('.wf-hist-item');
          const run = item ? list[Number(item.dataset.ri)] : null;
          if (!run || run.parentRunId) return;
          const treeButton = document.createElement('button');
          treeButton.className = 'btn-ghost mini';
          treeButton.textContent = '协作树';
          treeButton.type = 'button';
          const actions = detail.querySelector('.agent-hist-resume');
          if (actions) actions.insertBefore(treeButton, actions.firstChild);
          treeButton.addEventListener('click', async () => {
            let holder = detail.querySelector('.agent-hist-tree');
            if (!holder) { holder = document.createElement('div'); holder.className = 'agent-hist-tree'; detail.insertBefore(holder, detail.firstChild); }
            holder.innerHTML = '<div class="wf-step-out">正在加载协作树…</div>';
            try {
              const response = await (App.services.storage.getAgentRunTree ? App.services.storage.getAgentRunTree(run.id) : null);
              const tree = response && response.ok ? response.tree : null;
              if (!tree) { holder.innerHTML = '<div class="wf-step-out">暂无协作树记录。</div>'; return; }
              const nodes = [tree.root].concat(tree.children || []).filter(Boolean);
              const byParent = new Map();
              nodes.forEach((node) => {
                const parentId = String(node.run && node.run.parentRunId || '');
                if (!byParent.has(parentId)) byParent.set(parentId, []);
                byParent.get(parentId).push(node);
              });
              const renderNode = (node) => {
                const childRun = node.run || {};
                const status = childRun.status || 'running';
                const usage = childRun.usage || {};
                const descendants = (byParent.get(String(childRun.id || '')) || []).map(renderNode).join('');
                const role = childRun.parentRunId ? ({ explore: 'Explore', test: 'Test', review: 'Review' }[childRun.role] || 'Child') : 'Main';
                return `<details class="agent-hist-tree-node" ${childRun.id === tree.rootRunId ? 'open' : ''}><summary>${App.escapeHtml(role)} · ${App.escapeHtml(status)} · ${usage.steps || 0} 步 · ${App.escapeHtml(childRun.userGoal || '')}</summary><div class="agent-hist-tree-events">${App.agent.renderRunEvents(node.events || [])}</div>${descendants ? `<div class="agent-hist-tree-children">${descendants}</div>` : ''}</details>`;
              };
              const rootId = String(tree.rootRunId || '');
              const roots = nodes.filter((node) => {
                const id = String(node.run && node.run.id || '');
                const parentId = String(node.run && node.run.parentRunId || '');
                return id === rootId || !parentId || !nodes.some((candidate) => String(candidate.run && candidate.run.id || '') === parentId);
              });
              holder.innerHTML = roots.map(renderNode).join('');
            } catch (_) { holder.innerHTML = '<div class="wf-step-out">协作树加载失败。</div>'; }
          });
        });
        box.querySelectorAll('[data-export-run]').forEach((b) => {
          b.addEventListener('click', async () => {
            const r = await App.services.storage.exportAgentRun(b.dataset.exportRun || '');
            if (r && r.ok) App.ui.toast('运行轨迹已导出');
            else if (!(r && r.canceled)) App.ui.toast((r && r.error) || '导出失败');
          });
        });
        const openTraceInspector = async (run) => {
          if (!run || document.getElementById('agentTraceMask')) return;
          const traceMask = document.createElement('div');
          traceMask.className = 'modal-mask';
          traceMask.id = 'agentTraceMask';
          traceMask.innerHTML = `
            <div class="modal agent-modal agent-trace-modal" role="dialog" aria-modal="true">
              <div class="modal-header"><span>Agent Trace Inspector · ${App.escapeHtml(run.id)}</span>
                <button class="icon-btn" data-trace-close aria-label="关闭">
                  <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
                </button>
              </div>
              <div class="modal-body">
                <div class="agent-trace-summary" data-trace-metrics><div class="wf-step-out">正在加载运行指标…</div></div>
                <div class="agent-trace-tree" data-trace-tree><div class="wf-step-out">正在加载协作树…</div></div>
                <div class="agent-trace-tools">
                  <input type="text" data-trace-types placeholder="事件类型（逗号分隔）" aria-label="按事件类型筛选" />
                  <select data-trace-status aria-label="按事件状态筛选"><option value="">全部状态</option><option value="running">运行中</option><option value="completed">完成</option><option value="failed">失败</option><option value="cancelled">已取消</option></select>
                  <select data-trace-depth aria-label="按深度筛选"><option value="">全部深度</option><option value="0">根 Run</option><option value="1">深度 1</option><option value="2">深度 2</option></select>
                  <label class="agent-trace-payload"><input type="checkbox" data-trace-payload checked /> 显示事件载荷</label>
                  <button class="btn-ghost mini" data-trace-refresh>刷新</button>
                  <button class="btn-ghost mini" data-trace-export>导出脱敏 JSONL</button>
                </div>
                <div class="agent-trace-timeline" data-trace-events><div class="wf-step-out">正在加载 Trace…</div></div>
                <div class="agent-trace-more"><button class="btn-ghost" data-trace-more hidden>加载更多事件</button></div>
              </div>
              <div class="modal-footer"><span class="agent-hist-ux">只读 · 不支持重放和工具执行</span><button class="btn-ghost" data-trace-close>关闭</button></div>
            </div>`;
          document.body.appendChild(traceMask);
          const timeline = traceMask.querySelector('[data-trace-events]');
          const metricsBox = traceMask.querySelector('[data-trace-metrics]');
          const treeBox = traceMask.querySelector('[data-trace-tree]');
          const typeInput = traceMask.querySelector('[data-trace-types]');
          const statusInput = traceMask.querySelector('[data-trace-status]');
          const depthInput = traceMask.querySelector('[data-trace-depth]');
          const payloadInput = traceMask.querySelector('[data-trace-payload]');
          const moreButton = traceMask.querySelector('[data-trace-more]');
          let cursor = null;
          let hasMore = false;
          let loading = false;
          const closeTrace = () => traceMask.remove();
          traceMask.querySelectorAll('[data-trace-close]').forEach((button) => button.addEventListener('click', closeTrace));
          traceMask.addEventListener('click', (event) => { if (event.target === traceMask) closeTrace(); });
          traceMask.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeTrace(); });
          const formatMetric = (value, suffix) => value == null ? '未知' : String(value) + (suffix || '');
          const renderMetrics = (metrics) => {
            if (!metrics) { metricsBox.innerHTML = '<div class="wf-step-out">暂无运行指标</div>'; return; }
            const cache = metrics.cache || {};
            const errors = Object.entries(metrics.errorBreakdown || {}).map(([key, value]) => `${App.escapeHtml(key)} ${value}`).join(' · ') || '无';
            const hitRate = cache.hitRate == null ? '未知' : Math.round(Number(cache.hitRate) * 1000) / 10 + '%';
            metricsBox.innerHTML = `<div class="agent-trace-metric"><b>Steps</b><span>${formatMetric(metrics.steps)}</span></div><div class="agent-trace-metric"><b>Tool</b><span>${formatMetric(metrics.toolCalls)}</span></div><div class="agent-trace-metric"><b>Tokens</b><span>${formatMetric(metrics.inputTokens)} / ${formatMetric(metrics.outputTokens)}</span></div><div class="agent-trace-metric"><b>Cache</b><span>${hitRate} · 节省 ${formatMetric(cache.savedTokens)} tok</span></div><div class="agent-trace-metric"><b>Cost</b><span>${metrics.costUsd == null ? '未知' : '$' + metrics.costUsd} · 节省 ${cache.estimatedSavedCostUsd == null ? '未知' : '$' + cache.estimatedSavedCostUsd}</span></div><div class="agent-trace-metric"><b>Latency</b><span>${formatMetric(metrics.latencyMs, ' ms')} · Queue ${formatMetric(metrics.queueWaitMs, ' ms')}</span></div><div class="agent-trace-metric wide"><b>Errors</b><span>${errors}</span></div>`;
          };
          const renderTree = (tree) => {
            if (!tree || !tree.root) { treeBox.innerHTML = '<div class="wf-step-out">暂无协作树</div>'; return; }
            const nodes = [tree.root].concat(tree.children || []).filter(Boolean);
            const byParent = new Map();
            nodes.forEach((node) => { const parent = String(node.run && node.run.parentRunId || ''); if (!byParent.has(parent)) byParent.set(parent, []); byParent.get(parent).push(node); });
            const renderNode = (node) => {
              const item = node.run || {};
              const children = (byParent.get(String(item.id || '')) || []).map(renderNode).join('');
              const role = item.parentRunId ? (item.role || 'child') : 'main';
              return `<details class="agent-trace-tree-node" ${item.id === tree.rootRunId ? 'open' : ''}><summary>${App.escapeHtml(role)} · ${App.escapeHtml(item.status || 'unknown')} · ${Number(item.usage && item.usage.steps || 0)} 步</summary><div>${App.escapeHtml(item.userGoal || '')}${children ? `<div class="agent-trace-tree-children">${children}</div>` : ''}</div></details>`;
            };
            treeBox.innerHTML = `<div class="agent-trace-tree-title">协作树</div>${renderNode(tree.root)}`;
          };
          const renderEvents = (items, replace) => {
            if (replace) timeline.innerHTML = '';
            if (!items.length && replace) { timeline.innerHTML = '<div class="wf-step-out">没有匹配的事件</div>'; return; }
            const html = items.map((event) => {
              const status = event.status || (event.runStatus || 'running');
              const payload = event.payload == null ? '' : JSON.stringify(event.payload, null, 2);
              return `<article class="agent-trace-event status-${App.escapeHtml(status)}"><div class="agent-trace-event-head"><b>${App.escapeHtml(event.type || 'event')}</b><span>${App.escapeHtml(event.role || 'main')} · d${Number(event.depth || 0)} · ${event.createdAt ? new Date(event.createdAt).toLocaleTimeString('zh-CN', { hour12: false }) : ''}</span><em>${App.escapeHtml(status)}</em></div>${payloadInput.checked && payload ? `<pre>${App.escapeHtml(payload)}</pre>` : ''}</article>`;
            }).join('');
            timeline.insertAdjacentHTML('beforeend', html);
          };
          const load = async (reset) => {
            if (loading) return;
            loading = true;
            if (reset) { cursor = null; hasMore = false; timeline.innerHTML = '<div class="wf-step-out">正在加载 Trace…</div>'; }
            const types = String(typeInput.value || '').split(',').map((item) => item.trim()).filter(Boolean);
            const statuses = statusInput.value ? [statusInput.value] : [];
            const options = { rootRunId: run.id, cursor, limit: 50, types, statuses, includePayload: payloadInput.checked };
            if (depthInput.value !== '') options.depth = Number(depthInput.value);
            try {
              const response = await (App.services.storage && App.services.storage.tracePage ? App.services.storage.tracePage(options) : null);
              const page = response && response.ok !== false ? response : null;
              renderEvents(page && Array.isArray(page.items) ? page.items : [], !!reset);
              cursor = page && page.nextCursor || null;
              hasMore = !!(page && page.hasMore);
              moreButton.hidden = !hasMore;
            } catch (_) {
              if (reset) timeline.innerHTML = '<div class="wf-step-out">Trace 加载失败</div>';
              moreButton.hidden = true;
            } finally { loading = false; }
          };
          moreButton.addEventListener('click', () => load(false));
          traceMask.querySelector('[data-trace-refresh]').addEventListener('click', () => load(true));
          [typeInput, statusInput, depthInput, payloadInput].forEach((control) => control.addEventListener('change', () => load(true)));
          traceMask.querySelector('[data-trace-export]').addEventListener('click', async () => {
            const result = await (App.services.storage && App.services.storage.exportAgentTrace ? App.services.storage.exportAgentTrace({ rootRunId: run.id, redacted: true }) : null);
            if (result && result.ok) App.ui.toast('脱敏 Trace 已导出'); else if (!(result && result.canceled)) App.ui.toast((result && result.error) || '导出失败');
          });
          try {
            const [metricResponse, treeResponse] = await Promise.all([
              App.services.storage.getAgentRunMetrics ? App.services.storage.getAgentRunMetrics(run.id) : null,
              App.services.storage.getAgentRunTree ? App.services.storage.getAgentRunTree(run.id) : null,
            ]);
            renderMetrics(metricResponse && metricResponse.ok ? metricResponse.metrics : null);
            renderTree(treeResponse && treeResponse.ok ? treeResponse.tree : null);
          } catch (_) { renderMetrics(null); renderTree(null); }
          await load(true);
          typeInput.focus();
        };
        box.querySelectorAll('[data-inspector]').forEach((button) => {
          button.addEventListener('click', () => {
            const run = list.find((item) => item.id === button.dataset.inspector);
            openTraceInspector(run);
          });
        });
        if (autoOpenRunId) {
          const target = list.find((item) => item.id === autoOpenRunId);
          if (target) {
            autoOpenRunId = '';
            setTimeout(() => openTraceInspector(target), 0);
          }
        }
        // v2（UX）：统一诊断复制——run 元数据 + 事件统计 + 错误与失败清单
        box.querySelectorAll('[data-diagnose]').forEach((b) => {
          b.addEventListener('click', async () => {
            const runId = b.dataset.diagnose || '';
            const run = list.find((x) => x.id === runId);
            let events = [];
            try {
              const r = await App.services.storage.listAgentEvents(runId);
              if (r && r.ok) events = r.events || [];
            } catch (_) {}
            const u = (run && run.usage) || {};
            const errs = events.filter((e) => ['error', 'blocked', 'gate_blocked', 'budget_exhausted'].includes(e.type)).map((e) => {
              const pl = e.payload || {};
              return '[' + e.type + '] ' + (pl.message || pl.reason || (pl.names || []).join(',') || '');
            });
            const toolFails = events.filter((e) => e.type === 'tool_result' && e.payload && e.payload.result && e.payload.result.ok === false).map((e) => {
              const rp = e.payload.result;
              return (rp.error && rp.error.message) || rp.summary || '';
            });
            const lines = [
              '糖码运行诊断 ' + new Date().toISOString(),
              'run=' + runId,
              'status=' + ((run && run.status) || '?') + ' phase=' + ((run && run.phase) || '?'),
              'goal=' + ((run && run.userGoal) || '').slice(0, 200),
              'steps=' + (u.steps || 0) + ' tools=' + events.filter((e) => e.type === 'tool_call').length + ' failures=' + (u.failures || 0) + ' approvals=' + (u.approvals || 0) + ' compressions=' + (u.compressions || 0),
              'events=' + events.length,
              'errors=' + (errs.length ? '\n  - ' + errs.join('\n  - ') : '（无）'),
              'toolFailures=' + (toolFails.length ? '\n  - ' + toolFails.slice(0, 8).join('\n  - ') : '（无）'),
            ];
            const text = lines.join('\n');
            let copied = false;
            try { await navigator.clipboard.writeText(text); copied = true; } catch (_) {}
            if (!copied) {
              try {
                const ta = document.createElement('textarea');
                ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
                document.body.appendChild(ta); ta.select();
                copied = document.execCommand('copy'); ta.remove();
              } catch (_) {}
            }
            App.ui.toast(copied ? '诊断信息已复制到剪贴板' : '复制失败');
            if (copied) App.agent._uxTrack('diagnose');
          });
        });
        // v2（UX）：与上一条运行对比——状态/阶段/步骤/工具/失败/审批/耗时
        box.querySelectorAll('[data-compare]').forEach((b) => {
          b.addEventListener('click', async () => {
            const runId = b.dataset.compare || '';
            const idx = list.findIndex((x) => x.id === runId);
            if (idx <= 0) { App.ui.toast('没有更早的运行可对比'); return; }
            const prev = list[idx - 1];
            const detailEl = b.closest('.wf-hist-detail');
            const fetchEvents = async (rid) => {
              try { const r = await App.services.storage.listAgentEvents(rid); return (r && r.ok) ? (r.events || []) : []; } catch (_) { return []; }
            };
            const [curEvents, prevEvents] = await Promise.all([fetchEvents(runId), fetchEvents(prev.id)]);
            const stat = (run, events) => ({
              status: run.status || 'running', phase: run.phase || '-',
              steps: (run.usage && run.usage.steps) || 0,
              tools: events.filter((e) => e.type === 'tool_call').length,
              fails: (run.usage && run.usage.failures) || events.filter((e) => e.type === 'tool_result' && e.payload && e.payload.result && e.payload.result.ok === false).length,
              approvals: (run.usage && run.usage.approvals) || 0,
              dur: (run.startedAt && run.finishedAt && run.finishedAt >= run.startedAt) ? (((run.finishedAt - run.startedAt) / 1000).toFixed(1) + 's') : '-',
            });
            const cur = stat(list[idx], curEvents);
            const pv = stat(prev, prevEvents);
            const row = (label, va, vb) => '<div class="agent-hist-compare-row"><span>' + label + '</span><b>' + App.escapeHtml(va) + '</b><b>' + App.escapeHtml(vb) + '</b></div>';
            const html = '<div class="agent-hist-compare">'
              + '<div class="agent-hist-compare-head"><span></span><b>本次</b><b>上次</b></div>'
              + row('状态', cur.status, pv.status)
              + row('阶段', cur.phase, pv.phase)
              + row('步骤', cur.steps, pv.steps)
              + row('工具调用', cur.tools, pv.tools)
              + row('失败', cur.fails, pv.fails)
              + row('审批', cur.approvals, pv.approvals)
              + row('耗时', cur.dur, pv.dur)
              + '</div>';
            const oldBox = detailEl.querySelector('.agent-hist-compare');
            if (oldBox) oldBox.outerHTML = html;
            else detailEl.insertAdjacentHTML('afterbegin', html);
          });
        });
        // 继续：把该 run 的目标回填输入框（后端已按 threadId 自动注入上一轮状态与摘要）
        box.querySelectorAll('[data-resume]').forEach((b) => {
          b.addEventListener('click', () => {
            const run = list.find((x) => x.id === b.dataset.resume);
            const goal = (run && run.userGoal) || '';
            // v2（P0-A）：记录 runId，send 时随请求发给后端从 Checkpoint 恢复
            App.agent._resumeRunId = b.dataset.resume || '';
            close();
            const input = document.getElementById('agentInput');
            if (input) { input.value = goal; input.focus(); }
            const send = document.getElementById('agentSend');
            if (send) send.disabled = false;
            // v2（UX）：恢复预览——明确告知将从哪个 Run 的什么阶段继续
            App.agent.renderStatusSummary('blocked', { reason: '已选择从 Run ' + App.agent._resumeRunId.slice(0, 8) + '（' + ((run && run.phase) || '上一状态') + '）继续，可修改任务内容后发送。' });
          });
        });
      };
      // v2（UX）：搜索 + 状态筛选
      const searchInput = modal.querySelector('#agentHistSearch');
      const statusSel = modal.querySelector('#agentHistStatus');
      const countEl = modal.querySelector('#agentHistCount');
      const applyFilter = () => {
        const q = (searchInput.value || '').trim().toLowerCase();
        const st = statusSel.value;
        const view = runs.filter((run) => {
          if (st && run.status !== st) return false;
          if (q && !String(run.userGoal || '').toLowerCase().includes(q)) return false;
          return true;
        });
        countEl.textContent = view.length
          ? (view.length === runs.length ? '已加载 ' + runs.length + ' 条' : view.length + ' / 已加载 ' + runs.length + ' 条')
          : '无匹配';
        if (!view.length) { box.innerHTML = '<div class="wf-step-out">没有匹配的运行记录。</div>'; return; }
        renderList(view);
      };
      searchInput.addEventListener('input', applyFilter);
      statusSel.addEventListener('change', applyFilter);
      applyFilter();
    },

    // 把历史事件渲染为可读轨迹（Plan / 工具调用 / Diff / 结果 / 最终回答）
    renderRunEvents(events) {
      if (!events || !events.length) return '<div class="wf-step-out">无事件记录。</div>';
      const esc = (s) => App.escapeHtml(s == null ? '' : String(s));
      const longText = (value, limit, className) => {
        const text = value == null ? '' : String(value);
        if (text.length <= limit) return `<span class="agent-hist-text ${className || ''}">${esc(text)}</span>`;
        const summary = text.slice(0, limit).trimEnd();
        return `<details class="agent-hist-long ${className || ''}">
          <summary><span class="agent-hist-summary">${esc(summary)}…</span><span class="agent-hist-expand">展开全文</span><span class="agent-hist-collapse">收起</span></summary>
          <div class="agent-hist-full">${esc(text)}</div>
        </details>`;
      };
      const parts = [];
      let lastTool = null;
      events.forEach((ev) => {
        const pl = ev.payload || {};
        if (ev.type === 'thinking') {
          parts.push(`<div class="agent-hist-ev think"><span class="agent-hist-label">[思考]</span> ${longText(pl.text || '', 400, 'thinking-text')}</div>`);
        } else if (ev.type === 'tool_call') {
          lastTool = pl.name;
          parts.push(`<div class="agent-hist-ev tool-call"><span class="agent-hist-label">[工具]</span> <b>${esc(pl.name)}</b> ${longText(JSON.stringify(pl.args || {}, null, 2), 300, 'tool-args')}</div>`);
        } else if (ev.type === 'tool_result') {
          const rp = pl.result;
          const isObj = rp && typeof rp === 'object';
          const txt = isObj ? (rp.summary || (rp.error && rp.error.message) || '') : String(rp || '');
          const cls = isObj ? (rp.ok === false ? 'err' : 'ok') : (/失败|拒绝|错误/.test(txt.slice(0, 60)) ? 'err' : 'ok');
          const exitInfo = (isObj && rp.exitCode != null) ? '（退出码 ' + rp.exitCode + '）' : (isObj && rp.truncated ? '（已截断）' : '');
          // v1.1.0（M6）：验证工具（run_tests/run_lint/run_typecheck）的结果渲染命令列表
          let checkList = '';
          if (isObj && rp.data && rp.data.kind && Array.isArray(rp.data.results)) {
            checkList = '<div class="agent-hist-checks">' + rp.data.results.map((r) =>
              `<div class="agent-hist-check ${r.ok ? 'pass' : 'fail'}">${r.ok ? '通过' : '失败'} · ${esc(r.command)}${r.ok ? '' : '（退出码 ' + r.exitCode + '）'}</div>`).join('') +
              (rp.data.relatedToChanges ? '<div class="agent-hist-check warn">失败输出涉及本次修改的文件</div>' : '') + '</div>';
          }
          parts.push(`<div class="agent-hist-ev tool-result ${cls}"><span class="agent-hist-label">[结果]${esc(exitInfo)}</span> ${longText(txt, 500, 'tool-output')}${checkList}</div>`);
        } else if (ev.type === 'tool_diff') {
          const diff = (pl.diff || []).map((d) => `<div class="agent-diff-line ${d.type === '+' ? 'add' : (d.type === '-' ? 'del' : 'ctx')}">${d.type === '+' ? '+' : (d.type === '-' ? '-' : ' ')} ${esc(d.text)}</div>`).join('');
          parts.push(`<div class="agent-hist-ev tool-diff">[Diff] ${esc(pl.path || '')}<div class="agent-diff">${diff}</div></div>`);
        } else if (ev.type === 'require_approval') {
          parts.push(`<div class="agent-hist-ev approve"><span class="agent-hist-label">[审批]</span> ${longText(pl.description || pl.command || '', 200, 'approval-text')}</div>`);
        } else if (ev.type === 'subagent_queued' || ev.type === 'subagent_start' || ev.type === 'subagent_result' || ev.type === 'subagent_summary') {
          const role = pl.role || pl.subagentType || pl.type || 'explore';
          const result = pl.result && typeof pl.result === 'object' ? pl.result : pl;
          const evidence = (result.findings || []).flatMap((f) => (f.evidence || []).map((e) => `${e.path || ''}:${e.startLine || 0}-${e.endLine || 0}`));
          const checks = (result.checks || []).map((c) => `${c.status || 'skipped'} · ${c.name || ''}`).join('；');
          const state = ev.type === 'subagent_queued' ? '排队中' : (ev.type === 'subagent_start' ? '运行中' : (result.ok ? '完成' : (pl.status === 'cancelled' ? '已取消' : '失败')));
          parts.push(`<div class="agent-hist-ev subagent ${result.ok ? 'ok' : (state === '运行中' || state === '排队中' ? 'warn' : 'err')}"><b>[子代理 ${esc(role)} · ${state}]</b> ${esc(pl.goal || result.summary || '')}${result.summary && pl.goal ? '<br>' + longText(result.summary, 500, 'subagent-summary') : ''}${evidence.length ? '<br>证据：' + esc(evidence.join('、')) : ''}${checks ? '<br>检查：' + esc(checks) : ''}${result.error ? '<br>错误：' + esc(result.error.message || result.error.code || result.error) : ''}</div>`);
        } else if (ev.type === 'message') {
          parts.push(`<div class="agent-hist-ev msg">${esc(pl.text || '')}</div>`);
        } else if (ev.type === 'todo_update') {
          const todos = (pl.todos || []).map((t) => `${t.status === 'completed' ? '[完成]' : (t.status === 'in_progress' ? '[进行中]' : '[待办]')} ${esc(t.content)}`).join('<br>');
          if (todos) parts.push(`<div class="agent-hist-ev todo">[计划] <br>${todos}</div>`);
        } else if (ev.type === 'error' || ev.type === 'blocked' || ev.type === 'gate_blocked' || ev.type === 'budget_exhausted') {
          // v2（UX）：失败定位——错误/受阻/预算事件高亮，附明确动作提示
          const why = pl.message || pl.reason || (Array.isArray(pl.names) ? pl.names.join(', ') : '') || ev.type;
          const action = ev.type === 'blocked' || ev.type === 'budget_exhausted' ? ' → 可点「继续该任务」接力' : '';
          const failLabel = ev.type === 'budget_exhausted' ? '预算耗尽' : (ev.type === 'gate_blocked' ? '完成门拦截' : '受阻');
          parts.push(`<div class="agent-hist-ev is-fail"><span class="agent-hist-label">[${failLabel}]</span> ${longText(String(why) + action, 400, 'failure-text')}</div>`);
        }
      });
      if (!parts.length) return '<div class="wf-step-out">无可视化事件。</div>';
      return parts.join('');
    },

    // ===== v1.1.0（M7）：子代理卡片（explore 蓝 / test 橙 / review 紫） =====
    newSubagentBlock(ev) {
      const thread = document.getElementById('agentThread');
      const block = document.createElement('div');
      block.className = 'agent-tool agent-subagent type-' + App.escapeHtml(ev.type || 'explore');
      block.dataset.subid = ev.subId;
      const role = ev.role || ev.subagentType || ev.type;
      const typeLabel = role === 'test' ? '测试子代理' : (role === 'review' ? '审查子代理' : '探索子代理');
      block.innerHTML = `
        <div class="agent-tool-head">
          <span class="agent-tool-ico">◈</span>
          <span class="agent-tool-name">${typeLabel} ${App.escapeHtml(ev.subId || '')}</span>
          <span class="agent-tool-status">⏳ 运行中…</span>
          <button class="agent-tool-toggle">▾</button>
        </div>
        <div class="agent-tool-body">
          <div class="agent-subagent-goal">${App.escapeHtml(ev.goal || '')}</div>
          <pre class="agent-tool-out">等待结果…</pre>
        </div>`;
      thread.appendChild(block);
      thread.scrollTop = thread.scrollHeight;
      block.querySelector('.agent-tool-toggle').addEventListener('click', () => block.classList.toggle('collapsed'));
      block._startTime = Date.now();
      return block;
    },

    setSubagentResult(subId, ev) {
      const thread = document.getElementById('agentThread');
      const block = Array.from(thread.querySelectorAll('.agent-subagent')).find((b) => b.dataset.subid === subId);
      if (!block) return;
      const out = block.querySelector('.agent-tool-out');
      if (out) out.textContent = ev.summary || (ev.ok ? '完成' : '失败');
      const st = block.querySelector('.agent-tool-status');
      if (st) {
        const elapsed = block._startTime ? ((Date.now() - block._startTime) / 1000).toFixed(1) + 's' : '';
        st.textContent = (ev.ok ? '完成' : '失败') + (ev.steps ? ' · ' + ev.steps + ' 步' : '') + (ev.toolsUsed ? ' · ' + ev.toolsUsed + ' 次工具' : '') + (elapsed ? ' (' + elapsed + ')' : '');
      }
      const ico = block.querySelector('.agent-tool-ico');
      if (ico) ico.textContent = ev.ok ? '✓' : '✗';
      block.classList.add(ev.ok ? 'sub-ok' : 'sub-fail');
    },

    // v1.1.1：协作卡支持排队、结构化 findings/checks 与证据详情。
    newSubagentBlock(ev) {
      const thread = document.getElementById('agentThread');
      const existing = thread && Array.from(thread.querySelectorAll('.agent-subagent')).find((b) => b.dataset.subid === ev.subId);
      if (existing) {
        const status = existing.querySelector('.agent-tool-status');
        if (status && ev.type === 'subagent_start') status.textContent = '⏳ 运行中…';
        existing.classList.remove('sub-queued');
        return existing;
      }
      if (!thread) return null;
      const block = document.createElement('div');
      const queued = ev.type === 'subagent_queued' || ev.status === 'queued';
      const role = ev.role || ev.subagentType || ev.type;
      block.className = 'agent-tool agent-subagent type-' + App.escapeHtml(role || 'explore') + (queued ? ' sub-queued' : '');
      block.dataset.subid = ev.subId;
      const typeLabel = role === 'test' ? '测试子代理' : (role === 'review' ? '审查子代理' : '探索子代理');
      block.innerHTML = `<div class="agent-tool-head"><span class="agent-tool-ico">◈</span><span class="agent-tool-name">${typeLabel} ${App.escapeHtml(ev.subId || '')}</span><span class="agent-tool-status">${queued ? '⏱ 排队中…' : '⏳ 运行中…'}</span><button class="agent-tool-toggle">▾</button></div><div class="agent-tool-body"><div class="agent-subagent-goal">${App.escapeHtml(ev.goal || '')}</div><pre class="agent-tool-out">${queued ? '等待并发槽位…' : '等待结果…'}</pre><div class="agent-subagent-details"></div></div>`;
      thread.appendChild(block);
      thread.scrollTop = thread.scrollHeight;
      block.querySelector('.agent-tool-toggle').addEventListener('click', () => block.classList.toggle('collapsed'));
      block._startTime = ev.startedAt || (queued ? null : Date.now());
      return block;
    },
    setSubagentResult(subId, ev) {
      const thread = document.getElementById('agentThread');
      const block = thread && Array.from(thread.querySelectorAll('.agent-subagent')).find((b) => b.dataset.subid === subId);
      if (!block) return;
      const result = ev.result && typeof ev.result === 'object' ? ev.result : ev;
      const out = block.querySelector('.agent-tool-out');
      if (out) out.textContent = result.summary || (result.ok ? '完成' : '失败');
      const status = result.ok ? '完成' : (ev.status === 'cancelled' ? '已取消' : '失败');
      const st = block.querySelector('.agent-tool-status');
      if (st) {
        const elapsed = result.durationMs ? ((Number(result.durationMs) || 0) / 1000).toFixed(1) + 's' : (block._startTime ? ((Date.now() - block._startTime) / 1000).toFixed(1) + 's' : '');
        st.textContent = status + (result.steps ? ' · ' + result.steps + ' 步' : '') + (result.toolsUsed ? ' · ' + result.toolsUsed + ' 次工具' : '') + (elapsed ? ' (' + elapsed + ')' : '');
      }
      const ico = block.querySelector('.agent-tool-ico');
      if (ico) ico.textContent = result.ok ? '✓' : (ev.status === 'cancelled' ? '!' : '✗');
      const detail = block.querySelector('.agent-subagent-details');
      if (detail) {
        const findings = Array.isArray(result.findings) ? result.findings : [];
        const checks = Array.isArray(result.checks) ? result.checks : [];
        const findingHtml = findings.map((f) => `<div class="agent-subagent-finding"><b>${App.escapeHtml(f.severity || 'info')} · ${App.escapeHtml(f.title || '发现')}</b><div>${App.escapeHtml(f.detail || '')}</div>${(f.evidence || []).map((e) => `<code>${App.escapeHtml(e.path || '')}:${e.startLine || 0}-${e.endLine || 0}</code>`).join(' ')}</div>`).join('');
        const checkHtml = checks.map((c) => `<div class="agent-subagent-check ${App.escapeHtml(c.status || 'skipped')}">${App.escapeHtml(c.status || 'skipped')} · ${App.escapeHtml(c.name || '')}${c.detail ? ' · ' + App.escapeHtml(c.detail) : ''}</div>`).join('');
        detail.innerHTML = (findingHtml || checkHtml || result.error ? `<div class="agent-subagent-detail-title">协作详情</div>${findingHtml}${checkHtml}${result.error ? `<div class="agent-subagent-error">${App.escapeHtml(result.error.message || result.error.code || result.error)}</div>` : ''}` : '');
      }
      block.classList.add(result.ok ? 'sub-ok' : 'sub-fail');
      block.classList.remove('sub-queued');
    },

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
        const wid = (proj && proj.workspaceId) || '';
        const url = App.rt.agentBase() + '/api/skills' + (wid ? '?workspaceId=' + encodeURIComponent(wid) : '');
        const res = await fetch(url, { headers: authHeaders({ 'Content-Type': 'application/json' }) });
        if (!res.ok) throw new Error('bad status');
        const j = await res.json();
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
    openEngineObserver() {
      const existing = document.getElementById('agentEngineMask');
      if (existing) {
        this.renderEngineStrip();
        const closeButton = existing.querySelector('[data-engine-close]');
        if (closeButton) closeButton.focus();
        return;
      }
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.id = 'agentEngineMask';
      mask.innerHTML = `
        <div class="modal agent-modal agent-engine-modal" role="dialog" aria-modal="true" aria-labelledby="agentEngineTitle" tabindex="-1">
          <div class="modal-header">
            <div class="agent-engine-modal-heading">
              <span class="agent-engine-kicker">AGENT ENGINE</span>
              <strong id="agentEngineTitle">运行观测</strong>
            </div>
            <button class="icon-btn" data-engine-close type="button" aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modal-body">
            <div class="agent-engine-modal-copy">Runtime · Tool Registry · Cache Telemetry · Trace</div>
            <div class="agent-engine-stats" id="agentEngineStats"></div>
          </div>
          <div class="modal-footer">
            <button class="btn-ghost mini" id="agentEngineTraceBtn" type="button" title="查看当前会话最近一次运行的 Trace Inspector">查看 Trace</button>
            <button class="btn-ghost" data-engine-close type="button">关闭</button>
          </div>
        </div>`;
      document.body.appendChild(mask);
      const close = () => mask.remove();
      mask.querySelectorAll('[data-engine-close]').forEach((button) => button.addEventListener('click', close));
      mask.addEventListener('click', (event) => { if (event.target === mask) close(); });
      mask.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
      const traceButton = mask.querySelector('#agentEngineTraceBtn');
      if (traceButton) traceButton.addEventListener('click', async () => {
        close();
        await App.agent.openLatestTrace();
      });
      this.renderEngineStrip();
      this.refreshEngineStrip();
      const modal = mask.querySelector('.agent-engine-modal');
      if (modal) modal.focus();
    },

    renderEngineStrip() {
      const launcher = document.getElementById('agentEngineBtn');
      const launcherState = document.getElementById('agentEngineLauncherState');
      const statsBox = document.getElementById('agentEngineStats');
      const thread = App.agent.activeThread();
      const stored = App.agent._engineStripData || {};
      const run = stored.threadId === (thread && thread.id) ? stored.run : null;
      const metrics = stored.threadId === (thread && thread.id) ? stored.metrics : null;
      const live = App.agent._runState && (!thread || App.agent._runState.threadId === thread.id) ? App.agent._runState : null;
      const usage = (run && run.usage) || {};
      const budgetSnapshot = (run && run.budget) || {};
      const limits = budgetSnapshot.budget || (run && run.limits) || {};
      const spent = budgetSnapshot.spent || {};
      const remaining = budgetSnapshot.remaining || {};
      const cache = (metrics && metrics.cache) || usage.cache || {};
      const numeric = (value) => {
        if (value == null || value === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
      };
      const firstNumber = (...values) => {
        for (const value of values) {
          const n = numeric(value);
          if (n != null) return n;
        }
        return null;
      };
      const esc = (value) => App.escapeHtml(value == null ? '' : String(value));
      const formatVersion = (value, fallback) => {
        const raw = String(value || '').trim();
        if (!raw || raw === 'legacy/unknown') return fallback;
        return raw.startsWith('v') ? raw : 'v' + raw;
      };
      const formatTokens = (value) => {
        const n = numeric(value);
        if (n == null) return '未知';
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
        return String(Math.round(n));
      };
      const formatDuration = (value) => {
        const n = numeric(value);
        if (n == null) return '未知';
        return n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms';
      };
      const formatCost = (value) => {
        const n = numeric(value);
        return n == null ? '未知' : '$' + n.toFixed(4);
      };
      const runStatus = String((live && live.status) || (run && run.status) || 'idle');
      const statusLabels = {
        idle: '待运行', running: '运行中', completed: '已完成', done: '已完成', failed: '失败', error: '失败',
        stopped: '已停止', cancelled: '已取消', blocked: '受阻', budget_exhausted: '预算耗尽',
      };
      const statusClass = ['running', 'completed', 'done'].includes(runStatus) ? 'is-running' : (['failed', 'error'].includes(runStatus) ? 'is-error' : (runStatus === 'idle' ? 'is-idle' : 'is-warn'));
      if (launcher) {
        launcher.dataset.state = statusClass;
        launcher.title = '打开运行观测 · ' + (statusLabels[runStatus] || runStatus);
        if (launcherState) launcherState.textContent = statusLabels[runStatus] || runStatus;
      }
      if (!statsBox) return;
      const steps = live ? Number(live.step || 0) : firstNumber(usage.steps, spent.steps, 0);
      const maxSteps = firstNumber(limits.maxSteps, budgetSnapshot.granted && budgetSnapshot.granted.maxSteps, run && run.limits && run.limits.maxSteps);
      const budgetValue = maxSteps != null && maxSteps > 0 ? Math.round(steps || 0) + '/' + Math.round(maxSteps) : (steps == null ? '未知' : Math.round(steps) + ' 步');
      const remainingSteps = numeric(remaining.steps);
      const budgetDetail = remainingSteps != null ? '剩余 ' + Math.round(remainingSteps) + ' 步' : (live ? '实时累计' : '等待 Run 数据');
      const hitRate = numeric(cache.hitRate);
      const cacheValue = hitRate == null ? '未知' : (Math.round(hitRate * 1000) / 10) + '%';
      const savedTokens = numeric(cache.savedTokens);
      const cacheDetail = savedTokens == null ? 'Provider 未返回' : '节省 ' + formatTokens(savedTokens) + ' tok';
      const cost = firstNumber(metrics && metrics.costUsd, usage.estimatedCost);
      const latency = firstNumber(metrics && metrics.latencyMs, live ? Date.now() - (live.startedAt || Date.now()) : null, run && run.finishedAt && run.startedAt ? run.finishedAt - run.startedAt : null);
      const queueWait = firstNumber(metrics && metrics.queueWaitMs);
      const runtimeVersion = formatVersion(run && run.runtimeVersion, 'v1.1.2');
      const rawToolset = String((run && run.toolsetVersion) || '');
      const toolsetVersion = formatVersion(rawToolset.split(':')[0], 'v1.1.2');
      const role = (run && run.role) || 'main';
      const promptVersion = formatVersion(run && run.promptVersion, 'legacy');
      const runDetail = live
        ? ((live.phase || 'understanding') + ' · ' + Math.round(live.step || 0) + ' 步')
        : (run ? String(run.id || '').slice(0, 18) : '首个任务将自动记录');
      const stat = (key, label, value, detail, extraClass) => `<div class="agent-engine-stat${extraClass ? ' ' + extraClass : ''}" data-engine-stat="${key}"><span>${label}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small></div>`;
      statsBox.innerHTML = [
        stat('runtime', 'Runtime', runtimeVersion, 'Agent Engine'),
        stat('toolset', 'Toolset', toolsetVersion, 'Tool Registry · ' + role + ' · ' + promptVersion),
        stat('run', 'Run', statusLabels[runStatus] || runStatus, runDetail, statusClass),
        stat('cache', 'Cache', cacheValue, cacheDetail, hitRate == null ? 'is-unknown' : 'is-cache'),
        stat('budget', 'Budget', budgetValue, budgetDetail, 'is-budget'),
        stat('cost', 'Cost', formatCost(cost), cost == null ? '无价格表或未完成' : '估算值', cost == null ? 'is-unknown' : ''),
        stat('latency', 'Latency', formatDuration(latency), queueWait == null ? 'Queue 未知' : 'Queue ' + formatDuration(queueWait), latency == null ? 'is-unknown' : ''),
      ].join('');
      const traceButton = document.getElementById('agentEngineTraceBtn');
      if (traceButton && !traceButton.dataset.bound) {
        traceButton.dataset.bound = '1';
        traceButton.addEventListener('click', () => App.agent.openLatestTrace());
      }
    },

    async refreshEngineStrip() {
      const thread = App.agent.activeThread();
      const requestId = ++App.agent._engineStripRequest;
      if (!thread) {
        App.agent._engineStripData = { threadId: '', run: null, metrics: null };
        App.agent.renderEngineStrip();
        return;
      }
      let run = null;
      try {
        const response = App.services.storage && App.services.storage.listAgentRuns
          ? await App.services.storage.listAgentRuns(thread.id, 1, 0) : null;
        if (response && response.ok && Array.isArray(response.runs)) run = response.runs[0] || null;
      } catch (_) {}
      if (requestId !== App.agent._engineStripRequest || App.agent.activeThread().id !== thread.id) return;
      let metrics = null;
      try {
        if (run && App.services.storage && App.services.storage.getAgentRunMetrics) {
          const response = await App.services.storage.getAgentRunMetrics(run.rootRunId || run.id);
          if (response && response.ok) metrics = response.metrics || null;
        }
      } catch (_) {}
      if (requestId !== App.agent._engineStripRequest || App.agent.activeThread().id !== thread.id) return;
      App.agent._engineStripData = { threadId: thread.id, run, metrics };
      App.agent.renderEngineStrip();
    },

    async openLatestTrace() {
      const thread = App.agent.activeThread();
      if (!thread) return;
      let run = null;
      try {
        const response = App.services.storage && App.services.storage.listAgentRuns
          ? await App.services.storage.listAgentRuns(thread.id, 1, 0) : null;
        if (response && response.ok && Array.isArray(response.runs)) run = response.runs[0] || null;
      } catch (_) {}
      if (!run && App.agent._runState && App.agent._runState.threadId === thread.id && App.agent._runState.runId) {
        run = { id: App.agent._runState.runId };
      }
      if (!run) {
        App.ui.toast('当前会话还没有运行记录');
        App.agent.showRunHistory();
        return;
      }
      App.agent.showRunHistory({ openRunId: run.id });
    },

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
      let workspaceId = proj.workspaceId || '';
      if (!workspaceId && cwd) {
        try {
          const r = await App.services.shell.registerWorkspace(cwd, proj.name);
          if (r && r.ok) { workspaceId = r.workspaceId; proj.workspaceId = workspaceId; App.persist(); }
        } catch (_) {}
      }
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
    renderRunPill() {
      const pill = document.getElementById('agentRunPill');
      if (!pill) { App.agent.renderEngineStrip(); return; }
      const rs = App.agent._runState;
      if (!rs) { pill.hidden = true; App.agent.renderEngineStrip(); return; }
      App.agent.renderEngineStrip();
      // v15（单状态卡）：位于糖码页面时隐藏全局药丸，避免出现第二张状态卡；离开糖码页后作为导航提示
      if (App.router && typeof App.router.current === 'function' && App.router.current() === 'agent') { pill.hidden = true; return; }
      const textEl = document.getElementById('agentRunText');
      const projName = ((App.state.projects || []).find(p => p.id === rs.projectId) || {}).name || '项目';
      const thr = App.state.agentThreads.find(t => t.id === rs.threadId);
      const thrName = (thr && thr.title) ? thr.title : '会话';
      const phaseMap = { understanding: '理解', exploring: '探索', planning: '规划', implementing: '实施', verifying: '验证', reviewing: '复核', completed: '完成', waiting_approval: '等待审批', recovering: '恢复中' };
      const phase = phaseMap[rs.phase] || rs.phase || '';
      const secs = Math.max(0, Math.floor((Date.now() - (rs.startedAt || Date.now())) / 1000));
      const dur = secs >= 60 ? Math.floor(secs / 60) + '分' + (secs % 60 ? (secs % 60) + '秒' : '') : secs + '秒';
      let prefix = '⏳ 运行中', cls = '';
      if (rs.status === 'completed' || rs.status === 'done') { prefix = '✅ 已完成'; cls = ' done'; }
      else if (rs.status === 'error') { prefix = '⚠️ 已中断'; cls = ' error'; }
      else if (rs.status === 'blocked') { prefix = '⛔ 已阻塞'; cls = ' blocked'; }
      pill.className = 'agent-run-pill' + cls;
      const tool = rs.toolName ? ' · ' + rs.toolName : '';
      textEl.textContent = `${prefix} · ${projName}/${thrName} · ${phase}${tool} · ${rs.step} 步 · ${dur}`;
      pill.hidden = false;
    },

    // v1.1.0：清空全局运行状态（任务结束统一收敛点）
    clearRunState() {
      if (App.agent._runPillTimer) { clearInterval(App.agent._runPillTimer); App.agent._runPillTimer = null; }
      App.agent._runState = null;
      const pill = document.getElementById('agentRunPill');
      if (pill) pill.hidden = true;
      App.agent.renderEngineStrip();
    },

    /* ===== v2（UX）：统一状态摘要条——默认一行当前状态，异常时展开下一步动作 ===== */
    hideStatusSummary() {
      const box = document.getElementById('agentStatusSummary');
      if (box) { box.hidden = true; box.innerHTML = ''; }
    },
    // 继续上次任务：携带来源 Run 精确恢复（历史面板/状态卡/接力条统一入口）
    resumeRun(runId) {
      const input = document.getElementById('agentInput');
      const t = App.agent.activeThread();
      const lastPrompt = (t && t._lastPrompt) || ((t && t.history && t.history.length) ? (t.history.slice().reverse().find(h => h.role === 'user') || {}).content || '' : '');
      if (!lastPrompt) { App.ui.toast('没有可继续的任务内容'); return; }
      if (!runId) {
        const rs = App.agent._runState;
        runId = (t && t.lastRunId) || (rs && rs.runId) || '';
      }
      if (!runId) { App.ui.toast('未找到上次运行记录，无法精确恢复，请重新发起任务'); return; }
      App.agent._resumeRunId = String(runId);
      if (input) { input.value = lastPrompt; App.agent.autoSizeInput(input); }
      App.agent.hideStatusSummary();
      App.agent.send();
    },
    // 兼容旧调用（状态卡 continue 按钮）；统一走 resumeRun
    resumeLastRun() {
      const t = App.agent.activeThread();
      const rs = App.agent._runState;
      App.agent.resumeRun((t && t.lastRunId) || (rs && rs.runId) || '');
    },
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
    renderStatusSummary(mode, detail) {
      const box = document.getElementById('agentStatusSummary');
      if (!box) return;
      App.agent._uxTrack('status');
      const d = detail || {};
      const rs = App.agent._runState;
      const closeBtn = '<button type="button" class="agent-status-close" data-status-close="1" aria-label="关闭提示">×</button>';
      let cls = 'agent-status-row';
      let body = '';
      if (mode === 'running') {
        cls += ' is-running';
        const phase = rs && rs.phase ? rs.phase : (d.phase || 'understanding');
        const tool = rs && rs.toolName ? ' · <code>' + App.escapeHtml(rs.toolName) + '</code>' : '';
        const step = rs ? (rs.step || 0) : 0;
        const seg = (rs && rs.segmentIndex > 0) ? ' · 第 ' + (rs.segmentIndex + 1) + ' 段' : '';
        const proj = App.agent.activeProject();
        const cwd = (proj && proj.cwd) ? proj.cwd : '(后端默认目录)';
        const modeLabel = (proj && proj.auto) ? '自动执行' : '每步确认';
        body = '<span class="agent-status-dot"></span><span>正在执行 <b>' + App.escapeHtml(phase) + '</b>' + tool + ' · ' + step + ' 步' + seg + ' · <code>' + App.escapeHtml(cwd) + '</code> · ' + modeLabel + '</span>';
      } else if (mode === 'blocked' || mode === 'budget') {
        cls += ' is-warn';
        const title = mode === 'budget' ? '运行预算已耗尽' : '任务被阻断';
        body = '<span class="agent-status-ico">⏸</span><div class="agent-status-main"><div class="agent-status-title">' + title + '</div>'
          + '<div class="agent-status-detail">' + App.escapeHtml(d.reason || '请检查原因后继续或停止。') + '</div>'
          + '<div class="agent-status-ops"><button class="btn-primary mini" data-status-resume="1">继续任务</button>'
          + '<button class="btn-ghost mini" data-status-copy="1">复制诊断</button></div></div>' + closeBtn;
      } else if (mode === 'error') {
        cls += ' is-error';
        // v1.1.0（修复 M6）：左上角图标 ✕ → ⚠——原 ✕ 与右侧真实关闭按钮 × 视觉一致，用户误以为可点
        body = '<span class="agent-status-ico">⚠</span><div class="agent-status-main"><div class="agent-status-title">运行出错</div>'
          + '<div class="agent-status-detail">' + App.escapeHtml(String(d.message || '未知错误').slice(0, 600)) + '</div>'
          + '<div class="agent-status-ops"><button class="btn-ghost mini" data-status-retry="1">重试该任务</button>'
          + '<button class="btn-ghost mini" data-status-copy="1">复制诊断</button></div></div>' + closeBtn;
      } else if (mode === 'offline') {
        cls += ' is-warn';
        body = '<span class="agent-status-ico">⚠</span><div class="agent-status-main"><div class="agent-status-title">无法连接后端</div>'
          + '<div class="agent-status-detail">' + App.escapeHtml(d.message || '请求未发送，正文与 Skill 气泡已保留，可重试。') + '</div>'
          + '<div class="agent-status-ops"><button class="btn-primary mini" data-status-retry="1">重试发送</button>'
          + '<button class="btn-ghost mini" data-status-copy="1">复制诊断</button></div></div>' + closeBtn;
      } else if (mode === 'compact') {
        cls += ' is-info';
        const saved = d.beforeTokens && d.afterTokens ? '（' + Math.max(1, Math.round((d.beforeTokens - d.afterTokens) / 1000)) + 'k tokens）' : '';
        body = '<span class="agent-status-ico">⇅</span><div class="agent-status-main"><div class="agent-status-title">上下文已自动压缩' + saved + '</div>'
          + '<div class="agent-status-detail">较早对话已安全归纳，计划、错误与变更记录仍保留；可在历史中查看完整事件。</div></div>' + closeBtn;
      } else {
        App.agent.hideStatusSummary();
        return;
      }
      box.hidden = false;
      box.innerHTML = '<div class="' + cls + '">' + body + '</div>';
      // 事件绑定（重建后重新挂接）
      box.querySelector('[data-status-close]')?.addEventListener('click', () => App.agent.hideStatusSummary());
      const retry = box.querySelector('[data-status-retry]');
      if (retry) retry.addEventListener('click', () => {
        App.agent.hideStatusSummary();
        const thread = App.agent.activeThread();
        const input = document.getElementById('agentInput');
        if (thread && input) {
          const lastPrompt = (thread && thread._lastPrompt) || input.value.trim();
          if (!lastPrompt) { App.ui.toast('没有可重试的任务内容'); return; }
          if (!input.value.trim()) { input.value = lastPrompt; App.agent.autoSizeInput(input); }
        }
        App.agent.send();
      });
      const resume = box.querySelector('[data-status-resume]');
      if (resume) resume.addEventListener('click', () => App.agent.resumeLastRun());
      const copy = box.querySelector('[data-status-copy]');
      if (copy) copy.addEventListener('click', () => App.agent.copyStatusDiagnostics(d));
    },
    // 运行中：一行式实时状态（由 phase / tool_call / tool_result / segment 事件驱动，原位刷新同一张卡）
    showStatusRunning() {
      const box = document.getElementById('agentStatusSummary');
      if (!box) return;
      if (App.agent._compactTimer) { clearTimeout(App.agent._compactTimer); App.agent._compactTimer = null; }
      App.agent.renderStatusSummary('running');
      App.agent.renderEngineStrip();
    },
    // 上下文压缩：短暂提示，5 秒自动隐藏（用户也可手动关闭）
    showStatusCompact(detail) {
      App.agent.renderStatusSummary('compact', detail);
      if (App.agent._compactTimer) clearTimeout(App.agent._compactTimer);
      App.agent._compactTimer = setTimeout(() => App.agent.hideStatusSummary(), 6000);
    },

    // v1.1.0：点击药丸跳回运行中的会话
    jumpToRunThread() {
      const rs = App.agent._runState;
      if (!rs) return;
      try { if (App.router && App.router.go) App.router.go('agent'); } catch (e) {}
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
        <div class="modal" role="dialog" aria-modal="true" style="width:400px">
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
      let workspaceId = proj.workspaceId || '';
      if (!workspaceId) {
        try {
          const r = await App.services.shell.registerWorkspace(cwd, proj.name);
          if (r && r.ok) { workspaceId = r.workspaceId; proj.workspaceId = workspaceId; App.persist(); }
        } catch (_) {}
      }
      const file = '糖码记忆.md';
      let content = '';
      try {
        const r = await fetch(agentBase() + '/api/memory?cwd=' + encodeURIComponent(cwd) + '&workspaceId=' + encodeURIComponent(workspaceId) + '&file=' + encodeURIComponent(file), { cache: 'no-store', headers: authHeaders() });
        const j = await r.json().catch(() => ({}));
        content = (j && j.ok) ? (j.content || '') : '';
      } catch (e) { content = ''; }
      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.innerHTML = `
        <div class="modal">
          <div class="modal-header"><span>项目记忆（${App.escapeHtml(file)}）</span>
            <button class="modal-close" id="memClose" title="关闭">×</button></div>
          <div class="modal-body">
            <p class="hint">该文件位于项目工作目录 <code>${App.escapeHtml(cwd)}</code>，会作为长期记忆注入糖码的系统提示。保存即写入磁盘。</p>
            <textarea id="memContent" class="mem-editor" rows="14" style="font-family:ui-monospace,Menlo,Consolas,monospace">${App.escapeHtml(content)}</textarea>
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
          const r = await fetch(agentBase() + '/api/memory', {
            method: 'PUT',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ cwd, workspaceId, file, content: txt }),
          });
          const j = await r.json().catch(() => ({}));
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
    try { if (window.App && App.agent && App.agent.updateApprovalBarPosition) App.agent.updateApprovalBarPosition(); } catch (_) {}
  });
  // v1.1.0：顶栏运行状态药丸点击跳回（一次性绑定，agentView 外的常驻元素）
  try {
    const pill = document.getElementById('agentRunPill');
    if (pill) pill.addEventListener('click', () => App.agent.jumpToRunThread());
  } catch (_e) {}
})();
