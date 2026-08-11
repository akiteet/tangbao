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
  // Token fields alone are not proof of a live provider response. Offline
  // benchmark adapters intentionally provide deterministic simulated values.
  const simulated = source.dataOrigin === 'offline-mock' || source.source === 'estimated';
  const providerReported = !simulated && (source.source === 'provider' || source.dataOrigin === 'provider_usage' || source.providerReported === true || hasProviderFields);
  const hitRate = eligibleTokens != null && eligibleTokens > 0 && cacheReadTokens != null ? Math.min(1, cacheReadTokens / eligibleTokens) : UNKNOWN;
  const savedTokens = cacheReadTokens != null ? cacheReadTokens : UNKNOWN;
  const estimatedCostUsd = source.costUsd != null ? numberOrNull(source.costUsd) : costForTokens({ inputTokens, outputTokens: source.outputTokens != null ? source.outputTokens : usage.outputTokens }, source.prices);
  const estimatedSavedCostUsd = savedTokens != null ? costForTokens({ inputTokens: savedTokens, outputTokens: 0 }, source.prices) : UNKNOWN;
  const unknownReason = source.unknownReason != null ? String(source.unknownReason) : (
    providerReported
      ? (cacheReadTokens == null && cacheWriteTokens == null ? 'provider_cache_usage_unavailable' : (cacheReadTokens == null ? 'provider_cache_read_unavailable' : ''))
      : (source.source === 'unknown' || source.dataOrigin === 'unknown' ? 'provider_usage_unavailable' : '')
  );
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
    // Offline values remain visibly simulated even when an adapter-shaped
    // fixture happens to carry source: provider.
    source: simulated && source.dataOrigin === 'offline-mock' ? 'estimated' : (providerReported ? 'provider' : (source.source || 'unknown')),
    unknownReason: unknownReason || null,
    dataOrigin: String(source.dataOrigin || (simulated ? 'offline-mock' : (providerReported ? 'provider_usage' : 'unknown'))),
    prefixFingerprint: String(source.prefixFingerprint || ''),
  };
}

function mergeCacheMetrics(list) {
  const items = (Array.isArray(list) ? list : []).map(normalizeCacheMetrics);
  if (!items.length) return normalizeCacheMetrics({});
  // Keep known values usable without turning an unknown call into zero. Cache
  // hit rate is stricter: only real provider usage (or explicit offline-mock)
  // contributes to the denominator.
  const sumKnown = (key) => {
    const values = items.map((item) => item[key]).filter((value) => value != null && Number.isFinite(Number(value)));
    return values.length ? values.reduce((total, value) => total + Number(value), 0) : UNKNOWN;
  };
  const eligibleTokens = sumKnown('eligibleTokens');
  const cacheReadTokens = sumKnown('cacheReadTokens');
  const cacheWriteTokens = sumKnown('cacheWriteTokens');
  const hitItems = items.filter((item) => item.eligibleTokens != null && item.cacheReadTokens != null
    && ((item.source === 'provider' && item.dataOrigin === 'provider_usage') || item.dataOrigin === 'offline-mock'));
  const hitEligible = hitItems.reduce((total, item) => total + Number(item.eligibleTokens), 0);
  const hitRead = hitItems.reduce((total, item) => total + Number(item.cacheReadTokens), 0);
  const hitUnknown = items.some((item) => item.source === 'unknown' || item.dataOrigin === 'unknown'
    || (item.eligibleTokens != null && item.cacheReadTokens == null));
  const fingerprints = [...new Set(items.map((item) => item.prefixFingerprint).filter(Boolean))];
  const dataOrigins = new Set(items.map((item) => item.dataOrigin));
  const source = dataOrigins.has('offline-mock') ? 'estimated'
    : (items.some((item) => item.source === 'unknown') ? 'unknown' : (items.some((item) => item.source === 'estimated') ? 'estimated' : 'provider'));
  return {
    mode: items.some((item) => item.mode === 'unknown') ? 'unknown' : items[items.length - 1].mode,
    eligibleTokens,
    inputTokens: sumKnown('inputTokens'),
    cacheReadTokens,
    cacheWriteTokens,
    hitRate: !hitUnknown && hitEligible > 0 ? hitRead / hitEligible : UNKNOWN,
    savedTokens: cacheReadTokens,
    estimatedCostUsd: sumKnown('estimatedCostUsd'),
    estimatedSavedCostUsd: sumKnown('estimatedSavedCostUsd'),
    source,
    unknownReason: items.map((item) => item.unknownReason).filter(Boolean)[0]
      || (fingerprints.length > 1 ? 'prefix_fingerprint_mixed' : null),
    dataOrigin: dataOrigins.has('unknown') ? 'unknown' : (dataOrigins.has('offline-mock') ? 'offline-mock' : 'provider_usage'),
    prefixFingerprint: fingerprints.length === 1 ? fingerprints[0] : '',
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
