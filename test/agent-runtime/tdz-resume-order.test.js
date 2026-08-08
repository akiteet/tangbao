'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const src = fs.readFileSync(path.join(ROOT, 'src/infrastructure/agent-runtime/agent-server.js'), 'utf8');
const lineOf = (needle, from) => {
  const idx = src.indexOf(needle, from == null ? 0 : from);
  assert.ok(idx >= 0, '应能找到：' + needle);
  return src.slice(0, idx).split('\n').length;
};

test('B1-P0：resumeRootRunId/continuationIndex 声明在使用点之前（无 TDZ）', () => {
  const decl = lineOf('let resumeRootRunId =');
  const use = lineOf('rootRunId: resumeRootRunId');
  assert.ok(decl < use, '声明行(' + decl + ') 应在 createAgentRun 使用行(' + use + ') 之前');
  // 全文件仅一处声明（async 恢复块不得重复声明）
  assert.equal(src.match(/let resumeRootRunId\s*=/g).length, 1, 'resumeRootRunId 只能声明一次');
  assert.equal(src.match(/let continuationIndex\s*=/g).length, 1, 'continuationIndex 只能声明一次');
});

test('B1-P0：resume 校验（400 拒绝）在 writeHead(200) 之前执行', () => {
  const reject = lineOf("error: '要继续的运行不存在或已被清理");
  const writeHead = lineOf('res.writeHead(200, {');
  assert.ok(reject < writeHead, 'resume 校验行(' + reject + ') 应在 writeHead 行(' + writeHead + ') 之前，400 拒绝才有效');
});
