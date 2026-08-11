'use strict';

const { createBudgetManager } = require('./budget-manager');
const { createAbortLifecycle } = require('./abort-lifecycle');
const { classifyError } = require('./error-classifier');
const { TraceRecorder } = require('./trace-recorder');
const { normalizeModelUsage, mergeCacheMetrics } = require('./model-telemetry');
const { mergeCosts } = require('./cost-ledger');
const { beginModelCall, finishModelCall } = require('./model-call-recorder');

function parseArgs(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '{}')); } catch (_) { return {}; }
}

function safeCall(fn, ...args) {
  try { return fn(...args); } catch (_) { return null; }
}

function addUsage(previous, incoming, hasPrevious) {
  if (!hasPrevious) return incoming == null ? null : Number(incoming);
  if (previous == null || incoming == null) return null;
  return Number(previous) + Number(incoming);
}

function metricBudgetDelta(metric) {
  const delta = {
    durationMs: Number(metric && metric.latencyMs) || 0,
    queueWaitMs: Number(metric && metric.queueWaitMs) || 0,
    processMs: Number(metric && metric.processMs) || 0,
  };
  for (const [metricKey, budgetKey] of [['inputTokens', 'inputTokens'], ['outputTokens', 'outputTokens'], ['costUsd', 'costUsd']]) {
    if (metric && metric[metricKey] != null && Number.isFinite(Number(metric[metricKey]))) delta[budgetKey] = Number(metric[metricKey]);
  }
  return delta;
}

/**
 * Dependency-injected Agent Runtime boundary used by the offline harness and
 * focused tests. HTTP/SSE remains an adapter around this lifecycle contract.
 */
async function runAgent(input, dependencies) {
  const request = input && typeof input === 'object' ? input : {};
  const deps = dependencies || {};
  const runId = String(request.runId || 'run_' + Date.now().toString(36));
  const rootRunId = String(request.rootRunId || runId);
  const lifecycle = createAbortLifecycle(deps.signal || request.signal || null);
  const budget = deps.budgetManager || createBudgetManager(Object.assign({ maxSteps: Number(request.maxSteps) || 12 }, request.budget || {}));
  const messages = Array.isArray(request.messages) ? request.messages.map((item) => Object.assign({}, item)) : [];
  if (!messages.length && request.prompt != null) messages.push({ role: 'user', content: String(request.prompt) });
  const events = [];
  const emit = typeof deps.emit === 'function' ? deps.emit : (type, payload) => events.push({ type, payload: payload || {} });
  const trace = deps.traceRecorder || new TraceRecorder({ runId, store: deps.runStore, emit: (type, payload) => emit(type, payload) });
  const role = String(request.role || 'main');
  const registry = deps.toolRegistry || null;
  const toolContext = Object.assign({}, request.context || {}, {
    runId, rootRunId, role, signal: lifecycle.signal, budgetManager: budget,
  });
  const startedAt = Date.now();
  let terminal = null;
  let modelCalls = 0;
  const usage = {
    steps: 0,
    toolCalls: 0,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    costUsd: null,
    cost: null,
    cache: normalizeModelUsage({}).cache,
    failures: 0,
  };

  const persist = (patch) => {
    if (!deps.runStore || typeof deps.runStore.updateAgentRun !== 'function') return;
    safeCall(deps.runStore.updateAgentRun.bind(deps.runStore), runId, Object.assign({ usage, budget: budget.snapshot() }, patch || {}));
  };

  const finish = (nextStatus, error, output) => {
    if (terminal) return terminal;
    const status = String(nextStatus || 'failed');
    const normalizedError = error ? classifyError(error) : null;
    terminal = {
      ok: status === 'completed',
      runId,
      rootRunId,
      status,
      content: output == null ? '' : String(output),
      error: normalizedError,
      usage: Object.assign({}, usage, { steps: budget.spent.steps, toolCalls: budget.spent.toolCalls }),
      budget: budget.snapshot(),
      // Keep the terminal snapshot immutable. Emitting the terminal event
      // appends to the live array; sharing it here would create a JSON cycle.
      events: events.slice(),
      startedAt,
      finishedAt: Date.now(),
    };
    // Budget exhaustion and cancellation must stop descendants and pending
    // resources before the final state is persisted.
    if (status !== 'completed') lifecycle.abort(normalizedError || { type: status, code: status, message: status, recoverable: false });
    emit(status === 'completed' ? 'done' : 'error', terminal);
    persist({ status, phase: status, error: normalizedError && normalizedError.message, finishedAt: terminal.finishedAt });
    if (typeof deps.onTerminal === 'function') safeCall(deps.onTerminal, terminal);
    return terminal;
  };

  if (deps.runStore && typeof deps.runStore.createAgentRun === 'function') {
    safeCall(deps.runStore.createAgentRun.bind(deps.runStore), {
      id: runId,
      rootRunId,
      parentRunId: request.parentRunId || '',
      role,
      depth: Number(request.depth) || 0,
      readOnly: request.readOnly === true,
      userGoal: String(request.prompt || ''),
      status: 'running',
      startedAt,
      budget: budget.snapshot(),
      modelId: request.modelId || '',
      providerRef: request.provider || '',
      promptVersion: request.promptVersion || 'runtime/1.1.3',
      toolsetVersion: request.toolsetVersion || 'registry/1.1.3',
      runtimeVersion: request.runtimeVersion || 'runtime/1.1.3',
    });
  }

  const recordModelFailure = (call, error) => {
    const metric = finishModelCall(call, {
      status: 'failed',
      errorType: error.type,
      error,
      finishedAt: Date.now(),
    }, deps.recordModelCallMetric);
    trace.llm(Object.assign({ callType: 'chat', status: 'failed', error }, metric));
    return metric;
  };

  const applyModelMetric = (metric) => {
    const result = budget.consume(metricBudgetDelta(metric));
    trace.budget({ phase: 'after_model', requestId: metric.requestId, ok: result.ok, snapshot: budget.snapshot() });
    return result;
  };

  try {
    if (lifecycle.signal.aborted) return finish('cancelled', lifecycle.reason || { type: 'cancelled', code: 'cancelled', message: 'run cancelled', recoverable: false });
    if (typeof deps.modelCall !== 'function') return finish('failed', { type: 'infrastructure_failure', code: 'model_call_missing', message: 'modelCall dependency is required', recoverable: false });
    const maxSteps = Math.min(Math.max(Number(request.maxSteps) || (budget.budget.maxSteps || 12), 1), 1000);

    for (let step = 0; step < maxSteps; step++) {
      if (lifecycle.signal.aborted) return finish('cancelled', lifecycle.reason || { type: 'cancelled', code: 'cancelled', message: 'run cancelled', recoverable: false });
      const reservation = budget.consume({ steps: 1 });
      trace.budget({ phase: 'before_model', step: step + 1, ok: reservation.ok, snapshot: budget.snapshot() });
      if (!reservation.ok) return finish('budget_exhausted', reservation.error);
      usage.steps = budget.spent.steps;

      const call = beginModelCall({ scope: 'agent', callType: 'chat', runId, rootRunId, modelId: request.modelId, provider: request.provider, accountRef: request.accountRef, projectId: request.projectId, module: request.module || 'agent' });
      let response;
      try {
        response = await deps.modelCall({
          messages,
          tools: registry && registry.toOpenAITools ? registry.toOpenAITools({ role }) : (request.tools || []),
          signal: lifecycle.signal,
          runId,
          rootRunId,
          step,
          role,
        });
      } catch (error) {
        const normalized = classifyError(error, { type: 'model_failure', code: 'model_call_failed', recoverable: true });
        const metric = recordModelFailure(call, normalized);
        const spent = applyModelMetric(metric);
        if (!spent.ok) return finish('budget_exhausted', spent.error);
        return finish(normalized.type === 'cancelled' ? 'cancelled' : 'failed', normalized);
      }

      if (!response || typeof response !== 'object') {
        const normalized = classifyError({ type: 'invalid_result', code: 'model_result_invalid', message: 'model returned an invalid result', recoverable: false });
        const metric = recordModelFailure(call, normalized);
        const spent = applyModelMetric(metric);
        if (!spent.ok) return finish('budget_exhausted', spent.error);
        return finish('failed', normalized);
      }

      const normalizedUsage = normalizeModelUsage(response);
      const metric = finishModelCall(call, {
        status: 'completed',
        usage: response.usage || response.adapterUsage || response,
        cache: response.cache,
        costUsd: response.costUsd,
        cost: response.cost,
        costSource: response.costSource,
        queueWaitMs: response.queueWaitMs,
        processMs: response.processMs,
        finishedAt: Date.now(),
      }, deps.recordModelCallMetric);
      usage.inputTokens = addUsage(usage.inputTokens, normalizedUsage.inputTokens, modelCalls > 0);
      usage.outputTokens = addUsage(usage.outputTokens, normalizedUsage.outputTokens, modelCalls > 0);
      usage.reasoningTokens = addUsage(usage.reasoningTokens, normalizedUsage.reasoningTokens, modelCalls > 0);
      usage.cost = modelCalls > 0 ? mergeCosts([usage.cost, metric.cost]) : metric.cost;
      usage.costUsd = usage.cost.totalUsd;
      usage.cache = modelCalls > 0 ? mergeCacheMetrics([usage.cache, normalizedUsage.cache]) : normalizedUsage.cache;
      modelCalls++;
      const spent = applyModelMetric(metric);
      trace.llm(Object.assign({ callType: 'chat', status: 'completed' }, metric));
      if (!spent.ok) return finish('budget_exhausted', spent.error);

      const calls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
      const content = response.content || response.text || response.reasoning || '';
      if (!calls.length) {
        if (!String(content)) return finish('failed', { type: 'invalid_result', code: 'model_empty_result', message: 'model returned no content or tool call', recoverable: false });
        return finish('completed', null, content);
      }

      messages.push({
        role: 'assistant',
        content: response.content || '',
        tool_calls: calls.map((callItem) => ({ id: callItem.id, type: 'function', function: { name: callItem.name, arguments: callItem.arguments || '{}' } })),
      });
      for (const toolCall of calls) {
        if (lifecycle.signal.aborted) return finish('cancelled', lifecycle.reason || { type: 'cancelled', code: 'cancelled', message: 'cancelled before tool execution', recoverable: false });
        const args = parseArgs(toolCall.arguments);
        const toolStartedAt = Date.now();
        let result;
        try {
          if (!registry || typeof registry.dispatch !== 'function') {
            result = { ok: false, error: { type: 'tool_failure', code: 'tool_registry_missing', message: 'Tool Registry is unavailable', recoverable: false } };
          } else {
            result = await registry.dispatch(toolCall.name, args, toolContext);
          }
        } catch (error) {
          result = { ok: false, error: classifyError(error, { type: 'tool_failure', code: 'tool_dispatch_failed', recoverable: true }) };
        }
        if (!result || typeof result !== 'object') {
          result = { ok: false, error: { type: 'invalid_result', code: 'tool_result_invalid', message: 'tool returned an invalid result', recoverable: false } };
        }
        const durationMs = Math.max(0, Date.now() - toolStartedAt);
        const toolError = result.error ? classifyError(result.error, { type: 'tool_failure', code: 'tool_failed', recoverable: true }) : null;
        if (result.ok === false) usage.failures++;
        const toolSpent = budget.consume({ toolCalls: 1, durationMs, processMs: durationMs });
        trace.tool({ name: toolCall.name, status: result.ok === false ? 'failed' : 'completed', durationMs, error: toolError });
        trace.budget({ phase: 'after_tool', name: toolCall.name, ok: toolSpent.ok, snapshot: budget.snapshot() });
        emit('tool_result', { runId, name: toolCall.name, result });
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) });
        if (!toolSpent.ok) return finish('budget_exhausted', toolSpent.error);
      }
    }
    return finish('budget_exhausted', { type: 'budget_exhausted', code: 'budget_steps_exhausted', message: 'maximum runtime steps reached', recoverable: false });
  } catch (error) {
    return finish(lifecycle.signal.aborted ? 'cancelled' : 'failed', lifecycle.signal.aborted ? lifecycle.reason : error);
  } finally {
    lifecycle.dispose();
  }
}

module.exports = { runAgent };
