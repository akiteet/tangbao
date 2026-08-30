'use strict';
/* v1.2.1 批次 12：桌面宠物域——透明置顶小窗的生命周期/位置记忆/开关状态/点击穿透/漫游/
 * 宠物资产协议（tangbao-pet://）/AI 事件转发。纯工厂模式（同 createMainFloat 先例）：
 * createMainPet(deps) 注册全部 pet:* IPC，返回托盘/启动重置/主窗关闭/事件桥需要的函数。
 * Electron 模块（app/BrowserWindow/screen/dialog/shell/protocol）直接 require；主进程作用域的
 * 信任登记、来源校验、端口 getter 经 deps 注入：safeHandle / safeOn / getMainWindow /
 * trustWindow / untrustWindow / isAppUrl / isAllowedExternalUrl / getAppPort。
 *
 * 设计要点（对齐 zcode-pet 思路 + 糖包浮窗先例）：
 * - 小型透明无边框置顶窗口（默认 240x260），skipTaskbar，启动默认关（同浮窗用户裁决 2026-08-26）。
 * - 固定位置可拖动 + 自由漫游两种位置模式（第十三轮目标点制全屏散步；位置记忆 pet-state.json）。
 * - 默认点击穿透（setIgnoreMouseEvents(true,{forward:true})），渲染层 hover 到宠物本体时切回可交互。
 * - 内置宠物资产随静态服务伺服（/assets/pets/<id>/…）；用户导入宠物存 userData/tangbao-data/pets，
 *   经 tangbao-pet://<id>/<file> 自定义协议读取（builtin 优先、user 兜底），不暴露真实路径。
 * - AI 反应：main 侧 agent 事件桥（emitAgentEvent）转发给宠物窗口，渲染层据此切换动画+气泡。 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, screen, dialog, shell, protocol } = require('electron');

const PET_W = 240;
const PET_H = 260;

// 第九轮：窗口尺寸随缩放动态变化——固定 240x260 时放大后精灵上半截被窗口裁掉。
// 留白与 scale=1 基准一致（左右各 24px、顶部 52px 容纳气泡），且不小于基准窗口。
function petWindowSize(scale) {
  const s = Math.min(2.5, Math.max(0.4, Number.isFinite(scale) ? scale : 1));
  return {
    w: Math.max(PET_W, Math.round(192 * s) + 48),
    h: Math.max(PET_H, Math.round(208 * s) + 52),
  };
}

const DEFAULT_PET_STATE = {
  enabled: false,
  petId: 'fat-guga',
  scale: 1,
  roam: 'free', // 'free' 全屏漫游 | 'fixed' 固定位置（第十三轮起为字符串，旧布尔迁移）
  alwaysOnTop: true,
  x: undefined,
  y: undefined,
};

function createMainPet(deps) {
  const { safeHandle, safeOn } = deps;
  const mainWindow = () => (deps.getMainWindow ? deps.getMainWindow() : null);

  const petWindows = new Map(); // key: 'main'

  // ---- 状态记忆：userData/tangbao-data/pet-state.json（enabled/petId/scale/alwaysOnTop/x/y） ----
  const petStateFile = () => path.join(app.getPath('userData'), 'tangbao-data', 'pet-state.json');
  function readPetState() {
    try {
      const raw = fs.readFileSync(petStateFile(), 'utf8');
      const s = JSON.parse(raw);
      if (s && typeof s === 'object') {
        const merged = Object.assign({}, DEFAULT_PET_STATE, s);
        // 第十三轮：roam 布尔迁移为字符串模式（true→free / false→fixed）
        if (merged.roam === true) merged.roam = 'free';
        else if (merged.roam === false) merged.roam = 'fixed';
        if (merged.roam !== 'fixed') merged.roam = 'free';
        return merged;
      }
    } catch (_) {}
    return Object.assign({}, DEFAULT_PET_STATE);
  }
  function writePetState(patch) {
    try {
      const dir = path.join(app.getPath('userData'), 'tangbao-data');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const next = Object.assign(readPetState(), patch || {});
      fs.writeFileSync(petStateFile(), JSON.stringify(next));
      return next;
    } catch (_) { return null; }
  }

  // ---- 宠物位置：默认显示器右下角；记忆位置校验落在可见显示器内（尺寸随缩放动态） ----
  // 第十四轮反馈：默认位置支持「指定位置所在显示器」——复位不再盲跳主显示器（多显示器时旧实现
  // 会把宠物移出用户眼前的屏幕），rect 传窗口真实 bounds 时按该显示器 workArea 计算。
  function defaultPositionOn(rect) {
    try {
      const size = petWindowSize(readPetState().scale);
      const disp = rect
        ? screen.getDisplayMatching({ x: rect.x, y: rect.y, width: rect.width || PET_W, height: rect.height || PET_H })
        : screen.getPrimaryDisplay();
      const wa = disp.workArea;
      return { x: wa.x + wa.width - size.w - 24, y: wa.y + wa.height - size.h - 24 };
    } catch (_) { return { x: undefined, y: undefined }; }
  }
  function defaultPosition() {
    return defaultPositionOn(null);
  }
  function isValidPosition(p, w, h) {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return false;
    const disp = screen.getDisplayMatching({ x: p.x, y: p.y, width: w || PET_W, height: h || PET_H });
    return !!(disp && disp.workArea);
  }
  // 可见性保险（第五轮反馈「看不到」）：记忆位置可能被拖到屏幕边缘外/显示器变更后失效——
  // 创建与显示时统一钳回目标显示器 workArea 内，宠物永远完整可见。
  function clampToWorkArea(p, w, h) {
    const bw = w || PET_W;
    const bh = h || PET_H;
    try {
      const disp = screen.getDisplayMatching({ x: p.x, y: p.y, width: bw, height: bh });
      const wa = disp.workArea;
      return {
        x: Math.max(wa.x, Math.min(wa.x + wa.width - bw, Math.round(p.x))),
        y: Math.max(wa.y, Math.min(wa.y + wa.height - bh, Math.round(p.y))),
      };
    } catch (_) { return p; }
  }
  function ensureOnScreen(win) {
    if (!win || win.isDestroyed()) return;
    try {
      const b = win.getBounds();
      const c = clampToWorkArea({ x: b.x, y: b.y }, b.width, b.height);
      if (c.x !== b.x || c.y !== b.y) win.setPosition(c.x, c.y, false);
    } catch (_) {}
  }

  // ---- 拖动（2026-08-29 第九轮：JS 拖动回归——app-region 在「透明窗+穿透切换」下实测失灵；
  // 升级为渲染层绝对坐标(screenX)+rAF 合帧 pet:moveTo，无累积漂移、每帧最多一次 IPC） ----
  let dragging = false;
  let hovering = false;

  // ---- 自由漫游（第十三轮：目标点制，真·全屏移动）----
  // 每轮在 workArea 内（四周留边）取距当前位置 ≥ 屏宽 20% 的随机目标点：先水平走到目标 x
  // （running-right/left 专用行），y 相差大则跳跃换行（jumping 行 + 垂直滑移），到达后 idle 至下一轮。
  // 悬停/拖动中随时中止（渲染层回 idle），条件解除后自动选新目标；fixed 模式整个控制器不启动。
  let roamTimer = null;
  let roamWalkTimer = null;
  let roamHopTimer = null;
  let roamPhase = 'idle'; // idle | walk | hop
  function stopRoamWalk() { if (roamWalkTimer) { clearInterval(roamWalkTimer); roamWalkTimer = null; } }
  function stopRoamHop() { if (roamHopTimer) { clearInterval(roamHopTimer); roamHopTimer = null; } }
  function stopRoam() {
    if (roamTimer) { clearInterval(roamTimer); roamTimer = null; }
    stopRoamWalk();
    stopRoamHop();
    roamPhase = 'idle';
  }
  function notifyRoamEnd(win, hop) {
    if (win && !win.isDestroyed() && win.isVisible()) { try { win.webContents.send('pet:roam', hop ? { moving: false, hop: true } : { moving: false }); } catch (_) {} }
  }
  function pickRoamTarget(win, wa) {
    const b = win.getBounds();
    const mx = Math.max(8, Math.round(wa.width * 0.08));
    const my = Math.max(8, Math.round(wa.height * 0.08));
    const minX = wa.x + mx;
    const maxX = wa.x + wa.width - mx - b.width;
    const minY = wa.y + my;
    const maxY = wa.y + wa.height - my - b.height;
    let best = null;
    let bestDist = -1;
    for (let i = 0; i < 6; i++) {
      const tx = minX + Math.random() * Math.max(1, maxX - minX);
      const ty = minY + Math.random() * Math.max(1, maxY - minY);
      const dist = Math.abs(tx - b.x);
      if (dist >= wa.width * 0.2) return { x: Math.round(tx), y: Math.round(ty) };
      if (dist > bestDist) { bestDist = dist; best = { x: Math.round(tx), y: Math.round(ty) }; }
    }
    return best || { x: Math.round(minX), y: Math.round(minY) };
  }
  function abortRoamSegment(win) {
    stopRoamWalk();
    stopRoamHop();
    roamPhase = 'idle';
    notifyRoamEnd(win);
  }
  // 第十三轮诊断（临时）：漫游控制器行为追踪（探针经 globalThis 读取）
  function roamDebug(mark) {
    try {
      globalThis.__petRoamDebug = globalThis.__petRoamDebug || [];
      globalThis.__petRoamDebug.push({ mark, phase: roamPhase, roam: readPetState().roam, t: Date.now() });
      if (globalThis.__petRoamDebug.length > 60) globalThis.__petRoamDebug.shift();
    } catch (_) {}
  }
  function startRoam(win) {
    stopRoam();
    if (!win || win.isDestroyed()) return;
    roamTimer = setInterval(() => {
      try {
        if (win.isDestroyed() || !win.isVisible() || dragging || hovering || roamPhase !== 'idle') return;
        if (readPetState().roam !== 'free') return;
        const b = win.getBounds();
        const disp = screen.getDisplayMatching(b);
        const wa = disp.workArea;
        const target = pickRoamTarget(win, wa);
        const dir = target.x >= b.x ? 'right' : 'left';
        roamPhase = 'walk';
        roamDebug('walk-start');
        try { win.webContents.send('pet:roam', { moving: true, dir }); } catch (_) {}
        roamWalkTimer = setInterval(() => {
          try {
            if (win.isDestroyed() || !win.isVisible() || dragging || hovering) { abortRoamSegment(win); return; }
            const cb = win.getBounds();
            const dx = target.x - cb.x;
            if (Math.abs(dx) <= 5) {
              stopRoamWalk();
              const dy = target.y - cb.y;
              if (Math.abs(dy) > 24) {
                // 跳跃换行：jumping 姿态 + 垂直滑移（约 0.4s）
                roamPhase = 'hop';
                notifyRoamEnd(win, true);
                const step = Math.max(6, Math.round(Math.abs(dy) / 8)) * (dy > 0 ? 1 : -1);
                roamHopTimer = setInterval(() => {
                  try {
                    if (win.isDestroyed() || !win.isVisible() || dragging || hovering) { abortRoamSegment(win); return; }
                    const hb = win.getBounds();
                    const remain = target.y - hb.y;
                    if (Math.abs(remain) <= Math.abs(step)) {
                      win.setPosition(hb.x, target.y, false);
                      stopRoamHop();
                      roamPhase = 'idle';
                      notifyRoamEnd(win);
                      return;
                    }
                    win.setPosition(hb.x, hb.y + step, false);
                  } catch (_) { stopRoamHop(); roamPhase = 'idle'; }
                }, 40);
              } else {
                roamPhase = 'idle';
                notifyRoamEnd(win);
              }
              return;
            }
            win.setPosition(Math.round(cb.x + (dx > 0 ? 4 : -4)), cb.y, false);
          } catch (_) { stopRoamWalk(); roamPhase = 'idle'; }
        }, 110);
      } catch (_) {}
    }, 2200);
  }

  // ---- 宠物资产清单：builtin（assets/pets）+ 用户导入（userData/tangbao-data/pets） ----
  function builtinPetRoot() { return path.join(__dirname, '..', '..', 'assets', 'pets'); }
  function userPetRoot() { return path.join(app.getPath('userData'), 'tangbao-data', 'pets'); }
  function readMeta(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
  }
  function listPets() {
    const out = [];
    try {
      for (const id of fs.readdirSync(builtinPetRoot())) {
        const meta = readMeta(path.join(builtinPetRoot(), id, 'meta.json'));
        if (meta) out.push(Object.assign({ location: 'builtin' }, meta, { id: meta.id || id }));
      }
    } catch (_) {}
    try {
      for (const id of fs.readdirSync(userPetRoot())) {
        const meta = readMeta(path.join(userPetRoot(), id, 'meta.json'));
        if (meta) out.push(Object.assign({ location: 'user' }, meta, { id: meta.id || id }));
      }
    } catch (_) {}
    return out;
  }
  // 解析宠物资产文件：builtin 目录优先，其次用户目录。返回绝对路径或 null（供 tangbao-pet 协议）。
  function resolvePetAsset(petId, file) {
    if (!petId || !file || /(^|[\\/])\.\.([\\/]|$)/.test(String(petId)) || /(^|[\\/])\.\.([\\/]|$)/.test(String(file))) return null;
    const builtin = path.join(builtinPetRoot(), petId, file);
    if (fs.existsSync(builtin)) return builtin;
    const user = path.join(userPetRoot(), petId, file);
    if (fs.existsSync(user)) return user;
    return null;
  }

  // ---- tangbao-pet://<petId>/<file>：伺服内置/用户宠物资产（builtin 优先，user 兜底） ----
  function registerPetProtocol() {
    try {
      protocol.handle('tangbao-pet', async (request) => {
        try {
          const url = new URL(request.url);
          const seg = decodeURIComponent(url.host + url.pathname).split('/').filter(Boolean);
          const petId = seg[0];
          const file = seg.slice(1).join('/');
          if (!petId || !file) return new Response('404', { status: 404 });
          const abs = resolvePetAsset(petId, file);
          if (!abs) return new Response('404', { status: 404 });
          const data = await fs.promises.readFile(abs);
          const ext = path.extname(abs).toLowerCase();
          const type = ext === '.json' ? 'application/json; charset=utf-8' : (ext === '.webp' ? 'image/webp' : 'application/octet-stream');
          // 宠物资产跨源给渲染层（页面在 http://127.0.0.1:PORT，协议是 tangbao-pet://）。
          // 不带 ACAO 时 Pixi 的 fetch+createImageBitmap 会被 CORS 拦截 → 宠物不渲染。
          return new Response(data, { status: 200, headers: { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' } });
        } catch (_) { return new Response('404', { status: 404 }); }
      });
    } catch (e) { console.warn('[糖包] tangbao-pet 协议注册失败：' + (e && e.message ? e.message : e)); }
  }

  // ---- 宠物窗口 ----
  function createPetWindow() {
    const st = readPetState();
    const size = petWindowSize(st.scale);
    const pos = isValidPosition({ x: st.x, y: st.y }, size.w, size.h) ? clampToWorkArea({ x: st.x, y: st.y }, size.w, size.h) : defaultPosition();
    const win = new BrowserWindow({
      width: size.w,
      height: size.h,
      x: pos.x,
      y: pos.y,
      transparent: true,
      frame: false,
      alwaysOnTop: st.alwaysOnTop !== false,
      skipTaskbar: true,
      resizable: false,
      hasShadow: false,
      backgroundColor: '#00000000', // 第八轮闪烁修复：显式全透明背景，防白闪（electron#10801 官方 workaround）
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false, // 反馈修复：防 occlusion 判定节流 rAF 造成帧节奏抖动
        preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      },
    });
    deps.trustWindow(win);
    win.webContents.on('will-navigate', (event, url) => { if (!deps.isAppUrl(url)) event.preventDefault(); });
    win.webContents.setWindowOpenHandler(({ url }) => { if (deps.isAllowedExternalUrl(url)) { try { shell.openExternal(url); } catch (_) {} } return { action: 'deny' }; });
    win.once('ready-to-show', () => { try { win.show(); } catch (_) {} });
    // 位置持久化：800ms debounce 落最终位置（原生/JS 拖动的 move 都会触发；松手位置即真实位置）。
    let movePersistTimer = null;
    win.on('move', () => {
      if (win.isDestroyed()) return;
      if (movePersistTimer) clearTimeout(movePersistTimer);
      movePersistTimer = setTimeout(() => {
        movePersistTimer = null;
        if (win.isDestroyed()) return;
        const b = win.getBounds();
        writePetState({ x: b.x, y: b.y });
      }, 800);
    });
    win.on('closed', () => {
      deps.untrustWindow(win);
      petWindows.delete('main');
      if (movePersistTimer) { clearTimeout(movePersistTimer); movePersistTimer = null; }
      stopRoam();
    });
    // 默认点击穿透：桌面其余区域鼠标可直接点到底层应用
    try { win.setIgnoreMouseEvents(true, { forward: true }); } catch (_) {}
    if (process.env.TANGBAO_PET_DEBUG) {
      const dbgLog = (m) => { try { fs.appendFileSync(path.join(__dirname, '..', '..', '_diag_real_pet.log'), '[' + new Date().toISOString() + '] ' + m + '\n'); } catch (_) {} };
      win.webContents.on('console-message', (...a) => {
        const e = a[0];
        const lv = typeof a[1] === 'number' ? a[1] : (e && e.level);
        const m = typeof a[2] === 'string' ? a[2] : (e && e.message);
        dbgLog('[console lv=' + lv + '] ' + String(m).slice(0, 400));
      });
      win.webContents.on('did-fail-load', (...a) => dbgLog('[did-fail-load] ' + JSON.stringify(a.slice(1, 5))));
      win.webContents.on('render-process-gone', (...a) => dbgLog('[render-gone] ' + JSON.stringify(a.slice(1, 3))));
      win.webContents.once('did-finish-load', () => {
        dbgLog('[did-finish-load] ' + win.webContents.getURL());
        setTimeout(() => {
          win.webContents.executeJavaScript(
            '(function(){var c=document.querySelector("#pet-stage canvas");' +
            'var res=(performance.getEntriesByType("resource")||[]).map(function(r){return r.name.slice(-50)+" sz="+r.transferSize;});' +
            'return Promise.all([' +
            'fetch("/assets/pets/fat-guga/spritesheet.webp",{method:"HEAD"}).then(function(r){return "sheet:"+r.status;},function(e){return "sheet:ERR "+e.message;}),' +
            'fetch("/vendor/pixi.min.mjs",{method:"HEAD"}).then(function(r){return "pixi:"+r.status;},function(e){return "pixi:ERR "+e.message;})' +
            ']).then(function(r){return JSON.stringify({canvas:!!c,cw:c&&c.clientWidth,net:r,resources:res.slice(0,12)});});})()', true)
            .then((r) => dbgLog('[page] ' + r))
            .catch((e) => dbgLog('[page-exec-err] ' + e.message));
        }, 5000);
      });
    }
    win.loadURL(`http://127.0.0.1:${deps.getAppPort()}/pet.html`);
    return win;
  }
  function currentPetWindow() {
    const w = petWindows.get('main');
    return (w && !w.isDestroyed()) ? w : null;
  }
  function ensurePetWindow() {
    let w = currentPetWindow();
    if (!w) { w = createPetWindow(); petWindows.set('main', w); }
    return w;
  }

  function togglePetWindow() {
    let w = currentPetWindow();
    if (!w) {
      w = ensurePetWindow();
      writePetState({ enabled: true });
      if (readPetState().roam === 'free') startRoam(w);
      return true;
    }
    if (w.isVisible()) { notifyRoamEnd(w); try { w.hide(); } catch (_) {} writePetState({ enabled: false }); stopRoam(); return false; }
    if (w.isMinimized()) { try { w.restore(); } catch (_) {} }
    ensureOnScreen(w);
    try { w.show(); } catch (_) {}
    writePetState({ enabled: true });
    if (readPetState().roam === 'free') startRoam(w);
    return true;
  }
  function showPetWindow() {
    const w = currentPetWindow() || ensurePetWindow();
    if (w.isMinimized()) { try { w.restore(); } catch (_) {} }
    ensureOnScreen(w);
    try { w.show(); } catch (_) {}
    writePetState({ enabled: true });
    if (readPetState().roam === 'free') startRoam(w);
  }
  function hidePetWindow() {
    const w = currentPetWindow();
    if (w) { notifyRoamEnd(w); try { w.hide(); } catch (_) {} }
    stopRoam();
    writePetState({ enabled: false });
  }
  function resetPetOnBoot() { writePetState({ enabled: false }); } // 启动默认关（同浮窗裁决）
  function closeAllPetWindows() { petWindows.forEach((w) => { if (w && !w.isDestroyed()) { try { w.close(); } catch (_) {} } }); }

  // ---- AI 事件桥：main 侧 agent 事件 → 宠物窗口 ----
  function emitAgentEvent(payload) {
    const w = currentPetWindow();
    if (w && w.isVisible()) { try { w.webContents.send('pet:agentEvent', payload || {}); } catch (_) {} }
  }

  // ---- 诊断钩子（TANGBAO_PET_DEBUG=1 时启用，平时零开销）：
  // 自动显示桌宠 + 宠物窗 console/加载失败落盘 + 5s 后采样 canvas 与关键资源网络状态。
  // 用于定位「独立探针正常、真实应用渲染不出来」的环境差值（CSP/MIME/路径/缓存）。 ----
  if (process.env.TANGBAO_PET_DEBUG) {
    const dbgLog = (m) => { try { fs.appendFileSync(path.join(__dirname, '..', '..', '_diag_real_pet.log'), '[' + new Date().toISOString() + '] ' + m + '\n'); } catch (_) {} };
    app.whenReady().then(() => {
      setTimeout(() => { try { dbgLog('auto-show (debug)'); showPetWindow(); } catch (e) { dbgLog('auto-show err: ' + e.message); } }, 3000);
    });
  }

  // ---- IPC ----
  safeHandle('pet:toggle', async () => { const visible = togglePetWindow(); return { ok: true, visible }; });
  safeHandle('pet:hide', async () => { hidePetWindow(); return { ok: true }; });
  safeHandle('pet:show', async () => { showPetWindow(); return { ok: true }; });
  safeHandle('pet:setClickThrough', async (e, on) => {
    hovering = !on; // on=点击穿透（未悬停）；off=可交互（悬停中）→ 漫游暂停
    const w = currentPetWindow();
    if (w) { try { w.setIgnoreMouseEvents(!!on, { forward: true }); } catch (_) {} }
    return { ok: true };
  });
  safeHandle('pet:setRoamMode', async (e, mode) => {
    const m = mode === 'fixed' ? 'fixed' : 'free';
    writePetState({ roam: m });
    roamDebug('setMode:' + m);
    stopRoam();
    roamDebug('post-stop');
    if (m === 'free') startRoam(currentPetWindow());
    else notifyRoamEnd(currentPetWindow());
    roamDebug('post-start');
    return { ok: true, roam: m };
  });
  safeHandle('pet:setAlwaysOnTop', async (e, on) => {
    const w = currentPetWindow();
    if (w) { try { w.setAlwaysOnTop(!!on); } catch (_) {} }
    writePetState({ alwaysOnTop: !!on });
    return { ok: true };
  });
  safeHandle('pet:setDragging', async (e, on) => { dragging = !!on; return { ok: true }; });
  safeHandle('pet:moveTo', async (e, pos) => {
    if (!dragging) return { ok: true };
    const w = currentPetWindow();
    if (w && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      try { w.setPosition(Math.round(pos.x), Math.round(pos.y), false); } catch (_) {}
    }
    return { ok: true };
  });
  safeHandle('pet:resetPosition', async () => {
    // 第六轮反馈：复位同时落盘默认位置——宠物未显示时点复位，下次显示也回到右下角。
    // 第十四轮反馈（复位被移出屏幕）：旧实现按「主显示器 + pet-state 记忆 scale」算坐标，
    // 多显示器/窗口尺寸与记忆 scale 不一致时会落进不可见区域且设置后不校验。现在：
    // 以窗口真实 bounds 所在显示器计算右下角 + 钳回其 workArea + 落位后 ensureOnScreen 兜底。
    const w = currentPetWindow();
    let p;
    if (w) {
      const b = w.getBounds();
      const raw = defaultPositionOn(b);
      const c = clampToWorkArea(raw, b.width, b.height);
      if (c && c.x != null && c.y != null) {
        p = c;
        try { w.setPosition(c.x, c.y, false); } catch (_) {}
      }
    } else {
      p = defaultPosition();
    }
    if (p && p.x != null && p.y != null) writePetState({ x: p.x, y: p.y });
    if (w) ensureOnScreen(w);
    return { ok: true };
  });
  safeHandle('pet:setPet', async (e, id) => {
    const pid = String(id || '');
    if (!listPets().some((p) => p.id === pid)) return { ok: false, error: 'unknown pet' };
    writePetState({ petId: pid });
    const w = currentPetWindow();
    if (w) { try { w.webContents.send('pet:select', pid); } catch (_) {} }
    return { ok: true };
  });
  // 第十四轮反馈：已添加（导入）的宠物要有移除途径——内置宠物不可删；当前选中被删时自动回退内置 fat-guga。
  safeHandle('pet:delete', async (e, id) => {
    const pid = String(id || '');
    if (!/^[a-zA-Z0-9_-]+$/.test(pid)) return { ok: false, error: '无效的桌宠 id' };
    const userDir = path.join(userPetRoot(), pid);
    if (!readMeta(path.join(userDir, 'meta.json'))) return { ok: false, error: '仅可移除导入的桌宠' };
    try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (err) {
      return { ok: false, error: '移除失败：' + (err && err.message ? err.message : String(err)) };
    }
    let switched = false;
    if (readPetState().petId === pid) {
      writePetState({ petId: 'fat-guga' });
      switched = true;
      const w = currentPetWindow();
      if (w) { try { w.webContents.send('pet:select', 'fat-guga'); } catch (_) {} }
    }
    return { ok: true, pets: listPets(), petId: readPetState().petId, switched };
  });
  safeHandle('pet:setScale', async (e, s) => {
    const raw = typeof s === 'number' && Number.isFinite(s) ? s : 1;
    const val = Math.min(2.5, Math.max(0.4, raw));
    writePetState({ scale: val });
    const w = currentPetWindow();
    if (w) {
      try {
        // 第九轮：窗口尺寸随缩放动态变化，底部中心锚点（精灵脚底位置不动）→ 放大不再被窗口裁掉
        const size = petWindowSize(val);
        const b = w.getBounds();
        const feetX = b.x + b.width / 2;
        const feetY = b.y + b.height;
        w.setBounds({
          x: Math.round(feetX - size.w / 2),
          y: Math.round(feetY - size.h),
          width: size.w,
          height: size.h,
        });
        ensureOnScreen(w);
      } catch (_) {}
      try { w.webContents.send('pet:scale', val); } catch (_) {}
    }
    return { ok: true };
  });
  safeHandle('pet:list', async () => ({ ok: true, pets: listPets() }));
  safeHandle('pet:state', async () => ({ ok: true, state: readPetState() }));
  safeHandle('pet:import', async (e) => {
    try {
      const win = mainWindow() || currentPetWindow();
      const picked = await dialog.showOpenDialog(win, {
        title: '导入桌宠（选择包含精灵图的文件夹，meta.json 可选）',
        properties: ['openDirectory'],
      });
      if (picked.canceled || !picked.filePaths || !picked.filePaths.length) return { ok: true, canceled: true };
      const srcDir = picked.filePaths[0];
      // 第十轮（用户澄清）：文件名不必严苛——精灵图文件名任意（扫描文件夹内的 webp/png/jpg；
      // 多张时优先带 sheet/sprite 字样的），meta.json 可选（缺省用文件夹名生成 id 并自动补写）。
      let images = [];
      try { images = fs.readdirSync(srcDir).filter((f) => /\.(webp|png|jpe?g)$/i.test(f)); } catch (_) {}
      if (!images.length) {
        return { ok: false, error: '所选文件夹里没有找到精灵图（支持 webp / png / jpg）' };
      }
      images.sort((a, b) => {
        const sa = /sheet|sprite/i.test(a) ? 0 : 1;
        const sb = /sheet|sprite/i.test(b) ? 0 : 1;
        return sa - sb || a.localeCompare(b);
      });
      const sheetName = images[0];
      const sheet = path.join(srcDir, sheetName);
      const metaFile = path.join(srcDir, 'meta.json');
      const meta0 = fs.existsSync(metaFile) ? readMeta(metaFile) : null;
      const folderId = path.basename(srcDir).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48);
      const idSource = (meta0 && meta0.id) || folderId;
      if (!idSource) return { ok: false, error: '无法确定桌宠 id：meta.json 未提供 id 且文件夹名不含字母/数字' };
      const cellW = Math.round(Number(meta0 && meta0.cellWidth)) || 192;
      const cellH = Math.round(Number(meta0 && meta0.cellHeight)) || 208;
      const cols = Math.round(Number(meta0 && meta0.cols)) || 8;
      const dim = await imageDimensions(sheet);
      if (!dim) return { ok: false, error: '无法读取精灵图尺寸（支持 webp / png / jpg）' };
      if (dim.width % cellW !== 0 || dim.height % cellH !== 0) {
        return { ok: false, error: `精灵图宽高需为每格尺寸的整数倍：当前 ${dim.width}×${dim.height}，每格 ${cellW}×${cellH}。可在 meta.json 中用 cellWidth / cellHeight 声明你的格子规格` };
      }
      const realCols = Math.round(dim.width / cellW);
      if (realCols !== cols) {
        return { ok: false, error: `cols 与图片不符：宽 ${dim.width} ÷ 每格 ${cellW} = ${realCols} 列，meta.json 声明为 ${cols} 列` };
      }
      let meta = meta0 || {};
      const id = String(idSource).replace(/[^a-zA-Z0-9_-]/g, '') || 'pet-' + Date.now();
      const dstDir = path.join(userPetRoot(), id);
      if (!fs.existsSync(dstDir)) fs.mkdirSync(dstDir, { recursive: true });
      fs.copyFileSync(sheet, path.join(dstDir, sheetName));
      meta = Object.assign({}, meta, { id, source: 'user', spritesheetFile: sheetName, cellWidth: cellW, cellHeight: cellH, cols });
      if (!meta.displayName) meta.displayName = path.basename(srcDir);
      fs.writeFileSync(path.join(dstDir, 'meta.json'), JSON.stringify(meta, null, 2));
      const pets = listPets();
      return { ok: true, pets, petId: id };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });

  // 宠物窗口 → 主窗：状态变更通知（设置面板刷新）
  safeOn('pet:stateChanged', (e, patch) => {
    if (!patch || typeof patch !== 'object') return;
    writePetState(patch);
    const mw = mainWindow();
    if (mw && !mw.isDestroyed() && e.sender !== mw.webContents) { try { mw.webContents.send('pet:refresh'); } catch (_) {} }
  });

  // 注册协议处理器（需在 app ready 后）
  if (app.isReady()) registerPetProtocol();
  else app.whenReady().then(registerPetProtocol);

  return { togglePetWindow, showPetWindow, hidePetWindow, resetPetOnBoot, closeAllPetWindows, emitAgentEvent, readPetState, writePetState, listPets, registerPetProtocol };
}

// WebP/PNG 尺寸解析（导入校验用；不引入额外依赖）
async function imageDimensions(file) {
  try {
    const b = await fs.promises.readFile(file);
    if (b.length < 24) return null;
    if (b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP') {
      // VP8L lossless：'VP8L' + 1 字节签名 0x2F + 4 字节（14bit 宽-1 | 14bit 高-1）
      let off = 12;
      while (off + 8 <= b.length) {
        const tag = b.slice(off, off + 4).toString();
        const size = b.readUInt32LE(off + 4);
        if (tag === 'VP8L' && off + 8 + 1 + 4 <= b.length) {
          const d = b.readUInt32LE(off + 8 + 1);
          return { width: (d & 0x3fff) + 1, height: ((d >> 14) & 0x3fff) + 1 };
        }
        if (tag === 'VP8X' && off + 8 + 10 <= b.length) {
          const w = (b[off + 8 + 4] | (b[off + 8 + 5] << 8) | (b[off + 8 + 6] << 16)) + 1;
          const h = (b[off + 8 + 7] | (b[off + 8 + 8] << 8) | (b[off + 8 + 9] << 16)) + 1;
          return { width: w, height: h };
        }
        if (tag === 'VP8 ') {
          // VP8 有损：帧头 3 字节 + 2 字节宽 + 2 字节高（小端，第 9/10 字节）
          if (off + 8 + 12 <= b.length) {
            return { width: b.readUInt16LE(off + 8 + 6), height: b.readUInt16LE(off + 8 + 8) };
          }
        }
        off += 8 + size + (size % 2);
      }
      return null;
    }
    if (b.slice(0, 8).toString('hex') === '89504e470d0a1a0a') {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    // 第十轮：JPEG（扫描段结构取 SOF 宽高，基线/渐进通用）
    if (b[0] === 0xff && b[1] === 0xd8) {
      let off = 2;
      while (off + 9 <= b.length) {
        if (b[off] !== 0xff) { off++; continue; }
        const marker = b[off + 1];
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) { off += 2; continue; }
        if (marker === 0xda) return null; // 进入扫描数据仍未遇 SOF
        const len = b.readUInt16BE(off + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: b.readUInt16BE(off + 5), width: b.readUInt16BE(off + 7) };
        }
        off += 2 + len;
      }
      return null;
    }
    return null;
  } catch (_) { return null; }
}

module.exports = { createMainPet };
