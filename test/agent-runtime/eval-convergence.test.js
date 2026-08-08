'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { executeSafeTask } = require('../../src/core/agent-runtime/controlled-eval');

const ROOT = path.join(__dirname, '../..');

function streamOf(events, onCancel) {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= events.length) { controller.close(); return; }
      controller.enqueue(encoder.encode('data: ' + JSON.stringify(events[index++]) + '\n\n'));
    },
    cancel(reason) { if (onCancel) onCancel(reason); },
  });
}

test('受控 Eval 为编码任务启用源码门与收敛机制，纯测试任务豁免源码门', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-eval-convergence-'));
  const requests = [];
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return { ok: true, status: 200, body: streamOf([{ type: 'done', cumulativeSteps: 1 }]) };
  };
  try {
    await executeSafeTask({ appRoot: ROOT, runsRoot: temp, taskId: 'ml-js-001', ref: 'r', model: 'm', base: 'http://127.0.0.1:3000', token: 't', fetchImpl });
    await executeSafeTask({ appRoot: ROOT, runsRoot: temp, taskId: 'med-002', ref: 'r', model: 'm', base: 'http://127.0.0.1:3000', token: 't', fetchImpl });
    await executeSafeTask({ appRoot: ROOT, runsRoot: temp, taskId: 'simple-004', ref: 'r', model: 'm', base: 'http://127.0.0.1:3000', token: 't', fetchImpl });
    assert.equal(requests[0].requireSourceChange, true);
    assert.equal(requests[0].evalConvergence, true);
    assert.equal(requests[1].requireSourceChange, true);
    assert.equal(requests[2].requireSourceChange, false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('成功写工具触发机器 checks 全过后安全早停', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-eval-early-stop-'));
  let cancelled = '';
  try {
    const fetchImpl = async (_url, init) => {
      const cwd = JSON.parse(init.body).cwd;
      fs.writeFileSync(path.join(cwd, 'src', 'main.ts'), 'export function add(a: number, b: number): number { return a + b; }\n');
      return {
        ok: true, status: 200,
        body: streamOf([
          { type: 'tool_call', name: 'write_file' },
          { type: 'tool_result', name: 'write_file', result: { ok: true }, cumulativeSteps: 1, segmentSteps: 1 },
          { type: 'message', text: '不应继续消费' },
        ], (reason) => { cancelled = String(reason); }),
      };
    };
    const result = await executeSafeTask({ appRoot: ROOT, runsRoot: temp, taskId: 'ml-ts-001', ref: 'r', model: 'm', base: 'http://127.0.0.1:3000', token: 't', fetchImpl });
    assert.equal(result.status, 'completed_by_judge');
    assert.equal(result.machinePassed, true);
    assert.equal(result.completedByJudge, true);
    assert.equal(result.steps, 1);
    assert.equal(result.stepsSource, 'runtime_progress');
    assert.equal(result.judgeCompletedAtStep, 1);
    assert.equal(result.metricIncomplete, false);
    assert.equal(result.attempts[0].judgeCompletedAtStep, 1);
    assert.equal(cancelled, 'machine_checks_passed');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('机器 checks 未全过时不得早停', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-eval-no-early-stop-'));
  let cancelled = false;
  try {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      body: streamOf([
        { type: 'tool_call', name: 'write_file' },
        { type: 'tool_result', name: 'write_file', result: { ok: true }, cumulativeSteps: 1, segmentSteps: 1 },
        { type: 'blocked', reason: 'budget', cumulativeSteps: 2, segmentSteps: 2 },
      ], () => { cancelled = true; }),
    });
    const result = await executeSafeTask({ appRoot: ROOT, runsRoot: temp, taskId: 'ml-ts-001', ref: 'r', model: 'm', base: 'http://127.0.0.1:3000', token: 't', fetchImpl });
    assert.equal(result.status, 'blocked');
    assert.equal(result.machinePassed, false);
    assert.equal(result.completedByJudge, false);
    assert.equal(cancelled, false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('Runtime 包含半程收敛、重复失败恢复和源码门接线', () => {
  const server = fs.readFileSync(path.join(ROOT, 'src/infrastructure/agent-runtime/agent-server.js'), 'utf8');
  assert.match(server, /const repeatedFailures = new Map\(\)/);
  assert.match(server, /const failedRequests = new Map\(\)/);
  assert.match(server, /failureSignature\(tc\.name, args, result\)/);
  assert.match(server, /repeated_failed_operation/);
  assert.match(server, /同一工具与参数已经失败两次/);
  assert.match(server, /同一操作已重复失败/);
  assert.match(server, /ratio >= 0\.25 && body\.requireSourceChange === true \? '25'/);
  assert.match(server, /convergenceReminder\(wsState, ratio, \{ requireSourceChange: body\.requireSourceChange === true \}\)/);
  assert.match(server, /emit\('convergence_notice'/);
  assert.match(server, /Runtime 合成拒绝用于阻止原样死循环/);
  assert.match(server, /failedRequests\.delete\(requestKey\)/);
  assert.match(server, /repeatedFailures\.delete\(recovered\.signature\)/);
  assert.match(server, /requireSourceChange: body\.requireSourceChange === true/);
  const controlled = fs.readFileSync(path.join(ROOT, 'src/core/agent-runtime/controlled-eval.js'), 'utf8');
  assert.match(controlled, /const liveJudgeThrottleMs = 1000/);
  assert.match(controlled, /Date\.now\(\) - lastLiveJudgeAt >= liveJudgeThrottleMs/);
});
