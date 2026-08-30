'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SCHEMA_VERSION, MIGRATIONS } = require('../../src/core/schemas/db-schema');

function fakeDb(columns) {
  const sql = [];
  const names = new Set(columns);
  return {
    sql,
    prepare(statement) {
      assert.match(statement, /table_info\(agent_runs\)/);
      return { all: () => Array.from(names).map((name) => ({ name })) };
    },
    exec(statement) { sql.push(statement); },
  };
}

test('Schema v16 adds version tracking and metric tables', () => {
  assert.equal(SCHEMA_VERSION, 18);
  const db = fakeDb(['id', 'prompt_version', 'toolset_version', 'runtime_version']);
  MIGRATIONS[15](db);
  assert.ok(db.sql.some((sql) => /CREATE TABLE IF NOT EXISTS agent_run_metrics/.test(sql)));
  assert.ok(db.sql.some((sql) => /CREATE TABLE IF NOT EXISTS model_call_metrics/.test(sql)));
  assert.ok(db.sql.some((sql) => /idx_model_call_metrics_scope/.test(sql)));
});

test('Schema v16 migration is idempotent when columns and tables already exist', () => {
  const db = fakeDb(['id', 'prompt_version', 'toolset_version', 'runtime_version']);
  MIGRATIONS[15](db);
  const first = db.sql.length;
  MIGRATIONS[15](db);
  assert.equal(db.sql.length, first * 2, 'DDL uses IF NOT EXISTS and remains repeatable');
  assert.equal(db.sql.filter((sql) => /ALTER TABLE/.test(sql)).length, 0);
});
