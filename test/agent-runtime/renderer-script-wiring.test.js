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
