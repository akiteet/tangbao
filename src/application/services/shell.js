'use strict';
/* 系统/外壳服务：文件登记、目录选择、外部打开、子窗口、标题栏 */
(function () {
  App.services = App.services || {};
  App.services.shell = {
    registerLocalFile(absPath) {
      try { return (window.electron && window.electron.registerLocalFile) ? window.electron.registerLocalFile(absPath) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    registerWorkspace(absPath, name) {
      try { return (window.electron && window.electron.registerWorkspace) ? window.electron.registerWorkspace(absPath, name) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    showDirDialog() {
      try { return (window.electron && window.electron.showDirDialog) ? window.electron.showDirDialog() : { ok: false }; } catch (e) { return { ok: false }; }
    },
    openExternal(url) {
      try { return (window.electron && window.electron.openExternal) ? window.electron.openExternal(url) : null; } catch (e) { return null; }
    },
    openPath(absPath) {
      try { return (window.electron && window.electron.openPath) ? window.electron.openPath(absPath) : null; } catch (e) { return null; }
    },
    openChildWindow(opts) {
      try { return (window.electron && window.electron.openChildWindow) ? window.electron.openChildWindow(opts) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    setTitleBarOverlay(opts) {
      try { if (window.electron && window.electron.setTitleBarOverlay) window.electron.setTitleBarOverlay(opts); } catch (e) { /* ignore */ }
    },
  };
})();
