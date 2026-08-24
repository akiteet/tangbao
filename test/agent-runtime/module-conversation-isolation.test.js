'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { readComponentsSource } = require('./source-helper');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const ModuleSessions = require('../../src/infrastructure/storage/module-sessions');
const Gateway = require('../../src/infrastructure/model-gateway/gateway');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('gateway normalizes legacy module request kinds', () => {
  assert.equal(Gateway.normalizeKind('tavern'), 'chat');
  assert.equal(Gateway.normalizeKind('create'), 'chat');
  assert.equal(Gateway.normalizeKind('workflow'), 'chat');
  assert.equal(Gateway.normalizeKind({ type: 'create' }), 'chat');
  assert.equal(Gateway.normalizeKind({ requestType: 'tavern' }), 'chat');
  assert.equal(Gateway.normalizeKind('images'), 'images');
});

test('renderer gateway boundary strips module-only fields before transport', async () => {
  const app = { services: { float: { onInit() {} } } };
  let request = null;
  const context = {
    window: { App: app },
    App: app,
    location: { origin: 'http://127.0.0.1:1234', port: '1234' },
    console,
    fetch: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true };
    },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(read('src/renderer/runtime.js'), context, { filename: 'runtime.js' });
  await context.App.rt.gatewayFetch({
    ref: 'acc:test',
    type: 'create',
    payload: { model: 'test-model', web: false, allowTools: false, tools: [] },
  });
  assert.equal(request.kind, 'chat');
  assert.equal(Object.prototype.hasOwnProperty.call(request.payload, 'web'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(request.payload, 'allowTools'), false);
  assert.deepEqual(request.payload.tools, []);
});

test('renderer gateway boundary strips nested module-only fields', async () => {
  const app = { services: { float: { onInit() {} } } };
  let request = null;
  const context = {
    window: { App: app },
    App: app,
    location: { origin: 'http://127.0.0.1:1234', port: '1234' },
    console,
    fetch: async (_url, options) => {
      request = JSON.parse(options.body);
      return { ok: true };
    },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(read('src/renderer/runtime.js'), context, { filename: 'runtime.js' });
  await context.App.rt.gatewayFetch({
    ref: 'acc:test',
    kind: 'tavern',
    payload: {
      model: 'test-model',
      extra_body: { web: false, requestKind: 'tavern', keep: true },
      messages: [{ role: 'user', content: { text: 'hello', allowTools: false } }],
    },
  });
  assert.equal(request.kind, 'chat');
  assert.deepEqual(request.payload.extra_body, { keep: true });
  assert.deepEqual(request.payload.messages[0].content, { text: 'hello' });
});

test('gateway outbound payload strips module policy fields before reaching a provider', async () => {
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}');
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'web'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'allowTools'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(payload, 'providerModule'), false);
      assert.deepEqual(payload.tools, []);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }));
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = http.createServer((req, res) => Gateway.handleGateway(req, res));
  const proxyPort = await listen(proxy);
  Gateway.setEndpoints([{ ref: 'module-outbound', apiBase: `http://127.0.0.1:${upstreamPort}` }]);
  Gateway.configure({ getSecret: () => 'module-key', recordModelCallMetric: null });
  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ref: 'module-outbound',
        kind: 'create',
        payload: { model: 'mock-model', messages: [{ role: 'user', content: 'hello' }], stream: false, web: false, allowTools: false, providerModule: 'create', tools: [] },
      }),
    });
    assert.equal(response.status, 200);
  } finally {
    Gateway.configure({ getSecret: () => '', recordModelCallMetric: null });
    await close(proxy);
    await close(upstream);
  }
});

test('gateway sanitizer removes nested policy fields before adapter dispatch', () => {
  const clean = Gateway.sanitizeProviderPayload({
    web: false,
    nested: { allowTools: false, keep: 'yes' },
    list: [{ providerModule: 'create', keep: 1 }],
  });
  assert.deepEqual(clean, { nested: { keep: 'yes' }, list: [{ keep: 1 }] });
});

test('legacy module conversations stay out of regular state after sidecar migration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-module-isolation-'));
  try {
    const store = ModuleSessions.createStore({ rootDir: dir });
    const state = {
      conversations: [
        { id: 'chat-1', title: 'Regular', messages: [], updatedAt: 1 },
        { id: 'tg-1', title: 'Role', tavernCharacterId: 'role-1', messages: [], updatedAt: 2 },
        { id: 'create-1', title: 'Task', originModule: 'create', messages: [], updatedAt: 3 },
      ],
      activeId: 'tg-1',
    };
    const result = store.migrateLegacy(state);
    assert.equal(result.ok, true);
    assert.deepEqual(result.state.conversations.map((item) => item.id), ['chat-1']);
    assert.deepEqual(store.read('tavern').data.conversations.map((item) => item.id), ['tg-1']);
    assert.deepEqual(store.read('create').data.conversations.map((item) => item.id), ['create-1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Tavern origin marker is migrated into the isolated sidecar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-tavern-marker-'));
  try {
    const store = ModuleSessions.createStore({ rootDir: dir });
    const result = store.migrateLegacy({
      conversations: [{ id: 'tg-origin', originModule: 'tavern', messages: [], updatedAt: 1 }],
      activeId: 'tg-origin',
    });
    assert.equal(result.ok, true);
    assert.equal(result.state.conversations.length, 0);
    assert.equal(store.read('tavern').data.conversations[0].id, 'tg-origin');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed migration still partitions module records in renderer memory', () => {
  const app = read('src/renderer/app.js');
  assert.match(app, /function splitLegacyModuleSessions\(conversations\)/);
  assert.match(app, /App\.state\.conversations = split\.normal/);
  assert.match(app, /safeState\.conversations = split\.normal/);
  assert.match(app, /App\.moduleSessions\.status = 'failed'/);
});

test('regular Chat UI filters module sessions on every route', () => {
  const ui = readComponentsSource();
  const sidebar = ui.slice(ui.indexOf('renderSidebar()'), ui.indexOf('renderTopbarTitle()'));
  assert.match(sidebar, /App\.state\.conversations\.filter\(\(item\) => !moduleConversation\(item\)\)/);
  assert.doesNotMatch(sidebar, /App\.state\.view === 'chat'\s*\?/);
  const palette = ui.slice(ui.indexOf('async renderCommandPalette'), ui.indexOf('runCommand(id)'));
  assert.match(palette, /regularConversations/);
});

test('Tavern provider selector supports legacy single-model accounts', () => {
  const ui = readComponentsSource();
  assert.match(ui, /function accountModelNames\(account\)/);
  assert.match(ui, /account\.model \? \[account\.model\] : \[\]/);
  assert.match(ui, /modelNames = accountModelNames\(account\)/);
  assert.match(ui, /const names = accountModelNames\(selected\)/);
});

test('Tangchuang library keeps only preset/session navigation and sidecar session actions', () => {
  const create = read('src/renderer/views/workflows/create.js');
  assert.match(create, /create-library-head/);
  assert.match(create, /create-library-tabs/);
  assert.match(create, /data-create-library-tab/);
  assert.match(create, /data-create-library-toggle/);
  assert.match(create, /data-create-library-expand/);
  assert.match(create, /create-library-is-collapsed/);
  assert.doesNotMatch(create, /data-cat/);
  assert.doesNotMatch(create, /data-tag/);
  assert.doesNotMatch(create, /id="createSort"/);
  assert.match(create, /App\.chat\.conversationList\('create'\)/);
  assert.match(create, /App\.chat\.activate\(id, \{ owner: 'create'/);
  assert.match(create, /App\.chat\.persistConversation\(conv\)/);
  assert.match(create, /data-create-session-rename/);
  assert.match(create, /data-create-session-delete/);
  assert.match(create, /deleteCreateSession/);
  assert.match(create, /window\.confirm/);
  assert.match(create, /data-create-session-clear/);
  assert.match(create, /data-create-session-export/);
  assert.match(create, /wrapCreateGenericLibrary/);
  assert.match(create, /title: '\\u5de5\\u4f5c\\u6d41'/);
  assert.doesNotMatch(create, /data-tab=\"templates\"|renderTemplates|useTemplate|openTemplateForm|tplGrid|tplModalMask/);
});

test('Tangchuang new sessions inherit a live agent configuration without messages', () => {
  const chat = read('src/renderer/views/chat/chat.js');
  const create = read('src/renderer/views/workflows/create.js');
  assert.match(create, /inheritActive: true/);
  assert.match(create, /getAgent\(id\)/);
  assert.match(chat, /const inheritedAgent = owner === 'create'/);
  assert.match(chat, /opts\.inheritActive !== false/);
  assert.match(chat, /App\.create\.getAgent\(previous\.agentId\)/);
  assert.match(chat, /const configSource = agent \|\| \(inheritedAgent \? previous : null\)/);
  assert.match(chat, /messages: \[\]/);
  assert.doesNotMatch(chat, /inheritedAgent[\s\S]{0,500}\.messages/);
});

test('module headers use the shared model selector while accounts stay in settings', () => {
  const create = read('src/renderer/views/workflows/create.js');
  const tavern = read('src/renderer/views/tavern/tavern.js');
  const ui = readComponentsSource();
  assert.doesNotMatch(create, /moduleProviderMarkup\('create'\)/);
  assert.doesNotMatch(tavern, /moduleProviderMarkup\('tavern'\)/);
  assert.match(ui, /function currentModelModule\(\)/);
  assert.match(ui, /const p = App\.getProvider\(module\)/);
  assert.match(ui, /const conversationModel = conv && conv\.model && models\.includes\(conv\.model\)/);
  assert.match(ui, /providers\[module\]/);
  assert.match(ui, /apiModuleSel/);
});

test('module conversations are removed from regular state on sidecar write', () => {
  const chat = read('src/renderer/views/chat/chat.js');
  assert.match(chat, /A module conversation belongs to its sidecar/);
  assert.match(chat, /App\.state\.conversations = App\.state\.conversations\.filter/);
  assert.match(chat, /isModuleConversation\(item\)/);
});

test('module session deletion confirms, removes from the sidecar, and preserves empty-state support', () => {
  const chat = read('src/renderer/views/chat/chat.js');
  const tavern = read('src/renderer/views/tavern/tavern.js');
  const create = read('src/renderer/views/workflows/create.js');
  assert.match(chat, /deleteConversation\(id, options\)/);
  assert.match(chat, /removeModuleConversation\(owner, target\)/);
  assert.match(chat, /setActiveConversationId\(owner, result\.activeId \|\| null\)/);
  assert.match(tavern, /data-tg-session-delete/);
  assert.match(tavern, /App\.chat\.deleteConversation\(conv\.id, \{ owner: 'tavern' \}\)/);
  assert.match(tavern, /setUiPointer\(selected && selected\.id/);
  assert.match(create, /data-create-session-delete/);
  assert.match(create, /App\.chat\.deleteConversation\(conv\.id, \{ owner: 'create' \}\)/);
  assert.match(create, /taskSessionConversationId = result && result\.activeId/);
});

test('Tangchuang keeps the create entry first and available when search has no matches', () => {
  const create = read('src/renderer/views/workflows/create.js');
  assert.match(create, /const renderCreateGrid = App\.create\.renderGrid/);
  assert.match(create, /grid\.insertBefore\(add, grid\.firstElementChild\)/);
  assert.match(create, /if \(!add\)[\s\S]*grid\.innerHTML = ''/);
});
