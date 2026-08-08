'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MIGRATIONS, SCHEMA_VERSION } = require('../../src/core/schemas/db-schema');

test('v8 到 v9 迁移追加 Working State 证据列并回填 done', () => {
  const columns = new Set(['run_id', 'unresolved_errors_json']);
  const sql = [];
  const db = {
    prepare(statement) {
      assert.match(statement, /agent_working_states/);
      return { all: () => Array.from(columns).map((name) => ({ name })) };
    },
    exec(statement) {
      sql.push(statement);
      const match = /ADD COLUMN\s+(\w+)/i.exec(statement);
      if (match) columns.add(match[1]);
    },
  };
  MIGRATIONS[8](db);
  assert.equal(SCHEMA_VERSION >= 9, true);
  assert.equal(columns.has('verification_skips_json'), true);
  assert.equal(columns.has('pending_decisions_json'), true);
  assert.equal(sql.some((statement) => statement.includes("status = 'completed'") && statement.includes("status = 'done'")), true);
});
