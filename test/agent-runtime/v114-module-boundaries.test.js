'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('v1.1.4 Tangguan library collapse is runtime-only and uses the 900px desktop boundary', () => {
  const view = read('src/renderer/views/tangguan/tangguan.js');
  const css = read('styles.css');
  assert.match(view, /let libraryCollapsed = false;/);
  assert.match(view, /tg-library-is-collapsed/);
  assert.match(view, /data-tg-library-toggle/);
  assert.match(view, /window\.innerWidth > 900/);
  assert.doesNotMatch(view, /tangguanUi\(\)[\s\S]{0,240}libraryCollapsed/);
  assert.match(css, /--module-library-rail-width:\s*40px/);
  assert.match(css, /--module-library-tab-width:\s*32px/);
  assert.match(css, /--module-library-tab-height:\s*58px/);
  assert.match(css, /--module-library-tab-font-size:\s*12px/);
  assert.match(css, /#tangguanView \.tg-workspace\.tg-library-is-collapsed[\s\S]*grid-template-columns: var\(--module-library-rail-width\)/);
  assert.match(css, /#createView \.create-library-head > div[\s\S]*flex-direction: column/);
  assert.match(css, /#createView \.create-library-head small[\s\S]*display: block/);
  assert.match(css, /#createView\.create-library-is-collapsed[\s\S]*grid-template-columns: var\(--module-library-rail-width\)/);
  assert.match(css, /@media \(max-width: 900px\)[\s\S]*\.tg-desktop-only \{ display: none; \}/);
  assert.match(css, /\.tg-library-collapsed-tab \{[\s\S]*writing-mode: vertical-rl[\s\S]*text-orientation: upright/);
});

test('Tangguan every legacy session entry stays in Tangguan and mounts an owned Chat Surface', () => {
  const view = read('src/renderer/views/tangguan/tangguan.js');
  assert.doesNotMatch(view, /App\.chat\.activate\(conv\.id\);/);
  assert.match(view, /App\.chat\.activate\(conv\.id, \{ stay: 'tangguan', persist: false, render: false \}\)/);
  assert.match(view, /mode: 'tangguan', owner: 'tangguan'/);
  assert.match(view, /App\.state\.activeId = conv\.id;/);
});

test('Chat navigation flushes drafts and keeps module conversations on their own provider', () => {
  const chat = read('src/renderer/views/chat/chat.js');
  const router = read('src/renderer/router.js');
  assert.match(chat, /flushSurface\(\)/);
  assert.match(chat, /providerForConversation\(conv\)/);
  assert.match(chat, /function ownerForConversation\(conv\)/);
  assert.match(chat, /return App\.getProvider\(owner === 'tangguan' \|\| owner === 'create' \? owner : 'chat'\)/);
  assert.match(router, /skipDraftFlush !== true/);
  assert.match(chat, /flushDraft\(\{ conversationId: App\.state && App\.state\.activeId \}\)/);
});

test('Tangguan character cards and Chat history use bounded local rendering windows', () => {
  const tangguan = read('src/renderer/views/tangguan/tangguan.js');
  const chat = read('src/renderer/views/chat/chat.js');
  assert.match(tangguan, /let characterVisibleCount = 50;/);
  assert.match(tangguan, /items\.slice\(0, characterVisibleCount\)/);
  assert.match(tangguan, /data-tg-character-more/);
  assert.match(chat, /let messageVisibleCount = 100;/);
  assert.match(chat, /conv\.messages\.slice\(start\)/);
  assert.match(chat, /messageVisibleCount \+= 50/);
});

test('Chat Surface and create sessions keep task conversations inside Tangchuang', () => {
  const chat = read('src/renderer/views/chat/chat.js');
  const create = read('src/renderer/views/workflows/create.js');
  const router = read('src/renderer/router.js');
  assert.match(chat, /function isCreateConversation\(conv\)/);
  assert.match(chat, /opts\.originModule[\s\S]{0,120}conv\.originModule = String\(opts\.originModule\)/);
  assert.match(chat, /if \(opts\.stay === 'create'\)[\s\S]{0,220}App\.router\.go\('create'(?:,\s*\{[^}]*\})?\)/);
  assert.match(chat, /const owner = opts\.owner \|\| \(opts\.originModule === 'tangguan'/);
  assert.match(create, /createTaskDrawer/);
  assert.match(create, /App\.chat\.mountSurface\(\{[\s\S]{0,180}owner: 'create'/);
  assert.match(chat, /startWithAgent\(agent\) \{[\s\S]{0,120}newConversation\(agent, \{ owner: 'create', stay: 'create', originModule: 'create' \}\)/);
  assert.match(create, /App\.chat\.newConversation\(null, \{ stay: 'create', originModule: 'create' \}\)/);
  assert.match(create, /data-create-task-close/);
  assert.match(router, /const isModuleConversation =/);
  assert.match(router, /surface\.owner !== module/);
});

test('Tangchuang catalog modes keep the shared library head after removing templates', () => {
  const create = read('src/renderer/views/workflows/create.js');
  assert.match(create, /createLibraryMarkup\(content, options\)/);
  assert.match(create, /wrapCreateGenericLibrary\(root, options\)/);
  assert.match(create, /tabs: false/);
  assert.match(create, /wrapCreateGenericLibrary\(c, \{ title: '\\u5de5\\u4f5c\\u6d41'/);
  assert.match(create, /data-create-library-expand/);
  assert.match(create, /data-tab=\"workflows\"/);
  assert.doesNotMatch(create, /data-tab=\"templates\"|renderTemplates|useTemplate|openTemplateForm|tplGrid|tplModalMask/);
});

test('Module session actions delete instead of toggling legacy archived state', () => {
  const create = read('src/renderer/views/workflows/create.js');
  const tangguan = read('src/renderer/views/tangguan/tangguan.js');
  assert.match(create, /deleteCreateSession/);
  assert.match(create, /data-create-session-delete/);
  assert.match(tangguan, /deleteSession/);
  assert.match(tangguan, /data-tg-session-delete/);
  assert.doesNotMatch(create, /toggleCreateSessionArchive/);
  assert.doesNotMatch(tangguan, /toggleSessionArchive/);
});

test('普通 UI uses the unified font token while code remains monospace', () => {
  const css = read('styles.css');
  const main = read('src/main/main.js');
  const modules = read('src/renderer/components/modules.js');
  assert.match(css, /--font-ui:/);
  assert.match(css, /body \{[\s\S]*font-family: var\(--font-ui\)/);
  assert.match(css, /--font-mono:/);
  assert.match(css, /\.agent-answer code[\s\S]*font-family: var\(--font-mono\)/);
  assert.doesNotMatch(css, /\.suggest-skill \.suggest-title code[\s\S]*Microsoft YaHei/);
  assert.match(main, /font-family:-apple-system,BlinkMacSystemFont/);
  assert.match(modules, /font-family:-apple-system,BlinkMacSystemFont/);
});

test('Tangguan empty state keeps only character actions and no module introduction block', () => {
  const view = read('src/renderer/views/tangguan/tangguan.js');
  const start = view.indexOf('function renderWelcome(');
  const end = view.indexOf('function switchDrawer(', start);
  const emptyState = view.slice(start, end);
  assert.match(emptyState, /从一个角色开始/);
  assert.match(emptyState, /data-tg-open-editor/);
  assert.match(emptyState, /data-tg-import/);
  assert.doesNotMatch(emptyState, /糖馆用于角色卡与沉浸式角色会话/);
});

test('糖读切换文档后重建当前大纲，不保留上一份文档的标题', () => {
  const doc = read('src/renderer/views/documents/doc.js');
  const switchStart = doc.indexOf('switchDoc(id) {');
  const showStart = doc.indexOf('showDoc(d) {');
  const outlineStart = doc.indexOf('renderOutline() {');
  assert.ok(switchStart >= 0);
  assert.ok(showStart > switchStart);
  assert.ok(outlineStart > showStart);
  assert.match(doc.slice(switchStart, showStart), /App\.doc\.activeId = id;[\s\S]*App\.doc\.render\(\);[\s\S]*App\.doc\.openDrawer\(\);/);
  assert.match(doc.slice(showStart, outlineStart), /App\.doc\.activeDoc\(\)|App\.doc\.renderOutline\(\);/);
  assert.match(doc.slice(outlineStart, outlineStart + 600), /const d = App\.doc\.activeDoc\(\);/);
  assert.match(doc, /box\.innerHTML = '<div class="doc-outline-title">大纲<\/div>'/);
});
