'use strict';

// v1.2.0 批次 6：全局快捷键注册器（设置驱动）。
// 存储单一事实源在渲染层 state（settings.shortcuts.global），本工厂只负责：
// 启动时按持久化设置注册（whenReady 里调 applyAll）、用户改动后按传入表即时重注册
// （'shortcuts:setGlobal'，渲染层先落盘再调用）、注册失败可见（沿用批次 1a 先例）。
// 应用内组合键不在这里——归渲染层 shortcuts.js 分发，两者动作集互不重叠。
// electron 惰性获取：纯 Node 下 require('electron') 是路径字符串，测试环境可加载本模块。

const Core = require('../core/shortcuts');

function createMainShortcuts(deps) {
  const opts = deps && typeof deps === 'object' ? deps : {};
  const safeHandle = typeof opts.safeHandle === 'function' ? opts.safeHandle : null;
  const getSettings = typeof opts.getSettings === 'function' ? opts.getSettings : null;
  const actions = (opts.actions && typeof opts.actions === 'object') ? opts.actions : {};
  let globalShortcut = null;
  try {
    const el = require('electron');
    if (el && typeof el === 'object') globalShortcut = el.globalShortcut;
  } catch (_) {}

  // 持久化设置 → 生效表（缺失/非法回退默认；'' = 该动作不注册）
  function currentMap() {
    let raw = {};
    try {
      const st = getSettings();
      const sc = st && st.settings && st.settings.shortcuts;
      raw = (sc && typeof sc.global === 'object' && sc.global) || {};
    } catch (_) {}
    const map = {};
    for (const name of Core.GLOBAL_ACTIONS) {
      const hasOwn = Object.prototype.hasOwnProperty.call(raw, name);
      const norm = Core.normalizeStored(hasOwn ? raw[name] : Core.DEFAULT_GLOBAL[name]);
      map[name] = norm == null ? Core.DEFAULT_GLOBAL[name] : norm;
    }
    return map;
  }

  // 按表注册（先清本进程已注册项）；overrideMap 供 setGlobal 在渲染层落盘前即时生效
  function applyAll(overrideMap) {
    const results = {};
    if (!globalShortcut) {
      for (const name of Core.GLOBAL_ACTIONS) results[name] = { accelerator: '', ok: false, disabled: true };
      return results;
    }
    try { globalShortcut.unregisterAll(); } catch (_) {}
    const map = (overrideMap && typeof overrideMap === 'object') ? overrideMap : currentMap();
    for (const name of Core.GLOBAL_ACTIONS) {
      const stored = String(map[name] || '');
      if (!stored) { results[name] = { accelerator: '', ok: true, disabled: true }; continue; }
      const accel = Core.toElectronAccelerator(stored);
      let ok = false;
      try {
        ok = globalShortcut.register(accel, () => {
          try { if (typeof actions[name] === 'function') actions[name](); } catch (_) {}
        });
      } catch (_) {}
      results[name] = { accelerator: stored, ok };
      if (!ok) console.warn('[糖包] 全局快捷键注册失败（可能被其他程序占用）：' + stored + '（' + name + '），可在 设置→帮助→快捷键 改用其他组合');
    }
    return results;
  }

  if (safeHandle) {
    safeHandle('shortcuts:setGlobal', async (_e, input) => {
      const inMap = (input && typeof input === 'object') ? input : {};
      const merged = currentMap();
      for (const name of Core.GLOBAL_ACTIONS) {
        if (!Object.prototype.hasOwnProperty.call(inMap, name)) continue;
        const norm = Core.normalizeStored(inMap[name]);
        if (norm == null) return { ok: false, code: 'invalid_accelerator', action: name, error: '非法组合键：' + String(inMap[name]) };
        merged[name] = norm;
      }
      return { ok: true, results: applyAll(merged) };
    });
  }

  return { applyAll, currentMap };
}

module.exports = { createMainShortcuts, _core: Core };
