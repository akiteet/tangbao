'use strict';
// 项目级 .mcp.json 解析与合并回归（v1.2.0 批次 5-③C）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { _projectMcp } = require('../../src/main/main-mcp.js');

test('parseProjectMcpJson：官方 mcpServers 映射格式 → 规范化数组', () => {
  const raw = JSON.stringify({
    mcpServers: {
      fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'D:/ws'] },
      remote: { url: 'https://example.com/mcp' },
      bad: { transport: 'stdio' }, // 无 command → 丢弃
    },
  });
  const list = _projectMcp.parseProjectMcpJson(raw);
  assert.equal(list.length, 2);
  const fsSrv = list.find((s) => s.id === 'fs');
  assert.equal(fsSrv.transport, 'stdio');
  assert.deepEqual(fsSrv.args, ['-y', '@modelcontextprotocol/server-filesystem', 'D:/ws']);
  assert.equal(list.find((s) => s.id === 'remote').transport, 'http');
});

test('mergeServers：项目级同名 id 覆盖全局，其余保留顺序', () => {
  const g = [{ id: 'a', name: 'GA' }, { id: 'b', name: 'GB' }];
  const p = [{ id: 'b', name: 'PB-overrides' }, { id: 'c', name: 'PC-new' }];
  const merged = _projectMcp.mergeServers(g, p);
  assert.deepEqual(merged.map((s) => ({ id: s.id, name: s.name })), [
    { id: 'a', name: 'GA' },
    { id: 'b', name: 'PB-overrides' },
    { id: 'c', name: 'PC-new' },
  ]);
});

test('readProjectMcpJson：文件缺失返回 []；存在时读取并解析', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-mcpjson-'));
  try {
    assert.deepEqual(_projectMcp.readProjectMcpJson(dir), []);
    fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { only: { command: 'node', args: ['x.js'] } } }));
    const list = _projectMcp.readProjectMcpJson(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'only');
    assert.equal(list[0].command, 'node');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});
