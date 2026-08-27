'use strict';
// 应用内更新接线回归（v1.2.0 批次 3）：主进程门控 + preload 通道 + publish 配置（静态断言）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('main.js 更新门控：仅打包环境启用、不自动下载、三通道齐备', () => {
  const main = read('src/main/main.js');
  assert.ok(main.includes('function setupUpdater()'), 'setupUpdater 存在');
  // v1.2.0 迭代修复：通道无条件注册（开发态点击要得到 dev-mode 提示而非 No handler registered），
  // electron-updater 本体仍以 app.isPackaged 门控
  assert.ok(/if \(updaterStarted\) return;/.test(main), 'setupUpdater 幂等门控');
  assert.ok(/if \(app\.isPackaged\) \{/.test(main), 'electron-updater 本体仅打包环境加载');
  assert.ok(/code: app\.isPackaged \? 'updater-unavailable' : 'dev-mode'/.test(main), '不可用原因区分开发态与组件缺失');
  assert.ok(main.includes('autoUpdater.autoDownload = false'), '不自动下载（用户确认后下载）');
  assert.ok(main.includes("autoUpdater.autoInstallOnAppQuit = true"), '下载完成后退出时自动安装');
  for (const ch of ['updater:check', 'updater:download', 'updater:install']) {
    assert.ok(main.includes(`'` + ch + `'`), 'IPC 通道存在: ' + ch);
  }
  for (const ev of ['update-available', 'update-not-available', 'download-progress', 'update-downloaded']) {
    assert.ok(main.includes(`'` + ev + `'`), 'updater 事件转发: ' + ev);
  }
  assert.ok(main.includes('setupUpdater();'), 'whenReady 中已接线');
});

test('preload 暴露更新通道与版本查询，事件可退订', () => {
  const preload = read('src/preload/preload.js');
  for (const api of ['updaterCheck', 'updaterDownload', 'updaterInstall', 'getAppVersion']) {
    assert.ok(preload.includes(api + ':'), 'preload 暴露 ' + api);
  }
  assert.ok(preload.includes("ipcRenderer.on('updater:event'") && preload.includes("removeListener('updater:event'"), '事件订阅支持退订');
});

test('package.json 声明 GitHub publish 目标', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.build.publish.provider, 'github');
  assert.equal(pkg.build.publish.owner, 'akiteet');
  assert.equal(pkg.build.publish.repo, 'tangbao');
  assert.ok(pkg.dependencies['electron-updater'], 'electron-updater 为运行时依赖');
});
