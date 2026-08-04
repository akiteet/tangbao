'use strict';
(function () {
  window.App = window.App || {};

  const $ = (id) => document.getElementById(id);
  let editingModuleId = null; // 自定义模块编辑器状态：null=新增，有值=编辑该 id

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

  App.ui = {
    $,
    groupLabel,

    renderSidebar() {
      const list = $('historyList');
      const q = ($('searchInput').value || '').trim().toLowerCase();
      // M7：全文搜索——q 非空时匹配标题 + 消息内容（含深度思考文本），命中对话显示命中条数徽标
      let convs = App.state.conversations;
      const hitsMap = {};
      if (q) {
        convs = [];
        for (const c of App.state.conversations) {
          const titleHit = (c.title || '').toLowerCase().includes(q);
          let hits = 0;
          if (!titleHit) {
            for (const m of (c.messages || [])) {
              const hay = (((m.content || '') + ' ' + (m.think || '')) || '').toLowerCase();
              if (hay.includes(q)) hits++;
            }
          }
          if (titleHit || hits) { convs.push(c); if (hits) hitsMap[c.id] = hits; }
        }
      }
      if (!convs.length) {
        list.innerHTML = `<div class="history-empty">${q ? '没有匹配的对话' : '暂无对话记录'}</div>`;
        return;
      }
      const groups = {};
      for (const c of convs) {
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
      const b = $('webBtn'); if (b) b.classList.toggle('active', on);
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
      const view = App.state.view || 'chat';
      if (view !== 'chat') { if (btn) btn.hidden = true; if (dd) dd.hidden = true; return; } // 顶栏模型下拉仅供聊天
      if (btn) btn.hidden = false;
      const p = App.getProvider('chat');
      const models = (p.models && p.models.length) ? p.models : (p.model ? [p.model] : []);
      if (!models.length) { if (btn) btn.textContent = '未配置模型'; if (dd) dd.innerHTML = ''; return; }
      if (btn) btn.textContent = p.model || models[0] || '选择模型';
      if (dd) dd.innerHTML = models.map(m =>
        `<button data-model="${App.escapeHtml(m)}" class="${m === p.model ? 'active' : ''}">${App.escapeHtml(m)}</button>`
      ).join('');
      App.chat.syncImgBtn();
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
        root.style.setProperty('--radius-sm', Math.max(6, r - 4) + 'px');
        root.style.setProperty('--radius-lg', (r + 4) + 'px');      // M12：大卡片/气泡圆角随滑杆
        root.style.setProperty('--radius-pill', '999px');           // M12：胶囊圆角恒定
      } else {
        root.style.setProperty('--radius', '');
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
      t.textContent = msg;
      t.hidden = false;
      t.classList.add('show');
      setTimeout(() => { t.classList.remove('show'); t.hidden = true; }, 2400);
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
      App.ui.refreshSettingsUI();
      $('settingsModal').hidden = false;
    },

    closeSettings() { $('settingsModal').hidden = true; },

    refreshSettingsUI() {
      const s = App.state.settings;
      const apiModuleSel = $('apiModuleSel');
      if (apiModuleSel) App.ui.renderApiPanel(apiModuleSel.value || 'chat');
      App.ui.renderAccounts();
      // 自定义面板：提示词 / 模块 / 外观
      App.ui.renderModulesPanel();
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
      // 导航高亮
      document.querySelectorAll('.set-nav-item').forEach(t => t.classList.remove('active'));
      const activeNav = document.querySelector('.set-nav-item.active') || document.querySelector('.set-nav-item[data-panel="api"]');
      if (activeNav) activeNav.classList.add('active');
      App.ui.renderAccentSwatches();
    },

    /* ---------- API Key 输入框（1.0.6：明文只在主进程，前端不回填） ----------
     * 密钥保存在系统密钥库里，渲染进程只知道某个 ref 有没有值。所以输入框：
     *   已保存 → 空值 + 「已保存」占位符，留空提交表示「不修改」
     *   未保存 → 原始占位符
     */
    markKeyField(el, ref, emptyPlaceholder) {
      if (!el) return;
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
      const cur = prov.accountId || s.defaultAccountId || '__custom__';
      sel.innerHTML =
        s.accounts.map(a => `<option value="${a.id}">${App.escapeHtml(a.name)}</option>`).join('') +
        `<option value="__custom__">自定义填写</option>`;
      sel.value = cur;
      const cf = $('apiCustomFields');
      if (cf) cf.hidden = cur !== '__custom__';
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
      const prov = { accountId };
      if (accountId === '__custom__') {
        prov.apiBase = $('apiBaseCur').value.trim();
        prov.model = $('apiModelCur').value.trim();
        // Key 单独进密钥库，不写进 state
        await App.ui.commitKeyField($('apiKeyCur'), 'custom:' + m, '粘贴你的 API Key');
      } else {
        prov.model = existing.model || '';
      }
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
        const modules = ['default', 'chat', 'agent', 'create', 'image', 'doc'];
        modules.forEach(m => { App.state.settings.providers[m] = { accountId: '__default__', apiBase: '', model: '' }; });
        // 账户与模块配置清空了，密钥库里对应的 Key 也要一并删掉（联网搜索 Key 属于另一块设置，不动）
        if (App.rt && App.rt.deleteSecretsByPrefix) {
          App.rt.deleteSecretsByPrefix('acc:');
          App.rt.deleteSecretsByPrefix('custom:');
        }
        App.persist();
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
      const tt = (v && typeof v === 'object' && v.thinkType) ? v.thinkType : 'auto';
      const caps = (v && typeof v === 'object' && v.caps) ? v.caps : '';
      const input = document.createElement('input');
      input.type = 'text'; input.className = 'accModelRow';
      input.placeholder = '如 doubao-seed-1-6'; input.autocomplete = 'off';
      input.value = name;
      const cwInput = document.createElement('input');
      cwInput.type = 'number'; cwInput.className = 'accModelCtx';
      cwInput.placeholder = '128000'; cwInput.min = '4000'; cwInput.step = '1000';
      cwInput.title = '上下文窗口（token）';
      cwInput.value = cw;
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
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'model-row-del'; btn.dataset.rm = '1'; btn.textContent = '×'; btn.title = '删除该模型';
      row.appendChild(handle); row.appendChild(input); row.appendChild(cwInput); row.appendChild(ttSel); row.appendChild(capsSel); row.appendChild(btn);
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
      const name = $('accName').value.trim();
      const apiBase = $('accBase').value.trim();
      const apiKey = $('accKey').value.trim();
      const models = [];
      document.querySelectorAll('#accModels .model-row').forEach(row => {
        const nameInput = row.querySelector('.accModelRow');
        const ctxInput = row.querySelector('.accModelCtx');
        const ttSel = row.querySelector('.accModelThink');
        const capsSel = row.querySelector('.accModelCaps');
        const n = (nameInput && nameInput.value) ? nameInput.value.trim() : '';
        if (!n) return;
        const cw = (ctxInput && ctxInput.value) ? parseInt(ctxInput.value, 10) : 128000;
        const tt = (ttSel && ttSel.value) ? ttSel.value : 'auto';
        const caps = (capsSel && capsSel.value) ? capsSel.value : '';
        const m = { name: n, contextWindow: (cw > 0) ? cw : 128000, thinkType: tt };
        if (caps) m.caps = caps; // M6：能力预设
        models.push(m);
      });
      // 编辑已有账户时 Key 允许留空，表示沿用密钥库里已保存的那把
      const hasSaved = !!(id && App.rt && App.rt.hasSecret && App.rt.hasSecret('acc:' + id));
      if (!name || !apiBase) { App.ui.toast('请填写名称和 API Base URL'); return; }
      if (!apiKey && !hasSaved) { App.ui.toast('请填写 API Key'); return; }
      if (!models.length) { App.ui.toast('请至少填写一个模型名称'); return; }
      const s = App.state.settings;
      let accId = id;
      if (id) {
        const a = s.accounts.find(x => x.id === id);
        if (a) { Object.assign(a, { name, apiBase, models }); delete a.model; delete a.apiKey; }
      } else {
        const acc = { id: App.uid(), name, apiBase, models };
        s.accounts.push(acc);
        accId = acc.id;
        if (!s.defaultAccountId) s.defaultAccountId = acc.id;
      }
      // Key 只进系统密钥库，账户对象里不再留明文
      if (apiKey && App.rt && App.rt.setSecret) {
        const r = await App.rt.setSecret('acc:' + accId, apiKey);
        if (!r || !r.ok) App.ui.toast('密钥保存失败：' + ((r && r.error) || '未知原因'));
      }
      App.persist();
      App.ui.refreshSettingsUI();
      App.ui.syncModelSelect();
      App.ui.closeAccountForm();
      App.ui.toast(id ? '账户已保存' : '已添加账户');
    },

    deleteAccount(id) {
      const s = App.state.settings;
      s.accounts = s.accounts.filter(a => a.id !== id);
      // 账户没了，它的 Key 也不该继续留在系统密钥库里
      if (App.rt && App.rt.deleteSecret) App.rt.deleteSecret('acc:' + id);
      if (s.defaultAccountId === id) s.defaultAccountId = s.accounts.length ? s.accounts[0].id : '';
      // 清理引用了被删账户的模块选择
      for (const m of ['default', 'chat', 'agent', 'create', 'image', 'doc']) {
        const p = s.providers[m];
        if (p && p.accountId === id) { p.accountId = '__default__'; p.model = ''; }
      }
      App.persist();
      App.ui.refreshSettingsUI();
      App.ui.syncModelSelect();
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
      $('searchInput').addEventListener('input', () => App.ui.renderSidebar());
      $('collapseBtn').addEventListener('click', () => $('app').classList.add('collapsed'));
      $('expandBtn').addEventListener('click', () => $('app').classList.remove('collapsed'));
      $('themeBtn').addEventListener('click', () => App.ui.toggleTheme());
      $('settingsBtn').addEventListener('click', () => App.ui.openSettings());

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
          const p = App.state.settings.providers.chat || App.state.settings.providers.default;
          p.model = chosen;               // 记录当前选定模型名
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
          if (m) m.remove();
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
        document.querySelectorAll('.set-nav-item').forEach(t => t.classList.toggle('active', t === item));
        document.querySelectorAll('.settings-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === target));
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
        const cf = $('apiCustomFields');
        if (cf) cf.hidden = apiAccountSel.value !== '__custom__';
        const m = (apiModuleSel && apiModuleSel.value) || 'chat';
        if (m !== 'default' && App.state.settings.providers[m]) App.state.settings.providers[m].model = '';
      });

      // 账户管理（M8：编辑表单改为 modal 弹窗；排序为自由拖拽见 renderAccounts/renderModelRows）
      $('accAdd').addEventListener('click', () => App.ui.openAccountForm());
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
