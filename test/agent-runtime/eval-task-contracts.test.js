'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { judgeTask } = require('../../src/core/agent-runtime/eval-judge');

const ROOT = path.join(__dirname, '../..');
const tasks = JSON.parse(fs.readFileSync(path.join(ROOT, 'benchmarks/tasks.json'), 'utf8')).tasks;
const byId = new Map(tasks.map((task) => [task.id, task]));
const affected = ['simple-004', 'med-002', 'med-004', 'med-005', 'med-006', 'med-007', 'complex-001', 'complex-002', 'complex-003', 'complex-004', 'complex-006', 'complex-007', 'ml-py-001', 'ml-ts-001'];

test('14 个受影响任务均存在且仍使用结构化 checks', () => {
  assert.equal(affected.every((id) => byId.has(id)), true);
  assert.equal(affected.every((id) => byId.get(id).expectedChecks.every((check) => check && typeof check === 'object')), true);
});

test('任务契约不再使用 Windows 易碎 node -e 字符串或目录测试参数', () => {
  const checks = tasks.flatMap((task) => task.expectedChecks || []);
  const commands = checks.filter((check) => check && check.type === 'command').map((check) => check.command || '');
  assert.equal(commands.some((command) => /node\s+-e\s+/.test(command)), false);
  assert.equal(commands.some((command) => /node\s+--test\s+test\//.test(command)), false);
  assert.equal(checks.filter((check) => check && check.type === 'test_files').length, 5);
  assert.equal(checks.filter((check) => check && check.type === 'command' && check.runtime === 'node' && Array.isArray(check.args)).length >= 9, true);
});

test('Python 任务使用可检测 runtime，而不是裸 shell 命令', () => {
  const check = byId.get('ml-py-001').expectedChecks.find((item) => item.type === 'command');
  assert.equal(check.runtime, 'python');
  assert.deepEqual(check.args, ['-m', 'py_compile', 'src/main.py']);
  assert.equal(check.command, undefined);
});

test('仅四个目标任务使用向上取整的25%预算配置', () => {
  const overrides = tasks.filter((task) => task.budgetProfile).map((task) => [task.id, task.previousTimeoutSteps, task.timeoutSteps, task.budgetProfile]);
  assert.deepEqual(overrides, [
    ['med-005', 10, 13, 'targeted_plus_25_percent'],
    ['complex-004', 20, 25, 'targeted_plus_25_percent'],
    ['complex-006', 28, 35, 'targeted_plus_25_percent'],
    ['ml-ts-001', 10, 13, 'targeted_plus_25_percent'],
  ]);
});

test('med-007 接受合法对象方法实现，但占位 logger 仍不能通过', (t) => {
  const task = byId.get('med-007');
  const original = path.join(ROOT, 'benchmarks/fixtures/med-logging');
  // 合法实现来自 8-07 真实评测产物（历史存档目录；若不存在则跳过，不因评测目录轮换而失败）
  const completed = 'C:/Users/18860/AppData/Roaming/tangbao-web/tangbao-data/eval-runs-archive-20260808/med-007-2026-08-07T08-22-22-651Z-27160-a5a642df';
  if (!fs.existsSync(completed)) { t.skip('评测历史存档 med-007 目录不存在'); return; }
  const done = judgeTask(task, { cwd: completed, status: 'blocked', events: [] });
  assert.equal(done.ok, true);
  const placeholder = judgeTask(task, { cwd: original, status: 'completed', events: [] });
  assert.equal(placeholder.ok, false);
});
