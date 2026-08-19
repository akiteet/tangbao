'use strict';
(function () {
  window.App = window.App || {};

  const $ = (id) => document.getElementById(id);
  const SYSTEM_PROMPT = App.DEFAULT_PROMPTS.chat;

  // 上下文自动压缩逻辑见 src/renderer/views/chat/context.js（App.context.*），聊天与糖码共用

  const SUGGESTIONS = [
    { title: '写一份周报', desc: '工作总结 / 计划', prompt: '帮我写一份本周工作周报，包含完成事项、进行中和下周计划。', icon: '📅' },
    { title: '解释概念', desc: '用通俗语言讲清楚', prompt: '用通俗易懂的语言解释“量子纠缠”是什么。', icon: '💡' },
    { title: '翻译助手', desc: '中英文互译', prompt: '把下面这段话翻译成英文，保持语气自然：今天天气真好，我们去郊游吧。', icon: '🌐' },
    { title: '绘图提示词', desc: '生成图像描述', prompt: '生成一张赛博朋克风格的城市夜景图，霓虹灯光，4K 高清。', icon: '🎨' },
    { title: '健身计划', desc: '一周训练安排', prompt: '帮我制定一份适合上班族的一周健身计划。', icon: '💪' },
    { title: '代码助手', desc: 'Python 小技巧', prompt: '用 Python 读取一个 CSV 文件并输出前 5 行，给出示例代码。', icon: '💻' },
  ];

  const QUICK_ACTIONS = [
    { label: '帮我写', prompt: '帮我写一份本周工作周报，包含完成事项、进行中和下周计划。' },
    { label: '糖绘', prompt: '生成一张赛博朋克风格的城市夜景图，霓虹灯光，4K 高清。' },
    { label: '翻译', prompt: '把下面这段话翻译成英文，保持语气自然：' },
    { label: '总结', prompt: '请对以下文本进行总结，提取核心要点：' },
  ];

  let streaming = false;
  let streamUi = null;
  let renderedConvId = null;
  let renderedContentStamp = ''; // v1.1.5：内容戳——重进未变化的会话（模块往返）不再整窗重建
  let streamConvId = null;  // 聊天修复 E：当前流式回复所属会话 id（区分“本会话忙碌”与“其它会话忙碌”）
  let voiceBase = '';       // B5（P2）：语音听写最终文本基线——interim 更新时替换而非重复累加
  // 聊天修复 E：半开连接看门狗——首字节 30s / 流数据空闲 90s 未推进视为连接失效，
  // 抛 STREAM_IDLE_TIMEOUT 由 streamChat 外层 catch 走 saveAnswer 兜底并复位 streaming，杜绝“卡死吞消息”。
  const STREAM_FIRST_BYTE_MS = 30000;
  const STREAM_IDLE_MS = 90000;
  const raceTimeout = (promise, ms) => {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const e = new Error('流式响应空闲超时（' + Math.round(ms / 1000) + 's 无数据），已断开连接');
        e.code = 'STREAM_IDLE_TIMEOUT';
        reject(e);
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
  };
  let recognition = null;   // 语音听写实例
  let listening = false;    // 语音听写状态
  let pendingAttachments = []; // 待发送附件 [{id,name,type,text,size,data?}]
  let messageVisibleCount = 100;
  let messageWindowConvId = '';
  let surfaceState = null;

  // v1.1.6（批次 C）：聊天附件图片落盘——复用糖绘 D1 的 image-assets 基建。
  // state 里只存 {name,type,...} 引用不存 base64 data，消除 state 序列化体积 = 图片体积的放大。
  // 渲染/请求时经 cachedAttachmentDataUrl 按需取回（LRU 缓存最近 40 张）。
  const attachmentCache = new Map();
  const ATTACHMENT_CACHE_LIMIT = 40;
  function stripDataUrl(value) { return String(value || '').replace(/^data:image\/[^;,]+;base64,/, ''); }
  async function saveAttachmentAsset(dataUrl) {
    const svc = App.services && App.services.images;
    if (!svc || typeof svc.available === 'function' && !svc.available()) return null;
    const b64 = stripDataUrl(dataUrl);
    if (!b64) return null;
    try {
      const result = await svc.save(b64);
      if (result && result.ok && result.name) return result.name;
      if (result && result.code === 'quota') App.ui.toast('本地图片存储已达配额，该图保留内联');
      return null;
    } catch (_) { return null; }
  }
  async function cachedAttachmentDataUrl(name) {
    if (!name) return '';
    if (attachmentCache.has(name)) {
      const v = attachmentCache.get(name);
      attachmentCache.delete(name); attachmentCache.set(name, v);
      return v;
    }
    const svc = App.services && App.services.images;
    if (!svc || typeof svc.read !== 'function') return '';
    const result = await svc.read(name);
    const dataUrl = result && result.ok && result.dataUrl ? result.dataUrl : '';
    if (!dataUrl) return '';
    attachmentCache.set(name, dataUrl);
    while (attachmentCache.size > ATTACHMENT_CACHE_LIMIT) attachmentCache.delete(attachmentCache.keys().next().value);
    return dataUrl;
  }
  // 取附件的 data URL：有 data 直接返回（内联/旧数据），否则按 name 取回
  function attachmentDataUrl(a) {
    if (a && a.data) return a.data;
    if (a && a.name) return cachedAttachmentDataUrl(a.name);
    return '';
  }
  let draftTimer = null;
  let draftConversationId = null;
  const markdownCache = new Map();
  const MARKDOWN_CACHE_LIMIT = 160;
  let contextBarKey = '';
  const MODULE_OWNERS = new Set(['tangguan', 'create']);
  // All writes for one module are serialized. Streaming checkpoints and the
  // final conversation snapshot otherwise race through separate IPC calls and
  // an older snapshot can overwrite the latest assistant output.
  const moduleWriteQueues = new Map();

  function ensureModuleRuntime() {
    if (!App.moduleSessions || typeof App.moduleSessions !== 'object') {
      App.moduleSessions = { status: 'pending', data: {} };
    }
    App.moduleSessions.data = App.moduleSessions.data || {};
    for (const owner of MODULE_OWNERS) {
      const bucket = App.moduleSessions.data[owner];
      if (!bucket || typeof bucket !== 'object') App.moduleSessions.data[owner] = { conversations: [], activeId: null };
      if (!Array.isArray(App.moduleSessions.data[owner].conversations)) App.moduleSessions.data[owner].conversations = [];
    }
    return App.moduleSessions;
  }

  function isModuleOwner(owner) { return MODULE_OWNERS.has(String(owner || '')); }

  function ownerForConversation(conv) {
    if (conv && (conv.tangguanCharacterId || conv.originModule === 'tangguan')) return 'tangguan';
    if (conv && conv.originModule === 'create') return 'create';
    return 'default';
  }

  // Module ownership must not depend on the newest marker shape. Older
  // sessions can carry only originModule, while current Tangguan sessions
  // also carry tangguanCharacterId.
  function isTangguanConv(conv) { return ownerForConversation(conv) === 'tangguan'; }

  function currentOwner() {
    if (surfaceState && surfaceState.owner) return surfaceState.owner;
    const view = App.state && App.state.view;
    return isModuleOwner(view) ? view : 'default';
  }

  function conversationList(owner) {
    const name = String(owner || 'default');
    if (isModuleOwner(name)) {
      const bucket = ensureModuleRuntime().data[name];
      // Never fall back to App.state.conversations here. That collection is
      // the regular Chat store; migration failure is represented by the
      // in-memory module bucket so records remain inspectable without mixing
      // them back into the normal Chat view.
      return bucket.conversations;
    }
    return App.state && Array.isArray(App.state.conversations) ? App.state.conversations : [];
  }

  function activeConversationId(owner) {
    const name = String(owner || currentOwner());
    if (isModuleOwner(name)) {
      const bucket = ensureModuleRuntime().data[name];
      if (surfaceState && surfaceState.owner === name && surfaceState.conversationId != null) return surfaceState.conversationId || null;
      return bucket.activeId || null;
    }
    return App.state && App.state.activeId || null;
  }

  function setActiveConversationId(owner, id) {
    const name = String(owner || currentOwner());
    const value = id ? String(id) : null;
    if (isModuleOwner(name)) {
      ensureModuleRuntime().data[name].activeId = value;
      if (surfaceState && surfaceState.owner === name) surfaceState.conversationId = value;
    } else if (App.state) {
      App.state.activeId = value;
    }
    return value;
  }

  function conversationById(owner, id) {
    const target = String(id || '');
    return conversationList(owner).find((item) => item && item.id === target) || null;
  }

  function activeConversationFor(owner) {
    return conversationById(owner || currentOwner(), activeConversationId(owner || currentOwner()));
  }

  function isCurrentConversation(conv) {
    return !!conv && activeConversationId(ownerForConversation(conv)) === conv.id;
  }

  function moduleSnapshot(conv) {
    try { return JSON.parse(JSON.stringify(conv)); } catch (_) { return conv; }
  }

  function enqueueModuleWrite(owner, operation) {
    const name = String(owner || '');
    const previous = moduleWriteQueues.get(name) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    moduleWriteQueues.set(name, next.catch(() => {}));
    return next;
  }

  function persistModuleConversation(owner, conv, options) {
    const name = String(owner || ownerForConversation(conv));
    if (!isModuleOwner(name) || !conv || !conv.id) return App.persist ? App.persist(options) : { ok: false };
    const runtime = ensureModuleRuntime();
    if (runtime.status === 'failed') {
      runtime.lastError = runtime.lastError || 'module_session_migration_failed';
      return { ok: false, code: runtime.lastError, error: '模块会话迁移失败，当前记录只读，请先恢复迁移' };
    }
    const bucket = runtime.data[name];
    const next = moduleSnapshot(conv);
    // A module conversation belongs to its sidecar even when an older
    // renderer left a copy in the regular Chat array. Remove that copy before
    // any regular-state persistence can observe it.
    if (Array.isArray(App.state && App.state.conversations)) {
      App.state.conversations = App.state.conversations.filter((item) => !item || item.id !== next.id || !isModuleConversation(item));
    }
    bucket.conversations = [next].concat(bucket.conversations.filter((item) => item && item.id !== next.id));
    const activeId = options && options.activeId !== undefined ? options.activeId : bucket.activeId;
    if (activeId !== undefined) bucket.activeId = activeId || null;
    const service = App.services && App.services.moduleSessions;
    if (service && service.upsert) {
      enqueueModuleWrite(name, () => service.upsert(name, next, bucket.activeId)).then((result) => {
        if (result && result.ok && result.data) {
          bucket.conversations = Array.isArray(result.data.conversations) ? result.data.conversations : bucket.conversations;
          bucket.activeId = result.data.activeId || bucket.activeId || null;
        } else if (result && result.ok === false) {
          runtime.lastError = result.code || result.error || 'module_session_save_failed';
        }
      }).catch(() => { runtime.lastError = 'module_session_save_failed'; });
    }
    return { ok: true, module: name, conversation: next };
  }

  function removeModuleConversation(owner, id) {
    const name = String(owner || currentOwner());
    if (!isModuleOwner(name)) return { ok: false, code: 'unsupported_module' };
    const bucket = ensureModuleRuntime().data[name];
    const target = String(id || '');
    const existed = bucket.conversations.some((item) => item && item.id === target);
    bucket.conversations = bucket.conversations.filter((item) => item && item.id !== target);
    if (bucket.activeId === target) bucket.activeId = bucket.conversations[0] ? bucket.conversations[0].id : null;
    const service = App.services && App.services.moduleSessions;
    if (service && service.remove && ensureModuleRuntime().status !== 'failed') {
      enqueueModuleWrite(name, () => service.remove(name, target)).catch(() => {
        ensureModuleRuntime().lastError = 'module_session_remove_failed';
      });
    }
    return { ok: true, removed: existed, activeId: bucket.activeId };
  }

  function cachedMarkdown(content, cacheKey) {
    const value = String(content == null ? '' : content);
    const key = String(cacheKey || '') + '\0' + value;
    const cached = markdownCache.get(key);
    if (cached != null) return cached;
    const rendered = App.renderMarkdown(value);
    markdownCache.set(key, rendered);
    while (markdownCache.size > MARKDOWN_CACHE_LIMIT) {
      const first = markdownCache.keys().next().value;
      if (first == null) break;
      markdownCache.delete(first);
    }
    return rendered;
  }

  function providerForConversation(conv) {
    const owner = ownerForConversation(conv);
    return App.getProvider(owner === 'tangguan' || owner === 'create' ? owner : 'chat');
  }

  function flushDraft(options) {
    const opts = options && typeof options === 'object' ? options : {};
    if (draftTimer) { clearTimeout(draftTimer); draftTimer = null; }
    const input = $('input');
    const owner = opts.owner || currentOwner();
    const id = opts.conversationId || draftConversationId || activeConversationId(owner);
    if (!input || !id) return;
    try { localStorage.setItem('tb_draft_' + id, input.value); } catch (_) {}
    draftConversationId = null;
  }

  function scheduleDraft() {
    if (draftTimer) clearTimeout(draftTimer);
    draftConversationId = activeConversationId(currentOwner());
    draftTimer = setTimeout(() => { draftTimer = null; flushDraft(); }, 250);
  }

  function chatScrollNode() {
    return (surfaceState && surfaceState.scroll) || $('chatScroll');
  }

  function isTangguanConversation(id) {
    const conv = conversationById('tangguan', id)
      || conversationById('create', id)
      || conversationById('default', id);
    return isTangguanConv(conv);
  }

  function isCreateConversation(conv) {
    return !!(conv && conv.originModule === 'create');
  }

  function isModuleConversation(conv) {
    return !!(conv && (conv.tangguanCharacterId || conv.originModule === 'tangguan' || isCreateConversation(conv)));
  }

  function resetTangguanMessageWindow(conv) {
    const id = conv && conv.id ? String(conv.id) : '';
    if (id !== messageWindowConvId) {
      messageWindowConvId = id;
      messageVisibleCount = isTangguanConv(conv) ? 50 : 100;
    }
  }

  function contextBarStamp(conv, model, userMemory) {
    const messages = conv && Array.isArray(conv.messages) ? conv.messages : [];
    const last = messages[messages.length - 1] || {};
    return [
      conv && conv.id || '',
      Number(conv && conv.updatedAt) || 0,
      messages.length,
      last.id || '',
      String(last.content || '').length,
      String(last.think || '').length,
      Number(conv && conv.summaryCount) || 0,
      model || '',
      String(userMemory || '').length,
    ].join('|');
  }

  function bindWelcomeActions() {
    const welcome = $('welcome');
    if (!welcome || welcome.dataset.chatWelcomeBound === '1') return;
    welcome.dataset.chatWelcomeBound = '1';
    welcome.addEventListener('click', (event) => {
      const promptButton = event.target.closest('[data-prompt]');
      const suggestionButton = event.target.closest('[data-i]');
      const input = $('input');
      if (!input) return;
      if (promptButton) input.value = promptButton.dataset.prompt || '';
      else if (suggestionButton) {
        const suggestion = SUGGESTIONS[Number(suggestionButton.dataset.i)];
        if (!suggestion) return;
        input.value = suggestion.prompt;
      } else return;
      App.chat.autoSize();
      input.focus();
      App.chat.updateSendEnabled();
    });
  }

  App.chat = {
    pendingAttachments,
    editingIndex: null,     // M7：编辑模式下的用户消息下标（null=非编辑模式）

    mountSurface(options) {
      const opts = options && typeof options === 'object' ? options : {};
      const root = opts.root;
      if (!root) return { ok: false, code: 'chat_surface_root_missing' };
      const owner = opts.owner || opts.mode || 'default';
      if (surfaceState && surfaceState.root === root) {
        surfaceState.mode = opts.mode || surfaceState.mode || 'default';
        surfaceState.owner = owner;
        const nextConversationId = opts.conversationId !== undefined ? (opts.conversationId || null) : surfaceState.conversationId;
        if (opts.conversationId !== undefined && nextConversationId !== surfaceState.conversationId) {
          setActiveConversationId(owner, nextConversationId);
          surfaceState.conversationId = nextConversationId;
          App.chat.renderMessages();
        }
        if (App.ui && App.ui.syncModelSelect) App.ui.syncModelSelect();
        return { ok: true, reused: true };
      }
      if (surfaceState) App.chat.unmountSurface();
      const ids = ['welcome', 'messages', 'composer'];
      const nodes = ids.map((id) => $(id));
      if (nodes.some((node) => !node || !node.parentNode)) return { ok: false, code: 'chat_surface_nodes_missing' };
      const anchors = nodes.map((node) => {
        const anchor = document.createComment('chat-surface-home-' + node.id);
        node.parentNode.insertBefore(anchor, node);
        return anchor;
      });
      const scroll = document.createElement('div');
      scroll.className = 'tg-chat-scroll';
      scroll.setAttribute('data-chat-scroll', 'true');
      const messageSlot = document.createElement('div');
      messageSlot.className = 'tg-chat-message-slot';
      scroll.appendChild(messageSlot);
      root.replaceChildren(scroll);
      messageSlot.append(nodes[0], nodes[1]);
      root.appendChild(nodes[2]);
      surfaceState = {
        root,
        scroll,
        nodes,
        anchors,
        mode: opts.mode || 'default',
        owner,
        conversationId: opts.conversationId !== undefined ? (opts.conversationId || null) : activeConversationId(owner),
        previousActiveId: App.chat._preSurfaceActiveId
          || App.chat._preTangguanActiveId
          || App.chat._preCreateActiveId
          || (activeConversationId('default') && !isModuleConversation(activeConversationFor('default')) ? activeConversationId('default') : null),
        controls: {},
      };
      App.chat._preTangguanActiveId = null;
      App.chat._preCreateActiveId = null;
      App.chat._preSurfaceActiveId = null;
      if (surfaceState.mode === 'tangguan') {
        ['webBtn', 'imgBtn', 'attachBtn'].forEach((id) => {
          const node = $(id);
          if (!node) return;
          surfaceState.controls[id] = { display: node.style.display, disabled: node.disabled, title: node.title };
          node.style.display = 'none';
          node.disabled = true;
        });
      }
      setActiveConversationId(owner, surfaceState.conversationId);
      App.chat.renderMessages();
      App.chat.updateCtxBar();
      if (App.ui && App.ui.syncModelSelect) App.ui.syncModelSelect();
      return { ok: true, reused: false };
    },

    unmountSurface(options) {
      if (!surfaceState) return { ok: true, reused: false };
      const opts = options && typeof options === 'object' ? options : {};
      const state = surfaceState;
      if (opts.preserveActiveId) {
        if (state.previousActiveId) App.chat._preSurfaceActiveId = state.previousActiveId;
      } else if (state.mode === 'tangguan' || state.owner === 'create') {
        const previous = state.previousActiveId;
        setActiveConversationId(state.owner, state.conversationId || activeConversationId(state.owner));
        if (previous && conversationById('default', previous) && !isModuleConversation(conversationById('default', previous))) App.state.activeId = previous;
      }
      state.nodes.forEach((node, index) => {
        const anchor = state.anchors[index];
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(node, anchor.nextSibling);
      });
      Object.entries(state.controls || {}).forEach(([id, snapshot]) => {
        const node = $(id);
        if (!node) return;
        node.style.display = snapshot.display;
        node.disabled = snapshot.disabled;
        node.title = snapshot.title;
      });
      if (state.root) state.root.replaceChildren();
      surfaceState = null;
      return { ok: true, reused: false };
    },

    surface() { return surfaceState; },

    // Flush the current input before a route/session change. This is
    // intentionally synchronous and local-only so navigation never waits on
    // the model or the SQLite writer.
    flushSurface() {
      const opts = arguments[0] && typeof arguments[0] === 'object' ? arguments[0] : {};
      // Regular Chat compatibility path: flushDraft({ conversationId: App.state && App.state.activeId });
      flushDraft(Object.assign({}, opts, { owner: opts.owner || currentOwner() }));
      return { ok: true, conversationId: activeConversationId(opts.owner || currentOwner()) };
    },

    providerForConversation(conv) {
      return providerForConversation(conv);
    },

    activeConv() { return activeConversationFor(currentOwner()); },

    conversationList(owner) { return conversationList(owner || currentOwner()); },

    activeConversationId(owner) { return activeConversationId(owner || currentOwner()); },

    setActiveConversationId(owner, id) { return setActiveConversationId(owner || currentOwner(), id); },

    persistConversation(conv, options) {
      const owner = ownerForConversation(conv);
      return isModuleOwner(owner) ? persistModuleConversation(owner, conv, options) : (App.persist ? App.persist(options) : { ok: false });
    },

    // 判断当前聊天模型是否支持视觉输入
    isVisionModel() {
      const conv = App.chat.activeConv();
      const s = providerForConversation(conv);
      const model = (conv && conv.model) || s.model || '';
      return App.isVisionModel(model);
    },

    // 同步图片按钮可用状态
    syncImgBtn() {
      const btn = $('imgBtn');
      if (!btn) return;
      const conv = App.chat.activeConv();
      const s = providerForConversation(conv);
      const restricted = isTangguanConv(conv);
      const model = (conv && conv.model) || s.model || '';
      const ok = App.isVisionModel(model);
      btn.disabled = !ok || restricted;
      btn.classList.toggle('img-disabled', !ok || restricted);
      btn.title = restricted ? '糖馆独立会话不支持附件' : (ok ? '图片' : ('当前模型 ' + (model || '未配置') + ' 不支持图片输入，可在设置→API→视觉模型中添加'));
      const attach = $('attachBtn');
      if (attach) {
        attach.disabled = restricted;
        attach.title = restricted ? '糖馆独立会话不支持附件' : '添加附件';
      }
    },

    // 读取并压缩图片，返回 base64 data URL
    async processImage(file) {
      if (isTangguanConv(App.chat.activeConv())) {
        App.ui.toast('糖馆独立会话不支持图片或文件附件');
        return null;
      }
      const MAX_EDGE = 4096;
      const MAX_SIZE = 5 * 1024 * 1024; // 5MB
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const img = new Image();
          img.onload = () => {
            let w = img.naturalWidth, h = img.naturalHeight;
            const max = Math.max(w, h);
            if (max > MAX_EDGE) {
              const scale = MAX_EDGE / max;
              w = Math.round(w * scale); h = Math.round(h * scale);
            }
            const canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);
            let quality = 0.92;
            let dataUrl = canvas.toDataURL('image/jpeg', quality);
            // 如果仍超过 5MB，降低质量
            while (dataUrl.length > MAX_SIZE && quality > 0.3) {
              quality -= 0.1;
              dataUrl = canvas.toDataURL('image/jpeg', quality);
            }
            resolve(dataUrl);
          };
          img.onerror = () => reject(new Error('图片解析失败'));
          img.src = reader.result;
        };
        reader.onerror = () => reject(new Error('读取图片失败'));
        reader.readAsDataURL(file);
      });
    },

    // 处理图片文件：压缩后加入 pendingAttachments
    async handleImageFile(file) {
      if (!file || !file.type.startsWith('image/')) return;
      if (isTangguanConv(App.chat.activeConv())) { App.ui.toast('糖馆独立会话不支持图片或文件附件'); return; }
      if (!App.chat.isVisionModel()) { App.ui.toast('当前模型不支持图片输入'); return; }
      try {
        const data = await App.chat.processImage(file);
        pendingAttachments.push({ id: App.uid(), name: file.name, type: 'image', data, size: file.size });
        App.chat.pendingAttachments = pendingAttachments;
        App.chat.renderAttachChips();
        App.chat.updateSendEnabled();
        App.ui.toast('已添加图片 ' + file.name);
      } catch (e) { App.ui.toast('图片处理失败：' + (e.message || '未知错误')); }
    },

    // 渲染输入框上方的附件小卡片（chips）
    renderAttachChips() {
      const box = $('attachChips');
      if (!box) return;
      if (!pendingAttachments.length) { box.innerHTML = ''; box.style.display = 'none'; return; }
      box.style.display = 'flex';
      box.innerHTML = pendingAttachments.map(a => {
        if (a.type === 'image') {
          return `<span class="img-chip" data-id="${a.id}">
            <img src="${App.escapeHtml(a.data)}" alt="">
            <span class="attach-name">${App.escapeHtml(a.name)}</span>
            <button class="attach-chip-remove" data-remove="${a.id}" title="移除">×</button>
          </span>`;
        }
        return `<span class="attach-chip" data-id="${a.id}">
           <span class="attach-ico">📄</span>
           <span class="attach-name">${App.escapeHtml(a.name)}</span>
           <button class="attach-chip-remove" data-remove="${a.id}" title="移除">×</button>
         </span>`;
      }).join('');
    },

    removeAttachment(id) {
      pendingAttachments = pendingAttachments.filter(a => a.id !== id);
      App.chat.pendingAttachments = pendingAttachments;
      App.chat.renderAttachChips();
      App.chat.updateSendEnabled();
    },

    clearAttachments() {
      pendingAttachments = [];
      App.chat.pendingAttachments = pendingAttachments;
      App.chat.renderAttachChips();
    },

    updateSendEnabled() {
      $('sendBtn').disabled = streaming || (!$('input').value.trim() && !pendingAttachments.length);
    },

    // 把消息正文与附件拼成最终发给模型的 content
    // 纯文本返回字符串；含图片时返回 OpenAI vision 数组格式
    // v1.1.6（批次 C2）：附件图片按需取回——有 data 直接用（内联/旧数据），否则按 name 取回。
    // 同步版本（buildContent）：仅当 data 已就绪时返回图片；未就绪时该图被跳过（用于 token 估算等非关键路径）。
    // 发送关键路径用 preloadAttachments 先把 name→data 预加载完毕，再调 buildContent 拿到完整图片。
    async preloadAttachments(m) {
      if (!m || !m.attachments || !m.attachments.length) return;
      await Promise.all(m.attachments.filter(a => a.type === 'image' && !a.data && a.name).map(async (a) => {
        const url = await cachedAttachmentDataUrl(a.name);
        if (url) a.data = url; // 临时挂回 data 供本次 buildContent 使用（不 persist，仅内存态）
      }));
    },
    buildContent(m) {
      const textParts = [m.content || ''];
      const textAttachments = [];
      const images = [];
      if (m.attachments && m.attachments.length) {
        m.attachments.forEach(a => {
          if (a.type === 'image' && a.data) images.push(a.data);
          else if (a.type !== 'image') textAttachments.push(`【附件：${a.name}】\n${a.text || ''}`);
        });
      }
      if (textAttachments.length) textParts.push(textAttachments.join('\n\n'));
      const textContent = textParts.join('\n\n').trim();
      if (!images.length) return textContent;
      const arr = [];
      if (textContent) arr.push({ type: 'text', text: textContent });
      images.forEach(url => arr.push({ type: 'image_url', image_url: { url } }));
      return arr;
    },

    newConversation(agent, options) {
      const opts = options && typeof options === 'object' ? options : {};
      const requestedOwner = String(opts.owner || opts.originModule || opts.stay || '').trim().toLowerCase();
      const owner = opts.tangguanCharacterId || requestedOwner === 'tangguan'
        ? 'tangguan'
        : (requestedOwner === 'create' ? 'create' : 'default');
      if (isModuleOwner(owner) && ensureModuleRuntime().status === 'failed') {
        if (App.ui && App.ui.toast) App.ui.toast('模块会话迁移失败，请先恢复迁移后再新建会话');
        return null;
      }
      flushDraft({ owner, conversationId: activeConversationId(owner) });
      const previous = activeConversationFor(owner);
      if ((opts.stay === 'tangguan' || opts.stay === 'create') && previous && !isModuleConversation(previous)) {
        App.chat._preSurfaceActiveId = previous.id;
      }
      const inheritedAgent = owner === 'create' && !agent && opts.inheritActive !== false && previous && previous.agentId
        && App.create && typeof App.create.getAgent === 'function'
        ? App.create.getAgent(previous.agentId)
        : null;
      const configSource = agent || (inheritedAgent ? previous : null);
      const configAgent = agent || inheritedAgent;
      const conv = { id: App.uid(), title: '新对话', messages: [], updatedAt: Date.now() };
      if (owner === 'tangguan') {
        conv.originModule = 'tangguan';
        conv.tangguanRestricted = true;
        conv.web = false;
        conv.allowWeb = false;
        conv.allowAttachments = false;
        conv.allowTools = false;
      } else if (owner === 'create') {
        conv.originModule = 'create';
      } else if (opts.originModule) {
        conv.originModule = String(opts.originModule);
      }
      if (owner === 'tangguan' && opts.tangguanCharacterId) {
        conv.originModule = 'tangguan';
        conv.tangguanCharacterId = String(opts.tangguanCharacterId);
      }
      if (configAgent) {
        conv.title = configAgent.name;
        conv.agentId = configAgent.id;
        conv.systemPrompt = configSource.systemPrompt || configAgent.systemPrompt || '';
        // 对话级模型/参数优先（智能体指定），否则回退聊天默认
        if (configSource.model) conv.model = configSource.model;
        if (typeof configSource.temperature === 'number') conv.temperature = configSource.temperature;
        if (typeof configSource.topP === 'number') conv.topP = configSource.topP;
        if (typeof configSource.web === 'boolean') conv.web = configSource.web;
        if (Array.isArray(configSource.starters) && configSource.starters.length) conv.starters = configSource.starters.slice();
        // M12：智能体语气（tone）此前是死字段，此处落到对话，发送时注入系统提示
        if (configSource.tone) conv.tone = configSource.tone;
        // 计入智能体使用次数
        if (agent && configAgent.id && App.create && App.create.trackUsage) App.create.trackUsage(configAgent.id);
      }
      if (isModuleOwner(owner)) {
        ensureModuleRuntime().data[owner].activeId = conv.id;
        persistModuleConversation(owner, conv, { activeId: conv.id });
      } else {
        App.state.conversations.unshift(conv);
        App.state.activeId = conv.id;
      }
      resetTangguanMessageWindow(conv);
      App.chat.clearAttachments();
      App.chat.cancelEdit();
       if (opts.persist !== false && !isModuleOwner(owner)) setTimeout(() => App.persist(), 0); // v1.1.6（B1）：去同步——与会话切换帧解耦
       if (opts.stay === 'tangguan') {
         if (App.state.view !== 'tangguan') App.router.go('tangguan', { persist: opts.persist !== false, skipDraftFlush: true });
       } else if (opts.stay === 'create') {
         if (App.state.view !== 'create') App.router.go('create', { persist: opts.persist !== false, skipDraftFlush: true });
      } else {
        App.router.go('chat');
      }
      App.ui.renderSidebar();
      App.chat.showWelcome();
      App.ui.renderTopbarTitle();
      if (opts.stay === 'create' && App.create && typeof App.create.openTaskSession === 'function') {
        App.create.openTaskSession(conv.id);
      }
      return conv;
    },

    // 用智能体的某条引导问题开聊：新建对话并把问题预填到输入框（用户一键发送）
    startWithStarter(agent, starter) {
      const conversation = App.chat.newConversation(agent, { owner: 'create', stay: 'create', originModule: 'create' });
      if (!conversation) return;
      const input = document.getElementById('input');
      if (input) { input.value = starter || ''; input.focus(); }
    },

    activate(id, options) {
      const opts = options && typeof options === 'object' ? options : {};
      const owner = opts.owner || (opts.originModule === 'tangguan' || opts.stay === 'tangguan'
        ? 'tangguan'
        : opts.originModule === 'create' || opts.stay === 'create' ? 'create' : currentOwner());
      flushDraft({ owner, conversationId: activeConversationId(owner) });
      const current = activeConversationFor(owner);
      if (opts.stay === 'tangguan' || opts.stay === 'create') {
        if (current && !isModuleConversation(current)) App.chat._preSurfaceActiveId = current.id;
      }
      setActiveConversationId(owner, id);
      const next = conversationById(owner, id);
      if (isModuleOwner(owner) && next) persistModuleConversation(owner, next, { activeId: id });
      resetTangguanMessageWindow(App.chat.activeConv());
      App.chat.clearAttachments();
      App.chat.cancelEdit();
       if (opts.persist !== false && !isModuleOwner(owner)) setTimeout(() => App.persist(), 0); // v1.1.6（B1）：去同步——与会话切换帧解耦
       if (opts.stay === 'tangguan') {
         if (App.state.view !== 'tangguan') App.router.go('tangguan', { persist: opts.persist !== false, skipDraftFlush: true });
       } else if (opts.stay === 'create') {
         if (App.state.view !== 'create') App.router.go('create', { persist: opts.persist !== false, skipDraftFlush: true });
      } else {
        App.router.go('chat');
      }
      App.ui.renderSidebar();
       if (opts.render !== false) {
         App.chat.renderMessages();
         App.ui.renderTopbarTitle();
       }
      if (opts.stay === 'create' && App.create && typeof App.create.openTaskSession === 'function') {
        App.create.openTaskSession(id);
      }
    },

    deleteConversation(id, options) {
      const opts = options && typeof options === 'object' ? options : {};
      const owner = opts.owner || currentOwner();
      const target = String(id || '');
      const wasActive = activeConversationId(owner) === target;
      let result = { ok: true, removed: false, activeId: activeConversationId(owner) };
      if (isModuleOwner(owner)) {
        result = removeModuleConversation(owner, target);
        if (wasActive) setActiveConversationId(owner, result.activeId || null);
      } else {
        const before = App.state.conversations.length;
        App.state.conversations = App.state.conversations.filter(c => c.id !== target);
        result.removed = App.state.conversations.length !== before;
        if (App.state.activeId === target) {
          App.state.activeId = App.state.conversations[0] ? App.state.conversations[0].id : null;
        }
        result.activeId = App.state.activeId || null;
      }
      if (opts.render !== false && activeConversationId(owner) !== target && !isModuleOwner(owner)) {
        App.chat.renderMessages();
      }
      if (opts.render !== false && isModuleOwner(owner)) App.chat.renderMessages();
      if (!isModuleOwner(owner)) App.persist();
      if (opts.render !== false) {
        App.ui.renderSidebar();
        App.ui.renderTopbarTitle();
      }
      return Object.assign({ owner, id: target }, result);
    },

    async rename() {
      const conv = App.chat.activeConv();
      if (!conv) { App.ui.toast('没有可重命名的对话'); return; }
      const name = await App.ui.promptModal({
        title: '重命名对话',
        label: '对话名称',
        value: conv.title || '新对话',
        placeholder: '输入新的对话名称',
        confirmText: '重命名',
        maxLength: 60,
      });
      if (name === null) return; // 取消
      conv.title = name.trim() || conv.title;
      App.chat.persistConversation(conv);
      App.ui.renderTopbarTitle();
      App.ui.renderSidebar();
    },

    clear() {
      const conv = App.chat.activeConv();
      if (!conv) { App.ui.toast('没有可清空的对话'); return; }
      conv.messages = [];
      App.chat.persistConversation(conv);
      App.chat.renderMessages();
      App.ui.toast('已清空对话');
    },

    deleteMessage(idx) {
      const conv = App.chat.activeConv();
      if (!conv || idx == null || idx < 0 || idx >= conv.messages.length) return;
      conv.messages.splice(idx, 1);
      App.chat.persistConversation(conv);
      App.chat.renderMessages();
      App.ui.toast('已删除该条消息');
    },

    attachTextFile(file) {
      if (isTangguanConv(App.chat.activeConv())) { App.ui.toast('糖馆独立会话不支持图片或文件附件'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        let text = String(reader.result || '');
        const MAX = 20000;
        if (text.length > MAX) text = text.slice(0, MAX) + '\n…（附件过长已截断）';
        pendingAttachments.push({ id: App.uid(), name: file.name, type: file.type || 'text/plain', text, size: file.size });
        App.chat.pendingAttachments = pendingAttachments;
        App.chat.renderAttachChips();
        App.chat.updateSendEnabled();
        App.ui.toast('已附加 ' + file.name);
      };
      reader.onerror = () => App.ui.toast('读取文件失败：' + file.name);
      reader.readAsText(file);
    },

    startWithAgent(agent) {
      App.chat.newConversation(agent, { owner: 'create', stay: 'create', originModule: 'create' });
      $('input').focus();
    },

    showWelcome() {
      const welcome = $('welcome');
      const messages = $('messages');
      const composer = $('composer');
      const conv = App.chat.activeConv();
      const owner = surfaceState && surfaceState.owner ? surfaceState.owner : currentOwner();
      // The shared surface is reused by Tangguan and regular Chat. Clear the
      // previous conversation before showing an empty state so an empty
      // Tangguan session can never expose the old session's DOM.
      if (messages) messages.innerHTML = '';
      renderedConvId = null;
      renderedContentStamp = ''; // 清空态同步清戳，避免清空后重入被守卫跳过
      if (owner === 'create' && App.create && typeof App.create.renderTaskWelcome === 'function') {
        welcome.style.display = 'flex';
        messages.style.display = 'none';
        composer.style.display = 'block';
        App.create.renderTaskWelcome(welcome, conv);
        return;
      }
      if (owner === 'tangguan' && App.tangguan && typeof App.tangguan.renderWelcome === 'function') {
        welcome.style.display = 'flex';
        messages.style.display = 'none';
        composer.style.display = 'block';
        App.tangguan.renderWelcome(welcome, conv);
        return;
      }
      welcome.style.display = 'flex';
      messages.style.display = 'none';
      composer.style.display = 'block';
      // 聊天修复 F：输入框不再移入欢迎区居中——composer 始终留在 .view 底部，欢迎页也统一贴底
      $('chatTitle').textContent = '糖包';
      messages.innerHTML = '';
      App.chat.renderDefaultWelcome();
    },

    showChat() {
      const welcome = $('welcome');
      const messages = $('messages');
      const composer = $('composer');
      welcome.style.display = 'none';
      messages.style.display = 'flex';
      composer.style.display = 'block';
    },

    renderDefaultWelcome() {
      const welcome = $('welcome');
      if (!welcome) return;
      welcome.innerHTML = `<div class="welcome-logo"><img src="assets/logo.png" alt="糖包" /></div>
        <h1 class="welcome-title">有什么可以帮忙的？</h1>
        <p class="welcome-sub">我是糖包，你的全能 AI 助手</p>
        <div class="quick-actions" id="quickActions"></div>
        <div class="suggestions" id="suggestions"></div>`;
      App.chat.renderQuickActions();
      App.chat.renderSuggestions();
      bindWelcomeActions();
    },

    renderSuggestions() {
      $('suggestions').innerHTML = SUGGESTIONS.map((s, i) =>
        `<button class="suggestion" data-i="${i}">
           <span class="s-icon">${s.icon}</span>
           <span class="s-title">${App.escapeHtml(s.title)}</span>
           <span class="s-desc">${App.escapeHtml(s.desc)}</span>
         </button>`).join('');
    },

    renderQuickActions() {
      $('quickActions').innerHTML = QUICK_ACTIONS.map(a =>
        `<button class="quick-chip" data-prompt="${App.escapeHtml(a.prompt)}">${App.escapeHtml(a.label)}</button>`).join('');
    },

    messageNode(m, index) {
      const wrap = document.createElement('div');
      wrap.className = 'msg ' + m.role;
      wrap.dataset.index = index;
      if (m.id) wrap.dataset.messageId = m.id;
      if (m.role === 'assistant') {
        const thinkHtml = m.think
          ? `<div class="think-block" style="display:${(App.state.settings.thinkLevel || 'medium') !== 'off' ? 'block' : 'none'}">
               <div class="think-head"><span class="think-toggle">▾</span>深度思考</div>
               <div class="think-body">${App.escapeHtml(m.think)}</div>
             </div>`
          : '';
        // M9：答案版本切换（regenerate 重新生成后旧回答归档为版本；按钮位于「重新生成」与「删除」之间）
        const versions = (m.versions && m.versions.length > 1) ? m.versions : null;
        const vIdx = versions ? (m.versionIdx != null ? m.versionIdx : versions.length - 1) : 0;
        const displayContent = versions ? (versions[vIdx] || m.content || '') : (m.content || '');
        const versionBtn = versions
          ? `<button class="version-switch" data-version="1" title="切换回答版本">${vIdx + 1}/${versions.length}</button>`
          : '';
        const webLabel = m.webSources ? (m.webSources + ' 个') : '多个';
        const tangguan = isTangguanConv(App.chat.activeConv()) || isTangguanConversation(App.state.activeId);
        const webHtml = !tangguan && (m.webSources || (App.state.web && m.role === 'assistant'))
          ? '<div class="web-indicator"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>基于 ' + webLabel + '搜索来源</div>'
          : '';
        wrap.innerHTML = `<div class="msg-avatar"><img src="assets/logo.png" alt="糖包"></div>
          <div class="msg-body">
            <div class="msg-card">
              ${webHtml}
              ${thinkHtml}
              <div class="bubble"></div>
              <div class="msg-actions" data-msg="${index}">
                <button data-action="copy">复制</button>
                <button data-action="copy-md">复制 Markdown</button>
                <button data-action="regen">重新生成</button>
                ${versionBtn}
                <button data-action="delete">删除</button>
              </div>
            </div>
          </div>`;
        if (m.streamStatus === 'failed' || m.streamStatus === 'cancelled') {
          const actions = wrap.querySelector('.msg-actions');
          if (actions) actions.insertAdjacentHTML('beforeend', '<button data-action="continue">Continue</button>');
        }
        let bubbleHtml;
        try {
          bubbleHtml = cachedMarkdown(displayContent, (m.id || index) + ':' + vIdx);
        } catch (e) {
          // 渲染异常时降级为纯文本 + 提示，保证消息不丢、不白屏
          bubbleHtml = '<div class="msg-error">内容渲染失败：' + App.escapeHtml(String((e && e.message) || e)) +
            '</div><pre class="bubble-fallback">' + App.escapeHtml(displayContent) + '</pre>';
        }
        const errorHtml = m.error && !displayContent
          ? '<div class="msg-error">' + App.escapeHtml(String(m.error)) + '</div>'
          : '';
        wrap.querySelector('.bubble').innerHTML = errorHtml || bubbleHtml;
      } else {
        const imgHtml = (m.attachments && m.attachments.length)
          ? m.attachments.filter(a => a.type === 'image').map(a =>
              `<img class="chat-img" data-att-name="${App.escapeHtml(a.name || '')}" src="${App.escapeHtml(a.data || '')}" alt="${App.escapeHtml(a.origName || a.name || '')}" title="${App.escapeHtml(a.origName || a.name || '')}">`).join('')
          : '';
        const attHtml = (m.attachments && m.attachments.length)
          ? `<div class="attach-cards">` + m.attachments.filter(a => a.type !== 'image').map(a =>
              `<div class="attach-card"><span class="attach-ico">📄</span><span class="attach-name">${App.escapeHtml(a.name)}</span></div>`
            ).join('') + `</div>`
          : '';
        wrap.innerHTML = `<div class="msg-body">
            ${imgHtml}
            ${attHtml}
            <div class="bubble user-bubble"></div>
            <div class="msg-actions user-actions"><button data-action="copy-user">复制</button><button data-action="edit">编辑</button><button data-action="delete">删除</button></div>
          </div>`;
        const bubble = wrap.querySelector('.user-bubble');
        bubble.textContent = m.content || '';
        // 聊天修复 G：无文字即隐藏卡片气泡——纯图片/纯附件/空内容不再显示白底气泡，
        // 图片保留 .chat-img 圆角细边框直显；图文混合时行为不变
        if (!m.content) bubble.style.display = 'none';
      }
      return wrap;
    },

    renderMessages() {
      const messages = $('messages');
      const conv = App.chat.activeConv();
      if (!conv || !Array.isArray(conv.messages) || !conv.messages.length) {
        App.chat.showWelcome();
        App.chat.updateCtxBar();
        return;
      }
      // Keep the live bubble intact only while the currently visible
      // conversation is the one streaming. A navigation to another surface
      // must render that surface instead of carrying the old live DOM with it.
      if (streaming && streamConvId === conv.id && renderedConvId === conv.id
        && streamUi && streamUi.bubble && streamUi.bubble.isConnected
        && streamUi.bubble.closest('#messages') === messages) {
        return;
      }
      // v1.1.5：内容戳守卫——戳 = 会话 id + 条数 + 全部 content/think 长度和 + 末条流状态。
      // 编辑/删除/重生成/新消息都会改变戳；模块往返（聊天↔糖码）重进同一未变化会话时
      // 直接复用现有 DOM，跳过整窗重建（保留滚动位置，只做滚动跟随与标题/用量条刷新）。
      let stampSum = 0;
      for (const m of conv.messages) stampSum += String(m && m.content != null ? m.content : '').length + String(m && m.think != null ? m.think : '').length;
      const lastMsg = conv.messages[conv.messages.length - 1];
      const stamp = conv.id + '|' + conv.messages.length + '|' + stampSum + '|' + ((lastMsg && lastMsg.streamStatus) || '');
      if (stamp === renderedContentStamp && renderedConvId === conv.id
        && messages.children.length > 0 && messages.style.display !== 'none') {
        App.chat.scrollBottom(true);
        App.ui.renderTopbarTitle();
        App.chat.updateCtxBar();
        return;
      }
      resetTangguanMessageWindow(conv);
      App.chat.showChat();
       messages.innerHTML = '';
       const fragment = document.createDocumentFragment();
       const start = Math.max(0, conv.messages.length - messageVisibleCount);
       if (start > 0) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'btn-ghost mini tangguan-history-more';
        more.textContent = '加载更早消息';
         more.addEventListener('click', () => { messageVisibleCount += 50; App.chat.renderMessages(); });
         fragment.appendChild(more);
      }
      conv.messages.slice(start).forEach((m, offset) => {
        const i = start + offset;
        try {
           fragment.appendChild(App.chat.messageNode(m, i));
        } catch (e) {
          // 单条消息渲染失败不应清空整段对话：降级为纯文本气泡，保证不丢消息
          const fb = document.createElement('div');
          fb.className = 'msg ' + (m.role || 'assistant');
          if (m.id) fb.dataset.messageId = m.id;
          const b = document.createElement('div'); b.className = 'bubble';
          b.textContent = (m.content != null ? m.content : '') + '';
          fb.appendChild(b);
           fragment.appendChild(fb);
        }
       });
       messages.appendChild(fragment);
      // v1.1.6（批次 C3）：惰性迁移——渲染后对有 name 但无 data 的图片附件异步取回并填充 src；
      // 同时把取回的 data 落回 message 对象并异步 persist（先取回后改 state，可重入不丢数据）。
      messages.querySelectorAll('img.chat-img[data-att-name]').forEach(async (img) => {
        const name = img.dataset.attName;
        if (!name || img.src) return;
        img.removeAttribute('data-att-name');
        const url = await cachedAttachmentDataUrl(name);
        if (!url) return;
        img.src = url;
        let migrated = false;
        for (const m of conv.messages) {
          if (m.attachments) for (const a of m.attachments) {
            if (a.type === 'image' && a.name === name && !a.data) { a.data = url; migrated = true; }
          }
        }
        if (migrated) setTimeout(() => App.persist(), 0);
      });
      renderedConvId = conv.id;
      renderedContentStamp = stamp; // 构建成功后才落戳，失败重入仍会完整重建
      if (streaming && streamConvId === conv.id && streamUi && streamUi.messageId) {
        const liveNode = Array.from(messages.children).find((node) => node.dataset && node.dataset.messageId === streamUi.messageId);
        if (liveNode) App.chat.bindStreamUi(streamUi, liveNode);
      }
      App.chat.scrollBottom(true);
      App.ui.renderTopbarTitle();
      App.chat.updateCtxBar();
    },

    // 渲染聊天上下文用量条（显示实际发送给模型的 token 数）
    // M12：统一构建发送给模型的系统提示内容（基础系统提示 + 智能体语气）；streamChat 与 updateCtxBar 共用，保证用量条与实际发送一致
    buildSystemContent(conv) {
      const defaultSys = (App.state.settings.prompts && App.state.settings.prompts.chat) || (typeof SYSTEM_PROMPT !== 'undefined' ? SYSTEM_PROMPT : '');
      // Tangguan character instructions are added by preparePrompt after this
      // base prompt. Keep the shared Chat safety rules in front of them instead
      // of allowing a character card to replace the default system prompt.
      const baseSys = isTangguanConv(conv)
        ? defaultSys
        : ((conv && conv.systemPrompt) || defaultSys);
      let sc = baseSys;
      if (conv && conv.tone) sc += '\n\n# 语气要求\n请用「' + conv.tone + '」的语气回复用户。';
      return sc;
    },

    updateCtxBar() {
      const el = $('chatCtxBar'); if (!el) return;
      const conv = App.chat.activeConv();
      if (!conv || !conv.messages) { if (el.style) el.style.display = 'none'; contextBarKey = ''; return; }
      if (el.style) el.style.display = '';
      const model = (conv && conv.model) || providerForConversation(conv).model || '';
      const userMemory = isTangguanConv(conv) ? '' : (App.state.settings.userMemory || '');
      const nextKey = contextBarStamp(conv, model, userMemory);
      if (nextKey === contextBarKey) return;
      contextBarKey = nextKey;
      const ctxWindow = App.context.contextWindowOf(model);
      const allMsgs = conv.messages.map(m => ({ role: m.role, content: App.chat.buildContent(m) }));
      const systemContent = App.chat.buildSystemContent(conv);
      // 用 getCompactMessages 得到与发送一致的 finalMessages → bar 显示值 = 实际发送值
      const compact = App.context.getCompactMessages({
        messages: allMsgs, summary: conv.summary || '', summaryCount: conv.summaryCount || 0,
        recentKeep: App.context.RECENT_KEEP_CHAT, systemContent, window: ctxWindow,
      });
      const tokens = App.context.messagesTokens(compact.finalMessages);
       const userMemTok = App.context.estimateTokens(isTangguanConv(conv) ? '' : userMemory);
      const bd = App.context.breakdownFromFinal(compact.finalMessages, userMemTok);
      if (App.context.renderUsage) App.context.renderUsage(el, tokens + userMemTok, ctxWindow, bd);
    },

    isNearBottom() {
      const c = chatScrollNode();
      if (!c) return true;
      return c.scrollHeight - c.scrollTop - c.clientHeight < 60;
    },
    scrollBottom(force) {
      const c = chatScrollNode();
      if (!c) return;
      // 仅在强制或用户已贴近底部时跟随，避免打断向上翻看
      if (force || App.chat.isNearBottom()) c.scrollTop = c.scrollHeight;
    },

    appendAssistant(initialContent) {
      const wrap = document.createElement('div');
      wrap.className = 'msg assistant';
      const conv = App.chat.activeConv();
      wrap.innerHTML = `<div class="msg-avatar"><img src="assets/logo.png" alt="糖包"></div>
        <div class="msg-body">
          <div class="msg-card">
            ${App.state.web ? `<div class="web-indicator"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 010 18M12 3a14 14 0 000 18"/></svg>基于多个搜索来源</div>` : ''}
            <div class="think-block" style="display:none"><div class="think-head"><span class="think-toggle">▾</span>深度思考</div><div class="think-body"></div></div>
            <div class="bubble"><div class="typing"><span></span><span></span><span></span></div></div>
            <div class="msg-actions" style="display:none">
              <button data-action="copy">复制</button>
              <button data-action="copy-md">复制 Markdown</button>
              <button data-action="regen">重新生成</button>
            </div>
          </div>
        </div>`;
      const webIndicator = wrap.querySelector('.web-indicator');
      if (isTangguanConv(conv) && webIndicator) webIndicator.remove();
      $('messages').appendChild(wrap);
      if (initialContent) {
        try { wrap.querySelector('.bubble').innerHTML = App.renderMarkdown(initialContent); } catch (_) { wrap.querySelector('.bubble').textContent = initialContent; }
      }
      return {
        root: wrap,
        bubble: wrap.querySelector('.bubble'),
        thinkBlock: wrap.querySelector('.think-block'),
        thinkBody: wrap.querySelector('.think-body'),
        actions: wrap.querySelector('.msg-actions'),
      };
    },

    bindStreamUi(ui, node) {
      if (!ui || !node) return ui;
      ui.root = node;
      ui.bubble = node.querySelector('.bubble') || ui.bubble;
      ui.thinkBlock = node.querySelector('.think-block') || ui.thinkBlock;
      ui.thinkBody = node.querySelector('.think-body') || ui.thinkBody;
      ui.actions = node.querySelector('.msg-actions') || ui.actions;
      return ui;
    },

    async streamChat(conv, ui, options) {
      const streamOwner = ownerForConversation(conv);
      const providerModule = streamOwner === 'tangguan' || streamOwner === 'create' ? streamOwner : 'chat';
      // Provider adapters all receive a chat request. The module name selects
      // local credentials only; it is never sent as a gateway request kind.
      const transportKind = 'chat';
      const s = providerForConversation(conv);
      const liveMessage = (options && options.liveMessage) || {
        id: App.uid(),
        role: 'assistant',
        content: '',
        think: '',
        streamStatus: 'streaming',
        requestId: 'chat_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
        sequence: 0,
        startedAt: Date.now(),
      };
      // Keep a durable placeholder before the first provider byte. A process
      // crash or renderer reload can therefore show the partial answer rather
      // than silently losing the assistant turn.
      if (!conv.messages.includes(liveMessage)) conv.messages.push(liveMessage);
      if (!liveMessage.id) liveMessage.id = App.uid();
      streamUi = ui;
      streamUi.convId = conv.id;
      streamUi.messageId = liveMessage.id;
      if (streamUi.root) streamUi.root.dataset.messageId = liveMessage.id;
      liveMessage.streamStatus = 'streaming';
      liveMessage.requestId = 'chat_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      conv.updatedAt = Date.now();
      if (!s.ref || !s.hasKey || !s.model) {
        const errorText = '尚未配置当前模块 API。请在设置中为“' + (providerModule === 'tangguan' ? '糖馆' : providerModule === 'create' ? '糖创' : '聊天') + '”选择账户、模型和 API Key。';
        liveMessage.streamStatus = 'failed';
        liveMessage.error = errorText;
        liveMessage.updatedAt = Date.now();
        try { App.chat.persistConversation(conv); } catch (_) {}
        ui.bubble.innerHTML = '<div class="msg-error">' + App.escapeHtml(errorText) + '</div>';
        ui.actions.style.display = 'flex';
        return { ok: false, code: 'provider_not_configured', error: errorText };
      }
      App.chat.persistConversation(conv);
      const baseSys = App.chat.buildSystemContent(conv);
       const userMemory = isTangguanConv(conv) ? '' : (App.state.settings.userMemory || '').trim();
      // 聊天端享受用户长期记忆（差距 #4）：并入系统提示，与糖码后端注入方式一致
      let systemContent = userMemory ? (baseSys + '\n\n# 用户长期记忆\n' + userMemory) : baseSys;
      // Tangguan sessions receive only the selected local character and its
      // worldbook. Retrieval is scoped by character and never overrides the
      // base safety prompt.
      if (isTangguanConv(conv) && App.tangguan && App.tangguan.preparePrompt) {
        const lastUser = conv.messages.filter((item) => item.role === 'user').pop();
        const query = lastUser && typeof lastUser.content === 'string' ? lastUser.content : '';
        const tangguanPrompt = await App.tangguan.preparePrompt(conv, query).catch(() => '');
        if (tangguanPrompt) systemContent += '\n\n' + tangguanPrompt;
      }
      // 对话级模型优先（智能体指定），否则用聊天默认模型；联网同理
      const model = (conv.model && s.models.includes(conv.model)) ? conv.model : s.model;
      // M12：智能体指定模型不可用时给出提示（按对话+模型去重，避免每次发送重复弹）
      if (conv.model && s.models.length && !s.models.includes(conv.model)) {
        const key = conv.id + '|' + conv.model;
        if (App.chat._modelWarned !== key) {
          App.chat._modelWarned = key;
          App.ui.toast('智能体指定模型 ' + conv.model + ' 不在当前账户模型中，已改用 ' + s.model);
        }
      }
      const web = isTangguanConv(conv) ? false : ((conv.web != null) ? conv.web : App.state.web);
      const AGENT_BASE = App.rt.agentBase(); // 本机随机端口，运行时取
      const allMsgs = conv.messages.filter((item) => item !== liveMessage).map(m => ({ role: m.role, content: isTangguanConv(conv) ? String(m.content || '') : App.chat.buildContent(m) }));
      if (options && options.liveMessage) {
        allMsgs.push({ role: 'assistant', content: App.chat.buildContent(options.liveMessage) });
        allMsgs.push({ role: 'user', content: 'Continue the previous answer. Append only new information; do not repeat the existing answer.' });
      }
      // 异步压缩（#7）：同步取 finalMessages 直接发送，压缩在后台跑，不阻塞本轮 send
      const ctxWindow = App.context.contextWindowOf(model);
      const compact = App.context.getCompactMessages({
        messages: allMsgs,
        summary: conv.summary || '',
        summaryCount: conv.summaryCount || 0,
        recentKeep: App.context.RECENT_KEEP_CHAT,
        systemContent,
        window: ctxWindow,
      });
      let finalMessages = compact.finalMessages;
      // 压缩（G3）：首次（无摘要）同步出摘要再发送，消除「先丢历史、下一轮才有摘要」断层；已有摘要时后台异步，下一轮生效
      if (compact.needsCompress && compact.middleMsgs.length && !conv._compressing) {
        conv._compressing = true;
        const vCheck = () => compact.newSummaryCount === (conv.summaryCount || 0) + compact.middleMsgs.length;
        if (!conv.summary) {
          // G3：首次压缩改同步——先出摘要再组装发送；失败回退全量，不丢中间段
          const newSummary = await App.context.compressAsync('', compact.middleMsgs, s, ctxWindow, vCheck).catch(() => null);
          if (newSummary) {
            conv.summary = newSummary;
            conv.summaryCount = compact.newSummaryCount;
            App.chat.persistConversation(conv);
            App.chat.updateCtxBar();
            const compact2 = App.context.getCompactMessages({
              messages: allMsgs, summary: conv.summary, summaryCount: conv.summaryCount || 0,
              recentKeep: App.context.RECENT_KEEP_CHAT, systemContent, window: ctxWindow,
            });
            finalMessages = compact2.finalMessages;
          } else {
            finalMessages = allMsgs; // G3：压缩失败回退全量发送，不丢中间段
          }
          conv._compressing = false;
        } else {
          App.context.compressAsync(conv.summary || '', compact.middleMsgs, s, ctxWindow, vCheck).then(newSummary => {
            if (newSummary) {
              conv.summary = newSummary;
              conv.summaryCount = compact.newSummaryCount;
              App.chat.persistConversation(conv);
              App.chat.updateCtxBar();
              App.ui.toast('已自动压缩较早对话上下文');
            }
            conv._compressing = false;
          });
        }
      }
      // /context 明细：system=系统提示，memory=用户长期记忆（内联进系统提示，单独列为 memory 段），history=对话+摘要
       const cmSys = App.context.estimateTokens(systemContent);
       const cmMem = App.context.estimateTokens(userMemory);
      const cmTotal = App.context.messagesTokens(finalMessages);
      const chatBd = { system: cmSys, memory: cmMem, history: Math.max(0, cmTotal - cmSys - cmMem) };
      // G6：用量条阈值用实际发送模型（conv.model 优先），而非聊天默认 s.model
      if (App.context.renderUsage) App.context.renderUsage($('chatCtxBar'), cmTotal, App.context.contextWindowOf(model), chatBd);
      const payload = {
        model,
        stream: true,
        messages: finalMessages,
      };
       // Tangguan is tool-free. Its local policy stays on the conversation;
       // only the provider-compatible empty tool list is sent.
       if (isTangguanConv(conv)) {
          payload.tools = [];
       }
      if (typeof conv.temperature === 'number') payload.temperature = conv.temperature;
      if (typeof conv.topP === 'number') payload.top_p = conv.topP;
      // 深度思考：按模型自适应注入真实 API 参数
      Object.assign(payload, App.buildThinkParam(model, App.state.settings.thinkLevel || 'medium'));
      // 联网搜索：原生支持的模型直接发原生参数；不支持的（deepseek/kimi/claude 等）
      // 由本地后端(/api/search)先做真实检索，把结果注入 system 上下文，从而真正能联网。
      let webSourcesCount = 0;
      if (web) {
        const native = App.nativeWebModel(model);
        if (native) {
          Object.assign(payload, App.buildWebParam(model, true));
        } else {
          const lastUserMsg = conv.messages.filter(m => m.role === 'user').pop();
          const lastUserText = lastUserMsg
            ? (typeof lastUserMsg.content === 'string' ? lastUserMsg.content : ((lastUserMsg.content && lastUserMsg.content.text) || ''))
            : '';
          let searched = null;
          try {
            // 搜索 Key 由后端从密钥库取（ref = 'search'），前端不再经手明文
            const r = await fetch(AGENT_BASE + '/api/search', {
              method: 'POST',
              headers: App.rt.authHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ query: lastUserText }),
            });
            const d = await r.json().catch(() => ({ ok: false }));
            if (d && d.ok && Array.isArray(d.results) && d.results.length) searched = d.results;
          } catch (e) { /* 本地后端不可用，走普通对话 */ }
          if (searched) {
            const ctx = '【联网搜索结果】\n' + searched.map((x, i) =>
              `${i + 1}. ${x.title || ''}\n${x.url || ''}\n${x.snippet || ''}`).join('\n\n');
            payload.messages[0].content += '\n\n' + ctx;
            webSourcesCount = searched.length;
          } else {
            App.ui.toast('联网搜索暂不可用（未能获取搜索结果），将按普通对话发送');
          }
        }
      }
      let acc = (options && options.liveMessage && options.liveMessage.content) || '';
      let thinkAcc = (options && options.liveMessage && options.liveMessage.think) || '';
      let started = !!(acc || thinkAcc), thinkOpen = false;
      const wantThink = (App.state.settings.thinkLevel || 'medium') !== 'off';
      const providerSequences = { content: -1, reasoning: -1 };
      const seenProviderEvents = new Set();
      const acceptProviderEvent = (json, channel, fragment) => {
        const source = json && typeof json === 'object' ? json : {};
        // `event_id` often identifies the whole stream rather than a delta.
        // Only explicit sequence fields are eligible for duplicate filtering.
        const value = source.sequence != null ? source.sequence : source.seq;
        if (value == null || value === '') return true;
        const marker = channel + ':' + String(value) + ':' + String(fragment == null ? '' : fragment);
        if (seenProviderEvents.has(marker)) return false;
        const number = Number(value);
        if (Number.isFinite(number) && number < providerSequences[channel]) return false;
        seenProviderEvents.add(marker);
        if (Number.isFinite(number)) providerSequences[channel] = number;
        return true;
      };
      let lastPartialPersistAt = 0;
      let pendingPersistBytes = 0;
      let lastObservedContentLength = String(acc || '').length;
      let lastObservedThinkLength = String(thinkAcc || '').length;
      const renderedStreamText = { bubble: null, content: '', contentNode: null, thinkBody: null, think: '', thinkNode: null };
      const appendStreamText = (node, value, key) => {
        if (!node) return;
        const nodeKey = key === 'content' ? 'bubble' : 'thinkBody';
        const textNodeKey = key === 'content' ? 'contentNode' : 'thinkNode';
        if (renderedStreamText[nodeKey] !== node) {
          renderedStreamText[nodeKey] = node;
          renderedStreamText[key] = '';
          renderedStreamText[textNodeKey] = null;
          node.textContent = '';
        }
        const previous = renderedStreamText[key];
        if (value === previous) return;
        // Reuse one text node throughout the stream. Appending a node for each
        // delta makes long responses increasingly expensive to layout and
        // leaves hundreds of detached fragments for the final Markdown pass.
        if (!renderedStreamText[textNodeKey]) {
          renderedStreamText[textNodeKey] = document.createTextNode('');
          node.appendChild(renderedStreamText[textNodeKey]);
        }
        renderedStreamText[textNodeKey].nodeValue = value;
        renderedStreamText[key] = value;
      };
      const updateLiveMessage = (status) => {
        liveMessage.content = acc;
        liveMessage.think = thinkAcc;
        liveMessage.streamStatus = status || 'partial';
        liveMessage.updatedAt = Date.now();
        conv.updatedAt = liveMessage.updatedAt;
        const contentLength = String(liveMessage.content || '').length;
        const thinkLength = String(liveMessage.think || '').length;
        pendingPersistBytes += Math.max(0, contentLength - lastObservedContentLength);
        pendingPersistBytes += Math.max(0, thinkLength - lastObservedThinkLength);
        lastObservedContentLength = contentLength;
        lastObservedThinkLength = thinkLength;
      };
      const persistPartial = (status, force) => {
        updateLiveMessage(status);
        // Rendering may happen every 120 ms; storage is intentionally less
        // frequent so a long stream does not turn into a SQLite write storm.
        if (force || lastPartialPersistAt === 0 || liveMessage.updatedAt - lastPartialPersistAt >= 1000 || pendingPersistBytes >= 16384 || status === 'completed' || status === 'failed' || status === 'cancelled') {
          lastPartialPersistAt = liveMessage.updatedAt;
          pendingPersistBytes = 0;
          liveMessage.sequence += 1;
          try {
            if (isModuleOwner(streamOwner) && App.services && App.services.moduleSessions) {
              enqueueModuleWrite(streamOwner, () => App.services.moduleSessions.flushPartial({
                module: streamOwner,
                conversationId: conv.id,
                message: liveMessage,
                conversationUpdatedAt: conv.updatedAt,
              })).catch(() => { ensureModuleRuntime().lastError = 'module_session_partial_save_failed'; });
            } else {
              App.persist({ flushPartial: true, conversationId: conv.id, messageId: liveMessage.id });
            }
          } catch (_) {}
        }
      };
      // 流式渲染节流：把「整段 markdown 重渲染 + 滚动」合并到最多每 ~120ms 一次，
      // 避免长回复每个 delta 都重解析全文导致 O(n²) 卡顿；流末 flushNow 保证终态正确。
      let flushTimer = null;
      const flushRender = () => {
        const renderStarted = App.perf && App.perf.begin ? App.perf.begin() : 0;
        let canRender = false;
        try {
          canRender = !!(ui && ui.bubble && ui.bubble.isConnected && activeConversationId(streamOwner) === conv.id);
          const shouldFollow = canRender && App.chat.isNearBottom();
          if (canRender) {
            // Do not parse the entire growing Markdown document on every delta.
            // The completed message is rendered as Markdown after the stream.
            appendStreamText(ui.bubble, acc, 'content');
            if (wantThink && thinkAcc) {
              ui.thinkBlock.style.display = 'block';
              appendStreamText(ui.thinkBody, thinkAcc, 'think');
            }
          }
          persistPartial('partial');
           if (shouldFollow) App.chat.scrollBottom(true);
        } finally {
          if (App.perf) App.perf.measure('streamRenderMs', renderStarted, {
            rendered: canRender,
            contentLength: acc.length,
            thinkLength: thinkAcc.length,
          });
        }
      };
      const scheduleFlush = () => {
        if (flushTimer) return;
        flushTimer = setTimeout(() => { flushTimer = null; flushRender(); }, 120);
      };
      const flushNow = () => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        // 聊天修复 A：flush 渲染异常不得阻断消息落库（否则 streaming 卡死吞消息）
        try { flushRender(); } catch (e) { console.error('[chat] flush 渲染失败：', e); }
      };
      // 聊天修复 A：流末兜底保存——中断/报错也保留已生成内容（同糖码 finish 无条件保存）
      const saveAnswer = (errText) => {
        try { flushNow(); } catch (e) {}
        if (!acc && thinkAcc) { acc = thinkAcc; thinkAcc = ''; }
        if (acc || thinkAcc) {
          liveMessage.content = acc;
          liveMessage.think = thinkAcc;
          liveMessage.webSources = webSourcesCount;
          liveMessage.streamStatus = errText ? 'failed' : 'completed';
          liveMessage.error = errText ? String(errText).slice(0, 240) : '';
        } else if (errText) {
          liveMessage.content = '⚠️ ' + String(errText).slice(0, 240);
          liveMessage.think = '';
          liveMessage.webSources = webSourcesCount;
          liveMessage.streamStatus = 'failed';
          liveMessage.error = String(errText).slice(0, 240);
        } else {
          liveMessage.streamStatus = 'failed';
          liveMessage.error = 'model_empty_result';
        }
        conv.updatedAt = Date.now();
        persistPartial(liveMessage.streamStatus, true);
        if (ui && ui.bubble && ui.bubble.isConnected && activeConversationId(streamOwner) === conv.id) {
          if (acc) {
            try { ui.bubble.innerHTML = cachedMarkdown(acc, liveMessage.id + ':stream-final'); }
            catch (_) { ui.bubble.textContent = acc; }
            if (errText) ui.bubble.insertAdjacentHTML('beforeend', '<div class="msg-error">' + App.escapeHtml(String(errText).slice(0, 240)) + '</div>');
          } else if (errText) {
            ui.bubble.innerHTML = '<div class="msg-error">' + App.escapeHtml(String(errText).slice(0, 240)) + '</div>';
          }
        }
        if (errText && ui.actions && !ui.actions.querySelector('[data-action="continue"]')) {
          ui.actions.insertAdjacentHTML('beforeend', '<button data-action="continue">Continue</button>');
          ui.actions.style.display = 'flex';
        }
      };
      const appendDelta = (text, isThink) => {
        if (!started) { ui.bubble.textContent = ''; started = true; }
        if (isThink) { thinkAcc += text; } else { acc += text; }
        scheduleFlush();
      };
      // 检测并拆分 <think> 标签的文本
      const feedContent = (raw) => {
        while (raw) {
          if (!thinkOpen) {
            const idx = raw.indexOf('<think>');
            if (idx === -1) { appendDelta(raw, false); return; }
            if (idx > 0) appendDelta(raw.slice(0, idx), false);
            raw = raw.slice(idx + 7);
            thinkOpen = true;
          } else {
            const idx = raw.indexOf('</think>');
            if (idx === -1) { appendDelta(raw, true); return; }
            if (idx > 0) appendDelta(raw.slice(0, idx), true);
            raw = raw.slice(idx + 8);
            thinkOpen = false;
          }
        }
      };
      try {
        // 聊天修复 E：首字节看门狗——fetch 阶段挂起（网络半开）30s 后终止，走外层兜底保存。
        // The renderer sends one canonical gateway request. `gatewayFetch` is
        // the only boundary that strips renderer-only policy fields and adds
        // the local auth token; rebuilding the request here used to reintroduce
        // module aliases such as `create`/`tangguan` in older callers.
        const res = await raceTimeout(App.rt.gatewayFetch({
          ref: s.ref,
          kind: 'chat',
          telemetry: { scope: providerModule, callType: 'chat' },
          payload,
          signal: options && options.signal,
        }), STREAM_FIRST_BYTE_MS);
        if (!res.ok) {
          const txt = await App.rt.gatewayError(res);
          ui.bubble.innerHTML = `<div class="msg-error">请求失败（${res.status}）：${App.escapeHtml(String(txt).slice(0, 240))}</div>`;
          ui.actions.style.display = 'flex';
          saveAnswer(txt); // 聊天修复 A：失败也保留已生成部分/错误消息
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          // 聊天修复 E：流数据空闲看门狗——每次 read 重新计时，90s 无数据视为半开连接
          let chunk;
          try {
            chunk = await raceTimeout(reader.read(), STREAM_IDLE_MS);
          } catch (e) {
            if (e && e.code === 'STREAM_IDLE_TIMEOUT') throw e; // 外层 catch 走 saveAnswer 兜底
            throw e;
          }
          const { done, value } = chunk;
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split('\n');
          buf = parts.pop();
          for (const line of parts) {
            const t = line.trim();
            if (!t.startsWith('data:')) continue;
            const data = t.slice(5).trim();
            if (data === '[DONE]') break;
            let json;
            try { json = JSON.parse(data); } catch (e) { continue; }
            const delta = (json.choices && json.choices[0] && json.choices[0].delta) || {};
            if (delta.reasoning_content && acceptProviderEvent(json, 'reasoning', delta.reasoning_content)) {
              appendDelta(delta.reasoning_content, true);
              if (wantThink) ui.thinkBlock.style.display = 'block';
            }
            if (delta.content && acceptProviderEvent(json, 'content', delta.content)) feedContent(delta.content);
          }
        }
        // Flush a split UTF-8 code point before parsing the final SSE/JSON line.
        // Without this, a response ending in a multi-byte character can lose
        // its last character when the provider closes the stream.
        buf += decoder.decode();
        // 兼容中转站：流未以换行结尾，或根本不返回 SSE（单条 JSON）
        if (buf.trim()) {
          const t = buf.trim();
          if (t.startsWith('data:')) {
            const data = t.slice(5).trim();
            if (data && data !== '[DONE]') {
              try {
                const json = JSON.parse(data);
                const d = (json.choices && json.choices[0] && json.choices[0].delta) || {};
                if (d.reasoning_content && acceptProviderEvent(json, 'reasoning', d.reasoning_content)) { appendDelta(d.reasoning_content, true); if (wantThink) ui.thinkBlock.style.display = 'block'; }
                if (d.content && acceptProviderEvent(json, 'content', d.content)) feedContent(d.content);
              } catch (e) {}
            }
          } else {
            // 非流式：整段即一个 JSON 对象（部分中转站会忽略 stream:true）
            try {
              const json = JSON.parse(t);
              const ch = (json.choices && json.choices[0]) || {};
              if (ch.message && ch.message.reasoning_content) { appendDelta(ch.message.reasoning_content, true); if (wantThink) ui.thinkBlock.style.display = 'block'; }
              if (ch.message && ch.message.content) feedContent(ch.message.content);
              else if (ch.delta && ch.delta.content) feedContent(ch.delta.content);
            } catch (e) {}
          }
        }
      } catch (err) {
        ui.bubble.innerHTML = `<div class="msg-error">网络或 CORS 错误：${App.escapeHtml(String(err.message || err))}</div>`;
        ui.actions.style.display = 'flex';
        saveAnswer(err.message || err); // 聊天修复 A：中断保留已生成部分/错误消息
        return;
      }
      // 安全网：原生推理模型（如 grok）可能把完整回答放在思考通道（reasoning_content
      // 或未闭合 <think>），导致主 content 为空、气泡空白。此时把思考内容兜底为正文。
      if (!acc && thinkAcc) {
        acc = thinkAcc;
        thinkAcc = '';
        ui.bubble.innerHTML = App.renderMarkdown(acc);
      }
      // 聊天修复 A：统一走 saveAnswer 兜底保存（flushNow 已内置 try/catch）
      saveAnswer();
      if (acc) {
        try {
          if (ui.bubble && ui.bubble.isConnected) ui.bubble.innerHTML = cachedMarkdown(acc, liveMessage.id + ':stream-final');
        } catch (_) {
          if (ui.bubble && ui.bubble.isConnected) ui.bubble.textContent = acc;
        }
      } else if (!thinkAcc) {
        ui.bubble.innerHTML = '<div class="msg-error">模型未返回内容，请检查中转站地址和模型名。</div>';
      }
      if (wantThink && thinkAcc && ui.thinkBody && ui.thinkBody.isConnected) {
        try { ui.thinkBody.innerHTML = cachedMarkdown(thinkAcc, liveMessage.id + ':stream-think'); } catch (_) { ui.thinkBody.textContent = thinkAcc; }
        ui.thinkBlock.style.display = 'block';
      }
      ui.actions.style.display = 'flex';
    },

    // 手动压缩当前对话上下文：整段生成摘要并持久化，不裁剪 UI 历史
    async compactNow() {
      const conv = App.chat.activeConv();
      if (!conv || !conv.messages.length) return;
      const s = providerForConversation(conv);
      if (!s.ref || !s.hasKey || !s.model) { App.ui.toast('请先配置聊天 API'); return; }
      App.ui.toast('正在压缩上下文…');
      const allMsgs = conv.messages.map(m => ({ role: m.role, content: App.chat.buildContent(m) }));
      const summary = await App.context.summarizeFull(allMsgs, '', s);
      if (!summary) { App.ui.toast('压缩失败，稍后再试'); return; }
      conv.summary = summary;
      conv.summaryCount = Math.max(0, allMsgs.length - App.context.RECENT_KEEP_CHAT);
      App.chat.persistConversation(conv);
      App.chat.updateCtxBar();
      App.ui.toast('已压缩当前对话上下文');
    },

    // /memory 命令：写入用户长期记忆（userMemory），糖包与糖码共用同一份；不进入对话
    writeMemory(content) {
      if (!content) {
        const cur = (App.state.settings.userMemory || '').trim();
        App.ui.toast(cur ? ('当前用户长期记忆：\n' + cur) : '用法：/memory 要记住的内容');
        return;
      }
      const cur = (App.state.settings.userMemory || '').trim();
      const lines = cur ? cur.split('\n') : [];
      if (lines.includes(content)) { App.ui.toast('该记忆已存在'); return; }
      App.state.settings.userMemory = cur ? (cur + '\n' + content) : content;
      App.persist();
      if (App.ui.refreshSettingsUI) App.ui.refreshSettingsUI();
      App.chat.updateCtxBar();
      App.ui.toast('已写入用户长期记忆');
    },

    async continueGeneration(index) {
      if (streaming) { App.ui.toast('A response is already streaming.'); return; }
      const conv = App.chat.activeConv();
      const message = conv && conv.messages[index];
      if (!conv || !message || message.role !== 'assistant' || !['failed', 'cancelled'].includes(message.streamStatus)) return;
      const ui = App.chat.appendAssistant(message.content || '');
      streaming = true; streamConvId = conv.id; App.chat.setSending(true);
      try {
        // v1.1.6（批次 C2）：重生成时预加载上一条用户消息的附件图片
        const prevUser = conv.messages.slice(0, index).reverse().find(m => m.role === 'user');
        if (prevUser) await App.chat.preloadAttachments(prevUser);
        await App.chat.streamChat(conv, ui, { liveMessage: message });
      } finally {
        streaming = false; streamConvId = null; App.chat.setSending(false);
        App.chat.persistConversation(conv); App.ui.renderSidebar();
        if (isCurrentConversation(conv)) App.chat.renderMessages();
        App.services.float.refresh();
      }
    },

    async send() {
      const text = $('input').value.trim();
      // /memory 命令：写入用户长期记忆（不进入对话）
      if (text.startsWith('/memory')) {
        App.chat.writeMemory(text.slice(7).trim());
        $('input').value = ''; App.chat.autoSize();
        return;
      }
      const atts = pendingAttachments.slice();
      if (!text && !atts.length) return;
      // v1.1.6（批次 C1）：图片附件落盘为文件引用——state 不再内联 base64。
      // 落盘失败的回退保留 data 字段（数据不丢）。
      const persistedAtts = [];
      for (const a of atts) {
        if (a.type === 'image' && a.data) {
          const name = await saveAttachmentAsset(a.data);
          if (name) persistedAtts.push({ name, type: a.type, origName: a.name, size: a.size });
          else persistedAtts.push(Object.assign({}, a)); // 回退内联
        } else {
          persistedAtts.push(Object.assign({}, a));
        }
      }
      // 聊天修复 E：流式期间不再静默吞消息——明确提示忙碌来源，输入内容原样保留
      if (streaming) {
        // Legacy Chat contract: const busySame = streamConvId === (App.state.activeId || null);
        const legacyBusySame = streamConvId === (App.state.activeId || null);
        const busySame = isModuleOwner(currentOwner()) ? streamConvId === activeConversationId(currentOwner()) : legacyBusySame;
        App.ui.toast(busySame ? '当前对话仍在回复中，请稍候或等待完成后重试' : '另一个对话仍在回复中，请稍候');
        return;
      }
      let conv = App.chat.activeConv();
      if (!conv) {
        const owner = currentOwner();
        if (owner === 'tangguan') {
          // A module surface can be empty on first entry. Never let the
          // shared composer fall back to the regular Chat store in that case.
          conv = App.tangguan && typeof App.tangguan.ensureSession === 'function'
            ? await App.tangguan.ensureSession()
            : null;
        } else if (owner === 'create') {
          conv = App.chat.newConversation(null, { stay: 'create', originModule: 'create' });
        } else {
          conv = App.chat.newConversation();
        }
      }
      if (!conv) return;
      if (isTangguanConv(conv) && atts.length) {
        App.ui.toast('糖馆独立会话不支持图片或文件附件');
        return;
      }
      // M7：编辑上一条消息 → 截断到该条（含）、替换内容、重新生成（复用 regen 骨架）
      // M9：编辑后生成直接覆盖（问题已变，旧回答无对比价值；版本切换仅用于「重新生成」按钮）
      const editIdx = App.chat.editingIndex;
      if (editIdx != null && conv.messages[editIdx] && conv.messages[editIdx].role === 'user') {
        const um = conv.messages[editIdx];
        conv.messages.splice(editIdx + 1);
        um.content = text;
        if (persistedAtts.length) um.attachments = persistedAtts;
        App.chat.editingIndex = null;
        conv.updatedAt = Date.now();
        $('input').value = ''; App.chat.autoSize();
        App.chat.clearAttachments();
        App.chat.updateEditBanner();
        App.chat.persistConversation(conv); App.ui.renderSidebar();
        App.chat.renderMessages();
        const ui = App.chat.appendAssistant();
        App.chat.scrollBottom(true);
        streaming = true; streamConvId = conv.id; App.chat.setSending(true);
        try {
          await App.chat.streamChat(conv, ui);
        } finally {
          // 聊天修复 A：编辑重生成同样必须复位（防 streaming 卡死吞消息）
          // 聊天修复 E：只重渲染流归属会话——期间若已切到其它对话，不打扰当前视图（数据已 persist，切回时 activate() 会重绘）
          streaming = false; streamConvId = null; App.chat.setSending(false);
          App.chat.persistConversation(conv); App.ui.renderSidebar();
          if (isModuleOwner(ownerForConversation(conv))) {
            if (isCurrentConversation(conv)) App.chat.renderMessages(); else App.chat.updateCtxBar();
          } else {
            if (App.state.activeId === conv.id) App.chat.renderMessages(); else App.chat.updateCtxBar();
          }
          App.services.float.refresh();
        }
        return;
      }
      const userMsg = { role: 'user', content: text };
      if (persistedAtts.length) userMsg.attachments = persistedAtts;
      conv.messages.push(userMsg);
      if (conv.messages.filter((item) => item && item.role === 'user').length === 1
        && conv.titleMode !== 'manual'
        && (!conv.title || conv.title === '新对话' || conv.title === '新会话')) {
        conv.title = (text || (atts[0] && atts[0].name) || '新会话').replace(/\s+/g, ' ').trim().slice(0, 24) || '新会话';
        conv.titleMode = 'auto';
      }
      conv.updatedAt = Date.now();
      $('input').value = ''; App.chat.autoSize();
      try { localStorage.removeItem('tb_draft_' + conv.id); } catch (e) {}
      App.chat.clearAttachments();
      App.chat.persistConversation(conv); App.ui.renderSidebar();
      App.chat.showChat(); App.ui.renderTopbarTitle();
      $('messages').appendChild(App.chat.messageNode(userMsg, 0));
      const ui = App.chat.appendAssistant();
      App.chat.scrollBottom(true);
      // v1.1.6（批次 C2）：发送前预加载附件图片（name→data），确保 buildContent 拿到完整图片
      await App.chat.preloadAttachments(userMsg);
      streaming = true; streamConvId = conv.id; App.chat.setSending(true);
      try {
        await App.chat.streamChat(conv, ui);
      } finally {
        // 聊天修复 A：无论流式是否抛错都复位 streaming + 保存 + 重渲染（防卡死吞消息）
        // 聊天修复 E：只重渲染流归属会话（切走后不打扰当前视图）
        streaming = false; streamConvId = null; App.chat.setSending(false);
        App.chat.persistConversation(conv); App.ui.renderSidebar();
        if (isModuleOwner(ownerForConversation(conv))) {
          if (isCurrentConversation(conv)) App.chat.renderMessages(); else App.chat.updateCtxBar();
        } else {
          if (App.state.activeId === conv.id) App.chat.renderMessages(); else App.chat.updateCtxBar();
        }
        App.services.float.refresh();
      }
    },

    // M7：编辑上一条用户消息并重新生成。editingIndex = 被编辑的用户消息下标
    startEdit(index) {
      const conv = App.chat.activeConv();
      if (!conv || index == null) return;
      const m = conv.messages[index];
      if (!m || m.role !== 'user') return;
      App.chat.editingIndex = index;
      const input = $('input');
      if (input) { input.value = m.content || ''; input.focus(); App.chat.autoSize(); }
      App.chat.updateEditBanner();
    },

    cancelEdit() {
      App.chat.editingIndex = null;
      App.chat.updateEditBanner();
    },

    updateEditBanner() {
      const banner = $('editBanner');
      if (!banner) return;
      banner.style.display = (App.chat.editingIndex != null) ? 'flex' : 'none';
    },

    async regen(index) {
      const conv = App.chat.activeConv();
      if (!conv || index < 1 || conv.messages[index].role !== 'assistant') return;
      // B5（P2）：流式进行中禁止 regen 并发——避免两条流互相覆盖（与发送时的 busySame 守卫一致）
      if (streaming) { App.ui.toast('当前回复仍在生成中，请稍候再重新生成'); return; }
      // M9：旧回答归档为版本（同一问题多答案可切换对比），新回答成为最新版
      const am = conv.messages[index];
      const oldVersions = (am.versions && am.versions.length)
        ? am.versions.slice()
        : (am.content != null ? [am.content] : []);
      // remove assistant and all subsequent
      conv.messages = conv.messages.slice(0, index);
      App.chat.persistConversation(conv);
      App.chat.renderMessages();
      // re-stream
      const ui = App.chat.appendAssistant();
      streaming = true; streamConvId = conv.id; App.chat.setSending(true);
      try {
        await App.chat.streamChat(conv, ui);
      } finally {
        // 聊天修复 A：流式异常也必须复位（防 streaming 卡死）
        // 聊天修复 E：只重渲染流归属会话（切走后不打扰当前视图）
        streaming = false; streamConvId = null; App.chat.setSending(false);
        App.chat.persistConversation(conv); App.ui.renderSidebar();
        if (isModuleOwner(ownerForConversation(conv))) {
          if (isCurrentConversation(conv)) App.chat.renderMessages(); else App.chat.updateCtxBar();
        } else {
          if (App.state.activeId === conv.id) App.chat.renderMessages(); else App.chat.updateCtxBar();
        }
        App.services.float.refresh();
      }
      // M9：新回复挂 versions（旧版本 + 新内容，上限 5 版）
      const last = conv.messages[conv.messages.length - 1];
      if (last && last.role === 'assistant') {
        const v = oldVersions.concat([last.content]);
        while (v.length > 5) v.shift();
        last.versions = v;
        last.versionIdx = v.length - 1;
      }
      App.chat.persistConversation(conv); App.ui.renderSidebar(); App.chat.renderMessages();
      App.services.float.refresh();
    },

    setSending(on) {
      $('sendBtn').disabled = on || (!$('input').value.trim() && !pendingAttachments.length);
      $('input').disabled = on;
    },

    autoSize() {
      const el = $('input');
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    },

    // 语音听写：使用浏览器原生 SpeechRecognition（Chrome/Edge 支持）
    toggleVoice() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR) { App.ui.toast('当前浏览器不支持语音输入（建议用 Chrome/Edge）'); return; }
      if (listening) { if (recognition) recognition.stop(); return; }
      recognition = new SR();
      recognition.lang = 'zh-CN';
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.onstart = () => {
        listening = true;
        voiceBase = $('input').value; // B5（P2）：记录开始前已有文本作为最终基线
        const b = $('micBtn'); if (b) b.classList.add('listening');
        App.ui.toast('正在聆听…说完点一下麦克风停止');
      };
      recognition.onresult = (e) => {
        // B5（P2）：区分最终/临时结果——interim 每次触发只替换临时段，不再把全部结果反复累加
        let finalText = '', interimText = '';
        for (let i = 0; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalText += t; else interimText += t;
        }
        const base = voiceBase;
        const parts = [];
        if (base) parts.push(base);
        if (finalText) parts.push(finalText);
        if (interimText) parts.push(interimText);
        $('input').value = parts.join(' ');
        App.chat.autoSize();
        App.chat.updateSendEnabled();
        $('input').focus();
      };
      recognition.onend = () => {
        listening = false;
        voiceBase = $('input').value; // B5（P2）：结束固化基线，避免下次 interim 重复累加
        const b = $('micBtn'); if (b) b.classList.remove('listening');
      };
      recognition.onerror = (e) => {
        listening = false;
        const b = $('micBtn'); if (b) b.classList.remove('listening');
        if (e && e.error === 'no-speech') return;
        App.ui.toast('语音识别出错：' + ((e && e.error) || '未知'));
      };
      try { recognition.start(); } catch (err) {
        listening = false;
        const b = $('micBtn'); if (b) b.classList.remove('listening');
      }
    },

    onShow() {
      // 恢复当前会话的输入框草稿
      try {
        const draft = localStorage.getItem('tb_draft_' + activeConversationId(currentOwner())) || '';
        const inp = $('input');
        if (inp) { inp.value = draft; App.chat.autoSize(); App.chat.updateSendEnabled(); }
      } catch (e) {}
      flushDraft();
      App.chat.renderMessages();
      App.ui.renderTopbarTitle();
      App.ui.syncModelSelect();
      App.ui.syncThink(App.state.settings.thinkLevel || 'medium');
      App.ui.syncWeb(App.state.web);
      App.chat.syncImgBtn();
    },

    init() {
      App.chat.renderSuggestions();
      App.chat.renderQuickActions();
      App.chat.syncImgBtn();

      $('input').addEventListener('input', () => {
        const inputStarted = App.perf && App.perf.begin ? App.perf.begin() : 0;
        App.chat.autoSize();
        App.chat.updateSendEnabled();
        scheduleDraft();
        if (App.perf) App.perf.measure('inputHandlerMs', inputStarted, { valueLength: $('input').value.length });
      });
      $('input').addEventListener('blur', flushDraft);
      window.addEventListener('beforeunload', flushDraft);
      $('input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); App.chat.send(); }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); App.chat.send(); }
        else if (e.key === 'Escape' && App.chat.editingIndex != null) { App.chat.cancelEdit(); }
      });
      $('sendBtn').addEventListener('click', () => App.chat.send());
      const editCancel = $('editCancel');
      if (editCancel) editCancel.addEventListener('click', () => App.chat.cancelEdit());
      // 回到底部按钮：滚动偏离底部时显示，点击平滑回到底部
      const sbBtn = $('scrollBottomBtn'); const csEl = $('chatScroll');
      if (sbBtn && csEl) {
        const syncSb = () => { sbBtn.hidden = App.chat.isNearBottom(); };
        csEl.addEventListener('scroll', syncSb, { passive: true });
        sbBtn.addEventListener('click', () => {
          csEl.scrollTo({ top: csEl.scrollHeight, behavior: 'smooth' });
          sbBtn.hidden = true;
        });
        syncSb();
      }
      // 附件：读取文本文件为独立卡片（发送时作为上下文注入，不写入输入框）
      const attachInput = $('attachInput');
      $('attachBtn').addEventListener('click', () => { if (attachInput) attachInput.click(); });
      if (attachInput) {
        attachInput.addEventListener('change', () => {
          const files = attachInput.files ? Array.from(attachInput.files) : [];
          if (!files.length) return;
          const conv = App.chat.activeConv();
          if (isTangguanConv(conv)) {
            attachInput.value = '';
            App.ui.toast('糖馆独立会话不支持图片或文件附件');
            return;
          }
          files.forEach((file) => {
            const reader = new FileReader();
            reader.onload = () => {
              let text = String(reader.result || '');
              const MAX = 20000;
              if (text.length > MAX) text = text.slice(0, MAX) + '\n…（附件过长已截断）';
              pendingAttachments.push({ id: App.uid(), name: file.name, type: file.type || '', text, size: file.size });
              App.chat.pendingAttachments = pendingAttachments;
              App.chat.renderAttachChips();
              App.chat.updateSendEnabled();
              App.ui.toast('已附加 ' + file.name);
            };
            reader.onerror = () => App.ui.toast('读取文件失败：' + file.name);
            reader.readAsText(file);
          });
          attachInput.value = '';
        });
      }
      // 附件卡片：点击 × 移除
      const attachChips = $('attachChips');
      if (attachChips) {
        attachChips.addEventListener('click', (e) => {
          const btn = e.target.closest('[data-remove]');
          if (btn) App.chat.removeAttachment(btn.dataset.remove);
        });
      }
      // 图片：读取图片文件并压缩为 base64
      const imgInput = $('imgInput');
      const imgBtn = $('imgBtn');
      if (imgBtn && imgInput) {
        imgBtn.addEventListener('click', () => {
          if (!App.chat.isVisionModel()) { App.ui.toast('当前模型不支持图片输入'); return; }
          imgInput.click();
        });
        imgInput.addEventListener('change', () => {
          const files = imgInput.files ? Array.from(imgInput.files) : [];
          files.forEach(f => App.chat.handleImageFile(f));
          imgInput.value = '';
        });
      }
      // 粘贴图片
      $('input').addEventListener('paste', (e) => {
        if (!App.chat.isVisionModel()) return;
        const items = e.clipboardData && e.clipboardData.items ? Array.from(e.clipboardData.items) : [];
        let hasImg = false;
        items.forEach(item => {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file) { hasImg = true; App.chat.handleImageFile(file); }
          }
        });
        if (hasImg) e.preventDefault();
      });
      // 拖拽图片到聊天区（绑在 composer 上，欢迎页和对话视图都可见）
      const composer = $('composer');
      if (composer) {
        composer.addEventListener('dragover', (e) => { e.preventDefault(); composer.classList.add('drag-over'); });
        composer.addEventListener('dragleave', () => composer.classList.remove('drag-over'));
        composer.addEventListener('drop', (e) => {
          e.preventDefault();
          composer.classList.remove('drag-over');
          const files = e.dataTransfer ? Array.from(e.dataTransfer.files) : [];
          if (!files.length) return;
          files.forEach((f) => {
            if (f.type.startsWith('image/')) {
              if (App.chat.isVisionModel()) App.chat.handleImageFile(f);
              else App.ui.toast('当前模型不支持图片输入');
            } else if (f.type.startsWith('text/') || /\.(txt|md|csv|json|jsonl|log)$/i.test(f.name)) {
              App.chat.attachTextFile(f);
            } else {
              App.ui.toast('仅支持拖入图片或文本文件：' + f.name);
            }
          });
          App.chat.updateSendEnabled();
        });
      }

      // 深度思考 / 联网搜索开关在 ui.js init 中统一绑定，避免重复监听导致的双切换

      bindWelcomeActions();

      // message actions
      $('messages').addEventListener('click', (e) => {
        const thinkHead = e.target.closest('.think-head');
        if (thinkHead) { thinkHead.closest('.think-block').classList.toggle('collapsed'); return; }
        const msgEl = e.target.closest('.msg');
        const idx = msgEl ? +msgEl.dataset.index : null;
        const conv = App.chat.activeConv();

        const copy = e.target.closest('[data-action="copy"]');
        if (copy) {
          const card = copy.closest('.msg-card') || copy.closest('.msg-body');
          const text = card.querySelector('.bubble').innerText;
          navigator.clipboard.writeText(text).then(() => App.ui.toast('已复制')).catch(() => App.ui.toast('复制失败'));
          return;
        }
        const copyMd = e.target.closest('[data-action="copy-md"]');
        if (copyMd) {
          const text = (conv && idx != null && conv.messages[idx]) ? (conv.messages[idx].content || '') : '';
          navigator.clipboard.writeText(text).then(() => App.ui.toast('已复制 Markdown')).catch(() => App.ui.toast('复制失败'));
          return;
        }
        const copyUser = e.target.closest('[data-action="copy-user"]');
        if (copyUser) {
          const text = (conv && idx != null && conv.messages[idx]) ? (conv.messages[idx].content || '') : '';
          navigator.clipboard.writeText(text).then(() => App.ui.toast('已复制')).catch(() => App.ui.toast('复制失败'));
          return;
        }
        const editMsg = e.target.closest('[data-action="edit"]');
        if (editMsg) { App.chat.startEdit(idx); return; }
        // M9：答案版本切换（点击徽标循环切换，定向更新该消息 bubble，不整表重绘）
        const vs = e.target.closest('[data-version]');
        if (vs && idx != null) {
          const m = conv && conv.messages[idx];
          if (m && m.versions && m.versions.length > 1) {
            const cur = m.versionIdx != null ? m.versionIdx : m.versions.length - 1;
            m.versionIdx = (cur + 1) % m.versions.length;
            const card = vs.closest('.msg-card');
            const bubble = card && card.querySelector('.bubble');
            if (bubble) bubble.innerHTML = App.renderMarkdown(m.versions[m.versionIdx] || '');
            vs.textContent = (m.versionIdx + 1) + '/' + m.versions.length;
            App.chat.persistConversation(conv);
          }
          return;
        }
        const continuation = e.target.closest('[data-action="continue"]');
        if (continuation) { App.chat.continueGeneration(idx); return; }
        const regen = e.target.closest('[data-action="regen"]');
        if (regen) { App.chat.regen(idx); return; }
        const del = e.target.closest('[data-action="delete"]');
        if (del) { App.chat.deleteMessage(idx); return; }
      });

      // code copy —— 委托到 document，覆盖所有模块（聊天/糖码/糖读）内的代码块复制按钮
      if (!App.__codeCopyBound) {
        App.__codeCopyBound = true;
        document.addEventListener('click', (e) => {
          const btn = e.target.closest('.copy-btn');
          if (!btn) return;
          const pre = btn.closest('pre');
          const code = pre && pre.querySelector('code');
          if (!code) return;
          navigator.clipboard.writeText(code.innerText).then(() => {
            btn.textContent = '已复制';
            setTimeout(() => btn.textContent = '复制', 1500);
          }).catch(() => btn.textContent = '复制失败');
        });
      }
    },
  };
})();
