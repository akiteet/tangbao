'use strict';
/*
 * main-mcp.js —— MCP 服务器连接管理器（v1.2.0 批次 5-③B）。
 *
 * createMainMcp(deps) 工厂（同 createMainSkills/createMainStorage 先例）：
 *   deps = { safeHandle, getSettings, makeClient? }
 *     getSettings() → 返回完整 state 快照对象（或 null）；本模块只读 settings.mcp.servers。
 *     makeClient(server) → 可选注入：返回已连接的 SDK Client（测试桩用）。
 *
 * 职责：按启用的 server 配置维护官方 SDK Client 的连接生命周期，暴露：
 *   'mcp:status'    → 每个 server 的连接状态与工具数
 *   'mcp:listTools' → 指定 server 的工具清单（name/description/inputSchema）
 *   'mcp:callTool'  → 调用指定工具（结果文本拼接、200KB 截断、isError 透传）
 *
 * 安全边界：仅 enabled server 可连；stdio 命令来自用户自己在设置中填写（等价于用户在
 * 终端手动运行该命令）；连接与调用均有超时；应用退出时统一 close。
 */
const DEFAULT_TIMEOUT_MS = 30000;

let ACTIVE = null;

function createMainMcp(deps) {
  const safeHandle = deps && deps.safeHandle;
  const getSettings = deps && deps.getSettings;
  if (typeof safeHandle !== 'function') throw new Error('createMainMcp 需要 safeHandle');
  if (typeof getSettings !== 'function') throw new Error('createMainMcp 需要 getSettings');

  // id → { client, server, error?, toolsCount }
  const clients = new Map();

  function enabledServers() {
    let settings = null;
    try { settings = getSettings() || {}; } catch (_) { settings = {}; }
    const conf = settings.settings && settings.settings.mcp ? settings.settings.mcp : (settings.mcp || { servers: [] });
    return (Array.isArray(conf.servers) ? conf.servers : []).filter((s) => s && s.enabled !== false);
  }

  function findServer(id) {
    return enabledServers().find((s) => s.id === String(id || '')) || null;
  }

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(label + ' 超时（' + ms + 'ms）')), ms)),
    ]);
  }

  // 默认实现：官方 SDK Client（stdio / http）。测试可注入 deps.makeClient 覆盖。
  // 注意：SDK 的 exports 通配映射到 dist/cjs/*，子路径必须带 .js 后缀（'client/stdio' 不带后缀在 CJS 下 MODULE_NOT_FOUND，
  // 且单测注入 makeClient 桩不会走到这条默认实现——2026-08-26 验收实测抓出）。
  async function defaultConnect(server) {
    const sdk = {
      Client: require('@modelcontextprotocol/sdk/client').Client,
      StdioClientTransport: require('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport,
    };
    let StreamableHTTP = null; let SseTransport = null;
    try { StreamableHTTP = require('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport; } catch (_) {}
    try { SseTransport = require('@modelcontextprotocol/sdk/client/sse.js').SSEClientTransport; } catch (_) {}
    const client = new sdk.Client({ name: 'tangbao', version: '1.0.0' });
    let transport;
    if (server.transport === 'http') {
      if (!StreamableHTTP && !SseTransport) throw new Error('当前 SDK 不支持 http 传输');
      transport = new (StreamableHTTP || SseTransport)(new URL(server.url));
    } else {
      // 防御性归一化（2026-08-26）：win32 下统一为正斜杠，消除依赖链对路径形态的潜在敏感性
      // （Windows API 对两种斜杠等价，用户两种写法都可用）。
      let spawnCommand = String(server.command);
      const spawnArgs = Array.isArray(server.args) ? server.args.map(String) : [];
      if (process.platform === 'win32') {
        spawnCommand = spawnCommand.replace(/\\/g, '/');
        for (let i = 0; i < spawnArgs.length; i++) spawnArgs[i] = spawnArgs[i].replace(/\\/g, '/');
      }
      transport = new sdk.StdioClientTransport({
        command: spawnCommand,
        args: spawnArgs,
      });
    }
    await client.connect(transport);
    return client;
  }

  const connectFn = (deps && typeof deps.makeClient === 'function') ? deps.makeClient : defaultConnect;

  async function getClient(server) {
    const existing = clients.get(server.id);
    if (existing && existing.client && !existing.error) return existing;
    // 重建前清理旧连接
    if (existing) { try { await existing.client.close(); } catch (_) {} clients.delete(server.id); }

    const entry = { client: null, server, error: '', toolsCount: -1 };
    try {
      entry.client = await withTimeout(Promise.resolve(connectFn(server)), DEFAULT_TIMEOUT_MS, '连接 ' + server.id);
      if (!entry.client) throw new Error('connect 返回空客户端');
      clients.set(server.id, entry);
    } catch (e) {
      entry.error = e && e.message ? e.message : String(e);
      entry.client = null;
      clients.set(server.id, entry);
    }
    return entry;
  }

  function status() {
    const out = [];
    for (const server of enabledServers()) {
      const e = clients.get(server.id);
      out.push({ id: server.id, name: server.name || server.id, transport: server.transport,
        connected: !!(e && e.client && !e.error), toolsCount: e ? e.toolsCount : -1, error: e ? e.error : '' });
    }
    return { ok: true, servers: out };
  }

  async function listTools(input) {
    const serverId = String((input && input.serverId) || '');
    const server = findServer(serverId);
    if (!server) return { ok: false, error: '未找到已启用的 MCP server: ' + serverId };
    const entry = await getClient(server);
    if (!entry.client) return { ok: false, error: entry.error || '连接失败' };
    const res = await withTimeout(entry.client.listTools(), DEFAULT_TIMEOUT_MS, 'listTools');
    const tools = (res && Array.isArray(res.tools) ? res.tools : []).map((tl) => ({
      name: tl.name, description: tl.description || '', inputSchema: tl.inputSchema || {},
    }));
    entry.toolsCount = tools.length;
    return { ok: true, tools };
  }

  async function callTool(input) {
    const serverId = String((input && input.serverId) || '');
    const toolName = String((input && input.name) || '').slice(0, 200);
    const args = (input && input.arguments && typeof input.arguments === 'object') ? input.arguments : {};
    const server = findServer(serverId);
    if (!server) return { ok: false, error: '未找到已启用的 MCP server: ' + serverId };
    const entry = await getClient(server);
    if (!entry.client) return { ok: false, error: entry.error || '连接失败' };
    const raw = await withTimeout(entry.client.callTool({ name: toolName, arguments: args }), Math.max(DEFAULT_TIMEOUT_MS, Number(server.timeoutMs) || 60000), 'callTool');
    const parts = [];
    if (raw && Array.isArray(raw.content)) {
      for (const piece of raw.content) {
        if (piece && piece.type === 'text') parts.push(String(piece.text || ''));
        else if (piece && piece.type !== 'text') parts.push('[' + String(piece.type || 'unknown') + ' 内容]');
      }
    }
    let text = parts.join('\n');
    if (text.length > 200 * 1024) text = text.slice(0, 200 * 1024) + '\n…（输出已截断）';
    if (raw && raw.isError) return { ok: false, error: { code: 'mcp_tool_error', message: text || 'MCP 工具报告错误' }, retryable: true };
    return { ok: true, summary: text, truncated: false };
  }

  async function closeAll() {
    for (const [, entry] of clients) { try { if (entry.client) await entry.client.close(); } catch (_) {} }
    clients.clear();
  }

  safeHandle('mcp:status', async () => status());
  // v1.2.0 批次 5-③C：项目级 .mcp.json 合并——项目同名 id 覆盖全局
  safeHandle('mcp:effectiveServers', async (_e, input) => {
    const rootPath = String((input && input.projectRoot) || '');
    let project = [];
    if (rootPath) {
      try { project = readProjectMcpJson(rootPath); } catch (_) { project = []; }
    }
    return { ok: true, servers: mergeServers(enabledServers(), project) };
  });
  safeHandle('mcp:listTools', async (_e, input) => {
    try { return await listTools(input); }
    catch (error) { return { ok: false, error: error && error.message ? error.message : String(error) }; }
  });
  safeHandle('mcp:callTool', async (_e, input) => {
    try { return await callTool(input); }
    catch (error) { return { ok: false, error: error && error.message ? error.message : String(error) }; }
  });

  function effectiveServers(rootPath) {
    let project = [];
    if (rootPath) { try { project = readProjectMcpJson(rootPath); } catch (_) { project = []; } }
    return mergeServers(enabledServers(), project);
  }

  // 聚合全部启用 server 的工具清单（供模型工具列表动态追加）
  async function listAllTools() {
    const out = [];
    for (const server of enabledServers()) {
      try {
        const entry = await getClient(server);
        if (!entry.client) continue;
        const r = await withTimeout(entry.client.listTools(), DEFAULT_TIMEOUT_MS, 'listTools');
        for (const tl of ((r && r.tools) || [])) out.push({ serverId: server.id, name: tl.name, description: tl.description || '', inputSchema: tl.inputSchema || {} });
      } catch (_) {}
    }
    return out;
  }

  const api = { status, listTools, callTool, closeAll, effectiveServers, listAllTools };
  ACTIVE = api;
  return api;
}

// ===== 项目级 .mcp.json（官方通用格式：{ "mcpServers": { "<id>": { command/args | url } } }）=====
function normalizeOneServer(id, item) {
  const o = item && typeof item === 'object' ? item : {};
  const url = typeof o.url === 'string' ? o.url.trim() : '';
  const command = typeof o.command === 'string' ? o.command.trim() : '';
  const transport = url && /^https?:\/\//.test(url) ? 'http' : 'stdio';
  if (transport === 'http' ? !url : !command) return null;
  const args = Array.isArray(o.args) ? o.args.map(String).slice(0, 32) : [];
  return {
    id: String(id || '').slice(0, 64),
    name: typeof o.name === 'string' ? o.name.slice(0, 80) : String(id || ''),
    transport,
    command,
    args,
    url,
    enabled: o.enabled !== false && o.disabled !== true,
  };
}

/** 解析项目根下的 .mcp.json 文本 → 规范化 server 数组；JSON 损坏抛错由调用方决定策略 */
function parseProjectMcpJson(rawText) {
  const obj = JSON.parse(String(rawText || '{}'));
  const map = (obj && obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers))
    ? obj.mcpServers
    : {};
  const out = [];
  for (const id of Object.keys(map)) {
    const n = normalizeOneServer(id, map[id]);
    if (n) out.push(n);
  }
  return out;
}

/** 读取 <projectRoot>/.mcp.json；文件不存在返回 [] */
function readProjectMcpJson(projectRoot) {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(String(projectRoot || ''), '.mcp.json');
  if (!fs.existsSync(file)) return [];
  return parseProjectMcpJson(fs.readFileSync(file, 'utf8'));
}

/** 合并：项目级按 id 覆盖全局 */
function mergeServers(globalServers, projectServers) {
  const g = Array.isArray(globalServers) ? globalServers.slice() : [];
  const p = Array.isArray(projectServers) ? projectServers : [];
  for (const ps of p) {
    const i = g.findIndex((s) => s.id === ps.id);
    if (i >= 0) g[i] = ps; else g.push(ps);
  }
  return g;
}

function getActiveMcp(){ return ACTIVE; }

module.exports = { createMainMcp, getActiveMcp, DEFAULT_MCP_TIMEOUT_MS: DEFAULT_TIMEOUT_MS, _projectMcp: { parseProjectMcpJson, readProjectMcpJson, mergeServers } };
