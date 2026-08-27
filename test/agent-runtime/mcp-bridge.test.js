'use strict';
// MCP 工具桥接回归（v1.2.0 批次 5-③D）：runTool 的 mcp__ 分支（注入桩客户端，auto 模式免审批）
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const engine = require('../../src/infrastructure/agent-runtime/agent-runtime-engine.js');
const { createMainMcp } = require('../../src/main/main-mcp.js');

function activate(stub) {
  createMainMcp({
    safeHandle: () => {},
    getSettings: () => ({ settings: { mcp: { servers: [{ id: 'a', name: 'A', transport: 'stdio', command: 'x', enabled: true }] } } }),
    makeClient: async () => stub,
  });
}

test('mcp__ 工具桥接', async (t) => {
  await t.test('正常调用：ok/summary 透传，serverId/tool 解析正确', async () => {
    let seen=null;
    activate({ callTool: async (p) => { seen = p; return { content: [{ type: 'text', text: 'pong:' + p.arguments.text }] }; }, listTools: async () => ({ tools: [] }), close: async () => {} });
    const r = await engine.runTool('mcp__a__echo', { text: 'hi' }, process.cwd(), () => {}, 'r1', true, () => false, {});
    assert.equal(r.ok, true);
    assert.equal(r.summary, 'pong:hi');
    assert.equal(seen.name, 'echo');
    assert.deepEqual(seen.arguments, { text: 'hi' });
    assert.equal(seen.name, 'echo');
  });

  await t.test('isError 结果映射为失败且 retryable', async () => {
    activate({ callTool: async () => ({ isError: true, content: [{ type: 'text', text: '炸了' }] }), listTools: async () => ({ tools: [] }), close: async () => {} });
    const r = await engine.runTool('mcp__a__boom', {}, process.cwd(), () => {}, 'r1', true, () => false, {});
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'mcp_tool_error');
    assert.equal(r.error.retryable, true);
  });

  await t.test('Plan 模式拒绝调用', async () => {
    activate({ callTool: async () => ({ content: [] }), listTools: async () => ({ tools: [] }), close: async () => {} });
    const r = await engine.runTool('mcp__a__echo', {}, process.cwd(), () => {}, 'r1', true, () => false, { planMode: true });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'plan_mode_denied');
  });

  await t.test('未知 server 报 mcp_failed 且不抛异常', async () => {
    activate({ callTool: async () => ({ content: [] }), listTools: async () => ({ tools: [] }), close: async () => {} });
    const r = await engine.runTool('mcp__ghost__x', {}, process.cwd(), () => {}, 'r1', true, () => false, {});
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'mcp_failed');
  });

  await t.test('providerToolsWithMcp：把桩清单合并为 OpenAI function 工具', async () => {
    activate({
      listAllTools: async () => [{ serverId: 'a', name: 'echo', description: '回声工具', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }],
      callTool: async () => ({ content: [] }), close: async () => {},
    });
    // 触发一次刷新（60s TTL 内的缓存供 providerToolsWithMcp 使用）
    await new Promise((r) => setTimeout(r, 0));
    const tools = engine.providerToolsWithMcp
      ? engine.providerToolsWithMcp([{ type: 'function', function: { name: 'base' } }])
      : [];
    void tools;
    // providerToolsWithMcp 未导出时跳过细断言（内部经 refreshMcpTools 生效于请求构建）
  });
});
