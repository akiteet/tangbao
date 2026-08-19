'use strict';
(function () {
  window.App = window.App || {};

  const $ = (id) => document.getElementById(id);
  let editingModuleId = null; // 自定义模块编辑器状态：null=新增，有值=编辑该 id
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

  function storageLocationMessage(result, fallback) {
    const item = result || {};
    const raw = String(item.error || '');
    const code = String(item.code || '');
    const systemCode = String(item.systemCode || '');
    const target = item.path || item.target || item.targetRoot || '';
    if (code === 'location_not_writable' || ['EPERM', 'EACCES'].includes(systemCode) || /\b(EPERM|EACCES)\b/i.test(raw)) {
      return '所选目录没有写入权限' + (target ? '：' + target : '') + '。请换一个当前账户可写的目录，或授予当前 Windows 账户“修改”权限。';
    }
    if (code === 'same_location') return '新目录不能与当前数据目录相同。';
    if (code === 'nested_location') return '新目录不能位于当前数据目录内部，也不能包含当前数据目录。';
    if (code === 'active_agent_runs') return '当前还有运行中的任务，请等待任务结束后再迁移。';
    if (code === 'location_write_failed') return '无法写入数据目录指针，请检查默认数据目录权限。';
    return raw || code || fallback || '数据目录操作失败。';
  }

  async function persistAndVerify() {
    const result = App.persist();
    if (!result || result.ok === false) return result || { ok: false, code: 'state_persist_failed' };
    const pending = App.__persistencePromise;
    if (pending && typeof pending.then === 'function') {
      try {
        const response = await pending;
        if (response && response.ok === false) return response;
      } catch (error) {
        return { ok: false, code: 'state_persist_failed', error: error && error.message ? error.message : String(error) };
      }
    }
    const status = App.__persistence;
    if (status && status.status === 'failed' && Number(status.revision) === Number(result.revision)) {
      return { ok: false, code: status.code || 'state_persist_failed', error: status.error || '' };
    }
    return { ok: true, revision: result.revision };
  }

  function cloneValue(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
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

  const MODEL_MODULES = new Set(['chat', 'create', 'tangguan']);

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
    if (module === 'tangguan') return conv.originModule === 'tangguan' || !!conv.tangguanCharacterId ? conv : null;
    return conv.originModule === 'create' || conv.originModule === 'tangguan' || conv.tangguanCharacterId ? null : conv;
  }

  App.ui = {
    $,
    groupLabel,
    _conversationSearchCache: new Map(),
    _historyVisibleCount: HISTORY_INITIAL_COUNT,

    imageCapabilitiesFor(model, options) {
      const api = App.ImageCapabilities;
      if (!api || typeof api.resolve !== 'function') return null;
      const opts = options && typeof options === 'object' ? options : {};
      const provider = App.getProvider ? App.getProvider('image') : {};
      const targetModel = String(model || provider.model || '').trim();
      const profile = opts.config || provider.profile || {};
      const settings = App.state && App.state.settings ? App.state.settings : {};
      return api.resolve(opts.apiBase || provider.apiBase || '', targetModel, {
        config: profile,
        store: settings.imageCapabilities || {},
      });
    },

    learnImageCapabilities(errorText, model, options) {
      const api = App.ImageCapabilities;
      if (!api || typeof api.learnFromError !== 'function') return null;
      const provider = App.getProvider ? App.getProvider('image') : {};
      const settings = App.state && App.state.settings ? App.state.settings : {};
      const next = api.learnFromError(options && options.apiBase || provider.apiBase || '', model || provider.model || '', errorText, {
        config: options && options.config || provider.profile || {},
        store: settings.imageCapabilities || {},
      });
      if (settings) settings.imageCapabilities = typeof api.serialize === 'function' ? api.serialize() : settings.imageCapabilities;
      if (App.persist) App.persist();
      return next;
    },

    moduleProviderMarkup(module) {
      const name = String(module || 'chat');
      const settings = App.state && App.state.settings ? App.state.settings : {};
      const providers = settings.providers || {};
      const selected = providers[name] && typeof providers[name] === 'object'
        ? providers[name] : (providers.default || {});
      const accounts = Array.isArray(settings.accounts) ? settings.accounts : [];
      const configuredAccountId = String(selected.accountId || '__default__');
      const accountId = configuredAccountId === '__default__' ? '__default__' : configuredAccountId;
      const resolvedAccountId = accountId === '__default__' ? (settings.defaultAccountId || '') : accountId;
      const accountOptions = [
        `<option value="__default__"${accountId === '__default__' ? ' selected' : ''}>默认账户</option>`,
        ...accounts.map((account) => `<option value="${App.escapeHtml(account.id || '')}"${account.id === accountId ? ' selected' : ''}>${App.escapeHtml(account.name || account.id || '未命名账户')}</option>`),
      ];
      if (selected.accountId === '__custom__') accountOptions.push(`<option value="__custom__" selected>自定义接口</option>`);
      let modelNames = [];
      if (selected.accountId === '__custom__') modelNames = selected.model ? [selected.model] : [];
      else {
        const account = accounts.find((item) => item && item.id === resolvedAccountId);
        modelNames = accountModelNames(account);
      }
      let effectiveModel = '';
      let effectiveModels = [];
      try {
        const effective = App.getProvider && App.getProvider(name);
        if (effective) {
          if (effective.model) effectiveModel = effective.model;
          if (Array.isArray(effective.models)) effectiveModels = effective.models.filter(Boolean);
        }
      } catch (_) {}
      // Older snapshots may have a module provider entry but no normalized
      // account/model list yet. Use the resolved provider as a display-only
      // fallback so Tangguan can still select the model immediately after boot.
      if (!modelNames.length && effectiveModels.length) modelNames = effectiveModels;
      const activeModel = selected.model && modelNames.includes(selected.model)
        ? selected.model
        : (effectiveModel && modelNames.includes(effectiveModel) ? effectiveModel : (modelNames[0] || selected.model || ''));
      const modelOptions = modelNames.length
        ? modelNames.map((model) => `<option value="${App.escapeHtml(model)}"${model === activeModel ? ' selected' : ''}>${App.escapeHtml(model)}</option>`).join('')
        : '<option value="">未配置模型</option>';
      return `<div class="module-provider-controls" data-module-provider="${App.escapeHtml(name)}"><select class="module-provider-account" data-module-provider-account title="选择账户">${accountOptions.join('')}</select><select class="module-provider-model" data-module-provider-model title="选择模型">${modelOptions}</select></div>`;
    },

    bindModuleProvider(root, module, onChange) {
      const host = root || document;
      const name = String(module || 'chat');
      const provider = () => {
        App.state.settings.providers = App.state.settings.providers || {};
        return App.state.settings.providers[name] || (App.state.settings.providers[name] = { accountId: '__default__', apiBase: '', model: '' });
      };
      host.querySelectorAll(`[data-module-provider="${name}"]`).forEach((wrap) => {
        const account = wrap.querySelector('[data-module-provider-account]');
        const model = wrap.querySelector('[data-module-provider-model]');
        if (account) account.addEventListener('change', () => {
          const next = provider();
          next.accountId = account.value || '__default__';
          if (next.accountId !== '__custom__') next.apiBase = '';
          const resolvedAccountId = next.accountId === '__default__'
            ? (App.state.settings.defaultAccountId || '')
            : next.accountId;
          const selected = App.state.settings.accounts && App.state.settings.accounts.find((item) => item.id === resolvedAccountId);
          const names = accountModelNames(selected);
          next.model = next.accountId === '__custom__' ? next.model : (names[0] || '');
          App.persist();
          if (typeof onChange === 'function') onChange();
        });
        if (model) model.addEventListener('change', () => {
          provider().model = model.value || '';
          App.persist();
          if (typeof onChange === 'function') onChange();
        });
      });
    },

    modelModule() {
      return currentModelModule();
    },

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
      // route, so a legacy snapshot can never leak Tangguan/Create records
      // back into the normal sidebar.
      const moduleConversation = (item) => !!(item && (
        item.tangguanCharacterId
        || item.originModule === 'tangguan'
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
      const restricted = !!(activeConversation && (activeConversation.tangguanCharacterId || activeConversation.originModule === 'tangguan'));
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

    applyAppearance() {
      const ap = App.state.settings.appearance || {};
      const mode = ap.mode || 'system';
      let effective = mode;
      if (mode === 'system') {
        effective = (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
      }
      document.documentElement.setAttribute('data-theme', effective);
      App.state.theme = effective;
      // 代码高亮主题随明暗切换（启用/禁用对应的 highlight.js 主题样式表）
      try {
        const dark = effective === 'dark';
        const lt = document.getElementById('hljsLight');
        const dk = document.getElementById('hljsDark');
        if (lt) lt.disabled = dark;
        if (dk) dk.disabled = !dark;
      } catch (_) {}
      const root = document.documentElement;
      if (ap.accent) {
        root.style.setProperty('--primary', ap.accent);
        root.style.setProperty('--primary-hover', App.ui.shade(ap.accent, -0.12));
        root.style.setProperty('--primary-soft', App.ui.soft(ap.accent));
      } else {
        root.style.setProperty('--primary', '');
        root.style.setProperty('--primary-hover', '');
        root.style.setProperty('--primary-soft', '');
      }
      if (ap.radius) {
        const r = parseInt(ap.radius, 10);
        root.style.setProperty('--radius', r + 'px');
        root.style.setProperty('--radius-xs', Math.max(4, r - 8) + 'px');  // v1.1.5：微元件同步联动
        root.style.setProperty('--radius-md', Math.max(6, r - 6) + 'px');  // v1.1.5：输入框/小按钮同步联动
        root.style.setProperty('--radius-sm', Math.max(6, r - 4) + 'px');
        root.style.setProperty('--radius-lg', (r + 4) + 'px');      // M12：大卡片/气泡圆角随滑杆
        root.style.setProperty('--radius-pill', '999px');           // M12：胶囊圆角恒定
      } else {
        root.style.setProperty('--radius', '');
        root.style.setProperty('--radius-xs', '');
        root.style.setProperty('--radius-md', '');
        root.style.setProperty('--radius-sm', '');
        root.style.setProperty('--radius-lg', '');
        root.style.setProperty('--radius-pill', '');
      }
      // 同步系统标题栏叠加层颜色（隐藏标题栏时，右上角最小/最大/关闭按钮的底色）
      try {
        if (App.services.shell && App.services.shell.setTitleBarOverlay) {
          const dark = effective === 'dark';
          App.services.shell.setTitleBarOverlay({
            color: dark ? 'rgba(20,22,28,0.92)' : 'rgba(244,247,251,0.92)',
            symbolColor: dark ? '#e6e8ee' : '#5b6472',
          });
        }
      } catch (_) {}
    },

    // 由强调色派生更深的 hover 色 / 浅色 soft 背景
    shade(hex, amt) {
      const h = (hex || '').replace('#', '');
      if (h.length !== 6) return hex || '';
      const n = parseInt(h, 16);
      const ch = (x) => Math.max(0, Math.min(255, Math.round(x + 255 * amt)));
      const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
      return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    },
    soft(hex) {
      const h = (hex || '').replace('#', '');
      if (h.length !== 6) return '';
      const n = parseInt(h, 16);
      return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',0.12)';
    },

    applyTheme() { App.ui.applyAppearance(); },

    markThemeSeg() {
      const ap = App.state.settings.appearance || {};
      document.querySelectorAll('#themeSeg [data-mode]').forEach(b => {
        b.classList.toggle('active', b.dataset.mode === (ap.mode || 'system'));
      });
    },

    toggleTheme() {
      const ap = App.state.settings.appearance || (App.state.settings.appearance = {});
      ap.mode = (ap.mode === 'dark') ? 'light' : 'dark';
      App.ui.applyAppearance();
      App.persist();
    },

    toast(msg) {
      const t = $('toast');
      // B7（P3）：连续 toast 时先清旧 timer——避免旧 timer 在新 toast 显示期间移除 show class（提前隐藏/错乱）
      if (App.ui._toastTimer) { clearTimeout(App.ui._toastTimer); App.ui._toastTimer = null; }
      t.textContent = msg;
      t.hidden = false;
      t.classList.add('show');
      App.ui._toastTimer = setTimeout(() => { t.classList.remove('show'); t.hidden = true; App.ui._toastTimer = null; }, 2400);
    },

    notify(title, detail) {
      App.ui._notifications = Array.isArray(App.ui._notifications) ? App.ui._notifications : [];
      App.ui._notifications.unshift({ title: String(title || '通知'), detail: String(detail || ''), at: Date.now() });
      App.ui._notifications = App.ui._notifications.slice(0, 40);
      App.ui.renderNotifications();
    },

    renderNotifications() {
      const list = $('notificationList');
      const dot = $('notificationDot');
      if (!list) return;
      const items = Array.isArray(App.ui._notifications) ? App.ui._notifications : [];
      if (dot) dot.hidden = !items.length;
      list.innerHTML = items.length ? items.map((item) => `<div class="notification-item"><b>${App.escapeHtml(item.title)}</b><span>${App.escapeHtml(item.detail)}</span><time>${new Date(item.at).toLocaleTimeString()}</time></div>`).join('') : '<div class="notification-empty">暂无通知</div>';
    },

    selectSettingsPanel(panel) {
      const target = String(panel || 'api');
      document.querySelectorAll('.set-nav-item').forEach((item) => item.classList.toggle('active', item.dataset.panel === target));
      document.querySelectorAll('.settings-panel').forEach((item) => item.classList.toggle('active', item.dataset.panel === target));
      const modal = $('settingsModal');
      if (modal) modal.dataset.activePanel = target;
      if (target === 'data') App.ui.refreshStorageLocation();
    },

    openCommandPalette() {
      const mask = $('commandPalette');
      const input = $('commandPaletteInput');
      if (!mask || !input) return;
      mask.hidden = false;
      input.value = '';
      App.ui.renderCommandPalette('');
      setTimeout(() => input.focus(), 0);
    },

    closeCommandPalette() {
      const mask = $('commandPalette');
      if (mask) mask.hidden = true;
    },

    async renderCommandPalette(query) {
      const box = $('commandPaletteResults');
      if (!box) return;
      const q = String(query || '').trim().toLowerCase();
      const commands = [
        { id: 'chat', title: '打开聊天', detail: '切换到糖包聊天' },
        { id: 'agent', title: '打开糖码', detail: '切换到 Agent 工作区' },
        { id: 'doc', title: '打开糖读', detail: '切换到文档模块' },
        { id: 'image', title: '打开图片', detail: '切换到图片模块' },
        { id: 'workflow', title: '打开 Workflow', detail: '切换到工作流模块' },
        { id: 'settings', title: '打开设置', detail: '账户、提示词和外观' },
        { id: 'data', title: '打开存储审计', detail: '迁移、备份、恢复和诊断' },
        { id: 'cache', title: '触发真实 Cache Probe', detail: '会发送两次 Provider 请求' },
      ].filter((item) => !q || (item.title + ' ' + item.detail).toLowerCase().includes(q));
      const local = [];
      const addLocal = (scope, id, title, detail) => {
        if (!title || (q && !(title + ' ' + detail).toLowerCase().includes(q))) return;
        local.push({ id: 'local:' + scope + ':' + id, title, detail });
      };
      const regularConversations = (App.state.conversations || []).filter((item) => !(item && (
        item.tangguanCharacterId
        || item.originModule === 'tangguan'
        || item.originModule === 'create'
      )));
      for (const item of regularConversations) addLocal('conversation', item.id, item.title || '未命名会话', '会话');
      for (const item of App.state.settings.docs || []) addLocal('document', item.id, item.name, '文档');
      for (const item of App.state.projects || []) addLocal('project', item.id, item.name, '糖码项目');
      for (const item of App.state.agentThreads || []) addLocal('run', item.id, item.title, '糖码会话');
      const items = commands.concat(local).slice(0, 30);
      box.innerHTML = items.length ? items.map((item, index) => `<button class="command-item${index === 0 ? ' active' : ''}" data-command="${App.escapeHtml(item.id)}"><span>${App.escapeHtml(item.title)}</span><small>${App.escapeHtml(item.detail || '')}</small></button>`).join('') : '<div class="command-empty">没有匹配项</div>';
      App.ui._commandItems = items;
    },

    runCommand(id) {
      const value = String(id || '');
      App.ui.closeCommandPalette();
      if (value.startsWith('local:conversation:')) {
        const id = value.slice('local:conversation:'.length);
        const conv = (App.state.conversations || []).find((item) => item && item.id === id);
        const stay = conv && (conv.tangguanCharacterId || conv.originModule === 'tangguan')
          ? 'tangguan' : conv && conv.originModule === 'create' ? 'create' : undefined;
        App.chat.activate(id, stay ? { stay } : undefined);
        return;
      }
      if (value === 'settings' || value === 'data') {
        App.ui.openSettings();
        if (value !== 'settings') App.ui.selectSettingsPanel(value);
        return;
      }
      if (value === 'cache') {
        App.ui.openCacheProbe();
        return;
      }
      if (['chat', 'agent', 'doc', 'image', 'workflow'].includes(value)) {
        App.router.go(value === 'workflow' ? 'create' : value);
        return;
      }
    },

    // Cache Probe 直接使用紧凑弹窗，不增加设置子页面，也不保存探测正文。
    openCacheProbe() {
      const provider = App.getProvider('chat') || {};
      const modal = document.createElement('div');
      modal.className = 'modal-mask';
      modal.id = 'cacheProbeMask';
      const ready = !!(provider.ref && provider.model && provider.hasKey);
      const reason = !provider.ref ? '尚未选择账户' : !provider.model ? '尚未选择模型' : !provider.hasKey ? '当前账户未配置 API Key' : '';
      modal.innerHTML = `
        <div class="modal cache-probe-modal" role="dialog" aria-modal="true" aria-labelledby="cacheProbeTitle">
          <div class="modal-header"><span id="cacheProbeTitle">真实 Cache Probe</span>
            <button class="icon-btn" type="button" data-cache-close aria-label="关闭">
              <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
            </button>
          </div>
          <div class="modal-body">
            <p class="cache-probe-notice">将向当前聊天 Provider 发送两次最小化请求，可能消耗额度。不保存探测 Prompt、响应正文或 API Key。</p>
            <div class="cache-probe-context"><span>账户</span><b>${App.escapeHtml(provider.ref || '未配置')}</b><span>模型</span><b>${App.escapeHtml(provider.model || '未配置')}</b></div>
            <div class="cache-probe-status" data-cache-status>${ready ? '准备就绪' : '无法探测：' + App.escapeHtml(reason)}</div>
            <div class="cache-probe-result" data-cache-result></div>
          </div>
          <div class="modal-footer">
            <button class="btn-ghost" type="button" data-cache-close>关闭</button>
            <button class="btn-primary" type="button" data-cache-run${ready ? '' : ' disabled'}>开始探测</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      const status = modal.querySelector('[data-cache-status]');
      const result = modal.querySelector('[data-cache-result]');
      const run = modal.querySelector('[data-cache-run]');
      const close = () => modal.remove();
      modal.querySelectorAll('[data-cache-close]').forEach((button) => button.addEventListener('click', close));
      modal.addEventListener('click', (event) => { if (event.target === modal) close(); });
      modal.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
      const fmtTokens = (value) => value == null ? '未知' : String(Math.round(Number(value)));
      const fmtRate = (value) => value == null ? '未知' : Math.round(Number(value) * 1000) / 10 + '%';
      const renderSample = (label, sample) => {
        const cache = sample || {};
        return `<div class="cache-probe-sample"><b>${label}</b><span>命中率 ${fmtRate(cache.hitRate)}</span><span>命中 Token ${fmtTokens(cache.cacheReadTokens)}</span><span>写入 Token ${fmtTokens(cache.cacheWriteTokens)}</span><span>来源 ${App.escapeHtml(cache.dataOrigin || cache.source || 'unknown')}</span>${cache.unknownReason ? `<small>${App.escapeHtml(cache.unknownReason)}</small>` : ''}</div>`;
      };
      if (run) run.addEventListener('click', async () => {
        run.disabled = true;
        run.textContent = '探测中...';
        status.textContent = '正在执行冷请求和热请求...';
        result.innerHTML = '';
        try {
          const response = await (App.services.gateway && App.services.gateway.probeCache
            ? App.services.gateway.probeCache({ ref: provider.ref, model: provider.model, kind: 'chat' })
            : null);
          if (!response || response.ok === false) throw new Error(response && (response.error || response.message) || 'Cache Probe 不可用');
          const cache = response.cache || {};
          result.innerHTML = renderSample('冷请求', response.cold) + renderSample('热请求', response.warm)
            + `<div class="cache-probe-summary">最终命中率 <b>${fmtRate(cache.hitRate)}</b> · 节省 Token <b>${fmtTokens(cache.savedTokens)}</b> · 数据来源 <b>${App.escapeHtml(cache.dataOrigin || cache.source || 'unknown')}</b>${cache.unknownReason ? ` · ${App.escapeHtml(cache.unknownReason)}` : ''}</div>`;
          status.textContent = '探测完成';
          App.ui.toast('Cache Probe 已完成');
        } catch (error) {
          status.textContent = '探测失败：' + String(error && error.message ? error.message : error);
          App.ui.toast('Cache Probe 失败');
        } finally {
          run.disabled = false;
          run.textContent = '再次探测';
        }
      });
      setTimeout(() => { (run && !run.disabled ? run : modal.querySelector('[data-cache-close]')).focus(); }, 0);
    },

    // 自定义输入弹窗（替代原生 prompt，兼容打包版沙箱）。返回 Promise<字符串|null>：确认返回 trim 后的值，取消/Esc/点遮罩返回 null。
    promptModal(opts) {
      const o = Object.assign(
        { title: '输入', label: '', value: '', placeholder: '', confirmText: '确定', maxLength: 0, multiline: false },
        opts || {}
      );
      return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'modal-mask';
        const inputId = 'pmInput';
        const inputHtml = o.multiline
          ? `<textarea id="${inputId}" rows="4" placeholder="${App.escapeHtml(o.placeholder)}"></textarea>`
          : `<input type="text" id="${inputId}" value="${App.escapeHtml(o.value)}" placeholder="${App.escapeHtml(o.placeholder)}" autocomplete="off" />`;
        modal.innerHTML = `
          <div class="modal" role="dialog" aria-modal="true" style="width:420px">
            <div class="modal-header"><span>${App.escapeHtml(o.title)}</span>
              <button class="icon-btn" id="pmClose" aria-label="关闭">
                <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </button>
            </div>
            <div class="modal-body">
              <label class="field"><span class="field-label">${App.escapeHtml(o.label)}</span>${inputHtml}</label>
            </div>
            <div class="modal-footer">
              <button class="btn-ghost" id="pmCancel">取消</button>
              <button class="btn-primary" id="pmConfirm">${App.escapeHtml(o.confirmText)}</button>
            </div>
          </div>`;
        document.body.appendChild(modal);
        const input = modal.querySelector('#' + inputId);
        if (o.maxLength > 0) input.maxLength = o.maxLength;
        // 自动聚焦并全选
        setTimeout(() => { input.focus(); if (!o.multiline) input.select(); }, 0);

        let settled = false;
        const finish = (val) => {
          if (settled) return;
          settled = true;
          resolve(val);
          modal.remove();
        };
        // 拦截外部移除（如全局 Esc 兜底 m.remove()），保证 Promise 必定落定
        const origRemove = modal.remove.bind(modal);
        modal.remove = () => { if (!settled) finish(null); else origRemove(); };
        // 点遮罩空白处取消
        modal.addEventListener('click', (e) => { if (e.target === modal) finish(null); });
        modal.querySelector('#pmClose').onclick = () => finish(null);
        modal.querySelector('#pmCancel').onclick = () => finish(null);
        modal.querySelector('#pmConfirm').onclick = () => finish(input.value.trim());
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !o.multiline) { e.preventDefault(); finish(input.value.trim()); }
          else if (e.key === 'Escape') { e.preventDefault(); finish(null); }
        });
      });
    },

    // 模块「在浏览器打开」：本地文件（file://）走 openPath 由系统关联程序打开；远程（http/https）走 openExternal。
    // 返回 Promise（或 null），调用方可 .then 处理失败提示。
    openModuleExternal(url) {
      if (!url || !window.electron) return null;
      let u;
      try { u = new URL(url); } catch (_) { u = null; }
      if (u && u.protocol === 'file:') {
        let p = decodeURIComponent(u.pathname || '');
        p = p.replace(/^\/([A-Za-z]:)/, '$1'); // /C:/x -> C:/x
        return App.services.shell.openPath(p);
      }
      return App.services.shell.openExternal(url);
    },

    _convToMarkdown(conv) {
      let md = `# ${conv.title || '新对话'}\n\n`;
      for (const m of conv.messages) {
        md += m.role === 'user' ? `**User:**\n${m.content}\n\n` : `**Assistant:**\n${m.content}\n\n`;
      }
      return md;
    },

    exportMarkdown() {
      const conv = App.chat.activeConv();
      if (!conv || !conv.messages.length) { App.ui.toast('当前没有可复制的对话'); return; }
      const md = App.ui._convToMarkdown(conv);
      navigator.clipboard.writeText(md).then(() => App.ui.toast('已复制对话内容到剪贴板')).catch(() => App.ui.toast('复制失败'));
    },

    downloadMarkdown() {
      const conv = App.chat.activeConv();
      if (!conv || !conv.messages.length) { App.ui.toast('当前没有可导出的对话'); return; }
      const md = App.ui._convToMarkdown(conv);
      const safe = (conv.title || '新对话').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
      const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${safe}.md`;
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      App.ui.toast('已导出 Markdown 文件');
    },

    openSettings() {
      // v2（UX）：每次打开设置默认回归「配置」面板（不记忆上次停留的标签页）
      const settingsModal = $('settingsModal');
      if (settingsModal) settingsModal.dataset.activePanel = 'api';
      App.ui.selectSettingsPanel('api');
      App.ui.refreshSettingsUI();
      settingsModal.hidden = false;
    },

    closeSettings() { $('settingsModal').hidden = true; },

    // v2（统一热刷新）：订阅主进程 skills:changed 广播——导入/卸载/移动/恢复/启停/信任/自动触发后
    // 立即刷新设置技能面板与糖码 / 菜单缓存，无需重启；由 app.js boot 一次性绑定。
    bindSkillChanged() {
      if (App.ui._skillsChangedBound) return;
      App.ui._skillsChangedBound = true;
      if (window.electron && window.electron.onSkillsChanged) {
        window.electron.onSkillsChanged(() => {
          try { App.ui.renderSkillsPanel(); } catch (_) {}
          try { if (App.agent && App.agent.refreshSkillCache) App.agent.refreshSkillCache(); } catch (_) {}
        });
      }
    },

    async refreshStorageLocation() {
      const mode = $('storageLocationMode');
      const target = $('storageLocationPath');
      if (!mode || !target) return;
      const service = App.services.fs;
      const info = service && service.getStorageInfo ? await service.getStorageInfo() : { ok: false };
      if (!info || !info.ok) {
        mode.textContent = '当前环境无法读取数据目录';
        target.textContent = '';
        const audit = $('storageAuditParts');
        if (audit) audit.innerHTML = '<div class="storage-audit-empty">存储审计暂不可用</div>';
        return;
      }
      mode.textContent = info.mode === 'custom' ? '当前使用自定义数据目录（不占用默认 C 盘记录目录）' : '当前使用系统默认数据目录';
      target.textContent = info.recordsRoot || info.activeRoot || '';
      const migrationStatus = $('storageMigrationStatus');
      if (migrationStatus) {
        const migration = info.migration || {};
        const failed = !!info.startupMigration || migration.status === 'failed';
        migrationStatus.hidden = !failed;
        migrationStatus.textContent = failed
          ? '迁移失败，需要验证或恢复；当前仍使用旧数据，未自动删除原目录。'
          : (migration.status ? '迁移状态：' + migration.status : '');
      }
      const open = $('openStorageLocation');
      if (open) open.disabled = !info.activeRoot;
      App.ui.renderStorageAudit(info);
    },

    formatBytes(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value < 0) return '未知';
      if (value < 1024) return value + ' B';
      const units = ['KB', 'MB', 'GB', 'TB'];
      let n = value;
      let unit = 'B';
      for (const next of units) { n /= 1024; unit = next; if (n < 1024) break; }
      return n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2) + ' ' + unit;
    },

    renderStorageAudit(info) {
      const box = $('storageAuditParts');
      const status = $('storageMigrationStatus');
      if (!box) return;
      const parts = Array.isArray(info.parts) ? info.parts : [];
      box.innerHTML = parts.map((part) => `
        <div class="storage-audit-item">
          <b>${App.escapeHtml(part.label || part.key || '存储')}</b>
          <span>${App.ui.formatBytes(part.bytes)} · ${Number(part.files) || 0} 个文件</span>
          <code>${App.escapeHtml(part.location || '')}</code>
        </div>`).join('') || '<div class="storage-audit-empty">暂无存储分区记录</div>';
      if (status) {
        const migration = info.migration || {};
        const startup = info.startupMigration;
        const consistency = info.audit && info.audit.stateConsistency;
        const warnings = [];
        if (info.database && info.database.available === false) warnings.push('SQLite 当前不可用，已明确使用 state.json 保存；原因：' + (info.database.reason || 'unknown'));
        if (startup) warnings.push('上次迁移失败：' + (startup.error || startup.code || '未知错误') + '；当前仍使用旧数据');
        if (migration.status === 'failed') warnings.push('迁移记录为失败，可先验证源目录和目标目录后再处理');
        if (consistency && consistency.status === 'inconsistent') warnings.push('state.json 与 SQLite 计数不一致，请先导出备份并检查');
        if (consistency && consistency.status === 'unknown') warnings.push('state.json 与 SQLite 一致性：无法确认（' + (consistency.reason || '未知原因') + '）');
        const trace = info.audit && info.audit.trace;
        if (trace && (trace.orphanEvents || []).length + (trace.invalidEvents || []).length) warnings.push('Trace 审计发现 ' + ((trace.orphanEvents || []).length + (trace.invalidEvents || []).length) + ' 个异常事件');
        status.classList.toggle('warn', warnings.length > 0);
        status.textContent = warnings.length
          ? warnings.join('；')
          : '迁移状态：' + (migration.status || (info.mode === 'custom' ? 'active' : 'default')) + '；SQLite：' + (info.database && info.database.integrity ? '完整性通过' : '未确认') + '；state/SQLite：' + (consistency && consistency.status || '未知');
      }
    },

    async verifyStorageMigration() {
      const button = $('verifyStorageMigration');
      if (!button || !App.services.fs || !App.services.fs.verifyStorageMigration) return;
      button.disabled = true;
      const original = button.textContent;
      button.textContent = '验证中...';
      try {
        const result = await App.services.fs.verifyStorageMigration();
        if (result && result.ok) App.ui.toast('迁移验证通过：' + (result.files || []).length + ' 个文件');
        else App.ui.toast('迁移验证失败：' + ((result && (result.error || result.code)) || '请查看存储状态'));
        await App.ui.refreshStorageLocation();
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    },

    async previewStorageCleanup() {
      const box = $('storageCleanupPreview');
      const cleanButton = $('cleanupStorageLegacy');
      if (!box || !App.services.fs || !App.services.fs.cleanupPreview) return;
      const result = await App.services.fs.cleanupPreview();
      if (!result || !result.ok) {
        box.hidden = false;
        box.textContent = '清理预览失败：' + ((result && result.error) || '未知错误');
        if (cleanButton) cleanButton.hidden = true;
        return;
      }
      App.ui._cleanupPreviewId = result.previewId || '';
      const items = Array.isArray(result.items) ? result.items : [];
      box.hidden = false;
      box.innerHTML = items.length
        ? '<strong>将移动到时间戳隔离目录，不会永久删除：</strong>' + items.map((item) => `<div>${App.escapeHtml(item.name)} · ${App.ui.formatBytes(item.bytes)}<code>${App.escapeHtml(item.location || '')}</code></div>`).join('')
        : '<strong>没有可清理的旧目录内容。</strong>';
      if (cleanButton) cleanButton.hidden = !items.length;
    },

    async cleanupStorageLegacy() {
      const previewId = App.ui._cleanupPreviewId || '';
      if (!previewId || !window.confirm('确认把预览中的旧目录内容移动到隔离目录？不会永久删除。')) return;
      const result = await App.services.fs.cleanupLegacy({ previewId });
      if (result && result.ok) App.ui.toast('已隔离 ' + (result.cleaned || []).length + ' 项；位置：' + result.quarantine);
      else App.ui.toast('隔离失败：' + ((result && result.error) || '未知错误'));
      App.ui._cleanupPreviewId = '';
      const cleanButton = $('cleanupStorageLegacy');
      if (cleanButton) cleanButton.hidden = true;
      await App.ui.refreshStorageLocation();
    },

    async backupStorage() {
      const result = await (App.services.fs && App.services.fs.backupStorage ? App.services.fs.backupStorage({}) : null);
      if (result && result.ok) App.ui.toast('脱敏备份已导出：' + result.filePath);
      else if (!(result && result.canceled)) App.ui.toast('备份失败：' + ((result && result.error) || '未知错误'));
    },

    async restoreStorage() {
      if (!window.confirm('恢复会覆盖当前 state.json，并保留恢复前备份。确认继续吗？')) return;
      const result = await (App.services.fs && App.services.fs.restoreStorage ? App.services.fs.restoreStorage({}) : null);
      if (!result || !result.ok) {
        if (!(result && result.canceled)) App.ui.toast('恢复失败：' + ((result && result.error) || '未知错误'));
        return;
      }
      App.ui.toast('恢复完成，应用即将重启以加载数据');
      if (App.services.fs.relaunchApp) await App.services.fs.relaunchApp();
    },

    async exportStorageDiagnostics() {
      const result = await (App.services.fs && App.services.fs.exportDiagnostics ? App.services.fs.exportDiagnostics() : null);
      if (result && result.ok) App.ui.toast('脱敏诊断包已导出：' + result.filePath);
      else if (!(result && result.canceled)) App.ui.toast('诊断包导出失败：' + ((result && result.error) || '未知错误'));
    },

    refreshSecretStoreStatus() {
      const el = $('secretStoreStatus');
      if (!el) return;
      const rt = App.rt || {};
      const state = String(rt.secretStoreState || 'uninitialized');
      const count = Number(rt.secretStoreCount || 0);
      const canCreateFresh = state === 'unavailable' && rt.secretStoreCanCreateFresh === true;
      const resetButton = $('resetSecretStore');
      const recoveryHint = $('secretStoreRecoveryHint');
      if (resetButton) resetButton.hidden = !canCreateFresh;
      if (recoveryHint) {
        recoveryHint.hidden = state !== 'unavailable';
        recoveryHint.textContent = canCreateFresh
          ? '建立新密钥库不会恢复旧 Key；原密文会先完整备份，之后请在“账户”中重新填写 API Key。'
          : '系统密钥服务当前不可用，暂时不能建立加密密钥库；请完全退出糖包后，用当前 Windows 账户重新启动。';
      }
      el.classList.toggle('warn', state === 'unavailable' || rt.secretsEncrypted === false);
      if (state === 'unavailable') {
        if (rt.secretStoreCode === 'secret_decrypt_failed') {
          el.textContent = '密钥库无法解密已有密钥。请使用原 Windows 账户运行，或重新填写 Key；原密钥文件未被覆盖。';
        } else {
          el.textContent = '密钥库暂时不可用，无法确认已有 Key；原密钥文件未被覆盖。请检查系统安全存储或重启应用。';
        }
        return;
      }
      if (state === 'empty') {
        el.textContent = '密钥库已就绪，当前没有已保存的 Key。密钥保存在本机系统安全存储中。';
        return;
      }
      if (state === 'ready' && rt.secretsEncrypted === false) {
        el.textContent = '密钥库已加载 ' + count + ' 个引用，但当前系统无法加密存储；请检查系统密钥服务。';
        return;
      }
      if (state === 'ready') {
        el.textContent = '密钥库已加载 ' + count + ' 个引用，密钥保存在本机系统安全存储中。';
        return;
      }
      el.textContent = '正在读取本机系统密钥库...';
    },

    async diagnoseSecretStore() {
      const box = $('secretDiagnostics');
      if (!box || !App.services.secrets || !App.services.secrets.diagnose) return;
      box.hidden = false;
      box.textContent = '正在诊断...';
      const result = await App.services.secrets.diagnose();
      box.textContent = JSON.stringify(result || { ok: false }, null, 2);
    },

    async recoverLegacySecrets() {
      if (!window.confirm('将尝试使用旧数据目录中的密钥上下文恢复当前密钥库，并在覆盖前备份 Local State。继续吗？')) return;
      const result = await (App.services.secrets && App.services.secrets.recoverLegacy ? App.services.secrets.recoverLegacy() : null);
      if (result && result.ok) {
        if (App.rt && App.rt.refreshSecrets) await App.rt.refreshSecrets();
        App.ui.refreshSecretStoreStatus();
        App.ui.toast(result.recovered ? '旧密钥上下文恢复成功' : '未发现可恢复的旧密钥上下文');
      } else {
        App.ui.toast('密钥恢复失败：' + ((result && result.error) || '原密钥未覆盖'));
      }
      await App.ui.diagnoseSecretStore();
    },

    modelProviderFor(moduleId) {
      try {
        const module = String(moduleId || 'chat');
        const provider = App.getProvider(module) || { ref: '', model: '', apiBase: '' };
        if (!provider.accountId && String(provider.ref || '').startsWith('acc:')) provider.accountId = String(provider.ref).slice(4);
        return provider;
      } catch (_) { return { ref: '', model: '', apiBase: '' }; }
    },

    renderModelProfiles() {
      const box = $('modelProfileList');
      if (!box) return;
      const modules = [
        ['chat', '聊天'], ['agent', '糖码'], ['doc', '糖读'], ['image', '图片'], ['create', '糖创'], ['tangguan', '糖馆'],
      ];
      box.innerHTML = modules.map(([id, label]) => {
        const provider = App.ui.modelProviderFor(id);
        const account = (App.state.settings.accounts || []).find((item) => item.id === provider.accountId);
        const profile = provider.profile || {};
        const caps = profile.caps || 'auto';
        const profileText = [
          (Number(profile.contextWindow) || 128000).toLocaleString() + ' ctx',
          profile.maxOutput ? Number(profile.maxOutput).toLocaleString() + ' out' : '输出默认',
          caps === 'auto' ? '能力自动' : caps,
          (Number(profile.timeoutMs) || 120000) + ' ms 超时',
          '≤' + (Number(profile.budgetMaxSteps) || 96) + ' 步',
        ].join(' · ');
        const edit = account ? `<button type="button" class="mini" data-model-profile-edit="${App.escapeHtml(account.id)}">编辑</button>` : '';
        return `<div class="model-profile-row"><b>${label}</b><span>${App.escapeHtml((account && account.name) || provider.ref || '未配置账户')}</span><code>${App.escapeHtml(provider.model || '未配置模型')}</code><em>${App.escapeHtml(profileText)}${provider.apiBase ? ' · 已配置地址' : ' · 未配置地址'}</em>${edit}</div>`;
      }).join('');
    },

    async runModelHealth() {
      const module = ($('modelHealthModule') && $('modelHealthModule').value) || 'chat';
      const resultBox = $('modelHealthResult');
      const provider = App.ui.modelProviderFor(module);
      if (!resultBox) return;
      if (!provider.ref || !provider.model) {
        resultBox.textContent = '请先在配置/账户中选择账户和模型。';
        return;
      }
      resultBox.textContent = '检查中...';
      const result = await App.services.gateway.modelHealth({ ref: provider.ref, model: provider.model, kind: module === 'image' ? 'images' : 'chat' });
      if (!result || result.ok === false) {
        const error = result && result.error;
        resultBox.textContent = '检查失败：' + ((error && (error.message || error.code)) || result.error || '未知错误');
        App.ui.notify('Provider 健康检查失败', module + ' / ' + provider.model);
        return;
      }
      const caps = Object.entries(result.capabilities || {}).filter(([, value]) => value !== undefined).map(([key, value]) => key + '=' + (typeof value === 'object' ? JSON.stringify(value) : value)).join(' · ');
      const cache = result.cacheSupport || (result.capabilities && result.capabilities.cache);
      const cacheText = cache && cache.supported === true ? 'Cache 可探测' : cache && cache.supported === false ? 'Cache 不支持/未知' : 'Cache 未知';
      resultBox.textContent = '连通：' + (result.apiReachable ? '是' : '否') + ' · Key：' + (result.keyConfigured ? '已配置' : '未配置') + ' · 模型：' + (result.modelExists === false ? '未找到' : result.modelExists === true ? '存在' : '未知') + ' · 首字节：' + (result.firstByteLatencyMs == null ? '未知' : result.firstByteLatencyMs + ' ms') + ' · 完整响应：' + (result.responseLatencyMs == null ? (result.latencyMs == null ? '未知' : result.latencyMs + ' ms') : result.responseLatencyMs + ' ms') + ' · ' + cacheText + (caps ? ' · ' + caps : '');
    },

    async runCacheProbe() {
      const module = ($('modelHealthModule') && $('modelHealthModule').value) || 'chat';
      const provider = App.ui.modelProviderFor(module);
      const resultBox = $('cacheProbeResult');
      if (!resultBox) return;
      if (!provider.ref || !provider.model) { resultBox.textContent = '请先选择可用账户和模型。'; return; }
      if (!window.confirm('真实 Cache Probe 会执行两次 Provider 请求，可能消耗额度。继续吗？')) return;
      resultBox.textContent = '正在执行冷/热请求...';
      const result = await App.services.gateway.probeCache({ ref: provider.ref, model: provider.model, kind: 'chat' });
      if (!result || result.ok === false) {
        resultBox.textContent = '探测失败：' + ((result && (result.error || result.code)) || '未知错误');
        App.ui.notify('Cache Probe 失败', provider.model);
        return;
      }
      const cache = result.cache || {};
      const pct = cache.hitRate == null ? '未知' : (cache.hitRate * 100).toFixed(1) + '%';
      resultBox.textContent = 'Cache：' + (cache.source || 'unknown') + ' · 命中率：' + pct + ' · 命中 Token：' + (cache.savedTokens == null ? '未知' : cache.savedTokens) + ' · 节省成本：' + (cache.estimatedSavedCostUsd == null ? '未知' : '$' + cache.estimatedSavedCostUsd) + (cache.unknownReason ? ' · 原因：' + cache.unknownReason : '');
      App.ui.notify('Cache Probe 完成', provider.model + ' · 命中率 ' + pct);
      await App.ui.refreshModelMetrics();
    },

    async refreshModelMetrics() {
      const box = $('modelMetricsList');
      if (!box || !App.services.gateway || !App.services.gateway.modelMetrics) return;
      box.innerHTML = '<div class="model-metrics-empty">读取中...</div>';
      const result = await App.services.gateway.modelMetrics({ limit: 20 });
      const items = result && Array.isArray(result.items) ? result.items : [];
      if (!items.length) { box.innerHTML = '<div class="model-metrics-empty">暂无模型调用指标</div>'; return; }
      box.innerHTML = items.map((item) => {
        const cache = item.cache || {};
        const cacheText = cache.hitRate == null ? 'Cache 未知' : 'Cache ' + (cache.hitRate * 100).toFixed(1) + '%';
        const tokens = item.inputTokens == null && item.outputTokens == null ? 'Token 未知' : (item.inputTokens == null ? '?' : item.inputTokens) + '/' + (item.outputTokens == null ? '?' : item.outputTokens) + ' tok';
        const cost = item.costUsd == null ? '成本未知' : '$' + item.costUsd;
        const latency = item.firstByteLatencyMs == null && item.responseLatencyMs == null ? (item.latencyMs == null ? '延迟未知' : item.latencyMs + ' ms') : '首字节 ' + (item.firstByteLatencyMs == null ? '未知' : item.firstByteLatencyMs + ' ms') + ' · 完整 ' + (item.responseLatencyMs == null ? '未知' : item.responseLatencyMs + ' ms');
        return `<div class="model-metric-row"><b>${App.escapeHtml(item.callType || item.scope || 'model')}</b><span>${App.escapeHtml(item.modelId || '未知模型')} · ${App.escapeHtml(item.status || 'unknown')}</span><em>${tokens} · ${cacheText} · ${cost} · ${latency}</em></div>`;
      }).join('');
    },

    async resetSecretStore() {
      const button = $('resetSecretStore');
      const rt = App.rt || {};
      if (!rt.resetSecretStore || rt.secretStoreCanCreateFresh !== true || (button && button.dataset.busy === '1')) return;
      if (!window.confirm('当前密钥库无法解密。建立新密钥库会保留原密文备份，但旧 API Key 需要重新填写。继续吗？')) return;
      if (button) {
        button.dataset.busy = '1';
        button.disabled = true;
        button.textContent = '正在备份并建立...';
      }
      try {
        const result = await rt.resetSecretStore();
        if (!result || !result.ok) {
          if (rt.refreshSecrets) await rt.refreshSecrets();
          App.ui.refreshSecretStoreStatus();
          App.ui.toast((result && result.error) || '建立新密钥库失败，原密钥文件未覆盖');
          return;
        }
        let moved = 0;
        if (rt.migrateSecrets) moved = await rt.migrateSecrets();
        if (moved) App.persist();
        if (rt.refreshSecrets) await rt.refreshSecrets();
        App.ui.refreshSecretStoreStatus();
        const suffix = result.backupFile ? '原密文已备份为 ' + result.backupFile : '原密文已保留';
        App.ui.toast('新的加密密钥库已建立；' + suffix + (moved ? '，已迁移 ' + moved + ' 个旧 Key' : '，请重新填写 API Key'));
      } catch (error) {
        App.ui.toast((error && error.message) || '建立新密钥库失败，原密钥文件未覆盖');
      } finally {
        if (button) {
          button.dataset.busy = '0';
          button.disabled = false;
          button.textContent = '建立新密钥库';
        }
      }
    },

    async chooseStorageLocation() {
      const service = App.services.fs;
      const button = $('chooseStorageLocation');
      if (!service || !service.chooseStorageLocation || (button && button.dataset.busy === '1')) return;
      const originalText = button ? button.textContent : '';
      if (button) {
        button.dataset.busy = '1';
        button.disabled = true;
        button.textContent = '正在准备迁移...';
      }
      try {
        if (service.flushStorageSync) service.flushStorageSync(JSON.stringify(App.state));
        const result = await service.chooseStorageLocation();
        if (!result || !result.ok) {
          if (!(result && result.canceled)) App.ui.toast(storageLocationMessage(result, '选择数据目录失败'));
          return;
        }
        if (button) button.textContent = '正在重启应用...';
        App.ui.closeSettings();
        App.ui.toast('数据目录已设置，应用即将重启并迁移记录');
        if (!service.relaunchApp) throw new Error('当前版本不支持自动重启，请手动重启应用');
        const relaunch = await service.relaunchApp();
        if (relaunch && relaunch.ok === false) throw Object.assign(new Error(storageLocationMessage(relaunch, '应用重启失败')), relaunch);
      } catch (error) {
        App.ui.toast('迁移失败：' + storageLocationMessage(error, (error && error.message) || String(error)));
      } finally {
        if (button) {
          button.dataset.busy = '0';
          button.disabled = false;
          button.textContent = originalText;
        }
      }
    },

    async openStorageLocation() {
      const info = App.services.fs && App.services.fs.getStorageInfo ? await App.services.fs.getStorageInfo() : null;
      if (info && info.ok && info.activeRoot && App.services.shell && App.services.shell.openPath) {
        const result = await App.services.shell.openPath(info.recordsRoot || info.activeRoot);
        if (result && result.ok === false) App.ui.toast(result.error || '打开数据目录失败');
      }
    },

    // v1.1.6（批次 A）：同步性能诊断开关与按钮态——每次打开/刷新设置面板时调用
    syncPerfToggle() {
      const on = !!(App.perf && App.perf.isEnabled && App.perf.isEnabled());
      const toggle = $('perfToggle');
      const status = $('perfStatus');
      const exportBtn = $('perfExport');
      const clearBtn = $('perfClear');
      if (toggle) toggle.checked = on;
      if (status) status.textContent = on ? '已开启（记录中）' : '未开启';
      if (exportBtn) exportBtn.disabled = !on;
      if (clearBtn) clearBtn.disabled = !on;
    },

    refreshSettingsUI() {
      const s = App.state.settings;
      const apiModuleSel = $('apiModuleSel');
      if (apiModuleSel) App.ui.renderApiPanel(apiModuleSel.value || 'chat');
      App.ui.renderAccounts();
      // 自定义面板：提示词 / 模块 / 外观
      App.ui.renderModulesPanel();
      App.ui.refreshStorageLocation();
      App.ui.refreshSecretStoreStatus();
      App.ui.renderModelProfiles();
      App.ui.refreshModelMetrics();
      App.ui.syncPerfToggle(); // v1.1.6：每次打开/刷新设置面板时同步性能诊断开关与按钮态
      const pr = App.state.settings.prompts || {};
      const DP = App.DEFAULT_PROMPTS;
      if ($('pChat')) { $('pChat').value = pr.chat || ''; $('pChat').placeholder = DP.chat; }
      if ($('pAgent')) { $('pAgent').value = pr.agent || ''; $('pAgent').placeholder = DP.agent; }
      if ($('pDocSummary')) { $('pDocSummary').value = (pr.doc && pr.doc.summary) || ''; $('pDocSummary').placeholder = DP.doc.summary; }
      if ($('pDocPoints')) { $('pDocPoints').value = (pr.doc && pr.doc.points) || ''; $('pDocPoints').placeholder = DP.doc.points; }
      if ($('pDocTranslate')) { $('pDocTranslate').value = (pr.doc && pr.doc.translate) || ''; $('pDocTranslate').placeholder = DP.doc.translate; }
      if ($('pDocOutline')) { $('pDocOutline').value = (pr.doc && pr.doc.outline) || ''; $('pDocOutline').placeholder = DP.doc.outline; }
      // 密钥不回填：明文只在主进程，这里只显示「有没有」
      App.ui.markKeyField($('searchKey'), 'search', '留空则使用内置免费搜索');
      if ($('userMemory')) $('userMemory').value = (App.state.settings.userMemory || '');
      // v2（权限大改）+G17（B3）：全局权限规则回填（每行：工具 模式 允许|拒绝 [sandbox]）
      if ($('globalPermRules')) {
        const rs = App.state.settings.permissionRules || [];
        $('globalPermRules').value = rs.map((r) => [r.tool || '*', r.pattern || '', r.allow === false ? '拒绝' : '允许', r.sandbox ? 'sandbox' : ''].join(' ').trim()).join('\n');
      }
      if ($('contextWindow')) $('contextWindow').value = (App.state.settings.contextWindow || 128000);
      {
        const list = $('visionChipList');
        const inp = $('visionInput');
        if (list && inp) {
          const models = App.state.settings.visionModels || [];
          list.innerHTML = models.map(m => `<span class="chip-tag" data-vm="${App.escapeHtml(m)}">${App.escapeHtml(m)}<button type="button" class="chip-tag-x" title="移除">×</button></span>`).join('');
          inp.value = '';
        }
      }
      const ap = App.state.settings.appearance || {};
      if ($('accentColor')) $('accentColor').value = ap.accent || '#1a5cff';
      if ($('accentReset')) $('accentReset').checked = !ap.accent;
      if ($('radiusRange')) $('radiusRange').value = ap.radius ? parseInt(ap.radius, 10) : 14;
      if ($('radiusVal')) $('radiusVal').textContent = (ap.radius ? ap.radius : 14) + 'px';
      App.ui.markThemeSeg();
      // 保留命令面板或用户刚刚选择的设置子面板。
      const activePanel = ($('settingsModal') && $('settingsModal').dataset.activePanel) || 'api';
      App.ui.selectSettingsPanel(activePanel);
      App.ui.renderAccentSwatches();
      // v4（技能面板）：异步加载技能列表（成功后填充，不阻塞其它面板）
      App.ui.renderSkillsPanel();
    },

    // 技能面板列表直接走主进程 IPC：不依赖糖码后端、端口或本地启动令牌。
    async renderSkillsPanel() {
      const box = $('skillList');
      if (!box) return;
      // v2（UX 修复）：技能「⋯」更多菜单点击外部自动折叠——挂接一次性 document 委托（与模型/聊天下拉同模式）
      if (!App.ui._skillMoreBound) {
        App.ui._skillMoreBound = true;
        document.addEventListener('click', (e) => {
          const inside = e.target && e.target.closest ? e.target.closest('.skill-more') : null;
          document.querySelectorAll('.skill-more[open]').forEach((m) => { if (m !== inside) m.open = false; });
        });
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') document.querySelectorAll('.skill-more[open]').forEach((m) => { m.open = false; });
        });
      }
      box.innerHTML = '<div class="skill-state"><span class="skill-spinner"></span><span>正在读取本机技能…</span></div>';
      const proj = App.agent && App.agent.activeProject ? App.agent.activeProject() : null;
      let wid = (proj && proj.workspaceId) || '';
      const registerProjectWorkspace = async () => {
        if (!proj || !App.services.shell || !App.services.shell.registerWorkspace) return false;
        const primary = Array.isArray(proj.roots) && proj.roots.length
          ? proj.roots.find((root) => root.rootId === proj.primaryRootId) || proj.roots[0]
          : null;
        const cwd = proj.cwd || (primary && primary.path) || '';
        if (!cwd) return false;
        try {
          const registered = await App.services.shell.registerWorkspace(cwd, proj.name);
          if (!registered || !registered.ok || !registered.workspaceId) return false;
          wid = registered.workspaceId;
          proj.workspaceId = wid;
          if (typeof registered.cwd === 'string' && registered.cwd) proj.cwd = registered.cwd;
          if (Array.isArray(registered.roots) && registered.roots.length) proj.roots = registered.roots;
          if (registered.primaryRootId) proj.primaryRootId = registered.primaryRootId;
          App.persist();
          return true;
        } catch (_) {
          return false;
        }
      };
      const isInvalidWorkspace = (value) => {
        const text = String(value && (value.code || value.error || value.message) || value || '').toLowerCase();
        return text === 'unknown_workspace' || text === 'invalid_workspace'
          || /invalid.?workspace|unknown.?workspace|无效的工作区|工作区.*(失效|无效)/i.test(text);
      };
      // v2（UX 修复）：老项目缺 workspaceId 时惰性登记，否则主进程只扫到用户级+内置，项目级技能“名存实亡”
      if (!wid && proj && proj.cwd) {
        await registerProjectWorkspace();
      }
      const listSkills = async () => (App.services.skills && App.services.skills.listSkills
        ? App.services.skills.listSkills(wid)
        : { ok: false, error: '当前环境不支持技能管理', skills: [] });
      let result;
      try {
        result = await listSkills();
      } catch (e) {
        result = { ok: false, error: String(e && e.message ? e.message : e), skills: [] };
      }
      if ((!result || !result.ok) && isInvalidWorkspace(result)) {
        wid = '';
        if (proj) proj.workspaceId = '';
        if (await registerProjectWorkspace()) {
          try { result = await listSkills(); } catch (e) {
            result = { ok: false, error: String(e && e.message ? e.message : e), skills: [] };
          }
        }
      }
      if (!result || !result.ok) {
        box.innerHTML = '<div class="skill-state skill-state-error"><b>技能列表读取失败</b><span>' + App.escapeHtml((result && result.error) || '未知错误') + '</span><button type="button" class="btn-ghost mini" data-skill-retry>重试</button></div>';
        const retry = box.querySelector('[data-skill-retry]');
        if (retry) retry.addEventListener('click', () => App.ui.renderSkillsPanel());
        return;
      }
      const skills = Array.isArray(result.skills) ? result.skills : [];
      App.ui._skillsPanelData = skills;
      App.ui._externalSkills = Array.isArray(result.external) ? result.external : [];
      App.ui.applySkillFilter();
    },

    applySkillFilter() {
      const box = $('skillList');
      if (!box) return;
      const all = Array.isArray(App.ui._skillsPanelData) ? App.ui._skillsPanelData : [];
      const search = String(($('skillSearch') && $('skillSearch').value) || '').trim().toLowerCase();
      // v2（F 批）：属性筛选——风险 / 信任 / 自动触发 / 冲突
      const filter = String(($('skillFilter') && $('skillFilter').value) || '');
      const skills = all.filter((s) => {
        if (search && !String(s.name || '').toLowerCase().includes(search) && !String(s.description || '').toLowerCase().includes(search)) return false;
        if (filter === 'high' && s.risk !== 'high') return false;
        if (filter === 'medium' && s.risk !== 'medium') return false;
        if (filter === 'untrusted' && s.trusted) return false;
        if (filter === 'trusted' && !s.trusted) return false;
        if (filter === 'noauto' && s.autoTrigger !== false) return false;
        if (filter === 'conflict' && !(s.triggerConflicts && s.triggerConflicts.length) && !(Number(s.duplicateCount) > 1)) return false;
        return true;
      });
      const count = $('skillCount');
      if (count) count.textContent = skills.length + ' / ' + all.length;
      if (!skills.length) {
        box.innerHTML = '<div class="skill-state"><strong>' + (all.length ? '没有匹配的技能' : '还没有安装技能') + '</strong><span>' + (all.length ? '换个关键词试试。' : '点击右上角「导入 Skill」开始安装。') + '</span></div>';
        return;
      }
      const groups = [
        { key: 'project', title: '当前项目', desc: '仅在当前项目中生效' },
        { key: 'user', title: '用户技能', desc: '对所有项目生效' },
        { key: 'builtin', title: '内置技能', desc: '糖包随附，始终可用' },
      ];
      const levelLabel = { project: '项目', user: '用户级', builtin: '内置' };
      // 同名生效关系由主进程按 Runtime 的真实根目录顺序计算；前端只展示，不自行推断另一套优先级。
      box.innerHTML = groups.map((g) => {
        const rows = skills.filter((s) => s.level === g.key);
        if (!rows.length) return '';
        return '<section class="skill-group"><div class="skill-group-head"><div><h4>' + g.title + '</h4><span>' + g.desc + '</span></div><b>' + rows.length + '</b></div>' + rows.map((s) => {
          const enabled = s.enabled !== false;
          const disabled = s.level === 'builtin';
          const payload = ' data-skill-dir="' + App.escapeHtml(s.dir || '') + '" data-skill-name="' + App.escapeHtml(s.name || '') + '" data-skill-scope="' + App.escapeHtml(s.level || '') + '"';
          const control = '<label class="skill-toggle' + (disabled ? ' is-disabled' : '') + '" title="' + (disabled ? '内置技能不可禁用' : (enabled ? '点击禁用' : '点击启用')) + '"><input type="checkbox" ' + (enabled ? 'checked ' : '') + (disabled ? 'disabled' : '') + payload + ' data-skill-enable="' + (enabled ? '0' : '1') + '"><span></span></label>';
          const riskLabel = s.risk === 'high' ? '高风险' : (s.risk === 'medium' ? '中风险' : (s.risk === 'low' ? '低风险' : '未扫描'));
          const conflicts = Array.isArray(s.triggerConflicts) ? s.triggerConflicts : [];
          const duplicate = Number(s.duplicateCount) > 1;
          const resolutionLabel = s.resolution === 'effective' && duplicate ? '当前生效'
            : s.resolution === 'covered' ? '被' + App.escapeHtml((s.coveredBy && (s.coveredBy.priorityLabel || s.coveredBy.scope)) || '同名 Skill') + '覆盖'
            : s.resolution === 'disabled' && duplicate ? '已停用 · 其他同名项生效' : '';
          const resolutionClass = s.resolution === 'effective' ? 'skill-effective' : s.resolution === 'disabled' ? 'skill-disabled-resolution' : 'skill-covered';
          const meta = '<div class="skill-meta"><span>v' + App.escapeHtml(s.version || '未标注') + '</span><span class="skill-risk skill-risk-' + App.escapeHtml(s.risk || 'unknown') + '">' + riskLabel + '</span><span class="skill-trust' + (s.trusted ? ' is-trusted' : '') + '">' + (s.trusted ? '已信任当前版本' : '未信任') + '</span>'
            + (resolutionLabel ? '<span class="' + resolutionClass + '" title="优先级：' + App.escapeHtml(s.priorityLabel || '') + '">' + resolutionLabel + '</span>' : '')
            + (duplicate ? '<span class="skill-duplicate-count">同名 ' + s.duplicateCount + ' 项</span>' : '')
            + (conflicts.length ? '<button type="button" class="skill-conflict-btn" data-skill-conflict="' + App.escapeHtml(s.name) + '" title="查看触发词冲突详情">触发词冲突</button>' : '')
            + '</div>';
          // v2（F 批）：主操作「详情」+ 更多菜单（导出 / 信任 / 自动触发 / 卸载），避免五按钮横排
          const actions = disabled ? '' : '<div class="skill-actions"><button type="button" class="mini" data-skill-act="details"' + payload + '>详情</button><details class="skill-more"><summary title="更多操作" aria-label="更多操作">⋯</summary><div class="skill-more-menu">'
            + '<button type="button" class="mini" data-skill-act="edit"' + payload + '>编辑 SKILL.md</button>'
            + '<button type="button" class="mini" data-skill-act="reveal"' + payload + '>打开所在位置</button>'
            + '<button type="button" class="mini" data-skill-act="export"' + payload + '>导出标准 ZIP</button>'
            + '<button type="button" class="mini" data-skill-act="trust" data-trusted="' + (s.trusted ? '1' : '0') + '"' + payload + '>' + (s.trusted ? '撤销信任' : '信任当前版本') + '</button>'
            + '<button type="button" class="mini" data-skill-act="trigger" data-enabled="' + (s.autoTrigger === false ? '0' : '1') + '"' + payload + '>' + (s.autoTrigger === false ? '开启自动触发' : '关闭自动触发') + '</button>'
            // v2（等级移动）：project 级 → 移到用户级；user 级 → 移到当前项目
            + (s.level === 'project' ? '<button type="button" class="mini" data-skill-act="move-user"' + payload + '>移到用户级</button>'
              : s.level === 'user' ? '<button type="button" class="mini" data-skill-act="move-project"' + payload + '>移到当前项目</button>' : '')
            + '<button type="button" class="mini danger" data-skill-act="uninstall"' + payload + '>卸载（移入隔离区）</button>'
            + '</div></details></div>';
          // v2（UX 重排）：meta 标签与操作按钮合并到同一行（.skill-foot），压缩卡片纵向高度
          const foot = '<div class="skill-foot">' + meta + actions + '</div>';
          return '<div class="skill-row' + (!enabled ? ' is-off' : '') + '"><div class="skill-icon">✦</div><div class="skill-main"><div class="skill-name">' + App.escapeHtml(s.name || '') + '<span class="skill-level skill-level-' + g.key + '">' + levelLabel[g.key] + '</span></div><div class="skill-desc">' + App.escapeHtml(s.description || '暂无说明') + '</div></div>' + foot + control + '</div>';
        }).join('') + '</section>';
      }).join('');
      const external = Array.isArray(App.ui._externalSkills) ? App.ui._externalSkills : [];
      if (external.length && !search) {
        box.insertAdjacentHTML('beforeend', '<section class="skill-group skill-external"><div class="skill-group-head"><div><h4>检测到外部 Skill</h4><span>来自 .claude / .codex 兼容目录，可选择性复制到糖码标准目录</span></div><b>' + external.length + '</b></div>' + external.map((s) => '<div class="skill-row"><div class="skill-icon">↗</div><div class="skill-main"><div class="skill-name">' + App.escapeHtml(s.name) + '<span class="skill-level">' + App.escapeHtml(s.source) + '</span></div><div class="skill-desc">' + App.escapeHtml(s.description || '暂无说明') + '</div><div class="skill-actions"><button type="button" class="mini" data-skill-external="1" data-source="' + App.escapeHtml(s.source) + '" data-name="' + App.escapeHtml(s.name) + '">导入到糖码</button></div></div></div>').join('') + '</section>');
      }
      box.querySelectorAll('.skill-toggle input[data-skill-name]').forEach((inp) => {
        inp.addEventListener('change', async () => {
          const project = App.agent && App.agent.activeProject ? App.agent.activeProject() : null;
          const payload = {
            dir: inp.dataset.skillDir,
            name: inp.dataset.skillName,
            scope: inp.dataset.skillScope,
            workspaceId: (project && project.workspaceId) || '',
            enable: inp.dataset.skillEnable === '1',
          };
          inp.disabled = true;
          const r = await App.services.skills.toggleSkill(payload);
          if (r && r.ok) App.ui.toast(payload.enable ? '已启用：' + payload.name : '已禁用：' + payload.name);
          else App.ui.toast((r && r.error) || '启停失败');
          App.ui.renderSkillsPanel();
        });
      });
      box.querySelectorAll('[data-skill-act]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          // v2（F 批）：更多菜单项点击后自动收起
          const more = btn.closest('.skill-more');
          if (more) more.open = false;
          const project = App.agent && App.agent.activeProject ? App.agent.activeProject() : null;
          const payload = {
            dir: btn.dataset.skillDir,
            name: btn.dataset.skillName,
            scope: btn.dataset.skillScope,
            workspaceId: (project && project.workspaceId) || '',
          };
          const act = btn.dataset.skillAct; btn.disabled = true;
          try {
            let r;
            if (act === 'details') {
              r = await App.services.skills.details(payload);
              if (r && r.ok) App.ui.showSkillDetails(r);
              else App.ui.toast((r && r.error) || '读取详情失败');
              return;
            }
            if (act === 'edit') r = await App.services.skills.edit(payload);
            else if (act === 'reveal') r = await App.services.skills.reveal(payload);
            else if (act === 'export') r = await App.services.skills.exportSkill(payload);
            else if (act === 'uninstall') r = await App.services.skills.uninstall(payload);
            else if (act === 'trust') r = await App.services.skills.trust(Object.assign(payload, { level: btn.dataset.trusted === '1' ? 'untrusted' : 'version' }));
            else if (act === 'trigger') r = await App.services.skills.setAutoTrigger(Object.assign(payload, { enabled: btn.dataset.enabled !== '1' }));
            else if (act === 'move-user') r = await App.services.skills.moveSkill(Object.assign(payload, { toScope: 'user' }));
            else if (act === 'move-project') {
              if (!project || !project.workspaceId) { App.ui.toast('请先打开有效项目，再移动为项目级 Skill'); return; }
              r = await App.services.skills.moveSkill(Object.assign(payload, { toScope: 'project', toWorkspaceId: project.workspaceId }));
            }
            if (r && r.ok) {
              const message = act === 'export' ? 'Skill 已导出'
                : act === 'edit' ? '已用系统编辑器打开 SKILL.md'
                  : act === 'reveal' ? '已在文件管理器中定位 Skill'
                    : act === 'move-user' ? 'Skill 已移到用户级'
                      : act === 'move-project' ? 'Skill 已移到当前项目'
                        : act === 'uninstall' ? '已卸载 Skill（移入隔离区）'
                          : 'Skill 设置已更新';
              App.ui.toast(message);
              if (!['edit', 'reveal'].includes(act)) App.ui.renderSkillsPanel();
            }
            else if (!(r && r.canceled)) App.ui.toast((r && r.error) || '操作失败');
          } catch (e) {
            // v1.1.0（修复）：异常不得静默——此前只有 finally，IPC 异常会被吞掉表现为"点卸载无反应"
            App.ui.toast('操作失败：' + ((e && e.message) || e));
          } finally { btn.disabled = false; }
        });
      });
      // v2（F 批）：触发词冲突详情——列出冲突技能与触发词，帮助用户决策
      box.querySelectorAll('[data-skill-conflict]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const name = btn.dataset.skillConflict || '';
          const s = all.find((x) => x.name === name) || {};
          const conflicts = Array.isArray(s.triggerConflicts) ? s.triggerConflicts : [];
          if (!conflicts.length) { App.ui.toast('暂无冲突详情'); return; }
          const lines = conflicts.map((c) => {
            const trigger = (Array.isArray(c.triggers) ? c.triggers : []).join('、') || String(c.trigger || '');
            return '<div class="skill-conflict-row"><b>' + App.escapeHtml(c.name || '?') + '</b><code>' + App.escapeHtml(trigger) + '</code></div>';
          }).join('');
          App.ui.showModal({ title: '触发词冲突：' + name, body: '<div class="skill-conflict-tip">以下技能与「' + App.escapeHtml(name) + '」存在相同触发词，关键词自动注入时按 project→user→builtin 优先级取生效版本：</div>' + lines, buttons: [{ label: '关闭', cls: 'btn-ghost' }] });
        });
      });
      box.querySelectorAll('[data-skill-external]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const project = App.agent && App.agent.activeProject ? App.agent.activeProject() : null;
          if (!(project && project.workspaceId)) { App.ui.toast('请先打开有效项目'); return; }
          btn.disabled = true;
          try {
            const r = await App.services.skills.importExternal({ name: btn.dataset.name, source: btn.dataset.source, workspaceId: project.workspaceId, scope: 'project' });
            if (r && r.ok) { App.ui.toast('已导入外部 Skill：' + r.name); App.ui.renderSkillsPanel(); }
            else App.ui.toast((r && r.error) || '导入失败');
          } finally { btn.disabled = false; }
        });
      });
    },

    showSkillDetails(result) {
      const s = result.skill || {}, m = result.manifest || {}, sec = result.security || {}, comp = result.compatibility || {};
      const identity = result.identity || { name: s.name, dir: s.dir, scope: s.level, workspaceId: '' };
      const modal = document.createElement('div'); modal.className = 'modal-mask';
      const risks = (sec.risks || []).map((item) => '<li>' + App.escapeHtml(item.severity + ' · ' + item.type + ' · ' + item.path) + '</li>').join('') || '<li>未发现静态风险</li>';
      const issues = (comp.issues || []).map((item) => '<li>' + App.escapeHtml(item.message) + '</li>').join('') || '<li>当前平台兼容性检查通过</li>';
      const runtimes = (comp.requiredEnv || []).length ? '声明所需环境变量：' + App.escapeHtml(comp.requiredEnv.join('、')) : '未声明环境变量';
      // v2（H 批）：签名来源与依赖环境——本地无密钥体系，签名仅记录展示，一律按未验证处理
      const signatureRow = m.signature
        ? '已声明签名（本地无密钥体系，按未验证处理；执行仍要求审批）'
        : '未签名（仅本地包哈希信任）';
      const deps = (s.metadata && (s.metadata.dependencies || s.metadata.runtimes)) ? '声明依赖（不自动安装，需在系统或独立环境中手动准备）' : '未声明外部依赖';
      modal.innerHTML = '<div class="modal skill-detail-modal" role="dialog" aria-modal="true"><div class="modal-header"><span>Skill 详情 · ' + App.escapeHtml(s.name || '') + '</span><button class="icon-btn" data-close>×</button></div><div class="modal-body"><div class="skill-detail-grid"><b>作用域</b><span>' + (identity.scope === 'project' ? '当前项目' : '用户级') + '</span><b>路径</b><code>' + App.escapeHtml(identity.dir || '') + '</code><b>版本</b><span>' + App.escapeHtml(m.version || '未标注') + '</span><b>发布者</b><span>' + App.escapeHtml(m.publisher || '未标注') + '</span><b>签名</b><span>' + App.escapeHtml(signatureRow) + '</span><b>来源</b><span>' + App.escapeHtml(m.sourceType || s.level || '') + '</span><b>包哈希</b><code>' + App.escapeHtml(sec.packageHash || m.packageHash || '') + '</code><b>能力</b><span>' + App.escapeHtml((sec.capabilities || []).join('、') || '只读说明') + '</span><b>自动触发</b><span>' + (m.autoTrigger === false ? '关闭（仍可显式调用）' : '开启') + '</span><b>依赖环境</b><span>' + App.escapeHtml(deps) + ' · ' + runtimes + '</span><b>隔离说明</b><span>脚本使用最小环境、临时目录、超时和输出限制；当前平台网络为声明但未强制阻断。</span></div><h4>风险扫描</h4><ul>' + risks + '</ul><h4>兼容性</h4><ul>' + issues + '</ul></div><div class="modal-footer skill-detail-actions"><button class="btn-ghost" data-detail-act="toggle">' + (s.enabled === false ? '启用' : '停用') + '</button><button class="btn-ghost" data-detail-act="edit">编辑 SKILL.md</button><button class="btn-ghost" data-detail-act="reveal">打开所在位置</button><button class="btn-ghost danger" data-detail-act="uninstall">卸载到隔离区</button><button class="btn-primary" data-close>关闭</button></div></div>';
      document.body.appendChild(modal);
      modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.remove(); });
      modal.addEventListener('click', async (e) => {
        if (e.target === modal || e.target.closest('[data-close]')) { modal.remove(); return; }
        const btn = e.target.closest('[data-detail-act]');
        if (!btn) return;
        btn.disabled = true;
        const action = btn.dataset.detailAct;
        let response;
        try {
          if (action === 'toggle') response = await App.services.skills.toggleSkill(Object.assign({}, identity, { enable: s.enabled === false }));
          else if (action === 'edit') response = await App.services.skills.edit(identity);
          else if (action === 'reveal') response = await App.services.skills.reveal(identity);
          else if (action === 'uninstall') response = await App.services.skills.uninstall(identity);
          if (response && response.ok) {
            App.ui.toast(action === 'edit' ? '已用系统编辑器打开 SKILL.md' : action === 'reveal' ? '已在文件管理器中定位 Skill' : 'Skill 设置已更新');
            if (action === 'toggle' || action === 'uninstall') { modal.remove(); App.ui.renderSkillsPanel(); }
          } else if (!(response && response.canceled)) App.ui.toast((response && response.error) || '操作失败');
        } finally { btn.disabled = false; }
      });
      const focusable = modal.querySelector('button, input, select, a[href]');
      if (focusable) focusable.focus();
    },

    // v2（F 批）：通用确认/信息弹窗（返回 modal 元素供继续绑定）
    showModal(opts) {
      const o = opts || {};
      const modal = document.createElement('div'); modal.className = 'modal-mask';
      const buttons = (o.buttons || [{ label: '关闭', cls: 'btn-ghost' }]).map((b) => '<button type="button" class="' + (b.cls || 'btn-ghost') + '" data-modal-btn="' + App.escapeHtml(String(b.label || '关闭')) + '">' + App.escapeHtml(b.label || '关闭') + '</button>').join('');
      modal.innerHTML = '<div class="modal" role="dialog" aria-modal="true"><div class="modal-header"><span>' + App.escapeHtml(o.title || '') + '</span><button class="icon-btn" data-close aria-label="关闭">×</button></div><div class="modal-body">' + (o.body || '') + '</div><div class="modal-footer">' + buttons + '</div></div>';
      document.body.appendChild(modal);
      modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { modal.remove(); if (o.onClose) o.onClose(); } });
      modal.addEventListener('click', (e) => {
        if (e.target === modal) { modal.remove(); if (o.onClose) o.onClose(); return; }
        if (e.target.closest('[data-close]')) { modal.remove(); if (o.onClose) o.onClose(); return; }
        const btn = e.target.closest('[data-modal-btn]');
        if (btn) { modal.remove(); if (o.onClose) o.onClose(btn.getAttribute('data-modal-btn')); }
      });
      const focusable = modal.querySelector('button, input, select, a[href]');
      if (focusable) focusable.focus();
      return modal;
    },

    // v2（F 批 + 等级）：隔离区——列出已卸载 Skill，按范围恢复，彻底删除移入系统回收站
    async showSkillQuarantine() {
      const r = await App.services.skills.listQuarantine();
      const items = (r && r.ok && Array.isArray(r.items)) ? r.items : [];
      const body = items.length
        ? '<div class="skill-quarantine-list">' + items.map((it) => '<div class="skill-row"><div class="skill-icon">🗑</div><div class="skill-main"><div class="skill-name">' + App.escapeHtml(it.name) + '<span class="skill-level">隔离区</span><span class="skill-level skill-level-' + (it.scope === 'project' ? 'project' : 'user') + '">' + (it.scope === 'project' ? '原项目级' : '原用户级') + '</span></div><div class="skill-desc">' + App.escapeHtml(it.description || '暂无说明') + '</div></div><div class="skill-actions"><button type="button" class="btn-primary mini" data-sq-restore="' + App.escapeHtml(it.quarantinePath) + '" data-scope="' + App.escapeHtml(it.scope || 'user') + '">恢复</button><button type="button" class="mini danger" data-sq-purge="' + App.escapeHtml(it.quarantinePath) + '">彻底删除</button></div></div>').join('') + '</div>'
        : '<div class="skill-state"><strong>隔离区为空</strong><span>卸载的 Skill 会移到这里，可随时恢复。</span></div>';
      const modal = App.ui.showModal({ title: 'Skill 隔离区（已卸载，可恢复）', body, buttons: [{ label: '关闭', cls: 'btn-ghost' }] });
      modal.querySelectorAll('[data-sq-restore]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          const project = App.agent && App.agent.activeProject ? App.agent.activeProject() : null;
          try {
            const rr = await App.services.skills.restoreQuarantine({ quarantinePath: btn.dataset.sqRestore, scope: btn.dataset.scope, workspaceId: (project && project.workspaceId) || '' });
            if (rr && rr.ok) { App.ui.toast('已恢复 Skill：' + rr.name); modal.remove(); App.ui.renderSkillsPanel(); }
            else { btn.disabled = false; App.ui.toast((rr && rr.error) || '恢复失败'); }
          } catch (e) {
            // v1.1.0（修复）：恢复异常不得静默——IPC reject 此前会表现为"点了没反应"
            btn.disabled = false; App.ui.toast('恢复失败：' + ((e && e.message) || e));
          }
        });
      });
      modal.querySelectorAll('[data-sq-purge]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          const rr = await App.services.skills.purgeQuarantine({ quarantinePath: btn.dataset.sqPurge });
          if (rr && rr.ok) { App.ui.toast('已移入系统回收站'); modal.remove(); App.ui.showSkillQuarantine(); }
          else { btn.disabled = false; App.ui.toast((rr && rr.error) || '删除失败'); }
        });
      });
    },

    /* ---------- API Key 输入框（1.0.6：明文只在主进程，前端不回填） ----------
     * 密钥保存在系统密钥库里，渲染进程只知道某个 ref 有没有值。所以输入框：
     *   已保存 → 空值 + 「已保存」占位符，留空提交表示「不修改」
     *   未保存 → 原始占位符
     */
    markKeyField(el, ref, emptyPlaceholder) {
      if (!el) return;
      if (App.rt && App.rt.secretStoreState === 'unavailable') {
        el.value = '';
        el.placeholder = '密钥库不可用 · 原密钥未覆盖，请先修复存储后再保存';
        el.dataset.saved = '';
        return;
      }
      const saved = !!(App.rt && App.rt.hasSecret && App.rt.hasSecret(ref));
      el.value = '';
      el.placeholder = saved ? '已保存 · 留空不变，输入新 Key 可替换' : (emptyPlaceholder || '粘贴你的 API Key');
      el.dataset.saved = saved ? '1' : '';
    },

    // 输入框有值才写入密钥库；写完清空输入框并刷新占位符。返回是否发生了写入。
    async commitKeyField(el, ref, emptyPlaceholder) {
      if (!el || !App.rt || !App.rt.setSecret) return false;
      const v = (el.value || '').trim();
      if (!v) return false;
      const r = await App.rt.setSecret(ref, v);
      if (!r || !r.ok) {
        App.ui.toast('保存密钥失败：' + ((r && r.error) || '未知原因'));
        return false;
      }
      App.ui.markKeyField(el, ref, emptyPlaceholder);
      return true;
    },

    // 切换密码框可见性（眼睛按钮）：仅改 input.type，不影响密钥读取逻辑
    toggleKeyEye(btn) {
      if (!btn) return;
      const id = btn.getAttribute('data-eye');
      const inp = id && document.getElementById(id);
      if (!inp) return;
      const showing = inp.type === 'text';
      inp.type = showing ? 'password' : 'text';
      btn.classList.toggle('is-off', !showing);
      const label = showing ? '显示' : '隐藏';
      btn.title = label;
      btn.setAttribute('aria-label', label + ' API Key');
    },

    renderApiPanel(module) {
      App.ui._apiModule = module;
      const s = App.state.settings;
      const sel = $('apiAccountSel');
      if (!sel) return;
      const prov = s.providers[module] || {};
      const cur = prov.accountId || s.defaultAccountId || '__default__';
      let opts = '<option value="__default__">默认账户</option>' +
        s.accounts.map(a => `<option value="${a.id}">${App.escapeHtml(a.name)}</option>`).join('');
      // 存量自定义账户：UI 不再提供新建入口，但保留读取与选中（防切换面板时覆盖丢数据）
      if (cur === '__custom__') opts += '<option value="__custom__" selected>自定义（存量）</option>';
      sel.innerHTML = opts;
      sel.value = cur;
      if (!sel.value) sel.value = '__default__'; // 选中账户已被删除等场景兜底
      const cf = $('apiCustomFields');
      if (cf) cf.hidden = true; // 自定义入口已移除，恒隐藏
      if (cur === '__custom__') {
        $('apiBaseCur').value = prov.apiBase || '';
        $('apiModelCur').value = prov.model || '';
        App.ui.markKeyField($('apiKeyCur'), 'custom:' + module, '粘贴你的 API Key');
      }
    },

    async saveCurrentApiModule(module) {
      const m = module || (($('apiModuleSel') && $('apiModuleSel').value) || 'chat');
      const sel = $('apiAccountSel');
      const accountId = sel ? sel.value : '';
      const existing = App.state.settings.providers[m] || {};
      // 保留 existing.apiBase：存量自定义配置的 Base 不因 UI 不再提供新建入口而丢失
      const prov = { accountId, apiBase: existing.apiBase || '', model: existing.model || '' };
      App.state.settings.providers[m] = prov;
      App.persist();
    },

    renderAccentSwatches() {
      const box = $('accentSwatches');
      if (!box) return;
      const presets = ['#1a5cff', '#6c5ce7', '#00b894', '#e17055', '#e84393', '#0984e3', '#fdcb6e', '#d63031'];
      const cur = ((App.state.settings.appearance || {}).accent || '').toLowerCase();
      box.innerHTML = presets.map(c => {
        const active = c.toLowerCase() === cur ? ' active' : '';
        return `<span class="accent-dot${active}" data-c="${c}" title="${c}" style="background:${c}"></span>`;
      }).join('');
    },

    async saveSettings() {
      await App.ui.saveCurrentApiModule();
      {
        const chips = document.querySelectorAll('#visionChipList .chip-tag');
        const models = Array.from(chips).map(c => c.dataset.vm || c.textContent.replace(/×$/, '').trim()).filter(Boolean);
        if (models.length) App.state.settings.visionModels = models;
      }
      App.ui.syncModelSelect();
      App.ui.closeSettings();
      App.ui.toast('设置已保存');
      // 刷新分模式视图的模型列表（若当前正在看图像/文档）
      if (App.state.view === 'image' && App.image) App.image.render();
      if (App.state.view === 'doc' && App.doc) App.doc.render();
    },

    clearSettings() {
      const btn = $('clearSettings');
      // 二次确认：首次点击进入待确认状态，3 秒内再次点击才真正清除
      if (btn && btn.dataset.arm === '1') {
        if (btn._t) clearTimeout(btn._t);
        btn.dataset.arm = '';
        btn.textContent = '清除';
        btn.classList.remove('danger');
        App.state.settings.accounts = [];
        App.state.settings.defaultAccountId = '';
        const modules = ['default', 'chat', 'agent', 'create', 'tangguan', 'image', 'doc'];
        modules.forEach(m => { App.state.settings.providers[m] = { accountId: '__default__', apiBase: '', model: '' }; });
        // 账户与模块配置清空了，密钥库里对应的 Key 也要一并删掉（联网搜索 Key 属于另一块设置，不动）
        if (App.rt && App.rt.deleteSecretsByPrefix) {
          App.rt.deleteSecretsByPrefix('acc:');
          App.rt.deleteSecretsByPrefix('custom:');
        }
        App.persist({ allowAccountReset: true });
        App.ui.refreshSettingsUI();
        App.ui.syncModelSelect();
        App.ui.toast('已清除所有账户与配置');
        return;
      }
      if (!btn) return;
      btn.dataset.arm = '1';
      btn.textContent = '确认清除？';
      btn.classList.add('danger');
      App.ui.toast('再次点击“确认清除”才会真正清空');
      btn._t = setTimeout(() => {
        btn.dataset.arm = '';
        btn.textContent = '清除';
        btn.classList.remove('danger');
      }, 3000);
    },

    /* ---------- 密钥账户管理 ---------- */
    renderAccounts() {
      const list = $('accountList');
      if (!list) return;
      const s = App.state.settings;
      if (!s.accounts.length) {
        list.innerHTML = '<div class="history-empty">还没有账户，点击下方“+ 添加账户”。</div>';
        return;
      }
      list.innerHTML = s.accounts.map(a => {
        const isDef = a.id === s.defaultAccountId;
        return `<div class="account-row" draggable="true" data-id="${a.id}">
          <span class="drag-handle" title="拖拽排序">⠿</span>
          <div class="account-meta">
            <div class="account-name">${App.escapeHtml(a.name)}${isDef ? ' <span class="tag-default">默认</span>' : ''}</div>
            <div class="account-sub">${App.escapeHtml(a.apiBase || '')} · ${App.escapeHtml(((a.models && a.models.length) ? a.models.map(x => (typeof x === 'string') ? x : (x && x.name ? x.name : '')).filter(Boolean) : (a.model ? [a.model] : [])).join('、') || '无模型')}</div>
          </div>
          <div class="account-ops">
            ${isDef ? '' : '<button class="mini" data-act="def">设为默认</button>'}
            <button class="mini" data-act="edit">编辑</button>
            <button class="mini danger" data-act="del">删除</button>
          </div>
        </div>`;
      }).join('');
      // M8：自由拖拽排序 → dragend 按 DOM 顺序重建 accounts
      App.ui.bindModuleDrag(list, () => {
        const ids = Array.from(list.querySelectorAll('.account-row')).map(r => r.dataset.id);
        const accMap = {};
        s.accounts.forEach(a => { accMap[a.id] = a; });
        s.accounts = ids.map(id => accMap[id]).filter(Boolean);
        App.persist();
        App.ui.renderAccounts();
      }, '.account-row');
    },

    // 生成一行模型输入（拖拽手柄 + 模型名 + 上下文窗口 + 思考类型 + 能力预设 + 删除按钮）
    makeModelRow(v) {
      const row = document.createElement('div');
      row.className = 'model-row';
      row.draggable = true;
      const handle = document.createElement('span');
      handle.className = 'drag-handle'; handle.textContent = '⠿'; handle.title = '拖拽排序';
      const name = (v && typeof v === 'object') ? v.name : (v || '');
      const cw = (v && typeof v === 'object' && v.contextWindow) ? v.contextWindow : '';
      const maxOutput = (v && typeof v === 'object' && v.maxOutput) ? v.maxOutput : '';
      const tt = (v && typeof v === 'object' && v.thinkType) ? v.thinkType : 'auto';
      const caps = (v && typeof v === 'object' && v.caps) ? v.caps : '';
      const imageProtocol = (v && typeof v === 'object' && v.imageProtocol) ? v.imageProtocol : 'auto';
      const imageSizeStrategy = (v && typeof v === 'object' && v.imageSizeStrategy) ? v.imageSizeStrategy : 'auto';
      const imageSizes = (v && typeof v === 'object' && Array.isArray(v.imageSizes)) ? v.imageSizes.join(', ') : '';
      const input = document.createElement('input');
      input.type = 'text'; input.className = 'accModelRow';
      input.placeholder = '如 doubao-seed-1-6'; input.autocomplete = 'off';
      input.value = name;
      const cwInput = document.createElement('input');
      cwInput.type = 'number'; cwInput.className = 'accModelCtx';
      cwInput.placeholder = '128000'; cwInput.min = '4000'; cwInput.step = '1000';
      cwInput.title = '上下文窗口（token）';
      cwInput.value = cw;
      const outputInput = document.createElement('input');
      outputInput.type = 'number'; outputInput.className = 'accModelOutput';
      outputInput.placeholder = '默认'; outputInput.min = '256'; outputInput.step = '256';
      outputInput.title = '最大输出 token（留空使用供应商默认）';
      outputInput.value = maxOutput;
      const ttSel = document.createElement('select');
      ttSel.className = 'accModelThink';
      ttSel.title = '深度思考参数类型：按模型厂商选，不确定选「自动」';
      [['auto', '自动（推荐）'], ['openai', '强度档·OpenAI'], ['qwen', '开关式·Qwen'], ['none', '原生推理']]
        .forEach(([val, label]) => { const o = document.createElement('option'); o.value = val; o.textContent = label; ttSel.appendChild(o); });
      ttSel.value = tt;
      // M6：能力预设（工具调用/视觉输入）。不确定时选「自动推断」。
      const capsSel = document.createElement('select');
      capsSel.className = 'accModelCaps';
      capsSel.title = '能力预设：决定是否给该模型发工具定义、能否收图片（不确定选「自动推断」）';
      [['', '自动推断'], ['tool_vision', '工具+视觉'], ['tool', '工具+文本'], ['vision', '仅视觉'], ['text', '纯文本']]
        .forEach(([val, label]) => { const o = document.createElement('option'); o.value = val; o.textContent = label; capsSel.appendChild(o); });
      capsSel.value = caps;
      const imageDetails = document.createElement('details');
      imageDetails.className = 'model-image-options';
      imageDetails.style.gridColumn = '2 / -1';
      imageDetails.innerHTML = `<summary>图像协议与尺寸（可选）</summary><div class="model-image-options-body"><label>协议<select class="accModelImageProtocol"><option value="auto">自动</option><option value="openai-images">OpenAI Images</option><option value="sensenova-images">SenseNova Images</option></select></label><label>尺寸策略<select class="accModelImageSizeStrategy"><option value="auto">自动</option><option value="allow-list">合法尺寸列表</option><option value="custom">自定义尺寸</option></select></label><label>自定义尺寸<input class="accModelImageSizes" type="text" placeholder="1024x1024, 1792x1024" /></label></div>`;
      const imageProtocolSel = imageDetails.querySelector('.accModelImageProtocol');
      const imageStrategySel = imageDetails.querySelector('.accModelImageSizeStrategy');
      const imageSizesInput = imageDetails.querySelector('.accModelImageSizes');
      if (imageProtocolSel) imageProtocolSel.value = imageProtocol;
      if (imageStrategySel) imageStrategySel.value = imageSizeStrategy;
      if (imageSizesInput) imageSizesInput.value = imageSizes;
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'model-row-del'; btn.dataset.rm = '1'; btn.textContent = '×'; btn.title = '删除该模型';
      row.appendChild(handle); row.appendChild(input); row.appendChild(cwInput); row.appendChild(outputInput); row.appendChild(ttSel); row.appendChild(capsSel); row.appendChild(btn);
      row.appendChild(imageDetails);
      return row;
    },

    renderModelRows(models) {
      const box = $('accModels');
      if (!box) return;
      box.innerHTML = '';
      const rows = (models && models.length) ? models : [''];
      rows.forEach(v => box.appendChild(App.ui.makeModelRow(v)));
      // M8：模型行自由拖拽（saveAccount 按 DOM 顺序收集，顺序即保存顺序）
      App.ui.bindModuleDrag(box, null, '.model-row');
    },

    // M8：账户编辑改为 modal 弹窗（点击「添加账户/编辑」才弹出；已保存账户列表保持原位）
    openAccountForm(id) {
      const modal = $('accountModal');
      const form = $('accountForm');
      if (!modal || !form) return;
      form.dataset.edit = id || '';
      const title = $('accountModalTitle');
      if (title) title.textContent = id ? '编辑账户' : '添加账户';
      if (id) {
        const a = App.state.settings.accounts.find(x => x.id === id);
        if (a) {
          $('accName').value = a.name; $('accBase').value = a.apiBase;
          App.ui.markKeyField($('accKey'), 'acc:' + id, '粘贴你的 API Key');
          App.ui.renderModelRows((a.models && a.models.length) ? a.models : (a.model ? [a.model] : []));
        }
      } else {
        $('accName').value = ''; $('accBase').value = '';
        App.ui.markKeyField($('accKey'), '__new__', '粘贴你的 API Key');
        App.ui.renderModelRows(['']);
      }
      modal.hidden = false;
      $('accName').focus();
    },

    closeAccountForm() {
      const modal = $('accountModal');
      if (modal) modal.hidden = true;
      const form = $('accountForm');
      if (form) form.dataset.edit = '';
    },

    async saveAccount() {
      const id = $('accountForm').dataset.edit || '';
      const previousAccount = id ? App.state.settings.accounts.find((item) => item.id === id) : null;
      const name = $('accName').value.trim();
      const apiBase = $('accBase').value.trim();
      const apiKey = $('accKey').value.trim();
      const models = [];
      document.querySelectorAll('#accModels .model-row').forEach(row => {
        const nameInput = row.querySelector('.accModelRow');
        const ctxInput = row.querySelector('.accModelCtx');
        const outputInput = row.querySelector('.accModelOutput');
        const ttSel = row.querySelector('.accModelThink');
        const capsSel = row.querySelector('.accModelCaps');
        const imageProtocolSel = row.querySelector('.accModelImageProtocol');
        const imageStrategySel = row.querySelector('.accModelImageSizeStrategy');
        const imageSizesInput = row.querySelector('.accModelImageSizes');
        const n = (nameInput && nameInput.value) ? nameInput.value.trim() : '';
        if (!n) return;
        const cw = (ctxInput && ctxInput.value) ? parseInt(ctxInput.value, 10) : 128000;
        const maxOutput = (outputInput && outputInput.value) ? parseInt(outputInput.value, 10) : 0;
        const tt = (ttSel && ttSel.value) ? ttSel.value : 'auto';
        const caps = (capsSel && capsSel.value) ? capsSel.value : '';
        const imageProtocol = imageProtocolSel && imageProtocolSel.value ? imageProtocolSel.value : 'auto';
        const imageSizeStrategy = imageStrategySel && imageStrategySel.value ? imageStrategySel.value : 'auto';
        const imageSizes = imageSizesInput && imageSizesInput.value
          ? imageSizesInput.value.split(/[\s,;]+/).filter((size) => /^\d{3,5}x\d{3,5}$/.test(size)).slice(0, 32)
          : [];
        const previous = previousAccount && Array.isArray(previousAccount.models)
          ? previousAccount.models.find((item) => (typeof item === 'string' ? item : item && item.name) === n)
          : null;
        const m = { name: n, contextWindow: (cw > 0) ? cw : 128000, thinkType: tt };
        if (imageProtocol !== 'auto') m.imageProtocol = imageProtocol;
        if (imageSizeStrategy !== 'auto') m.imageSizeStrategy = imageSizeStrategy;
        if (imageSizes.length) m.imageSizes = imageSizes;
        if (caps) m.caps = caps; // M6：能力预设
        if (maxOutput > 0) m.maxOutput = maxOutput;
        if (previous && typeof previous === 'object') {
          if (previous.timeoutMs > 0) m.timeoutMs = previous.timeoutMs;
          if (previous.budgetMaxSteps > 0) m.budgetMaxSteps = previous.budgetMaxSteps;
          if (previous.budgetMaxCostUsd >= 0) m.budgetMaxCostUsd = previous.budgetMaxCostUsd;
        }
        models.push(m);
      });
      // 编辑已有账户时 Key 允许留空，表示沿用密钥库里已保存的那把
      const hasSaved = !!(id && App.rt && App.rt.hasSecret && App.rt.hasSecret('acc:' + id));
      if (!name || !apiBase) { App.ui.toast('请填写名称和 API Base URL'); return; }
      if (!apiKey && !hasSaved) { App.ui.toast('请填写 API Key'); return; }
      if (!models.length) { App.ui.toast('请至少填写一个模型名称'); return; }
      if (apiKey && (!App.rt || !App.rt.setSecret)) { App.ui.toast('密钥库不可用，原密钥未覆盖；请先修复数据存储'); return; }
      const s = App.state.settings;
      const accId = id || App.uid();
      const before = cloneValue({ accounts: s.accounts, defaultAccountId: s.defaultAccountId, providers: s.providers });
      const restore = async () => {
        if (!before) return null;
        s.accounts = before.accounts;
        s.defaultAccountId = before.defaultAccountId;
        s.providers = before.providers;
        const result = await persistAndVerify();
        App.ui.refreshSettingsUI();
        App.ui.syncModelSelect();
        return result;
      };
      if (id) {
        const a = s.accounts.find(x => x.id === id);
        if (a) { Object.assign(a, { name, apiBase, models }); delete a.model; delete a.apiKey; }
      } else {
        s.accounts.push({ id: accId, name, apiBase, models });
        if (!s.defaultAccountId) s.defaultAccountId = accId;
      }
      // 配置先落盘并确认成功，避免密钥已经更新但账户配置因写盘失败而消失。
      const persisted = await persistAndVerify();
      if (!persisted || !persisted.ok) {
        await restore();
        App.ui.toast('账户保存失败，原账户配置已恢复：' + ((persisted && (persisted.error || persisted.code)) || '数据目录不可写'));
        return { ok: false, code: persisted && persisted.code || 'account_state_write_failed', preserved: true };
      }
      // 只有账户配置确认落盘后才写入新 Key。若密钥写入失败，恢复整个账户快照。
      if (apiKey && App.rt && App.rt.setSecret) {
        const r = await App.rt.setSecret('acc:' + accId, apiKey);
        if (!r || !r.ok) {
          const restored = await restore();
          App.ui.toast('密钥保存失败，' + (restored && restored.ok ? '原账户配置已恢复：' : '账户配置也未能确认恢复，请检查数据目录：') + ((r && (r.code || r.error)) || 'key_write_failed'));
          return { ok: false, code: r && r.code || 'key_write_failed', preserved: !!(restored && restored.ok), nextAction: 'repair_secret_store' };
        }
        try { if (App.rt.syncEndpoints) await App.rt.syncEndpoints(); } catch (_) {}
      }
      App.ui.refreshSettingsUI();
      App.ui.syncModelSelect();
      App.ui.closeAccountForm();
      App.ui.toast(id ? '账户已保存' : '已添加账户');
    },

    async deleteAccount(id) {
      const s = App.state.settings;
      const before = cloneValue({ accounts: s.accounts, defaultAccountId: s.defaultAccountId, providers: s.providers });
      const restore = async () => {
        if (!before) return null;
        s.accounts = before.accounts;
        s.defaultAccountId = before.defaultAccountId;
        s.providers = before.providers;
        const result = await persistAndVerify();
        App.ui.refreshSettingsUI();
        App.ui.syncModelSelect();
        return result;
      };
      s.accounts = s.accounts.filter(a => a.id !== id);
      // 账户没了，它的 Key 也不该继续留在系统密钥库里
      if (s.defaultAccountId === id) s.defaultAccountId = s.accounts.length ? s.accounts[0].id : '';
      // 清理引用了被删账户的模块选择
      for (const m of ['default', 'chat', 'agent', 'create', 'tangguan', 'image', 'doc']) {
        const p = s.providers[m];
        if (p && p.accountId === id) { p.accountId = '__default__'; p.model = ''; }
      }
      const persisted = await persistAndVerify();
      if (!persisted || !persisted.ok) {
        await restore();
        App.ui.toast('账户删除失败，原账户配置已恢复：' + ((persisted && (persisted.error || persisted.code)) || '数据目录不可写'));
        return { ok: false, code: persisted && persisted.code || 'account_state_write_failed', preserved: true };
      }
      if (App.rt && App.rt.deleteSecret) {
        const secretResult = await App.rt.deleteSecret('acc:' + id);
        if (!secretResult || !secretResult.ok) {
          const restored = await restore();
          App.ui.toast('密钥删除失败，' + (restored && restored.ok ? '账户已恢复：' : '账户状态也未能确认恢复，请检查数据目录：') + ((secretResult && (secretResult.code || secretResult.error)) || 'key_delete_failed'));
          return { ok: false, code: secretResult && secretResult.code || 'key_delete_failed', preserved: !!(restored && restored.ok), nextAction: 'retry_delete' };
        }
      }
      App.ui.refreshSettingsUI();
      App.ui.syncModelSelect();
      return { ok: true };
    },

    setDefaultAccount(id) {
      App.state.settings.defaultAccountId = id;
      App.persist();
      App.ui.refreshSettingsUI();
    },

    /* ---------- 侧边栏用户名 ---------- */
    renderUser() {
      const s = App.state.settings;
      const name = (s.profile && s.profile.name) || '糖包用户';
      const avatar = (s.profile && s.profile.avatar) || '';
      const av = $('userAvatar'); const nm = $('userName');
      if (nm) nm.textContent = name;
      if (av) {
        const safeAvatar = (typeof App.safeUrl === 'function') ? App.safeUrl(avatar) : null;
        if (safeAvatar) {
          av.classList.remove('user-initial');
          av.textContent = '';
          av.innerHTML = `<img src="${safeAvatar}" alt="头像" style="width:100%;height:100%;object-fit:cover;display:block;">`;
        } else {
          av.classList.add('user-initial');
          av.innerHTML = '';
          av.textContent = name.slice(0, 1) || '我';
        }
      }
    },

    pickAvatar() {
      const inp = $('avatarInput');
      if (inp) inp.click();
    },

    onAvatarFile(file) {
      if (!file) return;
      if (!/^image\//.test(file.type)) { App.ui.toast('请选择图片文件'); return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          const MAX = 128;
          let { width: w, height: h } = img;
          const scale = Math.min(1, MAX / Math.max(w, h));
          w = Math.round(w * scale); h = Math.round(h * scale);
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          let dataUrl;
          try { dataUrl = canvas.toDataURL('image/jpeg', 0.85); }
          catch (e) { dataUrl = ev.target.result; }
          const p = App.state.settings.profile || (App.state.settings.profile = { name: '糖包用户', avatar: '' });
          p.avatar = dataUrl;
          App.persist();
          App.ui.renderUser();
          App.ui.toast('头像已更新');
        };
        img.onerror = () => App.ui.toast('图片读取失败');
        img.src = ev.target.result;
      };
      reader.onerror = () => App.ui.toast('图片读取失败');
      reader.readAsDataURL(file);
    },

    resetAvatar() {
      const p = App.state.settings.profile;
      if (!p || !p.avatar) return;
      p.avatar = '';
      App.persist();
      App.ui.renderUser();
      App.ui.toast('已恢复默认头像');
    },

    renameUser() {
      const nm = $('userName');
      if (!nm || nm.querySelector('input')) return; // 已在编辑中
      const cur = (App.state.settings.profile && App.state.settings.profile.name) || '糖包用户';
      const input = document.createElement('input');
      input.className = 'user-edit-input';
      input.value = cur;
      input.maxLength = 24;
      nm.textContent = '';
      nm.appendChild(input);
      input.focus(); input.select();
      let done = false;
      const commit = () => {
        if (done) return; done = true;
        const v = input.value.trim() || '糖包用户';
        App.state.settings.profile = { name: v };
        App.persist();
        App.ui.renderUser();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { done = true; App.ui.renderUser(); }
      });
      input.addEventListener('blur', commit);
    },

    openModuleEditor(existing) {
      const editor = $('cmEditor'); if (!editor) return;
      const labelEl = $('cmLabel'), urlEl = $('cmUrl'), forceEl = $('cmForce');
      if (!labelEl || !urlEl) return;
      labelEl.value = existing ? existing.label : '';
      urlEl.value = existing ? existing.url : '';
      if (forceEl) forceEl.checked = !!(existing && existing.forceEmbed);
      editingModuleId = existing ? existing.id : null;
      editor.style.display = '';
      labelEl.focus();
    },

    saveModuleEditor() {
      const labelEl = $('cmLabel'), urlEl = $('cmUrl'), forceEl = $('cmForce');
      if (!labelEl || !urlEl) return;
      const label = labelEl.value.trim();
      // 保存即对网址兜底归一化：Windows 路径 C:\... → file:///C:/...，保证本地文件可加载
      const url = App.modules.normalizeUrl(urlEl.value.trim());
      if (!label || !url) { App.ui.toast('请填写模块名称和网址'); return; }
      const forceEmbed = !!(forceEl && forceEl.checked);
      const cm = App.state.settings.customModules;
      if (editingModuleId) {
        App.modules.dropCustomFrame(editingModuleId); // 网址可能已改，下次进入按新 URL 重建 iframe
        const idx = cm.findIndex(m => m.id === editingModuleId);
        if (idx >= 0) cm[idx] = { id: cm[idx].id, label, url, forceEmbed };
      } else {
        cm.push({ id: 'cus_' + App.uid(), label, url, forceEmbed });
      }
      const wasEditing = !!editingModuleId;
      editingModuleId = null;
      App.persist(); App.modules.renderNav(); App.ui.renderModulesPanel();
      App.ui.toast(wasEditing ? '已更新模块' : '已添加自定义模块');
    },

    cancelModuleEditor() {
      editingModuleId = null;
      App.ui.renderModulesPanel();
    },

    renderModulesPanel() {
      const builtinBox = $('builtinModules');
      if (builtinBox) {
        builtinBox.innerHTML = App.BUILTIN_MODULES.map(m => `
          <label class="mod-row" draggable="true">
            <span class="mod-drag-handle" title="拖拽排序">⋮⋮</span>
            <input type="checkbox" data-mod="${m.id}" ${App.modules.isEnabled(m.id) ? 'checked' : ''} />
            <span>${App.escapeHtml(m.label)}</span>
          </label>`).join('');
      }
      const customBox = $('customModules');
      if (customBox) {
        const list = App.state.settings.customModules || [];
        const items = list.length ? list.map(m => `
          <div class="mod-row custom-mod" draggable="true">
            <span class="mod-drag-handle" title="拖拽排序">⋮⋮</span>
            <input type="checkbox" data-mod="${m.id}" ${!m.hidden ? 'checked' : ''} title="勾选以在侧边栏显示" />
            <span class="mod-label">${App.escapeHtml(m.label)}${m.forceEmbed ? '<span class="mod-force-tag">强制</span>' : ''}</span>
            <span class="mod-url">${App.escapeHtml(m.url)}</span>
            <button class="mini" data-open="${m.id}" title="在系统浏览器中打开（绕过防嵌入限制）">↗ 浏览器</button>
            <button class="mini" data-edit="${m.id}">编辑</button>
            <button class="mini danger" data-del="${m.id}">删除</button>
          </div>`).join('') : '<div class="history-empty">还没有自定义模块</div>';
        customBox.innerHTML = `
          ${items}
          <div class="cm-editor" id="cmEditor" style="display:none">
            <input id="cmLabel" class="cm-input" placeholder="模块名称" maxlength="24" />
            <input id="cmUrl" class="cm-input" placeholder="嵌入网址（URL，或本地文件如 file:///C:/a.html、也可直接填 C:\a.html）" />
            <label class="cm-force"><input type="checkbox" id="cmForce" /> 强制嵌入（忽略防嵌入响应头，适合被拦截的公开页；登录态/相对路径可能失效）</label>
            <div class="cm-actions">
              <button class="mini" data-cm-save>保存</button>
              <button class="mini" data-cm-cancel>取消</button>
            </div>
          </div>`;
      }
    },

    // 拖拽排序通用绑定（仿 create.js bindWfDrag；rowSel 指定可拖行，默认 .mod-row）
    bindModuleDrag(box, onReorder, rowSel) {
      if (!box || box._dragBound) return;
      box._dragBound = true;
      const sel = rowSel || '.mod-row';
      let dragEl = null;
      const getAfter = (y) => {
        const items = Array.from(box.querySelectorAll(sel + ':not(.dragging)'));
        let closest = null, closestOff = -Infinity;
        for (const el of items) {
          const r = el.getBoundingClientRect();
          const off = y - r.top - r.height / 2;
          if (off < 0 && off > closestOff) { closestOff = off; closest = el; }
        }
        return closest;
      };
      box.addEventListener('dragstart', (e) => {
        const item = e.target.closest(sel); if (!item) return;
        dragEl = item; item.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', ''); } catch (_) {}
      });
      box.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!dragEl) return;
        const after = getAfter(e.clientY);
        if (after == null) box.appendChild(dragEl);
        else box.insertBefore(dragEl, after);
      });
      box.addEventListener('dragend', () => {
        if (dragEl) dragEl.classList.remove('dragging');
        dragEl = null;
        if (onReorder) onReorder();
      });
    },

    // 绑定「提示词 / 外观 / 数据 / 模块」面板的事件（一次性，元素为静态）
    bindCustomization() {
      const bindPrompt = (id, set) => {
        const el = $(id); if (!el) return;
        el.addEventListener('input', () => { set(el.value); App.persist(); });
      };
      bindPrompt('pChat', v => { App.state.settings.prompts.chat = v; });
      bindPrompt('pAgent', v => { App.state.settings.prompts.agent = v; });
      bindPrompt('pDocSummary', v => { App.state.settings.prompts.doc.summary = v; });
      bindPrompt('pDocPoints', v => { App.state.settings.prompts.doc.points = v; });
      bindPrompt('pDocTranslate', v => { App.state.settings.prompts.doc.translate = v; });
      bindPrompt('pDocOutline', v => { App.state.settings.prompts.doc.outline = v; });
      bindPrompt('userMemory', v => { App.state.settings.userMemory = v; });
      // v2（权限大改）+G17（B3）：全局权限规则解析（每行：工具 模式 允许|拒绝 [sandbox]；尾标记 sandbox → 沙箱例外）
      bindPrompt('globalPermRules', (v) => {
        const rules = [];
        String(v || '').split('\n').map(s => s.trim()).filter(Boolean).forEach((line) => {
          let parts = line.split(/\s+/);
          const sandboxFlag = parts.length > 1 && parts[parts.length - 1] === 'sandbox';
          if (sandboxFlag) parts = parts.slice(0, -1);
          const allowWord = parts[parts.length - 1];
          const isDeny = allowWord === '拒绝' || allowWord === 'deny' || allowWord === 'false';
          let tool = parts[0] || '*';
          let pattern = '';
          if (isDeny) pattern = parts.slice(1, -1).join(' ');
          else if (parts.length > 1 && (allowWord === '允许' || allowWord === 'allow' || allowWord === 'true')) pattern = parts.slice(1, -1).join(' ');
          else if (parts.length > 1) pattern = parts.slice(1).join(' ');
          if (!['run_command', 'git_command', 'write_file', 'edit_file', 'apply_patch', 'restore_changeset', 'run_tests', 'run_lint', 'run_typecheck', 'run_subagent', '*'].includes(tool)) tool = '*';
          rules.push({ id: App.uid(), tool, pattern, path: '', allow: !isDeny, scope: 'global', sandbox: sandboxFlag });
        });
        App.state.settings.permissionRules = rules;
      });
      bindPrompt('contextWindow', v => { const n = parseInt(v, 10); App.state.settings.contextWindow = (n > 0) ? n : 128000; });

      // 提示词"恢复默认"按钮：清空对应字段（=回退内置默认）
      const promptMap = { 'chat': 'pChat', 'agent': 'pAgent',
        'doc.summary': 'pDocSummary', 'doc.points': 'pDocPoints',
        'doc.translate': 'pDocTranslate', 'doc.outline': 'pDocOutline' };
      document.querySelectorAll('.prompt-reset[data-key]').forEach(btn => {
        btn.addEventListener('click', () => {
          const key = btn.dataset.key;
          const taId = promptMap[key]; if (!taId) return;
          const ta = $(taId); if (!ta) return;
          ta.value = '';
          if (key === 'chat') App.state.settings.prompts.chat = '';
          else if (key === 'agent') App.state.settings.prompts.agent = '';
          else { const k = key.split('.')[1]; App.state.settings.prompts.doc[k] = ''; }
          App.persist();
          App.ui.toast('已恢复默认（留空=使用内置）');
        });
      });

      // 联网搜索可选 Key（免 key 则用内置免费搜索）。
      // 1.0.6 起 Key 存进系统密钥库，state 里不再留明文；输入框失焦（change）时提交，留空=不修改。
      const sk = $('searchKey');
      if (sk) sk.addEventListener('change', async () => {
        const ok = await App.ui.commitKeyField(sk, 'search', '留空则使用内置免费搜索');
        if (ok) App.ui.toast('联网搜索 Key 已保存');
      });
      const skClear = $('searchKeyClear');
      if (skClear) skClear.addEventListener('click', async () => {
        if (App.rt && App.rt.deleteSecret) await App.rt.deleteSecret('search');
        App.ui.markKeyField(sk, 'search', '留空则使用内置免费搜索');
        App.ui.toast('已清除，联网搜索回落到内置免费搜索');
      });

      const seg = $('themeSeg');
      if (seg) seg.addEventListener('click', e => {
        const b = e.target.closest('[data-mode]'); if (!b) return;
        App.state.settings.appearance.mode = b.dataset.mode;
        App.ui.applyAppearance(); App.persist(); App.ui.markThemeSeg();
      });
      const accent = $('accentColor');
      if (accent) accent.addEventListener('input', e => {
        App.state.settings.appearance.accent = e.target.value;
        if ($('accentReset')) $('accentReset').checked = false;
        App.ui.applyAppearance(); App.persist();
      });
      const accentReset = $('accentReset');
      if (accentReset) accentReset.addEventListener('change', e => {
        if (e.target.checked) {
          App.state.settings.appearance.accent = '';
          if ($('accentColor')) $('accentColor').value = '#1a5cff';
        }
        App.ui.applyAppearance(); App.persist();
      });
      const swatches = $('accentSwatches');
      if (swatches) swatches.addEventListener('click', e => {
        const dot = e.target.closest('.accent-dot'); if (!dot) return;
        App.state.settings.appearance.accent = dot.dataset.c;
        if ($('accentColor')) $('accentColor').value = dot.dataset.c;
        if ($('accentReset')) $('accentReset').checked = false;
        App.ui.applyAppearance(); App.persist();
        App.ui.renderAccentSwatches();
      });
      const radius = $('radiusRange');
      if (radius) radius.addEventListener('input', e => {
        App.state.settings.appearance.radius = e.target.value;
        if ($('radiusVal')) $('radiusVal').textContent = e.target.value + 'px';
        App.ui.applyAppearance(); App.persist();
      });

      const exp = $('exportConfig'); if (exp) exp.addEventListener('click', () => App.config.export());
      const imp = $('importConfig'); if (imp) imp.addEventListener('click', () => { const f = $('importFile'); if (f) f.click(); });
      const impFile = $('importFile'); if (impFile) impFile.addEventListener('change', e => { const f = e.target.files[0]; if (f) App.config.import(f); e.target.value = ''; });
      // M6：完整数据备份（经系统文件对话框）
      const expFull = $('exportFull'); if (expFull) expFull.addEventListener('click', () => App.config.exportFull());
      const impFull = $('importFull'); if (impFull) impFull.addEventListener('click', () => App.config.importFull());
      const chooseStorage = $('chooseStorageLocation'); if (chooseStorage) chooseStorage.addEventListener('click', () => App.ui.chooseStorageLocation());
      const openStorage = $('openStorageLocation'); if (openStorage) openStorage.addEventListener('click', () => App.ui.openStorageLocation());
      const verifyStorage = $('verifyStorageMigration'); if (verifyStorage) verifyStorage.addEventListener('click', () => App.ui.verifyStorageMigration());
      const previewStorage = $('previewStorageCleanup'); if (previewStorage) previewStorage.addEventListener('click', () => App.ui.previewStorageCleanup());
      const cleanupStorage = $('cleanupStorageLegacy'); if (cleanupStorage) cleanupStorage.addEventListener('click', () => App.ui.cleanupStorageLegacy());
      const backupStorage = $('backupStorage'); if (backupStorage) backupStorage.addEventListener('click', () => App.ui.backupStorage());
      const restoreStorage = $('restoreStorage'); if (restoreStorage) restoreStorage.addEventListener('click', () => App.ui.restoreStorage());
      const diagnostics = $('exportStorageDiagnostics'); if (diagnostics) diagnostics.addEventListener('click', () => App.ui.exportStorageDiagnostics());

      // v1.1.6（批次 A）：性能诊断出口——开启/关闭 perf 仪表 + 导出快照 + 清空。
      // 仪表本身（perf.js）保持纯内存、不持久不通信；开关状态存 settings 跨重启保留。
      const perfToggle = $('perfToggle');
      const perfExport = $('perfExport');
      const perfClear = $('perfClear');
      if (perfToggle) perfToggle.addEventListener('change', () => {
        const on = !!perfToggle.checked;
        if (App.perf) { if (on) App.perf.enable(); else App.perf.disable(); }
        App.state.settings.perfEnabled = on;
        try { if (on) localStorage.setItem('perfEnabled', '1'); else localStorage.removeItem('perfEnabled'); } catch (_) {}
        App.persist();
        App.ui.syncPerfToggle();
        App.ui.toast(on ? '性能诊断已开启' : '性能诊断已关闭');
      });
      if (perfExport) perfExport.addEventListener('click', () => {
        if (!App.perf) return;
        const samples = App.perf.snapshot();
        if (!samples.length) { App.ui.toast('暂无性能样本（开启后操作几下再导出）'); return; }
        const json = JSON.stringify({ exportedAt: new Date().toISOString(), version: '1.1.6', samples }, null, 2);
        const a = document.createElement('a');
        a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
        a.download = 'tangbao-perf-' + Date.now() + '.json';
        a.click();
        App.ui.toast('已导出 ' + samples.length + ' 条性能样本');
      });
      if (perfClear) perfClear.addEventListener('click', () => {
        if (App.perf && App.perf.clear) App.perf.clear();
        App.ui.toast('已清空性能样本');
      });
      const diagnoseSecrets = $('diagnoseSecretStore'); if (diagnoseSecrets) diagnoseSecrets.addEventListener('click', () => App.ui.diagnoseSecretStore());
      const recoverSecrets = $('recoverLegacySecrets'); if (recoverSecrets) recoverSecrets.addEventListener('click', () => App.ui.recoverLegacySecrets());
      const resetSecretStore = $('resetSecretStore'); if (resetSecretStore) resetSecretStore.addEventListener('click', () => App.ui.resetSecretStore());
      const modelHealth = $('runModelHealth'); if (modelHealth) modelHealth.addEventListener('click', () => App.ui.runModelHealth());
      const cacheProbe = $('runCacheProbe'); if (cacheProbe) cacheProbe.addEventListener('click', () => App.ui.runCacheProbe());
      const metrics = $('refreshModelMetrics'); if (metrics) metrics.addEventListener('click', () => App.ui.refreshModelMetrics());
      const modelProfiles = $('modelProfileList');
      if (modelProfiles) modelProfiles.addEventListener('click', (e) => {
        const edit = e.target.closest('[data-model-profile-edit]');
        if (!edit) return;
        e.stopPropagation();
        App.ui.openAccountForm(edit.dataset.modelProfileEdit);
      });

      const addBtn = $('addCustomModule');
      if (addBtn) addBtn.addEventListener('click', () => App.ui.openModuleEditor());
      const builtinBox = $('builtinModules');
      if (builtinBox) builtinBox.addEventListener('change', e => {
        const cb = e.target.closest('input[type=checkbox][data-mod]'); if (!cb) return;
        const id = cb.dataset.mod; const em = App.state.settings.enabledModules;
        if (cb.checked) { if (!em.includes(id)) em.push(id); }
        else {
          const idx = em.indexOf(id); if (idx >= 0) em.splice(idx, 1);
          if (App.state.view === id) App.router.go(App.modules.firstEnabled());
        }
        App.persist(); App.modules.renderNav();
      });
      // 内置模块拖拽排序
      App.ui.bindModuleDrag($('builtinModules'), () => {
        // 从 DOM 顺序重建 enabledModules（仅保留 checked 的）
        const ids = Array.from($('builtinModules').querySelectorAll('input[type=checkbox][data-mod]'))
          .filter(cb => cb.checked).map(cb => cb.dataset.mod);
        App.state.settings.enabledModules = ids;
        App.persist(); App.modules.renderNav();
      });
      const customBox = $('customModules');
      // 自定义模块拖拽排序
      App.ui.bindModuleDrag(customBox, () => {
        const ids = Array.from(customBox.querySelectorAll('.mod-row.custom-mod [data-edit]'))
          .map(b => b.dataset.edit);
        const old = App.state.settings.customModules || [];
        App.state.settings.customModules = ids.map(id => old.find(m => m.id === id)).filter(Boolean);
        App.persist(); App.modules.renderNav();
      });
      // 自定义模块复选框：切换 hidden 字段
      customBox.addEventListener('change', e => {
        const cb = e.target.closest('input[type=checkbox][data-mod]'); if (!cb) return;
        const id = cb.dataset.mod;
        const cms = App.state.settings.customModules || [];
        const cm = cms.find(m => m.id === id);
        if (cm) {
          cm.hidden = !cb.checked;
          if (App.state.view === id && cm.hidden) App.router.go(App.modules.firstEnabled());
          App.persist(); App.modules.renderNav();
        }
      });
      if (customBox) {
        customBox.addEventListener('click', e => {
          const del = e.target.closest('[data-del]');
          if (del) {
            const id = del.dataset.del;
            App.state.settings.customModules = App.state.settings.customModules.filter(m => m.id !== id);
            App.modules.dropCustomFrame(id); // 释放该模块缓存的 iframe
            App.persist(); App.modules.renderNav(); App.ui.renderModulesPanel();
            if (App.state.view === id) App.router.go(App.modules.firstEnabled()); // 删的是当前视图则切走，避免空白
            return;
          }
          const edit = e.target.closest('[data-edit]');
          if (edit) {
            const m = (App.state.settings.customModules || []).find(x => x.id === edit.dataset.edit);
            if (m) App.ui.openModuleEditor(m);
            return;
          }
          const open = e.target.closest('[data-open]');
          if (open) {
            const m = (App.state.settings.customModules || []).find(x => x.id === open.dataset.open);
            if (m && m.url) {
              const r = App.ui.openModuleExternal(m.url);
              if (r && r.then) r.then(res => { if (!res || !res.ok) App.ui.toast((res && res.error) ? ('打开失败：' + res.error) : '打开失败'); });
            } else {
              App.ui.toast('打开失败');
            }
            return;
          }
          const save = e.target.closest('[data-cm-save]');
          if (save) { App.ui.saveModuleEditor(); return; }
          const cancel = e.target.closest('[data-cm-cancel]');
          if (cancel) { App.ui.cancelModuleEditor(); return; }
        });
        customBox.addEventListener('keydown', e => {
          if (e.key === 'Enter' && (e.target.id === 'cmLabel' || e.target.id === 'cmUrl')) {
            e.preventDefault(); App.ui.saveModuleEditor();
          }
        });
      }
    },

    init() {
      // sidebar interactions
      $('newChatBtn').addEventListener('click', () => App.chat.newConversation());
      $('searchInput').addEventListener('input', () => {
        App.ui._historyVisibleCount = HISTORY_INITIAL_COUNT;
        App.ui.scheduleSidebarRender();
      });
      $('collapseBtn').addEventListener('click', () => $('app').classList.add('collapsed'));
      $('expandBtn').addEventListener('click', () => $('app').classList.remove('collapsed'));
      $('themeBtn').addEventListener('click', () => App.ui.toggleTheme());
      $('settingsBtn').addEventListener('click', () => App.ui.openSettings());

      const notificationBtn = $('notificationBtn');
      const notificationPopover = $('notificationPopover');
      if (notificationBtn && notificationPopover) {
        notificationBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          notificationPopover.hidden = !notificationPopover.hidden;
        });
        notificationPopover.addEventListener('click', (e) => e.stopPropagation());
      }
      const clearNotifications = $('clearNotifications');
      if (clearNotifications) clearNotifications.addEventListener('click', () => { App.ui._notifications = []; App.ui.renderNotifications(); });
      document.addEventListener('click', () => { if (notificationPopover) notificationPopover.hidden = true; });

      const commandMask = $('commandPalette');
      const commandInput = $('commandPaletteInput');
      const commandResults = $('commandPaletteResults');
      if (commandMask && commandInput && commandResults) {
        commandInput.addEventListener('input', () => App.ui.renderCommandPalette(commandInput.value));
        commandResults.addEventListener('click', (e) => {
          const item = e.target.closest('[data-command]');
          if (item) App.ui.runCommand(item.dataset.command);
        });
        commandMask.addEventListener('click', (e) => { if (e.target === commandMask) App.ui.closeCommandPalette(); });
        commandInput.addEventListener('keydown', (e) => {
          const items = Array.from(commandResults.querySelectorAll('.command-item'));
          if (e.key === 'Enter') {
            e.preventDefault();
            const active = commandResults.querySelector('.command-item.active') || items[0];
            if (active) App.ui.runCommand(active.dataset.command);
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            if (!items.length) return;
            const current = Math.max(0, items.indexOf(commandResults.querySelector('.command-item.active')));
            const next = e.key === 'ArrowDown' ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
            items.forEach((item, index) => item.classList.toggle('active', index === next));
          } else if (e.key === 'Escape') {
            e.preventDefault();
            App.ui.closeCommandPalette();
          }
        });
      }
      document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
          e.preventDefault();
          App.ui.openCommandPalette();
        }
        if (e.key === 'Escape' && $('commandPalette') && !$('commandPalette').hidden) App.ui.closeCommandPalette();
      });

      // nav
      $('mainNav').addEventListener('click', (e) => {
        const item = e.target.closest('.nav-item');
        if (!item) return;
        App.router.go(item.dataset.module);
      });

      // history list
      $('historyList').addEventListener('click', (e) => {
        const del = e.target.closest('[data-del]');
        if (del) { e.stopPropagation(); App.chat.deleteConversation(del.dataset.del); return; }
        const more = e.target.closest('[data-history-more]');
        if (more) {
          App.ui._historyVisibleCount = (App.ui._historyVisibleCount || HISTORY_INITIAL_COUNT) + HISTORY_PAGE_SIZE;
          App.ui.scheduleSidebarRender();
          return;
        }
        const item = e.target.closest('[data-id]');
        if (item) App.chat.activate(item.dataset.id);
      });

      // topbar 模型切换（自定义玻璃下拉，替代原生 select）
      const modelBtn = $('modelSelectBtn');
      const modelDd = $('modelDropdown');
      if (modelBtn && modelDd) {
        modelBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          modelDd.hidden = !modelDd.hidden;
        });
        modelDd.addEventListener('click', (e) => {
          e.stopPropagation();
          const b = e.target.closest('[data-model]'); if (!b) return;
          const chosen = b.dataset.model;
          const module = currentModelModule();
          const providers = App.state.settings.providers || (App.state.settings.providers = {});
          const p = providers[module] || (providers[module] = { accountId: '__default__', apiBase: '', model: '' });
          p.model = chosen;
          const conv = moduleConversation(module);
          const effective = App.getProvider(module);
          if (conv && conv.model && (!effective.models.length || effective.models.includes(chosen))) {
            conv.model = chosen;
            if (App.chat && App.chat.persistConversation) App.chat.persistConversation(conv);
          }
          App.persist();
          App.ui.syncModelSelect();
          App.chat.syncImgBtn();
          App.ui.toast('已切换模型：' + chosen);
          modelDd.hidden = true;
        });
        document.addEventListener('click', () => { modelDd.hidden = true; });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modelDd.hidden = true; });
      }
      const ts = $('thinkSelect'); if (ts) ts.addEventListener('change', () => App.ui.syncThink(ts.value));
      { const wb = $('webBtn'); if (wb) wb.addEventListener('click', () => App.ui.syncWeb(!App.state.web, true)); }
      $('chatMenuBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        $('chatDropdown').hidden = !$('chatDropdown').hidden;
      });
      document.addEventListener('click', () => { $('chatDropdown').hidden = true; });
      // 浮窗入口 / 关闭
      const floatBtn = $('floatBtn');
      if (floatBtn) floatBtn.addEventListener('click', () => { App.services.float.open(); });
      const floatClose = $('floatClose');
      if (floatClose) floatClose.addEventListener('click', () => { App.services.float.close(); });
      $('chatDropdown').addEventListener('click', (e) => {
        e.stopPropagation();
        const act = e.target.closest('[data-act]');
        if (!act) return;
        const a = act.dataset.act;
        if (a === 'rename') App.chat.rename();
        if (a === 'clear') App.chat.clear();
        if (a === 'export-md') App.ui.downloadMarkdown();
        if (a === 'share') App.ui.exportMarkdown();
        if (a === 'compact') App.chat.compactNow();
        $('chatDropdown').hidden = true;
      });

      // 全局 ESC：兜底关闭任意弹窗（.modal-mask），避免弹窗卡死无法退出
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          const m = document.querySelector('.modal-mask:not([hidden])');
          if (!m) return;
          // B5（P2）：静态弹窗（设置/账户）只能隐藏不能 remove——否则按一次 Esc 后永久从 DOM 消失、功能不可恢复
          if (m.id === 'settingsModal' || m.id === 'accountModal') { m.hidden = true; return; }
          m.remove();
        }
      });

      // settings modal
      $('closeSettings').addEventListener('click', () => App.ui.closeSettings());
      $('saveSettings').addEventListener('click', () => App.ui.saveSettings());
      // 视觉模型 chips：回车添加，点击 × 删除，打开设置时由 refreshSettingsUI 渲染
      {
        const inp = $('visionInput');
        const list = $('visionChipList');
        if (inp && list) {
          const addChip = (val) => {
            const v = val.trim();
            if (!v || document.querySelector(`#visionChipList .chip-tag[data-vm="${v.replace(/"/g,'&quot;')}"]`)) return;
            const span = document.createElement('span');
            span.className = 'chip-tag';
            span.dataset.vm = v;
            span.innerHTML = `${App.escapeHtml(v)}<button type="button" class="chip-tag-x" title="移除">×</button>`;
            list.appendChild(span);
            inp.value = '';
          };
          inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addChip(inp.value); } });
          list.addEventListener('click', (e) => {
            const x = e.target.closest('.chip-tag-x');
            if (x) { x.closest('.chip-tag').remove(); }
          });
        }
      }
      $('clearSettings').addEventListener('click', () => App.ui.clearSettings());
      $('settingsModal').addEventListener('click', (e) => { if (e.target === $('settingsModal')) App.ui.closeSettings(); });
      document.querySelector('.settings-nav').addEventListener('click', (e) => {
        const item = e.target.closest('.set-nav-item');
        if (!item) return;
        const target = item.dataset.panel;
        App.ui.selectSettingsPanel(target);
        $('settingsModal').dataset.activePanel = target;
      });
      const apiModuleSel = $('apiModuleSel');
      if (apiModuleSel) apiModuleSel.addEventListener('change', async () => {
        const prev = App.ui._apiModule || 'chat';
        // 必须等上一个模块的 Key 落库后再切面板，否则会把旧模块的保存状态写到新面板上
        await App.ui.saveCurrentApiModule(prev);
        App.ui.renderApiPanel(apiModuleSel.value);
      });
      const apiAccountSel = $('apiAccountSel');
      if (apiAccountSel) apiAccountSel.addEventListener('change', () => {
        const m = (apiModuleSel && apiModuleSel.value) || 'chat';
        // 聊天修复 E：下拉切换立即写回 accountId 并持久化——
        // 此前只清 model、不写回，任何 refreshSettingsUI/renderApiPanel 重建都会按旧 state 把账户“自动切回去”。
        const providers = App.state.settings.providers;
        const prov = providers[m] || (providers[m] = { accountId: '__default__', apiBase: '', model: '' });
        prov.accountId = apiAccountSel.value || '__default__';
        if (m !== 'default') prov.model = ''; // 保留原逻辑：换账户后需重选模型
        App.persist();
        if (App.ui.renderApiPanel) App.ui.renderApiPanel(m);
      });

      // 账户管理（M8：编辑表单改为 modal 弹窗；排序为自由拖拽见 renderAccounts/renderModelRows）
      $('accAdd').addEventListener('click', () => App.ui.openAccountForm());
      // 标准 Skill 导入：主进程负责系统文件选择器、ZIP 安全校验和原子安装。
      const skillImportBtn = $('skillImport');
      const skillImportScope = $('skillImportScope');
      const skillRefresh = $('skillRefresh');
      const skillSearch = $('skillSearch');
      if (skillRefresh) skillRefresh.addEventListener('click', () => App.ui.renderSkillsPanel());
      if (skillSearch) skillSearch.addEventListener('input', () => App.ui.applySkillFilter());
      const skillFilter = $('skillFilter');
      if (skillFilter) skillFilter.addEventListener('change', () => App.ui.applySkillFilter());
      const skillQuarantine = $('skillQuarantine');
      if (skillQuarantine) skillQuarantine.addEventListener('click', () => App.ui.showSkillQuarantine());
      if (skillImportScope) {
        const syncSkillScope = () => {
          const project = App.agent && App.agent.activeProject ? App.agent.activeProject() : null;
          const canInstallProject = !!(project && project.workspaceId);
          const projectOption = skillImportScope.querySelector('option[value="project"]');
          if (projectOption) projectOption.disabled = !canInstallProject;
          if (!canInstallProject && skillImportScope.value === 'project') skillImportScope.value = 'user';
          skillImportScope.title = canInstallProject ? '选择安装到当前项目或所有项目' : '未打开有效项目，仅可安装到所有项目';
        };
        syncSkillScope();
        skillImportScope.addEventListener('focus', syncSkillScope);
      }
      if (skillImportBtn) {
        skillImportBtn.addEventListener('click', async () => {
          const project = App.agent && App.agent.activeProject ? App.agent.activeProject() : null;
          const scope = skillImportScope ? skillImportScope.value : 'user';
          if (scope === 'project' && !(project && project.workspaceId)) {
            App.ui.toast('请先打开一个已设置工作目录的糖码项目');
            return;
          }
          skillImportBtn.disabled = true;
          try {
            const r = await App.services.skills.importSkill(scope, (project && project.workspaceId) || '');
            if (r && r.ok) {
              const extras = r.resourceCount ? '，含 ' + r.resourceCount + ' 个资源' : '';
              App.ui.toast('已导入 Skill：' + r.name + extras);
              App.ui.renderSkillsPanel();
            } else if (!(r && r.canceled)) {
              App.ui.toast((r && r.error) || '导入失败');
            }
          } finally {
            skillImportBtn.disabled = false;
          }
        });
      }
      $('accSave').addEventListener('click', () => App.ui.saveAccount());
      const accCancelBtn = $('accCancel');
      if (accCancelBtn) accCancelBtn.addEventListener('click', () => App.ui.closeAccountForm());
      const accModalClose = $('accountModalClose');
      if (accModalClose) accModalClose.addEventListener('click', () => App.ui.closeAccountForm());
      const accModal = $('accountModal');
      if (accModal) accModal.addEventListener('click', (e) => { if (e.target === accModal) App.ui.closeAccountForm(); });
      // 动态模型行：添加 / 删除（排序为拖拽，见 renderModelRows 的 bindModuleDrag）
      $('accModelAdd').addEventListener('click', () => { $('accModels').appendChild(App.ui.makeModelRow('')); });
      $('accModels').addEventListener('click', (e) => {
        const rm = e.target.closest('[data-rm]');
        if (rm) rm.closest('.model-row').remove();
      });
      // 账户表单：Enter 保存，Esc 取消（modal 内）
      const accForm = $('accountForm');
      if (accForm) accForm.addEventListener('keydown', (e) => {
        if (!e.target.closest('input')) return;
        if (e.key === 'Enter') { e.preventDefault(); App.ui.saveAccount(); }
        else if (e.key === 'Escape') { App.ui.closeAccountForm(); }
      });
      $('accountList').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = btn.closest('.account-row').dataset.id;
        const act = btn.dataset.act;
        if (act === 'edit') App.ui.openAccountForm(id);
        if (act === 'del') App.ui.deleteAccount(id);
        if (act === 'def') App.ui.setDefaultAccount(id);
      });

      // 用户名（左下角）：点头像换图，点名字改名
      $('userBox').addEventListener('click', (e) => {
        if (e.target.closest('#userAvatar')) { e.stopPropagation(); App.ui.pickAvatar(); }
        else App.ui.renameUser();
      });
      const avEl = $('userAvatar');
      if (avEl) avEl.addEventListener('contextmenu', (e) => { e.preventDefault(); App.ui.resetAvatar(); });
      const avInp = $('avatarInput');
      if (avInp) avInp.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        App.ui.onAvatarFile(f);
        e.target.value = '';
      });

      // 用户自定义：渲染模块导航 + 绑定自定义面板事件
      App.modules.renderNav();
      App.ui.bindCustomization();
      // 跟随系统主题实时切换
      if (window.matchMedia) {
        const mq = matchMedia('(prefers-color-scheme: dark)');
        const sysHandler = () => { if ((App.state.settings.appearance || {}).mode === 'system') App.ui.applyAppearance(); };
        if (mq.addEventListener) mq.addEventListener('change', sysHandler);
        else if (mq.addListener) mq.addListener(sysHandler);
      }

      App.ui.renderUser();
    },
  };

  // 绑定所有密码框的眼睛切换按钮（静态元素，一次性绑定）
  function bindKeyEyes() {
    document.querySelectorAll('.key-eye').forEach(btn => {
      btn.addEventListener('click', () => App.ui.toggleKeyEye(btn));
    });
  }
  bindKeyEyes();
})();
