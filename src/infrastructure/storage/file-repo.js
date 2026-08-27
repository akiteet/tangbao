'use strict';
/*
 * 糖包 文件仓（主进程独占，纯 Node，无原生依赖）
 *
 * 用途：存放体积较大、不应塞进 SQLite 行内的二进制/文本载荷：
 *   images / documents / thumbnails / exports / logs / changesets
 * 目录：userData/tangbao-data/files/<category>/<id>
 *
 * 所有写入都在 userData 子树内，id 仅允许 [\w.\-]，杜绝路径穿越。
 */
const fs = require('fs');
const path = require('path');

const CATEGORIES = ['images', 'documents', 'thumbnails', 'exports', 'logs', 'changesets'];

let base = '';

function init(rootDir) {
  base = path.join(rootDir, 'tangbao-data', 'files');
  for (const c of CATEGORIES) {
    try { fs.mkdirSync(path.join(base, c), { recursive: true }); } catch (_) { /* ignore */ }
  }
  return { base, categories: CATEGORIES.slice() };
}

function _resolve(category, id) {
  if (!CATEGORIES.includes(category)) throw new Error('未知文件仓分类: ' + category);
  const sid = String(id == null ? '' : id);
  // v1.2.0 批次 2 修复：原正则放行纯点号 id（'..' 经 path.join 可目录穿越）
  if (!/^[\w][\w.\-]*$/.test(sid) || sid.includes('..')) throw new Error('非法文件 id: ' + sid);
  return path.join(base, category, sid);
}

// buf: Buffer 或 string
function put(category, id, buf) {
  const f = _resolve(category, id);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
  return f;
}

function get(category, id) {
  try { return fs.readFileSync(_resolve(category, id)); } catch (_) { return null; }
}

function has(category, id) {
  try { return fs.existsSync(_resolve(category, id)); } catch (_) { return false; }
}

function remove(category, id) {
  try { fs.unlinkSync(_resolve(category, id)); return true; } catch (_) { return false; }
}

function categoryDir(category) {
  if (!CATEGORIES.includes(category)) throw new Error('未知文件仓分类: ' + category);
  return path.join(base, category);
}

/** M6：列出某分类下的全部文件名（GC 用）。 */
function list(category) {
  if (!CATEGORIES.includes(category)) throw new Error('未知文件仓分类: ' + category);
  try { return fs.readdirSync(path.join(base, category)); } catch (_) { return []; }
}

module.exports = { init, put, get, has, remove, categoryDir, list, CATEGORIES };
