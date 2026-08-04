'use strict';
/*
 * 糖包 v1.0.7 SQLite 表结构（DDL）
 * 用 CREATE TABLE IF NOT EXISTS 幂等执行；better-sqlite3 同步 API。
 * 所有表结构 100% 由 src/renderer/state/state.js 的 App.state 字段推导，
 * 不存任何明文密钥（密钥始终走主进程密钥库 secrets.js）。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL DEFAULT '',
  agent_id      TEXT,
  system_prompt TEXT,
  created_at    INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  conv_id    TEXT NOT NULL,
  idx        INTEGER NOT NULL DEFAULT 0,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  meta       TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, idx);

CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  api_base   TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS account_models (
  account_id     TEXT NOT NULL,
  name           TEXT NOT NULL,
  context_window INTEGER NOT NULL DEFAULT 128000,
  caps           TEXT,
  PRIMARY KEY (account_id, name)
);
CREATE INDEX IF NOT EXISTS idx_accmodels_acc ON account_models(account_id);

CREATE TABLE IF NOT EXISTS providers (
  module    TEXT PRIMARY KEY,
  account_id TEXT NOT NULL DEFAULT '',
  api_base  TEXT NOT NULL DEFAULT '',
  model     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL DEFAULT '',
  description  TEXT,
  system_prompt TEXT,
  icon         TEXT,
  category     TEXT,
  created_at   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS templates (
  id       TEXT PRIMARY KEY,
  title    TEXT NOT NULL DEFAULT '',
  category TEXT,
  prompt   TEXT,
  icon     TEXT,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workflows (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL DEFAULT '',
  steps TEXT,
  created_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS image_history (
  id         TEXT PRIMARY KEY,
  prompt     TEXT,
  style      TEXT,
  size       TEXT,
  n          INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_imagehist_created ON image_history(created_at DESC);

CREATE TABLE IF NOT EXISTS image_files (
  id         TEXT PRIMARY KEY,
  history_id TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,
  data       TEXT,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_imgfiles_hist ON image_files(history_id, seq);

CREATE TABLE IF NOT EXISTS docs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL DEFAULT '',
  text       TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_docs_created ON docs(created_at DESC);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL DEFAULT '',
  cwd           TEXT NOT NULL DEFAULT '',
  workspace_id  TEXT NOT NULL DEFAULT '',
  auto          INTEGER NOT NULL DEFAULT 0,
  approve_tools TEXT,
  cmd_whitelist TEXT,
  plan_mode     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agent_threads (
  id         TEXT PRIMARY KEY,
  project_id TEXT,
  title      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0,
  history    TEXT
);
CREATE INDEX IF NOT EXISTS idx_threads_proj ON agent_threads(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS kv_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

const TABLES = [
  'conversations', 'messages', 'accounts', 'account_models', 'providers',
  'agents', 'templates', 'workflows', 'image_history', 'image_files',
  'docs', 'projects', 'agent_threads', 'kv_meta',
];

// ===== Schema 版本化迁移（M6） =====
// 当前版本 = 1。MIGRATIONS[i] 表示「从版本 i 升级到 i+1」的迁移函数（参数为 better-sqlite3 的 db）。
// 新装库 user_version=0 → 顺序执行 MIGRATIONS[0..] 建全表；未来改结构时追加新迁移并把 SCHEMA_VERSION +1。
const SCHEMA_VERSION = 1;

/** 迁移 0（v0→v1）：建全部表。CREATE TABLE IF NOT EXISTS 幂等，可安全作用于已存在的旧库。 */
function migration_0(db) {
  db.exec(DDL);
}

const MIGRATIONS = [migration_0];

module.exports = { DDL, TABLES, SCHEMA_VERSION, MIGRATIONS };
