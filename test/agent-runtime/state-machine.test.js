'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { canTransition, createPhaseMachine, normalizeRunStatus } = require('../../src/core/agent-runtime/state-machine');

test('审批阶段可以恢复到之前访问过的 implementing', () => {
  const events = [];
  const machine = createPhaseMachine('implementing', { onTransition: (event) => events.push(event) });
  assert.equal(machine.set('waiting_approval').ok, true);
  assert.equal(machine.set('implementing').ok, true);
  assert.equal(machine.get(), 'implementing');
  assert.deepEqual(events.map((event) => event.to), ['waiting_approval', 'implementing']);
});

test('活动阶段允许根据工具信号往返，终态不可回退', () => {
  assert.equal(canTransition('verifying', 'implementing'), true);
  assert.equal(canTransition('implementing', 'verifying'), true);
  assert.equal(canTransition('completed', 'implementing'), false);
  const invalid = [];
  const machine = createPhaseMachine('completed', { onInvalid: (event) => invalid.push(event) });
  const result = machine.set('implementing');
  assert.equal(result.ok, false);
  assert.equal(machine.get(), 'completed');
  assert.equal(invalid[0].code, 'invalid_phase_transition');
});

test('旧 done 状态读取时归一化为 completed', () => {
  assert.equal(normalizeRunStatus('done'), 'completed');
  assert.equal(normalizeRunStatus('blocked'), 'blocked');
});
