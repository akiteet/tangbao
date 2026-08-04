'use strict';
/* 系统信息服务：本地服务端口（静态服务 + 糖码后端 + 启动令牌） */
(function () {
  App.services = App.services || {};
  App.services.system = {
    serverPorts() {
      try { return (window.electron && window.electron.serverPorts) ? window.electron.serverPorts() : null; } catch (e) { return null; }
    },
  };
})();
