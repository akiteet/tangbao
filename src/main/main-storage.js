'use strict';
/* 自 main.js 拆分（v1.1.8 批次 F）：存储域——SQLite 服务惰性单例 + 数据目录/备份/迁移/诊断/导入导出 IPC。
 * 纯工厂模式（同 createMainSkills 先例）：createMainStorage(deps) 注册全部 storage:* IPC handler，
 * 并返回主进程其他域需要的函数（getStorageService / readActiveStateObject / getStorageFileRepo）。
 * state.json 簇（acceptStateRevision / writeStateFileAtomic / chat-partials / fs:readState / fs:writeState /
 * chat:flushPartial）仍留 main.js——acceptStateRevision 与 writeStateFileAtomic 经 deps 注入回本模块。
 * deps 注入：safeHandle / safeOn / app / dialog / shell / secrets / getMainWindow /
 *            defaultUserDataRoot / startupLocation / hasActiveAgentRuns / getModuleSessionStore /
 *            acceptStateRevision / writeStateFileAtomic。 */
const fs = require('fs');
const path = require('path');
const dataLocation = require('../infrastructure/storage/data-location');

function createMainStorage(deps) {
  const {
    safeHandle, safeOn, app, dialog, shell, secrets,
    defaultUserDataRoot, startupLocation, hasActiveAgentRuns,
    getModuleSessionStore, acceptStateRevision, writeStateFileAtomic,
  } = deps;
  const mainWindow = () => (deps.getMainWindow ? deps.getMainWindow() : null);

// ===== M3 存储层（SQLite + 文件仓）：一次性迁移入口 =====
// better-sqlite3 是原生模块，未编译（沙箱 / 未 electron-rebuild）时整体不可用，App 继续走 state.json。
let storageService = null;
let storageFileRepo = null;
let storageReady = false;      // 完整性自检通过后才算真正可用
let backupRotatedOnce = false; // 每次启动只轮转一次备份
let storageFailure = '';

// v1.1.3：文件仓只做审计，不自动删除用户文件；清理必须经过预览和显式隔离操作。
function auditFileRepo(svc, fileRepo) {
  try {
    const refImg = new Set((svc.getImageFileNames ? svc.getImageFileNames() : []).filter(Boolean));
    const orphanImages = (fileRepo.list('images') || []).filter((f) => !refImg.has(f));
    const refDoc = new Set((svc.getDocIds ? svc.getDocIds() : []).filter(Boolean));
    const orphanDocuments = (fileRepo.list('documents') || []).filter((f) => !refDoc.has(f));
    const trace = svc && typeof svc.auditAgentTrace === 'function'
      ? svc.auditAgentTrace()
      : { ok: false, orphanEvents: [], invalidEvents: [], duplicateSequences: [] };
    return { orphanImages, orphanDocuments, trace };
  } catch (e) { console.warn('[存储层] 文件仓 GC 失败（忽略）：', e && e.message ? e.message : e); }
  return { orphanImages: [], orphanDocuments: [], trace: { ok: false, orphanEvents: [], invalidEvents: [], duplicateSequences: [] } };
}

function stateShape(value) {
  const state = value && typeof value === 'object' ? value : {};
  const settings = state.settings && typeof state.settings === 'object' ? state.settings : {};
  return {
    conversations: Array.isArray(state.conversations) ? state.conversations.length : null,
    accounts: Array.isArray(settings.accounts) ? settings.accounts.length : null,
    documents: Array.isArray(settings.docs) ? settings.docs.length : null,
    images: Array.isArray(settings.imageHistory) ? settings.imageHistory.length : null,
    projects: Array.isArray(state.projects) ? state.projects.length : null,
    threads: Array.isArray(state.agentThreads) ? state.agentThreads.length : null,
  };
}

function auditStateConsistency(svc) {
  const disk = readActiveStateObject();
  if (!disk) return { status: 'unknown', reason: 'state_missing', disk: null, sqlite: null, mismatches: [] };
  if (!svc || typeof svc.ready !== 'function' || !svc.ready()) {
    return { status: 'unknown', reason: 'sqlite_unavailable', disk: stateShape(disk), sqlite: null, mismatches: [] };
  }
  try {
    const migrator = require('../infrastructure/storage/migrator');
    const loaded = migrator.readState(svc, storageFileRepo);
    if (!loaded || !loaded.ok) return { status: 'unknown', reason: loaded && loaded.reason || 'sqlite_state_unavailable', disk: stateShape(disk), sqlite: null, mismatches: [] };
    const left = stateShape(disk);
    const right = stateShape(loaded.state);
    const mismatches = Object.keys(left)
      .filter((key) => left[key] != null && right[key] != null && left[key] !== right[key])
      .map((key) => ({ field: key, disk: left[key], sqlite: right[key] }));
    return { status: mismatches.length ? 'inconsistent' : 'consistent', disk: left, sqlite: right, mismatches };
  } catch (error) {
    return { status: 'unknown', reason: 'consistency_check_failed', disk: stateShape(disk), sqlite: null, mismatches: [], error: error && error.message ? error.message : String(error) };
  }
}

function listStorageBackups() {
  const dataDir = path.join(app.getPath('userData'), 'tangbao-data');
  try {
    return fs.readdirSync(dataDir)
      .filter((name) => /(?:backup|before-restore|pre-v|unreadable|secret-context)/i.test(name))
      .slice(0, 100)
      .map((name) => {
        const filePath = path.join(dataDir, name);
        let stat = null;
        try { stat = fs.statSync(filePath); } catch (_) {}
        return { name, path: filePath, bytes: stat && stat.isFile() ? stat.size : 0, isDirectory: !!(stat && stat.isDirectory()) };
      });
  } catch (_) { return []; }
}

function storageInfo() {
  const info = dataLocation.describe({ defaultRoot: defaultUserDataRoot, activeRoot: app.getPath('userData') });
  info.startupMigration = startupLocation && startupLocation.migration && startupLocation.migration.ok === false
    ? startupLocation.migration
    : null;
  const svc = getStorageService();
  info.database = { path: svc && svc.dbPathInfo ? svc.dbPathInfo() : path.join(app.getPath('userData'), 'tangbao-data', 'tangbao.db'), available: !!svc, integrity: svc && typeof svc.checkIntegrity === 'function' ? !!svc.checkIntegrity() : false, reason: svc ? '' : (storageFailure || 'sqlite_unavailable') };
  info.secretStore = typeof secrets.getStatus === 'function' ? secrets.getStatus() : null;
  info.audit = svc && storageFileRepo ? auditFileRepo(svc, storageFileRepo) : { orphanImages: [], orphanDocuments: [], trace: { ok: false, orphanEvents: [], invalidEvents: [], duplicateSequences: [] } };
  info.audit.stateConsistency = auditStateConsistency(svc);
  info.backups = listStorageBackups();
  info.moduleSessions = getModuleSessionStore().info();
  return info;
}

function getStorageService() {
  if (storageService && storageReady) return storageService;
  try {
    const { init: initStore, StorageService, checkIntegrity } = require('../infrastructure/storage/sqlite-store');
    const fileRepo = require('../infrastructure/storage/file-repo');
    const userData = app.getPath('userData');
    const dataDir = path.join(userData, 'tangbao-data');
    fs.mkdirSync(dataDir, { recursive: true });
    fileRepo.init(userData);
    storageFileRepo = fileRepo;
    if (!initStore(path.join(dataDir, 'tangbao.db'), fileRepo)) {
      storageFailure = 'sqlite_init_failed';
      return null;
    }
    if (!checkIntegrity()) {
      storageFailure = 'sqlite_integrity_failed';
      return null;
    }
    storageFailure = '';
    storageService = StorageService;
    storageReady = true;
    // v1.1.3：启动只审计文件仓，不自动删除孤儿图片/文档。
    try { auditFileRepo(storageService, storageFileRepo); } catch (_) { /* ignore */ }
    return storageService;
  } catch (e) {
    storageFailure = 'sqlite_unavailable';
    console.error('[存储层] better-sqlite3 不可用，回退 state.json：', e && e.message ? e.message : e);
    return null;
  }
}

function getStorageFileRepo() { return storageFileRepo; }

// Data location is user-selectable. The pointer stays in the original Electron
// userData directory; records are copied and activated after the next launch.
safeHandle('storage:info', () => storageInfo());

safeHandle('storage:chooseLocation', async () => {
  try {
    if (typeof hasActiveAgentRuns === 'function' && hasActiveAgentRuns()) {
      return { ok: false, code: 'active_agent_runs', error: '请等待运行结束后再迁移数据目录' };
    }
    const mw = mainWindow();
    const owner = mw && !mw.isDestroyed() ? mw : undefined;
    while (true) {
      const result = await dialog.showOpenDialog(owner, {
        title: '选择糖包数据目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths || !result.filePaths.length) return { ok: false, canceled: true };
      const selectedRoot = result.filePaths[0];
      const move = dataLocation.requestMove({
        pointerRoot: defaultUserDataRoot,
        sourceRoot: app.getPath('userData'),
        targetRoot: selectedRoot,
      });
      if (move.ok) {
        return {
          ok: true,
          restartRequired: true,
          targetRoot: move.target,
          recordsRoot: path.join(move.target, 'tangbao-data'),
        };
      }
      if (move.code !== 'location_not_writable') return move;

      const permissionAction = await dialog.showMessageBox(owner, {
        type: 'warning',
        title: '数据目录没有写入权限',
        message: '当前 Windows 账户无法写入所选目录',
        detail: (move.path || selectedRoot) + '\n\n请选择“重新选择”换一个可写目录；或选择“打开目录”，在资源管理器中打开属性 → 安全 → 给当前账户授予“修改”权限，然后返回继续选择。',
        buttons: ['重新选择', '打开目录', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (permissionAction.response === 1) {
        try { await shell.openPath(move.path || selectedRoot); } catch (_) {}
        continue;
      }
      if (permissionAction.response === 0) continue;
      return Object.assign({}, move, { canceled: true });
    }
  } catch (error) {
    return { ok: false, code: 'choose_location_failed', error: error && error.message ? error.message : String(error) };
  }
});

// 渲染进程启动后查询存储层是否可用（用于 UI 提示，不影响主流程）
safeHandle('storage:available', () => {
  const available = !!getStorageService();
  return { ok: available, reason: available ? '' : (storageFailure || 'sqlite_unavailable'), fallback: 'state.json' };
});

safeHandle('storage:verifyMigration', () => {
  try {
    const info = dataLocation.describe({ defaultRoot: defaultUserDataRoot, activeRoot: app.getPath('userData') });
    const migration = info.migration || {};
    if (!migration.sourceRoot || !migration.targetRoot) return { ok: false, code: 'migration_not_found', status: 'unknown' };
    return dataLocation.verifyMigration({ pointerRoot: defaultUserDataRoot, sourceRoot: migration.sourceRoot, targetRoot: migration.targetRoot, migrationId: migration.id });
  } catch (error) { return { ok: false, code: 'migration_verify_failed', error: error && error.message ? error.message : String(error) }; }
});

safeHandle('storage:cleanupPreview', () => dataLocation.cleanupPreview({ defaultRoot: defaultUserDataRoot, activeRoot: app.getPath('userData') }));
safeHandle('storage:cleanupLegacy', (_e, input) => dataLocation.cleanupLegacy({ defaultRoot: defaultUserDataRoot, activeRoot: app.getPath('userData'), previewId: input && input.previewId }));

function redactBackupValue(value, key) {
  if (key && /api[_-]?key|authorization|password|secret|token|credential/i.test(String(key))) return undefined;
  if (Array.isArray(value)) return value.map((item) => redactBackupValue(item, '')).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const safe = redactBackupValue(childValue, childKey);
      if (safe !== undefined) out[childKey] = safe;
    }
    return out;
  }
  return value;
}

function readActiveStateObject() {
  const file = path.join(app.getPath('userData'), 'tangbao-data', 'state.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

safeHandle('storage:backup', async (_e, input) => {
  try {
    const state = readActiveStateObject();
    if (!state || typeof state !== 'object') return { ok: false, code: 'storage_state_missing', error: '暂无可备份数据' };
    const payload = { format: 'tangbao-backup', reportVersion: 2, createdAt: new Date().toISOString(), schemaVersion: 16, storage: dataLocation.describe({ defaultRoot: defaultUserDataRoot, activeRoot: app.getPath('userData') }), state: redactBackupValue(state) };
    const opts = input && typeof input === 'object' ? input : {};
    const chosen = opts.filePath ? String(opts.filePath) : '';
    const result = chosen ? { canceled: false, filePath: chosen } : await dialog.showSaveDialog(mainWindow(), { title: '导出糖包脱敏备份', defaultPath: 'tangbao-backup-' + new Date().toISOString().slice(0, 10) + '.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, filePath: result.filePath, includeSecrets: false, reportVersion: 2 };
  } catch (error) { return { ok: false, code: 'storage_backup_failed', error: error && error.message ? error.message : String(error) }; }
});

safeHandle('storage:diagnostics', async () => {
  try {
    const result = await dialog.showSaveDialog(mainWindow(), {
      title: '导出脱敏诊断包',
      defaultPath: 'tangbao-diagnostics-' + new Date().toISOString().slice(0, 10) + '.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const payload = {
      format: 'tangbao-diagnostics',
      reportVersion: 2,
      createdAt: new Date().toISOString(),
      appVersion: require('../../package.json').version,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron,
      storage: storageInfo(),
      secrets: typeof secrets.diagnose === 'function' ? secrets.diagnose() : null,
      note: '此诊断包不包含 API Key、Prompt、消息正文或模型输出。',
    };
    fs.writeFileSync(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, filePath: result.filePath, redacted: true };
  } catch (error) {
    return { ok: false, code: 'diagnostics_export_failed', error: error && error.message ? error.message : String(error) };
  }
});

safeHandle('storage:restore', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    const selected = opts.filePath ? { canceled: false, filePaths: [String(opts.filePath)] } : await dialog.showOpenDialog(mainWindow(), { title: '恢复糖包脱敏备份', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (selected.canceled || !selected.filePaths || !selected.filePaths.length) return { ok: false, canceled: true };
    const source = selected.filePaths[0];
    const parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
    const state = parsed && parsed.format === 'tangbao-backup' ? parsed.state : parsed;
    if (!state || typeof state !== 'object' || (!state.conversations && !state.settings)) return { ok: false, code: 'invalid_backup', error: '备份文件缺少有效的 conversations/settings' };
    const safeState = redactBackupValue(state);
    const dataDir = path.join(app.getPath('userData'), 'tangbao-data');
    fs.mkdirSync(dataDir, { recursive: true });
    const stateFile = path.join(dataDir, 'state.json');
    const previous = stateFile + '.before-restore-' + Date.now() + '.json';
    if (fs.existsSync(stateFile)) fs.copyFileSync(stateFile, previous);
    const temp = stateFile + '.restore.tmp';
    fs.writeFileSync(temp, JSON.stringify(safeState, null, 2), 'utf8');
    fs.renameSync(temp, stateFile);
    const svc = getStorageService();
    if (svc) {
      try { require('../infrastructure/storage/migrator').syncState(svc, storageFileRepo, safeState); } catch (_) {}
    }
    return { ok: true, restartRequired: true, backupFile: previous, includeSecrets: false };
  } catch (error) { return { ok: false, code: 'storage_restore_failed', error: error && error.message ? error.message : String(error) }; }
});

// 渲染进程把归一化后的 App.state 传过来，一次性灌入 SQLite（迁移器内部幂等 + 失败回滚）
safeHandle('storage:migrate', async (e, stateJson) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite', fallback: 'state.json', storageFailure };
    const userData = app.getPath('userData');
    const dataDir = path.join(userData, 'tangbao-data');
    let raw = '';
    try { raw = fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'); } catch (_) { /* 无 state.json 也能迁移（用传入的归一化对象） */ }
    const normalized = JSON.parse(stateJson);
    const migrator = require('../infrastructure/storage/migrator');
    return migrator.run(svc, storageFileRepo, { state: normalized, rawJson: raw, stateDir: dataDir });
  } catch (err) {
    return { ok: false, reason: 'migrate-error', error: err && err.message ? err.message : String(err) };
  }
});

// M4 写穿：把 App.state 整库替换进 SQLite（主数据源）。无 migrated_v1 门槛、幂等；
// 备份策略（M6）：canonical 缺失时直接写；已存在则每个启动周期轮转一次（保留最近 3 份带时间戳副本）。
safeHandle('storage:syncState', async (e, stateJson, revision) => {
  try {
    const gate = acceptStateRevision(stateJson, revision);
    if (!gate.ok) return gate;
    const normalized = JSON.parse(stateJson);
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite', fallback: 'state.json', storageFailure };
    const userData = app.getPath('userData');
    const dataDir = path.join(userData, 'tangbao-data');
    const bak = path.join(dataDir, 'state.v1.backup.json');
    const migrator = require('../infrastructure/storage/migrator');
      if (!fs.existsSync(bak)) {
        try { fs.writeFileSync(bak, stateJson || '{}', 'utf8'); } catch (_) { /* 备份失败不阻断同步 */ }
    } else if (!backupRotatedOnce) {
      backupRotatedOnce = true;
      migrator.rotateBackup(dataDir, stateJson || '{}', 3);
    }
      return Object.assign({}, migrator.syncState(svc, storageFileRepo, normalized), { revision: gate.revision });
  } catch (err) {
    return { ok: false, reason: 'sync-error', error: err && err.message ? err.message : String(err) };
  }
});

// 聊天修复：关闭前同步落盘（sendSync——主进程阻塞同步写 state.json + SQLite，杜绝防抖未送达的竞态丢数据）
// B2（P1）：改用 safeOn 加 assertTrustedSender 鉴权——修复裸 ipcMain.on 可被嵌入 iframe 无鉴权覆写 state.json + SQLite 的问题
safeOn('storage:flushSync', (e, stateJson, revision) => {
    try {
      const gate = acceptStateRevision(stateJson, revision);
      if (!gate.ok) {
        if (e && e.returnValue === undefined) e.returnValue = gate;
        return;
      }
      const userData = app.getPath('userData');
      const dataDir = path.join(userData, 'tangbao-data');
      const stateFile = path.join(dataDir, 'state.json');
      let fileError = null;
      try { writeStateFileAtomic(stateFile, String(stateJson || '{}')); } catch (error) { fileError = error; }
      const svc = getStorageService();
      let sqlite = { ok: false, reason: storageFailure || 'no-sqlite', fallback: 'state.json' };
      if (!fileError && svc && stateJson) {
      try {
        const migrator = require('../infrastructure/storage/migrator');
        const normalized = JSON.parse(stateJson);
        const syncResult = migrator.syncState(svc, storageFileRepo, normalized);
        sqlite = Object.assign({}, syncResult, { ok: !syncResult || syncResult.ok !== false });
      } catch (error) { sqlite = { ok: false, reason: 'sqlite_sync_failed', error: error && error.message ? error.message : String(error), fallback: 'state.json' }; }
      }
      if (e && e.returnValue === undefined) e.returnValue = fileError
        ? { ok: false, code: 'state_file_write_failed', error: fileError.message || String(fileError), revision: gate.revision }
        : { ok: true, revision: gate.revision, file: 'saved', sqlite };
  } catch (err) {
    if (e && e.returnValue === undefined) e.returnValue = { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

// M4 读源：从 SQLite 重建 App.state。空库/不可用 → ok:false（渲染层回退 state.json）。
// 新鲜度检查：只有 SQLite 的 synced_at 不早于 state.json mtime 才采用，防 debounce 窗口内 SQLite 落后。
safeHandle('storage:loadState', async () => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite', fallback: 'state.json', storageFailure };
    const userData = app.getPath('userData');
    const migrator = require('../infrastructure/storage/migrator');
    const r = migrator.readState(svc, storageFileRepo);
    if (!r.ok) return r;
    // 聊天修复 B：删除 synced_at vs state.json mtime 新鲜度判定（漏洞源——先前同步把
    // synced_at 推到 ≥mtime 后旧 SQLite 被误判 fresh）；SQLite 现仅作 state.json 缺失时的备份。
    return { ok: true, state: r.state };
  } catch (err) {
    return { ok: false, reason: 'load-error', error: err && err.message ? err.message : String(err) };
  }
});

// v1.1.6（糖读增强）：删除单篇文档（docs 行 + 文件仓 documents/{id} blob），防止删除后从 SQLite fallback 复活
safeHandle('storage:deleteDoc', async (_e, docId) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite', fallback: 'state.json', storageFailure };
    if (!docId || typeof docId !== 'string') return { ok: false, reason: 'invalid-id' };
    const store = require('../infrastructure/storage/sqlite-store');
    if (typeof store.StorageService.deleteDoc !== 'function') return { ok: false, reason: 'deleteDoc-unavailable' };
    store.StorageService.deleteDoc(docId);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'delete-failed', error: err && err.message ? err.message : String(err) };
  }
});

// M7（v1.0.8）：工作流运行历史独立持久化（不随 App.state 写穿；SQLite 不可用则静默降级）
safeHandle('storage:saveRun', async (_e, run) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite' };
    svc.saveWorkflowRun(run || {});
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'save-run-error', error: err && err.message ? err.message : String(err) };
  }
});

safeHandle('storage:listRuns', async (_e, workflowId, limit) => {
  try {
    const svc = getStorageService();
    if (!svc) return { ok: false, reason: 'no-sqlite', runs: [] };
    return { ok: true, runs: svc.listWorkflowRuns(workflowId, limit) };
  } catch (err) {
    return { ok: false, reason: 'list-runs-error', runs: [], error: err && err.message ? err.message : String(err) };
  }
});

// M6 导入导出：完整数据（含对话/图片/项目）备份为 JSON 文件，经系统文件对话框读写
safeHandle('storage:exportState', async () => {
  try {
    const userData = app.getPath('userData');
    const file = path.join(userData, 'tangbao-data', 'state.json');
    if (!fs.existsSync(file)) return { ok: false, error: '暂无数据可导出' };
    const data = fs.readFileSync(file, 'utf8');
    const r = await dialog.showSaveDialog(mainWindow(), {
      title: '导出糖包完整数据备份',
      defaultPath: 'tangbao-backup-' + new Date().toISOString().slice(0, 10) + '.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, data, 'utf8');
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

safeHandle('storage:importState', async () => {
  try {
    const r = await dialog.showOpenDialog(mainWindow(), {
      title: '导入糖包完整数据备份',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
    const data = fs.readFileSync(r.filePaths[0], 'utf8');
    const obj = JSON.parse(data);
    if (!obj || typeof obj !== 'object' || (!obj.conversations && !obj.settings)) {
      return { ok: false, error: '不是有效的糖包备份文件（缺少 conversations/settings）' };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

  return { getStorageService, readActiveStateObject, getStorageFileRepo };
}

module.exports = { createMainStorage };
