'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Manager = require('../../src/core/agent-runtime/subagent-manager');

test('并发达到上限后排队，槽位释放后补位', async () => {
  const manager = Manager.create({ maxConcurrent: 1 });
  const first = manager.add({ type: 'explore', goal: 'first', parentRunId: 'root' });
  const second = manager.add({ type: 'test', goal: 'second', parentRunId: 'root' });
  manager.start(first.id);
  const waiting = manager.waitForStart(second.id);
  assert.equal(manager.get(second.id).status, 'queued');
  manager.finish(first.id, { ok: true, summary: 'done' });
  const started = await waiting;
  assert.equal(started.id, second.id);
  assert.equal(manager.get(second.id).status, 'running');
  manager.finish(second.id, { ok: true, summary: 'done' });
  assert.equal(manager.activeCount(), 0);
});

test('取消会同时处理 queued，恢复快照会把运行态还原为 pending', async () => {
  const manager = Manager.create({ maxConcurrent: 1 });
  const first = manager.add({ type: 'explore', goal: 'first', parentRunId: 'root' });
  const second = manager.add({ type: 'review', goal: 'second', parentRunId: 'root' });
  manager.start(first.id);
  const checkpoint = manager.snapshot();
  let cancelled = false;
  const waiting = manager.waitForStart(second.id, () => cancelled);
  cancelled = true;
  manager.cancelByParent('root', 'parent_cancelled');
  assert.equal((await waiting), null);
  assert.equal(manager.get(second.id).status, 'cancelled');
  const saved = Manager.create();
  saved.restore(checkpoint);
  assert.equal(saved.get(first.id).status, 'pending');
});
