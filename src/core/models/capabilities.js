'use strict';
/*
 * 模型能力统一判定（双环境单一事实源）
 *   - 渲染进程：以 <script> 加载，挂到 window.App.ModelCapabilities
 *   - 主进程（糖码后端 agent-server.js）：以 require 加载
 *
 * 取代原先散落在 state.js / agent-server.js 里的重复正则判断，
 * 避免「渲染端改了能力表、主进程忘了改」这类双份漂移。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.App = window.App || {};
    window.App.ModelCapabilities = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // 视觉模型白名单（子串匹配，模型名含其一即视为支持图片输入）
  const VISION_MODELS = [
    'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-5',
    'claude-3', 'claude-3-5', 'claude-3-7',
    'gemini-1.5', 'gemini-2.0',
    'qwen-vl', 'qwen2-vl', 'yi-vl', 'llava', 'internvl', 'pixtral',
    'glm-4v', 'minimax', 'step',
  ];

  const norm = (m) => (m || '').toLowerCase();

  // 查某模型名在给定 accounts 里配置的 thinkType（'auto'|'openai'|'qwen'|'doubao'|'none'）；查不到返回 ''
  function thinkTypeOf(name, accounts) {
    if (!name) return '';
    const accs = Array.isArray(accounts) ? accounts : [];
    for (const a of accs) {
      const models = (a && a.models) || [];
      for (const mm of models) {
        if (mm && typeof mm === 'object' && mm.name === name && mm.thinkType) return mm.thinkType;
      }
    }
    return '';
  }

  // 渲染进程版：从 window.App.state.settings.accounts 取
  function thinkTypeOfApp(name) {
    const accs = (typeof window !== 'undefined' && window.App && window.App.state && window.App.state.settings)
      ? window.App.state.settings.accounts : [];
    return thinkTypeOf(name, accs);
  }

  // 判断深度思考参数类型：'qwen' | 'doubao' | 'openai' | null
  //   优先读「每模型配置」的 thinkType；未配置或选“自动”时回退按模型名正则（兜底）。
  //   null = 不注入思考参数（原生推理，如 grok/deepseek，开关仅影响是否展示思考过程）。
  function thinkSupport(model, accounts) {
    const name = (model || '').trim();
    const tt = thinkTypeOf(name, accounts || []);
    if (tt && tt !== 'auto') return (tt === 'none') ? null : tt;
    const m = norm(name);
    if (/deepseek/.test(m)) return null;
    if (/qwen|qwq/.test(m)) return 'qwen';
    if (/doubao|seed/.test(m)) return 'doubao';
    if (/(^|[^a-z])o[0-9]|gpt-5/.test(m)) return 'openai';
    return null;
  }

  function thinkSupportApp(model) {
    const accs = (typeof window !== 'undefined' && window.App && window.App.state && window.App.state.settings)
      ? window.App.state.settings.accounts : [];
    return thinkSupport(model, accs);
  }

  // 深度思考参数（按 sup 类型返回真实 API 参数；level 缺省 medium）
  function buildThinkParam(model, level, accounts) {
    return buildThinkParamWithSup(thinkSupport(model, accounts || []), level, model);
  }

  // 按已确定的 sup 类型构建思考参数（供主进程复用，避免重复正则）
  //   level: 'off' | 'low' | 'medium' | 'high'
  function buildThinkParamWithSup(sup, level, model) {
    const lv = level || 'medium';
    const m = norm(model);
    if (lv === 'off') {
      if (sup === 'qwen') return { enable_thinking: false };
      if (/doubao|seed/.test(m)) return { thinking: { type: 'disabled' } }; // 豆包按模型名识别，显式关闭思考
      return {}; // OpenAI/其他/原生推理不传参
    }
    if (sup === 'qwen') return { enable_thinking: true };
    if (sup === 'openai') return { reasoning_effort: lv === 'high' ? 'high' : lv === 'low' ? 'low' : 'medium' };
    return {}; // doubao / none / null → 原生推理，开启即默认，不注入强度参数
  }

  // 判断模型是否原生支持联网搜索：'qwen' | 'openai' | null
  function nativeWebModel(model) {
    const m = norm(model);
    if (/qwen|qwq|dashscope|doubao|seed|ark/.test(m)) return 'qwen';
    if (/openai|gpt|o[0-9]/.test(m)) return 'openai';
    return null;
  }

  // 联网搜索参数：enabled=false 返回 {}（关闭）；原生支持时返回对应厂商参数。
  function buildWebParam(model, enabled) {
    if (!enabled) return {};
    const kind = nativeWebModel(model);
    if (kind === 'qwen') return { enable_search: true };
    if (kind === 'openai') return { tools: [{ type: 'web_search' }] };
    return {};
  }

  // 是否为视觉模型（支持图片输入）
  function isVisionModel(model, visionList) {
    const m = norm(model);
    const list = Array.isArray(visionList) ? visionList : VISION_MODELS;
    return list.some((vm) => m.includes(norm(vm)));
  }

  // M6：声明式能力预设（账户模型 config.caps 可选值）
  //   'auto'        → 全部启发式推断
  //   'tool_vision' → 工具调用 + 视觉输入
  //   'tool'        → 仅工具调用
  //   'vision'      → 仅视觉输入
  //   'text'        → 纯文本（无工具/无视觉）
  const CAPS_PRESETS = {
    tool_vision: { toolCalling: true, visionInput: true },
    tool: { toolCalling: true, visionInput: false },
    vision: { toolCalling: false, visionInput: true },
    text: { toolCalling: false, visionInput: false },
  };

  // 查模型在账户配置里声明的 caps 预设；查不到返回 ''
  function capsPresetOf(model, accounts) {
    if (!model) return '';
    const accs = Array.isArray(accounts) ? accounts : [];
    for (const a of accs) {
      const models = (a && a.models) || [];
      for (const mm of models) {
        if (mm && typeof mm === 'object' && mm.name === model && mm.caps && CAPS_PRESETS[mm.caps]) return mm.caps;
      }
    }
    return '';
  }
  function capsPresetOfApp(model) {
    const accs = (typeof window !== 'undefined' && window.App && window.App.state && window.App.state.settings)
      ? window.App.state.settings.accounts : [];
    return capsPresetOf(model, accs);
  }

  // M6：统一能力解析（Provider Adapter 的轻量版）。
  // 优先读账户模型声明的 caps 预设，未声明时用启发式回退。返回完整能力描述：
  //   { streaming, toolCalling, visionInput, imageGeneration, imageEditing, reasoning, nativeWebSearch,
  //     maxOutputTokens, supportsParallelToolCalls, supportsPromptCaching, preferredToolResultFormat }
  // 用途：UI 按能力隐藏/禁用入口；发送前校验（不给无工具模型发工具定义、不把图片编辑发给无视觉模型）。
  // v2（P1-11）：上下文窗口单一来源——优先读账户模型声明的 contextWindow，未声明返回 0（调用方回退默认）。
  // 取代原先散落在 state.js / context.js / sqlite-store.js 里的重复解析逻辑，双环境共用。
  const DEFAULT_CONTEXT_WINDOW = 128000;
  function contextWindowOfModel(model, accounts) {
    const name = norm(model);
    const accs = Array.isArray(accounts) ? accounts : [];
    for (const a of accs) {
      const models = (a && a.models) || [];
      for (const mm of models) {
        if (mm && typeof mm === 'object' && mm.name && norm(mm.name) === name && mm.contextWindow > 0) {
          return mm.contextWindow;
        }
      }
    }
    return 0;
  }

  function capsOfModel(model, accounts) {
    const name = norm(model);
    const preset = capsPresetOf(model, accounts || []);
    let toolCalling, visionInput;
    if (CAPS_PRESETS[preset]) {
      toolCalling = CAPS_PRESETS[preset].toolCalling;
      visionInput = CAPS_PRESETS[preset].visionInput;
    }
    // 启发式回退
    if (toolCalling === undefined) toolCalling = true; // OpenAI-compatible 主流默认支持工具
    if (visionInput === undefined) visionInput = isVisionModel(model, null);
    // v1.1.0（M6）：扩展字段——并行工具调用/缓存/结果格式默认值 + 按模型推断
    const parallel = !/deepseek-r1|o1|o3|thinking/i.test(name); // reasoning 类模型通常不支持并行工具
    // v3（Prompt Caching）：reasoning 类默认关闭；OpenAI 兼容/DeepSeek/Ark 自动前缀缓存，Anthropic 走 cache_control（见 promptCachingMode）
    const caching = parallel;
    const maxOut = (accounts || []).some((a) => a && Array.isArray(a.models))
      ? (accounts.reduce((acc, a) => {
          const m = (a.models || []).find((x) => norm(x && x.name ? x.name : '') === name);
          return m && m.maxOutput ? m.maxOutput : acc;
        }, 0) || 0) : 0;
    return {
      streaming: true,
      toolCalling: !!toolCalling,
      visionInput: !!visionInput,
      imageGeneration: /dall-e|gpt-image|flux|stable-diffusion|sdxl|midjourney|imagen|kling|seedream|wanx|可图/.test(name),
      imageEditing: !!visionInput, // 图片编辑走 vision chat 兜底，依赖视觉输入
      reasoning: !!thinkSupport(model, accounts || []),
      nativeWebSearch: !!nativeWebModel(model),
      // v1.1.0（M6）：扩展字段
      maxOutputTokens: Number(maxOut) || 0,
      supportsParallelToolCalls: parallel,
      supportsPromptCaching: caching,
      preferredToolResultFormat: 'json',
      providerProtocol: /^claude/.test(name) ? 'anthropic-messages' : (/^gemini/.test(name) ? 'gemini-generate-content' : (/^(gpt-5|o[134]|codex)/.test(name) ? 'openai-responses' : 'openai-chat')),
      usageFields: ['inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens'],
      // v2（P1-11）：上下文窗口单一来源（账户模型声明优先，未声明回退默认）
      contextWindow: contextWindowOfModel(model, accounts) || DEFAULT_CONTEXT_WINDOW,
    };
  }
  function capsOfModelApp(model) {
    const accs = (typeof window !== 'undefined' && window.App && window.App.state && window.App.state.settings)
      ? window.App.state.settings.accounts : [];
    return capsOfModel(model, accs);
  }

  // Prompt Caching 模式：'anthropic'（需 cache_control 字段）| 'auto'（自动前缀缓存，无需字段）| 'off'
  function promptCachingMode(model, apiBase) {
    const nm = norm(model);
    if (/deepseek-r1|o1|o3|thinking/i.test(nm)) return 'off';
    if (/^claude/.test(nm) || /api\.anthropic\.com/i.test(String(apiBase || ''))) return 'anthropic';
    return 'auto';
  }

  return {
    VISION_MODELS,
    CAPS_PRESETS,
    thinkTypeOf, thinkTypeOfApp,
    thinkSupport, thinkSupportApp,
    buildThinkParam, buildThinkParamWithSup,
    nativeWebModel, buildWebParam, isVisionModel,
    capsPresetOf, capsPresetOfApp, capsOfModel, capsOfModelApp,
    contextWindowOfModel, DEFAULT_CONTEXT_WINDOW,
    promptCachingMode,
  };
});
