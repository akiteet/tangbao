'use strict';
/*
 * 糖绘图片资产存储（v1.1.5 批次 D1）。
 *
 * 把生成图片从 settings 内联 base64 迁到数据根 tangbao-data/images/ 目录文件：
 * - save/read/remove 三个原语，文件名服务端生成、扩展名按内容嗅探
 * - 名称白名单校验（拒绝 `..`、路径分隔符、绝对路径），渲染层永远拿不到任意路径能力
 * - 目录级配额（默认 500MB）：超限拒绝写入并返回 code:'quota'
 * 纯 Node 模块，主进程 IPC 处理器是它的薄包装；单测直接覆盖本模块。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_QUOTA_BYTES = 500 * 1024 * 1024;

// 常见图标格式魔数（base64 前几字节解码后比对）
function sniffImageMime(base64) {
  try {
    const head = Buffer.from(String(base64 || '').slice(0, 24), 'base64');
    if (head.length < 4) return null;
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
    if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 && head[8] === 0x57 && head[9] === 0x45) return 'image/webp';
    if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46) return 'image/gif';
    return null;
  } catch (_) { return null; }
}

const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function validAssetName(name) {
  const text = String(name || '');
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(text) && !text.includes('..');
}

function dirSizeBytes(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (_) { return 0; }
  for (const name of entries) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (stat.isFile()) total += stat.size;
    } catch (_) {}
  }
  return total;
}

function createImageAssetStore(options) {
  const opts = options || {};
  const dir = String(opts.dir || '');
  const quotaBytes = Number(opts.quotaBytes) > 0 ? Number(opts.quotaBytes) : DEFAULT_QUOTA_BYTES;
  if (!dir || !path.isAbsolute(dir)) throw new Error('image asset store requires an absolute dir');

  let knownBytes = null; // 惰性统计一次，之后增量累加

  const ensureDir = () => { fs.mkdirSync(dir, { recursive: true }); };

  const usedBytes = () => {
    if (knownBytes == null) knownBytes = dirSizeBytes(dir);
    return knownBytes;
  };

  function save(base64, extHint) {
    const data = String(base64 || '').replace(/^data:image\/[^;,]+;base64,/, '').replace(/\s+/g, '');
    if (!data || data.length < 8) return { ok: false, code: 'image_asset_empty' };
    if (!/^[A-Za-z0-9+/=]+$/.test(data)) return { ok: false, code: 'image_asset_not_base64' };
    const mime = sniffImageMime(data);
    const ext = (extHint && /^[a-z0-9]{2,5}$/i.test(String(extHint))) ? String(extHint).toLowerCase()
      : (mime && MIME_EXT[mime]) || 'png';
    const buffer = Buffer.from(data, 'base64');
    if (!buffer.length) return { ok: false, code: 'image_asset_empty' };
    ensureDir();
    if (usedBytes() + buffer.length > quotaBytes) {
      return { ok: false, code: 'quota', usedBytes: usedBytes(), quotaBytes };
    }
    const name = 'img-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + '.' + ext;
    fs.writeFileSync(path.join(dir, name), buffer);
    knownBytes = usedBytes() + buffer.length;
    return { ok: true, name, mime: mime || 'image/' + (ext === 'jpg' ? 'jpeg' : ext), bytes: buffer.length };
  }

  function read(name) {
    if (!validAssetName(name)) return { ok: false, code: 'image_asset_bad_name' };
    const file = path.resolve(dir, name);
    if (!file.startsWith(path.resolve(dir) + path.sep)) return { ok: false, code: 'image_asset_bad_name' };
    try {
      const buffer = fs.readFileSync(file);
      const base64 = buffer.toString('base64');
      const mime = sniffImageMime(base64) || 'image/png';
      return { ok: true, dataUrl: 'data:' + mime + ';base64,' + base64, mime, bytes: buffer.length };
    } catch (_) {
      return { ok: false, code: 'image_asset_not_found' };
    }
  }

  function remove(name) {
    if (!validAssetName(name)) return { ok: false, code: 'image_asset_bad_name' };
    const file = path.resolve(dir, name);
    if (!file.startsWith(path.resolve(dir) + path.sep)) return { ok: false, code: 'image_asset_bad_name' };
    try {
      const stat = fs.statSync(file);
      fs.unlinkSync(file);
      if (knownBytes != null) knownBytes = Math.max(0, knownBytes - stat.size);
      return { ok: true };
    } catch (_) {
      return { ok: false, code: 'image_asset_not_found' };
    }
  }

  return { dir, quotaBytes, save, read, remove, usedBytes };
}

module.exports = { createImageAssetStore, sniffImageMime, validAssetName, MIME_EXT, DEFAULT_QUOTA_BYTES };
