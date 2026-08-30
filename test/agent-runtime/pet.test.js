'use strict';
// v1.2.1 批次 12：桌面宠物接线防回归（静态断言全链路——主进程工厂/引擎事件桥/托盘/设置卡/i18n/协议/CSP）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('批次12：主进程工厂 main-pet.js——透明无边框置顶小窗 + 位置/状态记忆', () => {
  const mp = read('src/main/main-pet.js');
  // 窗口参数：桌面宠物必须透明、无边框、置顶、不进任务栏、不可缩放、无阴影
  assert.match(mp, /transparent:\s*true/, '透明窗口（桌面宠物核心）');
  assert.match(mp, /frame:\s*false/, '无边框');
  assert.match(mp, /alwaysOnTop:\s*/, '置顶');
  assert.match(mp, /skipTaskbar:\s*true/, '不进任务栏');
  assert.match(mp, /resizable:\s*false/, '不可缩放');
  assert.match(mp, /hasShadow:\s*false/, '无系统阴影');
  assert.match(mp, /setIgnoreMouseEvents\(\s*true,\s*\{ forward:\s*true \}\)/, '默认点击穿透（forward 保留 hover）');
  assert.match(mp, /backgroundThrottling:\s*false/, '宠物窗关闭后台节流（防 occlusion 帧抖动）');
  assert.match(mp, /backgroundColor:\s*'#00000000'/, '显式全透明背景防白闪（第八轮闪烁修复）');
  // 状态记忆文件
  assert.match(mp, /pet-state\.json/, '宠物状态落盘 pet-state.json');
  // 用户反馈第四轮（2026-08-29）：移除自动漫游——固定位置可拖动；位置写盘 debounce 保留
  assert.doesNotMatch(mp, /pet:roamStep/, '旧瞬移漫游通道未复用（第十二轮改用 pet:roam 走段事件）');
  assert.match(mp, /function startRoam/, '自由漫游走段控制器（第十二轮回归）');
  assert.match(mp, /pet:roam', \{ moving: true, dir \}/, '走段开始事件（专用方向行姿态）');
  assert.match(mp, /pet:roam', hop \? \{ moving: false, hop: true \} : \{ moving: false \}/, '走段结束/跳跃换行事件（回 idle）');
  assert.match(mp, /hovering/, '悬停时漫游暂停');
  // 第十三轮：位置模式（固定/自由）+ 画廊
  assert.match(mp, /pet:setRoamMode/, '位置模式 IPC（fixed/free）');
  assert.doesNotMatch(mp, /pet:setRoam'/, '旧布尔漫游 IPC 已退役');
  assert.match(mp, /function pickRoamTarget/, '目标点寻路（全屏范围）');
  assert.match(mp, /wa\.width \* 0\.2/, '目标点距当前 ≥ 屏宽 20%（不再拘谨）');
  assert.match(mp, /hop: true/, '跳跃换行事件（jumping 姿态）');
  assert.match(mp, /merged\.roam === true\) merged\.roam = 'free'/, '旧布尔 roam 迁移');
  // 第九轮：app-region 失灵回退 JS 拖动（升级版）——绝对坐标 pet:moveTo + 动态窗口尺寸
  assert.doesNotMatch(mp, /pet:moveBy|pet:dragPose/, '增量式 moveBy 与 dragPose 通道已退役');
  assert.match(mp, /pet:moveTo/, '绝对坐标移动通道（rAF 合帧，无累积漂移）');
  assert.match(mp, /function petWindowSize/, '窗口尺寸随缩放动态变化（放大不再被窗口裁掉）');
  assert.match(mp, /petWindowSize\(st\.scale\)/, '创建窗口按当前缩放取尺寸');
  assert.match(mp, /movePersistTimer/, '位置写盘 debounce（拖动结束落最终位置）');
  // 第五轮反馈「看不到」：显示/创建时位置钳回可见工作区（拖出屏幕/显示器变更保险）
  assert.match(mp, /function clampToWorkArea/, 'workArea 钳制函数');
  assert.match(mp, /ensureOnScreen\(w\)/, '显示前强制回到可见区域');
  // 漫游：当前显示器 workArea 内移动
  assert.match(mp, /workArea/, '漫游限制在显示器工作区内');
  // 工厂导出
  assert.match(mp, /module\.exports = \{ createMainPet \}/, '工厂导出');
});

test('批次12：宠物资产 tangbao-pet:// 协议 + 内置精灵图资源存在', () => {
  const mp = read('src/main/main-pet.js');
  assert.match(mp, /protocol\.handle\('tangbao-pet'/, '注册 tangbao-pet 协议');
  assert.match(mp, /resolvePetAsset/, '内置优先、用户兜底的资产解析');
  // 内置宠物资产（Atlas 契约 1536x1872 = 9 行 x 8 格）
  const meta = JSON.parse(fs.readFileSync(path.join(root, 'assets/pets/fat-guga/meta.json'), 'utf8'));
  assert.equal(meta.id, 'fat-guga');
  assert.ok(fs.statSync(path.join(root, 'assets/pets/fat-guga/spritesheet.webp')).size > 100000, '内置 spritesheet.webp 非空');
});

test('批次12：main.js 接线——createMainPet 初始化 + 托盘/ Dock 项 + 启动默认关 + 事件桥', () => {
  const main = read('src/main/main.js');
  assert.match(main, /createMainPet\(\{/, 'createMainPet 工厂初始化');
  assert.match(main, /togglePetWindow\s*=\s*_mainPetInit\.togglePetWindow/, '托盘/快捷键引用 pet toggle');
  assert.match(main, /emitPetAgentEvent\s*=\s*_mainPetInit\.emitAgentEvent/, 'AI 事件桥赋值');
  assert.match(main, /显示\/隐藏桌宠/, '托盘/Dock 菜单含桌宠项（第六轮反馈改名）');
  assert.match(main, /resetPetOnBoot\(\)/, '启动默认关闭（同浮窗裁决）');
  assert.match(main, /closeAllPetWindows\(\)/, '主窗关闭时一并关闭宠物窗口');
  assert.match(main, /setAgentEventObserver\(\(payload\)\s*=>\s*emitPetAgentEvent\(payload\)\)/, 'agent 事件桥接线');
  // CSP/MIME
  assert.match(main, /tangbao-pet:/, 'CSP/协议含 tangbao-pet');
  assert.match(main, /'\.webp':\s*'image\/webp'/, 'MIME 表补 webp');
  assert.match(main, /worker-src 'self' blob:/, 'CSP 必须放行 blob worker（Pixi Assets.load 靠它解析精灵图，缺了=空画布）');
});

test('批次12：引擎 SSE 事件桥——setAgentEventObserver + emitRaw 镜像 + 导出', () => {
  const engine = read('src/infrastructure/agent-runtime/agent-runtime-engine.js');
  assert.match(engine, /let agentEventObserver = null;/, '观察者默认 null（零开销）');
  assert.match(engine, /function setAgentEventObserver/, '注入入口存在');
  assert.match(engine, /emitAgentEvent\(Object\.assign\(\{\}, data \|\| \{\}, \{ type \}\)\)/, 'emitRaw 镜像给宠物');
  assert.match(engine, /setAgentEventObserver/, '导出含 setAgentEventObserver');
  const server = read('src/infrastructure/agent-runtime/agent-server.js');
  assert.match(server, /setAgentEventObserver: runtime\.setAgentEventObserver/, 'agent-server 门面透传');
});

test('批次12：preload 暴露 pet 域（含 pet:agentEvent 订阅）', () => {
  const pre = read('src/preload/preload.js');
  for (const k of ['petToggle', 'petHide', 'petSetClickThrough', 'petSetDragging', 'petMoveTo', 'petSetRoamMode', 'petResetPosition', 'petSetPet', 'petSetScale', 'petList', 'petImport', 'petState', 'petStateChanged', 'onPetAgentEvent', 'onPetSelect', 'onPetScale', 'onPetRoam']) {
    assert.ok(pre.includes(k + ':'), 'preload 缺少 ' + k);
  }
  assert.ok(!pre.includes('petMoveBy') && !pre.includes('onPetDragPose') && !pre.includes('onPetRoamStep') && !pre.includes("petSetRoam:"), 'preload 增量拖动/姿态/旧漫游通道已退役');
  assert.match(pre, /ipcRenderer\.on\('pet:agentEvent'/, '宠物订阅 AI 事件');
});

test('批次12：设置卡——index.html DOM + ui.js renderPetSettings + state.js 归一化 + i18n', () => {
  const html = read('index.html');
  for (const id of ['petToggle', 'petGallery', 'petRoamMode', 'petImport', 'petScale', 'petAlwaysOnTop']) {
    assert.ok(html.includes('id="' + id + '"'), '设置卡缺少 #' + id);
  }
  // 第十二轮：自由漫游开关随走段制漫游回归（sc-row + switch）
  const petPanelRoam = html.slice(html.indexOf('class="settings-panel" data-panel="pet"'), html.indexOf('class="settings-panel" data-panel="data"'));
  assert.match(petPanelRoam, /id="petRoamMode"/, '位置模式选择（固定/自由）');
  // 第八轮：单行行内式重构（sc-row + iOS switch，修复无样式孤儿 .toggle）
  const petPanel = html.slice(html.indexOf('class="settings-panel" data-panel="pet"'), html.indexOf('class="settings-panel" data-panel="data"'));
  assert.match(petPanel, /class="sc-row"/, '桌宠面板单行行内式（对齐快捷键/MCP 卡）');
  assert.match(petPanel, /class="switch"/, 'iOS 开关构件');
  assert.doesNotMatch(petPanel, /class="toggle"/, '无样式孤儿 .toggle 已清除');
  assert.match(petPanel, /id="petResetPos"/, '复位位置按钮');
  const ui = read('src/renderer/components/ui.js');
  assert.match(ui, /renderPetSettings\(\)/, 'ui.js 提供 renderPetSettings');
  assert.match(ui, /App\.ui\.renderPetSettings\(\);/, 'refreshSettingsUI 接入');
  assert.match(ui, /window\.electron\.petShow/, '开关联动显示宠物');
  assert.match(ui, /window\.electron\.petImport/, '导入宠物按钮接线');
  // 第六轮反馈：开关真相同步 + 复位位置按钮
  assert.match(ui, /window\.electron\.petState/, '开关状态以主进程 pet-state 为准（启动重置后不再说谎）');
  assert.match(ui, /petResetPos/, '设置卡复位位置按钮接线');
  assert.match(ui, /已打开桌宠/, '改名：已打开桌宠');
  const state = read('src/renderer/state/state.js');
  assert.match(state, /pet:\s*\{ enabled:\s*false, petId:\s*'fat-guga'/, 'settings.pet 默认值');
  assert.match(state, /ns\.settings\.pet\s*=/, 'settings.pet 归一化');
  const i18n = read('src/renderer/components/i18n.js');
  assert.ok(i18n.includes("'pet.cardTitle'") && i18n.includes("'pet.import'"), 'i18n pet.* 词条');
  assert.ok(i18n.includes("'pet.cardTitle': '桌宠'") && i18n.includes("'pet.enabled': '显示桌宠'"), 'i18n 桌宠改名（第六轮反馈）');
  assert.ok(i18n.includes("'pet.position'") && i18n.includes("'pet.resetPos'"), 'i18n 位置/复位词条');
});

test('批次12（修复）：宠物不渲染根因——CSP unsafe-eval + 协议 ACAO + 内置走同源 HTTP + 失败可见', () => {
  const main = read('src/main/main.js');
  // 真根因：Pixi v8 dist 构建要求 unsafe-eval，严格 CSP 下初始化抛错。只对 pet.html 放宽。
  assert.match(main, /const CSP_PET = CSP_APP/, '定义宠物页专用 CSP');
  assert.match(main, /'unsafe-eval'/, 'pet.html CSP 放行 script-src unsafe-eval（Pixi v8 渲染器必需）');
  assert.match(main, /urlPath === '\/pet\.html' \? CSP_PET : CSP_APP/, '仅 pet.html 用宽松 CSP，其余页面严格');
  // 次要：协议跨源 ACAO + 内置走同源 HTTP
  const mp = read('src/main/main-pet.js');
  assert.match(mp, /Access-Control-Allow-Origin/, 'tangbao-pet 协议响应带 CORS 头');
  const pet = read('src/renderer/pet/pet.js');
  assert.match(pet, /function petAssetUrl/, '内置/用户宠物分别选择资源路径');
  assert.match(pet, /'\/assets\/pets\/' \+ encodeURIComponent/, '内置宠物走同源 HTTP（零 CORS）');
  assert.match(pet, /'tangbao-pet:\/\/' \+ encodeURIComponent/, '用户导入宠物走协议');
  assert.match(pet, /console\.error\('\[pet\] 精灵图加载失败'/, '加载失败写 console.error');
  assert.match(pet, /showLoadError/, '窗口内显示可见错误文字');
});

test('批次12（修复）：顶栏程序内宠物开关按钮 + 绑定', () => {
  const html = read('index.html');
  assert.ok(html.includes('id="petToggleBtn"'), '顶栏加 #petToggleBtn');
  const ui = read('src/renderer/components/ui.js');
  assert.match(ui, /const petToggleBtn = \$\(\'petToggleBtn\'\)/, 'ui.js 绑定顶栏按钮');
  assert.match(ui, /window\.electron\.petToggle/, '点击调用 petToggle');
  const i18n = read('src/renderer/components/i18n.js');
  assert.ok(i18n.includes("'pet.toggleTitle'"), 'i18n pet.toggleTitle 词条');
});

test('批次12（反馈修复）：快捷短语弹窗向上弹 + 锚定左缘（不再被窗口左缘裁切）', () => {
  const css = read('styles.css');
  assert.match(css, /\.snippet-dropdown\s*\{[^}]*top:\s*auto;/, '弹窗不再向下弹');
  assert.match(css, /\.snippet-dropdown\s*\{[^}]*bottom:\s*calc\(100% \+ 6px\)/, '弹窗改为向上弹');
  assert.match(css, /\.snippet-dropdown\s*\{[^}]*left:\s*0; right:\s*auto/, '弹窗锚按钮左缘向右上展开（通用 .dropdown 的 right:0 会向左伸出窗口被裁切）');
  assert.match(css, /\.snippet-dropdown\s*\{[^}]*max-height:\s*320px; overflow-y:\s*auto/, '短语多时弹窗内滚动');
  assert.match(css, /\.snippet-item[^{]*\{/, '弹窗项样式存在');
});

test('批次12（反馈修复）：渲染按需化——停用 Pixi 自动 ticker，仅换帧/缩放/尺寸变化时重绘', () => {
  const pet = read('src/renderer/pet/pet.js');
  assert.match(pet, /preserveDrawingBuffer:\s*true/, 'WebGL 保留绘制缓冲（透明窗常驻闪烁修复，第八轮）');
  assert.match(pet, /autoStart:\s*false/, '停用 Pixi 自动渲染（透明窗 60fps 持续重合成防闪烁）');
  assert.match(pet, /requestAnimationFrame\(frame\)/, '自驱 rAF 渲染循环');
  assert.match(pet, /pet\.update\(dt\) \|\| dirty/, '仅动画换帧才置 dirty');
  assert.match(pet, /hitTest\(localX, localY, 4\)/, '点击穿透判定 4px 内缩迟滞');
  assert.doesNotMatch(pet, /onPetRoamStep|toggleRoam|petMoveBy|layoutZones|onPetDragPose/, '渲染层漫游/增量拖动/姿态通道调用已退役');
  assert.match(pet, /playDirectional\('running', e\.screenX - dragLastX\)/, '拖动中方向实时跟随');
  assert.match(pet, /e\.screenX - grabOffset\.x/, '拖动定位用 screenX 绝对坐标（无累积漂移，松手位置=光标位置）');
  assert.match(pet, /petMoveTo\(p\.x, p\.y\)/, '移动经 pet:moveTo 发送');
  assert.match(pet, /pet\.position\.set\(window\.innerWidth \/ 2, window\.innerHeight\)/, 'resize 后精灵重新锚定底部中心（第九轮动态窗口尺寸）');
  assert.doesNotMatch(read('pet.html'), /-webkit-app-region/, 'pet.html 不再使用 app-region 拖动（透明窗+穿透切换下实测失灵）');
  const main = read('src/main/main-pet.js');
  const engine = read('src/renderer/pet/pet-engine.js');
  assert.match(engine, /hitTest\(localX, localY, margin\)/, '命中盒支持 margin 内缩');
  assert.match(engine, /return advanced;/, 'update 返回换帧 dirty 标志');
  // 第十轮：方向专用行——atlas 的 running-right/running-left 优先（不翻转），拖动朝向实时跟随
  assert.match(engine, /playDirectional\(base, dir\)/, '方向专用行优先（running-right/left）');
  // 专用行分支绝不能按方向镜像（素材自带朝向）——第十轮「左拖向右跑」根因
  assert.match(engine, /rightRow && rightRow\.length && leftRow && leftRow\.length\)\s*\{[^}]*this\.sprite\.scale\.x = this\.scaleValue;/, '专用行分支不按方向镜像');
  assert.match(engine, /faceDirection\(\)/, '切回通用行时强制应用朝向翻转');
  assert.match(engine, /this\.cellW/, '命中盒尺寸随 meta 格子规格');
  assert.match(pet, /playDirectional\('running', /, '拖动中朝向实时跟随');
  assert.match(main, /readdirSync\(srcDir\)\.filter/, '导入放宽：扫描文件夹（精灵图文件名任意）');
  assert.match(main, /jpe?g/, '导入放宽：支持 jpg');
  assert.match(main, /cellWidth/, '导入放宽：meta 可声明格子规格');
  assert.match(main, /meta0 \|\| \{\}/, 'meta.json 可选（缺省用文件夹名生成 id）');
  assert.doesNotMatch(main, /宽 1536px，高为 208 的整数倍/, '导入不再强制固定宽 1536');
});

test('批次12（第十二/十三轮）：自由漫游（全屏目标点制）+ 桌宠画廊 + 位置模式选择', () => {
  const pet = read('src/renderer/pet/pet.js');
  assert.match(pet, /onPetRoam/, '渲染层订阅漫游事件');
  assert.match(pet, /playDirectional\('running', p\.dir === 'left' \? -1 : 1\)/, '漫游走动用专用方向行（running-right/left）');
  assert.match(pet, /playOnce\('jumping'\)/, '跳跃换行姿态');
  const html = read('index.html');
  assert.ok(html.includes('id="petGallery"'), '桌宠画廊（所有已添加宠物预览/选择）');
  assert.ok(html.includes('id="petRoamMode"'), '位置模式选择（固定/自由）');
  const css = read('styles.css');
  assert.match(css, /\.pet-gallery \{/, '画廊样式（横排可滚动）');
  assert.match(css, /\.pet-gal-card\.active/, '选中卡片高亮');
  const ui = read('src/renderer/components/ui.js');
  assert.match(ui, /renderPetGallery\(/, 'ui.js 画廊渲染');
  assert.match(ui, /petSetRoamMode/, '位置模式绑定');
  assert.match(read('src/renderer/state/state.js'), /roamMode: psPet\.roamMode === 'fixed' \? 'fixed' : \(psPet\.roam === false \? 'fixed' : 'free'\)/, 'roamMode 归一化 + 旧布尔迁移');
  const i18n = read('src/renderer/components/i18n.js');
  assert.ok(i18n.includes("'pet.roamMode': '位置模式'") && i18n.includes("'pet.roamFree': '自由漫游'") && i18n.includes("'pet.roamFixed': '固定位置'"), 'i18n 位置模式词条');
});

test('批次12（第十轮）：对外文案与桌宠相关代码零竞品名', () => {
  for (const f of ['index.html', 'src/renderer/components/i18n.js', 'src/main/main-pet.js', 'src/renderer/pet/pet.js', 'pet.html', 'src/renderer/pet/atlas.js', 'src/renderer/pet/pet-engine.js']) {
    assert.doesNotMatch(read(f), /codex/i, f + ' 无竞品名');
  }
});

test('批次12（第五轮反馈）：宠物独立设置面板（与 提示词/模块 并列）+ 导入格式说明', () => {
  const html = read('index.html');
  assert.match(html, /class="set-nav-item" data-panel="pet"/, '设置导航含桌面宠物项（并列 提示词/模块）');
  assert.match(html, /class="settings-panel" data-panel="pet"/, '宠物独立面板内容区');
  assert.ok(html.includes('data-i18n="pet.importFormatTitle"'), '导入格式说明卡');
  assert.ok(html.includes('data-i18n="pet.importFormatSheet"'), 'spritesheet 契约说明');
  assert.ok(html.includes('data-i18n="pet.importFormatMeta"'), 'meta.json 说明');
  // 宠物卡已从外观面板迁出（外观面板不再包含 petToggle）
  const appearance = html.slice(html.indexOf('data-panel="appearance"'), html.indexOf('data-panel="pet"'));
  assert.ok(!appearance.includes('id="petToggle"'), '宠物卡不再埋在面板中');
  const i18n = read('src/renderer/components/i18n.js');
  assert.ok(i18n.includes("'panel.pet'"), 'i18n panel.pet 导航词条');
  assert.ok(i18n.includes("'pet.importFormatSheet'") && i18n.includes("'pet.importFormatMeta'"), 'i18n 导入格式词条');
});

test('批次12（第十一轮）：导入宠物立即可见 + 右键菜单条目可用', () => {
  const ui = read('src/renderer/components/ui.js');
  const region = ui.slice(ui.indexOf('renderPetSettings()'), ui.indexOf('renderLanguageSetting()'));
  assert.ok(region.includes('petList'), '宠物列表接入');
  assert.ok(!region.includes('select.options.length === 0'), '列表每次刷新重拉（原守卫导致导入的新宠物永远不出现）');
  const pet = read('src/renderer/pet/pet.js');
  assert.match(pet, /async function loadPet\(id\) \{[\s\S]{0,300}petList\(\)/, 'loadPet 前刷新宠物清单（新导入宠物可立即切换/轮换）');
  // 右键菜单：菜单内按下不冒泡关闭（原「任意 pointerdown 即关闭」让条目永远收不到 click）
  assert.match(pet, /menuEl\.addEventListener\('pointerdown', \(e\) => e\.stopPropagation\(\)\)/, '菜单内按下不关闭');
  assert.match(pet, /removeEventListener\('pointerdown', hideMenu\)/, '关闭时移除文档级监听');
});

test('批次12：渲染层宠物模块——atlas 契约 + 状态行 + 事件映射', () => {
  const atlas = read('src/renderer/pet/atlas.js');
  assert.match(atlas, /1536/, 'Atlas 默认契约宽 1536');
  assert.match(atlas, /192/, '默认格宽 192');
  assert.match(atlas, /'idle'/, '状态行含 idle');
  // 第八轮闪烁真凶：每行固定列数，动画不足时尾部是空白补位帧——
  // 轮播进空格 = 桌宠周期性整体消失（idle 实测 8 帧含 2 空帧 = 每 1.14s 消失 286ms）
  assert.match(atlas, /trimTrailingBlankFrames/, '行尾空白补位帧裁剪');
  // 第十轮：格子规格可由 meta.json 声明（导入放宽——任意尺寸横向排帧精灵图）
  assert.match(atlas, /makeAtlasTexture\(texture, grid\)/, '切图按 meta 声明的格子规格');
  assert.match(atlas, /trimTrailingBlankFrames\(url, atlas, grid\)/, '裁剪按 meta 声明的格子规格');
  const pet = read('src/renderer/pet/pet.js');
  assert.match(pet, /trimTrailingBlankFrames\(url, atlas, grid\)/, '加载时按规格执行空帧裁剪');
  assert.match(pet, /cellWidth/, '读取 meta 格子规格');
  assert.match(pet, /spritesheetFile/, '精灵图文件名来自 meta（支持 webp/png）');
  const agentEvents = read('src/renderer/pet/agent-events.js');
  assert.match(agentEvents, /require_approval/, '审批事件映射');
  assert.match(agentEvents, /tool_result/, '工具结果映射');
  assert.match(agentEvents, /'done'/, '完成映射');
  assert.ok(fs.existsSync(path.join(root, 'src/renderer/pet/pet-engine.js')), 'pet-engine 存在');
  assert.ok(fs.existsSync(path.join(root, 'src/renderer/pet/chat-bubble.js')), 'chat-bubble 存在');
});

test('批次12 第十四轮反馈：导入宠物可移除 + 复位显示器感知 + 开关可见', () => {
  const mp = read('src/main/main-pet.js');
  // ① 移除途径：pet:delete 仅删 user 目录宠物（id 白名单 + meta 必须存在），当前选中回退内置 fat-guga
  assert.match(mp, /safeHandle\('pet:delete', async \(e, id\) => \{/, '移除 IPC 注册');
  assert.match(mp, /\/\^\[a-zA-Z0-9_-\]\+\$\/\.test\(pid\)/, 'id 白名单（防路径越界）');
  assert.match(mp, /readMeta\(path\.join\(userDir, 'meta\.json'\)\)/, '仅 user 目录宠物可删（meta 存在性判定）');
  assert.match(mp, /fs\.rmSync\(userDir, \{ recursive: true, force: true \}\)/, '删除导入文件夹');
  assert.match(mp, /writePetState\(\{ petId: 'fat-guga' \}\)/, '当前选中被删回退内置 fat-guga');
  // ② 复位位置：显示器感知（窗口真实 bounds 所在屏）+ workArea 钳制 + ensureOnScreen 兜底
  assert.match(mp, /function defaultPositionOn\(rect\)/, '复位按窗口所在显示器计算（不再盲跳主显示器）');
  assert.ok(mp.indexOf('defaultPositionOn(b)') > -1, '复位用窗口真实 bounds');
  assert.ok(mp.indexOf('clampToWorkArea(raw, b.width, b.height)') > -1, '复位坐标钳回 workArea');
  assert.ok(/const c = clampToWorkArea\(raw[\s\S]{0,400}if \(w\) ensureOnScreen\(w\);/.test(mp.slice(mp.indexOf("'pet:resetPosition'"))), '复位后 ensureOnScreen 兜底');
  // ③ 面板开关可见：switch 轨道必须挂 .switch-track 类（裸 span 在 1684 行同名 .switch 覆盖下零尺寸不可见）
  const html = read('index.html');
  assert.ok(!/<label class="switch"><input[^>]*\/><span><\/span><\/label>/.test(html), '不得再出现裸 span 开关（不可见）');
  assert.match(html, /<input type="checkbox" id="petToggle" \/><span class="switch-track"><\/span>/);
  assert.match(html, /<input type="checkbox" id="petAlwaysOnTop" \/><span class="switch-track"><\/span>/);
  // 渲染层：删除按钮 + 确认 + 回退同步 + preload 通道
  const ui = read('src/renderer/components/ui.js');
  assert.match(ui, /data-pet-del/, '画廊卡片带移除按钮（仅 user 宠物渲染）');
  assert.match(ui, /window\.confirm\('确定移除此桌宠吗/, '删除前确认');
  assert.match(ui, /petDelete\(pid\)/, '走 preload 通道删除');
  assert.match(ui, /petId: r\.petId/, '删除后选中回退同步到 settings');
  const preload = read('src/preload/preload.js');
  assert.match(preload, /petDelete: \(id\) => ipcRenderer\.invoke\('pet:delete', id\)/, 'preload 暴露 petDelete');
  const css = read('styles.css');
  assert.match(css, /\.pet-gal-card \.pet-gal-del/, '删除按钮样式（悬停浮现）');
});
