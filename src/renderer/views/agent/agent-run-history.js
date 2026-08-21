'use strict';
/* 自 agent.js 拆分（v1.1.7 批次 E）：公共辅助与 agent.js 主体同源，各拆分文件独立声明。
 * 通过 Object.assign 挂到 window.App.agent，保持对象字面量方法定义形式不变。 */
(function () {
  window.App = window.App || {};
  const $ = (id) => document.getElementById(id);
  const agentBase = () => (App.rt ? App.rt.agentBase() : '');
  const authHeaders = (extra) => (App.rt ? App.rt.authHeaders(extra) : (extra || {}));

  Object.assign(window.App.agent, {
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
          const metric = run.metrics || {};
          const cache = metric.cache || {};
          const cost = metric.cost || {};
          const numberOrNull = (value) => value == null || !Number.isFinite(Number(value)) ? null : Number(value);
          const formatTokens = (value) => { const n = numberOrNull(value); return n == null ? '未知' : Math.round(n / 1000 * 10) / 10 + 'k'; };
          const formatCost = (value) => { const n = numberOrNull(value); return n == null ? '未知' : '$' + n.toFixed(4); };
          const formatDuration = (value) => { const n = numberOrNull(value); return n == null ? '未知' : (n < 1000 ? Math.round(n) + 'ms' : (n / 1000).toFixed(1) + 's'); };
          const steps = numberOrNull(metric.steps != null ? metric.steps : u.steps);
          const toolCalls = numberOrNull(metric.toolCalls != null ? metric.toolCalls : u.toolCalls);
          const failures = metric.errorBreakdown
            ? Object.values(metric.errorBreakdown).reduce((sum, value) => sum + (Number(value) || 0), 0)
            : numberOrNull(u.failures);
          const metricCost = cost.totalUsd != null ? cost.totalUsd : metric.costUsd;
          const cacheRate = numberOrNull(cache.hitRate);
          const cacheLabel = cacheRate == null
            ? 'cache unknown'
            : 'cache ' + Math.round(cacheRate * 1000) / 10 + '%';
          const costLabel = 'cost ' + formatCost(metricCost)
            + (cost.source && cost.source !== 'unknown' ? ' (' + cost.source + ')' : '')
            + (cost.unknownReason ? ' · ' + cost.unknownReason : '');
          const badge = (run.status === 'completed' || run.status === 'done') ? '<span class="ok">完成</span>'
            : run.status === 'failed' ? '<span class="error">失败</span>'
            : run.status === 'stopped' ? '<span class="warn">已停止</span>'
            : run.status === 'blocked' ? '<span class="warn">受阻</span>'
            : run.status === 'budget_exhausted' ? '<span class="warn">预算耗尽</span>'
            : `<span class="warn">${App.escapeHtml(run.status || 'running')}</span>`;
          const phaseTag = run.phase ? ` <span class="wf-hist-phase">${App.escapeHtml(run.phase)}</span>` : '';
          const roleLabel = run.parentRunId ? ({ explore: 'Explore', test: 'Test', review: 'Review' }[run.role] || 'Child') : 'Main';
          const roleTag = ` <span class="wf-hist-phase">${roleLabel}${run.parentRunId ? ' · 只读' : ''}</span>`;
          const metricMeta = [
            fmtTime(run.startedAt),
            steps == null ? 'steps unknown' : steps + ' steps',
            toolCalls == null ? 'tools unknown' : toolCalls + ' tools',
            fmtDur(run.startedAt, run.finishedAt) || 'duration unknown',
            formatTokens(metric.inputTokens != null ? metric.inputTokens : u.inputTokens) + ' in / ' + formatTokens(metric.outputTokens != null ? metric.outputTokens : u.outputTokens) + ' out',
            cacheLabel,
            costLabel,
            metric.queueWaitMs == null ? 'queue unknown' : 'queue ' + formatDuration(metric.queueWaitMs),
            failures ? failures + ' failures' : '',
          ].filter(Boolean).join(' · ');
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
            <span class="wf-hist-meta">${App.escapeHtml(metricMeta)}</span>
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
           const metricCost = metrics.cost || {};
           const costSource = metricCost.source || (metrics.costUsd == null ? 'unknown' : 'legacy');
           const costReason = metricCost.unknownReason ? ' · ' + metricCost.unknownReason : '';
           metricsBox.insertAdjacentHTML('beforeend', `<div class="agent-trace-metric wide"><b>Cost source</b><span>${App.escapeHtml(costSource)}${App.escapeHtml(costReason)}</span></div>`);
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
            const stat = (run, events) => {
              const metric = run.metrics || {};
              const usage = run.usage || {};
              const cache = metric.cache || {};
              const cost = metric.cost || {};
              const token = (value) => value == null ? 'unknown' : String(value);
              const money = (value) => value == null ? 'unknown' : '$' + Number(value).toFixed(4);
              return {
                status: run.status || 'running', phase: run.phase || '-',
                steps: metric.steps != null ? metric.steps : (usage.steps || 0),
                tools: metric.toolCalls != null ? metric.toolCalls : events.filter((e) => e.type === 'tool_call').length,
                fails: usage.failures != null ? usage.failures : (metric.errorBreakdown ? Object.values(metric.errorBreakdown).reduce((sum, value) => sum + Number(value || 0), 0) : events.filter((e) => e.type === 'tool_result' && e.payload && e.payload.result && e.payload.result.ok === false).length),
                approvals: (usage.approvals) || 0,
                inputTokens: token(metric.inputTokens != null ? metric.inputTokens : usage.inputTokens),
                outputTokens: token(metric.outputTokens != null ? metric.outputTokens : usage.outputTokens),
                cache: cache.hitRate == null ? 'unknown' : Math.round(Number(cache.hitRate) * 1000) / 10 + '%',
                cacheSaved: token(cache.savedTokens),
                cost: money(cost.totalUsd != null ? cost.totalUsd : metric.costUsd),
                queue: metric.queueWaitMs == null ? 'unknown' : metric.queueWaitMs + 'ms',
                latency: metric.latencyMs == null ? ((run.startedAt && run.finishedAt && run.finishedAt >= run.startedAt) ? (((run.finishedAt - run.startedAt) / 1000).toFixed(1) + 's') : '-') : metric.latencyMs + 'ms',
                dur: (run.startedAt && run.finishedAt && run.finishedAt >= run.startedAt) ? (((run.finishedAt - run.startedAt) / 1000).toFixed(1) + 's') : '-',
              };
            };
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
              + row('Input tokens', cur.inputTokens, pv.inputTokens)
              + row('Output tokens', cur.outputTokens, pv.outputTokens)
              + row('Cache hit', cur.cache, pv.cache)
              + row('Cache saved', cur.cacheSaved, pv.cacheSaved)
              + row('Cost', cur.cost, pv.cost)
              + row('Queue wait', cur.queue, pv.queue)
              + row('Latency', cur.latency, pv.latency)
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
    }
  });
})();
