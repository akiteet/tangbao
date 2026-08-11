'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePrices,
  calculateCost,
  mergeCosts,
} = require('../../src/core/agent-runtime/cost-ledger');
const { beginModelCall, finishModelCall } = require('../../src/core/agent-runtime/model-call-recorder');

test('cost ledger separates input, output and cache prices', () => {
  const cost = calculateCost({
    provider: 'openai',
    model: 'gpt-4o',
    usage: { inputTokens: 1000, outputTokens: 500 },
    cache: { cacheReadTokens: 400, cacheWriteTokens: 100 },
  });
  assert.equal(resolvePrices('openai', 'gpt-4o').catalogVersion, '2026-08-10-1');
  assert.equal(cost.source, 'estimated');
  assert.equal(cost.inputUsd, 0.0025);
  assert.equal(cost.outputUsd, 0.005);
  assert.equal(cost.cacheReadUsd, 0.0005);
  assert.equal(cost.cacheWriteUsd, null);
  assert.equal(cost.totalUsd, 0.0075);
  assert.equal(cost.savedUsd, 0.0005);
});

test('cost ledger preserves unknown price and token values', () => {
  const unknown = calculateCost({ provider: 'custom', model: 'private-model', usage: { inputTokens: 100, outputTokens: 20 }, cache: {} });
  assert.equal(unknown.totalUsd, null);
  assert.equal(unknown.source, 'unknown');
  assert.equal(unknown.unknownReason, 'price_not_found');
  assert.equal(mergeCosts([unknown, { totalUsd: 0.1, source: 'estimated' }]).totalUsd, null);
});

test('model call recorder adds non-secret attribution and cost source', () => {
  const call = beginModelCall({ scope: 'agent', callType: 'chat', modelId: 'gpt-4o', provider: 'openai', accountRef: 'acc:main', projectId: 'project-1', runId: 'run-1' }, 1000);
  const metric = finishModelCall(call, {
    usage: { inputTokens: 10, outputTokens: 5 },
    cache: { source: 'unknown', dataOrigin: 'unknown' },
    status: 'completed',
    finishedAt: 1100,
  });
  assert.equal(metric.attribution.accountRef, 'acc:main');
  assert.equal(metric.attribution.projectId, 'project-1');
  assert.equal(metric.cost.source, 'estimated');
  assert.equal(metric.requestId, call.requestId);
});
