'use strict';
/*
 * 本地 HTTP 请求鉴权（主进程静态服务与糖码后端共用，v1.1.5 批次 C1 收敛）。
 *
 * 此前 tokenEqual/checkToken/isLoopbackHost 在 src/main/main.js 与
 * agent-runtime-engine.js 各有一份实现，属于最不该漂移的安全代码——
 * 两端必须同步修改，现在统一从这里引用。
 */
const crypto = require('crypto');

// 常数时间比较，避免用 === 比较令牌时被时序侧信道逐字节猜出
function tokenEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch (_) { return false; }
}

// 提取 Authorization: Bearer <token>；缺失或非 Bearer 方案返回 null
function bearerToken(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String((req && req.headers && req.headers.authorization) || '').trim());
  return m ? m[1] : null;
}

// 单次校验：expected 为期望令牌；为空表示独立调试模式（如 node server 单跑），此时放行。
// 适用于期望令牌在运行时才注入（let 变量）的调用方，如糖码后端的 AUTH_TOKEN。
function tokenMatches(req, expected) {
  const token = String(expected || '');
  if (!token) return true; // 独立调试模式
  const presented = bearerToken(req);
  return !!presented && tokenEqual(presented, token);
}

// 鉴权工厂：expected 为固定令牌（如主进程启动时随机生成的 LOCAL_TOKEN）时使用
function createTokenChecker(expected) {
  const token = String(expected || '');
  return function checkToken(req) {
    return tokenMatches(req, token);
  };
}

// DNS 重绑定防护：只接受 Host 明确指向回环地址的请求。
// 若攻击者用一个解析到 127.0.0.1 的域名（evil.com）诱导浏览器访问，Host 会是 evil.com，这里直接拒绝。
function isLoopbackHost(req) {
  const name = String((req && req.headers && req.headers.host) || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

module.exports = { tokenEqual, bearerToken, tokenMatches, createTokenChecker, isLoopbackHost };
