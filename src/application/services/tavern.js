'use strict';

(function () {
  App.services = App.services || {};
  const call = (name, fallback, input) => {
    try {
      const fn = window.electron && window.electron[name];
      return fn ? fn(input) : fallback;
    } catch (_) { return fallback; }
  };
  App.services.tavern = {
    presets() { return call('tavernPresets', { ok: false, presets: [] }); },
    getMatureMode() { return call('tavernGetMatureMode', { ok: false, matureMode: false }); },
    setMatureMode(input) { return call('tavernSetMatureMode', { ok: false, matureMode: false }, input || {}); },
    listCharacters(input) { return call('tavernListCharacters', { ok: false, items: [], total: 0, nextCursor: null }, input || {}); },
    getCharacter(id) { return call('tavernGetCharacter', { ok: false, character: null, memories: [] }, id || ''); },
    saveCharacter(input) { return call('tavernSaveCharacter', { ok: false }, input || {}); },
    toggleFavorite(input) { return call('tavernToggleFavorite', { ok: false }, input || {}); },
    reorderCharacters(input) { return call('tavernReorderCharacters', { ok: false }, input || {}); },
    touchCharacter(input) { return call('tavernTouchCharacter', { ok: false }, input || {}); },
    cloneCharacter(input) { return call('tavernCloneCharacter', { ok: false }, input || {}); },
    deleteCharacter(input) { return call('tavernDeleteCharacter', { ok: false }, input || {}); },
    previewImport(input) { return call('tavernPreviewImport', { ok: false }, input || {}); },
    importCharacter(input) { return call('tavernImportCharacter', { ok: false }, input || {}); },
    previewWorldbookImport(input) { return call('tavernPreviewWorldbookImport', { ok: false }, input || {}); },
    importWorldbook(input) { return call('tavernImportWorldbook', { ok: false }, input || {}); },
    exportCharacter(input) { return call('tavernExportCharacter', { ok: false }, input || {}); },
    listMemory(input) { return call('tavernListMemory', { ok: false, items: [] }, input || {}); },
    saveMemory(input) { return call('tavernSaveMemory', { ok: false }, input || {}); },
    deleteMemory(input) { return call('tavernDeleteMemory', { ok: false }, input || {}); },
    retrieveContext(input) { return call('tavernRetrieveContext', { ok: false, items: [], context: '' }, input || {}); },
    rebuildIndex(input) { return call('tavernRebuildIndex', { ok: false }, input || {}); },
    generateDraft(input) { return call('tavernGenerateDraft', { ok: false }, input || {}); },
  };
})();
