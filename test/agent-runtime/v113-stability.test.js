'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');

test('v1.1.3 model health exposes first-byte and full-response timings', async () => {
  const gateway = require('../../src/infrastructure/model-gateway/gateway');
  const originalFetch = global.fetch;
  try {
    gateway.configure({ getSecret: (ref) => ref === 'acc:test' ? 'test-secret' : '' });
    gateway.setEndpoints([{ ref: 'acc:test', apiBase: 'https://provider.example/v1' }]);
    global.fetch = async () => new Response(JSON.stringify({ data: [{ id: 'demo-model' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const result = await gateway.healthCheck('acc:test', 'demo-model', 'chat');
    assert.equal(result.ok, true);
    assert.equal(result.modelExists, true);
    assert.equal(typeof result.firstByteLatencyMs, 'number');
    assert.equal(typeof result.responseLatencyMs, 'number');
    assert.ok(result.responseLatencyMs >= result.firstByteLatencyMs);
    assert.equal(result.capabilities.cache.supported, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('v1.1.3 state retains project/session metadata while the UI stays on the compact v1.1.2 layout', () => {
  const state = fs.readFileSync(path.join(root, 'src/renderer/state/state.js'), 'utf8');
  const agent = fs.readFileSync(path.join(root, 'src/renderer/views/agent/agent.js'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const search = fs.readFileSync(path.join(root, 'src/renderer/components/search.js'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'src/renderer/components/ui.js'), 'utf8');
  const migrator = fs.readFileSync(path.join(root, 'src/infrastructure/storage/migrator.js'), 'utf8');
  assert.match(state, /pinned: !!t\.pinned/);
  assert.match(state, /archived: !!t\.archived/);
  assert.match(state, /healthStatus/);
  assert.match(agent, /agent-engine-launcher/);
  assert.doesNotMatch(index, /模型与缓存/);
  assert.doesNotMatch(index, /storageAuditParts/);
  assert.match(index, /id="localSearchBtn"/);
  assert.match(index, /src\/renderer\/components\/search\.js/);
  assert.match(styles, /\.local-search-modal/);
  assert.match(search, /event\.key\.toLowerCase\(\) === 'k'/);
  assert.match(search, /scope === 'conversation'/);
  assert.match(search, /scope === 'document'/);
  assert.match(search, /scope === 'workflow'/);
  assert.match(search, /scope === 'skill'/);
  assert.match(ui, /openCacheProbe\(\)/);
  assert.doesNotMatch(ui, /打开模型与缓存/);
  assert.match(agent, /const steps = numberOrNull\(metric\.steps/);
  assert.match(agent, /const cacheLabel =/);
  assert.match(migrator, /agentProjectMeta/);
  assert.match(migrator, /agentThreadMeta/);
});
