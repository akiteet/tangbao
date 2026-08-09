'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function hash(value) { return crypto.createHash('sha256').update(value == null ? Buffer.alloc(0) : value).digest('hex'); }
function invalidPath() { return Object.assign(new Error('路径越界工作区'), { code: 'invalid_path' }); }
function comparable(value) { return process.platform === 'win32' ? String(value).toLowerCase() : String(value); }
function inside(root, target) {
  const rel = path.relative(root, target);
  const comparableRel = comparable(rel);
  return comparableRel !== '..' && !comparableRel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
function realCandidate(full) {
  try { return fs.realpathSync(full); }
  catch (error) {
    if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) throw error;
    // 新建文件/目录可能不存在：沿父目录向上找到最近的真实目录，
    // 再把不存在的尾部拼回去，从而识别工作区内的外部符号链接目录。
    const tail = [];
    let current = full;
    while (true) {
      try {
        const parentReal = fs.realpathSync(current);
        return path.resolve(parentReal, ...tail);
      } catch (parentError) {
        if (!parentError || (parentError.code !== 'ENOENT' && parentError.code !== 'ENOTDIR')) throw parentError;
        const parent = path.dirname(current);
        if (parent === current) throw error;
        tail.unshift(path.basename(current));
        current = parent;
      }
    }
  }
}
function resolveInside(root, rel) {
  const base = path.resolve(root); const full = path.resolve(base, String(rel || ''));
  if (full === base || !inside(base, full)) throw invalidPath();
  let realBase;
  try { realBase = fs.realpathSync(base); } catch (_) { throw invalidPath(); }
  let realTarget;
  try { realTarget = realCandidate(full); } catch (_) { throw invalidPath(); }
  if (!inside(realBase, realTarget)) throw invalidPath();
  return full;
}
function readSnapshot(file) { try { const content = fs.readFileSync(file); return { exists: true, content, hash: hash(content) }; } catch (e) { if (e.code === 'ENOENT') return { exists: false, content: null, hash: hash(null) }; throw e; } }
function plan(root, operations) {
  const plans = (operations || []).map((op, index) => {
    const type = String(op.type || 'write'); const file = resolveInside(root, op.path); const before = readSnapshot(file);
    if (op.expectedHash && op.expectedHash !== before.hash) throw Object.assign(new Error('文件哈希冲突：' + op.path), { code: 'hash_mismatch', path: op.path });
    let after = null; let target = null;
    if (type === 'delete') { if (!before.exists) throw Object.assign(new Error('文件不存在：' + op.path), { code: 'not_found' }); }
    else if (type === 'move') {
      target = resolveInside(root, op.to);
      if (!before.exists) throw Object.assign(new Error('文件不存在：' + op.path), { code: 'not_found' });
      // B6（P2）：目标已存在时预检——Windows rename 抛 EPERM、POSIX 静默覆盖，统一为明确拒绝（不覆盖）
      const targetSnap = readSnapshot(target);
      if (targetSnap.exists) throw Object.assign(new Error('目标文件已存在：' + op.to + '（拒绝覆盖，请先删除目标或换路径）'), { code: 'target_exists' });
      after = before.content;
    }
    else {
      after = op.encoding === 'base64'
        ? Buffer.from(String(op.content == null ? '' : op.content), 'base64')
        : Buffer.from(String(op.content == null ? '' : op.content));
      if (type === 'create' && before.exists) throw Object.assign(new Error('文件已存在：' + op.path), { code: 'already_exists' });
    }
    return { index, type, path: String(op.path), to: op.to ? String(op.to) : '', file, target, before, after, afterHash: hash(after) };
  });
  return { root: path.resolve(root), operations: plans, createdAt: Date.now() };
}
function atomicWrite(file, content, suffix) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.tangbao-' + suffix + '.tmp');
  fs.writeFileSync(temp, content); fs.renameSync(temp, file);
}
function restore(item, root) {
  let file = item.file;
  let target = item.target;
  if (root) {
    file = resolveInside(root, item.path);
    target = item.type === 'move' ? resolveInside(root, item.to) : null;
  }
  const destinations = [file, target].filter(Boolean);
  for (const file of destinations) { try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {} }
  if (item.before.exists) atomicWrite(file, item.before.content, 'restore');
}
function commit(tx, options) {
  const opts = options || {}; const committed = [];
  try {
    for (const item of tx.operations) {
      // Re-check the real path immediately before each filesystem operation.
      // The plan may have been created before an intermediate directory was replaced by a symlink.
      const file = resolveInside(tx.root, item.path);
      const target = item.type === 'move' ? resolveInside(tx.root, item.to) : null;
      const current = readSnapshot(file);
      if (current.hash !== item.before.hash) throw Object.assign(new Error('提交前文件已变化：' + item.path), { code: 'hash_mismatch' });
      if (opts.failAt === item.index) throw Object.assign(new Error('注入提交失败'), { code: 'injected_failure' });
      if (item.type === 'delete') fs.unlinkSync(file);
      else if (item.type === 'move') { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.renameSync(file, target); }
      else atomicWrite(file, item.after, String(item.index));
      committed.push(Object.assign({}, item, { file, target }));
    }
    return { ok: true, changes: tx.operations.map((item) => ({ type: item.type, path: item.path, to: item.to, beforeHash: item.before.hash, afterHash: item.afterHash, beforeExists: item.before.exists })) };
  } catch (error) {
    for (const item of committed.reverse()) { try { restore(item, tx.root); } catch (_) {} }
    return { ok: false, error: { code: error.code || 'commit_failed', message: error.message, retryable: error.code === 'hash_mismatch' }, rolledBack: committed.length };
  }
}
function rollback(root, changes) {
  const ordered = (changes || []).slice().reverse().map((change, index) => {
    const operation = String(change.operation || change.type || 'write');
    const currentPath = operation === 'move' ? (change.to || change.targetPath || change.path) : change.path;
    const file = resolveInside(root, currentPath);
    const original = resolveInside(root, change.path);
    return { index, change, operation, file, original, current: readSnapshot(file) };
  });
  const conflicts = ordered.filter((item) => item.change.afterHash && item.current.hash !== item.change.afterHash)
    .map((item) => item.operation === 'move' ? (item.change.to || item.change.targetPath) : item.change.path);
  if (conflicts.length) return { ok: false, conflicts, rolledBack: 0 };
  const applied = [];
  try {
    for (const item of ordered) {
      const beforeExists = item.change.beforeExists !== false && item.change.beforeContent != null;
      if (item.operation === 'create') {
        if (fs.existsSync(item.file)) fs.unlinkSync(item.file);
      } else if (item.operation === 'move') {
        if (fs.existsSync(item.file)) fs.unlinkSync(item.file);
        if (beforeExists) atomicWrite(item.original, Buffer.from(item.change.beforeContent, 'base64'), 'rollback-' + item.index);
      } else if (item.operation === 'delete') {
        if (beforeExists) atomicWrite(item.original, Buffer.from(item.change.beforeContent, 'base64'), 'rollback-' + item.index);
      } else if (beforeExists) {
        atomicWrite(item.original, Buffer.from(item.change.beforeContent, 'base64'), 'rollback-' + item.index);
      } else if (fs.existsSync(item.file)) {
        fs.unlinkSync(item.file);
      }
      applied.push(item);
    }
    return { ok: true, conflicts: [], rolledBack: applied.length };
  } catch (error) {
    return { ok: false, conflicts: [], rolledBack: applied.length, error: { code: 'rollback_failed', message: error.message, retryable: true } };
  }
}
function page(items, cursor, limit) { const start = Math.max(0, Number(cursor) || 0); const size = Math.min(200, Math.max(1, Number(limit) || 50)); const values = (items || []).slice(start, start + size); return { items: values, nextCursor: start + values.length < (items || []).length ? String(start + values.length) : null }; }
module.exports = { hash, resolveInside, readSnapshot, plan, commit, rollback, page };
