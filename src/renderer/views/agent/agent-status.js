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
    showStatusRunning() {
      const box = document.getElementById('agentStatusSummary');
      if (!box) return;
      if (App.agent._compactTimer) { clearTimeout(App.agent._compactTimer); App.agent._compactTimer = null; }
      App.agent.renderStatusSummary('running');
      App.agent.renderEngineStrip();
    },
    showStatusCompact(detail) {
      App.agent.renderStatusSummary('compact', detail);
      if (App.agent._compactTimer) clearTimeout(App.agent._compactTimer);
      App.agent._compactTimer = setTimeout(() => App.agent.hideStatusSummary(), 6000);
    },
    clearRunState() {
      if (App.agent._runPillTimer) { clearInterval(App.agent._runPillTimer); App.agent._runPillTimer = null; }
      App.agent._runState = null;
      const pill = document.getElementById('agentRunPill');
      if (pill) pill.hidden = true;
      App.agent.renderEngineStrip();
    },
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
    resumeLastRun() {
      const t = App.agent.activeThread();
      const rs = App.agent._runState;
      App.agent.resumeRun((t && t.lastRunId) || (rs && rs.runId) || '');
    }
  });
})();
