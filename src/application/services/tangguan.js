'use strict';

(function () {
  App.services = App.services || {};
  const call = (name, fallback, input) => {
    try {
      const fn = window.electron && window.electron[name];
      return fn ? fn(input) : fallback;
    } catch (_) { return fallback; }
  };
  App.services.tangguan = {
    presets() { return call('tangguanPresets', { ok: false, presets: [] }); },
    getMatureMode() { return call('tangguanGetMatureMode', { ok: false, matureMode: false }); },
    setMatureMode(input) { return call('tangguanSetMatureMode', { ok: false, matureMode: false }, input || {}); },
    listCharacters(input) { return call('tangguanListCharacters', { ok: false, items: [], total: 0, nextCursor: null }, input || {}); },
    getCharacter(id) { return call('tangguanGetCharacter', { ok: false, character: null, memories: [] }, id || ''); },
    saveCharacter(input) { return call('tangguanSaveCharacter', { ok: false }, input || {}); },
    toggleFavorite(input) { return call('tangguanToggleFavorite', { ok: false }, input || {}); },
    touchCharacter(input) { return call('tangguanTouchCharacter', { ok: false }, input || {}); },
    cloneCharacter(input) { return call('tangguanCloneCharacter', { ok: false }, input || {}); },
    deleteCharacter(input) { return call('tangguanDeleteCharacter', { ok: false }, input || {}); },
    previewImport(input) { return call('tangguanPreviewImport', { ok: false }, input || {}); },
    importCharacter(input) { return call('tangguanImportCharacter', { ok: false }, input || {}); },
    previewWorldbookImport(input) { return call('tangguanPreviewWorldbookImport', { ok: false }, input || {}); },
    importWorldbook(input) { return call('tangguanImportWorldbook', { ok: false }, input || {}); },
    exportCharacter(input) { return call('tangguanExportCharacter', { ok: false }, input || {}); },
    listMemory(input) { return call('tangguanListMemory', { ok: false, items: [] }, input || {}); },
    saveMemory(input) { return call('tangguanSaveMemory', { ok: false }, input || {}); },
    deleteMemory(input) { return call('tangguanDeleteMemory', { ok: false }, input || {}); },
    retrieveContext(input) { return call('tangguanRetrieveContext', { ok: false, items: [], context: '' }, input || {}); },
    rebuildIndex(input) { return call('tangguanRebuildIndex', { ok: false }, input || {}); },
    generateDraft(input) { return call('tangguanGenerateDraft', { ok: false }, input || {}); },
  };
})();
