'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { exportRunJSONL, parseRunJSONL } = require('../../src/core/agent-runtime/run-export');

test('Run导出按严格事件序号输出且可回读校验', () => {
  const text = exportRunJSONL({ run: { id: 'r1', status: 'completed' }, events: [{ seq: 2, type: 'done' }, { seq: 1, type: 'meta' }], workingState: { goal: 'x' }, checkpoints: [{ id: 'c1' }] });
  const parsed = parseRunJSONL(text);
  assert.equal(parsed.integrity.eventCount, 2);
  assert.equal(parsed.integrity.maxSeq, 2);
  assert.deepEqual(parsed.rows.filter((r) => r.recordType === 'event').map((r) => r.seq), [1, 2]);
});

test('重复或逆序事件拒绝导出', () => {
  assert.throws(() => exportRunJSONL({ run: { id: 'r' }, events: [{ seq: 1 }, { seq: 1 }] }), /event_sequence_not_strict/);
});

test('JSONL被篡改后校验失败', () => {
  const text = exportRunJSONL({ run: { id: 'r' }, events: [{ seq: 1, type: 'done' }] });
  assert.throws(() => parseRunJSONL(text.replace('done', 'error')), /checksum_mismatch/);
});
