'use strict';

function verificationKey(kind, command) {
  return String(kind || 'verification') + '::' + String(command || '').trim();
}

function normalizeCheckResults(check) {
  const c = check || {};
  const commands = Array.isArray(c.commands) ? c.commands : [];
  const results = Array.isArray(c.results) && c.results.length
    ? c.results
    : commands.map((command) => ({ command, ok: c.ok !== false }));
  return results.map((result) => ({
    kind: String(c.kind || 'verification'),
    command: String((result && result.command) || ''),
    ok: !!(result && result.ok),
    exitCode: result && result.exitCode,
    output: String((result && result.output) || ''),
    at: Number(c.at) || Date.now(),
    relatedToChanges: !!c.relatedToChanges,
  }));
}

function applyVerificationResult(wsState, check) {
  const ws = wsState || {};
  const checks = Array.isArray(ws.checks) ? ws.checks : [];
  const errors = Array.isArray(ws.unresolvedErrors) ? ws.unresolvedErrors : [];
  const entries = normalizeCheckResults(check);
  const keys = new Set(entries.map((entry) => verificationKey(entry.kind, entry.command)));

  // 保留完整验证审计轨迹；Completion Gate 通过 kind + command 只采用最新结果。
  ws.checks = checks.concat([Object.assign({}, check, { at: Number(check && check.at) || Date.now() })]);

  const resultKinds = new Set(entries.map((entry) => entry.kind));
  ws.unresolvedErrors = errors.filter((error) => {
    const key = error && error.verificationKey;
    if (key) return !keys.has(key);
    const legacySource = String((error && error.source) || '');
    return !Array.from(resultKinds).some((kind) => legacySource === 'run_' + kind);
  });

  for (const entry of entries) {
    if (entry.ok) continue;
    ws.unresolvedErrors.push({
      source: 'run_' + entry.kind,
      verificationKey: verificationKey(entry.kind, entry.command),
      kind: entry.kind,
      command: entry.command,
      message: entry.command + ' 失败' + (entry.exitCode == null ? '' : '（退出码 ' + entry.exitCode + '）'),
      at: entry.at,
    });
  }
  return ws;
}

function latestEffectiveChecks(checks) {
  const latest = new Map();
  for (const check of Array.isArray(checks) ? checks : []) {
    for (const entry of normalizeCheckResults(check)) {
      const key = verificationKey(entry.kind, entry.command);
      const prior = latest.get(key);
      if (!prior || entry.at >= prior.at) latest.set(key, entry);
    }
  }
  return Array.from(latest.values());
}

function normalizedChangePath(filePath) {
  const value = String(filePath || '').replace(/\\/g, '/');
  const rootSplit = value.indexOf(':');
  return (rootSplit > 0 ? value.slice(rootSplit + 1) : value).replace(/^\.\//, '').toLowerCase();
}

function classifyChangePath(filePath) {
  const value = normalizedChangePath(filePath);
  if (!value) return 'temporary';
  if (/(^|\/)(node_modules|dist|build|coverage|\.cache|tmp|temp|__pycache__)(\/|$)/.test(value) || /(^|\/)eval-(attempt|result)\.json$/.test(value)) return 'temporary';
  if (/(^|\/)(__tests__|test|tests|spec)(\/|$)/.test(value) || /\.(test|spec)\.[a-z0-9]+$/.test(value)) return 'test';
  if (/(^|\/)(readme|changelog|license)(\.|$)/.test(value) || /\.(md|mdx|rst|txt)$/.test(value)) return 'documentation';
  return 'source';
}

function activeChangesOf(wsState) {
  const latestChangeByPath = new Map();
  // B7（P3）：路径大小写归一（Windows 大小写不敏感文件系统下 'Foo.ts'/'foo.ts' 视为同一文件，避免重复计数）
  const normPath = (p) => String(p || '').toLowerCase();
  for (const change of Array.isArray(wsState && wsState.filesChanged) ? wsState.filesChanged : []) {
    if (!change || !change.path) continue;
    const key = normPath(change.path);
    const prior = latestChangeByPath.get(key);
    if (!prior || (Number(change.at) || 0) >= (Number(prior.at) || 0)) latestChangeByPath.set(key, change);
  }
  return Array.from(latestChangeByPath.values()).filter((change) => !change.restored);
}

function changeSummary(wsState) {
  const summary = { source: [], test: [], documentation: [], temporary: [] };
  for (const change of activeChangesOf(wsState)) summary[classifyChangePath(change.path)].push(change.path);
  return summary;
}

function convergenceReminder(wsState, ratio, options) {
  const opts = options || {};
  const summary = changeSummary(wsState);
  const effectiveChecks = latestEffectiveChecks(wsState && wsState.checks);
  const failedChecks = effectiveChecks.filter((check) => !check.ok);
  const passedChecks = effectiveChecks.filter((check) => check.ok);
  if (opts.requireSourceChange === true && ratio >= 0.25 && ratio < 0.5 && !summary.source.length) {
    if (summary.test.length || summary.documentation.length) return '评测预算已使用约 25%。当前只修改了测试或文档，核心产品行为尚未改变；请立即停止外围扩展，实施最小源码/配置修复。';
    return '评测预算已使用约 25%。尚无产品源码/配置变更；请停止继续泛读或规划，立即定位并实施最小核心修复。';
  }
  if (ratio >= 0.75 && summary.source.length && !passedChecks.length) {
    return '评测预算已使用约 75%。已有源码变更但还没有通过验证；请停止扩大范围，优先运行最小相关验证，并根据最新失败输出修复。';
  }
  if (ratio >= 0.5 && !summary.source.length) {
    if (summary.test.length || summary.documentation.length) return '评测预算已使用约 50%。目前只修改了测试或文档，核心产品行为尚未改变；请停止外围工作，定位并完成最小源码/配置修复。';
    return '评测预算已使用约 50%。尚无源码/配置变更；请停止继续泛读，定位最小核心修复并实施。';
  }
  if (ratio >= 0.5 && failedChecks.length) return '评测预算已使用约 50%。已有验证失败；请读取最新失败输出并修复根因，不要继续扩散修改范围。';
  return '';
}

function failureSignature(toolName, args, result) {
  const input = args && typeof args === 'object' ? args : {};
  const safeKeys = ['path', 'to', 'command', 'pattern', 'query', 'startLine', 'endLine', 'offset', 'limit'];
  const summary = {};
  for (const key of safeKeys) {
    if (input[key] == null) continue;
    summary[key] = String(input[key]).replace(/\s+/g, ' ').slice(0, 160);
  }
  const code = String((result && result.error && result.error.code) || (result && result.exitCode != null ? 'exit_' + result.exitCode : 'tool_error'));
  return String(toolName || 'tool') + '::' + JSON.stringify(summary) + '::' + code;
}

function completionGap(wsState, todos, options) {
  const ws = wsState || {};
  const opts = options || {};
  const gaps = [];
  const plan = Array.isArray(ws.plan) && ws.plan.length ? ws.plan : (Array.isArray(todos) ? todos : []);
  const pending = plan.filter((step) => step && (step.status === 'pending' || step.status === 'in_progress' || step.status === 'blocked'));
  if (pending.length) {
    gaps.push('计划中 ' + pending.length + ' 个步骤未完成（' + pending.map((step) => step.content || step.title || '未命名').slice(0, 3).join('、') + (pending.length > 3 ? ' 等' : '') + '）');
  }
  const unverifiedSteps = plan.filter((step) => step && step.status === 'completed' && step.verificationRequired === true
    && !(Array.isArray(step.verificationEventIds) && step.verificationEventIds.length));
  if (unverifiedSteps.length) gaps.push('有 ' + unverifiedSteps.length + ' 个已完成步骤缺少关联验证证据');

  const pendingApprovals = (Array.isArray(ws.decisions) ? ws.decisions : []).filter((decision) => decision && decision.result === 'pending');
  const pendingDecisions = (Array.isArray(ws.pendingDecisions) ? ws.pendingDecisions : []).filter((decision) => decision && decision.status === 'pending');
  if (pendingApprovals.length || pendingDecisions.length || opts.phase === 'waiting_approval') gaps.push('仍有待用户确认或审批的操作');

  const effectiveChecks = latestEffectiveChecks(ws.checks);
  const failedChecks = effectiveChecks.filter((check) => !check.ok);
  if (failedChecks.length) {
    gaps.push('有 ' + failedChecks.length + ' 项验证未通过（' + failedChecks.map((check) => check.kind).join('、') + '）');
  }

  const errors = Array.isArray(ws.unresolvedErrors) ? ws.unresolvedErrors : [];
  if (errors.length) gaps.push('存在未解决的错误：' + errors.map((error) => error.message || String(error)).slice(0, 2).join('；'));
  const childRuns = Array.isArray(ws.subagents) ? ws.subagents : [];
  const activeChildren = childRuns.filter((child) => child && (child.status === 'pending' || child.status === 'running'));
  const failedChildren = childRuns.filter((child) => child && child.status === 'failed');
  if (activeChildren.length) gaps.push('仍有 ' + activeChildren.length + ' 个子任务尚未结束');
  if (failedChildren.length) gaps.push('有 ' + failedChildren.length + ' 个子任务失败，需处理或明确取消');

  const activeChanges = activeChangesOf(ws);
  const changeKinds = changeSummary(ws);
  if (opts.requireChange === true && !activeChanges.length) {
    gaps.push('当前任务要求修改代码，但尚无任何有效文件变更；不得直接声称完成');
  }
  if (opts.requireSourceChange === true && !changeKinds.source.length) {
    const peripheral = changeKinds.test.length + changeKinds.documentation.length;
    gaps.push(peripheral
      ? '当前编码任务只修改了测试或文档，尚无产品源码/配置变更；不得直接声称完成'
      : '当前编码任务尚无产品源码/配置变更；不得直接声称完成');
  }
  if (activeChanges.length) {
    const latestChangeAt = Math.max(...activeChanges.map((change) => Number(change.at) || 0));
    const passedAfterChange = effectiveChecks.some((check) => check.ok && check.at >= latestChangeAt);
    const skipped = (Array.isArray(ws.verificationSkips) ? ws.verificationSkips : []).some((record) => {
      return record && String(record.reason || '').trim() && (Number(record.at) || 0) >= latestChangeAt;
    });
    if (!passedAfterChange && !skipped) gaps.push('本次有文件变更，但最近一次变更后没有通过验证，也未记录跳过验证的明确原因');
  }

  return gaps;
}

module.exports = {
  activeChangesOf,
  applyVerificationResult,
  changeSummary,
  classifyChangePath,
  completionGap,
  convergenceReminder,
  failureSignature,
  latestEffectiveChecks,
  normalizeCheckResults,
  verificationKey,
};
