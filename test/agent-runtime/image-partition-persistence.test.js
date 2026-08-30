'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const { SCHEMA_VERSION, MIGRATIONS } = require('../../src/core/schemas/db-schema');

/** 在受控 vm 上下文中加载 state.js（与 state-float-safety 同款骨架） */
function loadStateModule(diskState) {
  const context = {
    console,
    setTimeout,
    clearTimeout,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    App: {
      services: {
        fs: {
          loadStateJSON: async () => ({ ok: true, data: JSON.stringify(diskState) }),
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
  vm.runInNewContext(read('src/renderer/state/state.js'), context, { filename: 'state.js' });
  return context;
}

test('v1.1.8 生图分区标记 imageModel 跨重启往返（纯标记，无协议/尺寸配置）', async () => {
  const disk = {
    conversations: [],
    settings: {
      accounts: [{
        id: 'acc-img',
        name: 'Image Account',
        apiBase: 'https://example.test',
        models: [
          { name: 'doubao-seed-4', contextWindow: 128000, thinkType: 'auto' },
          // 用户切生图后保持默认选项时落盘只有这一个标记（bug 复现的最小状态）
          { name: 'dall-e-3', contextWindow: 128000, imageModel: true },
        ],
      }],
      defaultAccountId: 'acc-img',
    },
  };
  const context = loadStateModule(disk);
  const result = await context.App.loadState();
  assert.equal(result.ok, true);
  const models = context.App.state.settings.accounts[0].models;
  const text = models.find((m) => m.name === 'doubao-seed-4');
  const image = models.find((m) => m.name === 'dall-e-3');
  assert.equal(image.imageModel, true, 'imageModel 标记在归一化后必须保留');
  assert.notEqual(text.imageModel, true, '文本模型不得被误标为生图');
  // 归一化产物再次序列化（persist）后仍带标记——修复前这里会被剥成无标记
  const reparsed = JSON.parse(JSON.stringify(models));
  assert.equal(reparsed.find((m) => m.name === 'dall-e-3').imageModel, true);
});

test('v1.1.8 生图模型的协议/策略/尺寸配置归一化后同样保留', async () => {
  const disk = {
    conversations: [],
    settings: {
      accounts: [{
        id: 'acc-img-full',
        name: 'Full Image',
        apiBase: 'https://example.test',
        models: [{ name: 'flux-pro', contextWindow: 32000, imageModel: true, imageProtocol: 'http', imageSizeStrategy: 'fixed', imageSizeFormat: 'png', imageSizes: ['1024x1024', '512x512'] }],
      }],
      defaultAccountId: 'acc-img-full',
    },
  };
  const context = loadStateModule(disk);
  await context.App.loadState();
  const m = context.App.state.settings.accounts[0].models[0];
  assert.equal(m.imageModel, true);
  assert.equal(m.imageProtocol, 'http');
  assert.equal(m.imageSizeStrategy, 'fixed');
  assert.equal(m.imageSizeFormat, 'png');
  assert.deepEqual(Array.from(m.imageSizes), ['1024x1024', '512x512']);
});

test('Schema v17 adds image partition columns to account_models', () => {
  assert.equal(SCHEMA_VERSION, 18);
  const executed = [];
  const names = new Set(['account_id', 'name', 'context_window', 'caps']);
  const db = {
    prepare(statement) {
      assert.match(statement, /table_info\(account_models\)/);
      return { all: () => Array.from(names).map((name) => ({ name })) };
    },
    exec(statement) {
      executed.push(statement);
      const added = statement.match(/ADD COLUMN (\w+)/);
      if (added) names.add(added[1]);
    },
  };
  MIGRATIONS[16](db);
  assert.ok(executed.some((sql) => /ADD COLUMN image_model INTEGER NOT NULL DEFAULT 0/.test(sql)));
  assert.ok(executed.some((sql) => /ADD COLUMN image_extra TEXT/.test(sql)));
});

test('Schema v17 migration is idempotent when image columns already exist', () => {
  const db = {
    prepare() { return { all: () => [{ name: 'image_model' }, { name: 'image_extra' }] }; },
    exec() { throw new Error('must not ALTER TABLE when columns already exist'); },
  };
  MIGRATIONS[16](db);
});

test('SQLite 镜像完整承载图像分区字段（setAccountModels → getAccountModels → readState 往返）', (t) => {
  const storage = require('../../src/infrastructure/storage/sqlite-store');
  let Database = null;
  try { Database = require('better-sqlite3'); } catch (_) {}
  const migrator = require('../../src/infrastructure/storage/migrator');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-image-partition-'));
  const dbPath = path.join(dir, 'tangbao.sqlite');
  try {
    if (!storage.init(dbPath)) { t.skip('better-sqlite3 native module is unavailable for this Node runtime'); return; }
    // readState 对"无会话且无 kv"的库返回 { ok:false, reason:'empty' }，先放一条会话过守卫
    storage.StorageService.upsertConversation({ id: 'conv-img', title: 'Image RT', createdAt: 1, updatedAt: 2 });
    storage.StorageService.upsertAccount({ id: 'acc-roundtrip', name: 'RT', apiBase: 'https://example.test' });
    storage.StorageService.setAccountModels('acc-roundtrip', [
      { name: 'gpt-text', contextWindow: 128000, maxOutput: 8192, caps: 'tool_vision', thinkType: 'auto' },
      { name: 'seedream', contextWindow: 32000, imageModel: true, imageProtocol: 'http', imageSizeStrategy: 'fixed', imageSizes: ['1024x1024'] },
      { name: 'plain-image', contextWindow: 128000, imageModel: true },
      // 旧格式兼容：string 模型不炸
      'legacy-string-model',
    ]);

    const rows = storage.StorageService.getAccountModels('acc-roundtrip');
    const seedRow = rows.find((r) => r.name === 'seedream');
    const plainRow = rows.find((r) => r.name === 'plain-image');
    const textRow = rows.find((r) => r.name === 'gpt-text');
    assert.equal(seedRow.image_model, 1);
    const seedExtra = JSON.parse(seedRow.image_extra);
    assert.equal(seedExtra.imageProtocol, 'http');
    assert.equal(seedExtra.imageSizeStrategy, 'fixed');
    assert.deepEqual(seedExtra.imageSizes, ['1024x1024']);
    assert.equal(plainRow.image_model, 1);
    assert.equal(plainRow.image_extra, null);
    assert.equal(textRow.image_model, 0);

    // readState 读回：图像字段完整还原进 settings.accounts[].models（返回包裹在 { ok, state } 内）
    const result = migrator.readState(storage.StorageService, null);
    assert.equal(result.ok, true);
    const state = result.state;
    const account = ((state.settings || {}).accounts || []).find((a) => a.id === 'acc-roundtrip');
    assert.ok(account, 'readState 必须还原账户');
    const models = account.models;
    const seed = models.find((m) => m.name === 'seedream');
    const plain = models.find((m) => m.name === 'plain-image');
    const text = models.find((m) => m.name === 'gpt-text');
    assert.equal(seed.imageModel, true);
    assert.equal(seed.imageProtocol, 'http');
    assert.equal(seed.imageSizeStrategy, 'fixed');
    assert.deepEqual(seed.imageSizes, ['1024x1024']);
    assert.equal(plain.imageModel, true);
    assert.notEqual(plain.imageProtocol, 'http');
    assert.equal(text.imageModel, undefined);
    assert.equal(text.thinkType, 'auto');
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
