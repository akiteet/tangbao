'use strict';
/* 技能服务：导入 / 启停（底层走主进程文件操作，renderer 无任意路径写权限） */
(function () {
  App.services = App.services || {};
  App.services.skills = {
    listSkills(workspaceId) {
      try { return (window.electron && window.electron.skillsList) ? window.electron.skillsList(workspaceId || '') : { ok: false, error: '环境不支持', skills: [] }; } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), skills: [] }; }
    },
    importSkill(scope, workspaceId) {
      try { return (window.electron && window.electron.skillsImport) ? window.electron.skillsImport({ scope: scope || 'user', workspaceId: workspaceId || '' }) : { ok: false, error: '环境不支持' }; } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
    },
    manage(method, payload) {
      try { return (window.electron && typeof window.electron[method] === 'function') ? window.electron[method](payload || {}) : { ok: false, error: '环境不支持' }; } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
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
    toggleSkill(payload, name, enable) {
      const body = payload && typeof payload === 'object' ? Object.assign({}, payload) : { dir: payload, name, enable };
      try { return (window.electron && window.electron.skillsToggle) ? window.electron.skillsToggle(body) : { ok: false, error: '环境不支持' }; } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
    },
  };
})();
