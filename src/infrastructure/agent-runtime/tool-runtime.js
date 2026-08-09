'use strict';

const { ToolRegistry } = require('../../core/agent-runtime/tool-registry');

const DEFAULT_CAPABILITIES = Object.freeze([
  'agent.spawn',
  'workspace.read',
  'workspace.write',
  'process.exec',
  'git.read',
  'git.write',
  'skill.exec',
  'verification.run',
]);

function createToolRuntime(options) {
  const opts = options || {};
  const definitions = Array.isArray(opts.definitions) ? opts.definitions : [];
  const writable = new Set(Array.isArray(opts.writeToolNames) ? opts.writeToolNames.map(String) : []);
  const dispatch = typeof opts.dispatch === 'function' ? opts.dispatch : async () => ({ ok: false, error: { code: 'tool_dispatch_missing', message: 'tool dispatch is not configured', retryable: false } });
  const registry = new ToolRegistry({ version: opts.version, definitions: [] });
  for (const protocolTool of definitions) {
    const fn = protocolTool && protocolTool.function;
    if (!fn || !fn.name) continue;
    const name = String(fn.name);
    registry.register({
      name,
      version: String(opts.toolVersion || opts.version || '1.1.2'),
      description: fn.description || '',
      inputSchema: fn.parameters || { type: 'object', properties: {} },
      risk: writable.has(name) ? 'high' : (name === 'run_subagent' ? 'medium' : 'low'),
      readOnly: !writable.has(name),
      requiredCapabilities: name === 'run_subagent' ? ['agent.spawn'] : [],
      allowedRoles: [],
      timeout: name === 'web_search' ? 8000 : 0,
      rootScope: name === 'web_search' ? 'none' : 'workspace',
      telemetryKind: name === 'run_subagent' ? 'subagent' : 'tool_call',
      handler: (args, context) => dispatch(name, args, Object.assign({
        role: 'main',
        capabilities: DEFAULT_CAPABILITIES,
      }, context || {})),
    });
  }
  return {
    registry,
    tools: registry.toOpenAITools(),
    toolNames: new Set(registry.list().map((tool) => tool.name)),
    snapshot: () => registry.snapshot(),
  };
}

module.exports = { createToolRuntime, DEFAULT_CAPABILITIES };
