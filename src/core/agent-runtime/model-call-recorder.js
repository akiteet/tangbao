'use strict';

const crypto = require('crypto');
const { normalizeModelUsage } = require('./model-telemetry');
const { calculateCost, normalizeAttribution, normalizeCost } = require('./cost-ledger');

function requestId(prefix) {
  const head = String(prefix || 'mc').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 16) || 'mc';
  return head + '_' + Date.now().toString(36) + '_' + crypto.randomBytes(5).toString('hex');
}

function beginModelCall(input) {
  const source = input || {};
  const startedAt = Number(source.startedAt) || Date.now();
  return {
    requestId: String(source.requestId || requestId(source.callType || source.scope || 'mc')),
    startedAt,
    scope: String(source.scope || 'chat'),
    callType: String(source.callType || 'chat'),
    runId: String(source.runId || ''),
    rootRunId: String(source.rootRunId || source.runId || ''),
    modelId: String(source.modelId || ''),
    provider: String(source.provider || ''),
    accountRef: String(source.accountRef || source.ref || ''),
    projectId: String(source.projectId || ''),
    module: String(source.module || source.scope || ''),
  };
}

function finishModelCall(call, result, sink) {
  const base = call || beginModelCall();
  const input = result || {};
  const finishedAt = Number(input.finishedAt) || Date.now();
  const usage = normalizeModelUsage({
    adapterUsage: input.usage || input.adapterUsage || null,
    cache: input.cache || null,
    costUsd: input.costUsd,
  });
  const cost = input.cost && typeof input.cost === 'object'
    ? normalizeCost(input.cost)
    : calculateCost({
      usage,
      cache: usage.cache,
      provider: base.provider,
      model: base.modelId,
      prices: input.prices,
      providerCostUsd: input.costSource === 'provider' ? input.costUsd : null,
    });
  const attribution = normalizeAttribution({
    provider: base.provider,
    accountRef: base.accountRef,
    model: base.modelId,
    module: base.module,
    projectId: base.projectId,
    runId: base.runId,
    rootRunId: base.rootRunId,
  });
  const metric = {
    id: String(input.id || base.requestId),
    requestId: base.requestId,
    scope: base.scope,
    callType: base.callType,
    runId: base.runId,
    rootRunId: base.rootRunId,
    modelId: base.modelId,
    provider: base.provider,
    adapterUsage: input.usage || input.adapterUsage || {},
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cache: usage.cache,
    costUsd: cost.totalUsd,
    cost,
    attribution,
    queueWaitMs: input.queueWaitMs == null ? null : Number(input.queueWaitMs),
    latencyMs: Math.max(0, finishedAt - base.startedAt),
    status: String(input.status || 'completed'),
    errorType: input.errorType ? String(input.errorType) : '',
    error: input.error || null,
    startedAt: base.startedAt,
    finishedAt,
  };
  if (typeof sink === 'function') {
    try { sink(metric); } catch (_) { /* telemetry must never break a model call */ }
  }
  return metric;
}

function createModelCallRecorder(options) {
  const opts = options || {};
  return {
    begin(input) { return beginModelCall(input); },
    finish(call, result) { return finishModelCall(call, result, opts.sink); },
  };
}

module.exports = { requestId, beginModelCall, finishModelCall, createModelCallRecorder };
