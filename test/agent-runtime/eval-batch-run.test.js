'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('安全评测面板包含「全部运行」按钮且默认可用', () => {
  const agent = read('src/renderer/views/agent/agent.js');
  assert.match(agent, /id="agentEvalRunAll"/);
  assert.match(agent, /全部运行/);
  // 按钮与单任务按钮同列，任务非空时可用（与单任务按钮同一 disabled 条件）
  assert.match(agent, /agentEvalRunAll[\s\S]{0,120}\$\{tasks\.length \? '' : 'disabled'\}/);
});

test('批量运行合并能力复测与指标补测并跳过历史完整通过', () => {
  const agent = read('src/renderer/views/agent/agent.js');
  assert.match(agent, /const runtimeSkipped = tasks\.filter\(\(t\) => !t\.alreadyPassed && t\.infrastructureSkipped\);/);
  assert.match(agent, /const metricRetests = tasks\.filter\(\(t\) => t\.alreadyPassed && t\.metricIncomplete && !t\.infrastructureSkipped\);/);
  assert.match(agent, /const capabilityRetests = tasks\.filter\(\(t\) => !t\.alreadyPassed && !t\.infrastructureSkipped\);/);
  assert.match(agent, /const pending = capabilityRetests\.concat\(metricRetests\);/);
  assert.match(agent, /const skipped = tasks\.filter\(\(t\) => t\.alreadyPassed && !t\.metricIncomplete\)\.length;/);
  // 全部已通过且指标完整时直接提示，不调用模型
  assert.match(agent, /if \(pending\.length === 0\)/);
  assert.match(agent, /全部任务已通过，无需运行/);
  assert.match(agent, /能力复测 ' \+ capabilityRetests\.length \+ ' 个 · 指标补测 ' \+ metricRetests\.length \+ ' 个/);
  assert.match(agent, /跳过 ' \+ skipped \+ ' 个历史完整通过/);
});

test('批量运行按 3 路并发池串批执行并实时更新进度', () => {
  const agent = read('src/renderer/views/agent/agent.js');
  // 并发上限 3，分批 Promise.all
  assert.match(agent, /const CONCURRENCY = 3;/);
  assert.match(agent, /for \(let i = 0; i < pending\.length; i \+= CONCURRENCY\)/);
  assert.match(agent, /const batch = pending\.slice\(i, i \+ CONCURRENCY\);/);
  assert.match(agent, /await Promise\.all\(batch\.map\(\(t\) => runOne\(t\)\)\);/);
  // 每个任务独立调用 runAgentEval，单个失败不中断整体
  assert.match(agent, /await storage\.runAgentEval\(\{ taskId: task\.id, ref: provider\.ref, model \}\)/);
  assert.match(agent, /appendResult\(task\.id, null, String\(error\.message \|\| error\)\);/);
  // 完成进度：N/M 完成 · 3 路并发
  assert.match(agent, /results\.length \+ '\/' \+ pending\.length \+ ' 完成 · 3 路并发/);
});

test('批量运行期间互斥禁用按钮，结束后恢复并汇总通过数', () => {
  const agent = read('src/renderer/views/agent/agent.js');
  // 开始：禁用单任务与全部按钮
  assert.match(agent, /runBtn\.disabled = true; allBtn\.disabled = true;/);
  // 结束：恢复两个按钮
  assert.match(agent, /runBtn\.disabled = false; runBtn\.textContent = '再次运行'; allBtn\.disabled = false;/);
  // 汇总区分通过、行为失败、基础设施失败与环境跳过
  assert.match(agent, /const infrastructureFailed = results\.filter\(\(r\) => r\.infrastructureFailure\)\.length;/);
  assert.match(agent, /const behavioralFailed = results\.length - passed - infrastructureFailed;/);
  assert.match(agent, /' 行为失败 · ' \+ infrastructureFailed \+ ' 基础设施失败'/);
  assert.match(agent, /runtimeSkipped\.length \? ' · ' \+ runtimeSkipped\.length \+ ' 环境跳过'/);
});

test('批量运行不绕过主进程受控入口（仍走 runAgentEval IPC）', () => {
  const agent = read('src/renderer/views/agent/agent.js');
  const snippet = agent.slice(agent.indexOf("modal.querySelector('#agentEvalRunAll').onclick"), agent.indexOf("modal.querySelector('#agentEvalRunAll').onclick") + 2400);
  assert.doesNotMatch(snippet, /base:|token:|cwd:/);
  assert.match(snippet, /taskId: task\.id, ref: provider\.ref, model/);
});
