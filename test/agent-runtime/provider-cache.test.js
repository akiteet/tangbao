'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const adapters = require('../../src/infrastructure/model-gateway/adapters');
const { normalizeModelUsage } = require('../../src/core/agent-runtime/model-telemetry');

const messages = [
  { role: 'system', content: 'stable project instructions' },
  { role: 'user', content: 'hello' },
];

test('OpenAI-compatible requests usage on streaming calls and preserves cached tokens', () => {
  const request = adapters.buildRequest('openai', {
    apiBase: 'https://relay.example.com/v1',
    model: 'gpt-4o-mini',
    messages,
    stream: true,
  });
  assert.equal(request.body.stream_options.include_usage, true);

  const usage = adapters.normalizeUsage('openai', {
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 64 },
    },
  });
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 20);
  assert.equal(usage.cacheReadTokens, 64);
  assert.equal(usage.cacheReported, true);
});

test('stream usage fragments merge without losing provider cache data', () => {
  const first = adapters.parseSSE('anthropic', 'data: ' + JSON.stringify({
    type: 'message_start',
    message: {
      usage: {
        input_tokens: 100,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 12,
      },
    },
  }), {});
  const last = adapters.parseSSE('anthropic', 'data: ' + JSON.stringify({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 9 },
  }), {});
  const merged = adapters.mergeUsage(first.usage, last.usage);

  assert.equal(merged.inputTokens, 100);
  assert.equal(merged.outputTokens, 9);
  assert.equal(merged.cacheReadTokens, 80);
  assert.equal(merged.cacheWriteTokens, 12);
  assert.equal(merged.cacheReported, true);
});

test('Gemini sends a provider cache resource and reports cachedContentTokenCount', () => {
  const request = adapters.buildRequest('gemini', {
    apiBase: 'https://generativelanguage.googleapis.com',
    apiKey: 'key',
    model: 'gemini-2.0-flash',
    messages,
    stream: true,
    cachedContentName: 'cachedContents/tangbao-test',
  });
  assert.equal(request.body.cachedContent, 'cachedContents/tangbao-test');
  assert.equal(request.body.systemInstruction, undefined);

  const usage = adapters.normalizeUsage('gemini', {
    usageMetadata: {
      promptTokenCount: 120,
      candidatesTokenCount: 12,
      cachedContentTokenCount: 96,
    },
  });
  assert.equal(usage.cacheReadTokens, 96);
  assert.equal(usage.cacheReported, true);
});

test('missing provider cache fields remain unknown instead of becoming a cache miss', () => {
  const usage = adapters.normalizeUsage('openai', {
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  });
  const telemetry = normalizeModelUsage({ adapterUsage: usage });

  assert.equal(usage.cacheReported, false);
  assert.equal(telemetry.cache.cacheReadTokens, null);
  assert.equal(telemetry.cache.cacheWriteTokens, null);
  assert.equal(telemetry.cache.hitRate, null);
  assert.equal(telemetry.cache.source, 'unknown');
});
