'use strict';
/* 系统/外壳服务：文件登记、目录选择、外部打开、子窗口、标题栏 */
(function () {
  App.services = App.services || {};
  const failed = (error, fallback) => ({ ok: false, code: (error && error.code) || 'ipc_failed', error: (error && error.message) || fallback || '操作失败' });
  App.services.shell = {
    registerLocalFile(absPath) {
      try { return (window.electron && window.electron.registerLocalFile) ? window.electron.registerLocalFile(absPath) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    registerWorkspace(absPath, name) {
      try { return (window.electron && window.electron.registerWorkspace) ? window.electron.registerWorkspace(absPath, name) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    getWorkspace(workspaceId) {
      try { return (window.electron && window.electron.getWorkspace) ? window.electron.getWorkspace(workspaceId) : failed(null, '工作区接口不可用'); } catch (e) { return failed(e, '读取项目文件夹失败'); }
    },
    addWorkspaceRoot(workspaceId) {
      try { return (window.electron && window.electron.addWorkspaceRoot) ? window.electron.addWorkspaceRoot(workspaceId) : failed(null, '添加文件夹接口不可用'); } catch (e) { return failed(e, '添加文件夹失败'); }
    },
    removeWorkspaceRoot(workspaceId, rootId) {
      try { return (window.electron && window.electron.removeWorkspaceRoot) ? window.electron.removeWorkspaceRoot(workspaceId, rootId) : failed(null, '移除文件夹接口不可用'); } catch (e) { return failed(e, '移除文件夹失败'); }
    },
    renameWorkspaceRoot(workspaceId, rootId, name) {
      try { return (window.electron && window.electron.renameWorkspaceRoot) ? window.electron.renameWorkspaceRoot(workspaceId, rootId, name) : failed(null, '重命名文件夹接口不可用'); } catch (e) { return failed(e, '重命名文件夹失败'); }
    },
    setPrimaryWorkspaceRoot(workspaceId, rootId) {
      try { return (window.electron && window.electron.setPrimaryWorkspaceRoot) ? window.electron.setPrimaryWorkspaceRoot(workspaceId, rootId) : failed(null, '设置主文件夹接口不可用'); } catch (e) { return failed(e, '设置主文件夹失败'); }
    },
    showDirDialog() {
      try { return (window.electron && window.electron.showDirDialog) ? window.electron.showDirDialog() : failed(null, '目录选择接口不可用'); } catch (e) { return failed(e, '选择文件夹失败'); }
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
