'use strict';
(function () {
  window.App = window.App || {};

  const $ = (id) => document.getElementById(id);
  const isModuleConversation = (item) => !!(item && (
    item.tavernCharacterId
    || item.originModule === 'tavern'
    || item.originModule === 'create'
  ));

  let routeRenderFrame = 0;
  let routePersistFrame = 0;
  let routeGeneration = 0;
  let hasRenderedRoute = false;

  function scheduleRoutePersist() {
    if (routePersistFrame) return;
    const persist = () => {
      routePersistFrame = 0;
      if (App.persist) App.persist();
    };
    // Keep serialization/storage work out of the frame that commits the
    // visible module switch. The existing beforeunload flush remains the
    // final durability fallback.
    routePersistFrame = setTimeout(persist, 0);
  }

  function scheduleRouteRender(render) {
    if (typeof window.requestAnimationFrame === 'function') {
      routeRenderFrame = window.requestAnimationFrame(() => {
        routeRenderFrame = 0;
        render();
      });
    } else {
      routeRenderFrame = setTimeout(() => {
        routeRenderFrame = 0;
        render();
      }, 0);
    }
  }

  App.router = {
    go(module, options) {
      const switchStarted = App.perf && App.perf.begin ? App.perf.begin() : 0;
      const routeOptions = options && typeof options === 'object' ? options : {};
      const requestedModule = String(module || '');
      const requestedDefinition = App.modules && App.modules.getById ? App.modules.getById(requestedModule) : null;
      if (!requestedDefinition || (requestedDefinition.type !== 'custom' && !App.modules.isEnabled(requestedModule))) {
        module = App.modules.firstEnabled();
      } else {
        module = requestedModule;
      }
      const currentModule = App.state.view || 'chat';
      if (currentModule === module && routeOptions.force !== true && hasRenderedRoute) return;
      const switching = currentModule !== module;
      const generation = ++routeGeneration;
      // Navigation can happen before the draft debounce fires (especially
      // when clicking a module in the global rail). Save the current surface
      // before changing activeId or moving its DOM nodes.
      if (routeOptions.skipDraftFlush !== true
        && App.chat && typeof App.chat.flushSurface === 'function') App.chat.flushSurface();
      // 糖馆与普通 Chat 共用同一组 DOM 节点；切换模块前先还原原始挂载点，
      // 流式状态仍由 Chat Runtime 持有，不因视图切换而中断。
      const surface = App.chat && typeof App.chat.surface === 'function' ? App.chat.surface() : null;
      if (surface && surface.owner !== module && App.chat && typeof App.chat.unmountSurface === 'function') {
        App.chat.unmountSurface();
      }
      // A persisted activeId may point to a Tangguan-only conversation after
      // restart. Regular Chat must start with the last valid regular session,
      // or an empty state, rather than rendering a role conversation outside
      // Tangguan.
      if (module === 'chat' && App.chat && App.chat.activeConv) {
        const active = App.chat.activeConv();
        if (active && isModuleConversation(active)) {
          const preferred = App.chat._preSurfaceActiveId || App.chat._preTangguanActiveId || App.chat._preCreateActiveId;
          const fallback = App.state.conversations.find((item) => item && !isModuleConversation(item));
          const preferredConv = preferred && App.state.conversations.find((item) => item && item.id === preferred && !isModuleConversation(item));
          App.state.activeId = (preferredConv || fallback || null)?.id || null;
        }
        App.chat._preTangguanActiveId = null;
        App.chat._preCreateActiveId = null;
        App.chat._preSurfaceActiveId = null;
      }
      if (module === 'tavern' && App.chat) {
        const active = App.chat.activeConv && App.chat.activeConv();
        if (active && !isModuleConversation(active)) App.chat._preTangguanActiveId = active.id;
      }
      if (module === 'create' && App.chat) {
        const active = App.chat.activeConv && App.chat.activeConv();
        if (active && !isModuleConversation(active)) App.chat._preCreateActiveId = active.id;
      }
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
      if (routeOptions.persist !== false) scheduleRoutePersist();
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
      // v15（单状态卡）：路由切换后刷新糖码全局运行药丸可见性（糖码页内隐藏，离开后显示）
      if (App.agent && typeof App.agent.renderRunPill === 'function') App.agent.renderRunPill();

      const render = () => {
        if (generation !== routeGeneration || App.state.view !== module) return;
        if (isCustom) {
          App.modules.renderCustom(module);
        } else if (App[module] && typeof App[module].onShow === 'function') {
          App[module].onShow();
        } else if (module === 'chat' && App.chat && typeof App.chat.onShow === 'function') {
          // Shared Chat nodes may have just returned from Tangguan/Create.
          // Rebuild the regular view so module-specific welcome markup cannot remain.
          App.chat.onShow();
        }
        App.ui.renderTopbarTitle();
        if (App.ui.scheduleSidebarRender) App.ui.scheduleSidebarRender();
        else App.ui.renderSidebar();
        const chatScroll = document.getElementById('chatScroll');
        if (chatScroll) chatScroll.scrollTop = 0;
        hasRenderedRoute = true;
        // v1.1.8 U2：通知全局（一键回到底部按钮等）重新同步当前滚动容器
        document.dispatchEvent(new CustomEvent('view:changed', { detail: { module } }));
        if (App.perf) App.perf.measure('moduleSwitchMs', switchStarted, { module: String(module || '') });
      };

      if (switching && routeOptions.deferRender !== false) scheduleRouteRender(render);
      else render();
    },
    current() {
      return App.state.view || 'chat';
    },
  };
})();
