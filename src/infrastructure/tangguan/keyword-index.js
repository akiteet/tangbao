'use strict';

const fs = require('fs');
const path = require('path');
const Core = require('../../core/tangguan/tangguan-store');

const VERSION = 1;

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return null; }
}

function writeAtomic(filePath, value) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = filePath + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value), 'utf8');
  fs.renameSync(temp, filePath);
}

function fingerprint(memories) {
  return Core.stableHash(JSON.stringify((Array.isArray(memories) ? memories : [])
    .filter((item) => item && item.enabled !== false)
    .map((item) => [item.characterId, item.id, item.updatedAt, item.content, item.title, item.keywords, item.tags])
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])))));
}

function buildRecords(memories) {
  const records = {};
  for (const item of Array.isArray(memories) ? memories : []) {
    if (!item || item.enabled === false || !item.id || !item.characterId) continue;
    const characterId = String(item.characterId);
    const record = records[characterId] || { terms: {}, memoryIds: [] };
    const terms = Core.tokenize([item.title, item.content, ...(item.keywords || []), ...(item.tags || [])].join(' '));
    record.memoryIds.push(String(item.id));
    for (const term of terms) {
      if (!record.terms[term]) record.terms[term] = [];
      record.terms[term].push(String(item.id));
    }
    records[characterId] = record;
  }
  for (const record of Object.values(records)) {
    record.memoryIds = Array.from(new Set(record.memoryIds));
    for (const term of Object.keys(record.terms)) record.terms[term] = Array.from(new Set(record.terms[term]));
  }
  return records;
}

function createIndexStore(filePath) {
  const target = String(filePath || '');

  function load() {
    if (!target || !fs.existsSync(target)) return { ok: true, index: null, corrupted: false };
    const parsed = readJson(target);
    if (!parsed || parsed.version !== VERSION || !parsed.records || typeof parsed.records !== 'object') {
      return { ok: false, index: null, corrupted: true, code: 'keyword_index_corrupt' };
    }
    return { ok: true, index: parsed, corrupted: false };
  }

  function rebuild(memories) {
    const index = {
      version: VERSION,
      fingerprint: fingerprint(memories),
      records: buildRecords(memories),
      updatedAt: Date.now(),
    };
    try { writeAtomic(target, index); } catch (error) {
      return { ok: false, code: 'keyword_index_write_failed', error: error.message || String(error), index };
    }
    return { ok: true, index, bytes: target && fs.existsSync(target) ? fs.statSync(target).size : 0 };
  }

  function query(index, characterId, terms) {
    if (!index || !index.records) return null;
    const record = index.records[String(characterId || '')];
    if (!record) return new Set();
    const values = Array.isArray(terms) ? terms : [];
    if (!values.length) return null;
    const ids = new Set();
    for (const term of values) for (const id of Array.isArray(record.terms[term]) ? record.terms[term] : []) ids.add(id);
    return ids;
  }

  return { path: target, load, rebuild, query, fingerprint };
}

module.exports = { VERSION, fingerprint, buildRecords, createIndexStore };
