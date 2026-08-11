'use strict';
/* 模型网关服务：密钥引用 → 接口地址映射表 */
(function () {
  App.services = App.services || {};
  App.services.gateway = {
    setEndpoints(list) {
      try { return (window.electron && window.electron.setGatewayEndpoints) ? window.electron.setGatewayEndpoints(list) : null; } catch (e) { return null; }
    },
    probeCache(input) {
      try { return (window.electron && window.electron.probeCache) ? window.electron.probeCache(input || {}) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    modelHealth(input) {
      try { return (window.electron && window.electron.modelHealth) ? window.electron.modelHealth(input || {}) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    modelMetrics(input) {
      try { return (window.electron && window.electron.modelMetrics) ? window.electron.modelMetrics(input || {}) : { ok: false, items: [] }; } catch (e) { return { ok: false, items: [] }; }
    },
  };
})();
