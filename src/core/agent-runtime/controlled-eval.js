'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { judgeTask, resolveRuntime } = require('./eval-judge');

function readSafeTasks(appRoot) {
  const file = path.join(appRoot, 'benchmarks', 'tasks.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (parsed.tasks || []).filter((task) => task && task.id && task.goal && task.fixtureDir && !task.manualOnly);
}

function resolveSafeTask(appRoot, taskId) {
  const task = readSafeTasks(appRoot).find((item) => item.id === String(taskId || ''));
  if (!task) throw new Error('eval_task_not_allowed');
  return task;
}

function resolveFixtureSource(appRoot, fixtureDir) {
  const rel = String(fixtureDir || '');
  if (!rel) throw new Error('eval_fixture_required');
  const benchmarkRoot = path.resolve(appRoot, 'benchmarks');
  const source = path.resolve(benchmarkRoot, rel);
  if (source !== benchmarkRoot && !source.startsWith(benchmarkRoot + path.sep)) throw new Error('eval_fixture_outside_benchmarks');
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error('eval_fixture_missing');
  return source;
}

function createIsolatedFixture({ appRoot, runsRoot, task }) {
  const source = resolveFixtureSource(appRoot, task.fixtureDir);
  fs.mkdirSync(runsRoot, { recursive: true });
  const safeId = String(task.id).replace(/[^A-Za-z0-9_-]/g, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const nonce = crypto.randomBytes(4).toString('hex');
  const runDir = path.join(runsRoot, safeId + '-' + stamp + '-' + process.pid + '-' + nonce);
  fs.mkdirSync(runDir, { recursive: false });
  fs.cpSync(source, runDir, { recursive: true });
  return runDir;
}

function isRetryableInfrastructure(errorText, httpStatus) {
  const code = Number(httpStatus) || 0;
  if ([502, 503, 504].includes(code)) return true;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket|LITELLM_UNAVAILABLE|\b50[234]\b/i.test(String(errorText || ''));
}

function summarizeToolFailure(event) {
  const result = event && event.result;
  if (!result || result.ok !== false) return null;
  const error = result.error && typeof result.error === 'object' ? result.error : {};
  const message = String(error.message || result.summary || result.error || '工具执行失败').replace(/\s+/g, ' ').slice(0, 200);
  return {
    tool: String(event.name || 'unknown').slice(0, 80),
    code: String(error.code || (result.exitCode != null ? 'exit_' + result.exitCode : 'tool_error')).slice(0, 80),
    repeatCount: Math.max(1, Number(result.repeatCount) || 1),
    message,
  };
}

async function executeAttempt({ task, cwd, accountRef, modelId, base, token, fetchImpl, timeoutMs, attempt }) {
  const startedAt = Date.now();
  const events = [];
  let status = 'error';
  let lastError = '';
  let toolResultEvents = 0;
  let cumulativeSteps = 0;
  let stepsSource = 'unavailable';
  let segmentSteps = 0;
  let toolCalls = 0;
  let failures = 0;
  const toolFailureSummary = [];
  let httpStatus = 0;
  let completedByJudge = false;
  let judgeCompletedAtStep = null;
  let lastLiveJudgeAt = 0;
  const liveJudgeThrottleMs = 1000;
  try {
    const response = await fetchImpl(base + '/api/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(timeoutMs || Math.max(60_000, Number(task.timeoutSteps || 10) * 60_000)),
      body: JSON.stringify({
        prompt: task.goal,
        cwd,
        ref: accountRef,
        model: modelId,
        auto: true,
        planMode: false,
        permissionMode: 'sandbox',
        threadId: 'eval_' + task.id + '_' + Date.now() + '_' + attempt,
        maxSteps: task.timeoutSteps || 10,
        maxCumulativeSteps: task.timeoutSteps || 10,
        evalMode: true,
        requireChange: !(task.tags || []).some((tag) => tag === 'safety' || tag === 'context'),
        requireSourceChange: !(task.tags || []).some((tag) => tag === 'safety' || tag === 'context' || tag === 'text' || tag === 'test-only'),
        evalConvergence: true,
        thinkLevel: 'low',
      }),
    });
    httpStatus = Number(response && response.status) || 0;
    if (!response || !response.ok) throw new Error('eval_backend_http_' + httpStatus);
    if (!response.body || typeof response.body.getReader !== 'function') throw new Error('eval_backend_stream_missing');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let event;
        try { event = JSON.parse(data); } catch (_) { continue; }
        events.push({ type: event.type, payload: event });
        if (event.type === 'tool_call') toolCalls++;
        if (event.type === 'tool_result') {
          toolResultEvents++;
          if (event.result && event.result.ok === false) {
            failures++;
            const summary = summarizeToolFailure(event);
            if (summary) toolFailureSummary.push(summary);
          }
        }
        const hasCumulative = event.cumulativeSteps != null || (event.usage && event.usage.cumulativeSteps != null);
        const eventCumulative = Number(event.cumulativeSteps != null ? event.cumulativeSteps : (event.usage && event.usage.cumulativeSteps));
        const eventSegment = Number(event.segmentSteps != null ? event.segmentSteps : (event.usage && event.usage.segmentSteps));
        if (hasCumulative && Number.isFinite(eventCumulative)) {
          cumulativeSteps = Math.max(cumulativeSteps, eventCumulative);
          stepsSource = 'runtime_cumulative';
        }
        if (eventSegment >= 0) segmentSteps = eventSegment;
        if (event.type === 'done') status = 'completed';
        if (event.type === 'blocked') { status = 'blocked'; lastError = String(event.reason || ''); }
        if (event.type === 'error') lastError = String(event.message || '');
        const successfulTool = event.type === 'tool_result' && event.result && event.result.ok !== false;
        const toolName = String(event.name || '');
        const judgeTrigger = successfulTool && /write|edit|patch|create|move|delete|run_tests|run_lint|run_typecheck|run_build|run_command/.test(toolName);
        if (judgeTrigger && !completedByJudge && Date.now() - lastLiveJudgeAt >= liveJudgeThrottleMs) {
          lastLiveJudgeAt = Date.now();
          const liveJudgment = judgeTask(task, { cwd, status: 'running', events });
          if (liveJudgment.ok) {
            completedByJudge = true;
            judgeCompletedAtStep = cumulativeSteps > 0 ? cumulativeSteps : null;
            if (judgeCompletedAtStep != null) stepsSource = 'runtime_progress';
            status = 'completed_by_judge';
            lastError = '';
            try { await reader.cancel('machine_checks_passed'); } catch (_) {}
            break;
          }
        }
      }
    }
  } catch (error) {
    status = 'error';
    lastError = error && error.message ? error.message : String(error);
  }
  const retryableInfrastructure = toolCalls === 0 && isRetryableInfrastructure(lastError, httpStatus);
  const attemptResult = {
    attempt,
    runDir: cwd,
    status,
    error: lastError,
    httpStatus,
    toolCalls,
    failures,
    toolFailureSummary,
    steps: cumulativeSteps,
    stepsSource,
    toolResultEvents,
    segmentSteps,
    events,
    durationMs: Date.now() - startedAt,
    retryableInfrastructure,
    completedByJudge,
    judgeCompletedAtStep,
    metricIncomplete: completedByJudge && !(cumulativeSteps > 0),
  };
  fs.writeFileSync(path.join(cwd, 'eval-attempt.json'), JSON.stringify(Object.assign({}, attemptResult, { events: undefined }), null, 2), 'utf8');
  return attemptResult;
}

async function executeSafeTask({ appRoot, runsRoot, taskId, ref, model, base, token, fetchImpl = fetch, timeoutMs }) {
  const task = resolveSafeTask(appRoot, taskId);
  const accountRef = String(ref || '').trim();
  const modelId = String(model || '').trim();
  if (!accountRef || accountRef.length > 240) throw new Error('eval_ref_required');
  if (!modelId || modelId.length > 240) throw new Error('eval_model_required');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(String(base || ''))) throw new Error('eval_base_must_be_loopback');
  if (!token) throw new Error('eval_internal_token_required');

  const startedAt = Date.now();
  const attempts = [];
  let finalAttempt = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const cwd = createIsolatedFixture({ appRoot, runsRoot, task });
    const current = await executeAttempt({ task, cwd, accountRef, modelId, base, token, fetchImpl, timeoutMs, attempt });
    attempts.push(current);
    finalAttempt = current;
    if (!current.retryableInfrastructure) break;
  }

  const infrastructureFailed = !!(finalAttempt && finalAttempt.retryableInfrastructure && attempts.length >= 2);
  const judgment = judgeTask(task, { cwd: finalAttempt.runDir, status: finalAttempt.status, events: finalAttempt.events });
  // B3（P1）：终态统一——判分未通过时不得标 completed_by_judge（此前 live judge 部分事件过、全量判定未过时自相矛盾）
  let finalStatus;
  if (judgment.ok) {
    finalStatus = finalAttempt.completedByJudge ? 'completed_by_judge' : finalAttempt.status;
  } else {
    finalStatus = (finalAttempt.status === 'completed' || finalAttempt.status === 'completed_by_judge') ? 'assertion_failed' : finalAttempt.status;
  }
  if (judgment.infrastructureSkipped) finalStatus = 'infrastructure_skipped';
  else if (infrastructureFailed) finalStatus = 'infrastructure_failed';
  const result = {
    reportVersion: 2,
    at: new Date().toISOString(),
    id: task.id,
    title: task.title,
    status: finalStatus,
    machinePassed: !!judgment.ok,
    selfReportedDone: finalAttempt.status === 'completed',
    completedByJudge: !!finalAttempt.completedByJudge,
    judgeCompletedAtStep: finalAttempt.judgeCompletedAtStep,
    metricIncomplete: !!finalAttempt.metricIncomplete,
    steps: finalAttempt.steps,
    stepsSource: finalAttempt.stepsSource,
    toolResultEvents: finalAttempt.toolResultEvents,
    segmentSteps: finalAttempt.segmentSteps,
    toolCalls: finalAttempt.toolCalls,
    failures: finalAttempt.failures,
    toolFailureSummary: finalAttempt.toolFailureSummary,
    durationMs: Date.now() - startedAt,
    error: finalAttempt.error,
    judgment,
    infrastructureFailure: infrastructureFailed || judgment.infrastructureSkipped,
    attempts: attempts.map((item) => ({
      attempt: item.attempt, status: item.status, error: item.error,
      toolCalls: item.toolCalls, failures: item.failures, toolFailureSummary: item.toolFailureSummary, steps: item.steps,
      stepsSource: item.stepsSource, toolResultEvents: item.toolResultEvents,
      completedByJudge: !!item.completedByJudge,
      judgeCompletedAtStep: item.judgeCompletedAtStep,
      metricIncomplete: !!item.metricIncomplete,
      durationMs: item.durationMs, retryableInfrastructure: item.retryableInfrastructure,
    })),
    retryReason: attempts.length > 1 ? attempts[0].error : '',
    runDir: finalAttempt.runDir,
  };
  fs.writeFileSync(path.join(finalAttempt.runDir, 'eval-result.json'), JSON.stringify(result, null, 2), 'utf8');
  return result;
}

function listSafeTasks(appRoot) {
  return readSafeTasks(appRoot).map((task) => {
    const runtimes = Array.from(new Set((task.expectedChecks || []).map((check) => check && check.runtime).filter(Boolean)));
    const missingRuntimes = runtimes.filter((runtime) => !resolveRuntime(runtime));
    return {
      id: task.id,
      title: task.title,
      tags: Array.isArray(task.tags) ? task.tags.slice() : [],
      timeoutSteps: task.timeoutSteps || 10,
      requiredRuntimes: runtimes,
      missingRuntimes,
      infrastructureSkipped: missingRuntimes.length > 0,
    };
  });
}

module.exports = {
  readSafeTasks,
  resolveSafeTask,
  resolveFixtureSource,
  createIsolatedFixture,
  isRetryableInfrastructure,
  executeAttempt,
  executeSafeTask,
  listSafeTasks,
};
