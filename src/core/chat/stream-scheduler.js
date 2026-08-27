'use strict';
/*
 * stream-scheduler —— 流式渲染节流调度器（v1.2.0 批次 7 第三刀，自 chat.js 抽出的纯时序逻辑）。
 * UMD 双环境：测试 require；渲染层挂 window.App.chatStreamBuffer。
 *
 * 语义（与 chat.js 原实现一致）：
 *   schedule() —— 合并触发：已有待触发的定时器则直接返回；否则 delayMs 后回调一次 flush。
 *   flushNow() —— 立即同步回调并清掉未触发的定时器（保证终态正确、不二次触发）。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof root !== 'undefined' && root.window) {
    root.window.App = root.window.App || {};
    root.window.App.chatStreamBuffer = mod;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.App = globalThis.App || {};
    globalThis.App.chatStreamBuffer = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createFlushScheduler(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const delayMs = Number(opts.delayMs) > 0 ? Number(opts.delayMs) : 120;
    const flush = typeof opts.flush === 'function' ? opts.flush : function () {};
    let timer = null;

    return {
      /** 合并触发：最多每 delayMs 回调一次 */
      schedule() {
        if (timer) return;
        timer = setTimeout(() => { timer = null; flush(); }, delayMs);
      },
      /** 立即同步 flush 并清除未触发定时器 */
      flushNow() {
        if (timer) { clearTimeout(timer); timer = null; }
        flush();
      },
      /** 是否有待触发的合并 flush（测试与诊断用） */
      hasPending() { return timer != null; },
    };
  }

  return { createFlushScheduler };
});
