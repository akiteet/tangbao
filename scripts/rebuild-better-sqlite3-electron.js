'use strict';
/*
 * better-sqlite3 双 ABI 修复（v1.2.0 批次 0 引入）。
 *
 * 项目约定：better_sqlite3.node 保持 **Electron ABI**（纯 Node 的 npm test 里
 * sqlite 用例结构性跳过，真实覆盖由 `npm run check:sqlite` 经
 * ELECTRON_RUN_AS_NODE 补齐；打包 npmRebuild:false 原样带走）。
 * 但 `npm install` / `npm rebuild better-sqlite3` 会按当前 Node ABI 重装预编译，
 * 破坏这一约定（症状：check:electron-abi 报 NODE_MODULE_VERSION 不匹配）。
 * 跑一遍本脚本即可拉回 Electron 版预编译：
 *
 *   npm run rebuild:electron
 */
const { spawnSync } = require('child_process');
const path = require('path');

function main() {
  const electronVersion = require('electron/package.json').version;
  const cwd = path.join(__dirname, '..', 'node_modules', 'better-sqlite3');
  const binJs = path.join(__dirname, '..', 'node_modules', 'prebuild-install', 'bin.js');
  console.log('[rebuild:electron] better-sqlite3 -> electron v' + electronVersion);
  const result = spawnSync(process.execPath, [binJs, '--runtime=electron', '--target=' + electronVersion], {
    stdio: 'inherit',
    cwd,
  });
  if (result.error) {
    console.error('[rebuild:electron] ' + result.error.message);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status == null ? 1 : result.status;
}

main();
