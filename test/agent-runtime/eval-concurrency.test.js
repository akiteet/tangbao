'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('主进程评测并发上限为 3 且用计数锁（不再单实例）', () => {
  const main = read('src/main/main.js');
  assert.match(main, /const MAX_CONCURRENT_EVAL = 3;/);
  assert.match(main, /let controlledEvalCount = 0;/);
  assert.match(main, /if \(controlledEvalCount >= MAX_CONCURRENT_EVAL\) return \{ ok: false, error: '已有 ' \+ MAX_CONCURRENT_EVAL \+ ' 个安全评测在运行' \};/);
  assert.match(main, /controlledEvalCount\+\+;/);
  assert.match(main, /controlledEvalCount--;/);
  // 不再使用旧布尔锁
  assert.doesNotMatch(main, /controlledEvalRunning = true;/);
  assert.doesNotMatch(main, /已有安全评测正在运行/);
});

test('主进程 evalTasks 扫描历史通过并识别早停指标不完整', () => {
  const main = read('src/main/main.js');
  assert.match(main, /eval-result\.json/);
  assert.match(main, /machinePassed === true && r\.id/);
  assert.match(main, /passedIds\.add\(id\)/);
  assert.match(main, /latestPassedById\.set\(id, r\)/);
  assert.match(main, /alreadyPassed: passedIds\.has\(id\)/);
  assert.match(main, /latestPassed\.status === 'completed_by_judge'/);
  assert.match(main, /metricIncomplete/);
  // runsRoot 与受控评测落盘目录一致
  assert.match(main, /tangbao-data', 'eval-runs/);
  assert.match(main, /eval-runtime-readiness\.json/);
  assert.match(main, /missingRuntimes/);
});
