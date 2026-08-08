'use strict';
/*
 * 糖包 一次性迁移器（M3）
 *
 * 把归一化后的 App.state（由渲染进程 loadState 后传入）整库灌入 SQLite。
 * 设计要点：
 *  - 只读备份：先原样拷贝磁盘 state.json 到 state.v1.backup.json，绝不改写/删除源。
 *  - 幂等：kv_meta['migrated_v1'] 置位后不再运行。
 *  - 失败保护：整批在事务内执行；任何一步异常 → 事务回滚、标志不置位、App 继续走 state.json，不丢数据。
 *
 * 本迁移器不负责「读回」——读回与数据源切换是 M4 的事。M3 只负责把数据准备好。
 */
const fs = require('fs');
const path = require('path');

const MIGRATED_FLAG = 'migrated_v1';

/** 把原始 state.json 原样备份（只读，不删除源） */
function backupRaw(stateDir, rawJson) {
  const bak = path.join(stateDir, 'state.v1.backup.json');
  fs.writeFileSync(bak, rawJson || '{}', 'utf8');
  return bak;
}

/** 把归一化 state 灌入已初始化的 StorageService */
function insertState(storage, fileRepo, state) {
  const s = state || {};
  const settings = s.settings || {};

  // ---- kv_meta：标量 + JSON 字段 ----
  const kv = {
    theme: s.theme,
    view: s.view,
    activeId: s.activeId,
    activeThreadId: s.activeThreadId,
    activeProjectId: s.activeProjectId,
    thinkLevel: s.thinkLevel,
    web: s.web,
    agentProjectsCollapsed: s.agentProjectsCollapsed,
    agentSessionsCollapsed: s.agentSessionsCollapsed,
    defaultAccountId: settings.defaultAccountId,
    userMemory: settings.userMemory,
    contextWindow: settings.contextWindow,
    visionModels: JSON.stringify(settings.visionModels || []),
    enabledModules: JSON.stringify(settings.enabledModules || []),
    customModules: JSON.stringify(settings.customModules || []),
    prompts: JSON.stringify(settings.prompts || {}),
    appearance: JSON.stringify(settings.appearance || {}),
    profile: JSON.stringify(settings.profile || {}),
    agentUsage: JSON.stringify(settings.agentUsage || {}),
    search: JSON.stringify(settings.search || {}),
  };
  storage.setKVMulti(kv);

  // ---- 账户 + 模型 ----
  (settings.accounts || []).forEach((a) => {
    if (!a || !a.id) return;
    storage.upsertAccount(a);
    storage.setAccountModels(a.id, a.models || []);
  });

  // ---- provider ----
  Object.keys(settings.providers || {}).forEach((mod) => {
    storage.upsertProvider(mod, settings.providers[mod] || {});
  });

  // ---- 智能体 / 模板 / 工作流 ----
  (settings.agents || []).forEach((a) => a && a.id && storage.upsertAgent(a));
  (settings.templates || []).forEach((t) => t && t.id && storage.upsertTemplate(t));
  (settings.workflows || []).forEach((w) => w && w.id && storage.upsertWorkflow(w));

  // ---- 图片历史 + 图片文件（base64 落 image_files 表） ----
  (settings.imageHistory || []).forEach((it) => {
    if (!it || !it.id) return;
    storage.upsertImageHistory(it);
    const imgs = Array.isArray(it.images) ? it.images : [];
    imgs.forEach((b64, seq) => storage.addImageFile(it.id, seq, b64));
  });

  // ---- 文档（文本同时落文件仓 documents/<id>.txt） ----
  (settings.docs || []).forEach((d) => {
    if (!d || !d.id) return;
    storage.upsertDoc(d);
  });

  // ---- 糖码项目 ----
  (s.projects || []).forEach((p) => p && p.id && storage.upsertProject(p));

  // ---- 糖码会话线程 ----
  (s.agentThreads || []).forEach((t) => t && t.id && storage.upsertThread(t));

  // ---- 对话 + 消息 ----
  (s.conversations || []).forEach((c) => {
    if (!c || !c.id) return;
    storage.upsertConversation(c);
    storage.replaceMessages(c.id, c.messages || []);
  });
}

/**
 * 执行迁移。
 * @param storage  已 init 的 StorageService
 * @param fileRepo 文件仓实例（可为 null）
 * @param opts     { state: 归一化对象, rawJson: 磁盘 state.json 原文, stateDir: 数据目录 }
 */
function run(storage, fileRepo, opts) {
  const o = opts || {};
  if (!storage || !storage.ready || !storage.ready()) return { ok: false, reason: 'no-storage' };
  if (storage.getKV(MIGRATED_FLAG)) return { ok: true, skipped: true };

  const stateDir = o.stateDir || '';
  const backupPath = backupRaw(stateDir, o.rawJson);

  let result = { ok: true, backup: backupPath };
  const tx = storage.transaction(() => {
    storage.clearAll();
    insertState(storage, fileRepo, o.state);
    storage.setKV(MIGRATED_FLAG, '1');
  });
  try {
    tx();
  } catch (e) {
    result = { ok: false, reason: 'tx-failed', error: e && e.message ? e.message : String(e), backup: backupPath };
  }
  return result;
}

/**
 * M4 写穿：把当前 App.state 整库替换进 SQLite（主数据源）。
 * 与 run() 的区别：无 migrated_v1 门槛，每次 persist 都执行；事务内 clearAll + 全量 upsert，
 * 天然幂等。同时写 kv_meta['synced_at'] = now，供 storage:loadState 做新鲜度判断。
 */
function syncState(storage, fileRepo, state) {
  if (!storage || !storage.ready || !storage.ready()) return { ok: false, reason: 'no-storage' };
  try {
    const tx = storage.transaction(() => {
      storage.clearAll();
      insertState(storage, fileRepo, state || {});
      storage.setKV('synced_at', String(Date.now()));
    });
    tx();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'sync-failed', error: e && e.message ? e.message : String(e) };
  }
}

/** M4 读源：从 SQLite 重建 App.state。空库 / DB 不存在 → { ok:false, reason:'empty' } */
function readState(storage, fileRepo) {
  if (!storage || !storage.ready || !storage.ready()) return { ok: false, reason: 'no-storage' };
  try {
    const kv = storage.getAllKV() || {};
    const convs = storage.listConversations(100000);
    if (!convs.length && Object.keys(kv).length === 0) return { ok: false, reason: 'empty' };

    const pick = (k) => (k in kv ? kv[k] : undefined);
    const parse = (v) => { try { return v == null ? null : JSON.parse(v); } catch (_) { return null; } };
    const str = (v) => (v == null ? '' : String(v));
    const num = (v) => { const n = Number(v); return isNaN(n) ? 0 : n; };

    const s = {};
    s.theme = pick('theme');
    s.view = pick('view');
    s.activeId = pick('activeId');
    s.activeThreadId = pick('activeThreadId');
    s.activeProjectId = pick('activeProjectId');
    s.thinkLevel = pick('thinkLevel');
    const web = pick('web');
    s.web = (web === 'true' || web === true);
    s.agentProjectsCollapsed = (pick('agentProjectsCollapsed') === 'true');
    s.agentSessionsCollapsed = (pick('agentSessionsCollapsed') === 'true');

    const settings = {};
    settings.defaultAccountId = str(pick('defaultAccountId'));
    settings.userMemory = str(pick('userMemory'));
    settings.contextWindow = num(pick('contextWindow')) || 128000;
    settings.visionModels = parse(pick('visionModels')) || [];
    settings.enabledModules = parse(pick('enabledModules')) || [];
    settings.customModules = parse(pick('customModules')) || [];
    settings.prompts = parse(pick('prompts')) || {};
    settings.appearance = parse(pick('appearance')) || {};
    settings.profile = parse(pick('profile')) || {};
    settings.agentUsage = parse(pick('agentUsage')) || {};
    settings.search = parse(pick('search')) || {};
    settings.agentCwd = '';

    settings.accounts = storage.listAccounts().map((r) => ({
      id: r.id, name: r.name, apiBase: r.api_base,
      models: storage.getAccountModels(r.id).map((m) => {
        const mm = { name: m.name, contextWindow: num(m.context_window) || 128000 };
        if (m.caps) mm.caps = m.caps; // M6：声明式能力预设（'auto'|'tool_vision'|'tool'|'vision'|'text'）
        // 聊天修复 D：maxOutput/thinkType 往返（v1.1.0 加列后回读）
        if (m.max_output) mm.maxOutput = num(m.max_output);
        if (m.think_type) mm.thinkType = m.think_type;
        return mm;
      }),
    }));
    settings.providers = storage.getProviders() || {};
    settings.agents = storage.listAgents().map((r) => ({
      id: r.id, name: r.name, description: r.description, systemPrompt: r.system_prompt,
      icon: r.icon, category: r.category, createdAt: r.created_at,
    }));
    settings.templates = storage.listTemplates().map((r) => ({
      id: r.id, title: r.title, category: r.category, prompt: r.prompt, icon: r.icon, createdAt: r.created_at,
    }));
    settings.workflows = storage.listWorkflows().map((r) => ({
      id: r.id, name: r.name, steps: parse(r.steps) || [], createdAt: r.created_at,
    }));
    settings.imageHistory = storage.listImageHistory().map((r) => ({
      id: r.id, prompt: r.prompt, style: r.style, size: r.size, n: num(r.n),
      createdAt: r.created_at,
      images: storage.listImageFiles(r.id).map((f) => {
        // M6：DB 存文件名 → 从文件仓回读 base64；旧数据直接存 base64 时原样返回
        if (f.data && fileRepo && fileRepo.has && fileRepo.has('images', f.data)) {
          const buf = fileRepo.get('images', f.data);
          if (buf) return buf.toString('base64');
        }
        return f.data;
      }).filter((x) => x != null),
    }));
    settings.docs = storage.listDocs().map((r) => ({
      id: r.id, name: r.name, text: r.text || '', size: num(r.size), createdAt: r.created_at,
    }));
    s.settings = settings;

    s.projects = storage.listProjects().map((r) => ({
      id: r.id, name: r.name, cwd: r.cwd, workspaceId: r.workspace_id,
      roots: parse(r.roots_json) || [], primaryRootId: r.primary_root_id || '', auto: !!r.auto,
      approveTools: parse(r.approve_tools) || [], cmdWhitelist: parse(r.cmd_whitelist) || [],
      planMode: !!r.plan_mode, createdAt: r.created_at, lastUsedAt: r.last_used_at,
    }));
    s.agentThreads = storage.listThreads().map((r) => ({
      id: r.id, projectId: r.project_id, title: r.title, updatedAt: r.updated_at,
      history: parse(r.history) || [],
      draftText: r.draft_text || '',
      draftSkills: parse(r.draft_skills) || [],
      draftRootScope: parse(r.draft_root_scope_json) || { mode: 'primary', rootId: '' },
    }));

    s.conversations = convs.map((r) => ({
      id: r.id, title: r.title, agentId: r.agent_id, systemPrompt: r.system_prompt,
      createdAt: r.created_at, updatedAt: r.updated_at,
      messages: storage.getMessages(r.id).map((m) => {
        const mm = { id: m.id, role: m.role, content: m.content };
        const meta = parse(m.meta);
        if (meta && typeof meta === 'object') {
          if (meta.reasoning !== undefined) mm.reasoning = meta.reasoning;
          for (const k of Object.keys(meta)) {
            if (k !== 'reasoning') mm[k] = meta[k];
          }
        }
        return mm;
      }),
    }));

    return { ok: true, state: s };
  } catch (e) {
    return { ok: false, reason: 'read-failed', error: e && e.message ? e.message : String(e) };
  }
}

/**
 * M6：轮转只读备份。canonical = state.v1.backup.json；若已存在则先改名带时间戳保留，
 * 并清理超龄备份（保留最近 keep 份，不含 canonical），再写回 canonical。
 * 幂等调用方（storage:syncState 每个启动周期只调一次）。
 */
function rotateBackup(stateDir, rawJson, keep) {
  const dir = stateDir;
  if (!dir) return null;
  const keepN = (typeof keep === 'number' && keep > 0) ? keep : 3;
  try {
    const canon = path.join(dir, 'state.v1.backup.json');
    if (fs.existsSync(canon)) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      try { fs.renameSync(canon, path.join(dir, 'state.v1.backup.' + ts + '.json')); } catch (_) {}
      try {
        const list = fs.readdirSync(dir)
          .filter((n) => /^state\.v1\.backup\..+\.json$/.test(n))
          .sort();
        while (list.length > keepN) fs.unlinkSync(path.join(dir, list.shift()));
      } catch (_) {}
    }
    fs.writeFileSync(canon, rawJson || '{}', 'utf8');
    return canon;
  } catch (e) { return null; }
}

module.exports = { run, syncState, readState, rotateBackup, MIGRATED_FLAG };
