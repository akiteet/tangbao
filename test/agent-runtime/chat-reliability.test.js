'use strict';
// 聊天修复 E 回归：吞消息（streaming 卡死/切换会话）与账户切换自动回退。
// chat.js 是 IIFE 绑定 window 的渲染脚本，无法直接 require，故采用源码静态断言（与 skill-runtime.test.js 同风格）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('看门狗常量与 raceTimeout 存在', () => {
  const src = read('src/renderer/views/chat/chat.js');
  assert.ok(src.includes('const STREAM_FIRST_BYTE_MS = 30000;'), '首字节超时 30s');
  assert.ok(src.includes('const STREAM_IDLE_MS = 90000;'), '流数据空闲超时 90s');
  assert.ok(src.includes("const raceTimeout = (promise, ms) => {"), 'raceTimeout 助手存在');
  assert.ok(src.includes("e.code = 'STREAM_IDLE_TIMEOUT';"), '超时错误码存在');
  assert.ok(src.includes('return Promise.race([promise, timeout]).finally'), 'race 后清理定时器');
});

test('gatewayFetch 与 reader.read 均接入看门狗', () => {
  const src = read('src/renderer/views/chat/chat.js');
  assert.ok(src.includes('const res = await raceTimeout(App.rt.gatewayFetch('), 'fetch 阶段接首字节超时');
  assert.ok(src.includes('chunk = await raceTimeout(reader.read(), STREAM_IDLE_MS);'), 'reader 循环接空闲超时');
  assert.ok(src.includes("if (e && e.code === 'STREAM_IDLE_TIMEOUT') throw e;"), '超时抛给外层兜底');
  assert.ok(src.includes('// 聊天修复 E：流数据空闲看门狗'), '看门狗注释存在');
});

test('流式期间发送不再静默丢弃（明确提示并保留输入）', () => {
  const src = read('src/renderer/views/chat/chat.js');
  assert.ok(!src.includes('if ((!text && !atts.length) || streaming) return;'), '旧的静默丢弃已移除');
  assert.ok(src.includes("const busySame = streamConvId === (App.state.activeId || null);"), '区分本会话/其它会话忙碌');
  assert.ok(src.includes("App.ui.toast(busySame ? '当前对话仍在回复中"), '忙碌提示存在');
  assert.ok(src.includes('streamConvId = null'), '流结束复位归属会话');
});

test('三处发送路径都记录流归属并在 finally 按归属渲染', () => {
  const src = read('src/renderer/views/chat/chat.js');
  // 编辑重生成 + 普通发送 + regen 三处
  const markCount = (src.match(/streaming = true; streamConvId = conv\.id; App\.chat\.setSending\(true\);/g) || []).length;
  assert.equal(markCount, 3, '三处发送路径均记录 streamConvId');
  const renderCount = (src.match(/if \(App\.state\.activeId === conv\.id\) App\.chat\.renderMessages\(\); else App\.chat\.updateCtxBar\(\);/g) || []).length;
  assert.equal(renderCount, 3, '三处 finally 均按归属会话渲染');
});

test('账户下拉 change 立即写回 accountId 并持久化', () => {
  const src = read('src/renderer/components/ui.js');
  assert.ok(src.includes("prov.accountId = apiAccountSel.value || '__default__';"), 'change 立即写回 accountId');
  assert.ok(src.includes('App.persist();'), '写回后持久化');
  assert.ok(src.includes("if (m !== 'default') prov.model = '';"), '保留换账户清模型逻辑');
  assert.ok(src.includes('聊天修复 E：下拉切换立即写回 accountId'), '修复注释存在');
});

test('getProvider 回退链仍兼容（defaultAccountId 兜底）', () => {
  const src = read('src/renderer/state/state.js');
  assert.ok(src.includes('(sel.accountId || (s.providers.default && s.providers.default.accountId) || s.defaultAccountId)'), '回退链保留');
});

test('输入区去掉外层玻璃底条但保留输入卡片', () => {
  const css = read('styles.css');
  const composer = css.match(/\.composer \{ position: sticky; bottom: 0[^}]*\}/)[0];
  assert.ok(!composer.includes('backdrop-filter'), '玻璃模糊已移除');
  assert.ok(!composer.includes('var(--glass)'), '玻璃背景已移除');
  assert.ok(!composer.includes('border-top'), '顶部细线已移除');
  assert.ok(composer.includes('padding: 12px 24px 12px'), '底部固定 12px 间距');
  assert.ok(css.includes('.input-wrap {'), '输入卡片仍保留');
  assert.ok(/\.input-wrap \{[\s\S]{0,200}border: 1px solid var\(--border\)/.test(css), '卡片边框保留');
  assert.ok(!css.includes('.composer.centered'), 'centered 欢迎页样式已删除');
});

test('欢迎页输入框不再移入居中容器（统一贴底）', () => {
  const src = read('src/renderer/views/chat/chat.js');
  assert.ok(!src.includes("welcome.appendChild(composer)"), 'showWelcome 不再把输入框移入 welcome');
  assert.ok(!src.includes("view.appendChild(composer)"), 'showChat 不再移动输入框');
  assert.ok(!src.includes("classList.add('centered')") && !src.includes("classList.remove('centered')"), 'centered 类操作已删除');
  assert.ok(src.includes('聊天修复 F：输入框不再移入欢迎区居中'), '修复注释存在');
});

test('模型下拉限高 3.5 行且弹窗内滚动', () => {
  const css = read('styles.css');
  const dd = css.match(/\.model-dropdown \{[\s\S]{0,160}\}/)[0];
  assert.ok(dd.includes('max-height: 134px'), '弹窗高度上限 134px（≈3.5 行）');
  assert.ok(dd.includes('overflow-y: auto'), '弹窗内滚动');
  assert.ok(!dd.includes('max-height: 320px'), '旧的 320px 上限已替换');
});

test('纯图片/纯附件消息不再显示卡片气泡（图片保留细框直显）', () => {
  const src = read('src/renderer/views/chat/chat.js');
  assert.ok(src.includes("if (!m.content) bubble.style.display = 'none';"), '无文字即隐藏气泡');
  assert.ok(!src.includes("if (!m.content && !imgHtml && attHtml)"), '旧条件已替换');
  assert.ok(src.includes('class="chat-img"'), '图片直显保留');
  assert.ok(src.includes('聊天修复 G：无文字即隐藏卡片气泡'), '修复注释存在');
});
