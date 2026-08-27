'use strict';
/* 自 ui.js 拆分（v1.1.8 批次 C）：数据目录/存储审计/密钥库/模型健康与指标（区块 11-13）。
 * 模式同 agent 批次 E：独立 IIFE + Object.assign(window.App.ui, {...})，必须在 ui.js 之后加载；
 * 闭包辅助按批次 E 先例在本文件重声明。 */
(function () {
  window.App = window.App || {};
  const $ = (id) => document.getElementById(id);
  function storageLocationMessage(result, fallback) {
    const item = result || {};
    const raw = String(item.error || '');
    const code = String(item.code || '');
    const systemCode = String(item.systemCode || '');
    const target = item.path || item.target || item.targetRoot || '';
    if (code === 'location_not_writable' || ['EPERM', 'EACCES'].includes(systemCode) || /\b(EPERM|EACCES)\b/i.test(raw)) {
      return '所选目录没有写入权限' + (target ? '：' + target : '') + '。请换一个当前账户可写的目录，或授予当前 Windows 账户“修改”权限。';
    }
    if (code === 'same_location') return '新目录不能与当前数据目录相同。';
    if (code === 'nested_location') return '新目录不能位于当前数据目录内部，也不能包含当前数据目录。';
    if (code === 'active_agent_runs') return '当前还有运行中的任务，请等待任务结束后再迁移。';
    if (code === 'location_write_failed') return '无法写入数据目录指针，请检查默认数据目录权限。';
    return raw || code || fallback || '数据目录操作失败。';
  }
  Object.assign(window.App.ui, {
    async refreshStorageLocation() {
      const mode = $('storageLocationMode');
      const target = $('storageLocationPath');
      if (!mode || !target) return;
      const service = App.services.fs;
      const info = service && service.getStorageInfo ? await service.getStorageInfo() : { ok: false };
      if (!info || !info.ok) {
        mode.textContent = '当前环境无法读取数据目录';
        target.textContent = '';
        const audit = $('storageAuditParts');
        if (audit) audit.innerHTML = '<div class="storage-audit-empty">存储审计暂不可用</div>';
        return;
      }
      mode.textContent = info.mode === 'custom' ? '当前使用自定义数据目录（不占用默认 C 盘记录目录）' : '当前使用系统默认数据目录';
      target.textContent = info.recordsRoot || info.activeRoot || '';
      const migrationStatus = $('storageMigrationStatus');
      if (migrationStatus) {
        const migration = info.migration || {};
        const failed = !!info.startupMigration || migration.status === 'failed';
        migrationStatus.hidden = !failed;
        migrationStatus.textContent = failed
          ? '迁移失败，需要验证或恢复；当前仍使用旧数据，未自动删除原目录。'
          : (migration.status ? '迁移状态：' + migration.status : '');
      }
      const open = $('openStorageLocation');
      if (open) open.disabled = !info.activeRoot;
      App.ui.renderStorageAudit(info);
    },

    formatBytes(bytes) {
      const value = Number(bytes);
      if (!Number.isFinite(value) || value < 0) return '未知';
      if (value < 1024) return value + ' B';
      const units = ['KB', 'MB', 'GB', 'TB'];
      let n = value;
      let unit = 'B';
      for (const next of units) { n /= 1024; unit = next; if (n < 1024) break; }
      return n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2) + ' ' + unit;
    },

    renderStorageAudit(info) {
      const box = $('storageAuditParts');
      const status = $('storageMigrationStatus');
      if (!box) return;
      const parts = Array.isArray(info.parts) ? info.parts : [];
      box.innerHTML = parts.map((part) => `
        <div class="storage-audit-item">
          <b>${App.escapeHtml(part.label || part.key || '存储')}</b>
          <span>${App.ui.formatBytes(part.bytes)} · ${Number(part.files) || 0} 个文件</span>
          <code>${App.escapeHtml(part.location || '')}</code>
        </div>`).join('') || '<div class="storage-audit-empty">暂无存储分区记录</div>';
      if (status) {
        const migration = info.migration || {};
        const startup = info.startupMigration;
        const consistency = info.audit && info.audit.stateConsistency;
        const warnings = [];
        if (info.database && info.database.available === false) warnings.push('SQLite 当前不可用，已明确使用 state.json 保存；原因：' + (info.database.reason || 'unknown'));
        if (startup) warnings.push('上次迁移失败：' + (startup.error || startup.code || '未知错误') + '；当前仍使用旧数据');
        if (migration.status === 'failed') warnings.push('迁移记录为失败，可先验证源目录和目标目录后再处理');
        if (consistency && consistency.status === 'inconsistent') warnings.push('state.json 与 SQLite 计数不一致，请先导出备份并检查');
        if (consistency && consistency.status === 'unknown') warnings.push('state.json 与 SQLite 一致性：无法确认（' + (consistency.reason || '未知原因') + '）');
        const trace = info.audit && info.audit.trace;
        if (trace && (trace.orphanEvents || []).length + (trace.invalidEvents || []).length) warnings.push('Trace 审计发现 ' + ((trace.orphanEvents || []).length + (trace.invalidEvents || []).length) + ' 个异常事件');
        status.classList.toggle('warn', warnings.length > 0);
        status.textContent = warnings.length
          ? warnings.join('；')
          : '迁移状态：' + (migration.status || (info.mode === 'custom' ? 'active' : 'default')) + '；SQLite：' + (info.database && info.database.integrity ? '完整性通过' : '未确认') + '；state/SQLite：' + (consistency && consistency.status || '未知');
      }
    },

    async verifyStorageMigration() {
      const button = $('verifyStorageMigration');
      if (!button || !App.services.fs || !App.services.fs.verifyStorageMigration) return;
      button.disabled = true;
      const original = button.textContent;
      button.textContent = '验证中...';
      try {
        const result = await App.services.fs.verifyStorageMigration();
        if (result && result.ok) App.ui.toast('迁移验证通过：' + (result.files || []).length + ' 个文件');
        else App.ui.toast('迁移验证失败：' + ((result && (result.error || result.code)) || '请查看存储状态'));
        await App.ui.refreshStorageLocation();
      } finally {
        button.disabled = false;
        button.textContent = original;
      }
    },

    async previewStorageCleanup() {
      const box = $('storageCleanupPreview');
      const cleanButton = $('cleanupStorageLegacy');
      if (!box || !App.services.fs || !App.services.fs.cleanupPreview) return;
      const result = await App.services.fs.cleanupPreview();
      if (!result || !result.ok) {
        box.hidden = false;
        box.textContent = '清理预览失败：' + ((result && result.error) || '未知错误');
        if (cleanButton) cleanButton.hidden = true;
        return;
      }
      App.ui._cleanupPreviewId = result.previewId || '';
      const items = Array.isArray(result.items) ? result.items : [];
      box.hidden = false;
      box.innerHTML = items.length
        ? '<strong>将移动到时间戳隔离目录，不会永久删除：</strong>' + items.map((item) => `<div>${App.escapeHtml(item.name)} · ${App.ui.formatBytes(item.bytes)}<code>${App.escapeHtml(item.location || '')}</code></div>`).join('')
        : '<strong>没有可清理的旧目录内容。</strong>';
      if (cleanButton) cleanButton.hidden = !items.length;
    },

    async cleanupStorageLegacy() {
      const previewId = App.ui._cleanupPreviewId || '';
      if (!previewId || !window.confirm('确认把预览中的旧目录内容移动到隔离目录？不会永久删除。')) return;
      const result = await App.services.fs.cleanupLegacy({ previewId });
      if (result && result.ok) App.ui.toast('已隔离 ' + (result.cleaned || []).length + ' 项；位置：' + result.quarantine);
      else App.ui.toast('隔离失败：' + ((result && result.error) || '未知错误'));
      App.ui._cleanupPreviewId = '';
      const cleanButton = $('cleanupStorageLegacy');
      if (cleanButton) cleanButton.hidden = true;
      await App.ui.refreshStorageLocation();
    },

    async backupStorage() {
      const result = await (App.services.fs && App.services.fs.backupStorage ? App.services.fs.backupStorage({}) : null);
      if (result && result.ok) App.ui.toast('脱敏备份已导出：' + result.filePath);
      else if (!(result && result.canceled)) App.ui.toast('备份失败：' + ((result && result.error) || '未知错误'));
    },

    async restoreStorage() {
      if (!window.confirm('恢复会覆盖当前 state.json，并保留恢复前备份。确认继续吗？')) return;
      const result = await (App.services.fs && App.services.fs.restoreStorage ? App.services.fs.restoreStorage({}) : null);
      if (!result || !result.ok) {
        if (!(result && result.canceled)) App.ui.toast('恢复失败：' + ((result && result.error) || '未知错误'));
        return;
      }
      App.ui.toast('恢复完成，应用即将重启以加载数据');
      if (App.services.fs.relaunchApp) await App.services.fs.relaunchApp();
    },

    async exportStorageDiagnostics() {
      const result = await (App.services.fs && App.services.fs.exportDiagnostics ? App.services.fs.exportDiagnostics() : null);
      if (result && result.ok) App.ui.toast('脱敏诊断包已导出：' + result.filePath);
      else if (!(result && result.canceled)) App.ui.toast('诊断包导出失败：' + ((result && result.error) || '未知错误'));
    },

    refreshSecretStoreStatus() {
      const el = $('secretStoreStatus');
      if (!el) return;
      const rt = App.rt || {};
      const state = String(rt.secretStoreState || 'uninitialized');
      const count = Number(rt.secretStoreCount || 0);
      const canCreateFresh = state === 'unavailable' && rt.secretStoreCanCreateFresh === true;
      const resetButton = $('resetSecretStore');
      const recoveryHint = $('secretStoreRecoveryHint');
      if (resetButton) resetButton.hidden = !canCreateFresh;
      if (recoveryHint) {
        recoveryHint.hidden = state !== 'unavailable';
        recoveryHint.textContent = canCreateFresh
          ? '建立新密钥库不会恢复旧 Key；原密文会先完整备份，之后请在“账户”中重新填写 API Key。'
          : '系统密钥服务当前不可用，暂时不能建立加密密钥库；请完全退出糖包后，用当前 Windows 账户重新启动。';
      }
      el.classList.toggle('warn', state === 'unavailable' || rt.secretsEncrypted === false);
      if (state === 'unavailable') {
        if (rt.secretStoreCode === 'secret_decrypt_failed') {
          el.textContent = '密钥库无法解密已有密钥。请使用原 Windows 账户运行，或重新填写 Key；原密钥文件未被覆盖。';
        } else {
          el.textContent = '密钥库暂时不可用，无法确认已有 Key；原密钥文件未被覆盖。请检查系统安全存储或重启应用。';
        }
        return;
      }
      if (state === 'empty') {
        el.textContent = '密钥库已就绪，当前没有已保存的 Key。密钥保存在本机系统安全存储中。';
        return;
      }
      if (state === 'ready' && rt.secretsEncrypted === false) {
        el.textContent = '密钥库已加载 ' + count + ' 个引用，但当前系统无法加密存储；请检查系统密钥服务。';
        return;
      }
      if (state === 'ready') {
        el.textContent = '密钥库已加载 ' + count + ' 个引用，密钥保存在本机系统安全存储中。';
        return;
      }
      el.textContent = '正在读取本机系统密钥库...';
    },

    async diagnoseSecretStore() {
      const box = $('secretDiagnostics');
      if (!box || !App.services.secrets || !App.services.secrets.diagnose) return;
      box.hidden = false;
      box.textContent = '正在诊断...';
      const result = await App.services.secrets.diagnose();
      box.textContent = JSON.stringify(result || { ok: false }, null, 2);
    },

    async recoverLegacySecrets() {
      if (!window.confirm('将尝试使用旧数据目录中的密钥上下文恢复当前密钥库，并在覆盖前备份 Local State。继续吗？')) return;
      const result = await (App.services.secrets && App.services.secrets.recoverLegacy ? App.services.secrets.recoverLegacy() : null);
      if (result && result.ok) {
        if (App.rt && App.rt.refreshSecrets) await App.rt.refreshSecrets();
        App.ui.refreshSecretStoreStatus();
        App.ui.toast(result.recovered ? '旧密钥上下文恢复成功' : '未发现可恢复的旧密钥上下文');
      } else {
        App.ui.toast('密钥恢复失败：' + ((result && result.error) || '原密钥未覆盖'));
      }
      await App.ui.diagnoseSecretStore();
    },

    modelProviderFor(moduleId) {
      try {
        const module = String(moduleId || 'chat');
        const provider = App.getProvider(module) || { ref: '', model: '', apiBase: '' };
        if (!provider.accountId && String(provider.ref || '').startsWith('acc:')) provider.accountId = String(provider.ref).slice(4);
        return provider;
      } catch (_) { return { ref: '', model: '', apiBase: '' }; }
    },

    renderModelProfiles() {
      const box = $('modelProfileList');
      if (!box) return;
      const modules = [
        ['chat', '聊天'], ['agent', '糖码'], ['doc', '糖读'], ['image', '图片'], ['create', '糖创'], ['tavern', '糖馆'],
      ];
      box.innerHTML = modules.map(([id, label]) => {
        const provider = App.ui.modelProviderFor(id);
        const account = (App.state.settings.accounts || []).find((item) => item.id === provider.accountId);
        const profile = provider.profile || {};
        const caps = profile.caps || 'auto';
        const profileText = [
          (Number(profile.contextWindow) || 128000).toLocaleString() + ' ctx',
          profile.maxOutput ? Number(profile.maxOutput).toLocaleString() + ' out' : '输出默认',
          caps === 'auto' ? '能力自动' : caps,
          (Number(profile.timeoutMs) || 120000) + ' ms 超时',
          '≤' + (Number(profile.budgetMaxSteps) || 96) + ' 步',
        ].join(' · ');
        const edit = account ? `<button type="button" class="mini" data-model-profile-edit="${App.escapeHtml(account.id)}">编辑</button>` : '';
        return `<div class="model-profile-row"><b>${label}</b><span>${App.escapeHtml((account && account.name) || provider.ref || '未配置账户')}</span><code>${App.escapeHtml(provider.model || '未配置模型')}</code><em>${App.escapeHtml(profileText)}${provider.apiBase ? ' · 已配置地址' : ' · 未配置地址'}</em>${edit}</div>`;
      }).join('');
    },

    async runModelHealth() {
      const module = ($('modelHealthModule') && $('modelHealthModule').value) || 'chat';
      const resultBox = $('modelHealthResult');
      const provider = App.ui.modelProviderFor(module);
      if (!resultBox) return;
      if (!provider.ref || !provider.model) {
        resultBox.textContent = '请先在配置/账户中选择账户和模型。';
        return;
      }
      resultBox.textContent = '检查中...';
      const result = await App.services.gateway.modelHealth({ ref: provider.ref, model: provider.model, kind: module === 'image' ? 'images' : 'chat' });
      if (!result || result.ok === false) {
        const error = result && result.error;
        resultBox.textContent = '检查失败：' + ((error && (error.message || error.code)) || result.error || '未知错误');
        App.ui.notify('Provider 健康检查失败', module + ' / ' + provider.model);
        return;
      }
      const caps = Object.entries(result.capabilities || {}).filter(([, value]) => value !== undefined).map(([key, value]) => key + '=' + (typeof value === 'object' ? JSON.stringify(value) : value)).join(' · ');
      const cache = result.cacheSupport || (result.capabilities && result.capabilities.cache);
      const cacheText = cache && cache.supported === true ? 'Cache 可探测' : cache && cache.supported === false ? 'Cache 不支持/未知' : 'Cache 未知';
      resultBox.textContent = '连通：' + (result.apiReachable ? '是' : '否') + ' · Key：' + (result.keyConfigured ? '已配置' : '未配置') + ' · 模型：' + (result.modelExists === false ? '未找到' : result.modelExists === true ? '存在' : '未知') + ' · 首字节：' + (result.firstByteLatencyMs == null ? '未知' : result.firstByteLatencyMs + ' ms') + ' · 完整响应：' + (result.responseLatencyMs == null ? (result.latencyMs == null ? '未知' : result.latencyMs + ' ms') : result.responseLatencyMs + ' ms') + ' · ' + cacheText + (caps ? ' · ' + caps : '');
    },

    async runCacheProbe() {
      const module = ($('modelHealthModule') && $('modelHealthModule').value) || 'chat';
      const provider = App.ui.modelProviderFor(module);
      const resultBox = $('cacheProbeResult');
      if (!resultBox) return;
      if (!provider.ref || !provider.model) { resultBox.textContent = '请先选择可用账户和模型。'; return; }
      if (!window.confirm('真实 Cache Probe 会执行两次 Provider 请求，可能消耗额度。继续吗？')) return;
      resultBox.textContent = '正在执行冷/热请求...';
      const result = await App.services.gateway.probeCache({ ref: provider.ref, model: provider.model, kind: 'chat' });
      if (!result || result.ok === false) {
        resultBox.textContent = '探测失败：' + ((result && (result.error || result.code)) || '未知错误');
        App.ui.notify('Cache Probe 失败', provider.model);
        return;
      }
      const cache = result.cache || {};
      const pct = cache.hitRate == null ? '未知' : (cache.hitRate * 100).toFixed(1) + '%';
      resultBox.textContent = 'Cache：' + (cache.source || 'unknown') + ' · 命中率：' + pct + ' · 命中 Token：' + (cache.savedTokens == null ? '未知' : cache.savedTokens) + ' · 节省成本：' + (cache.estimatedSavedCostUsd == null ? '未知' : '$' + cache.estimatedSavedCostUsd) + (cache.unknownReason ? ' · 原因：' + cache.unknownReason : '');
      App.ui.notify('Cache Probe 完成', provider.model + ' · 命中率 ' + pct);
      await App.ui.refreshModelMetrics();
    },

    async refreshModelMetrics() {
      const box = $('modelMetricsList');
      if (!box || !App.services.gateway || !App.services.gateway.modelMetrics) return;
      box.innerHTML = '<div class="model-metrics-empty">读取中...</div>';
      const result = await App.services.gateway.modelMetrics({ limit: 20 });
      const items = result && Array.isArray(result.items) ? result.items : [];
      if (!items.length) { box.innerHTML = '<div class="model-metrics-empty">暂无模型调用指标</div>'; return; }
      box.innerHTML = items.map((item) => {
        const cache = item.cache || {};
        const cacheText = cache.hitRate == null ? 'Cache 未知' : 'Cache ' + (cache.hitRate * 100).toFixed(1) + '%';
        const tokens = item.inputTokens == null && item.outputTokens == null ? 'Token 未知' : (item.inputTokens == null ? '?' : item.inputTokens) + '/' + (item.outputTokens == null ? '?' : item.outputTokens) + ' tok';
        const cost = item.costUsd == null ? '成本未知' : '$' + item.costUsd;
        const latency = item.firstByteLatencyMs == null && item.responseLatencyMs == null ? (item.latencyMs == null ? '延迟未知' : item.latencyMs + ' ms') : '首字节 ' + (item.firstByteLatencyMs == null ? '未知' : item.firstByteLatencyMs + ' ms') + ' · 完整 ' + (item.responseLatencyMs == null ? '未知' : item.responseLatencyMs + ' ms');
        return `<div class="model-metric-row"><b>${App.escapeHtml(item.callType || item.scope || 'model')}</b><span>${App.escapeHtml(item.modelId || '未知模型')} · ${App.escapeHtml(item.status || 'unknown')}</span><em>${tokens} · ${cacheText} · ${cost} · ${latency}</em></div>`;
      }).join('');
    },

    async resetSecretStore() {
      const button = $('resetSecretStore');
      const rt = App.rt || {};
      if (!rt.resetSecretStore || rt.secretStoreCanCreateFresh !== true || (button && button.dataset.busy === '1')) return;
      if (!window.confirm('当前密钥库无法解密。建立新密钥库会保留原密文备份，但旧 API Key 需要重新填写。继续吗？')) return;
      if (button) {
        button.dataset.busy = '1';
        button.disabled = true;
        button.textContent = '正在备份并建立...';
      }
      try {
        const result = await rt.resetSecretStore();
        if (!result || !result.ok) {
          if (rt.refreshSecrets) await rt.refreshSecrets();
          App.ui.refreshSecretStoreStatus();
          App.ui.toast((result && result.error) || '建立新密钥库失败，原密钥文件未覆盖');
          return;
        }
        let moved = 0;
        if (rt.migrateSecrets) moved = await rt.migrateSecrets();
        if (moved) App.persist();
        if (rt.refreshSecrets) await rt.refreshSecrets();
        App.ui.refreshSecretStoreStatus();
        const suffix = result.backupFile ? '原密文已备份为 ' + result.backupFile : '原密文已保留';
        App.ui.toast('新的加密密钥库已建立；' + suffix + (moved ? '，已迁移 ' + moved + ' 个旧 Key' : '，请重新填写 API Key'));
      } catch (error) {
        App.ui.toast((error && error.message) || '建立新密钥库失败，原密钥文件未覆盖');
      } finally {
        if (button) {
          button.dataset.busy = '0';
          button.disabled = false;
          button.textContent = '建立新密钥库';
        }
      }
    },

    async chooseStorageLocation() {
      const service = App.services.fs;
      const button = $('chooseStorageLocation');
      if (!service || !service.chooseStorageLocation || (button && button.dataset.busy === '1')) return;
      const originalText = button ? button.textContent : '';
      if (button) {
        button.dataset.busy = '1';
        button.disabled = true;
        button.textContent = '正在准备迁移...';
      }
      try {
        if (service.flushStorageSync) service.flushStorageSync(JSON.stringify(App.state));
        const result = await service.chooseStorageLocation();
        if (!result || !result.ok) {
          if (!(result && result.canceled)) App.ui.toast(storageLocationMessage(result, '选择数据目录失败'));
          return;
        }
        if (button) button.textContent = '正在重启应用...';
        App.ui.closeSettings();
        App.ui.toast('数据目录已设置，应用即将重启并迁移记录');
        if (!service.relaunchApp) throw new Error('当前版本不支持自动重启，请手动重启应用');
        const relaunch = await service.relaunchApp();
        if (relaunch && relaunch.ok === false) throw Object.assign(new Error(storageLocationMessage(relaunch, '应用重启失败')), relaunch);
      } catch (error) {
        App.ui.toast('迁移失败：' + storageLocationMessage(error, (error && error.message) || String(error)));
      } finally {
        if (button) {
          button.dataset.busy = '0';
          button.disabled = false;
          button.textContent = originalText;
        }
      }
    },

    async openStorageLocation() {
      const info = App.services.fs && App.services.fs.getStorageInfo ? await App.services.fs.getStorageInfo() : null;
      if (info && info.ok && info.activeRoot && App.services.shell && App.services.shell.openPath) {
        const result = await App.services.shell.openPath(info.recordsRoot || info.activeRoot);
        if (result && result.ok === false) App.ui.toast(result.error || '打开数据目录失败');
      }
    },

    // v1.2.0：用量统计仪表盘（2026-08-26 修复「卡片是死的」——渲染绑定此前整体缺失，写入/聚合/IPC 链路本就健康）。
    // 供应商/成本两列已移除：provider 实为接口适配器名而非真实供应商，cost 因本地价格表覆盖有限几乎恒为 0。
    async refreshUsageSummary() {
      const rangeEl = $('usageRange'), totalsEl = $('usageTotals'), tableEl = $('usageTable'), emptyEl = $('usageEmpty');
      if (!totalsEl || !tableEl || !emptyEl) return;
      const days = rangeEl ? (Number(rangeEl.value) || 0) : 30;
      let res = null;
      try {
        res = window.electron && window.electron.metricsSummary ? await window.electron.metricsSummary({ days }) : { ok: false, error: '通道不可用' };
      } catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
      const fmtInt = (v) => Number(v || 0).toLocaleString('zh-CN');
      const fmtMs = (v) => (Number(v) || 0) >= 1 ? fmtInt(Math.round(v)) + ' ms' : '—';
      if (!res || !res.ok) {
        totalsEl.textContent = '用量统计不可用：' + ((res && (res.error || res.reason)) || '未知原因') + '（需使用 SQLite 存储模式）';
        tableEl.hidden = true;
        emptyEl.hidden = true;
        return;
      }
      const items = Array.isArray(res.items) ? res.items : [];
      const total = res.total || {};
      totalsEl.textContent = '合计：调用 ' + fmtInt(total.calls) + ' · 成功 ' + fmtInt(total.okCalls)
        + ' · Token 输入/输出/思考 ' + fmtInt(total.inTokens) + '/' + fmtInt(total.outTokens) + '/' + fmtInt(total.thinkTokens)
        + ' · 均延迟 ' + fmtMs(total.avgMs);
      if (!items.length) {
        tableEl.hidden = true;
        emptyEl.hidden = false;
        return;
      }
      emptyEl.hidden = true;
      const body = tableEl.querySelector('tbody');
      if (body) {
        body.innerHTML = items.map((it) => '<tr>' + [
          it.model || 'unknown', fmtInt(it.calls), fmtInt(it.okCalls),
          fmtInt(it.inTokens), fmtInt(it.outTokens), fmtInt(it.thinkTokens), fmtMs(it.avgMs),
        ].map((v) => '<td>' + App.escapeHtml(String(v)) + '</td>').join('') + '</tr>').join('');
      }
      tableEl.hidden = false;
    },
  });

  // v1.2.0：用量统计入口绑定（刷新按钮 / 范围切换）；面板激活入口在 ui.js selectSettingsPanel('data')
  const usageRefreshBtn = $('usageRefresh');
  if (usageRefreshBtn) usageRefreshBtn.addEventListener('click', () => { App.ui.refreshUsageSummary(); });
  const usageRangeEl = $('usageRange');
  if (usageRangeEl) usageRangeEl.addEventListener('change', () => { App.ui.refreshUsageSummary(); });
})();
