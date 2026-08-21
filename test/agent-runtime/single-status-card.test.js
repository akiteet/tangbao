'use strict';
const test = require('node:test');
const { readRuntimeSource, readRendererSource, readMainSource } = require('./source-helper');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('糖码页面不再创建独立接力条，继续操作并入状态卡', () => {
  const agent = readRendererSource();
  assert.doesNotMatch(agent, /showResumeBar\s*\(/);
  assert.doesNotMatch(agent, /hideResumeBar\s*\(/);
  assert.doesNotMatch(agent, /agentResumeBar/);
  // blocked 事件不再重复 Toast / 弹接力条
  assert.doesNotMatch(agent, /App\.ui\.toast\(ev\.reason/);
});

test('Meta 条并入状态卡，同一 Run 只保留一张状态卡', () => {
  const agent = readRendererSource();
  assert.match(agent, /v15（单状态卡）：Meta 信息并入统一状态卡/);
  assert.doesNotMatch(agent, /showResumeBar\(ev\.reason\)/);
  assert.match(agent, /segment_completed/);
  assert.match(agent, /showStatusRunning\(\);/);
});

test('全局运行药丸只在离开糖码页面时显示', () => {
  const agent = readRendererSource();
  const router = read('src/renderer/router.js');
  assert.match(agent, /App\.router\.current\(\) === 'agent'\) \{ pill\.hidden = true; return; \}/);
  assert.match(router, /renderRunPill/);
});

test('空会话不再展示首次操作示例引导，仅保留中性空状态', () => {
  const agent = readRendererSource();
  assert.doesNotMatch(agent, /描述你希望它完成的任务/);
  assert.doesNotMatch(agent, /列出当前目录的 \.js 文件/);
  assert.match(agent, /agent-empty';\s*\n\s*d\.innerHTML = '暂无消息'/);
});
