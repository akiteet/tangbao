'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const yauzl = require('yauzl');

const STANDARD_NAME_RE = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;
// v2（ZIP 兼容）：严格导入的命名规则放宽到 Unicode 安全集——允许中文等字母、数字、下划线、连字符，
// 长度 1-64；仍拒绝路径分隔符、引号、控制字符等非法字符（安全边界不放松）。
const COMPAT_NAME_RE = /^[\p{L}\p{N}_-]{1,64}$/u;
const LEGACY_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DEFAULT_LIMITS = Object.freeze({ maxFiles: 256, maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxDepth: 10, maxCompressionRatio: 120 });
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.css', '.html', '.xml', '.csv', '.toml', '.ini']);
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.py', '.sh']);

function skillError(code, message) {
  return Object.assign(new Error(message), { code });
}

function splitFrontmatter(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '');
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return { frontmatter: null, body: text.trim(), raw: text };
  let frontmatter;
  try { frontmatter = yaml.load(match[1]) || {}; }
  catch (error) { throw skillError('invalid_frontmatter', 'SKILL.md YAML frontmatter 无法解析：' + error.message); }
  if (!frontmatter || Array.isArray(frontmatter) || typeof frontmatter !== 'object') throw skillError('invalid_frontmatter', 'SKILL.md frontmatter 必须是对象');
  return { frontmatter, body: match[2].trim(), raw: text };
}

function normalizeTriggers(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 64);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean).slice(0, 64);
  return [];
}

function parseSkill(raw, fallbackName, options) {
  const opts = Object.assign({ strict: false }, options || {});
  const parsed = splitFrontmatter(raw);
  const fm = parsed.frontmatter || {};
  const name = String(fm.name || fallbackName || '').trim();
  const description = String(fm.description || '').trim();
  if (!name) throw skillError('missing_name', 'SKILL.md 缺少 name');
  if (!parsed.body) throw skillError('empty_body', 'SKILL.md 正文为空');
  if (opts.strict) {
    if (!COMPAT_NAME_RE.test(name)) throw skillError('invalid_name', '技能名须为 1-64 位字母、数字、下划线或连字符（支持中文等 Unicode），且不能包含路径、引号或控制字符');
    if (!description) throw skillError('missing_description', '标准 Skill 必须提供 description');
    if (description.length > 1024) throw skillError('description_too_long', 'description 不能超过 1024 字符');
    if (opts.directoryName && name !== opts.directoryName) throw skillError('name_mismatch', '技能目录名必须与 frontmatter name 一致');
  } else if (!LEGACY_NAME_RE.test(name)) {
    throw skillError('invalid_name', '技能名仅允许字母、数字、连字符或下划线（不超过 64 字符）');
  }
  const metadata = fm.metadata && typeof fm.metadata === 'object' && !Array.isArray(fm.metadata) ? fm.metadata : {};
  return {
    name,
    description,
    triggers: normalizeTriggers(fm.triggers),
    license: fm.license == null ? '' : String(fm.license),
    compatibility: fm.compatibility == null ? '' : String(fm.compatibility),
    metadata,
    allowedTools: fm['allowed-tools'] == null ? '' : String(fm['allowed-tools']),
    body: parsed.body,
    raw: parsed.raw,
    standard: !!parsed.frontmatter,
  };
}

function normalizeArchivePath(input, limits) {
  const opts = Object.assign({}, DEFAULT_LIMITS, limits || {});
  const raw = String(input || '').replace(/\\/g, '/');
  if (!raw || raw.includes('\0')) throw skillError('invalid_zip_path', 'ZIP 包含空路径或 NUL 字符');
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) throw skillError('zip_absolute_path', 'ZIP 包含绝对路径：' + raw);
  const directory = raw.endsWith('/');
  const parts = raw.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) throw skillError('zip_path_traversal', 'ZIP 路径越界：' + raw);
  if (parts.length > opts.maxDepth) throw skillError('zip_too_deep', 'ZIP 目录层级超过限制：' + raw);
  const normalized = parts.join('/') + (directory ? '/' : '');
  if (!normalized) throw skillError('invalid_zip_path', 'ZIP 包含无效路径');
  return normalized;
}

function isSymlinkEntry(entry) {
  const unixMode = (Number(entry.externalFileAttributes) >>> 16) & 0xffff;
  return (unixMode & 0xf000) === 0xa000;
}

function readZipPackage(zipPath, limits) {
  const opts = Object.assign({}, DEFAULT_LIMITS, limits || {});
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (openError, zipfile) => {
      if (openError) return reject(skillError('invalid_zip', '无法打开 ZIP：' + openError.message));
      const files = new Map();
      const seen = new Set();
      let totalBytes = 0;
      let fileCount = 0;
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch (_) {}
        reject(error && error.code ? error : skillError('invalid_zip', error && error.message ? error.message : String(error)));
      };
      zipfile.on('error', fail);
      zipfile.on('entry', (entry) => {
        try {
          const normalized = normalizeArchivePath(entry.fileName, opts);
          const isDirectory = normalized.endsWith('/');
          if ((entry.generalPurposeBitFlag & 0x1) !== 0) return fail(skillError('zip_encrypted', '不支持加密 ZIP 条目：' + normalized));
          if (isSymlinkEntry(entry)) return fail(skillError('zip_symlink', 'ZIP 不允许符号链接：' + normalized));
          const key = normalized.replace(/\/$/, '').toLowerCase();
          if (seen.has(key)) return fail(skillError('zip_duplicate_path', 'ZIP 包含重复或大小写冲突路径：' + normalized));
          seen.add(key);
          if (isDirectory) return zipfile.readEntry();
          fileCount += 1;
          if (fileCount > opts.maxFiles) return fail(skillError('zip_too_many_files', 'ZIP 文件数量超过限制（' + opts.maxFiles + '）'));
          const size = Number(entry.uncompressedSize) || 0;
          const compressed = Number(entry.compressedSize) || 0;
          if (size > opts.maxFileBytes) return fail(skillError('zip_file_too_large', 'ZIP 单文件超过限制：' + normalized));
          totalBytes += size;
          if (totalBytes > opts.maxTotalBytes) return fail(skillError('zip_too_large', 'ZIP 解压后总大小超过限制'));
          if (compressed > 0 && size / compressed > opts.maxCompressionRatio) return fail(skillError('zip_suspicious_ratio', 'ZIP 压缩比异常：' + normalized));
          zipfile.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail(streamError);
            const chunks = [];
            let actual = 0;
            stream.on('data', (chunk) => {
              actual += chunk.length;
              if (actual > opts.maxFileBytes || actual > size) { // B7（P3）：严格按声明大小校验，不再容忍 +1 越界
                stream.destroy(skillError('zip_entry_size_mismatch', 'ZIP 条目大小异常：' + normalized));
                return;
              }
              chunks.push(chunk);
            });
            stream.on('error', fail);
            stream.on('end', () => {
              if (settled) return;
              files.set(normalized, Buffer.concat(chunks));
              zipfile.readEntry();
            });
          });
        } catch (error) { fail(error); }
      });
      zipfile.on('end', () => {
        if (settled) return;
        settled = true;
        try {
          const manifest = packageFromFiles(files, { strict: true });
          resolve(Object.assign(manifest, { files, sourceType: 'zip', totalBytes, fileCount }));
        } catch (error) { reject(error); }
      });
      zipfile.readEntry();
    });
  });
}

function packageFromFiles(files, options) {
  const opts = Object.assign({ strict: true }, options || {});
  const paths = Array.from(files.keys()).filter((name) => !name.endsWith('/'));
  let prefix = '';
  if (!files.has('SKILL.md')) {
    const roots = new Set(paths.map((name) => name.split('/')[0]));
    if (roots.size !== 1) throw skillError('missing_skill_md', 'ZIP 根目录或唯一顶层技能目录中必须包含 SKILL.md');
    prefix = Array.from(roots)[0] + '/';
    if (!files.has(prefix + 'SKILL.md')) throw skillError('missing_skill_md', 'ZIP 顶层技能目录中缺少 SKILL.md');
  }
  const relativeFiles = paths.map((name) => {
    if (prefix && !name.startsWith(prefix)) throw skillError('mixed_zip_roots', 'ZIP 包含技能目录之外的文件：' + name);
    return name.slice(prefix.length);
  });
  if (relativeFiles.some((name) => !name)) throw skillError('invalid_zip_path', 'ZIP 包含无效文件名');
  const directoryName = prefix ? prefix.slice(0, -1) : '';
  // v2（ZIP 兼容）：唯一顶层目录只是分发包装层（GitHub 下载常带 -main/版本后缀），
  // 仅作 frontmatter 缺失时的 fallback 名，不再强制目录名 === name；
  // frontmatter name 始终权威，安装目标目录也始终用 frontmatter name。
  const skill = parseSkill(files.get(prefix + 'SKILL.md').toString('utf8'), directoryName || undefined, { strict: opts.strict });
  const resources = relativeFiles.filter((name) => name !== 'SKILL.md').sort().map((name) => ({
    path: name,
    kind: name.startsWith('scripts/') ? 'script' : name.startsWith('references/') ? 'reference' : name.startsWith('assets/') ? 'asset' : 'other',
    size: files.get(prefix + name).length,
  }));
  return { skill, prefix, resources, hasScripts: resources.some((item) => item.kind === 'script') };
}

async function readMarkdownPackage(filePath) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) throw skillError('invalid_source', '请选择 SKILL.md 或 Markdown 文件');
  if (stat.size > DEFAULT_LIMITS.maxFileBytes) throw skillError('skill_too_large', 'SKILL.md 超过大小限制');
  const raw = await fsp.readFile(filePath, 'utf8');
  const skill = parseSkill(raw, path.basename(filePath).replace(/\.md$/i, ''), { strict: true });
  return { skill, files: new Map([['SKILL.md', Buffer.from(raw, 'utf8')]]), resources: [], hasScripts: false, sourceType: 'markdown', totalBytes: Buffer.byteLength(raw), fileCount: 1, prefix: '' };
}

function packageForSource(filePath, limits) {
  return path.extname(filePath).toLowerCase() === '.zip' ? readZipPackage(filePath, limits) : readMarkdownPackage(filePath);
}

async function pathExists(target) {
  try { await fsp.access(target); return true; } catch (_) { return false; }
}

async function installPackage(pkg, targetRoot, options) {
  const opts = Object.assign({ replace: false }, options || {});
  const rename = typeof opts.rename === 'function' ? opts.rename : fsp.rename;
  const root = path.resolve(targetRoot);
  const target = path.join(root, pkg.skill.name);
  const nonce = crypto.randomBytes(6).toString('hex');
  const staging = path.join(root, '.tb-skill-stage-' + nonce);
  const backup = path.join(root, '.tb-skill-backup-' + nonce);
  let backupMade = false;
  let committed = false;
  let preserveBackup = false;
  await fsp.mkdir(root, { recursive: true });
  const exists = await pathExists(target);
  if (exists && !opts.replace) throw skillError('skill_exists', '技能已存在：' + pkg.skill.name);
  try {
    await fsp.mkdir(staging, { recursive: false });
    for (const [archivePath, content] of pkg.files.entries()) {
      const relative = pkg.prefix ? archivePath.slice(pkg.prefix.length) : archivePath;
      if (!relative || relative.endsWith('/')) continue;
      const output = path.resolve(staging, ...relative.split('/'));
      if (output !== staging && !output.startsWith(staging + path.sep)) throw skillError('zip_path_traversal', '安装路径越界：' + relative);
      await fsp.mkdir(path.dirname(output), { recursive: true });
      await fsp.writeFile(output, content);
    }
    const installedMeta = parseSkill(await fsp.readFile(path.join(staging, 'SKILL.md'), 'utf8'), pkg.skill.name, { strict: true, directoryName: pkg.skill.name });
    if (installedMeta.name !== pkg.skill.name) throw skillError('name_mismatch', '安装后的技能名不一致');
    if (exists) {
      await rename(target, backup);
      backupMade = true;
    }
    try {
      await rename(staging, target);
      committed = true;
    } catch (commitError) {
      if (backupMade && await pathExists(backup)) {
        try { await rename(backup, target); }
        catch (restoreError) {
          preserveBackup = true;
          const failure = skillError('skill_restore_failed', '新技能提交失败，且旧技能自动恢复失败；备份已保留：' + backup);
          failure.backupPath = backup;
          failure.cause = restoreError;
          throw failure;
        }
      }
      throw commitError;
    }
    if (backupMade && await pathExists(backup)) await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
    return { ok: true, name: pkg.skill.name, dir: target, sourceType: pkg.sourceType, resourceCount: pkg.resources.length, hasScripts: pkg.hasScripts };
  } finally {
    if (await pathExists(staging)) await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (!preserveBackup && committed && await pathExists(backup)) await fsp.rm(backup, { recursive: true, force: true }).catch(() => {});
  }
}

function resolveInside(root, relativePath) {
  const rel = String(relativePath || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || /^[A-Za-z]:\//.test(rel) || rel.split('/').includes('..')) throw skillError('invalid_resource_path', '资源路径非法');
  const base = path.resolve(root);
  const target = path.resolve(base, ...rel.split('/'));
  if (!target.startsWith(base + path.sep)) throw skillError('resource_path_traversal', '资源路径越界');
  return target;
}

async function listResources(skillDir) {
  const base = path.resolve(skillDir);
  const output = [];
  async function walk(dir, prefix, depth) {
    if (depth > DEFAULT_LIMITS.maxDepth) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = prefix ? prefix + '/' + entry.name : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel, depth + 1);
      else if (entry.isFile() && rel !== 'SKILL.md' && rel !== 'SKILL.md.disabled') {
        const stat = await fsp.stat(full);
        output.push({ path: rel.replace(/\\/g, '/'), kind: rel.startsWith('scripts/') ? 'script' : rel.startsWith('references/') ? 'reference' : rel.startsWith('assets/') ? 'asset' : 'other', size: stat.size });
      }
    }
  }
  await walk(base, '', 0);
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

async function readResource(skillDir, relativePath, options) {
  const opts = Object.assign({ offset: 0, maxChars: 12000 }, options || {});
  const target = resolveInside(skillDir, relativePath);
  const realBase = await fsp.realpath(skillDir);
  const realTarget = await fsp.realpath(target);
  if (!realTarget.startsWith(realBase + path.sep)) throw skillError('resource_symlink_escape', '资源链接逃逸技能目录');
  const stat = await fsp.stat(realTarget);
  if (!stat.isFile()) throw skillError('resource_not_file', '资源不是文件');
  const ext = path.extname(realTarget).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext) && path.basename(realTarget) !== 'SKILL.md') return { binary: true, size: stat.size, path: relativePath };
  const text = await fsp.readFile(realTarget, 'utf8');
  const offset = Math.max(0, Number(opts.offset) || 0);
  const maxChars = Math.max(256, Math.min(50000, Number(opts.maxChars) || 12000));
  return { binary: false, path: relativePath, size: stat.size, offset, content: text.slice(offset, offset + maxChars), nextOffset: offset + maxChars < text.length ? offset + maxChars : null, truncated: offset + maxChars < text.length };
}

function isSupportedScript(relativePath) {
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  return normalized.startsWith('scripts/') && SCRIPT_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

module.exports = {
  DEFAULT_LIMITS,
  STANDARD_NAME_RE,
  COMPAT_NAME_RE,
  parseSkill,
  normalizeArchivePath,
  packageFromFiles,
  readZipPackage,
  readMarkdownPackage,
  packageForSource,
  installPackage,
  listResources,
  readResource,
  resolveInside,
  isSupportedScript,
};
