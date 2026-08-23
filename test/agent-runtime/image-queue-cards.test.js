'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const IMG = fs.readFileSync(path.join(__dirname, '../../src/renderer/views/images/image.js'), 'utf8');
const CSS = fs.readFileSync(path.join(__dirname, '../../styles.css'), 'utf8');

test('v1.1.6 Bug1：失败任务卡有 TTL 自动清理（TERMINAL_TTL + endedAt 年龄判断）', () => {
  assert.match(IMG, /const TERMINAL_TTL = \d+/, 'TERMINAL_TTL 常量存在');
  assert.match(IMG, /endedAt && \(now - t\.endedAt\) > TERMINAL_TTL/, '按 endedAt 年龄清理过期终态任务');
});

test('v1.1.6 Bug1：error/canceled 卡有手动消除按钮（dismiss 分支）', () => {
  assert.match(IMG, /data-qact="dismiss"/, '消除按钮 data-qact="dismiss" 存在');
  assert.match(IMG, /delete App\.image\.tasks\[id\];\s*App\.image\.renderQueue\(\)/, 'dismiss 分支删除任务并重绘');
});

test('v1.1.6 Bug1：终态任务结束后有一次性兜底重绘定时器', () => {
  assert.match(IMG, /_terminalDismissTimer/, '兜底重绘定时器存在');
  assert.match(IMG, /TERMINAL_TTL \+ 500/, '兜底定时器在 TTL + 500ms 后触发');
});

test('v1.1.6 Bug1：重试后清除原失败记录（不再残留）', () => {
  assert.match(IMG, /qact === 'retry'[\s\S]*?delete App\.image\.tasks\[id\]/, 'retry 分支删除原失败任务');
});

test('v1.1.6 Bug1：terminals 展示上限收敛为 2（防止历史失败堆积）', () => {
  assert.match(IMG, /\.slice\(0, 2\)/, 'terminals 切片上限为 2');
});

test('v1.1.8：糖创「预设/会话」tab 走常规圆角 + 激活态（操作控件不再用胶囊）', () => {
  assert.match(CSS, /\.create-library-tabs \[data-create-library-tab\] \{[^}]*border-radius: var\(--radius-md\)/s, 'tab 按钮用常规圆角');
  assert.match(CSS, /\.create-library-tabs \[data-create-library-tab\]\.active \{[^}]*background: var\(--primary-soft\)/s, 'tab 激活态有 primary-soft 背景');
  assert.match(CSS, /\.create-library-tabs \[data-create-library-tab\]:hover/, 'tab 有 hover 态');
});
