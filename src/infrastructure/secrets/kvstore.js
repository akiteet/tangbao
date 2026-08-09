'use strict';
/*
 * 糖包 密钥库（主进程独占）
 *
 * 背景：1.0.6 之前 API Key 以明文躺在 state.json 和 localStorage 里，任何能读到用户
 * 目录的程序（甚至同步网盘、备份软件）都能直接拿走。
 *
 * 现在改为交给操作系统的密钥服务加密：
 *   Windows → DPAPI，macOS → Keychain，Linux → libsecret（Electron safeStorage 统一封装）
 *
 * 关键约束：渲染进程只有「写入 / 删除 / 询问是否存在」三个通道，没有任何读回明文的接口。
 * 真正用到密钥的地方（模型网关 server/gateway.js、糖码后端 server/agent-server.js）
 * 都在主进程里直接取，密钥全程不经过渲染层，也不进 IPC 回程消息。
 *
 * 密钥引用（ref）命名：
 *   acc:<accountId>   —— 设置里保存的账户
 *   custom:<module>   —— 某个模块「自定义填写」的独立密钥（module = chat/agent/image/doc/create/default）
 *   search            —— 联网搜索（Tavily）的可选 Key
 */
const fs = require('fs');
const path = require('path');

let filePath = '';
let legacyFilePaths = [];
let readPath = '';
let safeStorage = null;
let store = Object.create(null); // { ref: 明文 }
let encrypted = false;           // 当前落盘是否真的加密了
let loaded = false;
let loadState = 'uninitialized'; // empty | ready | unavailable
let loadCode = '';

function fileHeader() {
  return { v: 1, enc: encrypted, data: '' };
}

function setLoadFailure(code, error) {
  loaded = true;
  store = Object.create(null);
  loadState = 'unavailable';
  loadCode = String(code || 'secret_store_unavailable');
  const message = error && error.message ? error.message : error;
  if (message) console.error('[糖包·密钥库] ' + loadCode + '：', message);
}

function candidatePaths() {
  return [filePath].concat(legacyFilePaths).filter((value, index, list) => {
    if (!value) return false;
    const resolved = path.resolve(String(value));
    return list.findIndex((item) => item && path.resolve(String(item)) === resolved) === index;
  });
}

function decode(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.data !== 'string' || !raw.data) {
    throw Object.assign(new Error('密钥文件格式无效'), { code: 'secret_store_invalid' });
  }
  if (raw.enc) {
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function' || !safeStorage.isEncryptionAvailable()) {
      throw Object.assign(new Error('系统密钥服务不可用'), { code: 'secret_decrypt_unavailable' });
    }
    try {
      return safeStorage.decryptString(Buffer.from(raw.data, 'base64'));
    } catch (error) {
      throw Object.assign(new Error('当前 Windows 账户无法解密密钥文件'), { code: 'secret_decrypt_failed', cause: error });
    }
  }
  return Buffer.from(raw.data, 'base64').toString('utf8');
}

function load() {
  store = Object.create(null);
  readPath = candidatePaths().find((candidate) => {
    try { return fs.existsSync(candidate); } catch (_) { return false; }
  }) || '';
  if (!readPath) {
    loaded = true;
    loadState = 'empty';
    loadCode = '';
    return;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(readPath, 'utf8'));
    const json = decode(raw);
    const obj = JSON.parse(json);
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        if (typeof obj[k] === 'string' && obj[k]) store[k] = obj[k];
      }
    }
    encrypted = !!raw.enc;
    loaded = true;
    loadState = 'ready';
    loadCode = '';
  } catch (e) {
    setLoadFailure((e && e.code) || 'secret_store_invalid', e);
  }
  // 旧版本可能把密钥库放在 userData 根目录或默认 userData 下。
  // 读取成功后立即写到当前数据根，后续只使用当前路径。
  if (loadState === 'ready' && readPath !== filePath && filePath) {
    if (save()) readPath = filePath;
  }
}

function save() {
  if (!loaded || loadState === 'unavailable' || !filePath) return false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const json = JSON.stringify(store);
    const out = fileHeader();
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      out.enc = true;
      encrypted = true;
      out.data = safeStorage.encryptString(json).toString('base64');
    } else {
      // 系统密钥服务不可用（常见于没装 keyring 的 Linux）。
      // 这里不能静默丢弃用户的 Key，只能退化为 base64 明文存储，并明确标记 enc:false，
      // 由界面提示用户「当前系统无法加密存储密钥」。
      out.enc = false;
      encrypted = false;
      out.data = Buffer.from(json, 'utf8').toString('base64');
      console.error('[糖包·密钥库] 系统密钥服务不可用，密钥以未加密形式保存。');
    }
    // 先写临时文件再改名，避免写一半断电导致密钥文件损坏
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
    fs.renameSync(tmp, filePath);
    readPath = filePath;
    try { fs.chmodSync(filePath, 0o600); } catch (_) { /* Windows 上无意义，忽略 */ }
    return true;
  } catch (e) {
    try { fs.unlinkSync(filePath + '.tmp'); } catch (_) {}
    console.error('[糖包·密钥库] 写入失败：', e && e.message ? e.message : e);
    return false;
  }
}

/** 初始化。必须在 app.whenReady() 之后调用（safeStorage 依赖 app ready）。 */
function init(opts) {
  const o = opts || {};
  safeStorage = o.safeStorage || null;
  filePath = o.filePath ? path.resolve(String(o.filePath)) : '';
  legacyFilePaths = Array.isArray(o.legacyFilePaths)
    ? o.legacyFilePaths.filter((value) => value).map((value) => path.resolve(String(value)))
    : [];
  encrypted = !!(safeStorage && safeStorage.isEncryptionAvailable());
  loaded = false;
  loadState = 'uninitialized';
  loadCode = '';
  load();
  return Object.assign({ encrypted, count: Object.keys(store).length }, getStatus());
}

function getStatus() {
  return {
    state: loadState,
    code: loadCode,
    encrypted,
    count: Object.keys(store).length,
    source: readPath ? (readPath === filePath ? 'active' : 'legacy') : 'none',
  };
}

/** 仅供主进程内部使用，绝不经 IPC 暴露 */
function getSecret(ref) {
  if (!loaded) return '';
  return store[String(ref || '')] || '';
}

function setSecret(ref, value) {
  const k = String(ref || '').trim();
  const v = String(value == null ? '' : value);
  if (!k) return { ok: false, error: '缺少密钥标识' };
  if (!loaded || loadState === 'unavailable') {
    return { ok: false, code: loadCode || 'secret_store_unavailable', error: '密钥库无法读取，已保留原密钥文件' };
  }
  if (!v) return deleteSecret(k);

  // 失败要能原样退回，所以先记住这个 ref 原来的值
  const had = Object.prototype.hasOwnProperty.call(store, k);
  const prev = had ? store[k] : undefined;
  const rollback = () => { if (had) store[k] = prev; else delete store[k]; };

  store[k] = v;
  if (!save()) { rollback(); return { ok: false, error: '写入密钥文件失败' }; }

  // 写完立刻回读校验，确认加密/解密链路真的可用，避免用户以为存上了其实丢了
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const json = decode(raw);
    const probe = JSON.parse(json);
    if (!probe || probe[k] !== v) throw new Error('回读内容与写入不一致');
  } catch (e) {
    rollback();
    if (loadState !== 'unavailable') save(); // 尽力把文件恢复成回滚后的状态
    return { ok: false, code: (e && e.code) || 'secret_write_verify_failed', error: '写入后校验失败，原密钥已保留' };
  }
  loadState = 'ready';
  loadCode = '';
  return { ok: true, encrypted, count: Object.keys(store).length };
}

function deleteSecret(ref) {
  const k = String(ref || '').trim();
  if (!k) return { ok: false, error: '缺少密钥标识' };
  if (!loaded || loadState === 'unavailable') {
    return { ok: false, code: loadCode || 'secret_store_unavailable', error: '密钥库无法读取，未执行删除' };
  }
  if (!(k in store)) return { ok: true, encrypted };
  delete store[k];
  return { ok: save(), encrypted };
}

/** 批量删除：ref 前缀匹配（清空设置时用） */
function deleteByPrefix(prefix) {
  const p = String(prefix || '');
  if (!p) return { ok: false };
  if (!loaded || loadState === 'unavailable') {
    return { ok: false, code: loadCode || 'secret_store_unavailable', error: '密钥库无法读取，未执行删除' };
  }
  let hit = 0;
  for (const k of Object.keys(store)) {
    if (k.startsWith(p)) { delete store[k]; hit++; }
  }
  if (!hit) return { ok: true, removed: 0 };
  return { ok: save(), removed: hit };
}

function hasSecret(ref) {
  return !!store[String(ref || '')];
}

/** 只返回「有哪些 ref」，不返回任何明文 */
function listRefs() {
  return Object.keys(store);
}

function isEncrypted() {
  return encrypted;
}

module.exports = {
  init, getSecret, setSecret, deleteSecret, deleteByPrefix,
  hasSecret, listRefs, isEncrypted, getStatus,
};
