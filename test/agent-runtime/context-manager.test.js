'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Context = require('../../src/core/agent-runtime/context-manager');

function ws() {
  return {
    goal: '修复支付流程',
    plan: [{ content: '定位', status: 'completed' }, { content: '修复', status: 'in_progress' }],
    pendingWork: ['修复失败分支'], unresolvedErrors: [{ message: '测试失败' }],
    filesRead: [{ path: 'a.js', hash: 'h1' }], filesChanged: [{ path: 'a.js', afterHash: 'h2' }],
    checks: [{ kind: 'test', ok: false }],
  };
}

test('模型预算包含输出、工具和安全预留', () => {
  const b = Context.budgetForModel(10000, { outputReserve: 1000, toolReserve: 1000, safetyReserve: 500 });
  assert.equal(b.usable, 7500);
  assert.ok(b.precompress < b.hard && b.hard < b.emergency);
});

test('三阈值压力决策稳定', () => {
  const b = Context.budgetForModel(10000, { outputReserve: 1000, toolReserve: 1000, safetyReserve: 500 });
  assert.equal(Context.decidePressure(1000, b), 'normal');
  assert.equal(Context.decidePressure(b.precompress, b), 'precompress');
  assert.equal(Context.decidePressure(b.hard, b), 'hard');
  assert.equal(Context.decidePressure(b.emergency, b), 'emergency');
});

test('安全重建保留Goal、Plan、错误、变更和最近消息', () => {
  const messages = [{ role: 'system', content: '规则' }];
  for (let i = 0; i < 30; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', content: '历史' + i });
  const out = Context.rebuildSafeMessages(messages, { workingState: ws(), recentLimit: 6, eventRange: { from: 1, to: 20 } });
  const joined = out.messages.map((m) => m.content).join('\n');
  assert.match(joined, /修复支付流程/);
  assert.match(joined, /测试失败/);
  assert.match(joined, /a\.js/);
  assert.match(joined, /历史29/);
  assert.ok(out.messages.length > 2, '不能退化为system + 最新user');
});

test('硬阈值会安全重建而非直接丢中间状态', () => {
  const messages = [{ role: 'system', content: '系统' }, { role: 'user', content: 'x'.repeat(50000) }, { role: 'assistant', content: '处理中' }];
  const out = Context.enforceWindow(messages, 4000, { workingState: ws(), outputReserve: 500, toolReserve: 500, safetyReserve: 300 });
  assert.equal(out.triggered, true);
  assert.ok(['hard', 'emergency'].includes(out.pressure));
  assert.match(out.messages.map((m) => m.content).join('\n'), /Plan/);
});

test('超长 system Skill 指引也会按窗口预算压缩', () => {
  const messages = [{ role: 'system', content: '核心规则\n' + 'Skill步骤。'.repeat(12000) }, { role: 'user', content: '继续任务' }];
  const out = Context.enforceWindow(messages, 2048, { workingState: ws(), outputReserve: 256, toolReserve: 256, safetyReserve: 128 });
  assert.equal(out.triggered, true);
  assert.ok(out.afterTokens < out.beforeTokens);
  const joined = out.messages.map((m) => m.content).join('\n');
  assert.match(joined, /系统上下文已按窗口预算压缩/);
  assert.match(joined, /修复支付流程/);
  assert.match(joined, /测试失败/);
});

test('Summary v2保存结构和来源哈希并能识别陈旧', () => {
  const s = Context.summaryFromWorkingState(ws(), { from: 2, to: 18 });
  assert.equal(s.schemaVersion, 2);
  assert.equal(s.coveredToSeq, 18);
  assert.equal(Context.summaryIsValid(s, { 'a.js': 'h2' }).valid, true);
  const stale = Context.summaryIsValid(s, { 'a.js': 'new' });
  assert.equal(stale.valid, false);
  assert.deepEqual(stale.stale, ['a.js']);
});

test('Checkpoint v4包含真实事件范围、工作区范围并校验哈希', () => {
  const cp = Context.buildCheckpoint(ws(), { phase: 'implementing', workspaceId: 'w1', cwd: 'C:/repo', eventsToSeq: 12, sourceHashes: { 'a.js': 'h2' }, nextStep: '继续修复', rootScope: { mode: 'primary' }, allowedRootIds: ['r1'] });
  assert.equal(cp.schemaVersion, 4);
  assert.equal(cp.eventsToSeq, 12);
  const current = { workspaceId: 'w1', cwd: 'C:/repo', rootScope: { mode: 'primary' }, allowedRootIds: ['r1'], sourceHashes: { 'a.js': 'h2' } };
  assert.equal(Context.validateCheckpoint(cp, current).valid, true);
  assert.equal(Context.validateCheckpoint(cp, Object.assign({}, current, { workspaceId: 'w2' })).reason, 'workspace_changed');
  assert.deepEqual(Context.validateCheckpoint(cp, Object.assign({}, current, { sourceHashes: { 'a.js': 'h3' } })).stale, ['a.js']);
});
