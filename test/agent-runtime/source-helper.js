'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readRuntimeSource(root) {
  const base = root || path.join(__dirname, '../..');
  const runtimeDir = path.join(base, 'src/infrastructure/agent-runtime');
  return [
    fs.readFileSync(path.join(runtimeDir, 'agent-server.js'), 'utf8'),
    fs.readFileSync(path.join(runtimeDir, 'agent-runtime-engine.js'), 'utf8'),
  ].join('\n');
}

module.exports = { readRuntimeSource };
