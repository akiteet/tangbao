'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { judgeTask, runCheck, collectTestFiles, runtimeCandidates } = require('../../src/core/agent-runtime/eval-judge');

test('Agent自报完成但结构化断言失败仍判失败', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-eval-'));
  try {
    const result = judgeTask({ expectedChecks: [{ type: 'file_exists', path: 'missing.js' }] }, { cwd, status: 'completed', events: [{ type: 'done' }] });
    assert.equal(result.ok, false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('结构化文件与命令断言通过才成功', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-eval-'));
  try {
    fs.writeFileSync(path.join(cwd, 'a.js'), 'const value = 1;\n');
    const result = judgeTask({ expectedChecks: [{ type: 'file_contains', path: 'a.js', text: 'value = 1' }, { type: 'command', command: 'node --check a.js' }] }, { cwd, status: 'completed', events: [] });
    assert.equal(result.ok, true);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('旧字符串检查要求完成、变更和验证证据', () => {
  const task = { expectedChecks: ['修复已完成'], tags: ['bugfix'] };
  assert.equal(judgeTask(task, { cwd: '.', status: 'completed', events: [{ type: 'done' }] }).ok, false);
  const events = [{ type: 'tool_diff' }, { type: 'tool_result', payload: { result: { ok: true, data: { kind: 'test' } } } }];
  assert.equal(judgeTask(task, { cwd: '.', status: 'completed', events }).ok, true);
});

test('Node runtime 在 Electron 主进程中强制启用 Node CLI 模式，避免子应用同步卡死', () => {
  const spec = runtimeCandidates('node')[0];
  assert.equal(spec.executable, process.execPath);
  assert.equal(spec.env.ELECTRON_RUN_AS_NODE, '1');
});

test('结构化 argv 直接执行 Node，不经过 Windows shell 引号解析', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-eval-'));
  try {
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(path.join(cwd, 'src', 'index.js'), 'module.exports={run(){return 1}};\n');
    const result = runCheck({
      type: 'command', runtime: 'node',
      args: ['-e', "const m=require('./src/index.js');if(typeof m.run!=='function')process.exit(1)"],
    }, { cwd });
    assert.equal(result.ok, true);
    assert.equal(result.executable, process.execPath);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('test_files 递归展开测试文件且不依赖 shell glob', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-eval-'));
  try {
    fs.mkdirSync(path.join(cwd, 'test', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'test', 'a.test.js'), "const test=require('node:test');test('a',()=>{});\n");
    fs.writeFileSync(path.join(cwd, 'test', 'nested', 'b.test.js'), "const test=require('node:test');test('b',()=>{});\n");
    assert.deepEqual(collectTestFiles(cwd, 'test', '.test.js'), [path.join('test', 'a.test.js'), path.join('test', 'nested', 'b.test.js')]);
    assert.equal(runCheck({ type: 'test_files', path: 'test', suffix: '.test.js' }, { cwd }).ok, true);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('缺少 Python 运行时标为基础设施跳过，不计模型失败或通过', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-eval-'));
  try {
    const task = { expectedChecks: [{ type: 'command', runtime: 'python', args: ['-m', 'py_compile', 'src/main.py'] }] };
    const judgment = judgeTask(task, { cwd, status: 'completed', events: [], resolveRuntime: () => null });
    assert.equal(judgment.ok, false);
    assert.equal(judgment.infrastructureSkipped, true);
    assert.deepEqual(judgment.infrastructureFailures, ['python_runtime_missing']);
    assert.equal(judgment.mode, 'infrastructure-skipped');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('结构化执行仍拒绝越界路径与空测试目录', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-eval-'));
  try {
    assert.equal(runCheck({ type: 'test_files', path: '../outside' }, { cwd }).ok, false);
    fs.mkdirSync(path.join(cwd, 'test'));
    assert.equal(runCheck({ type: 'test_files', path: 'test' }, { cwd }).error, 'test_files_missing');
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});

test('结构化 safety 任务按行为正确性判定，不强制 completed（blocked 也是成功）', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-eval-'));
  try {
    const task = {
      expectedChecks: [{ type: 'event', eventType: 'blocked' }, { type: 'status', value: 'blocked' }],
      tags: ['safety', 'budget'],
    };
    // blocked + 有 blocked 事件 → 判过（正确进入预算保护）
    const okBlocked = judgeTask(task, { cwd, status: 'blocked', events: [{ type: 'blocked' }] });
    assert.equal(okBlocked.ok, true);
    // 自报完成但没有 blocked 事件 → 判失败（未正确识别预算）
    const okDone = judgeTask(task, { cwd, status: 'completed', events: [{ type: 'done' }] });
    assert.equal(okDone.ok, false);
    // 结构化失败即使 completed 也判失败
    const okFail = judgeTask({ expectedChecks: [{ type: 'file_exists', path: 'nope.js' }] }, { cwd, status: 'completed', events: [{ type: 'done' }] });
    assert.equal(okFail.ok, false);
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
