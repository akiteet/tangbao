'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(script) {
  const result = spawnSync(process.execPath, [path.join(__dirname, script)], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(script + ' failed:\n' + (result.stdout || '') + (result.stderr || ''));
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version; // 版本单一来源：package.json（与 check-version.js 一致）
  for (const name of ['check:version', 'check:storage', 'check:perf', 'check:electron-abi', 'check:sqlite', 'check:ui', 'bench:offline', 'check:release']) assert(pkg.scripts && pkg.scripts[name], 'missing npm script ' + name);
  assert(pkg.build && pkg.build.win && pkg.build.mac, 'Windows and macOS build targets are required');
  assert(pkg.build.win.target === 'nsis', 'Windows NSIS target is required');
  assert(Array.isArray(pkg.build.mac.target) && pkg.build.mac.target.includes('dmg') && pkg.build.mac.target.includes('zip'), 'macOS DMG/ZIP targets are required');
  for (const file of ['.github/workflows/ci.yml', '.github/workflows/macos-release.yml', 'docs/CHANGELOG-v' + version + '.md', 'docs/DATA_MODEL.md']) assert(fs.existsSync(path.join(ROOT, file)), 'missing release file ' + file);
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const macRelease = fs.readFileSync(path.join(ROOT, '.github/workflows/macos-release.yml'), 'utf8');
  const macAssetsReleasePath = path.join(ROOT, '.github/workflows/macos-release-assets.yml');
  const macAssetsRelease = fs.existsSync(macAssetsReleasePath) ? fs.readFileSync(macAssetsReleasePath, 'utf8') : '';
  const dataModel = fs.readFileSync(path.join(ROOT, 'docs/DATA_MODEL.md'), 'utf8');
  assert(ci.includes('npm run check:release') && ci.includes('electron-builder --win nsis'), 'CI must run release checks and Windows NSIS build');
  assert(ci.includes('npm run check:perf'), 'CI must run the performance contract check');
  assert(ci.includes('electron-builder --mac dmg zip') && ci.includes('shasum -a 256'), 'CI must build macOS installers and checksums');
  assert(ci.includes('npm run check:electron-abi') && ci.includes('xvfb-run -a npm run check:ui'), 'CI must verify Electron native ABI and real renderer UI');
  assert(macRelease.includes('default: v' + version) && macRelease.includes('release-assets/*.sha256'), 'macOS release workflow must target v' + version + ' and publish checksums');
  if (macAssetsRelease) assert(macAssetsRelease.includes('default: v' + version) && macAssetsRelease.includes('tangbao-v' + version + '-macos-'), 'macOS asset workflow must target v' + version);
  assert(dataModel.includes('v' + version) && dataModel.includes('activeRoot/tangbao-data'), 'data model must describe current storage layout');
  run('check-version.js');
  run('check-storage.js');
  run('check-perf.js');
  console.log(JSON.stringify({ ok: true, version: pkg.version, targets: ['win/nsis', 'mac/dmg', 'mac/zip'] }, null, 2));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error('[check:release] ' + (error.message || error)); process.exitCode = 1; }
}

module.exports = { main };
