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
      // 上下文条 / 浮窗控制按钮（⤢ ◐ 📌 ✕）仅在本体「糖包·聊天」模块显示；
      // 糖码/糖绘/糖读/糖创/自定义等模块无聊天累积，也不应出现浮窗入口。
      const ctxBar = $('chatCtxBar');
      if (ctxBar) ctxBar.style.display = (module === 'chat') ? '' : 'none';
      const isTangbao = module === 'chat';
      ['floatBtn', 'floatOpacity', 'floatPin', 'floatClose'].forEach(id => {
        const el = $(id);
        if (el) el.style.display = isTangbao ? '' : 'none';
      });
      if (isCustom) {
        App.modules.renderCustom(module);
      } else if (App[module] && typeof App[module].onShow === 'function') {
        App[module].onShow();
      }
      App.ui.renderTopbarTitle();
      App.ui.renderSidebar();
      // v15（单状态卡）：路由切换后刷新糖码全局运行药丸可见性（糖码页内隐藏，离开后显示）
      if (App.agent && typeof App.agent.renderRunPill === 'function') App.agent.renderRunPill();
      document.getElementById('chatScroll').scrollTop = 0;
    },
    current() {
      return App.state.view || 'chat';
    },
  };
})();
