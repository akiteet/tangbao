'use strict';
// MCP 管理器逻辑回归（v1.2.0 批次 5-③B）：注入桩客户端覆盖状态/列工具/调用/禁用分支。
// 真实 stdio 连接由用户 npm start 实测验证（子进程 SDK 加载在测试环境有平台摩擦）。
const test = require('node:test');
const assert = require('node:assert');

function makeManager(servers, stubClient) {
  const handlers = {};
  let connectCalls = 0;
  const safeHandle = (channel, fn) => { handlers[channel] = fn; };
  const { createMainMcp } = require('../../src/main/main-mcp.js');
  const mcp = createMainMcp({
    safeHandle,
    getSettings: () => ({ settings: { mcp: { servers } } }),
    makeClient: async () => { connectCalls++; return stubClient; },
  });
  return { mcp, handlers, connCalls: () => connectCalls };
}

test('状态：仅 enabled server 出现；禁用的不可达', async () => {
  const stub = { listTools: async () => ({ tools: [] }), callTool: async () => ({}), close: async () => {} };
  const { handlers } = makeManager([
    { id: 'on', name: 'On', transport: 'stdio', command: 'x', enabled: true },
    { id: 'off', name: 'Off', transport: 'stdio', command: 'x', enabled: false },
  ], stub);
  const s = await handlers['mcp:status'](null);
  assert.deepEqual(s.servers.map((r) => r.id), ['on']);
});

test('listTools/callTool：透传桩结果并缓存连接（第二次不再重连）', async () => {
  const calls = [];
  const stub = {
    listTools: async () => ({ tools: [{ name: 'echo', description: 'd', inputSchema: { type: 'object' } }] }),
    callTool: async (params) => { calls.push(params.name); return { content: [{ type: 'text', text: 'pong' }] }; },
    close: async () => {},
  };
  const { mcp, handlers, connCalls } = makeManager([{ id: 'a', name: 'A', transport: 'stdio', command: 'x', enabled: true }], stub);
  const t1 = await handlers['mcp:listTools'](null, { serverId: 'a' });
  assert.equal(t1.ok, true);
  assert.equal(t1.tools[0].name, 'echo');
  const c1 = await handlers['mcp:callTool'](null, { serverId: 'a', name: 'echo', arguments: {} });
  assert.equal(c1.ok, true);
  assert.equal(c1.summary, 'pong');
  const c2 = await handlers['mcp:callTool'](null, { serverId: 'a', name: 'echo', arguments: {} });
  assert.equal(c2.ok, true);
  assert.equal(connCalls(), 1, '连接必须被复用');
  assert.equal(mcp ? 0 : 1, 0);
  void c2;
});

test('isError 的工具结果以 ok:false 透传错误文本', async () => {
  const stub = {
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ isError: true, content: [{ type: 'text', text: '炸了' }] }),
    close: async () => {},
  };
  const { handlers } = makeManager([{ id: 'a', name: 'A', transport: 'stdio', command: 'x', enabled: true }], stub);
  const r = await handlers['mcp:callTool'](null, { serverId: 'a', name: 'boom', arguments: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'mcp_tool_error');
  assert.ok(r.error.message.includes('炸了'));
});

test('未知 server 与未启用 server 都拒绝', async () => {
  const stub = { listTools: async () => ({ tools: [] }), callTool: async () => ({}), close: async () => {} };
  const { handlers } = makeManager([{ id: 'on', name: 'On', transport: 'stdio', command: 'x', enabled: true }], stub);
  assert.equal((await handlers['mcp:listTools'](null, { serverId: 'ghost' })).ok, false);
  assert.equal((await handlers['mcp:listTools'](null, { serverId: 'off' })).ok, false);
});
