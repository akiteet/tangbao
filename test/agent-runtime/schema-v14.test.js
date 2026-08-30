'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SCHEMA_VERSION, MIGRATIONS } = require('../../src/core/schemas/db-schema');
const Context = require('../../src/core/agent-runtime/context-manager');

test('Schema v14 迁移增加项目根、Run 快照和 ChangeSet rootId', () => {
  const columns = {
    projects: new Set(['id', 'cwd', 'workspace_id']),
    agent_runs: new Set(['id', 'cwd', 'workspace_id']),
    agent_changesets: new Set(['id', 'run_id', 'path']),
  };
  const sql = [];
  const db = {
    prepare(statement) {
      const table = /table_info\(([^)]+)\)/.exec(statement)[1];
      return { all: () => Array.from(columns[table]).map((name) => ({ name })) };
    },
    exec(statement) {
      sql.push(statement);
      const m = /ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i.exec(statement);
      if (m) columns[m[1]].add(m[2]);
    },
  };
  MIGRATIONS[13](db);
  assert.equal(SCHEMA_VERSION, 18);
  assert.equal(columns.projects.has('roots_json'), true);
  assert.equal(columns.projects.has('primary_root_id'), true);
  assert.equal(columns.agent_runs.has('workspace_snapshot_json'), true);
  assert.equal(columns.agent_runs.has('workspace_fingerprint'), true);
  assert.equal(columns.agent_changesets.has('root_id'), true);
  assert.equal(sql.length, 6);
});

test('Checkpoint v4 以工作区指纹和范围判定多根变化并兼容 v2 cwd', () => {
  const cp = Context.buildCheckpoint({}, { workspaceId: 'w1', cwd: 'C:/a', workspaceFingerprint: 'fp1', primaryRootId: 'r1', workspaceSnapshot: { roots: [{ rootId: 'r1' }] }, rootScope: { mode: 'single', rootId: 'r1' }, allowedRootIds: ['r1'] });
  assert.equal(cp.schemaVersion, 4);
  const same = { workspaceId: 'w1', cwd: 'C:/a', workspaceFingerprint: 'fp1', rootScope: { mode: 'single', rootId: 'r1' }, allowedRootIds: ['r1'] };
  assert.equal(Context.validateCheckpoint(cp, same).valid, true);
  assert.equal(Context.validateCheckpoint(cp, Object.assign({}, same, { workspaceFingerprint: 'fp2' })).reason, 'workspace_roots_changed');
  assert.equal(Context.validateCheckpoint(cp, Object.assign({}, same, { rootScope: { mode: 'all' } })).reason, 'root_scope_changed');
  const old = { schemaVersion: 2, workspaceId: 'w1', cwd: 'C:/old', sourceHashes: {} };
  assert.equal(Context.validateCheckpoint(old, { workspaceId: 'w1', cwd: 'C:/new' }).reason, 'cwd_changed');
});
