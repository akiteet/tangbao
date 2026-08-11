'use strict';
/* 技能服务：导入 / 启停（底层走主进程文件操作，renderer 无任意路径写权限） */
(function () {
  App.services = App.services || {};
  const invoke = (method, payload) => {
    try {
      return (window.electron && typeof window.electron[method] === 'function')
        ? window.electron[method](payload)
        : { ok: false, error: '环境不支持' };
    } catch (e) {
      return { ok: false, code: e && e.code || 'ipc_failed', error: String(e && e.message ? e.message : e) };
    }
  };
  const activeProject = () => App.agent && App.agent.activeProject ? App.agent.activeProject() : null;
  const needsWorkspace = (payload) => {
    const body = payload && typeof payload === 'object' ? payload : {};
    return !!(body.workspaceId || body.toWorkspaceId || body.scope === 'project' || body.toScope === 'project');
  };
  const runWithWorkspace = async (payload, operation) => {
    const project = activeProject();
    if (!needsWorkspace(payload)) return operation(payload || {});
    if (!project || !App.services.workspace) {
      return { ok: false, code: 'workspace_reselection_required', error: '请先打开有效项目，再执行项目级 Skill 操作', needsSelection: true };
    }
    return App.services.workspace.run(project, (workspaceId) => {
      const body = Object.assign({}, payload || {}, { workspaceId });
      if (body.toScope === 'project' || body.scope === 'project') body.toWorkspaceId = workspaceId;
      return operation(body);
    });
  };
  App.services.skills = {
    async listSkills(workspaceId) {
      const project = activeProject();
      if (project && (workspaceId || project.cwd)) {
        const result = await App.services.workspace.run(project, (id) => invoke('skillsList', id));
        return result && result.ok === false && !Array.isArray(result.skills) ? Object.assign({ skills: [] }, result) : result;
      }
      const result = await invoke('skillsList', workspaceId || '');
      return result && result.ok === false && !Array.isArray(result.skills) ? Object.assign({ skills: [] }, result) : result;
    },
    async importSkill(scope, workspaceId) {
      return runWithWorkspace({ scope: scope || 'user', workspaceId: workspaceId || '' }, (payload) => invoke('skillsImport', payload));
    },
    async manage(method, payload) {
      return runWithWorkspace(payload || {}, (body) => invoke(method, body));
    },
    details(payload) { return this.manage('skillsDetails', payload); },
    edit(payload) { return this.manage('skillsEdit', payload); },
    reveal(payload) { return this.manage('skillsReveal', payload); },
    exportSkill(payload) { return this.manage('skillsExport', payload); },
    uninstall(payload) { return this.manage('skillsUninstall', payload); },
    trust(payload) { return this.manage('skillsTrust', payload); },
    setAutoTrigger(payload) { return this.manage('skillsAutoTrigger', payload); },
    moveSkill(payload) { return this.manage('skillsMove', payload); },
    importExternal(payload) { return this.manage('skillsImportExternal', payload); },
    listQuarantine() {
      try { return (window.electron && window.electron.skillsQuarantine) ? window.electron.skillsQuarantine() : { ok: false, items: [] }; } catch (e) { return { ok: false, items: [] }; }
    },
    restoreQuarantine(payload) { return this.manage('skillsRestore', payload); },
    purgeQuarantine(payload) { return this.manage('skillsPurge', payload); },
    async toggleSkill(payload, name, enable) {
      const body = payload && typeof payload === 'object' ? Object.assign({}, payload) : { dir: payload, name, enable };
      return runWithWorkspace(body, (next) => invoke('skillsToggle', next));
    },
  };
})();
