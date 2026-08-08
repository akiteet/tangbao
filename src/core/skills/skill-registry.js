'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const SkillPackage = require('./skill-package');

const MANIFEST_FILE = '.tangbao-skill.json';
const TRUST_FILE = '.tangbao-trust.json';
const PRIVATE_FILES = new Set([MANIFEST_FILE, TRUST_FILE, 'SKILL.md.disabled']);

function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
async function exists(target) { try { await fsp.access(target); return true; } catch (_) { return false; } }

async function collectFiles(skillDir, options) {
  const opts = Object.assign({ includePrivate: false }, options || {});
  const root = path.resolve(skillDir); const files = [];
  async function walk(dir, prefix) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const rel = (prefix ? prefix + '/' : '') + entry.name;
      if (!opts.includePrivate && PRIVATE_FILES.has(rel)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) {
        const data = await fsp.readFile(full);
        files.push({ path: rel.replace(/\\/g, '/'), size: data.length, hash: sha256(data), data });
      }
    }
  }
  await walk(root, '');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function packageHash(skillDir) {
  const files = await collectFiles(skillDir);
  return sha256(Buffer.from(stableJson(files.map((item) => ({ path: item.path, size: item.size, hash: item.hash }))),'utf8'));
}

async function readSkillMeta(skillDir) {
  const enabledPath = path.join(skillDir, 'SKILL.md');
  const disabledPath = path.join(skillDir, 'SKILL.md.disabled');
  const file = await exists(enabledPath) ? enabledPath : disabledPath;
  if (!await exists(file)) throw Object.assign(new Error('技能目录缺少 SKILL.md'), { code: 'missing_skill_md' });
  return SkillPackage.parseSkill(await fsp.readFile(file, 'utf8'), path.basename(skillDir), { strict: false });
}

function manifestFromFiles(meta, files, details) {
  const installedAt = Number(details && details.installedAt) || Date.now();
  return {
    schemaVersion: 1, name: meta.name, version: String(meta.metadata.version || ''),
    license: meta.license || '', compatibility: meta.compatibility || '', metadata: meta.metadata || {},
    publisher: String((meta.metadata && meta.metadata.publisher) || ''), signature: String((meta.metadata && meta.metadata.signature) || ''),
    sourceType: String(details && details.sourceType || 'directory'), sourcePath: String(details && details.sourcePath || ''),
    scope: String(details && details.scope || ''), autoTrigger: details && details.autoTrigger === false ? false : true,
    installedAt, updatedAt: Date.now(),
    packageHash: sha256(Buffer.from(stableJson(files.map((item) => ({ path: item.path, size: item.size, hash: item.hash }))), 'utf8')),
    files: files.map((item) => ({ path: item.path, size: item.size, hash: item.hash })),
    resources: files.filter((item) => item.path !== 'SKILL.md').map((item) => ({ path: item.path, size: item.size, hash: item.hash, kind: item.path.startsWith('scripts/') ? 'script' : item.path.startsWith('references/') ? 'reference' : item.path.startsWith('assets/') ? 'asset' : 'other' })),
  };
}
async function buildManifest(skillDir, details) {
  const meta = await readSkillMeta(skillDir); const files = await collectFiles(skillDir);
  return manifestFromFiles(meta, files, details);
}
function manifestFromPackage(pkg, details) {
  const files = [];
  for (const [archivePath, data] of pkg.files.entries()) {
    const rel = pkg.prefix ? archivePath.slice(pkg.prefix.length) : archivePath;
    if (!rel || rel.endsWith('/')) continue;
    files.push({ path: rel, size: data.length, hash: sha256(data) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return manifestFromFiles(pkg.skill, files, details);
}

async function writeManifest(skillDir, details) {
  const old = await readManifest(skillDir);
  const manifest = await buildManifest(skillDir, Object.assign({}, details || {}, { installedAt: old && old.installedAt }));
  const target = path.join(skillDir, MANIFEST_FILE); const temp = target + '.tmp-' + process.pid;
  await fsp.writeFile(temp, JSON.stringify(manifest, null, 2), 'utf8'); await fsp.rename(temp, target);
  return manifest;
}
async function readManifest(skillDir) {
  try { const value = JSON.parse(await fsp.readFile(path.join(skillDir, MANIFEST_FILE), 'utf8')); return value && typeof value === 'object' ? value : null; }
  catch (_) { return null; }
}

function diffManifests(before, after) {
  const oldMap = new Map(((before && before.files) || []).map((item) => [item.path, item]));
  const newMap = new Map(((after && after.files) || []).map((item) => [item.path, item]));
  const added = [], removed = [], changed = [];
  for (const [name, item] of newMap) { if (!oldMap.has(name)) added.push(name); else if (oldMap.get(name).hash !== item.hash) changed.push(name); }
  for (const name of oldMap.keys()) if (!newMap.has(name)) removed.push(name);
  const oldScripts = new Set(((before && before.resources) || []).filter((item) => item.kind === 'script').map((item) => item.path));
  const newScripts = ((after && after.resources) || []).filter((item) => item.kind === 'script').map((item) => item.path);
  return { added, removed, changed, addedScripts: newScripts.filter((name) => !oldScripts.has(name)), hashChanged: !!before && before.packageHash !== after.packageHash };
}

const CRC_TABLE = (() => { const table = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
function crc32(buffer) { let c = 0xffffffff; for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipDate(date) { const d = date || new Date(); return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2), day: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; }
async function exportStandardZip(skillDir, outputPath) {
  const meta = await readSkillMeta(skillDir); const files = await collectFiles(skillDir); const local = [], central = []; let offset = 0; const stamp = zipDate();
  for (const file of files) {
    const name = Buffer.from(meta.name + '/' + file.path.replace(/\\/g, '/'), 'utf8'); const data = file.data; const crc = crc32(data);
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(0, 8); head.writeUInt16LE(stamp.time, 10); head.writeUInt16LE(stamp.day, 12); head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26);
    local.push(head, name, data);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x800, 8); dir.writeUInt16LE(0, 10); dir.writeUInt16LE(stamp.time, 12); dir.writeUInt16LE(stamp.day, 14); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(0, 38); dir.writeUInt32LE(offset, 42); central.push(dir, name); offset += head.length + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16);
  const temp = outputPath + '.tmp-' + process.pid; await fsp.writeFile(temp, Buffer.concat([...local, centralBuffer, end])); await fsp.rename(temp, outputPath);
  return { ok: true, filePath: outputPath, packageHash: await packageHash(skillDir), files: files.length };
}

async function uninstall(skillDir, quarantineRoot) {
  const dir = path.resolve(skillDir);
  const meta = await readSkillMeta(dir);
  // v2（管理身份）：目录名允许与 name 不一致（GitHub -main 别名等），权限边界由 main.js 的可管理枚举保障；
  // 隔离目录以 frontmatter name + 时间戳命名，避免同名冲突。
  const root = path.resolve(quarantineRoot); await fsp.mkdir(root, { recursive: true });
  const dest = path.join(root, meta.name + '-' + Date.now());
  try {
    await fsp.rename(dir, dest);
  } catch (err) {
    // v1.1.0（修复）：项目级 Skill 与隔离区跨盘（EXDEV）或 Windows 占用（EPERM/EBUSY）时回退复制+删除，
    // 否则仅项目级（跨盘）Skill 卸载会静默失败，用户感知为"点卸载无反应"。
    if (err && ['EXDEV', 'EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
      await fsp.cp(dir, dest, { recursive: true, force: true });
      await fsp.rm(dir, { recursive: true, force: true });
    } else throw err;
  }
  return { ok: true, name: meta.name, quarantinePath: dest };
}

async function packageFromDirectory(skillDir, options) {
  const opts = Object.assign({ strict: true }, options || {});
  const dir = path.resolve(skillDir);
  const meta = await readSkillMeta(dir);
  // v2（ZIP 兼容）：目录名允许与 frontmatter name 不一致（GitHub -main 别名等），name 以 frontmatter 权威。
  const files = await collectFiles(dir);
  const map = new Map(files.map((item) => [item.path, item.data]));
  return Object.assign(SkillPackage.packageFromFiles(map, { strict: opts.strict }), {
    files: map, sourceType: String(opts.sourceType || 'directory'), sourcePath: dir,
    totalBytes: files.reduce((sum, item) => sum + item.size, 0), fileCount: files.length,
  });
}

async function setAutoTrigger(skillDir, enabled) {
  const current = await readManifest(skillDir);
  return writeManifest(skillDir, {
    installedAt: current && current.installedAt,
    sourceType: current && current.sourceType,
    sourcePath: current && current.sourcePath,
    scope: current && current.scope,
    autoTrigger: enabled !== false,
  });
}

async function detectExternalSkills(cwd) {
  const roots = [['claude', path.join(cwd, '.claude', 'skills')], ['codex', path.join(cwd, '.codex', 'skills')]]; const output = [];
  for (const [source, root] of roots) {
    let entries = []; try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) if (entry.isDirectory()) {
      try {
        const dir = path.join(root, entry.name); const meta = await readSkillMeta(dir);
        output.push({ source, name: meta.name, dir, description: meta.description, packageHash: await packageHash(dir) });
      } catch (_) {}
    }
  }
  return output;
}

// v2（生命周期）：完整管理枚举——列出所有已安装 Skill 实例（不去重、不要求目录名=name）。
// roots: [{ scope: 'user'|'project', dir }]；返回 [{ name, dir, scope, enabled, description }]。
// 与运行时 scanSkills（同名去重、只保留生效项）分离：管理操作必须以本枚举为准，
// 否则被覆盖实例、GitHub -main 别名目录、.claude/.codex 合法变体都无法被卸载/移动。
async function enumerateInstalled(roots) {
  const output = [];
  const seenDirs = new Set();
  for (const root of (roots || [])) {
    if (!root || !root.dir) continue;
    const base = path.resolve(root.dir);
    let entries = [];
    try { entries = await fsp.readdir(base, { withFileTypes: true }); } catch (_) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      const norm = path.normalize(dir);
      if (seenDirs.has(norm)) continue;
      seenDirs.add(norm);
      try {
        const enabledPath = path.join(dir, 'SKILL.md');
        const disabledPath = path.join(dir, 'SKILL.md.disabled');
        let raw = null, enabled = true;
        if (await exists(enabledPath)) { raw = await fsp.readFile(enabledPath, 'utf8'); enabled = true; }
        else if (await exists(disabledPath)) { raw = await fsp.readFile(disabledPath, 'utf8'); enabled = false; }
        if (raw == null) continue;
        const meta = SkillPackage.parseSkill(raw, entry.name, { strict: false });
        output.push({
          name: meta.name,
          dir: norm,
          scope: String(root.scope || 'user'),
          enabled,
          description: meta.description,
        });
      } catch (_) {}
    }
  }
  return output.sort((a, b) => a.name.localeCompare(b.name) || a.dir.localeCompare(b.dir));
}

function annotateDuplicateResolution(instances, orderedRoots) {
  const rows = Array.isArray(instances) ? instances : [];
  const roots = (orderedRoots || []).map((root, index) => ({
    scope: String(root && (root.scope || root.level) || ''),
    dir: path.resolve(String(root && root.dir || '')),
    label: String(root && root.label || ''),
    index,
  }));
  const scopeFallback = { project: 1000, user: 2000, builtin: 3000 };
  const priorityOf = (item) => {
    const itemDir = path.resolve(String(item && item.dir || ''));
    const parent = path.dirname(itemDir);
    const root = roots.find((candidate) => candidate.dir === parent && (!candidate.scope || candidate.scope === String(item && (item.scope || item.level) || '')));
    return {
      index: root ? root.index : (scopeFallback[String(item && (item.scope || item.level) || '')] || 9000),
      label: root && root.label ? root.label : String(item && (item.scope || item.level) || '未知来源'),
      dir: itemDir,
    };
  };
  const groups = new Map();
  rows.forEach((item) => {
    const key = String(item && item.name || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  const resolved = new Map();
  for (const group of groups.values()) {
    const ranked = group.slice().sort((a, b) => {
      const pa = priorityOf(a), pb = priorityOf(b);
      return pa.index - pb.index || pa.dir.localeCompare(pb.dir);
    });
    const effective = ranked.find((item) => item.enabled !== false) || null;
    const effectivePriority = effective ? priorityOf(effective) : null;
    for (const item of group) {
      const priority = priorityOf(item);
      const isEffective = !!effective && item === effective;
      const disabled = item.enabled === false;
      resolved.set(item, Object.assign({}, item, {
        duplicateCount: group.length,
        effective: isEffective,
        resolution: disabled ? 'disabled' : (isEffective ? 'effective' : 'covered'),
        priorityLabel: priority.label,
        coveredBy: !isEffective && effective ? {
          name: effective.name,
          scope: String(effective.scope || effective.level || ''),
          dir: effective.dir,
          priorityLabel: effectivePriority && effectivePriority.label || '',
        } : null,
      }));
    }
  }
  return rows.map((item) => resolved.get(item) || item);
}

async function copyRecursive(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await copyRecursive(from, to);
    else if (entry.isFile()) await fsp.copyFile(from, to);
  }
}

// v2（等级移动）：项目级 ↔ 用户级原子移动，保留启停/信任/自动触发/资源（整目录搬运）。
// 同盘走 rename（原子）；跨盘走 staging 复制 + 哈希复验 + 删除源（失败不删源）。
// replace=true 且目标同名时：目标先入 backup，成功后删除；失败恢复目标且源保持不动。
// 移动成功后按 opts.scope 重写私有清单 scope 字段。
async function moveSkill(fromDir, toRoot, options) {
  const opts = Object.assign({ replace: false, scope: '' }, options || {});
  const rename = typeof opts.rename === 'function' ? opts.rename : fsp.rename;
  const src = path.resolve(fromDir);
  const meta = await readSkillMeta(src);
  const root = path.resolve(toRoot);
  const target = path.join(root, meta.name);
  const targetExists = fs.existsSync(target);
  if (targetExists && !opts.replace) throw Object.assign(new Error('目标范围已存在同名技能「' + meta.name + '」，请先卸载或替换'), { code: 'skill_exists' });
  await fsp.mkdir(root, { recursive: true });
  const nonce = crypto.randomBytes(6).toString('hex');
  const backup = path.join(root, '.tb-skill-backup-' + nonce);
  let backupMade = false;
  let committed = false;
  let preserveBackup = false;
  try {
    if (targetExists) {
      await rename(target, backup);
      backupMade = true;
    }
    try {
      await rename(src, target);
      committed = true;
    } catch (moveError) {
      // 跨盘（EXDEV）→ staging 复制 + 哈希复验 + 删除源
      if (moveError && (moveError.code === 'EXDEV' || moveError.code === 'cross-device' || moveError.code === 'ENOSYS')) {
        const staging = path.join(root, '.tb-skill-stage-' + nonce);
        try {
          await copyRecursive(src, staging);
          const srcHash = await packageHash(src);
          const stageHash = await packageHash(staging);
          if (srcHash !== stageHash) throw Object.assign(new Error('跨盘移动哈希复验失败'), { code: 'hash_mismatch' });
          await rename(staging, target);
          await fsp.rm(src, { recursive: true, force: true });
          committed = true;
        } catch (stagingError) {
          // B6（P2）：跨盘复制/校验失败——恢复已移走的旧技能（与非 EXDEV 分支一致），避免备份目录孤儿
          if (backupMade && fs.existsSync(backup)) {
            try { await rename(backup, target); backupMade = false; }
            catch (restoreError) {
              preserveBackup = true;
              const failure = Object.assign(new Error('Skill 跨盘移动失败且旧技能恢复失败，备份已保留：' + backup), { code: 'skill_restore_failed' });
              failure.backupPath = backup;
              failure.cause = restoreError;
              throw failure;
            }
          }
          throw stagingError;
        } finally {
          if (fs.existsSync(staging)) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
        }
      } else {
        if (backupMade && fs.existsSync(backup)) {
          try { await rename(backup, target); }
          catch (restoreError) {
            preserveBackup = true;
            const failure = Object.assign(new Error('Skill 移动失败且旧技能恢复失败，备份已保留：' + backup), { code: 'skill_restore_failed' });
            failure.backupPath = backup;
            failure.cause = restoreError;
            throw failure;
          }
        }
        throw moveError;
      }
    }
    if (backupMade && fs.existsSync(backup)) await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
    // 重写私有清单 scope（保留来源/自动触发/安装时间），trust/启停状态随目录整体保留
    if (opts.scope) {
      const current = await readManifest(target) || {};
      await writeManifest(target, {
        scope: opts.scope,
        sourceType: current.sourceType,
        sourcePath: current.sourcePath,
        autoTrigger: current.autoTrigger !== false,
        installedAt: current.installedAt,
      });
    }
    return { ok: true, name: meta.name, dir: target, scope: opts.scope || '', sourceDir: src };
  } finally {
    if (!preserveBackup && committed && fs.existsSync(backup)) await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
  }
}

// v2（F 批）：隔离区（已卸载 Skill）列出与恢复
async function listQuarantine(quarantineRoot) {
  const root = path.resolve(quarantineRoot);
  let entries = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch (_) { return []; }
  const output = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const meta = await readSkillMeta(dir);
      const tsMatch = /-(\d+)$/.exec(entry.name);
      let scope = 'user';
      try { const manifest = await readManifest(dir); if (manifest && (manifest.scope === 'project' || manifest.scope === 'user')) scope = manifest.scope; } catch (_) {}
      output.push({
        name: meta.name, quarantinePath: dir, dir,
        description: meta.description, scope,
        movedAt: tsMatch ? Number(tsMatch[1]) : 0,
        quarantineName: entry.name,
      });
    } catch (_) {}
  }
  return output.sort((a, b) => b.movedAt - a.movedAt);
}

async function restoreFromQuarantine(quarantinePath, targetRoot) {
  const src = path.resolve(quarantinePath);
  const meta = await readSkillMeta(src);
  const root = path.resolve(targetRoot);
  const target = path.join(root, meta.name);
  if (fs.existsSync(target)) throw Object.assign(new Error('已存在同名技能「' + meta.name + '」，请先卸载或替换现有技能'), { code: 'skill_exists' });
  await fsp.mkdir(root, { recursive: true });
  try {
    await fsp.rename(src, target);
  } catch (err) {
    // v1.1.0（修复）：项目级恢复跨盘（EXDEV）或 Windows 占用（EPERM/EBUSY）时回退复制+删除（与 uninstall 对称），
    // 否则项目级 Skill 卸载后无法从隔离区恢复。
    if (err && ['EXDEV', 'EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
      await fsp.cp(src, target, { recursive: true, force: true });
      await fsp.rm(src, { recursive: true, force: true });
    } else throw err;
  }
  return { ok: true, name: meta.name, dir: target };
}

module.exports = { MANIFEST_FILE, TRUST_FILE, collectFiles, packageHash, buildManifest, manifestFromPackage, packageFromDirectory, writeManifest, readManifest, diffManifests, exportStandardZip, uninstall, moveSkill, setAutoTrigger, detectExternalSkills, enumerateInstalled, annotateDuplicateResolution, listQuarantine, restoreFromQuarantine, readSkillMeta };
