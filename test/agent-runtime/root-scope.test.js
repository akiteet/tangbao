'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { readRuntimeSource, readRendererSource, readMainSource } = require('./source-helper');
const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('输入区提供主根、指定根和全部根范围并随请求发送', () => {
  const agent = readRendererSource();
  const state = read('src/renderer/state/state.js');
  assert.match(agent, /id="agentRootScope"/);
  assert.match(agent, /主文件夹/);
  assert.match(agent, /指定：/);
  assert.match(agent, /全部文件夹/);
  assert.match(agent, /cwd, workspaceId, rootScope/);
  assert.match(agent, /draftRootScope/);
  assert.match(state, /draftRootScope/);
});

test('Runtime 将 rootScope 解析成 allowedRootIds 并强制工具范围', () => {
  const server = readRuntimeSource(root);
  assert.match(server, /WorkspaceRoots\.resolveRootScope\(workspace, body\.rootScope\)/);
  assert.match(server, /allowedRootIds/);
  assert.match(server, /root_out_of_scope/);
  assert.match(server, /allowedRoots/);
  assert.match(server, /allowedRootIds: ctx\.allowedRootIds/);
  assert.match(server, /rootScope, allowedRootIds/);
});

test('线程草稿与 Run 均持久化 root scope', () => {
  const schema = read('src/core/schemas/db-schema.js');
  const store = read('src/infrastructure/storage/sqlite-store.js');
  assert.match(schema, /draft_root_scope_json/);
  assert.match(schema, /root_scope_json/);
  assert.match(store, /draft_root_scope_json/);
  assert.match(store, /root_scope_json/);
});
