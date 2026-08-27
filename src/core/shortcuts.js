'use strict';
/*
 * 快捷键统一词表（双环境单一事实源，模式同 models/capabilities.js）
 *   - 渲染进程：以 <script> 加载，挂到 window.App.ShortcutsCore
 *   - 主进程：以 require 加载（main-shortcuts.js 注册全局加速键前复用同一校验）
 *
 * 存储形态统一为渲染层词表：修饰键 Ctrl/Shift/Alt + 主键（Ctrl 在 macOS 语义为 Cmd），
 * 主键支持单字符、F1~F24、Comma/Period/Slash/Minus/Equal/Backquote/Space。
 * 全局加速键注册前经 toElectronAccelerator 转成 Electron 词表（Ctrl → CommandOrControl）。
 * 应用内（settings.shortcuts.app）与全局（settings.shortcuts.global）动作互不重叠：
 * 应用内组合键由渲染层 shortcuts.js 分发，全局加速键由主进程 main-shortcuts.js 注册。
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  if (typeof window !== 'undefined') {
    window.App = window.App || {};
    window.App.ShortcutsCore = mod;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // 应用内组合键默认值（Ctrl 在匹配时等价 macOS Cmd，与既有 Ctrl+K 行为一致）
  const DEFAULT_APP = { palette: 'Ctrl+K', newChat: 'Ctrl+N', search: 'Ctrl+F', settings: 'Ctrl+Comma' };
  // 全局加速键默认值（mainToggle 默认空=不注册；floatToggle 沿用 v1.1.7 起的 Ctrl+Shift+F）
  const DEFAULT_GLOBAL = { floatToggle: 'Ctrl+Shift+F', mainToggle: '' };

  const APP_ACTIONS = ['palette', 'newChat', 'search', 'settings'];
  const GLOBAL_ACTIONS = ['floatToggle', 'mainToggle'];

  const NAMED_KEYS = ['Comma', 'Period', 'Slash', 'Minus', 'Equal', 'Backquote', 'Space'];
  const MOD_TOKENS = { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt' };

  // 结构校验 + 归一化：合法返回规范串（修饰键定序 Ctrl+Shift+Alt、单字母大写），空串原样返回（显式禁用），非法返回 null
  function normalizeStored(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    const parts = s.split('+');
    const key = parts.pop();
    if (!key) return null;
    const mods = [];
    for (const part of parts) {
      const token = MOD_TOKENS[part.toLowerCase()];
      if (!token || mods.includes(token)) return null;
      mods.push(token);
    }
    const isChar = /^[A-Za-z0-9]$/.test(key);
    const isFn = /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
    if (!isChar && !isFn && !NAMED_KEYS.includes(key)) return null;
    const normKey = isChar ? key.toUpperCase() : key;
    return (mods.length ? mods.join('+') + '+' : '') + normKey;
  }

  // 键盘事件 → 规范组合串。无 Ctrl/Alt 修饰时返回 ''（纯 Shift/无修饰不劫持，输入框打字不受影响）；
  // 不可归类的按键（方向键/IME 等）返回 ''。ctrl 与 meta（macOS Cmd）等价。
  function comboFromEvent(ev) {
    if (!ev || typeof ev.key !== 'string') return '';
    const hasCtrl = !!(ev.ctrlKey || ev.metaKey);
    const hasAlt = !!ev.altKey;
    if (!hasCtrl && !hasAlt) return '';
    const mods = [];
    if (hasCtrl) mods.push('Ctrl');
    if (ev.shiftKey) mods.push('Shift');
    if (hasAlt) mods.push('Alt');
    let key = ev.key;
    const named = { ',': 'Comma', '.': 'Period', '/': 'Slash', '-': 'Minus', '_': 'Minus', '=': 'Equal', '+': 'Equal', '`': 'Backquote', ' ': 'Space' };
    if (named[key]) key = named[key];
    else if (/^[a-zA-Z0-9]$/.test(key)) key = key.toUpperCase();
    else if (!/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return '';
    return mods.join('+') + '+' + key;
  }

  // 组合串匹配：两侧都过 normalizeStored 后按修饰键集合+主键比较
  function matchesStored(stored, combo) {
    const a = normalizeStored(stored);
    const b = normalizeStored(combo);
    return !!a && a === b;
  }

  // 渲染层词表 → Electron 加速键（Ctrl 在 macOS 注册为 Cmd；Shift/Alt 原样）
  function toElectronAccelerator(stored) {
    const norm = normalizeStored(stored);
    if (!norm) return '';
    const mac = typeof process !== 'undefined' && process.platform === 'darwin';
    return norm.replace(/^Ctrl\+/, (mac ? 'Cmd' : 'Control') + '+');
  }

  return {
    DEFAULT_APP, DEFAULT_GLOBAL, APP_ACTIONS, GLOBAL_ACTIONS,
    normalizeStored, comboFromEvent, matchesStored, toElectronAccelerator,
  };
});
