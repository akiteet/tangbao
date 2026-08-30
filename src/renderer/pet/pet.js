'use strict';
/* v1.2.1 批次 12：桌面宠物窗口主入口（pet.html 加载）。
 * - PixiJS 透明画布 + 精灵图（Atlas 契约）状态机
 * - 默认点击穿透：hover 到宠物本体才切回可交互（pet:setClickThrough）
 * - 拖动（pet:setDragging + pet:moveTo 绝对坐标；2026-08-29 移除自动漫游，固定位置可拖动）
 * - 点击反应/右键菜单
 * - 糖码 AI 事件（pet:agentEvent）→ 动画 + 气泡
 * - 换宠物（pet:select）/缩放（pet:scale）响应主窗设置 */
import { Application, Assets } from '../../../vendor/pixi.min.mjs';
import { makeAtlasTexture, trimTrailingBlankFrames } from './atlas.js';
import { PetSprite } from './pet-engine.js';
import { ChatBubble } from './chat-bubble.js';
import { mapAgentEvent, safeState } from './agent-events.js';

const bridge = window.electron;
if (!bridge || typeof bridge.petList !== 'function') {
  document.body.innerHTML = '<div style="color:#fff;padding:10px;font:12px sans-serif">宠物服务不可用</div>';
  throw new Error('pet: no electron bridge');
}

const stageEl = document.getElementById('pet-stage');
const app = new Application();
// autoStart:false——Pixi 默认每帧重绘透明窗（60fps），Windows 上持续重合成会闪烁；
// 改为下方自驱 rAF 按需渲染（帧动画本身 7fps）。
// preserveDrawingBuffer:true——透明窗 + WebGL 双缓冲下，合成器可能采样到换帧中间态造成常驻闪烁
// （第八轮反馈根因；electron/pixijs 官方议题通行修法），保留上一帧缓冲直到被覆盖。
await app.init({ resizeTo: window, backgroundAlpha: 0, antialias: true, autoDensity: true, autoStart: false, preserveDrawingBuffer: true });
stageEl.appendChild(app.canvas);

let state = { petId: 'fat-guga', scale: 1, alwaysOnTop: true };
try { const r = await bridge.petState(); if (r && r.ok && r.state) state = Object.assign(state, r.state); } catch (_) {}
let pets = [];
try { const r = await bridge.petList(); if (r && r.ok && Array.isArray(r.pets)) pets = r.pets; } catch (_) {}
if (!pets.some((p) => p.id === state.petId)) state.petId = (pets[0] && pets[0].id) || 'fat-guga';

const bubble = new ChatBubble(stageEl);
let pet = null;

// ---- 按需渲染循环基础设施（必须在 await loadPet 之前初始化！loadPet 尾部会调 renderOnce()，
//      若排在后面会触发 let TDZ「Cannot access before initialization」→ 模块中止 → 渲染循环永不启动
//      → 画布挂载但一帧不画 = 透明空白窗（2026-08-29 第六轮渲染事故根因）） ----
let needsRender = true;
function renderOnce() { needsRender = true; }
// 窗口随缩放动态变化（第九轮：固定 240x260 时放大后上半截被窗口裁掉）——resize 后把精灵重新
// 锚定到新窗口的底部中心（脚底位置由主进程 setBounds 保持，这里只对齐渲染坐标）。
window.addEventListener('resize', () => {
  if (pet) pet.position.set(window.innerWidth / 2, window.innerHeight);
  renderOnce();
});
let lastTs = 0;
function frame(ts) {
  const dt = lastTs ? Math.min(100, ts - lastTs) : 16;
  lastTs = ts;
  let dirty = needsRender;
  needsRender = false;
  // 拖动移动经 rAF 合帧：每帧最多一次 pet:moveTo（治 IPC 风暴卡顿）
  if (pendingMove) {
    const p = pendingMove;
    pendingMove = null;
    try { bridge.petMoveTo(p.x, p.y); } catch (_) {}
  }
  if (pet) dirty = pet.update(dt) || dirty;
  if (dirty) { try { app.renderer.render(app.stage); } catch (_) {} }
  requestAnimationFrame(frame);
}

// 资源 URL：内置宠物走同源 HTTP（/assets/pets/...，零 CORS）；用户导入宠物走 tangbao-pet:// 协议（主进程已带 ACAO）。
function petAssetUrl(id, file) {
  const meta = (pets || []).find((p) => p.id === id);
  if (meta && meta.location === 'user') return 'tangbao-pet://' + encodeURIComponent(String(id)) + '/' + file;
  return '/assets/pets/' + encodeURIComponent(String(id)) + '/' + file;
}

function showLoadError(message) {
  try {
    const errEl = document.createElement('div');
    errEl.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#e05555;font:12px system-ui,sans-serif;padding:10px;text-align:center;z-index:20;';
    errEl.textContent = message;
    stageEl.appendChild(errEl);
  } catch (_) {}
}

async function loadPet(id) {
  // 第十一轮：先刷新宠物清单——导入新宠物后主窗切换过来时，本窗启动时缓存的 pets 已过期
  // （过期清单会导致用户导入宠物查不到 meta，走错资源路径加载失败，右键「换一只」也轮不到它）
  try { const r = await bridge.petList(); if (r && r.ok && Array.isArray(r.pets)) pets = r.pets; } catch (_) {}
  if (pet) { try { app.stage.removeChild(pet); pet.destroy({ children: true }); } catch (_) {} pet = null; }
  const targetId = id || 'fat-guga';
  const meta = (pets || []).find((p) => p.id === targetId);
  const sheetFile = (meta && meta.spritesheetFile) || 'spritesheet.webp';
  const url = petAssetUrl(targetId, sheetFile);
  // 第十轮：格子规格可由 meta.json 声明（cellWidth/cellHeight/cols），缺省沿用内置规格
  const grid = {
    cellW: Math.round(Number(meta && meta.cellWidth)) || 192,
    cellH: Math.round(Number(meta && meta.cellHeight)) || 208,
    cols: Math.round(Number(meta && meta.cols)) || 8,
  };
  let tex;
  try { tex = await Assets.load(url); } catch (e) {
    console.error('[pet] 精灵图加载失败', url, e);
    showLoadError('宠物资源加载失败');
    bubble.show('宠物资源加载失败');
    return;
  }
  const atlas = makeAtlasTexture(tex, grid);
  await trimTrailingBlankFrames(url, atlas, grid); // 裁掉行尾空白补位帧（轮播进空格=周期性消失=常驻闪烁）
  pet = new PetSprite(atlas, { scale: state.scale, speed: 7, cellW: grid.cellW, cellH: grid.cellH });
  pet.position.set(app.screen.width / 2, app.screen.height);
  app.stage.addChild(pet);
  pet.setState('idle');
  renderOnce();
}

await loadPet(state.petId);
try { app.resize(); } catch (_) {} // resizeTo 的初次 sizing 不依赖 ticker，显式做一次
requestAnimationFrame(frame); // 渲染循环与拖动区基础设施已在模块前部初始化（TDZ 事故教训 ×2）

// ---- 点击穿透（几何判定）：绑 window——穿透态 forward:true 下 mousemove 仍可达 ----
let interactive = false;
function updateClickThrough(clientX, clientY) {
  if (!pet) return;
  const rect = app.canvas.getBoundingClientRect();
  const localX = (clientX - rect.left) - pet.x;
  const localY = (clientY - rect.top) - pet.y;
  const onPet = pet.hitTest(localX, localY, 4); // 4px 内缩迟滞，防 hover 边界反复切换点击穿透
  if (onPet !== interactive) {
    interactive = onPet;
    try { bridge.petSetClickThrough(!onPet); } catch (_) {}
  }
}
window.addEventListener('mousemove', (e) => updateClickThrough(e.clientX, e.clientY));
document.addEventListener('mouseleave', () => {
  if (interactive) { interactive = false; try { bridge.petSetClickThrough(true); } catch (_) {} }
});

// ---- 交互：拖动（第九轮升级）/ 单击 / 右键 ----
// 拖动定位用 screenX/screenY **绝对坐标**（光标屏幕位置 - 按下时抓取偏移），无增量累积漂移
// → 松手位置=光标位置；移动写入 pendingMove 由 rAF 合帧（frame 内每帧最多一次 pet:moveTo）。
// 姿态：进入拖态 + 拖动中方向实时跟随（playDirectional 优先用 atlas 的 running-right/left 专用行）。
let grabOffset = null; // 按下时光标相对窗口左上角的偏移
let dragMoved = false;
let dragLastX = 0;
let pendingMove = null;
app.canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  grabOffset = { x: e.screenX - window.screenX, y: e.screenY - window.screenY };
  dragMoved = false;
  dragLastX = e.screenX;
});
window.addEventListener('pointermove', (e) => {
  if (!grabOffset || e.buttons === 0) return;
  if (!dragMoved) {
    if (Math.abs(e.screenX - (window.screenX + grabOffset.x)) < 4 && Math.abs(e.screenY - (window.screenY + grabOffset.y)) < 4) return;
    dragMoved = true;
    try { bridge.petSetDragging(true); } catch (_) {}
    if (pet) pet.playDirectional('running', e.screenX - dragLastX);
  } else if (pet && Math.abs(e.screenX - dragLastX) >= 3) {
    pet.playDirectional('running', e.screenX - dragLastX);
  }
  dragLastX = e.screenX;
  pendingMove = { x: e.screenX - grabOffset.x, y: e.screenY - grabOffset.y };
});
window.addEventListener('pointerup', (e) => {
  if (!grabOffset) return;
  grabOffset = null;
  if (pendingMove) { const p = pendingMove; pendingMove = null; try { bridge.petMoveTo(p.x, p.y); } catch (_) {} }
  if (dragMoved) {
    dragMoved = false;
    try { bridge.petSetDragging(false); } catch (_) {}
    if (pet) { pet.faceDirection(); pet.setState('idle'); }
    return;
  }
  if (e.button === 0 && pet) { pet.playOnce('jumping'); bubble.show('喵～'); }
});
app.canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY); });

// ---- 右键菜单（DOM） ----
// 第十一轮：菜单打开后监听「任意 pointerdown 即关闭」会让菜单条目永远收不到 click
// （按下瞬间菜单先被移除）——改为菜单内按下 stopPropagation + 关闭时移除文档级监听。
let menuEl = null;
function hideMenu() {
  if (menuEl) { menuEl.remove(); menuEl = null; }
  document.removeEventListener('pointerdown', hideMenu);
}
function showMenu(x, y) {
  hideMenu();
  menuEl = document.createElement('div');
  menuEl.className = 'pet-menu';
  const btn = (label, fn) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', () => { hideMenu(); fn(); }); return b; };
  const sep = () => { const d = document.createElement('div'); d.className = 'sep'; return d; };
  menuEl.appendChild(btn('换一只宠物', cyclePet));
  menuEl.appendChild(btn('复位位置', () => { try { bridge.petResetPosition(); } catch (_) {} }));
  menuEl.appendChild(btn(state.alwaysOnTop ? '取消置顶' : '保持置顶', toggleAlwaysOnTop));
  menuEl.appendChild(sep());
  menuEl.appendChild(btn('隐藏桌宠', hidePet));
  menuEl.addEventListener('pointerdown', (e) => e.stopPropagation()); // 菜单内按下不关闭
  menuEl.style.left = Math.min(x, window.innerWidth - 130) + 'px';
  menuEl.style.top = Math.min(y, window.innerHeight - 160) + 'px';
  document.body.appendChild(menuEl);
  setTimeout(() => document.addEventListener('pointerdown', hideMenu), 0); // 点击菜单外关闭
}
function cyclePet() {
  if (!pets.length) return;
  const idx = pets.findIndex((p) => p.id === state.petId);
  const next = pets[(idx + 1) % pets.length];
  try { bridge.petSetPet(next.id); } catch (_) {}
  state.petId = next.id;
  loadPet(next.id);
  bubble.show('换新皮肤啦');
}
function toggleAlwaysOnTop() {
  state.alwaysOnTop = !state.alwaysOnTop;
  try { bridge.petSetAlwaysOnTop(state.alwaysOnTop); } catch (_) {}
  bubble.show(state.alwaysOnTop ? '保持置顶' : '取消置顶');
}
function hidePet() {
  try { bridge.petHide(); } catch (_) {}
}

// ---- 主窗设置同步（换宠物 / 缩放） ----
try { bridge.onPetSelect((id) => { if (id && id !== state.petId) { state.petId = id; loadPet(id); } }); } catch (_) {}
try { bridge.onPetScale((s) => { state.scale = s; if (pet) { pet.setScale(s); renderOnce(); } }); } catch (_) {}

// ---- 自由漫游姿态（第十三轮目标点制：走=专用方向行；hop=跳跃换行；停=idle 保持朝向） ----
try {
  bridge.onPetRoam((p) => {
    if (!pet || !p) return;
    if (p.moving) {
      pet.playDirectional('running', p.dir === 'left' ? -1 : 1);
    } else if (p.hop) {
      pet.playOnce('jumping');
    } else {
      pet.faceDirection();
      pet.setState('idle');
    }
  });
} catch (_) {}

// ---- 糖码 AI 事件 → 动画 + 气泡 ----
try {
  bridge.onPetAgentEvent((ev) => {
    if (!pet) return;
    const m = mapAgentEvent(ev);
    if (!m) return;
    if (m.state && m.state !== 'idle') pet.playOnce(safeState(m.state));
    else if (m.state === 'idle') pet.setState('idle');
    if (m.text) bubble.show(m.text);
  });
} catch (_) {}
