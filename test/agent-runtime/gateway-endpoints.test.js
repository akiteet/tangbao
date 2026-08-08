'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../../src/infrastructure/model-gateway/gateway');

test('B2：setEndpoints 拦截云元数据地址', () => {
  const n = G.setEndpoints([
    { ref: 'acc:evil', apiBase: 'http://169.254.169.254/latest/meta-data' },
    { ref: 'acc:ok', apiBase: 'https://api.openai.com/v1' },
  ]);
  assert.equal(n, 1, '元数据地址应被丢弃');
  assert.equal(G.getEndpoint('acc:evil'), '', '不应注册元数据端点');
  assert.equal(G.getEndpoint('acc:ok'), 'https://api.openai.com/v1', '正常端点应保留');
});

test('B2：setEndpoints 拦截非法协议与 metadata 主机，放行本地 Ollama', () => {
  const n = G.setEndpoints([
    { ref: 'a', apiBase: 'file:///etc/passwd' },
    { ref: 'b', apiBase: 'http://metadata.google.internal/computeMetadata/v1' },
    { ref: 'c', apiBase: 'http://169.254.170.2' },
    { ref: 'd', apiBase: 'https://127.0.0.1:11434' }, // 本地 Ollama 是合法用法
    { ref: 'e', apiBase: 'not-a-url' },
  ]);
  assert.equal(n, 1);
  assert.equal(G.getEndpoint('d'), 'https://127.0.0.1:11434');
});

test('B2：setEndpoints 数量上限 64', () => {
  const list = Array.from({ length: 80 }, (_, i) => ({ ref: 'r' + i, apiBase: 'https://x.example.com/' + i }));
  const n = G.setEndpoints(list);
  assert.equal(n, 64, '超过 64 应截断');
});
