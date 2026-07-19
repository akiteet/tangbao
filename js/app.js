'use strict';
(function () {
  window.App = window.App || {};

  function boot() {
    try {
      // 1) 载入本地持久化的状态（含旧版迁移）
      App.loadState();
      // 2) 应用外观（主题/强调色/圆角）
      App.ui.applyAppearance();
      // 3) 绑定全局 UI 事件（侧边栏 / 顶栏 / 设置弹窗）
      App.ui.init();
      // 4) 绑定聊天视图事件并渲染欢迎区 / 建议
      App.chat.init();
      // 5) 根据上次停留的模块进入对应视图
      App.router.go(App.state.view || 'chat');
    } catch (err) {
      console.error('糖包启动失败：', err);
      const t = document.getElementById('toast');
      if (t) {
        t.textContent = '初始化失败：' + (err && err.message ? err.message : String(err));
        t.hidden = false;
        t.classList.add('show');
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
