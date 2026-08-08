'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// 前端 context.js（renderer）与后端 context-manager.js 的预算必须同源
global.window = {};
global.App = {};
global.window.App = global.App;
require('../../src/renderer/views/chat/context.js');
const C = global.App.context;
const CM = require('../../src/core/agent-runtime/context-manager');

test('G6：前端 agentBudgetSpec 与后端 budgetForModel 阈值一致（≤2% 误差）', () => {
  for (const w of [32000, 64000, 128000, 200000]) {
    const fb = CM.budgetForModel(w);
    const fe = C.agentBudgetSpec(w);
    const tol = Math.max(2, Math.round(w * 0.02));
    assert.ok(Math.abs(fe.precompress - fb.precompress) <= tol, 'precompress ' + w);
    assert.ok(Math.abs(fe.hard - fb.hard) <= tol, 'hard ' + w);
    assert.ok(Math.abs(fe.emergency - fb.emergency) <= tol, 'emergency ' + w);
    assert.equal(fe.usable, fb.usable, 'usable ' + w);
  }
});

test('G6：emergency 阈值不再滞后于后端（旧前端 0.92 vs 后端约 0.708）', () => {
  const w = 128000;
  const b = C.agentBudgetSpec(w);
  const ratio = b.emergency / w;
  assert.ok(ratio >= 0.68 && ratio <= 0.75, 'emergency 阈值应约在窗口 0.68-0.75，而非旧 0.92，实际 ' + ratio.toFixed(3));
  assert.ok(C.agentUtilLevel(Math.round(w * 0.80), w) === 'emergency', '80% 用量应已进入 emergency');
});
