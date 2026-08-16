'use strict';

/*
 * Module conversation sidecars.
 *
 * These files intentionally live beside state.json under the active records
 * root. They are not part of the renderer state snapshot, so the ordinary
 * Chat/SQLite write-through path cannot accidentally re-mix module sessions.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { clone } = require('../../core/util/clone');

const FORMAT = 'tangbao-module-sessions';
const VERSION = 1;
const MODULES = new Set(['tangguan', 'create']);

function moduleName(value) {
  const name = String(value || '').trim();
  if (!MODULES.has(name)) throw Object.assign(new Error('unsupported_module'), { code: 'unsupported_module' });
  return name;
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.role !== 'user' && message.role !== 'assistant') return null;
  const next = Object.assign({}, message);
  if (next.content != null && typeof next.content !== 'string') next.content = String(next.content);
  if (next.think != null && typeof next.think !== 'string') next.think = String(next.think);
  return next;
}

function normalizeConversation(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '').trim();
  if (!id || id.length > 200) return null;
  const messages = Array.isArray(value.messages)
    ? value.messages.map(normalizeMessage).filter(Boolean)
    : [];
  const next = Object.assign({}, value, { id, messages });
  next.title = String(next.title || '新会话').slice(0, 200);
  next.updatedAt = Number(next.updatedAt) || Date.now();
  return next;
}

function normalizeEnvelope(module, value) {
  const name = moduleName(module);
  const source = value && typeof value === 'object' ? value : {};
  const conversations = [];
  const seen = new Set();
  for (const item of (Array.isArray(source.conversations) ? source.conversations : [])) {
    const conversation = normalizeConversation(item);
    if (!conversation || seen.has(conversation.id)) continue;
    seen.add(conversation.id);
    conversations.push(conversation);
  }
  const activeId = source.activeId && seen.has(String(source.activeId)) ? String(source.activeId) : null;
  return {
    format: FORMAT,
    version: VERSION,
    module: name,
    revision: Math.max(0, Number(source.revision) || 0),
    activeId,
    conversations,
    updatedAt: Number(source.updatedAt) || Date.now(),
  };
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createStore(options) {
  const opts = options || {};
  const root = path.resolve(String(opts.rootDir || ''));
  if (!root) throw new Error('module_session_root_missing');
  const dir = path.join(root, 'module-sessions');
  const markerFile = path.join(dir, 'migration.json');

  const fileFor = (module) => path.join(dir, moduleName(module) + '.json');

  const readJson = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  };

  const atomicWrite = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.tmp-' + process.pid + '-' + Date.now().toString(36);
    const text = JSON.stringify(value, null, 2);
    let fd = null;
    try {
      fd = fs.openSync(temp, 'w');
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(temp, file);
      if (fs.readFileSync(file, 'utf8') !== text) throw new Error('module_session_write_verify_failed');
    } catch (error) {
      try { if (fd !== null) fs.closeSync(fd); } catch (_) {}
      try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
      throw error;
    }
  };

  const marker = (value) => {
    try { return readJson(markerFile) || null; } catch (_) { return null; }
  };

  const writeMarker = (value) => {
    atomicWrite(markerFile, Object.assign({}, marker() || {}, value || {}, { updatedAt: new Date().toISOString() }));
  };

  const read = (module) => {
    const name = moduleName(module);
    const file = fileFor(name);
    let raw;
    try { raw = readJson(file); } catch (error) {
      return { ok: false, code: 'module_session_read_failed', module: name, path: file, error: error.message || String(error) };
    }
    if (raw == null) return { ok: true, module: name, path: file, exists: false, data: normalizeEnvelope(name, {}) };
    if (!raw || raw.format !== FORMAT || Number(raw.version) !== VERSION || raw.module !== name) {
      return { ok: false, code: 'module_session_invalid', module: name, path: file, error: 'invalid_module_session_envelope' };
    }
    return { ok: true, module: name, path: file, exists: true, data: normalizeEnvelope(name, raw) };
  };

  const write = (module, value) => {
    const name = moduleName(module);
    const next = normalizeEnvelope(name, value);
    next.revision = Math.max(0, next.revision || 0) + 1;
    next.updatedAt = Date.now();
    atomicWrite(fileFor(name), next);
    return { ok: true, module: name, path: fileFor(name), data: next };
  };

  const saveConversation = (module, conversation, activeId) => {
    const name = moduleName(module);
    const current = read(name);
    if (!current.ok) return current;
    const nextConversation = normalizeConversation(conversation);
    if (!nextConversation) return { ok: false, code: 'module_session_invalid_conversation' };
    const list = current.data.conversations.filter((item) => item.id !== nextConversation.id);
    list.unshift(nextConversation);
    return write(name, { conversations: list, activeId: activeId || current.data.activeId, revision: current.data.revision });
  };

  const removeConversation = (module, id) => {
    const name = moduleName(module);
    const current = read(name);
    if (!current.ok) return current;
    const target = String(id || '');
    const list = current.data.conversations.filter((item) => item.id !== target);
    const activeId = current.data.activeId === target ? (list[0] && list[0].id) || null : current.data.activeId;
    return write(name, { conversations: list, activeId, revision: current.data.revision });
  };

  const flushPartial = (input) => {
    const opts = input && typeof input === 'object' ? input : {};
    const name = moduleName(opts.module);
    const current = read(name);
    if (!current.ok) return current;
    const targetId = String(opts.conversationId || '');
    const source = current.data.conversations.find((item) => item.id === targetId);
    if (!source) return { ok: false, code: 'module_session_not_found', module: name };
    const message = normalizeMessage(opts.message);
    if (!message) return { ok: false, code: 'module_session_partial_invalid', module: name };
    const conversation = clone(source);
    const index = conversation.messages.findIndex((item) => item && item.id && item.id === message.id);
    if (index >= 0) conversation.messages[index] = Object.assign({}, conversation.messages[index], message);
    else conversation.messages.push(message);
    conversation.updatedAt = Number(opts.conversationUpdatedAt) || Date.now();
    const result = saveConversation(name, conversation, targetId);
    if (result.ok) result.partial = true;
    return result;
  };

  const migrateLegacy = (state) => {
    const source = state && typeof state === 'object' ? state : {};
    const legacy = Array.isArray(source.conversations) ? source.conversations : [];
    const groups = {
      tangguan: legacy.filter((item) => item && (item.tangguanCharacterId || item.originModule === 'tangguan')),
      create: legacy.filter((item) => item && item.originModule === 'create'),
    };
    if (!groups.tangguan.length && !groups.create.length) {
      return { ok: true, migrated: false, state: source, sessions: {} };
    }
    const existing = {};
    for (const name of ['tangguan', 'create']) {
      const result = read(name);
      if (!result.ok) return result;
      existing[name] = result;
    }
    const oldMarker = marker();
    const sourceHash = digest(legacy);
    if (oldMarker && oldMarker.sourceHash === sourceHash && oldMarker.status === 'verified') {
      const clean = Object.assign({}, source, { conversations: legacy.filter((item) => !item || (!item.tangguanCharacterId && item.originModule !== 'tangguan' && item.originModule !== 'create')) });
      return { ok: true, migrated: true, resumed: true, state: clean, sessions: { tangguan: existing.tangguan.data, create: existing.create.data } };
    }
    const migrationId = 'module_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
    const created = [];
    try {
      writeMarker({ migrationId, status: 'copying', sourceHash, counts: { tangguan: groups.tangguan.length, create: groups.create.length } });
      const sessions = {};
      for (const name of ['tangguan', 'create']) {
        const current = existing[name].data;
        const byId = new Map(current.conversations.map((item) => [item.id, item]));
        for (const item of groups[name]) {
          const normalized = normalizeConversation(item);
          if (!normalized) continue;
          const previous = byId.get(normalized.id);
          if (!previous || Number(normalized.updatedAt) >= Number(previous.updatedAt)) byId.set(normalized.id, normalized);
        }
        const result = write(name, { conversations: Array.from(byId.values()), activeId: current.activeId || (groups[name][0] && groups[name][0].id) || null });
        sessions[name] = result.data;
        if (!existing[name].exists) created.push(fileFor(name));
      }
      for (const name of ['tangguan', 'create']) {
        const check = read(name);
        if (!check.ok || !check.data || check.data.module !== name) throw new Error('module_session_verify_failed');
      }
      const clean = Object.assign({}, source, {
        conversations: legacy.filter((item) => !item || (!item.tangguanCharacterId && item.originModule !== 'tangguan' && item.originModule !== 'create')),
      });
      writeMarker({ migrationId, status: 'verified', sourceHash, stateHash: digest(clean) });
      return { ok: true, migrated: true, migrationId, state: clean, sessions };
    } catch (error) {
      for (const file of created) { try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {} }
      try { writeMarker({ migrationId, status: 'failed', sourceHash, error: error.message || String(error) }); } catch (_) {}
      return { ok: false, code: 'module_session_migration_failed', migrationId, sourcePreserved: true, error: error.message || String(error) };
    }
  };

  const info = () => {
    const modules = {};
    for (const name of ['tangguan', 'create']) {
      const file = fileFor(name);
      let stat = null;
      try { stat = fs.statSync(file); } catch (_) {}
      modules[name] = { path: file, exists: !!stat, bytes: stat && stat.isFile() ? stat.size : 0, status: read(name).ok ? 'ready' : 'invalid' };
    }
    return { dir, marker: marker(), modules };
  };

  return { dir, fileFor, read, write, saveConversation, removeConversation, flushPartial, migrateLegacy, info, marker };
}

module.exports = { FORMAT, VERSION, MODULES: Array.from(MODULES), createStore };
