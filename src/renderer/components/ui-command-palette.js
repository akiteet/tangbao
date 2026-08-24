'use strict';
/* 自 ui.js 拆分（v1.1.8 批次 C）：命令面板（openCommandPalette/closeCommandPalette/renderCommandPalette/runCommand）。
 * 模式同 agent 批次 E：独立 IIFE + Object.assign(window.App.ui, {...})，必须在 ui.js 之后加载；
 * 闭包辅助按批次 E 先例在本文件重声明。 */
(function () {
  window.App = window.App || {};
  const $ = (id) => document.getElementById(id);
  Object.assign(window.App.ui, {
    openCommandPalette() {
      const mask = $('commandPalette');
      const input = $('commandPaletteInput');
      if (!mask || !input) return;
      mask.hidden = false;
      input.value = '';
      App.ui.renderCommandPalette('');
      setTimeout(() => input.focus(), 0);
    },

    closeCommandPalette() {
      const mask = $('commandPalette');
      if (mask) mask.hidden = true;
    },

    async renderCommandPalette(query) {
      const box = $('commandPaletteResults');
      if (!box) return;
      const q = String(query || '').trim().toLowerCase();
      const commands = [
        { id: 'chat', title: '打开聊天', detail: '切换到糖包聊天' },
        { id: 'agent', title: '打开糖码', detail: '切换到 Agent 工作区' },
        { id: 'doc', title: '打开糖读', detail: '切换到文档模块' },
        { id: 'image', title: '打开图片', detail: '切换到图片模块' },
        { id: 'workflow', title: '打开 Workflow', detail: '切换到工作流模块' },
        { id: 'settings', title: '打开设置', detail: '账户、提示词和外观' },
        { id: 'data', title: '打开存储审计', detail: '迁移、备份、恢复和诊断' },
        { id: 'cache', title: '触发真实 Cache Probe', detail: '会发送两次 Provider 请求' },
      ].filter((item) => !q || (item.title + ' ' + item.detail).toLowerCase().includes(q));
      const local = [];
      const addLocal = (scope, id, title, detail) => {
        if (!title || (q && !(title + ' ' + detail).toLowerCase().includes(q))) return;
        local.push({ id: 'local:' + scope + ':' + id, title, detail });
      };
      const regularConversations = (App.state.conversations || []).filter((item) => !(item && (
        item.tavernCharacterId
        || item.originModule === 'tavern'
        || item.originModule === 'create'
      )));
      for (const item of regularConversations) addLocal('conversation', item.id, item.title || '未命名会话', '会话');
      for (const item of App.state.settings.docs || []) addLocal('document', item.id, item.name, '文档');
      for (const item of App.state.projects || []) addLocal('project', item.id, item.name, '糖码项目');
      for (const item of App.state.agentThreads || []) addLocal('run', item.id, item.title, '糖码会话');
      const items = commands.concat(local).slice(0, 30);
      box.innerHTML = items.length ? items.map((item, index) => `<button class="command-item${index === 0 ? ' active' : ''}" data-command="${App.escapeHtml(item.id)}"><span>${App.escapeHtml(item.title)}</span><small>${App.escapeHtml(item.detail || '')}</small></button>`).join('') : '<div class="command-empty">没有匹配项</div>';
      App.ui._commandItems = items;
    },

    runCommand(id) {
      const value = String(id || '');
      App.ui.closeCommandPalette();
      if (value.startsWith('local:conversation:')) {
        const id = value.slice('local:conversation:'.length);
        const conv = (App.state.conversations || []).find((item) => item && item.id === id);
        const stay = conv && (conv.tavernCharacterId || conv.originModule === 'tavern')
          ? 'tavern' : conv && conv.originModule === 'create' ? 'create' : undefined;
        App.chat.activate(id, stay ? { stay } : undefined);
        return;
      }
      if (value.startsWith('local:document:')) {
        const id = value.slice('local:document:'.length);
        App.router.go('doc');
        if (App.doc && typeof App.doc.switchDoc === 'function') App.doc.switchDoc(id);
        return;
      }
      if (value.startsWith('local:project:')) {
        const id = value.slice('local:project:'.length);
        App.router.go('agent');
        if (App.agent && typeof App.agent.switchProject === 'function') App.agent.switchProject(id);
        return;
      }
      if (value.startsWith('local:run:')) {
        const id = value.slice('local:run:'.length);
        App.router.go('agent');
        if (App.agent && typeof App.agent.switchThread === 'function') App.agent.switchThread(id);
        return;
      }
      if (value === 'settings' || value === 'data') {
        App.ui.openSettings();
        if (value !== 'settings') App.ui.selectSettingsPanel(value);
        return;
      }
      if (value === 'cache') {
        App.ui.openCacheProbe();
        return;
      }
      if (['chat', 'agent', 'doc', 'image', 'workflow'].includes(value)) {
        App.router.go(value === 'workflow' ? 'create' : value);
        return;
      }
    },
  });
})();
