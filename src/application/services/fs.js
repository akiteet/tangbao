'use strict';
/* 文件/存储服务：state.json 双写 + M3/M4 SQLite 通道 */
(function () {
  App.services = App.services || {};
  App.services.fs = {
    saveStateJSON(jsonStr, revision) {
      try { return (window.electron && window.electron.saveStateJSON) ? window.electron.saveStateJSON(jsonStr, revision) : { ok: false, code: 'ipc_unavailable' }; } catch (e) { return { ok: false, code: 'ipc_failed', error: e && e.message ? e.message : String(e) }; }
    },
    loadStateJSON() {
      try { return (window.electron && window.electron.loadStateJSON) ? window.electron.loadStateJSON() : { ok: false }; } catch (e) { return { ok: false }; }
    },
    migrateStorage(json) {
      try { return (window.electron && window.electron.migrateStorage) ? window.electron.migrateStorage(json) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    syncStorage(json, revision) {
      try { return (window.electron && window.electron.syncStorage) ? window.electron.syncStorage(json, revision) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    // 聊天修复：关闭前同步落盘（sendSync 阻塞等待）
    flushStorageSync(json, revision) {
      try { return (window.electron && window.electron.flushStorageSync) ? window.electron.flushStorageSync(json, revision) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    loadStorage() {
      try { return (window.electron && window.electron.loadStorage) ? window.electron.loadStorage() : { ok: false }; } catch (e) { return { ok: false }; }
    },
    async checkWorkspaceHealth(workspaceId) {
      const project = App.agent && App.agent.activeProject ? App.agent.activeProject() : null;
      const invoke = (id) => {
        try { return (window.electron && window.electron.checkWorkspaceHealth) ? window.electron.checkWorkspaceHealth(id) : { ok: false, code: 'ipc_unavailable' }; } catch (e) { return { ok: false, code: e && e.code || 'ipc_failed', error: String(e && e.message ? e.message : e) }; }
      };
      if (project && App.services.workspace && (workspaceId || project.workspaceId || project.cwd)) {
        return App.services.workspace.run(project, (id) => invoke(id));
      }
      return invoke(workspaceId || '');
    },
    exportState() {
      try { return (window.electron && window.electron.exportState) ? window.electron.exportState() : { ok: false, error: '环境不支持' }; } catch (e) { return { ok: false }; }
    },
    importState() {
      try { return (window.electron && window.electron.importState) ? window.electron.importState() : { ok: false, error: '环境不支持' }; } catch (e) { return { ok: false }; }
    },
    // M7（v1.0.8）：工作流运行历史（独立持久化，SQLite 不可用静默降级）
    getStorageInfo() {
      try { return (window.electron && window.electron.getStorageInfo) ? window.electron.getStorageInfo() : { ok: false }; } catch (e) { return { ok: false }; }
    },
    chooseStorageLocation() {
      try { return (window.electron && window.electron.chooseStorageLocation) ? window.electron.chooseStorageLocation() : { ok: false }; } catch (e) { return { ok: false }; }
    },
    verifyStorageMigration() {
      try { return (window.electron && window.electron.verifyStorageMigration) ? window.electron.verifyStorageMigration() : { ok: false }; } catch (e) { return { ok: false }; }
    },
    cleanupPreview() {
      try { return (window.electron && window.electron.cleanupPreview) ? window.electron.cleanupPreview() : { ok: false, items: [] }; } catch (e) { return { ok: false, items: [] }; }
    },
    cleanupLegacy(input) {
      try { return (window.electron && window.electron.cleanupLegacy) ? window.electron.cleanupLegacy(input || {}) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    backupStorage(input) {
      try { return (window.electron && window.electron.backupStorage) ? window.electron.backupStorage(input || {}) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    exportDiagnostics() {
      try { return (window.electron && window.electron.exportStorageDiagnostics) ? window.electron.exportStorageDiagnostics() : { ok: false }; } catch (e) { return { ok: false }; }
    },
    restoreStorage(input) {
      try { return (window.electron && window.electron.restoreStorage) ? window.electron.restoreStorage(input || {}) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    relaunchApp() {
      try { return (window.electron && window.electron.relaunchApp) ? window.electron.relaunchApp() : { ok: false }; } catch (e) { return { ok: false }; }
    },
    saveWorkflowRun(run) {
      try { return (window.electron && window.electron.saveWorkflowRun) ? window.electron.saveWorkflowRun(run) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    listWorkflowRuns(workflowId, limit) {
      try { return (window.electron && window.electron.listWorkflowRuns) ? window.electron.listWorkflowRuns(workflowId, limit) : { ok: false, runs: [] }; } catch (e) { return { ok: false, runs: [] }; }
    },
  };
  // v1.1.0（M1）：糖码 Agent Run 历史桥（一期 agent.js 已引用 App.services.storage，此处补齐接线）
  App.services.storage = {
    listAgentRuns(threadId, limit, offset) {
      try { return (window.electron && window.electron.listAgentRuns) ? window.electron.listAgentRuns(threadId, limit, offset) : { ok: false, runs: [] }; } catch (e) { return { ok: false, runs: [] }; }
    },
    listAgentEvents(runId) {
      try { return (window.electron && window.electron.listAgentEvents) ? window.electron.listAgentEvents(runId) : { ok: false, events: [] }; } catch (e) { return { ok: false, events: [] }; }
    },
    getAgentRunTree(rootRunId) {
      try { return (window.electron && window.electron.getAgentRunTree) ? window.electron.getAgentRunTree(rootRunId) : { ok: false, tree: null }; } catch (e) { return { ok: false, tree: null }; }
    },
    tracePage(input) {
      try { return (window.electron && window.electron.tracePage) ? window.electron.tracePage(input || {}) : { ok: false, items: [], nextCursor: null, hasMore: false, total: 0 }; } catch (e) { return { ok: false, items: [], nextCursor: null, hasMore: false, total: 0 }; }
    },
    getAgentRunMetrics(rootRunId) {
      try { return (window.electron && window.electron.getAgentRunMetrics) ? window.electron.getAgentRunMetrics(rootRunId) : { ok: false, metrics: null }; } catch (e) { return { ok: false, metrics: null }; }
    },
    exportAgentRun(runId) {
      try { return (window.electron && window.electron.exportAgentRun) ? window.electron.exportAgentRun(runId) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    exportAgentTrace(input) {
      try { return (window.electron && window.electron.exportAgentTrace) ? window.electron.exportAgentTrace(input || {}) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    listAgentEvalTasks() {
      try { return (window.electron && window.electron.listAgentEvalTasks) ? window.electron.listAgentEvalTasks() : { ok: false, tasks: [] }; } catch (e) { return { ok: false, tasks: [] }; }
    },
    runAgentEval(payload) {
      try { return (window.electron && window.electron.runAgentEval) ? window.electron.runAgentEval(payload || {}) : { ok: false, error: '环境不支持' }; } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
    },
    getAgentSummary(threadId) {
      try { return (window.electron && window.electron.getAgentSummary) ? window.electron.getAgentSummary(threadId) : { ok: false, summary: null }; } catch (e) { return { ok: false, summary: null }; }
    },
    // v2（P1-C）：压缩后摘要落库
    saveAgentSummary(s) {
      try { return (window.electron && window.electron.saveAgentSummary) ? window.electron.saveAgentSummary(s) : { ok: false }; } catch (e) { return { ok: false }; }
    },
  };
})();
