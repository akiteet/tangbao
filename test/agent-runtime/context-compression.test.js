'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// 在 node 中加载 renderer 的 context.js：需先建 window/App 双全局桩（文件内 window.App、App 均被引用）
global.window = {};
global.App = {};
global.window.App = global.App;
require('../../src/renderer/views/chat/context.js');
const C = global.App.context;

// 每条消息内容含唯一序号，避免相同内容干扰断言
function msg(role, i) {
  return { role, content: '测'.repeat(700) + '#' + i };
}

test('G3：首次压缩（无摘要超阈值）返回 needsCompress 与中间段', () => {
  const window = 32000; // limit ≈ 0.64×32k ≈ 20.5k；30×~1120 ≈ 33.6k 超阈值
  const messages = [];
  for (let i = 0; i < 30; i++) messages.push(msg('user', i));
  const r = C.getCompactMessages({
    messages, summary: '', summaryCount: 0,
    recentKeep: C.RECENT_KEEP_AGENT, systemContent: 'sys', util: C.COMPACT_UTIL_AGENT, window,
  });
  assert.equal(r.needsCompress, true);
  assert.ok(r.middleMsgs.length > 0, '中间段应非空');
  assert.ok(r.newSummaryCount > 0);
  // 断层现象：finalMessages 不含中间段首条 —— 调用方（agent.js/chat.js）必须用同步压缩先出摘要再发送
  assert.ok(!r.finalMessages.some((m) => m.content === r.middleMsgs[0].content),
    '未同步压缩时中间段被丢弃，正是 G3 要消除的断层');
});

test('G3：压缩成功返回非空新摘要（同步路径可用）', async () => {
  global.App.rt = { gatewayFetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '合并后的摘要内容' } }] }) }) };
  const mid = [msg('user', 1), msg('assistant', 2)];
  const provider = { ref: 'acc:test', hasKey: true, model: 'm' };
  const s = await C.compressAsync('', mid, provider, 128000, null);
  assert.ok(s && String(s).includes('合并后的摘要'), '应返回非空新摘要');
});

test('G3：压缩失败返回空值（触发调用方回退全量发送）', async () => {
  global.App.rt = { gatewayFetch: async () => { throw new Error('boom'); } };
  const mid = [msg('user', 1)];
  const provider = { ref: 'acc:test', hasKey: true, model: 'm' };
  const s = await C.compressAsync('', mid, provider, 128000, null);
  assert.ok(!s, '失败应返回空值，调用方据此回退全量发送，不丢中间段');
});

test('G3：版本检查不匹配时丢弃压缩结果', async () => {
  global.App.rt = { gatewayFetch: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }) };
  const mid = [msg('user', 1)];
  const provider = { ref: 'acc:test', hasKey: true, model: 'm' };
  const s = await C.compressAsync('', mid, provider, 128000, () => false);
  assert.equal(s, null);
});

test('G4：compressAsync 把 extraContext 透传给摘要生成（用户记忆/技能参考）', async () => {
  let seenUserText = '';
  global.App.rt = { gatewayFetch: async ({ payload }) => { seenUserText = payload.messages[1].content; return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; } };
  const mid = [msg('user', 1)];
  const provider = { ref: 'acc:test', hasKey: true, model: 'm' };
  const s = await C.compressAsync('', mid, provider, 128000, null, '用户长期记忆：xxx\n本次激活技能：git-commit-standards');
  assert.ok(s, '应返回摘要');
  assert.match(seenUserText, /用户长期记忆/, 'extraContext 应进入摘要请求');
  assert.match(seenUserText, /git-commit-standards/, '激活技能名应进入摘要请求');
});

test('预算阈值：agentUtilLevel 分档正确（ok/pre/hard/emergency，与后端同源）', () => {
  const w = 128000;
  const b = C.agentBudgetSpec(w);
  assert.equal(C.agentUtilLevel(b.precompress - 1, w), 'ok');
  assert.equal(C.agentUtilLevel(b.precompress, w), 'pre');
  assert.equal(C.agentUtilLevel(b.hard, w), 'hard');
  assert.equal(C.agentUtilLevel(b.emergency, w), 'emergency');
});
