'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { readRuntimeSource } = require('./source-helper');

const ROOT = path.join(__dirname, '../..');
const AS = require('../../src/infrastructure/agent-runtime/agent-server');
const CT = require('../../src/core/agent-runtime/change-transaction');
const { judgeTask } = require('../../src/core/agent-runtime/eval-judge');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readRuntime = () => readRuntimeSource(ROOT);

test('B6：parsePatch 支持新建文件（--- /dev/null）路径归一', () => {
  const patch = '--- /dev/null\n+++ b/src/newfile.js\n@@ -0,0 +1 @@\n+new content\n';
  const files = AS.parsePatch(patch);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/newfile.js', '新建文件路径应取 +++ 行');
  assert.equal(files[0].fromNull, true);
});

test('B6：parsePatch 支持删除文件（+++ /dev/null）标记', () => {
  const patch = '--- a/src/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-old line\n';
  const files = AS.parsePatch(patch);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, 'src/old.js', '删除文件路径应保留 --- 行');
  assert.equal(files[0].toNull, true);
});

test('B6：parsePatch 普通补丁不受影响', () => {
  const patch = '--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,2 @@\n-old\n+new\n';
  const files = AS.parsePatch(patch);
  assert.equal(files[0].path, 'src/a.js');
  assert.equal(files[0].fromNull, false);
  assert.equal(files[0].toNull, false);
});

test('B6：change-transaction move 目标已存在时预检拒绝（跨平台一致）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-move-'));
  try {
    fs.writeFileSync(path.join(dir, 'src.txt'), 'a');
    fs.writeFileSync(path.join(dir, 'dst.txt'), 'existing');
    assert.throws(() => CT.plan(dir, [{ type: 'move', path: 'src.txt', to: 'dst.txt' }]), (e) => e.code === 'target_exists', '目标已存在应抛 target_exists');
    fs.unlinkSync(path.join(dir, 'dst.txt'));
    const ok = CT.plan(dir, [{ type: 'move', path: 'src.txt', to: 'dst.txt' }]);
    assert.equal(ok.operations.length, 1, '目标不存在时 move 可规划');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('B6：eval-judge mixed 任务（含结构化 checks）不强制 completed', () => {
  const task = { id: 'x', tags: ['safety'], expectedChecks: [{ type: 'status', value: 'blocked' }] };
  const r = judgeTask(task, { status: 'blocked', events: [] });
  assert.equal(r.ok, true, 'safety 任务 blocked 且结构化 check 通过应判过');
});

test('B6：skill-registry EXDEV 失败恢复 backup（源码级）', () => {
  const src = read('src/core/skills/skill-registry.js');
  const i = src.indexOf("moveError.code === 'EXDEV'");
  const seg = src.slice(i, i + 1200);
  assert.match(seg, /catch \(stagingError\)/, 'EXDEV 分支应有独立 catch');
  assert.match(seg, /rename\(backup, target\); backupMade = false;/, '失败应恢复旧技能备份');
});

test('B6：runTool apply_patch 支持 fromNull 新建（源码级）', () => {
  const src = readRuntime();
  assert.match(src, /f\.fromNull && e && e\.code === 'ENOENT'\) \{ content = ''; \}/, '新建文件应从空内容应用补丁');
  assert.match(src, /f\.toNull\) return \{ ok: false, error: \{ code: 'not_supported'/, '删除文件段应引导 delete_file');
});
