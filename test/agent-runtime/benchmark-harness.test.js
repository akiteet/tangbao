'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runBenchmarkSuite,
  compareBenchmarkReports,
  replayEvents,
} = require('../../src/core/agent-runtime/benchmark-harness');

test('offline Benchmark 使用固定 seed 可重复且包含平台指标', () => {
  const first = runBenchmarkSuite({ suite: 'multi-agent', mode: 'offline', seed: 7 });
  const second = runBenchmarkSuite({ suite: 'multi-agent', mode: 'offline', seed: 7 });
  assert.deepEqual(first.results, second.results);
  assert.equal(first.results.length, 8);
  assert.equal(typeof first.summary.successRate, 'number');
  assert.ok(Object.hasOwn(first.summary, 'latencyP95'));
  assert.ok(Object.hasOwn(first.summary, 'cache'));
  assert.ok(Object.hasOwn(first.results[0], 'errorBreakdown'));
});

test('Benchmark 比较对成功率和 p95 回归设置门禁', () => {
  const baseline = runBenchmarkSuite({ suite: 'cache', mode: 'offline', seed: 9 });
  const current = JSON.parse(JSON.stringify(baseline));
  current.summary.successRate -= 0.1;
  current.summary.latencyP95 *= 1.2;
  const result = compareBenchmarkReports(baseline, current);
  assert.equal(result.pass, false);
  assert.equal(result.checks.successRate.pass, false);
  assert.equal(result.checks.latencyP95.pass, false);
});

test('Trace replay 从标准事件中恢复模型、工具和缓存指标', () => {
  const result = replayEvents([
    { type: 'llm_call', inputTokens: 10, outputTokens: 4 },
    { type: 'tool_call', status: 'completed' },
    { type: 'cache', payload: { eligibleTokens: 8, cacheReadTokens: 4, source: 'provider' } },
  ]);
  assert.equal(result.steps, 1);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.inputTokens, 10);
  assert.equal(result.cache.hitRate, 0.5);
});
