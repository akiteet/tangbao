'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyVerificationResult, changeSummary, classifyChangePath, completionGap,
  convergenceReminder, failureSignature, latestEffectiveChecks,
} = require('../../src/core/agent-runtime/completion-gate');

function state(overrides) {
  return Object.assign({ plan: [], filesChanged: [], checks: [], unresolvedErrors: [], decisions: [], pendingDecisions: [], verificationSkips: [] }, overrides || {});
}

test('要求代码变更的任务在零修改时阻止完成', () => {
  const gaps = completionGap(state(), [], { requireChange: true });
  assert.equal(gaps.some((gap) => gap.includes('尚无任何有效文件变更')), true);
  assert.deepEqual(completionGap(state(), [], { requireChange: false }), []);
});

test('源码变更门拒绝零修改、只改文档或只改测试', () => {
  const none = completionGap(state(), [], { requireSourceChange: true });
  assert.equal(none.some((gap) => gap.includes('尚无产品源码')), true);
  const docs = completionGap(state({ filesChanged: [{ path: 'README.md', at: 1 }] }), [], { requireSourceChange: true });
  assert.equal(docs.some((gap) => gap.includes('只修改了测试或文档')), true);
  const tests = completionGap(state({ filesChanged: [{ path: 'test/main.test.js', at: 1 }] }), [], { requireSourceChange: true });
  assert.equal(tests.some((gap) => gap.includes('只修改了测试或文档')), true);
});

test('源码变更门接受产品源码或配置变更', () => {
  const gaps = completionGap(state({
    filesChanged: [{ path: 'src/main.ts', at: 1 }],
    checks: [{ kind: 'typecheck', commands: ['tsc'], ok: true, at: 2, results: [{ command: 'tsc', ok: true }] }],
  }), [], { requireSourceChange: true });
  assert.deepEqual(gaps, []);
});

test('变更分类、半程提醒与失败签名不包含文件内容', () => {
  assert.equal(classifyChangePath('README.md'), 'documentation');
  assert.equal(classifyChangePath('test/a.test.js'), 'test');
  assert.equal(classifyChangePath('src/a.js'), 'source');
  assert.deepEqual(changeSummary(state({ filesChanged: [{ path: 'README.md' }, { path: 'src/a.js' }] })).source, ['src/a.js']);
  assert.match(convergenceReminder(state(), 0.25, { requireSourceChange: true }), /约 25%.*尚无产品源码\/配置变更/);
  assert.equal(convergenceReminder(state(), 0.25, { requireSourceChange: false }), '');
  assert.match(convergenceReminder(state(), 0.5), /尚无源码\/配置变更/);
  assert.match(convergenceReminder(state({ filesChanged: [{ path: 'src/a.js' }] }), 0.75), /最小相关验证/);
  const signature = failureSignature('edit_file', { path: 'src/a.js', old_str: 'secret content', new_str: 'new secret' }, { error: { code: 'not_found' } });
  assert.match(signature, /edit_file/);
  assert.doesNotMatch(signature, /secret content|new secret/);
});

test('文件修改后没有验证时 Completion Gate 阻止完成', () => {
  const gaps = completionGap(state({ filesChanged: [{ path: 'a.js', at: 100 }] }), []);
  assert.equal(gaps.some((gap) => gap.includes('没有通过验证')), true);
});

test('文件修改后有通过验证时允许完成', () => {
  const gaps = completionGap(state({
    filesChanged: [{ path: 'a.js', at: 100 }],
    checks: [{ kind: 'tests', commands: ['npm test'], ok: true, at: 110, results: [{ command: 'npm test', ok: true }] }],
  }), []);
  assert.deepEqual(gaps, []);
});

test('明确记录跳过验证原因可以作为证据', () => {
  const gaps = completionGap(state({
    filesChanged: [{ path: 'README.md', at: 100 }],
    verificationSkips: [{ reason: '仅修改文档，无可执行验证', at: 101 }],
  }), []);
  assert.deepEqual(gaps, []);
});

test('同一验证失败后重跑通过会解除旧错误和旧失败', () => {
  const ws = state({ unresolvedErrors: [{ source: 'run_tests', message: '旧版本测试失败记录' }] });
  applyVerificationResult(ws, {
    kind: 'tests', commands: ['npm test'], ok: false, at: 100,
    results: [{ command: 'npm test', ok: false, exitCode: 1, output: 'failed' }],
  });
  assert.equal(ws.unresolvedErrors.length, 1);
  applyVerificationResult(ws, {
    kind: 'tests', commands: ['npm test'], ok: true, at: 200,
    results: [{ command: 'npm test', ok: true, exitCode: 0, output: 'passed' }],
  });
  assert.equal(ws.unresolvedErrors.length, 0);
  assert.deepEqual(latestEffectiveChecks(ws.checks).map((check) => check.ok), [true]);
  assert.deepEqual(completionGap(ws, []), []);
});

test('待审批和未完成计划都会阻止完成', () => {
  const gaps = completionGap(state({
    plan: [{ content: '修复', status: 'in_progress' }],
    decisions: [{ id: 'd1', result: 'pending' }],
  }), []);
  assert.equal(gaps.some((gap) => gap.includes('步骤未完成')), true);
  assert.equal(gaps.some((gap) => gap.includes('待用户确认')), true);
});

test('同一文件最后一次操作是回滚时不再要求验证', () => {
  const gaps = completionGap(state({
    filesChanged: [
      { path: 'a.js', at: 100 },
      { path: 'a.js', at: 120, restored: true },
    ],
  }), []);
  assert.deepEqual(gaps, []);
});

test('要求验证的已完成步骤必须关联验证事件', () => {
  const gaps = completionGap(state({
    plan: [{ content: '修复', status: 'completed', verificationRequired: true, verificationEventIds: [] }],
  }), []);
  assert.equal(gaps.some((gap) => gap.includes('缺少关联验证证据')), true);
});

test('子任务运行中或失败会阻止父任务完成', () => {
  const active = completionGap(state({ subagents: [{ id: 'c1', status: 'running' }] }), []);
  assert.equal(active.some((gap) => gap.includes('子任务尚未结束')), true);
  const failed = completionGap(state({ subagents: [{ id: 'c2', status: 'failed' }] }), []);
  assert.equal(failed.some((gap) => gap.includes('子任务失败')), true);
});

test('pendingDecisions 中的未答问题会阻止完成', () => {
  const gaps = completionGap(state({ pendingDecisions: [{ id: 'd1', status: 'pending' }] }), []);
  assert.equal(gaps.some((gap) => gap.includes('待用户确认')), true);
});
