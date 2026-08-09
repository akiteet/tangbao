'use strict';

const { classifyError } = require('./error-classifier');

const DIMENSIONS = Object.freeze([
  'maxSteps',
  'maxDurationMs',
  'maxInputTokens',
  'maxOutputTokens',
  'maxCostUsd',
]);

const DEFAULT_BUDGET = Object.freeze({
  maxSteps: 96,
  maxDurationMs: 0,
  maxInputTokens: 0,
  maxOutputTokens: 0,
  maxCostUsd: 0,
  reserveRatio: 0.1,
});

function finiteLimit(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeBudget(input, fallback) {
  const source = Object.assign({}, fallback || DEFAULT_BUDGET, input || {});
  const out = {};
  for (const key of DIMENSIONS) out[key] = finiteLimit(source[key]);
  const reserve = Number(source.reserveRatio);
  out.reserveRatio = Number.isFinite(reserve) ? Math.min(Math.max(reserve, 0), 0.9) : DEFAULT_BUDGET.reserveRatio;
  return out;
}

function emptySpent() {
  return { steps: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, queueWaitMs: 0, processMs: 0 };
}

function addSpent(target, delta) {
  for (const key of Object.keys(target)) target[key] += Math.max(0, Number(delta && delta[key]) || 0);
  return target;
}

function limitFor(spentKey) {
  return {
    steps: 'maxSteps',
    durationMs: 'maxDurationMs',
    inputTokens: 'maxInputTokens',
    outputTokens: 'maxOutputTokens',
    costUsd: 'maxCostUsd',
  }[spentKey] || '';
}

class BudgetManager {
  constructor(input, options) {
    const opts = options || {};
    this.parent = opts.parent || null;
    this.clock = typeof opts.clock === 'function' ? opts.clock : Date.now;
    this.budget = normalizeBudget(input, opts.fallback);
    this.granted = Object.assign({}, this.budget);
    this.spent = emptySpent();
    this.reserved = emptySpent();
    this.startedAt = Number(opts.startedAt) || this.clock();
    this.children = new Map();
    this.lastExhaustion = null;
  }

  remaining(dimension) {
    const key = dimension || 'maxSteps';
    const limitKey = DIMENSIONS.includes(key) ? key : limitFor(key);
    const spentKey = ({ maxSteps: 'steps', maxDurationMs: 'durationMs', maxInputTokens: 'inputTokens', maxOutputTokens: 'outputTokens', maxCostUsd: 'costUsd' })[limitKey] || 'steps';
    if (!limitKey || !this.budget[limitKey]) return Infinity;
    return Math.max(0, this.budget[limitKey] - (this.spent[spentKey] || 0) - (this.reserved[spentKey] || 0));
  }

  elapsedMs(now) {
    return Math.max(0, (Number(now) || this.clock()) - this.startedAt);
  }

  check(delta, now) {
    const next = Object.assign({}, this.spent);
    addSpent(next, delta || {});
    const checks = [
      ['steps', 'maxSteps', 'steps'],
      ['durationMs', 'maxDurationMs', 'duration'],
      ['inputTokens', 'maxInputTokens', 'input_tokens'],
      ['outputTokens', 'maxOutputTokens', 'output_tokens'],
      ['costUsd', 'maxCostUsd', 'cost'],
    ];
    for (const [spentKey, limitKey, label] of checks) {
      if (this.budget[limitKey] > 0 && next[spentKey] > this.budget[limitKey]) {
        return { ok: false, type: 'budget_exhausted', code: 'budget_' + label + '_exhausted', dimension: limitKey, remaining: Math.max(0, this.budget[limitKey] - this.spent[spentKey]) };
      }
    }
    if (this.budget.maxDurationMs > 0 && this.elapsedMs(now) + (Number(delta && delta.durationMs) || 0) > this.budget.maxDurationMs) {
      return { ok: false, type: 'budget_exhausted', code: 'budget_duration_exhausted', dimension: 'maxDurationMs', remaining: Math.max(0, this.budget.maxDurationMs - this.elapsedMs(now)) };
    }
    return { ok: true, remaining: this.remainingSnapshot(next) };
  }

  remainingSnapshot(spent) {
    const source = spent || this.spent;
    const out = {};
    for (const [spentKey, limitKey] of [['steps', 'maxSteps'], ['durationMs', 'maxDurationMs'], ['inputTokens', 'maxInputTokens'], ['outputTokens', 'maxOutputTokens'], ['costUsd', 'maxCostUsd']]) {
      out[spentKey] = this.budget[limitKey] > 0 ? Math.max(0, this.budget[limitKey] - source[spentKey] - (this.reserved[spentKey] || 0)) : null;
    }
    return out;
  }

  consume(delta, meta) {
    const check = this.check(delta, (meta && meta.now) || this.clock());
    if (!check.ok) {
      this.lastExhaustion = classifyError(check);
      return { ok: false, error: this.lastExhaustion, spent: Object.assign({}, this.spent), remaining: this.remainingSnapshot() };
    }
    addSpent(this.spent, delta || {});
    return { ok: true, spent: Object.assign({}, this.spent), remaining: this.remainingSnapshot() };
  }

  canSpend(delta, meta) {
    return this.check(delta, (meta && meta.now) || this.clock()).ok;
  }

  grant(request, options) {
    const requested = normalizeBudget(request, this.budget);
    const opts = options || {};
    const granted = {};
    for (const [spentKey, limitKey] of [['steps', 'maxSteps'], ['durationMs', 'maxDurationMs'], ['inputTokens', 'maxInputTokens'], ['outputTokens', 'maxOutputTokens'], ['costUsd', 'maxCostUsd']]) {
      const unlimited = this.budget[limitKey] <= 0;
      const available = unlimited ? 0 : Math.max(0, this.budget[limitKey] - this.spent[spentKey] - this.reserved[spentKey]);
      const allocatable = unlimited ? 0 : available * (opts.ignoreReserve ? 1 : 1 - this.budget.reserveRatio);
      granted[limitKey] = unlimited ? 0 : Math.min(requested[limitKey] || allocatable, allocatable);
      this.reserved[spentKey] += granted[limitKey];
    }
    granted.reserveRatio = requested.reserveRatio;
    const child = new BudgetManager(granted, { parent: this, clock: this.clock });
    const id = String(opts.id || 'child_' + (this.children.size + 1));
    this.children.set(id, { manager: child, granted, released: false });
    child._reservationId = id;
    return child;
  }

  settleChild(child, actualSpent) {
    const id = child && child._reservationId;
    const record = id && this.children.get(id);
    if (!record || record.released) return;
    record.released = true;
    for (const [spentKey, limitKey] of [['steps', 'maxSteps'], ['durationMs', 'maxDurationMs'], ['inputTokens', 'maxInputTokens'], ['outputTokens', 'maxOutputTokens'], ['costUsd', 'maxCostUsd']]) {
      this.reserved[spentKey] = Math.max(0, this.reserved[spentKey] - (record.granted[limitKey] || 0));
    }
    const settled = this.consume(actualSpent || child.spent);
    if (!settled.ok) this.lastExhaustion = settled.error;
    return settled;
  }

  snapshot() {
    return {
      budget: Object.assign({}, this.budget),
      granted: Object.assign({}, this.granted),
      spent: Object.assign({}, this.spent),
      reserved: Object.assign({}, this.reserved),
      remaining: this.remainingSnapshot(),
      startedAt: this.startedAt,
      elapsedMs: this.elapsedMs(),
      exhausted: !!this.lastExhaustion,
      error: this.lastExhaustion,
    };
  }
}

function createBudgetManager(budget, options) {
  return new BudgetManager(budget, options);
}

module.exports = { DIMENSIONS, DEFAULT_BUDGET, normalizeBudget, BudgetManager, createBudgetManager, emptySpent };
