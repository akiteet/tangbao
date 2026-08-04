'use strict';
/* 文件/存储服务：state.json 双写 + M3/M4 SQLite 通道 */
(function () {
  App.services = App.services || {};
  App.services.fs = {
    saveStateJSON(jsonStr) {
      try { return (window.electron && window.electron.saveStateJSON) ? window.electron.saveStateJSON(jsonStr) : null; } catch (e) { return null; }
    },
    loadStateJSON() {
      try { return (window.electron && window.electron.loadStateJSON) ? window.electron.loadStateJSON() : { ok: false }; } catch (e) { return { ok: false }; }
    },
    migrateStorage(json) {
      try { return (window.electron && window.electron.migrateStorage) ? window.electron.migrateStorage(json) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    syncStorage(json) {
      try { return (window.electron && window.electron.syncStorage) ? window.electron.syncStorage(json) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    loadStorage() {
      try { return (window.electron && window.electron.loadStorage) ? window.electron.loadStorage() : { ok: false }; } catch (e) { return { ok: false }; }
    },
    exportState() {
      try { return (window.electron && window.electron.exportState) ? window.electron.exportState() : { ok: false, error: '环境不支持' }; } catch (e) { return { ok: false }; }
    },
    importState() {
      try { return (window.electron && window.electron.importState) ? window.electron.importState() : { ok: false, error: '环境不支持' }; } catch (e) { return { ok: false }; }
    },
    // M7（v1.0.8）：工作流运行历史（独立持久化，SQLite 不可用静默降级）
    saveWorkflowRun(run) {
      try { return (window.electron && window.electron.saveWorkflowRun) ? window.electron.saveWorkflowRun(run) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    listWorkflowRuns(workflowId, limit) {
      try { return (window.electron && window.electron.listWorkflowRuns) ? window.electron.listWorkflowRuns(workflowId, limit) : { ok: false, runs: [] }; } catch (e) { return { ok: false, runs: [] }; }
    },
  };
})();
