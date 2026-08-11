'use strict';
/* 浮窗服务：系统级独立置顶小窗（开关/状态/透明度/置顶/事件订阅） */
(function () {
  App.services = App.services || {};
  App.services.float = {
    open() {
      try { return (window.electron && window.electron.openFloat) ? window.electron.openFloat() : null; } catch (e) { return null; }
    },
    close() {
      try { return (window.electron && window.electron.closeFloat) ? window.electron.closeFloat() : null; } catch (e) { return null; }
    },
    sync(s) {
      try { if (window.electron && window.electron.floatSync) window.electron.floatSync(s); } catch (e) { /* ignore */ }
    },
    pushState(payload) {
      try { if (window.electron && window.electron.pushFloatState) window.electron.pushFloatState(payload); } catch (e) { /* ignore */ }
    },
    refresh() {
      try { return (window.electron && window.electron.floatRefresh) ? window.electron.floatRefresh() : null; } catch (e) { return null; }
    },
    onInit(cb) {
      try { if (window.electron && window.electron.onFloatInit) window.electron.onFloatInit(cb); } catch (e) { /* ignore */ }
    },
    onApply(cb) {
      try { if (window.electron && window.electron.onFloatApply) window.electron.onFloatApply(cb); } catch (e) { /* ignore */ }
    },
    onState(cb) {
      try { if (window.electron && window.electron.onFloatState) window.electron.onFloatState(cb); } catch (e) { /* ignore */ }
    },
    onRefresh(cb) {
      try { if (window.electron && window.electron.onFloatRefresh) window.electron.onFloatRefresh(cb); } catch (e) { /* ignore */ }
    },
    setOpacity(v) {
      try { if (window.electron && window.electron.setOpacity) window.electron.setOpacity(v); } catch (e) { /* ignore */ }
    },
    getOpacity() {
      try { return (window.electron && window.electron.getOpacity) ? window.electron.getOpacity() : Promise.resolve(1); } catch (e) { return Promise.resolve(1); }
    },
    setAlwaysOnTop(on) {
      try { if (window.electron && window.electron.setAlwaysOnTop) window.electron.setAlwaysOnTop(on); } catch (e) { /* ignore */ }
    },
    toggleMaximize() {
      try { if (window.electron && window.electron.toggleMaximize) window.electron.toggleMaximize(); } catch (e) { /* ignore */ }
    },
  };
})();
