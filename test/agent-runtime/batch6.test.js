'use strict';
// 批次 6 回归：快捷键分发层 / i18n 脚手架 / macOS Dock 路径（源码静态断言）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('快捷键体系：单一 keydown 分发层 + core 词表默认键 + 帮助清单 + K 排除', () => {
  const sc = read('src/renderer/components/shortcuts.js');
  const core = read('src/core/shortcuts.js');
  assert.ok(sc.includes("window.addEventListener('keydown', dispatch)"), '应用级 keydown 分发入口');
  assert.ok(core.includes("newChat: 'Ctrl+N'"), '新建会话默认键在 core 词表');
  assert.ok(sc.includes('newChatBtn'), '新建会话动作接线');
  assert.ok(sc.includes('localSearchBtn'), '聚焦本地搜索动作接线');
  assert.ok(sc.includes('openSettings'), '打开设置动作接线');
  assert.ok(sc.includes('moduleByIndex'), 'Mod+1~8 模块切换');
  assert.ok(sc.includes("combo === 'Ctrl+K'"), 'Ctrl/Cmd+K 归命令面板，本层排除');
  assert.ok(sc.includes('renderShortcutHelp') && sc.includes('shortcutList'), '帮助面板渲染键位清单');
  assert.ok(sc.includes('function appMap()'), '应用内键位由 settings 驱动（改动即时生效）');
  const html = read('index.html');
  assert.ok(html.includes('components/shortcuts.js'), 'shortcuts 已加载');
  assert.ok(html.includes('components/i18n.js'), 'i18n 已加载（先于 shortcuts）');
});

test('i18n 脚手架：词典/t/applyDom/setLocale + 首批 data-i18n 词条', () => {
  const i18n = read('src/renderer/components/i18n.js');
  assert.ok(i18n.includes('function t(') && i18n.includes('applyDom') && i18n.includes('setLocale'), '核心 API 存在');
  assert.ok(i18n.includes("'panel.api': '配置'") && i18n.includes("'topbar.settings': 'Settings'"), '中英词典首批词条');
  const html = read('index.html');
  assert.ok(html.includes('data-i18n-title="topbar.settings"'), '顶栏按钮标题已接入');
  assert.ok(html.includes('data-i18n="panel.api"'), '设置导航已接入');
  const state = read('src/renderer/state/state.js');
  assert.ok(state.includes("locale: 'zh'"), 'settings.locale 默认值');
  assert.ok(state.includes("ns.settings.locale"), 'locale 归一化透传');
});

test('i18n 第二批（v1.2.1 批次 9）：placeholder 机制 + 侧栏/composer 词条 + 糖馆 t() + 语言切换入口', () => {
  const i18n = read('src/renderer/components/i18n.js');
  assert.ok(i18n.includes('data-i18n-placeholder'), 'applyDom 支持 placeholder 翻译');
  assert.ok(i18n.includes("'sidebar.searchPlaceholder'") && i18n.includes("'composer.inputPlaceholder'"), '侧栏/composer 词条');
  assert.ok(i18n.includes("'tg.tab.characters'") && i18n.includes("'tg.exportAll'"), '糖馆 chrome 词条');
  assert.ok(i18n.includes("'settings.language'"), '语言卡词条');
  const html = read('index.html');
  assert.ok(html.includes('data-i18n-placeholder="sidebar.searchPlaceholder"'), '侧栏搜索 placeholder 接入');
  assert.ok(html.includes('data-i18n-placeholder="composer.inputPlaceholder"'), '输入框 placeholder 接入');
  assert.ok(html.includes('data-i18n-title="composer.snippet"') && html.includes('data-i18n-title="composer.send"'), 'composer 按钮 title 接入');
  assert.ok(html.includes('data-i18n="composer.thinkMedium"'), '思考强度下拉词条接入');
  assert.ok(html.includes('id="languageSelect"'), '设置→外观 语言切换入口');
  const ui = read('src/renderer/components/ui.js');
  assert.match(ui, /renderLanguageSetting\(\)/, 'ui.js 语言切换渲染');
  assert.match(ui, /App\.ui\.renderLanguageSetting\(\);/, 'refreshSettingsUI 接入');
  const view = read('src/renderer/views/tavern/tavern.js');
  assert.match(view, /tt\('tg\.tab\.characters'/, '糖馆 tab 词条化');
  assert.match(view, /tt\('tg\.exportAll'/, '糖馆底栏词条化');
  assert.match(view, /i18n:changed/, '语言切换重渲染糖馆');
});

test('macOS Dock 菜单代码路径：darwin 守卫 + 浮窗/退出项 + 失败可见化', () => {
  const main = read('src/main/main.js');
  assert.ok(/process\.platform === 'darwin'/.test(main), 'darwin 守卫存在');
  assert.ok(main.includes('app.dock.setMenu(dockMenu)'), 'Dock 菜单接线');
  assert.ok(/Dock 菜单设置失败/.test(main), '失败可见化（不静默吞错）');
});
