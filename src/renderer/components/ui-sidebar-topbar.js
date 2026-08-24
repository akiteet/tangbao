'use strict';
/* 自 ui.js 拆分（v1.1.8 批次 C）：侧边栏/顶栏/聊天开关（scheduleSidebarRender/renderSidebar/renderTopbarTitle/syncThink/syncWeb/syncModelSelect）。
 * 模式同 agent 批次 E：独立 IIFE + Object.assign(window.App.ui, {...})，必须在 ui.js 之后加载；
 * 闭包辅助按批次 E 先例在本文件重声明。 */
(function () {
  window.App = window.App || {};
  const $ = (id) => document.getElementById(id);
  const HISTORY_INITIAL_COUNT = 100;
  const HISTORY_PAGE_SIZE = 100;
  function conversationSearchStamp(conversation) {
    const item = conversation || {};
    const messages = Array.isArray(item.messages) ? item.messages : [];
    const last = messages[messages.length - 1] || {};
    return [
      Number(item.updatedAt) || 0,
      messages.length,
      last.id || '',
      String(last.content || '').length,
      String(last.think || '').length,
    ].join('|');
  }
  function groupLabel(ts) {
    const d = new Date(ts), now = new Date();
    const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.floor((startOfDay(now) - startOfDay(d)) / 86400000);
    if (diff === 0) return '今天';
    if (diff === 1) return '昨天';
    if (diff <= 7) return '过去7天';
    if (diff <= 30) return '过去30天';
    return '更早';
  }
  function accountModelNames(account) {
    if (!account || typeof account !== 'object') return [];
    const source = Array.isArray(account.models)
      ? account.models
      : (account.model ? [account.model] : []);
    return source.map((item) => typeof item === 'string' ? item : item && item.name)
      .filter(Boolean)
      .map((item) => String(item));
  }
  const MODEL_MODULES = new Set(['chat', 'create', 'tavern']);
  function currentModelModule() {
    const surface = App.chat && typeof App.chat.surface === 'function' ? App.chat.surface() : null;
    const surfaceOwner = surface && String(surface.owner || '').toLowerCase();
    if (MODEL_MODULES.has(surfaceOwner)) return surfaceOwner;
    const view = App.state && String(App.state.view || '').toLowerCase();
    return MODEL_MODULES.has(view) ? view : 'chat';
  }
  function moduleConversation(module) {
    const conv = App.chat && typeof App.chat.activeConv === 'function' ? App.chat.activeConv() : null;
    if (!conv) return null;
    if (module === 'create') return conv.originModule === 'create' ? conv : null;
    if (module === 'tavern') return conv.originModule === 'tavern' || !!conv.tavernCharacterId ? conv : null;
    return conv.originModule === 'create' || conv.originModule === 'tavern' || conv.tavernCharacterId ? null : conv;
  }
  Object.assign(window.App.ui, {
    scheduleSidebarRender() {
      if (App.ui._sidebarFrame) return;
      const render = () => {
        App.ui._sidebarFrame = 0;
        App.ui.renderSidebar();
      };
      if (typeof window.requestAnimationFrame === 'function') App.ui._sidebarFrame = window.requestAnimationFrame(render);
      else App.ui._sidebarFrame = setTimeout(render, 0);
    },

    renderSidebar() {
      const list = $('historyList');
      if (!list || !App.state) return;
      const q = ($('searchInput').value || '').trim().toLowerCase();
      // M7：全文搜索——q 非空时匹配标题 + 消息内容（含深度思考文本），命中对话显示命中条数徽标
      // Module sessions live in their own sidecars. The global Chat history is
      // deliberately a regular-chat-only view, regardless of the current
      // route, so a legacy snapshot can never leak Tavern/Create records
      // back into the normal sidebar.
      const moduleConversation = (item) => !!(item && (
        item.tavernCharacterId
        || item.originModule === 'tavern'
        || item.originModule === 'create'
      ));
      let convs = App.state.conversations.filter((item) => !moduleConversation(item));
      const hitsMap = {};
      if (q) {
        const sourceConvs = convs;
        convs = [];
        for (const c of sourceConvs) {
          const titleHit = (c.title || '').toLowerCase().includes(q);
          let hits = 0;
          if (!titleHit) {
            const stamp = conversationSearchStamp(c);
            const cached = App.ui._conversationSearchCache.get(c.id);
            let haystack;
            if (cached && cached.stamp === stamp) {
              haystack = cached.text;
            } else {
              const messages = (Array.isArray(c.messages) ? c.messages : [])
                .map((m) => String((m && m.content) || '') + ' ' + String((m && m.think) || ''))
                .map((value) => value.toLowerCase());
              haystack = (Array.isArray(c.messages) ? c.messages : [])
                .map((m) => String((m && m.content) || '') + ' ' + String((m && m.think) || ''))
                .join('\n')
                .toLowerCase();
              App.ui._conversationSearchCache.set(c.id, { stamp, text: haystack, messages });
              while (App.ui._conversationSearchCache.size > 256) {
                const first = App.ui._conversationSearchCache.keys().next().value;
                if (first == null) break;
                App.ui._conversationSearchCache.delete(first);
              }
            }
            if (haystack.includes(q)) {
              const cachedMessages = (App.ui._conversationSearchCache.get(c.id) || {}).messages || [];
              for (const hay of cachedMessages) if (hay.includes(q)) hits++;
            }
          }
          if (titleHit || hits) { convs.push(c); if (hits) hitsMap[c.id] = hits; }
        }
      }
      if (!convs.length) {
        list.innerHTML = `<div class="history-empty">${q ? '没有匹配的对话' : '暂无对话记录'}</div>`;
        return;
      }
      const visibleCount = App.ui._historyVisibleCount || HISTORY_INITIAL_COUNT;
      const visibleConvs = convs.slice(0, visibleCount);
      const groups = {};
      for (const c of visibleConvs) {
        const k = groupLabel(c.updatedAt);
        (groups[k] = groups[k] || []).push(c);
      }
      const order = ['今天', '昨天', '过去7天', '过去30天', '更早'];
      let html = '';
      for (const k of order) {
        if (!groups[k]) continue;
        html += `<div class="history-group"><div class="history-group-label">${k}</div>`;
        for (const c of groups[k]) {
          const active = c.id === App.state.activeId ? ' active' : '';
          const hitBadge = hitsMap[c.id] ? `<span class="history-hit">${hitsMap[c.id]} 条命中</span>` : '';
          html += `<div class="history-item${active}" data-id="${c.id}">
            <span class="history-title">${App.escapeHtml(c.title || '新对话')}</span>
            ${hitBadge}
            <button class="history-del" data-del="${c.id}" title="删除">🗑</button>
          </div>`;
        }
        html += '</div>';
      }
      if (convs.length > visibleConvs.length) {
        html += `<button type="button" class="history-more" data-history-more>加载更多对话（还剩 ${convs.length - visibleConvs.length} 条）</button>`;
      }
      list.innerHTML = html;
    },

    renderTopbarTitle() {
      const view = App.state.view || 'chat';
      const title = $('chatTitle');
      if (!title) return;
      if (view !== 'chat') {
        title.textContent = App.modules.label(view) || '糖包';
      } else {
        const conv = App.chat.activeConv();
        title.textContent = conv ? (conv.title || '新对话') : '糖包';
      }
      // 自定义模块：标题左边加刷新按钮
      const mod = App.modules.getById(view);
      // 清理旧按钮（切换模块时不留残留）
      const existingRefresh = document.querySelector('.title-refresh-btn');
      if (existingRefresh) existingRefresh.remove();
      const existingOpenext = document.querySelector('.title-openext-btn');
      if (existingOpenext) existingOpenext.remove();
      if (mod && mod.type === 'custom') {
        const btn = document.createElement('button');
        btn.className = 'title-refresh-btn';
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M17.65 6.35A7.96 7.96 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" fill="currentColor"/></svg>';
        btn.title = '刷新';
        btn.onclick = () => {
          const id = view;
          App.modules.dropCustomFrame(id);
          App.modules.renderCustom(id);
        };
        title.parentElement.insertBefore(btn, title);
        // 「在浏览器打开」按钮放在标题右侧
        const openextBtn = document.createElement('button');
        openextBtn.className = 'title-openext-btn';
        openextBtn.textContent = '↗';
        openextBtn.title = '在浏览器打开';
        openextBtn.onclick = () => {
          const r = App.ui.openModuleExternal(mod.url);
          if (r && r.then) r.then(res => { if (!res || !res.ok) App.ui.toast((res && res.error) ? ('打开失败：' + res.error) : '打开失败'); });
        };
        title.parentElement.appendChild(openextBtn); // 放在 title 后面
      }
      // ⋮ 菜单只在糖包模块显示
      const menuBtn = $('chatMenuBtn');
      const menuDrop = $('chatDropdown');
      const isChat = view === 'chat';
      if (menuBtn) menuBtn.style.display = isChat ? '' : 'none';
      if (menuDrop) menuDrop.style.display = isChat ? '' : 'none';
      App.ui.syncModelSelect();
    },

    syncThink(level) {
      if (!level) level = 'medium';
      App.state.settings.thinkLevel = level;
      const sel = $('thinkSelect'); if (sel) sel.value = level;
      App.persist();
      // 立即对当前已渲染的消息生效
      const show = level !== 'off';
      document.querySelectorAll('.msg.assistant .think-block').forEach(b => {
        const body = b.querySelector('.think-body');
        b.style.display = (show && body && body.textContent.trim()) ? 'block' : 'none';
      });
      // 诚实告知：当前模型是否支持可控思考
      const s = App.getProvider('chat');
      const model = s.model || '';
      if (model && App.thinkSupport && !App.thinkSupport(model)) {
        if (App.ui._thinkWarnModel !== model) {
          App.ui._thinkWarnModel = model;
          App.ui.toast('当前模型（' + model + '）深度思考为原生行为，调节仅控制是否展示思考过程');
        }
      } else {
        App.ui._thinkWarnModel = null;
      }
    },

    syncWeb(on, notify) {
      App.state.web = on;
      const activeConversation = App.chat && App.chat.activeConv ? App.chat.activeConv() : null;
      const restricted = !!(activeConversation && (activeConversation.tavernCharacterId || activeConversation.originModule === 'tavern'));
      const b = $('webBtn');
      if (b) {
        b.classList.toggle('active', !!on && !restricted);
        b.disabled = restricted;
        b.title = restricted ? '糖馆独立会话已关闭联网' : '联网搜索';
      }
      App.persist();
      if (notify) {
        if (!on) { App.ui.toast('已关闭联网搜索'); return; }
        const p = App.getProvider('chat');
        const supported = Object.keys(App.buildWebParam(p.model, true)).length > 0;
        App.ui.toast(supported ? '已开启联网搜索' : '已开启联网：实际是否联网取决于所选模型是否支持');
      }
    },

    syncModelSelect() {
      const btn = $('modelSelectBtn');
      const dd = $('modelDropdown');
      const module = currentModelModule();
      if (!MODEL_MODULES.has(module)) { if (btn) btn.hidden = true; if (dd) dd.hidden = true; return; }
      if (btn) btn.hidden = false;
      const p = App.getProvider(module);
      const models = (p.models && p.models.length) ? p.models : (p.model ? [p.model] : []);
      if (!models.length) { if (btn) btn.textContent = '未配置模型'; if (dd) dd.innerHTML = ''; return; }
      const conv = moduleConversation(module);
      const conversationModel = conv && conv.model && models.includes(conv.model) ? conv.model : '';
      const activeModel = conversationModel || p.model || models[0] || '';
      if (btn) btn.textContent = activeModel || '选择模型';
      if (dd) dd.innerHTML = models.map(m =>
        `<button data-model="${App.escapeHtml(m)}" class="${m === activeModel ? 'active' : ''}">${App.escapeHtml(m)}</button>`
      ).join('');
      if (App.chat && App.chat.syncImgBtn) App.chat.syncImgBtn();
    },
  });
})();
