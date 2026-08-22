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
    fs.readFileSync(path.join(runtimeDir, 'run-registry.js'), 'utf8'),
  ].join('\n');
}

// v1.1.7（批次 E）：渲染层拆分——拼接 src/renderer/views/agent/ 目录下全部 .js（按文件名排序），
// 拆分后的模块（agent-run-history.js / agent-bubbles.js 等）自动纳入断言源。
function readRendererSource(root) {
  const base = root || path.join(__dirname, '../..');
  return readDirSource(path.join(base, 'src/renderer/views/agent'));
}

// v1.1.7（批次 E）：主进程拆分——拼接 src/main/ 目录下全部 .js（按文件名排序）。
function readMainSource(root) {
  const base = root || path.join(__dirname, '../..');
  return readDirSource(path.join(base, 'src/main'));
}

// v1.1.8（批次 C）：ui.js 拆分（ui-accounts/ui-skills-panel/ui-settings-storage 等）——
// 拼接 src/renderer/components/ 目录下全部 .js，断言源自动覆盖拆分模块。
function readComponentsSource(root) {
  const base = root || path.join(__dirname, '../..');
  return readDirSource(path.join(base, 'src/renderer/components'));
}

function readDirSource(dir) {
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n');
}

module.exports = { readRuntimeSource, readRendererSource, readMainSource, readComponentsSource };
