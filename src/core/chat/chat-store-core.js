'use strict';
/*
 * chat-store-core —— 聊天/模块会话存储的纯核心（v1.2.0 批次 7 第一刀，自 chat.js 抽出）。
 * UMD 双环境：主进程/测试 require 加载；渲染层 <script> 加载挂 window.App.chatStoreCore。
 *
 * 职责（全部为可独立测试的纯逻辑）：
 *   - 模块归属判定：ownerForConversation / isTavernConv / isModuleOwner
 *   - 模块会话运行时结构整形：ensureModuleRuntime(host)（幂等，缺省桶自动补齐）
 *   - 模块写串行队列：createModuleWriteQueue()（同一 owner 的写操作按提交顺序执行，
 *     前序失败不阻断后续——与 chat.js 原实现语义一致）
 *   - 快照：snapshotOf(conv)（JSON 往返，失败回退原对象）
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof root !== 'undefined' && root.window) {
    root.window.App = root.window.App || {};
    root.window.App.chatStoreCore = mod;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.App = globalThis.App || {};
    globalThis.App.chatStoreCore = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MODULE_OWNERS = ['tavern', 'create'];
  const OWNER_SET = new Set(MODULE_OWNERS);

  function isModuleOwner(owner) { return OWNER_SET.has(String(owner || '')); }

  /** 归属判定不得依赖最新标记形态：老会话只有 originModule，新糖馆会话另带 tavernCharacterId */
  function ownerForConversation(conv) {
    if (conv && (conv.tavernCharacterId || conv.originModule === 'tavern')) return 'tavern';
    if (conv && conv.originModule === 'create') return 'create';
    return 'default';
  }

  function isTavernConv(conv) { return ownerForConversation(conv) === 'tavern'; }

  /**
   * 幂等整形宿主上的模块会话运行时结构。
   * host 需为可写对象（渲染层传 App；测试传任意 {}）。返回 host.moduleSessions。
   */
  function ensureModuleRuntime(host) {
    host = host || {};
    if (!host.moduleSessions || typeof host.moduleSessions !== 'object') {
      host.moduleSessions = { status: 'pending', data: {} };
    }
    host.moduleSessions.data = host.moduleSessions.data || {};
    for (const owner of MODULE_OWNERS) {
      const bucket = host.moduleSessions.data[owner];
      if (!bucket || typeof bucket !== 'object') host.moduleSessions.data[owner] = { conversations: [], activeId: null };
      if (!Array.isArray(host.moduleSessions.data[owner].conversations)) host.moduleSessions.data[owner].conversations = [];
    }
    return host.moduleSessions;
  }

  /** 序列化写队列工厂：每个 owner 独立排队；返回 {enqueue(owner, operation)} */
  function createModuleWriteQueue() {
    const queues = new Map();
    function enqueue(owner, operation) {
      const name = String(owner || '');
      const previous = queues.get(name) || Promise.resolve();
      const next = previous.catch(() => {}).then(operation);
      queues.set(name, next.catch(() => {}));
      return next;
    }
    return { enqueue };
  }

  function snapshotOf(conv) {
    try { return JSON.parse(JSON.stringify(conv)); } catch (_) { return conv; }
  }

  return {
    MODULE_OWNERS,
    isModuleOwner,
    ownerForConversation,
    isTavernConv,
    ensureModuleRuntime,
    createModuleWriteQueue,
    snapshotOf,
  };
});
