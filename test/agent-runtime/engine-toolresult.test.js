'use strict';
// 工具结果管线行为回归（v1.2.0 批次 2）：normalizeResult / formatToolResult 纯函数
const test = require('node:test');
const assert = require('node:assert');
const engine = require('../../src/infrastructure/agent-runtime/agent-runtime-engine.js');

test('normalizeResult：对象结果补全默认字段并透传语义', () => {
  const r = engine.normalizeResult({ ok: true, summary: '已完成' }, { durationMs: 12 });
  assert.equal(r.ok, true);
  assert.equal(r.summary, '已完成');
  assert.equal(r.durationMs, 12);
  // ok:false 且无 error 时自动补 error（模型需要结构化失败原因）
  const bad = engine.normalizeResult({ ok: false, summary: '没找到文件' }, {});
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'tool_error');
});

test('normalizeResult：对象 error.message 兜底为 summary', () => {
  const r = engine.normalizeResult({ ok: false, error: { code: 'x', message: '炸了' } }, {});
  assert.equal(r.summary, '炸了');
  assert.equal(r.error.code, 'x');
});

test('normalizeResult：裸字符串兜底分支——错误前缀判失败，普通文案判成功', () => {
  const bad = engine.normalizeResult('读取失败: nope', {});
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'tool_error');
  const good = engine.normalizeResult('已写入 3 行', {});
  assert.equal(good.ok, true);
  assert.equal(good.summary, '已写入 3 行');
});

test('formatToolResult：成功仅 summary；失败带错误码与重试提示', () => {
  assert.equal(engine.formatToolResult({ ok: true, summary: 'ok-text' }), 'ok-text');
  const out = engine.formatToolResult({ ok: false, summary: '', error: { code: 'empty_command', message: '命令为空', retryable: false } });
  assert.ok(out.includes('命令为空'), '必须包含错误信息');
  assert.ok(out.includes('empty_command'), '必须包含错误码');
  assert.ok(out.includes('[不可原样重试]'), '不可重试错误必须有明确提示');
  const retryable = engine.formatToolResult({ ok: false, summary: '', error: { code: 'net', message: '网络抖动', retryable: true } });
  assert.ok(retryable.includes('[可重试]'));
});

test('formatToolResult：截断与退出码提示', () => {
  let out = engine.formatToolResult({ ok: true, summary: 's', truncated: true });
  assert.ok(out.includes('[输出已截断'), '截断必须提示模型');
  out = engine.formatToolResult({ ok: true, summary: 's', truncated: true, nextCursor: 5 });
  assert.ok(out.includes('cursor 继续读取'), '有游标时提示续读方式');
  out = engine.formatToolResult({ ok: true, summary: 's', exitCode: 2 });
  assert.ok(out.includes('[退出码 2]'));
});

test('formatToolResult：非对象输入原样字符串化', () => {
  assert.equal(engine.formatToolResult(null), '');
  assert.equal(engine.formatToolResult('plain'), 'plain');
});
