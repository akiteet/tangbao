'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  setTitleBarOverlay: (opts) => ipcRenderer.send('set-titlebar-overlay', opts),
  showDirDialog: () => ipcRenderer.invoke('dialog:showDir'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openChildWindow: (opts) => ipcRenderer.invoke('custom:openChildWindow', opts),
  saveStateJSON: (jsonStr) => ipcRenderer.invoke('fs:writeState', jsonStr),
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
