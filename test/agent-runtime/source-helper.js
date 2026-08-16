'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readRuntimeSource(root) {
  const base = root || path.join(__dirname, '../..');
  const runtimeDir = path.join(base, 'src/infrastructure/agent-runtime');
  // v1.1.5（批次 D）：工具协议定义迁入 tool-runtime.js、HTTP 传输层拆到 agent-server-http.js，
  // 源码文本断言的「运行时源」随之覆盖这些同目录拆分模块。
  return [
    fs.readFileSync(path.join(runtimeDir, 'agent-server.js'), 'utf8'),
    fs.readFileSync(path.join(runtimeDir, 'agent-runtime-engine.js'), 'utf8'),
    fs.readFileSync(path.join(runtimeDir, 'tool-runtime.js'), 'utf8'),
    fs.readFileSync(path.join(runtimeDir, 'agent-server-http.js'), 'utf8'),
    fs.readFileSync(path.join(runtimeDir, 'search-providers.js'), 'utf8'),
  ].join('\n');
}

module.exports = { readRuntimeSource };
