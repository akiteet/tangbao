'use strict';
/* 密钥库服务：只有「写/删/问存不存在」四个通道，明文只在主进程 */
(function () {
  App.services = App.services || {};
  App.services.secrets = {
    setSecret(ref, value) {
      try { return (window.electron && window.electron.setSecret) ? window.electron.setSecret(ref, value) : { ok: false, error: '当前环境不支持密钥存储' }; } catch (e) { return { ok: false }; }
    },
    deleteSecret(ref) {
      try { return (window.electron && window.electron.deleteSecret) ? window.electron.deleteSecret(ref) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    deleteSecretsByPrefix(prefix) {
      try { return (window.electron && window.electron.deleteSecretsByPrefix) ? window.electron.deleteSecretsByPrefix(prefix) : { ok: false }; } catch (e) { return { ok: false }; }
    },
    listSecrets() {
      try { return (window.electron && window.electron.listSecrets) ? window.electron.listSecrets() : { ok: false }; } catch (e) { return { ok: false }; }
    },
    diagnose() {
      try { return (window.electron && window.electron.diagnoseSecrets) ? window.electron.diagnoseSecrets() : { ok: false }; } catch (e) { return { ok: false }; }
    },
    recoverLegacy() {
      try { return (window.electron && window.electron.recoverLegacySecrets) ? window.electron.recoverLegacySecrets() : { ok: false }; } catch (e) { return { ok: false }; }
    },
    resetSecretStore() {
      try { return (window.electron && window.electron.resetSecretStore) ? window.electron.resetSecretStore() : { ok: false, code: 'secret_store_reset_unsupported' }; } catch (e) { return { ok: false }; }
    },
  };
})();
