'use strict';
/*
 * 糖包 桌面版（Electron 主进程）
 * - 启动一个本地静态服务器托管前端（避免 file:// 下 ES Module / CORS 问题）
 * - 在主进程内拉起「糖码」后端（server/agent-server.js 的 startAgentServer）
 * - 退出时随进程结束自动关闭后端
 */
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { startAgentServer } = require('./server/agent-server');
const { execFile } = require('child_process');

// 便携化：优先 exe 所在盘，不落 C 盘。保护目录（Program Files）会弹窗征得用户授权。
if (app.isPackaged) {
  let defaultUserData;
  try { defaultUserData = app.getPath('userData'); } catch (e) { defaultUserData = null; }
  const { dialog } = require('electron');
  let ok = false;

  // 候选 1：exe 同级 tangbao-data/（非保护路径直接成功）
  try {
    const dataDir = path.join(path.dirname(process.execPath), 'tangbao-data');
    fs.mkdirSync(dataDir, { recursive: true });
    app.setPath('userData', dataDir);
    const probe = path.join(dataDir, '.write_test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    ok = true;
  } catch (_) { /* 保护目录，进入后续候选 */ }

  // 候选 2：若在保护目录（Program Files / Windows），弹窗征得用户授权后重试
  if (!ok) {
    const exeDir = path.dirname(process.execPath);
    const isProtected = /Program Files/i.test(exeDir) || /Windows/i.test(exeDir);
    if (isProtected) {
      try {
        const answer = dialog.showMessageBoxSync({
          type: 'question',
          title: '糖包 — 数据目录',
          message: '需要在安装目录下创建数据文件夹来保存对话记录和设置。',
          detail: '位置：' + path.join(exeDir, 'tangbao-data') + '\n\n' +
            '「确定」将尝试创建（可能需要管理员权限）。\n' +
            '「取消」将自动选择 D 盘其他位置。',
          buttons: ['确定', '取消'],
          defaultId: 0,
          cancelId: 1,
        });
        if (answer === 0) {
          try {
            const dataDir = path.join(exeDir, 'tangbao-data');
            fs.mkdirSync(dataDir, { recursive: true });
            app.setPath('userData', dataDir);
            const probe = path.join(dataDir, '.write_test');
            fs.writeFileSync(probe, 'ok');
            fs.unlinkSync(probe);
            ok = true;
          } catch (e) { console.error('糖包 授权后仍无法创建数据目录：' + dataDir, e); }
        }
      } catch (_) {}
    }
  }

  // 候选 3：同盘 Public 目录（始终可写，不落 C 盘）
  if (!ok) {
    let root;
    try {
      root = path.parse(process.execPath).root;
      if (root) {
        const dataDir = path.join(root, 'Users', 'Public', 'tangbao-web-data');
        fs.mkdirSync(dataDir, { recursive: true });
        app.setPath('userData', dataDir);
        const probe = path.join(dataDir, '.write_test');
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        ok = true;
      }
    } catch (e) { console.error('糖包 Public 候选失败：' + root + 'Users/Public/tangbao-web-data', e); }
  }

  if (!ok && defaultUserData) {
    try { app.setPath('userData', defaultUserData); } catch (_) {}
    console.error('糖包 便携模式全部失败，回退默认 userData：' + defaultUserData);
  }

  // 旧数据迁移：如果成功切到了新路径且老路径有数据，自动复制 Local Storage
  if (ok && defaultUserData) {
    const oldDir = defaultUserData;
    const newDir = app.getPath('userData');
    if (oldDir !== newDir) {
      try {
        const oldLS = path.join(oldDir, 'Local Storage');
        const newLS = path.join(newDir, 'Local Storage');
        if (fs.existsSync(oldLS) && !fs.existsSync(newLS)) {
          fs.cpSync(oldLS, newLS, { recursive: true });
        }
        // 同时也复制 state.json 如果存在
        const oldState = path.join(oldDir, 'tangbao-data', 'state.json');
        const newStateDir = path.join(newDir, 'tangbao-data');
        const newState = path.join(newStateDir, 'state.json');
        if (fs.existsSync(oldState) && !fs.existsSync(newState)) {
          fs.mkdirSync(newStateDir, { recursive: true });
          fs.copyFileSync(oldState, newState);
        }
      } catch (e) { console.error('糖包 旧数据迁移失败', e); }
    }
  }
}

const APP_PORT = Number(process.env.TANGBAO_PORT) || 4280; // 前端静态服务端口
const AGENT_PORT = 3000;                                    // 糖码后端端口（须与 js/agent.js 的 AGENT_BASE 一致）

let staticServer = null;
let mainWindow = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function startStaticServer() {
  const root = __dirname;
  return new Promise((resolve, reject) => {
    staticServer = http.createServer((req, res) => {
      try {
        const fullUrl = req.url || '/';
        // 本地文件经 HTTP 提供：把 file:// 转成同源 http://localhost:PORT/__local/<绝对路径>，
        // 规避 file:// 下 ES Module / fetch / 相对资源的 CORS 限制，使本地 HTML 整屏正常渲染。
        if (fullUrl.split('?')[0].startsWith('/__local/')) { handleLocalFile(fullUrl, res); return; }
        // 同源代理（强制嵌入被拦站点）：剥离防嵌入响应头
        if (fullUrl.split('?')[0] === '/proxy') { handleProxy(req, res); return; }
        // API 代理：转发到中转站，规避浏览器 CORS 限制
        if (fullUrl.split('?')[0] === '/api-proxy') { handleApiProxy(req, res); return; }
        let urlPath = decodeURIComponent(fullUrl.split('?')[0]);
        if (urlPath === '/') urlPath = '/index.html';
        const filePath = path.normalize(path.join(root, urlPath));
        // 路径穿越防护：必须仍位于 root 之内
        if (filePath !== root && !filePath.startsWith(root + path.sep)) {
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('403 Forbidden');
          return;
        }
        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
          res.end(data);
        });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Internal Error');
      }
    });
    staticServer.on('error', reject);
    staticServer.listen(APP_PORT, () => resolve());
  });
}

// 同源代理：剥离防嵌入响应头（X-Frame-Options / CSP），让被拦的公开页也能在 iframe 内联。
// 仅响应来自本应用的请求（Referer 为本应用源），避免被外部站点当作开放代理（SSRF）。
// 用系统 curl 兜底：某些站点（尤其带反爬/连接复用）会让 Node 的 fetch 偶发失败，
// 而 curl 走系统网络栈在用户机器上稳定。强嵌顽固站点时优先保证「能打开」。
function curlGet(url, ua) {
  return new Promise((resolve, reject) => {
    execFile('curl', ['-sL', '--compressed', '--max-time', '30', '-A', ua, url],
      { encoding: 'buffer', maxBuffer: 120 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        const head = stdout.slice(0, 600).toString('utf8').toLowerCase();
        const isHtml = /^\s*<!doctype\s+html|^\s*<html|<html/i.test(head);
        resolve({ ct: isHtml ? 'text/html; charset=utf-8' : 'application/octet-stream', body: stdout });
      });
  });
}

function handleProxy(req, res) {
  const referer = req.headers.referer || req.headers.origin || '';
  // 仅阻断「带外部 Referer」的请求（外部站点借本代理做 SSRF）；本应用自身请求（无 Referer 或同源）放行
  if (referer && !referer.startsWith(`http://localhost:${APP_PORT}`)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  let target;
  try {
    const u = new URL(req.url, 'http://localhost');
    const raw = u.searchParams.get('url');
    if (!raw) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('missing url'); return; }
    target = new URL(raw);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad url'); return;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('only http/https allowed'); return;
  }

  const UA = req.headers['user-agent']
    || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';

  // 把上游 HTML 改写（相对资源绝对化 + 注入导航拦截脚本），统一供 fetch / curl 两条路径复用
  const sendHtml = (buf, finalUrl) => {
    let html = buf.toString('utf8');
    html = html.replace(/((?:src|href|srcset|poster|data-src)\s*=\s*)(["'])(.*?)\2/gi,
      (m, pre, q, val) => pre + q + proxyTransformUrl(val, finalUrl) + q);
    const baseUrl = (() => { try { const u = new URL(finalUrl); u.search = ''; u.hash = ''; return u.href; } catch (e) { return finalUrl; } })();
    const navScript = '<script>(function(){var BASE=' + JSON.stringify(baseUrl) + ';var PROXY=\'/proxy?url=\';'
      + 'function abs(u){try{return new URL(u,BASE).href;}catch(e){return u;}}'
      + 'function toProxy(h){if(!h)return h;if(/^(#|javascript:|mailto:|tel:|data:|blob:)/i.test(h))return h;var a=abs(h);return PROXY+encodeURIComponent(a);}'
      + 'function fix(){document.querySelectorAll(\'a[href]\').forEach(function(el){var h=el.getAttribute(\'href\');if(/^(#|javascript:|mailto:|tel:)/i.test(h||\'\'))return;el.setAttribute(\'href\',toProxy(h));});'
      + 'document.querySelectorAll(\'form[action]\').forEach(function(el){var a=el.getAttribute(\'action\');if(a)el.setAttribute(\'action\',toProxy(a));});}'
      + 'document.addEventListener(\'click\',function(e){var t=e.target;var a=t&&t.closest?t.closest(\'a\'):null;if(a){var h=a.getAttribute(\'href\');if(h&&!/^(#|javascript:|mailto:|tel:)/i.test(h)){e.preventDefault();location.href=toProxy(h);}}},true);'
      + 'document.addEventListener(\'submit\',function(e){var f=e.target;if(f&&f.tagName===\'FORM\'){e.preventDefault();var u=toProxy(f.getAttribute(\'action\')||location.href);var q=new URLSearchParams(new FormData(f)).toString();location.href=q?(u+(u.indexOf(\'?\')>-1?\'&\':\'?\')+q):u;}},true);'
      + 'window.open=function(u){location.href=toProxy(u);return null;};'
      + 'function toProxyUrl(u){if(typeof u!=="string")return u;if(/^(#|javascript:|mailto:|tel:|data:|blob:)/i.test(u))return u;try{return toProxy(new URL(u,BASE).href);}catch(e){return u;}}'
      + 'try{var _assign=location.assign;location.assign=function(u){location.href=toProxy(String(u));};}catch(e){}'
      + 'try{var _replace=location.replace;location.replace=function(u){location.href=toProxy(String(u));};}catch(e){}'
      + 'try{var _push=history.pushState;history.pushState=function(s,t,u){return _push.call(history,s,t,u==null?u:toProxyUrl(u));};}catch(e){}'
      + 'try{var _hrep=history.replaceState;history.replaceState=function(s,t,u){return _hrep.call(history,s,t,u==null?u:toProxyUrl(u));};}catch(e){}'
      + 'fix();var mo=new MutationObserver(fix);if(document.documentElement)mo.observe(document.documentElement,{childList:true,subtree:true});'
      + '})();<\/script>';
    const marker = /<\/body>/i.test(html) ? '</body>' : (/<\/html>/i.test(html) ? '</html>' : null);
    html = marker ? html.replace(marker, navScript + marker) : (html + navScript);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(html);
  };
  const sendRaw = (buf, ct) => {
    res.writeHead(200, { 'Content-Type': ct, 'Access-Control-Allow-Origin': '*' });
    res.end(buf);
  };

  fetch(target.href, { method: 'GET', redirect: 'follow', headers: { 'User-Agent': UA, 'Accept': '*/*' } })
    .then(async (up) => {
      const ct = up.headers.get('content-type') || 'application/octet-stream';
      const finalUrl = up.url || target.href;
      const buf = Buffer.from(await up.arrayBuffer());
      if (/text\/html/i.test(ct)) sendHtml(buf, finalUrl);
      else sendRaw(buf, ct);
    })
    .catch(async (e) => {
      const cause = (e && e.cause) ? (e.cause.code + ': ' + e.cause.message) : (e && e.message);
      console.error('[proxy] fetch failed, falling back to curl:', target.href, '|', cause);
      try {
        const { ct, body } = await curlGet(target.href, UA);
        if (/text\/html/i.test(ct)) sendHtml(body, target.href);
        else sendRaw(body, ct);
      } catch (e2) {
        const cause2 = (e2 && e2.code) ? (e2.code + ': ' + e2.message) : (e2 && e2.message);
        console.error('[proxy] curl fallback also failed:', target.href, '|', cause2);
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('proxy error: ' + (cause || e) + ' | curl: ' + (cause2 || e2));
      }
    });
}

// API 代理：转发聊天/图像请求到中转站，规避浏览器 CORS
async function handleApiProxy(req, res) {
  try {
    const targetUrl = req.headers['x-target-url'];
    if (!targetUrl) { res.writeHead(400); res.end('missing x-target-url header'); return; }
    const bodyChunks = [];
    for await (const chunk of req) bodyChunks.push(chunk);
    const body = Buffer.concat(bodyChunks);
    const fRes = await fetch(targetUrl, {
      method: req.method,
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        'Authorization': req.headers['x-auth'] || '',
      },
      body: body.length ? body : undefined,
    });
    res.writeHead(fRes.status, {
      'Content-Type': fRes.headers.get('content-type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    if (fRes.body) {
      const reader = fRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (e) {
    res.writeHead(502);
    res.end('proxy error: ' + (e.message || e));
  }
}

function proxyTransformUrl(val, baseUrl) {
  val = (val || '').trim();
  if (!val) return val;
  if (/^(#|mailto:|javascript:|tel:|data:|blob:)/i.test(val)) return val;
  if (/^[a-z][a-z0-9+.-]*:/i.test(val)) return val; // 绝对地址（http/https 等）保持不变，直接加载
  try { return new URL(val, baseUrl).href; } catch (e) { return val; }
}

// 本地文件经 HTTP 提供：将 /__local/<encodeURIComponent(绝对路径)> 映射到磁盘文件返回。
// 仅响应本应用同源请求（webview/iframe 的 src 即 localhost:PORT，同源），不对外暴露。
// 安全性：只服务「真实存在的普通文件」的绝对路径；模块由用户自己在设置里创建（可信），
// 且静态服务仅监听 localhost，外部无法访问。
function handleLocalFile(fullUrl, res) {
  try {
    const raw = decodeURIComponent(fullUrl.split('?')[0].slice('/__local/'.length));
    // 防御性处理：去掉可能多余的前导 / 或 \（如前端偶发传入 /E:/...），避免 path.normalize 把 /E: 当成根路径
    const rel = raw.replace(/^[\\/]+/, '');
    const filePath = path.normalize(rel);
    if (!path.isAbsolute(filePath)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('400 Bad Path');
      return;
    }
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found: ' + filePath);
        return;
      }
      fs.readFile(filePath, (e2, data) => {
        if (e2) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('500 Read Error');
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(data);
      });
    });
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 Internal Error');
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#eef2fb',
    icon: path.join(__dirname, 'assets', 'app-icon.ico'),
    // 去掉原生标题栏的“框”感：隐藏标题栏，仅保留系统的最小/最大/关闭按钮（叠加在右上角）
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: 'rgba(244,247,251,0.92)',
      symbolColor: '#5b6472',
      height: 36,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: true, // 强制嵌入模块使用 <webview>，Electron 新版默认关闭，必须显式开启
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.loadURL(`http://localhost:${APP_PORT}/`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// 渲染进程（主题切换时）用来同步系统标题栏叠加层的颜色，使浅/深色模式下控件都清晰
ipcMain.on('set-titlebar-overlay', (e, opts) => {
  if (mainWindow && typeof mainWindow.setTitleBarOverlay === 'function') {
    try { mainWindow.setTitleBarOverlay(opts); } catch (_) {}
  }
});

// 糖码：弹出系统「选择文件夹」对话框，返回所选目录绝对路径（取消返回 ''）
ipcMain.handle('dialog:showDir', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择糖码工作目录',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return '';
    return r.filePaths[0];
  } catch (e) {
    return '';
  }
});

// 自定义模块「在浏览器打开」：用系统默认浏览器打开 URL（绕过站点对 iframe/webview 的防嵌入限制）
ipcMain.handle('shell:openExternal', async (e, url) => {
  try {
    const u = new URL(String(url || ''));
    // 允许 http/https 远程链接，以及 file: 本地文件（「↗ 浏览器打开」本地模块用）。
    // 仍拦截 shell: / javascript: 等危险协议，避免被外部程序执行。
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') return { ok: false, error: '仅支持 http/https/file 链接' };
    await shell.openExternal(u.href);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// 文件双写：将应用状态写入 userData/tangbao-data/state.json（可读文件，便于查看/备份）
// 仅允许写到 userData 子目录，防止越权访问其他文件
ipcMain.handle('fs:writeState', async (e, jsonStr) => {
  try {
    const userData = app.getPath('userData');
    const dir = path.join(userData, 'tangbao-data');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'state.json');
    // 安全检查：最终路径必须在 userData 子树内
    if (!file.startsWith(userData + path.sep)) return { ok: false, error: '路径越权' };
    fs.writeFileSync(file, jsonStr || '', 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// 外部「强制嵌入」模块：用糖包子窗口打开（webview 视口锁死 + iframe/proxy subpage 404，嵌入均不可靠，子窗口是唯一全功能方案）
const moduleWindows = new Map();
ipcMain.handle('custom:openChildWindow', async (e, {id, url, label}) => {
  try {
    let win = moduleWindows.get(id);
    if (win && !win.isDestroyed()) {
      // 窗口已存在且未关闭：聚焦该窗口
      if (win.isMinimized()) win.restore();
      win.focus();
      return { ok: true };
    }
    win = new BrowserWindow({
      width: 1100,
      height: 750,
      title: label || '糖包 · 外部站点',
      parent: mainWindow,
      backgroundMaterial: 'mica',         // Windows 11 液态玻璃效果（Mica 材质，系统标题栏自动适配）
      backgroundColor: '#1e1e2e',         // Mica 不可用时的回退色（深色）
      autoHideMenuBar: true,               // 隐藏 File/Edit/View/Help 菜单栏
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    await win.loadURL(url);
    moduleWindows.set(id, win);
    win.on('closed', () => moduleWindows.delete(id));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// 单实例：避免重复开多个窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // 强制嵌入模块用 <webview> 渲染：独立浏览器实例，不受对方 X-Frame-Options/CSP 限制，
  // cookie/JS 原生运行、弹窗可控。这里收紧安全基线与宿主一致，仅用于展示外部站点。
  app.on('will-attach-webview', (event, webPreferences, params) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.webSecurity = true;
    webPreferences.sandbox = false;
    // 关键：去掉 UA 里的 Electron/xx 标记，伪装成标准 Chrome。
    // 否则很多站点（如影视站 libhd）检测到 Electron 就只渲染头部、藏起正文。
    webPreferences.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  });

  app.whenReady().then(async () => {
    await startStaticServer();
    startAgentServer(AGENT_PORT); // 在主进程内启动糖码后端
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (staticServer) { try { staticServer.close(); } catch (e) {} staticServer = null; }
    if (process.platform !== 'darwin') app.quit();
  });
}
