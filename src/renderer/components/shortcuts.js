'use strict';
/* 应用级快捷键分发层（v1.2.0 批次 6a）。
 * 单一 window keydown 捕获入口；默认键位集中于此，可用 App.shortcuts.register 扩展。
 * 约定：
 *   - 组合格式 'mod+<key>'（mod = Ctrl/Win 或 Cmd）；数字键 mod+1..8 按启用模块顺序切换；
 *   - 带 mod 的组合在输入框内同样生效；未注册的按键不拦截、不影响输入；
 *   - Ctrl/Cmd+K 归命令面板所有，本层显式排除。 */
(function () {
  window.App = window.App || {};
  const userEntries = [];

  function isEnabledModule(id) {
    try { return App.modules && App.modules.isEnabled(id); } catch (_) { return false; }
  }

  function moduleByIndex(n) {
    if (!App.modules || !App.modules.all) return null;
    const mods = App.modules.all().filter((m) => isEnabledModule(m.id));
    return mods[n - 1] ? mods[n - 1].id : null;
  }

  const DEFAULTS = [
    {
      id: 'new_chat', combos: ['mod+n'], labelKey: 'sc.newChat',
      run() {
        if (App.state.view !== 'chat') { try { App.router.go('chat'); } catch (_) {} }
        const btn = document.getElementById('newChatBtn');
        if (btn) { btn.click(); return true; }
        if (App.chat && App.chat.newConversation) {
          const c = App.chat.newConversation(null, {});
          if (c && App.chat.setActiveConversationId) App.chat.setActiveConversationId('chat', c.id);
          if (App.chat.renderMessages) App.chat.renderMessages();
          return true;
        }
        return false;
      },
    },
    {
      id: 'local_search', combos: ['mod+f'], labelKey: 'sc.localSearch',
      run() {
        const b = document.getElementById('localSearchBtn');
        if (b) { b.click(); return true; }
        return false;
      },
    },
    {
      id: 'open_settings', combos: ['mod+,'], labelKey: 'sc.settings',
      run() {
        if (App.ui && App.ui.openSettings) { App.ui.openSettings(); return true; }
        return false;
      },
    },
  ];

  function allEntries() {
    return userEntries.concat(DEFAULTS.map((d) => ({ id: d.id, combos: d.combos, labelKey: d.labelKey, run: d.run })));
  }

  function comboMatches(e, combo) {
    if (!combo.startsWith('mod+')) return false;
    const key = combo.slice(4);
    if (!(e.ctrlKey || e.metaKey)) return false;
    if (e.altKey || e.shiftKey) return false;
    return e.key.toLowerCase() === key.toLowerCase();
  }

  function dispatch(e) {
    // 模块切换：mod+1..8
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && /^[1-8]$/.test(e.key)) {
      const id = moduleByIndex(Number(e.key));
      if (id) { e.preventDefault(); try { App.router.go(id); } catch (_) {} }
      return;
    }
    for (let i = allEntries().length - 1; i >= 0; i--) {
      const entry = allEntries()[i];
      for (const combo of entry.combos || []) {
        if (combo === 'mod+k') continue; // 命令面板专属
        if (!comboMatches(e, combo)) continue;
        let handled = false;
        try { handled = entry.run() === true; } catch (_) {}
        if (handled) e.preventDefault();
        return;
      }
    }
  }

  function register(entry) {
    if (entry && entry.id && Array.isArray(entry.combos) && typeof entry.run === 'function') userEntries.push(entry);
  }

  function listDefaults() {
    return DEFAULTS.map((d) => ({
      id: d.id,
      combos: d.combos.slice(),
      label: window.App.i18n ? App.i18n.t(d.labelKey, d.labelKey) : d.labelKey,
    }));
  }

  window.addEventListener('keydown', dispatch);

  // 帮助面板：把全部可用键位渲染成清单（经 i18n 翻译）。
  // v1.2.0 第十轮补全：此前只列 DEFAULTS 三条，漏了 1~8 切模块 / K 命令面板 / 全局浮窗键 / 缩放。
  function renderShortcutHelp() {
    const box = document.getElementById('shortcutList');
    if (!box) return;
    const t = (k, fb) => (window.App.i18n ? App.i18n.t(k, fb) : fb);
    const addRow = (keysText, label) => {
      const row = document.createElement('div');
      row.textContent = keysText + ' — ' + label;
      box.appendChild(row);
    };
    for (const d of DEFAULTS) {
      addRow(d.combos.map((c) => 'Ctrl/Cmd+' + c.slice(4).toUpperCase()).join(' / '), t(d.labelKey, d.labelKey));
    }
    addRow('Ctrl/Cmd+1~8', t('sc.modules', '切换模块（按侧栏启用顺序）'));
    addRow('Ctrl/Cmd+K', t('sc.palette', '命令面板'));
    let globalFloat = '';
    try { globalFloat = String(((App.state || {}).settings || {}).shortcuts.global.floatToggle || ''); } catch (_) {}
    addRow(globalFloat || 'Ctrl+Shift+F', t('sc.globalFloat', '全局显示/隐藏悬浮窗（应用外也生效）'));
    addRow('Ctrl/Cmd+= · Ctrl/Cmd+- · Ctrl/Cmd+0', t('sc.zoom', '放大 / 缩小 / 重置界面缩放（Ctrl+滚轮同样生效）'));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { try { App.i18n.applyDom(); renderShortcutHelp(); } catch (_) {} });
  else { try { App.i18n.applyDom(); renderShortcutHelp(); } catch (_) {} }

  window.App.shortcuts = { register, listDefaults, dispatch, renderShortcutHelp };
})();
