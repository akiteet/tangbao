'use strict';

const path = require('path');
const crypto = require('crypto');

const WORKSPACE_VERSION = 2;

function id() { return crypto.randomUUID(); }
function cleanName(value, fallback) {
  const out = String(value || '').trim();
  return out || fallback || '文件夹';
}
function normalizePath(value) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) return '';
  return path.normalize(path.resolve(value));
}
function pathKey(value) {
  const norm = normalizePath(value);
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}
function containsPath(parent, child) {
  const a = normalizePath(parent); const b = normalizePath(child);
  if (!a || !b) return false;
  const rel = path.relative(a, b);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
function normalizeRoot(root, index) {
  const src = root && typeof root === 'object' ? root : {};
  const rootPath = normalizePath(src.path || src.cwd || '');
  if (!rootPath) throw Object.assign(new Error('无效的工作区文件夹路径'), { code: 'invalid_root_path' });
  return {
    rootId: String(src.rootId || src.id || id()),
    name: cleanName(src.name, path.basename(rootPath) || ('文件夹 ' + (index + 1))),
    path: rootPath,
  };
}
function assertDisjointRoots(roots) {
  const list = Array.isArray(roots) ? roots : [];
  const ids = new Set(); const paths = new Set();
  for (let i = 0; i < list.length; i++) {
    const root = list[i];
    if (!root.rootId || ids.has(root.rootId)) throw Object.assign(new Error('工作区 rootId 重复'), { code: 'duplicate_root_id' });
    ids.add(root.rootId);
    const key = pathKey(root.path);
    if (!key || paths.has(key)) throw Object.assign(new Error('工作区文件夹重复：' + root.path), { code: 'duplicate_root_path' });
    paths.add(key);
    for (let j = 0; j < i; j++) {
      if (containsPath(list[j].path, root.path) || containsPath(root.path, list[j].path)) {
        throw Object.assign(new Error('工作区文件夹不能互相包含：' + list[j].path + ' ↔ ' + root.path), { code: 'nested_root_path' });
      }
    }
  }
  return true;
}
function normalizeWorkspace(input, options) {
  const src = input && typeof input === 'object' ? input : {};
  const opts = options || {};
  let roots = Array.isArray(src.roots) ? src.roots.map(normalizeRoot) : [];
  const legacy = normalizePath(src.cwd || opts.cwd || '');
  if (!roots.length && legacy) roots = [normalizeRoot({ rootId: src.primaryRootId || opts.primaryRootId, name: src.name || opts.name, path: legacy }, 0)];
  if (!roots.length && !opts.allowEmpty) throw Object.assign(new Error('工作区至少需要一个文件夹'), { code: 'workspace_has_no_roots' });
  assertDisjointRoots(roots);
  let primaryRootId = String(src.primaryRootId || opts.primaryRootId || '');
  if (!roots.some((root) => root.rootId === primaryRootId)) primaryRootId = roots[0] ? roots[0].rootId : '';
  return { version: WORKSPACE_VERSION, name: cleanName(src.name || opts.name, '项目'), primaryRootId, roots };
}
function primaryRoot(workspace) {
  const ws = normalizeWorkspace(workspace, { allowEmpty: true });
  return ws.roots.find((root) => root.rootId === ws.primaryRootId) || ws.roots[0] || null;
}
function resolveRoot(workspace, rootId) {
  const ws = normalizeWorkspace(workspace, { allowEmpty: true });
  const wanted = String(rootId || ws.primaryRootId || '');
  return ws.roots.find((root) => root.rootId === wanted) || null;
}
function addRoot(workspace, root) {
  const ws = normalizeWorkspace(workspace, { allowEmpty: true });
  return normalizeWorkspace(Object.assign({}, ws, { roots: ws.roots.concat([normalizeRoot(root, ws.roots.length)]) }));
}
function removeRoot(workspace, rootId) {
  const ws = normalizeWorkspace(workspace);
  if (ws.roots.length <= 1) throw Object.assign(new Error('工作区至少保留一个文件夹'), { code: 'last_root' });
  const next = ws.roots.filter((root) => root.rootId !== String(rootId || ''));
  if (next.length === ws.roots.length) throw Object.assign(new Error('未找到工作区文件夹'), { code: 'unknown_root' });
  return normalizeWorkspace(Object.assign({}, ws, { roots: next, primaryRootId: ws.primaryRootId === rootId ? next[0].rootId : ws.primaryRootId }));
}
function renameRoot(workspace, rootId, name) {
  const ws = normalizeWorkspace(workspace);
  let found = false;
  const roots = ws.roots.map((root) => root.rootId === String(rootId || '') ? (found = true, Object.assign({}, root, { name: cleanName(name, root.name) })) : root);
  if (!found) throw Object.assign(new Error('未找到工作区文件夹'), { code: 'unknown_root' });
  return normalizeWorkspace(Object.assign({}, ws, { roots }));
}
function setPrimaryRoot(workspace, rootId) {
  const ws = normalizeWorkspace(workspace);
  if (!ws.roots.some((root) => root.rootId === String(rootId || ''))) throw Object.assign(new Error('未找到工作区文件夹'), { code: 'unknown_root' });
  return normalizeWorkspace(Object.assign({}, ws, { primaryRootId: String(rootId) }));
}
function fingerprint(workspace) {
  const ws = normalizeWorkspace(workspace, { allowEmpty: true });
  const stable = { version: ws.version, primaryRootId: ws.primaryRootId, roots: ws.roots.map((root) => ({ rootId: root.rootId, path: pathKey(root.path) })) };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}
function normalizeRootScope(scope) {
  const src = scope && typeof scope === 'object' ? scope : {};
  const mode = ['primary', 'single', 'all'].includes(src.mode) ? src.mode : 'primary';
  return { mode, rootId: mode === 'single' ? String(src.rootId || '') : '' };
}
function resolveRootScope(workspace, scope) {
  const ws = normalizeWorkspace(workspace);
  const normalized = normalizeRootScope(scope);
  let allowedRootIds;
  if (normalized.mode === 'all') allowedRootIds = ws.roots.map((root) => root.rootId);
  else if (normalized.mode === 'single') {
    if (!normalized.rootId || !ws.roots.some((root) => root.rootId === normalized.rootId)) {
      throw Object.assign(new Error('任务指定的项目文件夹不存在或已被移除'), { code: 'root_scope_invalid' });
    }
    allowedRootIds = [normalized.rootId];
  } else {
    if (!ws.primaryRootId) throw Object.assign(new Error('项目没有可用的主文件夹'), { code: 'primary_root_missing' });
    allowedRootIds = [ws.primaryRootId];
  }
  return { rootScope: normalized, allowedRootIds };
}
function rootAllowed(allowedRootIds, rootId) {
  return new Set((allowedRootIds || []).map(String)).has(String(rootId || ''));
}
function publicWorkspace(workspace, workspaceId) {
  const ws = normalizeWorkspace(workspace, { allowEmpty: true });
  const primary = primaryRoot(ws);
  return { workspaceId: String(workspaceId || ''), version: ws.version, name: ws.name, primaryRootId: ws.primaryRootId, roots: ws.roots.map((root) => Object.assign({}, root, { primary: root.rootId === ws.primaryRootId })), cwd: primary ? primary.path : '' };
}

module.exports = { WORKSPACE_VERSION, normalizePath, containsPath, normalizeWorkspace, assertDisjointRoots, primaryRoot, resolveRoot, normalizeRootScope, resolveRootScope, rootAllowed, addRoot, removeRoot, renameRoot, setPrimaryRoot, fingerprint, publicWorkspace };
