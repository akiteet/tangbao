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
const legacySecretContext = require('../infrastructure/secrets/legacy-context');
const TangguanCore = require('../core/tangguan/tangguan-store');
const TangguanStore = require('../infrastructure/tangguan/tangguan-store');
const ModuleSessions = require('../infrastructure/storage/module-sessions');

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

// Electron's Windows safeStorage context is selected from Local State. Adopt
// the legacy context before app.ready so safeStorage initializes with the old
// key and the migrated ciphertext remains readable.
let adoptedLegacySecretContext = null;
try {
  adoptedLegacySecretContext = legacySecretContext.adoptLegacyContext({
    activeRoot: app.getPath('userData'),
    legacyRoot: defaultUserDataRoot,
  });
  if (adoptedLegacySecretContext.changed) {
    console.warn('[糖包] 已备份当前 Local State，并采用旧数据目录的密钥上下文：', adoptedLegacySecretContext.backupFile || '无备份');
  }
} catch (e) {
  console.warn('[糖包] 旧密钥上下文迁移跳过：', e && e.message ? e.message : e);
}

function secretStorePaths(activeRoot) {
  const roots = [
    activeRoot,
    defaultUserDataRoot,
    startupLocation.pointer && startupLocation.pointer.sourceRoot,
  ].filter(Boolean).map((root) => dataLocation.canonical(root));
  const paths = [];
  for (const root of roots) {
    paths.push(path.join(dataLocation.recordsRoot(root), 'secrets.json'));
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

  const portableRootName = dataLocation.PORTABLE_ROOT_NAME || 'tangbao-storage';

  // Keep the userData root separate from the records directory. The latter is
  // created as <portableRoot>/tangbao-data by the storage layer.
  try {
    const portableRoot = path.join(path.dirname(process.execPath), portableRootName);
    const migrated = dataLocation.migrateRoot(defaultUserData, portableRoot);
    if (migrated.ok) {
      dataLocation.writeLocation(defaultUserData, {
        rootPath: portableRoot,
        sourceRoot: defaultUserData,
        pending: false,
        migrationId: migrated.migrationId,
      });
      app.setPath('userData', portableRoot);
      ok = true;
    }
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
          detail: '位置：' + path.join(exeDir, portableRootName, 'tangbao-data') + '\n\n' +
            '「确定」将尝试创建（可能需要管理员权限）。\n' +
            '「取消」将自动选择 D 盘其他位置。',
          buttons: ['确定', '取消'],
          defaultId: 0,
          cancelId: 1,
        });
        if (answer === 0) {
          try {
            const portableRoot = path.join(exeDir, portableRootName);
            const migrated = dataLocation.migrateRoot(defaultUserData, portableRoot);
            if (migrated.ok) {
              dataLocation.writeLocation(defaultUserData, {
                rootPath: portableRoot,
                sourceRoot: defaultUserData,
                pending: false,
                migrationId: migrated.migrationId,
              });
              app.setPath('userData', portableRoot);
              ok = true;
            }
          } catch (e) { console.error('糖包 授权后仍无法创建数据目录：' + path.join(exeDir, portableRootName, 'tangbao-data'), e); }
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
let latestStateRevision = 0;
let tangguanStoreInstance = null;
let tangguanStoreBackend = null;
let tangguanStoreRoot = '';
let moduleSessionStoreInstance = null;
let moduleSessionStoreRoot = '';
const tangguanImportPreviews = new Map();

function getTangguanStore() {
  const svc = getStorageService();
  const activeRoot = dataLocation.canonical(app.getPath('userData'));
  if (tangguanStoreInstance && tangguanStoreBackend === svc && tangguanStoreRoot === activeRoot) return tangguanStoreInstance;
  const dataDir = dataLocation.recordsRoot(activeRoot);
  tangguanStoreBackend = svc;
  tangguanStoreRoot = activeRoot;
  tangguanStoreInstance = TangguanStore.createStore({
    getKV: svc && typeof svc.getKV === 'function' ? (key) => svc.getKV(key) : null,
    setKV: svc && typeof svc.setKV === 'function' ? (key, value) => svc.setKV(key, value) : null,
    filePath: path.join(dataDir, 'tangguan-library.json'),
    indexPath: path.join(dataDir, 'tangguan-embeddings.index.json'),
  });
  return tangguanStoreInstance;
}

function getModuleSessionStore() {
  const activeRoot = dataLocation.canonical(app.getPath('userData'));
  if (moduleSessionStoreInstance && moduleSessionStoreRoot === activeRoot) return moduleSessionStoreInstance;
  moduleSessionStoreRoot = activeRoot;
  moduleSessionStoreInstance = ModuleSessions.createStore({
    rootDir: dataLocation.recordsRoot(activeRoot),
  });
  return moduleSessionStoreInstance;
}

function extractStateRevision(payload, explicitRevision) {
  const explicit = Number(explicitRevision);
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;
  try {
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    const revision = parsed && parsed._persistence && Number(parsed._persistence.revision);
    return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
  } catch (_) { return 0; }
}

function acceptStateRevision(payload, explicitRevision) {
  let incoming = null;
  try { incoming = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (_) {}
  const incomingSettings = incoming && incoming.settings && typeof incoming.settings === 'object' ? incoming.settings : null;
  const incomingAccounts = incomingSettings && Array.isArray(incomingSettings.accounts) ? incomingSettings.accounts : null;
  // An accidental empty renderer snapshot must never erase a configured
  // account set. The explicit clear-settings action carries a one-shot marker.
  if (incomingAccounts && incomingAccounts.length === 0 && !(incoming && incoming._persistence && incoming._persistence.allowAccountReset === true)) {
    try {
      const current = readActiveStateObject();
      const currentAccounts = current && current.settings && Array.isArray(current.settings.accounts) ? current.settings.accounts : [];
      if (currentAccounts.length > 0) return { ok: false, code: 'account_loss_guard', reason: 'account_loss_guard', error: '拒绝用空账户快照覆盖已有账户' };
    } catch (_) {}
  }
  const revision = extractStateRevision(payload, explicitRevision);
  if (revision > 0 && latestStateRevision > 0 && revision < latestStateRevision) {
    return { ok: false, skipped: true, reason: 'stale_state_revision', revision, latestRevision: latestStateRevision };
  }
  if (revision > latestStateRevision) latestStateRevision = revision;
  return { ok: true, revision };
}

function writeStateFileAtomic(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const temp = file + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp';
  let fd = null;
  try {
    fd = fs.openSync(temp, 'w');
    fs.writeFileSync(fd, String(content || ''), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
    const written = fs.readFileSync(file, 'utf8');
    if (written !== String(content || '')) throw new Error('state_write_verify_failed');
  } catch (error) {
    try { if (fd !== null) fs.closeSync(fd); } catch (_) {}
    try { if (fs.existsSync(temp)) fs.unlinkSync(temp); } catch (_) {}
    throw error;
  }
}

const chatPartialRoot = () => path.join(dataLocation.recordsRoot(app.getPath('userData')), 'chat-partials');
const chatPartialKey = (conversationId, messageId) => crypto.createHash('sha256')
  .update(String(conversationId || '') + '\0' + String(messageId || ''))
  .digest('hex');

function chatPartialFile(conversationId, messageId) {
  return path.join(chatPartialRoot(), chatPartialKey(conversationId, messageId) + '.json');
}

function writeChatPartialPatch(patch, revision) {
  const conversationId = String(patch && patch.conversationId || '');
  const messageId = String(patch && patch.messageId || '');
  if (!conversationId || !messageId) throw new Error('partial_patch_invalid');
  const value = { version: 1, revision: Number(revision) || 0, patch };
  const file = chatPartialFile(conversationId, messageId);
  writeStateFileAtomic(file, JSON.stringify(value));
  return file;
}

function readChatPartialPatches(state) {
  const root = chatPartialRoot();
  if (!state || typeof state !== 'object' || !Array.isArray(state.conversations) || !fs.existsSync(root)) return state;
  let entries = [];
  try { entries = fs.readdirSync(root).filter((name) => name.endsWith('.json')); } catch (_) { return state; }
  const baseRevision = Number(state._persistence && state._persistence.revision) || 0;
  let maxRevision = baseRevision;
  const textField = (value, max) => String(value == null ? '' : value).slice(0, max);
  const mergePartialMessage = (target, incoming, messageId) => {
    if (target && target.role !== 'assistant') return null;
    const message = target || {
      id: messageId,
      role: 'assistant',
      content: '',
      think: '',
      streamStatus: 'partial',
      error: '',
      webSources: null,
      sequence: 0,
      requestId: '',
      startedAt: 0,
      updatedAt: Date.now(),
    };
    message.id = messageId;
    message.role = 'assistant';
    message.content = textField(incoming.content, 4 * 1024 * 1024);
    message.think = textField(incoming.think, 4 * 1024 * 1024);
    message.streamStatus = ['streaming', 'partial', 'completed', 'failed', 'cancelled'].includes(String(incoming.streamStatus))
      ? String(incoming.streamStatus) : 'partial';
    message.error = textField(incoming.error, 1000);
    message.webSources = Number.isFinite(Number(incoming.webSources)) ? Number(incoming.webSources) : null;
    message.sequence = Math.max(0, Number(incoming.sequence) || 0);
    message.requestId = textField(incoming.requestId, 200);
    message.startedAt = Number(incoming.startedAt) || 0;
    message.updatedAt = Number(incoming.updatedAt) || Date.now();
    return message;
  };
  for (const name of entries) {
    let value;
    try { value = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')); } catch (_) { continue; }
    const revision = Number(value && value.revision) || 0;
    const patch = value && value.patch && typeof value.patch === 'object' ? value.patch : null;
    if (!patch || revision <= baseRevision) continue;
    const conversation = state.conversations.find((item) => item && item.id === String(patch.conversationId || ''));
    if (!conversation) continue;
    if (!Array.isArray(conversation.messages)) conversation.messages = [];
    const message = conversation.messages.find((item) => item && item.id === String(patch.messageId || ''));
    const incoming = patch.message && typeof patch.message === 'object' ? patch.message : null;
    if (!incoming) continue;
    const messageId = String(patch.messageId || '');
    const restored = mergePartialMessage(message, incoming, messageId);
    if (!restored) continue;
    if (!message) conversation.messages.push(restored);
    if (patch.conversationUpdatedAt) conversation.updatedAt = Number(patch.conversationUpdatedAt) || conversation.updatedAt;
    maxRevision = Math.max(maxRevision, revision);
  }
  if (maxRevision > baseRevision) {
    state._persistence = Object.assign({}, state._persistence || {}, { revision: maxRevision, savedAt: Date.now(), format: 1 });
    latestStateRevision = Math.max(latestStateRevision, maxRevision);
  }
  return state;
}

function cleanupChatPartials(upToRevision) {
  const root = chatPartialRoot();
  if (!fs.existsSync(root)) return;
  let entries = [];
  try { entries = fs.readdirSync(root).filter((name) => name.endsWith('.json')); } catch (_) { return; }
  for (const name of entries) {
    const file = path.join(root, name);
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if ((Number(value && value.revision) || 0) <= Number(upToRevision || 0)) fs.unlinkSync(file);
    } catch (_) { /* keep malformed partials for diagnostics */ }
  }
}

function redactFloatStateJson(raw) {
  try {
    const state = JSON.parse(String(raw || '{}'));
    const settings = state && state.settings;
    if (settings && typeof settings === 'object') {
      settings.search = {};
      if (Array.isArray(settings.accounts)) {
        settings.accounts = settings.accounts.map((account) => {
          const next = Object.assign({}, account);
          delete next.apiKey;
          return next;
        });
      }
      if (settings.providers && typeof settings.providers === 'object') {
        for (const key of Object.keys(settings.providers)) {
          if (settings.providers[key] && typeof settings.providers[key] === 'object') delete settings.providers[key].apiKey;
        }
      }
    }
    return JSON.stringify(state);
  } catch (_) { return '{}'; }
}
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
safeHandle('workspace:health', (_e, workspaceId) => {
  const workspace = workspaceRegistry.get(String(workspaceId || ''));
  if (!workspace) return { ok: false, code: 'unknown_workspace', error: '当前项目的工作区登记已失效' };
  const roots = (workspace.roots || []).map((root) => {
    const item = { rootId: root.rootId, name: root.name, path: root.path, exists: false, readable: false, writable: false, status: 'offline' };
    try {
      const stat = fs.statSync(root.path);
      item.exists = stat.isDirectory();
      if (item.exists) {
        try { fs.accessSync(root.path, fs.constants.R_OK); item.readable = true; } catch (_) {}
        try { fs.accessSync(root.path, fs.constants.W_OK); item.writable = true; } catch (_) {}
      }
      item.status = item.exists && item.readable && item.writable ? 'healthy' : item.exists && item.readable ? 'degraded' : 'offline';
    } catch (_) {}
    return item;
  });
  const status = roots.length && roots.every((root) => root.status === 'healthy')
    ? 'healthy'
    : roots.some((root) => root.status === 'healthy' || root.status === 'degraded') ? 'degraded' : 'offline';
  return { ok: true, status, checkedAt: Date.now(), roots };
});
// Runtime 获取冻结副本，调用者不能改写主进程注册表。
function resolveWorkspace(id) {
  if (typeof id !== 'string') return null;
  const workspace = workspaceRegistry.get(id);
  if (!workspace) return null;
  const pub = WorkspaceRoots.publicWorkspace(workspace, id);
  return { workspaceId: id, name: pub.name, cwd: pub.cwd, primaryRootId: pub.primaryRootId, roots: pub.roots.map(({ rootId, name, path: rootPath }) => ({ rootId, name, path: rootPath })), fingerprint: WorkspaceRoots.fingerprint(workspace) };
}

// Tangguan and Create conversations live in module sidecars. They never enter
// the ordinary renderer state or the shared Chat history table.
safeHandle('module-sessions:load', (_e, module) => getModuleSessionStore().read(module));
safeHandle('module-sessions:list', (_e, module) => {
  const result = getModuleSessionStore().read(module);
  return result.ok ? { ok: true, module: result.module, conversations: result.data.conversations, activeId: result.data.activeId } : result;
});
safeHandle('module-sessions:get', (_e, module, id) => {
  const result = getModuleSessionStore().read(module);
  if (!result.ok) return result;
  const conversation = result.data.conversations.find((item) => item && item.id === String(id || '')) || null;
  return { ok: true, module: result.module, conversation };
});
safeHandle('module-sessions:save', (_e, module, conversation, activeId) => getModuleSessionStore().saveConversation(module, conversation, activeId));
safeHandle('module-sessions:remove', (_e, module, id) => getModuleSessionStore().removeConversation(module, id));
safeHandle('module-sessions:flushPartial', (_e, input) => getModuleSessionStore().flushPartial(input));
safeHandle('module-sessions:migrateLegacy', (_e, state) => getModuleSessionStore().migrateLegacy(state));
safeHandle('module-sessions:info', () => getModuleSessionStore().info());

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
safeHandle('secrets:diagnose', () => {
  try { return typeof secrets.diagnose === 'function' ? secrets.diagnose() : { ok: false, code: 'secret_diagnose_unsupported' }; }
  catch (error) { return { ok: false, code: 'secret_diagnose_failed', error: error && error.message ? error.message : String(error) }; }
});
safeHandle('secrets:recoverLegacy', () => {
  try {
    const before = typeof secrets.diagnose === 'function' ? secrets.diagnose() : null;
    const context = legacySecretContext.adoptLegacyContext({ activeRoot: app.getPath('userData'), legacyRoot: defaultUserDataRoot });
    if (!context.ok) return context;
    if (context.changed) {
      const info = secrets.init({ safeStorage, filePath: path.join(app.getPath('userData'), 'tangbao-data', 'secrets.json'), legacyFilePaths: secretStorePaths(app.getPath('userData')) });
      if (info.state !== 'ready') {
        legacySecretContext.restoreBackup(path.join(app.getPath('userData'), 'Local State'), context.backupPath);
        secrets.init({ safeStorage, filePath: path.join(app.getPath('userData'), 'tangbao-data', 'secrets.json'), legacyFilePaths: secretStorePaths(app.getPath('userData')) });
        return { ok: false, code: 'secret_context_unavailable', error: '旧密钥上下文无法恢复，原密钥未覆盖', before, context };
      }
    }
    const recovered = typeof secrets.recoverLegacy === 'function' ? secrets.recoverLegacy() : { ok: true, recovered: false };
    return Object.assign({}, recovered, { context, before, status: secrets.getStatus ? secrets.getStatus() : null });
  } catch (error) { return { ok: false, code: 'secret_recovery_failed', error: error && error.message ? error.message : String(error) }; }
});
safeHandle('secrets:reset', () => {
  if (typeof secrets.resetUnreadableStore !== 'function') {
    return { ok: false, code: 'secret_store_reset_unsupported', error: '当前版本不支持重建密钥库' };
  }
  return secrets.resetUnreadableStore();
});

// 渲染进程同步「密钥引用 → API Base」映射表；网关据此决定往哪转发（渲染进程指定不了目标）
safeHandle('gateway:setEndpoints', (e, list) => ({ ok: true, count: gateway.setEndpoints(list) }));

// 图像响应中的远程 URL 只能通过网关受限读取，渲染进程不直接承担跨域下载。
safeHandle('image:fetchAsset', async (_e, input) => {
  const opts = input && typeof input === 'object' ? input : {};
  if (!opts.url) return { ok: false, code: 'image_asset_url_missing' };
  try {
    const result = await gateway.readImageAsset(opts.url, { maxBytes: opts.maxBytes });
    return {
      ok: true,
      dataUrl: result.dataUrl,
      contentType: result.contentType,
      bytes: result.bytes,
    };
  } catch (error) {
    return {
      ok: false,
      code: error && error.type || 'image_asset_fetch_failed',
      error: error && error.message ? error.message : String(error),
    };
  }
});

safeHandle('cache:probe', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    if (!opts.ref || !opts.model) return { ok: false, code: 'cache_probe_args_missing', error: '缺少账户或模型' };
    return await gateway.probeCache(String(opts.ref), String(opts.model), { kind: opts.kind || 'chat' });
  } catch (error) {
    return { ok: false, code: error && error.code || 'cache_probe_failed', type: error && error.type || 'model_failure', error: error && error.message ? error.message : String(error) };
  }
});

safeHandle('model:health', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    return await gateway.healthCheck(String(opts.ref || ''), String(opts.model || ''), String(opts.kind || 'chat'));
  } catch (error) { return { ok: false, error: { type: 'infrastructure_failure', code: 'health_check_failed', message: error && error.message ? error.message : String(error) } }; }
});

safeHandle('model:metrics', async (_e, input) => {
  try {
    const svc = getStorageService();
    if (!svc || (typeof svc.listModelCallMetricsPage !== 'function' && typeof svc.listModelCallMetricsFiltered !== 'function')) return { ok: false, reason: 'no-sqlite', items: [] };
    const opts = input && typeof input === 'object' ? input : {};
    const page = typeof svc.listModelCallMetricsPage === 'function'
      ? svc.listModelCallMetricsPage(opts)
      : { items: svc.listModelCallMetricsFiltered(opts), nextCursor: null, total: null };
    return Object.assign({ ok: true }, page);
  } catch (error) { return { ok: false, reason: 'model-metrics-error', items: [], error: error && error.message ? error.message : String(error) }; }
});

safeHandle('search:query', async (_e, input) => {
  try {
    const svc = getStorageService();
    if (!svc || typeof svc.searchLocal !== 'function') return { ok: false, reason: 'no-sqlite', items: [], nextCursor: null, total: 0 };
    const opts = input && typeof input === 'object' ? input : {};
    const requestedScopes = Array.isArray(opts.scopes) && opts.scopes.length ? opts.scopes.map(String) : [];
    const wantsSkills = !requestedScopes.length || requestedScopes.includes('skill');
    const dbScopes = requestedScopes.filter((scope) => scope !== 'skill');
    const dbResult = svc.searchLocal(opts.query, Object.assign({}, opts, {
      scopes: dbScopes.length ? dbScopes : (wantsSkills ? ['__none__'] : requestedScopes),
      cursor: wantsSkills ? 0 : opts.cursor,
      limit: wantsSkills ? 100 : opts.limit,
    }));
    if (!wantsSkills) return dbResult;
    let skillItems = [];
    try {
      const needle = String(opts.query || '').trim().toLowerCase().slice(0, 160);
      const rows = await SkillRegistry.enumerateInstalled(managedSkillRoots(opts.workspaceId || ''));
      const redact = (value) => String(value || '').replace(/(sk-[A-Za-z0-9_-]{8,}|AIza[0-9A-Za-z_-]{16,}|(?:api[_-]?key|authorization|bearer)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]');
      skillItems = (rows || []).filter((row) => {
        const haystack = [row.name, row.description, row.dir].join('\n').toLowerCase();
        return needle && haystack.includes(needle);
      }).map((row) => ({ scope: 'skill', id: String(row.id || row.name || row.dir || ''), title: redact(row.name || ''), snippet: redact(row.description || ''), updatedAt: Number(row.updatedAt || 0) }));
    } catch (_) { skillItems = []; }
    const all = (dbResult.items || []).concat(skillItems).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    const offset = Math.max(Number(opts.cursor) || 0, 0);
    const limit = Math.min(Math.max(Number(opts.limit) || 30, 1), 100);
    const items = all.slice(offset, offset + limit);
    const total = Number(dbResult.total || 0) + skillItems.length;
    return { ok: dbResult.ok !== false, items, nextCursor: offset + items.length < total ? String(offset + items.length) : null, total };
  } catch (error) {
    return { ok: false, reason: 'search-failed', items: [], nextCursor: null, total: 0, error: error && error.message ? error.message : String(error) };
  }
});

// 渲染进程（主题切换时）用来同步系统标题栏叠加层的颜色，使浅/深色模式下控件都清晰
// Tangguan is a local library. Character cards and worldbook entries are
// stored in kv_meta (with a JSON sidecar fallback), never in the secret store.
safeHandle('tangguan:presets', () => ({ ok: true, presets: TangguanCore.PRESETS.map((item) => ({ id: item.id, label: item.label, summary: item.summary || '', patch: item.patch })) }));
safeHandle('tangguan:getMatureMode', () => {
  try { return { ok: true, matureMode: getTangguanStore().getMatureMode() }; }
  catch (error) { return { ok: false, code: 'tangguan_mature_mode_read_failed', matureMode: false, error: error.message || String(error) }; }
});
safeHandle('tangguan:setMatureMode', (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : { enabled: input === true };
    return getTangguanStore().setMatureMode(opts.enabled === true, opts.confirmed === true);
  } catch (error) { return { ok: false, code: 'tangguan_mature_mode_write_failed', matureMode: false, error: error.message || String(error) }; }
});
safeHandle('tangguan:listCharacters', (_e, input) => {
  try { return getTangguanStore().listCharacters(input || {}); }
  catch (error) { return { ok: false, code: 'tangguan_list_failed', items: [], total: 0, nextCursor: null, error: error.message || String(error) }; }
});
safeHandle('tangguan:getCharacter', (_e, id) => {
  try { return getTangguanStore().getCharacter(id && typeof id === 'object' ? id.id : id); }
  catch (error) { return { ok: false, code: 'tangguan_get_failed', character: null, memories: [], error: error.message || String(error) }; }
});
safeHandle('tangguan:saveCharacter', (_e, input) => {
  try { const opts = input && typeof input === 'object' ? input : {}; return getTangguanStore().saveCharacter(opts.character || opts, opts.expectedRevision); }
  catch (error) { return { ok: false, code: 'tangguan_save_failed', error: error.message || String(error) }; }
});
safeHandle('tangguan:toggleFavorite', (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    return getTangguanStore().toggleFavorite(opts.id, opts.favorite, opts.expectedRevision);
  } catch (error) { return { ok: false, code: 'tangguan_favorite_failed', error: error.message || String(error) }; }
});
safeHandle('tangguan:touchCharacter', (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    return getTangguanStore().touchCharacter(opts.id, opts.expectedRevision);
  } catch (error) { return { ok: false, code: 'tangguan_usage_failed', error: error.message || String(error) }; }
});
safeHandle('tangguan:cloneCharacter', (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    return getTangguanStore().cloneCharacter(opts.id, opts.expectedRevision);
  } catch (error) { return { ok: false, code: 'tangguan_clone_failed', error: error.message || String(error) }; }
});
safeHandle('tangguan:deleteCharacter', (_e, input) => {
  try { const opts = input && typeof input === 'object' ? input : {}; return getTangguanStore().deleteCharacter(opts.id || input, opts.expectedRevision); }
  catch (error) { return { ok: false, code: 'tangguan_delete_failed', error: error.message || String(error) }; }
});
safeHandle('tangguan:previewImport', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    let filePath = String(opts.filePath || '');
    if (!filePath) {
      const picked = await dialog.showOpenDialog(mainWindow, { title: 'Import character card', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (picked.canceled || !picked.filePaths || !picked.filePaths.length) return { ok: false, canceled: true };
      filePath = picked.filePaths[0];
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > TangguanCore.MAX_IMPORT_FILE_BYTES) return { ok: false, code: 'tangguan_import_too_large', error: 'Character card JSON must be no larger than 5MB.' };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const preview = TangguanCore.inspectImport(parsed);
    if (preview.tooLarge) return { ok: false, code: 'tangguan_card_too_large', error: 'Character card JSON must be no larger than 256KB.', bytes: preview.bytes, maxBytes: preview.maxBytes };
    const previewId = 'tgp_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
    tangguanImportPreviews.set(previewId, { bundle: parsed, expiresAt: Date.now() + 10 * 60 * 1000 });
    for (const [key, value] of tangguanImportPreviews) if (!value || value.expiresAt < Date.now()) tangguanImportPreviews.delete(key);
    return { ok: true, preview: true, previewId, character: preview.character, memories: preview.memories, warnings: preview.warnings, mature: preview.mature };
  } catch (error) { return { ok: false, code: 'tangguan_import_preview_failed', error: error.message || String(error) }; }
});
safeHandle('tangguan:importCharacter', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    if (opts.previewId) {
      const pending = tangguanImportPreviews.get(String(opts.previewId));
      if (!pending || pending.expiresAt < Date.now()) return { ok: false, code: 'tangguan_import_preview_expired', error: 'Import preview expired. Please choose the file again.' };
      tangguanImportPreviews.delete(String(opts.previewId));
      return getTangguanStore().importBundle(pending.bundle, opts.expectedRevision);
    }
    let filePath = String(opts.filePath || '');
    if (!filePath) {
      const picked = await dialog.showOpenDialog(mainWindow, { title: '导入角色卡', properties: ['openFile'], filters: [{ name: '角色卡 JSON', extensions: ['json'] }] });
      if (picked.canceled || !picked.filePaths || !picked.filePaths.length) return { ok: false, canceled: true };
      filePath = picked.filePaths[0];
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > TangguanCore.MAX_IMPORT_FILE_BYTES) return { ok: false, code: 'tangguan_import_too_large', error: 'Character card JSON must be no larger than 5MB.' };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const preview = TangguanCore.inspectImport(parsed);
    if (preview.tooLarge) return { ok: false, code: 'tangguan_card_too_large', error: 'Character card JSON must be no larger than 256KB.', bytes: preview.bytes, maxBytes: preview.maxBytes };
    return getTangguanStore().importBundle(parsed, opts.expectedRevision);
  } catch (error) { return { ok: false, code: 'tangguan_import_failed', error: error.message || String(error) }; }
});
safeHandle('tangguan:previewWorldbookImport', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    const characterId = String(opts.characterId || '');
    if (!characterId || !getTangguanStore().getCharacter(characterId).ok) return { ok: false, code: 'tangguan_character_not_found' };
    let filePath = String(opts.filePath || '');
    if (!filePath) {
      const picked = await dialog.showOpenDialog(mainWindow, { title: '导入世界书', properties: ['openFile'], filters: [{ name: '世界书 JSON', extensions: ['json'] }] });
      if (picked.canceled || !picked.filePaths || !picked.filePaths.length) return { ok: false, canceled: true };
      filePath = picked.filePaths[0];
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > TangguanCore.MAX_IMPORT_FILE_BYTES) return { ok: false, code: 'tangguan_import_too_large', error: 'Worldbook JSON must be no larger than 5MB.' };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const detail = getTangguanStore().getCharacter(characterId);
    const inspected = TangguanCore.inspectWorldbookImport(parsed, characterId, {
      character: detail.character,
      memories: detail.memories,
    });
    if (!inspected.importedCount) {
      return {
        ok: false,
        code: 'tangguan_worldbook_empty',
        error: 'No valid worldbook entries found.',
        sourceCount: inspected.sourceCount,
        skippedCount: inspected.skippedCount,
        warnings: inspected.warnings,
      };
    }
    if (inspected.tooLarge) {
      return {
        ok: true,
        preview: true,
        canImport: false,
        characterId,
        count: inspected.importedCount,
        sourceCount: inspected.sourceCount,
        skippedCount: inspected.skippedCount,
        bytes: inspected.bytes,
        maxBytes: inspected.maxBytes,
        warnings: inspected.warnings,
      };
    }
    const previewId = 'tgw_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
    tangguanImportPreviews.set(previewId, { worldbook: parsed, characterId, expiresAt: Date.now() + 10 * 60 * 1000 });
    for (const [key, value] of tangguanImportPreviews) if (!value || value.expiresAt < Date.now()) tangguanImportPreviews.delete(key);
    return {
      ok: true,
      preview: true,
      previewId,
      characterId,
      memories: inspected.memories,
      count: inspected.importedCount,
      sourceCount: inspected.sourceCount,
      skippedCount: inspected.skippedCount,
      warnings: inspected.warnings,
    };
  } catch (error) {
    const code = error instanceof SyntaxError ? 'tangguan_worldbook_invalid_json' : 'tangguan_worldbook_preview_failed';
    return { ok: false, code, error: error.message || String(error) };
  }
});
safeHandle('tangguan:importWorldbook', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    const pending = tangguanImportPreviews.get(String(opts.previewId || ''));
    if (!pending || pending.expiresAt < Date.now() || pending.characterId !== String(opts.characterId || '')) return { ok: false, code: 'tangguan_import_preview_expired', error: 'Import preview expired. Please choose the file again.' };
    tangguanImportPreviews.delete(String(opts.previewId));
    return getTangguanStore().importWorldbook(pending.characterId, pending.worldbook, opts.expectedRevision);
  } catch (error) { return { ok: false, code: 'tangguan_worldbook_import_failed', error: error.message || String(error) }; }
});
safeHandle('tangguan:exportCharacter', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    const item = getTangguanStore().getCharacter(opts.id || input);
    if (!item.ok || !item.character) return { ok: false, code: 'tangguan_character_not_found' };
    const picked = await dialog.showSaveDialog(mainWindow, { title: '导出角色卡', defaultPath: (item.character.name || 'character') + '.json', filters: [{ name: '角色卡 JSON', extensions: ['json'] }] });
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    writeStateFileAtomic(picked.filePath, JSON.stringify(TangguanCore.exportBundle(item.character, item.memories), null, 2));
    return { ok: true, filePath: picked.filePath };
  } catch (error) { return { ok: false, code: 'tangguan_export_failed', error: error.message || String(error) }; }
});
safeHandle('tangguan:listMemory', (_e, input) => {
  try { const opts = input && typeof input === 'object' ? input : {}; return getTangguanStore().listMemory(opts.characterId, opts); }
  catch (error) { return { ok: false, code: 'tangguan_memory_list_failed', items: [], error: error.message || String(error) }; }
});
safeHandle('tangguan:saveMemory', (_e, input) => {
  try { const opts = input && typeof input === 'object' ? input : {}; return getTangguanStore().saveMemory(opts.characterId, opts.memory || {}, opts.expectedRevision); }
  catch (error) { return { ok: false, code: 'tangguan_memory_save_failed', error: error.message || String(error) }; }
});
safeHandle('tangguan:deleteMemory', (_e, input) => {
  try { const opts = input && typeof input === 'object' ? input : {}; return getTangguanStore().deleteMemory(opts.characterId, opts.memoryId, opts.expectedRevision); }
  catch (error) { return { ok: false, code: 'tangguan_memory_delete_failed', error: error.message || String(error) }; }
});
safeHandle('tangguan:retrieveContext', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    const store = getTangguanStore();
    let mode = 'keyword';
    let dataOrigin = 'local-worldbook';
    let unknownReason = null;
    let retrievalOptions = { tokenBudget: opts.tokenBudget, limit: opts.limit };
    if (opts.semantic === true) {
      if (!opts.ref || !opts.model) unknownReason = 'embedding_provider_not_selected';
      else {
        const index = store.getEmbeddingIndex(opts.characterId, opts.model);
        if (!index.ok) unknownReason = index.code || 'embedding_index_unavailable';
        else {
          try {
            const embedded = await gateway.createEmbeddings(String(opts.ref), String(opts.model), [String(opts.query || '')], { callType: 'embedding_query' });
            if (embedded && embedded.ok && Array.isArray(embedded.vectors) && embedded.vectors[0]) {
              retrievalOptions = Object.assign(retrievalOptions, { queryVector: embedded.vectors[0], vectors: index.vectors });
              mode = 'hybrid';
              dataOrigin = 'provider';
            } else unknownReason = 'embedding_result_unknown';
          } catch (error) { unknownReason = error && error.code || 'embedding_provider_failed'; }
        }
      }
    }
    const result = store.retrieveContext(opts.characterId, opts.query, retrievalOptions);
    return Object.assign(result, { mode, dataOrigin, unknownReason, context: TangguanCore.formatContext(result) });
  } catch (error) { return { ok: false, code: 'tangguan_retrieve_failed', items: [], context: '', error: error.message || String(error) }; }
});
safeHandle('tangguan:rebuildIndex', async (_e, input) => {
  const opts = input && typeof input === 'object' ? input : {};
  if (String(opts.mode || 'keyword') === 'semantic') {
    try {
      if (!opts.ref || !opts.model) return { ok: false, code: 'tangguan_embedding_provider_missing', error: 'Choose an account and embedding model first.' };
      const store = getTangguanStore();
      const detail = store.getCharacter(opts.characterId);
      if (!detail.ok || !detail.character) return { ok: false, code: 'tangguan_character_not_found' };
      const memories = Array.isArray(detail.memories) ? detail.memories.filter((item) => item && item.enabled !== false && item.content) : [];
      if (!memories.length) return { ok: false, code: 'tangguan_memory_empty', error: 'Add at least one worldbook entry first.' };
      const embedded = await gateway.createEmbeddings(String(opts.ref), String(opts.model), memories.map((item) => [item.title, item.content, ...(item.keywords || [])].filter(Boolean).join('\\n')), { callType: 'embedding_index' });
      const vectors = {};
      memories.forEach((item, index) => { if (embedded.vectors[index]) vectors[item.id] = embedded.vectors[index]; });
      const rebuilt = store.rebuildEmbeddingIndex(opts.characterId, { modelId: opts.model, vectors, source: embedded.dataOrigin || 'provider' });
      return Object.assign({ ok: true, characterId: String(opts.characterId || ''), mode: 'semantic', dataOrigin: embedded.dataOrigin || 'provider', model: String(opts.model), count: memories.length }, rebuilt);
    } catch (error) { return { ok: false, code: error && error.code || 'tangguan_rebuild_failed', error: error.message || String(error) }; }
  }
  return { ok: true, characterId: String(opts.characterId || ''), mode: 'keyword', requestedMode: String(opts.mode || 'keyword'), dataOrigin: 'local-worldbook', message: '关键词索引无需重建' };
});
safeHandle('tangguan:generateDraft', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    if (!opts.ref || !opts.model) return { ok: false, code: 'tangguan_draft_provider_missing', error: '请先选择账户和模型' };
    const response = await fetch(`http://127.0.0.1:${appPort}/gateway`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LOCAL_TOKEN },
      body: JSON.stringify({ ref: String(opts.ref), kind: 'chat', payload: { model: String(opts.model), stream: false, response_format: { type: 'json_object' }, messages: [
        { role: 'system', content: 'Return only one valid JSON object for a local character card. Allowed keys: name, tagline, description, personality, scenario, greeting, firstMessage, exampleDialogue, systemPrompt, tags, matureAllowed. No Markdown, no code fences, no claims about saving. If a field is requested, improve only that field while keeping the other fields concise.' },
        { role: 'user', content: String(opts.brief || '').slice(0, 4000) },
      ] }, telemetry: { scope: 'tangguan', callType: 'tangguan_character_draft' } }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, code: 'tangguan_draft_provider_failed', error: body && body.error && body.error.message ? body.error.message : '模型请求失败' };
    const choice = body && body.choices && body.choices[0] && body.choices[0].message;
    const raw = choice && (choice.content || choice.reasoning_content);
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, code: 'tangguan_draft_invalid_json', error: 'The model returned no JSON draft.' };
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return { ok: false, code: 'tangguan_draft_invalid_json', error: 'The model returned invalid JSON; nothing was saved.' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'tangguan_draft_invalid_json', error: 'The model draft is not a JSON object.' };
    const normalized = TangguanCore.normalizeCharacter(parsed);
    delete normalized.id; delete normalized.createdAt; delete normalized.updatedAt;
    return { ok: true, draft: normalized, costNotice: true };
  } catch (error) { return { ok: false, code: 'tangguan_draft_failed', error: error.message || String(error) }; }
});

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
safeHandle('storage:info', () => storageInfo());

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
safeHandle('fs:writeState', async (e, jsonStr, revision) => {
  try {
    const gate = acceptStateRevision(jsonStr, revision);
    if (!gate.ok) return gate;
    const userData = app.getPath('userData');
    const dir = path.join(userData, 'tangbao-data');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'state.json');
    // 安全检查：最终路径必须在 userData 子树内
    if (!file.startsWith(userData + path.sep)) return { ok: false, error: '路径越权' };
    writeStateFileAtomic(file, jsonStr || '');
    cleanupChatPartials(gate.revision);
    return { ok: true, revision: gate.revision };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// 读取应用状态文件（与端口无关，作为 localStorage 的权威回退源）
// 流式聊天的显式中间态落盘：只写 state.json，不触发 SQLite 全量写穿。
safeHandle('chat:flushPartial', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    if (opts.patch && typeof opts.patch === 'object') {
      const patch = opts.patch;
      const conversationId = String(patch.conversationId || '');
      const messageId = String(patch.messageId || '');
      const incomingMessage = patch.message && typeof patch.message === 'object' ? patch.message : null;
      if (!conversationId || !messageId || !incomingMessage) return { ok: false, code: 'partial_patch_invalid' };
      if (conversationId.length > 160 || messageId.length > 160) return { ok: false, code: 'partial_patch_invalid' };
      if (incomingMessage.role && String(incomingMessage.role) !== 'assistant') return { ok: false, code: 'partial_patch_invalid' };
      const gate = acceptStateRevision({ partial: true }, opts.revision);
      if (!gate.ok) return gate;
      const textField = (value, max) => String(value == null ? '' : value).slice(0, max);
      const safePatch = {
        conversationId,
        messageId,
        message: {
          content: textField(incomingMessage.content, 4 * 1024 * 1024),
          think: textField(incomingMessage.think, 4 * 1024 * 1024),
          streamStatus: ['streaming', 'partial', 'completed', 'failed', 'cancelled'].includes(String(incomingMessage.streamStatus)) ? String(incomingMessage.streamStatus) : 'partial',
          error: textField(incomingMessage.error, 1000),
          webSources: Number.isFinite(Number(incomingMessage.webSources)) ? Number(incomingMessage.webSources) : null,
          sequence: Math.max(0, Number(incomingMessage.sequence) || 0),
          requestId: textField(incomingMessage.requestId, 200),
          startedAt: Number(incomingMessage.startedAt) || 0,
          updatedAt: Number(incomingMessage.updatedAt) || Date.now(),
        },
        conversationUpdatedAt: Number(patch.conversationUpdatedAt) || Date.now(),
      };
      writeChatPartialPatch(safePatch, gate.revision);
      return { ok: true, revision: gate.revision, durable: 'chat-partial', partial: true, conversationId, messageId };
    }
    const json = typeof opts.stateJson === 'string' ? opts.stateJson : (typeof opts.json === 'string' ? opts.json : '');
    if (!json) return { ok: false, code: 'partial_state_missing' };
    const gate = acceptStateRevision(json, opts.revision);
    if (!gate.ok) return gate;
    const userData = app.getPath('userData');
    const dir = path.join(userData, 'tangbao-data');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'state.json');
    if (!file.startsWith(userData + path.sep)) return { ok: false, code: 'path_denied' };
    writeStateFileAtomic(file, json);
    return { ok: true, revision: gate.revision, durable: 'state.json', conversationId: String(opts.conversationId || ''), messageId: String(opts.messageId || '') };
  } catch (error) {
    return { ok: false, code: 'partial_state_write_failed', error: error && error.message ? error.message : String(error) };
  }
});

safeHandle('fs:readState', async () => {
  try {
    const userData = app.getPath('userData');
    const file = path.join(userData, 'tangbao-data', 'state.json');
    // 安全检查：最终路径必须在 userData 子树内
    if (!file.startsWith(userData + path.sep)) return { ok: false, error: '路径越权' };
    if (!fs.existsSync(file)) return { ok: true, data: null };
      const state = readChatPartialPatches(JSON.parse(fs.readFileSync(file, 'utf8')));
      const data = JSON.stringify(state, null, 2);
      latestStateRevision = Math.max(latestStateRevision, extractStateRevision(data));
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
let storageFailure = '';

// v1.1.3：文件仓只做审计，不自动删除用户文件；清理必须经过预览和显式隔离操作。
function auditFileRepo(svc, fileRepo) {
  try {
    const refImg = new Set((svc.getImageFileNames ? svc.getImageFileNames() : []).filter(Boolean));
    const orphanImages = (fileRepo.list('images') || []).filter((f) => !refImg.has(f));
    const refDoc = new Set((svc.getDocIds ? svc.getDocIds() : []).filter(Boolean));
    const orphanDocuments = (fileRepo.list('documents') || []).filter((f) => !refDoc.has(f));
    const trace = svc && typeof svc.auditAgentTrace === 'function'
      ? svc.auditAgentTrace()
      : { ok: false, orphanEvents: [], invalidEvents: [], duplicateSequences: [] };
    return { orphanImages, orphanDocuments, trace };
  } catch (e) { console.warn('[存储层] 文件仓 GC 失败（忽略）：', e && e.message ? e.message : e); }
  return { orphanImages: [], orphanDocuments: [], trace: { ok: false, orphanEvents: [], invalidEvents: [], duplicateSequences: [] } };
}

function stateShape(value) {
  const state = value && typeof value === 'object' ? value : {};
  const settings = state.settings && typeof state.settings === 'object' ? state.settings : {};
  return {
    conversations: Array.isArray(state.conversations) ? state.conversations.length : null,
    accounts: Array.isArray(settings.accounts) ? settings.accounts.length : null,
    documents: Array.isArray(settings.docs) ? settings.docs.length : null,
    images: Array.isArray(settings.imageHistory) ? settings.imageHistory.length : null,
    projects: Array.isArray(state.projects) ? state.projects.length : null,
    threads: Array.isArray(state.agentThreads) ? state.agentThreads.length : null,
  };
}

function auditStateConsistency(svc) {
  const disk = readActiveStateObject();
  if (!disk) return { status: 'unknown', reason: 'state_missing', disk: null, sqlite: null, mismatches: [] };
  if (!svc || typeof svc.ready !== 'function' || !svc.ready()) {
    return { status: 'unknown', reason: 'sqlite_unavailable', disk: stateShape(disk), sqlite: null, mismatches: [] };
  }
  try {
    const migrator = require('../infrastructure/storage/migrator');
    const loaded = migrator.readState(svc, storageFileRepo);
    if (!loaded || !loaded.ok) return { status: 'unknown', reason: loaded && loaded.reason || 'sqlite_state_unavailable', disk: stateShape(disk), sqlite: null, mismatches: [] };
    const left = stateShape(disk);
    const right = stateShape(loaded.state);
    const mismatches = Object.keys(left)
      .filter((key) => left[key] != null && right[key] != null && left[key] !== right[key])
      .map((key) => ({ field: key, disk: left[key], sqlite: right[key] }));
    return { status: mismatches.length ? 'inconsistent' : 'consistent', disk: left, sqlite: right, mismatches };
  } catch (error) {
    return { status: 'unknown', reason: 'consistency_check_failed', disk: stateShape(disk), sqlite: null, mismatches: [], error: error && error.message ? error.message : String(error) };
  }
}

function listStorageBackups() {
  const dataDir = path.join(app.getPath('userData'), 'tangbao-data');
  try {
    return fs.readdirSync(dataDir)
      .filter((name) => /(?:backup|before-restore|pre-v|unreadable|secret-context)/i.test(name))
      .slice(0, 100)
      .map((name) => {
        const filePath = path.join(dataDir, name);
        let stat = null;
        try { stat = fs.statSync(filePath); } catch (_) {}
        return { name, path: filePath, bytes: stat && stat.isFile() ? stat.size : 0, isDirectory: !!(stat && stat.isDirectory()) };
      });
  } catch (_) { return []; }
}

function storageInfo() {
  const info = dataLocation.describe({ defaultRoot: defaultUserDataRoot, activeRoot: app.getPath('userData') });
  info.startupMigration = startupLocation && startupLocation.migration && startupLocation.migration.ok === false
    ? startupLocation.migration
    : null;
  const svc = getStorageService();
  info.database = { path: svc && svc.dbPathInfo ? svc.dbPathInfo() : path.join(app.getPath('userData'), 'tangbao-data', 'tangbao.db'), available: !!svc, integrity: svc && typeof svc.checkIntegrity === 'function' ? !!svc.checkIntegrity() : false, reason: svc ? '' : (storageFailure || 'sqlite_unavailable') };
  info.secretStore = typeof secrets.getStatus === 'function' ? secrets.getStatus() : null;
  info.audit = svc && storageFileRepo ? auditFileRepo(svc, storageFileRepo) : { orphanImages: [], orphanDocuments: [], trace: { ok: false, orphanEvents: [], invalidEvents: [], duplicateSequences: [] } };
  info.audit.stateConsistency = auditStateConsistency(svc);
  info.backups = listStorageBackups();
  info.moduleSessions = getModuleSessionStore().info();
  return info;
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
    if (!initStore(path.join(dataDir, 'tangbao.db'), fileRepo)) {
      storageFailure = 'sqlite_init_failed';
      return null;
    }
    if (!checkIntegrity()) {
      storageFailure = 'sqlite_integrity_failed';
      return null;
    }
    storageFailure = '';
    storageService = StorageService;
    storageReady = true;
    // v1.1.3：启动只审计文件仓，不自动删除孤儿图片/文档。
    try { auditFileRepo(storageService, storageFileRepo); } catch (_) { /* ignore */ }
    return storageService;
  } catch (e) {
    storageFailure = 'sqlite_unavailable';
    console.error('[存储层] better-sqlite3 不可用，回退 state.json：', e && e.message ? e.message : e);
    return null;
  }
}

// 渲染进程启动后查询存储层是否可用（用于 UI 提示，不影响主流程）
safeHandle('storage:available', () => {
  const available = !!getStorageService();
  return { ok: available, reason: available ? '' : (storageFailure || 'sqlite_unavailable'), fallback: 'state.json' };
});

safeHandle('storage:verifyMigration', () => {
  try {
    const info = dataLocation.describe({ defaultRoot: defaultUserDataRoot, activeRoot: app.getPath('userData') });
    const migration = info.migration || {};
    if (!migration.sourceRoot || !migration.targetRoot) return { ok: false, code: 'migration_not_found', status: 'unknown' };
    return dataLocation.verifyMigration({ pointerRoot: defaultUserDataRoot, sourceRoot: migration.sourceRoot, targetRoot: migration.targetRoot, migrationId: migration.id });
  } catch (error) { return { ok: false, code: 'migration_verify_failed', error: error && error.message ? error.message : String(error) }; }
});

safeHandle('storage:cleanupPreview', () => dataLocation.cleanupPreview({ defaultRoot: defaultUserDataRoot, activeRoot: app.getPath('userData') }));
safeHandle('storage:cleanupLegacy', (_e, input) => dataLocation.cleanupLegacy({ defaultRoot: defaultUserDataRoot, activeRoot: app.getPath('userData'), previewId: input && input.previewId }));

function redactBackupValue(value, key) {
  if (key && /api[_-]?key|authorization|password|secret|token|credential/i.test(String(key))) return undefined;
  if (Array.isArray(value)) return value.map((item) => redactBackupValue(item, '')).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const safe = redactBackupValue(childValue, childKey);
      if (safe !== undefined) out[childKey] = safe;
    }
    return out;
  }
  return value;
}

function readActiveStateObject() {
  const file = path.join(app.getPath('userData'), 'tangbao-data', 'state.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

safeHandle('storage:backup', async (_e, input) => {
  try {
    const state = readActiveStateObject();
    if (!state || typeof state !== 'object') return { ok: false, code: 'storage_state_missing', error: '暂无可备份数据' };
    const payload = { format: 'tangbao-backup', reportVersion: 2, createdAt: new Date().toISOString(), schemaVersion: 16, storage: dataLocation.describe({ defaultRoot: defaultUserDataRoot, activeRoot: app.getPath('userData') }), state: redactBackupValue(state) };
    const opts = input && typeof input === 'object' ? input : {};
    const chosen = opts.filePath ? String(opts.filePath) : '';
    const result = chosen ? { canceled: false, filePath: chosen } : await dialog.showSaveDialog(mainWindow, { title: '导出糖包脱敏备份', defaultPath: 'tangbao-backup-' + new Date().toISOString().slice(0, 10) + '.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, filePath: result.filePath, includeSecrets: false, reportVersion: 2 };
  } catch (error) { return { ok: false, code: 'storage_backup_failed', error: error && error.message ? error.message : String(error) }; }
});

safeHandle('storage:diagnostics', async () => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出脱敏诊断包',
      defaultPath: 'tangbao-diagnostics-' + new Date().toISOString().slice(0, 10) + '.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const payload = {
      format: 'tangbao-diagnostics',
      reportVersion: 2,
      createdAt: new Date().toISOString(),
      appVersion: require('../../package.json').version,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron,
      storage: storageInfo(),
      secrets: typeof secrets.diagnose === 'function' ? secrets.diagnose() : null,
      note: '此诊断包不包含 API Key、Prompt、消息正文或模型输出。',
    };
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, filePath: result.filePath, redacted: true };
  } catch (error) {
    return { ok: false, code: 'diagnostics_export_failed', error: error && error.message ? error.message : String(error) };
  }
});

safeHandle('storage:restore', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    const selected = opts.filePath ? { canceled: false, filePaths: [String(opts.filePath)] } : await dialog.showOpenDialog(mainWindow, { title: '恢复糖包脱敏备份', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (selected.canceled || !selected.filePaths || !selected.filePaths.length) return { ok: false, canceled: true };
    const source = selected.filePaths[0];
    const parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
    const state = parsed && parsed.format === 'tangbao-backup' ? parsed.state : parsed;
    if (!state || typeof state !== 'object' || (!state.conversations && !state.settings)) return { ok: false, code: 'invalid_backup', error: '备份文件缺少有效的 conversations/settings' };
    const safeState = redactBackupValue(state);
    const dataDir = path.join(app.getPath('userData'), 'tangbao-data');
    fs.mkdirSync(dataDir, { recursive: true });
    const stateFile = path.join(dataDir, 'state.json');
    const previous = stateFile + '.before-restore-' + Date.now() + '.json';
    if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, previous);
    const temp = stateFile + '.restore.tmp';
    fs.writeFileSync(temp, JSON.stringify(safeState, null, 2), 'utf8');
    fs.renameSync(temp, stateFile);
    const svc = getStorageService();
    if (svc) {
      try { require('../infrastructure/storage/migrator').syncState(svc, storageFileRepo, safeState); } catch (_) {}
    }
    return { ok: true, restartRequired: true, backupFile: previous, includeSecrets: false };
  } catch (error) { return { ok: false, code: 'storage_restore_failed', error: error && error.message ? error.message : String(error) }; }
});

// 渲染进程把归一化后的 App.state 传过来，一次性灌入 SQLite（迁移器内部幂等 + 失败回滚）
safeHandle('storage:migrate', async (e, stateJson) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite', fallback: 'state.json', storageFailure };
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
safeHandle('storage:syncState', async (e, stateJson, revision) => {
  try {
    const gate = acceptStateRevision(stateJson, revision);
    if (!gate.ok) return gate;
    const normalized = JSON.parse(stateJson);
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite', fallback: 'state.json', storageFailure };
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
      return Object.assign({}, migrator.syncState(svc, storageFileRepo, normalized), { revision: gate.revision });
  } catch (err) {
    return { ok: false, reason: 'sync-error', error: err && err.message ? err.message : String(err) };
  }
});

// 聊天修复：关闭前同步落盘（sendSync——主进程阻塞同步写 state.json + SQLite，杜绝防抖未送达的竞态丢数据）
// B2（P1）：改用 safeOn 加 assertTrustedSender 鉴权——修复裸 ipcMain.on 可被嵌入 iframe 无鉴权覆写 state.json + SQLite 的问题
safeOn('storage:flushSync', (e, stateJson, revision) => {
    try {
      const gate = acceptStateRevision(stateJson, revision);
      if (!gate.ok) {
        if (e && e.returnValue === undefined) e.returnValue = gate;
        return;
      }
      const userData = app.getPath('userData');
      const dataDir = path.join(userData, 'tangbao-data');
      const stateFile = path.join(dataDir, 'state.json');
      let fileError = null;
      try { writeStateFileAtomic(stateFile, String(stateJson || '{}')); } catch (error) { fileError = error; }
      const svc = getStorageService();
      let sqlite = { ok: false, reason: storageFailure || 'no-sqlite', fallback: 'state.json' };
      if (!fileError && svc && stateJson) {
      try {
        const migrator = require('../infrastructure/storage/migrator');
        const normalized = JSON.parse(stateJson);
        const syncResult = migrator.syncState(svc, storageFileRepo, normalized);
        sqlite = Object.assign({}, syncResult, { ok: !syncResult || syncResult.ok !== false });
      } catch (error) { sqlite = { ok: false, reason: 'sqlite_sync_failed', error: error && error.message ? error.message : String(error), fallback: 'state.json' }; }
      }
      if (e && e.returnValue === undefined) e.returnValue = fileError
        ? { ok: false, code: 'state_file_write_failed', error: fileError.message || String(fileError), revision: gate.revision }
        : { ok: true, revision: gate.revision, file: 'saved', sqlite };
  } catch (err) {
    if (e && e.returnValue === undefined) e.returnValue = { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// M4 读源：从 SQLite 重建 App.state。空库/不可用 → ok:false（渲染层回退 state.json）。
// 新鲜度检查：只有 SQLite 的 synced_at 不早于 state.json mtime 才采用，防 debounce 窗口内 SQLite 落后。
safeHandle('storage:loadState', async () => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite', fallback: 'state.json', storageFailure };
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

// v1.1.3：只读 Trace Inspector 查询，按根 Run 分页，避免一次性载入大型事件流。
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
     + 'background:#1e1e2e;color:#cdd6f4;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei","Helvetica Neue",Arial,sans-serif}'
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
        win.webContents.send('float:init', redactFloatStateJson(raw));
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
    if (!mainWindow || e.sender === mainWindow.webContents) return;
    if (!s || typeof s !== 'object' || !Array.isArray(s.conversations)) return;
    mainWindow.webContents.send('float:apply', {
      type: 'patch',
      conversations: s.conversations,
      activeId: s.activeId,
      web: s.web,
      thinkLevel: s.thinkLevel,
    });
  });

  // Main window -> float: send the latest in-memory snapshot. This path never
  // writes storage and is intentionally separate from the float patch path.
  safeOn('float:pushState', (e, payload) => {
    if (!mainWindow || e.sender !== mainWindow.webContents) return;
    if (!payload || typeof payload !== 'object' || !payload.state || typeof payload.state !== 'object') return;
    floatWindows.forEach((w) => {
      if (!w.isDestroyed()) w.webContents.send('float:state', payload);
    });
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
      if (adoptedLegacySecretContext && adoptedLegacySecretContext.changed && info.state !== 'ready') {
        legacySecretContext.restoreBackup(
          path.join(app.getPath('userData'), 'Local State'),
          adoptedLegacySecretContext.backupPath,
        );
        console.error('[糖包] 旧密钥上下文迁移后仍无法读取密钥，已恢复当前 Local State。');
      }
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
