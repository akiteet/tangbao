'use strict';
/*
 * 深拷贝（JSON 往返）共享实现（v1.1.5 批次 C2 收敛）。
 * 消费方：core/agent-runtime/tool-registry、infrastructure/storage/module-sessions。
 * 注意：src/core/models/image-capabilities.js 是 UMD 双环境模块（浏览器无 require），
 * 其内部 clone 保持本地副本，不要改成引用本文件。
 */
function clone(value) {
  if (value == null) return value;
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
}

module.exports = { clone };
