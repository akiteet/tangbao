'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readRuntimeSource, readRendererSource, readMainSource } = require('./source-helper');

const ROOT = path.join(__dirname, '../..');
const server = readRuntimeSource(ROOT);
const prompt = fs.readFileSync(path.join(ROOT, 'src/core/models/agent-prompt.js'), 'utf8');
const controlled = fs.readFileSync(path.join(ROOT, 'src/core/agent-runtime/controlled-eval.js'), 'utf8');

test('验证命令和专用验证工具失败后回到 implementing', () => {
  assert.match(server, /if \(isVerificationCommand && sh\.code !== 0 && typeof opts\.setPhase === 'function'\) opts\.setPhase\('implementing'\)/);
  assert.match(server, /if \(!allOk && typeof opts\.setPhase === 'function'\) opts\.setPhase\('implementing'\)/);
  assert.match(server, /验证失败，已回到 implementing/);
});

test('策略拒绝不会累计为连续真实工具失败', () => {
  assert.match(server, /const policyFailure = \['phase_restricted', 'not_allowed', 'sandbox_denied', 'approval_denied', 'bad_request'\]\.includes\(errorCode\)/);
  assert.match(server, /if \(!policyFailure\) countableExecutionFailure = true/);
  assert.match(server, /if \(!stepOk && countableExecutionFailure\) consecutiveFails\+\+/);
});

test('Eval 编码任务要求实际变更但不向 Runtime 注入 benchmark checks', () => {
  assert.match(controlled, /requireChange: !\(task\.tags \|\| \[\]\)\.some/);
  assert.match(server, /requireChange: body\.requireChange === true/);
  assert.doesNotMatch(server, /expectedChecks/);
});

test('Prompt 强制多条件 TODO、零修改不得完成和验证失败修复闭环', () => {
  assert.match(prompt, /多步、多文件或包含多个验收条件的任务/);
  assert.match(prompt, /编码任务若尚无实际文件变更，不得声称完成/);
  assert.match(prompt, /验证命令失败后，读取失败输出并回到实现阶段修改/);
});

test('工具错误反馈保留 code、可重试性与调整方案提示', () => {
  assert.match(server, /const code = r\.error\.code \? '\（' \+ r\.error\.code \+ '\）' : ''/);
  assert.match(server, /不可原样重试/);
  assert.match(server, /先修正触发原因，再重试/);
});
