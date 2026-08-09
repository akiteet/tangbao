'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function sameBytes(left, right) {
  try {
    return fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch (_) {
    return false;
  }
}

function findLegacySecret(legacyRoot) {
  const candidates = [
    path.join(legacyRoot, 'tangbao-data.backup', 'secrets.json'),
    path.join(legacyRoot, 'tangbao-data', 'secrets.json'),
    path.join(legacyRoot, 'secrets.json'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function uniqueBackupPath(filePath) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  const base = filePath + '.before-secret-context-' + stamp + '.bak';
  let candidate = base;
  let suffix = 1;
  while (fs.existsSync(candidate)) candidate = base + '.' + suffix++;
  return candidate;
}

function restoreBackup(activePath, backupPath) {
  if (!backupPath || !fs.existsSync(backupPath)) return false;
  try {
    if (fs.existsSync(activePath)) fs.unlinkSync(activePath);
    fs.renameSync(backupPath, activePath);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * The records migration can move secrets.json to another drive, but Electron's
 * Windows safeStorage key lives in Local State. Adopt the old key only when
 * the old and active ciphertext are the same file contents.
 */
function adoptLegacyContext({ activeRoot, legacyRoot } = {}) {
  const active = path.resolve(String(activeRoot || ''));
  const legacy = path.resolve(String(legacyRoot || ''));
  if (!active || !legacy || active.toLowerCase() === legacy.toLowerCase()) {
    return { ok: true, changed: false, reason: 'same_root' };
  }

  const legacySecret = findLegacySecret(legacy);
  if (!legacySecret) return { ok: true, changed: false, reason: 'legacy_secret_missing' };
  const legacySecretJson = readJson(legacySecret);
  if (!legacySecretJson || legacySecretJson.enc !== true) {
    return { ok: true, changed: false, reason: 'legacy_secret_not_encrypted' };
  }

  const activeSecret = path.join(active, 'tangbao-data', 'secrets.json');
  if (fs.existsSync(activeSecret) && !sameBytes(activeSecret, legacySecret)) {
    return { ok: true, changed: false, reason: 'secret_mismatch' };
  }

  const legacyLocalStatePath = path.join(legacy, 'Local State');
  const legacyLocalState = readJson(legacyLocalStatePath);
  const legacyKey = legacyLocalState && legacyLocalState.os_crypt && legacyLocalState.os_crypt.encrypted_key;
  if (typeof legacyKey !== 'string' || !legacyKey) {
    return { ok: true, changed: false, reason: 'legacy_context_missing' };
  }

  const activeLocalStatePath = path.join(active, 'Local State');
  const activeLocalState = readJson(activeLocalStatePath) || {};
  const activeKey = activeLocalState.os_crypt && activeLocalState.os_crypt.encrypted_key;
  if (activeKey === legacyKey) return { ok: true, changed: false, reason: 'already_adopted' };

  const merged = Object.assign({}, activeLocalState, {
    os_crypt: Object.assign({}, activeLocalState.os_crypt || {}, { encrypted_key: legacyKey }),
  });
  const tempPath = activeLocalStatePath + '.secret-context.tmp';
  const backupPath = fs.existsSync(activeLocalStatePath) ? uniqueBackupPath(activeLocalStatePath) : '';
  let moved = false;
  let installed = false;
  try {
    fs.mkdirSync(active, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(merged), { encoding: 'utf8', flag: 'wx' });
    if (backupPath) {
      fs.renameSync(activeLocalStatePath, backupPath);
      moved = true;
    }
    fs.renameSync(tempPath, activeLocalStatePath);
    installed = true;
    return {
      ok: true,
      changed: true,
      backupPath,
      backupFile: backupPath ? path.basename(backupPath) : '',
    };
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    if (moved && !installed) restoreBackup(activeLocalStatePath, backupPath);
    return {
      ok: false,
      code: 'secret_context_adopt_failed',
      error: error && error.message ? error.message : String(error),
    };
  }
}

module.exports = { adoptLegacyContext, restoreBackup };
