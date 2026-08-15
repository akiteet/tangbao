'use strict';

const fs = require('fs');
const { runAgent } = require('./run-agent');
const { ToolRegistry } = require('./tool-registry');
const { calculateCost, mergeCosts } = require('./cost-ledger');

const RUNTIME_VERSION = '1.1.4';
const PROMPT_VERSION = '1.1.4';
const TOOLSET_VERSION = '1.1.4';

const SUITES = Object.freeze({
  'multi-agent': [
    { id: 'bug-investigation', kind: 'investigation', baseSteps: 6, baseTools: 5 },
    { id: 'security-review', kind: 'review', baseSteps: 7, baseTools: 6 },
    { id: 'regression-analysis', kind: 'regression', baseSteps: 5, baseTools: 4 },
    { id: 'refactor-planning', kind: 'planning', baseSteps: 4, baseTools: 3 },
    { id: 'partial-failure', kind: 'partial-failure', baseSteps: 7, baseTools: 6, fault: 'tool_failure' },
    { id: 'cancel-and-resume', kind: 'cancel-resume', baseSteps: 8, baseTools: 6, fault: 'cancelled' },
    { id: 'queued-scheduling', kind: 'queued', baseSteps: 6, baseTools: 5, queueWaitMs: 42 },
    { id: 'cache-cold-warm', kind: 'cache', baseSteps: 5, baseTools: 4, cache: true },
  ],
  cache: [
    { id: 'cache-cold-warm', kind: 'cache', baseSteps: 5, baseTools: 4, cache: true },
    { id: 'cache-prefix-invalidation', kind: 'cache-invalidation', baseSteps: 5, baseTools: 4, cache: true },
  ],
  stability: [
    { id: 'storage-migration-recovery', kind: 'storage-migration', baseSteps: 3, baseTools: 2 },
    { id: 'provider-health-failure', kind: 'provider-health', baseSteps: 2, baseTools: 0, fault: 'provider_failure' },
    { id: 'malformed-model-result', kind: 'malformed-result', baseSteps: 2, baseTools: 0, fault: 'malformed_result' },
    { id: 'large-trace-pagination', kind: 'large-trace', baseSteps: 8, baseTools: 7 },
    { id: 'multi-root-permission', kind: 'permission', baseSteps: 3, baseTools: 1 },
    { id: 'manual-fallback', kind: 'manual-fallback', baseSteps: 3, baseTools: 1, fault: 'manual_fallback' },
  ],
});

function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  if (!state) state = 0x9e3779b9;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function percentile(values, ratio) {
  const items = values.filter((value) => Number.isFinite(Number(value))).map(Number).sort((a, b) => a - b);
  if (!items.length) return null;
  return items[Math.min(items.length - 1, Math.ceil(items.length * ratio) - 1)];
}

function round(value, digits) {
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** (digits == null ? 2 : digits);
  return Math.round(Number(value) * scale) / scale;
}

function makeCacheMetrics(input) {
  const source = input || {};
  const eligibleTokens = source.eligibleTokens == null ? null : Number(source.eligibleTokens);
  const cacheReadTokens = source.cacheReadTokens == null ? null : Number(source.cacheReadTokens);
  const cacheWriteTokens = source.cacheWriteTokens == null ? null : Number(source.cacheWriteTokens);
  const hitRate = eligibleTokens != null && eligibleTokens > 0 && cacheReadTokens != null ? round(cacheReadTokens / eligibleTokens, 4) : null;
  const savedTokens = cacheReadTokens == null ? null : cacheReadTokens;
  return {
    mode: String(source.mode || 'unknown'),
    eligibleTokens,
    inputTokens: source.inputTokens == null ? null : Number(source.inputTokens),
    cacheReadTokens,
    cacheWriteTokens,
    hitRate,
    savedTokens,
    estimatedCostUsd: source.estimatedCostUsd == null ? null : round(source.estimatedCostUsd, 6),
    estimatedSavedCostUsd: source.estimatedSavedCostUsd == null ? null : round(source.estimatedSavedCostUsd, 6),
    source: String(source.source || 'unknown'),
    unknownReason: source.unknownReason == null ? null : String(source.unknownReason),
    dataOrigin: String(source.dataOrigin || 'unknown'),
    prefixFingerprint: String(source.prefixFingerprint || ''),
  };
}

function mergeCacheMetrics(items) {
  const values = (Array.isArray(items) ? items : []).map(makeCacheMetrics);
  if (!values.length) return makeCacheMetrics({});
  const sumKnown = (key) => {
    const known = values.map((item) => item[key]).filter((value) => value != null && Number.isFinite(Number(value)));
    return known.length ? known.reduce((total, value) => total + Number(value), 0) : null;
  };
  const eligibleTokens = sumKnown('eligibleTokens');
  const cacheReadTokens = sumKnown('cacheReadTokens');
  const hitItems = values.filter((item) => item.eligibleTokens != null && item.cacheReadTokens != null
    && ((item.source === 'provider' && item.dataOrigin === 'provider_usage') || item.dataOrigin === 'offline-mock'));
  const hitEligible = hitItems.reduce((total, item) => total + Number(item.eligibleTokens), 0);
  const hitRead = hitItems.reduce((total, item) => total + Number(item.cacheReadTokens), 0);
  const hitUnknown = values.some((item) => item.source === 'unknown' || item.dataOrigin === 'unknown'
    || (item.eligibleTokens != null && item.cacheReadTokens == null));
  const fingerprints = [...new Set(values.map((item) => item.prefixFingerprint).filter(Boolean))];
  const origins = new Set(values.map((item) => item.dataOrigin));
  return makeCacheMetrics({
    mode: values.some((item) => item.mode === 'unknown') ? 'unknown' : values[values.length - 1].mode,
    eligibleTokens,
    inputTokens: sumKnown('inputTokens'),
    cacheReadTokens,
    cacheWriteTokens: sumKnown('cacheWriteTokens'),
    hitRate: !hitUnknown && hitEligible > 0 ? hitRead / hitEligible : null,
    estimatedCostUsd: sumKnown('estimatedCostUsd'),
    estimatedSavedCostUsd: sumKnown('estimatedSavedCostUsd'),
    source: origins.has('offline-mock') ? 'estimated' : (values.some((item) => item.source === 'unknown') ? 'unknown' : (values.some((item) => item.source === 'estimated') ? 'estimated' : 'provider')),
    unknownReason: values.map((item) => item.unknownReason).filter(Boolean)[0] || (fingerprints.length > 1 ? 'prefix_fingerprint_mixed' : null),
    dataOrigin: origins.has('unknown') ? 'unknown' : (origins.has('offline-mock') ? 'offline-mock' : 'provider_usage'),
    prefixFingerprint: fingerprints.length === 1 ? fingerprints[0] : '',
  });
}

function createMockProvider(options) {
  const opts = options || {};
  const random = seededRandom(opts.seed || 1);
  const warm = opts.cacheWarm === true;
  const fault = String(opts.fault || '');
  let calls = 0;
  return {
    call(task) {
      calls++;
      const inputTokens = 420 + Math.floor(random() * 80);
      const outputTokens = 80 + Math.floor(random() * 35);
      const eligibleTokens = 260;
      const cacheReadTokens = task.cache && warm ? eligibleTokens : (task.cache ? 0 : null);
      const cacheSource = task.cache ? 'estimated' : 'unknown';
      const failed = fault === 'tool_failure' && calls === 2;
      return {
        ok: !failed,
        content: failed ? '' : 'offline result for ' + task.id,
        inputTokens,
        outputTokens,
        latencyMs: 28 + Math.floor(random() * 16),
        cache: makeCacheMetrics({ mode: task.cache ? (warm ? 'warm' : 'cold') : 'unknown', eligibleTokens: task.cache ? eligibleTokens : null, inputTokens, cacheReadTokens: task.cache ? cacheReadTokens : null, cacheWriteTokens: task.cache && !warm ? eligibleTokens : null, estimatedCostUsd: 0.0014, estimatedSavedCostUsd: task.cache && warm ? 0.0007 : (task.cache ? 0 : null), source: cacheSource, dataOrigin: task.cache ? 'offline-mock' : 'unknown', unknownReason: task.cache ? null : 'not_cache_eligible', prefixFingerprint: 'offline-' + task.id }),
        error: failed ? { type: 'tool_failure', code: 'mock_tool_failure', recoverable: true, recommendedAction: 'inspect_tool_output' } : null,
      };
    },
  };
}

function replayEvents(events, task) {
  const source = Array.isArray(events) ? events : [];
  const llm = source.filter((event) => event.type === 'llm_call');
  const tools = source.filter((event) => event.type === 'tool_call');
  const failures = source.filter((event) => event.status === 'failed' || event.payload && event.payload.ok === false);
  const cache = source.map((event) => event.type === 'cache' ? event.payload || event.data || {} : null).filter(Boolean);
  const metric = source.find((event) => event.type === 'metrics' && (event.data || event.payload));
  if (metric) return Object.assign({}, metric.data || metric.payload);
  return {
    steps: llm.length,
    toolCalls: tools.length,
    inputTokens: llm.reduce((sum, event) => sum + Number(event.inputTokens || event.payload && event.payload.inputTokens || 0), 0),
    outputTokens: llm.reduce((sum, event) => sum + Number(event.outputTokens || event.payload && event.payload.outputTokens || 0), 0),
    cache: mergeCacheMetrics(cache),
    failures: failures.length,
    success: !source.some((event) => event.type === 'error' || event.status === 'failed'),
  };
}

function loadReplayFile(file) {
  if (!file || !fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.events)) return parsed.events;
    if (Array.isArray(parsed.results)) return parsed.results;
  } catch (_) {}
  return text.split(/\r?\n/).map((line) => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
}

function runTask(task, options) {
  const opts = options || {};
  if (opts.mode === 'replay' && opts.replayEvents) {
    const replayed = replayEvents(opts.replayEvents, task);
    return Object.assign({ suite: opts.suite, task: task.id, status: replayed.success === false ? 'failed' : 'completed', success: replayed.success !== false, steps: replayed.steps || 0, toolCalls: replayed.toolCalls || 0, failures: replayed.failures || 0, queueWaitMs: replayed.queueWaitMs == null ? null : replayed.queueWaitMs, processMs: replayed.processMs == null ? null : replayed.processMs, latencyMs: replayed.latencyMs == null ? null : replayed.latencyMs, humanInterventions: replayed.humanInterventions || 0, recoveryRate: replayed.recoveryRate == null ? null : replayed.recoveryRate, errorBreakdown: replayed.errorBreakdown || {} }, replayed);
  }
  const provider = createMockProvider({ seed: (opts.seed || 1) + task.id.length, cacheWarm: opts.mode === 'replay' || task.kind === 'cache', fault: task.fault });
  const events = [];
  const cacheSamples = [];
  const costSamples = [];
  let steps = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let latencyMs = 0;
  let failures = 0;
  let status = 'completed';
  let humanInterventions = 0;
  let recoveryRate = null;
  const errorBreakdown = {};
  const calls = Math.max(1, task.baseSteps - (task.kind === 'planning' ? 1 : 0));
  for (let i = 0; i < calls; i++) {
    const call = provider.call(task);
    steps++;
    inputTokens += call.inputTokens;
    outputTokens += call.outputTokens;
    latencyMs += call.latencyMs;
    cacheSamples.push(call.cache);
    costSamples.push(runtimeCost(call.inputTokens, call.outputTokens, call.cache));
    events.push({ type: 'llm_call', inputTokens: call.inputTokens, outputTokens: call.outputTokens, latencyMs: call.latencyMs, status: call.ok ? 'completed' : 'failed' });
    events.push({ type: 'cache', payload: call.cache });
    if (i < task.baseTools) { toolCalls++; events.push({ type: 'tool_call', status: call.ok ? 'completed' : 'failed' }); }
    if (!call.ok) {
      failures++;
      const type = call.error && call.error.type || 'tool_failure';
      errorBreakdown[type] = (errorBreakdown[type] || 0) + 1;
      if (task.kind === 'partial-failure') {
        recoveryRate = 1;
        events.push({ type: 'recovery', status: 'completed' });
      } else {
        status = 'failed';
      }
    }
  }
  if (task.kind === 'cancel-resume') {
    humanInterventions = 1;
    recoveryRate = 1;
    errorBreakdown.cancelled = 1;
    events.push({ type: 'cancelled', status: 'cancelled' });
    events.push({ type: 'resume', status: 'completed' });
  }
  const queueWaitMs = task.queueWaitMs == null ? 0 : task.queueWaitMs;
  const cache = mergeCacheMetrics(cacheSamples);
  const cost = mergeCosts(costSamples);
  const success = status === 'completed';
  return { suite: opts.suite, task: task.id, status, success, steps, toolCalls, inputTokens, outputTokens, cache, cost, costUsd: cost.totalUsd, latencyMs: latencyMs + queueWaitMs, queueWaitMs, processMs: latencyMs, humanInterventions, recoveryRate, failures, errorBreakdown, trace: events };
}

function summarize(results) {
  const rows = Array.isArray(results) ? results : [];
  const successCount = rows.filter((row) => row.success === true).length;
  const sum = (key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  const cacheRows = rows.map((row) => row.cache || {}).filter((cache) => cache.eligibleTokens != null && cache.source !== 'unknown');
  const cache = cacheRows.length ? mergeCacheMetrics(cacheRows) : makeCacheMetrics({ source: 'unknown', dataOrigin: 'unknown', unknownReason: 'no_cache_usage' });
  const unknownCacheCount = rows.filter((row) => !row.cache || row.cache.source === 'unknown' || row.cache.hitRate == null).length;
  const costSources = rows.reduce((out, row) => {
    const source = row.cost && row.cost.source || (row.costUsd == null ? 'unknown' : 'estimated');
    out[source] = (out[source] || 0) + 1;
    return out;
  }, {});
  return {
    taskCount: rows.length,
    successRate: rows.length ? round(successCount / rows.length, 4) : 0,
    successCount,
    steps: sum('steps'),
    toolCalls: sum('toolCalls'),
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    costUsd: rows.some((row) => row.costUsd == null) ? null : round(rows.reduce((total, row) => total + Number(row.costUsd), 0), 6),
    costSources,
    latencyP50: percentile(rows.map((row) => row.latencyMs), 0.5),
    latencyP95: percentile(rows.map((row) => row.latencyMs), 0.95),
    queueWaitMs: sum('queueWaitMs'),
    humanInterventions: sum('humanInterventions'),
    recoveryRate: rows.length ? round(rows.reduce((total, row) => total + (row.recoveryRate == null ? 0 : Number(row.recoveryRate)), 0) / rows.length, 4) : null,
    cache,
    unknownCacheCount,
    unknownMetricsCount: rows.filter((row) => row.costUsd == null || row.inputTokens == null || row.outputTokens == null).length,
    budgetExhaustedCount: rows.filter((row) => row.status === 'budget_exhausted').length,
    cancelledCount: rows.filter((row) => row.status === 'cancelled').length,
    errorBreakdown: rows.reduce((out, row) => { for (const [key, value] of Object.entries(row.errorBreakdown || {})) out[key] = (out[key] || 0) + Number(value || 0); return out; }, {}),
  };
}

function runBenchmarkSuite(options) {
  const opts = options || {};
  const suite = String(opts.suite || 'multi-agent');
  const tasks = SUITES[suite] || SUITES['multi-agent'];
  const mode = String(opts.mode || 'offline');
  const seed = Number(opts.seed || 1337);
  const replay = mode === 'replay' ? loadReplayFile(opts.replayFile || '') : [];
  const results = tasks.map((task) => runTask(task, { suite, mode, seed, replayEvents: replay.length ? replay : null }));
  const report = {
    reportVersion: 2,
    schemaVersion: 16,
    suiteVersion: 2,
    suite,
    mode: replay.length ? 'replay' : (mode === 'online' ? 'offline-fallback' : mode),
    seed,
    runtimeVersion: RUNTIME_VERSION,
    promptVersion: PROMPT_VERSION,
    toolsetVersion: TOOLSET_VERSION,
    model: mode === 'online' ? (opts.model || 'online-provider-unconfigured') : 'offline-mock',
    harness: 'sync-mock-compatible',
    results,
    summary: summarize(results),
    warnings: mode === 'online' ? ['No online provider is executed by the local harness; use a configured canary for live runs.'] : [],
  };
  return report;
}

function waitWithSignal(ms, signal) {
  const duration = Math.max(0, Number(ms) || 0);
  if (!duration) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer = setTimeout(done, duration);
    const abort = () => {
      clearTimeout(timer);
      timer = null;
      reject(signal && signal.reason || Object.assign(new Error('cancelled'), { type: 'cancelled', code: 'cancelled' }));
    };
    function done() {
      if (signal) signal.removeEventListener('abort', abort);
      resolve();
    }
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }
  });
}

function createRuntimeBenchmarkRegistry(task, counters) {
  const state = counters || { toolCalls: 0, failures: 0 };
  return new ToolRegistry({
    version: TOOLSET_VERSION,
    definitions: [{
      name: 'benchmark_step',
      version: '1.1.4',
      description: 'Deterministic offline benchmark tool',
      inputSchema: { type: 'object', properties: { step: { type: 'integer' } }, required: ['step'], additionalProperties: false },
      risk: 'low',
      requiredCapabilities: [],
      allowedRoles: ['main'],
      readOnly: true,
      timeout: 250,
      rootScope: 'workspace',
      telemetryKind: 'tool_call',
      handler: async (args, context) => {
        state.toolCalls++;
        await waitWithSignal(task.toolDelayMs || 0, context.signal);
        if (task.fault === 'tool_failure' && state.failures === 0) {
          state.failures++;
          return { ok: false, error: { type: 'tool_failure', code: 'offline_tool_failure', message: 'injected offline tool failure', recoverable: true, recommendedAction: 'continue_with_explicit_fallback' } };
        }
        return { ok: true, step: Number(args.step) || 0, source: 'offline-mock' };
      },
    }],
  });
}

function runtimeCache(task, warm) {
  if (!task.cache) return { mode: 'unknown', source: 'unknown', dataOrigin: 'unknown', unknownReason: 'not_cache_eligible' };
  const eligibleTokens = 160;
  return {
    mode: warm ? 'warm' : 'cold',
    eligibleTokens,
    inputTokens: 24,
    cacheReadTokens: warm ? eligibleTokens : 0,
    cacheWriteTokens: warm ? null : eligibleTokens,
    source: 'estimated',
    dataOrigin: 'offline-mock',
    prefixFingerprint: 'offline-runtime-' + task.id,
    estimatedSavedCostUsd: warm ? 0.00032 : 0,
  };
}

const OFFLINE_PRICES = Object.freeze({
  inputPer1k: 0.000001,
  outputPer1k: 0.000003,
  cacheReadPer1k: 0.0000002,
  cacheWritePer1k: 0.0000015,
  catalogVersion: 'offline-mock',
});

function runtimeCost(inputTokens, outputTokens, cache) {
  return calculateCost({ provider: 'offline-mock', model: 'offline-mock', usage: { inputTokens, outputTokens }, cache, prices: OFFLINE_PRICES });
}

function stableBenchmarkValue(value, requestIndex) {
  if (Array.isArray(value)) return value.map((item) => stableBenchmarkValue(item, requestIndex));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'startedAt' || key === 'finishedAt' || key === 'elapsedMs') continue;
    if (key === 'requestId') { out[key] = 'offline-request-' + requestIndex; continue; }
    if (key === 'id' && typeof child === 'string' && /^(chat|mc|bench_)/.test(child)) { out[key] = 'offline-id-' + requestIndex; continue; }
    if (key === 'latencyMs' || key === 'durationMs' || key === 'processMs') { out[key] = 0; continue; }
    out[key] = stableBenchmarkValue(child, requestIndex);
  }
  return out;
}

async function runRuntimeBenchmarkTask(task, options) {
  const opts = options || {};
  const startedAt = Date.now();
  const controller = new AbortController();
  const counters = { toolCalls: 0, failures: 0 };
  const metrics = [];
  const storedEvents = [];
  const storedRuns = new Map();
  const runId = 'bench_' + task.id + '_' + String(opts.seed || 1337);
  const registry = createRuntimeBenchmarkRegistry(task, counters);
  const runStore = {
    createAgentRun(run) { storedRuns.set(run.id, Object.assign({}, run)); },
    updateAgentRun(id, patch) { if (storedRuns.has(id)) Object.assign(storedRuns.get(id), patch || {}); },
    appendAgentEvent(id, type, payload, seq) { storedEvents.push({ id: id + ':' + seq, runId: id, seq, type, payload, createdAt: Date.now() }); },
  };
  let modelCalls = 0;
  let toolsIssued = 0;
  const warm = opts.mode === 'replay' || task.kind === 'cache' || task.kind === 'cache-invalidation';
  const cancelTimer = task.fault === 'cancelled'
    ? setTimeout(() => controller.abort({ type: 'cancelled', code: 'offline_cancelled', message: 'injected offline cancellation', recoverable: false }), 1)
    : null;
  const modelCall = async ({ signal, step }) => {
    modelCalls++;
    if (task.fault === 'provider_failure') throw { type: 'model_failure', code: 'offline_provider_failure', message: 'injected provider health failure', recoverable: true, recommendedAction: 'manual_fallback' };
    if (task.fault === 'malformed_result') return null;
    await waitWithSignal(task.fault === 'cancelled' ? 20 : 0, signal);
    const queueWaitMs = step === 0 && task.queueWaitMs != null ? task.queueWaitMs : null;
    if (toolsIssued < Number(task.baseTools || 0)) {
      const callId = runId + '_tool_' + toolsIssued;
      toolsIssued++;
      return {
        content: '',
        toolCalls: [{ id: callId, name: 'benchmark_step', arguments: JSON.stringify({ step }) }],
        usage: { inputTokens: 24, outputTokens: 6 },
        cache: runtimeCache(task, warm),
        cost: runtimeCost(24, 6, runtimeCache(task, warm)),
        queueWaitMs,
      };
    }
    return {
      content: 'offline runtime result for ' + task.id,
      usage: { inputTokens: 24, outputTokens: 8 },
      cache: runtimeCache(task, warm),
      cost: runtimeCost(24, 8, runtimeCache(task, warm)),
      queueWaitMs,
    };
  };
  const result = await runAgent({
    runId,
    rootRunId: runId,
    prompt: task.id,
    role: 'main',
    context: task.kind === 'permission' ? { permission: () => ({ ok: false, error: { type: 'permission_failure', code: 'offline_root_scope_denied', message: 'injected root scope denial', recoverable: false } }) } : {},
    maxSteps: Math.max(2, Number(task.baseSteps) || 2),
    budget: Object.assign({ maxSteps: Math.max(2, Number(task.baseSteps) || 2) }, task.budget || {}),
    modelId: 'offline-mock-model',
    provider: 'offline-mock',
    module: 'benchmark',
    promptVersion: PROMPT_VERSION,
    toolsetVersion: TOOLSET_VERSION,
    runtimeVersion: RUNTIME_VERSION,
  }, {
    signal: controller.signal,
    toolRegistry: registry,
    modelCall,
    runStore,
    recordModelCallMetric: (metric) => metrics.push(metric),
  });
  if (cancelTimer) clearTimeout(cancelTimer);
  const cache = result.usage && result.usage.cache ? result.usage.cache : makeCacheMetrics({ source: 'unknown', unknownReason: 'no_runtime_usage' });
  const status = result.status === 'completed' ? 'completed' : result.status;
  const errors = {};
  if (result.error && result.error.type) errors[result.error.type] = 1;
  if (counters.failures) errors.tool_failure = counters.failures;
  const processMs = 2 + ((Number(opts.seed) || 1337) + String(task.id).length) % 7;
  const stableTrace = storedEvents.map((event, index) => Object.assign({}, stableBenchmarkValue(event, index + 1), {
    id: runId + ':event:' + (index + 1),
    seq: index + 1,
    createdAt: index + 1,
  }));
  return {
    suite: opts.suite,
    task: task.id,
    status,
    success: status === 'completed',
    runId,
    runtimeVersion: RUNTIME_VERSION,
    promptVersion: PROMPT_VERSION,
    toolsetVersion: TOOLSET_VERSION,
    model: 'offline-mock',
    steps: result.usage && result.usage.steps != null ? result.usage.steps : modelCalls,
    toolCalls: result.usage && result.usage.toolCalls != null ? result.usage.toolCalls : counters.toolCalls,
    inputTokens: result.usage ? result.usage.inputTokens : null,
    outputTokens: result.usage ? result.usage.outputTokens : null,
    cache,
    cost: result.usage && result.usage.cost ? result.usage.cost : mergeCosts(metrics.map((metric) => metric.cost || {})),
    costUsd: result.usage && result.usage.cost ? result.usage.cost.totalUsd : null,
    latencyMs: processMs + (Number(task.queueWaitMs) || 0),
    queueWaitMs: Number(task.queueWaitMs) || 0,
    processMs,
    humanInterventions: task.fault === 'manual_fallback' ? 1 : 0,
    recoveryRate: task.fault === 'tool_failure' && counters.failures ? 1 : (task.fault === 'manual_fallback' ? 1 : null),
    failures: Object.values(errors).reduce((sum, value) => sum + value, 0),
    errorBreakdown: errors,
    budget: stableBenchmarkValue(result.budget, 0),
    trace: stableTrace,
    traceEventCount: stableTrace.length,
  };
}

async function runBenchmarkSuiteAsync(options) {
  const opts = options || {};
  const suite = String(opts.suite || 'multi-agent');
  const mode = String(opts.mode || 'offline');
  if (mode === 'replay') return runBenchmarkSuite(opts);
  const tasks = SUITES[suite] || SUITES['multi-agent'];
  const seed = Number(opts.seed || 1337);
  const results = [];
  for (const task of tasks) results.push(await runRuntimeBenchmarkTask(task, { suite, mode, seed }));
  return {
    reportVersion: 2,
    schemaVersion: 16,
    suiteVersion: 2,
    suite,
    mode,
    seed,
    runtimeVersion: RUNTIME_VERSION,
    promptVersion: PROMPT_VERSION,
    toolsetVersion: TOOLSET_VERSION,
    model: 'offline-mock',
    harness: 'run-agent-runtime',
    durationMs: results.reduce((sum, item) => sum + (Number(item.latencyMs) || 0), 0),
    results,
    summary: summarize(results),
    warnings: [],
  };
}

function compareBenchmarkReports(baseline, current, limits) {
  const before = baseline && baseline.summary || {};
  const after = current && current.summary || {};
  const maxSuccessDrop = Number(limits && limits.maxSuccessDrop) || 0.05;
  const maxMetricIncrease = Number(limits && limits.maxMetricIncrease) || 0.1;
  const ratio = (a, b) => a == null || b == null || Number(a) === 0 ? null : Number(b) / Number(a) - 1;
  const checks = {
    successRate: { baseline: before.successRate, current: after.successRate, delta: (Number(after.successRate) || 0) - (Number(before.successRate) || 0), pass: (Number(before.successRate) || 0) - (Number(after.successRate) || 0) <= maxSuccessDrop },
    inputTokens: { baseline: before.inputTokens, current: after.inputTokens, change: ratio(before.inputTokens, after.inputTokens), pass: ratio(before.inputTokens, after.inputTokens) == null || ratio(before.inputTokens, after.inputTokens) <= maxMetricIncrease },
    costUsd: { baseline: before.costUsd, current: after.costUsd, change: ratio(before.costUsd, after.costUsd), pass: ratio(before.costUsd, after.costUsd) == null || ratio(before.costUsd, after.costUsd) <= maxMetricIncrease },
    latencyP95: { baseline: before.latencyP95, current: after.latencyP95, change: ratio(before.latencyP95, after.latencyP95), pass: ratio(before.latencyP95, after.latencyP95) == null || ratio(before.latencyP95, after.latencyP95) <= maxMetricIncrease },
    cacheWarmHitRate: {
      baseline: before.cache && before.cache.hitRate,
      current: after.cache && after.cache.hitRate,
      delta: before.cache && after.cache && before.cache.hitRate != null && after.cache.hitRate != null ? Number(after.cache.hitRate) - Number(before.cache.hitRate) : null,
      pass: before.cache == null || after.cache == null || before.cache.hitRate == null || after.cache.hitRate == null || Number(before.cache.hitRate) - Number(after.cache.hitRate) <= maxSuccessDrop,
    },
  };
  return { pass: Object.values(checks).every((check) => check.pass), baseline: before, current: after, checks, thresholds: { maxSuccessDrop, maxMetricIncrease } };
}

module.exports = { SUITES, seededRandom, makeCacheMetrics, mergeCacheMetrics, createMockProvider, replayEvents, loadReplayFile, runTask, summarize, runBenchmarkSuite, runRuntimeBenchmarkTask, runBenchmarkSuiteAsync, compareBenchmarkReports, percentile };
