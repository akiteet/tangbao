'use strict';
const { readComponentsSource } = require('./source-helper');
const test = require('node:test');
const { readRuntimeSource, readRendererSource, readMainSource } = require('./source-helper');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const mainSrc = readMainSource();
const storeSrc = read('src/infrastructure/storage/sqlite-store.js');
const uiSrc = readComponentsSource();
const agentSrc = readRendererSource();
const chatSrc = read('src/renderer/views/chat/chat.js');

test('B5：sqlite init 迁移失败时回收连接并置空', () => {
  assert.match(storeSrc, /if \(opened\) opened\.close\(\);/, '失败时应关闭连接');
  assert.match(storeSrc, /db = null;/, '失败时应置空 db');
  assert.match(storeSrc, /已回退 state\.json/, '应有回退提示');
});

test('B5：updateAgentRun 部分更新保留旧值（不重置 phase/usage）', () => {
  assert.match(storeSrc, /cur = stmt\.getRun\.get/, '应读取当前行');
  assert.match(storeSrc, /keep\(p\.status, cur && cur\.status\)/, '未提供字段应沿用旧值');
});

test('B5：浮窗透明度钳制到 [0,1]', () => {
  assert.match(mainSrc, /Math\.min\(1, Math\.max\(0, Number\.isFinite\(raw\) \? raw : 1\)\)/, '透明度应钳制到 [0,1]');
});

test('B5：isDirectChildOf Windows 盘符大小写归一', () => {
  assert.match(mainSrc, /process\.platform === 'win32' \? String\(p\)\.toLowerCase\(\) : p/, 'Windows 路径应大小写归一');
});

test('B5：ESC 处理器对静态弹窗只隐藏不删除', () => {
  assert.match(uiSrc, /m\.id === 'settingsModal' \|\| m\.id === 'accountModal'\) \{ m\.hidden = true; return; \}/, '静态弹窗应 hidden 而非 remove');
});

test('B5：agent 流异常（requestAccepted）后清理运行标记', () => {
  const i = agentSrc.indexOf('B5（P2）：请求已接受后流异常中断');
  assert.ok(i >= 0, '应有 requestAccepted 异常清理块');
  const seg = agentSrc.slice(i, i + 500);
  assert.match(seg, /setRunning\(false\)/, '应清理运行状态');
  assert.match(seg, /thread\._running = false/, '应清理线程运行标记');
});

test('B5：regen 在流式进行中禁止并发', () => {
  const i = chatSrc.indexOf('async regen(');
  const seg = chatSrc.slice(i, i + 300);
  assert.match(seg, /if \(streaming\)/, 'regen 应检查 streaming');
  assert.match(seg, /请稍候再重新生成/, '应有忙碌提示');
});

test('B5：语音听写用最终基线替换，不重复累加 interim', () => {
  assert.match(chatSrc, /let voiceBase = ''/, '应有语音基线变量');
  assert.match(chatSrc, /isFinal\) finalText \+= t; else interimText \+= t;/, '应区分最终/临时结果');
  assert.match(chatSrc, /voiceBase = \$\('input'\)\.value; \/\/ B5（P2）：结束固化基线/, 'onend 应固化基线');
});
