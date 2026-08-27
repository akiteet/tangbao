'use strict';
/*
 * stream-accumulator —— 流式回复的累积器所有权模块（v1.2.0 批次 7 第五刀）。
 * 拥有 acc/thinkAcc 两条文本流与节流调度（内部组合 stream-scheduler），
 * chat.js 只保留 DOM 渲染回调（onFlush）与 think 标签拆分。
 *
 * createStreamAccumulator(options):
 *   initialAcc / initialThink —— 恢复播种（liveMessage 已有内容时）
 *   flushDelayMs              —— 合并窗口（默认 120ms）
 *   onFlush({acc, think})     —— 节流到点或 flushNow 时回调（渲染层读状态重绘）
 * 返回：
 *   append(t)/appendThink(t)  —— 追加增量并调度合并 flush
 *   getAcc()/getThink()       —— 当前全文（saveAnswer/持久化读取）
 *   setAcc(v)/setThink(v)
 *   swapThinkIntoAcc()        —— 无正文但有思考时：思考转正（原 saveAnswer 内联语义）
 *   flushNow()                —— 立即同步 onFlush 并取消挂起定时器
 *   hasPending()
 */
(function (root, factory) {
  const makeScheduler = (root && root.window && root.window.App && root.window.App.chatStreamBuffer)
    ? root.window.App.chatStreamBuffer.createFlushScheduler
    : null;
  const mod = factory(makeScheduler || require('./stream-scheduler.js').createFlushScheduler);
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof root !== 'undefined' && root.window) {
    root.window.App.chatStreamAccumulator = mod;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.App = globalThis.App || {};
    globalThis.App.chatStreamAccumulator = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (createFlushScheduler) {
  function str(v) { return String(v == null ? '' : v); }

  function createStreamAccumulator(options) {
    const opts = options && typeof options === 'object' ? options : {};
    let acc = str(opts.initialAcc);
    let think = str(opts.initialThink);
    const onFlush = typeof opts.onFlush === 'function' ? opts.onFlush : function () {};
    const scheduler = createFlushScheduler({
      delayMs: opts.flushDelayMs,
      flush: () => { onFlush({ acc, think }); },
    });

    return {
      append(text) { acc += str(text); scheduler.schedule(); },
      appendThink(text) { think += str(text); scheduler.schedule(); },
      getAcc() { return acc; },
      getThink() { return think; },
      setAcc(v) { acc = str(v); },
      setThink(v) { think = str(v); },
      /** 无正文但有思考：思考转正为正文（原 saveAnswer 内联语义） */
      swapThinkIntoAcc() { if (!acc && think) { acc = think; think = ''; } },
      flushNow() { scheduler.flushNow(); },
      /** 合并触发透传（chat.js 集成点仍直接调用；append/appendThink 内部已自动调度） */
      schedule() { scheduler.schedule(); },
      hasPending() { return scheduler.hasPending(); },
    };
  }

  return { createStreamAccumulator };
});
