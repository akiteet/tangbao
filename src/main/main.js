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
const os = require('os');
const crypto = require('crypto');
const { startAgentServer, configureAgentServer, flushActiveAgentRuns, hasActiveAgentRuns, scanSkills } = require('../infrastructure/agent-runtime/agent-server');
// 注意：kvstore.js（原 secrets.js）无法被 electron-builder 的 asar 步骤打入 app.asar
// （app-builder 会确定性地排除该文件），故改为通过 extraResources 以松散资源形式
// 放到 resources/ 下，打包后从 process.resourcesPath 加载，开发模式仍走本地路径。
const secrets = app.isPackaged
  ? require(path.join(process.resourcesPath, 'kvstore'))
  : require('../infrastructure/secrets/kvstore');
const gateway = require('../infrastructure/model-gateway/gateway');
const SkillPackage = require('../core/skills/skill-package');
const SkillRegistry = require('../core/skills/skill-registry');
const SkillSecurity = require('../core/skills/skill-security');
const ControlledEval = require('../core/agent-runtime/controlled-eval');
const WorkspaceRoots = require('../core/workspace/workspace-roots');
const dataLocation = require('../infrastructure/storage/data-location');

// M5（#254）：自定义协议 tangbao-file:// —— 渲染进程不再直接持有本地文件绝对路径，
// 改为「用户选文件 → 主进程发不透明 fileId → tangbao-file://<fileId> 读取」，收敛本地文件暴露面。
// 注册为特权方案（secure + standard + supportFetchAPI），使本地 HTML 的 ES Module / fetch 等同源能力可用。
protocol.registerSchemesAsPrivileged([
  { scheme: 'tangbao-file', privileges: { secure: true, standard: true, supportFetchAPI: true } },
]);
// fileId → 绝对路径（不透明、不可枚举）；反向表避免同一文件重复注册撑大 Map
const fileRegistry = new Map();
const pathToFileId = new Map();

// Resolve the selected data root before Electron creates browser storage.
const defaultUserDataRoot = dataLocation.canonical(app.getPath('userData'));
const startupLocation = dataLocation.resolveStartupLocation({
  defaultRoot: defaultUserDataRoot,
  packaged: app.isPackaged,
  executablePath: process.execPath,
});
const startupUsesDefaultRoot = path.resolve(startupLocation.rootPath).toLowerCase() === defaultUserDataRoot.toLowerCase();
const startupHasLocationPointer = !!dataLocation.readLocation(defaultUserDataRoot);
if (startupLocation.rootPath && !startupUsesDefaultRoot) {
  try { app.setPath('userData', startupLocation.rootPath); } catch (error) {
    console.error('[tangbao] failed to select data root:', error && error.message ? error.message : error);
  }
}

function secretStorePaths(activeRoot) {
  const roots = [
    activeRoot,
    defaultUserDataRoot,
    startupLocation.pointer && startupLocation.pointer.sourceRoot,
  ].filter(Boolean).map((root) => dataLocation.canonical(root));
  const paths = [];
  for (const root of roots) {
    paths.push(path.join(root, 'tangbao-data', 'secrets.json'));
    // 兼容 v1.0.5 及早期自定义目录直接存放 secrets.json 的布局。
    paths.push(path.join(root, 'secrets.json'));
    paths.push(path.join(root, 'tangbao-data.backup', 'secrets.json'));
  }
  return Array.from(new Set(paths.map((value) => path.resolve(value))));
}

// 便携化：优先 exe 所在盘，不落 C 盘。保护目录（Program Files）会弹窗征得用户授权。
if (app.isPackaged && startupUsesDefaultRoot && !startupHasLocationPointer) {
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
let controlledEvalCount = 0; // v16（批量提速）：运行中的评测并发计数（上限 MAX_CONCURRENT_EVAL）
const MAX_CONCURRENT_EVAL = 3; // v16（批量提速）：评测并发上限，3 路并行（中转站限流下保守值）

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

// M7（#253）+ multi-root：workspaceId(不透明) → { roots, primaryRootId, name }。
// 渲染进程可展示文件夹路径，但 Runtime 只信任主进程注册表解析出的不可变工作区快照。
const workspaceRegistry = new Map();
const workspacePathToId = new Map();

function workspacePathKey(value) {
  const norm = WorkspaceRoots.normalizePath(value);
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}
function indexWorkspacePaths(workspaceId, workspace) {
  for (const root of (workspace && workspace.roots) || []) workspacePathToId.set(workspacePathKey(root.path), workspaceId);
}
function unindexWorkspacePaths(workspaceId) {
  for (const [key, id] of workspacePathToId) if (id === workspaceId) workspacePathToId.delete(key);
}
function workspacesFile() {
  try { return path.join(app.getPath('userData'), 'workspaces.json'); } catch (_) { return null; }
}
function loadWorkspaces() {
  const f = workspacesFile(); if (!f) return;
  try {
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (Array.isArray(arr)) {
      for (const raw of arr) {
        if (!raw || typeof raw.workspaceId !== 'string') continue;
        try {
          const workspace = WorkspaceRoots.normalizeWorkspace(raw, { allowEmpty: false });
          workspaceRegistry.set(raw.workspaceId, workspace);
          indexWorkspacePaths(raw.workspaceId, workspace);
        } catch (_) {}
      }
    }
  } catch (_) { /* 首次运行无文件，忽略 */ }
}
function saveWorkspaces() {
  const f = workspacesFile(); if (!f) return;
  try {
    const arr = [];
    for (const [workspaceId, workspace] of workspaceRegistry) {
      const pub = WorkspaceRoots.publicWorkspace(workspace, workspaceId);
      arr.push({ workspaceId, version: pub.version, name: pub.name, primaryRootId: pub.primaryRootId, roots: pub.roots.map(({ rootId, name, path: rootPath }) => ({ rootId, name, path: rootPath })), cwd: pub.cwd });
    }
    fs.writeFileSync(f, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) { console.warn('[工作区] 保存 workspaces.json 失败：', e && e.message ? e.message : e); } // B7（P3）：不再静默吞错
}
function ensureWorkspaceDir(absPath) {
  if (typeof absPath !== 'string' || !path.isAbsolute(absPath)) return { ok: false, code: 'invalid_root_path', error: '选择的路径无效，请重新选择文件夹' };
  let st;
  try { st = fs.statSync(absPath); } catch (_) { return { ok: false, code: 'root_not_found', error: '选择的文件夹不存在或当前无法访问' }; }
  if (!st.isDirectory()) return { ok: false, code: 'root_not_directory', error: '选择的路径不是文件夹' };
  return { ok: true, path: WorkspaceRoots.normalizePath(absPath) };
}
// 单根兼容登记：旧调用继续得到 workspaceId；多根项目使用 workspace:addRoot 扩展。
function registerWorkspaceInternal(absPath, name) {
  const checked = ensureWorkspaceDir(absPath);
  if (!checked.ok) return checked;
  const existing = workspacePathToId.get(workspacePathKey(checked.path));
  if (existing) return Object.assign({ ok: true }, WorkspaceRoots.publicWorkspace(workspaceRegistry.get(existing), existing));
  const workspaceId = crypto.randomUUID();
  const workspace = WorkspaceRoots.normalizeWorkspace({ name: typeof name === 'string' ? name : '', cwd: checked.path });
  workspaceRegistry.set(workspaceId, workspace);
  indexWorkspacePaths(workspaceId, workspace);
  saveWorkspaces();
  return Object.assign({ ok: true }, WorkspaceRoots.publicWorkspace(workspace, workspaceId));
}
function updateWorkspace(workspaceId, updater) {
  const current = workspaceRegistry.get(String(workspaceId || ''));
  if (!current) return { ok: false, code: 'unknown_workspace', error: '当前项目的工作区登记已失效，请重新选择项目文件夹' };
  if (typeof hasActiveAgentRuns === 'function' && hasActiveAgentRuns()) return { ok: false, code: 'workspace_busy', error: '当前有运行中的任务，暂不能修改项目文件夹；请先停止或等待任务完成' };
  try {
    const next = updater(current);
    unindexWorkspacePaths(String(workspaceId));
    workspaceRegistry.set(String(workspaceId), next);
    indexWorkspacePaths(String(workspaceId), next);
    saveWorkspaces();
    return Object.assign({ ok: true }, WorkspaceRoots.publicWorkspace(next, workspaceId));
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error), code: error && error.code ? error.code : 'workspace_update_failed' };
  }
}
safeHandle('app:registerWorkspace', (e, absPath, name) => registerWorkspaceInternal(absPath, name));
safeHandle('workspace:get', (_e, workspaceId) => {
  const ws = workspaceRegistry.get(String(workspaceId || ''));
  return ws ? Object.assign({ ok: true }, WorkspaceRoots.publicWorkspace(ws, workspaceId)) : { ok: false, code: 'unknown_workspace', error: '当前项目的工作区登记已失效，请重新选择项目文件夹' };
});
safeHandle('workspace:addRoot', async (_e, workspaceId) => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, { title: '添加项目文件夹', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    const checked = ensureWorkspaceDir(r.filePaths[0]); if (!checked.ok) return checked;
    const owner = workspacePathToId.get(workspacePathKey(checked.path));
    if (owner && owner !== String(workspaceId || '')) return { ok: false, code: 'root_owned_by_other_workspace', error: '该文件夹已属于另一个糖码项目，不能重复挂载' };
    return updateWorkspace(workspaceId, (ws) => WorkspaceRoots.addRoot(ws, { path: checked.path }));
  } catch (error) { return { ok: false, code: error && error.code ? error.code : 'workspace_add_root_failed', error: error && error.message ? error.message : '添加文件夹失败，请稍后重试' }; }
});
safeHandle('workspace:removeRoot', (_e, workspaceId, rootId) => updateWorkspace(workspaceId, (ws) => WorkspaceRoots.removeRoot(ws, rootId)));
safeHandle('workspace:renameRoot', (_e, workspaceId, rootId, name) => updateWorkspace(workspaceId, (ws) => WorkspaceRoots.renameRoot(ws, rootId, name)));
safeHandle('workspace:setPrimary', (_e, workspaceId, rootId) => updateWorkspace(workspaceId, (ws) => WorkspaceRoots.setPrimaryRoot(ws, rootId)));
// Runtime 获取冻结副本，调用者不能改写主进程注册表。
function resolveWorkspace(id) {
  if (typeof id !== 'string') return null;
  const workspace = workspaceRegistry.get(id);
  if (!workspace) return null;
  const pub = WorkspaceRoots.publicWorkspace(workspace, id);
  return { workspaceId: id, name: pub.name, cwd: pub.cwd, primaryRootId: pub.primaryRootId, roots: pub.roots.map(({ rootId, name, path: rootPath }) => ({ rootId, name, path: rootPath })), fingerprint: WorkspaceRoots.fingerprint(workspace) };
}

/* ---------- 密钥库 IPC（只有写入/删除/询问存在，没有读回明文的通道） ---------- */

safeHandle('secrets:set', (e, ref, value) => secrets.setSecret(ref, value));
safeHandle('secrets:delete', (e, ref) => secrets.deleteSecret(ref));
safeHandle('secrets:deletePrefix', (e, prefix) => secrets.deleteByPrefix(prefix));
// 只回 ref 列表 + 密钥库状态，绝不回明文。读取失败时 refs 保持为空，前端不能把它误判成“没有 Key”。
safeHandle('secrets:list', () => {
  const status = typeof secrets.getStatus === 'function' ? secrets.getStatus() : { state: 'ready', code: '' };
  return {
    ok: status.state !== 'unavailable',
    refs: status.state === 'unavailable' ? [] : secrets.listRefs(),
    encrypted: secrets.isEncrypted(),
    status,
  };
});

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
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    const reg = registerWorkspaceInternal(r.filePaths[0], '');
    return reg.ok ? reg : { ok: false, code: reg.code || 'workspace_register_failed', error: reg.error || '无法登记工作区文件夹' };
  } catch (e) {
    return { ok: false, code: e && e.code ? e.code : 'dialog_failed', error: e && e.message ? e.message : '选择文件夹失败' };
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
    if (/\.(exe|bat|cmd|com|scr|ps1|msi|vbs|jar|js|wsf|lnk|hta)$/i.test(p)) return { ok: false, error: '出于安全拒绝打开可执行文件' };
    const r = await shell.openPath(p);
    return { ok: true, result: r || '' };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// Data location is user-selectable. The pointer stays in the original Electron
// userData directory; records are copied and activated after the next launch.
safeHandle('storage:info', () => dataLocation.describe({
  defaultRoot: defaultUserDataRoot,
  activeRoot: app.getPath('userData'),
}));

safeHandle('storage:chooseLocation', async () => {
  try {
    if (typeof hasActiveAgentRuns === 'function' && hasActiveAgentRuns()) {
      return { ok: false, code: 'active_agent_runs', error: '请等待运行结束后再迁移数据目录' };
    }
    const owner = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    while (true) {
      const result = await dialog.showOpenDialog(owner, {
        title: '选择糖包数据目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths || !result.filePaths.length) return { ok: false, canceled: true };
      const selectedRoot = result.filePaths[0];
      const move = dataLocation.requestMove({
        pointerRoot: defaultUserDataRoot,
        sourceRoot: app.getPath('userData'),
        targetRoot: selectedRoot,
      });
      if (move.ok) {
        return {
          ok: true,
          restartRequired: true,
          targetRoot: move.target,
          recordsRoot: path.join(move.target, 'tangbao-data'),
        };
      }
      if (move.code !== 'location_not_writable') return move;

      const permissionAction = await dialog.showMessageBox(owner, {
        type: 'warning',
        title: '数据目录没有写入权限',
        message: '当前 Windows 账户无法写入所选目录',
        detail: (move.path || selectedRoot) + '\n\n请选择“重新选择”换一个可写目录；或选择“打开目录”，在资源管理器中打开属性 → 安全 → 给当前账户授予“修改”权限，然后返回继续选择。',
        buttons: ['重新选择', '打开目录', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (permissionAction.response === 1) {
        try { await shell.openPath(move.path || selectedRoot); } catch (_) {}
        continue;
      }
      if (permissionAction.response === 0) continue;
      return Object.assign({}, move, { canceled: true });
    }
  } catch (error) {
    return { ok: false, code: 'choose_location_failed', error: error && error.message ? error.message : String(error) };
  }
});

safeHandle('app:relaunch', () => {
  try {
    app.relaunch({ args: process.argv.slice(1) });
    setTimeout(() => app.exit(0), 50);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
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

// ===== M3 存储层（SQLite + 文件仓）：一次性迁移入口 =====
// better-sqlite3 是原生模块，未编译（沙箱 / 未 electron-rebuild）时整体不可用，App 继续走 state.json。
let storageService = null;
let storageFileRepo = null;
let storageReady = false;      // 完整性自检通过后才算真正可用
let backupRotatedOnce = false; // 每次启动只轮转一次备份

// M6：文件仓孤儿 GC —— 仅当 SQLite 已是权威源（有 synced_at/migrated_v1）时清理无引用文件
function runFileGC(svc, fileRepo) {
  try {
    if (!svc.getKV || (!svc.getKV('synced_at') && !svc.getKV('migrated_v1'))) return;
    const refImg = new Set((svc.getImageFileNames ? svc.getImageFileNames() : []).filter(Boolean));
    for (const f of (fileRepo.list('images') || [])) if (!refImg.has(f)) fileRepo.remove('images', f);
    const refDoc = new Set((svc.getDocIds ? svc.getDocIds() : []).filter(Boolean));
    for (const f of (fileRepo.list('documents') || [])) if (!refDoc.has(f)) fileRepo.remove('documents', f);
  } catch (e) { console.warn('[存储层] 文件仓 GC 失败（忽略）：', e && e.message ? e.message : e); }
}

function getStorageService() {
  if (storageService && storageReady) return storageService;
  try {
    const { init: initStore, StorageService, checkIntegrity } = require('../infrastructure/storage/sqlite-store');
    const fileRepo = require('../infrastructure/storage/file-repo');
    const userData = app.getPath('userData');
    const dataDir = path.join(userData, 'tangbao-data');
    fs.mkdirSync(dataDir, { recursive: true });
    fileRepo.init(userData);
    storageFileRepo = fileRepo;
    if (!initStore(path.join(dataDir, 'tangbao.db'), fileRepo)) return null;
    // M6：完整性自检失败 → 禁用 SQLite，App 走 state.json 回退链
    if (!checkIntegrity()) {
      console.error('[存储层] SQLite 完整性检查未通过，本次禁用 SQLite，回退 state.json。');
      return null;
    }
    storageService = StorageService;
    storageReady = true;
    // M6：文件仓孤儿 GC（每个启动周期一次）
    try { runFileGC(storageService, storageFileRepo); } catch (_) { /* ignore */ }
    return storageService;
  } catch (e) {
    console.error('[存储层] better-sqlite3 不可用，回退 state.json：', e && e.message ? e.message : e);
    return null;
  }
}

// 渲染进程启动后查询存储层是否可用（用于 UI 提示，不影响主流程）
safeHandle('storage:available', () => ({ ok: !!getStorageService() }));

// 渲染进程把归一化后的 App.state 传过来，一次性灌入 SQLite（迁移器内部幂等 + 失败回滚）
safeHandle('storage:migrate', async (e, stateJson) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite' };
    const userData = app.getPath('userData');
    const dataDir = path.join(userData, 'tangbao-data');
    let raw = '';
    try { raw = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'); } catch (_) { /* 无 state.json 也能迁移（用传入的归一化对象） */ }
    const normalized = JSON.parse(stateJson);
    const migrator = require('../infrastructure/storage/migrator');
    return migrator.run(svc, storageFileRepo, { state: normalized, rawJson: raw, stateDir: dataDir });
  } catch (err) {
    return { ok: false, reason: 'migrate-error', error: err && err.message ? err.message : String(err) };
  }
});

// M4 写穿：把 App.state 整库替换进 SQLite（主数据源）。无 migrated_v1 门槛、幂等；
// 备份策略（M6）：canonical 缺失时直接写；已存在则每个启动周期轮转一次（保留最近 3 份带时间戳副本）。
safeHandle('storage:syncState', async (e, stateJson) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite' };
    const userData = app.getPath('userData');
    const dataDir = path.join(userData, 'tangbao-data');
    const bak = path.join(dataDir, 'state.v1.backup.json');
    const migrator = require('../infrastructure/storage/migrator');
    if (!fs.existsSync(bak)) {
      try { fs.writeFileSync(bak, stateJson || '{}', 'utf8'); } catch (_) { /* 备份失败不阻断同步 */ }
    } else if (!backupRotatedOnce) {
      backupRotatedOnce = true;
      migrator.rotateBackup(dataDir, stateJson || '{}', 3);
    }
    const normalized = JSON.parse(stateJson);
    return migrator.syncState(svc, storageFileRepo, normalized);
  } catch (err) {
    return { ok: false, reason: 'sync-error', error: err && err.message ? err.message : String(err) };
  }
});

// 聊天修复：关闭前同步落盘（sendSync——主进程阻塞同步写 state.json + SQLite，杜绝防抖未送达的竞态丢数据）
// B2（P1）：改用 safeOn 加 assertTrustedSender 鉴权——修复裸 ipcMain.on 可被嵌入 iframe 无鉴权覆写 state.json + SQLite 的问题
safeOn('storage:flushSync', (e, stateJson) => {
  try {
    const userData = app.getPath('userData');
    const dataDir = path.join(userData, 'tangbao-data');
    const stateFile = path.join(dataDir, 'state.json');
    try { fs.writeFileSync(stateFile, String(stateJson || '{}'), 'utf8'); } catch (_) {}
    const svc = getStorageService();
    if (svc && stateJson) {
      try {
        const migrator = require('../infrastructure/storage/migrator');
        const normalized = JSON.parse(stateJson);
        migrator.syncState(svc, storageFileRepo, normalized);
      } catch (_) { /* SQLite 同步失败不阻断退出 */ }
    }
    if (e && e.returnValue === undefined) e.returnValue = { ok: true };
  } catch (err) {
    if (e && e.returnValue === undefined) e.returnValue = { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// M4 读源：从 SQLite 重建 App.state。空库/不可用 → ok:false（渲染层回退 state.json）。
// 新鲜度检查：只有 SQLite 的 synced_at 不早于 state.json mtime 才采用，防 debounce 窗口内 SQLite 落后。
safeHandle('storage:loadState', async () => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite' };
    const userData = app.getPath('userData');
    const migrator = require('../infrastructure/storage/migrator');
    const r = migrator.readState(svc, storageFileRepo);
    if (!r.ok) return r;
    // 聊天修复 B：删除 synced_at vs state.json mtime 新鲜度判定（漏洞源——先前同步把
    // synced_at 推到 ≥mtime 后旧 SQLite 被误判 fresh）；SQLite 现仅作 state.json 缺失时的备份。
    return { ok: true, state: r.state };
  } catch (err) {
    return { ok: false, reason: 'load-error', error: err && err.message ? err.message : String(err) };
  }
});

// M7（v1.0.8）：工作流运行历史独立持久化（不随 App.state 写穿；SQLite 不可用则静默降级）
safeHandle('storage:saveRun', async (_e, run) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite' };
    svc.saveWorkflowRun(run || {});
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'save-run-error', error: err && err.message ? err.message : String(err) };
  }
});

safeHandle('storage:listRuns', async (_e, workflowId, limit) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite', runs: [] };
    return { ok: true, runs: svc.listWorkflowRuns(workflowId, limit) };
  } catch (err) {
    return { ok: false, reason: 'list-runs-error', runs: [], error: err && err.message ? err.message : String(err) };
  }
});

// v1.1.0（M1）：糖码 Agent Run 历史查询（运行列表 / 事件轨迹 / 上下文摘要）
safeHandle('agent:listRuns', async (_e, threadId, limit, offset) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite', runs: [] };
    return { ok: true, runs: svc.listAgentRuns(threadId, limit, offset) };
  } catch (err) {
    return { ok: false, reason: 'list-agent-runs-error', runs: [], error: err && err.message ? err.message : String(err) };
  }
});

safeHandle('agent:runEvents', async (_e, runId) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite', events: [] };
    return { ok: true, events: svc.listAgentEvents(runId) };
  } catch (err) {
    return { ok: false, reason: 'list-agent-events-error', events: [], error: err && err.message ? err.message : String(err) };
  }
});

safeHandle('agent:runTree', async (_e, rootRunId) => {
  try {
    const svc = getStorageService();
    if (!svc || typeof svc.listAgentRunTree !== 'function') return { ok: false, reason: 'no-sqlite', tree: null };
    return { ok: true, tree: svc.listAgentRunTree(rootRunId) };
  } catch (err) { return { ok: false, reason: 'list-agent-run-tree-error', tree: null, error: err && err.message ? err.message : String(err) }; }
});

// v1.1.2：只读 Trace Inspector 查询，按根 Run 分页，避免一次性载入大型事件流。
safeHandle('agent:tracePage', async (_e, input) => {
  try {
    const svc = getStorageService();
    if (!svc || typeof svc.listAgentTracePage !== 'function') return { ok: false, reason: 'no-sqlite', items: [], nextCursor: null, hasMore: false, total: 0 };
    const opts = input && typeof input === 'object' ? input : {};
    return Object.assign({ ok: true }, svc.listAgentTracePage(String(opts.rootRunId || opts.runId || ''), opts));
  } catch (err) {
    return { ok: false, reason: 'agent-trace-page-error', items: [], nextCursor: null, hasMore: false, total: 0, error: err && err.message ? err.message : String(err) };
  }
});

safeHandle('agent:runMetrics', async (_e, rootRunId) => {
  try {
    const svc = getStorageService();
    if (!svc || typeof svc.aggregateAgentRunMetrics !== 'function') return { ok: false, reason: 'no-sqlite', metrics: null };
    return { ok: true, metrics: svc.aggregateAgentRunMetrics(String(rootRunId || '')) };
  } catch (err) { return { ok: false, reason: 'agent-run-metrics-error', metrics: null, error: err && err.message ? err.message : String(err) }; }
});

safeHandle('agent:exportRun', async (_e, runId) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite' };
    const jsonl = svc.exportAgentRun(String(runId || ''));
    if (!jsonl) return { ok: false, error: '未找到该运行记录' };
    const result = await dialog.showSaveDialog(mainWindow, { title: '导出糖码运行轨迹', defaultPath: 'tangbao-run-' + String(runId || '').replace(/[^A-Za-z0-9_-]/g, '_') + '.jsonl', filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, jsonl, 'utf8');
    return { ok: true, filePath: result.filePath };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

safeHandle('agent:exportTrace', async (_e, input) => {
  try {
    const svc = getStorageService();
    if (!svc || typeof svc.exportAgentTrace !== 'function') return { ok: false, reason: 'no-sqlite' };
    const payload = input && typeof input === 'object' ? input : { rootRunId: input };
    const rootRunId = String(payload.rootRunId || payload.runId || '');
    const jsonl = svc.exportAgentTrace({ rootRunId, redacted: true });
    if (!jsonl) return { ok: false, error: '未找到该根运行记录' };
    const result = await dialog.showSaveDialog(mainWindow, { title: '导出脱敏 Agent Trace', defaultPath: 'tangbao-trace-' + rootRunId.replace(/[^A-Za-z0-9_-]/g, '_') + '.jsonl', filters: [{ name: 'JSON Lines', extensions: ['jsonl'] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, jsonl, 'utf8');
    return { ok: true, filePath: result.filePath, redacted: true };
  } catch (err) { return { ok: false, error: err && err.message ? err.message : String(err) }; }
});

// P0 Eval：受控主进程入口。渲染层只能选择白名单 taskId + 当前账户 ref/model，
// 不能传 cwd、base、token 或 fixture 路径；LOCAL_TOKEN 始终留在主进程。
safeHandle('agent:evalTasks', async () => {
  try {
    const tasks = ControlledEval.listSafeTasks(path.join(__dirname, '..', '..'));
    // v16（批量提速）：扫描 eval-runs 已落盘的 machinePassed 结果，标记 alreadyPassed 供面板跳过
    const passedIds = new Set();
    const latestPassedById = new Map();
    try {
      const runsRoot = path.join(app.getPath('userData'), 'tangbao-data', 'eval-runs');
      if (fs.existsSync(runsRoot)) {
        for (const dir of fs.readdirSync(runsRoot)) {
          const rp = path.join(runsRoot, dir, 'eval-result.json');
          if (!fs.existsSync(rp)) continue;
          try {
            const r = JSON.parse(fs.readFileSync(rp, 'utf8'));
            if (r && r.machinePassed === true && r.id) {
              const id = String(r.id);
              passedIds.add(id);
              const prior = latestPassedById.get(id);
              if (!prior || String(r.at || '') > String(prior.at || '')) latestPassedById.set(id, r);
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
    try {
      const dataRoot = path.join(app.getPath('userData'), 'tangbao-data');
      fs.mkdirSync(dataRoot, { recursive: true });
      const readiness = {
        at: new Date().toISOString(),
        runtimes: Object.fromEntries(Array.from(new Set(tasks.flatMap((task) => task.requiredRuntimes || []))).map((runtime) => [runtime, !tasks.some((task) => (task.missingRuntimes || []).includes(runtime))])),
      };
      fs.writeFileSync(path.join(dataRoot, 'eval-runtime-readiness.json'), JSON.stringify(readiness, null, 2), 'utf8');
    } catch (_) {}
    return {
      ok: true,
      tasks: tasks.map((t) => {
        const id = String(t.id);
        const latestPassed = latestPassedById.get(id);
        const metricIncomplete = !!(latestPassed && latestPassed.status === 'completed_by_judge' && !(Number(latestPassed.steps) > 0));
        return Object.assign({}, t, { alreadyPassed: passedIds.has(id), metricIncomplete });
      }),
    };
  } catch (err) { return { ok: false, tasks: [], error: err && err.message ? err.message : String(err) }; }
});

safeHandle('agent:runEval', async (_e, payload) => {
  if (controlledEvalCount >= MAX_CONCURRENT_EVAL) return { ok: false, error: '已有 ' + MAX_CONCURRENT_EVAL + ' 个安全评测在运行' };
  controlledEvalCount++;
  try {
    if (!agentPort) return { ok: false, error: '糖码后端尚未启动' };
    const body = payload && typeof payload === 'object' ? payload : {};
    const appRoot = path.join(__dirname, '..', '..');
    const runsRoot = path.join(app.getPath('userData'), 'tangbao-data', 'eval-runs');
    const result = await ControlledEval.executeSafeTask({
      appRoot,
      runsRoot,
      taskId: body.taskId,
      ref: body.ref,
      model: body.model,
      base: `http://127.0.0.1:${agentPort}`,
      token: LOCAL_TOKEN,
    });
    const { runDir: _privateRunDir, ...publicResult } = result;
    return { ok: true, result: publicResult };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    controlledEvalCount--;
  }
});

/* ---------- v4（技能面板）：技能导入 / 启停（renderer 无文件写权限，经主进程执行） ---------- */
const SKILL_NAME_RE = /^[\p{L}\p{N}_-]{1,64}$/u; // v2（ZIP 兼容）：允许中文等 Unicode 名称，仍拒绝路径/引号等非法字符
const userSkillsDirsList = () => [
  path.join(app.getPath('userData'), 'tangbao-data', 'skills'),
  path.join(os.homedir(), '.tangbao-skills'),
  path.join(os.homedir(), '.workbuddy', 'skills'),
];
const projectSkillRoots = (cwd) => cwd ? [
  path.join(cwd, '.workbuddy', 'skills'),
  path.join(cwd, '.tangbao-skills'),
  path.join(cwd, '.claude', 'skills'),
  path.join(cwd, '.codex', 'skills'),
] : [];
const projectSkillTargetRoot = (cwd) => path.join(cwd, '.workbuddy', 'skills');
const canonicalExistingPath = (value) => {
  const resolved = path.resolve(String(value || ''));
  try { return fs.realpathSync.native(resolved); } catch (_) { return resolved; }
};
const isDirectChildOf = (target, root) => {
  const resolvedTarget = canonicalExistingPath(target);
  const resolvedRoot = canonicalExistingPath(root);
  // B5（P2）：Windows 盘符大小写归一——realpathSync.native 可能返回不同大小写盘符，直接 === 比较会误判
  const norm = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : p);
  return norm(path.dirname(resolvedTarget)) === norm(resolvedRoot) && norm(resolvedTarget) !== norm(resolvedRoot);
};
// 设置页只读列举：直接走主进程，避免依赖糖码后端端口与本地启动令牌。
// v2（统一热刷新）：任何生命周期变更（导入/卸载/移动/恢复/彻底删除/启停/信任/自动触发）后广播，
// renderer 收到后立即刷新设置面板与糖码 / 菜单技能缓存，无需重启。
const broadcastSkillChanged = () => {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('skills:changed', { at: Date.now() }); } catch (_) {}
  }
};
safeHandle('skills:list', async (_e, workspaceId) => {
  try {
    let cwd = '';
    if (workspaceId) {
      const ws = resolveWorkspace(String(workspaceId));
      if (!ws) return { ok: false, error: '无效的工作区标识', skills: [] };
      cwd = ws.cwd;
    }
    // 完整管理枚举不去重：管理页必须显示被覆盖的项目/用户/内置同名实例；Runtime 仍按既有 scanSkills 优先级选生效项。
    const managed = await SkillRegistry.enumerateInstalled(managedSkillRoots(workspaceId));
    const builtinRoot = path.join(__dirname, '..', 'infrastructure', 'agent-runtime', 'skills');
    const builtin = await SkillRegistry.enumerateInstalled([{ scope: 'builtin', dir: builtinRoot }]);
    const all = managed.map((m) => ({ name: m.name, description: m.description, level: m.scope, scope: m.scope, dir: m.dir, enabled: m.enabled }))
      .concat(builtin.map((s) => ({ name: s.name, description: s.description, level: 'builtin', scope: 'builtin', dir: s.dir, enabled: s.enabled !== false })));
    const orderedRoots = [];
    if (cwd) projectSkillRoots(cwd).forEach((dir, index) => orderedRoots.push({ scope: 'project', dir, label: ['项目 .workbuddy', '项目 .tangbao', '项目 .claude', '项目 .codex'][index] || '项目 Skill' }));
    userSkillsDirsList().forEach((dir, index) => orderedRoots.push({ scope: 'user', dir, label: ['糖包用户目录', '用户 .tangbao', '用户 .workbuddy'][index] || '用户 Skill' }));
    orderedRoots.push({ scope: 'builtin', dir: builtinRoot, label: '内置 Skill' });
    const resolvedAll = SkillRegistry.annotateDuplicateResolution(all, orderedRoots);
    const conflicts = SkillSecurity.triggerConflicts(resolvedAll);
    const skills = await Promise.all(resolvedAll.map(async (s) => {
      let manifest = null, security = null, trust = null;
      try { manifest = await SkillRegistry.readManifest(s.dir); } catch (_) {}
      try { security = await SkillSecurity.scan(s.dir); trust = await SkillSecurity.trustStatus(s.dir, security.packageHash); } catch (_) {}
      return {
        name: s.name, description: s.description, level: s.level, dir: s.dir, enabled: s.enabled,
        version: (manifest && manifest.version) || String((s.metadata && s.metadata.version) || ''),
        license: (manifest && manifest.license) || s.license || '', compatibility: (manifest && manifest.compatibility) || s.compatibility || '',
        sourceType: manifest && manifest.sourceType || (s.level === 'builtin' ? 'builtin' : 'directory'), sourcePath: manifest && manifest.sourcePath || '',
        installedAt: manifest && manifest.installedAt || 0, updatedAt: manifest && manifest.updatedAt || 0, autoTrigger: !manifest || manifest.autoTrigger !== false,
        packageHash: security && security.packageHash || (manifest && manifest.packageHash) || '',
        resources: security && security.resources || s.resources || [], capabilities: security && security.capabilities || [],
        risk: security && security.score || 'unknown', risks: security && security.risks || [], trusted: !!(trust && trust.trusted), trustReason: trust && trust.reason || 'untrusted',
        allowedTools: s.allowedTools || '', triggerConflicts: conflicts.filter((item) => item.skills.includes(s.name)),
        duplicateCount: Number(s.duplicateCount) || 1,
        effective: s.effective === true,
        resolution: String(s.resolution || (s.enabled === false ? 'disabled' : 'effective')),
        priorityLabel: String(s.priorityLabel || ''),
        coveredBy: s.coveredBy || null,
      };
    }));
    const external = cwd ? await SkillRegistry.detectExternalSkills(cwd) : [];
    return { ok: true, skills, external, conflicts };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), skills: [] };
  }
});

// 可管理范围只接受已知用户/项目 Skill 根下的直接单个目录；禁止把工作区其他任意子目录当成 Skill 操作。
const isAllowedSkillDir = (dir, workspaceId, scope) => {
  const roots = [];
  const expectedScope = String(scope || '');
  if (!expectedScope || expectedScope === 'user') roots.push(...userSkillsDirsList());
  if (!expectedScope || expectedScope === 'project') {
    if (workspaceId) {
      const ws = resolveWorkspace(String(workspaceId));
      if (ws && ws.cwd) roots.push(...projectSkillRoots(ws.cwd));
    } else {
      for (const v of workspaceRegistry.values()) roots.push(...projectSkillRoots(v && v.cwd));
    }
  }
  return roots.some((root) => isDirectChildOf(dir, root));
};
// v2（生命周期）：完整管理根——用户级两个目录 + 项目级标准/兼容技能目录。
// workspaceId 非空时项目根只含该工作区（列表/管理均限定当前项目上下文）；为空时包含全部已登记工作区。
// 与运行时 scanSkills 分离：管理枚举不去重、不要求目录名=name，保证被覆盖实例与别名目录可管理。
const managedSkillRoots = (workspaceId) => {
  const roots = [];
  for (const base of userSkillsDirsList()) roots.push({ scope: 'user', dir: base });
  const pushProject = (cwd) => {
    for (const dir of projectSkillRoots(cwd)) roots.push({ scope: 'project', dir });
  };
  if (workspaceId) {
    const ws = resolveWorkspace(workspaceId);
    if (ws && ws.cwd) pushProject(ws.cwd);
  } else {
    for (const v of workspaceRegistry.values()) pushProject(v && v.cwd);
  }
  return roots;
};
async function resolveManagedSkill(payload) {
  const name = String((payload && payload.name) || '').trim();
  const workspaceId = String((payload && payload.workspaceId) || '');
  const requestedScope = String((payload && (payload.scope || payload.level)) || '');
  if (requestedScope && !['user', 'project'].includes(requestedScope)) throw Object.assign(new Error('无效的 Skill 作用域'), { code: 'invalid_skill_scope' });
  let cwd = '';
  if (workspaceId) {
    const ws = resolveWorkspace(workspaceId);
    if (!ws) throw Object.assign(new Error('无效的工作区标识'), { code: 'invalid_workspace' });
    cwd = ws.cwd;
  }
  // 完整管理枚举（不去重）：name + dir 精确匹配；dir 缺失时按 name 兜底。
  const rows = await SkillRegistry.enumerateInstalled(managedSkillRoots(workspaceId));
  const requestedDirRaw = String((payload && payload.dir) || '').trim();
  const requestedDir = requestedDirRaw ? canonicalExistingPath(requestedDirRaw) : '';
  let match = rows.find((item) => item.name === name && (!requestedDir || canonicalExistingPath(item.dir) === requestedDir) && (!requestedScope || item.scope === requestedScope));
  if (!match && requestedDir) match = rows.find((item) => canonicalExistingPath(item.dir) === requestedDir && (!requestedScope || item.scope === requestedScope));
  if (!match) throw Object.assign(new Error('未找到可管理的 Skill：' + name), { code: 'skill_not_found' });
  if (!isAllowedSkillDir(match.dir, workspaceId, match.scope)) throw Object.assign(new Error('内置或范围外 Skill 为只读，不能执行该操作'), { code: 'skill_read_only' });
  const meta = await SkillRegistry.readSkillMeta(match.dir);
  return {
    skill: { name: meta.name, level: match.scope, dir: match.dir, enabled: match.enabled },
    meta,
    cwd,
  };
}
safeHandle('skills:import', async (_e, payload) => {
  const scope = String((payload && payload.scope) || 'user');
  const workspaceId = String((payload && payload.workspaceId) || '');
  let targetRoot;
  if (scope === 'project') {
    const ws = workspaceId ? resolveWorkspace(workspaceId) : null;
    if (!ws || !ws.cwd) return { ok: false, error: '请先打开有效项目，再导入项目级 Skill' };
    targetRoot = projectSkillTargetRoot(ws.cwd);
  } else if (scope === 'user') {
    targetRoot = userSkillsDirsList()[0];
  } else {
    return { ok: false, error: '无效的 Skill 安装范围' };
  }
  try {
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: scope === 'project' ? '导入项目 Skill' : '导入用户 Skill',
      properties: ['openFile'],
      filters: [
        { name: 'Agent Skill', extensions: ['zip', 'md'] },
        { name: 'Skill 完整包', extensions: ['zip'] },
        { name: 'SKILL.md', extensions: ['md'] },
      ],
    });
    if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) return { ok: false, canceled: true };
    const sourcePath = picked.filePaths[0];
    const skillPackage = await SkillPackage.packageForSource(sourcePath);
    const incomingManifest = SkillRegistry.manifestFromPackage(skillPackage, { scope, sourceType: skillPackage.sourceType, sourcePath });
    const incomingSecurity = SkillSecurity.scanPackage(skillPackage);
    const compatibility = SkillSecurity.compatibility(skillPackage.skill, { platform: process.platform, tangbaoVersion: app.getVersion(), executables: { node: process.execPath } });
    const targetDir = path.join(targetRoot, skillPackage.skill.name);
    let replace = false;
    if (fs.existsSync(targetDir)) {
      const currentManifest = await SkillRegistry.readManifest(targetDir) || await SkillRegistry.buildManifest(targetDir, { scope });
      const diff = SkillRegistry.diffManifests(currentManifest, incomingManifest);
      const lines = [
        '新增 ' + diff.added.length + ' / 修改 ' + diff.changed.length + ' / 删除 ' + diff.removed.length,
        diff.addedScripts.length ? '新增脚本：' + diff.addedScripts.join('、') : '没有新增脚本',
        '风险等级：' + incomingSecurity.score + '；兼容性：' + (compatibility.ok ? '通过' : compatibility.issues.map((item) => item.message).join('；')),
      ];
      const confirm = await dialog.showMessageBox(mainWindow, {
        type: incomingSecurity.score === 'high' ? 'warning' : 'question',
        title: '替换同名 Skill',
        message: 'Skill「' + skillPackage.skill.name + '」已存在',
        detail: lines.join('\n'),
        buttons: ['取消', '替换'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirm.response !== 1) return { ok: false, canceled: true };
      replace = true;
    } else if (incomingSecurity.score !== 'low' || !compatibility.ok) {
      const confirm = await dialog.showMessageBox(mainWindow, {
        type: 'warning', title: '确认安装 Skill', message: 'Skill「' + skillPackage.skill.name + '」需要确认',
        detail: '风险等级：' + incomingSecurity.score + '\n能力：' + incomingSecurity.capabilities.join('、') + '\n兼容性：' + (compatibility.ok ? '通过' : compatibility.issues.map((item) => item.message).join('；')),
        buttons: ['取消', '仍然安装'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (confirm.response !== 1) return { ok: false, canceled: true };
    }
    const installed = await SkillPackage.installPackage(skillPackage, targetRoot, { replace });
    const manifest = await SkillRegistry.writeManifest(installed.dir, { scope, sourceType: skillPackage.sourceType, sourcePath });
    broadcastSkillChanged();
    return Object.assign({ ok: true, scope, manifest, risk: incomingSecurity.score, compatibility }, installed);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code ? e.code : 'skill_import_failed' };
  }
});
safeHandle('skills:details', async (_e, payload) => {
  try {
    const managed = await resolveManagedSkill(payload);
    const manifest = await SkillRegistry.readManifest(managed.skill.dir) || await SkillRegistry.buildManifest(managed.skill.dir, { scope: managed.skill.level });
    const security = await SkillSecurity.scan(managed.skill.dir);
    const trust = await SkillSecurity.trustStatus(managed.skill.dir, security.packageHash);
    const compatibility = SkillSecurity.compatibility(managed.meta, { platform: process.platform, tangbaoVersion: app.getVersion(), executables: { node: process.execPath } });
    return {
      ok: true,
      skill: managed.skill,
      identity: { name: managed.skill.name, dir: managed.skill.dir, scope: managed.skill.level, workspaceId: String((payload && payload.workspaceId) || '') },
      manifest, security, trust, compatibility,
      capabilities: { edit: true, reveal: true, toggle: true, uninstall: true },
    };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
safeHandle('skills:edit', async (_e, payload) => {
  try {
    const managed = await resolveManagedSkill(payload);
    const enabledPath = path.join(managed.skill.dir, 'SKILL.md');
    const disabledPath = path.join(managed.skill.dir, 'SKILL.md.disabled');
    const target = fs.existsSync(enabledPath) ? enabledPath : disabledPath;
    if (!fs.existsSync(target)) return { ok: false, error: 'Skill 缺少可编辑的 SKILL.md' };
    const result = await shell.openPath(target);
    return result ? { ok: false, error: result } : { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
safeHandle('skills:reveal', async (_e, payload) => {
  try {
    const managed = await resolveManagedSkill(payload);
    const target = fs.existsSync(path.join(managed.skill.dir, 'SKILL.md'))
      ? path.join(managed.skill.dir, 'SKILL.md')
      : path.join(managed.skill.dir, 'SKILL.md.disabled');
    shell.showItemInFolder(target);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
safeHandle('skills:export', async (_e, payload) => {
  try {
    const managed = await resolveManagedSkill(payload);
    const picked = await dialog.showSaveDialog(mainWindow, { title: '导出标准 Skill ZIP', defaultPath: managed.skill.name + '.zip', filters: [{ name: 'Skill ZIP', extensions: ['zip'] }] });
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    return await SkillRegistry.exportStandardZip(managed.skill.dir, picked.filePath);
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
safeHandle('skills:uninstall', async (_e, payload) => {
  try {
    const managed = await resolveManagedSkill(payload);
    const confirm = await dialog.showMessageBox(mainWindow, { type: 'warning', title: '卸载 Skill', message: '卸载「' + managed.skill.name + '」？', detail: 'Skill 将移入糖包隔离目录，不会永久删除。', buttons: ['取消', '卸载'], defaultId: 0, cancelId: 0, noLink: true });
    if (confirm.response !== 1) return { ok: false, canceled: true };
    const quarantine = path.join(app.getPath('userData'), 'tangbao-data', 'skill-quarantine');
    const result = await SkillRegistry.uninstall(managed.skill.dir, quarantine);
    broadcastSkillChanged();
    return result;
  } catch (e) { console.error('[skills:uninstall]', e); return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
safeHandle('skills:quarantine', async () => {
  try {
    const quarantine = path.join(app.getPath('userData'), 'tangbao-data', 'skill-quarantine');
    const list = await SkillRegistry.listQuarantine(quarantine);
    return { ok: true, items: list };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});
safeHandle('skills:restore', async (_e, payload) => {
  try {
    const quarantinePath = String((payload && payload.quarantinePath) || '');
    if (!quarantinePath) return { ok: false, error: '缺少隔离路径' };
    const quarantine = path.resolve(path.join(app.getPath('userData'), 'tangbao-data', 'skill-quarantine'));
    const target = path.resolve(quarantinePath);
    if (target !== quarantine && !target.startsWith(quarantine + path.sep)) return { ok: false, error: '非法隔离路径' };
    // v2（按范围恢复）：默认回到记录的原范围；project 需要目标 workspaceId
    let scope = String((payload && payload.scope) || '');
    if (!scope) { try { const list = await SkillRegistry.listQuarantine(quarantine); const hit = list.find((item) => path.resolve(item.quarantinePath) === target); scope = hit && hit.scope || 'user'; } catch (_) { scope = 'user'; } }
    let targetRoot;
    if (scope === 'project') {
      const ws = resolveWorkspace(String((payload && payload.workspaceId) || ''));
      if (!ws || !ws.cwd) return { ok: false, error: '恢复项目级 Skill 需要打开对应项目' };
      targetRoot = projectSkillTargetRoot(ws.cwd);
    } else {
      scope = 'user';
      targetRoot = userSkillsDirsList()[0];
    }
    const confirm = await dialog.showMessageBox(mainWindow, { type: 'warning', title: '恢复 Skill', message: '恢复「' + path.basename(target) + '」？', detail: '将恢复到' + (scope === 'project' ? '当前项目' : '用户级') + '技能目录；若已存在同名技能则恢复失败。', buttons: ['取消', '恢复'], defaultId: 0, cancelId: 0, noLink: true });
    if (confirm.response !== 1) return { ok: false, canceled: true };
    const restored = await SkillRegistry.restoreFromQuarantine(target, targetRoot);
    // 恢复后按原范围重写清单 scope（隔离目录内清单保留原 scope，这里显式对齐）
    try { await SkillRegistry.writeManifest(restored.dir, { scope, sourceType: 'directory', autoTrigger: true }); } catch (_) {}
    broadcastSkillChanged();
    return Object.assign({ ok: true, scope }, restored);
  } catch (e) { console.error('[skills:restore]', e); return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
// v2（彻底删除）：隔离区 Skill 移入系统回收站（可找回），不做不可逆删除；路径必须位于隔离根内。
safeHandle('skills:purge', async (_e, payload) => {
  try {
    const quarantinePath = String((payload && payload.quarantinePath) || '');
    if (!quarantinePath) return { ok: false, error: '缺少隔离路径' };
    const quarantine = path.resolve(path.join(app.getPath('userData'), 'tangbao-data', 'skill-quarantine'));
    const target = path.resolve(quarantinePath);
    if (target !== quarantine && !target.startsWith(quarantine + path.sep)) return { ok: false, error: '非法隔离路径' };
    const stat = await fs.promises.stat(target).catch(() => null);
    if (!stat || !stat.isDirectory()) return { ok: false, error: '隔离项不存在' };
    const confirm = await dialog.showMessageBox(mainWindow, { type: 'warning', title: '彻底删除 Skill', message: '将「' + path.basename(target) + '」移入系统回收站？', detail: '可从 Windows 回收站找回；此操作不可撤销。', buttons: ['取消', '移入回收站'], defaultId: 0, cancelId: 0, noLink: true });
    if (confirm.response !== 1) return { ok: false, canceled: true };
    await shell.trashItem(target);
    broadcastSkillChanged();
    return { ok: true, quarantinePath: target };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
safeHandle('skills:trust', async (_e, payload) => {
  try {
    const managed = await resolveManagedSkill(payload);
    const security = await SkillSecurity.scan(managed.skill.dir);
    const level = String((payload && payload.level) || 'version');
    if (!['untrusted', 'version', 'source'].includes(level)) return { ok: false, error: '无效的信任级别' };
    if (level === 'untrusted') {
      const trustPath = path.join(managed.skill.dir, SkillRegistry.TRUST_FILE);
      await fs.promises.unlink(trustPath).catch(() => {});
      broadcastSkillChanged();
      return { ok: true, trusted: false };
    }
    const record = await SkillSecurity.writeTrust(managed.skill.dir, { packageHash: security.packageHash, source: String((payload && payload.source) || ''), level, capabilities: security.capabilities });
    broadcastSkillChanged();
    return { ok: true, trusted: true, record };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
safeHandle('skills:autoTrigger', async (_e, payload) => {
  try { const managed = await resolveManagedSkill(payload); const manifest = await SkillRegistry.setAutoTrigger(managed.skill.dir, payload && payload.enabled !== false); broadcastSkillChanged(); return { ok: true, autoTrigger: manifest.autoTrigger }; }
  catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
// v2（等级移动）：项目级 ↔ 用户级原子移动（保留启停/信任/自动触发/资源）；目标同名先展示差异确认后替换。
safeHandle('skills:move', async (_e, payload) => {
  try {
    const managed = await resolveManagedSkill(payload);
    const toScope = String((payload && payload.toScope) || '');
    let targetRoot;
    if (toScope === 'project') {
      const ws = resolveWorkspace(String((payload && payload.toWorkspaceId) || ''));
      if (!ws || !ws.cwd) return { ok: false, error: '请先打开有效项目，再移动为项目级 Skill' };
      targetRoot = projectSkillTargetRoot(ws.cwd);
    } else if (toScope === 'user') {
      targetRoot = userSkillsDirsList()[0];
    } else {
      return { ok: false, error: '无效的目标 Skill 范围' };
    }
    if (managed.skill.level === toScope) return { ok: false, error: 'Skill 已在该范围' };
    const targetDir = path.join(targetRoot, managed.skill.name);
    let replace = false;
    if (fs.existsSync(targetDir)) {
      const currentManifest = await SkillRegistry.readManifest(targetDir) || await SkillRegistry.buildManifest(targetDir, { scope: toScope });
      const incomingManifest = await SkillRegistry.buildManifest(managed.skill.dir, { scope: toScope });
      const diff = SkillRegistry.diffManifests(currentManifest, incomingManifest);
      const confirm = await dialog.showMessageBox(mainWindow, {
        type: 'warning', title: '目标范围存在同名 Skill',
        message: '「' + managed.skill.name + '」在目标范围已存在',
        detail: '移动将替换目标版本。\n新增 ' + diff.added.length + ' / 修改 ' + diff.changed.length + ' / 删除 ' + diff.removed.length + ' 个文件' + (diff.addedScripts.length ? '\n新增脚本：' + diff.addedScripts.join('、') : ''),
        buttons: ['取消', '替换并移动'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (confirm.response !== 1) return { ok: false, canceled: true };
      replace = true;
    }
    const moved = await SkillRegistry.moveSkill(managed.skill.dir, targetRoot, { replace, scope: toScope });
    broadcastSkillChanged();
    return Object.assign({ ok: true, scope: toScope }, moved);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code };
  }
});
safeHandle('skills:importExternal', async (_e, payload) => {
  try {
    const workspaceId = String((payload && payload.workspaceId) || ''); const ws = workspaceId ? resolveWorkspace(workspaceId) : null;
    if (!ws || !ws.cwd) return { ok: false, error: '请先打开有效项目' };
    const candidates = await SkillRegistry.detectExternalSkills(ws.cwd);
    const source = candidates.find((item) => item.name === String(payload.name || '') && item.source === String(payload.source || ''));
    if (!source) return { ok: false, error: '未找到外部 Skill' };
    const pkg = await SkillRegistry.packageFromDirectory(source.dir, { sourceType: source.source });
    const targetRoot = payload.scope === 'user' ? userSkillsDirsList()[0] : projectSkillTargetRoot(ws.cwd);
    const targetDir = path.join(targetRoot, pkg.skill.name); const replace = fs.existsSync(targetDir);
    const installed = await SkillPackage.installPackage(pkg, targetRoot, { replace });
    await SkillRegistry.writeManifest(installed.dir, { scope: payload.scope === 'user' ? 'user' : 'project', sourceType: source.source, sourcePath: source.dir });
    broadcastSkillChanged();
    return Object.assign({ ok: true }, installed);
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
safeHandle('skills:toggle', async (_e, payload) => {
  const name = String((payload && payload.name) || '');
  const enable = !!(payload && payload.enable);
  if (!name || !SKILL_NAME_RE.test(name)) return { ok: false, error: '技能名非法' };
  try {
    const managed = await resolveManagedSkill(payload);
    const dir = managed.skill.dir;
    const fsp = require('fs/promises');
    const from = enable ? path.join(dir, 'SKILL.md.disabled') : path.join(dir, 'SKILL.md');
    const to = enable ? path.join(dir, 'SKILL.md') : path.join(dir, 'SKILL.md.disabled');
    const exists = await fsp.access(from).then(() => true).catch(() => false);
    if (!exists) return { ok: false, error: '找不到 ' + path.basename(from) };
    await fsp.rename(from, to);
    broadcastSkillChanged();
    return { ok: true, name, enabled: enable };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

safeHandle('agent:summary', async (_e, threadId) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite', summary: null };
    return { ok: true, summary: svc.getLatestContextSummary(threadId) };
  } catch (err) {
    return { ok: false, reason: 'get-agent-summary-error', summary: null, error: err && err.message ? err.message : String(err) };
  }
});

// v2（P1-C）：压缩完成后摘要落库（agent_context_summaries，重启后后端读回注入）
safeHandle('agent:saveSummary', async (_e, s) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite' };
    return { ok: true, saved: svc.saveContextSummary(s || {}) };
  } catch (err) {
    return { ok: false, reason: 'save-summary-error', error: err && err.message ? err.message : String(err) };
  }
});

// M6 导入导出：完整数据（含对话/图片/项目）备份为 JSON 文件，经系统文件对话框读写
safeHandle('storage:exportState', async () => {
  try {
    const userData = app.getPath('userData');
    const file = path.join(userData, 'tangbao-data', 'state.json');
    if (!fs.existsSync(file)) return { ok: false, error: '暂无数据可导出' };
    const data = fs.readFileSync(file, 'utf8');
    const r = await dialog.showSaveDialog(mainWindow, {
      title: '导出糖包完整数据备份',
      defaultPath: 'tangbao-backup-' + new Date().toISOString().slice(0, 10) + '.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, data, 'utf8');
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

safeHandle('storage:importState', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '导入糖包完整数据备份',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    const data = fs.readFileSync(r.filePaths[0], 'utf8');
    const obj = JSON.parse(data);
    if (!obj || typeof obj !== 'object' || (!obj.conversations && !obj.settings)) {
      return { ok: false, error: '不是有效的糖包备份文件（缺少 conversations/settings）' };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// 外部「强制嵌入」模块：用糖包子窗口打开（webview 视口锁死 + iframe/proxy subpage 404，嵌入均不可靠，子窗口是唯一全功能方案）
const moduleWindows = new Map();

// ===== 子窗口浏览器伪装与失败诊断（修复 libhd.com 等站点返回 403） =====
// Electron 31.7.7 内置 Chromium 126，UA 对齐 Chrome 126 正式版，避免被站点风控识别为 Electron/自动化客户端
const CHILD_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const CHILD_LANGS = 'zh-CN,zh;q=0.9,en;q=0.8';
// client hints 品牌串需与上面的 Chrome UA 一致：UA 说 Chrome 但 sec-ch-ua 说 Electron 会被反爬立刻识破
const CHILD_CH_UA = '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"';

// webRequest 每个 session 只保留一个监听器（重复注册是覆盖而非堆叠），用 Set 避免重复初始化
const initedPartitions = new Set();

// partition 名进入 session 键空间，需收敛字符集（id 来自用户自定义模块设置）
function modulePartition(id) {
  return 'persist:module_' + String(id || 'default').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
}

function setupModuleSession(partition) {
  const ses = session.fromPartition(partition);
  if (initedPartitions.has(partition)) return ses;
  initedPartitions.add(partition);

  // session 级 UA + Accept-Language（必须在 BrowserWindow 创建前调用：不影响已存在的 WebContents）
  ses.setUserAgent(CHILD_UA, CHILD_LANGS);

  // 补齐 Chrome 客户端提示：setUserAgent 不会同步更新 sec-ch-ua（它源自独立的 UA metadata）
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const h = details.requestHeaders;
    h['User-Agent'] = CHILD_UA;
    h['Accept-Language'] = CHILD_LANGS;
    h['sec-ch-ua'] = CHILD_CH_UA;
    h['sec-ch-ua-mobile'] = '?0';
    h['sec-ch-ua-platform'] = '"Windows"';
    callback({ requestHeaders: h });
  });
  return ses;
}

// 失败回退页：data:text/html，整体 encodeURIComponent 转义（# % & 等都安全）
function buildChildErrorPage(status, statusText, originalUrl) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const safeUrl = esc(originalUrl);
  const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<title>加载失败 ' + esc(status) + '</title><style>'
    + 'body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'background:#1e1e2e;color:#cdd6f4;font-family:system-ui,"Microsoft YaHei",sans-serif}'
    + '.b{max-width:560px;padding:32px;text-align:center}'
    + '.c{font-size:44px;font-weight:700;color:#f38ba8;margin:0 0 12px}'
    + '.m{font-size:15px;line-height:1.7;margin:0 0 18px}'
    + '.u{font-size:12px;word-break:break-all;color:#9399b2;background:#181825;padding:10px;border-radius:8px;margin:0 0 20px}'
    + 'a{display:inline-block;padding:10px 22px;background:#89b4fa;color:#1e1e2e;'
    + 'text-decoration:none;border-radius:8px;font-weight:600;font-size:14px}'
    + '</style></head><body><div class="b">'
    + '<p class="c">' + esc(status) + '</p>'
    + '<p class="m">该站点拒绝了糖包子窗口的访问' + (statusText ? '（' + esc(statusText) + '）' : '') + '。<br>可尝试改用系统浏览器打开。</p>'
    + '<p class="u">' + safeUrl + '</p>'
    // target="_blank" 必须：走 setWindowOpenHandler → shell.openExternal；
    // 普通 <a href> 会被 will-navigate 白名单放行并在原窗导航，又回到 403
    + '<a href="' + safeUrl + '" target="_blank" rel="noreferrer">在系统浏览器打开</a>'
    + '</div></body></html>';
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

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

    // 关键顺序：session 必须在 BrowserWindow 创建前配好（setUserAgent 不影响已存在的 WebContents）
    const partition = modulePartition(id);
    setupModuleSession(partition);

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
        partition,                         // 独立持久分区：登录 cookie 跨次启动留存
        // nativeWindowOpen 已删除：Electron 31 的 WebPreferences 无此键（15+ 起恒为 true），弹窗由下方 setWindowOpenHandler 接管
      },
    });
    // 先登记再加载：loadURL 失败会 reject，避免窗口成为无法复用的孤儿
    moduleWindows.set(id, win);
    win.on('closed', () => moduleWindows.delete(id));

    // webContents 级兜底（防止 session UA 因时序未生效）
    try { win.webContents.setUserAgent(CHILD_UA); } catch (_) {}

    // 子窗口内部导航守卫：只允许 http/https，杜绝 file:/javascript: 跳转逃逸
    win.webContents.on('will-navigate', (event, navUrl) => {
      try { const nu = new URL(navUrl); if (nu.protocol !== 'http:' && nu.protocol !== 'https:') event.preventDefault(); } catch (_) { event.preventDefault(); }
    });
    // 子窗口内 window.open 一律交由系统浏览器（仅 http/https），其余拦截
    win.webContents.setWindowOpenHandler(({ url: childUrl }) => {
      if (isAllowedExternalUrl(childUrl)) { try { shell.openExternal(childUrl); } catch (_) {} }
      return { action: 'deny' };
    });

    // ---- 失败诊断：HTTP >= 400 或网络级失败，替换为可跳系统浏览器的错误页 ----
    let fallbackShown = false;
    const showFallback = (status, statusText) => {
      if (fallbackShown || win.isDestroyed()) return;
      fallbackShown = true;
      try { win.setTitle((label || '外部站点') + ' · 加载失败 ' + status); } catch (_) {}
      // setImmediate：避免在导航事件回调里同步发起新导航
      setImmediate(() => {
        if (!win.isDestroyed()) win.loadURL(buildChildErrorPage(status, statusText, rawUrl)).catch(() => {});
      });
    };

    // did-navigate 直接带主框架 HTTP 状态码（非 HTTP 导航如 data: 为 -1，天然不会自触发）
    win.webContents.on('did-navigate', (_ev, navUrl, httpResponseCode, httpStatusText) => {
      if (httpResponseCode >= 400) {
        console.error('[糖包子窗口] HTTP ' + httpResponseCode + ' ' + httpStatusText + ' → ' + navUrl);
        showFallback(httpResponseCode, httpStatusText);
      }
    });
    // 网络级失败（DNS/TLS/连接重置）；-3 = ERR_ABORTED，多为重定向或用户中断，忽略
    win.webContents.on('did-fail-load', (_ev, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      console.error('[糖包子窗口] did-fail-load ' + errorCode + ' ' + errorDescription + ' → ' + validatedURL);
      showFallback(errorCode, errorDescription);
    });

    // loadURL 在 did-fail-load 时 reject（错误页已由监听器接管），这里吞掉，仍返回 ok 让渲染层显示"已在子窗口打开"
    try { await win.loadURL(rawUrl); } catch (_) {}
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
  // B5（P2）：透明度钳制到 [0,1]，避免 NaN/越界值破坏浮窗可见性
  const raw = typeof v === 'number' ? v : 1;
  const val = Math.min(1, Math.max(0, Number.isFinite(raw) ? raw : 1));
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
        legacyFilePaths: secretStorePaths(app.getPath('userData')),
      });
      if (!info.encrypted) console.error('[糖包] 当前系统密钥服务不可用，API Key 将以未加密形式保存。');
    } catch (e) {
      console.error('[糖包] 密钥库初始化失败：', e);
    }
    // 模型网关与糖码后端都直接从主进程密钥库取密钥，密钥不经渲染层
    gateway.configure({
      getSecret: secrets.getSecret,
      recordModelCallMetric(metric) {
        const svc = getStorageService();
        return svc && typeof svc.recordModelCallMetric === 'function' ? svc.recordModelCallMetric(metric) : null;
      },
    });
    loadWorkspaces(); // M7（#253）：启动即恢复工作区注册表，使持久化的 workspaceId 仍有效
    // v1.1.0（M1）：给糖码后端注入 Agent Run 持久化存储（lazy 代理，storage 就绪后生效；不可用则静默降级为无持久化模式）
const runStoreMethods = ['createAgentRun', 'updateAgentRun', 'listAgentRuns', 'getAgentRun', 'listAgentRunTree', 'appendAgentEvent', 'listAgentEvents', 'upsertWorkingState', 'getWorkingState', 'saveAgentCheckpoint', 'getCheckpoint', 'listCheckpoints', 'saveContextSummary', 'getLatestContextSummary', 'saveChangeset', 'listChangesets', 'recordModelCallMetric', 'upsertAgentRunMetrics', 'aggregateAgentRunMetrics'];
    const runStoreProxy = {};
    runStoreMethods.forEach((m) => {
      runStoreProxy[m] = (...a) => {
        const svc = getStorageService();
        return (svc && typeof svc[m] === 'function') ? svc[m](...a) : null;
      };
    });
    // v1.1.0（M3）：文件仓 Artifact 桥（ChangeSet 快照/日志等大内容走 file-repo 磁盘）
    runStoreProxy.storeArtifact = (category, id, buf) => {
      try { const fr = require('../infrastructure/storage/file-repo'); fr.put(category, id, buf); return true; } catch (e) { return false; }
    };
    runStoreProxy.getArtifact = (category, id) => {
      try { const fr = require('../infrastructure/storage/file-repo'); const b = fr.get(category, id); return b ? b.toString('utf8') : null; } catch (e) { return null; }
    };
    configureAgentServer({
      getSecret: secrets.getSecret,
      getEndpoint: gateway.getEndpoint,
      resolveWorkspace,
      runStore: runStoreProxy,
      // v3（批次4）：用户级 skill 目录——「放目录即被加载」的体验
      userSkillsDirs: userSkillsDirsList(),
    });

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
    // v2（P0-4）：退出前 flush 进行中的 agent run 检查点（同步写 SQLite，避免工作丢失）
    try { flushActiveAgentRuns(); } catch (_) {}
    try { globalShortcut.unregisterAll(); } catch (_) {}
    // 聊天修复：退出前兜底——若 renderer 的同步 flush 未送达，主进程再灌一次 SQLite 备份
    try {
      const svc = getStorageService();
      const userData = app.getPath('userData');
      const stateFile = path.join(userData, 'tangbao-data', 'state.json');
      if (svc && fs.existsSync(stateFile)) {
        const raw = fs.readFileSync(stateFile, 'utf8');
        const migrator = require('../infrastructure/storage/migrator');
        try { migrator.syncState(svc, storageFileRepo, JSON.parse(raw)); } catch (_) {}
      }
    } catch (_) {}
  });
}
