'use strict';

const crypto = require('crypto');

const UNKNOWN = null;

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function prefixFingerprint(input) {
  const source = input || {};
  return crypto.createHash('sha256').update(stable({
    role: source.role || '',
    promptVersion: source.promptVersion || '',
    promptPrefix: source.promptPrefix || '',
    toolsetVersion: source.toolsetVersion || '',
    toolSchema: source.toolSchema || '',
    modelId: source.modelId || '',
    provider: source.provider || '',
    workspaceFingerprint: source.workspaceFingerprint || '',
  })).digest('hex');
}

function numberOrNull(value) {
  if (value == null || value === '') return UNKNOWN;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : UNKNOWN;
}

function costForTokens(tokens, prices) {
  if (!prices || typeof prices !== 'object') return UNKNOWN;
  const input = Number(prices.inputPer1k);
  if (!Number.isFinite(input)) return UNKNOWN;
  const output = Number(prices.outputPer1k);
  const result = (Number(tokens && tokens.inputTokens) || 0) * input / 1000 + (Number(tokens && tokens.outputTokens) || 0) * (Number.isFinite(output) ? output : 0) / 1000;
  return Number.isFinite(result) ? result : UNKNOWN;
}

function normalizeCacheMetrics(input) {
  const source = input || {};
  const usage = source.usage || {};
  const inputTokens = numberOrNull(source.inputTokens != null ? source.inputTokens : usage.inputTokens);
  const cacheReadTokens = numberOrNull(source.cacheReadTokens != null ? source.cacheReadTokens : usage.cacheReadTokens);
  const cacheWriteTokens = numberOrNull(source.cacheWriteTokens != null ? source.cacheWriteTokens : usage.cacheWriteTokens);
  const eligibleTokens = numberOrNull(source.eligibleTokens);
  const hasProviderFields = cacheReadTokens != null || cacheWriteTokens != null;
  const providerReported = source.source === 'provider' || hasProviderFields;
  const hitRate = eligibleTokens != null && eligibleTokens > 0 && cacheReadTokens != null ? Math.min(1, cacheReadTokens / eligibleTokens) : UNKNOWN;
  const savedTokens = cacheReadTokens != null ? cacheReadTokens : UNKNOWN;
  const estimatedCostUsd = source.costUsd != null ? numberOrNull(source.costUsd) : costForTokens({ inputTokens, outputTokens: source.outputTokens != null ? source.outputTokens : usage.outputTokens }, source.prices);
  const estimatedSavedCostUsd = savedTokens != null ? costForTokens({ inputTokens: savedTokens, outputTokens: 0 }, source.prices) : UNKNOWN;
  return {
    mode: String(source.mode || 'unknown'),
    eligibleTokens,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    hitRate,
    savedTokens,
    estimatedCostUsd,
    estimatedSavedCostUsd,
    source: providerReported ? 'provider' : (source.source || 'unknown'),
    prefixFingerprint: String(source.prefixFingerprint || ''),
  };
}

function mergeCacheMetrics(list) {
  const items = (Array.isArray(list) ? list : []).map(normalizeCacheMetrics);
  if (!items.length) return normalizeCacheMetrics({});
  const sum = (key) => items.some((item) => item[key] == null) ? UNKNOWN : items.reduce((total, item) => total + item[key], 0);
  const eligibleTokens = sum('eligibleTokens');
  const cacheReadTokens = sum('cacheReadTokens');
  const cacheWriteTokens = sum('cacheWriteTokens');
  return {
    mode: items.some((item) => item.mode === 'unknown') ? 'unknown' : items[items.length - 1].mode,
    eligibleTokens,
    inputTokens: sum('inputTokens'),
    cacheReadTokens,
    cacheWriteTokens,
    hitRate: eligibleTokens != null && eligibleTokens > 0 && cacheReadTokens != null ? cacheReadTokens / eligibleTokens : UNKNOWN,
    savedTokens: cacheReadTokens,
    estimatedCostUsd: sum('estimatedCostUsd'),
    estimatedSavedCostUsd: sum('estimatedSavedCostUsd'),
    source: items.some((item) => item.source === 'unknown') ? 'unknown' : (items.some((item) => item.source === 'estimated') ? 'estimated' : 'provider'),
    prefixFingerprint: items[items.length - 1].prefixFingerprint || '',
  };
}

function normalizeModelUsage(input) {
  const source = input || {};
  const usage = source.adapterUsage || source.usage || source;
  const result = {
    inputTokens: numberOrNull(usage.inputTokens),
    outputTokens: numberOrNull(usage.outputTokens),
    reasoningTokens: numberOrNull(usage.reasoningTokens),
    costUsd: numberOrNull(usage.costUsd != null ? usage.costUsd : usage.estimatedCost),
  };
  const cacheInput = source.cache ? Object.assign({}, source.cache) : Object.assign({}, source, usage);
  if (usage.cacheReported === false) {
    cacheInput.cacheReadTokens = null;
    cacheInput.cacheWriteTokens = null;
    cacheInput.source = 'unknown';
  }
  result.cache = normalizeCacheMetrics(cacheInput);
  return result;
}

module.exports = { UNKNOWN, prefixFingerprint, normalizeCacheMetrics, mergeCacheMetrics, normalizeModelUsage, costForTokens };
