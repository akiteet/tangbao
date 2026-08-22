'use strict';

const fs = require('node:fs');
const { readRuntimeSource, readRendererSource, readMainSource } = require('./source-helper');
const path = require('node:path');
const { readComponentsSource } = require('./source-helper');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('state loading rejects malformed snapshots and recovers missing account fields from a fallback', () => {
  const state = read('src/renderer/state/state.js');
  assert.match(state, /function parseStateCandidate\(raw, oldFormat\)/);
  assert.match(state, /function stateNeedsRecovery\(value(?:, opts)?\)/);
  assert.match(state, /function mergeMissingState\(primary, fallback\)/);
  assert.match(state, /if \(primary\.oldFormat \|\| recovered\) App\.persist\(\)/);
  assert.match(state, /App\.state = ns;\s*if \(opts\.persist === true\) App\.persist\(\)/);
});

test('float sync is a conversation patch and cannot overwrite main-window settings', () => {
  const app = read('src/renderer/app.js');
  const main = readMainSource();
  assert.match(app, /type: 'patch'/);
  assert.match(app, /function mergeFloatConversations\(current, incoming\)/);
  assert.match(app, /Number\(next && next\.updatedAt\)/);
  assert.doesNotMatch(app, /settings: App\.state\.settings/);
  assert.match(main, /safeOn\('float:pushState'/);
  assert.match(main, /safeOn\('float:sync'/);
  assert.match(main, /Array\.isArray\(s\.conversations\)/);
});

test('state writes are atomic and stale revisions are ignored', () => {
  const main = readMainSource();
  const preload = read('src/preload/preload.js');
  assert.match(main, /function acceptStateRevision\(payload, explicitRevision\)/);
  assert.match(main, /function writeStateFileAtomic\(file, content\)/);
  assert.match(main, /reason: 'stale_state_revision'/);
  assert.match(main, /writeStateFileAtomic\(file, jsonStr\)/);
  assert.match(preload, /saveStateJSON: \(jsonStr, revision\)/);
  assert.match(preload, /syncStorage: \(json, revision\)/);
  assert.match(preload, /flushStorageSync: \(json, revision\)/);
});

test('chat partial 只允许恢复 assistant，并可补回尚未进入完整快照的消息', () => {
  const main = readMainSource();
  const state = read('src/renderer/state/state.js');
  assert.match(main, /const chatPartialRoot = \(\) => path\.join\(dataLocation\.recordsRoot\(app\.getPath\('userData'\)\), 'chat-partials'\)/);
  assert.match(main, /const mergePartialMessage = \(target, incoming, messageId\)/);
  assert.match(main, /if \(target && target\.role !== 'assistant'\) return null/);
  assert.match(main, /if \(!message\) conversation\.messages\.push\(restored\)/);
  assert.match(main, /if \(incomingMessage\.role && String\(incomingMessage\.role\) !== 'assistant'\)/);
  assert.match(state, /role: 'assistant',\s*content: String\(message\.content \|\| ''\)/);
});

test('account model rows keep a visible model name column and scroll instead of collapsing', () => {
  const html = read('index.html');
  const styles = read('styles.css');
  assert.match(html, /class="h-output">/);
  assert.match(styles, /\.model-row, \.model-row-head \{[^}]*display:\s*grid/);
  assert.match(styles, /grid-template-columns:\s*16px minmax\(190px, 1fr\) 88px 88px 124px 110px 56px 30px/);
  assert.match(styles, /\.model-row \.accModelRow \{[^}]*min-width:\s*150px/);
  assert.match(styles, /\.model-row \.accModelOutput \{[^}]*width:\s*88px[^}]*flex:\s*none/);
  assert.match(styles, /#accountModal \.account-form \{[^}]*overflow-x:\s*auto/);
  assert.match(styles, /#accountModal \.modal \{\s*width:\s*min\(1120px, 96vw\);\s*max-width:\s*96vw/);
});

test('incomplete disk state keeps accounts from the complete SQLite fallback', async () => {
  const source = read('src/renderer/state/state.js');
  const saved = [];
  const storage = new Map();
  const context = {
    console,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    App: {
      services: {
        fs: {
          loadStateJSON: async () => ({ ok: true, data: JSON.stringify({ conversations: [], settings: { profile: { name: 'partial' } } }) }),
          loadStorage: async () => ({ ok: true, state: {
            conversations: [],
            settings: {
              accounts: [{ id: 'acc-preserved', name: 'Preserved', apiBase: 'https://example.test', models: ['demo'] }],
              providers: { default: { accountId: 'acc-preserved', apiBase: '', model: 'demo' } },
            },
          } }),
          saveStateJSON: (json) => { saved.push(JSON.parse(json)); return { ok: true }; },
        },
      },
      rt: { syncEndpoints: () => {} },
    },
    window: null,
    addEventListener: () => {},
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'state.js' });
  const result = await context.App.loadState();
  assert.equal(result.ok, true);
  assert.equal(context.App.state.settings.accounts[0].id, 'acc-preserved');
  assert.ok(saved.some((snapshot) => snapshot.settings.accounts.some((account) => account.id === 'acc-preserved')));
});

test('persistence failures remain observable instead of being reported as saved', async () => {
  const state = read('src/renderer/state/state.js');
  const notifications = [];
  const context = {
    console,
    setTimeout,
    clearTimeout,
    localStorage: {
      setItem: () => {},
      getItem: () => null,
      removeItem: () => {},
    },
    App: {
      services: {
        fs: {
          saveStateJSON: () => Promise.resolve({ ok: false, code: 'state_file_write_failed' }),
        },
      },
      ui: { notify: (title, detail) => notifications.push({ title, detail }) },
      rt: {},
    },
    window: null,
    addEventListener: () => {},
  };
  context.window = context;
  vm.runInNewContext(state, context, { filename: 'state.js' });
  const result = context.App.persist();
  assert.equal(result.ok, true);
  await context.App.__persistencePromise;
  assert.equal(context.App.__persistence.status, 'failed');
  assert.equal(context.App.__persistence.code, 'state_file_write_failed');
  assert.equal(notifications.length, 1);
});

test('account recovery snapshots restore metadata and streaming output survives reload normalization', async () => {
  const state = read('src/renderer/state/state.js');
  const recovery = {
    conversations: [],
    settings: {
      accounts: [{ id: 'acc-recovered', name: 'Recovered', apiBase: 'https://example.test', models: ['demo'] }],
      defaultAccountId: 'acc-recovered',
      providers: { agent: { accountId: 'acc-recovered', model: 'demo' } },
    },
  };
  const disk = {
    conversations: [],
    settings: {
      accounts: [],
      defaultAccountId: 'acc-recovered',
      providers: { agent: { accountId: 'acc-recovered', model: 'demo' } },
    },
    agentThreads: [{ id: 'thread-live', title: 'Live', history: [], _liveAnswer: 'partial answer', _liveEvents: [{ type: 'thinking', text: 'working' }], _pendingUser: { content: 'continue', skills: [] }, _running: true }],
  };
  const values = new Map([['tangbao_account_recovery_v1', JSON.stringify(recovery)]]);
  const context = {
    console,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: (key) => values.get(key) || null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    },
    App: {
      services: {
        fs: {
          loadStateJSON: async () => ({ ok: true, data: JSON.stringify(disk) }),
          loadStorage: async () => ({ ok: false }),
          saveStateJSON: () => ({ ok: true }),
        },
      },
      rt: {},
    },
    window: null,
    addEventListener: () => {},
  };
  context.window = context;
  vm.runInNewContext(state, context, { filename: 'state.js' });
  const result = await context.App.loadState();
  assert.equal(result.ok, true);
  assert.equal(context.App.state.settings.accounts[0].id, 'acc-recovered');
  assert.equal(context.App.state.agentThreads[0]._liveAnswer, 'partial answer');
  assert.equal(context.App.state.agentThreads[0]._liveEvents[0].type, 'thinking');
  assert.equal(context.App.state.agentThreads[0]._pendingUser.content, 'continue');
});

test('a fresh empty account state is not reported as an incomplete recovery', async () => {
  const state = read('src/renderer/state/state.js');
  const disk = JSON.stringify({
    conversations: [],
    settings: {
      accounts: [],
      defaultAccountId: '',
      providers: { default: { accountId: '__default__', apiBase: '', model: '' } },
    },
  });
  const context = {
    console,
    setTimeout,
    clearTimeout,
    localStorage: {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
    },
    App: {
      services: {
        fs: {
          loadStateJSON: async () => ({ ok: true, data: disk }),
          loadStorage: async () => ({ ok: false }),
          saveStateJSON: () => ({ ok: true }),
        },
      },
      rt: {},
    },
    window: null,
    addEventListener: () => {},
  };
  context.window = context;
  vm.runInNewContext(state, context, { filename: 'state.js' });
  const result = await context.App.loadState();
  assert.equal(result.ok, true);
  assert.equal(result.recovered, false);
  assert.equal(context.App.__stateRecovery, null);
});

test('legacy snapshots append Tangguan without changing existing module order', () => {
  const state = read('src/renderer/state/state.js');
  const context = {
    console,
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    App: { services: {}, rt: {} },
    window: null,
    addEventListener: () => {},
  };
  context.window = context;
  vm.runInNewContext(state, context, { filename: 'state.js' });
  const result = context.App.loadStateFromRaw(JSON.stringify({
    conversations: [],
    settings: {
      accounts: [],
      defaultAccountId: '',
      providers: { default: { accountId: '__default__' } },
      enabledModules: ['chat', 'agent'],
    },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(context.App.state.settings.enabledModules), ['chat', 'agent', 'tangguan']);
});

test('account mutations persist metadata before touching secrets and restore on either failure', () => {
  const ui = readComponentsSource();
  const saveStart = ui.indexOf('async saveAccount()');
  const savePersist = ui.indexOf('const persisted = await persistAndVerify();', saveStart);
  const saveSecret = ui.indexOf("await App.rt.setSecret('acc:' + accId, apiKey)", saveStart);
  const deleteStart = ui.indexOf('async deleteAccount(id)');
  const deletePersist = ui.indexOf('const persisted = await persistAndVerify();', deleteStart);
  const deleteSecret = ui.indexOf("await App.rt.deleteSecret('acc:' + id)", deleteStart);
  assert.ok(saveStart >= 0 && savePersist > saveStart && saveSecret > savePersist, '编辑账户先落盘再写密钥');
  assert.ok(deleteStart >= 0 && deletePersist > deleteStart && deleteSecret > deletePersist, '删除账户先落盘再删密钥');
  assert.match(ui.slice(saveStart, saveSecret), /const restore = async \(\)/);
  assert.match(ui.slice(saveSecret, deleteStart), /const restored = await restore\(\)/);
  assert.match(ui.slice(deleteSecret), /const restored = await restore\(\)/);
});
