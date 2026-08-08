'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  resolveFixtureSource,
  prepareFixture,
  runEvalTask,
} = require('../../scripts/bench');

test('fixtureDir 同时兼容项目根目录和 benchmarks 相对路径', () => {
  const source = resolveFixtureSource('fixtures/multi-lang-js');
  assert.equal(path.basename(source), 'multi-lang-js');
  assert.equal(path.basename(path.dirname(path.dirname(source))), 'benchmarks');
  assert.equal(fs.existsSync(source), true);
});

test('隔离 fixture 使用唯一目录且不主动删除', () => {
  const calls = [];
  const originalMkdir = fs.mkdirSync;
  const originalCp = fs.cpSync;
  const originalRm = fs.rmSync;
  fs.mkdirSync = (target, options) => calls.push(['mkdir', target, options]);
  fs.cpSync = (source, target, options) => calls.push(['copy', source, target, options]);
  fs.rmSync = (...args) => calls.push(['remove', ...args]);
  try {
    const fixture = prepareFixture(
      { id: 'safe-004', fixtureDir: 'fixtures/safe-git' },
      '',
      { runsRoot: 'E:/isolated-eval-runs' },
    );
    assert.equal(fixture.isolated, true);
    assert.match(fixture.cwd.replace(/\\/g, '/'), /^E:\/isolated-eval-runs\/safe-004-/);
    fixture.cleanup();
    assert.equal(calls.filter((entry) => entry[0] === 'copy').length, 1);
    assert.equal(calls.some((entry) => entry[0] === 'remove'), false);
  } finally {
    fs.mkdirSync = originalMkdir;
    fs.cpSync = originalCp;
    fs.rmSync = originalRm;
  }
});

test('无 fixture 任务保持显式 fallbackCwd', () => {
  const fixture = prepareFixture({ id: 'simple-001' }, 'E:/explicit-safe-cwd');
  assert.equal(fixture.cwd, 'E:/explicit-safe-cwd');
  assert.equal(fixture.isolated, false);
});

test('Eval 请求传递账户 ref 而不包含密钥明文', async () => {
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    const payload = 'data: ' + JSON.stringify({ type: 'done' }) + '\n\n';
    return {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      }),
    };
  };
  try {
    await runEvalTask(
      { id: 'ref-001', title: 'ref', goal: 'test', timeoutSteps: 1, expectedChecks: [] },
      { base: 'http://127.0.0.1:3000', cwd: 'E:/fixture', model: 'model-a', ref: 'account-ref-a', timeoutMs: 1000 },
    );
    assert.equal(requestBody.ref, 'account-ref-a');
    assert.equal(requestBody.model, 'model-a');
    assert.equal(Object.prototype.hasOwnProperty.call(requestBody, 'apiKey'), false);
  } finally {
    global.fetch = originalFetch;
  }
});
