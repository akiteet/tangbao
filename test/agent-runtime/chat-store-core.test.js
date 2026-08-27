'use strict';
// chat-store-core / conv-markdown 行为回归（v1.2.0 批次 7 第一刀：自 chat.js/ui.js 抽出的纯核心）
const test = require('node:test');
const assert = require('node:assert');
const core = require('../../src/core/chat/chat-store-core.js');
const md = require('../../src/core/chat/conv-markdown.js');

test('归属判定：tavernCharacterId / originModule / default 三态，不依赖标记新旧', () => {
  assert.equal(core.ownerForConversation({ tavernCharacterId: 'c1' }), 'tavern');
  assert.equal(core.ownerForConversation({ originModule: 'tavern' }), 'tavern');
  assert.equal(core.ownerForConversation({ tavernCharacterId: '', originModule: 'tavern' }), 'tavern');
  assert.equal(core.ownerForConversation({ originModule: 'create' }), 'create');
  assert.equal(core.ownerForConversation({}), 'default');
  assert.equal(core.ownerForConversation(null), 'default');
  assert.equal(core.isTavernConv({ tavernCharacterId: 'c1' }), true);
  assert.equal(core.isTavernConv({}), false);
  assert.equal(core.isModuleOwner('tavern'), true);
  assert.equal(core.isModuleOwner('chat'), false);
  assert.equal(core.isModuleOwner(''), false);
});

test('运行时整形幂等：自动补齐模块桶且不破坏既有数据', () => {
  const host = {};
  const r1 = core.ensureModuleRuntime(host);
  assert.equal(r1.status, 'pending');
  for (const owner of core.MODULE_OWNERS) {
    assert.deepEqual(r1.data[owner], { conversations: [], activeId: null });
  }
  // 预置数据后再次整形必须原样保留
  r1.data.tavern.conversations.push({ id: 'c1' });
  r1.data.tavern.activeId = 'c1';
  const r2 = core.ensureModuleRuntime(host);
  assert.equal(r2, host.moduleSessions);
  assert.equal(r2.data.tavern.conversations[0].id, 'c1');
  assert.equal(r2.data.tavern.activeId, 'c1');
  // 损坏形态（非数组 conversations）被修复
  delete r2.data.create.conversations;
  const r3 = core.ensureModuleRuntime(host);
  assert.deepEqual(r3.data.create.conversations, []);
});

test('写队列：同一 owner 串行按序执行；不同 owner 并行互不阻塞', async () => {
  const q = core.createModuleWriteQueue();
  const order = [];
  const slow = (ms, tag) => () => new Promise((res) => setTimeout(() => { order.push(tag); res(tag); }, ms));
  await Promise.all([
    q.enqueue('tavern', slow(30, 'A1')),
    q.enqueue('tavern', slow(5, 'A2')),   // 提交更晚但更快 → 必须等 A1 完成后才执行
    q.enqueue('create', slow(1, 'B1')),
  ]);
  assert.deepEqual(order, ['B1', 'A1', 'A2']);
  // 前序抛错不得阻断后续
  const after = [];
  await q.enqueue('tavern', async () => { throw new Error('boom'); }).catch(() => {});
  await q.enqueue('tavern', async () => { after.push('ok'); });
  assert.deepEqual(after, ['ok']);
});

test('snapshotOf：JSON 往返隔离；循环引用回退原对象', () => {
  const src = { id: 'x', messages: [{ content: 'hi' }] };
  const snap = core.snapshotOf(src);
  snap.messages[0].content = 'changed';
  assert.equal(src.messages[0].content, 'hi');
  const a = {}; a.self = a;
  assert.equal(core.snapshotOf(a), a);
});

test('buildConversationMarkdown：标题兜底/角色标签/空会话', () => {
  const out = md.buildConversationMarkdown({
    title: '调试会话',
    messages: [
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一答' },
    ],
  });
  assert.equal(out, '# 调试会话\n\n**User:**\n第一问\n\n**Assistant:**\n第一答\n\n');
  assert.equal(md.buildConversationMarkdown({ messages: [] }), '# 新对话\n\n');
  assert.equal(md.buildConversationMarkdown(null), '# 新对话\n\n');
});
