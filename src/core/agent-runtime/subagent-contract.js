'use strict';

const SEVERITIES = new Set(['high', 'medium', 'low', 'info', 'block', 'warn']);
const CHECK_STATUSES = new Set(['passed', 'failed', 'skipped']);

function stringValue(value, fallback) {
  const text = String(value == null ? '' : value).trim();
  return text || String(fallback || '');
}

function normalizeEvidence(value) {
  if (typeof value === 'string') return { path: '', startLine: 0, endLine: 0, detail: value };
  const item = value && typeof value === 'object' ? value : {};
  const startLine = Number(item.startLine || item.line || 0);
  const endLine = Number(item.endLine || item.line || startLine || 0);
  return {
    path: stringValue(item.path, ''),
    startLine: Number.isFinite(startLine) ? Math.max(0, startLine) : 0,
    endLine: Number.isFinite(endLine) ? Math.max(0, endLine) : 0,
    detail: stringValue(item.detail || item.description || item.text, ''),
  };
}

function normalizeFinding(value) {
  const item = value && typeof value === 'object' ? value : { detail: value };
  const severity = stringValue(item.severity, 'info').toLowerCase();
  return {
    severity: SEVERITIES.has(severity) ? severity : 'info',
    title: stringValue(item.title, '未命名发现'),
    detail: stringValue(item.detail || item.description, ''),
    evidence: Array.isArray(item.evidence) ? item.evidence.slice(0, 20).map(normalizeEvidence) : [],
    recommendation: stringValue(item.recommendation || item.recommendationText, ''),
  };
}

function normalizeCheck(value) {
  const item = value && typeof value === 'object' ? value : { detail: value };
  const status = stringValue(item.status, 'skipped').toLowerCase();
  return {
    name: stringValue(item.name, '未命名检查'),
    status: CHECK_STATUSES.has(status) ? status : 'skipped',
    detail: stringValue(item.detail || item.description || item.output, ''),
  };
}

function parseStructured(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  const candidates = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fenced.exec(raw))) candidates.push(match[1].trim());
  candidates.push(raw);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {}
  }
  for (let start = raw.indexOf('{'); start >= 0; start = raw.indexOf('{', start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          const parsed = JSON.parse(raw.slice(start, i + 1));
          if (parsed && typeof parsed === 'object') return parsed;
        } catch (_) {}
        break;
      }
    }
  }
  return null;
}

function normalizeError(value, fallback) {
  if (!value) return null;
  const defaults = fallback || {};
  if (value && typeof value === 'object') {
    return Object.assign({}, value, {
      code: stringValue(value.code, defaults.code || 'subagent_failed'),
      message: stringValue(value.message || value.detail, defaults.message || '子代理执行失败'),
      retryable: value.retryable === true,
    });
  }
  return {
    code: defaults.code || 'subagent_failed',
    message: stringValue(value, defaults.message || '子代理执行失败'),
    retryable: false,
  };
}

function normalize(raw, meta) {
  const options = meta || {};
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = typeof raw === 'string' ? raw : stringValue(source.summary || source.content, '');
  const parsed = parseStructured(text);
  const value = parsed ? Object.assign({}, source, parsed) : source;
  let error = normalizeError(value.error, { code: 'subagent_failed', message: '子代理执行失败' });
  if (value.ok === false && !error) error = { code: 'subagent_failed', message: stringValue(value.summary || text, '子代理执行失败'), retryable: false };
  error = normalizeError(error, { code: 'subagent_failed', message: '子代理执行失败' });
  const ok = value.ok !== false && !error;
  return {
    ok,
    summary: stringValue(value.summary || text, ok ? '子代理未提供文字摘要' : (error && error.message) || '子代理执行失败'),
    findings: Array.isArray(value.findings) ? value.findings.slice(0, 100).map(normalizeFinding) : [],
    checks: Array.isArray(value.checks) ? value.checks.slice(0, 100).map(normalizeCheck) : [],
    steps: Number.isFinite(Number(value.steps)) ? Number(value.steps) : Number(options.steps || 0),
    toolsUsed: Number.isFinite(Number(value.toolsUsed)) ? Number(value.toolsUsed) : Number(options.toolsUsed || 0),
    durationMs: Number.isFinite(Number(value.durationMs)) ? Number(value.durationMs) : Number(options.durationMs || 0),
    error,
  };
}

function aggregate(results) {
  const items = (Array.isArray(results) ? results : []).map((item) => normalize(item));
  const failed = items.filter((item) => !item.ok);
  const passed = items.length - failed.length;
  const status = failed.length ? (passed ? 'degraded' : 'failed') : 'completed';
  return {
    ok: items.length > 0 && failed.length === 0,
    status,
    summary: failed.length ? `${passed}/${items.length} 个子代理成功，结果降级：${failed.length} 个失败或取消` : `全部 ${items.length} 个子代理完成`,
    findings: items.flatMap((item, index) => item.findings.map((finding) => Object.assign({ subagentIndex: index }, finding))),
    checks: items.flatMap((item, index) => item.checks.map((check) => Object.assign({ subagentIndex: index }, check))),
    failures: failed.map((item, index) => ({ index, summary: item.summary, error: item.error })),
    results: items,
  };
}

module.exports = { normalizeEvidence, normalizeFinding, normalizeCheck, parseStructured, normalize, aggregate };
