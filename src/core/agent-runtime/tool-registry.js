'use strict';

const crypto = require('crypto');
const { classifyError } = require('./error-classifier');
const { clone } = require('../util/clone');

const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);
const TYPE_NAMES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function protocolToDefinition(input, fallback) {
  const source = input && input.function ? Object.assign({}, input.function, { type: input.type }) : input || {};
  const base = fallback || {};
  const parameters = source.inputSchema || source.parameters || { type: 'object', properties: {} };
  return Object.assign({}, base, source, {
    name: String(source.name || base.name || ''),
    version: String(source.version || base.version || '1.0.0'),
    inputSchema: parameters,
    handler: source.handler || base.handler,
    risk: String(source.risk || base.risk || 'low'),
    requiredCapabilities: Array.isArray(source.requiredCapabilities) ? source.requiredCapabilities.slice() : (Array.isArray(base.requiredCapabilities) ? base.requiredCapabilities.slice() : []),
    allowedRoles: Array.isArray(source.allowedRoles) ? source.allowedRoles.slice() : (Array.isArray(base.allowedRoles) ? base.allowedRoles.slice() : []),
    readOnly: source.readOnly != null ? !!source.readOnly : base.readOnly !== false,
    timeout: Number(source.timeout || base.timeout) || 0,
    rootScope: source.rootScope || base.rootScope || 'workspace',
    telemetryKind: String(source.telemetryKind || base.telemetryKind || 'tool_call'),
  });
}

function validateSchemaDefinition(schema, path) {
  const node = schema || { type: 'object' };
  const at = path || '$';
  if (!node || typeof node !== 'object' || Array.isArray(node)) return { ok: false, code: 'schema_invalid', message: at + ': schema must be an object' };
  if (node.type && !TYPE_NAMES.has(node.type)) return { ok: false, code: 'schema_invalid', message: at + ': unsupported schema type ' + node.type };
  if (node.enum != null && !Array.isArray(node.enum)) return { ok: false, code: 'schema_invalid', message: at + '.enum: expected array' };
  if (node.required != null && (!Array.isArray(node.required) || node.required.some((key) => typeof key !== 'string'))) return { ok: false, code: 'schema_invalid', message: at + '.required: expected string array' };
  if (node.type === 'object' && node.properties != null) {
    if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) return { ok: false, code: 'schema_invalid', message: at + '.properties: expected object' };
    for (const [key, child] of Object.entries(node.properties)) {
      const result = validateSchemaDefinition(child, at + '.' + key);
      if (!result.ok) return result;
    }
  }
  if (node.type === 'array' && node.items != null) {
    const result = validateSchemaDefinition(node.items, at + '.items');
    if (!result.ok) return result;
  }
  return { ok: true };
}

function validateSchema(schema, value, path) {
  const node = schema || { type: 'object' };
  const at = path || '$';
  if (node.type && !TYPE_NAMES.has(node.type)) return { ok: false, code: 'schema_invalid', message: at + ': unsupported schema type ' + node.type };
  if (node.enum && !node.enum.some((item) => stable(item) === stable(value))) return { ok: false, code: 'invalid_arguments', message: at + ': value is not in enum' };
  if (node.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'invalid_arguments', message: at + ': expected object' };
    for (const key of node.required || []) if (!(key in value)) return { ok: false, code: 'invalid_arguments', message: at + '.' + key + ': is required' };
    for (const [key, child] of Object.entries(node.properties || {})) if (key in value) {
      const result = validateSchema(child, value[key], at + '.' + key);
      if (!result.ok) return result;
    }
    if (node.additionalProperties === false) for (const key of Object.keys(value)) if (!node.properties || !Object.prototype.hasOwnProperty.call(node.properties, key)) return { ok: false, code: 'invalid_arguments', message: at + '.' + key + ': is not allowed' };
  } else if (node.type === 'array') {
    if (!Array.isArray(value)) return { ok: false, code: 'invalid_arguments', message: at + ': expected array' };
    if (node.maxItems != null && value.length > Number(node.maxItems)) return { ok: false, code: 'invalid_arguments', message: at + ': too many items' };
    for (let i = 0; i < value.length; i++) { const result = validateSchema(node.items, value[i], at + '[' + i + ']'); if (!result.ok) return result; }
  } else if (node.type === 'string' && typeof value !== 'string') return { ok: false, code: 'invalid_arguments', message: at + ': expected string' };
  else if (node.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return { ok: false, code: 'invalid_arguments', message: at + ': expected number' };
  else if (node.type === 'integer' && (!Number.isInteger(value))) return { ok: false, code: 'invalid_arguments', message: at + ': expected integer' };
  else if (node.type === 'boolean' && typeof value !== 'boolean') return { ok: false, code: 'invalid_arguments', message: at + ': expected boolean' };
  else if (node.type === 'null' && value !== null) return { ok: false, code: 'invalid_arguments', message: at + ': expected null' };
  return { ok: true };
}

function contextAllows(definition, context) {
  const ctx = context || {};
  const role = String(ctx.role || 'main');
  const roles = definition.allowedRoles || [];
  if (roles.length && !roles.includes(role)) return { ok: false, error: classifyError({ type: 'permission_failure', code: 'role_not_allowed', message: 'role ' + role + ' cannot use ' + definition.name, recoverable: false }) };
  const required = definition.requiredCapabilities || [];
  const capabilities = new Set(Array.isArray(ctx.capabilities) ? ctx.capabilities : []);
  const missing = required.filter((capability) => !capabilities.has(capability));
  if (missing.length) return { ok: false, error: classifyError({ type: 'permission_failure', code: 'capability_missing', message: 'missing capabilities: ' + missing.join(', '), recoverable: false }) };
  if (ctx.readOnly === true && definition.readOnly === false) return { ok: false, error: classifyError({ type: 'permission_failure', code: 'read_only_role_denied', message: 'read-only context cannot use ' + definition.name, recoverable: false }) };
  if (ctx.permission && typeof ctx.permission === 'function') {
    const result = ctx.permission(definition, ctx);
    if (result === false || result && result.ok === false) return { ok: false, error: classifyError(result && result.error || { type: 'permission_failure', code: 'permission_denied', message: 'tool permission denied', recoverable: false }) };
  }
  return { ok: true };
}

class ToolRegistry {
  constructor(options) {
    const opts = options || {};
    this.version = String(opts.version || '1.1.2');
    this.tools = new Map();
    this.registrationOrder = [];
    for (const definition of opts.definitions || []) this.register(definition);
  }

  register(input) {
    const definition = protocolToDefinition(input);
    if (!definition.name) throw Object.assign(new Error('tool_name_required'), { code: 'tool_name_required' });
    if (!definition.handler || typeof definition.handler !== 'function') throw Object.assign(new Error('tool_handler_required'), { code: 'tool_handler_required' });
    if (!RISK_LEVELS.includes(definition.risk)) throw Object.assign(new Error('invalid_tool_risk'), { code: 'invalid_tool_risk' });
    const schema = validateSchemaDefinition(definition.inputSchema);
    if (!schema.ok) throw Object.assign(new Error(schema.message), { code: schema.code });
    if (this.tools.has(definition.name)) throw Object.assign(new Error('tool_already_registered: ' + definition.name), { code: 'tool_already_registered' });
    const normalized = Object.freeze(Object.assign({}, definition, { inputSchema: clone(definition.inputSchema), requiredCapabilities: Object.freeze(definition.requiredCapabilities.slice()), allowedRoles: Object.freeze(definition.allowedRoles.slice()) }));
    this.tools.set(definition.name, normalized);
    this.registrationOrder.push(definition.name);
    return normalized;
  }

  resolve(name, context) {
    const definition = this.tools.get(String(name || ''));
    if (!definition) return null;
    const allowed = contextAllows(definition, context);
    if (!allowed.ok) throw Object.assign(new Error(allowed.error.message), allowed.error, { code: allowed.error.code });
    return definition;
  }

  list(filter) {
    const f = filter || {};
    return this.registrationOrder.map((name) => this.tools.get(name)).filter((definition) => {
      if (f.name && definition.name !== f.name) return false;
      if (f.risk && definition.risk !== f.risk) return false;
      if (f.readOnly != null && definition.readOnly !== !!f.readOnly) return false;
      if (f.telemetryKind && definition.telemetryKind !== f.telemetryKind) return false;
      if (f.role && definition.allowedRoles.length && !definition.allowedRoles.includes(f.role)) return false;
      if (f.capability && !definition.requiredCapabilities.includes(f.capability)) return false;
      return true;
    });
  }

  async dispatch(name, args, context) {
    const ctx = context || {};
    let definition;
    try { definition = this.resolve(name, ctx); } catch (error) { return { ok: false, error: classifyError(error, { type: 'permission_failure' }) }; }
    if (!definition) return { ok: false, error: classifyError({ type: 'tool_failure', code: 'tool_not_found', message: 'tool not found: ' + name, recoverable: false }) };
    const validation = validateSchema(definition.inputSchema, args == null ? {} : args);
    if (!validation.ok) return { ok: false, error: classifyError({ type: 'invalid_result', code: validation.code, message: validation.message, recoverable: false }) };
    if (ctx.signal && ctx.signal.aborted) return { ok: false, error: classifyError({ type: 'cancelled', code: 'cancelled', message: 'tool dispatch cancelled', recoverable: false }) };
    let timer = null;
    const controller = new AbortController();
    let unlink = () => {};
    let cancelResolve = null;
    const cancelled = new Promise((resolve) => { cancelResolve = resolve; });
    if (ctx.signal) {
      const abort = () => {
        try { controller.abort(ctx.signal.reason); } catch (_) { try { controller.abort(); } catch (_) {} }
        cancelResolve({ ok: false, error: classifyError({ type: 'cancelled', code: 'cancelled', message: 'tool dispatch cancelled', recoverable: false }) });
      };
      if (ctx.signal.aborted) abort();
      else ctx.signal.addEventListener('abort', abort, { once: true });
      unlink = () => ctx.signal.removeEventListener('abort', abort);
    }
    const timeoutMs = Number(ctx.timeoutMs || definition.timeout) || 0;
    const timeoutError = timeoutMs ? classifyError({ type: 'timeout', code: 'tool_timeout', message: 'tool timed out after ' + timeoutMs + 'ms', recoverable: true }) : null;
    const timeout = timeoutMs ? new Promise((resolve) => { timer = setTimeout(() => { try { controller.abort(timeoutError); } catch (_) {} resolve({ ok: false, error: timeoutError }); }, timeoutMs); }) : null;
    const invoke = Promise.resolve().then(() => definition.handler(args == null ? {} : args, Object.assign({}, ctx, { tool: definition, signal: controller.signal })));
    try {
      const result = timeout ? await Promise.race([invoke, timeout, cancelled]) : (ctx.signal ? await Promise.race([invoke, cancelled]) : await invoke);
      if (!result || typeof result !== 'object') return { ok: false, error: classifyError({ type: 'invalid_result', code: 'tool_result_invalid', message: 'tool handler must return an object', recoverable: false }) };
      return result;
    } catch (error) {
      return { ok: false, error: classifyError(error, { type: 'tool_failure', code: 'tool_handler_failed' }) };
    } finally { if (timer) clearTimeout(timer); unlink(); }
  }

  toOpenAITools(filter) {
    return this.list(filter).map((definition) => ({ type: 'function', function: { name: definition.name, description: definition.description || '', parameters: clone(definition.inputSchema) } }));
  }

  snapshot() {
    const definitions = this.list().map((definition) => ({ name: definition.name, version: definition.version, inputSchema: clone(definition.inputSchema), risk: definition.risk, requiredCapabilities: definition.requiredCapabilities.slice(), allowedRoles: definition.allowedRoles.slice(), readOnly: definition.readOnly, timeout: definition.timeout, rootScope: definition.rootScope, telemetryKind: definition.telemetryKind }));
    const fingerprint = crypto.createHash('sha256').update(stable({ version: this.version, definitions })).digest('hex');
    return { version: this.version, fingerprint, tools: definitions };
  }
}

function registryFromProtocol(tools, options) {
  const opts = options || {};
  const registry = new ToolRegistry({ version: opts.version, definitions: [] });
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = tool && tool.function && tool.function.name;
    registry.register(Object.assign({}, tool && tool.function || {}, opts.defaults || {}, { name, handler: opts.handler || (async () => ({ ok: false, error: { code: 'tool_handler_missing', message: 'tool handler missing' } })) }));
  }
  return registry;
}

module.exports = { ToolRegistry, registryFromProtocol, validateSchema, validateSchemaDefinition, contextAllows, protocolToDefinition, RISK_LEVELS };
