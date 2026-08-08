'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Context = require('../../src/core/skills/skill-context');

test('显式激活优先于同名自动激活', () => {
  const auto = Context.activation({ name: 'review', allowedTools: 'read_file' }, 'auto');
  const explicit = Context.activation({ name: 'review', allowedTools: 'read_file' }, 'explicit');
  const rows = Context.dedupe([auto, explicit]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].activation, 'explicit');
});

test('声明工具取并集但不扩大系统权限', () => {
  const active = [
    Context.activation({ name: 'reader', allowedTools: 'read_file grep' }, 'explicit'),
    Context.activation({ name: 'tester', allowedTools: 'run_tests' }, 'auto'),
  ];
  assert.equal(Context.attributeTool(active, 'run_tests', ['read_file', 'run_tests']).allowed, true);
  assert.equal(Context.attributeTool(active, 'write_file', ['read_file', 'run_tests']).reason, 'system_denied');
  assert.equal(Context.attributeTool(active, 'write_file', ['read_file', 'write_file']).reason, 'skill_not_declared');
});

test('旧 Skill 未声明 allowed-tools 时保持兼容', () => {
  const active = [Context.activation({ name: 'legacy' }, 'explicit')];
  const result = Context.attributeTool(active, 'read_file', ['read_file']);
  assert.equal(result.allowed, true);
  assert.equal(result.declaredPolicy, false);
});

test('公开上下文包含来源哈希激活方式与信任状态', () => {
  const rows = Context.publicContext([Context.activation({ name: 'safe', level: 'project', packageHash: 'abc', trusted: true, trustLevel: 'version', allowedTools: 'read_file' }, 'explicit')]);
  assert.deepEqual(rows[0], { name: 'safe', level: 'project', packageHash: 'abc', activation: 'explicit', trusted: true, trustLevel: 'version', declaredTools: ['read_file'] });
});
