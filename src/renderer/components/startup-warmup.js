'use strict';
/*
 * 启动自检模块：应用就绪后自动预热一次「外部站点」子窗口，
 * 验证子窗口创建链路（custom:openChildWindow）在真实环境可用并完成一次真实加载，
 * 便于发现分区/UA/代理等环境问题。仅在本机 Electron 环境执行；浏览器预览环境自动跳过。
 */
(function () {
  const WARMUP_URL = 'https://ys.mihoyo.com/main/';
  const WARMUP_ID = 'genshin';
  const WARMUP_LABEL = '外部站点';

  function fire() {
    if (!window.electron || !window.electron.openChildWindow) return;
    App.services.shell.openChildWindow({ id: WARMUP_ID, url: WARMUP_URL, label: WARMUP_LABEL });
  }

  function waitBoot(tries) {
    if (window.App && App.__bootReady) { setTimeout(fire, 2500); return; }
    if (tries <= 0) return;
    setTimeout(() => waitBoot(tries - 1), 200);
  }

  waitBoot(50);
})();