'use strict';

// 分层说明（v1.1.5）：本文件是糖馆持久化实现（infrastructure 层，依赖 fs）；
// 领域契约与预设角色卡在 src/core/tangguan/tangguan-store.js。同名是有意的分层设计。
const fs = require('fs');
const path = require('path');
const Core = require('../../core/tangguan/tangguan-store');
const EmbeddingIndex = require('./embedding-index');
const KeywordIndex = require('./keyword-index');
const { readJson } = require('../util/json');

const KV_KEY = 'tangguan:library:v1';

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const temp = filePath + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  try {
    const fd = fs.openSync(temp, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (_) {}
  fs.renameSync(temp, filePath);
}

function createStore(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const getKV = typeof opts.getKV === 'function' ? opts.getKV : null;
  const setKV = typeof opts.setKV === 'function' ? opts.setKV : null;
  const filePath = opts.filePath || '';
  const indexStore = EmbeddingIndex.createIndexStore(opts.indexPath || (filePath ? filePath + '.index.json' : ''));
  const keywordStore = KeywordIndex.createIndexStore(opts.keywordIndexPath || (filePath ? filePath + '.keyword.index.json' : ''));
  let cache = null;

  function empty() {
    return { version: Core.VERSION, revision: 0, characters: [], memories: [], matureMode: false, updatedAt: 0 };
  }

  function load() {
    if (cache) return cache;
    let value = null;
    try { value = getKV ? JSON.parse(getKV(KV_KEY) || 'null') : null; } catch (_) { value = null; }
    if (!value) value = readJson(filePath);
    const normalized = Core.normalizeEnvelope(value || {});
    normalized.revision = Number(value && value.revision) || 0;
    cache = { version: Core.VERSION, revision: normalized.revision, characters: normalized.characters, memories: normalized.memories, matureMode: value && value.matureMode === true, updatedAt: Number(value && value.updatedAt) || 0 };
    return cache;
  }

  function save(next) {
    const normalized = Core.normalizeEnvelope(next);
    const value = {
      version: Core.VERSION,
      revision: Number(next && next.revision) || 0,
      characters: normalized.characters,
      memories: normalized.memories,
      matureMode: next && next.matureMode === true,
      updatedAt: Date.now(),
    };
    let sqliteOk = false;
    if (setKV) {
      try { setKV(KV_KEY, JSON.stringify(value)); sqliteOk = true; } catch (_) { sqliteOk = false; }
    }
    let fileOk = false;
    try { if (filePath) { writeJsonAtomic(filePath, value); fileOk = true; } } catch (_) { fileOk = false; }
    if (!sqliteOk && !fileOk) throw new Error('tangguan_store_write_failed');
    cache = value;
    try { keywordStore.rebuild(value.memories); } catch (_) { /* keyword retrieval can fall back to a scan */ }
    return value;
  }

  function mutate(mutator, expectedRevision) {
    const current = load();
    if (expectedRevision != null && Number(expectedRevision) !== Number(current.revision)) {
      return { ok: false, code: 'tangguan_revision_conflict', revision: current.revision };
    }
    const next = { version: Core.VERSION, revision: current.revision + 1, characters: current.characters.slice(), memories: current.memories.slice(), matureMode: current.matureMode === true };
    mutator(next);
    try {
      const saved = save(next);
      return { ok: true, revision: saved.revision, characters: saved.characters, memories: saved.memories };
    } catch (error) {
      return { ok: false, code: 'tangguan_store_write_failed', error: error.message || String(error), revision: current.revision };
    }
  }

  return {
    load,
    listCharacters(input) {
      const opts = input && typeof input === 'object' ? input : {};
      const q = String(opts.query || '').trim().toLowerCase();
      const tag = String(opts.tag || '').trim().toLowerCase();
      const all = load().characters.filter((item) => {
        const hay = [item.name, item.description, ...(item.tags || [])].join(' ').toLowerCase();
        return (!q || hay.includes(q)) && (!tag || (item.tags || []).some((value) => value.toLowerCase() === tag));
      }).sort((a, b) => Number(b.favorite) - Number(a.favorite)
        || Number(b.lastUsedAt || 0) - Number(a.lastUsedAt || 0)
        || Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
      const cursor = Math.max(0, Number(opts.cursor) || 0);
      const limit = Math.min(50, Math.max(1, Number(opts.limit) || 20));
       const items = all.slice(cursor, cursor + limit).map((item) => opts.summary === true ? {
         id: item.id,
         name: item.name,
         tagline: item.tagline,
         description: item.description,
         avatar: item.avatar,
         tags: item.tags,
         favorite: item.favorite === true,
         archived: item.archived === true,
         usageCount: item.usageCount || 0,
         lastUsedAt: item.lastUsedAt || 0,
         createdAt: item.createdAt,
         updatedAt: item.updatedAt,
       } : item);
      return { ok: true, items, total: all.length, nextCursor: cursor + items.length < all.length ? String(cursor + items.length) : null, revision: load().revision };
    },
    getCharacter(id) {
      const state = load();
      const target = id && typeof id === 'object' ? id.id : id;
      const character = state.characters.find((item) => item.id === String(target || '')) || null;
      return { ok: !!character, character, memories: character ? state.memories.filter((item) => item.characterId === character.id) : [], revision: state.revision };
    },
    saveCharacter(character, expectedRevision) {
      const normalized = Core.normalizeCharacter(character);
      const current = load();
      const existingMemories = current.memories.filter((item) => item.characterId === normalized.id);
      if (Core.characterCardBytes(normalized, existingMemories) > Core.MAX_CARD_BYTES) {
        return { ok: false, code: 'tangguan_card_too_large', maxBytes: Core.MAX_CARD_BYTES };
      }
      return mutate((next) => {
        const index = next.characters.findIndex((item) => item.id === normalized.id);
        normalized.createdAt = index >= 0 ? next.characters[index].createdAt : normalized.createdAt;
        normalized.updatedAt = Date.now();
        if (index >= 0) next.characters[index] = normalized;
        else next.characters.unshift(normalized);
      }, expectedRevision);
    },
    toggleFavorite(id, favorite, expectedRevision) {
      const target = String(id || '');
      const current = load().characters.find((item) => item.id === target);
      if (!current) return { ok: false, code: 'tangguan_character_not_found' };
      const nextFavorite = favorite == null ? !current.favorite : favorite === true;
      return mutate((next) => {
        const item = next.characters.find((entry) => entry.id === target);
        if (item) {
          item.favorite = nextFavorite;
          item.updatedAt = Date.now();
        }
      }, expectedRevision);
    },
    touchCharacter(id, expectedRevision) {
      const target = String(id || '');
      const current = load().characters.find((item) => item.id === target);
      if (!current) return { ok: false, code: 'tangguan_character_not_found' };
      const now = Date.now();
      return mutate((next) => {
        const item = next.characters.find((entry) => entry.id === target);
        if (item) {
          item.usageCount = Math.max(0, Number(item.usageCount) || 0) + 1;
          item.lastUsedAt = now;
          item.updatedAt = now;
        }
      }, expectedRevision);
    },
    cloneCharacter(id, expectedRevision) {
      const target = String(id || '');
      const current = load();
      const source = current.characters.find((item) => item.id === target);
      if (!source) return { ok: false, code: 'tangguan_character_not_found' };
      const now = Date.now();
      const character = Core.normalizeCharacter(Object.assign({}, source, {
        id: Core.id('char'),
        name: (source.name || '未命名角色') + ' 副本',
        favorite: false,
        archived: false,
        usageCount: 0,
        lastUsedAt: 0,
        createdAt: now,
        updatedAt: now,
      }));
      const memories = current.memories
        .filter((item) => item.characterId === target)
        .map((item) => Core.normalizeMemory(Object.assign({}, item, {
          id: Core.id('memory'),
          characterId: character.id,
          createdAt: now,
          updatedAt: now,
        }), character.id));
      if (Core.characterCardBytes(character, memories) > Core.MAX_CARD_BYTES) {
        return { ok: false, code: 'tangguan_card_too_large', maxBytes: Core.MAX_CARD_BYTES };
      }
      const result = mutate((next) => {
        next.characters.unshift(character);
        next.memories.unshift(...memories);
      }, expectedRevision);
      return result.ok ? Object.assign(result, { characterId: character.id, character, memories }) : result;
    },
    deleteCharacter(id, expectedRevision) {
      const target = String(id || '');
      return mutate((next) => {
        next.characters = next.characters.filter((item) => item.id !== target);
        next.memories = next.memories.filter((item) => item.characterId !== target);
      }, expectedRevision);
    },
    importBundle(bundle, expectedRevision) {
      const imported = Core.importBundle(bundle);
      if (Core.characterCardBytes(imported.character, imported.memories) > Core.MAX_CARD_BYTES) {
        return { ok: false, code: 'tangguan_card_too_large', maxBytes: Core.MAX_CARD_BYTES };
      }
      // Imported cards always become a new local record. This prevents an
      // exported id from overwriting an existing card during a preview import.
      imported.character.id = Core.id('char');
      imported.character.createdAt = Date.now();
      imported.character.updatedAt = imported.character.createdAt;
      imported.memories = imported.memories.map((item) => Object.assign({}, item, {
        id: Core.id('memory'), characterId: imported.character.id,
      }));
      const result = mutate((next) => {
        const index = next.characters.findIndex((item) => item.id === imported.character.id);
        if (index >= 0) next.characters[index] = imported.character;
        else next.characters.unshift(imported.character);
        next.memories = next.memories.filter((item) => item.characterId !== imported.character.id);
        next.memories.unshift(...imported.memories);
      }, expectedRevision);
      return result.ok ? Object.assign(result, { characterId: imported.character.id }) : result;
    },
    importWorldbook(characterId, bundle, expectedRevision) {
      const target = String(characterId || '');
      const current = load();
      const character = current.characters.find((item) => item.id === target);
      if (!character) return { ok: false, code: 'tangguan_character_not_found' };
      const imported = Core.importWorldbook(bundle, target).map((item) => Object.assign({}, item, {
        id: Core.id('memory'),
        characterId: target,
      }));
      if (!imported.length) return { ok: false, code: 'tangguan_worldbook_empty', error: 'No valid worldbook entries found.' };
      const existing = current.memories.filter((item) => item.characterId === target);
      if (Core.characterCardBytes(character, existing.concat(imported)) > Core.MAX_CARD_BYTES) {
        return { ok: false, code: 'tangguan_card_too_large', maxBytes: Core.MAX_CARD_BYTES };
      }
      const result = mutate((next) => {
        next.memories.unshift(...imported);
      }, expectedRevision);
      return result.ok ? Object.assign(result, { characterId: target, importedCount: imported.length }) : result;
    },
    listMemory(characterId, input) {
      const opts = input && typeof input === 'object' ? input : {};
      const all = load().memories.filter((item) => item.characterId === String(characterId || '')).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
      const cursor = Math.max(0, Number(opts.cursor) || 0);
      const limit = Math.min(100, Math.max(1, Number(opts.limit) || 50));
      const items = all.slice(cursor, cursor + limit);
      return { ok: true, items, total: all.length, nextCursor: cursor + items.length < all.length ? String(cursor + items.length) : null, revision: load().revision };
    },
    saveMemory(characterId, memory, expectedRevision) {
      const normalized = Core.normalizeMemory(Object.assign({}, memory, { characterId }), characterId);
      return mutate((next) => {
        const index = next.memories.findIndex((item) => item.id === normalized.id && item.characterId === normalized.characterId);
        normalized.updatedAt = Date.now();
        if (index >= 0) { normalized.createdAt = next.memories[index].createdAt; next.memories[index] = normalized; }
        else next.memories.unshift(normalized);
      }, expectedRevision);
    },
    deleteMemory(characterId, memoryId, expectedRevision) {
      return mutate((next) => {
        next.memories = next.memories.filter((item) => !(item.characterId === String(characterId || '') && item.id === String(memoryId || '')));
      }, expectedRevision);
    },
    retrieveContext(characterId, query, options) {
      const state = load();
      const scoped = state.memories.filter((item) => item.characterId === String(characterId || ''));
      const opts = options && typeof options === 'object' ? Object.assign({}, options) : {};
      if (!opts.queryVector && String(query || '').trim()) {
        try {
          let loaded = keywordStore.load();
          const expected = keywordStore.fingerprint(state.memories);
          if (!loaded.ok || !loaded.index || loaded.index.fingerprint !== expected) {
            const rebuilt = keywordStore.rebuild(state.memories);
            loaded = rebuilt.ok ? { ok: true, index: rebuilt.index } : loaded;
          }
          if (loaded.ok && loaded.index) opts.keywordIds = keywordStore.query(loaded.index, characterId, Core.tokenize(query));
        } catch (_) { /* fall back to the bounded in-memory scan */ }
      }
      return Object.assign({ ok: true, revision: state.revision }, Core.retrieveMemories(scoped, query, opts));
    },
    getEmbeddingIndex(characterId, modelId) {
      const state = load();
      const memories = state.memories.filter((item) => item.characterId === String(characterId || ''));
      const loaded = indexStore.load();
      if (!loaded.ok || !loaded.index) return { ok: false, code: loaded.code || 'embedding_index_missing', stale: false, corrupted: !!loaded.corrupted };
      const index = loaded.index;
      if (String(index.characterId) !== String(characterId || '') || String(index.modelId || '') !== String(modelId || '')) {
        return { ok: false, code: 'embedding_index_stale', stale: true, fingerprint: index.fingerprint || '' };
      }
      const expected = indexStore.fingerprint(characterId, memories, modelId);
      if (expected !== index.fingerprint) return { ok: false, code: 'embedding_index_stale', stale: true, fingerprint: index.fingerprint || '', expectedFingerprint: expected };
      return { ok: true, modelId: index.modelId || '', fingerprint: index.fingerprint || '', vectors: index.entries || {}, source: index.source || 'provider' };
    },
    rebuildEmbeddingIndex(characterId, options) {
      const state = load();
      const opts = options && typeof options === 'object' ? options : {};
      const memories = state.memories.filter((item) => item.characterId === String(characterId || ''));
      return indexStore.rebuild({ characterId, memories, vectors: opts.vectors, modelId: opts.modelId, source: opts.source || 'provider' });
    },
    replaceEnvelope(envelope) {
      const next = Core.normalizeEnvelope(envelope);
      next.revision = load().revision + 1;
      next.matureMode = load().matureMode === true;
      try { const saved = save(next); return { ok: true, revision: saved.revision }; } catch (error) { return { ok: false, code: 'tangguan_store_write_failed', error: error.message || String(error) }; }
    },
    getMatureMode() { return load().matureMode === true; },
    setMatureMode(enabled, confirmed) {
      const current = load();
      if (confirmed !== true) {
        return { ok: false, code: 'tangguan_mature_confirmation_required', matureMode: current.matureMode === true };
      }
      try {
        const saved = save(Object.assign({}, current, { revision: current.revision + 1, matureMode: enabled === true }));
        return { ok: true, matureMode: saved.matureMode === true, revision: saved.revision };
      } catch (error) {
        return { ok: false, code: 'tangguan_mature_mode_write_failed', error: error.message || String(error), matureMode: current.matureMode === true };
      }
    },
    filePath,
    keywordIndexPath: keywordStore.path,
  };
}

module.exports = { KV_KEY, createStore };
