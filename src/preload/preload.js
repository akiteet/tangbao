'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // 本地服务端口（系统随机分配，仅绑定 127.0.0.1）；渲染进程启动时取一次
  serverPorts: () => ipcRenderer.invoke('app:ports'),
  // 密钥库：只有「写 / 删 / 问存不存在」，故意没有 getSecret —— 渲染进程永远拿不回明文。
  // 真正用密钥的地方（模型网关、糖码后端）都在主进程内直接读。
  setSecret: (ref, value) => ipcRenderer.invoke('secrets:set', ref, value),
  deleteSecret: (ref) => ipcRenderer.invoke('secrets:delete', ref),
  deleteSecretsByPrefix: (prefix) => ipcRenderer.invoke('secrets:deletePrefix', prefix),
  listSecrets: () => ipcRenderer.invoke('secrets:list'),
  // 同步「密钥引用 → API Base」映射表给模型网关（渲染进程只能指定 ref，指定不了转发目标）
  setGatewayEndpoints: (list) => ipcRenderer.invoke('gateway:setEndpoints', list),
  // M5：把本地文件绝对路径交给主进程，换回不透明 fileId（只回 id，不回路径/内容）
  registerLocalFile: (absPath) => ipcRenderer.invoke('app:registerLocalFile', absPath),
  // M7（#253）：把工作目录绝对路径交给主进程校验+登记，换回不透明 workspaceId（只回 id，不回路径）
  registerWorkspace: (absPath, name) => ipcRenderer.invoke('app:registerWorkspace', absPath, name),
  setTitleBarOverlay: (opts) => ipcRenderer.send('set-titlebar-overlay', opts),
  showDirDialog: () => ipcRenderer.invoke('dialog:showDir'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  // 本地文件（如用户设置的本地模块）用系统关联程序打开：仅允许绝对路径，且主进程拒绝可执行后缀
  openPath: (absPath) => ipcRenderer.invoke('shell:openPath', absPath),
  openChildWindow: (opts) => ipcRenderer.invoke('custom:openChildWindow', opts),
  saveStateJSON: (jsonStr) => ipcRenderer.invoke('fs:writeState', jsonStr),
  // 读取磁盘 state.json（与端口无关，用于随机端口下稳定恢复数据）
  loadStateJSON: () => ipcRenderer.invoke('fs:readState'),
  // 浮窗（系统级独立置顶小窗）
  openFloat: () => ipcRenderer.invoke('float:open'),
  closeFloat: () => ipcRenderer.invoke('float:close'),
  floatSync: (s) => ipcRenderer.send('float:sync', s),
  floatRefresh: () => ipcRenderer.invoke('float:refresh'),
  onFloatInit: (cb) => ipcRenderer.on('float:init', (e, raw) => cb(raw)),
  onFloatApply: (cb) => ipcRenderer.on('float:apply', (e, s) => cb(s)),
  onFloatRefresh: (cb) => ipcRenderer.on('float:refresh', () => cb()),
  // 浮窗透明度：setOpacity 立即生效，getOpacity 读取当前值
  setOpacity: (v) => ipcRenderer.invoke('float:setOpacity', v),
  getOpacity: () => ipcRenderer.invoke('float:getOpacity'),
  // 浮窗置顶开关 + 双击最大化
  setAlwaysOnTop: (on) => ipcRenderer.invoke('float:setAlwaysOnTop', on),
  toggleMaximize: () => ipcRenderer.invoke('float:toggleMaximize'),
});
