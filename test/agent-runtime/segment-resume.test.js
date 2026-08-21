'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readRuntimeSource, readRendererSource, readMainSource } = require('./source-helper');
const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('Runtime 实现同 Run 自动续段并区分段事件与终态', () => {
  const server = readRuntimeSource(root);
  assert.match(server, /const MAX_SEGMENTS = 5/);
  assert.match(server, /const MAX_CUMULATIVE_STEPS = 1000/);
  assert.match(server, /emit\('segment_completed'/);
  assert.match(server, /emit\('segment_started'/);
  assert.match(server, /usage\.segmentIndex/);
  assert.match(server, /usage\.segmentSteps/);
  assert.match(server, /usage\.cumulativeSteps/);
  assert.match(server, /terminalHandled/);
  assert.match(server, /saveCheckpoint\('segment-boundary'\)/);
  assert.match(server, /saveCheckpoint\('segment-limit'\)/);
});

test('Eval 模式使用显式累计总步数，普通产品任务仍默认 1000 步', () => {
  const server = readRuntimeSource(root);
  const controlled = read('src/core/agent-runtime/controlled-eval.js');
  assert.match(server, /const evalMode = body\.evalMode === true/);
  assert.match(server, /Number\(body\.maxCumulativeSteps\) \|\| maxSteps/);
  assert.match(server, /: MAX_CUMULATIVE_STEPS/);
  assert.match(server, /if \(cumulativeSteps >= maxCumulativeSteps\) break/);
  assert.match(server, /cumulativeSteps >= maxCumulativeSteps/);
  assert.match(server, /const terminalPayload = \(payload\)/);
  assert.match(server, /usage\.maxCumulativeSteps = maxCumulativeSteps/);
  assert.match(server, /emit\('done', terminalPayload\(\)\)/);
  assert.match(server, /emit\('blocked', terminalPayload/);
  assert.match(server, /emit\('error', terminalPayload/);
  assert.match(controlled, /maxCumulativeSteps: task\.timeoutSteps \|\| 10/);
  assert.match(controlled, /evalMode: true/);
});

test('Completion Gate 使用请求 maxSteps 而非固定 96', () => {
  const server = readRuntimeSource(root);
  assert.match(server, /if \(step >= maxSteps - 1\) break;/);
  assert.doesNotMatch(server, /step >= MAX_STEPS - 1/);
});

test('精确恢复对来源 Run 与 Checkpoint 做结构化校验，不静默重发', () => {
  const server = readRuntimeSource(root);
  assert.match(server, /resume_run_not_found/);
  assert.match(server, /resume_checkpoint_missing/);
  assert.match(server, /resume_thread_mismatch/);
  assert.match(server, /resume_workspace_mismatch/);
  assert.match(server, /resume_checkpoint_invalid/);
  assert.match(server, /ContextManager\.validateCheckpoint\(ck\.state/);
  assert.match(server, /continuedFromRunId: String\(body\.resumeRunId \|\| ''\)/);
  assert.match(server, /resumeRootRunId/);
  assert.match(server, /continuationIndex/);
});

test('前端三个继续入口统一携带来源 Run 并声明 checkpoint 恢复', () => {
  const agent = readRendererSource();
  assert.match(agent, /resumeRun\(runId\)/);
  assert.match(agent, /t\.lastRunId/);
  assert.match(agent, /App\.agent\._resumeRunId = String\(runId\)/);
  assert.match(agent, /resumeMode: App\.agent\._resumeRunId \? 'checkpoint' : ''/);
  // 状态卡继续按钮与历史面板「继续该任务」统一走 resumeRun 链
  assert.match(agent, /resume\.addEventListener\('click', \(\) => App\.agent\.resumeLastRun\(\)\);/);
  assert.match(agent, /App\.agent\._resumeRunId = b\.dataset\.resume \|\| '';/);
});

test('存储层持久化 continuation 谱系与 root scope', () => {
  const schema = read('src/core/schemas/db-schema.js');
  const store = read('src/infrastructure/storage/sqlite-store.js');
  assert.match(schema, /continued_from_run_id/);
  assert.match(schema, /root_run_id/);
  assert.match(schema, /continuation_index/);
  assert.match(store, /continued_from_run_id/);
  assert.match(store, /rootRunId: row\.root_run_id \|\| row\.id/);
  assert.match(store, /continuationIndex/);
  assert.match(store, /rootScope: jp\(row\.root_scope_json\)/);
});
