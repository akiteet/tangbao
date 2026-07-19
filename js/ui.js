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
      const convs = App.state.conversations.filter(c => !q || (c.title || '').toLowerCase().includes(q));
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
          html += `<div class="history-item${active}" data-id="${c.id}">
            <span class="history-title">${App.escapeHtml(c.title || '新对话')}</span>
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
          if (mod.url && window.electron) {
            window.electron.openExternal(mod.url).then(r => {
              if (!r || !r.ok) App.ui.toast((r && r.error) ? ('打开失败：' + r.error) : '打开失败');
            });
          }
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

    syncThink(on) {
      App.state.think = on;
      $('thinkBtn').classList.toggle('active', on);
      App.persist();
      // 立即对当前已渲染的消息生效：根据开关显示/隐藏思考块
      document.querySelectorAll('.msg.assistant .think-block').forEach(b => {
        const body = b.querySelector('.think-body');
        b.style.display = (on && body && body.textContent.trim()) ? 'block' : 'none';
      });
      // 诚实告知：当前模型是否支持「真正开关」深度思考（避免用户以为开关坏了）
      const s = App.getProvider('chat');
      const model = s.model || '';
      if (model && App.thinkSupport && !App.thinkSupport(model)) {
        if (App.ui._thinkWarnModel !== model) {
          App.ui._thinkWarnModel = model;
          App.ui.toast(on
            ? '当前模型（' + model + '）深度思考为原生行为，开关仅控制是否展示思考过程'
            : '当前模型（' + model + '）无法关闭原生深度思考，开关仅控制展示');
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
      } else {
        root.style.setProperty('--radius', '');
        root.style.setProperty('--radius-sm', '');
      }
      // 同步系统标题栏叠加层颜色（隐藏标题栏时，右上角最小/最大/关闭按钮的底色）
      try {
        if (window.electron && window.electron.setTitleBarOverlay) {
          const dark = effective === 'dark';
          window.electron.setTitleBarOverlay({
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
      if ($('searchKey')) $('searchKey').value = (App.state.settings.search && App.state.settings.search.apiKey) || '';
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
        $('apiKeyCur').value = prov.apiKey || '';
        $('apiModelCur').value = prov.model || '';
      }
    },

    saveCurrentApiModule(module) {
      const m = module || (($('apiModuleSel') && $('apiModuleSel').value) || 'chat');
      const sel = $('apiAccountSel');
      const accountId = sel ? sel.value : '';
      const existing = App.state.settings.providers[m] || {};
      const prov = { accountId };
      if (accountId === '__custom__') {
        prov.apiBase = $('apiBaseCur').value.trim();
        prov.apiKey = $('apiKeyCur').value.trim();
        prov.model = $('apiModelCur').value.trim();
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

    saveSettings() {
      App.ui.saveCurrentApiModule();
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
        const modules = ['default', 'chat', 'image', 'doc'];
        modules.forEach(m => { App.state.settings.providers[m] = { accountId: '__default__', apiBase: '', apiKey: '', model: '' }; });
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
        return `<div class="account-row" data-id="${a.id}">
          <div class="account-meta">
            <div class="account-name">${App.escapeHtml(a.name)}${isDef ? ' <span class="tag-default">默认</span>' : ''}</div>
            <div class="account-sub">${App.escapeHtml(a.apiBase || '')} · ${App.escapeHtml(((a.models && a.models.length) ? a.models : (a.model ? [a.model] : [])).join('、') || '无模型')}</div>
          </div>
          <div class="account-ops">
            ${isDef ? '' : '<button class="mini" data-act="def">设为默认</button>'}
            <button class="mini" data-act="edit">编辑</button>
            <button class="mini danger" data-act="del">删除</button>
          </div>
        </div>`;
      }).join('');
    },

    // 生成一行模型输入（带删除按钮）
    makeModelRow(v) {
      const row = document.createElement('div');
      row.className = 'model-row';
      const input = document.createElement('input');
      input.type = 'text'; input.className = 'accModelRow';
      input.placeholder = '如 doubao-seed-1-6'; input.autocomplete = 'off';
      input.value = v || '';
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'model-row-del'; btn.dataset.rm = '1'; btn.textContent = '×'; btn.title = '删除该模型';
      row.appendChild(input); row.appendChild(btn);
      return row;
    },

    renderModelRows(models) {
      const box = $('accModels');
      if (!box) return;
      box.innerHTML = '';
      const rows = (models && models.length) ? models : [''];
      rows.forEach(v => box.appendChild(App.ui.makeModelRow(v)));
    },

    openAccountForm(id) {
      const form = $('accountForm');
      if (!form) return;
      form.dataset.edit = id || '';
      if (id) {
        const a = App.state.settings.accounts.find(x => x.id === id);
        if (a) {
          $('accName').value = a.name; $('accBase').value = a.apiBase; $('accKey').value = a.apiKey;
          App.ui.renderModelRows((a.models && a.models.length) ? a.models : (a.model ? [a.model] : []));
        }
      } else {
        $('accName').value = ''; $('accBase').value = ''; $('accKey').value = '';
        App.ui.renderModelRows(['']);
      }
      form.hidden = false;
      $('accName').focus();
    },

    saveAccount() {
      const id = $('accountForm').dataset.edit || '';
      const name = $('accName').value.trim();
      const apiBase = $('accBase').value.trim();
      const apiKey = $('accKey').value.trim();
      const models = Array.from(document.querySelectorAll('#accModels .accModelRow'))
        .map(i => i.value.trim()).filter(Boolean);
      if (!name || !apiBase || !apiKey) { App.ui.toast('请填写名称、API Base URL 和 Key'); return; }
      if (!models.length) { App.ui.toast('请至少填写一个模型名称'); return; }
      const s = App.state.settings;
      if (id) {
        const a = s.accounts.find(x => x.id === id);
        if (a) { Object.assign(a, { name, apiBase, apiKey, models }); delete a.model; }
      } else {
        const acc = { id: App.uid(), name, apiBase, apiKey, models };
        s.accounts.push(acc);
        if (!s.defaultAccountId) s.defaultAccountId = acc.id;
      }
      App.persist();
      App.ui.refreshSettingsUI();
      App.ui.syncModelSelect();
      if (id) {
        $('accountForm').hidden = true;
        $('accountForm').dataset.edit = '';
        App.ui.toast('账户已保存');
      } else {
        // 新增：保持表单打开并清空，便于连续添加多个账户
        $('accName').value = ''; $('accBase').value = ''; $('accKey').value = '';
        App.ui.renderModelRows(['']);
        $('accName').focus();
        App.ui.toast('已添加，可继续添加，或点“取消”收起');
      }
    },

    deleteAccount(id) {
      const s = App.state.settings;
      s.accounts = s.accounts.filter(a => a.id !== id);
      if (s.defaultAccountId === id) s.defaultAccountId = s.accounts.length ? s.accounts[0].id : '';
      // 清理引用了被删账户的模块选择
      for (const m of ['default', 'chat', 'image', 'doc']) {
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
        if (avatar) {
          av.classList.remove('user-initial');
          av.textContent = '';
          av.innerHTML = `<img src="${avatar}" alt="头像" style="width:100%;height:100%;object-fit:cover;display:block;">`;
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

    // 拖拽排序通用绑定（仿 create.js bindWfDrag）
    bindModuleDrag(box, onReorder) {
      if (!box || box._dragBound) return;
      box._dragBound = true;
      let dragEl = null;
      const getAfter = (y) => {
        const items = Array.from(box.querySelectorAll('.mod-row:not(.dragging)'));
        let closest = null, closestOff = -Infinity;
        for (const el of items) {
          const r = el.getBoundingClientRect();
          const off = y - r.top - r.height / 2;
          if (off < 0 && off > closestOff) { closestOff = off; closest = el; }
        }
        return closest;
      };
      box.addEventListener('dragstart', (e) => {
        const item = e.target.closest('.mod-row'); if (!item) return;
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

      // 联网搜索可选 Key（免 key 则用内置免费搜索）
      const sk = $('searchKey');
      if (sk) sk.addEventListener('input', () => {
        App.state.settings.search = App.state.settings.search || {};
        App.state.settings.search.apiKey = sk.value.trim();
        App.persist();
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
            if (m && m.url && window.electron) {
              window.electron.openExternal(m.url).then(r => {
                if (!r || !r.ok) App.ui.toast((r && r.error) ? ('打开失败：' + r.error) : '打开失败');
              });
            } else if (m && m.url) {
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
      $('thinkBtn').addEventListener('click', () => App.ui.syncThink(!App.state.think));
      { const wb = $('webBtn'); if (wb) wb.addEventListener('click', () => App.ui.syncWeb(!App.state.web, true)); }
      $('chatMenuBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        $('chatDropdown').hidden = !$('chatDropdown').hidden;
      });
      document.addEventListener('click', () => { $('chatDropdown').hidden = true; });
      $('chatDropdown').addEventListener('click', (e) => {
        e.stopPropagation();
        const act = e.target.closest('[data-act]');
        if (!act) return;
        const a = act.dataset.act;
        if (a === 'rename') App.chat.rename();
        if (a === 'clear') App.chat.clear();
        if (a === 'export-md') App.ui.downloadMarkdown();
        if (a === 'share') App.ui.exportMarkdown();
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
      if (apiModuleSel) apiModuleSel.addEventListener('change', () => {
        const prev = App.ui._apiModule || 'chat';
        App.ui.saveCurrentApiModule(prev);
        App.ui.renderApiPanel(apiModuleSel.value);
      });
      const apiAccountSel = $('apiAccountSel');
      if (apiAccountSel) apiAccountSel.addEventListener('change', () => {
        const cf = $('apiCustomFields');
        if (cf) cf.hidden = apiAccountSel.value !== '__custom__';
        const m = (apiModuleSel && apiModuleSel.value) || 'chat';
        if (m !== 'default' && App.state.settings.providers[m]) App.state.settings.providers[m].model = '';
      });

      // 账户管理
      $('accAdd').addEventListener('click', () => App.ui.openAccountForm());
      $('accSave').addEventListener('click', () => App.ui.saveAccount());
      $('accCancel').addEventListener('click', () => { $('accountForm').hidden = true; $('accountForm').dataset.edit = ''; });
      // 动态模型行：添加 / 删除
      $('accModelAdd').addEventListener('click', () => { $('accModels').appendChild(App.ui.makeModelRow('')); });
      $('accModels').addEventListener('click', (e) => {
        const rm = e.target.closest('[data-rm]');
        if (rm) rm.closest('.model-row').remove();
      });
      // 账户表单：Enter 保存，Esc 取消/收起（含动态模型行输入）
      $('accountForm').addEventListener('keydown', (e) => {
        if (!e.target.closest('input')) return;
        if (e.key === 'Enter') { e.preventDefault(); App.ui.saveAccount(); }
        else if (e.key === 'Escape') { $('accountForm').hidden = true; $('accountForm').dataset.edit = ''; }
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
})();
