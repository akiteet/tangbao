'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const storage = require('../../src/infrastructure/storage/sqlite-store');
let Database = null;
try { Database = require('better-sqlite3'); } catch (_) {}

test('local search is paginated, scoped and redacts secret-like content', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-search-'));
  const dbPath = path.join(dir, 'tangbao.sqlite');
  try {
    if (!storage.init(dbPath)) { t.skip('better-sqlite3 native module is unavailable for this Node runtime'); return; }
    storage.StorageService.upsertConversation({ id: 'conv-search', title: 'Benchmark notes', createdAt: 1, updatedAt: 10 });
    storage.StorageService.replaceMessages('conv-search', [{ id: 'msg-search', role: 'user', content: 'cache benchmark sk-test-secret-12345678', createdAt: 2 }]);
    storage.StorageService.upsertDoc({ id: 'doc-search', name: 'Cache report', text: 'warm cache result', createdAt: 3 });
    storage.StorageService.upsertWorkflow({ id: 'wf-search', name: 'Cache workflow', steps: [], createdAt: 4 });
    storage.StorageService.createAgentRun({ id: 'run-search', threadId: 'thread-search', workspaceId: 'project-search', userGoal: 'cache investigation', status: 'completed', startedAt: 5, finishedAt: 6 });

    const first = storage.StorageService.searchLocal('cache', { scopes: ['conversation', 'document', 'workflow'], limit: 2 });
    assert.equal(first.ok, true);
    assert.equal(first.items.length, 2);
    assert.equal(typeof first.total, 'number');
    assert.ok(first.nextCursor);
    assert.ok(first.items.every((item) => !String(item.snippet).includes('sk-test-secret')));

    const second = storage.StorageService.searchLocal('cache', { scopes: ['conversation', 'document', 'workflow'], cursor: first.nextCursor, limit: 2 });
    assert.equal(second.ok, true);
    assert.ok(second.items.length >= 1);
    assert.ok(second.items.every((item) => ['conversation', 'document', 'workflow'].includes(item.scope)));

    const runOnly = storage.StorageService.searchLocal('cache', { scopes: ['run'], limit: 10 });
    assert.equal(runOnly.total, 1);
    const runFiltered = storage.StorageService.searchLocal('cache', { scopes: ['run'], runId: 'run-search', limit: 10 });
    assert.equal(runFiltered.total, 1);
    const otherProject = storage.StorageService.searchLocal('cache', { scopes: ['run'], projectId: 'other-project', limit: 10 });
    assert.equal(otherProject.total, 0);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('run history returns v16 metrics while retaining legacy usage fields', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-history-'));
  const dbPath = path.join(dir, 'tangbao.sqlite');
  try {
    if (!storage.init(dbPath)) { t.skip('better-sqlite3 native module is unavailable for this Node runtime'); return; }
    storage.StorageService.createAgentRun({ id: 'run-metrics', threadId: 'thread-metrics', userGoal: 'measure cache', status: 'completed', startedAt: 10, finishedAt: 40, usage: { steps: 2 } });
    storage.StorageService.upsertAgentRunMetrics({
      runId: 'run-metrics', rootRunId: 'run-metrics', steps: 2, toolCalls: 1,
      inputTokens: 100, outputTokens: 25, queueWaitMs: 7,
      cache: { hitRate: 0.5, savedTokens: 50, source: 'provider', dataOrigin: 'provider' },
      cost: { totalUsd: 0.0123, source: 'estimated' },
    });
    const page = storage.StorageService.listAgentRuns('thread-metrics', 10, 0);
    assert.equal(page.length, 1);
    assert.equal(page[0].usage.steps, 2);
    assert.equal(page[0].metrics.toolCalls, 1);
    assert.equal(page[0].metrics.cache.hitRate, 0.5);
    assert.equal(page[0].metrics.cost.totalUsd, 0.0123);
    assert.equal(page[0].metrics.queueWaitMs, 7);
    assert.equal(page[0].metrics.reasoningTokens, null);

    storage.StorageService.createAgentRun({ id: 'run-metrics-unknown', threadId: 'thread-metrics', userGoal: 'unknown usage', status: 'completed', startedAt: 50, finishedAt: 60 });
    const unknown = storage.StorageService.upsertAgentRunMetrics({ runId: 'run-metrics-unknown', rootRunId: 'run-metrics-unknown' });
    assert.equal(unknown.inputTokens, null);
    assert.equal(unknown.outputTokens, null);
    assert.equal(unknown.reasoningTokens, null);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('model metrics filter keeps attribution and cost unknown instead of zero', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-model-metrics-'));
  const dbPath = path.join(dir, 'tangbao.sqlite');
  try {
    if (!storage.init(dbPath)) { t.skip('better-sqlite3 native module is unavailable for this Node runtime'); return; }
    storage.StorageService.recordModelCallMetric({
      id: 'metric-filter', scope: 'chat', callType: 'chat', provider: 'custom', modelId: 'private-model',
      accountRef: 'account-local', projectId: 'project-local', inputTokens: 10, outputTokens: 2,
    });
    const page = storage.StorageService.listModelCallMetricsPage({ accountRef: 'account-local', projectId: 'project-local', limit: 10 });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].attribution.accountRef, 'account-local');
    assert.equal(page.items[0].cost.totalUsd, null);
    assert.equal(page.items[0].cost.source, 'unknown');
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v16 metric token repair preserves legacy rows and allows unknown values', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-metric-repair-'));
  const dbPath = path.join(dir, 'tangbao.sqlite');
  try {
    if (!Database || !storage.init(dbPath)) { t.skip('better-sqlite3 native module is unavailable for this Node runtime'); return; }
    storage.StorageService.createAgentRun({ id: 'legacy-metric-run', threadId: 'legacy-metric-thread', userGoal: 'legacy metric', status: 'completed', startedAt: 1, finishedAt: 2 });
    storage.StorageService.upsertAgentRunMetrics({ runId: 'legacy-metric-run', inputTokens: 10, outputTokens: 2, reasoningTokens: 1 });
    storage.close();

    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE agent_run_metrics_old (
        run_id TEXT PRIMARY KEY, root_run_id TEXT NOT NULL DEFAULT '', steps INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cache_json TEXT, cost_usd REAL, latency_ms INTEGER, queue_wait_ms INTEGER, process_ms INTEGER,
        human_interventions INTEGER NOT NULL DEFAULT 0, recovery_rate REAL, error_breakdown_json TEXT,
        source TEXT NOT NULL DEFAULT 'runtime', created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO agent_run_metrics_old SELECT * FROM agent_run_metrics;
      DROP TABLE agent_run_metrics;
      ALTER TABLE agent_run_metrics_old RENAME TO agent_run_metrics;
    `);
    legacyDb.close();

    assert.equal(storage.init(dbPath), true);
    const legacy = storage.StorageService.getAgentRunMetrics('legacy-metric-run');
    assert.equal(legacy.inputTokens, 10);
    assert.equal(legacy.outputTokens, 2);
    assert.equal(legacy.reasoningTokens, 1);
    const unknown = storage.StorageService.upsertAgentRunMetrics({ runId: 'unknown-metric-run', rootRunId: 'unknown-metric-run' });
    assert.equal(unknown.inputTokens, null);
    assert.equal(unknown.outputTokens, null);
    assert.equal(unknown.reasoningTokens, null);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
