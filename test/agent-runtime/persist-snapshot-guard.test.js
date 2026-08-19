'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// v1.1.6（B3）：createPersistedSnapshot 的 content 未变时返回缓存、不走到第二次带缩进 stringify。
// 用 vm 执行 state.js，构造最小 App 上下文，连续两次 persist 验证 snapshot 复用。
function makeContext() {
  const storage = new Map();
  const context = {
    console, setTimeout, clearTimeout,
    localStorage: {
      getItem: (k) => storage.get(k) || null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    App: {
      services: { fs: { saveStateJSON: () => ({ ok: true }) } },
      rt: {},
    },
    window: null, addEventListener: () => {},
  };
  context.window = context;
  return context;
}

test('B3: state 未变时 persist 复用缓存 snapshot（不重新 stringify）', () => {
  const state = read('src/renderer/state/state.js');
  const ctx = makeContext();
  vm.runInNewContext(state, ctx, { filename: 'state.js' });
  // 初始化一个最小 state
  ctx.App.state = { conversations: [], settings: { accounts: [], providers: {} } };
  const first = ctx.App.persist();
  assert.equal(first.ok, true);
  const firstJson = ctx.App.__persistence; // 不直接依赖内部，改用二次调用比对
  // 第二次 persist，state 未变 → 应返回同一 snapshot（revision 不变）
  const second = ctx.App.persist();
  assert.equal(second.ok, true);
  assert.equal(second.revision, first.revision, 'revision 不变说明复用缓存');
});

test('B3: state 变化时 persist 产生新 snapshot（revision 递增）', () => {
  const state = read('src/renderer/state/state.js');
  const ctx = makeContext();
  vm.runInNewContext(state, ctx, { filename: 'state.js' });
  ctx.App.state = { conversations: [], settings: { accounts: [], providers: {} } };
  const first = ctx.App.persist();
  // 改变 state → 新 snapshot
  ctx.App.state.conversations = [{ id: 'c1', messages: [] }];
  const second = ctx.App.persist();
  assert.equal(second.ok, true);
  assert.ok(second.revision > first.revision, 'revision 递增说明产生了新 snapshot');
});

test('B2: sanitizeFloatState 不再使用 JSON.parse(JSON.stringify) 全量深拷贝', () => {
  const state = read('src/renderer/state/state.js');
  // 验证 sanitizeFloatState 函数体内不再有 JSON.parse(JSON.stringify —— 改为手动浅拷贝脱敏
  const fnStart = state.indexOf('function sanitizeFloatState');
  const fnEnd = state.indexOf('\n  }', fnStart);
  const fnBody = state.slice(fnStart, fnEnd);
  assert.doesNotMatch(fnBody, /JSON\.parse\(JSON\.stringify/, '不再全量深拷贝');
  assert.match(fnBody, /Object\.assign/, '改为手动浅拷贝');
  assert.match(fnBody, /delete next\.apiKey/, '仍脱敏 apiKey');
});
