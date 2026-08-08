'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildComparison, agentPassed } = require('../../src/core/agent-runtime/compare-eval');

test('机器判分字段与旧报告回退兼容', () => {
  assert.equal(agentPassed({ machinePassed: true }), true);
  assert.equal(agentPassed({ machinePassed: false }), false);
  assert.equal(agentPassed({ passed: true }), true);
  assert.equal(agentPassed({ status: 'done', judgment: { ok: true } }), true);
  assert.equal(agentPassed({ status: 'done', judgment: { ok: false } }), false);
  assert.equal(agentPassed({ status: 'assertion_failed' }), null);
  assert.equal(agentPassed(null), null);
});

test('对照表包含糖码与外部 Agent 列', () => {
  const tasks = [{ id: 't1', title: '任务一' }];
  const self = { results: [{ id: 't1', machinePassed: true, steps: 5, failures: 1 }] };
  const traces = { codex: { t1: { passed: false, steps: 8, failures: 3 } }, claude: { t1: { passed: true } } };
  const out = buildComparison({ tasks, self, traces });
  assert.deepEqual(out.agents, ['糖码', 'codex', 'claude']);
  assert.equal(out.rows[0].agents['糖码'].passed, true);
  assert.equal(out.rows[0].agents['糖码'].steps, 5);
  assert.equal(out.rows[0].agents.codex.passed, false);
  assert.equal(out.rows[0].agents.claude.passed, true);
  assert.equal(out.stats['糖码'].passed, 1);
  assert.equal(out.stats.codex.passed, 0);
  assert.equal(out.stats.claude.passed, 1);
});

test('未运行的 Agent 不参与通过率统计', () => {
  const tasks = [{ id: 't1', title: 'x' }, { id: 't2', title: 'y' }];
  const self = { results: [{ id: 't1', machinePassed: true }, { id: 't2', machinePassed: false }] };
  const traces = { codex: { t1: { passed: true } } };
  const out = buildComparison({ tasks, self, traces });
  assert.equal(out.stats['糖码'].judged, 2);
  assert.equal(out.stats['糖码'].passRate, 0.5);
  assert.equal(out.stats.codex.judged, 1);
  assert.equal(out.stats.codex.passRate, 1);
  assert.equal(out.rows[1].agents.codex.passed, null);
});
