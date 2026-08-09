'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const locations = require('../../src/infrastructure/storage/data-location');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-location-'));
}

test('data location migration copies records and skips browser caches', () => {
  const root = tempRoot();
  try {
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    fs.mkdirSync(path.join(source, 'tangbao-data', 'files', 'documents'), { recursive: true });
    fs.mkdirSync(path.join(source, 'Local Storage'), { recursive: true });
    fs.mkdirSync(path.join(source, 'Cache'), { recursive: true });
    fs.writeFileSync(path.join(source, 'tangbao-data', 'tangbao.db'), 'db');
    fs.writeFileSync(path.join(source, 'tangbao-data', 'files', 'documents', 'doc-1'), 'document');
    fs.writeFileSync(path.join(source, 'Local Storage', 'leveldb'), 'state');
    fs.writeFileSync(path.join(source, 'Cache', 'large-cache'), 'ignore');

    const result = locations.migrateRoot(source, target);
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(target, 'tangbao-data', 'tangbao.db'), 'utf8'), 'db');
    assert.equal(fs.readFileSync(path.join(target, 'tangbao-data', 'files', 'documents', 'doc-1'), 'utf8'), 'document');
    assert.equal(fs.readFileSync(path.join(target, 'Local Storage', 'leveldb'), 'utf8'), 'state');
    assert.equal(fs.existsSync(path.join(target, 'Cache')), false);

    fs.writeFileSync(path.join(target, 'tangbao-data', 'tangbao.db'), 'newer-target');
    assert.equal(locations.migrateRoot(source, target).ok, true);
    assert.equal(fs.readFileSync(path.join(target, 'tangbao-data', 'tangbao.db'), 'utf8'), 'newer-target');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('data location migration folds legacy root records into tangbao-data', () => {
  const root = tempRoot();
  try {
    const source = path.join(root, 'legacy-source');
    const target = path.join(root, 'target');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'state.json'), '{"legacy":true}');
    fs.writeFileSync(path.join(source, 'secrets.json'), '{"v":1,"enc":true}');
    fs.writeFileSync(path.join(source, 'tangbao.db'), 'db');

    const result = locations.migrateRoot(source, target);
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(target, 'tangbao-data', 'state.json'), 'utf8'), '{"legacy":true}');
    assert.equal(fs.readFileSync(path.join(target, 'tangbao-data', 'secrets.json'), 'utf8'), '{"v":1,"enc":true}');
    assert.equal(fs.readFileSync(path.join(target, 'tangbao-data', 'tangbao.db'), 'utf8'), 'db');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('data location pointer schedules a restart and is completed on startup', () => {
  const root = tempRoot();
  try {
    const pointerRoot = path.join(root, 'default');
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    fs.mkdirSync(path.join(source, 'tangbao-data'), { recursive: true });
    fs.writeFileSync(path.join(source, 'tangbao-data', 'state.json'), '{"ok":true}');

    const pending = locations.requestMove({ pointerRoot, sourceRoot: source, targetRoot: target });
    assert.equal(pending.ok, true);
    assert.equal(pending.restartRequired, true);
    assert.equal(locations.readLocation(pointerRoot).pending, true);

    const startup = locations.resolveStartupLocation({ defaultRoot: pointerRoot, packaged: false, executablePath: '' });
    assert.equal(startup.rootPath, path.resolve(target));
    assert.equal(startup.pointer.pending, false);
    assert.equal(fs.readFileSync(path.join(target, 'tangbao-data', 'state.json'), 'utf8'), '{"ok":true}');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('data location pointer can be replaced when a previous selection already exists', () => {
  const root = tempRoot();
  try {
    const pointerRoot = path.join(root, 'default');
    const source = path.join(root, 'source');
    const firstTarget = path.join(root, 'first-target');
    const secondTarget = path.join(root, 'second-target');
    assert.equal(locations.requestMove({ pointerRoot, sourceRoot: source, targetRoot: firstTarget }).ok, true);
    const replaced = locations.requestMove({ pointerRoot, sourceRoot: source, targetRoot: secondTarget });
    assert.equal(replaced.ok, true);
    assert.equal(locations.readLocation(pointerRoot).rootPath, path.resolve(secondTarget));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('data location rejects same and nested roots', () => {
  const root = tempRoot();
  try {
    assert.equal(locations.validateMove(root, root).code, 'same_location');
    assert.equal(locations.validateMove(root, path.join(root, 'child')).code, 'nested_location');
    assert.equal(locations.validateMove(path.join(root, 'child'), root).code, 'nested_location');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
