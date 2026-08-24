'use strict';
/*
 * 糖包运行时配置（本地服务地址 / 启动令牌）
 *
 * 主进程用「系统分配的随机端口 + 仅绑定 127.0.0.1」拉起两个本地服务：
 *   - 静态服务（托管前端 + /gateway 模型网关；本地文件经 tangbao-file:// 自定义协议读取）
 *   - 糖码后端（/api/agent 等）
 * 端口不再固定为 4280 / 3000，渲染进程必须在启动时向主进程索取。
 * 所有对本地服务的请求都要带 Authorization: Bearer <启动令牌>（见 App.rt.authHeaders）。
 */
(function () {
  window.App = window.App || {};

  const rt = {
    ready: false,
    appPort: 0,
    agentPort: 0,
    token: '',

    // 启动时调用一次；必须早于任何本地服务请求
    async init() {
      if (rt.ready) return rt;
      try {
        if (App.services && App.services.system && App.services.system.serverPorts) {
          const p = await App.services.system.serverPorts();
          if (p) {
            rt.appPort = Number(p.app) || 0;
            rt.agentPort = Number(p.agent) || 0;
            rt.token = String(p.token || '');
          }
        }
      } catch (e) {
        console.error('获取本地服务端口失败：', e);
      }
      // 非 Electron 环境（浏览器直开调试）退化为当前页面端口
      if (!rt.appPort) rt.appPort = Number(location.port) || 0;
      rt.ready = true;
      return rt;
    },

    // 静态服务源（= 当前页面同源）
    appOrigin() {
      return rt.appPort ? 'http://127.0.0.1:' + rt.appPort : location.origin;
    },
    // 糖码后端根地址；未就绪时返回 '' 由调用方兜底提示
    agentBase() {
      return rt.agentPort ? 'http://127.0.0.1:' + rt.agentPort : '';
    },
    gatewayUrl() {
      return rt.appOrigin() + '/gateway';
    },
    // M5（#254）：本地文件绝对路径 → 主进程登记 → 不透明 tangbao-file://<fileId>
    async localFileUrl(absPath) {
      if (App.services && App.services.shell && App.services.shell.registerLocalFile) {
        try {
          const r = await App.services.shell.registerLocalFile(absPath);
          if (r && r.ok && r.fileId) return 'tangbao-file://' + r.fileId;
        } catch (e) { console.error('[糖包] 注册本地文件失败：', e); }
      }
      return 'about:blank';
    },

    // 本地服务鉴权头：合并调用方自定义头，追加启动令牌
    authHeaders(extra) {
      const h = Object.assign({}, extra || {});
      if (rt.token) h['Authorization'] = 'Bearer ' + rt.token;
      return h;
    },

    /* ---------------- 密钥库（明文只存在于主进程） ---------------- */

    // 已保存密钥的引用集合；只知道「有没有」，不知道内容
    secretRefs: new Set(),
    secretsEncrypted: true,
    secretStoreState: 'uninitialized',
    secretStoreCode: '',
    secretStoreCount: 0,
    secretStoreCanCreateFresh: false,

    hasSecret(ref) {
      return !!ref && rt.secretRefs.has(ref);
    },
    async refreshSecrets() {
      try {
        if (!App.services.secrets || !App.services.secrets.listSecrets) return null;
        const r = await App.services.secrets.listSecrets();
        const status = (r && r.status) || {};
        rt.secretStoreState = String(status.state || (r && r.ok === false ? 'unavailable' : 'ready'));
        rt.secretStoreCode = String(status.code || (r && r.code) || '');
        rt.secretStoreCount = Number(status.count != null ? status.count : ((r && r.refs) || []).length) || 0;
        rt.secretStoreCanCreateFresh = status.canCreateFresh === true;
        if (r && typeof r.encrypted === 'boolean') rt.secretsEncrypted = r.encrypted;
        // 读取失败时不能用空 refs 覆盖已有状态，否则 UI 会把“无法解密”显示成“未配置”。
        if (!r || r.ok === false || rt.secretStoreState === 'unavailable') return r || { ok: false };
        rt.secretRefs = new Set((r && r.refs) || []);
        return r;
      } catch (e) {
        rt.secretStoreState = 'unavailable';
        rt.secretStoreCode = 'secret_store_unavailable';
        console.error('读取密钥列表失败：', e);
        return { ok: false, code: rt.secretStoreCode };
      }
    },
    async setSecret(ref, value) {
      const r = await App.services.secrets.setSecret(ref, value);
      if (r && r.ok) {
        if (value) rt.secretRefs.add(ref); else rt.secretRefs.delete(ref);
        rt.secretStoreState = 'ready';
        rt.secretStoreCode = '';
        if (typeof r.count === 'number') rt.secretStoreCount = r.count;
        if (typeof r.encrypted === 'boolean') rt.secretsEncrypted = r.encrypted;
      }
      return r || { ok: false };
    },
    async resetSecretStore() {
      const r = await App.services.secrets.resetSecretStore();
      if (r && r.ok) {
        rt.secretRefs = new Set();
        rt.secretStoreState = 'ready';
        rt.secretStoreCode = '';
        rt.secretStoreCount = 0;
        rt.secretStoreCanCreateFresh = false;
        rt.secretsEncrypted = r.encrypted !== false;
      }
      return r || { ok: false };
    },
    async deleteSecret(ref) {
      const r = await App.services.secrets.deleteSecret(ref);
      if (r && r.ok) rt.secretRefs.delete(ref);
      return r || { ok: false };
    },
    async deleteSecretsByPrefix(prefix) {
      const r = await App.services.secrets.deleteSecretsByPrefix(prefix);
      if (r && r.ok) {
        for (const k of Array.from(rt.secretRefs)) if (k.startsWith(prefix)) rt.secretRefs.delete(k);
      }
      return r || { ok: false };
    },

    /* ---------------- 模型网关 ---------------- */

    // 把当前所有「密钥引用 → API Base」同步给主进程网关。
    // 任何改动账户/自定义地址的地方保存后都要调一次（App.persist 里已统一调用）。
    async syncEndpoints() {
      try {
        if (!App.services.gateway || !App.services.gateway.setEndpoints) return;
        const s = (window.App && App.state && App.state.settings) || {};
        const list = [];
        for (const a of (s.accounts || [])) {
          if (a && a.id && a.apiBase) list.push({ ref: 'acc:' + a.id, apiBase: a.apiBase });
        }
        for (const m of Object.keys(s.providers || {})) {
          const p = s.providers[m];
          if (p && p.accountId === '__custom__' && p.apiBase) list.push({ ref: 'custom:' + m, apiBase: p.apiBase });
        }
        await App.services.gateway.setEndpoints(list);
      } catch (e) { console.error('同步模型网关地址失败：', e); }
    },

    // M3 存储层：把归一化后的 App.state 灌入 SQLite（better-sqlite3 不可用则主进程返回 {ok:false}，此处静默忽略）
    async migrateStorage(stateJson) {
      try {
        return await App.services.fs.migrateStorage(stateJson);
      } catch (e) { console.warn('[存储层] 迁移失败（不影响启动）：', e); return { ok: false }; }
    },

    // M4 写穿：整库替换进 SQLite（主数据源）。失败静默（state.json 仍双写兜底）
    async syncStorage(stateJson) {
      try {
        return await App.services.fs.syncStorage(stateJson);
      } catch (e) { console.warn('[存储层] 同步失败（state.json 仍兜底）：', e); return { ok: false }; }
    },

    // M4 读源：从 SQLite 重建 App.state；空/不可用/落后 → {ok:false}（调用方回退 state.json）
    async loadStorage() {
      try {
        return await App.services.fs.loadStorage();
      } catch (e) { console.warn('[存储层] 读取失败（回退 state.json）：', e); return { ok: false }; }
    },

    // 统一的模型调用入口。渲染进程只给 ref（密钥引用）+ kind（路径白名单）+ payload，
    // 目标地址和密钥都由主进程解析，前端既指定不了转发目标，也接触不到密钥。
    normalizeGatewayKind(kind) {
      const aliases = { tavern: 'chat', create: 'chat', workflow: 'chat', 'tavern/chat': 'chat', 'create/chat': 'chat' };
      const source = kind && typeof kind === 'object'
        ? (kind.kind || kind.type || kind.requestType)
        : kind;
      const value = String(source || 'chat').trim().toLowerCase();
      return aliases[value] || value || 'chat';
    },

    sanitizeGatewayPayload(value) {
      // Renderer-only policy flags must never reach a provider, including from
      // legacy module callers that still attach them to nested options.
      const policyFields = new Set(['web', 'allowWeb', 'allowAttachments', 'allowTools', 'providerModule', 'requestKind']);
      const clean = (item) => {
        if (Array.isArray(item)) return item.map(clean);
        if (!item || typeof item !== 'object') return item;
        const output = {};
        Object.entries(item).forEach(([key, value]) => {
          if (!policyFields.has(key)) output[key] = clean(value);
        });
        return output;
      };
      return clean(value && typeof value === 'object' ? value : {});
    },

    gatewayRequest(opts) {
      const o = opts || {};
      return {
        ref: o.ref,
        // Tavern/Create are module owners, not provider protocols. The
        // request body must always use the canonical chat gateway kind.
        kind: rt.normalizeGatewayKind(o.kind || o.type || o.requestType),
        payload: rt.sanitizeGatewayPayload(o.payload),
        telemetry: o.telemetry || undefined,
      };
    },

    gatewayFetch(opts) {
      const o = opts || {};
      return fetch(rt.gatewayUrl(), {
        method: 'POST',
        headers: rt.authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(rt.gatewayRequest(o)),
        signal: o.signal,
      });
    },

    /* ---------------- 明文密钥迁移（1.0.5 → 1.0.6，只跑一次） ---------------- */

    // 老版本把 apiKey 明文写在 state.json / localStorage 里。这里把它们搬进系统密钥库：
    // 加密写入 → 主进程回读校验 → 校验通过才删掉明文字段。任一步失败就保留明文，
    // 宁可这次没迁移成功，也不能把用户的 Key 弄丢。
    async migrateSecrets() {
      const s = (window.App && App.state && App.state.settings) || {};
      const jobs = [];
      for (const a of (s.accounts || [])) {
        if (a && a.id && typeof a.apiKey === 'string' && a.apiKey.trim()) {
          jobs.push({ ref: 'acc:' + a.id, key: a.apiKey.trim(), owner: a });
        }
      }
      for (const m of Object.keys(s.providers || {})) {
        const p = s.providers[m];
        if (p && typeof p.apiKey === 'string' && p.apiKey.trim()) {
          jobs.push({ ref: 'custom:' + m, key: p.apiKey.trim(), owner: p });
        }
      }
      if (s.search && typeof s.search.apiKey === 'string' && s.search.apiKey.trim()) {
        jobs.push({ ref: 'search', key: s.search.apiKey.trim(), owner: s.search });
      }
      let moved = 0;
      if (jobs.length && App.services.secrets.setSecret) {
        for (const j of jobs) {
          try {
            const r = await rt.setSecret(j.ref, j.key);
            if (r && r.ok) { delete j.owner.apiKey; moved++; }
            else console.error('密钥迁移失败（已保留明文）：', j.ref, r && r.error);
          } catch (e) { console.error('密钥迁移异常（已保留明文）：', j.ref, e); }
        }
      }
      // 顺手清掉历史遗留的空 apiKey 字段，避免它们继续出现在 state.json 里
      for (const a of (s.accounts || [])) if (a && !a.apiKey) delete a.apiKey;
      for (const m of Object.keys(s.providers || {})) {
        const p = s.providers[m];
        if (p && !p.apiKey) delete p.apiKey;
      }
      if (s.search && !s.search.apiKey) delete s.search.apiKey;
      return moved;
    },

    // 从网关响应里取错误文案（网关失败时返回 { error: { message } }）
    async gatewayError(res) {
      try {
        const t = await res.text();
        try {
          const j = JSON.parse(t);
          return (j && j.error && (j.error.message || j.error)) || t;
        } catch (_) { return t; }
      } catch (_) { return '未知错误'; }
    },
  };

  // 浮窗初始化消息抢注 + 缓冲。
  // 主进程在 did-finish-load 就会 send('float:init')，而 boot() 现在要先 await 端口，
  // 若等 boot 里再注册监听就可能错过这条消息（浮窗显示空白）。这里在脚本解析阶段就注册。
  rt._floatInitRaw = null;
  rt._floatInitCb = null;
  if (App.services && App.services.float && App.services.float.onInit) {
    App.services.float.onInit((raw) => {
      if (rt._floatInitCb) rt._floatInitCb(raw);
      else rt._floatInitRaw = raw; // 先缓冲，等 boot 注册回调后补发
    });
  }
  rt.onFloatInit = function (cb) {
    rt._floatInitCb = cb;
    if (rt._floatInitRaw != null) {
      const raw = rt._floatInitRaw;
      rt._floatInitRaw = null;
      cb(raw);
    }
  };

  // 提前发起端口请求（不阻塞脚本解析），boot() 里 await 时通常已完成
  rt._initPromise = rt.init();

  App.rt = rt;
})();
