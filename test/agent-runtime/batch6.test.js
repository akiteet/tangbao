'use strict';
// 批次 6 回归：快捷键分发层 / i18n 脚手架 / macOS Dock 路径（源码静态断言）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('快捷键体系：单一 keydown 分发层 + 默认键位 + 帮助清单 + K 排除', () => {
  const sc = read('src/renderer/components/shortcuts.js');
  assert.ok(sc.includes("window.addEventListener('keydown', dispatch)"), '应用级 keydown 分发入口');
  assert.ok(sc.includes("'mod+n'") && sc.includes('newChatBtn'), '新建会话默认键');
  assert.ok(sc.includes("'mod+f'") && sc.includes('localSearchBtn'), '聚焦本地搜索默认键');
  assert.ok(sc.includes("'mod+,'") && sc.includes('openSettings'), '打开设置默认键');
  assert.ok(/mod\+1/.test(sc) && sc.includes('moduleByIndex'), 'Mod+1~8 模块切换');
  assert.ok(sc.includes("combo === 'mod+k') continue"), 'Ctrl/Cmd+K 归命令面板，本层排除');
  assert.ok(sc.includes('renderShortcutHelp') && sc.includes('shortcutList'), '帮助面板渲染键位清单');
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

test('macOS Dock 菜单代码路径：darwin 守卫 + 浮窗/退出项 + 失败可见化', () => {
  const main = read('src/main/main.js');
  assert.ok(/process\.platform === 'darwin'/.test(main), 'darwin 守卫存在');
  assert.ok(main.includes('app.dock.setMenu(dockMenu)'), 'Dock 菜单接线');
  assert.ok(/Dock 菜单设置失败/.test(main), '失败可见化（不静默吞错）');
});
