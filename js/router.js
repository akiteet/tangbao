'use strict';
(function () {
  window.App = window.App || {};

  const $ = (id) => document.getElementById(id);

  App.router = {
    go(module) {
      // 守卫：模块不存在或内置模块被禁用 → 回退到首个启用模块
      const mod = App.modules.getById(module);
      if (!mod || (mod.type !== 'custom' && !App.modules.isEnabled(module))) {
        module = App.modules.firstEnabled();
      }
      // 用稳定 id 定位自定义区块：首次进入自定义模块后其 data-view 会被改写为模块 id，
      // 若用 [data-view="__custom"] 选择器会二次失效，导致后续自定义模块无法切换显示。
      const customSection = document.getElementById('customSection');
      const isCustom = mod && mod.type === 'custom';
      if (customSection) customSection.dataset.view = isCustom ? module : '__custom';

      App.state.view = module;
      App.persist();
      document.querySelectorAll('.view').forEach(v => {
        v.hidden = v.dataset.view !== module;
      });
      document.querySelectorAll('.nav-item').forEach(n => {
        n.classList.toggle('active', n.dataset.module === module);
      });
      // 上下文条仅在聊天/糖码显示（其他模块无对话累积）
      const ctxBar = $('chatCtxBar');
      if (ctxBar) ctxBar.style.display = (module === 'chat' || module === 'agent') ? '' : 'none';
      if (isCustom) {
        App.modules.renderCustom(module);
      } else if (App[module] && typeof App[module].onShow === 'function') {
        App[module].onShow();
      }
      App.ui.renderTopbarTitle();
      App.ui.renderSidebar();
      document.getElementById('chatScroll').scrollTop = 0;
    },
    current() {
      return App.state.view || 'chat';
    },
  };
})();
