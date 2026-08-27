'use strict';
// 用量统计仪表盘聚合回归（v1.2.0 批次 5；经 check:sqlite 的 Electron ABI 通道执行）。
// 2026-08-26：provider 实为接口适配器名、cost 几乎恒空，两列已从仪表盘移除，聚合仅按模型分组。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('用量聚合真库：按模型汇总（与 provider 无关）、成功数按 completed 统计、按日序列与总计', (t) => {
  const storage = require('../../src/infrastructure/storage/sqlite-store');
  let Database = null;
  try { Database = require('better-sqlite3'); } catch (_) {}
  if (!Database) { t.skip('better-sqlite3 native module is unavailable for this Node runtime'); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-usage-'));
  if (!storage.init(path.join(dir, 'tangbao.sqlite'))) { t.skip('better-sqlite3 初始化失败'); return; }
  try {
    const now = Date.now();
    const svc = storage.StorageService;
    svc.recordModelCallMetric({ id: 'u1', provider: 'prov-a', modelId: 'model-m1', status: 'completed', inputTokens: 100, outputTokens: 50, reasoningTokens: 10, latencyMs: 300, startedAt: now, finishedAt: now });
    svc.recordModelCallMetric({ id: 'u2', provider: 'prov-b', modelId: 'model-m1', status: 'rate_limit', errorType: 'rate_limit', inputTokens: 10, outputTokens: 0, latencyMs: 200, startedAt: now, finishedAt: now });
    svc.recordModelCallMetric({ id: 'u3', provider: 'prov-a', modelId: 'model-m2', status: 'completed', inputTokens: 7, outputTokens: 3, latencyMs: 100, startedAt: now - 86400000 });

    const res = svc.listModelCallMetricsSummary({ days: 7 });
    assert.equal(res.ok, true);
    assert.equal(res.items.length, 2, '同一模型跨 provider 合并为一行');

    const m1 = res.items.find((r) => r.model === 'model-m1');
    assert.ok(m1);
    assert.equal(m1.calls, 2);
    assert.equal(m1.okCalls, 1, '只有 completed 计入成功');
    assert.equal(m1.inTokens, 110);
    assert.equal(m1.outTokens, 50);
    assert.equal(m1.thinkTokens, 10);
    assert.equal(m1.avgMs, 250);
    assert.equal(m1.costUsd, undefined, '聚合结果不再输出成本');
    assert.equal(m1.provider, undefined, '聚合结果不再输出供应商');

    const total = res.total;
    assert.equal(total.calls, 3);
    assert.equal(total.okCalls, 2);
    assert.equal(total.inTokens, 117);
    assert.ok(Array.isArray(res.daily) && res.daily.length >= 1, '按日序列至少一天');
    assert.ok(res.daily.every((d) => d.day && typeof d.calls === 'number'));
  } finally {
    try { storage.close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});
