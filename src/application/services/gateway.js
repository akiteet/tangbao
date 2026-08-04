'use strict';
/* 模型网关服务：密钥引用 → 接口地址映射表 */
(function () {
  App.services = App.services || {};
  App.services.gateway = {
    setEndpoints(list) {
      try { return (window.electron && window.electron.setGatewayEndpoints) ? window.electron.setGatewayEndpoints(list) : null; } catch (e) { return null; }
    },
  };
})();
