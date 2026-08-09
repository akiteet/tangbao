'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../src/core/agent-runtime/subagent-contract');

test('结构化结果补齐缺失字段并保留 evidence/checks', () => {
  const result = C.normalize({
    summary: '发现风险',
    findings: [{ severity: 'HIGH', title: '越界', detail: '详情', evidence: [{ path: 'src/a.js', line: 7, detail: '证据' }] }],
    checks: [{ name: '语法', status: 'passed' }],
  }, { steps: 2, toolsUsed: 3, durationMs: 40 });
  assert.equal(result.ok, true);
  assert.equal(result.findings[0].severity, 'high');
  assert.deepEqual(result.findings[0].evidence[0], { path: 'src/a.js', startLine: 7, endLine: 7, detail: '证据' });
  assert.equal(result.checks[0].status, 'passed');
  assert.equal(result.steps, 2);
  assert.equal(result.error, null);
});

test('空摘要、非法 JSON 和错误结果均有稳定协议', () => {
  const empty = C.normalize('');
  assert.equal(empty.ok, true);
  assert.ok(empty.summary);
  const parsed = C.normalize('前置说明\n```json\n{"ok":false,"summary":"失败","error":{"code":"x","message":"bad"}}\n```');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'x');
  const invalid = C.normalize({ ok: false, summary: '失败' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, 'subagent_failed');
});

test('错误对象始终包含稳定的 code/message/retryable 字段', () => {
  const result = C.normalize({ ok: false, summary: '模型异常', error: {} });
  assert.deepEqual(result.error, { code: 'subagent_failed', message: '子代理执行失败', retryable: false });
});

test('聚合结果区分全成功、部分失败和全失败', () => {
  const all = C.aggregate([{ ok: true, summary: 'a' }, { ok: true, summary: 'b' }]);
  assert.equal(all.status, 'completed');
  assert.equal(all.ok, true);
  const partial = C.aggregate([{ ok: true, summary: 'a' }, { ok: false, summary: 'b', error: { code: 'x', message: 'bad' } }]);
  assert.equal(partial.status, 'degraded');
  assert.equal(partial.ok, false);
  assert.equal(partial.failures.length, 1);
  const failed = C.aggregate([{ ok: false, summary: 'a' }]);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.ok, false);
});
