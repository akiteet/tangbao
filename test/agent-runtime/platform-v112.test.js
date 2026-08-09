'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ToolRegistry } = require('../../src/core/agent-runtime/tool-registry');
const { RoleRegistry } = require('../../src/core/agent-runtime/role-registry');
const { createBudgetManager } = require('../../src/core/agent-runtime/budget-manager');
const { createAbortLifecycle } = require('../../src/core/agent-runtime/abort-lifecycle');
const { classifyError } = require('../../src/core/agent-runtime/error-classifier');
const { prefixFingerprint, normalizeCacheMetrics, mergeCacheMetrics } = require('../../src/core/agent-runtime/model-telemetry');
const { tracePage, exportRedactedJSONL } = require('../../src/core/agent-runtime/trace-recorder');

test('ToolRegistry rejects duplicates and invalid nested schemas', () => {
  const registry = new ToolRegistry({ version: 'test' });
  const definition = {
    name: 'read_fixture',
    version: '1.0.0',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: async (args) => ({ ok: true, path: args.path }),
    readOnly: true,
    allowedRoles: ['explore'],
    requiredCapabilities: ['workspace.read'],
  };
  registry.register(definition);
  assert.throws(() => registry.register(definition), (error) => error.code === 'tool_already_registered');
  assert.throws(() => registry.register({ name: 'bad', inputSchema: { type: 'object', properties: { x: { type: 'wat' } } }, handler() { return {}; } }), (error) => error.code === 'schema_invalid');
  assert.equal(registry.snapshot().tools[0].name, 'read_fixture');
  assert.equal(registry.snapshot().fingerprint, registry.snapshot().fingerprint);
});

test('ToolRegistry enforces role/capability/schema and timeout contracts', async () => {
  const registry = new ToolRegistry({ definitions: [{
    name: 'read_fixture',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    handler: async (args) => ({ ok: true, path: args.path }),
    readOnly: true,
    allowedRoles: ['explore'],
    requiredCapabilities: ['workspace.read'],
  }, {
    name: 'slow', inputSchema: { type: 'object', properties: {} }, timeout: 10,
    handler: () => new Promise(() => {}),
  }] });
  const context = { role: 'explore', capabilities: ['workspace.read'], readOnly: true };
  assert.deepEqual(await registry.dispatch('read_fixture', { path: 'a' }, context), { ok: true, path: 'a' });
  assert.equal((await registry.dispatch('read_fixture', {}, context)).error.type, 'invalid_result');
  assert.equal((await registry.dispatch('read_fixture', { path: 'a' }, { role: 'test', capabilities: [] })).error.type, 'permission_failure');
  assert.equal((await registry.dispatch('slow', {}, context)).error.type, 'timeout');
  assert.equal((await registry.dispatch('missing', {}, context)).error.code, 'tool_not_found');
});

test('RoleRegistry derives read-only role capabilities from the tool registry', () => {
  const tools = new ToolRegistry({ definitions: [{
    name: 'inspect', inputSchema: { type: 'object', properties: {} },
    requiredCapabilities: ['workspace.read'], readOnly: true, handler: () => ({ ok: true }),
  }] });
  const roles = new RoleRegistry([{ name: 'explore', readOnly: true, capabilities: ['workspace.read'], tools: ['inspect'] }]);
  assert.equal(roles.toolsFor('explore', tools).length, 1);
  assert.equal(roles.protocolToolsFor('explore', tools)[0].function.name, 'inspect');
  assert.equal(roles.snapshot().roles[0].readOnly, true);
});

test('BudgetManager reserves child budget and settles actual spend', () => {
  const parent = createBudgetManager({ maxSteps: 10, maxInputTokens: 100, maxCostUsd: 1, reserveRatio: 0.2 });
  const child = parent.grant({ maxSteps: 5, maxInputTokens: 50, maxCostUsd: 0.5 }, { id: 'child' });
  assert.equal(child.snapshot().granted.maxSteps, 5);
  assert.equal(parent.snapshot().reserved.steps, 5);
  assert.equal(child.consume({ steps: 3, inputTokens: 20, costUsd: 0.1 }).ok, true);
  parent.settleChild(child, { steps: 3, inputTokens: 20, costUsd: 0.1 });
  const snapshot = parent.snapshot();
  assert.equal(snapshot.reserved.steps, 0);
  assert.equal(snapshot.spent.steps, 3);
  assert.equal(parent.consume({ steps: 8 }).error.type, 'budget_exhausted');
});

test('AbortLifecycle cascades and cleans up when parent or external signal aborts', () => {
  const root = createAbortLifecycle();
  const child = root.child();
  let cleaned = 0;
  child.addCleanup(() => { cleaned++; });
  root.abort({ type: 'cancelled', code: 'user_cancelled', message: 'cancelled', recoverable: false });
  assert.equal(root.signal.aborted, true);
  assert.equal(child.signal.aborted, true);
  assert.equal(child.reason.code, 'user_cancelled');
  assert.equal(cleaned, 1);

  const controller = new AbortController();
  const external = createAbortLifecycle(controller.signal);
  controller.abort(new Error('external abort'));
  assert.equal(external.aborted, true);
  assert.equal(external.reason.type, 'cancelled');
});

test('Error and cache telemetry preserve unknown values instead of inventing zeros', () => {
  const error = classifyError({ code: 'tool_timeout', message: 'late' });
  assert.equal(error.type, 'timeout');
  assert.equal(error.recommendedAction, 'reduce_scope_or_retry_with_new_budget');
  const unknown = normalizeCacheMetrics({ source: 'unknown' });
  assert.equal(unknown.cacheReadTokens, null);
  assert.equal(unknown.hitRate, null);
  assert.equal(mergeCacheMetrics([{ eligibleTokens: 10, cacheReadTokens: 5, source: 'provider' }, unknown]).hitRate, null);
  assert.notEqual(prefixFingerprint({ promptPrefix: 'a', toolsetVersion: '1' }), prefixFingerprint({ promptPrefix: 'a', toolsetVersion: '2' }));
});

test('Trace pages are filterable, paginated and redacted', () => {
  const events = [
    { id: '1', seq: 1, type: 'llm_call', createdAt: 1, payload: { status: 'completed', authorization: 'Bearer secret' } },
    { id: '2', seq: 2, type: 'tool_call', createdAt: 2, payload: { status: 'failed', token: 'hidden' } },
    { id: '3', seq: 3, type: 'cache', createdAt: 3, payload: { status: 'completed', hitRate: null } },
  ];
  const first = tracePage(events, { limit: 2, statuses: ['completed'] });
  assert.equal(first.items.length, 2);
  assert.equal(first.hasMore, false);
  const next = tracePage(events, { limit: 1, cursor: tracePage(events, { limit: 1 }).nextCursor });
  assert.equal(next.items[0].id, '2');
  assert.match(JSON.stringify(first.items), /redacted/);
  assert.doesNotMatch(exportRedactedJSONL({ events }), /Bearer secret|hidden/);
});
