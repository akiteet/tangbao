'use strict';

const fs = require('node:fs');
const { readRuntimeSource, readRendererSource, readMainSource } = require('./source-helper');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');

test('糖码布局保留稳定的收缩、换行和横向滚动契约', () => {
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const agent = readRendererSource();

  assert.match(styles, /\.agent-layout\s*\{[^}]*min-width:\s*0/);
  assert.match(styles, /\.agent-main\s*\{[^}]*min-width:\s*0/);
  assert.match(styles, /\.agent-answer\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(styles, /\.agent-answer h1[\s\S]*?\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(styles, /\.agent-answer pre, \.agent-answer \.code-block\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(styles, /\.agent-answer \.code-block code\s*\{[^}]*white-space:\s*pre/);
  assert.match(styles, /#agentView\s*\{[^}]*padding-left:\s*16px[^}]*padding-right:\s*16px/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*#agentView\s*\{[^}]*padding-left:\s*12px[^}]*padding-right:\s*12px/);
  assert.match(styles, /\.agent-projects\s*\{[^}]*flex:\s*0 0 168px[^}]*width:\s*168px/);
  assert.match(styles, /\.agent-sessions\s*\{[^}]*flex:\s*0 0 168px[^}]*width:\s*168px/);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*agent-layout-compact[\s\S]*position:\s*absolute/);
  assert.match(styles, /\.agent-projects-head button, \.agent-sessions-head button[\s\S]*white-space:\s*nowrap[\s\S]*writing-mode:\s*horizontal-tb/);
  assert.match(styles, /\.agent-expand-tab\s*\{[\s\S]*writing-mode:\s*vertical-lr/);
  assert.doesNotMatch(styles, /@media \(max-width: 640px\)[\s\S]*\.agent-projects, \.agent-sessions \{ display: none; \}/);
  assert.match(agent, /matchMedia\('\(max-width: 900px\)'\)/);
  assert.match(agent, /_compactSidebarOpen/);
  assert.match(agent, /if \(App\.agent\._sidebarCompactMode\) App\.agent\._compactSidebarOpen = 'projects'/);
  assert.match(agent, /if \(App\.agent\._sidebarCompactMode\) App\.agent\._compactSidebarOpen = 'sessions'/);
  assert.doesNotMatch(styles, /\.agent-engine-rail/);
});

test('Electron UI smoke 使用固定的三种发布窗口', () => {
  const source = fs.readFileSync(path.join(root, 'scripts/ui-smoke.js'), 'utf8');
  assert.match(source, /1440, height: 900/);
  assert.match(source, /1024, height: 768/);
  assert.match(source, /720, height: 768/);
  assert.match(source, /390, height: 844/);
  assert.match(source, /<= 900/);
  assert.match(source, /smoke-drawer/);
  assert.match(source, /capturePage\(\)/);
  assert.match(source, /BrowserWindow/);
});
