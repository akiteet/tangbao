'use strict';
/* 自 main.js 拆分（v1.1.8 批次 F）：系统级浮窗域——独立置顶小窗的生命周期/位置记忆/开关状态/
 * 双向同步 IPC。纯工厂模式（同 createMainSkills 先例）：createMainFloat(deps) 注册全部 float:* IPC，
 * 并返回主进程启动恢复/托盘/快捷键/主窗关闭钩子需要的函数。
 * Electron 模块（app/BrowserWindow/screen/shell）直接 require；主进程作用域的信任登记、来源校验、
 * 端口 getter 经 deps 注入：safeHandle / safeOn / getMainWindow / trustWindow / untrustWindow /
 * isAppUrl / isAllowedExternalUrl / getAppPort。 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, screen, shell } = require('electron');

function createMainFloat(deps) {
  const { safeHandle, safeOn } = deps;
  const mainWindow = () => (deps.getMainWindow ? deps.getMainWindow() : null);

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

// 浮窗脱敏快照：清空搜索索引、剥离账户/Provider 的 apiKey 后再下发给浮窗
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

// 启动恢复：若上次退出时浮窗是开着的，自动重建
function restoreFloatWindowIfOpen() {
  if (readFloatState().open) {
    const w = createFloatingWindow();
    floatWindows.set('chat', w);
  }
}

// 主窗关闭时一并关闭所有浮窗，避免孤儿窗口（浮窗依赖主窗落盘 float:sync）
function closeAllFloatWindows() {
  try { floatWindows.forEach((w) => { if (w && !w.isDestroyed()) w.close(); }); } catch (_) {}
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
    deps.trustWindow(win);
    win.webContents.on('will-navigate', (event, url) => { if (!deps.isAppUrl(url)) event.preventDefault(); });
    win.webContents.setWindowOpenHandler(({ url }) => { if (deps.isAllowedExternalUrl(url)) { try { shell.openExternal(url); } catch (_) {} } return { action: 'deny' }; });
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
    deps.untrustWindow(win);
    floatWindows.delete('chat');
    const mw = mainWindow();
    if (mw && mw.webContents) mw.webContents.send('float:refresh');
  });
  win.loadURL(`http://127.0.0.1:${deps.getAppPort()}/?float=chat`);
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
    const mw = mainWindow();
    if (!mw || e.sender === mw.webContents) return;
    if (!s || typeof s !== 'object' || !Array.isArray(s.conversations)) return;
    mw.webContents.send('float:apply', {
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
    const mw = mainWindow();
    if (!mw || e.sender !== mw.webContents) return;
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

  return { toggleFloatWindow, restoreFloatWindowIfOpen, closeAllFloatWindows, readFloatState };
}

module.exports = { createMainFloat };
