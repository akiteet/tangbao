'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readComponentsSource } = require('./source-helper');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('performance diagnostics stay bounded, disabled, and memory-only', () => {
  const source = read('src/renderer/perf.js');
  assert.match(source, /let enabled = false;/);
  assert.match(source, /const CAPACITY = 120;/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|fetch\s*\(|sendSync|App\.services/);
  assert.match(source, /samples\.splice\(0, samples\.length - CAPACITY\)/);
});

test('interactive slow paths expose timing contracts without recording user content', () => {
  const router = read('src/renderer/router.js');
  const app = read('src/renderer/app.js');
  const chat = read('src/renderer/views/chat/chat.js');
  const tavern = read('src/renderer/views/tavern/tavern.js');
  const ui = readComponentsSource();
  assert.match(router, /measure\('moduleSwitchMs'/);
  assert.match(app, /measure\('bootMs'/);
  assert.match(chat, /measure\('inputHandlerMs'/);
  assert.match(chat, /measure\('streamRenderMs'/);
  assert.match(tavern, /measure\('tavernRenderMs'/);
  assert.match(ui, /scheduleSidebarRender\(\)/);
  assert.doesNotMatch(chat, /measure\('(?:inputHandlerMs|streamRenderMs)'[^\n]*content/);
});

test('chat streaming reuses one text node and caches context-bar work', () => {
  const chat = read('src/renderer/views/chat/chat.js');
  assert.match(chat, /renderedStreamText\s*=\s*\{[^}]*contentNode/);
  assert.match(chat, /renderedStreamText\[textNodeKey\]\.nodeValue\s*=\s*value/);
  assert.doesNotMatch(chat, /node\.appendChild\(document\.createTextNode\(value\.slice\(previous\.length\)\)\)/);
  assert.match(chat, /let contextBarKey = ''/);
  assert.match(chat, /if \(nextKey === contextBarKey\) return/);
});

test('large local lists have bounded rendering and indexed search', () => {
  const ui = readComponentsSource();
  const tavern = read('src/renderer/views/tavern/tavern.js');
  assert.match(ui, /HISTORY_INITIAL_COUNT = 100/);
  assert.match(ui, /data-history-more/);
  assert.match(ui, /_conversationSearchCache: new Map\(\)/);
  assert.match(tavern, /characterSearchIndex = new Map/);
  assert.match(tavern, /characterMatches\(item, needle\)/);
  assert.match(tavern, /canReuseList/);
});
