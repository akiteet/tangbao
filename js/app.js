'use strict';
(function () {
  window.App = window.App || {};

  function boot() {
    try {
      const params = new URLSearchParams(location.search);
      const floatMode = params.get('float') === 'chat';

      if (floatMode) {
        document.body.classList.add('float-mode');
        App.__floatMode = true;
        App.__floatReady = false;
        // 浮窗透明度开关：默认不透明（可读性优先），悬停时强制不透明，点击在 1.0/0.6 间切换
        function setupFloatOpacity() {
          const btn = document.getElementById('floatOpacity');
          if (!btn || !window.electron) return;
          App.__floatOpacity = 1.0;
          const apply = (v) => { if (window.electron.setOpacity) window.electron.setOpacity(v); };
          if (window.electron.getOpacity) {
            window.electron.getOpacity().then((v) => { if (typeof v === 'number' && v > 0) App.__floatOpacity = v; }).catch(() => {});
          }
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            App.__floatOpacity = (App.__floatOpacity < 1 ? 1.0 : 0.6);
            apply(App.__floatOpacity);
          });
          document.addEventListener('mouseleave', () => apply(App.__floatOpacity));
          document.addEventListener('mouseenter', () => apply(1.0));
        }
        // 浮窗置顶切换 + 双击顶栏最大化
        function setupFloatPin() {
          const btn = document.getElementById('floatPin');
          if (!btn || !window.electron) return;
          let pinned = true; // 与 BrowserWindow alwaysOnTop 默认值一致（持久态已在创建时应用）
          btn.classList.add('active');
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            pinned = !pinned;
            btn.classList.toggle('active', pinned);
            if (window.electron.setAlwaysOnTop) window.electron.setAlwaysOnTop(pinned);
          });
          const tb = document.querySelector('.topbar');
          if (tb) tb.addEventListener('dblclick', (e) => {
            if (e.target.closest('button')) return; // 不拦截按钮点击
            if (window.electron.toggleMaximize) window.electron.toggleMaximize();
          });
        }
        // 浮窗不写本机 state.json，只把变更单向同步给主窗；且初始化完成前不发送，避免用空状态覆盖主窗。
        App.persist = function () {
          if (App.__floatReady && window.electron && window.electron.floatSync) {
            window.electron.floatSync({
              conversations: App.state.conversations,
              activeId: App.state.activeId,
              view: App.state.view,
              settings: App.state.settings,
              web: App.state.web,
              thinkLevel: App.state.thinkLevel,
            });
          }
        };
        if (window.electron && window.electron.onFloatInit) {
          window.electron.onFloatInit((raw) => {
            try {
              // 复用 loadState 的迁移逻辑：先写回 localStorage 再 loadState
              localStorage.setItem('tangbao_web_state_v1', raw);
              App.loadState();
            } catch (e) { console.error('浮窗初始化状态失败：', e); }
            App.__floatReady = true;
            App.router.go('chat');
            setupFloatOpacity();
            setupFloatPin();
            if (App.chat && App.chat.onShow) App.chat.onShow();
            const inp = document.getElementById('input');
            if (inp) setTimeout(() => inp.focus(), 0);
          });
        }
        if (window.electron && window.electron.onFloatRefresh) {
          window.electron.onFloatRefresh(() => {
            if (App.chat && App.chat.onShow) App.chat.onShow();
          });
        }
      }

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

      // 主窗监听浮窗回传的状态变更，合并并真实落盘
      if (!floatMode && window.electron && window.electron.onFloatApply) {
        window.electron.onFloatApply((s) => {
          if (!s) return;
          Object.assign(App.state, {
            conversations: s.conversations,
            activeId: s.activeId,
            view: s.view,
            settings: s.settings,
            web: s.web,
            thinkLevel: s.thinkLevel,
          });
          App.persist();
          if (App.chat && App.chat.onShow) App.chat.onShow();
          if (App.ui && App.ui.renderSidebar) App.ui.renderSidebar();
        });
      }
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
