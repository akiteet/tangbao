'use strict';
/* 文件/存储服务：state.json 双写 + M3/M4 SQLite 通道。
 * v1.1.5（批次 C3）：IPC 容错包装统一走 App.services.ipc（方法缺失 → 各自 fallback；
 * 调用异常 → fallback 合并 ok/code/error）。 */
(function () {
  App.services = App.services || {};
  const ipc = () => App.services.ipc;
  App.services.fs = {
    saveStateJSON(jsonStr, revision) {
      return ipc().invokeSync('saveStateJSON', [jsonStr, revision], { ok: false, code: 'ipc_unavailable' });
    },
    loadStateJSON() {
      return ipc().invokeSync('loadStateJSON', [], { ok: false });
    },
    migrateStorage(json) {
      return ipc().invokeSync('migrateStorage', [json], { ok: false });
    },
    syncStorage(json, revision) {
      return ipc().invokeSync('syncStorage', [json, revision], { ok: false });
    },
    // 聊天修复：关闭前同步落盘（sendSync 阻塞等待）
    flushStorageSync(json, revision) {
      return ipc().invokeSync('flushStorageSync', [json, revision], { ok: false });
    },
    loadStorage() {
      return ipc().invokeSync('loadStorage', [], { ok: false });
    },
    async checkWorkspaceHealth(workspaceId) {
      const project = App.agent && App.agent.activeProject ? App.agent.activeProject() : null;
      const invoke = (id) => ipc().invokeSync('checkWorkspaceHealth', [id], { ok: false, code: 'ipc_unavailable' });
      if (project && App.services.workspace && (workspaceId || project.workspaceId || project.cwd)) {
        return App.services.workspace.run(project, (id) => invoke(id));
      }
      return invoke(workspaceId || '');
    },
    exportState() {
      return ipc().invokeSync('exportState', [], { ok: false, error: '环境不支持' });
    },
    importState() {
      return ipc().invokeSync('importState', [], { ok: false, error: '环境不支持' });
    },
    // M7（v1.0.8）：工作流运行历史（独立持久化，SQLite 不可用静默降级）
    getStorageInfo() {
      return ipc().invokeSync('getStorageInfo', [], { ok: false });
    },
    chooseStorageLocation() {
      return ipc().invokeSync('chooseStorageLocation', [], { ok: false });
    },
    verifyStorageMigration() {
      return ipc().invokeSync('verifyStorageMigration', [], { ok: false });
    },
    cleanupPreview() {
      return ipc().invokeSync('cleanupPreview', [], { ok: false, items: [] });
    },
    cleanupLegacy(input) {
      return ipc().invokeSync('cleanupLegacy', [input || {}], { ok: false });
    },
    backupStorage(input) {
      return ipc().invokeSync('backupStorage', [input || {}], { ok: false });
    },
    exportDiagnostics() {
      return ipc().invokeSync('exportStorageDiagnostics', [], { ok: false });
    },
    restoreStorage(input) {
      return ipc().invokeSync('restoreStorage', [input || {}], { ok: false });
    },
    relaunchApp() {
      return ipc().invokeSync('relaunchApp', [], { ok: false });
    },
    saveWorkflowRun(run) {
      return ipc().invokeSync('saveWorkflowRun', [run], { ok: false });
    },
    listWorkflowRuns(workflowId, limit) {
      return ipc().invokeSync('listWorkflowRuns', [workflowId, limit], { ok: false, runs: [] });
    },
  };
  // v1.1.0（M1）：糖码 Agent Run 历史桥（一期 agent.js 已引用 App.services.storage，此处补齐接线）
  App.services.storage = {
    listAgentRuns(threadId, limit, offset) {
      return ipc().invokeSync('listAgentRuns', [threadId, limit, offset], { ok: false, runs: [] });
    },
    listAgentEvents(runId) {
      return ipc().invokeSync('listAgentEvents', [runId], { ok: false, events: [] });
    },
    getAgentRunTree(rootRunId) {
      return ipc().invokeSync('getAgentRunTree', [rootRunId], { ok: false, tree: null });
    },
    tracePage(input) {
      return ipc().invokeSync('tracePage', [input || {}], { ok: false, items: [], nextCursor: null, hasMore: false, total: 0 });
    },
    getAgentRunMetrics(rootRunId) {
      return ipc().invokeSync('getAgentRunMetrics', [rootRunId], { ok: false, metrics: null });
    },
    exportAgentRun(runId) {
      return ipc().invokeSync('exportAgentRun', [runId], { ok: false });
    },
    exportAgentTrace(input) {
      return ipc().invokeSync('exportAgentTrace', [input || {}], { ok: false });
    },
    listAgentEvalTasks() {
      return ipc().invokeSync('listAgentEvalTasks', [], { ok: false, tasks: [] });
    },
    runAgentEval(payload) {
      return ipc().invokeSync('runAgentEval', [payload || {}], { ok: false, error: '环境不支持' });
    },
    getAgentSummary(threadId) {
      return ipc().invokeSync('getAgentSummary', [threadId], { ok: false, summary: null });
    },
    // v2（P1-C）：压缩后摘要落库
    saveAgentSummary(s) {
      return ipc().invokeSync('saveAgentSummary', [s], { ok: false });
    },
  };
})();
