'use strict';
// 启动闪屏回归：闪屏接线完整性——splash.html 自包含、主窗 show:false + boot-done 接管、
// 兜底防呆、打包白名单登记。main.js / app.js 均为绑定环境的脚本，采用源码静态断言（同 chat-reliability 风格）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('splash.html 像素字标自包含（手写点阵字形/无logo无进度条/淡出钩子/背景模式）', () => {
  const src = read('splash.html');
  assert.ok(src.includes('aria-label="TangBao 启动中"'), '无障碍标注存在');
  assert.ok(src.includes('GLYPHS') && src.includes("'TangBao'"), '手写几何点阵字形表 + TangBao 组词（非字体栅格化）');
  assert.ok(!src.includes('SimHei') && !src.includes('measureText') && !src.includes('getImageData'), '无字体栅格化依赖（字形手写、不读像素）');
  assert.ok(src.includes('prefers-reduced-motion'), '减动效降级保留');
  assert.ok(!src.includes('logo'), '不含 logo（用户要求极简）');
  assert.ok(!src.includes('class="bar"') && !src.includes('progress'), '无进度条（纯符号）');
  assert.ok(src.includes('is-done'), '淡出钩子 .is-done 存在（主进程 executeJavaScript 触发）');
  assert.ok(src.includes('bg=solid'), 'solid 模式铺底色类（不支持 acrylic 的系统不发白）');
  assert.ok(!/<script[^>]+src=/.test(src), '无外部脚本依赖（file:// 自包含）');
});

test('对比度与闪烁特效：中性近纯色底 + 内边缘流光 + 放大字标 + 主题色低强度参与', () => {
  const src = read('splash.html');
  assert.ok(!src.includes('115deg'), '斜向光斑已删（大范围柔和渐变显脏）');
  assert.ok(!src.includes('rgba(23, 23, 23, 0.30)') && !src.includes('--veil'), '整页玻璃轻纱已删（第十三轮定稿）');
  assert.ok(!src.includes('--band-hi') && !src.includes('--band-lo'), '通宽硬边暗带已删（不再靠暗带承托字标）');
  assert.ok(src.includes('var(--splash-bg, #171717)'), 'body::before 单层中性底（无主题色时纯色深灰）');
  assert.ok(src.includes("setProperty('--splash-bg'") && src.includes('135deg'), '有主题色时仅注入 135deg 极弱渐变（几乎不可察觉）');
  assert.ok(src.includes('conic-gradient') && src.includes('splash-border-flow') && src.includes('-webkit-mask-composite: xor'), '内边缘流光：mask 打孔环线旋转，不遮字标');
  assert.ok(src.includes("setProperty('--splash-accent'"), '流光颜色经 --splash-accent 注入加亮主题色');
  assert.ok(!src.includes('TWINKLE_COLOR || colColor[cellsX'), '呼吸砖不沾主题色，保持字标同款灰白渐变（用户要求）');
  assert.ok(!src.includes('rgba(12, 14, 18') && !src.includes('rgba(8, 10, 14') && !src.includes('#111214'), '蓝移调黑清零（与应用中性灰同族）');
  assert.ok(src.includes('accent=([0-9a-fA-F]{6})') && src.includes('function lift('), '主题色解析并向白提亮 22%（仅终端光标用）');
  assert.ok(src.includes('CURSOR_COL') && src.includes('CURSOR_PERIOD'), '尾随终端式方块光标（主题元素）');
  assert.ok(src.includes('drawSolid') && !src.includes('ctx.scale'), '整数设备像素栅格 + 按列合并绘制（砖缝彻底为零）');
  assert.ok(!src.includes('radial-gradient') && !src.includes('border-radius'), '无居中方框底板（用户明确否掉）');
  assert.ok(!src.includes('TILE_GAP'), '砖缝已消除（直角实心像素字）');
  assert.ok(src.includes('var MAX_W = 540') && src.includes('Math.min(15,'), '字标放大到 15px 砖格（更有气势）');
  assert.ok(src.includes("'#8a8a8a'") && src.includes("'#ffffff'"), '横向灰→白渐变端点（左端提亮保证与背景对比）');
  assert.ok(src.includes('var TWINKLE_SHARE = 0.14') && src.includes('spawnTwinkler'), '呼吸灯收敛为低密度动效');
  assert.ok(src.includes('900 + Math.random() * 720'), '呼吸节奏放缓并保持错峰');
  assert.ok(src.includes('var SWEEP_WIDTH = 2') && src.includes('var SWEEP_DURATION = 880'), '一次窄亮带扫光');
  assert.ok(src.includes('var BRAND_WORD = \'TangBao\'') && src.includes("var WORD = 'Tangbao'"), '几何字标 Tangbao（仅 T 大写，用户定稿）+ 品牌回退字样');
  assert.ok(src.includes('var LETTER_GAP = 1'), '字母间保留规整空列');
  assert.ok(src.includes('0.72 + 0.28 * a'), '呼吸最低亮度保持稳定可读');
});

test('闪窗亚克力门控：Win11 走 acrylic，其余回退实色', () => {
  const main = read('src/main/main.js');
  assert.ok(main.includes("backgroundMaterial = 'acrylic'"), 'Win11 亚克力模糊（ZCode 同款）');
  assert.ok(main.includes('22621'), '按 build ≥ 22621 门控');
  assert.ok(main.includes("'#00000000'"), 'acrylic 模式窗口全透明底');
  assert.ok(main.includes("'#171717'"), '回退模式实色深灰（应用 neutral 暗底令牌）');
  assert.ok(main.includes("search: 'bg='"), '页面经查询参数得知背景模式');
});

test('闪屏注入用户主题色：主进程读 state.json 经查询参数传 accent', () => {
  const main = read('src/main/main.js');
  assert.ok(main.includes('function splashAccentParam()'), '主题色提取函数存在');
  assert.ok(/function splashAccentParam\(\) \{[\s\S]*?readActiveStateObject\(\)/.test(main), '复用现有同步读取入口');
  assert.ok(/function splashAccentParam\(\) \{[\s\S]*?settings\.appearance\.accent/.test(main), '取 appearance.accent 字段');
  assert.ok(/search: 'bg='[\s\S]{0,80}splashAccentParam\(\)/.test(main), 'loadFile search 拼接 accent 参数');
});

test('主窗改为启动隐藏，由渲染层 boot-done 接管显示', () => {
  const main = read('src/main/main.js');
  assert.ok(main.includes("backgroundColor: '#f4f4f4'"), '主窗底色改中性灰（原 #eef2fb 蓝底不再出现）');
  const showFalse = (main.match(/show: false,/g) || []).length;
  assert.ok(showFalse >= 2, '主窗与闪窗均 show:false，实际 ' + showFalse + ' 处');
  assert.ok(main.includes("loadFile(path.join(__dirname, '..', '..', 'splash.html')"), '闪屏经 loadFile 加载根目录 splash.html');
  assert.ok(main.includes("safeOn('app:boot-done'"), 'boot-done 通道已注册');
  assert.ok(main.includes('function revealMainWindow'), '接管函数存在且幂等（isVisible 守卫）');
});

test('闪屏防呆：每进程一次 + 最短展示 1s + 20s 兜底 + 主窗加载失败兜底', () => {
  const main = read('src/main/main.js');
  assert.ok(main.includes('const SPLASH_MIN_MS = 3000;'), '最短展示时长 3s（用户要求开屏展示 3 秒）');
  assert.ok(main.includes('splashShownAt = Date.now();'), '记录展示起始时间用于补齐最短展示');
  assert.ok(main.includes('if (splashCreated) return;'), '冷启动只建一次（activate/reload 不重弹）');
  assert.ok(/20000/.test(main), '20s 兜底定时器存在');
  assert.ok(main.includes('did-fail-load'), '主窗加载失败也强制可见');
  assert.ok(main.includes('createSplash();'), 'whenReady 第一步创建闪屏');
});

test('渲染层在 boot finally 发信号；浮窗模式不发', () => {
  const preload = read('src/preload/preload.js');
  assert.ok(preload.includes("notifyBootDone: (payload) => ipcRenderer.send('app:boot-done'"), 'preload 单向通道');
  const app = read('src/renderer/app.js');
  assert.ok(app.includes('window.electron.notifyBootDone({ ok: App.__bootReady === true'), 'finally 中成功失败都发');
  assert.ok(app.includes('!App.__floatMode && window.electron && window.electron.notifyBootDone'), '浮窗共用 boot 但不发信号');
});

test('打包白名单登记 splash.html', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.build.files.includes('splash.html'), 'electron-builder files 含 splash.html');
});
