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
let safeStorage = null;
let store = Object.create(null); // { ref: 明文 }
let encrypted = false;           // 当前落盘是否真的加密了
let loaded = false;

function fileHeader() {
  return { v: 1, enc: encrypted, data: '' };
}

function load() {
  store = Object.create(null);
  try {
    if (!fs.existsSync(filePath)) { loaded = true; return; }
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw.data !== 'string' || !raw.data) { loaded = true; return; }
    let json = '';
    if (raw.enc) {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
        console.error('[糖包·密钥库] 密文已存在但当前系统无法解密（密钥服务不可用），本次不加载。');
        loaded = true;
        return;
      }
      json = safeStorage.decryptString(Buffer.from(raw.data, 'base64'));
    } else {
      json = Buffer.from(raw.data, 'base64').toString('utf8');
    }
    const obj = JSON.parse(json);
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(obj)) {
        if (typeof obj[k] === 'string' && obj[k]) store[k] = obj[k];
      }
    }
  } catch (e) {
    console.error('[糖包·密钥库] 读取失败：', e && e.message ? e.message : e);
  }
  loaded = true;
}

function save() {
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
    try { fs.chmodSync(filePath, 0o600); } catch (_) { /* Windows 上无意义，忽略 */ }
    return true;
  } catch (e) {
    console.error('[糖包·密钥库] 写入失败：', e && e.message ? e.message : e);
    return false;
  }
}

/** 初始化。必须在 app.whenReady() 之后调用（safeStorage 依赖 app ready）。 */
function init(opts) {
  const o = opts || {};
  safeStorage = o.safeStorage || null;
  filePath = o.filePath || '';
  encrypted = !!(safeStorage && safeStorage.isEncryptionAvailable());
  load();
  return { encrypted, count: Object.keys(store).length };
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
    const json = raw.enc
      ? safeStorage.decryptString(Buffer.from(raw.data, 'base64'))
      : Buffer.from(raw.data, 'base64').toString('utf8');
    const probe = JSON.parse(json);
    if (!probe || probe[k] !== v) throw new Error('回读内容与写入不一致');
  } catch (e) {
    rollback();
    save(); // 尽力把文件恢复成回滚后的状态
    return { ok: false, error: '写入后校验失败：' + (e && e.message ? e.message : e) };
  }
  return { ok: true, encrypted };
}

function deleteSecret(ref) {
  const k = String(ref || '').trim();
  if (!k) return { ok: false, error: '缺少密钥标识' };
  if (!(k in store)) return { ok: true, encrypted };
  delete store[k];
  return { ok: save(), encrypted };
}

/** 批量删除：ref 前缀匹配（清空设置时用） */
function deleteByPrefix(prefix) {
  const p = String(prefix || '');
  if (!p) return { ok: false };
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
  hasSecret, listRefs, isEncrypted,
};
