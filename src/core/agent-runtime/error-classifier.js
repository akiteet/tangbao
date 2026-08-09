'use strict';

// Stable run error taxonomy. The legacy retryable field is intentionally kept.
const ERROR_TYPES = Object.freeze([
  'tool_failure',
  'model_failure',
  'permission_failure',
  'context_limit',
  'timeout',
  'invalid_result',
  'cancelled',
  'budget_exhausted',
  'infrastructure_failure',
]);

const TYPE_ACTIONS = Object.freeze({
  tool_failure: 'inspect_tool_output',
  model_failure: 'adjust_request_or_provider',
  permission_failure: 'request_approval_or_use_safe_alternative',
  context_limit: 'compress_context_or_reduce_scope',
  timeout: 'reduce_scope_or_retry_with_new_budget',
  invalid_result: 'validate_result_and_request_correction',
  cancelled: 'stop_run_and_wait_for_user',
  budget_exhausted: 'resume_with_explicit_additional_budget',
  infrastructure_failure: 'check_runtime_or_storage',
});

function inferType(code, error) {
  const value = String(code || '').toLowerCase();
  const message = String(error && error.message || '').toLowerCase();
  if (error && (error.name === 'AbortError' || error.type === 'cancelled')) return 'cancelled';
  if (/cancel|abort|parent_cancel/.test(value)) return 'cancelled';
  if (/budget|step_limit|token_budget|cost_limit/.test(value)) return 'budget_exhausted';
  if (/permission|approval|denied|forbidden|root_out_of_scope|sandbox/.test(value)) return 'permission_failure';
  if (/context|token_limit|overflow|too_many_tokens/.test(value) || /context length|too many tokens/.test(message)) return 'context_limit';
  if (/timeout|timed_out|idle/.test(value)) return 'timeout';
  if (/invalid|malformed|schema|empty_result|parse/.test(value)) return 'invalid_result';
  if (/tool|skill|command|script/.test(value)) return 'tool_failure';
  if (/model|llm|provider|upstream|auth|rate_limit/.test(value)) return 'model_failure';
  return '';
}

function normalizeType(type, code, error) {
  const explicit = String(type || '').trim();
  if (ERROR_TYPES.includes(explicit)) return explicit;
  return inferType(code, error) || 'infrastructure_failure';
}

function defaultRecoverable(type, retryable) {
  if (retryable != null) return !!retryable;
  return !['permission_failure', 'cancelled', 'budget_exhausted', 'invalid_result'].includes(type);
}

function classifyError(input, defaults) {
  const source = input instanceof Error ? input : (input || {});
  const base = defaults || {};
  const code = String(source.code || base.code || 'runtime_error');
  const message = String(source.message || base.message || source.error || '运行时错误');
  const type = normalizeType(source.type || base.type, code, source);
  const recoverable = defaultRecoverable(type, source.recoverable != null ? source.recoverable : base.recoverable != null ? base.recoverable : source.retryable != null ? source.retryable : base.retryable);
  const recommendedAction = String(source.recommendedAction || base.recommendedAction || TYPE_ACTIONS[type]);
  return {
    type,
    code,
    message,
    recoverable,
    recommendedAction,
    retryable: source.retryable != null ? !!source.retryable : recoverable,
  };
}

function errorForType(type, message, code, extra) {
  const payload = Object.assign({}, extra || {}, { type, message, code });
  return classifyError(payload);
}

function isTerminalError(error) {
  const normalized = classifyError(error);
  return !normalized.recoverable || ['cancelled', 'budget_exhausted'].includes(normalized.type);
}

module.exports = {
  ERROR_TYPES,
  TYPE_ACTIONS,
  classifyError,
  errorForType,
  isTerminalError,
};
