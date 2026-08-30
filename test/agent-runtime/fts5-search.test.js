'use strict';
// v1.2.1 批次 5b：FTS5 全文索引真库回归（经 check:sqlite 的 Electron ABI 通道执行）。
// trigram 分词器不支持增量 delete/update（'delete' 特殊语法报 SQL logic error），故采用
// 「写入标脏 + 搜索前按需整表重建」：验证迁移建成 messages_fts、写入后 searchLocal 重建并命中、
// 内容变更后旧词消失新词命中、短查询回退 LIKE、标题命中保留。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { SCHEMA_VERSION, MIGRATIONS } = require('../../src/core/schemas/db-schema');

test('FTS5：migration_17 建成 + 按需重建 + searchLocal 长查询走 MATCH / 短查询回退 LIKE', (t) => {
  let Database = null;
  try { Database = require('better-sqlite3'); } catch (_) {}
  if (!Database) { t.skip('better-sqlite3 native module unavailable for this Node runtime'); return; }
  assert.equal(MIGRATIONS.length, SCHEMA_VERSION, '迁移函数数量必须等于 SCHEMA_VERSION');
  assert.ok(SCHEMA_VERSION >= 18, 'SCHEMA_VERSION 应推进到 v18+（含 FTS5 迁移）');
  const storage = require('../../src/infrastructure/storage/sqlite-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-fts5-'));
  const dbPath = path.join(dir, 'tangbao.sqlite');
  if (!storage.init(dbPath)) { t.skip('sqlite-store 初始化失败'); return; }
  const S = storage.StorageService;
  let probe = null;
  try {
    probe = new Database(dbPath, { readonly: true });
    assert.equal(probe.pragma('user_version', { simple: true }), SCHEMA_VERSION, '新建库 user_version 必须等于 SCHEMA_VERSION');
    assert.ok(probe.prepare("SELECT name FROM sqlite_master WHERE name='messages_fts'").get(), 'messages_fts 必须由迁移 17 创建');
    assert.ok(probe.prepare("SELECT value FROM kv_meta WHERE key='fts_dirty'").get(), 'fts_dirty 标记由迁移初始化');

    // 写入（replaceMessages 标记脏）
    S.upsertConversation({ id: 'c1', title: '测试会话', createdAt: 1, updatedAt: 2 });
    S.replaceMessages('c1', [
      { id: 'm1', idx: 0, role: 'user', content: '糖包助手在本地运行', createdAt: 10 },
      { id: 'm2', idx: 1, role: 'assistant', content: 'the quick brown fox jumps', createdAt: 11 },
      { id: 'm3', idx: 2, role: 'user', content: '本地运行助手测试', createdAt: 12 },
    ]);
    // searchLocal 长查询：首次触发按需重建 → 中文 4 字命中
    const long = S.searchLocal('本地运行助手', { scopes: ['conversation'] });
    assert.equal(long.ok, true);
    assert.ok(long.items.some((it) => it.id === 'c1'), 'searchLocal 长查询（FTS MATCH）应命中 c1');
    const en = S.searchLocal('brown', { scopes: ['conversation'] });
    assert.ok(en.items.some((it) => it.id === 'c1'), 'searchLocal 英文应命中 c1');

    // 内容变更（再次标记脏）→ 重建后旧词消失、新词命中
    S.replaceMessages('c1', [
      { id: 'm1', idx: 0, role: 'user', content: '糖包助手在本地运行', createdAt: 10 },
      { id: 'm2', idx: 1, role: 'assistant', content: 'foxbox everything', createdAt: 11 },
      { id: 'm3', idx: 2, role: 'user', content: '本地运行助手测试', createdAt: 12 },
    ]);
    const stale = S.searchLocal('brown', { scopes: ['conversation'] });
    assert.equal(stale.items.length, 0, '内容变更后旧词 brown 应不再命中');
    const fresh = S.searchLocal('foxbox', { scopes: ['conversation'] });
    assert.ok(fresh.items.some((it) => it.id === 'c1'), '内容变更后新词 foxbox 应命中 c1');

    // 短查询（2 字）回退 LIKE 仍命中
    const short = S.searchLocal('本地', { scopes: ['conversation'] });
    assert.equal(short.ok, true);
    assert.ok(short.items.some((it) => it.id === 'c1'), 'searchLocal 短查询（LIKE 回退）应命中 c1');
    // 标题 LIKE 命中保留
    const title = S.searchLocal('测试会话', { scopes: ['conversation'] });
    assert.equal(title.ok, true);
    assert.ok(title.items.some((it) => it.id === 'c1'), '标题 LIKE 命中应保留');
  } finally {
    if (probe) { try { probe.close(); } catch (_) {} }
    try { storage.close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});
