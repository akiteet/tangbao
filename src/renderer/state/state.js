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

  function stateNeedsRecovery(value) {
    const settings = value && value.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return true;
    if (!hasOwn(value, 'conversations') || !hasOwn(settings, 'accounts') || !hasOwn(settings, 'providers')) return true;
    return Array.isArray(settings.accounts) && settings.accounts.length === 0 && hasConfiguredAccountReference(value);
  }

  function mergeMissingState(primary, fallback) {
    const p = primary && typeof primary === 'object' ? primary : {};
    const f = fallback && typeof fallback === 'object' ? fallback : {};
    const merged = Object.assign({}, f, p);
    if (p.settings || f.settings) {
      const ps = p.settings && typeof p.settings === 'object' ? p.settings : {};
      const fs = f.settings && typeof f.settings === 'object' ? f.settings : {};
      merged.settings = Object.assign({}, fs, ps);
      if (Array.isArray(ps.accounts) && ps.accounts.length === 0 && Array.isArray(fs.accounts) && fs.accounts.length > 0 && hasConfiguredAccountReference(p)) {
        merged.settings.accounts = fs.accounts;
        if (!ps.defaultAccountId && fs.defaultAccountId) merged.settings.defaultAccountId = fs.defaultAccountId;
      }
      if (ps.providers || fs.providers) {
        const pp = ps.providers && typeof ps.providers === 'object' ? ps.providers : {};
        const fp = fs.providers && typeof fs.providers === 'object' ? fs.providers : {};
        merged.settings.providers = Object.assign({}, fp, pp);
      }
    }
    return merged;
  }

  function sanitizeFloatState(value) {
    let copy;
    try { copy = JSON.parse(JSON.stringify(value || {})); } catch (_) { return {}; }
    if (copy.settings && typeof copy.settings === 'object') {
      if (copy.settings.search && typeof copy.settings.search === 'object') copy.settings.search = {};
      if (Array.isArray(copy.settings.accounts)) {
        copy.settings.accounts = copy.settings.accounts.map((account) => {
          const next = Object.assign({}, account);
          delete next.apiKey;
          return next;
        });
      }
      if (copy.settings.providers && typeof copy.settings.providers === 'object') {
        copy.settings.providers = Object.fromEntries(Object.entries(copy.settings.providers).map(([key, provider]) => {
          const next = Object.assign({}, provider || {});
          delete next.apiKey;
          return [key, next];
        }));
      }
    }
    return copy;
  }

  function createPersistedSnapshot() {
    let content;
    try { content = JSON.stringify(App.state); } catch (_) { return null; }
    if (_pendingSnapshot && content === _lastPersistedStateJson) return _pendingSnapshot;
    _stateRevision = Math.max(_stateRevision, Date.now());
    const revision = _stateRevision + 1;
    _stateRevision = revision;
    const persisted = Object.assign({}, App.state, {
      _persistence: { revision, savedAt: Date.now(), format: 1 },
    });
    const json = JSON.stringify(persisted, null, 2);
    _lastPersistedStateJson = content;
    _pendingSnapshot = { content, json, revision };
    return _pendingSnapshot;
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
    const current = createPersistedSnapshot();
    if (current && current.revision !== revision && response.ok === false) return response;
    if (response.ok === false) {
      publishPersistenceStatus('failed', { code: response.code || response.reason || kind + '_failed', error: response.error || response.message || '', revision, kind });
    } else if (kind === 'file') {
      publishPersistenceStatus('saved', { revision, file: 'saved', sqlite: (App.__persistence && App.__persistence.sqlite) || 'pending' });
    } else {
      publishPersistenceStatus('saved', { revision, sqlite: 'saved', file: (App.__persistence && App.__persistence.file) || 'saved' });
    }
    return response;
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
        image:   { accountId: '__default__', apiBase: '', model: '' },
        doc:     { accountId: '__default__', apiBase: '', model: '' },
      },
      agents: [],
      agentUsage: {},            // { [agentId]: number } 智能体使用次数（覆盖预设+自定义）
      templates: [],             // 提示词模板库 [{ id, title, category, prompt, icon }]
      workflows: [],             // 智能体工作流 [{ id, name, steps:[{title,prompt,usePrev}] }]
      imageHistory: [],          // [{ id, prompt, style, size, n, images:[b64...], createdAt }]
      docs: [],                   // [{ id, name, text, size, createdAt }] 文档解析已上传文档（限长截断）
      agentCwd: '',               // 编码助手工作目录（空则默认项目目录）
      prompts: {                 // 用户可自定义的系统提示词（留空回退内置）
        chat: '',                // 聊天（糖包）系统提示
        agent: '',               // 糖码（编码助手）系统提示
        doc: { summary: '', points: '', translate: '', outline: '' }, // 糖读分析提示
      },
      appearance: { mode: 'system', accent: '', radius: '' }, // 外观主题：mode=light|dark|system
      enabledModules: ['chat', 'image', 'doc', 'create', 'agent'], // 启用的内置模块
      customModules: [],         // 用户自定义模块 [{ id, label, url, forceEmbed, hidden }]
      search: {},                // 联网搜索配置；Key 存在密钥库的 'search' 引用下，不落 state
      userMemory: '',         // 用户级长期记忆，注入糖码 system prompt
      contextWindow: 128000,  // 模型上下文窗口（token）：自动压缩阈值与 /context 分母；未知模型时回退
      visionModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-5', 'claude-3', 'claude-3-5', 'claude-3-7', 'gemini-1.5', 'gemini-2.0', 'qwen-vl', 'qwen2-vl', 'yi-vl', 'llava', 'internvl', 'pixtral', 'glm-4v', 'minimax', 'step'], // 视觉模型白名单
      permissionRules: [],       // v2（权限大改）：全局权限规则（所有项目生效，项目规则优先）[{ id, tool, pattern, path, allow, scope:'global', force? }]
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
      ? ps.imageHistory.filter(x => x && Array.isArray(x.images))
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
    const allBuiltin = ['chat', 'image', 'doc', 'create', 'agent'];
    const validBuiltinIds = new Set(allBuiltin);
    ns.settings.enabledModules = Array.isArray(ps.enabledModules)
      ? ps.enabledModules.filter(id => validBuiltinIds.has(id)) : allBuiltin.slice();
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
    // 聊天修复 C：保留全部 6 个模块（此前 agent/create 每载必丢 → 重启回退默认账户）
    for (const m of ['default', 'chat', 'image', 'doc', 'agent', 'create']) {
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
      for (const m of ['default', 'chat', 'image', 'doc', 'agent', 'create']) ns.settings.providers[m].accountId = '__default__';
    }
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

    const stillIncomplete = stateNeedsRecovery(value);
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

  App.persist = function () {
    const snapshot = createPersistedSnapshot();
    if (!snapshot) return { ok: false, error: 'state_serialize_failed' };
    let localStorageOk = true;
    try {
      localStorage.setItem(STORAGE_KEY, snapshot.json);
      const recovery = accountRecoverySnapshot();
      if (recovery) localStorage.setItem(ACCOUNT_RECOVERY_KEY, recovery);
    } catch (e) {
      localStorageOk = false;
      publishPersistenceStatus('degraded', { code: 'local_storage_write_failed', error: e && e.message ? e.message : String(e), revision: snapshot.revision });
    }
    // 文件双写：state.json 使用 revision，主进程会拒绝过期快照。
    let diskResult = null;
    try {
      if (App.services.fs && App.services.fs.saveStateJSON) {
        diskResult = App.services.fs.saveStateJSON(snapshot.json, snapshot.revision);
        if (isThenable(diskResult)) {
          const pending = Promise.resolve(diskResult)
            .then((result) => handlePersistenceResult(result, snapshot.revision, 'file'))
            .catch((error) => handlePersistenceResult({ ok: false, code: 'state_file_write_failed', error: error && error.message ? error.message : String(error) }, snapshot.revision, 'file'));
          App.__persistencePromise = pending;
        } else {
          handlePersistenceResult(diskResult, snapshot.revision, 'file');
        }
      } else if (!localStorageOk) {
        handlePersistenceResult({ ok: false, code: 'no_persistence_backend' }, snapshot.revision, 'file');
      } else {
        publishPersistenceStatus('saved', { revision: snapshot.revision, file: 'localStorage', sqlite: 'not_configured' });
      }
    } catch (e) {
      handlePersistenceResult({ ok: false, code: 'state_file_write_failed', error: e && e.message ? e.message : String(e) }, snapshot.revision, 'file');
    }
    // 主窗口把脱敏状态推送给浮窗；浮窗从不把 settings 回传覆盖主窗口。
    try {
      if (!App.__floatMode && App.services.float && App.services.float.pushState) {
        App.services.float.pushState({ state: sanitizeFloatState(App.state), revision: snapshot.revision });
      }
    } catch (e) { /* ignore */ }
    // 账户/自定义地址可能刚被改过，同步给主进程的模型网关
    try { if (App.rt && App.rt.syncEndpoints) App.rt.syncEndpoints(); } catch (e) { /* ignore */ }
    // M4 写穿：防抖后把同一份带 revision 的快照同步进 SQLite。
    try {
      if (_syncTimer) clearTimeout(_syncTimer);
      _syncTimer = setTimeout(() => {
        _syncTimer = null;
        try {
          if (!App.rt || !App.rt.syncStorage) return;
          const current = createPersistedSnapshot();
          if (!current || current.json === _lastSyncedJson) return;
          const result = App.rt.syncStorage(current.json, current.revision);
          const settle = (response) => {
            if (response && response.ok === false && response.reason !== 'no-sqlite') {
              handlePersistenceResult(response, current.revision, 'sqlite');
              return response;
            }
            _lastSyncedJson = current.json;
            publishPersistenceStatus('saved', { revision: current.revision, sqlite: response && response.ok === false ? 'fallback' : 'saved' });
            return response;
          };
          if (isThenable(result)) Promise.resolve(result).then(settle).catch((error) => settle({ ok: false, code: 'sqlite_sync_failed', error: error && error.message ? error.message : String(error) }));
          else settle(result);
        } catch (e) {
          handlePersistenceResult({ ok: false, code: 'sqlite_sync_failed', error: e && e.message ? e.message : String(e) }, snapshot.revision, 'sqlite');
        }
      }, 800);
    } catch (e) { /* ignore */ }
    return { ok: true, revision: snapshot.revision, pending: isThenable(diskResult), localStorage: localStorageOk };
  };

  // M4 写穿兜底：关闭前若有未落盘的同步立即 flush（聊天修复：改同步 sendSync，杜绝 fire-and-forget 竞态）
  try {
    window.addEventListener('beforeunload', () => {
      try {
        if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
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
