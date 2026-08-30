'use strict';
/* 应用级快捷键分发层（v1.2.0 批次 6a；v1.2.1 批次 3：动作 id 与键位统一到 ShortcutsCore 词表，
 * 应用内组合键改由 settings.shortcuts.app 驱动，设置→帮助 快捷键卡可点击录入改键）。
 * 约定：
 *   - 存储形态统一为 ShortcutsCore 词表（'Ctrl+N'）；匹配经 core.comboFromEvent + matchesStored；
 *   - Ctrl/Cmd+K 归命令面板（ui.js 独立监听），本层显式排除；
 *   - 模块切换 mod+1..8 固定语义，不入可配置键位；
 *   - 全局加速键（floatToggle/mainToggle）只在此列出与录入，实际注册走 main-shortcuts（shortcutsSetGlobal IPC）。 */
(function () {
  window.App = window.App || {};
  const userEntries = [];

  function core() {
    return (window.App && App.ShortcutsCore) || null;
  }

  function isEnabledModule(id) {
    try { return App.modules && App.modules.isEnabled(id); } catch (_) { return false; }
  }

  function moduleByIndex(n) {
    if (!App.modules || !App.modules.all) return null;
    const mods = App.modules.all().filter((m) => isEnabledModule(m.id));
    return mods[n - 1] ? mods[n - 1].id : null;
  }

  // 应用内可配置动作（palette 归命令面板，不在本表）
  const APP_ACTION_DEFS = [
    {
      id: 'newChat', labelKey: 'sc.newChat',
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
      id: 'search', labelKey: 'sc.localSearch',
      run() {
        const b = document.getElementById('localSearchBtn');
        if (b) { b.click(); return true; }
        return false;
      },
    },
    {
      id: 'settings', labelKey: 'sc.settings',
      run() {
        if (App.ui && App.ui.openSettings) { App.ui.openSettings(); return true; }
        return false;
      },
    },
  ];

  const APP_IDS = APP_ACTION_DEFS.map((a) => a.id);
  const GLOBAL_IDS = ['floatToggle', 'mainToggle'];

  // 读取当前生效键位（settings 优先，缺省回退 core 默认）
  function appMap() {
    const c = core();
    const stored = (((App.state || {}).settings || {}).shortcuts || {}).app || {};
    const defaults = (c && c.DEFAULT_APP) || {};
    const map = {};
    for (const id of APP_IDS) map[id] = Object.prototype.hasOwnProperty.call(stored, id) ? stored[id] : defaults[id];
    return map;
  }
  function globalMap() {
    const c = core();
    const stored = (((App.state || {}).settings || {}).shortcuts || {}).global || {};
    const defaults = (c && c.DEFAULT_GLOBAL) || {};
    const map = {};
    for (const id of GLOBAL_IDS) map[id] = Object.prototype.hasOwnProperty.call(stored, id) ? stored[id] : defaults[id];
    return map;
  }

  function comboFromEvent(e) {
    const c = core();
    if (c && typeof c.comboFromEvent === 'function') return c.comboFromEvent(e);
    return '';
  }
  function comboMatches(stored, combo) {
    if (!stored || !combo) return false;
    const c = core();
    if (c && typeof c.matchesStored === 'function') return c.matchesStored(stored, combo);
    return String(stored) === combo;
  }

  function runAction(id) {
    const def = APP_ACTION_DEFS.find((a) => a.id === id);
    if (!def) return false;
    let handled = false;
    try { handled = def.run() === true; } catch (_) {}
    return handled;
  }

  function dispatch(e) {
    // 模块切换：mod+1..8（固定语义，不依赖可配置词表）
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && /^[1-8]$/.test(e.key)) {
      const id = moduleByIndex(Number(e.key));
      if (id) { e.preventDefault(); try { App.router.go(id); } catch (_) {} }
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return;
    // 命令面板专属：Ctrl+K 恒不让出（ui.js 有独立监听）
    if (combo === 'Ctrl+K') return;
    // 用户注册条目（倒序优先）
    for (let i = userEntries.length - 1; i >= 0; i--) {
      const entry = userEntries[i];
      for (const c of entry.combos || []) {
        if (comboMatches(c, combo)) {
          let handled = false;
          try { handled = entry.run() === true; } catch (_) {}
          if (handled) e.preventDefault();
          return;
        }
      }
    }
    // 应用内动作（settings 驱动，改动即时生效无需重载）
    const map = appMap();
    for (const id of APP_IDS) {
      if (comboMatches(map[id], combo)) {
        if (runAction(id)) e.preventDefault();
        return;
      }
    }
  }

  function register(entry) {
    if (entry && entry.id && Array.isArray(entry.combos) && typeof entry.run === 'function') userEntries.push(entry);
  }

  function listDefaults() {
    const map = appMap();
    const t = (k, fb) => (window.App.i18n ? App.i18n.t(k, fb) : fb);
    return APP_ACTION_DEFS.map((d) => ({ id: d.id, combos: [map[d.id]], label: t(d.labelKey, d.labelKey) }));
  }

  const t = (k, fb) => (window.App.i18n ? App.i18n.t(k, fb) : fb);
  const fmt = (combo) => (combo ? combo : '（未设置）');

  // ---- 设置→帮助 快捷键卡：可点击录入改键 ----
  let recording = null; // { scope, id }

  function saveAppAction(id, combo) {
    const settings = App.state.settings || (App.state.settings = {});
    settings.shortcuts = settings.shortcuts || { app: {}, global: {} };
    settings.shortcuts.app = settings.shortcuts.app || {};
    settings.shortcuts.app[id] = combo;
    App.persist();
    renderAll();
  }
  function saveGlobalAction(id, combo) {
    const settings = App.state.settings || (App.state.settings = {});
    settings.shortcuts = settings.shortcuts || { app: {}, global: {} };
    settings.shortcuts.global = settings.shortcuts.global || {};
    settings.shortcuts.global[id] = combo;
    App.persist();
    // 立即重注册全局加速键（main-shortcuts shortcuts:setGlobal；normalizeStored('') 保留空串=禁用）
    try {
      if (window.electron && window.electron.shortcutsSetGlobal) {
        window.electron.shortcutsSetGlobal({ [id]: combo }).then((r) => {
          if (r && r.ok === false) App.ui.toast((r && r.error) || '全局快捷键注册失败');
        }).catch(() => {});
      }
    } catch (_) {}
    renderAll();
  }

  function renderShortcutRows() {
    const box = document.getElementById('shortcutEditRows');
    if (!box) return;
    const app = appMap();
    const glob = globalMap();
    const row = (scope, id, label, combo) => `
      <div class="sc-row" data-sc-scope="${scope}" data-sc-id="${id}">
        <span class="sc-label">${label}</span>
        <span class="sc-controls">
          <button type="button" class="sc-key" data-sc-key="${scope}:${id}">${fmt(combo)}</button>
          ${combo ? '<button type="button" class="sc-clear" data-sc-clear="' + scope + ':' + id + '" title="清除（禁用）">✕</button>' : ''}
        </span>
      </div>`;
    const rows = [];
    for (const d of APP_ACTION_DEFS) rows.push(row('app', d.id, t(d.labelKey, d.labelKey), app[d.id]));
    rows.push(row('global', 'floatToggle', t('sc.globalFloat', '全局显示/隐藏悬浮窗'), glob.floatToggle));
    rows.push(row('global', 'mainToggle', t('sc.mainToggle', '全局显示/隐藏主窗口'), glob.mainToggle));
    box.innerHTML = rows.join('');
    bindRowActions(box);
  }

  function bindRowActions(box) {
    box.querySelectorAll('[data-sc-key]').forEach((b) => {
      b.addEventListener('click', () => startRecording(b.dataset.scKey));
    });
    box.querySelectorAll('[data-sc-clear]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const [scope, id] = b.dataset.scClear.split(':');
        (scope === 'global' ? saveGlobalAction : saveAppAction)(id, '');
      });
    });
  }

  function startRecording(key) {
    const [scope, id] = key.split(':');
    const box = document.getElementById('shortcutEditRows');
    const btn = box && box.querySelector('[data-sc-key="' + key + '"]');
    if (btn) btn.textContent = '按下新组合…（Esc 清除）';
    recording = { scope, id };
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', handler, true);
        recording = null;
        renderAll();
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // 未带 Ctrl/Alt 修饰，继续等待
      if (combo === 'Ctrl+K') { App.ui.toast('Ctrl+K 为命令面板保留，不能改'); return; }
      // 同命名空间冲突检查（跨命名空间 app/global 允许，作用域不同）
      const others = scope === 'global' ? globalMap() : appMap();
      const conflict = Object.keys(others).find((oid) => oid !== id && others[oid] === combo);
      if (conflict) { App.ui.toast('与「' + conflict + '」冲突：' + combo + '，未保存'); return; }
      document.removeEventListener('keydown', handler, true);
      recording = null;
      (scope === 'global' ? saveGlobalAction : saveAppAction)(id, combo);
    };
    document.addEventListener('keydown', handler, true);
  }

  function resetAll() {
    const c = core();
    const defApp = (c && c.DEFAULT_APP) || {};
    const defGlob = (c && c.DEFAULT_GLOBAL) || {};
    const settings = App.state.settings || (App.state.settings = {});
    settings.shortcuts = settings.shortcuts || {};
    settings.shortcuts.app = Object.assign({}, defApp);
    settings.shortcuts.global = Object.assign({}, defGlob);
    App.persist();
    try {
      if (window.electron && window.electron.shortcutsSetGlobal) {
        window.electron.shortcutsSetGlobal(settings.shortcuts.global).catch(() => {});
      }
    } catch (_) {}
    renderAll();
    App.ui.toast('已恢复默认快捷键');
  }

  // 帮助面板：只读键位概览（随当前 settings 动态渲染）
  function renderShortcutHelp() {
    const box = document.getElementById('shortcutList');
    if (!box) return;
    box.textContent = '';
    const addRow = (keysText, label) => {
      const row = document.createElement('div');
      row.textContent = keysText + ' — ' + label;
      box.appendChild(row);
    };
    const app = appMap();
    for (const d of APP_ACTION_DEFS) addRow(fmt(app[d.id]), t(d.labelKey, d.labelKey));
    const glob = globalMap();
    addRow(fmt(glob.floatToggle) + ' · ' + fmt(glob.mainToggle), t('sc.global', '全局快捷键（应用外也生效）'));
    addRow('Ctrl/Cmd+1~8', t('sc.modules', '切换模块（按侧栏启用顺序）'));
    addRow('Ctrl/Cmd+K', t('sc.palette', '命令面板'));
    addRow('Ctrl/Cmd+= · Ctrl/Cmd+- · Ctrl/Cmd+0', t('sc.zoom', '放大 / 缩小 / 重置界面缩放（Ctrl+滚轮同样生效）'));
  }

  function renderAll() {
    renderShortcutRows();
    renderShortcutHelp();
  }

  window.addEventListener('keydown', dispatch);

  function bootShortcuts() {
    try { if (App.i18n && App.i18n.applyDom) App.i18n.applyDom(); } catch (_) {}
    const resetBtn = document.getElementById('shortcutReset');
    if (resetBtn) resetBtn.addEventListener('click', resetAll);
    renderAll();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootShortcuts);
  else bootShortcuts();

  window.App.shortcuts = { register, listDefaults, dispatch, renderShortcutHelp, renderShortcutRows, resetAll };
})();
