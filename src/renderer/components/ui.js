'use strict';
(function () {
  window.App = window.App || {};

  const $ = (id) => document.getElementById(id);

  // "#rgb"/"#rrggbb" → "r,g,b" 三通道串（供 --primary-rgb 等令牌）；非法输入返回空串走 CSS 默认
  function hexToRgbTriplet(hex) {
    const h = String(hex || '').replace('#', '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(h) && !/^[0-9a-fA-F]{3}$/.test(h)) return '';
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
  }

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
      // fallback so Tavern can still select the model immediately after boot.
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
        // v1.1.8 修复：同步 RGB 通道——否则 14 处 focus 环/glow 的 rgba(var(--primary-rgb),…) 在自定义强调色下仍显示默认蓝
        root.style.setProperty('--primary-rgb', hexToRgbTriplet(ap.accent));
        root.style.setProperty('--primary-hover-rgb', hexToRgbTriplet(App.ui.shade(ap.accent, -0.12)));
      } else {
        root.style.setProperty('--primary', '');
        root.style.setProperty('--primary-hover', '');
        root.style.setProperty('--primary-soft', '');
        root.style.setProperty('--primary-rgb', '');
        root.style.setProperty('--primary-hover-rgb', '');
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
      // 同步系统标题栏叠加层颜色（隐藏标题栏时，右上角最小/最大/关闭按钮的底色）——随主题暖色板
      try {
        if (App.services.shell && App.services.shell.setTitleBarOverlay) {
          const dark = effective === 'dark';
          App.services.shell.setTitleBarOverlay({
            color: dark ? 'rgba(23,23,23,0.96)' : 'rgba(250,250,250,0.96)',
            symbolColor: dark ? '#a3a3a3' : '#525252',
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
      if (target === 'data') {
        App.ui.refreshStorageLocation();
        if (App.ui.refreshUsageSummary) App.ui.refreshUsageSummary(); // v1.2.0：切到数据面板自动刷新用量统计
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
          <div class="modal modal-sm" role="dialog" aria-modal="true">
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
      // v1.2.0 批次 7 第一刀：构建逻辑抽至 core 纯模块（可独立测试）
      return App.chatMarkdown.buildConversationMarkdown(conv);
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
      // v1.2.0 批次 4：上下文压缩参数与世界书检索预算回填
      {
        const c = App.state.settings.context || {};
        const tu = App.state.settings.tavernUi || {};
        if ($('ctxCompactUtil')) $('ctxCompactUtil').value = (c.compactUtil != null ? c.compactUtil : 0.85);
        if ($('ctxRecentKeep')) $('ctxRecentKeep').value = (c.recentKeep != null ? c.recentKeep : 16);
        if ($('ctxSummaryMax')) $('ctxSummaryMax').value = (c.summaryMaxTokens != null ? c.summaryMaxTokens : 4000);
        if ($('ragTokenBudget')) $('ragTokenBudget').value = (tu.ragTokenBudget != null ? tu.ragTokenBudget : 1000);
        if ($('ragLimit')) $('ragLimit').value = (tu.ragLimit != null ? tu.ragLimit : 8);
      }
      // v1.2.0 第九轮：MCP servers JSON 编辑器回填（此前 textarea 零绑定，HANDOFF 曾误记已做——同用量统计事故）
      if ($('mcpServersJson')) {
        const list = ((App.state.settings.mcp || {}).servers) || [];
        $('mcpServersJson').value = Array.isArray(list) && list.length ? JSON.stringify(list, null, 2) : '';
      }
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
      // v1.2.0：浮窗装配勾选态回显
      {
        const kit = App.state.settings.floatKit || {};
        const kitIds = [['fkWelcome', 'welcome'], ['fkThink', 'think'], ['fkWeb', 'web'], ['fkModelSelect', 'modelSelect'], ['fkImages', 'images'], ['fkAttachments', 'attachments'], ['fkMenu', 'menu'], ['fkCtxBar', 'ctxBar'], ['fkMsgActions', 'msgActions'], ['fkDisclaimer', 'disclaimer']];
        for (const [id, key] of kitIds) { const el = $(id); if (el) el.checked = kit[key] === true; }
      }
      App.ui.markThemeSeg();
      // 保留命令面板或用户刚刚选择的设置子面板。
      const activePanel = ($('settingsModal') && $('settingsModal').dataset.activePanel) || 'api';
      App.ui.selectSettingsPanel(activePanel);
      App.ui.renderAccentSwatches();
      // v4（技能面板）：异步加载技能列表（成功后填充，不阻塞其它面板）
      App.ui.renderSkillsPanel();
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
        const modules = ['default', 'chat', 'agent', 'create', 'tavern', 'image', 'doc'];
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


    /* ---------- 侧边栏用户名 ---------- */
    renderUser() {
      const s = App.state.settings;
      const name = (s.profile && s.profile.name) || '糖包用户';
      const avatar = (s.profile && s.profile.avatar) || '';
      const av = $('userAvatar'); const nm = $('userName');
      if (nm) nm.textContent = name;
      if (av) {
        // 本地受信 dataURL 不走 safeUrl 的 2048 长度闸——128px 头像的 base64 普遍 3~15K，
        // 此前被拒导致「保存成功但永远显示首字母」（2026-08-26 用户反馈修复）
        const isLocalData = typeof avatar === 'string' && /^data:image\//i.test(avatar);
        const safeAvatar = isLocalData ? avatar : ((typeof App.safeUrl === 'function') ? App.safeUrl(avatar) : null);
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
            <button class="mini" data-win="${m.id}" title="在独立小窗中打开">⧉ 小窗</button>
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
      // v1.2.0 批次 4：上下文压缩参数与世界书检索预算（越界输入不写入，保留原值）
      const ensureCtx = () => { App.state.settings.context = App.state.settings.context || {}; return App.state.settings.context; };
      const ensureTavernUi = () => { App.state.settings.tavernUi = App.state.settings.tavernUi || {}; return App.state.settings.tavernUi; };
      bindPrompt('ctxCompactUtil', v => { const n = parseFloat(v); if (n >= 0.05 && n <= 0.95) ensureCtx().compactUtil = n; });
      bindPrompt('ctxRecentKeep', v => { const n = parseInt(v, 10); if (n >= 4 && n <= 200) ensureCtx().recentKeep = n; });
      bindPrompt('ctxSummaryMax', v => { const n = parseInt(v, 10); if (n >= 200 && n <= 16000) ensureCtx().summaryMaxTokens = n; });
      bindPrompt('ragTokenBudget', v => { const n = parseInt(v, 10); if (n >= 128 && n <= 8000) ensureTavernUi().ragTokenBudget = n; });
      bindPrompt('ragLimit', v => { const n = parseInt(v, 10); if (n >= 1 && n <= 20) ensureTavernUi().ragLimit = n; });

      // v1.2.0 第九轮：MCP servers JSON 编辑（change 提交——JSON 打字中途必然解析失败，不能像逐行字段那样用 input 事件）。
      // 校验与 state.js 归一化同规则：缺 id 或 command|url 的条目丢弃；保存后主进程按 settings.mcp.servers 动态连接。
      {
        const mcpTa = $('mcpServersJson');
        if (mcpTa) mcpTa.addEventListener('change', () => {
          let parsed;
          try { parsed = JSON.parse(mcpTa.value || '[]'); } catch (e) { App.ui.toast('MCP 配置解析失败：' + ((e && e.message) || e)); return; }
          if (!Array.isArray(parsed)) { App.ui.toast('MCP 配置需为 server 数组'); return; }
          const servers = parsed.map((sv) => {
            const item = sv && typeof sv === 'object' ? sv : {};
            return {
              id: String(item.id || '').trim().slice(0, 64),
              name: String(item.name || '').slice(0, 80),
              transport: item.transport === 'http' ? 'http' : 'stdio',
              command: typeof item.command === 'string' ? item.command.trim().slice(0, 500) : '',
              args: Array.isArray(item.args) ? item.args.map(String).slice(0, 32) : [],
              url: typeof item.url === 'string' ? item.url.trim().slice(0, 500) : '',
              enabled: item.enabled !== false,
            };
          }).filter((sv) => sv.id && (sv.transport === 'http' ? /^https?:\/\//.test(sv.url) : sv.command));
          const dropped = parsed.length - servers.length;
          App.state.settings.mcp = { servers };
          App.persist();
          App.ui.toast('MCP 服务器配置已保存（' + servers.length + ' 个）' + (dropped > 0 ? '，丢弃无效条目 ' + dropped + ' 个' : ''));
        });
        const mcpTestBtn = $('mcpTestBtn');
        if (mcpTestBtn) mcpTestBtn.addEventListener('click', async () => {
          const out = $('mcpStatusOut');
          if (!out) return;
          const servers = (((App.state.settings.mcp || {}).servers) || []).filter((s) => s.enabled !== false);
          out.hidden = false;
          if (!servers.length) { out.textContent = '没有已启用的 MCP server，请先在上方填写 JSON 并点击空白处保存。'; return; }
          mcpTestBtn.disabled = true;
          out.textContent = '正在连接…';
          const lines = [];
          for (const s of servers) {
            try {
              const res = window.electron && window.electron.mcpListTools ? await window.electron.mcpListTools({ serverId: s.id }) : { ok: false, error: '通道不可用' };
              lines.push((res && res.ok) ? ('✓ ' + s.id + '：已连接 · ' + res.tools.length + ' 个工具') : ('✗ ' + s.id + '：失败 — ' + ((res && res.error) || '未知原因')));
            } catch (e) { lines.push('✗ ' + s.id + '：失败 — ' + String((e && e.message) || e)); }
          }
          out.style.whiteSpace = 'pre-line';
          out.textContent = lines.join('\n');
          mcpTestBtn.disabled = false;
        });
      }

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
      // v1.2.0：浮窗装配勾选 → settings.floatKit（即时持久化，pushState 自动同步已打开的悬浮窗）
      {
        const kitIds = [['fkWelcome', 'welcome'], ['fkThink', 'think'], ['fkWeb', 'web'], ['fkModelSelect', 'modelSelect'], ['fkImages', 'images'], ['fkAttachments', 'attachments'], ['fkMenu', 'menu'], ['fkCtxBar', 'ctxBar'], ['fkMsgActions', 'msgActions'], ['fkDisclaimer', 'disclaimer']];
        for (const [id, key] of kitIds) {
          const el = $(id);
          if (!el) continue;
          el.addEventListener('change', () => {
            const kit = App.state.settings.floatKit || (App.state.settings.floatKit = {});
            kit[key] = el.checked;
            App.persist(); // pushState 会把 floatKit 同步到已打开的悬浮窗并重挂 fk-show-* 类
          });
        }
      }

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
        // v1.1.8 Q1：DOM 与 state 失同步时（渲染被跳过/时序错位）ids 可能为空——
        // 空数组绝不落盘，否则一次拖拽即把 customModules 固化为 []（2026-08-22 事故根因之一）
        if (!ids.length && old.length) { App.modules.renderNav(); return; }
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
          // v1.2.0：自定义模块独立小窗打开（复用 forceEmbed 同款子窗口，按 id 单例聚焦）
          const win = e.target.closest('[data-win]');
          if (win) {
            const m = (App.state.settings.customModules || []).find(x => x.id === win.dataset.win);
            if (m && m.url) {
              const r = App.services.shell.openChildWindow({ id: m.id, url: m.url, label: m.label });
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

      // v1.2.0 批次 3：应用内更新（设置→帮助）。状态机 idle→checking→available→downloading→downloaded
      {
        const stEl = $('updaterStatus'), ckBtn = $('updaterCheckBtn'), inBtn = $('updaterInstallBtn');
        if (stEl && ckBtn && inBtn && window.electron && window.electron.updaterCheck) {
          const setStatus = (t) => { stEl.textContent = t; };
          const setBusy = (b) => { ckBtn.disabled = !!b; };
          let updPhase = 'idle';
          let pendingVersion = '';
          window.electron.getAppVersion().then((r) => {
            if (r && r.ok && $('updaterCurVersion')) $('updaterCurVersion').textContent = 'v' + r.version;
            const badge = $('updaterVersionBadge');
            if (r && r.ok && badge) badge.textContent = 'v' + r.version;
            const about = $('aboutVersion');
            if (r && r.ok && about) about.textContent = 'v' + r.version;
          }).catch(() => {});
          window.electron.onUpdaterEvent((ev) => {
            if (!ev || !ev.type) return;
            if (ev.type === 'checking') setStatus('正在检查更新…');
            else if (ev.type === 'none') { updPhase = 'idle'; setBusy(false); setStatus('已是最新版本'); }
            else if (ev.type === 'available') { pendingVersion = ev.version || ''; updPhase = 'available'; setBusy(false); ckBtn.textContent = '下载更新'; setStatus('发现新版本 v' + pendingVersion + '，点击下载'); }
            else if (ev.type === 'progress') setStatus('下载中 ' + (ev.percent != null ? ev.percent + '%' : '…'));
            else if (ev.type === 'downloaded') { updPhase = 'idle'; setBusy(false); setStatus('v' + (ev.version || pendingVersion) + ' 已就绪，点击「重启并安装」完成升级'); inBtn.style.display = ''; }
            else if (ev.type === 'error') { updPhase = 'idle'; setBusy(false); setStatus('更新出错：' + (ev.message || '未知原因')); }
          });
          // 主进程统一 resolve { ok, code }：dev-mode=开发环境、updater-unavailable=组件缺失、updater-error=检查/下载失败；
          // 仅当 invoke 本身异常（通道缺失等意外）才走 catch 兜底文案
          const gateFailText = (r) => r && r.code === 'dev-mode' ? '开发环境不支持应用内更新（打包版可用）'
            : r && (r.code === 'updater-unavailable') ? '更新组件不可用'
              : '无法连接 GitHub（检查网络或代理）';
          ckBtn.addEventListener('click', async () => {
            if (updPhase === 'downloading') return;
            if (updPhase === 'available') {
              setBusy(true); setStatus('下载中…完成后会提示安装'); updPhase = 'downloading';
              try {
                const r = await window.electron.updaterDownload();
                if (!r || !r.ok) { setStatus('下载失败：' + gateFailText(r)); setBusy(false); updPhase = 'available'; }
              } catch (e) { setStatus('下载失败：无法连接 GitHub（检查网络或代理）'); setBusy(false); updPhase = 'available'; }
              return;
            }
            setBusy(true); setStatus('正在检查更新…'); updPhase = 'checking';
            try {
              const r = await window.electron.updaterCheck();
              if (!r || !r.ok) { setStatus('检查失败：' + gateFailText(r)); setBusy(false); updPhase = 'idle'; }
            } catch (e) { setStatus('检查失败：无法连接 GitHub（检查网络或代理）'); setBusy(false); updPhase = 'idle'; }
          });
          inBtn.addEventListener('click', () => window.electron.updaterInstall());
        }
      }
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
      $('accModelAdd').addEventListener('click', () => { $('accModels').appendChild(App.ui.makeModelRow('', false)); });
      $('accImageModelAdd').addEventListener('click', () => { $('accImageModels').appendChild(App.ui.makeModelRow('', true)); });
      $('accModels').addEventListener('click', (e) => {
        const rm = e.target.closest('[data-rm]');
        if (rm) rm.closest('.model-row').remove();
      });
      $('accImageModels').addEventListener('click', (e) => {
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
