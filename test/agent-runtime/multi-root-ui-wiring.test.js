'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('多根工作区通过主进程 IPC 和 preload 暴露最小管理接口', () => {
  const main = read('src/main/main.js');
  const preload = read('src/preload/preload.js');
  const shell = read('src/application/services/shell.js');
  assert.match(main, /workspace:addRoot/);
  assert.match(main, /workspace:removeRoot/);
  assert.match(main, /workspace:setPrimary/);
  assert.match(main, /hasActiveAgentRuns/);
  assert.match(main, /code: 'workspace_busy'/);
  assert.match(main, /code: 'root_owned_by_other_workspace'/);
  assert.match(main, /code: 'unknown_workspace'/);
  assert.match(preload, /addWorkspaceRoot/);
  assert.match(preload, /removeWorkspaceRoot/);
  assert.match(preload, /setPrimaryWorkspaceRoot/);
  assert.match(shell, /renameWorkspaceRoot/);
});

test('项目界面保存主根兼容字段并显示多根管理', () => {
  const agent = read('src/renderer/views/agent/agent.js');
  const state = read('src/renderer/state/state.js');
  assert.match(agent, /projRoots/);
  assert.match(agent, /添加文件夹/);
  assert.match(agent, /primaryRootId/);
  assert.match(agent, /p\.cwd = primary\.path/);
  assert.match(agent, /WORKSPACE_ERROR_MESSAGES/);
  assert.match(agent, /projRootError/);
  assert.match(agent, /showRootError\(result, '添加文件夹失败，请重新选择。'\)/);
  assert.match(agent, /result\.canceled/);
  assert.match(state, /roots:/);
});
