'use strict';
// Token 估算模块行为回归（v1.2.0 批次 2：补零覆盖模块 tokenizer.js）
const test = require('node:test');
const assert = require('node:assert');
const TokenEstimator = require('../../src/core/models/tokenizer.js');

test('空输入恒为 0', () => {
  assert.equal(TokenEstimator.estimateTokens(''), 0);
  assert.equal(TokenEstimator.estimateTokens(null), 0);
  assert.equal(TokenEstimator.estimateTokens(undefined), 0);
});

test('启发式口径：CJK 约 1.6 token/字、其余约 0.3 token/字符', () => {
  assert.equal(TokenEstimator.heuristicTokens('你好'), Math.ceil(2 * 1.6));
  // '你好abc' = 2 CJK + 3 other → ceil(3.2 + 0.9) = ceil(4.1) = 5
  assert.equal(TokenEstimator.heuristicTokens('你好abc'), Math.ceil(2 * 1.6 + 3 * 0.3));
  assert.equal(TokenEstimator.heuristicTokens(''), 0);
});

test('非字符串输入按 JSON 序列化计入', () => {
  const n = TokenEstimator.estimateTokens({ a: 1 });
  assert.ok(Number.isInteger(n) && n > 0, '对象输入应得到正整数 token 数');
});

test('同串重复估算稳定（LRU 记忆化），长文本单调不减', () => {
  const s = '糖包 token 估算回归测试'.repeat(8);
  const a = TokenEstimator.estimateTokens(s);
  const b = TokenEstimator.estimateTokens(s);
  assert.equal(a, b, '同一字符串两次结果必须一致（记忆化命中）');
  assert.ok(a > 0);
  assert.ok(TokenEstimator.estimateTokens(s + s) >= a, '更长文本 token 数不得更少');
});

test('hasRealTokenizer 返回布尔；无论真实/BPE 或启发式路径 estimateTokens 都为正整数', () => {
  assert.equal(typeof TokenEstimator.hasRealTokenizer(), 'boolean');
  const n = TokenEstimator.estimateTokens('hello world, 你好世界');
  assert.ok(Number.isInteger(n) && n > 0);
});
