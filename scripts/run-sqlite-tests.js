'use strict';
/*
 * SQLite 测试 Electron 通道（v1.1.5 批次 F2）。
 *
 * better-sqlite3 按 Electron ABI 编译，纯 Node 的 npm test 无法加载原生模块，
 * storage-search-metrics 的 4 个用例因此在普通测试通道结构性跳过。
 * 本脚本以 ELECTRON_RUN_AS_NODE=1 拉起 Electron 自带的 Node 运行时（ABI 匹配）
 * 执行这些用例，与 check:electron-abi（select 1 冒烟）互补，补齐真实 DB 覆盖。
 *
 * 用法：npm run check:sqlite
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const electronBinary = require('electron'); // 在纯 Node 上下文中解析为 Electron 可执行文件路径

const TESTS = [
  'test/agent-runtime/storage-search-metrics.test.js',
  'test/agent-runtime/image-partition-persistence.test.js',
  'test/agent-runtime/schema-migration-real.test.js', // v1.2.0 批次 2：迁移真 SQLite 幂等
  'test/agent-runtime/fulltext-search.test.js', // v1.2.0 批次 4b：消息正文全文检索 + 片段窗口化
  'test/agent-runtime/usage-metrics-summary.test.js', // v1.2.0 批次 5：用量成本仪表盘聚合
  'test/agent-runtime/fts5-search.test.js', // v1.2.1 批次 5b：FTS5 全文索引（迁移 17 + 触发器同步 + MATCH 加速）
];

function main() {
  const args = ['--test', ...TESTS.map((file) => path.join(ROOT, file))];
  const result = spawnSync(electronBinary, args, {
    stdio: 'inherit',
    cwd: ROOT,
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
  });
  if (result.error) {
    console.error('[check:sqlite] 无法启动 Electron 运行时：' + result.error.message);
    process.exitCode = 1;
    return;
  }
  process.exitCode = result.status == null ? 1 : result.status;
}

if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
  // 防御：本脚本若被当作 Electron 主进程入口执行（无 RUN_AS_NODE），提示正确用法
  console.error('[check:sqlite] 请通过 npm run check:sqlite 调用（需要 ELECTRON_RUN_AS_NODE=1）');
  process.exitCode = 1;
} else {
  main();
}
