'use strict';
// 跨会话全文检索回归（v1.2.0 批次 4b；经 check:sqlite 的 Electron ABI 通道执行）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('searchExcerpt：命中位置居中截取 + 省略号 + 短文本原样', () => {
  const { searchExcerpt } = require('../../src/infrastructure/storage/sqlite-store')._searchHelpers;
  // 短文本原样返回
  assert.equal(searchExcerpt('短消息', '短'), '短消息');
  // 长文本：以命中处为中心，前后补省略号
  const long = '前缀'.repeat(40) + '关键词在这里' + '后缀'.repeat(60);
  const out = searchExcerpt(long, '关键词');
  assert.ok(out.startsWith('…') && out.endsWith('…'));
  assert.ok(out.includes('关键词在这里'));
  assert.ok(out.length < 140, '片段应收敛在窗口大小内');
});

test('本地检索 conversation 范围命中消息正文并返回窗口化片段', (t) => {
  const storage = require('../../src/infrastructure/storage/sqlite-store');
  let Database = null;
  try { Database = require('better-sqlite3'); } catch (_) {}
  if (!Database) { t.skip('better-sqlite3 native module is unavailable for this Node runtime'); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-fulltext-'));
  if (!storage.init(path.join(dir, 'tangbao.sqlite'))) { t.skip('better-sqlite3 初始化失败'); return; }
  try {
    storage.StorageService.upsertConversation({ id: 'conv-ft', title: '普通会话', createdAt: 1, updatedAt: 2 });
    const pad = '无关内容填充。'.repeat(30); // 让正文远超窗口长度
    const msgs = [];
    for (let i = 0; i < 5; i++) {
      msgs.push({ role: 'user', content: `第${i}条与目标无关` });
      msgs.push({ role: 'assistant', content: pad + '糖包的流式渲染管线值得信赖' + pad });
    }
    storage.StorageService.replaceMessages('conv-ft', msgs.map((m, idx) => Object.assign({ id: 'm-ft-' + idx, createdAt: 10 + idx }, m)));

    const hit = storage.StorageService.searchLocal('流式渲染', { scopes: ['conversation'], limit: 10 });
    assert.equal(hit.ok, true);
    const convHit = hit.items.find((it) => it.scope === 'conversation' && it.id === 'conv-ft');
    assert.ok(convHit, '按消息正文必须能命中会话');
    assert.ok(convHit.snippet.includes('流式渲染'), '片段必须包含命中词');
    assert.ok(convHit.snippet.length <= 130, '片段必须窗口化而非整段原文');

    const miss = storage.StorageService.searchLocal('绝不存在的词组xyz', { scopes: ['conversation'] });
    assert.equal(miss.items.filter((it) => it.scope === 'conversation' && it.id === 'conv-ft').length, 0);
  } finally {
    try { storage.close(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
});
