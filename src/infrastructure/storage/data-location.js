'use strict';

const fs = require('fs');
const path = require('path');

const LOCATION_FILE = 'tangbao-location.json';
const LOCATION_VERSION = 1;

// Keep application records and browser state, but leave Chromium caches behind.
const MIGRATED_ENTRIES = [
  'tangbao-data',
  'Local Storage',
  'Session Storage',
  'IndexedDB',
  'Preferences',
  'Network',
  'Shared Dictionary',
];

// v1.0.5 及更早版本曾把记录直接放在 userData 根目录。迁移时统一收进
// target/tangbao-data，避免出现“对话迁了、密钥还留在旧目录”的半迁移状态。
const LEGACY_RECORD_ENTRIES = [
  'state.json',
  'secrets.json',
  'tangbao.db',
  'tangbao.db.pre-v16.bak',
  'state.v1.backup.json',
];

function canonical(value) {
  return path.resolve(String(value || ''));
}

function pathKey(value) {
  const resolved = canonical(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSameOrNested(parent, candidate) {
  const base = canonical(parent);
  const target = canonical(candidate);
  const relative = path.relative(base, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function locationPath(pointerRoot) {
  return path.join(canonical(pointerRoot), LOCATION_FILE);
}

function replaceFile(source, target) {
  try {
    fs.renameSync(source, target);
    return;
  } catch (error) {
    // Windows may refuse rename-overwrite when the pointer already exists.
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error && error.code)) throw error;
  }
  const backup = target + '.bak-' + process.pid + '-' + Date.now();
  let movedExisting = false;
  try {
    fs.renameSync(target, backup);
    movedExisting = true;
    fs.renameSync(source, target);
    fs.unlinkSync(backup);
  } catch (error) {
    try { if (movedExisting && !fs.existsSync(target)) fs.renameSync(backup, target); } catch (_) {}
    throw error;
  }
}

function readLocation(pointerRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(locationPath(pointerRoot), 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.rootPath || !path.isAbsolute(String(raw.rootPath))) return null;
    return {
      version: Number(raw.version) || LOCATION_VERSION,
      rootPath: canonical(raw.rootPath),
      sourceRoot: raw.sourceRoot && path.isAbsolute(String(raw.sourceRoot)) ? canonical(raw.sourceRoot) : '',
      pending: raw.pending === true,
      updatedAt: String(raw.updatedAt || ''),
    };
  } catch (_) {
    return null;
  }
}

function writeLocation(pointerRoot, value) {
  const root = canonical(pointerRoot);
  const input = value || {};
  const record = {
    version: LOCATION_VERSION,
    rootPath: canonical(input.rootPath),
    sourceRoot: input.sourceRoot ? canonical(input.sourceRoot) : '',
    pending: input.pending === true,
    updatedAt: new Date().toISOString(),
  };
  if (!path.isAbsolute(record.rootPath)) return { ok: false, code: 'invalid_location' };
  try {
    fs.mkdirSync(root, { recursive: true });
    const file = locationPath(root);
    const temp = file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(record, null, 2), 'utf8');
    replaceFile(temp, file);
    return { ok: true, location: record, path: file };
  } catch (error) {
    return { ok: false, code: 'location_write_failed', error: error && error.message ? error.message : String(error) };
  }
}

function probeWritable(root) {
  const target = canonical(root);
  const probe = path.join(target, '.tangbao-write-test-' + process.pid + '-' + Date.now());
  try {
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return { ok: true, path: target };
  } catch (error) {
    try { fs.unlinkSync(probe); } catch (_) {}
    return {
      ok: false,
      path: target,
      code: 'location_not_writable',
      systemCode: error && error.code ? String(error.code) : '',
      error: error && error.message ? error.message : String(error),
    };
  }
}

function copyEntryIfMissing(source, target) {
  let stat;
  try { stat = fs.lstatSync(source); } catch (_) { return { copied: false, skipped: true }; }
  if (stat.isSymbolicLink()) return { copied: false, skipped: true };
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    let copied = false;
    for (const name of fs.readdirSync(source)) {
      const result = copyEntryIfMissing(path.join(source, name), path.join(target, name));
      copied = copied || !!result.copied;
    }
    return { copied, skipped: false };
  }
  if (fs.existsSync(target)) return { copied: false, skipped: true };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return { copied: true, skipped: false };
}

function migrateRoot(sourceRoot, targetRoot) {
  const source = canonical(sourceRoot);
  const target = canonical(targetRoot);
  if (pathKey(source) === pathKey(target)) return { ok: false, code: 'same_location' };
  if (isSameOrNested(source, target) || isSameOrNested(target, source)) {
    return { ok: false, code: 'nested_location', error: '数据目录不能互相包含' };
  }
  const writable = probeWritable(target);
  if (!writable.ok) return writable;
  if (!fs.existsSync(source)) return { ok: true, copied: false, source, target };
  try {
    let copied = false;
    for (const name of MIGRATED_ENTRIES) {
      const result = copyEntryIfMissing(path.join(source, name), path.join(target, name));
      copied = copied || !!result.copied;
    }
    for (const name of LEGACY_RECORD_ENTRIES) {
      const result = copyEntryIfMissing(path.join(source, name), path.join(target, 'tangbao-data', name));
      copied = copied || !!result.copied;
    }
    return { ok: true, copied, source, target };
  } catch (error) {
    return { ok: false, code: 'migration_failed', source, target, error: error && error.message ? error.message : String(error) };
  }
}

function validateMove(sourceRoot, targetRoot) {
  const source = canonical(sourceRoot);
  const target = canonical(targetRoot);
  if (!path.isAbsolute(target)) return { ok: false, code: 'invalid_location' };
  if (pathKey(source) === pathKey(target)) return { ok: false, code: 'same_location' };
  if (isSameOrNested(source, target) || isSameOrNested(target, source)) {
    return { ok: false, code: 'nested_location', error: '数据目录不能互相包含' };
  }
  const writable = probeWritable(target);
  return writable.ok ? { ok: true, source, target } : writable;
}

function requestMove({ pointerRoot, sourceRoot, targetRoot }) {
  const checked = validateMove(sourceRoot, targetRoot);
  if (!checked.ok) return checked;
  const written = writeLocation(pointerRoot, {
    rootPath: checked.target,
    sourceRoot: checked.source,
    pending: true,
  });
  if (!written.ok) return written;
  return Object.assign({ ok: true, restartRequired: true }, written, { source: checked.source, target: checked.target });
}

function resolveStartupLocation({ defaultRoot, packaged, executablePath }) {
  const original = canonical(defaultRoot);
  const pointer = readLocation(original);
  if (pointer) {
    const source = pointer.sourceRoot || original;
    if (pathKey(pointer.rootPath) !== pathKey(original)) {
      const writable = probeWritable(pointer.rootPath);
      if (writable.ok) {
        if (pointer.pending) {
          const migrated = migrateRoot(source, pointer.rootPath);
          if (migrated.ok) {
            writeLocation(original, { rootPath: pointer.rootPath, sourceRoot: source, pending: false });
            return { rootPath: pointer.rootPath, defaultRoot: original, migrated, pointer: readLocation(original) };
          }
          return { rootPath: source || original, defaultRoot: original, migration: migrated, pointer };
        }
        return { rootPath: pointer.rootPath, defaultRoot: original, pointer };
      }
    }
  }

  if (packaged && executablePath) {
    const executableDir = path.dirname(executablePath);
    const driveRoot = path.parse(executablePath).root;
    const candidates = [
      path.join(executableDir, 'tangbao-data'),
      driveRoot ? path.join(driveRoot, 'Users', 'Public', 'tangbao-web-data') : '',
    ].filter(Boolean);
    for (const candidate of candidates) {
      const checked = validateMove(original, candidate);
      if (!checked.ok) continue;
      const migrated = migrateRoot(original, candidate);
      if (!migrated.ok) continue;
      writeLocation(original, { rootPath: checked.target, sourceRoot: original, pending: false });
      return { rootPath: checked.target, defaultRoot: original, migrated, pointer: readLocation(original) };
    }
  }

  return { rootPath: original, defaultRoot: original, pointer };
}

function describe({ defaultRoot, activeRoot }) {
  const original = canonical(defaultRoot);
  const active = canonical(activeRoot);
  const pointer = readLocation(original);
  return {
    ok: true,
    mode: pathKey(original) === pathKey(active) ? 'default' : 'custom',
    defaultRoot: original,
    activeRoot: active,
    recordsRoot: path.join(active, 'tangbao-data'),
    pointerPath: locationPath(original),
    pending: !!(pointer && pointer.pending),
    sourceRoot: pointer ? pointer.sourceRoot || '' : '',
    migratedEntries: MIGRATED_ENTRIES.slice(),
  };
}

module.exports = {
  LOCATION_FILE,
  MIGRATED_ENTRIES,
  LEGACY_RECORD_ENTRIES,
  canonical,
  isSameOrNested,
  readLocation,
  writeLocation,
  probeWritable,
  migrateRoot,
  validateMove,
  requestMove,
  resolveStartupLocation,
  describe,
};
