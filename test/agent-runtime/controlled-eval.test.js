'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  listSafeTasks,
  resolveSafeTask,
  resolveFixtureSource,
  createIsolatedFixture,
  executeSafeTask,
} = require('../../src/core/agent-runtime/controlled-eval');

const ROOT = path.join(__dirname, '../..');

test('受控评测只列出非人工且带 fixture 的白名单任务', () => {
  const tasks = listSafeTasks(ROOT);
  // 23 个自动任务全部补齐隔离 fixture 后，白名单从 5 升至 23
  assert.equal(tasks.length, 23);
  assert.ok(tasks.every((task) => task.id && task.title));
  assert.throws(() => resolveSafeTask(ROOT, 'ctx-001'), /eval_task_not_allowed/);
  assert.ok(resolveSafeTask(ROOT, 'simple-001'));
  assert.ok(resolveSafeTask(ROOT, 'ml-js-001'));
});

test('fixture 必须位于 benchmarks 内且路径存在', () => {
  const source = resolveFixtureSource(ROOT, 'fixtures/multi-lang-js');
  assert.equal(path.basename(source), 'multi-lang-js');
  assert.throws(() => resolveFixtureSource(ROOT, '../src'), /eval_fixture_outside_benchmarks/);
  assert.throws(() => resolveFixtureSource(ROOT, 'fixtures/not-found'), /eval_fixture_missing/);
});

test('每次创建唯一隔离目录并保留原 fixture 内容', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-controlled-eval-test-'));
  try {
    const task = resolveSafeTask(ROOT, 'ml-js-001');
    const first = createIsolatedFixture({ appRoot: ROOT, runsRoot: temp, task });
    const second = createIsolatedFixture({ appRoot: ROOT, runsRoot: temp, task });
    assert.notEqual(first, second);
    assert.equal(fs.existsSync(path.join(first, 'src', 'main.js')), true);
    assert.equal(fs.existsSync(path.join(second, 'src', 'main.js')), true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('主进程评测请求固定隔离 cwd、内部 token 和账户 ref', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-controlled-eval-run-'));
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, headers: init.headers, body: JSON.parse(init.body) };
    const payload = 'data: ' + JSON.stringify({ type: 'done' }) + '\n\n';
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); } }),
    };
  };
  try {
    const result = await executeSafeTask({
      appRoot: ROOT,
      runsRoot: temp,
      taskId: 'ml-js-001',
      ref: 'account-ref',
      model: 'model-a',
      base: 'http://127.0.0.1:32123',
      token: 'internal-token',
      fetchImpl,
      timeoutMs: 1000,
    });
    assert.equal(request.url, 'http://127.0.0.1:32123/api/agent');
    assert.equal(request.headers.Authorization, 'Bearer internal-token');
    assert.equal(request.body.ref, 'account-ref');
    assert.equal(request.body.model, 'model-a');
    assert.equal(request.body.permissionMode, 'sandbox');
    assert.equal(request.body.evalMode, true);
    assert.equal(request.body.maxCumulativeSteps, 10);
    assert.equal(request.body.maxSteps, 10);
    assert.match(request.body.cwd, /tb-controlled-eval-run-/);
    assert.equal(Object.prototype.hasOwnProperty.call(request.body, 'workspaceId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(request.body, 'apiKey'), false);
    assert.equal(result.status, 'assertion_failed');
    assert.equal(result.steps, 0);
    assert.equal(result.stepsSource, 'unavailable');
    assert.equal(fs.existsSync(path.join(result.runDir, 'eval-result.json')), true);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('多个工具结果事件仍只使用 Runtime 累计步数', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-controlled-eval-steps-'));
  const events = [
    { type: 'tool_call', name: 'read_file' },
    { type: 'tool_result', result: { ok: true } },
    { type: 'tool_call', name: 'read_file' },
    { type: 'tool_result', result: { ok: true } },
    { type: 'blocked', reason: '达到任务总步数上限', cumulativeSteps: 1, segmentSteps: 1, usage: { cumulativeSteps: 1, segmentSteps: 1 } },
  ];
  const payload = events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('');
  try {
    const result = await executeSafeTask({
      appRoot: ROOT, runsRoot: temp, taskId: 'ml-js-001', ref: 'r', model: 'm', base: 'http://127.0.0.1:3000', token: 't',
      fetchImpl: async () => ({ ok: true, status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); } }) }),
      timeoutMs: 1000,
    });
    assert.equal(result.steps, 1);
    assert.equal(result.stepsSource, 'runtime_cumulative');
    assert.equal(result.toolResultEvents, 2);
    assert.equal(result.attempts[0].steps, 1);
    assert.equal(result.attempts[0].toolResultEvents, 2);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('无 Runtime usage 时不把工具结果数量伪装成精确步数', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-controlled-eval-no-steps-'));
  const payload = 'data: ' + JSON.stringify({ type: 'tool_result', result: { ok: false } }) + '\n\n';
  try {
    const result = await executeSafeTask({
      appRoot: ROOT, runsRoot: temp, taskId: 'ml-js-001', ref: 'r', model: 'm', base: 'http://127.0.0.1:3000', token: 't',
      fetchImpl: async () => ({ ok: true, status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); } }) }),
      timeoutMs: 1000,
    });
    assert.equal(result.steps, 0);
    assert.equal(result.stepsSource, 'unavailable');
    assert.equal(result.toolResultEvents, 1);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('工具失败结果持久化脱敏诊断摘要', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-controlled-eval-failure-summary-'));
  const event = {
    type: 'tool_result', name: 'edit_file', cumulativeSteps: 2,
    result: { ok: false, repeatCount: 2, error: { code: 'not_found', message: '目标文本不存在\n请重新读取文件' } },
  };
  const payload = 'data: ' + JSON.stringify(event) + '\n\n' + 'data: ' + JSON.stringify({ type: 'blocked', reason: 'stop', cumulativeSteps: 2 }) + '\n\n';
  try {
    const result = await executeSafeTask({
      appRoot: ROOT, runsRoot: temp, taskId: 'ml-js-001', ref: 'r', model: 'm', base: 'http://127.0.0.1:3000', token: 't',
      fetchImpl: async () => ({ ok: true, status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); } }) }),
      timeoutMs: 1000,
    });
    assert.deepEqual(result.toolFailureSummary, [{ tool: 'edit_file', code: 'not_found', repeatCount: 2, message: '目标文本不存在 请重新读取文件' }]);
    assert.deepEqual(result.attempts[0].toolFailureSummary, result.toolFailureSummary);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('网络建连失败只重试一次且每次使用全新 fixture', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-controlled-eval-retry-'));
  const cwds = [];
  let count = 0;
  const fetchImpl = async (_url, init) => {
    cwds.push(JSON.parse(init.body).cwd);
    count++;
    if (count === 1) throw new TypeError('fetch failed');
    const payload = 'data: ' + JSON.stringify({ type: 'done', cumulativeSteps: 1 }) + '\n\n';
    return { ok: true, status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(payload)); controller.close(); } }) };
  };
  try {
    const result = await executeSafeTask({ appRoot: ROOT, runsRoot: temp, taskId: 'ml-js-001', ref: 'r', model: 'm', base: 'http://127.0.0.1:3000', token: 't', fetchImpl, timeoutMs: 1000 });
    assert.equal(result.attempts.length, 2);
    assert.notEqual(cwds[0], cwds[1]);
    assert.equal(fs.existsSync(cwds[0]), true);
    assert.equal(fs.existsSync(cwds[1]), true);
    assert.equal(result.retryReason, 'fetch failed');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('已产生工具调用后流中断不自动重试', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-controlled-eval-no-retry-'));
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    const encoder = new TextEncoder();
    let pulled = false;
    return {
      ok: true, status: 200,
      body: new ReadableStream({
        pull(controller) {
          if (!pulled) {
            pulled = true;
            controller.enqueue(encoder.encode('data: ' + JSON.stringify({ type: 'tool_call', name: 'read_file' }) + '\n\n'));
          } else controller.error(new Error('socket reset'));
        },
      }),
    };
  };
  try {
    const result = await executeSafeTask({ appRoot: ROOT, runsRoot: temp, taskId: 'ml-js-001', ref: 'r', model: 'm', base: 'http://127.0.0.1:3000', token: 't', fetchImpl, timeoutMs: 1000 });
    assert.equal(calls, 1);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.toolCalls, 1);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('两次基础设施失败单独分类，不计模型能力失败', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-controlled-eval-infra-'));
  try {
    const result = await executeSafeTask({ appRoot: ROOT, runsRoot: temp, taskId: 'ml-js-001', ref: 'r', model: 'm', base: 'http://127.0.0.1:3000', token: 't', fetchImpl: async () => { throw new TypeError('fetch failed'); }, timeoutMs: 1000 });
    assert.equal(result.status, 'infrastructure_failed');
    assert.equal(result.infrastructureFailure, true);
    assert.equal(result.machinePassed, false);
    assert.equal(result.attempts.length, 2);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('拒绝非回环后端、空账户引用和任意非白名单 taskId', async () => {
  const base = { appRoot: ROOT, runsRoot: os.tmpdir(), model: 'm', ref: 'r', token: 't', fetchImpl: async () => null };
  await assert.rejects(executeSafeTask({ ...base, taskId: 'ctx-001', base: 'http://127.0.0.1:3000' }), /eval_task_not_allowed/);
  await assert.rejects(executeSafeTask({ ...base, taskId: 'ml-js-001', base: 'http://example.com:3000' }), /eval_base_must_be_loopback/);
  await assert.rejects(executeSafeTask({ ...base, taskId: 'ml-js-001', base: 'http://127.0.0.1:3000', ref: '' }), /eval_ref_required/);
});

test('主进程、preload、service 与糖码 UI 均接入受控 Eval', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'src/preload/preload.js'), 'utf8');
  const service = fs.readFileSync(path.join(ROOT, 'src/application/services/fs.js'), 'utf8');
  const agent = fs.readFileSync(path.join(ROOT, 'src/renderer/views/agent/agent.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(main.includes("safeHandle('agent:evalTasks'"));
  assert.ok(main.includes("safeHandle('agent:runEval'"));
  assert.ok(main.includes('token: LOCAL_TOKEN'));
  assert.ok(main.includes('controlledEvalCount'));
  assert.ok(main.includes('MAX_CONCURRENT_EVAL'));
  assert.ok(main.includes('const { runDir: _privateRunDir, ...publicResult } = result'));
  assert.ok(preload.includes("ipcRenderer.invoke('agent:runEval'"));
  assert.ok(service.includes('runAgentEval(payload)'));
  assert.ok(agent.includes('id="agentEvalBtn"'));
  assert.ok(agent.includes('showSafeEval()'));
  assert.ok(pkg.build.files.includes('benchmarks/tasks.json'));
  assert.ok(pkg.build.files.includes('benchmarks/fixtures/**/*'));
});
