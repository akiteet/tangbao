'use strict';

/* Isolated conversation storage for Tangguan and Create. */
(function () {
  App.services = App.services || {};
  const MODULES = new Set(['tavern', 'create']);
  const empty = (module) => ({
    format: 'tangbao-module-sessions',
    version: 1,
    module,
    revision: 0,
    activeId: null,
    conversations: [],
  });
  const validModule = (module) => MODULES.has(String(module || '')) ? String(module) : '';

  const invoke = (name, fallback, args) => App.services.ipc.invoke(name, args, fallback);

  App.services.moduleSessions = {
    status: 'pending',
    async load(module) {
      const name = validModule(module);
      if (!name) return { ok: false, code: 'unsupported_module', data: empty(String(module || '')) };
      const result = await invoke('moduleSessionsLoad', { ok: false, module: name, data: empty(name) }, [name]);
      if (!result.ok) this.status = 'failed';
      return result;
    },
    async list(module) {
      const name = validModule(module);
      if (!name) return { ok: false, code: 'unsupported_module', conversations: [], activeId: null };
      return invoke('moduleSessionsList', { ok: false, module: name, conversations: [], activeId: null }, [name]);
    },
    async get(module, id) {
      const name = validModule(module);
      if (!name) return { ok: false, code: 'unsupported_module', conversation: null };
      return invoke('moduleSessionsGet', { ok: false, module: name, conversation: null }, [name, id]);
    },
    async upsert(module, conversation, activeId) {
      const name = validModule(module);
      if (!name) return { ok: false, code: 'unsupported_module' };
      return invoke('moduleSessionsSave', { ok: false, module: name }, [name, conversation, activeId]);
    },
    async remove(module, id) {
      const name = validModule(module);
      if (!name) return { ok: false, code: 'unsupported_module' };
      return invoke('moduleSessionsRemove', { ok: false, module: name }, [name, id]);
    },
    async flushPartial(input) {
      const payload = input && typeof input === 'object' ? input : {};
      const name = validModule(payload.module);
      if (!name) return { ok: false, code: 'unsupported_module' };
      return invoke('moduleSessionsFlushPartial', { ok: false, code: 'ipc_unavailable' }, [Object.assign({}, payload, { module: name })]);
    },
    async migrateLegacy(state) {
      return invoke('moduleSessionsMigrateLegacy', { ok: false, code: 'ipc_unavailable', sourcePreserved: true }, [state || {}]);
    },
    async info() {
      return invoke('moduleSessionsInfo', { ok: false, modules: {} }, []);
    },
  };
})();
