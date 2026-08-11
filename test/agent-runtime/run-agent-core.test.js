'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgent } = require('../../src/core/agent-runtime/run-agent');
const { ToolRegistry } = require('../../src/core/agent-runtime/tool-registry');

function registry(handler) {
  return new ToolRegistry({ version: 'test/1', definitions: [{
    name: 'inspect',
    version: '1.0.0',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    readOnly: true,
    allowedRoles: ['main'],
    requiredCapabilities: [],
    handler: handler || (async (args) => ({ ok: true, value: args.value })),
  }] });
}

function textResponse(content, extra) {
  return Object.assign({ content, usage: { inputTokens: 10, outputTokens: 4 } }, extra || {});
}

test('runAgent completes through the injected model boundary and records request ids', async () => {
  const metrics = [];
  const result = await runAgent({ runId: 'run-complete', prompt: 'hello', maxSteps: 2 }, {
    toolRegistry: registry(),
    modelCall: async () => textResponse('done'),
    recordModelCallMetric: (metric) => metrics.push(metric),
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.content, 'done');
  assert.equal(metrics.length, 1);
  assert.ok(metrics[0].requestId);
  assert.equal(metrics[0].inputTokens, 10);
  assert.equal(metrics[0].cache.cacheReadTokens, null);
  assert.ok(result.events.some((event) => event.type === 'llm_call'));
});

test('runAgent dispatches tools and classifies tool failures', async () => {
  let calls = 0;
  const result = await runAgent({ runId: 'run-tool', prompt: 'inspect', maxSteps: 3 }, {
    toolRegistry: registry(async () => {
      calls++;
      return { ok: false, error: { type: 'tool_failure', code: 'fixture_failed', message: 'fixture failed', recoverable: true } };
    }),
    modelCall: async ({ step }) => step === 0
      ? textResponse('', { toolCalls: [{ id: 'call-1', name: 'inspect', arguments: JSON.stringify({ value: 'x' }) }] })
      : textResponse('finished'),
  });

  assert.equal(result.status, 'completed');
  assert.equal(calls, 1);
  assert.equal(result.usage.failures, 1);
  assert.ok(result.events.some((event) => event.type === 'tool_call' && event.payload.status === 'failed'));
});

test('runAgent turns an empty model result into invalid_result and writes terminal state once', async () => {
  const updates = [];
  const result = await runAgent({ runId: 'run-invalid', prompt: 'empty', maxSteps: 1 }, {
    toolRegistry: registry(),
    modelCall: async () => textResponse(''),
    runStore: {
      createAgentRun() {},
      updateAgentRun(_id, patch) { updates.push(patch); },
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error.type, 'invalid_result');
  assert.equal(updates.filter((patch) => ['completed', 'failed', 'cancelled', 'budget_exhausted', 'blocked'].includes(patch.status)).length, 1);
});

test('runAgent aborts before a new call and preserves cancelled as terminal state', async () => {
  const controller = new AbortController();
  let calls = 0;
  const resultPromise = runAgent({ runId: 'run-cancel', prompt: 'cancel' }, {
    signal: controller.signal,
    toolRegistry: registry(),
    modelCall: async ({ signal }) => {
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (signal.aborted) throw signal.reason || new Error('aborted');
      return textResponse('late');
    },
  });
  controller.abort({ type: 'cancelled', code: 'user_cancelled', message: 'user cancelled', recoverable: false });
  const result = await resultPromise;

  assert.equal(result.status, 'cancelled');
  assert.equal(result.error.type, 'cancelled');
  assert.ok(calls <= 1);
});

test('runAgent aborts when token budget is exhausted', async () => {
  let calls = 0;
  const result = await runAgent({ runId: 'run-budget', prompt: 'budget', maxSteps: 2, budget: { maxInputTokens: 5 } }, {
    toolRegistry: registry(),
    modelCall: async () => { calls++; return textResponse('too large'); },
  });

  assert.equal(result.status, 'budget_exhausted');
  assert.equal(result.error.type, 'budget_exhausted');
  assert.equal(calls, 1);
  assert.equal(result.budget.exhausted, true);
});
