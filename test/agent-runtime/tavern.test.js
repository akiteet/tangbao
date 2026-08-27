'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const Core = require('../../src/core/tavern/tavern-store');
const Infra = require('../../src/infrastructure/tavern/tavern-store');
const EmbeddingIndex = require('../../src/infrastructure/tavern/embedding-index');
const Gateway = require('../../src/infrastructure/model-gateway/gateway');

test('character cards expose shortcut fields, presets, and safe local avatars', () => {
  const card = Core.normalizeCharacter({
    id: 'card-a', name: 'Archivist', tagline: 'Keep the record clear', greeting: 'Welcome.',
    matureAllowed: true, avatar: 'https://example.test/avatar.png', tags: ['research'],
    starters: ['Open the archive', 'Ask about the missing page', ''],
  });
  assert.equal(card.id, 'card-a');
  assert.equal(card.tagline, 'Keep the record clear');
  assert.equal(card.greeting, 'Welcome.');
  assert.equal(card.matureAllowed, true);
  assert.equal(card.avatar, '');
  assert.deepEqual(card.starters, ['Open the archive', 'Ask about the missing page']);
  const presetIds = Core.PRESETS.map((item) => item.id);
  assert.deepEqual(presetIds, [
    'midnight-radio-lan',
    'mist-harbor-wensheng',
    'starship-yicheng',
    'southwind-nanzhi',
  ]);
  for (const preset of Core.PRESETS) {
    assert.ok(preset.summary && preset.summary.length >= 30, `${preset.id} needs a concrete summary`);
    assert.ok(preset.patch.name);
    assert.ok(preset.patch.tagline.length >= 20);
    assert.ok(preset.patch.description.length >= 80);
    assert.ok(preset.patch.personality.length >= 120);
    assert.ok(preset.patch.scenario.length >= 120);
    assert.ok(preset.patch.firstMessage.length >= 40);
    assert.ok(preset.patch.starters.length >= 4);
    assert.ok(preset.patch.exampleDialogue.length >= 80);
    assert.ok((preset.patch.exampleDialogue.match(/用户：/g) || []).length >= 2, `${preset.id} needs two user turns`);
    assert.ok((preset.patch.exampleDialogue.match(new RegExp(preset.patch.name + '：', 'g')) || []).length >= 2, `${preset.id} needs two character turns`);
    assert.ok(preset.patch.systemPrompt.length >= 60);
    assert.ok(preset.patch.tags.length >= 3 && preset.patch.tags.length <= 6);
    assert.match(preset.patch.scenario, /\d{1,2}:\d{2}|公历|周[一二三四五六日]/, `${preset.id} needs a concrete time anchor`);
    assert.match(preset.patch.scenario, /号|馆|店|站|港|桥|书|频道|录音室|舰桥|库房/, `${preset.id} needs a concrete place anchor`);
    assert.match(preset.patch.systemPrompt, /用户|不要|不得|每次|每轮|回复|尊重/, `${preset.id} needs explicit interaction rules`);
    assert.doesNotMatch(
      `${preset.summary} ${preset.patch.description} ${preset.patch.personality} ${preset.patch.scenario} ${preset.patch.systemPrompt}`.toLowerCase(),
      /web|联网|工具|附件|工作流|代码|总结|翻译|任务助手|智能体|写作助手/,
      `${preset.id} must remain an immersive character, not a functional assistant`,
    );
  }
  assert.equal(presetIds.includes('writing-assistant'), false);
  assert.equal(presetIds.includes('game-character'), false);
});

test('Tavern keeps stream output across surface changes and hides web indicators', () => {
  const chat = fs.readFileSync(path.join(__dirname, '../../src/renderer/views/chat/chat.js'), 'utf8');
  const view = fs.readFileSync(path.join(__dirname, '../../src/renderer/views/tavern/tavern.js'), 'utf8');
  assert.doesNotMatch(chat, /renderMessages\(\) \{\s*if \(streaming\) \{/);
  assert.match(chat, /let streamUi = null;/);
  assert.match(chat, /bindStreamUi\(ui, node\)/);
  assert.match(chat, /streamUi\.messageId = liveMessage\.id/);
  assert.match(chat, /if \(m\.id\) wrap\.dataset\.messageId = m\.id/);
  // v1.2.0 群聊增强：activeConv 提取为复用变量（群聊头像/名字行同用），web 指示符逻辑不变
  assert.match(chat, /const activeConv = App\.chat\.activeConv\(\);\r?\n\s*const tavern = isTavernConv\(activeConv\) \|\| isTavernConversation\(App\.state\.activeId\)/);
  assert.match(chat, /const webHtml = !tavern &&/);
  assert.match(chat, /if \(isTavernConv\(conv\) && webIndicator\) webIndicator\.remove\(\)/);
  assert.match(view, /function switchDrawer\(kind\)/);
  assert.match(view, /restoreEditorBase\(\)/);
  assert.match(view, /保存并切换/);
});

test('character card export keeps bounded starter prompts and imports them again', () => {
  const card = Core.normalizeCharacter({ id: 'card-starters', name: 'Archivist', starters: ['One', 'Two'] });
  const bundle = Core.exportBundle(card, []);
  assert.deepEqual(bundle.data.starters, ['One', 'Two']);
  assert.deepEqual(Core.importBundle(bundle).character.starters, ['One', 'Two']);
});

test('Tavern character cards and character_book entries normalize without losing common fields', () => {
  const imported = Core.importBundle({
    spec: 'chara_card_v2',
    data: {
      name: 'Archivist',
      char_persona: 'Keeps careful notes',
      first_mes: 'Welcome.',
      mes_example: '<START>\nUser: hello',
      system_prompt: 'Stay grounded.',
      tags: ['research'],
      character_book: {
        entries: [{ comment: 'Archive rule', keys: ['archive', 'record'], content: 'The archive is local.', weight: 80 }],
      },
    },
  });
  assert.equal(imported.character.name, 'Archivist');
  assert.equal(imported.character.description, 'Keeps careful notes');
  assert.equal(imported.character.firstMessage, 'Welcome.');
  assert.equal(imported.character.exampleDialogue, '<START>\nUser: hello');
  assert.equal(imported.memories.length, 1);
  assert.equal(imported.memories[0].title, 'Archive rule');
  assert.deepEqual(imported.memories[0].keywords, ['archive', 'record']);
  assert.equal(imported.memories[0].priority, 80);
});

test('standalone worldbooks normalize supported envelopes without character data', () => {
  const entries = Core.importWorldbook({ character_book: { entries: [{ comment: 'A rule', keys: ['bell'], content: 'The bell rings at dusk.', weight: 70 }] } }, 'char-a');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].characterId, 'char-a');
  assert.equal(entries[0].title, 'A rule');
  assert.deepEqual(entries[0].keywords, ['bell']);
  assert.equal(entries[0].priority, 70);
  assert.equal(Core.importWorldbook([{ title: 'Second', content: 'A second fact.' }], 'char-a').length, 1);
});

test('standalone worldbook envelopes all bind entries to the selected character', () => {
  const sources = [
    { worldbook: [{ title: 'Worldbook', content: 'Worldbook fact.' }] },
    { memories: [{ title: 'Memories', content: 'Memory fact.' }] },
    { entries: [{ title: 'Entries', content: 'Entry fact.' }] },
    { character_book: { entries: [{ comment: 'Character book', content: 'Character-book fact.' }] } },
    { data: { character_book: { entries: [{ comment: 'Nested character book', content: 'Nested fact.' }] } } },
    [{ title: 'Array', content: 'Array fact.' }],
  ];
  for (const source of sources) {
    const imported = Core.importWorldbook(source, 'char-selected');
    assert.equal(imported.length, 1);
    assert.equal(imported[0].characterId, 'char-selected');
    assert.match(imported[0].content, /fact\./);
  }
});

test('standalone worldbook preview reports skipped entries without changing import compatibility', () => {
  const preview = Core.inspectWorldbookImport({ entries: [
    { title: 'Valid', content: 'Keep this local fact.' },
    { title: 'Empty', content: '   ' },
    { title: 'Missing content' },
  ] }, 'char-a');
  assert.equal(preview.sourceCount, 3);
  assert.equal(preview.importedCount, 1);
  assert.equal(preview.skippedCount, 2);
  assert.match(preview.warnings.join(' '), /2/);
  assert.equal(Core.importWorldbook({ entries: [
    { title: 'Valid', content: 'Keep this local fact.' },
    { title: 'Empty', content: '   ' },
  ] }, 'char-a').length, 1);
});

test('worldbook preview detects the projected card size before writing', () => {
  const character = Core.normalizeCharacter({ id: 'char-a', name: 'A' });
  const existing = [Core.normalizeMemory({ characterId: character.id, content: 'existing fact' }, character.id)];
  const entries = Array.from({ length: 30 }, (_, index) => ({
    title: 'Large entry ' + index,
    content: 'x'.repeat(12000),
  }));
  const preview = Core.inspectWorldbookImport({ entries }, character.id, { character, memories: existing });
  assert.equal(preview.importedCount, 30);
  assert.equal(preview.tooLarge, true);
  assert.equal(preview.canImport, false);
  assert.ok(preview.bytes > Core.MAX_CARD_BYTES);
  assert.match(preview.warnings.join(' '), /不能写入/);
});

test('worldbook import conflict, size failure, and write failure leave existing data unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-tavern-import-fail-'));
  try {
    const filePath = path.join(dir, 'library.json');
    const store = Infra.createStore({ filePath });
    assert.equal(store.saveCharacter({ id: 'char-a', name: 'A' }, 0).ok, true);
    assert.equal(store.saveMemory('char-a', { content: 'keep me' }, 1).ok, true);
    const before = store.getCharacter('char-a');
    const conflict = store.importWorldbook('char-a', { entries: [{ content: 'stale write' }] }, 1);
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'tavern_revision_conflict');
    assert.deepEqual(store.getCharacter('char-a').memories, before.memories);

    const oversized = store.importWorldbook('char-a', {
      entries: Array.from({ length: 30 }, (_, index) => ({ title: 'Large ' + index, content: 'x'.repeat(12000) })),
    }, before.revision);
    assert.equal(oversized.ok, false);
    assert.equal(oversized.code, 'tavern_card_too_large');
    assert.deepEqual(store.getCharacter('char-a').memories, before.memories);

    const seededCharacter = Core.normalizeCharacter({ id: 'char-a', name: 'A' });
    let kv = JSON.stringify({
      version: Core.VERSION,
      revision: 1,
      characters: [seededCharacter],
      memories: [{ id: 'keep', characterId: 'char-a', content: 'keep me' }],
      matureMode: false,
    });
    const failingStore = Infra.createStore({
      getKV: () => kv,
      setKV: () => { throw new Error('simulated worldbook write failure'); },
    });
    const failed = failingStore.importWorldbook('char-a', { entries: [{ content: 'must not persist' }] }, 1);
    assert.equal(failed.ok, false);
    assert.equal(failed.code, 'tavern_store_write_failed');
    assert.deepEqual(failingStore.getCharacter('char-a').memories.map((item) => item.content), ['keep me']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('worldbook retrieval is character-scoped, ranked, and budgeted', () => {
  const first = Core.normalizeCharacter({ id: 'char-a', name: 'A' });
  const second = Core.normalizeCharacter({ id: 'char-b', name: 'B' });
  const memories = [
    Core.normalizeMemory({ id: 'm-a', characterId: first.id, title: 'Build rule', content: 'Use the build command.', keywords: ['build'], priority: 90 }, first.id),
    Core.normalizeMemory({ id: 'm-b', characterId: second.id, title: 'Build rule', content: 'Do not use this character context.', keywords: ['build'], priority: 100 }, second.id),
  ];
  const result = Core.retrieveMemories(memories.filter((item) => item.characterId === first.id), 'build', { limit: 5, tokenBudget: 128 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].memory.id, 'm-a');
  assert.ok(result.usedChars > 0);
  assert.equal(result.semantic, false);
});

test('tavern store persists revisions and rejects stale writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-tavern-'));
  try {
    const store = Infra.createStore({ filePath: path.join(dir, 'library.json') });
    const saved = store.saveCharacter({ id: 'char-a', name: 'A' }, 0);
    assert.equal(saved.ok, true);
    assert.equal(saved.revision, 1);
    const stale = store.saveMemory('char-a', { id: 'memory-a', content: 'fact' }, 0);
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'tavern_revision_conflict');
    const memory = store.saveMemory('char-a', { id: 'memory-a', content: 'fact', keywords: ['fact'] }, 1);
    assert.equal(memory.ok, true);
    const reloaded = Infra.createStore({ filePath: path.join(dir, 'library.json') });
    const detail = reloaded.getCharacter('char-a');
    assert.equal(detail.ok, true);
    assert.equal(detail.memories[0].content, 'fact');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('imports always receive new ids and semantic indexes become stale after worldbook edits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-tavern-index-'));
  try {
    const store = Infra.createStore({
      filePath: path.join(dir, 'library.json'),
      indexPath: path.join(dir, 'embeddings.index.json'),
    });
    const original = store.saveCharacter({ id: 'card-a', name: 'Existing' }, 0);
    assert.equal(original.ok, true);
    const imported = store.importBundle({ data: { id: 'card-a', name: 'Imported', greeting: 'Hi' }, worldbook: [{ id: 'memory-a', content: 'A local fact', keys: ['fact'] }] }, 1);
    assert.equal(imported.ok, true);
    assert.notEqual(imported.characterId, 'card-a');
    const detail = store.getCharacter(imported.characterId);
    assert.equal(detail.memories[0].characterId, imported.characterId);

    const rebuilt = store.rebuildEmbeddingIndex(imported.characterId, {
      modelId: 'text-embedding-test',
      vectors: { [detail.memories[0].id]: [1, 0, 0] },
      source: 'offline-mock',
    });
    assert.equal(rebuilt.ok, true);
    const ready = store.getEmbeddingIndex(imported.characterId, 'text-embedding-test');
    assert.equal(ready.ok, true);
    assert.equal(ready.source, 'offline-mock');
    assert.deepEqual(ready.vectors[detail.memories[0].id], [1, 0, 0]);
    const rawIndex = fs.readFileSync(path.join(dir, 'embeddings.index.json'), 'utf8');
    assert.equal(rawIndex.includes('A local fact'), false);
    assert.equal(rawIndex.includes('A changed local fact'), false);

    const changed = store.saveMemory(imported.characterId, { id: detail.memories[0].id, content: 'A changed local fact', keywords: ['changed'] }, 2);
    assert.equal(changed.ok, true);
    const stale = store.getEmbeddingIndex(imported.characterId, 'text-embedding-test');
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'embedding_index_stale');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('embedding index reports corruption without affecting the character library', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-tavern-corrupt-'));
  const indexPath = path.join(dir, 'embeddings.index.json');
  try {
    fs.writeFileSync(indexPath, '{broken', 'utf8');
    const index = EmbeddingIndex.createIndexStore(indexPath);
    const result = index.load();
    assert.equal(result.ok, false);
    assert.equal(result.corrupted, true);
    assert.equal(result.code, 'embedding_index_corrupt');
    assert.equal(fs.existsSync(indexPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('embedding calls record request identity and an explicit non-cacheable metric', async () => {
  const originalFetch = global.fetch;
  const metrics = [];
  Gateway.setEndpoints([{ ref: 'acct-embedding', apiBase: 'https://provider.example/v1' }]);
  Gateway.configure({
    getSecret: (ref) => ref === 'acct-embedding' ? 'test-secret' : '',
    recordModelCallMetric: (metric) => metrics.push(metric),
  });
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ index: 0, embedding: [1, 0, 0] }], usage: { prompt_tokens: 4, total_tokens: 4 } }),
  });
  try {
    const result = await Gateway.createEmbeddings('acct-embedding', 'text-embedding-test', ['hello'], { callType: 'embedding_query' });
    assert.equal(result.ok, true);
    assert.equal(metrics.length, 1);
    assert.equal(metrics[0].scope, 'tavern');
    assert.equal(metrics[0].callType, 'embedding_query');
    assert.match(metrics[0].requestId, /^embedding_query_/);
    assert.equal(metrics[0].cache.mode, 'not_eligible');
    assert.equal(metrics[0].cache.unknownReason, 'not_cache_eligible');
    assert.equal(metrics[0].cache.dataOrigin, 'not_applicable');
    assert.equal(metrics[0].inputTokens, 4);
  } finally {
    global.fetch = originalFetch;
    Gateway.configure({ getSecret: () => '', recordModelCallMetric: null });
  }
});

test('Tavern chat source keeps attachments and provider tools disabled', () => {
  const chat = fs.readFileSync(path.join(__dirname, '../../src/renderer/views/chat/chat.js'), 'utf8');
  assert.match(chat, /if \(isTavernConv\(conv\)\) \{\s*payload\.tools = \[\];/);
  assert.doesNotMatch(chat, /payload\.web\s*=/);
  assert.match(chat, /const conv = App\.chat\.activeConv\(\);[\s\S]{0,240}糖馆独立会话不支持图片或文件附件/);
});

test('Tavern transport uses chat kind while retaining module telemetry', () => {
  const chat = fs.readFileSync(path.join(__dirname, '../../src/renderer/views/chat/chat.js'), 'utf8');
  assert.match(chat, /const transportKind = 'chat';/);
  assert.match(chat, /gatewayFetch\([\s\S]{0,240}kind: 'chat'[\s\S]{0,180}scope: providerModule/);
});

test('Tavern new sessions start empty and auto-title from the first user turn', () => {
  const view = fs.readFileSync(path.join(__dirname, '../../src/renderer/views/tavern/tavern.js'), 'utf8');
  const chat = fs.readFileSync(path.join(__dirname, '../../src/renderer/views/chat/chat.js'), 'utf8');
  assert.match(view, /conv\.title = '新会话';/);
  assert.doesNotMatch(view, /conv\.messages\.push\(\{ id: App\.uid\(\), role: 'assistant', content: greeting/);
  assert.match(chat, /conv\.titleMode !== 'manual'/);
  assert.match(chat, /conv\.title = \(text \|\|/);
  assert.doesNotMatch(chat, /conv\.title === '新会话' \|\| conv\.tavernCharacterId/);
});

test('Tavern editor keeps a single worldbook heading and exposes standalone import', () => {
  const view = fs.readFileSync(path.join(__dirname, '../../src/renderer/views/tavern/tavern.js'), 'utf8');
  const memory = view.slice(view.indexOf('function memoryHtml()'), view.indexOf('function sessionHtml()'));
  assert.doesNotMatch(memory, /tg-section-title.*世界书/);
  assert.match(view, /data-tg-worldbook-import/);
  assert.match(view, /previewWorldbookImport/);
});

test('Tavern worldbook mutations invalidate detail cache before rerender', () => {
  const view = fs.readFileSync(path.join(__dirname, '../../src/renderer/views/tavern/tavern.js'), 'utf8');
  const deleteStart = view.indexOf('const memoryDelete = target.closest');
  const importStart = view.indexOf('const worldbookImport = target.closest');
  assert.ok(deleteStart >= 0);
  assert.ok(importStart > deleteStart);
  assert.match(view.slice(deleteStart, importStart), /invalidateCharacterDetail\(selected\.id\);[\s\S]*loadCharacters\(selected\.id\)/);
  assert.match(view.slice(importStart, importStart + 2600), /invalidateCharacterDetail\(selected\.id\);[\s\S]*loadCharacters\(selected\.id, \{ refreshList: true \}\)/);
});

test('Tavern character replacement is guarded while the editor is dirty', () => {
  const view = fs.readFileSync(path.join(__dirname, '../../src/renderer/views/tavern/tavern.js'), 'utf8');
  assert.match(view, /function runWithEditorGuard\(action\)/);
  // 角色卡点击带 personalOnly：进入个人会话，绝不被指针带进群聊（2026-08-26 用户反馈）
  assert.match(view, /runWithEditorGuard\(async \(\) => \{[\s\S]{0,300}loadCharacters\(select\.dataset\.tgSelect, \{ personalOnly: true \}\)/);
  assert.match(view, /runWithEditorGuard\(\(\) => \{[\s\S]{0,180}activeDrawer = 'editor'/);
});

test('Tavern local interactions coalesce search and editor dirty work', () => {
  const view = fs.readFileSync(path.join(__dirname, '../../src/renderer/views/tavern/tavern.js'), 'utf8');
  assert.match(view, /let characterSearchTimer = null;/);
  assert.match(view, /setTimeout\(\(\) => \{[\s\S]{0,260}renderCharacterList\(query, list\)/);
  assert.match(view, /function scheduleEditorDirtyCheck\(\)/);
  assert.match(view, /editorDirty = true;/);
  assert.match(view, /editorDirty = editorSignature\(\) !== editorSnapshot;/);
  assert.doesNotMatch(view, /if \(search\)[\s\S]{0,180}renderCharacterList\(search\.value, list\)/);
  assert.doesNotMatch(view, /if \(event\.target\.closest\('\.tg-editor-form'\)\) editorDirty = editorSignature\(\) !== editorSnapshot;/);
});

test('Tavern editor exposes immersive draft fields without legacy duplicate controls', () => {
  const view = fs.readFileSync(path.join(__dirname, '../../src/renderer/views/tavern/tavern.js'), 'utf8');
  assert.doesNotMatch(view, /tgSystemPrompt|bindLegacy|legacyParseDraft/);
  assert.match(view, /tgFirstMessage/);
  assert.match(view, /tgStarters/);
  assert.match(view, /tgExample/);
  assert.match(view, /data-tg-preset/);
  assert.match(view, /selected = Object\.assign\(\{\}, selected \|\| \{\}, preset\.patch\)/);
  assert.match(view, /editorDirty = true;/);
});

test('Tavern keeps the default Chat prompt and isolates global user memory', () => {
  const chat = fs.readFileSync(path.join(__dirname, '../../src/renderer/views/chat/chat.js'), 'utf8');
  const view = fs.readFileSync(path.join(__dirname, '../../src/renderer/views/tavern/tavern.js'), 'utf8');
  assert.match(chat, /const baseSys = isTavernConv\(conv\)/);
  assert.match(chat, /const userMemory = isTavernConv\(conv\) \? ''/);
  assert.match(chat, /const userMemTok = App\.context\.estimateTokens\(isTavernConv\(conv\) \? ''/);
  assert.match(chat, /const cmSys = App\.context\.estimateTokens\(systemContent\)/);
  assert.match(view, /let worldbookExpanded = false;/);
  assert.match(view, /worldbookExpanded = !!\(body && !body\.hidden\)/);
});

test('Tavern invalid character pointers fall back to a valid recent card', () => {
  const view = fs.readFileSync(path.join(__dirname, '../../src/renderer/views/tavern/tavern.js'), 'utf8');
  assert.match(view, /const explicit = hasCharacter\(preferredId\) \? String\(preferredId\) : ''/);
  assert.match(view, /const persisted = hasCharacter\(ui\.lastCharacterId\) \? String\(ui\.lastCharacterId\) : ''/);
  assert.match(view, /selectedId = explicit \|\| persisted \|\| \(fallback && fallback\.id\) \|\| currentId \|\|/);
});

test('Tavern library cards stay compact and ignore malformed sessions', () => {
  const view = fs.readFileSync(path.join(__dirname, '../../src/renderer/views/tavern/tavern.js'), 'utf8');
  const cardSource = view.slice(view.indexOf('function card(item)'), view.indexOf('function renderCharacterList'));
  assert.doesNotMatch(cardSource, /item\.description/);
  assert.match(cardSource, /data-tg-recent/);
  assert.match(view, /function isValidSession\(item, characterId\)/);
  assert.match(view, /\.filter\(\(item\) => isValidSession\(item, characterId\)\)/);
  // v1.2.0：findSession 改为按 id 全量查找个人会话，不再绑定当前选中角色——跨角色可进、孤儿会话可删（2026-08-26）
  assert.doesNotMatch(view.slice(view.indexOf('function findSession'), view.indexOf('function findSession') + 600), /isValidSession\(item, selected/);
  assert.match(view, /message\.role === 'user' \|\| message\.role === 'assistant'/);
  // v1.2.0：会话 tab 聚合全部角色的个人会话，逐行标注所属角色（2026-08-26 用户反馈）
  assert.match(view, /function sessionHtml\(\) \{[\s\S]{0,600}filter\(\(item\) => !isGroupConv\(item\)\)/);
  assert.match(view, /与「\$\{esc\(nameOf\(item\.tavernCharacterId\)\)\}」的会话/);
  // v1.2.0 群聊独立：指针校正改用归属判定（单角色 + 群聊归首位角色），isValidSession 只做单角色展示过滤
  assert.match(view, /if \(!belongsToCharacter\(active, selected\.id\)\) restoreConversation\(selected\.id\)/);
});
