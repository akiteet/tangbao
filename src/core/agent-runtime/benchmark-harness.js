'use strict';

const fs = require('fs');

const RUNTIME_VERSION = '1.1.2';
const PROMPT_VERSION = '1.1.2';
const TOOLSET_VERSION = '1.1.2';

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
    prefixFingerprint: String(source.prefixFingerprint || ''),
  };
}

function mergeCacheMetrics(items) {
  const values = (Array.isArray(items) ? items : []).map(makeCacheMetrics);
  if (!values.length) return makeCacheMetrics({});
  const sum = (key) => values.some((item) => item[key] == null) ? null : values.reduce((total, item) => total + item[key], 0);
  const eligibleTokens = sum('eligibleTokens');
  const cacheReadTokens = sum('cacheReadTokens');
  return makeCacheMetrics({
    mode: values.some((item) => item.mode === 'unknown') ? 'unknown' : values[values.length - 1].mode,
    eligibleTokens,
    inputTokens: sum('inputTokens'),
    cacheReadTokens,
    cacheWriteTokens: sum('cacheWriteTokens'),
    estimatedCostUsd: sum('estimatedCostUsd'),
    estimatedSavedCostUsd: sum('estimatedSavedCostUsd'),
    source: values.some((item) => item.source === 'unknown') ? 'unknown' : (values.some((item) => item.source === 'estimated') ? 'estimated' : 'provider'),
    prefixFingerprint: values[values.length - 1].prefixFingerprint,
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
        cache: makeCacheMetrics({ mode: task.cache ? (warm ? 'warm' : 'cold') : 'unknown', eligibleTokens: task.cache ? eligibleTokens : null, inputTokens, cacheReadTokens: task.cache ? cacheReadTokens : null, cacheWriteTokens: task.cache && !warm ? eligibleTokens : null, estimatedCostUsd: 0.0014, estimatedSavedCostUsd: task.cache && warm ? 0.0007 : (task.cache ? 0 : null), source: cacheSource, prefixFingerprint: 'offline-' + task.id }),
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
  const success = status === 'completed';
  return { suite: opts.suite, task: task.id, status, success, steps, toolCalls, inputTokens, outputTokens, cache, costUsd: round((inputTokens * 0.000002 + outputTokens * 0.000006), 6), latencyMs: latencyMs + queueWaitMs, queueWaitMs, processMs: latencyMs, humanInterventions, recoveryRate, failures, errorBreakdown, trace: events };
}

function summarize(results) {
  const rows = Array.isArray(results) ? results : [];
  const successCount = rows.filter((row) => row.success === true).length;
  const sum = (key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  const cache = mergeCacheMetrics(rows.map((row) => row.cache || {}));
  return {
    taskCount: rows.length,
    successRate: rows.length ? round(successCount / rows.length, 4) : 0,
    successCount,
    steps: sum('steps'),
    toolCalls: sum('toolCalls'),
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    costUsd: round(rows.reduce((total, row) => total + (Number(row.costUsd) || 0), 0), 6),
    latencyP50: percentile(rows.map((row) => row.latencyMs), 0.5),
    latencyP95: percentile(rows.map((row) => row.latencyMs), 0.95),
    queueWaitMs: sum('queueWaitMs'),
    humanInterventions: sum('humanInterventions'),
    recoveryRate: rows.length ? round(rows.reduce((total, row) => total + (row.recoveryRate == null ? 0 : Number(row.recoveryRate)), 0) / rows.length, 4) : null,
    cache,
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
    reportVersion: 1,
    suite,
    mode: replay.length ? 'replay' : (mode === 'online' ? 'offline-fallback' : mode),
    seed,
    runtimeVersion: RUNTIME_VERSION,
    promptVersion: PROMPT_VERSION,
    toolsetVersion: TOOLSET_VERSION,
    model: mode === 'online' ? (opts.model || 'online-provider-unconfigured') : 'offline-mock',
    results,
    summary: summarize(results),
    warnings: mode === 'online' ? ['No online provider is executed by the local harness; use a configured canary for live runs.'] : [],
  };
  return report;
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
  };
  return { pass: Object.values(checks).every((check) => check.pass), baseline: before, current: after, checks, thresholds: { maxSuccessDrop, maxMetricIncrease } };
}

module.exports = { SUITES, seededRandom, makeCacheMetrics, mergeCacheMetrics, createMockProvider, replayEvents, loadReplayFile, runTask, summarize, runBenchmarkSuite, compareBenchmarkReports, percentile };
