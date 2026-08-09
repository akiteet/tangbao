'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Gate = require('../../src/core/agent-runtime/completion-gate');

test('queued/cancelled/degraded 子代理不能让父任务误报完成', () => {
  const gaps = Gate.completionGap({
    subagents: [{ id: 'queued', status: 'queued' }, { id: 'cancelled', status: 'cancelled' }],
    subagentSummary: { status: 'degraded' },
  }, []);
  assert.ok(gaps.length >= 3);
  assert.ok(gaps.some((g) => String(g).includes('degraded')));
});
