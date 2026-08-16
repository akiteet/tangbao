'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const capabilities = require('../../src/core/models/capabilities');

test('promptCachingMode：claude/anthropic 走显式 cache_control，reasoning 类关闭，其余自动', () => {
  assert.equal(capabilities.promptCachingMode('claude-sonnet-4', ''), 'anthropic');
  assert.equal(capabilities.promptCachingMode('any-model', 'https://api.anthropic.com'), 'anthropic');
  assert.equal(capabilities.promptCachingMode('deepseek-r1', ''), 'off');
  assert.equal(capabilities.promptCachingMode('o1-mini', ''), 'off');
  assert.equal(capabilities.promptCachingMode('some-thinking-model', ''), 'off');
  assert.equal(capabilities.promptCachingMode('gpt-5.5', ''), 'auto');
  assert.equal(capabilities.promptCachingMode('doubao-pro', ''), 'auto');
});

test('v1.1.5（F1）：模型网关聊天路径消费能力判定，off 模型不注入 cache_control', () => {
  const gateway = fs.readFileSync(path.join(__dirname, '../../src/infrastructure/model-gateway/gateway.js'), 'utf8');
  assert.match(gateway, /capabilities\.promptCachingMode \? capabilities\.promptCachingMode\(payload\.model, base\) : 'auto'/);
  assert.match(gateway, /promptCaching: useCaching/);
  assert.match(gateway, /cachingMode !== 'off'/);
});

test('v1.1.5（F1）：糖码 engine 与网关保持同源判定（callLLMStream 仍走 promptCachingMode）', () => {
  const engine = fs.readFileSync(path.join(__dirname, '../../src/infrastructure/agent-runtime/agent-runtime-engine.js'), 'utf8');
  assert.match(engine, /cap\.promptCachingMode && cap\.promptCachingMode\(model, apiBase\) !== 'off'/);
});
