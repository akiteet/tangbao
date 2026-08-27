'use strict';
// 五项历史遗留修复的静态断言（2026-08-26）：
// ①左下角头像 dataURL 直渲染 ④联网 net.fetch+错误可见化 ⑤角色卡拖动排序 ③浮窗 floatKit 装配 ②自定义模块独立小窗
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('①左下角头像：本地 dataURL 不再被 safeUrl 长度闸拒绝', () => {
  const ui = read('src/renderer/components/ui.js');
  assert.ok(ui.includes("/^data:image\\//i.test(avatar)"), 'renderUser 对 data:image/ 前缀直渲染');
  assert.match(ui, /const isLocalData = typeof avatar === 'string' && \/\^data:image\\\/\/i\.test\(avatar\)/);
});

test('④联网搜索：出网走 Electron net.fetch + 失败原因可见化 + 去假阳性', () => {
  const sp = read('src/infrastructure/agent-runtime/search-providers.js');
  assert.ok(sp.includes("require('electron')") && sp.includes('_net.fetch'), '主进程出网走 net.fetch（自动系统代理）');
  assert.ok(sp.includes('return fetch(url, opts)'), '非 Electron 语境回退全局 fetch');
  const chat = read('src/renderer/views/chat/chat.js');
  assert.ok(chat.includes('AbortSignal.timeout(12000)'), '/api/search 前端 12s 超时');
  assert.ok(chat.includes('联网搜索失败（'), '失败原因可见化（不再一律「暂不可用」）');
  const caps = read('src/core/models/capabilities.js');
  assert.ok(!caps.includes("{ tools: [{ type: 'web_search' }] }"), 'openai 系假阳性注入已移除');
  assert.ok(!/if \(\/openai/.test(caps), 'openai 分支已从 nativeWebModel 移除');
  assert.match(caps, /qwen\|qwq\|dashscope\|doubao\|seed\|ark/, 'qwen/doubao 真实原生分支保留');
});

test('⑤角色卡拖动排序：sortOrder 全链路 + 收藏置顶组内自定义', () => {
  const core = read('src/core/tavern/tavern-store.js');
  assert.ok(core.includes('result.sortOrder = Math.max(0, Math.round(Number(data.sortOrder) || 0))'), 'normalizeCharacter 放行 sortOrder');
  const infra = read('src/infrastructure/tavern/tavern-store.js');
  assert.ok(infra.includes('Number(a.sortOrder || 0) - Number(b.sortOrder || 0)'), '排序=收藏置顶+组内自定义序');
  assert.ok(infra.includes('reorderCharacters(orderedIds, expectedRevision)'), 'store 提供 reorderCharacters（乐观并发）');
  assert.ok(infra.includes('function nextSortOrder'), '新增卡片排序号=最大值+1（防插队）');
  assert.ok(infra.includes('sortOrder: item.sortOrder || 0'), 'summary 分页投影透传 sortOrder');
  const tavern = read('src/renderer/views/tavern/tavern.js');
  assert.ok(tavern.includes('draggable="true"') && tavern.includes('bindCharacterDrag'), '卡片可拖拽且渲染后绑定');
  assert.ok(tavern.includes("activeCharacterFilter !== 'all' || liveQuery"), '搜索/筛选状态下禁用拖拽');
  const main = read('src/main/main-tavern.js');
  assert.ok(main.includes("safeHandle('tavern:reorderCharacters'"), '主进程通道已注册');
  const preload = read('src/preload/preload.js');
  assert.ok(preload.includes('tavernReorderCharacters'), 'preload 透传');
  const svc = read('src/application/services/tavern.js');
  assert.ok(svc.includes('reorderCharacters(input)'), '服务层透传');
});

test('③浮窗 floatKit 装配：默认极简 + sanitize 透传 + agentRunPill 恒隐', () => {
  const state = read('src/renderer/state/state.js');
  assert.ok(state.includes('floatKit: { welcome: false, think: false, web: false'), '默认全关=极简');
  assert.ok(state.includes('floatKit: settings.floatKit || {}'), 'sanitizeFloatState 透传 floatKit 给浮窗');
  const app = read('src/renderer/app.js');
  assert.ok(app.includes('function applyFloatKit'), '浮窗按 floatKit 挂 fk-show-* 类');
  const css = read('styles.css');
  assert.match(css, /body\.float-mode:not\(\.fk-show-welcome\) #welcome/, '未勾选块默认隐藏');
  assert.match(css, /body\.float-mode #agentRunPill \{ display: none !important; \}/, '浮窗恒隐糖码运行药丸（卡死隐患）');
  const html = read('index.html');
  assert.ok(html.includes('id="fkWelcome"') && html.includes('悬浮窗装配'), '设置→外观 提供装配勾选组');
  const ui = read('src/renderer/components/ui.js');
  assert.ok(ui.includes("['fkWelcome', 'welcome']"), '勾选绑定 floatKit 并持久化');
});

test('②自定义模块独立小窗入口', () => {
  const modules = read('src/renderer/components/modules.js');
  assert.ok(modules.includes('data-cv-win') && modules.includes('独立小窗打开'), '模块视图头部提供小窗入口');
  const ui = read('src/renderer/components/ui.js');
  assert.ok(ui.includes('data-win="${m.id}"'), '管理面板每行提供小窗入口');
  assert.ok(ui.includes("App.services.shell.openChildWindow({ id: m.id, url: m.url, label: m.label })"), '复用既有子窗口通道（按 id 单例聚焦）');
});

test('版本显示动态化：关于卡片不再硬编码 v1.1.8', () => {
  const html = read('index.html');
  assert.ok(html.includes('id="aboutVersion"'), '关于卡片版本号元素存在');
  assert.doesNotMatch(html, /about-ver">v1\.1\.8/, '不再硬编码旧版本');
  const ui = read('src/renderer/components/ui.js');
  assert.ok(ui.includes("about.textContent = 'v' + r.version"), '关于卡片版本经 getAppVersion 动态回填');
});

test('用量统计激活/装配词条横排/子窗口多开（2026-08-26 第六轮反馈）', () => {
  const storage = read('src/renderer/components/ui-settings-storage.js');
  assert.ok(storage.includes('async refreshUsageSummary()'), '用量统计渲染函数存在（此前整体缺失）');
  assert.ok(storage.includes('window.electron.metricsSummary'), '调用 metricsSummary IPC');
  assert.ok(storage.includes("usageRefreshBtn.addEventListener"), '刷新按钮已绑定');
  const ui = read('src/renderer/components/ui.js');
  assert.ok(ui.includes('App.ui.refreshUsageSummary()'), '切到数据面板自动刷新');
  const main = read('src/main/main.js');
  const childSeg = main.slice(main.indexOf('custom:openChildWindow'), main.indexOf('custom:openChildWindow') + 2600);
  assert.ok(!childSeg.includes('parent: mainWindow'), '子窗口不再绑 parent（多开/最大化/最小化丑面板共同根因）');
  assert.ok(childSeg.includes('minWidth: 480'), '子窗口最小尺寸防缩没');
  assert.ok(childSeg.includes('支持多开'), '同 id 可多开（登记改窗口数组）');
  const css = read('styles.css');
  assert.match(css, /repeat\(5, 1fr\)/, '装配面板 5 列两行对齐');
  const html = read('index.html');
  assert.ok(html.includes('fk-chip'), '横排胶囊词条样式');
});

test('⑩第十轮反馈：MCP 编辑器接线 + 快捷键指南补全 + 键盘缩放', () => {
  const ui = read('src/renderer/components/ui.js');
  assert.ok(ui.includes("$('mcpServersJson')"), 'MCP JSON 编辑器有回填与 change 保存绑定（此前零绑定，卡片是死的）');
  assert.ok(ui.includes('mcpListTools'), '测试连接走 mcp:listTools 通道');
  const pre = read('src/preload/preload.js');
  assert.ok(pre.includes('mcpListTools'), 'preload 暴露 mcpListTools');
  const sc = read('src/renderer/components/shortcuts.js');
  assert.ok(sc.includes('sc.palette'), '帮助面板含命令面板键位行');
  assert.ok(sc.includes('shortcuts.global.floatToggle'), '帮助面板含全局浮窗键行');
  const i18n = read('src/renderer/components/i18n.js');
  assert.ok(i18n.includes("'sc.zoom'"), '缩放键位词条已入双语词典');
  const main = read('src/main/main.js');
  assert.ok(main.includes('before-input-event') && main.includes('attachZoomShortcuts'), '主进程为可信窗口挂键盘缩放');
});
