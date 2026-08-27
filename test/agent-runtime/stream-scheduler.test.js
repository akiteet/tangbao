'use strict';
// stream-scheduler 行为回归（v1.2.0 批次 7 第三刀）：合并触发/立即触发/无挂起时立即触发/周期复用
const test = require('node:test');
const assert = require('node:assert');
const { createFlushScheduler } = require('../../src/core/chat/stream-scheduler.js');

test('合并触发：多次 schedule 只回调一次，约 delayMs 后触发', async () => {
  let count = 0;
  const s = createFlushScheduler({ delayMs: 40, flush: () => { count++; } });
  s.schedule(); s.schedule(); s.schedule(); s.schedule();
  assert.equal(s.hasPending(), true);
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(count, 1, '四次 schedule 必须合并为一次 flush');
  assert.equal(s.hasPending(), false);
});

test('flushNow：立即同步触发并清除未触发定时器（不二次触发）', async () => {
  let count = 0;
  const s = createFlushScheduler({ delayMs: 50, flush: () => { count++; } });
  s.schedule();
  s.flushNow();
  assert.equal(count, 1);
  assert.equal(s.hasPending(), false);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(count, 1, '原定时器必须已被取消');
});

test('无挂起时 flushNow 也立即执行（终态兜底语义）', () => {
  let count = 0;
  const s = createFlushScheduler({ delayMs: 120, flush: () => { count++; } });
  s.flushNow();
  assert.equal(count, 1);
});

test('触发后可再次调度（周期复用）', async () => {
  let count = 0;
  const s = createFlushScheduler({ delayMs: 30, flush: () => { count++; } });
  s.schedule();
  await new Promise((r) => setTimeout(r, 60));
  s.schedule();
  assert.equal(s.hasPending(), true, '第二轮应重新挂起');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(count, 2);
});
