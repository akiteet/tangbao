'use strict';
/*
 * 共享上下文管理模块（对标 Claude Code 的 compaction）
 * - 提供 token 估算（混合中英文）、增量摘要合并、整段压缩
 * - 聊天(糖包)与糖码(agent)两端复用，避免重复实现、保证一致
 */
(function () {
  window.App = window.App || {};
  App.context = App.context || {};

  const PROXY_PORT = location.port || 4280;

  // 混合中英文回退估算：CJK 约 1.6 token/字，其余约 0.3 token/字符（仅在真实分词器不可用时使用）
  function heuristicTokens(text) {
    if (!text) return 0;
    const s = typeof text === 'string' ? text : JSON.stringify(text);
    const cjk = (s.match(/[一-鿿㐀-䶿]/g) || []).length;
    const other = s.length - cjk;
    return Math.ceil(cjk * 1.6 + other * 0.3);
  }
  App.context.heuristicTokens = heuristicTokens;

  // 真实 BPE 分词器（vendor/tokenizer.js 暴露 window.Tokenizer.countTokens，基于 cl100k_base）。
  // 对中文/代码显著比启发式更准；加载失败或异常时回退启发式。惰性引用 window.Tokenizer，
  // 因此即便脚本加载顺序有波动也不影响运行时正确性。
  App.context.estimateTokens = function (text) {
    if (!text) return 0;
    const s = typeof text === 'string' ? text : JSON.stringify(text);
    const T = (typeof window !== 'undefined' && window.Tokenizer && typeof window.Tokenizer.countTokens === 'function')
      ? window.Tokenizer : null;
    if (T) {
      try {
        const n = T.countTokens(s);
        if (typeof n === 'number' && n >= 0) return n;
      } catch (e) { /* 落到启发式 */ }
    }
    return heuristicTokens(s);
  };
  App.context.hasRealTokenizer = function () {
    return !!(typeof window !== 'undefined' && window.Tokenizer && typeof window.Tokenizer.countTokens === 'function');
  };

  function msgTokens(m) {
    const c = m && m.content;
    if (typeof c === 'string') return App.context.estimateTokens(c);
    if (Array.isArray(c)) return c.reduce((n, p) => n + (p.type === 'text' ? App.context.estimateTokens(p.text) : 1000), 0);
    return 0;
  }
  App.context.msgTokens = msgTokens;
  App.context.messagesTokens = function (msgs) { return (msgs || []).reduce((n, m) => n + msgTokens(m), 0); };

  // 摘要长度上限（token），避免摘要无限膨胀占用上下文。截断时会找自然边界。
  App.context.SUMMARY_MAX_TOKENS = 4000;

  const COMPACT_SYS = '你是一个对话上下文压缩器。请将下面的多轮对话压缩为一份结构化中文摘要：'
    + '1) 保留用户的关键需求、偏好、已做的技术决策与重要结论（含理由）；'
    + '2) 保留未完成的任务、TODO、待办事项、阻塞项与下一步计划；'
    + '3) 保留已打开/正在编辑的文件路径及其当前修改状态；'
    + '4) 保留遇到的错误（报错原文）及其解决状态（已解决/未解决）；'
    + '5) 保留对后续有用的具体信息：文件名、命令、报错、数字、代码片段关键行；'
    + '6) 省略寒暄、问候、日常闲聊与明显冗余的重复内容；'
    + '7) 不要编造原文没有的信息；'
    + '8) 摘要控制在约 3000 字以内，保持精炼。输出纯文本，可用简短小标题分节。不要 emoji。';

  // 安全截断摘要文本：超 token 上限时，按比例取字符并在句号/换行边界切断
  function truncateSummary(text, maxTokens) {
    if (!text) return text;
    if (App.context.estimateTokens(text) <= maxTokens) return text;
    let chars = Math.round(text.length * (maxTokens / App.context.estimateTokens(text)));
    const slice = text.slice(0, chars);
    const lastBreak = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf('。'), slice.lastIndexOf('.'));
    if (lastBreak > chars * 0.6) chars = lastBreak + 1;
    return text.slice(0, chars).replace(/\s+$/, '');
  }

  function targetUrl(provider) {
    const base = String(provider.apiBase || '').replace(/\/+$/, '');
    return /\/chat\/completions$/i.test(base) ? base : base + '/chat/completions';
  }

  function messagesToText(msgs) {
    return (msgs || []).map(m => {
      let body = m.content;
      if (Array.isArray(body)) body = body.map(p => p.type === 'text' ? p.text : '[图片]').join(' ');
      return '[' + m.role + '] ' + (body || '');
    }).join('\n\n');
  }

  async function callSummary(messages, provider) {
    try {
      const r = await fetch('http://localhost:' + PROXY_PORT + '/api-proxy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-target-url': targetUrl(provider),
          'x-auth': 'Bearer ' + (provider.apiKey || ''),
        },
        body: JSON.stringify({ model: provider.model, stream: false, messages }),
      });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      return c ? String(c).trim() : null;
    } catch (e) { return null; } // 压缩失败不阻断对话
  }

  // 增量合并：把已有摘要 + 新“中间段”压成一份新摘要（不重算全部历史）
  App.context.summarizeDelta = async function (existingSummary, middleMsgs, provider) {
    if (!provider || !provider.apiKey || !provider.model) return existingSummary || null;
    const userText = (existingSummary
      ? '【已有摘要，请在其基础上更新/合并，不要重复已有内容】\n' + existingSummary + '\n\n【新增对话（请并入上述摘要）】\n'
      : '') + messagesToText(middleMsgs);
    const summary = await callSummary([
      { role: 'system', content: COMPACT_SYS },
      { role: 'user', content: userText },
    ], provider);
    return truncateSummary(summary, App.context.SUMMARY_MAX_TOKENS) || existingSummary || null;
  };

  // 整段压缩（供 /compact），focus 可选、做定向保留
  App.context.summarizeFull = async function (historyMsgs, focus, provider) {
    if (!provider || !provider.apiKey || !provider.model) return null;
    const sys = COMPACT_SYS + (focus ? '\n\n用户额外要求：本次压缩请重点保留以下内容——' + focus : '');
    const summary = await callSummary([
      { role: 'system', content: sys },
      { role: 'user', content: messagesToText(historyMsgs) },
    ], provider);
    return truncateSummary(summary, App.context.SUMMARY_MAX_TOKENS) || null;
  };

  // 保留条数：始终原样保留的最近消息数（与模型窗口无关）
  App.context.RECENT_KEEP_CHAT = 16;
  App.context.RECENT_KEEP_AGENT = 20;
  // 压缩触发利用率：上下文用到窗口的该比例即自动压缩（agent 留更多余量给工具输出）
  App.context.COMPACT_UTIL_CHAT = 0.85;
  App.context.COMPACT_UTIL_AGENT = 0.80;

  // 上下文窗口：优先模型自身配置，其次全局设置（默认 128000）。
  App.context.contextWindowOf = function (model) {
    const fb = (App.state && App.state.settings && App.state.settings.contextWindow) || 128000;
    if (!model) return fb;
    // 先查模型自身配置（新数据模型为 { name, contextWindow }）
    const m = model.toLowerCase();
    const accounts = (App.state && App.state.settings && App.state.settings.accounts) || [];
    for (const acc of accounts) {
      const mods = acc.models || [];
      for (const mod of mods) {
        if (mod && typeof mod === 'object' && mod.name && mod.name.toLowerCase() === m && mod.contextWindow > 0) {
          return mod.contextWindow;
        }
      }
    }
    return fb;
  };

  // 单次摘要允许喂给压缩模型的最大 token（留余量给系统提示与输出），超出则分块
  function safeChunkTokens(window) { return Math.max(4000, Math.round(window * 0.5)); }

  // 分块合并摘要：把 middle 按 safe 大小切块，逐块并入 existingSummary，避免单次超窗口
  async function summarizeChunked(existingSummary, middle, provider, window) {
    const safe = safeChunkTokens(window);
    let s = existingSummary || '';
    let i = 0;
    while (i < middle.length) {
      let j = i + 1, acc = App.context.msgTokens(middle[i]);
      while (j < middle.length && acc + App.context.msgTokens(middle[j]) <= safe) { acc += App.context.msgTokens(middle[j]); j++; }
      const ns = await App.context.summarizeDelta(s, middle.slice(i, j), provider);
      if (ns) s = truncateSummary(ns, App.context.SUMMARY_MAX_TOKENS); else if (j === i + 1) { /* 单条失败也前进，避免死循环 */ }
      else break; // 非单条失败则停止，保留已合并部分
      i = j;
    }
    return s;
  }

  // 上下文用量条渲染：百分比进度条 + token 计数（对齐 Claude Code /context）
  App.context.renderUsage = function (el, tokens, threshold, breakdown) {
    if (!el) return;
    const pct = Math.max(0, Math.min(100, Math.round((tokens / threshold) * 100)));
    const wrap = el.querySelector('.ctx-bar-fill') || el;
    const label = el.querySelector('.ctx-bar-label');
    let level = 'ok';
    if (pct >= 90) level = 'danger';
    else if (pct >= 70) level = 'warn';
    el.dataset.level = level;
    if (wrap.classList) { wrap.classList.remove('ok', 'warn', 'danger', 'segmented'); wrap.classList.add(level); }
    if (wrap.style) wrap.style.width = pct + '%';
    if (wrap.querySelectorAll) { wrap.querySelectorAll('.seg').forEach(s => s.remove()); }
    const segs = (breakdown && (breakdown.system || breakdown.memory || breakdown.history)) ? breakdown : null;
    if (segs) {
      const mk = (cls, val) => {
        const d = document.createElement('div');
        d.className = 'seg seg-' + cls;
        d.style.flexGrow = String(val);
        return d;
      };
      if (segs.system) wrap.appendChild(mk('system', segs.system));
      if (segs.memory) wrap.appendChild(mk('memory', segs.memory));
      if (segs.history) wrap.appendChild(mk('history', segs.history));
      wrap.classList.add('segmented');
    }
    const k = (tokens / 1000).toFixed(1);
    const tk = (threshold / 1000).toFixed(0);
    if (label) label.textContent = pct + '%（' + k + 'k / ' + tk + 'k）';
    // 清除 legend/tip（如仍存在于 DOM 中）
    const legend = el.querySelector('.ctx-bar-legend');
    if (legend) legend.innerHTML = '';
    const tip = el.querySelector('.ctx-bar-tip');
    if (tip) tip.innerHTML = '';
  };

  // 把"实际发给模型"的消息数组拆成 system/history 两段（摘要归 history），
  // memoryTokens 由调用方额外传入（如糖码后端注入的 userMemory）。返回 { system, memory, history }
  App.context.breakdownFromFinal = function (finalMessages, memoryTokens) {
    let system = 0, history = 0;
    (finalMessages || []).forEach((m, i) => {
      const t = App.context.msgTokens(m);
      if (i === 0 && m && m.role === 'system') system += t;
      else history += t; // 摘要（额外 system 消息）也算压缩后的历史
    });
    return { system, memory: memoryTokens || 0, history };
  };

  // ===== 异步压缩（#7）：分离"取消息"与"压缩"，避免 await 阻塞发送 =====

  // 辅助函数：从 m 末尾往前遍历，累计 token 不超过 limit，返回 { recent, middleIdx }
  // recent 从 middleIdx 到末尾，middle 为 [0, middleIdx)
  function fitFromEnd(messages, headerTokens, limit, tokenCache) {
    if (!messages.length) return { recent: messages, middleIdx: 0 };
    const cache = tokenCache || {};
    let remain = limit - headerTokens;
    let idx = messages.length;
    while (idx > 0 && remain > 0) {
      const m = messages[idx - 1];
      let t = cache[m.role + '|' + m.content.length];
      if (t == null) { t = App.context.estimateTokens(m.role + '\n' + m.content); cache[m.role + '|' + m.content.length] = t; }
      if (t <= remain) { remain -= t; idx--; }
      else break;
    }
    return { recent: messages.slice(idx), middleIdx: idx };
  }

  // 同步速取发送消息列表（不调模型，不阻塞 send），同时标记是否需要后台压缩。
  // opts: { messages, summary, summaryCount, recentKeep, systemContent, util, window }
  // 返回 { finalMessages, needsCompress, middleMsgs, newSummaryCount }
  App.context.getCompactMessages = function (opts) {
    let { messages, summary, summaryCount, recentKeep, systemContent, util, window } = opts;
    if (summaryCount == null || summaryCount > messages.length) summaryCount = 0;
    const sysHead = [{ role: 'system', content: systemContent }];
    const sumMsg = (s) => ({ role: 'system', content: '【历史对话摘要（已自动压缩）】\n' + s });
    const limit = Math.round((window || 128000) * (util || App.context.COMPACT_UTIL_CHAT));
    const headerTokens = App.context.messagesTokens(sysHead);

    // 没有摘要且整体未到阈值：原样发送
    if (!summary && App.context.messagesTokens(messages) <= limit) {
      return { finalMessages: sysHead.concat(messages), needsCompress: false, middleMsgs: [], newSummaryCount: 0 };
    }

    // 需要压缩：从末尾反向填充直到接近 limit
    const sumMemTok = summary ? App.context.estimateTokens(sumMsg(summary).content) : 0;
    // 摘要 + 系统头占用的 token
    const consumed = headerTokens + sumMemTok;
    // 从末尾填充，尽量填满窗口（不再固定 recentKeep 条）
    const batchKeep = Math.max(recentKeep || 4, 4); // 至少保留 4 条
    if (!summary) {
      // 分支 B：首次压缩，无摘要
      let recent = messages.slice(-batchKeep);
      const recentTok = App.context.messagesTokens(recent);
      // 如果 recent 本身就超了，就只保留最后几条
      if (recentTok > limit) {
        recent = [messages[messages.length - 1]];
      } else if (messages.length > batchKeep) {
        // 从 batchKeep 之后往前塞更多消息
        const remain = limit - consumed - recentTok;
        if (remain > 200) {
          const extra = fitFromEnd(messages.slice(0, -batchKeep), 0, remain).recent;
          recent = extra.concat(recent);
        }
      }
      const middle = messages.slice(summaryCount, messages.length - recent.length);
      if (middle.length) {
        return { finalMessages: sysHead.concat(recent), needsCompress: true, middleMsgs: middle, newSummaryCount: middle.length };
      }
      // middle 为空 → recent 覆盖了全部消息，但仍超限 → 全量发送
      return { finalMessages: sysHead.concat(messages), needsCompress: true, middleMsgs: [], newSummaryCount: 0 };
    }

    // 分支 C/D：已有摘要
    let recent = messages.slice(-batchKeep);
    const recentTok = App.context.messagesTokens(recent);
    if (recentTok + consumed > limit) {
      // 最后几条已超窗口，只保留摘要
      recent = [];
    } else {
      // 反向填充更多消息
      const remain = limit - consumed - recentTok;
      if (remain > 200) {
        const extra = fitFromEnd(messages.slice(0, -batchKeep), 0, remain).recent;
        recent = extra.concat(recent);
      }
    }
    const middle = messages.slice(summaryCount, messages.length - recent.length);
    if (middle.length) {
      const head = sysHead.concat([sumMsg(summary)]);
      return { finalMessages: head.concat(recent), needsCompress: true, middleMsgs: middle, newSummaryCount: summaryCount + middle.length };
    }

    // 分支 D（re-expand）：middle 为空，但有空间可加更多旧消息？
    if (summaryCount > 0 && recent.length < messages.length) {
      // 从 summaryCount 之前的历史中取更多消息
      const remain = limit - consumed - App.context.messagesTokens(recent);
      if (remain > 200) {
        const preRecent = messages.slice(0, summaryCount); // 已包含在摘要中的旧消息
        const extraFit = fitFromEnd(preRecent, 0, remain);
        if (extraFit.recent.length) {
          recent = extraFit.recent.concat(recent);
        }
      }
    }

    // 无需压缩，保持已压缩形态
    const head = sysHead.concat([sumMsg(summary)]);
    return { finalMessages: head.concat(recent), needsCompress: false, middleMsgs: [], newSummaryCount: summaryCount };
  };

  // 后台异步压缩（fire-and-forget），返回新摘要或 null（失败）。
  // versionCheck：回调时检测版本号是否匹配，避免快速连发时旧压缩覆盖新状态。
  App.context.compressAsync = async function (existingSummary, middleMsgs, provider, window, versionCheck) {
    if (!middleMsgs || !middleMsgs.length) return existingSummary || null;
    if (!provider || !provider.apiKey || !provider.model) return existingSummary || null;
    try {
      const result = await summarizeChunked(existingSummary || '', middleMsgs, provider, window || 128000);
      // 若版本号变化（新消息已在压缩期间被处理），丢弃本次结果
      if (typeof versionCheck === 'function' && !versionCheck()) return null;
      return result;
    } catch (e) { return null; }
  };

  // ===== 原同步压缩（保留供手动 /compact 等场景使用，发送路径现已改用上面的异步方案）=====

  // 计算发送给模型的消息数组（增量压缩核心逻辑，聊天与糖码共用）
  //  opts: { messages, summary, summaryCount, recentKeep, provider, systemContent, util }
  //  返回 { finalMessages, summary, summaryCount }
  //  触发条件：估算 token 超过「模型真实窗口 × 利用率」才压缩（不再按消息条数硬触发），
  //  从而把模型上下文用满、避免过早压缩浪费容量。
  App.context.buildCompactMessages = async function (opts) {
    let { messages, summary, summaryCount, recentKeep, provider, systemContent, util } = opts;
    if (summaryCount == null || summaryCount > messages.length) summaryCount = 0;
    const sysHead = [{ role: 'system', content: systemContent }];
    const sumMsg = (s) => ({ role: 'system', content: '【历史对话摘要（已自动压缩）】\n' + s });
    const tail = messages.slice(summaryCount); // 尚未纳入摘要的部分

    const window = App.context.contextWindowOf(provider && provider.model ? provider.model : '');
    const limit = Math.round(window * (util || App.context.COMPACT_UTIL_CHAT));

    // 没有摘要且整体远未到阈值：原样发送（把模型上下文用满）
    if (!summary && App.context.messagesTokens(messages) <= limit) {
      return { finalMessages: sysHead.concat(messages), summary: '', summaryCount: 0 };
    }

    const recent = messages.slice(-recentKeep);
    const middle = messages.slice(summaryCount, messages.length - recentKeep); // 需压缩的中间段

    if (!summary) {
      // 首次压缩：把 middle 分块并入摘要（避免单次摘要超窗口）
      if (middle.length) {
        const ns = await summarizeChunked('', middle, provider, window);
        if (ns) { summary = ns; summaryCount += middle.length; }
      }
      const head = summary ? sysHead.concat([sumMsg(summary)]) : sysHead;
      const body = summary ? recent : messages; // 压缩失败则原样兜底，不丢消息
      return { finalMessages: head.concat(body), summary, summaryCount };
    }

    // 已有摘要：middle 有新内容则增量合并（分块避免超窗口）；否则保持已压缩形态
    if (middle.length) {
      const ns = await summarizeChunked(summary, middle, provider, window);
      if (ns) { summary = ns; summaryCount += middle.length; }
    }
    const head = sysHead.concat([sumMsg(summary)]);
    const body = summary ? recent : tail; // 合并失败兜底发 tail
    return { finalMessages: head.concat(body), summary, summaryCount };
  };
})();
