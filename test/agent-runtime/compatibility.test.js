'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SCHEMA_VERSION, MIGRATIONS } = require('../../src/core/schemas/db-schema');
const tasks = require('../../benchmarks/tasks.json');

test('Schema v9 之后迁移链保持连续', () => {
  assert.equal(SCHEMA_VERSION >= 9, true);
  assert.equal(MIGRATIONS.length, SCHEMA_VERSION);
  MIGRATIONS.forEach((migration, index) => assert.equal(typeof migration, 'function', 'migration_' + index));
});

test('固定评测集保持 30 项基线并扩展多语言真实任务', () => {
  const list = Array.isArray(tasks) ? tasks : tasks.tasks;
  assert.equal(Array.isArray(list), true);
  assert.equal(list.length >= 30, true);
  for (const task of list) {
    assert.equal(typeof task.id, 'string');
    assert.equal(typeof task.goal, 'string');
    assert.equal(Array.isArray(task.expectedChecks), true);
    assert.equal(Array.isArray(task.tags), true);
  }
  // v2（I 批）：带 fixture 的结构化判分任务（multi-lang + safety）
  const structured = list.filter((t) => t.fixtureDir && t.expectedChecks.some((check) => check && typeof check === 'object'));
  assert.equal(structured.length >= 3, true);
  // 结构化判分任务必须带 fixtureDir（可机器判分）；safe-004/safe-006 与 multi-lang 均属此类
  const allStructured = list.filter((t) => t.expectedChecks.some((check) => check && typeof check === 'object'));
  assert.ok(allStructured.every((t) => t.fixtureDir), '所有结构化判分任务必须带 fixtureDir');
  // 人工驱动任务（multi-turn / 审批 / 重启 / 外部注入）应标记 manualOnly，不进入自动执行
  const manual = list.filter((t) => t.manualOnly);
  assert.equal(manual.length >= 8, true);
  assert.ok(manual.every((t) => t.expectedChecks.every((check) => typeof check === 'string')), 'manualOnly 任务保留字符串判分供人工评测参考');
});
