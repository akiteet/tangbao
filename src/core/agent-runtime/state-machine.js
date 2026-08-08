'use strict';

const ACTIVE_PHASES = [
  'recovering',
  'understanding',
  'exploring',
  'planning',
  'implementing',
  'verifying',
  'reviewing',
];
const PAUSE_PHASES = ['waiting_approval'];
const TERMINAL_PHASES = ['completed', 'blocked', 'failed', 'budget_exhausted', 'cancelled'];
const KNOWN_PHASES = new Set(ACTIVE_PHASES.concat(PAUSE_PHASES, TERMINAL_PHASES));

function allowedTargets(from) {
  if (TERMINAL_PHASES.includes(from)) return new Set();
  if (from === 'waiting_approval') return new Set(ACTIVE_PHASES.concat(TERMINAL_PHASES));
  if (ACTIVE_PHASES.includes(from)) {
    return new Set(ACTIVE_PHASES.concat(PAUSE_PHASES, TERMINAL_PHASES));
  }
  return new Set();
}

function canTransition(from, to) {
  if (!KNOWN_PHASES.has(from) || !KNOWN_PHASES.has(to)) return false;
  if (from === to) return true;
  return allowedTargets(from).has(to);
}

function normalizeRunStatus(status) {
  const value = String(status || 'running');
  return value === 'done' ? 'completed' : value;
}

function createPhaseMachine(initialPhase, hooks) {
  let current = KNOWN_PHASES.has(initialPhase) ? initialPhase : 'understanding';
  const opts = hooks || {};

  return {
    get() { return current; },
    set(next, meta) {
      const target = String(next || '');
      if (!canTransition(current, target)) {
        const result = { ok: false, changed: false, from: current, to: target, code: 'invalid_phase_transition' };
        if (typeof opts.onInvalid === 'function') opts.onInvalid(result, meta || null);
        return result;
      }
      if (target === current) return { ok: true, changed: false, from: current, to: target };
      const from = current;
      current = target;
      const result = { ok: true, changed: true, from, to: target };
      if (typeof opts.onTransition === 'function') opts.onTransition(result, meta || null);
      return result;
    },
  };
}

module.exports = {
  ACTIVE_PHASES,
  PAUSE_PHASES,
  TERMINAL_PHASES,
  canTransition,
  createPhaseMachine,
  normalizeRunStatus,
};
