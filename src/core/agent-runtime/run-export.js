'use strict';
const crypto = require('crypto');

function stable(value) { return JSON.stringify(value == null ? null : value); }
function checksum(lines) { return crypto.createHash('sha256').update(lines.join('\n')).digest('hex'); }

function exportRunJSONL(input) {
  const src = input || {};
  if (!src.run || !src.run.id) throw new Error('run_required');
  const events = (Array.isArray(src.events) ? src.events : []).slice().sort((a, b) => Number(a.seq) - Number(b.seq));
  let prev = -1; // B7（P3）：seq 从 0 开始的事件流也合法（原 prev=0 会误报 event_sequence_not_strict）
  for (const event of events) {
    const seq = Number(event.seq) || 0;
    if (seq <= prev) throw new Error('event_sequence_not_strict');
    prev = seq;
  }
  const rows = [
    { recordType: 'run', exportVersion: 1, data: src.run },
    ...events.map((event) => ({ recordType: 'event', seq: event.seq, data: event })),
    { recordType: 'workingState', data: src.workingState || null },
    { recordType: 'references', checkpoints: src.checkpoints || [], summary: src.summary || null, artifacts: src.artifacts || [] },
  ];
  const lines = rows.map(stable);
  lines.push(stable({ recordType: 'integrity', eventCount: events.length, maxSeq: prev, sha256: checksum(lines) }));
  return lines.join('\n') + '\n';
}

function parseRunJSONL(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  const rows = lines.map((line) => JSON.parse(line));
  const integrity = rows[rows.length - 1];
  if (!integrity || integrity.recordType !== 'integrity') throw new Error('integrity_record_missing');
  const actual = checksum(lines.slice(0, -1));
  if (actual !== integrity.sha256) throw new Error('checksum_mismatch');
  const events = rows.filter((row) => row.recordType === 'event');
  if (events.length !== integrity.eventCount) throw new Error('event_count_mismatch');
  return { rows, integrity };
}

module.exports = { exportRunJSONL, parseRunJSONL };
