'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const assert = require('node:assert/strict');

const Core = require('../../src/core/tangguan/tangguan-store');
const KeywordIndex = require('../../src/infrastructure/tangguan/keyword-index');

function makeMemories() {
  const memories = [];
  for (let i = 0; i < 2000; i++) {
    const characterId = i < 1000 ? 'character-a' : 'character-b';
    const chunks = Array.from({ length: 5 }, (_, chunk) => 'chunk-body-' + i + '-' + chunk + ' shared-world-term');
    memories.push({
      id: 'memory-' + i,
      characterId,
      title: 'World entry ' + i,
      content: chunks.join('\n'),
      keywords: [i % 2 ? 'shared-world-term' : 'needle'],
      tags: ['benchmark'],
      enabled: true,
      priority: 50,
      updatedAt: i + 1,
    });
  }
  return memories;
}

test('role-scoped keyword RAG stays fast and recoverable at 2000 entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-rag-benchmark-'));
  const indexPath = path.join(dir, 'worldbook.keyword.index.json');
  const memories = makeMemories();
  try {
    const store = KeywordIndex.createIndexStore(indexPath);
    const built = store.rebuild(memories);
    assert.equal(built.ok, true);
    assert.ok(built.bytes > 0);

    const sourceBytes = Buffer.byteLength(JSON.stringify(memories), 'utf8');
    assert.ok(built.bytes <= sourceBytes * 3, 'keyword index is too large');
    const rawIndex = fs.readFileSync(indexPath, 'utf8');
    assert.equal(rawIndex.includes(memories[0].content), false);

    const restarted = KeywordIndex.createIndexStore(indexPath);
    const loaded = restarted.load();
    assert.equal(loaded.ok, true);
    assert.equal(loaded.index.fingerprint, store.fingerprint(memories));

    const query = 'needle shared-world-term';
    const terms = Core.tokenize(query);
    const scoped = memories.filter((item) => item.characterId === 'character-a');
    const timings = [];
    let lastResult = null;
    for (let i = 0; i < 30; i++) {
      const started = performance.now();
      const keywordIds = restarted.query(loaded.index, 'character-a', terms);
      lastResult = Core.retrieveMemories(scoped, query, { keywordIds, limit: 8, tokenBudget: 600 });
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);
    const p95 = timings[Math.min(timings.length - 1, Math.ceil(timings.length * 0.95) - 1)];
    assert.ok(p95 <= 100, 'keyword retrieval p95 was ' + p95.toFixed(2) + 'ms');
    assert.ok(lastResult.items.length > 0);
    assert.equal(lastResult.items.some((item) => item.memory.characterId !== 'character-a'), false);

    fs.writeFileSync(indexPath, '{broken', 'utf8');
    const corrupted = KeywordIndex.createIndexStore(indexPath);
    const failed = corrupted.load();
    assert.equal(failed.ok, false);
    assert.equal(failed.corrupted, true);
    const rebuilt = corrupted.rebuild(memories);
    assert.equal(rebuilt.ok, true);
    assert.equal(corrupted.load().ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
