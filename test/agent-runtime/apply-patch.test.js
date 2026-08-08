'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AS = require('../../src/infrastructure/agent-runtime/agent-server');
const { parsePatch, applyPatchToContent, validateExpectedHashes, lineDiff } = AS;

test('G9-C1：parsePatch 解析多文件段 Unified Diff', () => {
  const patch = '--- a/src/a.js\n+++ b/src/a.js\n@@ -1,2 +1,2 @@\n-old\n+new\n--- a/src/b.js\n+++ b/src/b.js\n@@ -1 +1 @@\n-x\n+y\n';
  const files = parsePatch(patch);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'src/a.js');
  assert.equal(files[1].path, 'src/b.js');
  assert.equal(files[0].hunks[0].lines[0].type, 'del');
  assert.equal(files[0].hunks[0].lines[1].type, 'add');
});

test('G9-C1：CRLF 文件用 LF 补丁可应用且写回保留 CRLF', () => {
  const content = 'line1\r\nline2\r\nline3\r\n';
  const patch = '--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,1 @@\n-line2\n+line2-modified\n';
  const files = parsePatch(patch);
  const res = applyPatchToContent(content, files[0].hunks);
  assert.equal(res.ok, true);
  assert.equal(res.content, 'line1\r\nline2-modified\r\nline3\r\n', '写回应保留 CRLF');
});

test('G9-C1：LF 文件用 LF 补丁写回保持 LF', () => {
  const content = 'a\nb\nc\n';
  const patch = '--- a/f.txt\n+++ b/f.txt\n@@ -2,1 +2,1 @@\n-b\n+b2\n';
  const res = applyPatchToContent(content, parsePatch(patch)[0].hunks);
  assert.equal(res.ok, true);
  assert.equal(res.content, 'a\nb2\nc\n');
});

test('G9-C1：上下文不匹配返回错误', () => {
  const content = 'x\ny\n';
  const patch = '--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-nothere\n+repl\n';
  const res = applyPatchToContent(content, parsePatch(patch)[0].hunks);
  assert.equal(res.ok, false);
  assert.match(res.error, /不匹配/);
});

test('G9-C1：expectedFileHashes 缺项判 conflict，全覆盖通过', () => {
  const files = [{ path: 'a.js', hunks: [] }, { path: 'b.js', hunks: [] }];
  const missing = validateExpectedHashes(files, { 'a.js': 'h1' });
  assert.equal(missing.ok, false);
  assert.match(missing.error.message, /缺少文件 b\.js/);
  const full = validateExpectedHashes(files, { 'a.js': 'h1', 'b.js': 'h2' });
  assert.equal(full.ok, true);
  assert.equal(validateExpectedHashes(files, null).ok, true, '未提供 expected 时放行');
});

test('G9-C1：lineDiff 20 万行完全相同走快速路径（不超时、空 diff）', () => {
  const big = Array.from({ length: 200000 }, (_, i) => 'line' + i).join('\n');
  const t0 = Date.now();
  const d = lineDiff(big, big);
  assert.ok(Date.now() - t0 < 5000, '20 万行应快速返回');
  assert.deepEqual(d, [], '完全相同应为空 diff');
});

test('G9-C1：lineDiff 大差异回退摘要式提示（不超时）', () => {
  const a = Array.from({ length: 200000 }, (_, i) => 'a' + i).join('\n');
  const b = Array.from({ length: 200000 }, (_, i) => 'b' + i).join('\n');
  const t0 = Date.now();
  const d = lineDiff(a, b);
  assert.ok(Date.now() - t0 < 5000, '大差异应快速回退');
  assert.ok(d.length === 1 && String(d[0].text).includes('差异过大'), '应返回摘要式提示');
});

test('G9-C1：lineDiff 小文件仍逐行精确', () => {
  const d = lineDiff('a\nb\nc\n', 'a\nb2\nc\n');
  assert.deepEqual(d.filter((x) => x.type !== ' ').map((x) => x.type), ['-', '+']);
});
