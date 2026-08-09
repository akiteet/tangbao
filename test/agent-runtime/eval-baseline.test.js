'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { buildBaseline, metricsFor, resolveDefaultDataRoot } = require('../../scripts/build-eval-baseline');

function writeResult(root, dir, result) {
  const target = path.join(root, dir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'eval-result.json'), JSON.stringify(result));
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-eval-baseline-'));
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(runsRoot);
  const tasks = [
    { id: 'passed', goal: 'x', fixtureDir: 'fixtures/a', expectedChecks: [] },
    { id: 'failed', goal: 'x', fixtureDir: 'fixtures/b', expectedChecks: [] },
    { id: 'python', goal: 'x', fixtureDir: 'fixtures/c', expectedChecks: [{ type: 'command', runtime: 'python', args: ['-V'] }] },
    { id: 'infra', goal: 'x', fixtureDir: 'fixtures/d', expectedChecks: [] },
  ];
  const tasksFile = path.join(root, 'tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify({ tasks }));
  writeResult(runsRoot, 'passed-old', { id: 'passed', at: '2026-01-01T00:00:00.000Z', machinePassed: true, status: 'completed', steps: 3 });
  writeResult(runsRoot, 'passed-new-fail', { id: 'passed', at: '2026-01-02T00:00:00.000Z', machinePassed: false, status: 'blocked', steps: 5 });
  writeResult(runsRoot, 'failed-old', { id: 'failed', at: '2026-01-01T00:00:00.000Z', machinePassed: false, status: 'blocked', steps: 4 });
  writeResult(runsRoot, 'failed-new', { id: 'failed', at: '2026-01-03T00:00:00.000Z', machinePassed: false, status: 'assertion_failed', steps: 6 });
  writeResult(runsRoot, 'python-old', { id: 'python', at: '2026-01-01T00:00:00.000Z', machinePassed: false, status: 'blocked', steps: 8 });
  writeResult(runsRoot, 'infra-only', { id: 'infra', at: '2026-01-02T00:00:00.000Z', machinePassed: false, status: 'infrastructure_failed', infrastructureFailure: true, steps: 0 });
  return { root, runsRoot, tasksFile };
}

test('增量基线优先保留最新通过，并为缺失运行时合成环境跳过', () => {
  const data = fixture();
  const report = buildBaseline({ tasks: data.tasksFile, runsRoot: data.runsRoot, missingRuntimes: ['python'] });
  assert.equal(report.baselineQuality, 'clean_incremental');
  assert.equal(report.baselineMode, 'incremental-cumulative');
  assert.equal(report.results.length, 4);
  const byId = Object.fromEntries(report.results.map((result) => [result.id, result]));
  assert.equal(byId.passed.selectionReason, 'latest_machine_passed');
  assert.equal(byId.passed.selectedRunDir, 'passed-old');
  assert.equal(byId.failed.selectionReason, 'latest_behavioral_result');
  assert.equal(byId.failed.selectedRunDir, 'failed-new');
  assert.equal(byId.python.status, 'infrastructure_skipped');
  assert.equal(byId.python.steps, 0);
  assert.equal(byId.infra.selectionReason, 'latest_infrastructure_result');
  assert.deepEqual(report.metrics, {
    machinePassed: 1, total: 4, machineSuccessRate: 0.25,
    diagnosableTotal: 2, diagnosableSuccessRate: 0.5,
    behavioralFailed: 1, infrastructureFailed: 1,     infrastructureSkipped: 1,
    metricCompleteCount: 2, metricIncompleteCount: 0,
    totalSteps: 9, averageSteps: 4.5, totalToolCalls: 0, totalFailures: 0, totalDurationMs: 0,
  });
});

test('早停通过但0步的历史结果标记指标不完整且不计入步数平均', () => {
  const data = fixture();
  writeResult(data.runsRoot, 'passed-judge-zero', {
    id: 'passed', at: '2026-01-04T00:00:00.000Z', machinePassed: true,
    status: 'completed_by_judge', completedByJudge: true, steps: 0,
  });
  const report = buildBaseline({ tasks: data.tasksFile, runsRoot: data.runsRoot, missingRuntimes: ['python'] });
  const selected = report.results.find((result) => result.id === 'passed');
  assert.equal(selected.steps, null);
  assert.equal(selected.stepsSource, 'metric_incomplete');
  assert.equal(selected.metricIncomplete, true);
  assert.equal(report.metrics.metricIncompleteCount, 1);
  assert.equal(report.metrics.metricCompleteCount, 1);
  assert.equal(report.metrics.totalSteps, 6);
  assert.equal(report.metrics.averageSteps, 6);
});

test('真实基线生成器优先使用桌面应用持久化的运行时检测结果', () => {
  const projectRoot = path.join(__dirname, '../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-runtime-readiness-'));
  const readinessFile = path.join(temp, 'readiness.json');
  fs.writeFileSync(readinessFile, JSON.stringify({ at: '2026-08-07T00:00:00.000Z', runtimes: { node: true, python: false } }));
  try {
    const report = buildBaseline({
      tasks: path.join(projectRoot, 'benchmarks', 'tasks.json'),
      runsRoot: path.join(resolveDefaultDataRoot(), 'eval-runs'),
      readinessFile,
      missingRuntimes: [],
    });
    assert.equal(report.metrics.total, 23);
    assert.equal(report.metrics.machinePassed, 22);
    assert.equal(report.metrics.diagnosableTotal, 22);
    assert.equal(report.metrics.diagnosableSuccessRate, 1);
    assert.equal(report.metrics.infrastructureSkipped, 1);
    assert.equal(report.results.find((result) => result.id === 'ml-py-001').status, 'infrastructure_skipped');
    assert.equal(report.runtimeReadiness.source, readinessFile);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('指标将环境跳过与基础设施失败排除出可判定分母', () => {
  const metrics = metricsFor([
    { machinePassed: true },
    { machinePassed: false, status: 'blocked' },
    { machinePassed: false, status: 'infrastructure_skipped', infrastructureFailure: true },
    { machinePassed: false, status: 'infrastructure_failed', infrastructureFailure: true },
  ]);
  assert.equal(metrics.machineSuccessRate, 0.25);
  assert.equal(metrics.diagnosableTotal, 2);
  assert.equal(metrics.diagnosableSuccessRate, 0.5);
  assert.equal(metrics.behavioralFailed, 1);
  assert.equal(metrics.infrastructureFailed, 1);
  assert.equal(metrics.infrastructureSkipped, 1);
});

test('任务或运行结果损坏时失败，不静默生成不完整基线', () => {
  const data = fixture();
  const broken = path.join(data.runsRoot, 'broken');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, 'eval-result.json'), '{');
  assert.throws(() => buildBaseline({ tasks: data.tasksFile, runsRoot: data.runsRoot, missingRuntimes: [] }), /invalid_eval_result/);
});
