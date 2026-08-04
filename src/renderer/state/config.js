'use strict';
(function () {
  window.App = window.App || {};

  // 配置导入 / 导出：把账户、智能体、模板、工作流、提示词、外观、模块开关序列化为 JSON。
  App.config = {
    collect() {
      const s = App.state.settings;
      return {
        app: 'tangbao',
        version: 1,
        exportedAt: new Date().toISOString(),
        accounts: s.accounts,
        defaultAccountId: s.defaultAccountId,
        providers: s.providers,
        agents: s.agents,
        templates: s.templates,
        workflows: s.workflows,
        prompts: s.prompts,
        appearance: s.appearance,
        enabledModules: s.enabledModules,
        customModules: s.customModules,
      };
    },

    export() {
      const data = App.config.collect();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tangbao-config-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      App.ui.toast('配置已导出');
    },

    async import(file) {
      try {
        const text = await file.text();
        const obj = JSON.parse(text);
        if (!obj || typeof obj !== 'object') throw new Error('格式无效');
        const s = App.state.settings;
        if (Array.isArray(obj.accounts)) s.accounts = obj.accounts;
        if (typeof obj.defaultAccountId === 'string') s.defaultAccountId = obj.defaultAccountId;
        if (obj.providers && typeof obj.providers === 'object') s.providers = obj.providers;
        if (Array.isArray(obj.agents)) s.agents = obj.agents;
        if (Array.isArray(obj.templates)) s.templates = obj.templates;
        if (Array.isArray(obj.workflows)) s.workflows = obj.workflows;
        if (obj.prompts && typeof obj.prompts === 'object') s.prompts = obj.prompts;
        if (obj.appearance && typeof obj.appearance === 'object') s.appearance = obj.appearance;
        if (Array.isArray(obj.enabledModules)) s.enabledModules = obj.enabledModules;
        if (Array.isArray(obj.customModules)) s.customModules = obj.customModules;
        App.persist();
        if (App.ui.applyAppearance) App.ui.applyAppearance();
        App.modules.renderNav();
        App.ui.refreshSettingsUI();
        App.ui.toast('配置已导入');
      } catch (e) {
        App.ui.toast('导入失败：' + (e && e.message ? e.message : String(e)));
      }
    },

    // M6：完整数据备份导出（含对话/图片/项目/线程，经系统保存对话框）
    async exportFull() {
      try {
        const r = await App.services.fs.exportState();
        if (!r) return;
        if (r.canceled) return;
        if (r.ok) App.ui.toast('完整数据已导出到：' + r.path);
        else App.ui.toast('导出失败：' + (r.error || '未知错误'));
      } catch (e) {
        App.ui.toast('导出失败：' + (e && e.message ? e.message : String(e)));
      }
    },

    // M6：完整数据备份导入（经系统打开对话框，覆盖当前数据前需确认）
    async importFull() {
      try {
        const r = await App.services.fs.importState();
        if (!r) return;
        if (r.canceled) return;
        if (!r.ok) { App.ui.toast('导入失败：' + (r.error || '未知错误')); return; }
        if (!window.confirm('导入将覆盖当前全部对话/设置/项目数据，且不可撤销。确定继续吗？')) return;
        const res = App.loadFromJson(r.data);
        if (res && res.ok) {
          App.ui.toast('完整数据已导入');
          if (App.ui.applyAppearance) App.ui.applyAppearance();
          App.modules.renderNav();
          if (App.ui.refreshSettingsUI) App.ui.refreshSettingsUI();
          if (App.router && App.router.go) App.router.go(App.state.view || 'chat');
        } else {
          App.ui.toast('导入失败：' + ((res && res.error) || '未知错误'));
        }
      } catch (e) {
        App.ui.toast('导入失败：' + (e && e.message ? e.message : String(e)));
      }
    },
  };
})();
