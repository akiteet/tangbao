'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Context = require('../../src/core/agent-runtime/context-manager');

test('G5：工具结果按独立预算从尾部保留并注明省略', () => {
  const messages = [{ role: 'system', content: '规则' }];
  for (let i = 0; i < 10; i++) messages.push({ role: 'tool', tool_call_id: 't' + i, content: '大结果'.repeat(300) }); // 每条约 900 字
  const out = Context.rebuildSafeMessages(messages, { workingState: {}, recentLimit: 20, toolReserveChars: 2400, contextWindow: 32000 });
  const toolMsgs = out.messages.filter((m) => m.role === 'tool');
  assert.ok(toolMsgs.length >= 3, '应保留最近 2 条真实工具消息 + 1 条省略占位');
  const totalChars = toolMsgs.reduce((n, m) => n + m.content.length, 0);
  assert.ok(totalChars <= 2400 + 200, '工具总字符不超过独立预算 + 占位余量');
  assert.ok(out.messages.some((m) => String(m.content).includes('独立预算已省略')), '应有省略注明');
  // 保真：最近一条工具消息内容必须完整保留
  assert.ok(out.messages.some((m) => m.role === 'tool' && String(m.content).startsWith('大结果大结果')), '最近工具消息应保留');
});

test('G5：工具预算充足时不丢弃、不加占位', () => {
  const messages = [{ role: 'system', content: '规则' }, { role: 'tool', tool_call_id: 't1', content: '短结果' }];
  const out = Context.rebuildSafeMessages(messages, { workingState: {}, recentLimit: 10, toolReserveChars: 40000, contextWindow: 32000 });
  assert.ok(out.messages.some((m) => m.role === 'tool' && String(m.content) === '短结果'), '预算充足时应原样保留');
  assert.ok(!out.messages.some((m) => String(m.content).includes('独立预算已省略')), '不应有省略占位');
});
