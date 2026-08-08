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
    // 聊天修复：关闭前同步落盘（sendSync 阻塞等待）
    flushStorageSync(json) {
      try { return (window.electron && window.electron.flushStorageSync) ? window.electron.flushStorageSync(json) : { ok: false }; } catch (e) { return { ok: false }; }
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
  // v1.1.0（M1）：糖码 Agent Run 历史桥（一期 agent.js 已引用 App.services.storage，此处补齐接线）
  App.services.storage = {
    listAgentRuns(threadId, limit, offset) {
      try { return (window.electron && window.electron.listAgentRuns) ? window.electron.listAgentRuns(threadId, limit, offset) : { ok: false, runs: [] }; } catch (e) { return { ok: false, runs: [] }; }
    },
    listAgentEvents(runId) {
      try { return (window.electron && window.electron.listAgentEvents) ? window.electron.listAgentEvents(runId) : { ok: false, events: [] }; } catch (e) { return { ok: false, events: [] }; }
    },
    exportAgentRun(runId) {
      try { return (window.electron && window.electron.exportAgentRun) ? window.electron.exportAgentRun(runId) : { ok: false }; } catch (e) { return { ok: false }; }
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
