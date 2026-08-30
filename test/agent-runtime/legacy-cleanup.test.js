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
  assert.ok(sc.includes("'floatToggle'"), '全局浮窗键行仍在（GLOBAL_IDS）');
  const i18n = read('src/renderer/components/i18n.js');
  assert.ok(i18n.includes("'sc.zoom'"), '缩放键位词条已入双语词典');
  const main = read('src/main/main.js');
  assert.ok(main.includes('before-input-event') && main.includes('attachZoomShortcuts'), '主进程为可信窗口挂键盘缩放');
});

test('糖绘生图模型显示与调用一致（2026-08-28）：render 自愈 + 入队快照可见下拉', () => {
  const img = read('src/renderer/views/images/image.js');
  // 第一层：render 自愈——存在生图模型但 providers.image.model 不在其中（含为空）时拨正 state
  assert.ok(img.includes('imageNames.has(imgProv.model)') && img.includes('imageProv.model = imgSel'), 'render 自愈把 state 拨正为下拉显示模型');
  assert.ok(img.includes('if (imageProv.model !== imgSel)'), '仅在值变化时 persist（收敛不重复写盘）');
  // 第二层：generate 以可见下拉为准 + enqueue 快照 + runTask 以快照为准
  assert.ok(img.includes("const visibleModel = modelPick && modelPick.value ? modelPick.value : ''"), 'generate 读 #imgModel 当前值');
  assert.ok(img.includes('model: taskModel'), 'enqueue 快照本次模型到 task');
  assert.ok(img.includes('taskModel = paramsModel || provider.model'), '快照回退 provider.model');
  assert.ok(img.includes('if (task.model) p.model = task.model'), 'runTask 以入队快照模型为准（所见即所调）');
});

test('批次 1：app.js 浮窗合并/快照函数无重复定义（死代码清理防回潮）', () => {
  const app = read('src/renderer/app.js');
  const countFn = (name) => (app.match(new RegExp('function\\s+' + name + '\\s*\\(')) || []).length;
  assert.equal(countFn('applyFloatStateSnapshot'), 1, 'applyFloatStateSnapshot 只保留带守卫的存活版本');
  assert.equal(countFn('mergeFloatConversations'), 1, 'mergeFloatConversations 只保留一份定义');
  assert.ok(app.includes('__applyingFloatState'), '存活版本保留浮窗防环守卫');
  assert.ok(app.includes('splitLegacyModuleSessions'), 'splitLegacyModuleSessions 仍被其他逻辑使用');
});

test('批次 2：糖馆编辑器焦点守护（异步回流不再把焦点丢回 BODY）', () => {
  const tavern = read('src/renderer/views/tavern/tavern.js');
  assert.ok(tavern.includes('function startEditorFocusKeeper') && tavern.includes('function stopEditorFocusKeeper'), '焦点守护器存在');
  assert.ok(tavern.includes('document.activeElement === document.body'), '仅当焦点掉回 body 时才还焦（不抢用户主动聚焦）');
  assert.ok(tavern.includes("if (kind === 'editor') startEditorFocusKeeper()"), 'switchDrawer 打开编辑器时启动守护');
  assert.match(tavern, /requestAnimationFrame\(focusNameWhenReady\);\r?\n           startEditorFocusKeeper\(\)/, '新建角色后衔接既有重试并启动守护');
  assert.match(tavern, /stopEditorFocusKeeper\(\);\r?\n    render\(\)/, '关抽屉时停止守护');
});

test('批次 3：快捷键 id/键位统一 core 词表 + 设置卡可录入改键', () => {
  const sc = read('src/renderer/components/shortcuts.js');
  // id 统一：分发层不再有私有 snake_case id
  assert.doesNotMatch(sc, /new_chat|local_search|open_settings/, '分发层不再用私有 snake_case 动作 id');
  assert.ok(sc.includes("id: 'newChat'") && sc.includes("id: 'search'") && sc.includes("id: 'settings'"), '动作 id 与 core 词表一致');
  // 键位 settings 驱动 + 冲突检查 + 全局即时重注册
  assert.ok(sc.includes('function appMap()') && sc.includes('settings.shortcuts'), '分发层从 settings.shortcuts.app 读键位');
  assert.ok(sc.includes("combo === 'Ctrl+K'"), 'Ctrl+K 恒让给命令面板');
  assert.ok(sc.includes('shortcutsSetGlobal'), '全局改键经 shortcutsSetGlobal 即时重注册');
  assert.ok(sc.includes('function resetAll'), '提供恢复默认');
  assert.ok(sc.includes("'与「' + conflict + '」冲突"), '同命名空间冲突拒绝');
  // 设置卡接线（防「死的卡片」复发）
  const html = read('index.html');
  assert.ok(html.includes('id="shortcutEditRows"'), '设置→帮助 快捷键卡有录入容器');
  assert.ok(html.includes('id="shortcutReset"'), '设置卡有恢复默认按钮');
  const i18n = read('src/renderer/components/i18n.js');
  assert.ok(i18n.includes("'sc.mainToggle'") && i18n.includes("'sc.global'"), '新词条已入双语词典');
});

test('批次 6：MCP 审批记忆接线（弹窗按钮 + 引擎会话授权 + 设置撤销卡）', () => {
  const ap = read('src/renderer/views/agent/agent-approvals.js');
  assert.ok(ap.includes('allow_session_tool') && ap.includes('allow_mcp_rule'), '审批弹窗提供「本会话不再询问 / 永久允许此工具」');
  assert.ok(ap.includes('ruleTool = \'mcp\''), 'MCP 规则形状修正（总是允许写 tool=mcp + pattern=server/tool）');
  const engine = read('src/infrastructure/agent-runtime/agent-runtime-engine.js');
  assert.ok(engine.includes("decision === 'allow_session_tool'") && engine.includes("approvedTools.add('mcp|'"), '引擎审批回调写入会话级工具授权');
  const ad = read('src/infrastructure/agent-runtime/approval-decision.js');
  assert.ok(ad.includes('auth.approvedTools') && ad.includes("toolName === 'mcp'"), 'needsApproval 3.5 步 + MCP 默认审批');
  const ui = read('src/renderer/components/ui.js');
  assert.ok(ui.includes('renderMcpAllowed') && ui.includes('data-mcp-revoke'), '设置卡渲染 MCP 已授权清单 + 撤销');
  const html = read('index.html');
  assert.ok(html.includes('id="mcpAllowedList"'), '设置卡 DOM 存在（防「死的卡片」）');
});
