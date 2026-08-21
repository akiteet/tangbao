'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readRuntimeSource, readRendererSource, readMainSource } = require('./source-helper');

const ROOT = path.join(__dirname, '../..');
const CM = require('../../src/core/agent-runtime/context-manager');
const agentSrc = readRuntimeSource(ROOT);

test('B4：summaryIsValid——current 非空时已删除文件判 stale', () => {
  const summary = { schemaVersion: 2, coveredFromSeq: 1, coveredToSeq: 5, sourceHashes: { 'a.js': 'h1', 'b.js': 'h2' }, requirements: [], constraints: [], completed: [], pending: [], files: [], decisions: [], checks: [], errors: [], nextSteps: [] };
  const deleted = CM.summaryIsValid(summary, { 'b.js': 'h2' }); // a.js 已从工作区消失
  assert.equal(deleted.valid, false, '已删除文件应使摘要失效');
  assert.deepEqual(deleted.stale, ['a.js']);
});

test('B4：summaryIsValid——current 为空对象时不判删除（恢复场景不误伤）', () => {
  const summary = { schemaVersion: 2, coveredFromSeq: 1, coveredToSeq: 5, sourceHashes: { 'a.js': 'h1' }, requirements: [], constraints: [], completed: [], pending: [], files: [], decisions: [], checks: [], errors: [], nextSteps: [] };
  const r = CM.summaryIsValid(summary, {});
  assert.equal(r.valid, true, '空哈希上下文不应触发删除判定');
});

test('B4：verifyChangedHashes 已删除文件（ENOENT）不再误报', () => {
  assert.match(agentSrc, /e\.code === 'ENOENT' \|\| e\.code === 'ENOTDIR'\)\) continue;/, '读取失败中的 ENOENT 应跳过而非判 stale');
});

test('B4：web_search 在 sandbox 模式下被硬拒', () => {
  const i = agentSrc.indexOf("if (name === 'web_search')");
  const seg = agentSrc.slice(i, i + 700);
  assert.match(seg, /permCtx\.mode === 'sandbox'/, 'web_search 应检查 sandbox');
  assert.match(seg, /sandbox_denied/, '应有沙箱拒绝响应');
});

test('B4：create/delete/move_file 审批后补 aborted 检查', () => {
  const i = agentSrc.indexOf("name === 'create_file' || name === 'delete_file' || name === 'move_file'");
  const seg = agentSrc.slice(i, i + 1800);
  assert.match(seg, /if \(aborted\(\)\) return \{ ok: false, error: \{ code: 'cancelled'/, '审批后应有 aborted 检查');
});

test('B4：job 日志 2MB 上限 + runId 绑定 + killRunJobs 清理', () => {
  assert.match(agentSrc, /job\.logs\.length > 2 \* 1024 \* 1024/, 'job 日志应有 2MB 上限');
  assert.match(agentSrc, /const job = \{ child, logs: '', desc: String\(args\.description \|\| command\), runId \};/, 'job 应绑定 runId');
  assert.match(agentSrc, /function killRunJobs\(runId\)/, '应有 killRunJobs');
  assert.match(agentSrc, /try \{ killRunJobs\(runId\); \} catch/, 'req close 应调用 killRunJobs');
});

test('B4：session 结束后延迟释放，避免 Map 无限增长', () => {
  assert.match(agentSrc, /setTimeout\(\(\) => \{ sessions\.delete\(sessionId\); \}, 5 \* 60 \* 1000\)/, 'session close 后应延迟删除');
});
