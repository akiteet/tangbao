'use strict';
(function () {
  const STORAGE_KEY = 'tangbao_web_state_v1';
  const OLD_KEY = 'doubao_web_state_v1';

  const defaultState = () => ({
    conversations: [],          // { id, title, messages, updatedAt, agentId?, systemPrompt? }
    activeId: null,
    theme: 'light',
    view: 'chat',
    settings: {
      accounts: [],             // [{ id, name, apiBase, apiKey, models:[] }]
      defaultAccountId: '',      // 默认账户 id
      profile: { name: '糖包用户', avatar: '' },
      providers: {
        default: { accountId: '__default__', apiBase: '', apiKey: '', model: '' },
        chat:    { accountId: '__default__', apiBase: '', apiKey: '', model: '' },
        agent:   { accountId: '__default__', apiBase: '', apiKey: '', model: '' },
        create:  { accountId: '__default__', apiBase: '', apiKey: '', model: '' },
        image:   { accountId: '__default__', apiBase: '', apiKey: '', model: '' },
        doc:     { accountId: '__default__', apiBase: '', apiKey: '', model: '' },
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
      search: { apiKey: '' },    // 联网搜索可选 Key（留空用内置免费搜索）
      visionModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-5', 'claude-3', 'claude-3-5', 'claude-3-7', 'gemini-1.5', 'gemini-2.0', 'qwen-vl', 'qwen2-vl', 'yi-vl', 'llava', 'internvl', 'pixtral', 'glm-4v', 'minimax', 'step'], // 视觉模型白名单
    },
    agentThreads: [],            // 糖码多会话线程：[{ id, projectId, title, updatedAt, history:[{role, content}] }]，持久化
    activeThreadId: null,        // 当前激活的糖码会话线程 id
    projects: [],                // 糖码项目：[{ id, name, cwd, auto, approveTools:[], cmdWhitelist:[], planMode, createdAt, lastUsedAt }]
    activeProjectId: null,       // 当前激活的糖码项目 id
    agentProjectsCollapsed: false, // 糖码项目侧栏是否折叠
    agentSessionsCollapsed: false, // 糖码会话侧栏是否折叠
    think: true,
    web: false,
  });

  window.App = window.App || {};
  App.state = defaultState();

  // 内置默认提示词集中定义（供设置面板 placeholder 显示 + 各模块留空时回退引用）
  App.DEFAULT_PROMPTS = {
    chat: '你是一个名为"糖包"的全能 AI 助手，由用户本地前端调用大模型接口驱动。请用简洁、友好、准确的中文回答用户的问题。',
    agent: '你是糖码，一个运行在用户本地工作目录中的编码助手，类似 Claude Code。\n\n## 工作准则\n1. 只通过提供的工具完成任务，不要编造文件内容或命令结果。\n2. 多步任务先用 todo_write 拆成可勾选清单并维护进度（开始做某项前标 in_progress，完成标 completed）；单一简单任务可不用。\n3. 先观察再修改：用 list_dir / glob / read_file 读懂上下文；搜文件内容用 grep（支持 glob/-n/-i/-C）；大文件用 read_file 的 offset/limit 只读片段。\n4. 命令仅在当前工作目录内执行；不要访问工作目录之外的路径。需要执行命令时优先用 run_command。\n5. 需要外部信息（报错方案、库用法、文档）时用 web_search 联网检索，不要凭空猜测。\n6. 版本管理优先用 git_command，参数只写 git 之后的部分。\n7. 长任务命令用 run_command 的 run_in_background 后台运行，稍后读取其输出。\n\n## 关于 Plan 模式\n- 若用户开启了 Plan 模式，你只能探索（list_dir/glob/read_file/grep/web_search），不得调用任何会修改文件或执行命令的工具；请基于探索结果给出清晰的实施计划，等用户关闭 Plan 模式后再动手。\n\n## 输出格式\n- 用 Markdown 结构化输出：标题（##）、列表、代码块。\n- 修改文件时，用代码块展示改动的关键片段，标注文件路径。\n- 每步操作后简述做了什么（一句话），不要大段复述工具输出。\n- 任务完成后用以下结构总结：\n  ### 完成\n  简述改动内容（2-3 句）。\n  ### 下一步建议\n  如有后续可做的事，列 1-3 条建议；无则写"无需后续操作"。\n- 回答用中文，简洁直接，不要客套。不要使用 emoji 表情符号。',
    doc: {
      summary: '请用中文对下面的资料做一段简洁的摘要（不超过 200 字）。',
      points: '请提取资料中的关键要点，用带编号的列表呈现，每条精简。',
      translate: '请将下面的资料完整翻译成英文，保留原有结构。',
      outline: '请按章节/主题对资料进行拆解，输出层级化的结构大纲（用 Markdown 标题表示层级）。',
    },
  };

  // 解析某模块最终使用的 Base/Key/Model（model=当前激活模型，models=可选模型列表）
  App.getProvider = function (module) {
    const s = App.state.settings;
    const sel = (s.providers && s.providers[module]) || s.providers.default;
    if (sel.accountId === '__custom__') {
      const cm = sel.model || '';
      return { apiBase: sel.apiBase || '', apiKey: sel.apiKey || '', model: cm, models: cm ? [cm] : [] };
    }
    let aid = (module === 'default') ? sel.accountId
      : (sel.accountId || (s.providers.default && s.providers.default.accountId) || s.defaultAccountId);
    if (!aid || aid === '__default__') aid = s.defaultAccountId;
    if (aid && aid !== '__default__') {
      const acc = s.accounts.find(a => a.id === aid);
      if (acc) {
        const models = Array.isArray(acc.models) ? acc.models : (acc.model ? [acc.model] : []);
        // 优先用 provider.model 中显式选中的；若不在本账户模型列表则回退首个
        const active = (sel.model && models.includes(sel.model)) ? sel.model : (models[0] || '');
        return { apiBase: acc.apiBase || '', apiKey: acc.apiKey || '', model: active, models };
      }
    }
    return { apiBase: '', apiKey: '', model: '', models: [] };
  };

  // 判断模型是否支持「可控」的深度思考：返回 'qwen' | 'doubao' | 'openai' | null
  //  null = 该模型不提供开关思考的 API 参数（如 deepseek 为原生推理、o 系列为内置推理、未知模型等），
  //  这类模型深度思考开关只能控制“是否展示思考过程”，无法真正开/关思考。
  App.thinkSupport = function (model) {
    const m = (model || '').toLowerCase();
    if (/deepseek/.test(m)) return null;                       // 原生推理，API 无法开关
    if (/qwen|qwq/.test(m)) return 'qwen';
    if (/doubao|seed/.test(m)) return 'doubao';
    if (/(^|[^a-z])o[0-9]|gpt-5/.test(m)) return 'openai';
    return null;
  };

  // 深度思考参数：开关真正决定思考与否。支持可控思考的模型注入真实 API 参数；
  // 不支持的返回 {}（思考由模型原生决定，开关仅影响展示）。
  App.buildThinkParam = function (model, enabled) {
    const sup = App.thinkSupport(model);
    if (sup === 'qwen') return { enable_thinking: !!enabled };
    if (sup === 'doubao') return { thinking: { type: enabled ? 'enabled' : 'disabled' } };
    if (sup === 'openai') return enabled ? { reasoning_effort: 'high' } : {};
    return {};
  };

  // 判断模型是否原生支持联网搜索，返回 'qwen' | 'openai' | null
  //  'qwen'  → 阿里系，用 enable_search
  //  'openai'→ OpenAI 官方，用 tools.web_search
  //  null    → 不支持原生联网（deepseek/kimi/claude/gemini 等），改由本地后端兜底检索
  App.nativeWebModel = function (model) {
    const m = (model || '').toLowerCase();
    if (/qwen|qwq|dashscope|doubao|seed|ark/.test(m)) return 'qwen';
    if (/openai|gpt|o[0-9]/.test(m)) return 'openai';
    return null;
  };

  // 联网搜索参数：只对原生支持联网的模型返回原生参数；其余一律 {}（改由聊天层做本地兜底检索）
  // 避免把 OpenAI 的 web_search 工具塞给 DeepSeek 等不支持的端点导致 400
  // 判断模型是否为视觉模型（支持图片输入）
  App.isVisionModel = function (model) {
    const m = (model || '').toLowerCase();
    const list = (App.state.settings.visionModels || []);
    return list.some(vm => m.includes(vm.toLowerCase()));
  };

  App.loadState = function () {
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      let oldFormat = false;
      if (!raw) {
        raw = localStorage.getItem(OLD_KEY);
        if (raw) oldFormat = true;
      }
      if (raw) {
        const parsed = JSON.parse(raw);
        const ns = defaultState();
        Object.assign(ns, parsed);
        const ps = (parsed.settings && typeof parsed.settings === 'object') ? parsed.settings : {};
        ns.settings = ns.settings || {};
        ns.settings.accounts = (Array.isArray(ps.accounts) ? ps.accounts : []).map(a => Object.assign({}, a, {
          models: Array.isArray(a.models) ? a.models : (a.model ? [a.model] : []),
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
        // 联网搜索可选 Key
        ns.settings.search = (ps.search && typeof ps.search === 'object')
          ? { apiKey: typeof ps.search.apiKey === 'string' ? ps.search.apiKey : '' }
          : { apiKey: '' };
        // 视觉模型白名单（旧版无则给默认）
        ns.settings.visionModels = Array.isArray(ps.visionModels) && ps.visionModels.length
          ? ps.visionModels
          : ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-5', 'claude-3', 'claude-3-5', 'claude-3-7', 'gemini-1.5', 'gemini-2.0', 'qwen-vl', 'qwen2-vl', 'yi-vl', 'llava', 'internvl', 'pixtral', 'glm-4v', 'minimax', 'step'];
        // 糖码多会话线程：归一化 + 旧版 agentHistory 迁移为首个线程
        const cleanHist = (arr) => (Array.isArray(arr) ? arr : [])
          .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
          .slice(-60);
        let threads = Array.isArray(parsed.agentThreads)
          ? parsed.agentThreads
            .filter(t => t && typeof t === 'object')
            .map(t => ({
              id: t.id || App.uid(),
              projectId: t.projectId || null,   // 归属项目（旧数据无则后续迁移补上）
              title: (typeof t.title === 'string' && t.title.trim()) ? t.title : '新会话',
              updatedAt: Number(t.updatedAt) || Date.now(),
              history: cleanHist(t.history),
            }))
          : [];
        // 旧版单条 agentHistory → 若无线程则包成首个会话
        const oldHist = cleanHist(parsed.agentHistory);
        if (!threads.length && oldHist.length) {
          threads = [{ id: App.uid(), projectId: null, title: '会话 1', updatedAt: Date.now(), history: oldHist }];
        }
        // 糖码项目：归一化 + 旧版迁移（无项目时用旧 agentCwd 创建默认项目）
        let projects = Array.isArray(parsed.projects)
          ? parsed.projects
            .filter(p => p && typeof p === 'object' && p.id)
            .map(p => ({
              id: p.id,
              name: (typeof p.name === 'string' && p.name.trim()) ? p.name : '未命名项目',
              cwd: typeof p.cwd === 'string' ? p.cwd : '',
              auto: !!p.auto,
              approveTools: Array.isArray(p.approveTools) ? p.approveTools.filter(x => typeof x === 'string') : [],
              cmdWhitelist: Array.isArray(p.cmdWhitelist) ? p.cmdWhitelist.filter(x => typeof x === 'string') : [],
              planMode: !!p.planMode,
              createdAt: Number(p.createdAt) || Date.now(),
              lastUsedAt: Number(p.lastUsedAt) || Date.now(),
            }))
          : [];
        if (!projects.length) {
          // 迁移：用旧 agentCwd 创建默认项目，approveTools 留空保持原行为
          projects = [{ id: App.uid(), name: '默认项目', cwd: (typeof ps.agentCwd === 'string' ? ps.agentCwd : ''),
            auto: false, approveTools: [], cmdWhitelist: [], planMode: false, createdAt: Date.now(), lastUsedAt: Date.now() }];
        }
        const firstPid = projects[0].id;
        // 把无 projectId 的线程归到首个项目
        for (const t of threads) { if (!t.projectId) t.projectId = firstPid; }
        ns.projects = projects;
        ns.activeProjectId = (parsed.activeProjectId && projects.some(p => p.id === parsed.activeProjectId))
          ? parsed.activeProjectId : firstPid;
        ns.agentProjectsCollapsed = !!parsed.agentProjectsCollapsed;
        ns.agentSessionsCollapsed = !!parsed.agentSessionsCollapsed;
        ns.agentThreads = threads;
        // 激活线程：优先用已存在的 activeThreadId，否则取首个线程
        const wantId = parsed.activeThreadId;
        ns.activeThreadId = (wantId && threads.some(t => t.id === wantId))
          ? wantId
          : (threads[0] ? threads[0].id : null);
        const oldProviders = ps.providers || {};
        const newProviders = {};
        for (const m of ['default', 'chat', 'image', 'doc']) {
          const op = oldProviders[m] || {};
          let accountId = (op.accountId !== undefined) ? op.accountId
            : (op.useDefault === false ? '__custom__' : '__default__');
          newProviders[m] = {
            accountId: accountId || '__default__',
            apiBase: op.apiBase || '', apiKey: op.apiKey || '', model: op.model || '',
          };
        }
        ns.settings.providers = newProviders;
        // 旧版单配置：把默认 provider 升级为一个账户
        if (oldFormat && oldProviders.default && oldProviders.default.apiBase) {
          const acc = {
            id: App.uid(), name: '默认账户',
            apiBase: oldProviders.default.apiBase,
            apiKey: oldProviders.default.apiKey,
            models: oldProviders.default.model ? [oldProviders.default.model] : [],
          };
          ns.settings.accounts = [acc];
          ns.settings.defaultAccountId = acc.id;
          for (const m of ['default', 'chat', 'image', 'doc']) ns.settings.providers[m].accountId = '__default__';
        }
        App.state = ns;
        App.persist();
        if (oldFormat) { try { localStorage.removeItem(OLD_KEY); } catch (e) {} }
        return;
      }
    } catch (e) { /* ignore */ }
  };

  App.persist = function () {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(App.state)); } catch (e) { /* ignore */ }
  };

  App.uid = function () {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  };

  App.defaultState = defaultState;
})();
