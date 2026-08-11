'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOCATION_FILE = 'tangbao-location.json';
const LOCATION_VERSION = 1;
const MIGRATION_STATE_FILE = 'tangbao-migration.json';

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

function migrationId() {
  return 'mig_' + Date.now().toString(36) + '_' + crypto.randomBytes(5).toString('hex');
}

function atomicWriteJson(file, value) {
  const temp = file + '.tmp-' + process.pid + '-' + Date.now();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  replaceFile(temp, file);
}

function migrationPath(pointerRoot) {
  return path.join(canonical(pointerRoot), MIGRATION_STATE_FILE);
}

function readMigrationState(pointerRoot) {
  try {
    const raw = JSON.parse(fs.readFileSync(migrationPath(pointerRoot), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch (_) { return null; }
}

function writeMigrationState(pointerRoot, state) {
  const current = readMigrationState(pointerRoot) || {};
  const next = Object.assign({}, current, state || {}, { updatedAt: new Date().toISOString() });
  try {
    atomicWriteJson(migrationPath(pointerRoot), next);
    return { ok: true, state: next, path: migrationPath(pointerRoot) };
  } catch (error) {
    return { ok: false, code: 'migration_state_write_failed', error: error && error.message ? error.message : String(error) };
  }
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(file);
  hash.update(data);
  return { sha256: hash.digest('hex'), bytes: data.length };
}

function collectFiles(root, current, out, limit) {
  if (out.length >= limit) throw Object.assign(new Error('迁移文件数量超过限制'), { code: 'migration_too_many_files' });
  let stat;
  try { stat = fs.lstatSync(current); } catch (_) { return; }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(current)) collectFiles(root, path.join(current, name), out, limit);
    return;
  }
  const rel = path.relative(root, current).split(path.sep).join('/');
  const digest = hashFile(current);
  out.push({ path: rel, bytes: digest.bytes, sha256: digest.sha256 });
}

function migrationMappings(sourceRoot) {
  const source = canonical(sourceRoot);
  const mappings = [];
  const seenTargets = new Set();
  const add = (entry, targetPrefix) => {
    const sourcePath = path.join(source, entry);
    if (!fs.existsSync(sourcePath)) return;
    const files = [];
    collectFiles(source, sourcePath, files, 100000);
    for (const file of files) {
      const target = path.join(targetPrefix, file.path).split(path.sep).join('/');
      if (seenTargets.has(target)) continue;
      seenTargets.add(target);
      mappings.push({ source: path.join(source, file.path), target, bytes: file.bytes, sha256: file.sha256 });
    }
  };
  // The normalized tangbao-data tree wins over legacy root-level files on collision.
  for (const name of MIGRATED_ENTRIES) add(name, '');
  for (const name of LEGACY_RECORD_ENTRIES) add(name, 'tangbao-data');
  return mappings;
}

function verifyStagedMigration(mappings, stageRoot, preserved) {
  const missing = [];
  const mismatched = [];
  let bytes = 0;
  for (const item of mappings) {
    const target = path.join(stageRoot, item.target);
    try {
      const digest = hashFile(target);
      const expected = preserved && preserved[item.target] ? preserved[item.target] : item;
      bytes += digest.bytes;
      if (digest.sha256 !== expected.sha256 || digest.bytes !== expected.bytes) {
        mismatched.push({ path: item.target, expected: expected.sha256, actual: digest.sha256 });
      }
    } catch (_) { missing.push(item.target); }
  }
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched, bytes, count: mappings.length };
}

function removeTree(target) {
  try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
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
      migrationId: String(raw.migrationId || ''),
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
    migrationId: String(input.migrationId || ''),
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
  return migrateRootWithOptions(sourceRoot, targetRoot, {});
}

function migrateRootWithOptions(sourceRoot, targetRoot, options) {
  const source = canonical(sourceRoot);
  const target = canonical(targetRoot);
  if (pathKey(source) === pathKey(target)) return { ok: false, code: 'same_location' };
  if (isSameOrNested(source, target) || isSameOrNested(target, source)) {
    return { ok: false, code: 'nested_location', error: '数据目录不能互相包含' };
  }
  const writable = probeWritable(target);
  if (!writable.ok) return writable;
  const opts = options || {};
  const pointerRoot = canonical(opts.pointerRoot || source);
  const id = String(opts.migrationId || migrationId());
  const stage = target + '.tangbao-stage-' + id;
  const backup = target + '.tangbao-backup-' + id;
  const baseState = { version: 1, id, status: 'pending', sourceRoot: source, targetRoot: target, stageRoot: stage, backupRoot: '', files: [], bytes: 0, verification: null, errors: [] };
  writeMigrationState(pointerRoot, baseState);
  let movedTarget = false;
  let activated = false;
  try {
    removeTree(stage);
    fs.mkdirSync(stage, { recursive: true });
    const preserved = Object.create(null);
    // Preserve target-only files while staging so a migration never drops user data.
    if (fs.existsSync(target)) {
      for (const name of fs.readdirSync(target)) copyEntryIfMissing(path.join(target, name), path.join(stage, name));
      const existing = [];
      collectFiles(target, target, existing, 100000);
      for (const item of existing) preserved[item.path] = { sha256: item.sha256, bytes: item.bytes };
    }
    const mappings = fs.existsSync(source) ? migrationMappings(source) : [];
    const effectiveMappings = mappings.map((item) => {
      const existing = preserved[item.target];
      return Object.assign({}, item, {
        preserved: !!existing,
        activationSha256: existing ? existing.sha256 : item.sha256,
        activationBytes: existing ? existing.bytes : item.bytes,
      });
    });
    writeMigrationState(pointerRoot, { id, status: 'copying', sourceRoot: source, targetRoot: target, files: effectiveMappings, bytes: effectiveMappings.reduce((sum, item) => sum + (item.activationBytes || item.bytes), 0), verification: null, errors: [] });
    for (const item of effectiveMappings) copyEntryIfMissing(item.source, path.join(stage, item.target));
    const verification = verifyStagedMigration(effectiveMappings, stage, preserved);
    if (!verification.ok) throw Object.assign(new Error('迁移校验失败'), { code: 'migration_verification_failed', verification });
    writeMigrationState(pointerRoot, { id, status: 'verified', files: effectiveMappings, bytes: verification.bytes, verification });
    if (fs.existsSync(target)) {
      removeTree(backup);
      fs.renameSync(target, backup);
      movedTarget = true;
    }
    fs.renameSync(stage, target);
    activated = true;
    const active = { id, status: 'active', sourceRoot: source, targetRoot: target, stageRoot: '', backupRoot: movedTarget ? backup : '', files: effectiveMappings, bytes: verification.bytes, verification, errors: [] };
    writeMigrationState(pointerRoot, active);
    return { ok: true, copied: effectiveMappings.length > 0, source, target, migrationId: id, status: 'active', files: effectiveMappings, bytes: verification.bytes, backupRoot: movedTarget ? backup : '' };
  } catch (error) {
    removeTree(stage);
    if (movedTarget && !activated) {
      try { if (!fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target); } catch (_) {}
    }
    const state = { id, status: 'failed', sourceRoot: source, targetRoot: target, stageRoot: '', backupRoot: movedTarget ? backup : '', verification: error && error.verification || null, errors: [{ code: error && error.code || 'migration_failed', message: error && error.message ? error.message : String(error) }] };
    writeMigrationState(pointerRoot, state);
    return { ok: false, code: error && error.code || 'migration_failed', source, target, migrationId: id, status: 'failed', error: error && error.message ? error.message : String(error), verification: error && error.verification || null };
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
    migrationId: migrationId(),
  });
  if (!written.ok) return written;
  return Object.assign({ ok: true, restartRequired: true }, written, { source: checked.source, target: checked.target, migrationId: written.location.migrationId });
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
          const migrated = migrateRootWithOptions(source, pointer.rootPath, { pointerRoot: original, migrationId: pointer.migrationId });
          if (migrated.ok) {
            writeLocation(original, { rootPath: pointer.rootPath, sourceRoot: source, pending: false, migrationId: migrated.migrationId });
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
  const sizeOf = (target) => {
    let bytes = 0;
    let files = 0;
    const walkSize = (current) => {
      let stat;
      try { stat = fs.lstatSync(current); } catch (_) { return; }
      if (stat.isSymbolicLink()) return;
      if (stat.isDirectory()) { for (const name of fs.readdirSync(current)) walkSize(path.join(current, name)); }
      else { files++; bytes += Number(stat.size) || 0; }
    };
    walkSize(target);
    return { path: target, bytes, files, exists: fs.existsSync(target) };
  };
  const migration = readMigrationState(original);
  const parts = [
    { key: 'records', label: '记录与 SQLite', location: path.join(active, 'tangbao-data') },
    { key: 'browserState', label: '浏览器状态', location: path.join(active, 'Local Storage') },
    { key: 'pointer', label: '目录指针', location: locationPath(original) },
  ].map((part) => Object.assign(part, sizeOf(part.location)));
  if (migration && migration.backupRoot) parts.push(Object.assign({ key: 'migrationBackup', label: '迁移备份', location: migration.backupRoot }, sizeOf(migration.backupRoot)));
  return {
    ok: true,
    mode: pathKey(original) === pathKey(active) ? 'default' : 'custom',
    defaultRoot: original,
    activeRoot: active,
    recordsRoot: path.join(active, 'tangbao-data'),
    pointerPath: locationPath(original),
    pending: !!(pointer && pointer.pending),
    migrationId: pointer && pointer.migrationId || '',
    migration,
    sourceRoot: pointer ? pointer.sourceRoot || '' : '',
    migratedEntries: MIGRATED_ENTRIES.slice(),
    parts,
    totalBytes: parts.reduce((sum, part) => sum + part.bytes, 0),
  };
}

function verifyMigration(options) {
  const opts = options || {};
  const source = canonical(opts.sourceRoot || '');
  const target = canonical(opts.targetRoot || '');
  if (!source || !target) return { ok: false, code: 'migration_paths_missing' };
  const mappings = fs.existsSync(source) ? migrationMappings(source) : [];
  const verification = verifyStagedMigration(mappings, target);
  const state = readMigrationState(opts.pointerRoot || source);
  return { ok: verification.ok, status: verification.ok ? 'verified' : 'failed', sourceRoot: source, targetRoot: target, migrationId: opts.migrationId || state && state.id || '', files: mappings, bytes: verification.bytes, verification, state };
}

function cleanupPreview({ defaultRoot, activeRoot } = {}) {
  const original = canonical(defaultRoot);
  const active = canonical(activeRoot || original);
  if (pathKey(original) === pathKey(active)) return { ok: true, previewId: '', items: [], totalBytes: 0, reason: 'default_active' };
  const names = Array.from(new Set(MIGRATED_ENTRIES.concat(LEGACY_RECORD_ENTRIES)));
  const items = [];
  for (const name of names) {
    const location = path.join(original, name);
    if (!fs.existsSync(location) || name === LOCATION_FILE || name === MIGRATION_STATE_FILE) continue;
    const stat = fs.lstatSync(location);
    if (stat.isDirectory() && pathKey(location) === pathKey(path.join(active, name))) continue;
    let bytes = 0;
    const walk = (current) => {
      let s; try { s = fs.lstatSync(current); } catch (_) { return; }
      if (s.isSymbolicLink()) return;
      if (s.isDirectory()) fs.readdirSync(current).forEach((child) => walk(path.join(current, child)));
      else bytes += Number(s.size) || 0;
    };
    walk(location);
    items.push({ name, location, bytes, type: stat.isDirectory() ? 'directory' : 'file' });
  }
  const previewId = 'cleanup_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
  return { ok: true, previewId, items, totalBytes: items.reduce((sum, item) => sum + item.bytes, 0), defaultRoot: original, activeRoot: active };
}

function cleanupLegacy({ defaultRoot, activeRoot, previewId, items } = {}) {
  const preview = cleanupPreview({ defaultRoot, activeRoot });
  if (!preview.ok || !preview.items.length) return Object.assign(preview, { cleaned: [] });
  if (previewId && String(previewId).split('_').slice(0, 1).join('_') !== 'cleanup') return { ok: false, code: 'cleanup_preview_invalid' };
  const quarantine = path.join(preview.defaultRoot, '.tangbao-quarantine-' + new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17));
  const cleaned = [];
  try {
    fs.mkdirSync(quarantine, { recursive: true });
    for (const item of preview.items) {
      const dest = path.join(quarantine, item.name);
      if (!isSameOrNested(preview.defaultRoot, item.location) || pathKey(item.location) === pathKey(locationPath(preview.defaultRoot))) continue;
      fs.renameSync(item.location, dest);
      cleaned.push({ from: item.location, to: dest, bytes: item.bytes });
    }
    return { ok: true, quarantine, cleaned, totalBytes: cleaned.reduce((sum, item) => sum + item.bytes, 0) };
  } catch (error) {
    return { ok: false, code: 'cleanup_failed', quarantine, cleaned, error: error && error.message ? error.message : String(error) };
  }
}

module.exports = {
  LOCATION_FILE,
  MIGRATION_STATE_FILE,
  MIGRATED_ENTRIES,
  LEGACY_RECORD_ENTRIES,
  canonical,
  isSameOrNested,
  readLocation,
  writeLocation,
  probeWritable,
  migrateRoot,
  migrateRootWithOptions,
  validateMove,
  requestMove,
  resolveStartupLocation,
  describe,
  readMigrationState,
  writeMigrationState,
  verifyMigration,
  cleanupPreview,
  cleanupLegacy,
};
