'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXPECTED = '1.1.4';

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  assert(pkg.version === EXPECTED, 'package.json version must be ' + EXPECTED);
  assert(lock.version === EXPECTED, 'package-lock.json version must be ' + EXPECTED);
  assert(lock.packages && lock.packages[''] && lock.packages[''].version === EXPECTED, 'lockfile root version must be ' + EXPECTED);

  const required = [
    ['src/core/agent-runtime/benchmark-harness.js', "reportVersion: 2"],
    ['src/core/agent-runtime/role-registry.js', "version: '1.1.4'"],
    ['src/infrastructure/agent-runtime/agent-runtime-engine.js', "const RUNTIME_VERSION = '1.1.4'"],
    ['.github/workflows/macos-release.yml', 'default: v1.1.4'],
    ['README.md', 'v1.1.4'],
    ['README.en.md', 'v1.1.4'],
  ];
  for (const [file, anchor] of required) {
    const content = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert(content.includes(anchor), file + ' is missing current version anchor ' + anchor);
  }
  console.log(JSON.stringify({ ok: true, version: EXPECTED, checked: required.map((item) => item[0]) }, null, 2));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error('[check:version] ' + (error.message || error)); process.exitCode = 1; }
}

module.exports = { EXPECTED, main };
