'use strict';

const fs = require('fs');
const path = require('path');
const Core = require('../../core/tangguan/tangguan-store');

const VERSION = 1;

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = filePath + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value), 'utf8');
  fs.renameSync(temp, filePath);
}

function fingerprint(characterId, memories, modelId) {
  return Core.stableHash(JSON.stringify({
    characterId: String(characterId || ''),
    modelId: String(modelId || ''),
    memories: (Array.isArray(memories) ? memories : [])
      .filter((item) => item && item.enabled !== false)
      .map((item) => [item.id, item.updatedAt, item.content.length])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  }));
}

function createIndexStore(filePath) {
  const target = String(filePath || '');

  function load() {
    if (!target || !fs.existsSync(target)) return { ok: true, index: null, corrupted: false };
    const parsed = readJson(target);
    if (!parsed || parsed.version !== VERSION || typeof parsed.entries !== 'object') {
      try { fs.unlinkSync(target); } catch (_) {}
      return { ok: false, index: null, corrupted: true, code: 'embedding_index_corrupt' };
    }
    return { ok: true, index: parsed, corrupted: false };
  }

  function rebuild(input) {
    const opts = input || {};
    const memories = Array.isArray(opts.memories) ? opts.memories : [];
    const vectors = opts.vectors && typeof opts.vectors === 'object' ? opts.vectors : {};
    const entries = {};
    for (const item of memories) {
      if (!item || item.enabled === false || !Array.isArray(vectors[item.id])) continue;
      const vector = vectors[item.id].map(Number).filter(Number.isFinite).slice(0, 3072);
      if (vector.length) entries[item.id] = vector;
    }
    const index = {
      version: VERSION,
      characterId: String(opts.characterId || ''),
      modelId: String(opts.modelId || ''),
      source: String(opts.source || 'provider'),
      fingerprint: fingerprint(opts.characterId, memories, opts.modelId),
      entries,
      updatedAt: Date.now(),
    };
    writeAtomic(target, index);
    return { ok: true, index, count: Object.keys(entries).length, fingerprint: index.fingerprint };
  }

  function currentFingerprint(characterId, memories, modelId) {
    return fingerprint(characterId, memories, modelId);
  }

  return { path: target, load, rebuild, fingerprint: currentFingerprint };
}

module.exports = { VERSION, fingerprint, createIndexStore };
