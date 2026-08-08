'use strict';
/*
 * 糖码 v2（对照评测）：外部 Agent 同任务对比框架。
 *
 * 纯函数模块：不依赖文件系统以外的状态，便于单元测试。
 *
 * 输入约定：
 *   self    —— 糖码评测报告（benchmarks/last-eval.json 或相同形状），results[i] 含
 *              machinePassed（新）或 status==='done' && judgment.ok（旧回退）
 *   traces  —— 外部 Agent 轨迹，形如 { [agentName]: { [taskId]: TraitResult } }
 *              TraitResult: { passed, steps?, toolCalls?, failures?, durationMs? }
 *   tasks   —— 对比任务清单 [{ id, title }]
 *
 * 输出：
 *   { rows, stats, agents }
 *   rows   —— 每任务一行，含各 agent 的判定与指标
 *   stats  —— 每 agent 的通过率/平均步骤/平均失败/平均耗时
 */
function agentPassed(result) {
  if (!result) return null;
  if (typeof result.machinePassed === 'boolean') return result.machinePassed;
  if (typeof result.passed === 'boolean') return result.passed;
  // 旧报告回退：status==='done' 且 judgment.ok
  if (result.status === 'done' && result.judgment) return !!result.judgment.ok;
  if (result.status === 'done') return true;
  return null;
}

function pickNumber(result, key) {
  if (!result) return null;
  const v = result[key];
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function buildComparison(input) {
  const opts = input || {};
  const tasks = Array.isArray(opts.tasks) ? opts.tasks : [];
  const self = (opts.self && Array.isArray(opts.self.results)) ? opts.self.results : [];
  const traces = (opts.traces && typeof opts.traces === 'object') ? opts.traces : {};
  const agents = ['糖码'].concat(Object.keys(traces).filter((name) => name && name !== '糖码'));

  const selfById = {};
  for (const r of self) { if (r && r.id) selfById[r.id] = r; }

  const rows = tasks.map((task) => {
    const entry = { taskId: task.id, title: task.title || '', agents: {} };
    entry.agents['糖码'] = {
      passed: agentPassed(selfById[task.id]),
      steps: pickNumber(selfById[task.id], 'steps'),
      toolCalls: pickNumber(selfById[task.id], 'toolCalls'),
      failures: pickNumber(selfById[task.id], 'failures'),
      durationMs: pickNumber(selfById[task.id], 'durationMs'),
    };
    for (const name of Object.keys(traces)) {
      const r = traces[name] && traces[name][task.id];
      entry.agents[name] = {
        passed: agentPassed(r),
        steps: pickNumber(r, 'steps'),
        toolCalls: pickNumber(r, 'toolCalls'),
        failures: pickNumber(r, 'failures'),
        durationMs: pickNumber(r, 'durationMs'),
      };
    }
    return entry;
  });

  const stats = {};
  for (const agent of agents) {
    const judged = rows.map((r) => r.agents[agent] && r.agents[agent].passed).filter((v) => v !== null);
    const passed = judged.filter(Boolean).length;
    const sum = (key) => {
      const vals = rows.map((r) => r.agents[agent] && r.agents[agent][key]).filter((v) => typeof v === 'number');
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };
    const avg = (key) => {
      const vals = rows.map((r) => r.agents[agent] && r.agents[agent][key]).filter((v) => typeof v === 'number');
      return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
    };
    stats[agent] = {
      judged: judged.length,
      passed,
      passRate: judged.length ? Math.round((passed / judged.length) * 1000) / 1000 : null,
      avgSteps: avg('steps'),
      avgToolCalls: avg('toolCalls'),
      avgFailures: avg('failures'),
      avgDurationMs: avg('durationMs'),
      totalToolCalls: sum('toolCalls'),
    };
  }

  return { rows, stats, agents };
}

module.exports = { buildComparison, agentPassed };
