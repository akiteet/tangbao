'use strict';
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  setTitleBarOverlay: (opts) => ipcRenderer.send('set-titlebar-overlay', opts),
  showDirDialog: () => ipcRenderer.invoke('dialog:showDir'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openChildWindow: (opts) => ipcRenderer.invoke('custom:openChildWindow', opts),
});
