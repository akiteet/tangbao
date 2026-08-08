'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SubM = require('../../src/core/agent-runtime/subagent-manager');
const Gate = require('../../src/core/agent-runtime/completion-gate');

test('G21-C2：默认并发上限 3——等于上限通过、+1 抛错', () => {
  const m = SubM.create(); // maxConcurrent=3
  const ids = ['a', 'b', 'c'].map((t) => m.add({ type: 'explore', goal: t, parentRunId: 'p' }).id);
  ids.forEach((id) => m.start(id));
  const d = m.add({ type: 'test', goal: 'd', parentRunId: 'p' });
  assert.throws(() => m.start(d.id), /并发上限/);
  m.finish(ids[0], { ok: true });
  assert.doesNotThrow(() => m.start(d.id), '释放一个并发后应可启动');
});

test('G21-C2：默认子任务数上限 8——同一父 8 个通过、第 9 个抛错', () => {
  const m = SubM.create(); // maxChildren=8
  for (let i = 0; i < 8; i++) m.add({ type: 'explore', goal: 'g' + i, parentRunId: 'p' });
  assert.throws(() => m.add({ type: 'explore', goal: 'g9', parentRunId: 'p' }), /数量上限/);
  assert.doesNotThrow(() => m.add({ type: 'explore', goal: 'other', parentRunId: 'p2' }), '其他父任务不受限');
});

test('G21-C2：默认深度上限 2——深度 2 通过、深度 3 抛错', () => {
  const m = SubM.create(); // maxDepth=2
  const parent = { id: 'root', depth: 0 };
  const l1 = m.add({ type: 'explore', goal: 'l1', parentRunId: 'root' }, parent);
  const l2 = m.add({ type: 'test', goal: 'l2', parentRunId: l1.id }, l1);
  assert.equal(l2.depth, 2, '深度 2 允许');
  assert.throws(() => m.add({ type: 'review', goal: 'l3', parentRunId: l2.id }, l2), /最大深度/);
});

test('G21-C2：子任务恒只读——白名单不含任何写/命令/git/子代理工具', () => {
  const m = SubM.create();
  const neverTools = ['write_file', 'edit_file', 'apply_patch', 'create_file', 'delete_file', 'move_file', 'run_command', 'git_command', 'run_subagent'];
  for (const role of ['explore', 'test', 'review']) {
    const item = m.add({ type: role, goal: 'x', parentRunId: 'p' });
    assert.equal(item.readOnly, true, role + ' 应恒只读');
    for (const wt of neverTools) {
      assert.ok(!item.allowedTools.includes(wt), role + ' 不应含写/命令工具 ' + wt);
    }
  }
  // test 角色可运行测试/静态检查（只读=不改工作区）
  const t = m.add({ type: 'test', goal: 't', parentRunId: 'p2' });
  assert.ok(t.allowedTools.includes('run_tests'), 'test 角色应可运行测试');
  assert.ok(t.allowedTools.includes('run_typecheck'), 'test 角色应可运行类型检查');
});

test('G21-C2：父取消级联只影响 pending/running，completed 保留', () => {
  const m = SubM.create();
  const a = m.add({ type: 'explore', goal: 'a', parentRunId: 'p' });
  const b = m.add({ type: 'test', goal: 'b', parentRunId: 'p' });
  const c = m.add({ type: 'review', goal: 'c', parentRunId: 'p' });
  m.start(a.id); m.start(b.id);
  m.finish(a.id, { ok: true }); // a 已完成
  const cancelled = m.cancelByParent('p', '父任务中止');
  assert.equal(cancelled.length, 2, '应取消 b(running)+c(pending)');
  assert.equal(m.gate('p').cancelled.length, 2);
  assert.equal(m.gate('p').completed.length, 1, '已完成子任务保留');
});

test('G21-C2：completion-gate 如实上报失败/活跃子任务（不阻断但需处理）', () => {
  const gaps = Gate.completionGap({
    subagents: [
      { id: 's1', status: 'failed' },
      { id: 's2', status: 'running' },
      { id: 's3', status: 'completed' },
    ],
  }, []);
  assert.ok(gaps.some((g) => String(g).includes('子任务失败')), '失败子任务应上报');
  assert.ok(gaps.some((g) => String(g).includes('尚未结束')), '活跃子任务应上报');
  const clean = Gate.completionGap({ subagents: [{ id: 's1', status: 'completed' }] }, []);
  assert.ok(!clean.some((g) => String(g).includes('子任务')), '全部完成后不误报');
});
