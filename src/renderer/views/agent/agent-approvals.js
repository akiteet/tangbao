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
    showApprovalGlobal(callId, command, extra) {
      App.agent._uxTrack('approval');
      const old = document.getElementById('agentApprovalBar');
      if (old) old.remove();
      const bar = document.createElement('div');
      bar.className = 'agent-approval-bar';
      bar.id = 'agentApprovalBar';
      const diffs = (extra && Array.isArray(extra.diffs) && extra.diffs.length) ? extra.diffs : null;
      const diffHtml = diffs ? diffs.map((d) => `
          <div class="agent-approval-diff-file">${App.escapeHtml(d.path)}</div>
          <div class="agent-diff">${(d.diff || []).map((ln) => {
            const sign = ln.type === '+' ? '+' : (ln.type === '-' ? '-' : ' ');
            const cls = ln.type === '+' ? 'add' : (ln.type === '-' ? 'del' : 'ctx');
            return `<div class="agent-diff-line ${cls}">${sign} ${App.escapeHtml(ln.text)}</div>`;
          }).join('')}</div>`).join('') : '';
      // v2（UX）：影响文件与 Skill 来源上下文（渐进披露：默认一行，可展开）
      const toolLabel = (extra && extra.toolName) ? '<span class="agent-approval-bar-tag">' + App.escapeHtml(String(extra.toolName).replace(/_/g, ' ')) + '</span>' : '';
      const fileHint = (extra && (extra.filePath || extra.extraPath))
        ? '<div class="agent-approval-bar-meta">影响文件：<code>' + App.escapeHtml(String(extra.filePath || extra.extraPath)) + '</code></div>' : '';
      const attr = App.agent._lastAttribution;
      let attrHtml = '';
      if (attr && (attr.activeSkills || []).length) {
        const skillNames = attr.activeSkills.map((n) => App.escapeHtml(n)).join('、');
        const modeLabel = attr.allowedBy && attr.allowedBy.length ? '（声明允许）' : '（未声明此工具）';
        const hashInfo = (attr.allowedBy && attr.allowedBy.length && attr.activeSkills.length)
          ? ' · 包哈希 ' + App.escapeHtml(String(attr.packageHash || '').slice(0, 8)) : '';
        attrHtml = '<div class="agent-approval-bar-meta">Skill 来源：<code>' + skillNames + '</code>' + modeLabel + hashInfo + '</div>';
      }
      bar.innerHTML = `
        <div class="agent-approval-bar-main">
          ${toolLabel}
          <span class="agent-approval-bar-tag">审批</span>
          <span class="agent-approval-bar-cmd" title="${App.escapeHtml(String(command || ''))}">${App.escapeHtml(String(command || '该操作需要你的批准').slice(0, 140))}</span>
          ${diffs ? '<button class="agent-approval-bar-toggle" type="button">查看变更</button>' : ''}
        </div>
        ${fileHint}
        ${attrHtml}
        ${diffs ? `<div class="agent-approval-bar-diff" style="display:none">${diffHtml}</div>` : ''}
        <div class="agent-approval-bar-ops">
          <button class="btn-primary mini" data-ap="allow_once" title="仅批准本次操作">批准</button>
          <button class="btn-ghost mini" data-ap="allow_run" title="本次任务内不再逐次询问">本任务免问</button>
          ${App.agent.activeProject() && App.agent.activeProject().cwd
            ? '<button class="btn-ghost mini" data-ap="allow_rule" title="写入项目权限规则：该工具/命令总是允许（保存到 .tangbao/permissions.json）">总是允许</button>' +
              '<button class="btn-ghost mini danger" data-ap="reject_rule" title="写入项目权限规则：该工具/命令总是拒绝">总是拒绝</button>'
            : ''}
          <button class="btn-ghost mini danger" data-ap="reject_reason" title="拒绝并填写原因，帮助糖码调整方案">拒绝并说明</button>
          <button class="btn-ghost mini danger" data-ap="reject">拒绝</button>
        </div>`;
      document.body.appendChild(bar);
      // v2（补全）：动态 bottom——悬浮于输入区上方，不遮输入
      App.agent.updateApprovalBarPosition();
      const toggle = bar.querySelector('.agent-approval-bar-toggle');
      if (toggle) toggle.addEventListener('click', () => {
        const d = bar.querySelector('.agent-approval-bar-diff');
        if (d) {
          const show = d.style.display !== 'block';
          d.style.display = show ? 'block' : 'none';
          toggle.textContent = show ? '收起变更' : '查看变更';
        }
      });
      bar.querySelectorAll('button[data-ap]').forEach((b) => {
        b.addEventListener('click', async () => {
          const decision = b.dataset.ap;
          let reason = '';
          // v2（UX）：拒绝并说明原因——先收集原因再提交
          if (decision === 'reject_reason') {
            reason = (window.prompt('拒绝原因（可选，将帮助糖码调整方案）：', '') || '').trim();
            if (!reason) { App.ui.toast('已按「拒绝」处理（未填写原因）'); }
          }
          bar.remove();
          // v2（权限大改）+G17（B1）：总是允许/总是拒绝/本任务免问——写项目规则（<cwd>/.tangbao/permissions.json）并即时生效
          if (decision === 'allow_rule' || decision === 'reject_rule' || decision === 'allow_run') {
            const proj = App.agent.activeProject();
            const tool = (extra && extra.toolName) ? extra.toolName : 'run_command';
            const pattern = (tool === 'run_command' || tool === 'git_command') ? String(command || '') : '';
            if (proj && proj.cwd) {
              const rule = { id: App.uid(), tool, pattern, path: '', allow: decision !== 'reject_rule', force: false, scope: 'project' };
              const rules = [].concat(Array.isArray(proj.permissionRules) ? proj.permissionRules : [], [rule]);
              try {
                await fetch(agentBase() + '/api/permissions', {
                  method: 'PUT', headers: authHeaders({ 'Content-Type': 'application/json' }),
                  body: JSON.stringify({ cwd: proj.cwd, workspaceId: proj.workspaceId, rules }),
                });
                proj.permissionRules = rules;
                App.persist();
                App.ui.toast(decision === 'reject_rule' ? '已写入「总是拒绝」规则' : (decision === 'allow_run' ? '已写入「总是允许」规则（本任务免问）' : '已写入「总是允许」规则（下次运行生效）'));
              } catch (e) { App.ui.toast('规则写入失败：' + (e.message || e)); }
            }
          }
          await App.agent.approveRequest(callId, decision === 'reject_reason' ? 'reject' : decision, reason, decision === 'allow_run');
        });
      });
    },
    showMemorySuggestion(text) {
      if (!text) return;
      const old = document.getElementById('agentMemCard');
      if (old) old.remove();
      const proj = App.agent.activeProject();
      const card = document.createElement('div');
      card.id = 'agentMemCard';
      card.className = 'agent-mem-card';
      card.innerHTML = `
        <div class="agent-mem-card-title">糖码建议记忆</div>
        <div class="agent-mem-card-text">${App.escapeHtml(text)}</div>
        <div class="agent-mem-card-ops">
          <button class="btn-primary mini" id="memConfirm">确认写入</button>
          <button class="btn-ghost mini" id="memIgnore">忽略</button>
        </div>`;
      document.body.appendChild(card);
      const close = () => card.remove();
      card.querySelector('#memIgnore').onclick = close;
      card.querySelector('#memConfirm').onclick = async () => {
        close();
        if (!proj || !proj.cwd) { App.ui.toast('当前项目无工作目录，无法写入记忆'); return; }
        try {
          const b = agentBase();
          const hdrs = authHeaders({ 'Content-Type': 'application/json' });
          const cur = await fetch(b + '/api/memory?cwd=' + encodeURIComponent(proj.cwd) + '&workspaceId=' + encodeURIComponent(proj.workspaceId || ''), { headers: hdrs }).then(r => r.json()).catch(() => ({}));
          const prev = (cur && cur.content) ? String(cur.content).trim() : '';
          const next = prev ? prev + '\n\n' + text : text;
          const put = await fetch(b + '/api/memory', { method: 'PUT', headers: hdrs, body: JSON.stringify({ cwd: proj.cwd, workspaceId: proj.workspaceId, content: next }) }).then(r => r.json()).catch(() => ({}));
          App.ui.toast((put && put.ok) ? '记忆已写入 糖码记忆.md（下次运行生效）' : '记忆写入失败');
        } catch (e) { App.ui.toast('记忆写入失败：' + (e.message || e)); }
      };
    },
    wireApproval(block, callId, extra) {
      App.agent._uxTrack('approveInline');
      const box = block.querySelector('.agent-approve');
      if (!box) return;
      // v1.1.0（M3）：写前 Diff 预览（apply_patch 审批时后端随事件下发 diffs）
      const diffBox = box.querySelector('.agent-approve-diff');
      if (diffBox && extra && Array.isArray(extra.diffs) && extra.diffs.length) {
        diffBox.style.display = 'block';
        diffBox.innerHTML = extra.diffs.map((d) => `
          <div class="agent-approve-diff-file">${App.escapeHtml(d.path)}</div>
          <div class="agent-diff">${(d.diff || []).map((ln) => {
            const sign = ln.type === '+' ? '+' : (ln.type === '-' ? '-' : ' ');
            const cls = ln.type === '+' ? 'add' : (ln.type === '-' ? 'del' : 'ctx');
            return `<div class="agent-diff-line ${cls}">${sign} ${App.escapeHtml(ln.text)}</div>`;
          }).join('')}</div>`).join('');
      }
      box.style.display = 'flex';
      box.querySelectorAll('button[data-ap]').forEach(b => {
        b.addEventListener('click', async () => {
          let decision = b.dataset.ap;
          let reason = '';
          if (decision === 'reject_reason') {
            reason = (window.prompt('拒绝原因（可选，将帮助糖码调整方案）：', '') || '').trim();
            if (!reason) { App.ui.toast('已按「拒绝」处理（未填写原因）'); }
            decision = 'reject';
          }
          const approved = decision !== 'reject';
          box.style.display = 'none';
          const st = block.querySelector('.agent-tool-status');
          if (st) st.textContent = approved ? '已批准，执行中…' : ('已拒绝' + (reason ? '：' + reason.slice(0, 60) : ''));
          try {
            await fetch(agentBase() + '/api/agent/approve', {
              method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ callId, approved, decision, reason: reason || '' }),
            });
          } catch (e) {}
        });
      });
    },
    setPlanBadge(text) {
      const badge = document.getElementById('agentPlanBadge');
      if (badge) { badge.textContent = 'Plan ' + (text || '执行'); badge.className = 'agent-status plan-badge on'; }
    },
    resetPlanBadge() {
      App.agent._planApproved = false;
      const proj = App.agent.activeProject();
      const badge = document.getElementById('agentPlanBadge');
      if (badge && proj) {
        badge.textContent = 'Plan ' + (proj.planMode ? '只读' : '执行');
        badge.className = 'agent-status plan-badge ' + (proj.planMode ? 'on' : 'off');
      }
    },
    showPlanApproval(ev) {
      App.agent.removeCard('agentPlanApprove');
      const thread = document.getElementById('agentThread');
      if (!thread) return;
      const card = document.createElement('div');
      card.id = 'agentPlanApprove';
      card.className = 'agent-plan-approve';
      const items = (ev && Array.isArray(ev.todos) && ev.todos.length)
        ? ev.todos.map((t) => '<div class="agent-plan-item">' + App.escapeHtml(String((t && t.content) || '')) + '</div>').join('')
        : '<div class="agent-plan-item">（模型尚未产出任务清单，批准后将直接进入执行模式）</div>';
      card.innerHTML = `
        <div class="agent-plan-title">📋 计划待批准</div>
        <div class="agent-plan-sub">模型将执行以下任务，批准后自动切换到执行模式：</div>
        <div class="agent-plan-list">${items}</div>
        <div class="agent-plan-ops">
          <button class="btn-primary mini" data-pa="approve">批准请求</button>
          <button class="btn-ghost mini" data-pa="reject">调整计划</button>
        </div>`;
      thread.appendChild(card);
      thread.scrollTop = thread.scrollHeight;
      card.querySelectorAll('[data-pa]').forEach((b) => b.addEventListener('click', () => {
        const callId = ev && ev.callId;
        if (!callId) return;
        const decision = b.dataset.pa === 'approve' ? 'allow_run' : 'reject';
        App.agent.approveRequest(callId, decision, '', false);
        App.agent.removeCard('agentPlanApprove');
        App.ui.toast(decision === 'allow_run' ? '已批准计划，模型开始执行' : '已通知模型调整计划');
      }));
    },
    showPlanExit(ev) {
      App.agent.removeCard('agentPlanExit');
      const thread = document.getElementById('agentThread');
      if (!thread) return;
      const card = document.createElement('div');
      card.id = 'agentPlanExit';
      card.className = 'agent-plan-approve';
      card.innerHTML = `
        <div class="agent-plan-title">⚠️ 完成门拦截</div>
        <div class="agent-plan-sub">任务持续无进展，仍处于 Plan 只读模式。可退出计划模式继续修复，或调整方案。</div>
        <div class="agent-plan-ops">
          <button class="btn-primary mini" data-pe="1">退出计划模式并继续修复</button>
          <button class="btn-ghost mini" data-pe="0">暂不退出</button>
        </div>`;
      thread.appendChild(card);
      thread.scrollTop = thread.scrollHeight;
      card.querySelectorAll('[data-pe]').forEach((b) => b.addEventListener('click', () => {
        const callId = ev && ev.callId;
        const exit = b.dataset.pe === '1';
        if (callId) App.agent.approveRequest(callId, exit ? 'allow_run' : 'reject', '', false);
        App.agent.removeCard('agentPlanExit');
        App.ui.toast(exit ? '已退出计划模式，继续修复' : '保持计划模式');
      }));
    },
    showDecisionCard(ev) {
      App.agent.removeCard('agentDecision');
      const thread = document.getElementById('agentThread');
      if (!thread) return;
      const multiSelect = !!(ev && ev.multiSelect);
      const opts = (ev && Array.isArray(ev.options) && ev.options.length) ? ev.options : [];
      const card = document.createElement('div');
      card.id = 'agentDecision';
      card.className = 'agent-decision';
      const optHtml = opts.length
        ? opts.map((o) => `
            <label class="agent-decision-opt">
              <input type="${multiSelect ? 'checkbox' : 'radio'}" name="agentDecisionOpt" data-opt="1" value="${App.escapeHtml(String(o))}">
              <span>${App.escapeHtml(String(o))}</span>
            </label>`).join('')
        : '';
      card.innerHTML = `
        <div class="agent-decision-title">❓ ${App.escapeHtml(String((ev && ev.question) || '请确认'))}</div>
        ${ev && ev.context ? `<div class="agent-decision-ctx">${App.escapeHtml(String(ev.context))}</div>` : ''}
        ${optHtml ? `<div class="agent-decision-opts">${optHtml}</div>` : ''}
        <div class="agent-decision-custom"><input data-custom="1" type="text" placeholder="${multiSelect ? '自定义补充（可选，追加到选择）' : '自定义答案（输入后优先采用）'}"></div>
        <div class="agent-decision-ops"><button class="btn-primary mini" data-decision-submit="1">提交答复</button></div>`;
      thread.appendChild(card);
      thread.scrollTop = thread.scrollHeight;
      const btn = card.querySelector('[data-decision-submit]');
      if (btn) btn.addEventListener('click', () => App.agent.submitDecision(ev && ev.id, multiSelect));
    },
    async submitDecision(id, multiSelect) {
      const card = document.getElementById('agentDecision');
      if (!card || !id) return;
      const sel = Array.from(card.querySelectorAll('input[data-opt]:checked')).map((i) => i.value);
      const customEl = card.querySelector('[data-custom]');
      const custom = customEl ? customEl.value.trim() : '';
      let answer;
      if (multiSelect) {
        answer = custom ? sel.concat(custom) : sel;
      } else {
        answer = custom || (sel.length ? sel[0] : '');
      }
      if (multiSelect && !answer.length) { App.ui.toast('请至少选择一项或填写自定义答案'); return; }
      try {
        await fetch(agentBase() + '/api/agent/decision', {
          method: 'POST', headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ id, answer }),
        });
      } catch (e) {}
      App.agent.removeCard('agentDecision');
      App.ui.toast('已提交答复');
    }
  });
})();
