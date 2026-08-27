'use strict';
// 审批文案纯模块回归（v1.2.0 批次 7 第四刀）
const test = require('node:test');
const assert = require('node:assert');
const { denialSuggestion, approvalMsg } = require('../../src/infrastructure/agent-runtime/approval-messages.js');

test('approvalMsg：超时/拒绝分支文案区分，批准返回 null', () => {
  const t = approvalMsg('timeout', '该命令', 'npm test');
  assert.ok(t.includes('等待审批超时') && t.includes('该命令'));
  assert.ok(approvalMsg(false, '该命令', 'rm -rf /').includes('用户拒绝了该命令'));
  assert.equal(approvalMsg(true, '该命令', 'x'), null);
});

test('denialSuggestion：git/命令/写文件/联网/执行 分支各给替代方向', () => {
  assert.ok(denialSuggestion('该命令', 'git push origin').includes('只读 git 操作'));
  assert.ok(denialSuggestion('该命令', 'curl example.com').includes('拆分为更安全的只读命令'));
  assert.ok(denialSuggestion('写文件', 'src/a.js').includes('缩小修改范围'));
  assert.ok(denialSuggestion('联网搜索', 'web x').includes('read_file / glob / grep'));
  assert.ok(denialSuggestion('执行验证', 'run anything').includes('run_tests / run_lint'));
  assert.ok(denialSuggestion('其他', 'zzz').includes('不要原样重复申请'));
});
