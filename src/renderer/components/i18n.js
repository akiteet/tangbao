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
      'panel.pet': '桌宠',
      'panel.data': '数据',
      'panel.help': '帮助',
      'panel.skills': '技能',
      'help.aboutTitle': '关于',
      'help.modulesTitle': '模块一览',
      'help.shortcutsTitle': '快捷键',
      'sc.newChat': '新建会话',
      'sc.localSearch': '本地搜索',
      'sc.settings': '打开设置',
      'sc.modules': '切换模块（按侧栏启用顺序）',
      'sc.palette': '命令面板',
      'sc.globalFloat': '全局显示/隐藏悬浮窗',
      'sc.mainToggle': '全局显示/隐藏主窗口',
      'sc.global': '全局快捷键（应用外也生效）',
      'sc.zoom': '放大 / 缩小 / 重置界面缩放（Ctrl+滚轮同样生效）',
      // v1.2.1 批次 12：桌面宠物
      'pet.cardTitle': '桌宠',
      'pet.toggleTitle': '显示/隐藏桌宠',
      'pet.cardHint': '透明置顶小窗 + 精灵图动画；糖码运行/工具/审批时宠物会做反应。托盘右键或本卡均可开关。',
      'pet.enabled': '显示桌宠',
      'pet.pet': '宠物',
      'pet.import': '导入桌宠',
      'pet.importBtn': '选择文件夹…',
      'pet.scale': '大小',
      'pet.position': '位置',
      'pet.resetPos': '复位位置（屏幕右下角）',
      'pet.roamMode': '位置模式',
      'pet.roamFree': '自由漫游',
      'pet.roamFixed': '固定位置',
      'pet.alwaysOnTop': '保持置顶',
      // v1.2.1 批次 9：侧栏 / composer / 糖馆 / 设置 第二批（渐进迁移：只收静态 chrome 与高频文案）
      'sidebar.collapse': '收起侧边栏',
      'sidebar.expand': '展开侧边栏',
      'sidebar.searchPlaceholder': '搜索对话',
      'sidebar.avatarTitle': '点击更换头像（右键恢复默认）',
      'sidebar.nameTitle': '点击修改用户名',
      'sidebar.theme': '切换主题',
      'composer.editBanner': '正在编辑上一条消息，发送后将重新生成回复',
      'composer.editCancel': '取消编辑',
      'composer.think': '深度思考强度',
      'composer.thinkOff': '关',
      'composer.thinkLow': '思考·低',
      'composer.thinkMedium': '思考·中',
      'composer.thinkHigh': '思考·高',
      'composer.web': '联网搜索',
      'composer.model': '模型',
      'composer.float': '置顶浮窗',
      'composer.inputPlaceholder': '给糖包发送消息（Enter 发送，Shift+Enter 换行）',
      'composer.image': '图片',
      'composer.attach': '附件（文本文件）',
      'composer.snippet': '快捷短语',
      'composer.send': '发送',
      'tg.tab.characters': '角色',
      'tg.tab.sessions': '会话',
      'tg.tab.groups': '群聊',
      'tg.new': '＋ 新建角色',
      'tg.newGroup': '＋ 新建群聊',
      'tg.import': '导入角色卡',
      'tg.exportAll': '导出全部',
      'tg.libraryExpand': '会话',
      'tg.emptyTitle': '从一个角色开始',
      'tg.emptyDesc': '创建或导入角色卡，开始一段沉浸式会话。',
      'tg.emptyNew': '新建角色',
      'tg.emptyImport': '导入角色卡',
      'settings.language': '界面语言',
      'settings.languageHint': '切换界面显示语言，即时生效并随设置持久化。',
      // v1.2.1 第五轮反馈：宠物独立面板 + 导入格式说明
      'pet.importFormatTitle': '导入格式说明',
      'pet.importFormatSheet': '精灵图文件名任意（webp / png / jpg）—— 横向排帧：每格默认 192×208、每行 8 格（可用 meta.json 的 cellWidth / cellHeight / cols 自定义任意规格）；高为每格的整数倍，行序固定：待机/右走/左走/挥手/跳跃/失败/等待/走动/回顾。',
      'pet.importFormatMeta': 'meta.json 可选（缺省用文件夹名生成 id 并自动补写）；行尾空白格自动忽略。内置 fat-guga 可作模板；素材请用可自由分发者，仅存本机。',
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
      'panel.pet': 'Pet',
      'panel.data': 'Data',
      'panel.help': 'Help',
      'panel.skills': 'Skills',
      'help.aboutTitle': 'About',
      'help.modulesTitle': 'Modules',
      'help.shortcutsTitle': 'Shortcuts',
      'sc.newChat': 'New chat',
      'sc.localSearch': 'Local search',
      'sc.settings': 'Open settings',
      'sc.modules': 'Switch modules (sidebar order)',
      'sc.palette': 'Command palette',
      'sc.globalFloat': 'Global show/hide float window',
      'sc.mainToggle': 'Global show/hide main window',
      'sc.global': 'Global shortcuts (work outside the app)',
      'sc.zoom': 'Zoom in / out / reset (Ctrl+wheel also works)',
      // v1.2.1 批次 12：桌面宠物
      'pet.cardTitle': 'Pet',
      'pet.toggleTitle': 'Show / hide pet',
      'pet.cardHint': 'A transparent always-on-top pet window. It reacts to agent runs/tools/approvals. Toggle via tray or this card.',
      'pet.enabled': 'Show pet',
      'pet.pet': 'Pet',
      'pet.import': 'Import pet',
      'pet.importBtn': 'Choose folder…',
      'pet.scale': 'Size',
      'pet.position': 'Position',
      'pet.resetPos': 'Reset position (bottom-right)',
      'pet.roamMode': 'Position mode',
      'pet.roamFree': 'Free roaming',
      'pet.roamFixed': 'Fixed position',
      'pet.alwaysOnTop': 'Always on top',
      // v1.2.1 批次 9：第二批
      'sidebar.collapse': 'Collapse sidebar',
      'sidebar.expand': 'Expand sidebar',
      'sidebar.searchPlaceholder': 'Search chats',
      'sidebar.avatarTitle': 'Click to change avatar (right-click to reset)',
      'sidebar.nameTitle': 'Click to edit your name',
      'sidebar.theme': 'Toggle theme',
      'composer.editBanner': 'Editing the last message; sending will regenerate the reply',
      'composer.editCancel': 'Cancel editing',
      'composer.think': 'Thinking depth',
      'composer.thinkOff': 'Off',
      'composer.thinkLow': 'Think · Low',
      'composer.thinkMedium': 'Think · Medium',
      'composer.thinkHigh': 'Think · High',
      'composer.web': 'Web search',
      'composer.model': 'Model',
      'composer.float': 'Pinned float window',
      'composer.inputPlaceholder': 'Message Tangbao (Enter to send, Shift+Enter for newline)',
      'composer.image': 'Image',
      'composer.attach': 'Attachment (text files)',
      'composer.snippet': 'Quick phrases',
      'composer.send': 'Send',
      'tg.tab.characters': 'Characters',
      'tg.tab.sessions': 'Sessions',
      'tg.tab.groups': 'Groups',
      'tg.new': '＋ New character',
      'tg.newGroup': '＋ New group',
      'tg.import': 'Import card',
      'tg.exportAll': 'Export all',
      'tg.libraryExpand': 'Sessions',
      'tg.emptyTitle': 'Start with a character',
      'tg.emptyDesc': 'Create or import a character card to begin an immersive session.',
      'tg.emptyNew': 'New character',
      'tg.emptyImport': 'Import card',
      'settings.language': 'Interface language',
      'settings.languageHint': 'Switch the UI language. Takes effect immediately and persists with settings.',
      // v1.2.1 第五轮反馈（第八轮收敛为两行）
      'pet.importFormatTitle': 'Import format',
      'pet.importFormatSheet': 'Any sprite sheet image (webp / png / jpg) — horizontal frames: cells default to 192×208, 8 per row (declare your own grid via cellWidth / cellHeight / cols in meta.json); height must be a multiple of the cell. Row order is fixed: idle / run-right / run-left / waving / jumping / failed / waiting / running / review.',
      'pet.importFormatMeta': 'meta.json is optional (the folder name becomes the id and one is generated for you); trailing blank cells are ignored automatically. The built-in fat-guga works as a template; use freely distributable assets — imports stay on this machine.',
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

  /** 扫描 data-i18n（textContent）/ data-i18n-title（title/aria-label）/ data-i18n-placeholder（placeholder）节点应用当前语言 */
  function applyDom(rootEl) {
    const root = rootEl || document;
    root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const v = t(el.dataset.i18nTitle);
      el.setAttribute('title', v);
      el.setAttribute('aria-label', v);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder)); });
  }

  App.i18n = { t, setLocale, getLocale, locales, applyDom };
})();
