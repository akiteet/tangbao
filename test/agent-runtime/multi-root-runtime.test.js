'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readRuntimeSource, readRendererSource, readMainSource } = require('./source-helper');
const root = path.resolve(__dirname, '..', '..');
const server = readRuntimeSource(root);

test('Runtime 工具协议声明 rootId 和工作区根列表', () => {
  assert.match(server, /name: 'list_workspace_roots'/);
  assert.match(server, /fn\.parameters\.properties\.rootId/);
  assert.match(server, /WorkspaceRoots\.resolveRoot/);
  assert.match(server, /aggregateTools/);
  assert.match(server, /root_required/);
  assert.match(server, /git_root_outside_workspace/);
  assert.match(server, /unknown_root/);
});

test('运行状态与变更快照使用 rootId/限定路径', () => {
  assert.match(server, /workspaceSnapshot: workspace/);
  assert.match(server, /workspaceFingerprint/);
  assert.match(server, /qualified\(targetRel\)/);
  assert.match(server, /rootId: String\(opts\.rootId/);
  assert.match(server, /verifyChangedHashes\(cwd, ws\.filesChanged \|\| \[\], workspace\)/);
});
