'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Workspace = require('../../src/core/workspace/workspace-roots');

const abs = (...parts) => path.resolve(path.join(process.cwd(), ...parts));

test('旧单根 cwd 自动迁移为多根工作区并保持主根', () => {
  const ws = Workspace.normalizeWorkspace({ name: 'demo', cwd: abs('fixtures', 'a') });
  assert.equal(ws.version, 2);
  assert.equal(ws.roots.length, 1);
  assert.equal(ws.primaryRootId, ws.roots[0].rootId);
  assert.equal(Workspace.primaryRoot(ws).path, abs('fixtures', 'a'));
});

test('允许两个互不包含的独立根并按 rootId 解析', () => {
  const ws = Workspace.normalizeWorkspace({ name: 'multi', roots: [
    { rootId: 'front', name: '前端', path: abs('fixtures', 'front') },
    { rootId: 'back', name: '后端', path: abs('fixtures', 'back') },
  ], primaryRootId: 'front' });
  assert.equal(Workspace.resolveRoot(ws, 'back').name, '后端');
  assert.equal(Workspace.publicWorkspace(ws, 'w1').cwd, abs('fixtures', 'front'));
});

test('拒绝重复和互相嵌套的工作区根并提供可展示原因', () => {
  const a = abs('fixtures', 'root');
  assert.throws(() => Workspace.normalizeWorkspace({ roots: [{ rootId: 'a', path: a }, { rootId: 'b', path: a }] }), (e) => e.code === 'duplicate_root_path' && /重复/.test(e.message));
  assert.throws(() => Workspace.normalizeWorkspace({ roots: [{ rootId: 'a', path: a }, { rootId: 'b', path: path.join(a, 'nested') }] }), (e) => e.code === 'nested_root_path' && /不能互相包含/.test(e.message));
});

test('添加、移除、重命名和设置主根保持稳定 rootId', () => {
  let ws = Workspace.normalizeWorkspace({ roots: [{ rootId: 'a', name: 'A', path: abs('fixtures', 'a') }] });
  ws = Workspace.addRoot(ws, { rootId: 'b', name: 'B', path: abs('fixtures', 'b') });
  ws = Workspace.renameRoot(ws, 'b', '服务端');
  ws = Workspace.setPrimaryRoot(ws, 'b');
  assert.equal(Workspace.primaryRoot(ws).name, '服务端');
  ws = Workspace.removeRoot(ws, 'a');
  assert.deepEqual(ws.roots.map((root) => root.rootId), ['b']);
  assert.throws(() => Workspace.removeRoot(ws, 'b'), (e) => e.code === 'last_root');
});

test('任务范围解析为权威 allowedRootIds 并拒绝未知根', () => {
  const ws = Workspace.normalizeWorkspace({ primaryRootId: 'a', roots: [
    { rootId: 'a', path: abs('fixtures', 'scope-a') },
    { rootId: 'b', path: abs('fixtures', 'scope-b') },
  ] });
  assert.deepEqual(Workspace.resolveRootScope(ws, { mode: 'primary' }).allowedRootIds, ['a']);
  assert.deepEqual(Workspace.resolveRootScope(ws, { mode: 'single', rootId: 'b' }).allowedRootIds, ['b']);
  assert.deepEqual(Workspace.resolveRootScope(ws, { mode: 'all' }).allowedRootIds.sort(), ['a', 'b']);
  assert.throws(() => Workspace.resolveRootScope(ws, { mode: 'single', rootId: 'missing' }), (e) => e.code === 'root_scope_invalid');
  assert.equal(Workspace.rootAllowed(['a'], 'b'), false);
});

test('工作区指纹在根或主根变化时改变', () => {
  const a = Workspace.normalizeWorkspace({ roots: [{ rootId: 'a', path: abs('fixtures', 'a') }, { rootId: 'b', path: abs('fixtures', 'b') }], primaryRootId: 'a' });
  const b = Workspace.setPrimaryRoot(a, 'b');
  assert.notEqual(Workspace.fingerprint(a), Workspace.fingerprint(b));
  assert.equal(Workspace.fingerprint(a), Workspace.fingerprint(Workspace.normalizeWorkspace(a)));
});
