'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const dataLocation = require('../src/infrastructure/storage/data-location');
const { SCHEMA_VERSION } = require('../src/core/schemas/db-schema');
const { normalizeCacheMetrics } = require('../src/core/agent-runtime/model-telemetry');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-storage-check-'));
  try {
    const defaultRoot = path.join(tempRoot, 'default');
    const activeRoot = path.join(tempRoot, 'active');
    fs.mkdirSync(path.join(activeRoot, 'tangbao-data'), { recursive: true });
    fs.writeFileSync(path.join(activeRoot, 'tangbao-data', 'state.json'), '{}', 'utf8');
    const info = dataLocation.describe({ defaultRoot, activeRoot });
    assert(info.ok === true, 'storage describe must succeed');
    assert(info.recordsRoot === path.join(activeRoot, 'tangbao-data'), 'records root must be under activeRoot');
    assert(Array.isArray(info.parts), 'storage audit parts are required');
    assert(typeof dataLocation.verifyMigration === 'function', 'verifyMigration is missing');
    assert(typeof dataLocation.cleanupPreview === 'function', 'cleanupPreview is missing');
    assert(typeof dataLocation.cleanupLegacy === 'function', 'cleanupLegacy is missing');
    assert(SCHEMA_VERSION === 17, 'Schema must remain v17'); // v1.1.8：image_model/image_extra 列迁移后守卫随版本推进
    const unknown = normalizeCacheMetrics({ source: 'unknown', dataOrigin: 'unknown' });
    assert(unknown.cacheReadTokens === null && unknown.hitRate === null, 'unknown cache metrics must remain null');
    console.log(JSON.stringify({ ok: true, schemaVersion: SCHEMA_VERSION, recordsRoot: info.recordsRoot, totalBytes: info.totalBytes }, null, 2));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error('[check:storage] ' + (error.message || error)); process.exitCode = 1; }
}

module.exports = { main };
