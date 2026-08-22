'use strict';
/* 自 main.js 拆分（v1.1.8 批次 F）：糖码 Agent Run 域——运行历史查询/轨迹导出/受控评测/上下文摘要 IPC。
 * 纯工厂模式（同 createMainSkills 先例）：createMainAgentRuns(deps) 注册全部 agent:*runs IPC handler，
 * 并返回 createRunStoreProxy(getStorageService) 给 whenReady 的 configureAgentServer 注入 runStore。
 * deps 注入：safeHandle / app / dialog / getMainWindow / getStorageService / getAgentPort / LOCAL_TOKEN。 */
const fs = require('fs');
const path = require('path');
const ControlledEval = require('../core/agent-runtime/controlled-eval');

function createMainAgentRuns(deps) {
  const { safeHandle, app, dialog, getStorageService, getAgentPort, LOCAL_TOKEN } = deps;
  const mainWindow = () => (deps.getMainWindow ? deps.getMainWindow() : null);

let controlledEvalCount = 0; // v16（批量提速）：运行中的评测并发计数（上限 MAX_CONCURRENT_EVAL）
const MAX_CONCURRENT_EVAL = 3; // v16（批量提速）：评测并发上限，3 路并行（中转站限流下保守值）

// v1.1.0（M1）：糖码 Agent Run 历史查询（运行列表 / 事件轨迹 / 上下文摘要）
safeHandle('agent:listRuns', async (_e, threadId, limit, offset) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite', runs: [] };
    return { ok: true, runs: svc.listAgentRuns(threadId, limit, offset) };
  } catch (err) {
    return { ok: false, reason: 'list-agent-runs-error', runs: [], error: err && err.message ? err.message : String(err) };
  }
});

safeHandle('agent:runEvents', async (_e, runId) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite', events: [] };
    return { ok: true, events: svc.listAgentEvents(runId) };
  } catch (err) {
    return { ok: false, reason: 'list-agent-events-error', events: [], error: err && err.message ? err.message : String(err) };
  }
});

safeHandle('agent:runTree', async (_e, rootRunId) => {
  try {
    const svc = getStorageService();
    if (!svc || typeof svc.listAgentRunTree !== 'function') return { ok: false, reason: 'no-sqlite', tree: null };
    return { ok: true, tree: svc.listAgentRunTree(rootRunId) };
  } catch (err) { return { ok: false, reason: 'list-agent-run-tree-error', tree: null, error: err && err.message ? err.message : String(err) }; }
});

// v1.1.3：只读 Trace Inspector 查询，按根 Run 分页，避免一次性载入大型事件流。
safeHandle('agent:tracePage', async (_e, input) => {
  try {
    const svc = getStorageService();
    if (!svc || typeof svc.listAgentTracePage !== 'function') return { ok: false, reason: 'no-sqlite', items: [], nextCursor: null, hasMore: false, total: 0 };
    const opts = input && typeof input === 'object' ? input : {};
    return Object.assign({ ok: true }, svc.listAgentTracePage(String(opts.rootRunId || opts.runId || ''), opts));
  } catch (err) {
    return { ok: false, reason: 'agent-trace-page-error', items: [], nextCursor: null, hasMore: false, total: 0, error: err && err.message ? err.message : String(err) };
  }
});

safeHandle('agent:runMetrics', async (_e, rootRunId) => {
  try {
    const svc = getStorageService();
    if (!svc || typeof svc.aggregateAgentRunMetrics !== 'function') return { ok: false, reason: 'no-sqlite', metrics: null };
    return { ok: true, metrics: svc.aggregateAgentRunMetrics(String(rootRunId || '')) };
  } catch (err) { return { ok: false, reason: 'agent-run-metrics-error', metrics: null, error: err && err.message ? err.message : String(err) }; }
});

safeHandle('agent:exportRun', async (_e, runId) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite' };
    const jsonl = svc.exportAgentRun(String(runId || ''));
    if (!jsonl) return { ok: false, error: '未找到该运行记录' };
    const result = await dialog.showSaveDialog(mainWindow(), { title: '导出糖码运行轨迹', defaultPath: 'tangbao-run-' + String(runId || '').replace(/[^A-Za-z0-9_-]/g, '_') + '.jsonl', filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, jsonl, 'utf8');
    return { ok: true, filePath: result.filePath };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

safeHandle('agent:exportTrace', async (_e, input) => {
  try {
    const svc = getStorageService();
    if (!svc || typeof svc.exportAgentTrace !== 'function') return { ok: false, reason: 'no-sqlite' };
    const payload = input && typeof input === 'object' ? input : { rootRunId: input };
    const rootRunId = String(payload.rootRunId || payload.runId || '');
    const jsonl = svc.exportAgentTrace({ rootRunId, redacted: true });
    if (!jsonl) return { ok: false, error: '未找到该根运行记录' };
    const result = await dialog.showSaveDialog(mainWindow(), { title: '导出脱敏 Agent Trace', defaultPath: 'tangbao-trace-' + rootRunId.replace(/[^A-Za-z0-9_-]/g, '_') + '.jsonl', filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, jsonl, 'utf8');
    return { ok: true, filePath: result.filePath, redacted: true };
  } catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
});

// P0 Eval：受控主进程入口。渲染层只能选择白名单 taskId + 当前账户 ref/model，
// 不能传 cwd、base、token 或 fixture 路径；LOCAL_TOKEN 始终留在主进程。
safeHandle('agent:evalTasks', async () => {
  try {
    const tasks = ControlledEval.listSafeTasks(path.join(__dirname, '..', '..'));
    // v16（批量提速）：扫描 eval-runs 已落盘的 machinePassed 结果，标记 alreadyPassed 供面板跳过
    const passedIds = new Set();
    const latestPassedById = new Map();
    try {
      const runsRoot = path.join(app.getPath('userData'), 'tangbao-data', 'eval-runs');
      if (fs.existsSync(runsRoot)) {
        for (const dir of fs.readdirSync(runsRoot)) {
          const rp = path.join(runsRoot, dir, 'eval-result.json');
          if (!fs.existsSync(rp)) continue;
          try {
            const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
            if (r && r.machinePassed === true && r.id) {
              const id = String(r.id);
              passedIds.add(id);
              const prior = latestPassedById.get(id);
              if (!prior || String(r.at || '') > String(prior.at || '')) latestPassedById.set(id, r);
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    try {
      const dataRoot = path.join(app.getPath('userData'), 'tangbao-data');
      fs.mkdirSync(dataRoot, { recursive: true });
      const readiness = {
        at: new Date().toISOString(),
        runtimes: Object.fromEntries(Array.from(new Set(tasks.flatMap((task) => task.requiredRuntimes || []))).map((runtime) => [runtime, !tasks.some((task) => (task.missingRuntimes || []).includes(runtime))])),
      };
      fs.writeFileSync(path.join(dataRoot, 'eval-runtime-readiness.json'), JSON.stringify(readiness, null, 2), 'utf8');
    } catch (_) {}
    return {
      ok: true,
      tasks: tasks.map((t) => {
        const id = String(t.id);
        const latestPassed = latestPassedById.get(id);
        const metricIncomplete = !!(latestPassed && latestPassed.status === 'completed_by_judge' && !(Number(latestPassed.steps) > 0));
        return Object.assign({}, t, { alreadyPassed: passedIds.has(id), metricIncomplete });
      }),
    };
  } catch (err) { return { ok: false, tasks: [], error: err && err.message ? err.message : String(err) }; }
});

safeHandle('agent:runEval', async (_e, payload) => {
  if (controlledEvalCount >= MAX_CONCURRENT_EVAL) return { ok: false, error: '已有 ' + MAX_CONCURRENT_EVAL + ' 个安全评测在运行' };
  controlledEvalCount++;
  try {
    const agentPort = getAgentPort ? getAgentPort() : 0;
    if (!agentPort) return { ok: false, error: '糖码后端尚未启动' };
    const body = payload && typeof payload === 'object' ? payload : {};
    const appRoot = path.join(__dirname, '..', '..');
    const runsRoot = path.join(app.getPath('userData'), 'tangbao-data', 'eval-runs');
    const result = await ControlledEval.executeSafeTask({
      appRoot,
      runsRoot,
      taskId: body.taskId,
      ref: body.ref,
      model: body.model,
      base: `http://127.0.0.1:${agentPort}`,
      token: LOCAL_TOKEN,
    });
    const { runDir: _privateRunDir, ...publicResult } = result;
    return { ok: true, result: publicResult };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    controlledEvalCount--;
  }
});

safeHandle('agent:summary', async (_e, threadId) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite', summary: null };
    return { ok: true, summary: svc.getLatestContextSummary(threadId) };
  } catch (err) {
    return { ok: false, reason: 'get-agent-summary-error', summary: null, error: err && err.message ? err.message : String(err) };
  }
});

// v2（P1-C）：压缩完成后摘要落库（agent_context_summaries，重启后后端读回注入）
safeHandle('agent:saveSummary', async (_e, s) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite' };
    return { ok: true, saved: svc.saveContextSummary(s || {}) };
  } catch (err) {
    return { ok: false, reason: 'save-summary-error', error: err && err.message ? err.message : String(err) };
  }
});

  // v1.1.0（M1）：给糖码后端注入 Agent Run 持久化存储（lazy 代理，storage 就绪后生效；不可用则静默降级为无持久化模式）
  function createRunStoreProxy(svcGetter) {
    const runStoreMethods = ['createAgentRun', 'updateAgentRun', 'listAgentRuns', 'getAgentRun', 'listAgentRunTree', 'appendAgentEvent', 'listAgentEvents', 'upsertWorkingState', 'getWorkingState', 'saveAgentCheckpoint', 'getCheckpoint', 'listCheckpoints', 'saveContextSummary', 'getLatestContextSummary', 'saveChangeset', 'listChangesets', 'recordModelCallMetric', 'upsertAgentRunMetrics', 'aggregateAgentRunMetrics'];
    const runStoreProxy = {};
    runStoreMethods.forEach((m) => {
      runStoreProxy[m] = (...a) => {
        const svc = svcGetter();
        return (svc && typeof svc[m] === 'function') ? svc[m](...a) : null;
      };
    });
    // v1.1.0（M3）：文件仓 Artifact 桥（ChangeSet 快照/日志等大内容走 file-repo 磁盘）
    runStoreProxy.storeArtifact = (category, id, buf) => {
      try { const fr = require('../infrastructure/storage/file-repo'); fr.put(category, id, buf); return true; } catch (e) { return false; }
    };
    runStoreProxy.getArtifact = (category, id) => {
      try { const fr = require('../infrastructure/storage/file-repo'); const b = fr.get(category, id); return b ? b.toString('utf8') : null; } catch (e) { return null; }
    };
    return runStoreProxy;
  }

  return { createRunStoreProxy };
}

module.exports = { createMainAgentRuns };
