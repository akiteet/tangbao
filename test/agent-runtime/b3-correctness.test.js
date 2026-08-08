'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');

test('B3：normalizeResult 坏前缀含「工具执行出错」（外层 catch 文案不再误判成功）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/infrastructure/agent-runtime/agent-server.js'), 'utf8');
  const m = src.match(/const bad = \/([^/]+)\/\.test\(s\)/);
  assert.ok(m, '应能找到 normalizeResult 坏前缀正则');
  assert.match(m[1], /工具执行出错|工具执行失败/, '前缀应含工具执行出错/失败');
});

test('B3：safePath 具备 realpath 符号链接逃逸校验', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/infrastructure/agent-runtime/agent-server.js'), 'utf8');
  const i = src.indexOf('function safePath');
  const seg = src.slice(i, i + 1200);
  assert.match(seg, /fs\.realpathSync/, 'safePath 应解析 realpath');
  assert.match(seg, /realRel/, '应校验真实路径相对关系');
});

test('B3：controlled-eval 终态——判分未通过时不得标 completed_by_judge', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/core/agent-runtime/controlled-eval.js'), 'utf8');
  // completed_by_judge 只在判分通过分支（judgment.ok 内）作为终态赋值
  assert.match(src, /finalStatus = finalAttempt\.completedByJudge \? 'completed_by_judge' : finalAttempt\.status;/, 'completed_by_judge 仅在 judgment.ok 分支内赋值');
  // 判分未通过（else 分支）必须映射到 assertion_failed / 原始状态
  assert.match(src, /\(finalAttempt\.status === 'completed' \|\| finalAttempt\.status === 'completed_by_judge'\) \? 'assertion_failed' : finalAttempt\.status;/, '判分未通过分支终态统一为 assertion_failed');
});

test('B3：skill-runner 超时强制 settle 且并发位归还', async () => {
  const S = require('../../src/infrastructure/agent-runtime/skill-runner');
  const script = path.join(os.tmpdir(), 'tangbao-skill-hang-' + process.pid + '.js');
  fs.writeFileSync(script, 'setInterval(() => {}, 5000);\n', 'utf8');
  try {
    const opts = { scriptPath: script, timeoutMs: 100, maxConcurrent: 1 };
    const r1 = await S.run(opts);
    assert.equal(r1.ok, false, '挂起脚本应判失败');
    assert.equal(r1.error && r1.error.code, 'skill_script_timeout', '应返回超时错误');
    const r2 = await S.run(opts);
    assert.notEqual(r2.error && r2.error.code, 'skill_concurrency_limit', '并发位应已归还（第二次能运行而非并发上限）');
  } finally {
    try { fs.unlinkSync(script); } catch (_) {}
  }
});
