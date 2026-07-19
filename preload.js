'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 仅暴露极小的受控接口给渲染进程：
//  - setTitleBarOverlay：同步标题栏叠加层颜色
//  - showDirDialog：弹出系统「选择文件夹」对话框，返回所选绝对路径（取消返回 ''）
contextBridge.exposeInMainWorld('electron', {
  setTitleBarOverlay: (opts) => ipcRenderer.send('set-titlebar-overlay', opts),
  showDirDialog: () => ipcRenderer.invoke('dialog:showDir'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openChildWindow: (opts) => ipcRenderer.invoke('custom:openChildWindow', opts),
});
