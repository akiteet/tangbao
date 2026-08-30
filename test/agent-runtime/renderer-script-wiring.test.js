'use strict';
// 渲染层核心模块接线防回归（2026-08-26 群聊全员秒败根因：stream-accumulator.js 漏加进 index.html，
// App.chatStreamAccumulator 未定义导致所有真实流式请求在 chat.js 秒抛 TypeError——静态源码断言对
// 「文件存在但页面未加载」全盲，故此处直接断言 index.html 的 script 标签与加载顺序）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('index.html 必须加载全部 core/chat 纯模块且顺序先于 chat.js', () => {
  const html = read('index.html');
  const cores = [
    'src/core/chat/chat-store-core.js',
    'src/core/chat/conv-markdown.js',
    'src/core/chat/stream-scheduler.js',
    'src/core/chat/stream-accumulator.js',
  ];
  const chatIdx = html.indexOf('src/renderer/views/chat/chat.js');
  assert.ok(chatIdx > 0, 'chat.js 已被 index.html 加载');
  for (const f of cores) {
    assert.ok(fs.existsSync(path.join(root, f)), f + ' 文件存在');
    const idx = html.indexOf(f);
    assert.ok(idx > 0, 'index.html 缺少 <script src="' + f + '">——漏载将使对应 window.App.* 未定义、流式请求全部秒抛');
    assert.ok(idx < chatIdx, f + ' 必须先于 chat.js 加载（chat.js 启动即读取其注册的 App 命名空间）');
  }
  // 依赖顺序：accumulator 组合 scheduler，必须在其后加载
  assert.ok(html.indexOf('stream-scheduler.js') < html.indexOf('stream-accumulator.js'), 'stream-accumulator 依赖 stream-scheduler，须后加载');
});

test('index.html 必须加载 core/shortcuts.js 且先于 state.js 与分发层（v1.2.1 批次 3 接线）', () => {
  const html = read('index.html');
  const coreFile = 'src/core/shortcuts.js';
  assert.ok(fs.existsSync(path.join(root, coreFile)), coreFile + ' 文件存在');
  const coreIdx = html.indexOf(coreFile);
  const stateIdx = html.indexOf('src/renderer/state/state.js');
  const dispatcherIdx = html.indexOf('src/renderer/components/shortcuts.js');
  assert.ok(coreIdx > 0, 'index.html 缺少 ' + coreFile + '——渲染层 App.ShortcutsCore 未定义则快捷键设置卡/分发器全盲');
  assert.ok(coreIdx < stateIdx, 'core/shortcuts.js 必须先于 state.js 加载（state.js 归一化引用 App.ShortcutsCore）');
  assert.ok(coreIdx < dispatcherIdx, 'core/shortcuts.js 必须先于分发层加载');
});

test('pet.html 必须加载 vendor/pixi.min.mjs 与 pet 主入口（v1.2.1 批次 12 接线）', () => {
  const petHtml = read('pet.html');
  const petJs = read('src/renderer/pet/pet.js');
  assert.ok(fs.existsSync(path.join(root, 'vendor/pixi.min.mjs')), 'vendor/pixi.min.mjs 文件存在（宠物动画引擎）');
  assert.ok(fs.existsSync(path.join(root, 'src/renderer/pet/pet.js')), 'pet.js 主入口存在');
  assert.match(petHtml, /<script type="module" src="src\/renderer\/pet\/pet\.js"><\/script>/, 'pet.html 加载 pet.js 主入口');
  // 依赖模块必须在（避免「文件存在但未加载」）
  for (const f of ['atlas.js', 'pet-engine.js', 'chat-bubble.js', 'agent-events.js']) {
    assert.ok(fs.existsSync(path.join(root, 'src/renderer/pet', f)), 'src/renderer/pet/' + f + ' 存在');
  }
  // pet.js 的相对导入须指向项目根 vendor（../../ 会错解析到 src/vendor/）
  assert.match(petJs, /import \{ Application, Assets \} from '\.\.\/\.\.\/\.\.\/vendor\/pixi\.min\.mjs'/, 'pet.js 从项目根 vendor 导入 pixi');
});
