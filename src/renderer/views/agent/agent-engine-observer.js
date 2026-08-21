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
      const runtimeVersion = formatVersion(run && run.runtimeVersion, 'v1.1.4');
      const rawToolset = String((run && run.toolsetVersion) || '');
      const toolsetVersion = formatVersion(rawToolset.split(':')[0], 'v1.1.4');
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
    }
  });
})();
