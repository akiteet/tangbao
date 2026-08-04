'use strict';
/*
 * 糖包 桌面版（Electron 主进程）
 * - 启动一个本地静态服务器托管前端（避免 file:// 下 ES Module / CORS 问题）
 * - 在主进程内拉起「糖码」后端（server/agent-server.js 的 startAgentServer）
 * - 退出时随进程结束自动关闭后端
 */
const { app, BrowserWindow, ipcMain, protocol, dialog, shell, screen, Tray, globalShortcut, Menu, safeStorage, session } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { startAgentServer, configureAgentServer } = require('../infrastructure/agent-runtime/agent-server');
// 注意：kvstore.js（原 secrets.js）无法被 electron-builder 的 asar 步骤打入 app.asar
// （app-builder 会确定性地排除该文件），故改为通过 extraResources 以松散资源形式
// 放到 resources/ 下，打包后从 process.resourcesPath 加载，开发模式仍走本地路径。
const secrets = app.isPackaged
  ? require(path.join(process.resourcesPath, 'kvstore'))
  : require('../infrastructure/secrets/kvstore');
const gateway = require('../infrastructure/model-gateway/gateway');

// M5（#254）：自定义协议 tangbao-file:// —— 渲染进程不再直接持有本地文件绝对路径，
// 改为「用户选文件 → 主进程发不透明 fileId → tangbao-file://<fileId> 读取」，收敛本地文件暴露面。
// 注册为特权方案（secure + standard + supportFetchAPI），使本地 HTML 的 ES Module / fetch 等同源能力可用。
protocol.registerSchemesAsPrivileged([
  { scheme: 'tangbao-file', privileges: { secure: true, standard: true, supportFetchAPI: true } },
]);
// fileId → 绝对路径（不透明、不可枚举）；反向表避免同一文件重复注册撑大 Map
const fileRegistry = new Map();
const pathToFileId = new Map();

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

// 本地服务端口：一律由操作系统分配随机空闲端口，且只绑定 127.0.0.1。
// 不再使用固定的 4280/3000，也不再监听 0.0.0.0/::，避免局域网可访问、端口冲突、多开失败与端口探测。
// 端口在启动后填充，并通过 preload 的 serverPorts() 下发给渲染进程。
// TANGBAO_PORT 仅供本机开发调试时固定静态服务端口（生产不设置）。
let appPort = 0;   // 前端静态服务端口
let agentPort = 0; // 糖码后端端口

// 启动令牌：每次启动随机生成的 256 位密钥，只经 preload 下发给本应用的渲染进程。
// 所有本地 API（/gateway 模型网关、糖码后端）都要求 Authorization: Bearer <token>，
// 这样即便有别的本机进程/网页猜到了端口，也无法调用本地接口。
const LOCAL_TOKEN = crypto.randomBytes(32).toString('hex');

let staticServer = null;
let mainWindow = null;

// 常数时间比较，避免用 === 比较令牌时被时序侧信道逐字节猜出
function tokenEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (_) { return false; }
}

// 本地 API 鉴权：必须带 Authorization: Bearer <启动令牌>
function checkToken(req) {
  const h = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h).trim());
  return !!m && tokenEqual(m[1], LOCAL_TOKEN);
}

// 判断来源是否为本应用自身（同源）。文档导航没有 Origin 头，此时按无 Origin 处理。
function isSelfOrigin(v) {
  if (!v) return true;
  return v === `http://127.0.0.1:${appPort}` || v === `http://localhost:${appPort}`;
}

// DNS 重绑定防护：只接受 Host 明确指向回环地址的请求。
// 若攻击者用一个解析到 127.0.0.1 的域名（evil.com）诱导浏览器访问，Host 会是 evil.com，这里直接拒绝。
function isLoopbackHost(req) {
  const host = String(req.headers.host || '');
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

function deny(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}

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

// ===== Electron 安全加固（v1.0.6）=====
// CSP（通过静态服务响应头下发；本地文件协议用更宽松版本）。
// connect-src 必须写成 http://127.0.0.1:*：CSP 的 host-source 省略端口时只匹配 scheme 默认端口（http→80），
// 而糖码后端跑在系统分配的随机端口上（js/runtime.js agentBase()），不带 :* 会把 /api/* 请求全部拦死。
// 模型网关是同源请求（appOrigin + /gateway），由 'self' 覆盖，无需放行任何外部 https。
// frame-src / img-src 放行 http:：自定义模块允许用户填 http:// 地址（主进程 openChildWindow 白名单同样放行 http），
// 头像 safeUrl 也放行 http；iframe 天然跨源隔离且 IPC 有 assertTrustedSender 兜底，风险可控。
const CSP_APP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http: tangbao-file:",
  "font-src 'self' data:",
  "media-src 'self' blob: https:",
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
  "frame-src 'self' tangbao-file: https: http:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// 本地文件模块（tangbao-file://）用较宽松 CSP：允许文件自身的内联/外链脚本与资源。
// frame-ancestors 必须写成 http://127.0.0.1:*（不能用 'none'/'self'）：本地文件模块是被主页面用 iframe
// 嵌进来的（js/modules.js 本地文件分支），'none' 会让 iframe 直接被拒渲染而白屏；而 'self' 在这里指的是
// 被嵌文档自身的 tangbao-file:// 源，同样匹配不上静态服务。限定 127.0.0.1 后，外部站点依旧无法嵌入。
// 其 IPC 已被 assertTrustedSender 拦截（frame.url 非本应用）。
const CSP_LOCAL = [
  "default-src 'self' 'unsafe-inline' data: blob:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src * data: blob:",
  "font-src * data:",
  "connect-src *",
  "frame-src *",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors http://127.0.0.1:*",
].join('; ');

// 可信渲染进程白名单：仅这些窗口的 IPC 才被接受（主窗 + 浮窗，均加载本应用同源页面）
const trustedWebContents = new Set();
function trustWindow(win) { try { if (win && win.webContents) trustedWebContents.add(win.webContents); } catch (_) {} }
function untrustWindow(win) { try { if (win && win.webContents) trustedWebContents.delete(win.webContents); } catch (_) {} }
function appOrigin() { return `http://127.0.0.1:${appPort}`; }
// 仅允许本应用自身 URL（同源、同随机端口）的导航
function isAppUrl(url) { try { return String(url).startsWith(appOrigin()); } catch (_) { return false; } }
// 仅允许 http/https 外部链接（供 openExternal / 子窗口新开页白名单）
function isAllowedExternalUrl(url) { try { const u = new URL(String(url)); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (_) { return false; } }

// IPC 来源校验：调用方必须是「本应用主窗/浮窗 + 主框架（非自定义模块 iframe）+ 同源 URL」。
// 这样嵌入的第三方网页（其 frame.url 为外部域名）既拿不到特权 IPC，也无法冒充主窗发请求。
function assertTrustedSender(event) {
  const sender = event && event.sender;
  if (!sender || !trustedWebContents.has(sender)) throw new Error('拒绝：未知来源的 IPC 调用');
  const frame = event.senderFrame;
  if (!frame || frame.parentFrame) throw new Error('拒绝：仅主框架可调用 IPC');
  if (!String(frame.url || '').startsWith(appOrigin())) throw new Error('拒绝：IPC 来源不是本应用');
}

function safeHandle(channel, fn) {
  ipcMain['handle'](channel, async (event, ...args) => {
    assertTrustedSender(event);
    return await fn(event, ...args);
  });
}
function safeOn(channel, fn) {
  ipcMain['on'](channel, (event, ...args) => {
    assertTrustedSender(event);
    fn(event, ...args);
  });
}

// 权限请求默认全部拒绝（摄像头/麦克风/地理位置等），仅对本应用同源帧按需放开剪贴板读取
try {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    try {
      if (webContents.getURL().startsWith(appOrigin()) && (permission === 'clipboard-read' || permission === 'clipboard-sanitized-write')) {
        callback(true); return;
      }
    } catch (_) {}
    callback(false);
  });
} catch (_) {}

function startStaticServer() {
  const root = path.join(__dirname, '..', '..');
  return new Promise((resolve, reject) => {
    staticServer = http.createServer((req, res) => {
      try {
        const fullUrl = req.url || '/';
        const routePath = fullUrl.split('?')[0];

        // 统一入口守卫（对所有请求生效）：
        // 1) Host 必须是回环地址 —— 挡 DNS 重绑定（恶意域名解析到 127.0.0.1）
        // 2) 带 Origin 时必须是本应用自己 —— 挡 webview 里的外部页面跨源打本地服务
        if (!isLoopbackHost(req)) { deny(res, 403, '403 Forbidden'); return; }
        if (!isSelfOrigin(req.headers.origin)) { deny(res, 403, '403 Forbidden'); return; }

        // M5（#254）：本地文件已不再经 /__local/<绝对路径> 暴露路径。
        // 渲染进程改用 tangbao-file://<fileId> 自定义协议（fileId 由主进程 registerLocalFile 发放，不透明、不可枚举）。
        // 协议处理器见 app.whenReady 内的 protocol.handle('tangbao-file')。
        // 以下是「本地 API」，一律要求启动令牌
        // （/proxy 同源反代已在 1.0.6 删除：嵌入外部站改由 openChildWindow 子窗口承载，
        //   避免仅 Referer 同源校验、未拦内网/元数据地址的 SSRF 面；/gateway 已做元数据拦截）
        // 模型网关：渲染进程只发 { ref, kind, payload }，目标地址与密钥都在主进程解析
        if (routePath === '/gateway') {
          if (!checkToken(req)) { deny(res, 401, '401 Unauthorized'); return; }
          gateway.handleGateway(req, res); return;
        }
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
          res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Security-Policy': CSP_APP });
          res.end(data);
        });
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('500 Internal Error');
      }
    });
    staticServer.on('error', reject);
    // 0 = 交给系统挑一个空闲端口；'127.0.0.1' = 只回环可达，外部主机连不上
    const want = Number(process.env.TANGBAO_PORT) || 0;
    staticServer.listen(want, '127.0.0.1', () => resolve(staticServer.address().port));
  });
}

// 同源代理 /proxy 已删除（M4）：它作为「强制嵌入外部站」的服务端反代缺少对目标地址的 SSRF 拦截
// （仅 Referer 同源校验挡外部站借道，未拦 169.254.x / 内网），构成 SSRF 面。
// 强制嵌入现由 openChildWindow 子窗口承载（见 js/modules.js、preload.js），
// 模型转发统一走 /gateway（server/gateway.js，已拦云元数据）。

// M5（#254）已收敛：本地文件读取不再接受渲染进程给的绝对路径，消除「任意路径可读」暴露面。
// 改为：渲染进程调用 app:registerLocalFile(绝对路径) → 主进程发不透明 fileId → 经 tangbao-file://<fileId> 自定义协议读取
// （处理器见 app.whenReady 内的 protocol.handle('tangbao-file')）。URL 不含任何真实路径，fileId 不可枚举。

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#eef2fb',
    icon: path.join(__dirname, '..', '..', 'assets', 'app-icon.ico'),
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
      webviewTag: false, // 第三方/自定义模块改用 iframe 或隔离子窗口承载，不再启用 <webview>（保险起见默认关闭）
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${appPort}/`);
  trustWindow(mainWindow);
  // 导航守卫：仅允许本应用同源 URL 的顶层导航，其余一律阻止（防钓鱼/跳转逃逸）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  // 新窗口一律拒绝在应用内打开；白名单内的 http/https 才交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) { try { shell.openExternal(url); } catch (_) {} }
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => {
    untrustWindow(mainWindow);
    mainWindow = null;
    // 浮窗依赖主窗落盘（float:sync），主窗关闭时一并关闭所有浮窗，避免孤儿窗口
    try { floatWindows.forEach((w) => { if (w && !w.isDestroyed()) w.close(); }); } catch (_) {}
  });
}

// 渲染进程启动时取本地服务端口 + 启动令牌（端口随机分配，令牌每次启动重新生成）
safeHandle('app:ports', () => ({ app: appPort, agent: agentPort, token: LOCAL_TOKEN }));

// M5（#254）：渲染进程用本地文件绝对路径换取不透明 fileId（仅登记真实存在的文件，绝不回传路径/内容）
safeHandle('app:registerLocalFile', (e, absPath) => {
  if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) {
    return { ok: false, error: 'invalid path' };
  }
  let st;
  try { st = fs.statSync(absPath); } catch (_) { return { ok: false, error: 'not found' }; }
  if (!st.isFile()) return { ok: false, error: 'not a file' };
  const norm = path.normalize(absPath);
  const existing = pathToFileId.get(norm);
  if (existing) return { ok: true, fileId: existing };
  const fileId = crypto.randomUUID();
  fileRegistry.set(fileId, norm);
  pathToFileId.set(norm, fileId);
  return { ok: true, fileId };
});

// M7（#253）：工作区注册表——workspaceId(不透明) → { cwd, name }。
// 渲染进程只持有 workspaceId，永远不直接下发裸 cwd；agent 后端经 resolveWorkspace 解析受控目录。
const workspaceRegistry = new Map();   // workspaceId -> { cwd, name }
const workspacePathToId = new Map();   // normalize(cwd) -> workspaceId

function workspacesFile() {
  try { return path.join(app.getPath('userData'), 'workspaces.json'); } catch (_) { return null; }
}
function loadWorkspaces() {
  const f = workspacesFile(); if (!f) return;
  try {
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Array.isArray(arr)) {
      for (const w of arr) {
        if (w && typeof w.workspaceId === 'string' && typeof w.cwd === 'string') {
          workspaceRegistry.set(w.workspaceId, { cwd: w.cwd, name: w.name || '' });
          workspacePathToId.set(path.normalize(w.cwd), w.workspaceId);
        }
      }
    }
  } catch (_) { /* 首次运行无文件，忽略 */ }
}
function saveWorkspaces() {
  const f = workspacesFile(); if (!f) return;
  try {
    const arr = [];
    for (const [workspaceId, v] of workspaceRegistry) arr.push({ workspaceId, cwd: v.cwd, name: v.name });
    fs.writeFileSync(f, JSON.stringify(arr, null, 2), 'utf8');
  } catch (_) {}
}
// 主进程内登记（系统对话框与 registerWorkspace IPC 共用）：校验绝对路径 + 目录存在，幂等
function registerWorkspaceInternal(absPath, name) {
  if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) return { ok: false, error: 'invalid path' };
  let st;
  try { st = fs.statSync(absPath); } catch (_) { return { ok: false, error: 'not found' }; }
  if (!st.isDirectory()) return { ok: false, error: 'not a directory' };
  const norm = path.normalize(absPath);
  const existing = workspacePathToId.get(norm);
  if (existing) {
    const cur = workspaceRegistry.get(existing) || {};
    return { ok: true, workspaceId: existing, cwd: norm, name: cur.name || '' };
  }
  const workspaceId = crypto.randomUUID();
  workspaceRegistry.set(workspaceId, { cwd: norm, name: typeof name === 'string' ? name : '' });
  workspacePathToId.set(norm, workspaceId);
  saveWorkspaces();
  return { ok: true, workspaceId, cwd: norm, name: typeof name === 'string' ? name : '' };
}
// 渲染进程用的登记通道：手填或只读来源的 cwd 都经主进程校验后才下发不透明 workspaceId
safeHandle('app:registerWorkspace', (e, absPath, name) => registerWorkspaceInternal(absPath, name));
// agent 后端经此把 workspaceId 解析回受控目录（未知 id 返回 null → 拒绝请求）
function resolveWorkspace(id) {
  if (typeof id !== 'string') return null;
  const v = workspaceRegistry.get(id);
  return v ? { cwd: v.cwd, name: v.name } : null;
}

/* ---------- 密钥库 IPC（只有写入/删除/询问存在，没有读回明文的通道） ---------- */

safeHandle('secrets:set', (e, ref, value) => secrets.setSecret(ref, value));
safeHandle('secrets:delete', (e, ref) => secrets.deleteSecret(ref));
safeHandle('secrets:deletePrefix', (e, prefix) => secrets.deleteByPrefix(prefix));
// 只回 ref 列表 + 是否真的加密存储，绝不回明文
safeHandle('secrets:list', () => ({ refs: secrets.listRefs(), encrypted: secrets.isEncrypted() }));

// 渲染进程同步「密钥引用 → API Base」映射表；网关据此决定往哪转发（渲染进程指定不了目标）
safeHandle('gateway:setEndpoints', (e, list) => ({ ok: true, count: gateway.setEndpoints(list) }));

// 渲染进程（主题切换时）用来同步系统标题栏叠加层的颜色，使浅/深色模式下控件都清晰
safeOn('set-titlebar-overlay', (e, opts) => {
  if (mainWindow && typeof mainWindow.setTitleBarOverlay === 'function') {
    try { mainWindow.setTitleBarOverlay(opts); } catch (_) {}
  }
});

// 糖码：弹出系统「选择文件夹」对话框，在主进程登记后返回 { ok, workspaceId, cwd, name }（取消返回 { ok:false }）
safeHandle('dialog:showDir', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择糖码工作目录',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false };
    const reg = registerWorkspaceInternal(r.filePaths[0], '');
    return reg.ok ? { ok: true, workspaceId: reg.workspaceId, cwd: reg.cwd, name: reg.name } : { ok: false };
  } catch (e) {
    return { ok: false };
  }
});

// 自定义模块「在浏览器打开」：仅允许 http/https，交给系统默认浏览器。
// file: 协议已不再经此通道（本地文件改用 shell:openPath，见下），其余危险协议一律拦截。
safeHandle('shell:openExternal', async (e, url) => {
  try {
    const raw = String(url || '');
    if (raw.length > 2048) return { ok: false, error: 'URL 过长（>2048）' };
    if (/[\u0000-\u001F\u007F]/.test(raw)) return { ok: false, error: 'URL 含非法控制字符' };
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: '仅支持 http/https 链接' };
    await shell.openExternal(u.href);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// 本地文件（如用户设置的本地模块）用系统关联程序打开：仅接受绝对路径，并拒绝常见可执行后缀，避免误启动程序
safeHandle('shell:openPath', async (e, absPath) => {
  try {
    const p = String(absPath || '');
    if (!/^[A-Za-z]:[\\/]/.test(p) && !/^\//.test(p) && !/^\\\\/.test(p)) return { ok: false, error: '仅支持绝对路径' };
    if (/\.(exe|bat|cmd|com|scr|ps1|msi|vbs|jar|js|wsf|lnk)$/i.test(p)) return { ok: false, error: '出于安全拒绝打开可执行文件' };
    const r = await shell.openPath(p);
    return { ok: true, result: r || '' };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// 文件双写：将应用状态写入 userData/tangbao-data/state.json（可读文件，便于查看/备份）
// 仅允许写到 userData 子目录，防止越权访问其他文件
safeHandle('fs:writeState', async (e, jsonStr) => {
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

// 读取应用状态文件（与端口无关，作为 localStorage 的权威回退源）
safeHandle('fs:readState', async () => {
  try {
    const userData = app.getPath('userData');
    const file = path.join(userData, 'tangbao-data', 'state.json');
    // 安全检查：最终路径必须在 userData 子树内
    if (!file.startsWith(userData + path.sep)) return { ok: false, error: '路径越权' };
    if (!fs.existsSync(file)) return { ok: true, data: null };
    const data = fs.readFileSync(file, 'utf8');
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// 外部「强制嵌入」模块：用糖包子窗口打开（webview 视口锁死 + iframe/proxy subpage 404，嵌入均不可靠，子窗口是唯一全功能方案）
const moduleWindows = new Map();
safeHandle('custom:openChildWindow', async (e, {id, url, label}) => {
  try {
    const rawUrl = String(url || '');
    // 仅允许 http/https 站点；file:/javascript: 等一律拒绝（本地模块已走 iframe，不需子窗口）
    let u;
    try { u = new URL(rawUrl); } catch (_) { return { ok: false, error: 'URL 无效' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: '子窗口仅支持 http/https 链接' };
    if (rawUrl.length > 2048 || /[\u0000-\u001F\u007F]/.test(rawUrl)) return { ok: false, error: 'URL 过长或含非法字符' };
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
        webviewTag: false,
        nativeWindowOpen: false,           // 禁止子窗口内的 window.open 自带弹窗（由下方 setWindowOpenHandler 接管）
      },
    });
    // 子窗口内部导航守卫：只允许 http/https，杜绝 file:/javascript: 跳转逃逸
    win.webContents.on('will-navigate', (event, navUrl) => {
      try { const nu = new URL(navUrl); if (nu.protocol !== 'http:' && nu.protocol !== 'https:') event.preventDefault(); } catch (_) { event.preventDefault(); }
    });
    // 子窗口内 window.open 一律交由系统浏览器（仅 http/https），其余拦截
    win.webContents.setWindowOpenHandler(({ url: childUrl }) => {
      if (isAllowedExternalUrl(childUrl)) { try { shell.openExternal(childUrl); } catch (_) {} }
      return { action: 'deny' };
    });
    await win.loadURL(rawUrl);
    moduleWindows.set(id, win);
    win.on('closed', () => moduleWindows.delete(id));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// 系统级浮窗：独立的、永远置顶的小窗（聊天）。复用同源静态服务，加载 ?float=chat。
const floatWindows = new Map();

// 浮窗位置/尺寸记忆：落盘到 userData/tangbao-data/float-bounds.json
const floatBoundsFile = () => path.join(app.getPath('userData'), 'tangbao-data', 'float-bounds.json');

function loadFloatBounds() {
  try {
    const raw = fs.readFileSync(floatBoundsFile(), 'utf8');
    const b = JSON.parse(raw);
    if (b && typeof b.width === 'number' && typeof b.height === 'number') return b;
  } catch (_) {}
  return null;
}

// 校验记忆的位置是否落在某个可见显示器内，避免记忆到已断开的副屏导致窗口"消失"
function isValidBounds(b) {
  if (!b || typeof b.x !== 'number' || typeof b.y !== 'number' ||
      typeof b.width !== 'number' || typeof b.height !== 'number') return false;
  const disp = screen.getDisplayMatching({ x: b.x, y: b.y, width: b.width, height: b.height });
  if (!disp || !disp.workArea) return false;
  const wa = disp.workArea;
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  return cx >= wa.x && cx <= wa.x + wa.width && cy >= wa.y && cy <= wa.y + wa.height;
}

function writeFloatBounds(b) {
  try {
    const dir = path.join(app.getPath('userData'), 'tangbao-data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(floatBoundsFile(), JSON.stringify(b));
  } catch (_) {}
}

// 浮窗开关/透明度/置顶状态：落盘到 userData/tangbao-data/float-state.json
const floatStateFile = () => path.join(app.getPath('userData'), 'tangbao-data', 'float-state.json');
function readFloatState() {
  try {
    const raw = fs.readFileSync(floatStateFile(), 'utf8');
    const s = JSON.parse(raw);
    if (s && typeof s === 'object') return Object.assign({ open: false, opacity: 1.0, alwaysOnTop: true }, s);
  } catch (_) {}
  return { open: false, opacity: 1.0, alwaysOnTop: true };
}
function writeFloatState(patch) {
  try {
    const dir = path.join(app.getPath('userData'), 'tangbao-data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const next = Object.assign(readFloatState(), patch || {});
    fs.writeFileSync(floatStateFile(), JSON.stringify(next));
    return next;
  } catch (_) { return null; }
}

// 切换浮窗显隐：无窗则新建并显示，可见则隐藏（不销毁），隐藏则显示。状态同步写入 float-state.json
function toggleFloatWindow() {
  const win = floatWindows.get('chat');
  if (!win || win.isDestroyed()) {
    const w = createFloatingWindow();
    floatWindows.set('chat', w);
    writeFloatState({ open: true });
    return true;
  }
  if (win.isVisible()) {
    try { win.hide(); } catch (_) {}
    writeFloatState({ open: false });
    return false;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  writeFloatState({ open: true });
  return true;
}

let floatBoundsSaveTimer = null;
function saveFloatBounds(win) {
  if (win.isDestroyed()) return;
  const b = win.getBounds();
  if (floatBoundsSaveTimer) clearTimeout(floatBoundsSaveTimer);
  floatBoundsSaveTimer = setTimeout(() => writeFloatBounds(b), 500);
}

function createFloatingWindow() {
  const saved = loadFloatBounds();
  const valid = isValidBounds(saved);
  const fState = readFloatState();
  const win = new BrowserWindow({
    width: valid ? saved.width : 380,
    height: valid ? saved.height : 600,
    x: valid ? saved.x : undefined,
    y: valid ? saved.y : undefined,
    minWidth: 320,
    minHeight: 420,
    alwaysOnTop: fState.alwaysOnTop !== false,
    opacity: typeof fState.opacity === 'number' ? fState.opacity : 1,
    frame: false,
    backgroundColor: '#1f2329',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      },
    });
    // 浮窗同样属于可信窗口：登记以便 IPC 校验；并加导航/新窗口守卫
    trustWindow(win);
    win.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
    win.webContents.setWindowOpenHandler(({ url }) => { if (isAllowedExternalUrl(url)) { try { shell.openExternal(url); } catch (_) {} } return { action: 'deny' }; });
    // 先挂监听，再加载，避免 did-finish-load 早于渲染进程注册监听
  win.webContents.once('did-finish-load', () => {
    try {
      const file = path.join(app.getPath('userData'), 'tangbao-data', 'state.json');
      const raw = fs.readFileSync(file, 'utf8');
      win.webContents.send('float:init', raw);
    } catch (_) { /* 无 state.json 时浮窗用默认空状态 */ }
  });
  win.once('ready-to-show', () => win.show());
  win.on('move', () => saveFloatBounds(win));
  win.on('resize', () => saveFloatBounds(win));
  win.on('close', () => { try { writeFloatBounds(win.getBounds()); } catch (_) {} });
  win.on('closed', () => {
    untrustWindow(win);
    floatWindows.delete('chat');
    if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('float:refresh');
  });
  win.loadURL(`http://127.0.0.1:${appPort}/?float=chat`);
  return win;
}

safeHandle('float:open', async () => {
  let win = floatWindows.get('chat');
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    return { ok: true };
  }
  try {
    const w = createFloatingWindow();
    floatWindows.set('chat', w);
    writeFloatState({ open: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

safeHandle('float:close', async () => {
  const win = floatWindows.get('chat');
  if (win && !win.isDestroyed()) { try { win.hide(); } catch (_) {} }
  writeFloatState({ open: false });
  return { ok: true };
});
// 注：原 float:toggle / float:destroy 两个 IPC 通道为孤儿（tray 直接调 toggleFloatWindow()，preload 未暴露），已删除，避免暴露无用攻击面。

// 浮窗 → 主窗：转发状态变更（主窗据此合并并落盘）
safeOn('float:sync', (e, s) => {
  if (mainWindow && mainWindow.webContents) mainWindow.webContents.send('float:apply', s);
});

// 主窗 → 浮窗：通知重渲染（流式结束 / 浮窗关闭后）
safeHandle('float:refresh', async () => {
  floatWindows.forEach((w) => { if (!w.isDestroyed()) w.webContents.send('float:refresh'); });
  return { ok: true };
});

// 浮窗双击顶栏：最大化 / 还原
safeHandle('float:toggleMaximize', async () => {
  const win = floatWindows.get('chat');
  if (win && !win.isDestroyed()) { try { if (win.isMaximized()) win.unmaximize(); else win.maximize(); } catch (_) {} }
  return { ok: true };
});
// 浮窗透明度：setOpacity 立即生效并持久化（默认 1.0 不透明，点击切到 0.6）；getOpacity 读取当前值
safeHandle('float:setOpacity', async (e, v) => {
  const val = typeof v === 'number' ? v : 1;
  const win = floatWindows.get('chat');
  if (win && !win.isDestroyed()) { try { win.setOpacity(val); } catch (_) {} }
  writeFloatState({ opacity: val });
  return { ok: true };
});
// 浮窗置顶开关：setAlwaysOnTop 立即生效并持久化
safeHandle('float:setAlwaysOnTop', async (e, on) => {
  const win = floatWindows.get('chat');
  if (win && !win.isDestroyed()) { try { win.setAlwaysOnTop(!!on); } catch (_) {} }
  writeFloatState({ alwaysOnTop: !!on });
  return { ok: true };
});
safeHandle('float:getOpacity', async () => {
  const win = floatWindows.get('chat');
  if (win && !win.isDestroyed()) { try { return win.getOpacity(); } catch (_) {} }
  return readFloatState().opacity;
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
  // 主窗已关闭 webviewTag（webview 默认不创建），此处作为兜底：即便被启用，也强制最严基线并拒绝非 http/https 源
  app.on('will-attach-webview', (event, webPreferences, params) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.webSecurity = true;
    webPreferences.sandbox = true;
    if (params && params.src && !/^https?:\/\//i.test(params.src)) event.preventDefault();
  });

  app.whenReady().then(async () => {
    // 密钥库必须在 app ready 之后初始化（safeStorage 依赖 app ready）。
    // 密钥文件与 state.json 同目录，但内容由系统密钥服务加密，明文不再进 state.json / localStorage。
    try {
      const info = secrets.init({
        safeStorage,
        filePath: path.join(app.getPath('userData'), 'tangbao-data', 'secrets.json'),
      });
      if (!info.encrypted) console.error('[糖包] 当前系统密钥服务不可用，API Key 将以未加密形式保存。');
    } catch (e) {
      console.error('[糖包] 密钥库初始化失败：', e);
    }
    // 模型网关与糖码后端都直接从主进程密钥库取密钥，密钥不经渲染层
    gateway.configure({ getSecret: secrets.getSecret });
    loadWorkspaces(); // M7（#253）：启动即恢复工作区注册表，使持久化的 workspaceId 仍有效
    configureAgentServer({ getSecret: secrets.getSecret, getEndpoint: gateway.getEndpoint, resolveWorkspace });

    // M5（#254）：tangbao-file:// 自定义协议处理器——按 fileId 回磁盘文件，URL 不暴露任何真实路径
    protocol.handle('tangbao-file', (request) => {
      try {
        const u = new URL(request.url);
        const fileId = (u.hostname || '') || String(u.pathname || '').replace(/^\/+/, '');
        const filePath = fileRegistry.get(fileId);
        if (!filePath) {
          return new Response('404 Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        }
        const ext = path.extname(filePath).toLowerCase();
        const data = fs.readFileSync(filePath);
        return new Response(data, { status: 200, headers: { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Security-Policy': CSP_LOCAL } });
      } catch (err) {
        return new Response('500 Internal Error', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    });

    // 两个本地服务都必须先拿到实际端口，窗口才能 loadURL / 渲染进程才能取端口
    appPort = await startStaticServer();
    // 糖码后端与静态服务不同源，需要显式告知允许的来源；令牌与静态服务共用同一个
    agentPort = await startAgentServer(0, {
      token: LOCAL_TOKEN,
      allowOrigin: `http://127.0.0.1:${appPort}`,
    });
    createWindow();
    // 若上次退出时浮窗是开着的，自动恢复浮窗
    try {
      if (readFloatState().open) {
        const w = createFloatingWindow();
        floatWindows.set('chat', w);
      }
    } catch (_) {}
    // 托盘图标（复用 app-icon.ico）：右键菜单切换浮窗 / 退出；点击托盘切换浮窗
    try {
      const trayIcon = path.join(__dirname, '..', '..', 'assets', 'app-icon.ico');
      const tray = new Tray(trayIcon);
      tray.setToolTip('糖包');
      const trayMenu = Menu.buildFromTemplate([
        { label: '显示/隐藏浮窗', click: () => { toggleFloatWindow(); } },
        { type: 'separator' },
        { label: '退出糖包', click: () => { app.quit(); } },
      ]);
      tray.setContextMenu(trayMenu);
      tray.on('click', () => { toggleFloatWindow(); });
    } catch (_) {}
    // 全局快捷键 Ctrl/Cmd+Shift+F 切换浮窗显隐（注册失败静默忽略：被占用或缺少权限）
    try {
      const ok = globalShortcut.register('CommandOrControl+Shift+F', () => { toggleFloatWindow(); });
      if (!ok) { /* 注册失败，静默忽略 */ }
    } catch (_) {}

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (staticServer) { try { staticServer.close(); } catch (e) {} staticServer = null; }
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    try { globalShortcut.unregisterAll(); } catch (_) {}
  });
}
