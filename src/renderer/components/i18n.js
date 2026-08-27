'use strict';
/* i18n 脚手架（v1.2.0 批次 6b）。
 * 首批范围：框架 + data-i18n/data-i18n-title 声明式翻译 + 设置面板导航与顶栏按钮首批词条。
 * 后续按模块逐步把硬编码文案迁移到词典（不要一次性全量替换）。
 * locale 来源：settings.locale（默认 zh），setLocale 写回并广播 i18n:changed。 */
(function () {
  window.App = window.App || {};
  const packs = {
    zh: {
      'topbar.settings': '设置',
      'topbar.search': '本地搜索',
      'topbar.newChat': '新建对话',
      'panel.api': '配置',
      'panel.account': '账户',
      'panel.prompts': '提示词',
      'panel.modules': '模块',
      'panel.appearance': '外观',
      'panel.data': '数据',
      'panel.help': '帮助',
      'panel.skills': '技能',
      'help.aboutTitle': '关于',
      'help.modulesTitle': '模块一览',
      'help.shortcutsTitle': '快捷键',
      'sc.newChat': '新建会话（Ctrl/Cmd+N）',
      'sc.localSearch': '本地搜索（Ctrl/Cmd+F）',
      'sc.settings': '打开设置（Ctrl/Cmd+,）',
      'sc.modules': '切换模块（按侧栏启用顺序）',
      'sc.palette': '命令面板',
      'sc.globalFloat': '全局显示/隐藏悬浮窗（应用外也生效）',
      'sc.zoom': '放大 / 缩小 / 重置界面缩放（Ctrl+滚轮同样生效）',
    },
    en: {
      'topbar.settings': 'Settings',
      'topbar.search': 'Local Search',
      'topbar.newChat': 'New Chat',
      'panel.api': 'General',
      'panel.account': 'Account',
      'panel.prompts': 'Prompts',
      'panel.modules': 'Modules',
      'panel.appearance': 'Appearance',
      'panel.data': 'Data',
      'panel.help': 'Help',
      'panel.skills': 'Skills',
      'help.aboutTitle': 'About',
      'help.modulesTitle': 'Modules',
      'help.shortcutsTitle': 'Shortcuts',
      'sc.newChat': 'New chat (Ctrl/Cmd+N)',
      'sc.localSearch': 'Local search (Ctrl/Cmd+F)',
      'sc.settings': 'Open settings (Ctrl/Cmd+,)',
      'sc.modules': 'Switch modules (sidebar order)',
      'sc.palette': 'Command palette',
      'sc.globalFloat': 'Global show/hide float window (works outside the app)',
      'sc.zoom': 'Zoom in / out / reset (Ctrl+wheel also works)',
    },
  };
  let currentLocale = 'zh';
  try {
    const saved = App.state && App.state.settings && App.state.settings.locale;
    currentLocale = (typeof saved === 'string' && packs[saved]) ? saved : 'zh';
  } catch (_) {}

  function t(key, fallback) {
    const k = String(key || '');
    const pack = packs[currentLocale] || {};
    const value = pack[k];
    if (value != null) return value;
    const zh = packs.zh[k];
    if (zh != null) return zh;
    return fallback != null ? fallback : k;
  }

  function getLocale() { return currentLocale; }
  function locales() { return Object.keys(packs); }

  /** 切换语言：写回 settings.locale（由调用方持久化）+ 立即应用 DOM + 广播 */
  function setLocale(l) {
    if (!packs[l]) return false;
    currentLocale = l;
    try {
      if (App.state && App.state.settings) App.state.settings.locale = l;
      if (App.persist) App.persist();
    } catch (_) {}
    applyDom();
    try { document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { locale: l } })); } catch (_) {}
    return true;
  }

  /** 扫描 data-i18n（textContent）与 data-i18n-title（title/aria-label）节点应用当前语言 */
  function applyDom(rootEl) {
    const root = rootEl || document;
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const v = t(el.dataset.i18nTitle);
      el.setAttribute('title', v);
      el.setAttribute('aria-label', v);
    });
  }

  App.i18n = { t, setLocale, getLocale, locales, applyDom };
})();
