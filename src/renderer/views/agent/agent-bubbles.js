'use strict';
/* 自 agent.js 拆分（v1.1.7 批次 E）：公共辅助与 agent.js 主体同源，各拆分文件独立声明。
 * 通过 Object.assign 挂到 window.App.agent，保持对象字面量方法定义形式不变。 */
(function () {
  window.App = window.App || {};
  const $ = (id) => document.getElementById(id);
  const agentBase = () => (App.rt ? App.rt.agentBase() : '');
  const authHeaders = (extra) => (App.rt ? App.rt.authHeaders(extra) : (extra || {}));

  Object.assign(window.App.agent, {
    createUserMessage(text, skills) {
      const node = document.createElement('div');
      node.className = 'agent-msg user';
      const safeSkills = Array.isArray(skills) ? skills.filter((s) => s && s.name) : [];
      const tags = safeSkills.length
        ? '<div class="agent-message-skills">' + safeSkills.map((s) => '<span class="agent-message-skill"><span>✦</span>' + App.escapeHtml(s.name) + '</span>').join('') + '</div>'
        : '';
      node.innerHTML = tags + '<div class="agent-message-text">' + App.escapeHtml(text || '') + '</div>';
      return node;
    },
    appendUser(text, skills) {
      const thread = document.getElementById('agentThread');
      const empty = thread.querySelector('.agent-empty'); if (empty) empty.remove();
      const node = App.agent.createUserMessage(text, skills);
      thread.appendChild(node);
      thread.scrollTop = thread.scrollHeight;
      return node;
    },
    newToolBlock(name, args) {
      const thread = document.getElementById('agentThread');
      const block = document.createElement('div');
      block.className = 'agent-tool';
      const argStr = (args && Object.keys(args).length) ? JSON.stringify(args, null, 2) : '';
      block.innerHTML = `
        <div class="agent-tool-head">
          <span class="agent-tool-ico">⚙</span>
          <span class="agent-tool-name">${App.escapeHtml(name)}</span>
          <span class="agent-tool-status">⏳ 运行中…</span>
          <button class="agent-tool-toggle">▾</button>
        </div>
        <div class="agent-tool-body">
          ${argStr ? `<pre class="agent-tool-args">${App.escapeHtml(argStr)}</pre>` : ''}
          <pre class="agent-tool-out">等待执行…</pre>
          <div class="agent-approve" style="display:none">
            <div class="agent-approve-diff" style="display:none"></div>
            <span class="agent-approve-tip">该操作需要你的批准：</span>
            <div class="agent-approve-ops">
              <button class="btn-primary mini" data-ap="allow_once">批准</button>
              <button class="btn-ghost mini" data-ap="allow_run">本任务免问</button>
              <button class="btn-ghost mini danger" data-ap="reject_reason">拒绝并说明</button>
              <button class="btn-ghost mini danger" data-ap="reject">拒绝</button>
            </div>
          </div>
        </div>`;
      thread.appendChild(block);
      thread.scrollTop = thread.scrollHeight;
      block.querySelector('.agent-tool-toggle').addEventListener('click', () => {
        block.classList.toggle('collapsed');
      });
      block._startTime = Date.now(); // 记录开始时间，用于 setToolResult 展示耗时
      return block;
    },
    setToolResult(block, result, statusText) {
      if (!block) return;
      const out = block.querySelector('.agent-tool-out');
      // v1.1.0（M3）：结构化 ToolResult——用 ok/truncated/exitCode 判定，不再正则粗判
      const isObj = result && typeof result === 'object';
      const ok = isObj ? result.ok !== false : true;
      const truncated = isObj ? !!result.truncated : false;
      const exitCode = isObj && result.exitCode != null ? result.exitCode : null;
      const text = isObj ? (result.summary || (result.error && result.error.message) || '(空)') : (result || '(空)');
      if (out) out.textContent = text + (truncated ? '\n[输出已截断]' : '') + (exitCode != null ? '\n[退出码 ' + exitCode + ']' : '');
      const st = block.querySelector('.agent-tool-status');
      if (st) {
        const elapsed = block._startTime ? ((Date.now() - block._startTime) / 1000).toFixed(1) + 's' : '';
        st.textContent = (statusText || '完成') + (elapsed ? ' (' + elapsed + ')' : '');
        st.title = (ok ? '✅' : '❌') + ' ' + st.textContent;
      }
      const ico = block.querySelector('.agent-tool-ico');
      if (ico) ico.textContent = ok ? '✅' : '❌';
    },
    newSubagentBlock(ev) {
      const thread = document.getElementById('agentThread');
      const block = document.createElement('div');
      block.className = 'agent-tool agent-subagent type-' + App.escapeHtml(ev.type || 'explore');
      block.dataset.subid = ev.subId;
      const role = ev.role || ev.subagentType || ev.type;
      const typeLabel = role === 'test' ? '测试子代理' : (role === 'review' ? '审查子代理' : '探索子代理');
      block.innerHTML = `
        <div class="agent-tool-head">
          <span class="agent-tool-ico">◈</span>
          <span class="agent-tool-name">${typeLabel} ${App.escapeHtml(ev.subId || '')}</span>
          <span class="agent-tool-status">⏳ 运行中…</span>
          <button class="agent-tool-toggle">▾</button>
        </div>
        <div class="agent-tool-body">
          <div class="agent-subagent-goal">${App.escapeHtml(ev.goal || '')}</div>
          <pre class="agent-tool-out">等待结果…</pre>
        </div>`;
      thread.appendChild(block);
      thread.scrollTop = thread.scrollHeight;
      block.querySelector('.agent-tool-toggle').addEventListener('click', () => block.classList.toggle('collapsed'));
      block._startTime = Date.now();
      return block;
    },
    setSubagentResult(subId, ev) {
      const thread = document.getElementById('agentThread');
      const block = Array.from(thread.querySelectorAll('.agent-subagent')).find((b) => b.dataset.subid === subId);
      if (!block) return;
      const out = block.querySelector('.agent-tool-out');
      if (out) out.textContent = ev.summary || (ev.ok ? '完成' : '失败');
      const st = block.querySelector('.agent-tool-status');
      if (st) {
        const elapsed = block._startTime ? ((Date.now() - block._startTime) / 1000).toFixed(1) + 's' : '';
        st.textContent = (ev.ok ? '完成' : '失败') + (ev.steps ? ' · ' + ev.steps + ' 步' : '') + (ev.toolsUsed ? ' · ' + ev.toolsUsed + ' 次工具' : '') + (elapsed ? ' (' + elapsed + ')' : '');
      }
      const ico = block.querySelector('.agent-tool-ico');
      if (ico) ico.textContent = ev.ok ? '✓' : '✗';
      block.classList.add(ev.ok ? 'sub-ok' : 'sub-fail');
    },
    newSubagentBlock(ev) {
      const thread = document.getElementById('agentThread');
      const existing = thread && Array.from(thread.querySelectorAll('.agent-subagent')).find((b) => b.dataset.subid === ev.subId);
      if (existing) {
        const status = existing.querySelector('.agent-tool-status');
        if (status && ev.type === 'subagent_start') status.textContent = '⏳ 运行中…';
        existing.classList.remove('sub-queued');
        return existing;
      }
      if (!thread) return null;
      const block = document.createElement('div');
      const queued = ev.type === 'subagent_queued' || ev.status === 'queued';
      const role = ev.role || ev.subagentType || ev.type;
      block.className = 'agent-tool agent-subagent type-' + App.escapeHtml(role || 'explore') + (queued ? ' sub-queued' : '');
      block.dataset.subid = ev.subId;
      const typeLabel = role === 'test' ? '测试子代理' : (role === 'review' ? '审查子代理' : '探索子代理');
      block.innerHTML = `<div class="agent-tool-head"><span class="agent-tool-ico">◈</span><span class="agent-tool-name">${typeLabel} ${App.escapeHtml(ev.subId || '')}</span><span class="agent-tool-status">${queued ? '⏱ 排队中…' : '⏳ 运行中…'}</span><button class="agent-tool-toggle">▾</button></div><div class="agent-tool-body"><div class="agent-subagent-goal">${App.escapeHtml(ev.goal || '')}</div><pre class="agent-tool-out">${queued ? '等待并发槽位…' : '等待结果…'}</pre><div class="agent-subagent-details"></div></div>`;
      thread.appendChild(block);
      thread.scrollTop = thread.scrollHeight;
      block.querySelector('.agent-tool-toggle').addEventListener('click', () => block.classList.toggle('collapsed'));
      block._startTime = ev.startedAt || (queued ? null : Date.now());
      return block;
    },
    setSubagentResult(subId, ev) {
      const thread = document.getElementById('agentThread');
      const block = thread && Array.from(thread.querySelectorAll('.agent-subagent')).find((b) => b.dataset.subid === subId);
      if (!block) return;
      const result = ev.result && typeof ev.result === 'object' ? ev.result : ev;
      const out = block.querySelector('.agent-tool-out');
      if (out) out.textContent = result.summary || (result.ok ? '完成' : '失败');
      const status = result.ok ? '完成' : (ev.status === 'cancelled' ? '已取消' : '失败');
      const st = block.querySelector('.agent-tool-status');
      if (st) {
        const elapsed = result.durationMs ? ((Number(result.durationMs) || 0) / 1000).toFixed(1) + 's' : (block._startTime ? ((Date.now() - block._startTime) / 1000).toFixed(1) + 's' : '');
        st.textContent = status + (result.steps ? ' · ' + result.steps + ' 步' : '') + (result.toolsUsed ? ' · ' + result.toolsUsed + ' 次工具' : '') + (elapsed ? ' (' + elapsed + ')' : '');
      }
      const ico = block.querySelector('.agent-tool-ico');
      if (ico) ico.textContent = result.ok ? '✓' : (ev.status === 'cancelled' ? '!' : '✗');
      const detail = block.querySelector('.agent-subagent-details');
      if (detail) {
        const findings = Array.isArray(result.findings) ? result.findings : [];
        const checks = Array.isArray(result.checks) ? result.checks : [];
        const findingHtml = findings.map((f) => `<div class="agent-subagent-finding"><b>${App.escapeHtml(f.severity || 'info')} · ${App.escapeHtml(f.title || '发现')}</b><div>${App.escapeHtml(f.detail || '')}</div>${(f.evidence || []).map((e) => `<code>${App.escapeHtml(e.path || '')}:${e.startLine || 0}-${e.endLine || 0}</code>`).join(' ')}</div>`).join('');
        const checkHtml = checks.map((c) => `<div class="agent-subagent-check ${App.escapeHtml(c.status || 'skipped')}">${App.escapeHtml(c.status || 'skipped')} · ${App.escapeHtml(c.name || '')}${c.detail ? ' · ' + App.escapeHtml(c.detail) : ''}</div>`).join('');
        detail.innerHTML = (findingHtml || checkHtml || result.error ? `<div class="agent-subagent-detail-title">协作详情</div>${findingHtml}${checkHtml}${result.error ? `<div class="agent-subagent-error">${App.escapeHtml(result.error.message || result.error.code || result.error)}</div>` : ''}` : '');
      }
      block.classList.add(result.ok ? 'sub-ok' : 'sub-fail');
      block.classList.remove('sub-queued');
    },
    newAssistant() {
      const thread = document.getElementById('agentThread');
      const node = document.createElement('div');
      node.className = 'agent-msg assistant';
      node.innerHTML = '<div class="agent-answer"></div>';
      thread.appendChild(node);
      thread.scrollTop = thread.scrollHeight;
      return node.querySelector('.agent-answer');
    },
    appendThinking(text) {
      const thread = document.getElementById('agentThread');
      const node = document.createElement('div');
      node.className = 'agent-think';
      node.textContent = text;
      thread.appendChild(node);
      thread.scrollTop = thread.scrollHeight;
    },
    setError(msg) {
      const thread = document.getElementById('agentThread');
      const node = document.createElement('div');
      node.className = 'agent-msg assistant';
      node.innerHTML = `<div class="agent-answer error">${App.escapeHtml(msg)}</div>`;
      thread.appendChild(node);
      thread.scrollTop = thread.scrollHeight;
    }
  });
})();
