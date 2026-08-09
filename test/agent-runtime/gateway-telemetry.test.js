'use strict';

const http = require('http');
const test = require('node:test');
const assert = require('node:assert/strict');
const gateway = require('../../src/infrastructure/model-gateway/gateway');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('model gateway records non-agent model calls with unified telemetry', async () => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer provider-key');
    res.writeHead(200, { 'Content-Type': 'application/json', 'x-request-id': 'upstream-1' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }));
  });
  const upstreamPort = await listen(upstream);
  const metrics = [];
  gateway.setEndpoints([{ ref: 'telemetry-test', apiBase: `http://127.0.0.1:${upstreamPort}` }]);
  gateway.configure({ getSecret: () => 'provider-key', recordModelCallMetric: (metric) => metrics.push(metric) });
  const proxy = http.createServer((req, res) => gateway.handleGateway(req, res));
  const proxyPort = await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: 'telemetry-test',
        kind: 'chat',
        telemetry: { scope: 'documents', callType: 'document_qa' },
        payload: { model: 'mock-model', messages: [{ role: 'user', content: 'hello' }], stream: false },
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, 'ok');
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].scope, 'documents');
    assert.equal(metrics[0].callType, 'document_qa');
    assert.equal(metrics[0].inputTokens, 12);
    assert.equal(metrics[0].outputTokens, 4);
    assert.equal(metrics[0].cache.hitRate, null);
    assert.equal(metrics[0].requestId, 'upstream-1');
  } finally {
    gateway.configure({ getSecret: () => '', recordModelCallMetric: null });
    await close(proxy);
    await close(upstream);
  }
});
