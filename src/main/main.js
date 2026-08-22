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
const { createTokenChecker, isLoopbackHost } = require('../infrastructure/http/request-auth');
const { userSkillsDirsList, createMainSkills } = require('./main-skills'); // v1.1.7 批次 E：技能目录辅助 + 技能 IPC 工厂
const { createMainStorage } = require('./main-storage'); // v1.1.8 批次 F：存储域工厂
const { createMainTangguan } = require('./main-tangguan'); // v1.1.8 批次 F：糖馆域工厂
const { createMainAgentRuns } = require('./main-agent-runs'); // v1.1.8 批次 F：糖码 Run 域工厂
const { createMainFloat } = require('./main-float'); // v1.1.8 批次 F：浮窗域工厂
let createRunStoreProxy; // 由底部 createMainAgentRuns 初始化后赋值，whenReady 构造 runStore 用
// v1.1.8 批次 F：浮窗三件套由底部 createMainFloat 初始化后赋值（托盘/快捷键/启动恢复/主窗关闭钩子使用）
let toggleFloatWindow;
let restoreFloatWindowIfOpen;
let closeAllFloatWindows;
let managedSkillRoots; // 由底部 createMainSkills 初始化后赋值，搜索 handler 请求时读取
// v1.1.8 批次 F：存储域三件套由底部 createMainStorage 初始化后赋值（IPC 请求/退出钩子均在初始化后触发）
let getStorageService;
let readActiveStateObject;
let getStorageFileRepo;
const legacySecretContext = require('../infrastructure/secrets/legacy-context');
const ImageAssets = require('../infrastructure/storage/image-assets');
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
const checkToken = createTokenChecker(LOCAL_TOKEN);

let staticServer = null;
let mainWindow = null;
let latestStateRevision = 0;
let moduleSessionStoreInstance = null;
let moduleSessionStoreRoot = '';
let imageAssetStoreInstance = null;
let imageAssetStoreRoot = '';
// v1.1.5（批次 D1）：糖绘历史图片资产存储（数据根 images/ 目录，含 500MB 配额）
function getImageAssetStore() {
  const activeRoot = dataLocation.canonical(app.getPath('userData'));
  if (imageAssetStoreInstance && imageAssetStoreRoot === activeRoot) return imageAssetStoreInstance;
  imageAssetStoreRoot = activeRoot;
  imageAssetStoreInstance = ImageAssets.createImageAssetStore({
    dir: path.join(dataLocation.recordsRoot(activeRoot), 'images'),
  });
  return imageAssetStoreInstance;
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
  // v1.1.8 Q1：customModules/visionModels 空快照守卫——会话数 >0 且磁盘当前值非空时，
  // 拒绝用空列表覆盖（同 account_loss_guard 模式；2026-08-22 事故：拖拽写空 + 写穿同步三处同时清空）。
  // 合法的"清空全部模块/视觉模型"操作目前不存在（编辑器只有逐个删除），故无需 one-shot 豁免标记。
  if (incomingSettings && Array.isArray(incoming.conversations) && incoming.conversations.length > 0) {
    try {
      const current = readActiveStateObject();
      const cs = current && current.settings || {};
      for (const field of ['customModules', 'visionModels']) {
        const incomingList = incomingSettings[field];
        const currentList = cs[field];
        if (Array.isArray(incomingList) && incomingList.length === 0 && Array.isArray(currentList) && currentList.length > 0) {
          return { ok: false, code: 'settings_loss_guard', reason: 'settings_loss_guard', error: '拒绝用空 ' + field + ' 覆盖已有配置' };
        }
      }
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


// 常数时间比较，避免用 === 比较令牌时被时序侧信道逐字节猜出
// 本地 API 鉴权：必须带 Authorization: Bearer <启动令牌>
// DNS 重绑定防护：Host 必须指向回环地址
// ——三者的实现在 v1.1.5 收敛到 src/infrastructure/http/request-auth.js（与糖码后端共用）

// 判断来源是否为本应用自身（同源）。文档导航没有 Origin 头，此时按无 Origin 处理。
function isSelfOrigin(v) {
  if (!v) return true;
  return v === `http://127.0.0.1:${appPort}` || v === `http://localhost:${appPort}`;
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
// 而糖码后端跑在系统分配的随机端口上（src/renderer/runtime.js agentBase()），不带 :* 会把 /api/* 请求全部拦死。
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
// 嵌进来的（src/renderer/components/modules.js 本地文件分支），'none' 会让 iframe 直接被拒渲染而白屏；而 'self' 在这里指的是
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
// 强制嵌入现由 openChildWindow 子窗口承载（见 src/renderer/components/modules.js、preload.js），
// 模型转发统一走 /gateway（src/infrastructure/model-gateway/gateway.js，已拦云元数据）。

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
    // v1.1.8：height 与 .topbar(54px) 对齐——此前 36px 导致窗口按钮比顶栏矮一截；
    // 初始色为中性亮色板，运行时由渲染层 applyAppearance 随主题/强调色更新
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: 'rgba(250,250,250,0.96)',
      symbolColor: '#525252',
      height: 54,
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
    try { closeAllFloatWindows(); } catch (_) {}
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

// v1.1.5（批次 D1）：糖绘历史图片落盘——渲染层只传 base64 与资源名，
// 读写严格限定在数据根 images/ 目录内（见 storage/image-assets.js 的名称白名单）。
safeHandle('image:saveAsset', (_e, input) => {
  const opts = input && typeof input === 'object' ? input : {};
  if (!opts.base64) return { ok: false, code: 'image_asset_empty' };
  try {
    return getImageAssetStore().save(opts.base64, opts.ext);
  } catch (error) {
    return { ok: false, code: 'image_asset_save_failed', error: error && error.message ? error.message : String(error) };
  }
});

safeHandle('image:readAsset', (_e, input) => {
  const opts = input && typeof input === 'object' ? input : {};
  try {
    return getImageAssetStore().read(opts.name);
  } catch (error) {
    return { ok: false, code: 'image_asset_read_failed', error: error && error.message ? error.message : String(error) };
  }
});

safeHandle('image:deleteAsset', (_e, input) => {
  const opts = input && typeof input === 'object' ? input : {};
  try {
    return getImageAssetStore().remove(opts.name);
  } catch (error) {
    return { ok: false, code: 'image_asset_delete_failed', error: error && error.message ? error.message : String(error) };
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
    const skillOnly = requestedScopes.length === 1 && requestedScopes[0] === 'skill';
    const dbScopes = requestedScopes.filter((scope) => scope !== 'skill');
    let dbResult;
    if (skillOnly) {
      // 用户只选了「Skill」范围：跳过数据库搜索，只合并技能行
      dbResult = { ok: true, items: [], nextCursor: null, total: 0 };
    } else {
      dbResult = svc.searchLocal(opts.query, Object.assign({}, opts, {
        scopes: dbScopes.length ? dbScopes : (wantsSkills ? [] : requestedScopes),
        cursor: wantsSkills ? 0 : opts.cursor,
        limit: wantsSkills ? 100 : opts.limit,
      }));
    }
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
    // v1.1.6（P0 防御）：非字符串 json 一律拒绝——此前 flushPartial 断线时会把
    // undefined 传到这里，writeStateFileAtomic 会把它写成空串，导致 state.json 被清空。
    if (typeof jsonStr !== 'string' || !jsonStr.trim()) return { ok: false, code: 'invalid_json' };
    const gate = acceptStateRevision(jsonStr, revision);
    if (!gate.ok) return gate;
    const userData = app.getPath('userData');
    const dir = path.join(userData, 'tangbao-data');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'state.json');
    // 安全检查：最终路径必须在 userData 子树内
    if (!file.startsWith(userData + path.sep)) return { ok: false, error: '路径越权' };
    writeStateFileAtomic(file, jsonStr);
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
     + 'background:#1e1e2e;color:#cdd6f4;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC","Helvetica Neue",Arial,sans-serif}'
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
    // v1.1.0（M1）：Agent Run 持久化存储由 main-agent-runs.js 的 createRunStoreProxy 构造（lazy 代理）
    configureAgentServer({
      getSecret: secrets.getSecret,
      getEndpoint: gateway.getEndpoint,
      resolveWorkspace,
      runStore: createRunStoreProxy(getStorageService),
      // v3（批次4）：用户级 skill 目录——「放目录即被加载」的体验
      userSkillsDirs: userSkillsDirsList(app),
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
    // 若上次退出时浮窗是开着的，自动恢复浮窗（main-float.js 工厂返回）
    try { restoreFloatWindowIfOpen(); } catch (_) {}
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
        try { migrator.syncState(svc, getStorageFileRepo(), JSON.parse(raw)); } catch (_) {}
      }
    } catch (_) {}
  });
}

// v1.1.8（批次 F）：存储域拆分模块——先于技能工厂初始化（技能/糖馆/搜索/agent 查询都依赖 getStorageService）
const _mainStorageInit = createMainStorage({
  safeHandle,
  safeOn,
  app,
  dialog,
  shell,
  secrets,
  getMainWindow: () => mainWindow,
  defaultUserDataRoot,
  startupLocation,
  hasActiveAgentRuns,
  getModuleSessionStore,
  acceptStateRevision,
  writeStateFileAtomic,
});
getStorageService = _mainStorageInit.getStorageService;
readActiveStateObject = _mainStorageInit.readActiveStateObject;
getStorageFileRepo = _mainStorageInit.getStorageFileRepo;

// v1.1.8（批次 F）：糖馆域拆分模块（角色卡/世界书/记忆检索/索引/草稿 IPC）
createMainTangguan({
  safeHandle,
  app,
  dialog,
  getMainWindow: () => mainWindow,
  getStorageService,
  writeStateFileAtomic,
  getAppPort: () => appPort,
  LOCAL_TOKEN,
});

// v1.1.8（批次 F）：糖码 Run 域拆分模块（运行历史/轨迹导出/受控评测/上下文摘要 IPC）
const _mainAgentRunsInit = createMainAgentRuns({
  safeHandle,
  app,
  dialog,
  getMainWindow: () => mainWindow,
  getStorageService,
  getAgentPort: () => agentPort,
  LOCAL_TOKEN,
});
createRunStoreProxy = _mainAgentRunsInit.createRunStoreProxy;

// v1.1.8（批次 F）：浮窗域拆分模块（生命周期/位置记忆/开关状态/双向同步 IPC）
const _mainFloatInit = createMainFloat({
  safeHandle,
  safeOn,
  getMainWindow: () => mainWindow,
  trustWindow,
  untrustWindow,
  isAppUrl,
  isAllowedExternalUrl,
  getAppPort: () => appPort,
});
toggleFloatWindow = _mainFloatInit.toggleFloatWindow;
restoreFloatWindowIfOpen = _mainFloatInit.restoreFloatWindowIfOpen;
closeAllFloatWindows = _mainFloatInit.closeAllFloatWindows;

// v1.1.7（批次 E）：技能面板 IPC 拆分模块（renderer 无文件写权限，经主进程执行）
// 纯工厂模式：createMainSkills 注册所有技能 IPC handler 并返回主进程需要的 helper
managedSkillRoots = createMainSkills({
  safeHandle,
  app,
  getStorageService,
  getMainWindow: () => mainWindow,
  resolveWorkspace,
  BrowserWindow,
  dialog,
  shell,
  workspaceRegistry,
}).managedSkillRoots;
