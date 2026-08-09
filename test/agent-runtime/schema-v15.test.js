'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SCHEMA_VERSION, MIGRATIONS } = require('../../src/core/schemas/db-schema');

function fakeRunTable(initial, threadInitial) {
  const columns = new Set(initial || []);
  const threadColumns = new Set(threadInitial || ['id']);
  const sql = [];
  return {
    columns,
    threadColumns,
    sql,
    db: {
      prepare(statement) {
        const match = /table_info\(([^)]+)\)/.exec(statement);
        assert.ok(match);
        const source = match[1] === 'agent_threads' ? threadColumns : columns;
        return { all: () => Array.from(source).map((name) => ({ name })) };
      },
      exec(statement) {
        sql.push(statement);
        const match = /ALTER TABLE\s+(agent_runs|agent_threads)\s+ADD COLUMN\s+(\w+)/i.exec(statement);
        if (match) (match[1] === 'agent_threads' ? threadColumns : columns).add(match[2]);
      },
    },
  };
}

test('Schema v15 迁移增加 continuation 谱系与 root scope', () => {
  const fake = fakeRunTable(['id', 'role']);
  MIGRATIONS[14](fake.db);
  assert.equal(SCHEMA_VERSION, 16);
  assert.equal(fake.columns.has('continued_from_run_id'), true);
  assert.equal(fake.columns.has('root_run_id'), true);
  assert.equal(fake.columns.has('continuation_index'), true);
  assert.equal(fake.columns.has('root_scope_json'), true);
  assert.equal(fake.threadColumns.has('draft_root_scope_json'), true);
  assert.ok(fake.sql.some((line) => /idx_agentruns_continued/.test(line)));
  assert.ok(fake.sql.some((line) => /idx_agentruns_root/.test(line)));
});

test('Schema v15 迁移可重复执行且不会重复加列', () => {
  const fake = fakeRunTable(['id', 'role', 'continued_from_run_id', 'root_run_id', 'continuation_index', 'root_scope_json'], ['id', 'draft_root_scope_json']);
  MIGRATIONS[14](fake.db);
  assert.equal(fake.sql.some((line) => /ALTER TABLE/i.test(line)), false);
  assert.ok(fake.sql.some((line) => /UPDATE agent_runs SET root_run_id/.test(line)));
});
