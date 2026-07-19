'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Node.js 的 fetch 不检查 CORS，用于中转站 API 请求
async function bridgeFetch(url, { method, headers, body }) {
  const res = await fetch(url, { method, headers, body });
  // 返回一个兼容浏览器 ReadableStream 的接口
  return {
    ok: res.ok,
    status: res.status,
    headers: res.headers,
    body: res.body,        // Node.js ReadableStream，用法同浏览器
    text: () => res.text(),
    json: () => res.json(),
  };
}

contextBridge.exposeInMainWorld('electron', {
  setTitleBarOverlay: (opts) => ipcRenderer.send('set-titlebar-overlay', opts),
  showDirDialog: () => ipcRenderer.invoke('dialog:showDir'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openChildWindow: (opts) => ipcRenderer.invoke('custom:openChildWindow', opts),
  fetch: bridgeFetch,   // 无 CORS 的 fetch，用于 API 请求
});
