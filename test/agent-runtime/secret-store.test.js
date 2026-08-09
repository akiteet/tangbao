'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../../src/infrastructure/secrets/kvstore');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-secret-store-'));
}

function safeStorage({ available = true, failDecrypt = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) {
      return Buffer.from('encrypted:' + value, 'utf8');
    },
    decryptString(buffer) {
      if (failDecrypt) throw new Error('DPAPI failure');
      const value = Buffer.from(buffer).toString('utf8');
      if (!value.startsWith('encrypted:')) throw new Error('invalid payload');
      return value.slice('encrypted:'.length);
    },
  };
}

function writeLegacyFile(filePath, value, encrypted = false) {
  const json = JSON.stringify(value);
  fs.writeFileSync(filePath, JSON.stringify({ v: 1, enc: encrypted, data: Buffer.from(json, 'utf8').toString('base64') }), 'utf8');
}

test('secret store promotes a legacy file and keeps references available', () => {
  const root = tempRoot();
  try {
    const active = path.join(root, 'active', 'tangbao-data', 'secrets.json');
    const legacy = path.join(root, 'legacy', 'secrets.json');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    writeLegacyFile(legacy, { 'acc:one': 'key-one' });

    const info = store.init({ filePath: active, legacyFilePaths: [legacy], safeStorage: safeStorage() });
    assert.equal(info.state, 'ready');
    assert.equal(info.source, 'active');
    assert.deepEqual(store.listRefs(), ['acc:one']);
    assert.equal(store.getSecret('acc:one'), 'key-one');
    assert.equal(JSON.parse(fs.readFileSync(active, 'utf8')).enc, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('secret store reports decrypt failure and never overwrites the unreadable file', () => {
  const root = tempRoot();
  try {
    const active = path.join(root, 'secrets.json');
    writeLegacyFile(active, { 'acc:one': 'key-one' }, true);
    const before = crypto.createHash('sha256').update(fs.readFileSync(active)).digest('hex');

    const info = store.init({ filePath: active, safeStorage: safeStorage({ failDecrypt: true }) });
    assert.equal(info.state, 'unavailable');
    assert.equal(info.code, 'secret_decrypt_failed');
    const result = store.setSecret('acc:two', 'key-two');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'secret_decrypt_failed');
    const after = crypto.createHash('sha256').update(fs.readFileSync(active)).digest('hex');
    assert.equal(after, before);
    assert.deepEqual(store.listRefs(), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('secret store reports unavailable system storage without replacing encrypted data', () => {
  const root = tempRoot();
  try {
    const active = path.join(root, 'secrets.json');
    writeLegacyFile(active, { 'acc:one': 'key-one' }, true);
    const before = fs.readFileSync(active, 'utf8');

    const info = store.init({ filePath: active, safeStorage: safeStorage({ available: false }) });
    assert.equal(info.state, 'unavailable');
    assert.equal(info.code, 'secret_decrypt_unavailable');
    assert.equal(store.deleteSecret('acc:one').ok, false);
    assert.equal(fs.readFileSync(active, 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('secret store can create a new encrypted file when no previous file exists', () => {
  const root = tempRoot();
  try {
    const active = path.join(root, 'secrets.json');
    assert.equal(store.init({ filePath: active, safeStorage: safeStorage() }).state, 'empty');
    const result = store.setSecret('acc:one', 'key-one');
    assert.equal(result.ok, true);
    assert.equal(store.getStatus().state, 'ready');
    assert.equal(JSON.parse(fs.readFileSync(active, 'utf8')).enc, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
