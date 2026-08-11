'use strict';

const PRICE_CATALOG_VERSION = '2026-08-10-1';

// Prices are a local snapshot. An unmatched model is intentionally unknown.
const PRICE_CATALOG = Object.freeze({
  'openai:gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01, cacheReadPer1k: 0.00125 },
  'openai:gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006, cacheReadPer1k: 0.000075 },
  'openai:gpt-4.1': { inputPer1k: 0.002, outputPer1k: 0.008, cacheReadPer1k: 0.0005 },
  'openai:gpt-4.1-mini': { inputPer1k: 0.0004, outputPer1k: 0.0016, cacheReadPer1k: 0.0001 },
  'openai:gpt-4.1-nano': { inputPer1k: 0.0001, outputPer1k: 0.0004, cacheReadPer1k: 0.000025 },
  'anthropic:claude-3-5-sonnet': { inputPer1k: 0.003, outputPer1k: 0.015, cacheReadPer1k: 0.0003, cacheWritePer1k: 0.00375 },
  'anthropic:claude-3-7-sonnet': { inputPer1k: 0.003, outputPer1k: 0.015, cacheReadPer1k: 0.0003, cacheWritePer1k: 0.00375 },
  'google:gemini-1.5-pro': { inputPer1k: 0.00125, outputPer1k: 0.005, cacheReadPer1k: 0.0003125 },
  'google:gemini-1.5-flash': { inputPer1k: 0.000075, outputPer1k: 0.0003, cacheReadPer1k: 0.00001875 },
  'deepseek:deepseek-chat': { inputPer1k: 0.00027, outputPer1k: 0.0011, cacheReadPer1k: 0.00007 },
});

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function clean(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max || 120);
}

function providerKey(provider) {
  const value = clean(provider, 60).toLowerCase();
  if (value === 'gemini' || value === 'google') return 'google';
  if (value === 'openai-responses') return 'openai';
  return value;
}

function modelKey(provider, model) {
  return providerKey(provider) + ':' + clean(model, 120).toLowerCase();
}

function resolvePrices(provider, model, overrides) {
  if (overrides && typeof overrides === 'object') {
    const explicit = {
      inputPer1k: finiteOrNull(overrides.inputPer1k),
      outputPer1k: finiteOrNull(overrides.outputPer1k),
      reasoningPer1k: finiteOrNull(overrides.reasoningPer1k),
      cacheReadPer1k: finiteOrNull(overrides.cacheReadPer1k),
      cacheWritePer1k: finiteOrNull(overrides.cacheWritePer1k),
    };
    if (Object.values(explicit).some((value) => value != null)) return Object.assign({ catalogVersion: 'explicit' }, explicit);
  }
  const key = modelKey(provider, model);
  if (PRICE_CATALOG[key]) return Object.assign({ catalogVersion: PRICE_CATALOG_VERSION }, PRICE_CATALOG[key]);
  const prefix = Object.keys(PRICE_CATALOG).sort((a, b) => b.length - a.length).find((candidate) => key.startsWith(candidate + '-'));
  if (prefix) return Object.assign({ catalogVersion: PRICE_CATALOG_VERSION }, PRICE_CATALOG[prefix]);
  const modelName = clean(model, 120).toLowerCase();
  const modelOnly = Object.keys(PRICE_CATALOG).sort((a, b) => b.length - a.length).find((candidate) => {
    const candidateModel = candidate.slice(candidate.indexOf(':') + 1);
    return modelName === candidateModel || modelName.startsWith(candidateModel + '-');
  });
  if (modelOnly) return Object.assign({ catalogVersion: PRICE_CATALOG_VERSION }, PRICE_CATALOG[modelOnly]);
  return null;
}

function component(tokens, price) {
  const count = finiteOrNull(tokens);
  const rate = finiteOrNull(price);
  return count == null || rate == null ? null : count * rate / 1000;
}

function round(value) {
  return value == null ? null : Math.round(Number(value) * 1000000) / 1000000;
}

function calculateCost(input) {
  const source = input || {};
  const usage = source.usage || source.adapterUsage || {};
  const cache = source.cache || {};
  const providerCost = finiteOrNull(source.providerCostUsd != null ? source.providerCostUsd : source.costUsd);
  const prices = source.prices || resolvePrices(source.provider, source.model);
  const inputUsd = providerCost != null ? null : component(usage.inputTokens != null ? usage.inputTokens : source.inputTokens, prices && prices.inputPer1k);
  const outputUsd = providerCost != null ? null : component(usage.outputTokens != null ? usage.outputTokens : source.outputTokens, prices && prices.outputPer1k);
  const reasoningUsd = providerCost != null ? null : component(usage.reasoningTokens != null ? usage.reasoningTokens : source.reasoningTokens, prices && (prices.reasoningPer1k == null ? prices.outputPer1k : prices.reasoningPer1k));
  const cacheReadUsd = providerCost != null ? null : component(cache.cacheReadTokens, prices && prices.cacheReadPer1k);
  const cacheWriteUsd = providerCost != null ? null : component(cache.cacheWriteTokens, prices && prices.cacheWritePer1k);
  // Provider output token counts usually already include reasoning tokens.
  // Keep reasoning as a diagnostic component without double charging it.
  const calculatedTotal = [inputUsd, outputUsd].every((value) => value != null)
    ? inputUsd + outputUsd
    : null;
  const totalUsd = providerCost != null ? providerCost : calculatedTotal;
  const savedUsd = cache.cacheReadTokens == null || !prices
    ? null
    : component(cache.cacheReadTokens, prices.inputPer1k == null ? null : Math.max(0, prices.inputPer1k - (prices.cacheReadPer1k == null ? prices.inputPer1k : prices.cacheReadPer1k)));
  const sourceName = providerCost != null ? 'provider' : (prices ? 'estimated' : 'unknown');
  return {
    inputUsd: round(inputUsd),
    outputUsd: round(outputUsd),
    reasoningUsd: round(reasoningUsd),
    cacheReadUsd: round(cacheReadUsd),
    cacheWriteUsd: round(cacheWriteUsd),
    totalUsd: round(totalUsd),
    savedUsd: round(savedUsd),
    source: sourceName,
    priceCatalogVersion: prices && prices.catalogVersion ? prices.catalogVersion : null,
    unknownReason: totalUsd == null ? (providerCost == null && !prices ? 'price_not_found' : 'token_or_provider_cost_unavailable') : null,
  };
}

function normalizeCost(cost) {
  const source = cost || {};
  return {
    inputUsd: finiteOrNull(source.inputUsd),
    outputUsd: finiteOrNull(source.outputUsd),
    reasoningUsd: finiteOrNull(source.reasoningUsd),
    cacheReadUsd: finiteOrNull(source.cacheReadUsd),
    cacheWriteUsd: finiteOrNull(source.cacheWriteUsd),
    totalUsd: finiteOrNull(source.totalUsd != null ? source.totalUsd : source.costUsd),
    savedUsd: finiteOrNull(source.savedUsd),
    source: ['provider', 'estimated', 'unknown'].includes(String(source.source)) ? String(source.source) : 'unknown',
    priceCatalogVersion: source.priceCatalogVersion == null ? null : clean(source.priceCatalogVersion, 80),
    unknownReason: source.unknownReason == null ? null : clean(source.unknownReason, 160),
  };
}

function normalizeAttribution(input) {
  const source = input || {};
  return {
    provider: clean(source.provider, 60),
    accountRef: clean(source.accountRef || source.ref, 120),
    model: clean(source.model || source.modelId, 120),
    module: clean(source.module || source.scope, 60),
    projectId: clean(source.projectId, 160),
    runId: clean(source.runId, 160),
    rootRunId: clean(source.rootRunId || source.runId, 160),
  };
}

function mergeCosts(costs) {
  const items = (Array.isArray(costs) ? costs : []).map(normalizeCost);
  if (!items.length) return normalizeCost({ source: 'unknown', unknownReason: 'no_model_calls' });
  const sum = (key) => items.some((item) => item[key] == null) ? null : round(items.reduce((total, item) => total + item[key], 0));
  const source = items.some((item) => item.source === 'unknown') ? 'unknown' : (items.some((item) => item.source === 'estimated') ? 'estimated' : 'provider');
  return normalizeCost({
    inputUsd: sum('inputUsd'), outputUsd: sum('outputUsd'), reasoningUsd: sum('reasoningUsd'),
    cacheReadUsd: sum('cacheReadUsd'), cacheWriteUsd: sum('cacheWriteUsd'), totalUsd: sum('totalUsd'), savedUsd: sum('savedUsd'),
    source, priceCatalogVersion: items.map((item) => item.priceCatalogVersion).filter(Boolean)[0] || null,
    unknownReason: items.map((item) => item.unknownReason).filter(Boolean)[0] || null,
  });
}

module.exports = {
  PRICE_CATALOG_VERSION,
  PRICE_CATALOG,
  resolvePrices,
  calculateCost,
  normalizeCost,
  normalizeAttribution,
  mergeCosts,
};
