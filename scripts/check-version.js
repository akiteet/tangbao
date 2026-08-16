'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

// 版本单一来源：package.json。check 与 bump 都从这里取，发版不再需要同步改本文件的常量。
const EXPECTED = readJson('package.json').version;

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
    ['src/core/agent-runtime/benchmark-harness.js', 'reportVersion: 2'],
    ['src/core/agent-runtime/role-registry.js', "version: '" + EXPECTED + "'"],
    ['src/infrastructure/agent-runtime/agent-runtime-engine.js', "const RUNTIME_VERSION = '" + EXPECTED + "'"],
    ['.github/workflows/macos-release.yml', 'default: v' + EXPECTED],
    ['README.md', 'tangbao-' + EXPECTED + '-setup.exe'],
    ['README.en.md', 'tangbao-' + EXPECTED + '-setup.exe'],
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
