'use strict';
/* 统一 IPC 调用入口（v1.1.5 批次 C3 收敛）。
 * 此前 fs.js / skills.js / module-sessions.js 各写一份 window.electron 容错包装，语义漂移。
 * 统一规则：
 * - 方法不存在 → 返回调用方给定的 fallback（各服务保留自己的降级形状）
 * - 调用异常 → fallback 浅合并 { ok:false, code, error }（错误信息不吞）
 * - invokeSync 成功时原样返回（含 Promise，由调用方决定是否 await）
 * - invoke（异步版）等待结果后做对象校验，非对象结果回落 fallback
 */
(function () {
  App.services = App.services || {};
  const method = (name) => (window.electron && typeof window.electron[name] === 'function') ? window.electron[name] : null;
  const failShape = (fallback, e) => Object.assign({}, fallback, {
    ok: false,
    code: (e && e.code) || 'ipc_failed',
    error: String(e && e.message ? e.message : e),
  });
  App.services.ipc = {
    available(name) { return !!method(name); },
    invokeSync(name, args, fallback) {
      const fn = method(name);
      if (!fn) return fallback;
      try { return fn.apply(window.electron, args || []); } catch (e) { return failShape(fallback, e); }
    },
    async invoke(name, args, fallback) {
      const fn = method(name);
      if (!fn) return fallback;
      try {
        const result = await fn.apply(window.electron, args || []);
        return result && typeof result === 'object' ? result : fallback;
      } catch (e) { return failShape(fallback, e); }
    },
  };
})();
