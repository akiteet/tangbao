'use strict';
/*
 * Token 估算统一模块（UMD 双环境单一事实源）
 *   - 渲染进程：<script> 加载（须在 context.js 之前），挂 window.App.TokenEstimator
 *   - 主进程（糖码后端 agent-server.js）：以 require 加载
 *
 * 消除前后端估算口径分裂（此前：前端 cl100k/启发式 vs 后端 字符数/4）。
 * 真实分词器：vendor/tokenizer.js（浏览器 IIFE，暴露 window.Tokenizer.countTokens，o200k_base）；
 * node 环境下临时注入 global.window 后 require，try/finally 还原，避免污染全局。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.App = window.App || {};
    window.App.TokenEstimator = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  let BPE = null;

  if (typeof window !== 'undefined' && window.Tokenizer && typeof window.Tokenizer.countTokens === 'function') {
    BPE = window.Tokenizer;
  } else if (typeof module !== 'undefined' && module.exports) {
    try {
      const g = (typeof globalThis !== 'undefined') ? globalThis : global;
      const prev = g.window;
      g.window = g.window || {};
      require('../../../vendor/tokenizer.js');
      if (g.window.Tokenizer && typeof g.window.Tokenizer.countTokens === 'function') BPE = g.window.Tokenizer;
      if (prev === undefined) delete g.window; else g.window = prev;
    } catch (e) { /* 加载失败回退启发式 */ }
  }

  // 混合中英文回退估算：CJK 约 1.6 token/字，其余约 0.3 token/字符（真实分词器不可用时使用）
  function heuristicTokens(text) {
    if (!text) return 0;
    const s = typeof text === 'string' ? text : JSON.stringify(text);
    const cjk = (s.match(/[一-鿿㐀-䶿]/g) || []).length;
    const other = s.length - cjk;
    return Math.ceil(cjk * 1.6 + other * 0.3);
  }

  function estimateTokens(text) {
    if (!text) return 0;
    const s = typeof text === 'string' ? text : JSON.stringify(text);
    // v1.1.5：LRU 记忆化——换会话/重进模块时 updateCtxBar 与压缩决策会对同一批
    // 消息文本反复分词（o200k BPE 是真实长任务），同串只算一次即可消除切换卡顿。
    const memo = estimateTokens._memo || (estimateTokens._memo = new Map());
    const hit = memo.get(s);
    if (hit !== undefined) {
      memo.delete(s); memo.set(s, hit); // 触碰移到队尾，维持 LRU 语义
      return hit;
    }
    let n;
    if (BPE) {
      try {
        const counted = BPE.countTokens(s);
        n = (typeof counted === 'number' && counted >= 0) ? counted : heuristicTokens(s);
      } catch (e) { n = heuristicTokens(s); /* 落到启发式 */ }
    } else {
      n = heuristicTokens(s);
    }
    memo.set(s, n);
    if (memo.size > 4000) memo.delete(memo.keys().next().value); // 淘汰最久未用
    return n;
  }

  function hasRealTokenizer() { return !!BPE; }

  return { estimateTokens, hasRealTokenizer, heuristicTokens };
});
