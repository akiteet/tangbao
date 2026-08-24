'use strict';
(function () {
  window.App = window.App || {};
  App.__bootReady = false;
  App.moduleSessions = App.moduleSessions || {
    status: 'pending',
    data: {
      tavern: { conversations: [], activeId: null },
      create: { conversations: [], activeId: null },
    },
  };

  function mergeFloatConversations(current, incoming) {
    const existing = Array.isArray(current) ? current : [];
    const updates = Array.isArray(incoming) ? incoming : [];
    const byId = new Map(existing.filter((item) => item && item.id).map((item) => [item.id, item]));
    const order = existing.map((item) => item && item.id).filter(Boolean);
    const isNewer = (next, previous) => {
      if (!previous) return true;
      const nextAt = Number(next && next.updatedAt) || 0;
      const previousAt = Number(previous && previous.updatedAt) || 0;
      if (nextAt !== previousAt) return nextAt > previousAt;
      const nextCount = Array.isArray(next && next.messages) ? next.messages.length : 0;
      const previousCount = Array.isArray(previous && previous.messages) ? previous.messages.length : 0;
      return nextCount >= previousCount;
    };
    for (const next of updates) {
      if (!next || !next.id) continue;
      const previous = byId.get(next.id);
      if (isNewer(next, previous)) byId.set(next.id, next);
      if (!previous) order.push(next.id);
    }
    return order.map((id) => byId.get(id)).filter(Boolean);
  }

  const isModuleConversation = (item) => !!(item && (
    item.tavernCharacterId
    || item.originModule === 'tavern'
    || item.originModule === 'create'
  ));

  // v1.1.8 模块改名：旧桶/旧快照里的会话字段还是旧名（tangguanCharacterId /
  // originModule:'tangguan'），加载进内存时统一映射为新名，读写两侧即一致。
  function normalizeModuleConversationFields(item) {
    if (!item || typeof item !== 'object') return item;
    if (item.tangguanCharacterId && !item.tavernCharacterId) {
      item.tavernCharacterId = String(item.tangguanCharacterId);
      delete item.tangguanCharacterId;
    }
    if (item.originModule === 'tangguan') item.originModule = 'tavern';
    return item;
  }
  function normalizeModuleConversationList(list) {
    return (Array.isArray(list) ? list : []).map(normalizeModuleConversationFields);
  }

  function mergeModuleSessions(primary, fallback) {
    const list = Array.isArray(primary) ? primary.filter((item) => item && item.id) : [];
    const byId = new Map(list.map((item) => [item.id, item]));
    for (const item of Array.isArray(fallback) ? fallback : []) {
      if (!item || !item.id) continue;
      const previous = byId.get(item.id);
      if (!previous || (Number(item.updatedAt) || 0) >= (Number(previous.updatedAt) || 0)) byId.set(item.id, item);
    }
    return Array.from(byId.values()).sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  }

  function splitLegacyModuleSessions(conversations) {
    const source = Array.isArray(conversations) ? conversations : [];
    return {
      normal: source.filter((item) => !isModuleConversation(item)),
      // 兼容新旧字段名：输入可能是未归一化的旧快照
      tavern: source.filter((item) => item && (item.tavernCharacterId || item.tangguanCharacterId || item.originModule === 'tavern' || item.originModule === 'tangguan')),
      create: source.filter((item) => item && item.originModule === 'create'),
    };
  }

  function applyFloatStateSnapshot(payload) {
    const state = payload && payload.state && typeof payload.state === 'object' ? payload.state : payload;
    if (!state || typeof state !== 'object') return false;
    const safeState = Object.assign({}, state);
    const split = splitLegacyModuleSessions(safeState.conversations);
    safeState.conversations = split.normal;
    if (safeState.activeId && !safeState.conversations.some((item) => item && item.id === safeState.activeId)) {
      safeState.activeId = safeState.conversations[0] ? safeState.conversations[0].id : null;
    }
    const result = App.loadStateFromRaw ? App.loadStateFromRaw(JSON.stringify(safeState), { persist: false }) : { ok: false };
    if (!result || !result.ok) return false;
    if (App.chat && App.chat.onShow) App.chat.onShow();
    if (App.ui && App.ui.renderSidebar) App.ui.renderSidebar();
    return true;
  }

  async function initializeModuleSessions() {
    const service = App.services && App.services.moduleSessions;
    if (!service) return { ok: false, code: 'module_session_service_missing' };
    const previousActiveId = App.state && App.state.activeId;
    const migration = await service.migrateLegacy(App.state);
    if (!migration || !migration.ok) {
      // A failed copy must not leave the old module records in the regular Chat
      // collection. Keep a memory-only partition so the user can still inspect
      // them, while the original snapshot remains untouched for recovery.
      const split = splitLegacyModuleSessions(App.state && App.state.conversations);
      const data = {};
      for (const module of ['tavern', 'create']) {
        const loaded = await Promise.resolve(service.load(module)).catch(() => null);
        const sidecar = loaded && loaded.ok && loaded.data ? loaded.data : null;
        const conversations = normalizeModuleConversationList(mergeModuleSessions(sidecar && sidecar.conversations, split[module]));
        const activeId = sidecar && sidecar.activeId && conversations.some((item) => item.id === sidecar.activeId)
          ? sidecar.activeId : (conversations[0] ? conversations[0].id : null);
        data[module] = { conversations, activeId, revision: Number(sidecar && sidecar.revision) || 0 };
      }
      App.state.conversations = split.normal;
      if (!split.normal.some((item) => item && item.id === App.state.activeId)) {
        App.state.activeId = split.normal[0] ? split.normal[0].id : null;
      }
      App.moduleSessions.data = data;
      App.moduleSessions.status = 'failed';
      App.__moduleSessionRecovery = migration || { ok: false, code: 'module_session_migration_failed', sourcePreserved: true };
      return Object.assign({}, migration || { ok: false, code: 'module_session_migration_failed' }, { data });
    }
    if (migration.state && Array.isArray(migration.state.conversations)) {
      App.state.conversations = migration.state.conversations;
      const normalIds = new Set(App.state.conversations.map((item) => item && item.id).filter(Boolean));
      if (!normalIds.has(previousActiveId)) App.state.activeId = App.state.conversations[0] ? App.state.conversations[0].id : null;
    }
    const data = {};
    let loadFailed = null;
    for (const module of ['tavern', 'create']) {
      const loaded = await service.load(module);
      if (!loaded || !loaded.ok || !loaded.data) {
        loadFailed = loaded || { ok: false, code: 'module_session_load_failed', module };
        const fallback = migration.sessions && migration.sessions[module];
        data[module] = {
          conversations: normalizeModuleConversationList(Array.isArray(fallback && fallback.conversations) ? fallback.conversations : []),
          activeId: fallback && fallback.activeId || null,
          revision: Number(fallback && fallback.revision) || 0,
        };
        continue;
      }
      data[module] = {
        conversations: normalizeModuleConversationList(Array.isArray(loaded.data.conversations) ? loaded.data.conversations : []),
        activeId: loaded.data.activeId || null,
        revision: Number(loaded.data.revision) || 0,
      };
    }
    App.moduleSessions.data = data;
    App.moduleSessions.status = loadFailed ? 'failed' : 'active';
    if (loadFailed) App.__moduleSessionRecovery = loadFailed;
    if (migration.migrated || previousActiveId !== App.state.activeId) App.persist();
    return { ok: !loadFailed, migration, data, error: loadFailed };
  }

  function mergeFloatConversations(current, incoming) {
    const existing = Array.isArray(current) ? current : [];
    const updates = Array.isArray(incoming) ? incoming : [];
    const byId = new Map(existing.filter((item) => item && item.id).map((item) => [item.id, item]));
    const order = existing.map((item) => item && item.id).filter(Boolean);
    const isNewer = (next, previous) => {
      if (!previous) return true;
      const nextAt = Number(next && next.updatedAt) || 0;
      const previousAt = Number(previous && previous.updatedAt) || 0;
      if (nextAt !== previousAt) return nextAt > previousAt;
      const nextCount = Array.isArray(next && next.messages) ? next.messages.length : 0;
      const previousCount = Array.isArray(previous && previous.messages) ? previous.messages.length : 0;
      return nextCount >= previousCount;
    };
    for (const next of updates) {
      if (!next || !next.id) continue;
      const previous = byId.get(next.id);
      if (isNewer(next, previous)) byId.set(next.id, next);
      if (!previous) order.push(next.id);
    }
    return order.map((id) => byId.get(id)).filter(Boolean);
  }

  function applyFloatStateSnapshot(payload) {
    const state = payload && payload.state && typeof payload.state === 'object' ? payload.state : payload;
    if (!state || typeof state !== 'object') return false;
    // v1.1.6：防止浮窗收到主窗推送后 loadStateFromRaw 触发副作用再回传形成循环。
    // 用 __applyingFloatState 守卫：应用期间浮窗的 App.persist 只走本地渲染不走 sync。
    App.__applyingFloatState = true;
    try {
      const result = App.loadStateFromRaw ? App.loadStateFromRaw(JSON.stringify(state), { persist: false }) : { ok: false };
      if (!result || !result.ok) return false;
      if (App.chat && App.chat.onShow) App.chat.onShow();
      if (App.ui && App.ui.renderSidebar) App.ui.renderSidebar();
      return true;
    } finally {
      App.__applyingFloatState = false;
    }
  }

  async function boot() {
    // v1.1.6（批次 A）：按设置快速开启 perf 仪表，使 bootMs 本身能被记录。
    // state 加载后会再同步一次（settings.perfEnabled）；此处先用 localStorage 兜底（state 加载前）。
    try { if (App.perf && localStorage.getItem('perfEnabled') === '1') App.perf.enable(); } catch (_) {}
    const bootStarted = App.perf && App.perf.begin ? App.perf.begin() : 0;
    try {
      // 0) 先取本地服务端口与启动令牌：端口由系统随机分配，任何本地请求都依赖它
      if (App.rt && App.rt.init) await App.rt.init();
      const params = new URLSearchParams(location.search);
      const floatMode = params.get('float') === 'chat';

      if (floatMode) {
        document.body.classList.add('float-mode');
        App.__floatMode = true;
        App.__floatReady = false;
        // 浮窗透明度开关：默认不透明（可读性优先），悬停时强制不透明，点击在 1.0/0.6 间切换
        function setupFloatOpacity() {
          const btn = document.getElementById('floatOpacity');
          if (!btn) return;
          App.__floatOpacity = 1.0;
          const apply = (v) => { App.services.float.setOpacity(v); };
          App.services.float.getOpacity().then((v) => { if (typeof v === 'number' && v > 0) App.__floatOpacity = v; }).catch(() => {});
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            App.__floatOpacity = (App.__floatOpacity < 1 ? 1.0 : 0.6);
            apply(App.__floatOpacity);
          });
          document.addEventListener('mouseleave', () => apply(App.__floatOpacity));
          document.addEventListener('mouseenter', () => apply(1.0));
        }
        // 浮窗置顶切换 + 双击顶栏最大化
        function setupFloatPin() {
          const btn = document.getElementById('floatPin');
          if (!btn) return;
          let pinned = true; // 与 BrowserWindow alwaysOnTop 默认值一致（持久态已在创建时应用）
          btn.classList.add('active');
          btn.addEventListener('click', (e) => {
            e.stopPropagation();
            pinned = !pinned;
            btn.classList.toggle('active', pinned);
            App.services.float.setAlwaysOnTop(pinned);
          });
          const tb = document.querySelector('.topbar');
          if (tb) tb.addEventListener('dblclick', (e) => {
            if (e.target.closest('button')) return; // 不拦截按钮点击
            App.services.float.toggleMaximize();
          });
        }
        // 浮窗不写本机 state.json，只把会话增量单向同步给主窗；账户设置永不回传。
        // v1.1.6：应用主窗推送状态期间不回传 sync，防止 pushState→loadStateFromRaw→persist→sync→pushState 循环。
        App.persist = function () {
          if (App.__floatReady && !App.__applyingFloatState) {
            App.services.float.sync({
              type: 'patch',
              conversations: App.state.conversations,
              activeId: App.state.activeId,
              web: App.state.web,
              thinkLevel: App.state.thinkLevel,
            });
          }
        };
        if (App.services.float.onState) {
          App.services.float.onState((payload) => {
            if (!App.__floatReady) return;
            applyFloatStateSnapshot(payload);
          });
        }
        if (App.rt && App.rt.onFloatInit) {
          App.rt.onFloatInit((raw) => {
            try {
              if (!App.loadStateFromRaw || !App.loadStateFromRaw(raw, { persist: false }).ok) {
                throw new Error('invalid_float_state');
              }
            } catch (e) { console.error('浮窗初始化状态失败：', e); }
            App.__floatReady = true;
            App.router.go('chat', { force: true });
            setupFloatOpacity();
            setupFloatPin();
            if (App.chat && App.chat.onShow) App.chat.onShow();
            const inp = document.getElementById('input');
            if (inp) setTimeout(() => inp.focus(), 0);
          });
        }
        // 浮窗自身的刷新只重绘本地内容，避免在刚发送 patch 后读到旧 state.json。
        App.services.float.refresh = function () {
          if (App.chat && App.chat.onShow) App.chat.onShow();
        };
        App.services.float.onRefresh(() => {
          if (App.chat && App.chat.onShow) App.chat.onShow();
        });
      }

      // 1) 载入本地持久化的状态（含旧版迁移）
      await App.loadState();
      if (!floatMode) await initializeModuleSessions();

      // 1.5) 密钥：先取回主进程已存的密钥引用，再把 1.0.5 及更早版本残留在
      //      state.json / localStorage 里的明文 API Key 搬进系统密钥库。
      //      浮窗共用主窗的数据且不落盘，迁移只在主窗做一次。
      if (!floatMode && App.rt) {
        if (App.rt.refreshSecrets) await App.rt.refreshSecrets();
        if (App.rt.migrateSecrets) {
          const moved = await App.rt.migrateSecrets();
          // 迁移成功才会删明文；只要动过就立刻落盘，让 state.json 里不再留 Key
          if (moved) {
            console.log('[糖包] 已将 ' + moved + ' 个 API Key 迁入系统密钥库');
            App.persist();
          }
        }
        if (App.rt.secretsEncrypted === false) {
          console.warn('[糖包] 当前系统不支持安全存储，API Key 以本地文件保存，请留意数据目录权限。');
        }
        // 把「密钥引用 → 接口地址」映射同步给主进程网关（persist 里也会调，这里保证首次启动就有）
        if (App.rt.syncEndpoints) await App.rt.syncEndpoints();
        // 1.7) M3 存储层一次性迁移：把归一化后的 App.state 灌入 SQLite（better-sqlite3 不可用则静默跳过）
        if (App.rt.migrateStorage) {
          try { await App.rt.migrateStorage(JSON.stringify(App.state)); } catch (_) { /* SQLite 不可用时不阻断启动 */ }
        }
      }

      // 2) 应用外观（主题/强调色/圆角）
      App.ui.applyAppearance();
      // v1.1.6（批次 A）：state 加载后按 settings.perfEnabled 同步仪表开关
      try { if (App.perf && App.state.settings.perfEnabled) App.perf.enable(); else if (App.perf && !App.state.settings.perfEnabled) App.perf.disable(); } catch (_) {}
      // 3) 绑定全局 UI 事件（侧边栏 / 顶栏 / 设置弹窗）
      App.ui.init();
      if (App.__moduleSessionRecovery && App.__moduleSessionRecovery.ok === false) {
        const recovery = App.__moduleSessionRecovery;
        App.ui.notify('模块会话迁移失败', recovery.error || recovery.code || '原会话仍保留，请检查数据目录后重试');
      }
      if (App.__stateRecovery) {
        const recovery = App.__stateRecovery;
        App.ui.notify(recovery.code === 'partial_state' ? '数据恢复不完整' : '已恢复账户配置', recovery.needsUserReview ? '部分状态缺失，请检查账户和数据目录' : '已从本地回退快照恢复缺失的账户配置');
      }
      if (App.__persistence && App.__persistence.status === 'failed') {
        App.ui.notify('数据保存失败', '当前内容仍保留在浏览器回退存储，请检查数据目录后重试');
      }
      // A failed migration must be visible after restart; never silently fall back.
      try {
        const storageInfo = App.services.fs && App.services.fs.getStorageInfo ? await App.services.fs.getStorageInfo() : null;
        if (storageInfo && storageInfo.startupMigration) {
          const detail = storageInfo.startupMigration.error || storageInfo.startupMigration.code || '请打开设置中的存储审计';
          App.ui.notify('数据迁移失败', detail);
          App.ui.toast('数据迁移失败，当前仍使用旧数据；请打开设置查看恢复选项');
        }
      } catch (_) {}
      // 4) 绑定聊天视图事件并渲染欢迎区 / 建议
      App.chat.init();
      // 5) 进入模块视图：每次启动默认回到「糖包」聊天界面（v2 UX 决策：不记忆上次停留的模块）
      App.router.go('chat', { force: true });

      // v2（统一热刷新）：一次性订阅技能变更广播（设置面板 + 糖码 / 菜单即时刷新）
      if (App.ui && App.ui.bindSkillChanged) App.ui.bindSkillChanged();

      // 主窗监听浮窗回传的状态变更，合并并真实落盘
      if (!floatMode) {
        App.services.float.onApply((s) => {
          if (!s) return;
          const prevConvCount = (App.state.conversations || []).length;
          const prevActiveId = App.state.activeId;
          const conversations = mergeFloatConversations(App.state.conversations, s.conversations);
          const newActiveId = conversations.some((item) => item && item.id === s.activeId) ? s.activeId : App.state.activeId;
          // v1.1.6：去重——浮窗回传的内容与主窗现有一致时不 persist/pushState，防止循环
          const noChange = conversations.length === prevConvCount && newActiveId === prevActiveId
            && (typeof s.web !== 'boolean' || s.web === App.state.web)
            && (!['off','low','medium','high'].includes(s.thinkLevel) || s.thinkLevel === App.state.thinkLevel);
          if (noChange) return;
          Object.assign(App.state, {
            conversations,
            activeId: newActiveId,
            web: typeof s.web === 'boolean' ? s.web : App.state.web,
            thinkLevel: ['off', 'low', 'medium', 'high'].includes(s.thinkLevel) ? s.thinkLevel : App.state.thinkLevel,
          });
          App.persist();
          if (App.chat && App.chat.onShow) App.chat.onShow();
          if (App.ui && App.ui.renderSidebar) App.ui.renderSidebar();
        });
      }
      App.__bootReady = true;
    } catch (err) {
      console.error('糖包启动失败：', err);
      const t = document.getElementById('toast');
      if (t) {
        t.textContent = '初始化失败：' + (err && err.message ? err.message : String(err));
        t.hidden = false;
        t.classList.add('show');
      }
    } finally {
      if (App.perf) App.perf.measure('bootMs', bootStarted);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
