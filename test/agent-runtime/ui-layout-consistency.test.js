'use strict';

const { readComponentsSource } = require('./source-helper');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('设置弹窗使用统一固定可视高度且正文只有设置内容区负责滚动', () => {
  const css = read('styles.css');
  assert.match(css, /#settingsModal \.modal \{[^}]*height: min\(720px, 86vh\)/s);
  assert.match(css, /#settingsModal \.modal-body \{[^}]*overflow: hidden[^}]*padding: 0/s);
  assert.match(css, /\.settings-shell \{[^}]*height: 100%[^}]*overflow: hidden/s);
  assert.match(css, /\.settings-content \{[^}]*min-height: 0[^}]*overflow-y: auto/s);
});

test('设置弹窗底部说明使用独立容器和与主体一致的安全留白', () => {
  const html = read('index.html');
  const css = read('styles.css');
  assert.match(html, /<div class="settings-footer-notes">[\s\S]*密钥保存在本机系统安全存储中[\s\S]*不会上传到任何其他地方/);
  assert.match(css, /\.settings-footer-notes \{[^}]*padding: var\(--sp-2\) var\(--sp-5\) var\(--sp-3\)[^}]*border-top:/s);
  assert.match(css, /\.settings-footer-notes \.hint \{[^}]*margin: 0/s);
});

test('账户页关闭设置内容外层滚动并仅保留账户列表内滚动', () => {
  const css = read('styles.css');
  const ui = readComponentsSource();
  assert.match(ui, /settingsModal\.dataset\.activePanel = 'api'/);
  assert.match(ui, /\$\('settingsModal'\)\.dataset\.activePanel = target/);
  assert.match(css, /#settingsModal\[data-active-panel="account"\] \.settings-content \{ overflow: hidden; \}/);
  assert.match(css, /\.settings-panel\[data-panel="account"\] \.account-list-box \{[^}]*flex: 1 1 auto[^}]*max-height: none/s);
  assert.match(css, /\.account-list-box \{[^}]*overflow-y: auto/s);
});

test('糖读上传只由原生文件输入触发一次', () => {
  const doc = read('src/renderer/views/documents/doc.js');
  assert.doesNotMatch(doc, /dz\.addEventListener\('click', \(\) => input\.click\(\)\)/);
  assert.match(doc, /input\.addEventListener\('change'/);
  assert.match(doc, /if \(inp\) inp\.click\(\)/);
  assert.match(doc, /dz\.addEventListener\('drop'/);
});

test('糖读文件区约显示2.5张卡片并独立滚动，大纲获得更多空间和可见滚动条', () => {
  const doc = read('src/renderer/views/documents/doc.js');
  const css = read('styles.css');
  assert.match(doc, /doc-sec doc-sec-upload/);
  assert.match(doc, /doc-sec doc-sec-files/);
  assert.match(doc, /doc-sec doc-sec-analysis/);
  assert.match(doc, /doc-sec doc-sec-outline/);
  assert.match(css, /\.doc-chip \{[^}]*min-height: var\(--ctl-h-md\)/s);
  assert.match(css, /--doc-files-peek-height:\s*95px/);
  assert.match(css, /\.doc-sidebar \.doc-list \{[^}]*max-height:\s*var\(--doc-files-peek-height\)[^}]*overflow-y:\s*auto[^}]*scrollbar-gutter:\s*stable/s);
  assert.match(css, /\.doc-sec-outline \{[^}]*flex:\s*1 1 58%[^}]*min-height:\s*220px/s);
  assert.match(css, /\.doc-outline \{[^}]*height:\s*0[^}]*overflow-y:\s*scroll[^}]*scrollbar-gutter:\s*stable both-edges/s);
  // v1.1.8 N2：滚动条全局唯一规格——大纲的"可见滚动条"由全局 thin + border-strong thumb 契约保证
  assert.match(css, /\* \{ scrollbar-width: thin; scrollbar-color: var\(--border-strong\) transparent; \}/);
  assert.match(css, /::-webkit-scrollbar \{ width: 8px; height: 8px; \}/);
  assert.match(css, /::-webkit-scrollbar-thumb \{[\s\S]*?background: var\(--border-strong\)/);
  assert.match(css, /@media \(max-height:\s*700px\)[\s\S]*\.doc-sec-outline \{ min-height:\s*150px/);
});

test('左侧模块区小于聊天历史区且聊天历史卡片更紧凑', () => {
  const css = read('styles.css');
  assert.match(css, /\.main-nav \{[^}]*max-height: 34vh[^}]*flex: 0 1 auto/s);
  assert.match(css, /\.history \{[^}]*flex: 1 1 0[^}]*min-height: 0/s);
  assert.match(css, /\.sidebar \.history-item \{[^}]*min-height: var\(--ctl-h-md\)[^}]*padding: var\(--sp-2\) var\(--sp-2\)/s);
});

test('图片历史样式限定在 image-shell，不再覆盖左侧聊天历史卡片', () => {
  const css = read('styles.css');
  assert.match(css, /\.image-shell \.history-item \{/);
  assert.match(css, /\.image-shell \.history-thumb \{/);
  assert.doesNotMatch(css, /\n\.history-item \{ display: flex; gap: 16px; padding: 12px;/);
});
