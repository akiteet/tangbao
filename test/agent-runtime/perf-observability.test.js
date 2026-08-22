'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');

test('v1.1.6（批次 A）：perf 仪表 API 契约——enable/disable/snapshot/clear 就位且默认关', () => {
  const perf = fs.readFileSync(path.join(ROOT, 'src/renderer/perf.js'), 'utf8');
  assert.match(perf, /let enabled = false;/, '默认关闭');
  assert.match(perf, /enable\(\)/, 'enable API');
  assert.match(perf, /disable\(\)/, 'disable API');
  assert.match(perf, /snapshot\(\)/, 'snapshot API');
  assert.match(perf, /clear\(\)/, 'clear API');
  assert.match(perf, /isEnabled\(\)/, 'isEnabled API');
});

test('v1.1.6（批次 A）：设置面板 data 区有性能诊断出口', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /id="perfToggle"/, 'perf 开关');
  assert.match(html, /id="perfExport"/, '导出快照按钮');
  assert.match(html, /id="perfClear"/, '清空按钮');
});

test('v1.1.6（批次 A）：ui.js 绑定 perf 开关/导出/清空，开关状态存 settings + localStorage', () => {
  const ui = require('./source-helper').readComponentsSource();
  assert.match(ui, /perfToggle.*addEventListener\('change'/, '开关 change 绑定');
  assert.match(ui, /App\.perf\.enable\(\)/, '开启调用');
  assert.match(ui, /App\.perf\.disable\(\)/, '关闭调用');
  assert.match(ui, /App\.state\.settings\.perfEnabled/, '状态存 settings');
  assert.match(ui, /localStorage\.setItem\('perfEnabled'/, 'localStorage 兜底');
  assert.match(ui, /App\.perf\.snapshot\(\)/, '导出快照调用');
});

test('v1.1.6（批次 A）：app.js boot 按设置开启 perf 使 bootMs 可记录', () => {
  const app = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
  assert.match(app, /localStorage\.getItem\('perfEnabled'\)/, 'boot 前 localStorage 兜底');
  assert.match(app, /App\.state\.settings\.perfEnabled/, 'state 加载后同步');
  assert.match(app, /measure\('bootMs'/, 'bootMs 埋点仍在');
});

test('v1.1.6（批次 A）：perf.js 红线不变——不持久化不通信（check:perf 兼容）', () => {
  const perf = fs.readFileSync(path.join(ROOT, 'src/renderer/perf.js'), 'utf8');
  assert.doesNotMatch(perf, /localStorage|sessionStorage|fetch\s*\(|sendSync|App\.services/, 'perf.js 仍纯内存');
});
