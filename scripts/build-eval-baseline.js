'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveRuntime } = require('../src/core/agent-runtime/eval-judge');
const dataLocation = require('../src/infrastructure/storage/data-location');

const PROJECT_ROOT = path.join(__dirname, '..');
const DEFAULT_TASKS = path.join(PROJECT_ROOT, 'benchmarks', 'tasks.json');
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, 'benchmarks', 'last-eval.json');
function resolveDefaultDataRoot() {
  const defaultUserDataRoot = path.join(os.homedir(), 'AppData', 'Roaming', 'tangbao-web');
  const pointer = dataLocation.readLocation(defaultUserDataRoot);
  const activeRoot = pointer && pointer.rootPath ? pointer.rootPath : defaultUserDataRoot;
  return path.join(activeRoot, 'tangbao-data');
}

const DEFAULT_DATA_ROOT = process.env.TANGBAO_DATA || resolveDefaultDataRoot();
const DEFAULT_RUNS = process.env.TANGBAO_EVAL_RUNS || path.join(DEFAULT_DATA_ROOT, 'eval-runs');
const DEFAULT_READINESS = process.env.TANGBAO_EVAL_RUNTIME_READINESS || path.join(DEFAULT_DATA_ROOT, 'eval-runtime-readiness.json');

function parseArgs(argv) {
  const args = { tasks: DEFAULT_TASKS, output: DEFAULT_OUTPUT, runsRoot: DEFAULT_RUNS, readinessFile: DEFAULT_READINESS, missingRuntimes: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tasks' && argv[i + 1]) args.tasks = path.resolve(argv[++i]);
    else if (argv[i] === '--output' && argv[i + 1]) args.output = path.resolve(argv[++i]);
    else if (argv[i] === '--runs-root' && argv[i + 1]) args.runsRoot = path.resolve(argv[++i]);
    else if (argv[i] === '--readiness-file' && argv[i + 1]) args.readinessFile = path.resolve(argv[++i]);
    else if (argv[i] === '--missing-runtime' && argv[i + 1]) args.missingRuntimes.push(String(argv[++i]).toLowerCase());
    else throw new Error('unknown_argument:' + argv[i]);
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function automaticTasks(tasksFile) {
  const parsed = readJson(tasksFile);
  const tasks = (parsed.tasks || []).filter((task) => task && task.id && task.goal && task.fixtureDir && !task.manualOnly);
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error('duplicate_task_id:' + task.id);
    ids.add(task.id);
  }
  return tasks;
}

function readRuns(runsRoot) {
  if (!fs.existsSync(runsRoot)) throw new Error('eval_runs_missing:' + runsRoot);
  const runs = [];
  for (const dir of fs.readdirSync(runsRoot)) {
    const file = path.join(runsRoot, dir, 'eval-result.json');
    if (!fs.existsSync(file)) continue;
    let result;
    try { result = readJson(file); }
    catch (error) { throw new Error('invalid_eval_result:' + file + ':' + error.message); }
    if (!result || !result.id || !result.at) throw new Error('invalid_eval_result_shape:' + file);
    runs.push(Object.assign({}, result, { _selectedRunDir: dir }));
  }
  return runs;
}

function requiredRuntimes(task) {
  return Array.from(new Set((task.expectedChecks || []).map((check) => check && check.runtime).filter(Boolean).map((value) => String(value).toLowerCase())));
}

function newest(list) {
  return list.slice().sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
}

function cleanSelectedResult(result, selectionReason) {
  const selectedRunDir = result._selectedRunDir || (result.runDir ? path.basename(result.runDir) : '');
  const copy = Object.assign({}, result);
  const metricIncomplete = copy.machinePassed === true && copy.status === 'completed_by_judge' && !(Number(copy.steps) > 0);
  if (metricIncomplete) {
    copy.steps = null;
    copy.stepsSource = 'metric_incomplete';
    copy.metricIncomplete = true;
  }
  delete copy._selectedRunDir;
  delete copy.runDir;
  delete copy.diagnostics;
  copy.selectedRunDir = selectedRunDir;
  copy.selectedAt = result.at;
  copy.selectionReason = selectionReason;
  return copy;
}

function syntheticRuntimeSkip(task, missing) {
  return {
    reportVersion: 2,
    at: new Date().toISOString(),
    id: task.id,
    title: task.title,
    status: 'infrastructure_skipped',
    machinePassed: false,
    selfReportedDone: false,
    steps: 0,
    stepsSource: 'not_started',
    segmentSteps: 0,
    toolCalls: 0,
    failures: 0,
    durationMs: 0,
    error: '缺少运行时：' + missing.join(', '),
    judgment: {
      ok: false,
      completed: false,
      checks: [],
      mode: 'infrastructure-skipped',
      hasChange: false,
      hasVerification: false,
      infrastructureSkipped: true,
      infrastructureFailures: missing.map((runtime) => ({ type: 'runtime', runtime, error: 'runtime_unavailable' })),
    },
    infrastructureFailure: true,
    attempts: [],
    retryReason: '',
    selectedRunDir: '',
    selectedAt: '',
    selectionReason: 'runtime_unavailable',
  };
}

function selectResult(task, taskRuns, missingRuntimes) {
  const missing = requiredRuntimes(task).filter((runtime) => missingRuntimes.has(runtime));
  if (missing.length) return syntheticRuntimeSkip(task, missing);
  const passed = newest(taskRuns.filter((result) => result.machinePassed === true));
  if (passed) return cleanSelectedResult(passed, 'latest_machine_passed');
  const behavioral = newest(taskRuns.filter((result) => !result.infrastructureFailure && result.status !== 'infrastructure_skipped'));
  if (behavioral) return cleanSelectedResult(behavioral, 'latest_behavioral_result');
  const infrastructure = newest(taskRuns.filter((result) => result.infrastructureFailure || result.status === 'infrastructure_skipped'));
  if (infrastructure) return cleanSelectedResult(infrastructure, 'latest_infrastructure_result');
  throw new Error('missing_eval_result:' + task.id);
}

function metricsFor(results) {
  const passed = results.filter((result) => result.machinePassed === true).length;
  const infrastructureSkipped = results.filter((result) => result.status === 'infrastructure_skipped').length;
  const infrastructureFailed = results.filter((result) => result.infrastructureFailure && result.status !== 'infrastructure_skipped').length;
  const behavioralFailed = results.length - passed - infrastructureSkipped - infrastructureFailed;
  const diagnosableTotal = results.length - infrastructureSkipped - infrastructureFailed;
  const metricComplete = results.filter((result) => result.steps != null && result.metricIncomplete !== true && !result.infrastructureFailure && result.status !== 'infrastructure_skipped');
  const sum = (key, list = results) => list.reduce((total, result) => total + (Number(result[key]) || 0), 0);
  return {
    machinePassed: passed,
    total: results.length,
    machineSuccessRate: results.length ? passed / results.length : 0,
    diagnosableTotal,
    diagnosableSuccessRate: diagnosableTotal ? passed / diagnosableTotal : 0,
    behavioralFailed,
    infrastructureFailed,
    infrastructureSkipped,
    metricCompleteCount: metricComplete.length,
    metricIncompleteCount: results.filter((result) => result.metricIncomplete === true).length,
    totalSteps: sum('steps', metricComplete),
    averageSteps: metricComplete.length ? sum('steps', metricComplete) / metricComplete.length : null,
    totalToolCalls: sum('toolCalls'),
    totalFailures: sum('failures'),
    totalDurationMs: sum('durationMs'),
  };
}

function buildBaseline(options) {
  const tasks = automaticTasks(options.tasks);
  const runs = readRuns(options.runsRoot);
  const required = Array.from(new Set(tasks.flatMap(requiredRuntimes)));
  let runtimeReadiness = null;
  if (options.readinessFile && fs.existsSync(options.readinessFile)) {
    try { runtimeReadiness = readJson(options.readinessFile); }
    catch (error) { throw new Error('invalid_runtime_readiness:' + options.readinessFile + ':' + error.message); }
  }
  const detectedMissing = required.filter((runtime) => runtimeReadiness && runtimeReadiness.runtimes && typeof runtimeReadiness.runtimes[runtime] === 'boolean'
    ? runtimeReadiness.runtimes[runtime] === false
    : !resolveRuntime(runtime));
  const missingRuntimes = new Set([].concat(options.missingRuntimes || [], detectedMissing));
  const byTask = new Map(tasks.map((task) => [task.id, []]));
  for (const result of runs) if (byTask.has(result.id)) byTask.get(result.id).push(result);
  const results = tasks.map((task) => selectResult(task, byTask.get(task.id), missingRuntimes));
  const metrics = metricsFor(results);
  const budgetOverrides = tasks.filter((task) => task.budgetProfile).map((task) => ({
    id: task.id,
    profile: task.budgetProfile,
    previousTimeoutSteps: Number(task.previousTimeoutSteps) || null,
    timeoutSteps: Number(task.timeoutSteps) || null,
  }));
  return {
    reportVersion: 3,
    at: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
    generator: 'scripts/build-eval-baseline.js@1',
    source: 'desktop-controlled-eval',
    model: 'desktop-configured-model',
    cwd: 'isolated-fixtures',
    baselineQuality: 'clean_incremental',
    baselineMode: 'incremental-cumulative',
    archivedBaseline: 'benchmarks/first-raw-eval.json',
    budgetProfile: budgetOverrides.length ? 'targeted_plus_25_percent' : 'original',
    budgetOverrides,
    runtimeReadiness: runtimeReadiness ? { source: options.readinessFile, at: runtimeReadiness.at || '', runtimes: runtimeReadiness.runtimes || {} } : { source: 'generator-process', runtimes: Object.fromEntries(required.map((runtime) => [runtime, !missingRuntimes.has(runtime)])) },
    selectionPolicy: {
      passed: 'latest machinePassed=true result',
      failed: 'latest non-infrastructure result when no passing result exists',
      runtimeUnavailable: 'synthetic infrastructure_skipped result',
      infrastructureOnly: 'latest infrastructure result',
    },
    results,
    metrics,
    diagnostics: {
      knownContaminationCount: 0,
      interpretation: 'Clean incremental baseline. Results may come from different desktop batches; use a same-version full rerun for strict model comparisons.',
    },
  };
}

function writeBaseline(options) {
  const report = buildBaseline(options);
  fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = writeBaseline(options);
    console.log(JSON.stringify({ output: options.output, quality: report.baselineQuality, metrics: report.metrics }, null, 2));
  } catch (error) {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  }
}

module.exports = { resolveDefaultDataRoot, parseArgs, automaticTasks, readRuns, requiredRuntimes, selectResult, metricsFor, buildBaseline, writeBaseline };
