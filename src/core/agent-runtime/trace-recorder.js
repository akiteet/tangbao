'use strict';

const crypto = require('crypto');

const SECRET_KEY = /api[_-]?key|authorization|password|secret|token|cookie|credential/i;
const MAX_STRING = 16000;

function redact(value, key, depth) {
  if (depth > 8) return '[redacted:depth]';
  if (key && SECRET_KEY.test(String(key))) return '[redacted]';
  if (typeof value === 'string') {
    const text = value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '\n[truncated]' : value;
    return text.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [redacted]').replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[redacted]');
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, '', depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) out[childKey] = redact(childValue, childKey, depth + 1);
    return out;
  }
  return value;
}

function redactPayload(value) { return redact(value, '', 0); }

function eventStatus(event) {
  const payload = event && event.payload || {};
  if (payload.status) return String(payload.status);
  if (payload.ok === false || event && ['error', 'failed', 'tool_error'].includes(event.type)) return 'failed';
  if (event && ['done', 'completed', 'run_completed'].includes(event.type)) return 'completed';
  return 'running';
}

function encodeCursor(seq, id, createdAt) {
  return Buffer.from(JSON.stringify({ seq: Number(seq) || 0, id: String(id || ''), createdAt: Number(createdAt) || 0 }), 'utf8').toString('base64url');
}
function decodeCursor(cursor) {
  try {
    const value = JSON.parse(Buffer.from(String(cursor || ''), 'base64url').toString('utf8'));
    return { seq: Number(value.seq) || 0, id: String(value.id || ''), createdAt: Number(value.createdAt) || 0 };
  } catch (_) { return { seq: -1, id: '', createdAt: -1 }; }
}

function tracePage(events, options) {
  const opts = options || {};
  const types = new Set((Array.isArray(opts.types) ? opts.types : []).map(String));
  const statuses = new Set((Array.isArray(opts.statuses) ? opts.statuses : []).map(String));
  const depth = opts.depth == null ? null : Number(opts.depth);
  const cursor = decodeCursor(opts.cursor);
  const byTime = opts.sortBy === 'createdAt';
  const source = (Array.isArray(events) ? events : []).slice().sort((a, b) => byTime
    ? (Number(a.createdAt) - Number(b.createdAt) || String(a.id).localeCompare(String(b.id)))
    : (Number(a.seq) - Number(b.seq) || String(a.id).localeCompare(String(b.id))));
  const filtered = source.filter((event) => {
    if (byTime) {
      if (Number(event.createdAt) < cursor.createdAt || (Number(event.createdAt) === cursor.createdAt && String(event.id || '') <= cursor.id)) return false;
    } else if (Number(event.seq) < cursor.seq || (Number(event.seq) === cursor.seq && String(event.id || '') <= cursor.id)) return false;
    if (types.size && !types.has(String(event.type || ''))) return false;
    if (statuses.size && !statuses.has(eventStatus(event))) return false;
    if (depth != null) {
      const eventDepth = event.depth != null ? event.depth : event.payload && event.payload.depth;
      if (eventDepth != null && Number(eventDepth) > depth) return false;
    }
    return true;
  });
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 500);
  const page = filtered.slice(0, limit).map((event) => {
    const item = Object.assign({}, event, { status: eventStatus(event) });
    if (opts.includePayload === false) delete item.payload;
    else item.payload = redactPayload(item.payload);
    return item;
  });
  const last = page[page.length - 1];
  return { items: page, nextCursor: last && filtered.length > page.length ? encodeCursor(last.seq, last.id, last.createdAt) : null, hasMore: filtered.length > page.length, total: filtered.length };
}

function exportRedactedJSONL(input) {
  const source = input || {};
  const lines = [];
  if (source.run) lines.push(JSON.stringify({ recordType: 'run', data: redactPayload(source.run) }));
  for (const run of Array.isArray(source.runs) ? source.runs : []) lines.push(JSON.stringify({ recordType: 'run', data: redactPayload(run) }));
  for (const event of Array.isArray(source.events) ? source.events : []) lines.push(JSON.stringify({ recordType: 'event', seq: event.seq, data: redactPayload(event) }));
  if (source.metrics) lines.push(JSON.stringify({ recordType: 'metrics', data: redactPayload(source.metrics) }));
  if (source.workingState) lines.push(JSON.stringify({ recordType: 'workingState', data: redactPayload(source.workingState) }));
  const checksum = crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
  lines.push(JSON.stringify({ recordType: 'integrity', eventCount: (source.events || []).length, sha256: checksum, redacted: true }));
  return lines.join('\n') + '\n';
}

class TraceRecorder {
  constructor(options) {
    const opts = options || {};
    this.runId = String(opts.runId || '');
    this.store = opts.store || null;
    this.emit = typeof opts.emit === 'function' ? opts.emit : null;
    this.seq = Number(opts.startSeq) || 0;
  }

  record(type, payload, options) {
    const opts = options || {};
    const item = redactPayload(Object.assign({}, payload || {}, opts.status ? { status: opts.status } : {}));
    this.seq = Number(opts.seq) || this.seq + 1;
    if (this.emit) this.emit(type, item);
    if (this.store && typeof this.store.appendAgentEvent === 'function') {
      try { this.store.appendAgentEvent(this.runId, type, item, this.seq); } catch (_) {}
    }
    return { runId: this.runId, seq: this.seq, type, payload: item };
  }

  llm(payload) { return this.record('llm_call', payload); }
  tool(payload) { return this.record('tool_call', payload); }
  budget(payload) { return this.record('budget', payload); }
  cache(payload) { return this.record('cache', payload); }
  child(payload) { return this.record('subagent', payload); }
}

module.exports = { TraceRecorder, redactPayload, tracePage, encodeCursor, decodeCursor, exportRedactedJSONL, eventStatus };
