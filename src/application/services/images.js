'use strict';
/* 糖绘图片资产服务（v1.1.5 批次 D1）：历史图片落盘 / 读取 / 删除。
 * 底层走主进程白名单 IPC（image:saveAsset / readAsset / deleteAsset），
 * 文件操作严格限定在数据根 tangbao-data/images/ 内，渲染层不持有任意路径能力。 */
(function () {
  App.services = App.services || {};
  const call = (method, input) => App.services.ipc.invoke(method, [input || {}], { ok: false, code: 'ipc_unavailable' });
  App.services.images = {
    available() { return App.services.ipc.available('saveImageAsset'); },
    async save(base64, ext) { return call('saveImageAsset', { base64, ext }); },
    async read(name) { return call('readImageAsset', { name }); },
    async remove(name) { return call('deleteImageAsset', { name }); },
  };
})();
