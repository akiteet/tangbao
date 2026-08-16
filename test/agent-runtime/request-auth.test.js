'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { tokenEqual, bearerToken, tokenMatches, createTokenChecker, isLoopbackHost } = require('../../src/infrastructure/http/request-auth');

function reqWith(headers) {
  return { headers: headers || {} };
}

test('tokenEqual：等长相同 true、等长不同 false、不等长 false、空输入两侧归一', () => {
  assert.equal(tokenEqual('abc123', 'abc123'), true);
  assert.equal(tokenEqual('abc123', 'abc124'), false);
  assert.equal(tokenEqual('short', 'a-much-longer-token'), false);
  assert.equal(tokenEqual('', ''), true); // 两侧都归一为零长 buffer，长度相等且 timingSafeEqual 通过
  assert.equal(tokenEqual(null, undefined), true); // 同上：String(a||'') 归一
  assert.equal(tokenEqual('secret', null), false); // 长度不等直接 false
});

test('bearerToken：大小写方案、缺失头、非 Bearer 方案', () => {
  assert.equal(bearerToken(reqWith({ authorization: 'Bearer tok-1' })), 'tok-1');
  assert.equal(bearerToken(reqWith({ authorization: 'bearer tok-1' })), 'tok-1'); // 方案名大小写不敏感
  assert.equal(bearerToken(reqWith({ authorization: '  Bearer   tok-2  ' })), 'tok-2');
  assert.equal(bearerToken(reqWith({})), null);
  assert.equal(bearerToken(reqWith({ authorization: 'Basic dXNlcjpwYXNz' })), null);
  assert.equal(bearerToken(null), null); // 容错：无 req/headers
});

test('tokenMatches：独立调试模式（期望为空）放行；令牌正确/错误判定正确', () => {
  assert.equal(tokenMatches(reqWith({}), ''), true); // 独立调试模式
  assert.equal(tokenMatches(reqWith({}), undefined), true);
  assert.equal(tokenMatches(reqWith({ authorization: 'Bearer right' }), 'right'), true);
  assert.equal(tokenMatches(reqWith({ authorization: 'Bearer wrong' }), 'right'), false);
  assert.equal(tokenMatches(reqWith({}), 'right'), false); // 未带令牌
});

test('createTokenChecker：固定令牌工厂（主进程 LOCAL_TOKEN 用法）', () => {
  const check = createTokenChecker('fixed-token');
  assert.equal(typeof check, 'function');
  assert.equal(check(reqWith({ authorization: 'Bearer fixed-token' })), true);
  assert.equal(check(reqWith({ authorization: 'Bearer other' })), false);
  assert.equal(check(reqWith({})), false);
  assert.equal(createTokenChecker('')(reqWith({})), true); // 期望为空仍走独立调试放行
});

test('isLoopbackHost：127.0.0.1 / localhost / ::1（含端口与方括号形式）通过，其他域名拒绝', () => {
  assert.equal(isLoopbackHost(reqWith({ host: '127.0.0.1' })), true);
  assert.equal(isLoopbackHost(reqWith({ host: '127.0.0.1:5177' })), true);
  assert.equal(isLoopbackHost(reqWith({ host: 'localhost' })), true);
  assert.equal(isLoopbackHost(reqWith({ host: 'localhost:3000' })), true);
  assert.equal(isLoopbackHost(reqWith({ host: '[::1]:3000' })), true);
  // 已知边界（与收敛前的两份原实现一致）：不带方括号和端口的裸 ::1 会被端口剥离正则误伤，
  // 实际浏览器/HTTP 客户端发送 IPv6 Host 时总是带 [::1]:port 形式，这里如实记录行为而非美化。
  assert.equal(isLoopbackHost(reqWith({ host: '::1' })), false);
  assert.equal(isLoopbackHost(reqWith({ host: 'evil.com' })), false); // DNS 重绑定：解析到回环的域名也拒绝
  assert.equal(isLoopbackHost(reqWith({ host: 'evil.com:3000' })), false);
  assert.equal(isLoopbackHost(reqWith({})), false); // 无 Host 视为不匹配
});
