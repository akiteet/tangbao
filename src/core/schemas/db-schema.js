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
  roots_json    TEXT,
  primary_root_id TEXT NOT NULL DEFAULT '',
  auto          INTEGER NOT NULL DEFAULT 0,
  approve_tools TEXT,
  cmd_whitelist TEXT,
  plan_mode     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT 0,
  last_used_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agent_threads (
  id           TEXT PRIMARY KEY,
  project_id   TEXT,
  title        TEXT NOT NULL DEFAULT '',
  updated_at   INTEGER NOT NULL DEFAULT 0,
  history      TEXT,
  draft_text   TEXT NOT NULL DEFAULT '',
  draft_skills TEXT,
  draft_root_scope_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_threads_proj ON agent_threads(project_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS kv_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT,
  workflow_name TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'running',
  input_json    TEXT,
  output_json   TEXT,
  error         TEXT,
  steps_json    TEXT,
  started_at    INTEGER NOT NULL DEFAULT 0,
  finished_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wfruns_wf ON workflow_runs(workflow_id, started_at DESC);
`;

const TABLES = [
  'conversations', 'messages', 'accounts', 'account_models', 'providers',
  'agents', 'templates', 'workflows', 'image_history', 'image_files',
  'docs', 'projects', 'agent_threads', 'kv_meta', 'workflow_runs',
];

// ===== Schema 版本化迁移（M6） =====
// 当前版本 = 16。MIGRATIONS[i] 表示「从版本 i 升级到 i+1」的迁移函数（参数为 better-sqlite3 的 db）。
// 新装库 user_version=0 → 顺序执行 MIGRATIONS[0..] 建全表；未来改结构时追加新迁移并把 SCHEMA_VERSION +1。
const SCHEMA_VERSION = 16;

/** 迁移 0（v0→v1）：建全部表。CREATE TABLE IF NOT EXISTS 幂等，可安全作用于已存在的旧库。 */
function migration_0(db) {
  db.exec(DDL);
}

/** 迁移 1（v1→v2）：新增 workflow_runs 表（v1.0.8 工作流运行历史）。 */
function migration_1(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS workflow_runs (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT,
  workflow_name TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'running',
  input_json    TEXT,
  output_json   TEXT,
  error         TEXT,
  steps_json    TEXT,
  started_at    INTEGER NOT NULL DEFAULT 0,
  finished_at   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_wfruns_wf ON workflow_runs(workflow_id, started_at DESC);
`);
}

/** 迁移 2（v2→v3）：糖码 Agent Run 持久化五表（v1.1.0 M1）。
 *  新表刻意不进 TABLES（clearAll 清数据时保留运行历史/审计轨迹）。 */
function migration_2(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS agent_runs (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  cwd          TEXT NOT NULL DEFAULT '',
  workspace_snapshot_json TEXT,
  workspace_fingerprint TEXT NOT NULL DEFAULT '',
  primary_root_id TEXT NOT NULL DEFAULT '',
  user_goal    TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'running',
  phase        TEXT NOT NULL DEFAULT 'understanding',
  model_id     TEXT NOT NULL DEFAULT '',
  provider_ref TEXT NOT NULL DEFAULT '',
  plan_mode    INTEGER NOT NULL DEFAULT 0,
  limits_json  TEXT,
  usage_json   TEXT,
  error        TEXT,
  started_at   INTEGER NOT NULL DEFAULT 0,
  finished_at  INTEGER NOT NULL DEFAULT 0,
  working_state_id TEXT NOT NULL DEFAULT '',   -- v2（补全 7）：关联 WorkingState
  latest_checkpoint_id TEXT NOT NULL DEFAULT '', -- v2（补全 7）：最近 Checkpoint
  created_at   INTEGER NOT NULL DEFAULT 0,      -- v2（补全 7）：创建时间（与 started_at 同步）
  parent_run_id TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'main',
  depth         INTEGER NOT NULL DEFAULT 0,
  read_only     INTEGER NOT NULL DEFAULT 0,
  budget_json   TEXT,
  continued_from_run_id TEXT NOT NULL DEFAULT '',
  root_run_id   TEXT NOT NULL DEFAULT '',
  continuation_index INTEGER NOT NULL DEFAULT 0,
  root_scope_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_agentruns_thread ON agent_runs(thread_id, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_run_events (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 0,
  type        TEXT NOT NULL DEFAULT '',
  payload_json TEXT,
  created_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agentevent_run ON agent_run_events(run_id, seq);

CREATE TABLE IF NOT EXISTS agent_working_states (
  run_id              TEXT PRIMARY KEY,
  goal                TEXT NOT NULL DEFAULT '',
  constraints_json    TEXT,
  plan_json           TEXT,
  completed_json      TEXT,
  pending_json        TEXT,
  blocked_json        TEXT,
  files_read_json     TEXT,
  files_changed_json  TEXT,
  commands_json       TEXT,
  checks_json         TEXT,
  decisions_json      TEXT,
  unresolved_errors_json TEXT,
  verification_skips_json TEXT,
  pending_decisions_json TEXT,
  subagents_json      TEXT,
  skill_context_json  TEXT,
  assumptions_json    TEXT,
  user_confirmations_json TEXT,
  updated_at          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agent_checkpoints (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL DEFAULT 0,
  reason        TEXT NOT NULL DEFAULT '',
  state_json    TEXT,
  events_to_seq INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agentckpt_run ON agent_checkpoints(run_id, seq);

CREATE TABLE IF NOT EXISTS agent_context_summaries (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL DEFAULT '',
  thread_id        TEXT NOT NULL DEFAULT '',
  covered_from_seq INTEGER NOT NULL DEFAULT 0,
  covered_to_seq   INTEGER NOT NULL DEFAULT 0,
  summary          TEXT NOT NULL DEFAULT '',
  version          INTEGER NOT NULL DEFAULT 1,
  summary_json     TEXT,
  source_hashes_json TEXT,
  validity         TEXT NOT NULL DEFAULT 'valid',
  created_at       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agentsum_thread ON agent_context_summaries(thread_id, created_at DESC);
`);
}

/** 迁移 3（v3→v4）：糖码运行级 ChangeSet（M3 文件快照回滚）。新表不进 TABLES。 */
function migration_3(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS agent_changesets (
  id         TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL DEFAULT '',
  root_id    TEXT NOT NULL DEFAULT '',
  path       TEXT NOT NULL DEFAULT '',
  old_hash   TEXT NOT NULL DEFAULT '',
  content_ref TEXT NOT NULL DEFAULT '',
  operation  TEXT NOT NULL DEFAULT 'write',
  new_hash   TEXT NOT NULL DEFAULT '',
  target_path TEXT NOT NULL DEFAULT '',
  before_exists INTEGER NOT NULL DEFAULT 1,
  status     TEXT NOT NULL DEFAULT 'committed',
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_changesets_run ON agent_changesets(run_id, path);
`);
}

/** 迁移 4（v4→v5）：account_models 加 max_output 列（M6 模型能力表扩展）。 */
function migration_4(db) {
  const cols = db.prepare("PRAGMA table_info(account_models)").all().map((c) => c.name);
  if (!cols.includes('max_output')) {
    db.exec('ALTER TABLE account_models ADD COLUMN max_output INTEGER NOT NULL DEFAULT 0');
  }
}

/** 迁移 5（v5→v6）：account_models 加 think_type 列（聊天修复 D：模型思考类型往返）。 */
function migration_5(db) {
  const cols = db.prepare("PRAGMA table_info(account_models)").all().map((c) => c.name);
  if (!cols.includes('think_type')) {
    db.exec("ALTER TABLE account_models ADD COLUMN think_type TEXT");
  }
}

// v2（补全 7）：迁移 6（v6→v7）：agent_runs 加 working_state_id / latest_checkpoint_id / created_at，回填 created_at=started_at
function migration_6(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(agent_runs)').all().map((c) => c.name));
  const add = (name, ddl) => { if (!cols.has(name)) db.exec('ALTER TABLE agent_runs ADD COLUMN ' + ddl); };
  add('working_state_id', 'working_state_id TEXT NOT NULL DEFAULT \'\'');
  add('latest_checkpoint_id', 'latest_checkpoint_id TEXT NOT NULL DEFAULT \'\'');
  add('created_at', 'created_at INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE agent_runs SET created_at = started_at WHERE created_at = 0');
}

// v5：迁移 7（v7→v8）：糖码会话增加按会话保存的输入文字与 Skill 气泡草稿。
function migration_7(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(agent_threads)').all().map((c) => c.name));
  if (!cols.has('draft_text')) db.exec("ALTER TABLE agent_threads ADD COLUMN draft_text TEXT NOT NULL DEFAULT ''");
  if (!cols.has('draft_skills')) db.exec('ALTER TABLE agent_threads ADD COLUMN draft_skills TEXT');
}

// v6：迁移 8（v8→v9）：Working State 持久化显式跳过验证证据；历史 done 状态统一回填为 completed。
function migration_8(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(agent_working_states)').all().map((c) => c.name));
  if (!cols.has('verification_skips_json')) db.exec('ALTER TABLE agent_working_states ADD COLUMN verification_skips_json TEXT');
  if (!cols.has('pending_decisions_json')) db.exec('ALTER TABLE agent_working_states ADD COLUMN pending_decisions_json TEXT');
  db.exec("UPDATE agent_runs SET status = 'completed' WHERE status = 'done'");
}

// v7：迁移 9（v9→v10）：ContextSummary v2 追加结构化摘要、来源哈希和有效性字段。
function migration_9(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(agent_context_summaries)').all().map((c) => c.name));
  if (!cols.has('summary_json')) db.exec('ALTER TABLE agent_context_summaries ADD COLUMN summary_json TEXT');
  if (!cols.has('source_hashes_json')) db.exec('ALTER TABLE agent_context_summaries ADD COLUMN source_hashes_json TEXT');
  if (!cols.has('validity')) db.exec("ALTER TABLE agent_context_summaries ADD COLUMN validity TEXT NOT NULL DEFAULT 'valid'");
}

// v8：迁移 10（v10→v11）：ChangeSet v2 追加操作、提交后哈希、目标路径和状态。
function migration_10(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(agent_changesets)').all().map((c) => c.name));
  if (!cols.has('operation')) db.exec("ALTER TABLE agent_changesets ADD COLUMN operation TEXT NOT NULL DEFAULT 'write'");
  if (!cols.has('new_hash')) db.exec("ALTER TABLE agent_changesets ADD COLUMN new_hash TEXT NOT NULL DEFAULT ''");
  if (!cols.has('target_path')) db.exec("ALTER TABLE agent_changesets ADD COLUMN target_path TEXT NOT NULL DEFAULT ''");
  if (!cols.has('before_exists')) db.exec('ALTER TABLE agent_changesets ADD COLUMN before_exists INTEGER NOT NULL DEFAULT 1');
  if (!cols.has('status')) db.exec("ALTER TABLE agent_changesets ADD COLUMN status TEXT NOT NULL DEFAULT 'committed'");
}

// v9：迁移 11（v11→v12）：子 Agent 独立 Run 的父子关系、角色、深度、只读边界与预算。
function migration_11(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(agent_runs)').all().map((c) => c.name));
  if (!cols.has('parent_run_id')) db.exec("ALTER TABLE agent_runs ADD COLUMN parent_run_id TEXT NOT NULL DEFAULT ''");
  if (!cols.has('role')) db.exec("ALTER TABLE agent_runs ADD COLUMN role TEXT NOT NULL DEFAULT 'main'");
  if (!cols.has('depth')) db.exec('ALTER TABLE agent_runs ADD COLUMN depth INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('read_only')) db.exec('ALTER TABLE agent_runs ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('budget_json')) db.exec('ALTER TABLE agent_runs ADD COLUMN budget_json TEXT');
  const wsCols = new Set(db.prepare('PRAGMA table_info(agent_working_states)').all().map((c) => c.name));
  if (!wsCols.has('subagents_json')) db.exec('ALTER TABLE agent_working_states ADD COLUMN subagents_json TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agentruns_parent ON agent_runs(parent_run_id, started_at ASC)');
}

const MIGRATIONS = [migration_0, migration_1, migration_2, migration_3, migration_4, migration_5, migration_6, migration_7, migration_8, migration_9, migration_10, migration_11, migration_12, migration_13, migration_14, migration_15];

// v10：迁移 12（v12→v13）：Working State 追加 Skill 工具权限归因上下文（激活来源/包哈希/声明工具），供工具约束与恢复使用。
function migration_12(db) {
  const wsCols = new Set(db.prepare('PRAGMA table_info(agent_working_states)').all().map((c) => c.name));
  if (!wsCols.has('skill_context_json')) db.exec('ALTER TABLE agent_working_states ADD COLUMN skill_context_json TEXT');
}

// v11：迁移 13（v13→v14）：多根工作区项目、Run 快照与分根 ChangeSet。
function migration_13(db) {
  const projectCols = new Set(db.prepare('PRAGMA table_info(projects)').all().map((c) => c.name));
  if (!projectCols.has('roots_json')) db.exec('ALTER TABLE projects ADD COLUMN roots_json TEXT');
  if (!projectCols.has('primary_root_id')) db.exec("ALTER TABLE projects ADD COLUMN primary_root_id TEXT NOT NULL DEFAULT ''");
  const runCols = new Set(db.prepare('PRAGMA table_info(agent_runs)').all().map((c) => c.name));
  if (!runCols.has('workspace_snapshot_json')) db.exec('ALTER TABLE agent_runs ADD COLUMN workspace_snapshot_json TEXT');
  if (!runCols.has('workspace_fingerprint')) db.exec("ALTER TABLE agent_runs ADD COLUMN workspace_fingerprint TEXT NOT NULL DEFAULT ''");
  if (!runCols.has('primary_root_id')) db.exec("ALTER TABLE agent_runs ADD COLUMN primary_root_id TEXT NOT NULL DEFAULT ''");
  const changeCols = new Set(db.prepare('PRAGMA table_info(agent_changesets)').all().map((c) => c.name));
  if (!changeCols.has('root_id')) db.exec("ALTER TABLE agent_changesets ADD COLUMN root_id TEXT NOT NULL DEFAULT ''");
}

// v12：迁移 14（v14→v15）：Continuation 谱系和任务级工作区范围。
function migration_14(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(agent_runs)').all().map((c) => c.name));
  if (!cols.has('continued_from_run_id')) db.exec("ALTER TABLE agent_runs ADD COLUMN continued_from_run_id TEXT NOT NULL DEFAULT ''");
  if (!cols.has('root_run_id')) db.exec("ALTER TABLE agent_runs ADD COLUMN root_run_id TEXT NOT NULL DEFAULT ''");
  if (!cols.has('continuation_index')) db.exec('ALTER TABLE agent_runs ADD COLUMN continuation_index INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('root_scope_json')) db.exec('ALTER TABLE agent_runs ADD COLUMN root_scope_json TEXT');
  db.exec("UPDATE agent_runs SET root_run_id = id WHERE role = 'main' AND root_run_id = ''");
  db.exec('CREATE INDEX IF NOT EXISTS idx_agentruns_continued ON agent_runs(continued_from_run_id, started_at ASC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_agentruns_root ON agent_runs(root_run_id, continuation_index ASC)');
  const threadCols = new Set(db.prepare('PRAGMA table_info(agent_threads)').all().map((c) => c.name));
  if (!threadCols.has('draft_root_scope_json')) db.exec('ALTER TABLE agent_threads ADD COLUMN draft_root_scope_json TEXT');
}

// v13：迁移 15（v15→v16）：Run 版本追踪、Run 汇总指标和跨模块模型调用指标。
// 所有字段/索引均使用存在性检查或 IF NOT EXISTS，允许迁移重复执行。
function migration_15(db) {
  const runCols = new Set(db.prepare('PRAGMA table_info(agent_runs)').all().map((c) => c.name));
  const addRun = (name, ddl) => { if (!runCols.has(name)) db.exec('ALTER TABLE agent_runs ADD COLUMN ' + ddl); };
  addRun('prompt_version', "prompt_version TEXT NOT NULL DEFAULT 'legacy/unknown'");
  addRun('toolset_version', "toolset_version TEXT NOT NULL DEFAULT 'legacy/unknown'");
  addRun('runtime_version', "runtime_version TEXT NOT NULL DEFAULT 'legacy/unknown'");
  db.exec(`
CREATE TABLE IF NOT EXISTS agent_run_metrics (
  run_id              TEXT PRIMARY KEY,
  root_run_id         TEXT NOT NULL DEFAULT '',
  steps               INTEGER NOT NULL DEFAULT 0,
  tool_calls          INTEGER NOT NULL DEFAULT 0,
  input_tokens        INTEGER NOT NULL DEFAULT 0,
  output_tokens       INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_json          TEXT,
  cost_usd            REAL,
  latency_ms          INTEGER,
  queue_wait_ms       INTEGER,
  process_ms          INTEGER,
  human_interventions INTEGER NOT NULL DEFAULT 0,
  recovery_rate       REAL,
  error_breakdown_json TEXT,
  source              TEXT NOT NULL DEFAULT 'runtime',
  created_at          INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_run_metrics_root ON agent_run_metrics(root_run_id, updated_at ASC);

CREATE TABLE IF NOT EXISTS model_call_metrics (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL DEFAULT '',
  root_run_id         TEXT NOT NULL DEFAULT '',
  scope               TEXT NOT NULL DEFAULT 'agent',
  call_type           TEXT NOT NULL DEFAULT 'chat',
  model_id            TEXT NOT NULL DEFAULT '',
  provider            TEXT NOT NULL DEFAULT '',
  request_id          TEXT NOT NULL DEFAULT '',
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  reasoning_tokens    INTEGER,
  cache_json          TEXT,
  cost_usd            REAL,
  latency_ms          INTEGER,
  queue_wait_ms       INTEGER,
  status              TEXT NOT NULL DEFAULT 'completed',
  error_type          TEXT NOT NULL DEFAULT '',
  started_at          INTEGER NOT NULL DEFAULT 0,
  finished_at         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_model_call_metrics_run ON model_call_metrics(run_id, started_at ASC);
CREATE INDEX IF NOT EXISTS idx_model_call_metrics_scope ON model_call_metrics(scope, started_at DESC);
`);
}

module.exports = { DDL, TABLES, SCHEMA_VERSION, MIGRATIONS };
