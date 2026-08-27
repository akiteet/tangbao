'use strict';
// state→SQLite 迁移真 SQLite 回归（v1.2.0 批次 2；经 check:sqlite 的 Electron ABI 通道执行）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SCHEMA_VERSION, MIGRATIONS } = require('../../src/core/schemas/db-schema');

test('真库迁移：新库 schema 版本一致 + state→SQLite 迁移幂等（MIGRATED_FLAG 跳过）', (t) => {
  const storage = require('../../src/infrastructure/storage/sqlite-store');
  let Database = null;
  try { Database = require('better-sqlite3'); } catch (_) {}
  const migrator = require('../../src/infrastructure/storage/migrator');
  const fileRepo = require('../../src/infrastructure/storage/file-repo');

  if (!Database) { t.skip('better-sqlite3 native module is unavailable for this Node runtime'); return; }
  // MIGRATIONS 是迁移函数数组：长度必须等于 SCHEMA_VERSION（每步 +1，索引 i 完成 v(i)→v(i+1)）
  assert.ok(MIGRATIONS.length >= 17, '迁移步数应覆盖到 v17+');
  assert.equal(MIGRATIONS.length, SCHEMA_VERSION, '迁移函数数量必须等于 SCHEMA_VERSION');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-migration-real-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-migration-real-files-'));
  const dbPath = path.join(dir, 'tangbao.sqlite');
  if (!storage.init(dbPath)) { t.skip('better-sqlite3 初始化失败'); return; }
  fileRepo.init(repoRoot);
  try {
    // 全新建库直接落在当前 schema 版本（建库 SQL 与 MIGRATIONS 同源）
    const ro = new Database(dbPath, { readonly: true });
    const v1 = ro.pragma('user_version', { simple: true });
    ro.close();
    assert.equal(v1, SCHEMA_VERSION, '新建库的 user_version 必须等于 SCHEMA_VERSION');

    // 第一轮：空 state 迁移应成功落账并打上 MIGRATED_FLAG
    const first = migrator.run(storage.StorageService, fileRepo, { state: {}, stateDir: dir });
    assert.equal(first.ok, true, '首轮迁移必须成功');
    assert.notEqual(first.skipped, true);
    assert.ok(storage.StorageService.getKV(migrator.MIGRATED_FLAG), '迁移后必须留下 MIGRATED_FLAG');

    // 第二轮：同进程重复调用被标记短路（幂等），不再 clearAll 重灌
    const second = migrator.run(storage.StorageService, fileRepo, { state: {}, stateDir: dir });
    assert.deepEqual(second, { ok: true, skipped: true });

    assert.ok(storage.checkIntegrity(), '迁移后完整性检查必须通过');
  } finally {
    try { storage.close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch (_) {}
  }
});
