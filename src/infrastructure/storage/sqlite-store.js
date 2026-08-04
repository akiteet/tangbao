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

const { DDL, TABLES, SCHEMA_VERSION, MIGRATIONS } = require('../../core/schemas/db-schema');

let db = null;
let fileRepo = null;
const stmt = {};

const j = (v) => (v === undefined ? null : JSON.stringify(v));
const u = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch (_) { return null; } };

/** 打开并初始化数据库。成功返回 true，原生模块不可用返回 false。 */
function init(dbPath, fileRepoInstance) {
  if (db) return true;
  if (!Database) return false;
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // M6：版本化迁移 —— 按 PRAGMA user_version 顺序执行 MIGRATIONS[cur..]，每步在事务内提交
  let cur = 0;
  try { cur = Number(db.pragma('user_version', { simple: true })) || 0; } catch (_) {}
  for (let i = cur; i < SCHEMA_VERSION; i++) {
    const m = MIGRATIONS[i];
    if (!m) break;
    db.transaction(() => { m(db); db.pragma('user_version = ' + (i + 1)); })();
  }
  fileRepo = fileRepoInstance || null;
  prepare();
  return true;
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
    `INSERT INTO account_models (account_id,name,context_window,caps) VALUES (@account_id,@name,@context_window,@caps)
     ON CONFLICT(account_id,name) DO UPDATE SET context_window=@context_window, caps=@caps`);

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
    `INSERT INTO projects (id,name,cwd,workspace_id,auto,approve_tools,cmd_whitelist,plan_mode,created_at,last_used_at)
     VALUES (@id,@name,@cwd,@workspace_id,@auto,@approve_tools,@cmd_whitelist,@plan_mode,@created_at,@last_used_at)
     ON CONFLICT(id) DO UPDATE SET name=@name, cwd=@cwd, workspace_id=@workspace_id, auto=@auto,
       approve_tools=@approve_tools, cmd_whitelist=@cmd_whitelist, plan_mode=@plan_mode, last_used_at=@last_used_at`);
  stmt.listProj = db.prepare('SELECT * FROM projects ORDER BY created_at ASC');

  stmt.insThread = db.prepare(
    `INSERT INTO agent_threads (id,project_id,title,updated_at,history)
     VALUES (@id,@project_id,@title,@updated_at,@history)
     ON CONFLICT(id) DO UPDATE SET project_id=@project_id, title=@title, updated_at=@updated_at, history=@history`);

  stmt.getKV = db.prepare('SELECT value FROM kv_meta WHERE key=?');
  stmt.insKV = db.prepare(
    `INSERT INTO kv_meta (key,value) VALUES (@key,@value)
     ON CONFLICT(key) DO UPDATE SET value=@value`);
  stmt.allKV = db.prepare('SELECT key,value FROM kv_meta');

  // ---- M4 读源：readState 用 ----
  stmt.getAccModels = db.prepare('SELECT name, context_window FROM account_models WHERE account_id=? ORDER BY name ASC');
  stmt.listImgHist = db.prepare('SELECT * FROM image_history ORDER BY created_at DESC');
  stmt.listImgFiles = db.prepare('SELECT * FROM image_files WHERE history_id=? ORDER BY seq ASC');
  stmt.allImgFiles = db.prepare('SELECT data FROM image_files');
  stmt.listDocsAll = db.prepare('SELECT * FROM docs ORDER BY created_at DESC');
  stmt.listThreadsAll = db.prepare('SELECT * FROM agent_threads ORDER BY updated_at DESC');

  // ---- M7（v1.0.8）：工作流运行历史（独立表，不随 App.state 写穿） ----
  stmt.insWfRun = db.prepare(
    `INSERT INTO workflow_runs (id,workflow_id,workflow_name,status,input_json,output_json,error,steps_json,started_at,finished_at)
     VALUES (@id,@workflow_id,@workflow_name,@status,@input_json,@output_json,@error,@steps_json,@started_at,@finished_at)
     ON CONFLICT(id) DO UPDATE SET workflow_id=@workflow_id, workflow_name=@workflow_name, status=@status,
       input_json=@input_json, output_json=@output_json, error=@error, steps_json=@steps_json,
       started_at=@started_at, finished_at=@finished_at`);
  stmt.listWfRuns = db.prepare('SELECT * FROM workflow_runs WHERE workflow_id=? ORDER BY started_at DESC LIMIT ?');
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
      const meta = m.meta ? j(m.meta) : (m.reasoning !== undefined ? j({ reasoning: m.reasoning }) : null);
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
      const caps = (typeof m === 'object' && m.caps) ? String(m.caps) : null;
      stmt.insAccModel.run({ account_id: accId, name, context_window: cw || 128000, caps });
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

function upsertProject(p) {
  stmt.insProj.run({
    id: p.id, name: p.name || '', cwd: p.cwd || '', workspace_id: p.workspaceId || '',
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
  upsertDoc, getDocText,
  upsertProject, listProjects,
  upsertThread,
  getAccountModels, listImageHistory, listImageFiles, listDocs, listThreads,
  getImageFileNames, getDocIds, checkIntegrity,
  saveWorkflowRun, listWorkflowRuns,
  getKV, setKV, getAllKV, setKVMulti,
  clearAll, transaction,
};

module.exports = { init, StorageService, ready, close, checkIntegrity, _imageHelpers: { stripDataUrl, sniffImageExt } };
