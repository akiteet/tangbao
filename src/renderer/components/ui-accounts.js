'use strict';
/* 自 ui.js 拆分（v1.1.8 批次 C）：密钥账户管理（renderAccounts/makeModelRow/renderModelRows/collectModelRows/toggleModelImage/openAccountForm/saveAccount/deleteAccount/setDefaultAccount）。
 * 模式同 agent 批次 E：独立 IIFE + Object.assign(window.App.ui, {...})，必须在 ui.js 之后加载；
 * 闭包辅助按批次 E 先例在本文件重声明。 */
(function () {
  window.App = window.App || {};
  const $ = (id) => document.getElementById(id);
  async function persistAndVerify() {
    const result = App.persist();
    if (!result || result.ok === false) return result || { ok: false, code: 'state_persist_failed' };
    const pending = App.__persistencePromise;
    if (pending && typeof pending.then === 'function') {
      try {
        const response = await pending;
        if (response && response.ok === false) return response;
      } catch (error) {
        return { ok: false, code: 'state_persist_failed', error: error && error.message ? error.message : String(error) };
      }
    }
    const status = App.__persistence;
    if (status && status.status === 'failed' && Number(status.revision) === Number(result.revision)) {
      return { ok: false, code: status.code || 'state_persist_failed', error: status.error || '' };
    }
    return { ok: true, revision: result.revision };
  }
  function cloneValue(value) {
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  }
  Object.assign(window.App.ui, {
    /* ---------- 密钥账户管理 ---------- */
    renderAccounts() {
      const list = $('accountList');
      if (!list) return;
      const s = App.state.settings;
      if (!s.accounts.length) {
        list.innerHTML = '<div class="history-empty">还没有账户，点击下方“+ 添加账户”。</div>';
        return;
      }
      list.innerHTML = s.accounts.map(a => {
        const isDef = a.id === s.defaultAccountId;
        return `<div class="account-row" draggable="true" data-id="${a.id}">
          <span class="drag-handle" title="拖拽排序">⠿</span>
          <div class="account-meta">
            <div class="account-name">${App.escapeHtml(a.name)}${isDef ? ' <span class="tag-default">默认</span>' : ''}</div>
            <div class="account-sub">${App.escapeHtml(a.apiBase || '')} · ${App.escapeHtml(((a.models && a.models.length) ? a.models.map(x => (typeof x === 'string') ? x : (x && x.name ? x.name : '')).filter(Boolean) : (a.model ? [a.model] : [])).join('、') || '无模型')}</div>
          </div>
          <div class="account-ops">
            ${isDef ? '' : '<button class="mini" data-act="def">设为默认</button>'}
            <button class="mini" data-act="edit">编辑</button>
            <button class="mini danger" data-act="del">删除</button>
          </div>
        </div>`;
      }).join('');
      // M8：自由拖拽排序 → dragend 按 DOM 顺序重建 accounts
      App.ui.bindModuleDrag(list, () => {
        const ids = Array.from(list.querySelectorAll('.account-row')).map(r => r.dataset.id);
        const accMap = {};
        s.accounts.forEach(a => { accMap[a.id] = a; });
        s.accounts = ids.map(id => accMap[id]).filter(Boolean);
        App.persist();
        App.ui.renderAccounts();
      }, '.account-row');
    },

    // 生成一行模型输入（对话/文本模型 或 图像生成模型）
    makeModelRow(v, isImage) {
      const row = document.createElement('div');
      row.className = 'model-row' + (isImage ? ' model-row-image' : '');
      row.draggable = true;
      const handle = document.createElement('span');
      handle.className = 'drag-handle'; handle.textContent = '⠿'; handle.title = '拖拽排序';
      const name = (v && typeof v === 'object') ? v.name : (v || '');
      const cw = (v && typeof v === 'object' && v.contextWindow) ? v.contextWindow : '';
      const input = document.createElement('input');
      input.type = 'text'; input.className = 'accModelRow';
      input.placeholder = '如 doubao-seed-1-6'; input.autocomplete = 'off';
      input.value = name;
      const cwInput = document.createElement('input');
      cwInput.type = 'number'; cwInput.className = 'accModelCtx';
      cwInput.placeholder = '128000'; cwInput.min = '4000'; cwInput.step = '1000';
      cwInput.title = '上下文窗口（token）';
      cwInput.value = cw;
      row.appendChild(handle); row.appendChild(input); row.appendChild(cwInput);
      if (isImage) {
        // 图像生成模型（糖绘专用）：协议 + 尺寸策略 + 自定义尺寸（内联紧凑）
        const imageProtocol = (v && typeof v === 'object' && v.imageProtocol) ? v.imageProtocol : 'auto';
        const imageSizeStrategy = (v && typeof v === 'object' && v.imageSizeStrategy) ? v.imageSizeStrategy : 'auto';
        const imageSizes = (v && typeof v === 'object' && Array.isArray(v.imageSizes)) ? v.imageSizes.join(', ') : '';
        const protoSel = document.createElement('select');
        protoSel.className = 'accModelImageProtocol';
        [['auto', '自动'], ['openai-images', 'OpenAI Images'], ['sensenova-images', 'SenseNova Images']]
          .forEach(([val, label]) => { const o = document.createElement('option'); o.value = val; o.textContent = label; protoSel.appendChild(o); });
        protoSel.value = imageProtocol;
        const strategySel = document.createElement('select');
        strategySel.className = 'accModelImageSizeStrategy';
        [['auto', '自动'], ['allow-list', '合法尺寸列表'], ['custom', '自定义尺寸']]
          .forEach(([val, label]) => { const o = document.createElement('option'); o.value = val; o.textContent = label; strategySel.appendChild(o); });
        strategySel.value = imageSizeStrategy;
        const sizesInput = document.createElement('input');
        sizesInput.type = 'text'; sizesInput.className = 'accModelImageSizes';
        sizesInput.placeholder = '1024x1024, 1792x1024'; sizesInput.autocomplete = 'off';
        sizesInput.value = imageSizes;
        row.appendChild(protoSel); row.appendChild(strategySel); row.appendChild(sizesInput);
      } else {
        // 对话/文本模型：最大输出 + 思考类型 + 能力预设
        const maxOutput = (v && typeof v === 'object' && v.maxOutput) ? v.maxOutput : '';
        const tt = (v && typeof v === 'object' && v.thinkType) ? v.thinkType : 'auto';
        const caps = (v && typeof v === 'object' && v.caps) ? v.caps : '';
        const outputInput = document.createElement('input');
        outputInput.type = 'number'; outputInput.className = 'accModelOutput';
        outputInput.placeholder = '默认'; outputInput.min = '256'; outputInput.step = '256';
        outputInput.title = '最大输出 token（留空使用供应商默认）';
        outputInput.value = maxOutput;
        const ttSel = document.createElement('select');
        ttSel.className = 'accModelThink';
        ttSel.title = '深度思考参数类型：按模型厂商选，不确定选「自动」';
        [['auto', '自动（推荐）'], ['openai', '强度档·OpenAI'], ['qwen', '开关式·Qwen'], ['none', '原生推理']]
          .forEach(([val, label]) => { const o = document.createElement('option'); o.value = val; o.textContent = label; ttSel.appendChild(o); });
        ttSel.value = tt;
        const capsSel = document.createElement('select');
        capsSel.className = 'accModelCaps';
        capsSel.title = '能力预设：决定是否给该模型发工具定义、能否收图片（不确定选「自动推断」）';
        [['', '自动推断'], ['tool_vision', '工具+视觉'], ['tool', '工具+文本'], ['vision', '仅视觉'], ['text', '纯文本']]
          .forEach(([val, label]) => { const o = document.createElement('option'); o.value = val; o.textContent = label; capsSel.appendChild(o); });
        capsSel.value = caps;
        row.appendChild(outputInput); row.appendChild(ttSel); row.appendChild(capsSel);
      }
      const toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'model-img-toggle';
      toggle.dataset.imgToggle = '1';
      toggle.textContent = isImage ? '→ 文本' : '→ 生图';
      toggle.title = isImage ? '改为对话/文本模型' : '设为图像生成模型（可配置协议与尺寸）';
      row.appendChild(toggle);
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'model-row-del'; btn.dataset.rm = '1'; btn.textContent = '×'; btn.title = '删除该模型';
      row.appendChild(btn);
      return row;
    },

    renderModelRows(models) {
      const box = $('accModels');
      const imgBox = $('accImageModels');
      if (!box || !imgBox) return;
      box.innerHTML = ''; imgBox.innerHTML = '';
      const list = (models && models.length) ? models : [''];
      const isImageModel = (m) => !!(m && typeof m === 'object' && (m.imageModel === true || m.imageProtocol || m.imageSizeStrategy || (Array.isArray(m.imageSizes) && m.imageSizes.length)));
      for (const m of list) {
        const img = isImageModel(m);
        (img ? imgBox : box).appendChild(App.ui.makeModelRow(m, img));
      }
      App.ui.bindModuleDrag(box, null, '.model-row');
      App.ui.bindModuleDrag(imgBox, null, '.model-row');
    },

    // 从两个分区收集当前模型行（对话行不带图像字段；生图行带 imageModel + 图像字段）
    collectModelRows() {
      const out = [];
      const read = (container, isImage) => {
        if (!container) return;
        container.querySelectorAll('.model-row').forEach((row) => {
          const nameInput = row.querySelector('.accModelRow');
          const ctxInput = row.querySelector('.accModelCtx');
          const n = (nameInput && nameInput.value) ? nameInput.value.trim() : '';
          if (!n) return;
          const cw = (ctxInput && ctxInput.value) ? parseInt(ctxInput.value, 10) : 128000;
          const m = { name: n, contextWindow: (cw > 0) ? cw : 128000 };
          if (isImage) {
            const protoSel = row.querySelector('.accModelImageProtocol');
            const strategySel = row.querySelector('.accModelImageSizeStrategy');
            const sizesInput = row.querySelector('.accModelImageSizes');
            const p = (protoSel && protoSel.value) ? protoSel.value : 'auto';
            const s = (strategySel && strategySel.value) ? strategySel.value : 'auto';
            const sz = (sizesInput && sizesInput.value)
              ? sizesInput.value.split(/[\s,;]+/).filter((x) => /^\d{3,5}x\d{3,5}$/.test(x)).slice(0, 32)
              : [];
            m.imageModel = true;
            if (p !== 'auto') m.imageProtocol = p;
            if (s !== 'auto') m.imageSizeStrategy = s;
            if (sz.length) m.imageSizes = sz;
          } else {
            const outputInput = row.querySelector('.accModelOutput');
            const ttSel = row.querySelector('.accModelThink');
            const capsSel = row.querySelector('.accModelCaps');
            const maxOutput = (outputInput && outputInput.value) ? parseInt(outputInput.value, 10) : 0;
            const tt = (ttSel && ttSel.value) ? ttSel.value : 'auto';
            const caps = (capsSel && capsSel.value) ? capsSel.value : '';
            m.thinkType = tt;
            if (maxOutput > 0) m.maxOutput = maxOutput;
            if (caps) m.caps = caps;
          }
          out.push(m);
        });
      };
      read($('accModels'), false);
      read($('accImageModels'), true);
      return out;
    },

    // 行内切换对话/生图分区（保留已填内容，仅翻转 imageModel 并重渲染）
    toggleModelImage(row) {
      const wasImage = row.classList.contains('model-row-image');
      const nameInput = row.querySelector('.accModelRow');
      const name = (nameInput && nameInput.value) ? nameInput.value.trim() : '';
      const all = App.ui.collectModelRows();
      let target = name ? all.find((m) => m.name === name) : null;
      if (!target) {
        target = { name, contextWindow: 128000 };
        if (!wasImage) target.thinkType = 'auto';
        all.push(target);
      }
      if (wasImage) {
        // 生图 → 对话：清图像字段
        delete target.imageProtocol; delete target.imageSizeStrategy; delete target.imageSizes; delete target.imageModel;
        if (!target.thinkType) target.thinkType = 'auto';
      } else {
        target.imageModel = true;
      }
      App.ui.renderModelRows(all);
    },

    // M8：账户编辑改为 modal 弹窗（点击「添加账户/编辑」才弹出；已保存账户列表保持原位）
    openAccountForm(id) {
      const modal = $('accountModal');
      const form = $('accountForm');
      if (!modal || !form) return;
      form.dataset.edit = id || '';
      const title = $('accountModalTitle');
      if (title) title.textContent = id ? '编辑账户' : '添加账户';
      if (id) {
        const a = App.state.settings.accounts.find(x => x.id === id);
        if (a) {
          $('accName').value = a.name; $('accBase').value = a.apiBase;
          App.ui.markKeyField($('accKey'), 'acc:' + id, '粘贴你的 API Key');
          App.ui.renderModelRows((a.models && a.models.length) ? a.models : (a.model ? [a.model] : []));
        }
      } else {
        $('accName').value = ''; $('accBase').value = '';
        App.ui.markKeyField($('accKey'), '__new__', '粘贴你的 API Key');
        App.ui.renderModelRows(['']);
      }
      // 行内切换对话/生图分区（事件委托，只绑一次）
      ['accModels', 'accImageModels'].forEach((cid) => {
        const box = $(cid);
        if (!box || box.dataset.imgToggleBound) return;
        box.dataset.imgToggleBound = '1';
        box.addEventListener('click', (e) => {
          const t = e.target.closest('[data-img-toggle]');
          if (!t) return;
          e.stopPropagation();
          const row = t.closest('.model-row');
          if (row) App.ui.toggleModelImage(row);
        });
      });
      modal.hidden = false;
      $('accName').focus();
    },

    closeAccountForm() {
      const modal = $('accountModal');
      if (modal) modal.hidden = true;
      const form = $('accountForm');
      if (form) form.dataset.edit = '';
    },

    async saveAccount() {
      const id = $('accountForm').dataset.edit || '';
      const previousAccount = id ? App.state.settings.accounts.find((item) => item.id === id) : null;
      const name = $('accName').value.trim();
      const apiBase = $('accBase').value.trim();
      const apiKey = $('accKey').value.trim();
      // 分区收集：对话/文本模型（无图像字段）+ 图像生成模型（imageModel + 协议/尺寸）
      const models = App.ui.collectModelRows();
      // 编辑已有账户时保留既有私有字段往返（timeoutMs/budget 等）；生图模型补回对话字段（切回对话不丢）
      if (previousAccount && Array.isArray(previousAccount.models)) {
        for (const m of models) {
          const prev = previousAccount.models.find((item) => (typeof item === 'string' ? item : item && item.name) === m.name);
          if (!prev || typeof prev !== 'object') continue;
          if (prev.timeoutMs > 0) m.timeoutMs = prev.timeoutMs;
          if (prev.budgetMaxSteps > 0) m.budgetMaxSteps = prev.budgetMaxSteps;
          if (prev.budgetMaxCostUsd >= 0) m.budgetMaxCostUsd = prev.budgetMaxCostUsd;
          if (m.imageModel) {
            if (prev.thinkType) m.thinkType = prev.thinkType;
            if (prev.caps) m.caps = prev.caps;
            if (prev.maxOutput > 0) m.maxOutput = prev.maxOutput;
          }
        }
      }
      // 编辑已有账户时 Key 允许留空，表示沿用密钥库里已保存的那把
      const hasSaved = !!(id && App.rt && App.rt.hasSecret && App.rt.hasSecret('acc:' + id));
      if (!name || !apiBase) { App.ui.toast('请填写名称和 API Base URL'); return; }
      if (!apiKey && !hasSaved) { App.ui.toast('请填写 API Key'); return; }
      if (!models.length) { App.ui.toast('请至少填写一个模型名称'); return; }
      if (apiKey && (!App.rt || !App.rt.setSecret)) { App.ui.toast('密钥库不可用，原密钥未覆盖；请先修复数据存储'); return; }
      const s = App.state.settings;
      const accId = id || App.uid();
      const before = cloneValue({ accounts: s.accounts, defaultAccountId: s.defaultAccountId, providers: s.providers });
      const restore = async () => {
        if (!before) return null;
        s.accounts = before.accounts;
        s.defaultAccountId = before.defaultAccountId;
        s.providers = before.providers;
        const result = await persistAndVerify();
        App.ui.refreshSettingsUI();
        App.ui.syncModelSelect();
        return result;
      };
      if (id) {
        const a = s.accounts.find(x => x.id === id);
        if (a) { Object.assign(a, { name, apiBase, models }); delete a.model; delete a.apiKey; }
      } else {
        s.accounts.push({ id: accId, name, apiBase, models });
        if (!s.defaultAccountId) s.defaultAccountId = accId;
      }
      // 配置先落盘并确认成功，避免密钥已经更新但账户配置因写盘失败而消失。
      const persisted = await persistAndVerify();
      if (!persisted || !persisted.ok) {
        await restore();
        App.ui.toast('账户保存失败，原账户配置已恢复：' + ((persisted && (persisted.error || persisted.code)) || '数据目录不可写'));
        return { ok: false, code: persisted && persisted.code || 'account_state_write_failed', preserved: true };
      }
      // 只有账户配置确认落盘后才写入新 Key。若密钥写入失败，恢复整个账户快照。
      if (apiKey && App.rt && App.rt.setSecret) {
        const r = await App.rt.setSecret('acc:' + accId, apiKey);
        if (!r || !r.ok) {
          const restored = await restore();
          App.ui.toast('密钥保存失败，' + (restored && restored.ok ? '原账户配置已恢复：' : '账户配置也未能确认恢复，请检查数据目录：') + ((r && (r.code || r.error)) || 'key_write_failed'));
          return { ok: false, code: r && r.code || 'key_write_failed', preserved: !!(restored && restored.ok), nextAction: 'repair_secret_store' };
        }
        try { if (App.rt.syncEndpoints) await App.rt.syncEndpoints(); } catch (_) {}
      }
      App.ui.refreshSettingsUI();
      App.ui.syncModelSelect();
      App.ui.closeAccountForm();
      App.ui.toast(id ? '账户已保存' : '已添加账户');
    },

    async deleteAccount(id) {
      const s = App.state.settings;
      const before = cloneValue({ accounts: s.accounts, defaultAccountId: s.defaultAccountId, providers: s.providers });
      const restore = async () => {
        if (!before) return null;
        s.accounts = before.accounts;
        s.defaultAccountId = before.defaultAccountId;
        s.providers = before.providers;
        const result = await persistAndVerify();
        App.ui.refreshSettingsUI();
        App.ui.syncModelSelect();
        return result;
      };
      s.accounts = s.accounts.filter(a => a.id !== id);
      // 账户没了，它的 Key 也不该继续留在系统密钥库里
      if (s.defaultAccountId === id) s.defaultAccountId = s.accounts.length ? s.accounts[0].id : '';
      // 清理引用了被删账户的模块选择
      for (const m of ['default', 'chat', 'agent', 'create', 'tavern', 'image', 'doc']) {
        const p = s.providers[m];
        if (p && p.accountId === id) { p.accountId = '__default__'; p.model = ''; }
      }
      const persisted = await persistAndVerify();
      if (!persisted || !persisted.ok) {
        await restore();
        App.ui.toast('账户删除失败，原账户配置已恢复：' + ((persisted && (persisted.error || persisted.code)) || '数据目录不可写'));
        return { ok: false, code: persisted && persisted.code || 'account_state_write_failed', preserved: true };
      }
      if (App.rt && App.rt.deleteSecret) {
        const secretResult = await App.rt.deleteSecret('acc:' + id);
        if (!secretResult || !secretResult.ok) {
          const restored = await restore();
          App.ui.toast('密钥删除失败，' + (restored && restored.ok ? '账户已恢复：' : '账户状态也未能确认恢复，请检查数据目录：') + ((secretResult && (secretResult.code || secretResult.error)) || 'key_delete_failed'));
          return { ok: false, code: secretResult && secretResult.code || 'key_delete_failed', preserved: !!(restored && restored.ok), nextAction: 'retry_delete' };
        }
      }
      App.ui.refreshSettingsUI();
      App.ui.syncModelSelect();
      return { ok: true };
    },

    setDefaultAccount(id) {
      App.state.settings.defaultAccountId = id;
      App.persist();
      App.ui.refreshSettingsUI();
    },
  });
})();
