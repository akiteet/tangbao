'use strict';
/*
 * 糖包 存储服务（主进程独占，better-sqlite3 同步 API）
 *
 * 这是 v1.0.7「不再使用大一统 State」的数据后端。M3 阶段它作为**增量层**存在：
 * 由迁移器一次性灌入，应用仍走 state.json / App.persist()，84 处调用点的切换留到 M4。
 *
 * 安全：绝不存明文密钥。本服务只存账户元数据（id/name/apiBase/模型列表），
 * 密钥始终由主进程密钥库 secrets.js 保管。
 *
 * better-sqlite3 是原生模块：若未编译（沙箱/未 electron-rebuild），init() 返回 false，
 * 调用方应静默回退 state.json，不阻断启动。
 */
let Database = null;
try { Database = require('better-sqlite3'); } catch (e) { Database = null; }
const fs = require('fs');

const { DDL, TABLES, SCHEMA_VERSION, MIGRATIONS } = require('../../core/schemas/db-schema');
const { normalizeRunStatus, TERMINAL_PHASES } = require('../../core/agent-runtime/state-machine');
const { tracePage, exportRedactedJSONL, redactPayload, eventStatus } = require('../../core/agent-runtime/trace-recorder');
const { normalizeModelUsage, mergeCacheMetrics } = require('../../core/agent-runtime/model-telemetry');
const { calculateCost, normalizeAttribution, normalizeCost, mergeCosts } = require('../../core/agent-runtime/cost-ledger');

let db = null;
let fileRepo = null;
const stmt = {};

const j = (v) => (v === undefined ? null : JSON.stringify(v));
const u = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch (_) { return null; } };

function packTelemetry(cache, cost, attribution) {
  const payload = cache && typeof cache === 'object' ? Object.assign({}, cache) : {};
  if (cost) payload.cost = normalizeCost(cost);
  if (attribution) payload.attribution = normalizeAttribution(attribution);
  return Object.keys(payload).length ? payload : null;
}

function unpackTelemetry(value) {
  const payload = value && typeof value === 'object' ? value : {};
  const cache = payload.metrics && typeof payload.metrics === 'object'
    ? payload.metrics
    : (payload.cache && typeof payload.cache === 'object' ? payload.cache : payload);
  return {
    cache: cache && typeof cache === 'object' ? cache : null,
    cost: payload.cost ? normalizeCost(payload.cost) : null,
    attribution: payload.attribution ? normalizeAttribution(payload.attribution) : null,
  };
}

// v16 initially created token columns as NOT NULL even though unknown usage is
// represented by null. Rebuild that table in place for databases created by
// that release, without changing the public schema version.
function repairAgentRunMetricTokenColumns(database) {
  const columns = database.prepare('PRAGMA table_info(agent_run_metrics)').all();
  const tokenNames = new Set(['input_tokens', 'output_tokens', 'reasoning_tokens']);
  const existing = new Set(columns.map((column) => column.name));
  if (!['run_id', 'root_run_id', 'input_tokens', 'output_tokens', 'reasoning_tokens'].every((name) => existing.has(name))) return;
  if (!columns.some((column) => tokenNames.has(column.name) && Number(column.notnull) === 1)) return;

  database.transaction(() => {
    database.exec(`
      DROP TABLE IF EXISTS agent_run_metrics_v16_repair;
      CREATE TABLE agent_run_metrics_v16_repair (
        run_id              TEXT PRIMARY KEY,
        root_run_id         TEXT NOT NULL DEFAULT '',
        steps               INTEGER NOT NULL DEFAULT 0,
        tool_calls          INTEGER NOT NULL DEFAULT 0,
        input_tokens        INTEGER,
        output_tokens       INTEGER,
        reasoning_tokens    INTEGER,
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
      INSERT INTO agent_run_metrics_v16_repair (
        run_id,root_run_id,steps,tool_calls,input_tokens,output_tokens,
        reasoning_tokens,cache_json,cost_usd,latency_ms,queue_wait_ms,
        process_ms,human_interventions,recovery_rate,error_breakdown_json,
        source,created_at,updated_at
      )
      SELECT run_id,root_run_id,steps,tool_calls,input_tokens,output_tokens,
        reasoning_tokens,cache_json,cost_usd,latency_ms,queue_wait_ms,
        process_ms,human_interventions,recovery_rate,error_breakdown_json,
        source,created_at,updated_at
      FROM agent_run_metrics;
      DROP TABLE agent_run_metrics;
      ALTER TABLE agent_run_metrics_v16_repair RENAME TO agent_run_metrics;
      CREATE INDEX IF NOT EXISTS idx_agent_run_metrics_root ON agent_run_metrics(root_run_id, updated_at ASC);
    `);
  })();
}

function metricCost(metric, usage, cache) {
  if (metric && metric.cost) return normalizeCost(metric.cost);
  if (metric && metric.costUsd != null) return normalizeCost({ totalUsd: metric.costUsd, source: metric.costSource || 'estimated', unknownReason: metric.costSource ? null : 'legacy_estimate' });
  return calculateCost({ usage, cache, provider: metric && metric.provider, model: metric && metric.modelId });
}

/** 打开并初始化数据库。成功返回 true，原生模块不可用返回 false。 */
function init(dbPath, fileRepoInstance) {
  if (db) return true;
  if (!Database) return false;
  let opened = null;
  let migrationBackup = '';
  try {
    // Keep a recoverable copy before a version upgrade. SQLite transactions still
    // protect individual steps; the copy covers startup failures and WAL issues.
    if (dbPath && fs.existsSync(dbPath)) {
      const probe = new Database(dbPath, { readonly: true });
      let probeVersion = 0;
      try { probeVersion = Number(probe.pragma('user_version', { simple: true })) || 0; } catch (_) {}
      try { probe.close(); } catch (_) {}
      if (probeVersion < SCHEMA_VERSION) {
        migrationBackup = String(dbPath) + '.pre-v' + SCHEMA_VERSION + '.bak';
        try { fs.copyFileSync(dbPath, migrationBackup); } catch (_) { migrationBackup = ''; }
      }
    }
    opened = new Database(dbPath);
    opened.pragma('journal_mode = WAL');
    opened.pragma('foreign_keys = ON');
    opened.pragma('synchronous = NORMAL'); // v1.1.6（D1）：WAL 模式下 NORMAL 安全，每次提交不再 fsync，降低主进程阻塞
    // M6：版本化迁移 —— 按 PRAGMA user_version 顺序执行 MIGRATIONS[cur..]，每步在事务内提交
    let cur = 0;
    try { cur = Number(opened.pragma('user_version', { simple: true })) || 0; } catch (_) {}
    for (let i = cur; i < SCHEMA_VERSION; i++) {
      const m = MIGRATIONS[i];
      if (!m) break;
      opened.transaction(() => { m(opened); opened.pragma('user_version = ' + (i + 1)); })();
    }
    repairAgentRunMetricTokenColumns(opened);
    fileRepo = fileRepoInstance || null;
    db = opened;
    prepare();
    return true;
  } catch (e) {
    // B5（P2）：初始化/迁移失败时回收连接并置空——避免半初始化 DB 被后续复用（调用方回退 state.json）
    try { if (opened) opened.close(); } catch (_) {}
    if (migrationBackup && fs.existsSync(migrationBackup)) {
      try { fs.copyFileSync(migrationBackup, dbPath); } catch (_) {}
    }
    db = null;
    console.error('[存储层] SQLite 初始化/迁移失败，已回退 state.json：', e && e.message ? e.message : e);
    return false;
  }
}

/** M6：SQLite 完整性自检。返回 true 表示 OK；调用方应在启动时检查，失败则禁用 SQLite 回退 state.json。 */
function checkIntegrity() {
  if (!db) return false;
  try {
    const r = db.pragma('integrity_check', { simple: true });
    return r === 'ok';
  } catch (e) {
    console.error('[存储层] integrity_check 失败：', e && e.message ? e.message : e);
    return false;
  }
}

function close() {
  if (db) { try { db.close(); } catch (_) {} db = null; }
}
function ready() { return !!db; }
function dbPathInfo() { return db ? db.name : null; }

function prepare() {
  stmt.insConv = db.prepare(
    `INSERT INTO conversations (id,title,agent_id,system_prompt,created_at,updated_at)
     VALUES (@id,@title,@agent_id,@system_prompt,@created_at,@updated_at)
     ON CONFLICT(id) DO UPDATE SET title=@title, agent_id=@agent_id, system_prompt=@system_prompt, updated_at=@updated_at`);
  stmt.getConv = db.prepare('SELECT * FROM conversations WHERE id=?');
  stmt.listConv = db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?');
  stmt.delConv = db.prepare('DELETE FROM conversations WHERE id=?');
  stmt.delMsgByConv = db.prepare('DELETE FROM messages WHERE conv_id=?');
  stmt.touchConv = db.prepare('UPDATE conversations SET title=@title, updated_at=@updated_at WHERE id=@id');

  stmt.insMsg = db.prepare(
    `INSERT INTO messages (id,conv_id,idx,role,content,created_at,meta)
     VALUES (@id,@conv_id,@idx,@role,@content,@created_at,@meta)
     ON CONFLICT(id) DO UPDATE SET conv_id=@conv_id, idx=@idx, role=@role, content=@content, created_at=@created_at, meta=@meta`);
  stmt.getMsg = db.prepare('SELECT * FROM messages WHERE conv_id=? ORDER BY idx ASC');

  stmt.insAcc = db.prepare(
    `INSERT INTO accounts (id,name,api_base,created_at,updated_at)
     VALUES (@id,@name,@api_base,@created_at,@updated_at)
     ON CONFLICT(id) DO UPDATE SET name=@name, api_base=@api_base, updated_at=@updated_at`);
  stmt.listAcc = db.prepare('SELECT * FROM accounts ORDER BY created_at ASC');
  stmt.delAcc = db.prepare('DELETE FROM accounts WHERE id=?');
  stmt.delAccModels = db.prepare('DELETE FROM account_models WHERE account_id=?');
  stmt.insAccModel = db.prepare(
    `INSERT INTO account_models (account_id,name,context_window,max_output,caps,think_type,image_model,image_extra) VALUES (@account_id,@name,@context_window,@max_output,@caps,@think_type,@image_model,@image_extra)
     ON CONFLICT(account_id,name) DO UPDATE SET context_window=@context_window, max_output=@max_output, caps=@caps, think_type=@think_type, image_model=@image_model, image_extra=@image_extra`);

  stmt.insProv = db.prepare(
    `INSERT INTO providers (module,account_id,api_base,model)
     VALUES (@module,@account_id,@api_base,@model)
     ON CONFLICT(module) DO UPDATE SET account_id=@account_id, api_base=@api_base, model=@model`);
  stmt.getProv = db.prepare('SELECT * FROM providers');

  stmt.insAgent = db.prepare(
    `INSERT INTO agents (id,name,description,system_prompt,icon,category,created_at)
     VALUES (@id,@name,@description,@system_prompt,@icon,@category,@created_at)
     ON CONFLICT(id) DO UPDATE SET name=@name, description=@description, system_prompt=@system_prompt, icon=@icon, category=@category`);
  stmt.listAgent = db.prepare('SELECT * FROM agents ORDER BY created_at ASC');
  stmt.delAgent = db.prepare('DELETE FROM agents WHERE id=?');

  stmt.insTpl = db.prepare(
    `INSERT INTO templates (id,title,category,prompt,icon,created_at)
     VALUES (@id,@title,@category,@prompt,@icon,@created_at)
     ON CONFLICT(id) DO UPDATE SET title=@title, category=@category, prompt=@prompt, icon=@icon`);
  stmt.listTpl = db.prepare('SELECT * FROM templates ORDER BY created_at ASC');
  stmt.delTpl = db.prepare('DELETE FROM templates WHERE id=?');

  stmt.insWf = db.prepare(
    `INSERT INTO workflows (id,name,steps,created_at)
     VALUES (@id,@name,@steps,@created_at)
     ON CONFLICT(id) DO UPDATE SET name=@name, steps=@steps`);
  stmt.listWf = db.prepare('SELECT * FROM workflows ORDER BY created_at ASC');
  stmt.delWf = db.prepare('DELETE FROM workflows WHERE id=?');

  stmt.insImgHist = db.prepare(
    `INSERT INTO image_history (id,prompt,style,size,n,created_at)
     VALUES (@id,@prompt,@style,@size,@n,@created_at)
     ON CONFLICT(id) DO UPDATE SET prompt=@prompt, style=@style, size=@size, n=@n`);
  stmt.insImgFile = db.prepare(
    `INSERT INTO image_files (id,history_id,seq,data,created_at)
     VALUES (@id,@history_id,@seq,@data,@created_at)
     ON CONFLICT(id) DO UPDATE SET history_id=@history_id, seq=@seq, data=@data`);

  stmt.insDoc = db.prepare(
    `INSERT INTO docs (id,name,text,size,created_at)
     VALUES (@id,@name,@text,@size,@created_at)
     ON CONFLICT(id) DO UPDATE SET name=@name, text=@text, size=@size`);

  stmt.insProj = db.prepare(
    `INSERT INTO projects (id,name,cwd,workspace_id,roots_json,primary_root_id,auto,approve_tools,cmd_whitelist,plan_mode,created_at,last_used_at)
     VALUES (@id,@name,@cwd,@workspace_id,@roots_json,@primary_root_id,@auto,@approve_tools,@cmd_whitelist,@plan_mode,@created_at,@last_used_at)
     ON CONFLICT(id) DO UPDATE SET name=@name, cwd=@cwd, workspace_id=@workspace_id, roots_json=@roots_json, primary_root_id=@primary_root_id, auto=@auto,
       approve_tools=@approve_tools, cmd_whitelist=@cmd_whitelist, plan_mode=@plan_mode, last_used_at=@last_used_at`);
  stmt.listProj = db.prepare('SELECT * FROM projects ORDER BY created_at ASC');

  stmt.insThread = db.prepare(
    `INSERT INTO agent_threads (id,project_id,title,updated_at,history,draft_text,draft_skills,draft_root_scope_json)
     VALUES (@id,@project_id,@title,@updated_at,@history,@draft_text,@draft_skills,@draft_root_scope_json)
     ON CONFLICT(id) DO UPDATE SET project_id=@project_id, title=@title, updated_at=@updated_at,
       history=@history, draft_text=@draft_text, draft_skills=@draft_skills, draft_root_scope_json=@draft_root_scope_json`);

  stmt.getKV = db.prepare('SELECT value FROM kv_meta WHERE key=?');
  stmt.insKV = db.prepare(
    `INSERT INTO kv_meta (key,value) VALUES (@key,@value)
     ON CONFLICT(key) DO UPDATE SET value=@value`);
  stmt.allKV = db.prepare('SELECT key,value FROM kv_meta');

  // ---- M4 读源：readState 用 ----
  stmt.getAccModels = db.prepare('SELECT name, context_window, max_output, caps, think_type, image_model, image_extra FROM account_models WHERE account_id=? ORDER BY name ASC');
  stmt.listImgHist = db.prepare('SELECT * FROM image_history ORDER BY created_at DESC');
  stmt.listImgFiles = db.prepare('SELECT * FROM image_files WHERE history_id=? ORDER BY seq ASC');
  stmt.allImgFiles = db.prepare('SELECT data FROM image_files');
  stmt.listDocsAll = db.prepare('SELECT * FROM docs ORDER BY created_at DESC');
  stmt.delDoc = db.prepare('DELETE FROM docs WHERE id=?');
  stmt.listThreadsAll = db.prepare('SELECT * FROM agent_threads ORDER BY updated_at DESC');

  // ---- M7（v1.0.8）：工作流运行历史（独立表，不随 App.state 写穿） ----
  stmt.insWfRun = db.prepare(
    `INSERT INTO workflow_runs (id,workflow_id,workflow_name,status,input_json,output_json,error,steps_json,started_at,finished_at)
     VALUES (@id,@workflow_id,@workflow_name,@status,@input_json,@output_json,@error,@steps_json,@started_at,@finished_at)
     ON CONFLICT(id) DO UPDATE SET workflow_id=@workflow_id, workflow_name=@workflow_name, status=@status,
       input_json=@input_json, output_json=@output_json, error=@error, steps_json=@steps_json,
       started_at=@started_at, finished_at=@finished_at`);
  stmt.listWfRuns = db.prepare('SELECT * FROM workflow_runs WHERE workflow_id=? ORDER BY started_at DESC LIMIT ?');

  // ---- v1.1.0（M1）：糖码 Agent Run 持久化（五表） ----
  stmt.insRun = db.prepare(
    `INSERT INTO agent_runs (id,thread_id,workspace_id,cwd,workspace_snapshot_json,workspace_fingerprint,primary_root_id,user_goal,status,phase,model_id,provider_ref,plan_mode,limits_json,usage_json,error,started_at,finished_at,working_state_id,latest_checkpoint_id,created_at,parent_run_id,role,depth,read_only,budget_json,continued_from_run_id,root_run_id,continuation_index,root_scope_json,prompt_version,toolset_version,runtime_version)
     VALUES (@id,@thread_id,@workspace_id,@cwd,@workspace_snapshot_json,@workspace_fingerprint,@primary_root_id,@user_goal,@status,@phase,@model_id,@provider_ref,@plan_mode,@limits_json,@usage_json,@error,@started_at,@finished_at,@working_state_id,@latest_checkpoint_id,@created_at,@parent_run_id,@role,@depth,@read_only,@budget_json,@continued_from_run_id,@root_run_id,@continuation_index,@root_scope_json,@prompt_version,@toolset_version,@runtime_version)`);
   stmt.updRun = db.prepare(
    `UPDATE agent_runs SET status=@status, phase=@phase, usage_json=@usage_json, error=@error, finished_at=@finished_at,
        prompt_version=COALESCE(@prompt_version,prompt_version), toolset_version=COALESCE(@toolset_version,toolset_version), runtime_version=COALESCE(@runtime_version,runtime_version),
        budget_json=COALESCE(@budget_json,budget_json), model_id=COALESCE(@model_id,model_id), provider_ref=COALESCE(@provider_ref,provider_ref)
      WHERE id=@id AND (status NOT IN ('completed','blocked','failed','budget_exhausted','cancelled') OR status=@status)`);
  stmt.listRuns = db.prepare('SELECT * FROM agent_runs WHERE thread_id=? ORDER BY started_at DESC LIMIT ? OFFSET ?');
  stmt.listRunsByRoot = db.prepare('SELECT * FROM agent_runs WHERE root_run_id=? OR id=? ORDER BY depth ASC, started_at ASC');
  stmt.listRunsAll = db.prepare('SELECT * FROM agent_runs ORDER BY started_at ASC, created_at ASC');
  stmt.getRun = db.prepare('SELECT * FROM agent_runs WHERE id=?');
  stmt.insEvent = db.prepare(
    `INSERT INTO agent_run_events (id,run_id,seq,type,payload_json,created_at)
     VALUES (@id,@run_id,@seq,@type,@payload_json,@created_at)`);
  stmt.listEvents = db.prepare('SELECT * FROM agent_run_events WHERE run_id=? ORDER BY seq ASC');
  stmt.listTraceEvents = db.prepare(
    `SELECT e.*, r.root_run_id, r.parent_run_id, r.role, r.depth, r.status AS run_status
       FROM agent_run_events e
       JOIN agent_runs r ON r.id=e.run_id
      WHERE r.root_run_id=? OR r.id=?
      ORDER BY e.created_at ASC, e.id ASC`);
  stmt.maxEventSeq = db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM agent_run_events WHERE run_id=?');
  stmt.upsertRunMetrics = db.prepare(
    `INSERT INTO agent_run_metrics (run_id,root_run_id,steps,tool_calls,input_tokens,output_tokens,reasoning_tokens,cache_json,cost_usd,latency_ms,queue_wait_ms,process_ms,human_interventions,recovery_rate,error_breakdown_json,source,created_at,updated_at)
     VALUES (@run_id,@root_run_id,@steps,@tool_calls,@input_tokens,@output_tokens,@reasoning_tokens,@cache_json,@cost_usd,@latency_ms,@queue_wait_ms,@process_ms,@human_interventions,@recovery_rate,@error_breakdown_json,@source,@created_at,@updated_at)
     ON CONFLICT(run_id) DO UPDATE SET root_run_id=@root_run_id,steps=@steps,tool_calls=@tool_calls,input_tokens=@input_tokens,output_tokens=@output_tokens,reasoning_tokens=@reasoning_tokens,cache_json=@cache_json,cost_usd=@cost_usd,latency_ms=@latency_ms,queue_wait_ms=@queue_wait_ms,process_ms=@process_ms,human_interventions=@human_interventions,recovery_rate=@recovery_rate,error_breakdown_json=@error_breakdown_json,source=@source,updated_at=@updated_at`);
  stmt.getRunMetrics = db.prepare('SELECT * FROM agent_run_metrics WHERE run_id=?');
  stmt.listRunMetricsByRoot = db.prepare('SELECT * FROM agent_run_metrics WHERE root_run_id=? OR run_id=? ORDER BY updated_at ASC');
  stmt.insModelCallMetric = db.prepare(
    `INSERT INTO model_call_metrics (id,run_id,root_run_id,scope,call_type,model_id,provider,request_id,input_tokens,output_tokens,reasoning_tokens,cache_json,cost_usd,latency_ms,queue_wait_ms,status,error_type,started_at,finished_at)
     VALUES (@id,@run_id,@root_run_id,@scope,@call_type,@model_id,@provider,@request_id,@input_tokens,@output_tokens,@reasoning_tokens,@cache_json,@cost_usd,@latency_ms,@queue_wait_ms,@status,@error_type,@started_at,@finished_at)
     ON CONFLICT(id) DO UPDATE SET run_id=@run_id,root_run_id=@root_run_id,scope=@scope,call_type=@call_type,model_id=@model_id,provider=@provider,request_id=@request_id,input_tokens=@input_tokens,output_tokens=@output_tokens,reasoning_tokens=@reasoning_tokens,cache_json=@cache_json,cost_usd=@cost_usd,latency_ms=@latency_ms,queue_wait_ms=@queue_wait_ms,status=@status,error_type=@error_type,started_at=@started_at,finished_at=@finished_at`);
  stmt.listModelCallMetrics = db.prepare('SELECT * FROM model_call_metrics WHERE run_id=? ORDER BY started_at ASC');
  stmt.listModelCallMetricsByRoot = db.prepare(
    'SELECT * FROM model_call_metrics WHERE root_run_id=? OR run_id=? ORDER BY started_at ASC');
  stmt.upsertWS = db.prepare(
    `INSERT INTO agent_working_states (run_id,goal,constraints_json,plan_json,completed_json,pending_json,blocked_json,files_read_json,files_changed_json,commands_json,checks_json,decisions_json,unresolved_errors_json,verification_skips_json,pending_decisions_json,subagents_json,skill_context_json,assumptions_json,user_confirmations_json,updated_at)
     VALUES (@run_id,@goal,@constraints_json,@plan_json,@completed_json,@pending_json,@blocked_json,@files_read_json,@files_changed_json,@commands_json,@checks_json,@decisions_json,@unresolved_errors_json,@verification_skips_json,@pending_decisions_json,@subagents_json,@skill_context_json,@assumptions_json,@user_confirmations_json,@updated_at)
     ON CONFLICT(run_id) DO UPDATE SET goal=@goal, constraints_json=@constraints_json, plan_json=@plan_json,
       completed_json=@completed_json, pending_json=@pending_json, blocked_json=@blocked_json,
       files_read_json=@files_read_json, files_changed_json=@files_changed_json, commands_json=@commands_json,
       checks_json=@checks_json, decisions_json=@decisions_json, unresolved_errors_json=@unresolved_errors_json,
       verification_skips_json=@verification_skips_json, pending_decisions_json=@pending_decisions_json, subagents_json=@subagents_json, skill_context_json=@skill_context_json,
       assumptions_json=@assumptions_json, user_confirmations_json=@user_confirmations_json, updated_at=@updated_at`);
  stmt.getWS = db.prepare('SELECT * FROM agent_working_states WHERE run_id=?');
  stmt.insCheckpoint = db.prepare(
    `INSERT INTO agent_checkpoints (id,run_id,seq,reason,state_json,events_to_seq,created_at)
     VALUES (@id,@run_id,@seq,@reason,@state_json,@events_to_seq,@created_at)`);
  // v2（P0-A）：Checkpoint 读取（恢复/续跑）
  stmt.getCheckpoint = db.prepare('SELECT * FROM agent_checkpoints WHERE run_id=? ORDER BY seq DESC, created_at DESC LIMIT 1');
  stmt.listCheckpoints = db.prepare('SELECT id, run_id, seq, reason, created_at FROM agent_checkpoints WHERE run_id=? ORDER BY seq DESC');
  stmt.insSummary = db.prepare(
    `INSERT INTO agent_context_summaries (id,run_id,thread_id,covered_from_seq,covered_to_seq,summary,version,summary_json,source_hashes_json,validity,created_at)
     VALUES (@id,@run_id,@thread_id,@covered_from_seq,@covered_to_seq,@summary,@version,@summary_json,@source_hashes_json,@validity,@created_at)`);
  stmt.latestSummary = db.prepare(
    'SELECT * FROM agent_context_summaries WHERE thread_id=? ORDER BY created_at DESC, version DESC LIMIT 1');
  // ---- v1.1.0（M3）：ChangeSet（运行级文件快照回滚） ----
  stmt.insChangeset = db.prepare(
    `INSERT INTO agent_changesets (id,run_id,root_id,path,old_hash,content_ref,operation,new_hash,target_path,before_exists,status,created_at)
     VALUES (@id,@run_id,@root_id,@path,@old_hash,@content_ref,@operation,@new_hash,@target_path,@before_exists,@status,@created_at)
     ON CONFLICT(id) DO UPDATE SET root_id=@root_id, operation=@operation, new_hash=@new_hash, target_path=@target_path, status=@status, created_at=@created_at`);
  stmt.listChangesets = db.prepare('SELECT * FROM agent_changesets WHERE run_id=? ORDER BY created_at ASC');
}

/* ----------------------------- 实现层（StorageService 使用） ----------------------------- */

function upsertConversation(c) {
  stmt.insConv.run({
    id: c.id, title: c.title || '', agent_id: c.agentId || null,
    system_prompt: c.systemPrompt || null,
    created_at: Number(c.createdAt) || Date.now(),
    updated_at: Number(c.updatedAt) || Date.now(),
  });
}
function getConversation(id) { return stmt.getConv.get(id) || null; }
function listConversations(limit) { return stmt.listConv.all(limit || 200); }
function deleteConversation(id) {
  stmt.delMsgByConv.run(id);
  stmt.delConv.run(id);
}
function touchConversation(id, title, updatedAt) {
  stmt.touchConv.run({ id, title: title || '', updated_at: Number(updatedAt) || Date.now() });
}

function replaceMessages(convId, msgs) {
  const run = db.transaction((cid, list) => {
    stmt.delMsgByConv.run(cid);
    list.forEach((m, idx) => {
      // 聊天修复 D：chat 消息顶层 think/webSources/attachments/versions/reasoning 等并入 meta，SQLite 往返不丢
      const top = {};
      ['think', 'webSources', 'attachments', 'versions', 'versionIdx', 'reasoning', 'meta', 'done'].forEach((k) => {
        if (m[k] !== undefined) top[k] = m[k];
      });
      const meta = Object.keys(top).length ? j(top) : null;
      stmt.insMsg.run({
        id: m.id || ('m_' + cid + '_' + idx),
        conv_id: cid, idx, role: m.role,
        content: typeof m.content === 'string' ? m.content : (m.content == null ? '' : String(m.content)),
        created_at: Number(m.createdAt) || Number(m.created_at) || Date.now(),
        meta,
      });
    });
  });
  run(convId, msgs || []);
}
function getMessages(convId) { return stmt.getMsg.all(convId); }

function upsertAccount(a) {
  const now = Date.now();
  stmt.insAcc.run({ id: a.id, name: a.name || '', api_base: a.apiBase || '', created_at: now, updated_at: now });
}
function listAccounts() { return stmt.listAcc.all(); }
function deleteAccount(id) {
  stmt.delAccModels.run(id);
  stmt.delAcc.run(id);
}
function setAccountModels(accountId, models) {
  const run = db.transaction((accId, list) => {
    stmt.delAccModels.run(accId);
    (list || []).forEach((m) => {
      const name = typeof m === 'string' ? m : (m && m.name);
      if (!name) return;
      const cw = (typeof m === 'object' && m.contextWindow) ? Number(m.contextWindow) : 128000;
      // v1.1.0（M6）：max_output（最大输出 token，默认 0=未配置）
      const mo = (typeof m === 'object' && m.maxOutput) ? Number(m.maxOutput) : 0;
      const caps = (typeof m === 'object' && m.caps) ? String(m.caps) : null;
      // 聊天修复 D：thinkType（思考类型）往返
      const tt = (typeof m === 'object' && m.thinkType) ? String(m.thinkType) : null;
      // v1.1.8：图像分区往返——imageModel 标记 + 协议/策略/格式/尺寸打包 JSON
      const im = (typeof m === 'object' && m.imageModel === true) ? 1 : 0;
      let extra = null;
      if (typeof m === 'object') {
        const e = {};
        if (m.imageProtocol) e.imageProtocol = m.imageProtocol;
        if (m.imageSizeStrategy) e.imageSizeStrategy = m.imageSizeStrategy;
        if (m.imageSizeFormat) e.imageSizeFormat = m.imageSizeFormat;
        if (Array.isArray(m.imageSizes) && m.imageSizes.length) e.imageSizes = m.imageSizes;
        extra = Object.keys(e).length ? JSON.stringify(e) : null;
      }
      stmt.insAccModel.run({ account_id: accId, name, context_window: cw || 128000, max_output: mo || 0, caps, think_type: tt, image_model: im, image_extra: extra });
    });
  });
  run(accountId, models);
}

function upsertProvider(module, p) {
  stmt.insProv.run({ module, account_id: (p && p.accountId) || '', api_base: (p && p.apiBase) || '', model: (p && p.model) || '' });
}
function getProviders() {
  const rows = stmt.getProv.all();
  const out = {};
  rows.forEach((r) => { out[r.module] = { accountId: r.account_id, apiBase: r.api_base, model: r.model }; });
  return out;
}

function upsertAgent(a) {
  stmt.insAgent.run({
    id: a.id, name: a.name || '', description: a.description || null,
    system_prompt: a.systemPrompt || null, icon: a.icon || null, category: a.category || null,
    created_at: Number(a.createdAt) || Date.now(),
  });
}
function listAgents() { return stmt.listAgent.all(); }
function deleteAgent(id) { stmt.delAgent.run(id); }

function upsertTemplate(t) {
  stmt.insTpl.run({
    id: t.id, title: t.title || '', category: t.category || null, prompt: t.prompt || null,
    icon: t.icon || null, created_at: Number(t.createdAt) || Date.now(),
  });
}
function listTemplates() { return stmt.listTpl.all(); }
function deleteTemplate(id) { stmt.delTpl.run(id); }

function upsertWorkflow(w) {
  stmt.insWf.run({ id: w.id, name: w.name || '', steps: j(w.steps), created_at: Number(w.createdAt) || Date.now() });
}
function listWorkflows() { return stmt.listWf.all(); }
function deleteWorkflow(id) { stmt.delWf.run(id); }

function upsertImageHistory(item) {
  stmt.insImgHist.run({
    id: item.id, prompt: item.prompt || null, style: item.style || null,
    size: item.size || null, n: Number(item.n) || 0, created_at: Number(item.createdAt) || Date.now(),
  });
}
// M6：图片从 base64 提取为文件仓文件（files/images/<historyId>_<seq>.<ext>），DB 只存文件名。
// 文件写入失败时回退为把 base64 原文存表（readState 兼容两种形态）。
function stripDataUrl(b64) {
  return /^data:[^;]+;base64,/.test(b64) ? b64.replace(/^data:[^;]+;base64,/, '') : b64;
}
function sniffImageExt(b64) {
  try {
    const buf = Buffer.from(stripDataUrl(b64), 'base64');
    if (!buf.length) return '';
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
    if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'webp';
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
    return '';
  } catch (_) { return ''; }
}
function addImageFile(historyId, seq, data) {
  let fname = null;
  if (fileRepo && typeof data === 'string' && data) {
    try {
      const ext = sniffImageExt(data);
      const id = String(historyId) + '_' + seq + (ext ? '.' + ext : '');
      fileRepo.put('images', id, Buffer.from(stripDataUrl(data), 'base64'));
      fname = id;
    } catch (e) { /* 写文件失败 → 退回 base64 存表 */ }
  }
  stmt.insImgFile.run({
    id: 'img_' + historyId + '_' + seq, history_id: historyId, seq,
    data: fname || data || null, created_at: Date.now(),
  });
}

function upsertDoc(doc) {
  stmt.insDoc.run({
    id: doc.id, name: doc.name || '', text: doc.text || '', size: Number(doc.size) || (doc.text ? doc.text.length : 0),
    created_at: Number(doc.createdAt) || Date.now(),
  });
  if (fileRepo && typeof doc.text === 'string') {
    try { fileRepo.put('documents', doc.id, Buffer.from(doc.text, 'utf8')); } catch (_) { /* ignore */ }
  }
}
function getDocText(id) {
  if (!fileRepo) return null;
  const buf = fileRepo.get('documents', id);
  return buf ? buf.toString('utf8') : null;
}
// v1.1.6（糖读增强）：删除文档行 + 文件仓 documents/{id} blob，避免删除后从 SQLite fallback 复活
function deleteDoc(id) {
  stmt.delDoc.run(id);
  try { fileRepo.remove('documents', id); } catch (_) { /* 文件仓删除失败不阻断 */ }
}

function upsertProject(p) {
  stmt.insProj.run({
    id: p.id, name: p.name || '', cwd: p.cwd || '', workspace_id: p.workspaceId || '',
    roots_json: j(Array.isArray(p.roots) ? p.roots : []), primary_root_id: String(p.primaryRootId || ''),
    auto: p.auto ? 1 : 0, approve_tools: j(p.approveTools), cmd_whitelist: j(p.cmdWhitelist),
    plan_mode: p.planMode ? 1 : 0, created_at: Number(p.createdAt) || Date.now(),
    last_used_at: Number(p.lastUsedAt) || Date.now(),
  });
}
function listProjects() { return stmt.listProj.all(); }

function upsertThread(t) {
  stmt.insThread.run({
    id: t.id, project_id: t.projectId || null, title: t.title || '',
    updated_at: Number(t.updatedAt) || Date.now(), history: j(t.history),
    draft_text: typeof t.draftText === 'string' ? t.draftText : '',
    draft_skills: j(Array.isArray(t.draftSkills) ? t.draftSkills : []),
    draft_root_scope_json: j(t.draftRootScope && typeof t.draftRootScope === 'object' ? t.draftRootScope : { mode: 'primary', rootId: '' }),
  });
}

// ---- M4 读源：readState 用 ----
function getAccountModels(accountId) { return stmt.getAccModels.all(accountId); }
function listImageHistory() { return stmt.listImgHist.all(); }
function listImageFiles(historyId) { return stmt.listImgFiles.all(historyId); }
function listDocs() { return stmt.listDocsAll.all(); }
function listThreads() { return stmt.listThreadsAll.all(); }

// ---- M6 GC：被引用的文件仓文件名/文档 id（供孤儿清理） ----
function getImageFileNames() {
  try { return stmt.allImgFiles.all().map((r) => r.data).filter((x) => x != null); } catch (_) { return []; }
}
function getDocIds() {
  try { return stmt.listDocsAll.all().map((r) => r.id); } catch (_) { return []; }
}

function getKV(key) { const r = stmt.getKV.get(key); return r ? r.value : null; }
function setKV(key, value) { stmt.insKV.run({ key, value: value == null ? '' : String(value) }); }
function getAllKV() {
  const rows = stmt.allKV.all();
  const out = {};
  rows.forEach((r) => { out[r.key] = r.value; });
  return out;
}
function setKVMulti(obj) {
  const run = db.transaction((o) => {
    Object.keys(o).forEach((k) => stmt.insKV.run({ key: k, value: o[k] == null ? '' : String(o[k]) }));
  });
  run(obj);
}

function clearAll() {
  const run = db.transaction(() => { TABLES.forEach((t) => { try { db.prepare('DELETE FROM ' + t).run(); } catch (_) {} }); });
  run();
}

// ---- M7（v1.0.8）：工作流运行历史 ----
function saveWorkflowRun(run) {
  const r = run || {};
  stmt.insWfRun.run({
    id: r.id || ('wr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    workflow_id: r.workflowId || null,
    workflow_name: String(r.workflowName || ''),
    status: String(r.status || 'running'),
    input_json: r.inputJson != null ? JSON.stringify(r.inputJson) : null,
    output_json: r.outputJson != null ? JSON.stringify(r.outputJson) : null,
    error: r.error != null ? String(r.error) : null,
    steps_json: r.steps ? JSON.stringify(r.steps) : null,
    started_at: Number(r.startedAt) || 0,
    finished_at: Number(r.finishedAt) || 0,
  });
  return true;
}

function listWorkflowRuns(workflowId, limit) {
  try {
    const rows = stmt.listWfRuns.all(workflowId || '', Math.min(Number(limit) || 20, 100));
    return rows.map((row) => {
      const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };
      return {
        id: row.id, workflowId: row.workflow_id, workflowName: row.workflow_name,
        status: row.status, inputJson: parse(row.input_json), outputJson: parse(row.output_json),
        error: row.error, steps: parse(row.steps_json),
        startedAt: row.started_at, finishedAt: row.finished_at,
      };
    });
  } catch (_) { return []; }
}

function transaction(fn) { return db.transaction(fn); }

// ---- v1.1.0（M1）：糖码 Agent Run 持久化 ----
const jp = (s) => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };

function createAgentRun(run) {
  const r = run || {};
  const id = r.id || ('ar_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  stmt.insRun.run({
    id,
    thread_id: String(r.threadId || ''), workspace_id: String(r.workspaceId || ''), cwd: String(r.cwd || ''),
    workspace_snapshot_json: r.workspaceSnapshot ? JSON.stringify(r.workspaceSnapshot) : null,
    workspace_fingerprint: String(r.workspaceFingerprint || ''), primary_root_id: String(r.primaryRootId || ''),
    user_goal: String(r.userGoal || ''), status: normalizeRunStatus(r.status), phase: String(r.phase || 'understanding'),
    model_id: String(r.modelId || ''), provider_ref: String(r.providerRef || ''),
    plan_mode: r.planMode ? 1 : 0,
    limits_json: r.limits ? JSON.stringify(r.limits) : null,
    usage_json: r.usage ? JSON.stringify(r.usage) : null,
    error: r.error != null ? String(r.error) : null,
    started_at: Number(r.startedAt) || Date.now(), finished_at: Number(r.finishedAt) || 0,
    working_state_id: String(r.workingStateId || ''), latest_checkpoint_id: String(r.latestCheckpointId || ''),
    created_at: Number(r.createdAt) || Number(r.startedAt) || Date.now(), // v2（补全 7）
    parent_run_id: String(r.parentRunId || ''), role: String(r.role || 'main'), depth: Number(r.depth) || 0,
    read_only: r.readOnly ? 1 : 0, budget_json: r.budget ? JSON.stringify(r.budget) : null,
    continued_from_run_id: String(r.continuedFromRunId || ''), root_run_id: String(r.rootRunId || id),
    continuation_index: Math.max(0, Number(r.continuationIndex) || 0), root_scope_json: r.rootScope ? JSON.stringify(r.rootScope) : null,
    prompt_version: String(r.promptVersion || 'legacy/unknown'),
    toolset_version: String(r.toolsetVersion || 'legacy/unknown'),
    runtime_version: String(r.runtimeVersion || 'legacy/unknown'),
  });
  return id;
}

function updateAgentRun(id, patch) {
  const p = patch || {};
  // B5（P2）：部分更新保留旧值——读取当前行，未提供的字段沿用，避免 phase/usage/error 被误重置
  let cur = null;
  try { cur = stmt.getRun.get(String(id || '')) || null; } catch (_) {}
  const currentStatus = cur ? normalizeRunStatus(cur.status) : '';
  const keep = (provided, fallback, dflt) => (provided != null ? provided : (fallback != null ? fallback : dflt));
  const requestedStatus = normalizeRunStatus(keep(p.status, cur && cur.status) || 'running');
  // A terminal run is immutable. This guard is paired with the SQL predicate
  // above so late async callbacks cannot turn cancelled/failed into completed.
  if (cur && TERMINAL_PHASES.includes(currentStatus) && requestedStatus !== currentStatus) return getAgentRun(id);
  const usage = p.usage != null ? p.usage : (cur && jp(cur.usage_json));
  const budget = p.budget != null ? p.budget : (cur && jp(cur.budget_json));
  stmt.updRun.run({
    id: String(id || ''),
    status: requestedStatus,
    phase: String(keep(p.phase, cur && cur.phase, 'understanding')),
    usage_json: usage != null ? JSON.stringify(usage) : null,
    error: keep(p.error, cur && cur.error) != null ? String(keep(p.error, cur && cur.error)) : null,
    finished_at: Number(keep(p.finishedAt, cur && cur.finished_at, 0)) || 0,
    prompt_version: p.promptVersion != null ? String(p.promptVersion) : null,
    toolset_version: p.toolsetVersion != null ? String(p.toolsetVersion) : null,
    runtime_version: p.runtimeVersion != null ? String(p.runtimeVersion) : null,
    budget_json: budget != null ? JSON.stringify(budget) : null,
    model_id: p.modelId != null ? String(p.modelId) : null,
    provider_ref: p.providerRef != null ? String(p.providerRef) : null,
  });
}

function listAgentRuns(threadId, limit, offset) {
  try {
    const pageSize = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const pageOffset = Math.max(Number(offset) || 0, 0);
    return stmt.listRuns.all(String(threadId || ''), pageSize, pageOffset).map((row) => {
      const run = {
        id: row.id, threadId: row.thread_id, workspaceId: row.workspace_id, cwd: row.cwd,
        workspaceSnapshot: jp(row.workspace_snapshot_json), workspaceFingerprint: row.workspace_fingerprint || '', primaryRootId: row.primary_root_id || '',
        userGoal: row.user_goal, status: normalizeRunStatus(row.status), phase: row.phase,
        modelId: row.model_id, providerRef: row.provider_ref, planMode: !!row.plan_mode,
        limits: jp(row.limits_json), usage: jp(row.usage_json), error: row.error,
        startedAt: row.started_at, finishedAt: row.finished_at,
        workingStateId: row.working_state_id, latestCheckpointId: row.latest_checkpoint_id, createdAt: row.created_at, // v2（补全 7）
        parentRunId: row.parent_run_id || '', role: row.role || 'main', depth: Number(row.depth) || 0, readOnly: !!row.read_only, budget: jp(row.budget_json),
        continuedFromRunId: row.continued_from_run_id || '', rootRunId: row.root_run_id || row.id,
        continuationIndex: Number(row.continuation_index) || 0, rootScope: jp(row.root_scope_json) || { mode: 'primary', rootId: '' },
        promptVersion: row.prompt_version || 'legacy/unknown', toolsetVersion: row.toolset_version || 'legacy/unknown', runtimeVersion: row.runtime_version || 'legacy/unknown',
      };
      // The history list receives the compact summary only. Events remain lazy,
      // while the v16 metrics side table makes cost/cache visible immediately.
      run.metrics = getAgentRunMetrics(run.id);
      return run;
    });
  } catch (_) { return []; }
}

function getAgentRun(id) {
  const row = stmt.getRun.get(String(id || ''));
  if (!row) return null;
  return {
    id: row.id, threadId: row.thread_id, workspaceId: row.workspace_id, cwd: row.cwd,
    workspaceSnapshot: jp(row.workspace_snapshot_json), workspaceFingerprint: row.workspace_fingerprint || '', primaryRootId: row.primary_root_id || '',
    userGoal: row.user_goal, status: normalizeRunStatus(row.status), phase: row.phase,
    modelId: row.model_id, providerRef: row.provider_ref, planMode: !!row.plan_mode,
    limits: jp(row.limits_json), usage: jp(row.usage_json), error: row.error,
    startedAt: row.started_at, finishedAt: row.finished_at,
    workingStateId: row.working_state_id, latestCheckpointId: row.latest_checkpoint_id, createdAt: row.created_at, // v2（补全 7）
    parentRunId: row.parent_run_id || '', role: row.role || 'main', depth: Number(row.depth) || 0, readOnly: !!row.read_only, budget: jp(row.budget_json),
    continuedFromRunId: row.continued_from_run_id || '', rootRunId: row.root_run_id || row.id,
    continuationIndex: Number(row.continuation_index) || 0, rootScope: jp(row.root_scope_json) || { mode: 'primary', rootId: '' },
    promptVersion: row.prompt_version || 'legacy/unknown', toolsetVersion: row.toolset_version || 'legacy/unknown', runtimeVersion: row.runtime_version || 'legacy/unknown',
  };
}

function listAgentRunTree(rootRunId) {
  try {
    const requested = String(rootRunId || '');
    const root = getAgentRun(requested);
    if (!root) return null;
    const actualRootId = root.rootRunId || root.id;
    const runs = stmt.listRunsByRoot.all(actualRootId, actualRootId).map((row) => getAgentRun(row.id)).filter(Boolean);
    const nodes = runs.map((run) => ({ run, events: listAgentEvents(run.id) }));
    return {
      rootRunId: actualRootId,
      root: nodes.find((node) => node.run.id === actualRootId) || null,
      children: nodes.filter((node) => node.run.id !== actualRootId),
    };
  } catch (_) { return null; }
}

function appendAgentEvent(runId, type, payload, seq) {
  const next = (seq != null) ? Number(seq) : ((stmt.maxEventSeq.get(String(runId || '')) || { m: 0 }).m + 1);
  stmt.insEvent.run({
    id: 'ev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    run_id: String(runId || ''), seq: next, type: String(type || ''),
    payload_json: payload != null ? JSON.stringify(payload) : null,
    created_at: Date.now(),
  });
  return next;
}

function listAgentEvents(runId) {
  try {
    return stmt.listEvents.all(String(runId || '')).map((row) => ({
      id: row.id, runId: row.run_id, seq: row.seq, type: row.type,
      payload: jp(row.payload_json), createdAt: row.created_at,
    }));
  } catch (_) { return []; }
}

// Keep trace corruption visible to the recovery center. Invalid payloads are
// reported instead of being silently discarded by the normal reader.
function auditAgentTrace() {
  if (!db) return { ok: false, orphanEvents: [], invalidEvents: [], duplicateSequences: [] };
  try {
    const runs = new Set(db.prepare('SELECT id FROM agent_runs').all().map((row) => String(row.id)));
    const rows = db.prepare('SELECT id,run_id,seq,payload_json FROM agent_run_events ORDER BY run_id,seq').all();
    const orphanEvents = [];
    const invalidEvents = [];
    const duplicateSequences = [];
    const seen = new Set();
    for (const row of rows) {
      const runId = String(row.run_id || '');
      if (!runs.has(runId)) orphanEvents.push({ id: row.id, runId, seq: row.seq });
      const sequenceKey = runId + ':' + String(row.seq);
      if (seen.has(sequenceKey)) duplicateSequences.push({ id: row.id, runId, seq: row.seq });
      seen.add(sequenceKey);
      if (row.payload_json != null) {
        try { JSON.parse(row.payload_json); } catch (_) { invalidEvents.push({ id: row.id, runId, seq: row.seq, payloadInvalid: true }); }
      }
    }
    return { ok: true, eventCount: rows.length, runCount: runs.size, orphanEvents, invalidEvents, duplicateSequences };
  } catch (error) {
    return { ok: false, orphanEvents: [], invalidEvents: [], duplicateSequences: [], error: error && error.message ? error.message : String(error) };
  }
}

function listAgentEventsPage(runId, options) {
  try {
    const page = tracePage(listAgentEvents(runId), options || {});
    return Object.assign({ runId: String(runId || '') }, page);
  } catch (_) {
    return { runId: String(runId || ''), items: [], nextCursor: null, hasMore: false, total: 0 };
  }
}

function listAgentTracePage(rootRunId, options) {
  try {
    const requested = String(rootRunId || '');
    const root = getAgentRun(requested);
    if (!root) return { rootRunId: requested, items: [], nextCursor: null, hasMore: false, total: 0 };
    const actualRootId = root.rootRunId || root.id;
    const opts = options && typeof options === 'object' ? options : {};
    const statuses = new Set((Array.isArray(opts.statuses) ? opts.statuses : []).map(String));
    const events = stmt.listTraceEvents.all(actualRootId, actualRootId).map((row) => ({
      id: row.id,
      runId: row.run_id,
      seq: row.seq,
      type: row.type,
      payload: jp(row.payload_json),
      createdAt: row.created_at,
      rootRunId: row.root_run_id || actualRootId,
      parentRunId: row.parent_run_id || '',
      role: row.role || 'main',
      depth: Number(row.depth) || 0,
      runStatus: normalizeRunStatus(row.run_status),
    })).filter((event) => !statuses.size || statuses.has(eventStatus(event)) || statuses.has(event.runStatus));
    const page = tracePage(events, Object.assign({}, opts, { sortBy: 'createdAt' }));
    return Object.assign({ rootRunId: actualRootId }, page);
  } catch (_) {
    return { rootRunId: String(rootRunId || ''), items: [], nextCursor: null, hasMore: false, total: 0 };
  }
}

function metricFromRow(row) {
  if (!row) return null;
  const telemetry = unpackTelemetry(jp(row.cache_json));
  return {
    runId: row.run_id,
    rootRunId: row.root_run_id || row.run_id,
    steps: Number(row.steps) || 0,
    toolCalls: Number(row.tool_calls) || 0,
    inputTokens: row.input_tokens == null ? null : Number(row.input_tokens),
    outputTokens: row.output_tokens == null ? null : Number(row.output_tokens),
    reasoningTokens: row.reasoning_tokens == null ? null : Number(row.reasoning_tokens),
    cache: telemetry.cache,
    cost: telemetry.cost,
    attribution: telemetry.attribution,
    costUsd: row.cost_usd == null ? (telemetry.cost && telemetry.cost.totalUsd) : Number(row.cost_usd),
    latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
    queueWaitMs: row.queue_wait_ms == null ? null : Number(row.queue_wait_ms),
    processMs: row.process_ms == null ? null : Number(row.process_ms),
    humanInterventions: Number(row.human_interventions) || 0,
    recoveryRate: row.recovery_rate == null ? null : Number(row.recovery_rate),
    errorBreakdown: jp(row.error_breakdown_json) || {},
    source: row.source || 'runtime',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function upsertAgentRunMetrics(metrics) {
  const m = metrics || {};
  const cache = m.cache ? mergeCacheMetrics([m.cache]) : (m.usage && m.usage.cache ? mergeCacheMetrics([m.usage.cache]) : null);
  const usage = m.usage || m;
  const cost = metricCost(m, usage, cache);
  const attribution = normalizeAttribution(m.attribution || {
    provider: m.provider,
    accountRef: m.accountRef,
    model: m.modelId || m.model,
    module: m.module || m.scope || 'agent',
    projectId: m.projectId,
    runId: m.runId,
    rootRunId: m.rootRunId || m.runId,
  });
  const metricNumber = (value) => {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const now = Date.now();
  stmt.upsertRunMetrics.run({
    run_id: String(m.runId || ''), root_run_id: String(m.rootRunId || m.runId || ''),
    steps: Number(m.steps) || 0, tool_calls: Number(m.toolCalls) || 0,
    input_tokens: metricNumber(m.inputTokens), output_tokens: metricNumber(m.outputTokens), reasoning_tokens: metricNumber(m.reasoningTokens),
    cache_json: packTelemetry(cache, cost, attribution) ? JSON.stringify(packTelemetry(cache, cost, attribution)) : null,
    cost_usd: cost.totalUsd, latency_ms: m.latencyMs == null ? null : Number(m.latencyMs),
    queue_wait_ms: m.queueWaitMs == null ? null : Number(m.queueWaitMs), process_ms: m.processMs == null ? null : Number(m.processMs),
    human_interventions: Number(m.humanInterventions) || 0, recovery_rate: m.recoveryRate == null ? null : Number(m.recoveryRate),
    error_breakdown_json: m.errorBreakdown ? JSON.stringify(m.errorBreakdown) : null, source: String(m.source || 'runtime'), created_at: Number(m.createdAt) || now, updated_at: now,
  });
  return getAgentRunMetrics(m.runId);
}

function getAgentRunMetrics(runId) {
  try {
    const direct = metricFromRow(stmt.getRunMetrics.get(String(runId || '')));
    if (direct) return direct;
    const run = getAgentRun(runId);
    if (!run) return null;
    const usage = run.usage || {};
    const normalized = normalizeModelUsage(usage);
    return {
      runId: run.id, rootRunId: run.rootRunId || run.id,
      steps: Number(usage.steps) || 0, toolCalls: Number(usage.toolCalls) || 0,
       inputTokens: normalized.inputTokens, outputTokens: normalized.outputTokens, reasoningTokens: normalized.reasoningTokens,
      cache: normalized.cache, cost: normalizeCost({ totalUsd: normalized.costUsd, source: normalized.costUsd == null ? 'unknown' : 'estimated', unknownReason: normalized.costUsd == null ? 'legacy_unknown' : 'legacy_estimate' }),
      attribution: normalizeAttribution({ provider: run.providerRef, model: run.modelId, module: 'agent', runId: run.id, rootRunId: run.rootRunId || run.id }), costUsd: normalized.costUsd,
      latencyMs: run.finishedAt && run.startedAt ? Math.max(0, run.finishedAt - run.startedAt) : null,
      queueWaitMs: null, processMs: null, humanInterventions: Number(usage.approvals) || 0,
      recoveryRate: null, errorBreakdown: run.error ? { legacy: 1 } : {}, source: 'legacy/unknown', createdAt: run.createdAt, updatedAt: run.finishedAt || run.startedAt,
    };
  } catch (_) { return null; }
}

function sumMetric(values) {
  const items = values.filter((value) => value != null && Number.isFinite(Number(value)));
  return items.length === values.length ? items.reduce((total, value) => total + Number(value), 0) : null;
}

function aggregateAgentRunMetrics(rootRunId) {
  try {
    const root = getAgentRun(rootRunId);
    if (!root) return null;
    const actualRootId = root.rootRunId || root.id;
    const runs = stmt.listRunsByRoot.all(actualRootId, actualRootId).map((row) => getAgentRun(row.id)).filter(Boolean);
    const metrics = runs.map((run) => getAgentRunMetrics(run.id)).filter(Boolean);
    const statusCounts = runs.reduce((out, run) => {
      const status = String(run.status || 'unknown');
      out[status] = (out[status] || 0) + 1;
      return out;
    }, {});
    const errors = {};
    metrics.forEach((metric) => Object.entries(metric.errorBreakdown || {}).forEach(([key, value]) => { errors[key] = (errors[key] || 0) + Number(value || 0); }));
    const rootLatency = root.startedAt && root.finishedAt && root.finishedAt >= root.startedAt ? root.finishedAt - root.startedAt : null;
    const cache = metrics.length ? mergeCacheMetrics(metrics.map((metric) => metric.cache || {})) : normalizeModelUsage({}).cache;
    return {
      runId: root.id,
      rootRunId: actualRootId,
      runCount: runs.length,
      statusCounts,
      steps: metrics.reduce((total, metric) => total + (Number(metric.steps) || 0), 0),
      toolCalls: metrics.reduce((total, metric) => total + (Number(metric.toolCalls) || 0), 0),
      inputTokens: sumMetric(metrics.map((metric) => metric.inputTokens)),
      outputTokens: sumMetric(metrics.map((metric) => metric.outputTokens)),
      reasoningTokens: sumMetric(metrics.map((metric) => metric.reasoningTokens)),
      cache,
      cost: mergeCosts(metrics.map((metric) => metric.cost || { totalUsd: metric.costUsd, source: metric.costUsd == null ? 'unknown' : 'estimated' })),
      costUsd: sumMetric(metrics.map((metric) => metric.costUsd)),
      unknownReasons: metrics.map((metric) => metric.cost && metric.cost.unknownReason).filter(Boolean),
      latencyMs: rootLatency,
      totalLatencyMs: sumMetric(metrics.map((metric) => metric.latencyMs)),
      queueWaitMs: sumMetric(metrics.map((metric) => metric.queueWaitMs)),
      processMs: sumMetric(metrics.map((metric) => metric.processMs)),
      humanInterventions: metrics.reduce((total, metric) => total + (Number(metric.humanInterventions) || 0), 0),
      recoveryRate: metrics.length ? metrics.reduce((total, metric) => total + (Number(metric.recoveryRate) || 0), 0) / metrics.length : null,
      errorBreakdown: errors,
      source: metrics.every((metric) => metric.source === 'runtime') ? 'runtime' : 'mixed',
      createdAt: root.createdAt,
      updatedAt: root.finishedAt || root.startedAt,
    };
  } catch (_) { return null; }
}

function recordModelCallMetric(metric) {
  const m = metric || {};
  const usage = normalizeModelUsage(m);
  const cost = metricCost(m, usage, usage.cache);
  const attribution = normalizeAttribution(m.attribution || {
    provider: m.provider || m.providerRef,
    accountRef: m.accountRef || m.ref,
    model: m.modelId || m.model,
    module: m.module || m.scope || 'agent',
    projectId: m.projectId,
    runId: m.runId,
    rootRunId: m.rootRunId || m.runId,
  });
  const id = String(m.id || 'mc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  stmt.insModelCallMetric.run({
    id, run_id: String(m.runId || ''), root_run_id: String(m.rootRunId || m.runId || ''), scope: String(m.scope || 'agent'), call_type: String(m.callType || 'chat'),
    model_id: String(m.modelId || ''), provider: String(m.provider || m.providerRef || ''), request_id: String(m.requestId || ''),
    input_tokens: usage.inputTokens == null ? null : usage.inputTokens, output_tokens: usage.outputTokens == null ? null : usage.outputTokens, reasoning_tokens: usage.reasoningTokens == null ? null : usage.reasoningTokens,
    cache_json: packTelemetry(usage.cache, cost, attribution) ? JSON.stringify(packTelemetry(usage.cache, cost, attribution)) : null, cost_usd: cost.totalUsd,
    latency_ms: m.latencyMs == null ? null : Number(m.latencyMs), queue_wait_ms: m.queueWaitMs == null ? null : Number(m.queueWaitMs),
    status: String(m.status || 'completed'), error_type: String(m.errorType || ''), started_at: Number(m.startedAt) || Date.now(), finished_at: Number(m.finishedAt) || Date.now(),
  });
  return id;
}

function listModelCallMetrics(runId) {
  try {
    return stmt.listModelCallMetrics.all(String(runId || '')).map((row) => {
      const telemetry = unpackTelemetry(jp(row.cache_json));
      return {
      id: row.id, runId: row.run_id, rootRunId: row.root_run_id, scope: row.scope, callType: row.call_type, modelId: row.model_id, provider: row.provider,
      requestId: row.request_id, inputTokens: row.input_tokens == null ? null : row.input_tokens, outputTokens: row.output_tokens == null ? null : row.output_tokens, reasoningTokens: row.reasoning_tokens == null ? null : row.reasoning_tokens,
      cache: telemetry.cache, cost: telemetry.cost, attribution: telemetry.attribution, costUsd: row.cost_usd == null ? (telemetry.cost && telemetry.cost.totalUsd) : row.cost_usd, latencyMs: row.latency_ms, queueWaitMs: row.queue_wait_ms, status: row.status, errorType: row.error_type,
      startedAt: row.started_at, finishedAt: row.finished_at,
      };
    });
  } catch (_) { return []; }
}

function listModelCallMetricsByRoot(rootRunId) {
  try {
    const root = getAgentRun(rootRunId);
    const actualRootId = root ? (root.rootRunId || root.id) : String(rootRunId || '');
    return stmt.listModelCallMetricsByRoot.all(actualRootId, actualRootId).map((row) => {
      const telemetry = unpackTelemetry(jp(row.cache_json));
      return {
      id: row.id, runId: row.run_id, rootRunId: row.root_run_id, scope: row.scope, callType: row.call_type, modelId: row.model_id, provider: row.provider,
      requestId: row.request_id, inputTokens: row.input_tokens == null ? null : row.input_tokens, outputTokens: row.output_tokens == null ? null : row.output_tokens, reasoningTokens: row.reasoning_tokens == null ? null : row.reasoning_tokens,
      cache: telemetry.cache, cost: telemetry.cost, attribution: telemetry.attribution, costUsd: row.cost_usd == null ? (telemetry.cost && telemetry.cost.totalUsd) : row.cost_usd, latencyMs: row.latency_ms, queueWaitMs: row.queue_wait_ms, status: row.status, errorType: row.error_type,
      startedAt: row.started_at, finishedAt: row.finished_at,
      };
    });
  } catch (_) { return []; }
}

function modelCallMetricFromRow(row) {
  const telemetry = unpackTelemetry(jp(row.cache_json));
  return {
    id: row.id, runId: row.run_id, rootRunId: row.root_run_id, scope: row.scope, callType: row.call_type,
    modelId: row.model_id, provider: row.provider, requestId: row.request_id,
    inputTokens: row.input_tokens == null ? null : row.input_tokens,
    outputTokens: row.output_tokens == null ? null : row.output_tokens,
    reasoningTokens: row.reasoning_tokens == null ? null : row.reasoning_tokens,
    cache: telemetry.cache, cost: telemetry.cost, attribution: telemetry.attribution,
    costUsd: row.cost_usd == null ? (telemetry.cost && telemetry.cost.totalUsd) : row.cost_usd,
    latencyMs: row.latency_ms == null ? null : row.latency_ms, queueWaitMs: row.queue_wait_ms == null ? null : row.queue_wait_ms,
    status: row.status, errorType: row.error_type, startedAt: row.started_at, finishedAt: row.finished_at,
  };
}

function listModelCallMetricsPage(options) {
  const opts = options || {};
  const where = [];
  const params = [];
  if (opts.scope) { where.push('scope = ?'); params.push(String(opts.scope)); }
  if (opts.provider) { where.push('provider = ?'); params.push(String(opts.provider)); }
  if (opts.callType) { where.push('call_type = ?'); params.push(String(opts.callType)); }
  if (opts.model) { where.push('model_id = ?'); params.push(String(opts.model)); }
  if (opts.runId) { where.push('(run_id = ? OR root_run_id = ?)'); params.push(String(opts.runId), String(opts.runId)); }
  if (opts.from != null) { where.push('started_at >= ?'); params.push(Number(opts.from) || 0); }
  if (opts.to != null) { where.push('started_at <= ?'); params.push(Number(opts.to) || Date.now()); }
  const jsonFilters = [];
  if (opts.accountRef) jsonFilters.push(['accountRef', String(opts.accountRef)]);
  if (opts.projectId) jsonFilters.push(['projectId', String(opts.projectId)]);
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 1000);
  const offset = Math.max(Number(opts.cursor) || 0, 0);
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  try {
    // JSON1 is bundled by most SQLite builds, but older user databases can be
    // opened by a build without it. Keep the metrics endpoint useful there.
    let jsonExtractAvailable = true;
    if (jsonFilters.length) {
      try { db.prepare("SELECT json_extract('{}', '$.attribution') AS value").get(); } catch (_) { jsonExtractAvailable = false; }
    }
    if (jsonFilters.length && !jsonExtractAvailable) {
      const allRows = db.prepare('SELECT * FROM model_call_metrics' + whereSql + ' ORDER BY started_at DESC, id DESC').all(...params);
      const filtered = allRows.filter((row) => {
        const attribution = unpackTelemetry(jp(row.cache_json)).attribution || {};
        return jsonFilters.every(([key, value]) => String(attribution[key] || '') === value);
      });
      const pageRows = filtered.slice(offset, offset + limit);
      return { items: pageRows.map(modelCallMetricFromRow), nextCursor: offset + pageRows.length < filtered.length ? String(offset + pageRows.length) : null, total: filtered.length, dataOrigin: 'sqlite-fallback' };
    }
    jsonFilters.forEach(([key, value]) => { where.push("json_extract(cache_json, '$.attribution." + key + "') = ?"); params.push(value); });
    const filteredWhereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = Number(db.prepare('SELECT COUNT(*) AS total FROM model_call_metrics' + filteredWhereSql).get(...params).total) || 0;
    const rows = db.prepare('SELECT * FROM model_call_metrics' + filteredWhereSql + ' ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?').all(...params, limit, offset);
    return { items: rows.map(modelCallMetricFromRow), nextCursor: offset + rows.length < total ? String(offset + rows.length) : null, total };
  } catch (error) {
    return { items: [], nextCursor: null, total: 0, error: error && error.message ? error.message : String(error) };
  }
}

function listModelCallMetricsFiltered(options) {
  const page = listModelCallMetricsPage(options);
  return page.items;
}

function searchLocal(query, options) {
  if (!db) return { ok: false, items: [], nextCursor: null, total: 0 };
  const text = String(query || '').trim().slice(0, 160);
  if (!text) return { ok: true, items: [], nextCursor: null, total: 0 };
  const opts = options && typeof options === 'object' ? options : {};
  const allowed = new Set(Array.isArray(opts.scopes) && opts.scopes.length ? opts.scopes.map(String) : ['conversation', 'document', 'run', 'workflow']);
  const limit = Math.min(Math.max(Number(opts.limit) || 30, 1), 100);
  const offset = Math.max(Number(opts.cursor) || 0, 0);
  const like = '%' + text.replace(/[\\%_]/g, '\\$&') + '%';
  const redact = (value) => String(value || '').replace(/(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{16,}|(?:api[_-]?key|authorization|bearer)\s*[:=]\s*)[^\s,;]+/gi, (match, prefix) => /^(?:sk-|AIza)/i.test(prefix) ? '[redacted]' : prefix + '[redacted]');
  const fragments = [];
  const params = [];
  const add = (scope, sql, values) => {
    if (!allowed.has(scope)) return;
    const scopeLiteral = "'" + String(scope).replace(/'/g, "''") + "'";
    fragments.push(sql.replace(/^SELECT /, 'SELECT ' + scopeLiteral + ' AS scope, '));
    params.push(...values);
  };
  try {
      add('conversation', `SELECT c.id,c.title,c.updated_at,
        CASE WHEN c.title LIKE ? ESCAPE '\\' THEN c.title ELSE COALESCE(m.content,'') END AS snippet,
        NULL AS thread_id, NULL AS project_id
        FROM conversations c LEFT JOIN messages m ON m.conv_id=c.id
        WHERE c.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\'
        GROUP BY c.id`, [like, like, like]);
      add('document', `SELECT id,name,created_at,
        CASE WHEN name LIKE ? ESCAPE '\\' THEN name ELSE COALESCE(text,'') END AS snippet,
        NULL AS thread_id, NULL AS project_id
        FROM docs WHERE name LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\'
        `, [like, like, like]);
      const runFilters = [];
      const runValues = [like, like, like];
      if (opts.projectId) { runFilters.push('(r.workspace_id = ? OR t.project_id = ?)'); runValues.push(String(opts.projectId), String(opts.projectId)); }
      if (opts.runId) { runFilters.push('(r.id = ? OR r.root_run_id = ?)'); runValues.push(String(opts.runId), String(opts.runId)); }
      const runFilterSql = runFilters.length ? ' AND ' + runFilters.join(' AND ') : '';
      add('run', `SELECT r.id,r.user_goal AS title,r.started_at AS updated_at,
        CASE WHEN r.user_goal LIKE ? ESCAPE '\\' THEN r.user_goal ELSE COALESCE(r.error,'') END AS snippet,
        r.thread_id AS thread_id, t.project_id AS project_id
        FROM agent_runs r LEFT JOIN agent_threads t ON t.id = r.thread_id
        WHERE (r.user_goal LIKE ? ESCAPE '\\' OR r.error LIKE ? ESCAPE '\\')${runFilterSql}
        `, runValues);
      add('workflow', `SELECT id,name,created_at,name AS snippet,
        NULL AS thread_id, NULL AS project_id
        FROM workflows WHERE name LIKE ? ESCAPE '\\' OR steps LIKE ? ESCAPE '\\'
        `, [like, like]);
    if (!fragments.length) return { ok: true, items: [], nextCursor: null, total: 0, unsupportedScopes: ['skill'] };
    const union = fragments.join(' UNION ALL ');
    const total = Number(db.prepare('SELECT COUNT(*) AS total FROM (' + union + ')').get(...params).total) || 0;
    const rows = db.prepare('SELECT * FROM (' + union + ') ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?').all(...params, limit, offset);
      const items = rows.map((row) => ({
        scope: String(row.scope || ''), id: String(row.id || ''), title: redact(row.title || row.name || ''),
        snippet: redact(String(row.snippet || '').slice(0, 240)), updatedAt: Number(row.updated_at || 0),
        threadId: row.thread_id == null ? '' : String(row.thread_id),
        projectId: row.project_id == null ? '' : String(row.project_id),
      }));
    return { ok: true, items, nextCursor: offset + items.length < total ? String(offset + items.length) : null, total };
  } catch (error) {
    return { ok: false, items: [], nextCursor: null, total: 0, error: error && error.message ? error.message : String(error) };
  }
}

function upsertWorkingState(runId, ws) {
  const w = ws || {};
  stmt.upsertWS.run({
    run_id: String(runId || ''), goal: String(w.goal || ''),
    constraints_json: w.constraints ? JSON.stringify(w.constraints) : null,
    plan_json: w.plan ? JSON.stringify(w.plan) : null,
    completed_json: w.completedWork ? JSON.stringify(w.completedWork) : null,
    pending_json: w.pendingWork ? JSON.stringify(w.pendingWork) : null,
    blocked_json: w.blockedWork ? JSON.stringify(w.blockedWork) : null,
    files_read_json: w.filesRead ? JSON.stringify(w.filesRead) : null,
    files_changed_json: w.filesChanged ? JSON.stringify(w.filesChanged) : null,
    commands_json: w.commandsRun ? JSON.stringify(w.commandsRun) : null,
    checks_json: w.checks ? JSON.stringify(w.checks) : null,
    decisions_json: w.decisions ? JSON.stringify(w.decisions) : null,
    unresolved_errors_json: w.unresolvedErrors ? JSON.stringify(w.unresolvedErrors) : null,
    verification_skips_json: w.verificationSkips ? JSON.stringify(w.verificationSkips) : null,
    pending_decisions_json: w.pendingDecisions ? JSON.stringify(w.pendingDecisions) : null,
    subagents_json: w.subagents ? JSON.stringify(w.subagents) : null,
    skill_context_json: Array.isArray(w.skillContext) && w.skillContext.length ? JSON.stringify(w.skillContext) : null,
    assumptions_json: w.assumptions ? JSON.stringify(w.assumptions) : null,
    user_confirmations_json: w.userConfirmations ? JSON.stringify(w.userConfirmations) : null,
    updated_at: Date.now(),
  });
}

function getWorkingState(runId) {
  const row = stmt.getWS.get(String(runId || ''));
  if (!row) return null;
  return {
    runId: row.run_id, goal: row.goal,
    constraints: jp(row.constraints_json), plan: jp(row.plan_json),
    completedWork: jp(row.completed_json), pendingWork: jp(row.pending_json), blockedWork: jp(row.blocked_json),
    filesRead: jp(row.files_read_json), filesChanged: jp(row.files_changed_json),
    commandsRun: jp(row.commands_json), checks: jp(row.checks_json),
    decisions: jp(row.decisions_json), unresolvedErrors: jp(row.unresolved_errors_json),
    verificationSkips: jp(row.verification_skips_json), pendingDecisions: jp(row.pending_decisions_json), subagents: jp(row.subagents_json),
    skillContext: jp(row.skill_context_json),
    assumptions: jp(row.assumptions_json), userConfirmations: jp(row.user_confirmations_json),
    updatedAt: row.updated_at,
  };
}

function saveAgentCheckpoint(runId, reason, state, eventsToSeq) {
  const seq = ((stmt.maxEventSeq.get(String(runId || '')) || { m: 0 }).m);
  stmt.insCheckpoint.run({
    id: 'ck_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    run_id: String(runId || ''), seq: Number(eventsToSeq) || seq,
    reason: String(reason || ''), state_json: state != null ? JSON.stringify(state) : null,
    events_to_seq: Number(eventsToSeq) || seq, created_at: Date.now(),
  });
  return true;
}

// v2（P0-A）：读取最近 Checkpoint（state_json 已解析）；无则 null
function getCheckpoint(runId) {
  const row = stmt.getCheckpoint.get(String(runId || ''));
  if (!row) return null;
  let state = null;
  try { state = row.state_json ? JSON.parse(row.state_json) : null; } catch (_) {}
  return { id: row.id, runId: row.run_id, seq: row.seq, reason: row.reason, state, eventsToSeq: row.events_to_seq, createdAt: row.created_at };
}

// v2（P0-A）：列出某 run 的 Checkpoint 摘要（恢复面板用）
function listCheckpoints(runId) {
  return stmt.listCheckpoints.all(String(runId || '')).map((r) => ({
    id: r.id, runId: r.run_id, seq: r.seq, reason: r.reason, createdAt: r.created_at,
  }));
}

function exportAgentRun(runId) {
  const run = getAgentRun(runId);
  if (!run) return null;
  const { exportRunJSONL } = require('../../core/agent-runtime/run-export');
  return exportRunJSONL({ run, events: listAgentEvents(runId), workingState: getWorkingState(runId), checkpoints: listCheckpoints(runId), summary: getLatestContextSummary(run.threadId), artifacts: [] });
}

function exportAgentTrace(input) {
  const opts = typeof input === 'string' ? { rootRunId: input } : (input || {});
  const rootRunId = String(opts.rootRunId || opts.runId || '');
  const run = getAgentRun(rootRunId);
  if (!run) return null;
  const tree = listAgentRunTree(rootRunId);
  const nodes = tree ? [tree.root].concat(tree.children || []).filter(Boolean) : [{ run, events: listAgentEvents(rootRunId) }];
  const events = nodes.flatMap((node) => (node.events || []).map((event) => Object.assign({}, event, { runId: node.run.id })));
  const metrics = getAgentRunMetrics(rootRunId);
  if (opts.redacted === false) {
    const { exportRunJSONL: exportRaw } = require('../../core/agent-runtime/run-export');
    return exportRaw({ run, events, workingState: getWorkingState(rootRunId), checkpoints: listCheckpoints(rootRunId), summary: getLatestContextSummary(run.threadId), artifacts: [], metrics });
  }
  return exportRedactedJSONL({ run: redactPayload(run), runs: nodes.map((node) => redactPayload(node.run)), events, workingState: getWorkingState(rootRunId), metrics: aggregateAgentRunMetrics(rootRunId) || metrics });
}

function saveContextSummary(s) {
  const x = s || {};
  stmt.insSummary.run({
    id: 'sum_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    run_id: String(x.runId || ''), thread_id: String(x.threadId || ''),
    covered_from_seq: Number(x.coveredFromSeq) || 0, covered_to_seq: Number(x.coveredToSeq) || 0,
    summary: String(x.summary || ''), version: Number(x.version) || 1,
    summary_json: x.summaryJson ? JSON.stringify(x.summaryJson) : null,
    source_hashes_json: x.sourceHashes ? JSON.stringify(x.sourceHashes) : null,
    validity: String(x.validity || 'valid'), created_at: Date.now(),
  });
  return true;
}

function getLatestContextSummary(threadId) {
  const row = stmt.latestSummary.get(String(threadId || ''));
  if (!row) return null;
  return {
    id: row.id, runId: row.run_id, threadId: row.thread_id,
    coveredFromSeq: row.covered_from_seq, coveredToSeq: row.covered_to_seq,
    summary: row.summary, version: row.version,
    summaryJson: jp(row.summary_json), sourceHashes: jp(row.source_hashes_json), validity: row.validity || 'valid',
    createdAt: row.created_at,
  };
}

// ---- v1.1.0（M3）：ChangeSet ----
function saveChangeset(cs) {
  const x = cs || {};
  const id = x.id || ('cs_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  stmt.insChangeset.run({
    id, run_id: String(x.runId || ''), root_id: String(x.rootId || ''), path: String(x.path || ''),
    old_hash: String(x.oldHash || ''), content_ref: String(x.contentRef || ''),
    operation: String(x.operation || 'write'), new_hash: String(x.newHash || ''), target_path: String(x.targetPath || ''), before_exists: x.beforeExists === false ? 0 : 1, status: String(x.status || 'committed'),
    created_at: Date.now(),
  });
  return id;
}

function listChangesets(runId) {
  try {
    return stmt.listChangesets.all(String(runId || '')).map((row) => ({
      id: row.id, runId: row.run_id, rootId: row.root_id || '', path: row.path, oldHash: row.old_hash,
      contentRef: row.content_ref, operation: row.operation || 'write', newHash: row.new_hash || '', targetPath: row.target_path || '', beforeExists: row.before_exists !== 0, status: row.status || 'committed',
      createdAt: row.created_at,
    }));
  } catch (_) { return []; }
}

const StorageService = {
  ready, close, init, dbPathInfo,
  upsertConversation, getConversation, listConversations, deleteConversation, touchConversation,
  replaceMessages, getMessages,
  upsertAccount, listAccounts, deleteAccount, setAccountModels,
  upsertProvider, getProviders,
  upsertAgent, listAgents, deleteAgent,
  upsertTemplate, listTemplates, deleteTemplate,
  upsertWorkflow, listWorkflows, deleteWorkflow,
  upsertImageHistory, addImageFile,
  upsertDoc, getDocText, deleteDoc,
  upsertProject, listProjects,
  upsertThread,
  getAccountModels, listImageHistory, listImageFiles, listDocs, listThreads,
  getImageFileNames, getDocIds, auditAgentTrace, checkIntegrity,
  saveWorkflowRun, listWorkflowRuns,
  getKV, setKV, getAllKV, setKVMulti,
  clearAll, transaction,
  // v1.1.0（M1）：Agent Run 持久化
  createAgentRun, updateAgentRun, listAgentRuns, getAgentRun, listAgentRunTree,
   appendAgentEvent, listAgentEvents, listAgentEventsPage, listAgentTracePage,
  upsertAgentRunMetrics, getAgentRunMetrics, aggregateAgentRunMetrics, recordModelCallMetric, listModelCallMetrics, listModelCallMetricsByRoot, listModelCallMetricsPage, listModelCallMetricsFiltered, searchLocal, exportAgentTrace,
  upsertWorkingState, getWorkingState,
  saveAgentCheckpoint, getCheckpoint, listCheckpoints, exportAgentRun, saveContextSummary, getLatestContextSummary,
  // v1.1.0（M3）：ChangeSet
  saveChangeset, listChangesets,
};

module.exports = { init, StorageService, ready, close, checkIntegrity, _imageHelpers: { stripDataUrl, sniffImageExt } };
