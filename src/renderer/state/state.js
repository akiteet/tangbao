'use strict';
(function () {
  const STORAGE_KEY = 'tangbao_web_state_v1';
  const OLD_KEY = 'doubao_web_state_v1';
  const ACCOUNT_RECOVERY_KEY = 'tangbao_account_recovery_v1';

  // M4 写穿节流：App.persist 高频触发时防抖 800ms 再同步 SQLite；_lastSyncedJson 用于跳过未变化
  let _syncTimer = null;
  let _lastSyncedJson = null;
  let _lastPersistedStateJson = null;
  let _pendingSnapshot = null;
  let _stateRevision = 0;
  let _lastPersistenceNotice = '';
  let _fileWriteInFlight = null;
  let _fileWritePending = null;
  let _sqliteSyncTimer = null;
  let _sqliteSyncInFlight = null;
  let _sqliteSyncPending = null;
  let _lastEndpointFingerprint = null;

  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

  function persistedRevision(value) {
    const meta = value && typeof value === 'object' && value._persistence;
    const revision = meta && Number(meta.revision);
    return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
  }

  function parseStateCandidate(raw, oldFormat) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const settings = value.settings;
      if (settings != null && (typeof settings !== 'object' || Array.isArray(settings))) return null;
      if (hasOwn(value, 'conversations') && !Array.isArray(value.conversations)) return null;
      if (hasOwn(value, 'agentThreads') && !Array.isArray(value.agentThreads)) return null;
      if (hasOwn(value, 'projects') && !Array.isArray(value.projects)) return null;
      if (settings && hasOwn(settings, 'accounts') && !Array.isArray(settings.accounts)) return null;
      if (settings && hasOwn(settings, 'providers') && (typeof settings.providers !== 'object' || Array.isArray(settings.providers))) return null;
      if (!(hasOwn(value, 'conversations') || hasOwn(value, 'settings') || hasOwn(value, 'agentThreads') || hasOwn(value, 'projects') || hasOwn(value, 'activeId'))) return null;
      return { value, oldFormat: !!oldFormat, raw };
    } catch (_) {
      return null;
    }
  }

  // A valid JSON file can still be an interrupted/old partial snapshot. Missing
  // fields are filled only from a backup candidate; explicit empty arrays win.
  function hasConfiguredAccountReference(value) {
    const settings = value && value.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
    if (typeof settings.defaultAccountId === 'string' && settings.defaultAccountId.trim()) return true;
    const providers = settings.providers && typeof settings.providers === 'object' ? settings.providers : {};
    return Object.values(providers).some((provider) => {
      const accountId = provider && provider.accountId;
      return typeof accountId === 'string' && accountId.trim() && !['__default__', '__custom__'].includes(accountId);
    });
  }

  function hasExplicitAccountReset(value) {
    return !!(value && value._persistence && value._persistence.allowAccountReset === true);
  }

  function stateNeedsRecovery(value, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const settings = value && value.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return true;
    if (!hasOwn(value, 'conversations') || !hasOwn(settings, 'accounts') || !hasOwn(settings, 'providers')) return true;
    // v1.1.6：非 chat 数据丢失检测——仅在已有会话数据时才检查 agentThreads/projects 是否缺失或为空。
    // 全新空状态（无会话）不触发恢复，避免首次安装误判。
    const hasConversations = Array.isArray(value.conversations) && value.conversations.length > 0;
    if (hasConversations) {
      if (!hasOwn(value, 'agentThreads') || !Array.isArray(value.agentThreads) || value.agentThreads.length === 0) return true;
      if (!hasOwn(value, 'projects') || !Array.isArray(value.projects) || value.projects.length === 0) return true;
      // v1.1.6 加固：有会话但 customModules 为空 → 触发恢复（fallback 有数据则补回，防自定义模块再次静默丢失）。
      // opts.ignoreCustomModules=true 时跳过——用于 loadState 的 incomplete 判定，避免打扰"无自定义模块"的新用户。
      if (!o.ignoreCustomModules && Array.isArray(settings.customModules) && settings.customModules.length === 0) return true;
      // v1.1.8 Q1：visionModels 纳入丢失检测——applyLoaded 只在字段缺失时回填默认表，防不住被固化的空数组
      if (!o.ignoreCustomModules && Array.isArray(settings.visionModels) && settings.visionModels.length === 0) return true;
    }
    // An empty account array is recoverable unless it was produced by the
    // explicit two-step "clear all" action. This protects against a partial
    // renderer snapshot that kept providers but lost the account list.
    return Array.isArray(settings.accounts) && settings.accounts.length === 0
      && !hasExplicitAccountReset(value) && hasConfiguredAccountReference(value);
  }

  function mergeMissingState(primary, fallback) {
    const p = primary && typeof primary === 'object' ? primary : {};
    const f = fallback && typeof fallback === 'object' ? fallback : {};
    const merged = Object.assign({}, f, p);
    if (p.settings || f.settings) {
      const ps = p.settings && typeof p.settings === 'object' ? p.settings : {};
      const fs = f.settings && typeof f.settings === 'object' ? f.settings : {};
      merged.settings = Object.assign({}, fs, ps);
      if (Array.isArray(ps.accounts) && ps.accounts.length === 0 && Array.isArray(fs.accounts) && fs.accounts.length > 0 && !hasExplicitAccountReset(p)) {
        merged.settings.accounts = fs.accounts;
        if (!ps.defaultAccountId && fs.defaultAccountId) merged.settings.defaultAccountId = fs.defaultAccountId;
      }
      if (ps.providers || fs.providers) {
        const pp = ps.providers && typeof ps.providers === 'object' ? ps.providers : {};
        const fp = fs.providers && typeof fs.providers === 'object' ? fs.providers : {};
        merged.settings.providers = Object.assign({}, fp, pp);
      }
      // v1.1.6：非 chat 数据从 fallback 恢复——primary 空但 fallback 有数据时用 fallback
      if (Array.isArray(ps.imageHistory) && ps.imageHistory.length === 0 && Array.isArray(fs.imageHistory) && fs.imageHistory.length > 0) {
        merged.settings.imageHistory = fs.imageHistory;
      }
      if (Array.isArray(ps.docs) && ps.docs.length === 0 && Array.isArray(fs.docs) && fs.docs.length > 0) {
        merged.settings.docs = fs.docs;
      }
      // v1.1.6 补丁：customModules 同 imageHistory/docs——字段缺失或为空且 fallback 有数据时恢复，
      // 避免 state.json 被覆盖后用户自定义模块（糖九球等）从主源消失。
      if ((!Array.isArray(ps.customModules) || ps.customModules.length === 0) && Array.isArray(fs.customModules) && fs.customModules.length > 0) {
        merged.settings.customModules = fs.customModules;
      }
      // v1.1.8 Q1：visionModels 同策略恢复（自定义视觉模型列表被固化清空时从 fallback 捞回）
      if ((!Array.isArray(ps.visionModels) || ps.visionModels.length === 0) && Array.isArray(fs.visionModels) && fs.visionModels.length > 0) {
        merged.settings.visionModels = fs.visionModels;
      }
    }
    // v1.1.6：agentThreads/projects 从 fallback 恢复
    if (Array.isArray(p.agentThreads) && p.agentThreads.length === 0 && Array.isArray(f.agentThreads) && f.agentThreads.length > 0) {
      merged.agentThreads = f.agentThreads;
      if (!p.activeThreadId && f.activeThreadId) merged.activeThreadId = f.activeThreadId;
    }
    if (Array.isArray(p.projects) && p.projects.length === 0 && Array.isArray(f.projects) && f.projects.length > 0) {
      merged.projects = f.projects;
      if (!p.activeProjectId && f.activeProjectId) merged.activeProjectId = f.activeProjectId;
    }
    return merged;
  }

  // v1.1.6（B2 修订）：手动脱敏替代 JSON.parse(JSON.stringify(state)) 第三次全量序列化。
  // 浮窗需要 conversations（渲染对话）、view、activeId、web、thinkLevel、settings（外观+账户脱敏）。
  // 只浅拷贝需要的顶层字段 + 删 apiKey，不再对整个 state 做深拷贝。
  function sanitizeFloatState(value) {
    const source = value || {};
    const settings = source.settings && typeof source.settings === 'object' ? source.settings : {};
    const sanitizedSettings = { appearance: settings.appearance || {}, view: settings.view || 'chat' };
    if (settings.accounts && Array.isArray(settings.accounts)) {
      sanitizedSettings.accounts = settings.accounts.map((account) => {
        const next = Object.assign({}, account);
        delete next.apiKey;
        return next;
      });
    }
    if (settings.providers && typeof settings.providers === 'object') {
      sanitizedSettings.providers = Object.fromEntries(Object.entries(settings.providers).map(([key, provider]) => {
        const next = Object.assign({}, provider || {});
        delete next.apiKey;
        return [key, next];
      }));
    }
    return {
      activeId: source.activeId || null,
      view: source.view || 'chat',
      web: source.web,
      thinkLevel: source.thinkLevel,
      conversations: Array.isArray(source.conversations) ? source.conversations : [],
      settings: sanitizedSettings,
    };
  }

  function persistableState() {
    const source = App.state || {};
    const sessions = App.moduleSessions;
    if (!Array.isArray(source.conversations)) return source;
    const copy = Object.assign({}, source);
    copy.conversations = source.conversations.filter((item) => !(item && (
      item.tangguanCharacterId
      || item.originModule === 'tangguan'
      || item.originModule === 'create'
    )));
    if (copy.activeId && !copy.conversations.some((item) => item && item.id === copy.activeId)) {
      copy.activeId = copy.conversations[0] ? copy.conversations[0].id : null;
    }
    return copy;
  }

  function createPersistedSnapshot(options) {
    const opts = options && typeof options === 'object' ? options : {};
    let content;
    const serializeStarted = App.perf && App.perf.begin ? App.perf.begin() : 0;
    const stateValue = persistableState();
    try { content = JSON.stringify(stateValue); } catch (_) { return null; }
    if (App.perf) {
      const stateBytes = utf8ByteLength(content);
      App.perf.measure('stateSerializeMs', serializeStarted, { stateBytes });
      App.perf.record('stateBytes', stateBytes);
      App.perf.record('messageCount', Array.isArray(stateValue && stateValue.conversations)
        ? stateValue.conversations.reduce((total, item) => total + (Array.isArray(item && item.messages) ? item.messages.length : 0), 0)
        : 0);
    }
    if (_pendingSnapshot && content === _lastPersistedStateJson && !opts.allowAccountReset) return _pendingSnapshot;
    _stateRevision = Math.max(_stateRevision, Date.now());
    const revision = _stateRevision + 1;
    _stateRevision = revision;
    const persisted = Object.assign({}, stateValue, {
      _persistence: { revision, savedAt: Date.now(), format: 1, allowAccountReset: opts.allowAccountReset === true },
    });
    const json = JSON.stringify(persisted, null, 2);
    _lastPersistedStateJson = content;
    _pendingSnapshot = { content, json, revision };
    return _pendingSnapshot;
  }

  function utf8ByteLength(value) {
    const source = String(value == null ? '' : value);
    try {
      if (typeof TextEncoder === 'function') return new TextEncoder().encode(source).length;
    } catch (_) {}
    return source.length;
  }

  // Streaming output only needs the active assistant message to survive a
  // renderer restart. Serializing the complete state here is expensive when
  // image history, documents, or many conversations are present, so partial
  // checkpoints use a small patch handled by the main process.
  function createPartialSnapshot(options) {
    const opts = options && typeof options === 'object' ? options : {};
    const conversationId = String(opts.conversationId || '');
    const messageId = String(opts.messageId || '');
    const conversations = App.state && Array.isArray(App.state.conversations) ? App.state.conversations : [];
    const conversation = conversations.find((item) => item && item.id === conversationId);
    const message = conversation && Array.isArray(conversation.messages)
      ? conversation.messages.find((item) => item && item.id === messageId)
      : null;
    if (!conversation || !message) return null;
    _stateRevision = Math.max(_stateRevision, Date.now());
    const revision = _stateRevision + 1;
    _stateRevision = revision;
    return {
      partial: true,
      revision,
      patch: {
        conversationId,
        messageId,
        message: {
          role: 'assistant',
          content: String(message.content || ''),
          think: String(message.think || ''),
          streamStatus: String(message.streamStatus || 'partial'),
          error: String(message.error || ''),
          webSources: Number.isFinite(Number(message.webSources)) ? Number(message.webSources) : null,
          sequence: Number.isFinite(Number(message.sequence)) ? Number(message.sequence) : 0,
          requestId: String(message.requestId || ''),
          startedAt: Number(message.startedAt) || 0,
          updatedAt: Number(message.updatedAt) || Date.now(),
        },
        conversationUpdatedAt: Number(conversation.updatedAt) || Date.now(),
      },
    };
  }

  function accountRecoverySnapshot() {
    const settings = App.state && App.state.settings;
    if (!settings || !Array.isArray(settings.accounts) || !settings.accounts.length) return null;
    const accounts = settings.accounts.map((account) => {
      const next = Object.assign({}, account);
      delete next.apiKey;
      return next;
    });
    const providers = {};
    const source = settings.providers && typeof settings.providers === 'object' ? settings.providers : {};
    for (const [key, value] of Object.entries(source)) {
      providers[key] = Object.assign({}, value || {});
      delete providers[key].apiKey;
    }
    return JSON.stringify({
      conversations: [],
      settings: { accounts, defaultAccountId: settings.defaultAccountId || '', providers },
    });
  }

  function isThenable(value) {
    return !!(value && typeof value.then === 'function');
  }

  function endpointFingerprint() {
    const settings = App.state && App.state.settings ? App.state.settings : {};
    const accounts = Array.isArray(settings.accounts) ? settings.accounts
      .map((item) => ({ id: item && item.id || '', apiBase: item && item.apiBase || '' }))
      .filter((item) => item.id && item.apiBase) : [];
    const custom = Object.entries(settings.providers && typeof settings.providers === 'object' ? settings.providers : {})
      .filter(([, item]) => item && item.accountId === '__custom__')
      .map(([module, item]) => ({ module, apiBase: item.apiBase || '' }));
    return JSON.stringify({ accounts, custom });
  }

  function fileWriteMethod(options) {
    const opts = options && typeof options === 'object' ? options : {};
    if (opts.flushPartial && App.services.fs && App.services.fs.flushChatPartial) {
      return (snapshot) => snapshot && snapshot.patch
        ? App.services.fs.flushChatPartial({ patch: snapshot.patch, revision: snapshot.revision })
        : App.services.fs.flushChatPartial({
          stateJson: snapshot.json,
          revision: snapshot.revision,
          conversationId: opts.conversationId,
          messageId: opts.messageId,
        });
    }
    // v1.1.6（P0 修复）：部分持久化后端缺失时跳过，绝不 fallback 写全量——
    // 部分快照（createPartialSnapshot）没有 json 字段，fallback 会把 undefined 交给
    // saveStateJSON → fs:writeState → writeStateFileAtomic(undefined) → state.json 被写空。
    // 这是"三番五次数据丢失"的确定性根因：流式中途应用退出后，state.json 保持空，
    // 下次启动走残缺 fallback，非 chat 数据永久丢失。
    if (opts.flushPartial) {
      return () => ({ ok: true, skipped: 'partial_backend_unavailable' });
    }
    if (App.services.fs && App.services.fs.saveStateJSON) {
      return (snapshot) => App.services.fs.saveStateJSON(snapshot.json, snapshot.revision);
    }
    return null;
  }

  function pumpFileWrite() {
    if (_fileWriteInFlight || !_fileWritePending) return;
    const request = _fileWritePending;
    _fileWritePending = null;
    const method = fileWriteMethod(request.options);
    let result;
    const writeStarted = App.perf && App.perf.begin ? App.perf.begin() : 0;
    try { result = method ? method(request.snapshot) : { ok: false, code: 'no_persistence_backend' }; }
    catch (error) { result = { ok: false, code: request.options.flushPartial ? 'partial_state_write_failed' : 'state_file_write_failed', error: error && error.message ? error.message : String(error) }; }
    _fileWriteInFlight = Promise.resolve(result)
      .then((response) => {
        if (App.perf) App.perf.measure('fileWriteMs', writeStarted, { revision: request.snapshot.revision });
        const settled = handlePersistenceResult(response, request.snapshot.revision, 'file');
        request.resolve(settled);
        return settled;
      })
      .catch((error) => {
        if (App.perf) App.perf.measure('fileWriteMs', writeStarted, { revision: request.snapshot.revision, failed: true });
        const settled = handlePersistenceResult({ ok: false, code: request.options.flushPartial ? 'partial_state_write_failed' : 'state_file_write_failed', error: error && error.message ? error.message : String(error) }, request.snapshot.revision, 'file');
        request.resolve(settled);
        return settled;
      })
      .finally(() => {
        _fileWriteInFlight = null;
        pumpFileWrite();
      });
  }

  function enqueueFileWrite(snapshot, options) {
    const promise = new Promise((resolve) => {
      if (_fileWritePending && _fileWritePending.resolve) {
        _fileWritePending.resolve({ ok: true, superseded: true, revision: _fileWritePending.snapshot.revision });
      }
      _fileWritePending = { snapshot, options: options || {}, resolve };
      if (App.perf) App.perf.record('ipcQueueDepth', (_fileWriteInFlight ? 1 : 0) + (_fileWritePending ? 1 : 0) + (_sqliteSyncInFlight ? 1 : 0) + (_sqliteSyncPending ? 1 : 0));
      pumpFileWrite();
    });
    App.__persistencePromise = promise;
    return promise;
  }

  function pumpSqliteSync() {
    if (_sqliteSyncInFlight || !_sqliteSyncPending) return;
    if (!App.rt || !App.rt.syncStorage) { _sqliteSyncPending = null; return; }
    const current = _sqliteSyncPending;
    _sqliteSyncPending = null;
    if (!current || current.json === _lastSyncedJson) return;
    let result;
    const syncStarted = App.perf && App.perf.begin ? App.perf.begin() : 0;
    try { result = App.rt.syncStorage(current.json, current.revision); }
    catch (error) { result = { ok: false, code: 'sqlite_sync_failed', error: error && error.message ? error.message : String(error) }; }
    const settle = (response) => {
      if (response && response.ok === false && response.reason !== 'no-sqlite') {
        return handlePersistenceResult(response, current.revision, 'sqlite');
      }
      _lastSyncedJson = current.json;
      publishPersistenceStatus('saved', { revision: current.revision, sqlite: response && response.ok === false ? 'fallback' : 'saved' });
      return response;
    };
    _sqliteSyncInFlight = Promise.resolve(result).then((response) => {
      if (App.perf) App.perf.measure('sqliteSyncMs', syncStarted, { revision: current.revision });
      return settle(response);
    }).catch((error) => {
      if (App.perf) App.perf.measure('sqliteSyncMs', syncStarted, { revision: current.revision, failed: true });
      return settle({ ok: false, code: 'sqlite_sync_failed', error: error && error.message ? error.message : String(error) });
    }).finally(() => {
      _sqliteSyncInFlight = null;
      pumpSqliteSync();
    });
  }

  function enqueueSqliteSync(snapshot) {
    _sqliteSyncPending = snapshot;
    if (App.perf) App.perf.record('ipcQueueDepth', (_fileWriteInFlight ? 1 : 0) + (_fileWritePending ? 1 : 0) + (_sqliteSyncInFlight ? 1 : 0) + (_sqliteSyncPending ? 1 : 0));
    if (_sqliteSyncTimer) clearTimeout(_sqliteSyncTimer);
    _sqliteSyncTimer = setTimeout(() => {
      _sqliteSyncTimer = null;
      pumpSqliteSync();
    }, 800);
  }

  function flushPersistence(options) {
    const opts = options && typeof options === 'object' ? options : {};
    if (_sqliteSyncTimer) {
      clearTimeout(_sqliteSyncTimer);
      _sqliteSyncTimer = null;
      pumpSqliteSync();
    }
    const waits = [];
    if (_fileWriteInFlight) waits.push(_fileWriteInFlight);
    if (_fileWritePending) {
      pumpFileWrite();
      if (_fileWriteInFlight) waits.push(_fileWriteInFlight);
    }
    if (_sqliteSyncInFlight) waits.push(_sqliteSyncInFlight);
    if (_sqliteSyncPending) {
      pumpSqliteSync();
      if (_sqliteSyncInFlight) waits.push(_sqliteSyncInFlight);
    }
    if (opts.snapshot !== false && !opts.partial) {
      const snapshot = createPersistedSnapshot(opts);
      if (snapshot && fileWriteMethod(opts)) {
        waits.push(enqueueFileWrite(snapshot, opts));
      }
      try { enqueueSqliteSync(snapshot); } catch (_) {}
      if (_sqliteSyncTimer) {
        clearTimeout(_sqliteSyncTimer);
        _sqliteSyncTimer = null;
        pumpSqliteSync();
        if (_sqliteSyncInFlight) waits.push(_sqliteSyncInFlight);
      }
    }
    const unique = Array.from(new Set(waits.filter((item) => item && typeof item.then === 'function')));
    return unique.length ? Promise.allSettled(unique).then((items) => ({
      ok: items.every((item) => item.status === 'fulfilled' && (!item.value || item.value.ok !== false)),
      results: items.map((item) => item.status === 'fulfilled' ? item.value : { ok: false, error: String(item.reason || '') }),
    })) : Promise.resolve({ ok: true, results: [] });
  }

  function publishPersistenceStatus(status, detail) {
    const next = Object.assign({ status, at: Date.now() }, detail || {});
    App.__persistence = Object.assign({}, App.__persistence || {}, next);
    if (status !== 'failed') return;
    const fingerprint = String(next.code || next.error || 'persistence_failed');
    if (_lastPersistenceNotice === fingerprint) return;
    _lastPersistenceNotice = fingerprint;
    try {
      if (App.ui && App.ui.notify) App.ui.notify('数据保存失败', '当前内容仍保留在内存/浏览器回退存储，请检查数据目录后重试');
      else if (App.ui && App.ui.toast) App.ui.toast('数据保存失败：' + fingerprint);
    } catch (_) {}
  }

  function handlePersistenceResult(result, revision, kind) {
    const response = result && typeof result === 'object' ? result : { ok: false, code: kind + '_no_result' };
    if (_stateRevision !== revision && response.ok === false) return response;
    if (response.ok === false) {
      publishPersistenceStatus('failed', { code: response.code || response.reason || kind + '_failed', error: response.error || response.message || '', revision, kind });
    } else if (kind === 'file') {
      publishPersistenceStatus('saved', { revision, file: 'saved', sqlite: (App.__persistence && App.__persistence.sqlite) || 'pending' });
    } else {
      publishPersistenceStatus('saved', { revision, sqlite: 'saved', file: (App.__persistence && App.__persistence.file) || 'saved' });
    }
    return response;
  }

  function normalizeImageCapabilityStore(value) {
    const api = typeof App !== 'undefined' && App.ImageCapabilities;
    if (api && typeof api.normalizeStore === 'function') return api.normalizeStore(value);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function syncImageCapabilityStore(settings) {
    if (!settings) return {};
    const store = normalizeImageCapabilityStore(settings.imageCapabilities);
    settings.imageCapabilities = store;
    if (App.ImageCapabilities && typeof App.ImageCapabilities.hydrate === 'function') App.ImageCapabilities.hydrate(store);
    return store;
  }

  const defaultState = () => ({
    conversations: [],          // { id, title, messages, updatedAt, agentId?, systemPrompt? }
    activeId: null,
    theme: 'light',
    view: 'chat',
    settings: {
      // 1.0.6 起 API Key 不再进 state：账户只存 { id, name, apiBase, models }，
      // 密钥由主进程 safeStorage 保管，这里只用 ref（acc:<id> / custom:<module> / search）指代。
      accounts: [],             // [{ id, name, apiBase, models:[] }]
      defaultAccountId: '',      // 默认账户 id
      profile: { name: '糖包用户', avatar: '' },
      providers: {
        default: { accountId: '__default__', apiBase: '', model: '' },
        chat:    { accountId: '__default__', apiBase: '', model: '' },
        agent:   { accountId: '__default__', apiBase: '', model: '' },
        create:  { accountId: '__default__', apiBase: '', model: '' },
        tangguan:{ accountId: '__default__', apiBase: '', model: '' },
        image:   { accountId: '__default__', apiBase: '', model: '' },
        doc:     { accountId: '__default__', apiBase: '', model: '' },
      },
      agents: [],
      agentUsage: {},            // { [agentId]: number } 智能体使用次数（覆盖预设+自定义）
      templates: [],             // 历史兼容字段；当前 UI 不再提供模板库
      workflows: [],             // 智能体工作流 [{ id, name, steps:[{title,prompt,usePrev}] }]
      imageHistory: [],          // [{ id, prompt, style, size, n, images:[b64...], createdAt }]
      imageCapabilities: {},     // 图像模型能力缓存，按 API Base + 精确模型隔离
      docs: [],                   // [{ id, name, text, size, createdAt }] 文档解析已上传文档（限长截断）
      agentCwd: '',               // 编码助手工作目录（空则默认项目目录）
      prompts: {                 // 用户可自定义的系统提示词（留空回退内置）
        chat: '',                // 聊天（糖包）系统提示
        agent: '',               // 糖码（编码助手）系统提示
        doc: { summary: '', points: '', translate: '', outline: '' }, // 糖读分析提示
      },
      appearance: { mode: 'system', accent: '', radius: '' }, // 外观主题：mode=light|dark|system
      enabledModules: ['chat', 'image', 'doc', 'create', 'tangguan', 'agent'], // 启用的内置模块
      customModules: [],         // 用户自定义模块 [{ id, label, url, forceEmbed, hidden }]
      search: {},                // 联网搜索配置；Key 存在密钥库的 'search' 引用下，不落 state
      userMemory: '',         // 用户级长期记忆，注入糖码 system prompt
      contextWindow: 128000,  // 模型上下文窗口（token）：自动压缩阈值与 /context 分母；未知模型时回退
      visionModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-5', 'claude-3', 'claude-3-5', 'claude-3-7', 'gemini-1.5', 'gemini-2.0', 'qwen-vl', 'qwen2-vl', 'yi-vl', 'llava', 'internvl', 'pixtral', 'glm-4v', 'minimax', 'step'], // 视觉模型白名单
      permissionRules: [],       // v2（权限大改）：全局权限规则（所有项目生效，项目规则优先）[{ id, tool, pattern, path, allow, scope:'global', force? }]
      // 糖馆只保存可恢复指针；抽屉、标签和编辑脏状态只存在运行时。
      tangguanUi: { lastCharacterId: '', lastConversationId: '' },
    },
    agentThreads: [],            // 糖码多会话线程：[{ id, projectId, title, updatedAt, history:[{role, content}] }]，持久化
    activeThreadId: null,        // 当前激活的糖码会话线程 id
    projects: [],                // 糖码项目：[{ id, name, cwd(主根兼容), workspaceId, roots:[{rootId,name,path}], primaryRootId, ... }]
    activeProjectId: null,       // 当前激活的糖码项目 id
    agentProjectsCollapsed: false, // 糖码项目侧栏是否折叠（旧版，v1.1.0 迁移到 agentTreeCollapsed）
    agentSessionsCollapsed: false, // 糖码会话侧栏是否折叠（旧版，v1.1.0 迁移到 agentTreeCollapsed）
    agentTreeCollapsed: false,     // v1.1.0：项目/会话合一树是否折叠
    agentTreeExpanded: {},         // v1.1.0：项目展开态 { [projectId]: bool }
    agentModel: '',               // v2（UX）：糖码用户最后选中的模型（render 重建/切项目时保持，避免回退默认模型）
    thinkLevel: 'medium',         // 深度思考强度：'off' | 'low' | 'medium' | 'high'
    web: false,
  });

  window.App = window.App || {};
  App.state = defaultState();
  syncImageCapabilityStore(App.state.settings);

  // 内置默认提示词集中定义（供设置面板 placeholder 显示 + 各模块留空时回退引用）
  App.DEFAULT_PROMPTS = {
    chat: '你是一个名为"糖包"的全能 AI 助手，由用户本地前端调用大模型接口驱动。请用简洁、友好、准确的中文回答用户的问题。',
    agent: (typeof App !== 'undefined' && App.AgentPrompt && App.AgentPrompt.SYSTEM_PROMPT) || '',
    doc: {
      summary: '请用中文对下面的资料做一段简洁的摘要（不超过 200 字）。',
      points: '请提取资料中的关键要点，用带编号的列表呈现，每条精简。',
      translate: '请将下面的资料完整翻译成英文，保留原有结构。',
      outline: '请按章节/主题对资料进行拆解，输出层级化的结构大纲（用 Markdown 标题表示层级）。',
    },
  };

  // 解析某模块最终使用的 Base/Model/密钥引用
  //   model  = 当前激活模型，models = 可选模型列表
  //   ref    = 密钥引用（acc:<id> / custom:<module>），实际密钥只在主进程里
  //   hasKey = 该引用在系统密钥库里是否已保存密钥（用于「有没有配好」的判断）
  // 1.0.6 起不再返回 apiKey —— 渲染进程拿不到明文，模型请求一律走 App.rt.gatewayFetch。
  const hasKey = (ref) => !!(ref && App.rt && App.rt.hasSecret(ref));

  App.getProvider = function (module) {
    const s = App.state.settings;
    const sel = (s.providers && s.providers[module]) || s.providers.default;
    if (sel.accountId === '__custom__') {
      const cm = sel.model || '';
      const ref = 'custom:' + module;
      return { apiBase: sel.apiBase || '', ref, hasKey: hasKey(ref), model: cm, models: cm ? [cm] : [] };
    }
    let aid = (module === 'default') ? sel.accountId
      : (sel.accountId || (s.providers.default && s.providers.default.accountId) || s.defaultAccountId);
    if (!aid || aid === '__default__') aid = s.defaultAccountId;
    if (aid && aid !== '__default__') {
      const acc = s.accounts.find(a => a.id === aid);
      if (acc) {
        const models = Array.isArray(acc.models) ? acc.models : (acc.model ? [acc.model] : []);
        // 模型名列表（兼容新旧格式）
        const modelNames = models.map(x => (typeof x === 'string') ? x : (x && x.name ? x.name : '')).filter(Boolean);
        // 优先用 provider.model 中显式选中的；若不在本账户模型列表则回退首个
        const active = (sel.model && modelNames.includes(sel.model)) ? sel.model : (modelNames[0] || '');
        const activeConfig = models.find((item) => (typeof item === 'string' ? item : item && item.name) === active);
        const ref = 'acc:' + acc.id;
        return { apiBase: acc.apiBase || '', ref, hasKey: hasKey(ref), model: active, models: modelNames, profile: typeof activeConfig === 'object' ? Object.assign({}, activeConfig) : { name: active, contextWindow: 128000 } };
      }
    }
    return { apiBase: '', ref: '', hasKey: false, model: '', models: [] };
  };

  // 判断模型的深度思考参数类型：返回 'qwen' | 'doubao' | 'openai' | null
  //  优先读「添加模型时」为该模型配置的 thinkType（每模型配置，避免枚举过时的模型名）；
  //  未配置或选“自动”时才回退到按模型名的正则自动判断（仅作兜底）。
  //  null = 不注入任何思考参数（原生推理，如 grok/deepseek，开关仅影响是否展示思考过程）。
  // 模型能力统一转发到 src/core/models/capabilities.js（双环境单一事实源，取代下列散落正则）
  App.thinkTypeOf = function (name) { return App.ModelCapabilities.thinkTypeOfApp(name); };
  App.thinkSupport = function (model) { return App.ModelCapabilities.thinkSupportApp(model); };
  App.buildThinkParam = function (model, level) {
    const accounts = (App.state && App.state.settings) ? App.state.settings.accounts : [];
    return App.ModelCapabilities.buildThinkParam(model, level, accounts);
  };
  App.nativeWebModel = function (model) { return App.ModelCapabilities.nativeWebModel(model); };
  // 联网搜索参数：原生支持的模型返回对应厂商参数（qwen: enable_search / openai: tools.web_search），其余 {}。
  // 此前该函数缺失，导致联网开启且命中原生联网模型时崩溃；现已补全。
  App.buildWebParam = function (model, enabled) { return App.ModelCapabilities.buildWebParam(model, enabled); };
  App.isVisionModel = function (model) {
    const list = (App.state && App.state.settings) ? App.state.settings.visionModels : undefined;
    return App.ModelCapabilities.isVisionModel(model, list);
  };

  // v2（权限大改）：permissionMode 迁移推导——旧 planMode/auto 映射到 5 档模式
  function derivePermissionMode(p) {
    if (p && typeof p.permissionMode === 'string' && ['plan', 'default', 'acceptEdits', 'auto', 'bypass', 'sandbox'].includes(p.permissionMode)) return p.permissionMode;
    if (!p) return 'default';
    if (p.planMode) return 'plan';
    if (p.auto) return 'auto';
    return 'default';
  }

  // 从一段 JSON 文本还原并归一化应用状态（含旧版迁移）。oldFormat 表示来源为旧版 OLD_KEY。
  function applyLoaded(raw, oldFormat, options) {
    const parsed = JSON.parse(raw);
    const opts = options && typeof options === 'object' ? options : {};
    _stateRevision = Math.max(_stateRevision, persistedRevision(parsed));
    const ns = defaultState();
    Object.assign(ns, parsed);
    delete ns._persistence;
    const ps = (parsed.settings && typeof parsed.settings === 'object') ? parsed.settings : {};
    ns.settings = ns.settings || {};
    ns.settings.accounts = (Array.isArray(ps.accounts) ? ps.accounts : []).map(a => Object.assign({}, a, {
      // 模型迁移：旧 string[] → 新 { name, contextWindow, caps? }[]
      models: Array.isArray(a.models) ? a.models.map(m => {
        if (typeof m === 'string') return { name: m, contextWindow: 128000 };
        if (m && typeof m === 'object' && typeof m.name === 'string')
          return {
            name: m.name,
            contextWindow: (typeof m.contextWindow === 'number' && m.contextWindow > 0) ? m.contextWindow : 128000,
            caps: (m.caps && ['auto', 'tool_vision', 'tool', 'vision', 'text'].includes(m.caps)) ? m.caps : undefined,
            // 聊天修复 D：maxOutput/thinkType 往返（归一化不再丢弃）
            maxOutput: (typeof m.maxOutput === 'number' && m.maxOutput > 0) ? m.maxOutput : undefined,
            thinkType: (typeof m.thinkType === 'string' && m.thinkType) ? m.thinkType : undefined,
            timeoutMs: (typeof m.timeoutMs === 'number' && m.timeoutMs > 0) ? m.timeoutMs : undefined,
            budgetMaxSteps: (typeof m.budgetMaxSteps === 'number' && m.budgetMaxSteps > 0) ? m.budgetMaxSteps : undefined,
            budgetMaxCostUsd: (typeof m.budgetMaxCostUsd === 'number' && m.budgetMaxCostUsd >= 0) ? m.budgetMaxCostUsd : undefined,
            imageModel: m.imageModel === true ? true : undefined,
            imageProtocol: (typeof m.imageProtocol === 'string' && m.imageProtocol) ? m.imageProtocol : undefined,
            imageSizeStrategy: (typeof m.imageSizeStrategy === 'string' && m.imageSizeStrategy) ? m.imageSizeStrategy : undefined,
            imageSizeFormat: (typeof m.imageSizeFormat === 'string' && m.imageSizeFormat) ? m.imageSizeFormat : undefined,
            imageSizes: Array.isArray(m.imageSizes) ? m.imageSizes.filter((size) => typeof size === 'string').slice(0, 32) : undefined,
          };
        return null;
      }).filter(Boolean) : (a.model ? [{ name: a.model, contextWindow: 128000 }] : []),
    }));
    ns.settings.defaultAccountId = ps.defaultAccountId || '';
    ns.settings.profile = {
      name: (ps.profile && ps.profile.name) || '糖包用户',
      avatar: (ps.profile && ps.profile.avatar) || '',
    };
    ns.settings.agents = Array.isArray(ps.agents) ? ps.agents : [];
    ns.settings.agentUsage = (ps.agentUsage && typeof ps.agentUsage === 'object') ? ps.agentUsage : {};
    ns.settings.templates = Array.isArray(ps.templates) ? ps.templates : [];
    ns.settings.workflows = Array.isArray(ps.workflows) ? ps.workflows : [];
    ns.settings.imageHistory = Array.isArray(ps.imageHistory)
      ? ps.imageHistory.filter(x => x && (Array.isArray(x.images) || Array.isArray(x.files)))
      : [];
    ns.settings.docs = Array.isArray(ps.docs)
      ? ps.docs.filter(x => x && typeof x.text === 'string')
      : [];
    ns.settings.agentCwd = (typeof ps.agentCwd === 'string') ? ps.agentCwd : '';
    // 自定义提示词（旧版无此字段则给默认空结构）
    const psPrompts = (ps.prompts && typeof ps.prompts === 'object') ? ps.prompts : {};
    ns.settings.prompts = {
      chat: typeof psPrompts.chat === 'string' ? psPrompts.chat : '',
      agent: typeof psPrompts.agent === 'string' ? psPrompts.agent : '',
      doc: (psPrompts.doc && typeof psPrompts.doc === 'object') ? {
        summary: psPrompts.doc.summary || '', points: psPrompts.doc.points || '',
        translate: psPrompts.doc.translate || '', outline: psPrompts.doc.outline || '',
      } : { summary: '', points: '', translate: '', outline: '' },
    };
    // 外观主题
    const psAp = (ps.appearance && typeof ps.appearance === 'object') ? ps.appearance : {};
    ns.settings.appearance = {
      mode: (psAp.mode === 'dark' || psAp.mode === 'light' || psAp.mode === 'system') ? psAp.mode : 'system',
      accent: typeof psAp.accent === 'string' ? psAp.accent : '',
      radius: typeof psAp.radius === 'string' ? psAp.radius : '',
    };
    // 模块开关 / 自定义模块（保留用户自定义顺序，仅过滤非法 id）
    const allBuiltin = ['chat', 'image', 'doc', 'create', 'tangguan', 'agent'];
    const validBuiltinIds = new Set(allBuiltin);
    const storedModules = Array.isArray(ps.enabledModules)
      ? ps.enabledModules.filter(id => validBuiltinIds.has(id)) : allBuiltin.slice();
    // Tangguan did not exist in older snapshots. Add only the new module while
    // preserving the user's existing order and other enable/disable choices.
    ns.settings.enabledModules = Array.from(new Set(storedModules.concat('tangguan')));
    ns.settings.customModules = Array.isArray(ps.customModules)
      ? ps.customModules.filter(m => m && m.id && m.label && m.url).map(m => ({ id: m.id, label: String(m.label), url: String(m.url), forceEmbed: !!m.forceEmbed, hidden: !!m.hidden }))
      : [];
    // 联网搜索：1.0.6 起 Key 存密钥库。这里只在读到旧版明文时临时保留，
    // 交给启动时的 App.rt.migrateSecrets() 搬进密钥库并删除。
    ns.settings.search = {};
    if (ps.search && typeof ps.search === 'object' && typeof ps.search.apiKey === 'string' && ps.search.apiKey) {
      ns.settings.search.apiKey = ps.search.apiKey;
    }
    // 用户级长期记忆
    ns.settings.userMemory = (typeof ps.userMemory === 'string') ? ps.userMemory : '';
    // 上下文窗口（token）：自动压缩阈值与 /context 分母；未知模型时回退
    ns.settings.contextWindow = (typeof ps.contextWindow === 'number' && ps.contextWindow > 0) ? ps.contextWindow : 128000;
    // 思考强度迁移：旧版 think:boolean → 新版 thinkLevel: 'off'|'low'|'medium'|'high'
    if (ps.thinkLevel && ['off','low','medium','high'].includes(ps.thinkLevel)) {
      ns.settings.thinkLevel = ps.thinkLevel;
    } else if (ps.think === false) {
      ns.settings.thinkLevel = 'off';
    } else if (ps.think === true) {
      ns.settings.thinkLevel = 'medium';
    }
    // 视觉模型白名单（旧版无则给默认）
    ns.settings.visionModels = Array.isArray(ps.visionModels) && ps.visionModels.length
      ? ps.visionModels
      : ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-5', 'claude-3', 'claude-3-5', 'claude-3-7', 'gemini-1.5', 'gemini-2.0', 'qwen-vl', 'qwen2-vl', 'yi-vl', 'llava', 'internvl', 'pixtral', 'glm-4v', 'minimax', 'step'];
    const tgUi = (ps.tangguanUi && typeof ps.tangguanUi === 'object') ? ps.tangguanUi : {};
    ns.settings.tangguanUi = {
      lastCharacterId: typeof tgUi.lastCharacterId === 'string' ? tgUi.lastCharacterId : '',
      lastConversationId: typeof tgUi.lastConversationId === 'string' ? tgUi.lastConversationId : '',
    };
    // 糖码多会话线程：归一化 + 旧版 agentHistory 迁移为首个线程
    const cleanSkills = (arr) => {
      const out = [], seen = new Set();
      for (const s of (Array.isArray(arr) ? arr : [])) {
        const name = String((s && s.name) || '').trim();
        if (!name || seen.has(name) || out.length >= 8) continue;
        seen.add(name);
        out.push({ name, description: String((s && s.description) || ''), level: String((s && s.level) || 'user') });
      }
      return out;
    };
    const cleanHist = (arr) => (Array.isArray(arr) ? arr : [])
      .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
      .map(h => h.role === 'user' ? { role: 'user', content: h.content, skills: cleanSkills(h.skills) } : { role: 'assistant', content: h.content })
      .slice(-60);
    let threads = Array.isArray(parsed.agentThreads)
      ? parsed.agentThreads
        .filter(t => t && typeof t === 'object')
        .map(t => ({
          id: t.id || App.uid(),
          projectId: t.projectId || null,   // 归属项目（旧数据无则后续迁移补上）
          title: (typeof t.title === 'string' && t.title.trim()) ? t.title : '新会话',
          updatedAt: Number(t.updatedAt) || Date.now(),
          pinned: !!t.pinned,
          archived: !!t.archived,
          tags: Array.isArray(t.tags) ? t.tags.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean).slice(0, 8) : [],
          history: cleanHist(t.history),
          draftText: typeof t.draftText === 'string' ? t.draftText : '',
          draftSkills: cleanSkills(t.draftSkills),
          draftRootScope: (t.draftRootScope && typeof t.draftRootScope === 'object') ? { mode: ['primary', 'single', 'all'].includes(t.draftRootScope.mode) ? t.draftRootScope.mode : 'primary', rootId: t.draftRootScope.mode === 'single' ? String(t.draftRootScope.rootId || '') : '' } : { mode: 'primary', rootId: '' },
          _liveAnswer: typeof t._liveAnswer === 'string' ? t._liveAnswer : '',
          _liveEvents: Array.isArray(t._liveEvents) ? t._liveEvents.slice(-240) : [],
          _pendingUser: typeof t._pendingUser === 'string'
            ? { content: t._pendingUser, skills: [] }
            : (t._pendingUser && typeof t._pendingUser === 'object' ? { content: String(t._pendingUser.content || ''), skills: cleanSkills(t._pendingUser.skills) } : null),
          _running: !!t._running,
        }))
      : [];
    // 旧版单条 agentHistory → 若无线程则包成首个会话
    const oldHist = cleanHist(parsed.agentHistory);
    if (!threads.length && oldHist.length) {
      threads = [{ id: App.uid(), projectId: null, title: '会话 1', updatedAt: Date.now(), pinned: false, archived: false, tags: [], history: oldHist, draftText: '', draftSkills: [], draftRootScope: { mode: 'primary', rootId: '' } }];
    }
    // 糖码项目：归一化 + 旧版迁移（无项目时用旧 agentCwd 创建默认项目）
    let projects = Array.isArray(parsed.projects)
      ? parsed.projects
        .filter(p => p && typeof p === 'object' && p.id)
        .map(p => ({
          id: p.id,
          name: (typeof p.name === 'string' && p.name.trim()) ? p.name : '未命名项目',
          cwd: typeof p.cwd === 'string' ? p.cwd : '',
          workspaceId: typeof p.workspaceId === 'string' ? p.workspaceId : '',
          roots: Array.isArray(p.roots) ? p.roots.filter(r => r && typeof r.rootId === 'string' && typeof r.path === 'string').map(r => ({ rootId: r.rootId, name: typeof r.name === 'string' ? r.name : '', path: r.path })) : [],
          primaryRootId: typeof p.primaryRootId === 'string' ? p.primaryRootId : '',
          auto: !!p.auto,
          approveTools: Array.isArray(p.approveTools) ? p.approveTools.filter(x => typeof x === 'string') : [],
          cmdWhitelist: Array.isArray(p.cmdWhitelist) ? p.cmdWhitelist.filter(x => typeof x === 'string') : [],
          planMode: !!p.planMode,
          maxSteps: Number(p.maxSteps) || 0, // v2（权限大改①）：补 maxSteps 往返
          createdAt: Number(p.createdAt) || Date.now(),
          lastUsedAt: Number(p.lastUsedAt) || Date.now(),
          // v2（权限大改）：permissionMode 5 档（缺省按旧字段迁移）
          permissionMode: derivePermissionMode(p),
          permissionRules: Array.isArray(p.permissionRules) ? p.permissionRules : [],
          pinned: !!p.pinned,
          tags: Array.isArray(p.tags) ? p.tags.filter(x => typeof x === 'string').map(x => x.trim()).filter(Boolean).slice(0, 8) : [],
          healthStatus: ['healthy', 'degraded', 'offline', 'unknown'].includes(p.healthStatus) ? p.healthStatus : 'unknown',
          healthCheckedAt: Number(p.healthCheckedAt) || 0,
          healthRoots: Array.isArray(p.healthRoots) ? p.healthRoots.slice(0, 32) : [],
        }))
      : [];
    if (!projects.length) {
      // 迁移：用旧 agentCwd 创建默认项目，approveTools 留空保持原行为
      projects = [{ id: App.uid(), name: '默认项目', cwd: (typeof ps.agentCwd === 'string' ? ps.agentCwd : ''), workspaceId: '',
        auto: false, approveTools: [], cmdWhitelist: [], planMode: false, permissionMode: 'default', permissionRules: [], pinned: false, tags: [], healthStatus: 'unknown', healthCheckedAt: 0, healthRoots: [], createdAt: Date.now(), lastUsedAt: Date.now() }];
    }
    const firstPid = projects[0].id;
    // 把无 projectId 的线程归到首个项目
    for (const t of threads) { if (!t.projectId) t.projectId = firstPid; }
    ns.projects = projects;
    ns.activeProjectId = (parsed.activeProjectId && projects.some(p => p.id === parsed.activeProjectId))
      ? parsed.activeProjectId : firstPid;
    ns.agentProjectsCollapsed = !!parsed.agentProjectsCollapsed;
    ns.agentSessionsCollapsed = !!parsed.agentSessionsCollapsed;
    // v1.1.0（回退）：树折叠状态迁移到两栏折叠（若曾折叠过树则两栏也折叠）
    if (parsed.agentTreeCollapsed) { ns.agentProjectsCollapsed = true; ns.agentSessionsCollapsed = true; }
    ns.agentThreads = threads;
    // 激活线程：优先用已存在的 activeThreadId，否则取首个线程
    const wantId = parsed.activeThreadId;
    ns.activeThreadId = (wantId && threads.some(t => t.id === wantId))
      ? wantId
      : (threads[0] ? threads[0].id : null);
    const oldProviders = ps.providers || {};
    const newProviders = {};
    // 聊天修复 C：保留全部模块；糖馆单独使用 tangguan Provider，旧快照缺失时跟随默认账户
    for (const m of ['default', 'chat', 'image', 'doc', 'agent', 'create', 'tangguan']) {
      const op = oldProviders[m] || {};
      let accountId = (op.accountId !== undefined) ? op.accountId
        : (op.useDefault === false ? '__custom__' : '__default__');
      newProviders[m] = {
        accountId: accountId || '__default__',
        apiBase: op.apiBase || '', model: op.model || '',
      };
      // 旧版明文 Key 暂留一手，等启动时的 migrateSecrets() 搬进密钥库后会被删掉
      if (op.apiKey) newProviders[m].apiKey = op.apiKey;
    }
    ns.settings.providers = newProviders;
    syncImageCapabilityStore(ns.settings);
    // 旧版单配置：把默认 provider 升级为一个账户
    if (oldFormat && oldProviders.default && oldProviders.default.apiBase) {
      const acc = {
        id: App.uid(), name: '默认账户',
        apiBase: oldProviders.default.apiBase,
        models: oldProviders.default.model ? [oldProviders.default.model] : [],
      };
      // 同上：明文 Key 只是过渡，migrateSecrets() 迁移成功后即从 state 移除
      if (oldProviders.default.apiKey) acc.apiKey = oldProviders.default.apiKey;
      ns.settings.accounts = [acc];
      ns.settings.defaultAccountId = acc.id;
      for (const m of ['default', 'chat', 'image', 'doc', 'agent', 'create', 'tangguan']) ns.settings.providers[m].accountId = '__default__';
    }
    syncImageCapabilityStore(ns.settings);
    App.state = ns;
    if (opts.persist === true) App.persist();
    if (oldFormat) { try { localStorage.removeItem(OLD_KEY); } catch (e) {} }
  }

  // 载入本地持久化状态（含旧版迁移）。
  // 关键修复：1.0.6 起静态服务端口改为系统随机分配，而 localStorage 按 origin（含端口）分区，
  // 端口一变 origin 即变，原 localStorage 全读不到 → 升级 / 每次重启都会丢数据。
  // 故优先从与端口无关的磁盘 state.json 读取（App.persist 一直双写它），localStorage 仅作回退。
  App.loadState = async function (options) {
    const opts = options && typeof options === 'object' ? options : {};
    const candidates = [];
    const addCandidate = (candidate, source) => {
      if (candidate) candidates.push(Object.assign({ source }, candidate));
    };

    let primary = null;
    if (typeof opts.raw === 'string') {
      primary = parseStateCandidate(opts.raw, !!opts.oldFormat);
      if (primary) primary.source = opts.source || 'provided';
    } else {
      try {
        if (App.services.fs && App.services.fs.loadStateJSON) {
          const res = await App.services.fs.loadStateJSON();
          primary = parseStateCandidate(res && res.ok ? res.data : null, false);
          if (primary) primary.source = 'state.json';
        }
      } catch (_) {}
    }

    // Only consult fallbacks when the primary snapshot is absent or incomplete.
    // This keeps the newest conversation output authoritative while recovering
    // account/settings fields from an older complete snapshot when necessary.
    if (!primary || stateNeedsRecovery(primary.value)) {
      try {
        if (App.services.fs && App.services.fs.loadStorage) {
          const r = await App.services.fs.loadStorage();
          if (r && r.ok && r.state && typeof r.state === 'object') {
            addCandidate(parseStateCandidate(JSON.stringify(r.state), false), 'sqlite');
          }
        }
      } catch (_) {}
      if (!opts.raw) {
        try {
          let raw = localStorage.getItem(STORAGE_KEY);
          let oldFormat = false;
          if (!raw) {
            raw = localStorage.getItem(OLD_KEY);
            oldFormat = !!raw;
          }
          addCandidate(parseStateCandidate(raw, oldFormat), oldFormat ? 'legacy-localStorage' : 'localStorage');
          addCandidate(parseStateCandidate(localStorage.getItem(ACCOUNT_RECOVERY_KEY), false), 'account-recovery');
        } catch (_) {}
      }
    }

    if (!primary) primary = candidates.shift() || null;
    if (!primary) return { ok: false, code: 'state_unavailable' };

    let value = primary.value;
    let recovered = false;
    if (stateNeedsRecovery(value)) {
      for (const fallback of candidates) {
        const next = mergeMissingState(value, fallback.value);
        if (JSON.stringify(next) !== JSON.stringify(value)) recovered = true;
        value = next;
        if (!stateNeedsRecovery(value)) break;
      }
    }

    const stillIncomplete = stateNeedsRecovery(value, { ignoreCustomModules: true });
    App.__stateRecovery = (recovered || stillIncomplete)
      ? { code: stillIncomplete ? 'partial_state' : 'state_recovered', source: primary.source, needsUserReview: stillIncomplete }
      : null;
    applyLoaded(JSON.stringify(value), primary.oldFormat, { persist: false });
    if (primary.oldFormat || recovered) App.persist();
    return { ok: true, source: primary.source, recovered, incomplete: stillIncomplete };
  };

  App.loadStateFromRaw = function (raw, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const candidate = parseStateCandidate(raw, !!opts.oldFormat);
    if (!candidate) return { ok: false, code: 'invalid_state' };
    applyLoaded(candidate.raw, candidate.oldFormat, { persist: opts.persist === true });
    return { ok: true };
  };

  App.persist = function (options) {
    const opts = options && typeof options === 'object' ? options : {};
    if (opts.flushPartial) {
      const partial = createPartialSnapshot(opts);
      if (!partial) return { ok: false, code: 'partial_target_missing' };
      let diskResult = null;
      try {
        if (fileWriteMethod(opts)) diskResult = enqueueFileWrite(partial, opts);
        else publishPersistenceStatus('degraded', { code: 'partial_persistence_backend_missing', revision: partial.revision });
      } catch (e) {
        handlePersistenceResult({ ok: false, code: 'partial_state_write_failed', error: e && e.message ? e.message : String(e) }, partial.revision, 'file');
      }
      return { ok: true, revision: partial.revision, pending: isThenable(diskResult), partial: true };
    }
    const snapshot = createPersistedSnapshot(opts);
    if (!snapshot) return { ok: false, error: 'state_serialize_failed' };
    let localStorageOk = true;
    try {
      localStorage.setItem(STORAGE_KEY, snapshot.json);
      const recovery = accountRecoverySnapshot();
      if (recovery) localStorage.setItem(ACCOUNT_RECOVERY_KEY, recovery);
      else if (opts.allowAccountReset === true) localStorage.removeItem(ACCOUNT_RECOVERY_KEY);
    } catch (e) {
      localStorageOk = false;
      publishPersistenceStatus('degraded', { code: 'local_storage_write_failed', error: e && e.message ? e.message : String(e), revision: snapshot.revision });
    }
    // 文件双写：state.json 使用 revision，主进程会拒绝过期快照。高频保存只
    // 保留队列中的最新快照，避免流式输出把渲染进程拖入 IPC 写入风暴。
    let diskResult = null;
    try {
      if (fileWriteMethod(opts)) {
        diskResult = enqueueFileWrite(snapshot, opts);
      } else if (!localStorageOk) {
        handlePersistenceResult({ ok: false, code: 'no_persistence_backend' }, snapshot.revision, 'file');
      } else {
        publishPersistenceStatus('saved', { revision: snapshot.revision, file: 'localStorage', sqlite: 'not_configured' });
      }
    } catch (e) {
      handlePersistenceResult({ ok: false, code: opts.flushPartial ? 'partial_state_write_failed' : 'state_file_write_failed', error: e && e.message ? e.message : String(e) }, snapshot.revision, 'file');
    }
    // 主窗口把脱敏状态推送给浮窗；浮窗从不把 settings 回传覆盖主窗口。
    try {
      if (!App.__floatMode && App.services.float && App.services.float.pushState) {
        App.services.float.pushState({ state: sanitizeFloatState(App.state), revision: snapshot.revision });
      }
    } catch (e) { /* ignore */ }
    // 账户/自定义地址没有变化时不重复同步模型网关。
    try {
      const fingerprint = endpointFingerprint();
      if (App.rt && App.rt.syncEndpoints && fingerprint !== _lastEndpointFingerprint) {
        _lastEndpointFingerprint = fingerprint;
        Promise.resolve(App.rt.syncEndpoints()).catch(() => {});
      }
    } catch (e) { /* ignore */ }
    // M4 写穿：SQLite 同样使用单写入通道，连续保存只保留最新快照。
    try { enqueueSqliteSync(snapshot); } catch (e) { /* ignore */ }
    return { ok: true, revision: snapshot.revision, pending: isThenable(diskResult), localStorage: localStorageOk };
  };

  // Internal lifecycle hook for shutdown, diagnostics, and tests. It waits
  // for the current file/SQLite queues without changing the storage format.
  App.persistence = {
    flush(options) {
      const opts = options && typeof options === 'object' ? options : {};
      if (_sqliteSyncTimer) {
        clearTimeout(_sqliteSyncTimer);
        _sqliteSyncTimer = null;
        pumpSqliteSync();
      }
      const waits = [];
      if (_fileWriteInFlight) waits.push(_fileWriteInFlight);
      if (_fileWritePending) { pumpFileWrite(); if (_fileWriteInFlight) waits.push(_fileWriteInFlight); }
      if (_sqliteSyncInFlight) waits.push(_sqliteSyncInFlight);
      if (_sqliteSyncPending) { pumpSqliteSync(); if (_sqliteSyncInFlight) waits.push(_sqliteSyncInFlight); }
      if (opts.snapshot !== false && !opts.partial) {
        const snapshot = createPersistedSnapshot(opts);
        if (snapshot && fileWriteMethod(opts)) waits.push(enqueueFileWrite(snapshot, opts));
        try { enqueueSqliteSync(snapshot); } catch (_) {}
        if (_sqliteSyncTimer) {
          clearTimeout(_sqliteSyncTimer);
          _sqliteSyncTimer = null;
          pumpSqliteSync();
          if (_sqliteSyncInFlight) waits.push(_sqliteSyncInFlight);
        }
      }
      const unique = Array.from(new Set(waits.filter((item) => item && typeof item.then === 'function')));
      return unique.length ? Promise.allSettled(unique).then((items) => ({
        ok: items.every((item) => item.status === 'fulfilled' && (!item.value || item.value.ok !== false)),
        results: items.map((item) => item.status === 'fulfilled' ? item.value : { ok: false, error: String(item.reason || '') }),
      })) : Promise.resolve({ ok: true, results: [] });
    },
    pending() { return !!(_fileWriteInFlight || _fileWritePending || _sqliteSyncInFlight || _sqliteSyncPending || _sqliteSyncTimer); },
  };

  // Internal lifecycle hook used by shutdown, diagnostics and tests. It does
  // not create a new persistence format and never writes secrets.
  App.persistence = {
    flush(options) { return flushPersistence(options); },
    pending() { return !!(_fileWriteInFlight || _fileWritePending || _sqliteSyncInFlight || _sqliteSyncPending || _sqliteSyncTimer); },
  };

  // M4 写穿兜底：关闭前若有未落盘的同步立即 flush（聊天修复：改同步 sendSync，杜绝 fire-and-forget 竞态）
  try {
    window.addEventListener('beforeunload', () => {
      try {
        if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
        if (_sqliteSyncTimer) { clearTimeout(_sqliteSyncTimer); _sqliteSyncTimer = null; }
        const snapshot = createPersistedSnapshot();
        if (snapshot && snapshot.json !== _lastSyncedJson) {
          _lastSyncedJson = snapshot.json;
          try { localStorage.setItem(STORAGE_KEY, snapshot.json); } catch (_) {}
          try {
            if (App.services.fs && App.services.fs.saveStateJSON) App.services.fs.saveStateJSON(snapshot.json, snapshot.revision);
          } catch (_) {}
          if (App.services.fs && App.services.fs.flushStorageSync) {
            App.services.fs.flushStorageSync(snapshot.json, snapshot.revision);
          } else if (App.rt && App.rt.syncStorage) {
            App.rt.syncStorage(snapshot.json, snapshot.revision);
          }
        }
      } catch (e) { /* ignore */ }
    });
  } catch (e) { /* ignore */ }

  App.uid = function () {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  };

  // M6：从完整备份 JSON 恢复应用状态（导入用）。复用 applyLoaded 归一化 + 落盘。
  App.loadFromJson = function (raw) {
    try {
      if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: '备份内容为空' };
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || (!obj.conversations && !obj.settings)) return { ok: false, error: '不是有效的糖包备份' };
      applyLoaded(raw, false);
      App.persist();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  };

  App.defaultState = defaultState;
})();
