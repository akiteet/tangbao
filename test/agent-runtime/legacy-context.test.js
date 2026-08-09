'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { adoptLegacyContext } = require('../../src/infrastructure/secrets/legacy-context');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-secret-context-'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), 'utf8');
}

test('legacy secret context is adopted only when active and legacy ciphertext match', () => {
  const root = tempRoot();
  try {
    const legacy = path.join(root, 'legacy');
    const active = path.join(root, 'active');
    const oldKey = 'old-encrypted-key';
    const newKey = 'new-encrypted-key';
    const ciphertext = JSON.stringify({ v: 1, enc: true, data: 'same-ciphertext' });
    writeJson(path.join(legacy, 'Local State'), { os_crypt: { encrypted_key: oldKey } });
    writeJson(path.join(active, 'Local State'), { os_crypt: { encrypted_key: newKey, keep: true } });
    fs.mkdirSync(path.join(legacy, 'tangbao-data.backup'), { recursive: true });
    fs.mkdirSync(path.join(active, 'tangbao-data'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'tangbao-data.backup', 'secrets.json'), ciphertext, 'utf8');
    fs.writeFileSync(path.join(active, 'tangbao-data', 'secrets.json'), ciphertext, 'utf8');
    const before = fs.readFileSync(path.join(active, 'Local State'));

    const result = adoptLegacyContext({ activeRoot: active, legacyRoot: legacy });
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(active, 'Local State'), 'utf8')).os_crypt.encrypted_key, oldKey);
    assert.equal(JSON.parse(fs.readFileSync(path.join(active, 'Local State'), 'utf8')).os_crypt.keep, true);
    assert.deepEqual(fs.readFileSync(path.join(active, result.backupFile)), before);
    assert.equal(adoptLegacyContext({ activeRoot: active, legacyRoot: legacy }).changed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy secret context is not adopted when ciphertext differs', () => {
  const root = tempRoot();
  try {
    const legacy = path.join(root, 'legacy');
    const active = path.join(root, 'active');
    writeJson(path.join(legacy, 'Local State'), { os_crypt: { encrypted_key: 'old' } });
    writeJson(path.join(active, 'Local State'), { os_crypt: { encrypted_key: 'new' } });
    fs.mkdirSync(path.join(legacy, 'tangbao-data.backup'), { recursive: true });
    fs.mkdirSync(path.join(active, 'tangbao-data'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'tangbao-data.backup', 'secrets.json'), 'old', 'utf8');
    fs.writeFileSync(path.join(active, 'tangbao-data', 'secrets.json'), 'new', 'utf8');

    const result = adoptLegacyContext({ activeRoot: active, legacyRoot: legacy });
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(active, 'Local State'), 'utf8')).os_crypt.encrypted_key, 'new');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
