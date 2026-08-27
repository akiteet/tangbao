'use strict';
/* 自 main.js 拆分（v1.1.8 批次 F）：糖馆域——角色卡/世界书/记忆检索/索引/草稿 IPC。
 * 纯工厂模式（同 createMainSkills 先例）：createMainTavern(deps) 注册全部 tavern:* IPC handler。
 * deps 注入：safeHandle / app / dialog / getMainWindow / getStorageService / writeStateFileAtomic /
 *            getAppPort / LOCAL_TOKEN。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dataLocation = require('../infrastructure/storage/data-location');
const TavernCore = require('../core/tavern/tavern-store');
const TavernStore = require('../infrastructure/tavern/tavern-store');
const gateway = require('../infrastructure/model-gateway/gateway');

function createMainTavern(deps) {
  const { safeHandle, app, dialog, getStorageService, writeStateFileAtomic, getAppPort, LOCAL_TOKEN } = deps;
  const mainWindow = () => (deps.getMainWindow ? deps.getMainWindow() : null);

let tavernStoreInstance = null;
let tavernStoreBackend = null;
let tavernStoreRoot = '';
const tavernImportPreviews = new Map();

function getTavernStore() {
  const svc = getStorageService();
  const activeRoot = dataLocation.canonical(app.getPath('userData'));
  if (tavernStoreInstance && tavernStoreBackend === svc && tavernStoreRoot === activeRoot) return tavernStoreInstance;
  const dataDir = dataLocation.recordsRoot(activeRoot);
  tavernStoreBackend = svc;
  tavernStoreRoot = activeRoot;
  tavernStoreInstance = TavernStore.createStore({
    getKV: svc && typeof svc.getKV === 'function' ? (key) => svc.getKV(key) : null,
    setKV: svc && typeof svc.setKV === 'function' ? (key, value) => svc.setKV(key, value) : null,
    filePath: path.join(dataDir, 'tangbao-library.json'),
    indexPath: path.join(dataDir, 'tangbao-embeddings.index.json'),
  });
  return tavernStoreInstance;
}

// Tavern is a local library. Character cards and worldbook entries are
// stored in kv_meta (with a JSON sidecar fallback), never in the secret store.
safeHandle('tavern:presets', () => ({ ok: true, presets: TavernCore.PRESETS.map((item) => ({ id: item.id, label: item.label, summary: item.summary || '', patch: item.patch })) }));
safeHandle('tavern:getMatureMode', () => {
  try { return { ok: true, matureMode: getTavernStore().getMatureMode() }; }
  catch (error) { return { ok: false, code: 'tavern_mature_mode_read_failed', matureMode: false, error: error.message || String(error) }; }
});
safeHandle('tavern:setMatureMode', (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : { enabled: input === true };
    return getTavernStore().setMatureMode(opts.enabled === true, opts.confirmed === true);
  } catch (error) { return { ok: false, code: 'tavern_mature_mode_write_failed', matureMode: false, error: error.message || String(error) }; }
});
safeHandle('tavern:listCharacters', (_e, input) => {
  try { return getTavernStore().listCharacters(input || {}); }
  catch (error) { return { ok: false, code: 'tavern_list_failed', items: [], total: 0, nextCursor: null, error: error.message || String(error) }; }
});
safeHandle('tavern:getCharacter', (_e, id) => {
  try { return getTavernStore().getCharacter(id && typeof id === 'object' ? id.id : id); }
  catch (error) { return { ok: false, code: 'tavern_get_failed', character: null, memories: [], error: error.message || String(error) }; }
});
safeHandle('tavern:saveCharacter', (_e, input) => {
  try { const opts = input && typeof input === 'object' ? input : {}; return getTavernStore().saveCharacter(opts.character || opts, opts.expectedRevision); }
  catch (error) { return { ok: false, code: 'tavern_save_failed', error: error.message || String(error) }; }
});
safeHandle('tavern:toggleFavorite', (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    return getTavernStore().toggleFavorite(opts.id, opts.favorite, opts.expectedRevision);
  } catch (error) { return { ok: false, code: 'tavern_favorite_failed', error: error.message || String(error) }; }
});
safeHandle('tavern:reorderCharacters', (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    return getTavernStore().reorderCharacters(opts.orderedIds, opts.expectedRevision);
  } catch (error) { return { ok: false, code: 'tavern_reorder_failed', error: error.message || String(error) }; }
});
safeHandle('tavern:touchCharacter', (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    return getTavernStore().touchCharacter(opts.id, opts.expectedRevision);
  } catch (error) { return { ok: false, code: 'tavern_usage_failed', error: error.message || String(error) }; }
});
safeHandle('tavern:cloneCharacter', (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    return getTavernStore().cloneCharacter(opts.id, opts.expectedRevision);
  } catch (error) { return { ok: false, code: 'tavern_clone_failed', error: error.message || String(error) }; }
});
safeHandle('tavern:deleteCharacter', (_e, input) => {
  try { const opts = input && typeof input === 'object' ? input : {}; return getTavernStore().deleteCharacter(opts.id || input, opts.expectedRevision); }
  catch (error) { return { ok: false, code: 'tavern_delete_failed', error: error.message || String(error) }; }
});
safeHandle('tavern:previewImport', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    let filePath = String(opts.filePath || '');
    if (!filePath) {
      const picked = await dialog.showOpenDialog(mainWindow(), { title: 'Import character card', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (picked.canceled || !picked.filePaths || !picked.filePaths.length) return { ok: false, canceled: true };
      filePath = picked.filePaths[0];
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > TavernCore.MAX_IMPORT_FILE_BYTES) return { ok: false, code: 'tavern_import_too_large', error: 'Character card JSON must be no larger than 5MB.' };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const preview = TavernCore.inspectImport(parsed);
    if (preview.tooLarge) return { ok: false, code: 'tavern_card_too_large', error: 'Character card JSON must be no larger than 256KB.', bytes: preview.bytes, maxBytes: preview.maxBytes };
    const previewId = 'tgp_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
    tavernImportPreviews.set(previewId, { bundle: parsed, expiresAt: Date.now() + 10 * 60 * 1000 });
    for (const [key, value] of tavernImportPreviews) if (!value || value.expiresAt < Date.now()) tavernImportPreviews.delete(key);
    return { ok: true, preview: true, previewId, character: preview.character, memories: preview.memories, warnings: preview.warnings, mature: preview.mature };
  } catch (error) { return { ok: false, code: 'tavern_import_preview_failed', error: error.message || String(error) }; }
});
safeHandle('tavern:importCharacter', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    if (opts.previewId) {
      const pending = tavernImportPreviews.get(String(opts.previewId));
      if (!pending || pending.expiresAt < Date.now()) return { ok: false, code: 'tavern_import_preview_expired', error: 'Import preview expired. Please choose the file again.' };
      tavernImportPreviews.delete(String(opts.previewId));
      return getTavernStore().importBundle(pending.bundle, opts.expectedRevision);
    }
    let filePath = String(opts.filePath || '');
    if (!filePath) {
      const picked = await dialog.showOpenDialog(mainWindow(), { title: '导入角色卡', properties: ['openFile'], filters: [{ name: '角色卡 JSON', extensions: ['json'] }] });
      if (picked.canceled || !picked.filePaths || !picked.filePaths.length) return { ok: false, canceled: true };
      filePath = picked.filePaths[0];
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > TavernCore.MAX_IMPORT_FILE_BYTES) return { ok: false, code: 'tavern_import_too_large', error: 'Character card JSON must be no larger than 5MB.' };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const preview = TavernCore.inspectImport(parsed);
    if (preview.tooLarge) return { ok: false, code: 'tavern_card_too_large', error: 'Character card JSON must be no larger than 256KB.', bytes: preview.bytes, maxBytes: preview.maxBytes };
    return getTavernStore().importBundle(parsed, opts.expectedRevision);
  } catch (error) { return { ok: false, code: 'tavern_import_failed', error: error.message || String(error) }; }
});
safeHandle('tavern:previewWorldbookImport', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    const characterId = String(opts.characterId || '');
    if (!characterId || !getTavernStore().getCharacter(characterId).ok) return { ok: false, code: 'tavern_character_not_found' };
    let filePath = String(opts.filePath || '');
    if (!filePath) {
      const picked = await dialog.showOpenDialog(mainWindow(), { title: '导入世界书', properties: ['openFile'], filters: [{ name: '世界书 JSON', extensions: ['json'] }] });
      if (picked.canceled || !picked.filePaths || !picked.filePaths.length) return { ok: false, canceled: true };
      filePath = picked.filePaths[0];
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > TavernCore.MAX_IMPORT_FILE_BYTES) return { ok: false, code: 'tavern_import_too_large', error: 'Worldbook JSON must be no larger than 5MB.' };
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const detail = getTavernStore().getCharacter(characterId);
    const inspected = TavernCore.inspectWorldbookImport(parsed, characterId, {
      character: detail.character,
      memories: detail.memories,
    });
    if (!inspected.importedCount) {
      return {
        ok: false,
        code: 'tavern_worldbook_empty',
        error: 'No valid worldbook entries found.',
        sourceCount: inspected.sourceCount,
        skippedCount: inspected.skippedCount,
        warnings: inspected.warnings,
      };
    }
    if (inspected.tooLarge) {
      return {
        ok: true,
        preview: true,
        canImport: false,
        characterId,
        count: inspected.importedCount,
        sourceCount: inspected.sourceCount,
        skippedCount: inspected.skippedCount,
        bytes: inspected.bytes,
        maxBytes: inspected.maxBytes,
        warnings: inspected.warnings,
      };
    }
    const previewId = 'tgw_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
    tavernImportPreviews.set(previewId, { worldbook: parsed, characterId, expiresAt: Date.now() + 10 * 60 * 1000 });
    for (const [key, value] of tavernImportPreviews) if (!value || value.expiresAt < Date.now()) tavernImportPreviews.delete(key);
    return {
      ok: true,
      preview: true,
      previewId,
      characterId,
      memories: inspected.memories,
      count: inspected.importedCount,
      sourceCount: inspected.sourceCount,
      skippedCount: inspected.skippedCount,
      warnings: inspected.warnings,
    };
  } catch (error) {
    const code = error instanceof SyntaxError ? 'tavern_worldbook_invalid_json' : 'tavern_worldbook_preview_failed';
    return { ok: false, code, error: error.message || String(error) };
  }
});
safeHandle('tavern:importWorldbook', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    const pending = tavernImportPreviews.get(String(opts.previewId || ''));
    if (!pending || pending.expiresAt < Date.now() || pending.characterId !== String(opts.characterId || '')) return { ok: false, code: 'tavern_import_preview_expired', error: 'Import preview expired. Please choose the file again.' };
    tavernImportPreviews.delete(String(opts.previewId));
    return getTavernStore().importWorldbook(pending.characterId, pending.worldbook, opts.expectedRevision);
  } catch (error) { return { ok: false, code: 'tavern_worldbook_import_failed', error: error.message || String(error) }; }
});
safeHandle('tavern:exportCharacter', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    const item = getTavernStore().getCharacter(opts.id || input);
    if (!item.ok || !item.character) return { ok: false, code: 'tavern_character_not_found' };
    const picked = await dialog.showSaveDialog(mainWindow(), { title: '导出角色卡', defaultPath: (item.character.name || 'character') + '.json', filters: [{ name: '角色卡 JSON', extensions: ['json'] }] });
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    writeStateFileAtomic(picked.filePath, JSON.stringify(TavernCore.exportBundle(item.character, item.memories), null, 2));
    return { ok: true, filePath: picked.filePath };
  } catch (error) { return { ok: false, code: 'tavern_export_failed', error: error.message || String(error) }; }
});
safeHandle('tavern:listMemory', (_e, input) => {
  try { const opts = input && typeof input === 'object' ? input : {}; return getTavernStore().listMemory(opts.characterId, opts); }
  catch (error) { return { ok: false, code: 'tavern_memory_list_failed', items: [], error: error.message || String(error) }; }
});
safeHandle('tavern:saveMemory', (_e, input) => {
  try { const opts = input && typeof input === 'object' ? input : {}; return getTavernStore().saveMemory(opts.characterId, opts.memory || {}, opts.expectedRevision); }
  catch (error) { return { ok: false, code: 'tavern_memory_save_failed', error: error.message || String(error) }; }
});
safeHandle('tavern:deleteMemory', (_e, input) => {
  try { const opts = input && typeof input === 'object' ? input : {}; return getTavernStore().deleteMemory(opts.characterId, opts.memoryId, opts.expectedRevision); }
  catch (error) { return { ok: false, code: 'tavern_memory_delete_failed', error: error.message || String(error) }; }
});
safeHandle('tavern:retrieveContext', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    const store = getTavernStore();
    let mode = 'keyword';
    let dataOrigin = 'local-worldbook';
    let unknownReason = null;
    let retrievalOptions = { tokenBudget: opts.tokenBudget, limit: opts.limit };
    if (opts.semantic === true) {
      if (!opts.ref || !opts.model) unknownReason = 'embedding_provider_not_selected';
      else {
        const index = store.getEmbeddingIndex(opts.characterId, opts.model);
        if (!index.ok) unknownReason = index.code || 'embedding_index_unavailable';
        else {
          try {
            const embedded = await gateway.createEmbeddings(String(opts.ref), String(opts.model), [String(opts.query || '')], { callType: 'embedding_query' });
            if (embedded && embedded.ok && Array.isArray(embedded.vectors) && embedded.vectors[0]) {
              retrievalOptions = Object.assign(retrievalOptions, { queryVector: embedded.vectors[0], vectors: index.vectors });
              mode = 'hybrid';
              dataOrigin = 'provider';
            } else unknownReason = 'embedding_result_unknown';
          } catch (error) { unknownReason = error && error.code || 'embedding_provider_failed'; }
        }
      }
    }
    const result = store.retrieveContext(opts.characterId, opts.query, retrievalOptions);
    return Object.assign(result, { mode, dataOrigin, unknownReason, context: TavernCore.formatContext(result) });
  } catch (error) { return { ok: false, code: 'tavern_retrieve_failed', items: [], context: '', error: error.message || String(error) }; }
});
safeHandle('tavern:rebuildIndex', async (_e, input) => {
  const opts = input && typeof input === 'object' ? input : {};
  if (String(opts.mode || 'keyword') === 'semantic') {
    try {
      if (!opts.ref || !opts.model) return { ok: false, code: 'tavern_embedding_provider_missing', error: 'Choose an account and embedding model first.' };
      const store = getTavernStore();
      const detail = store.getCharacter(opts.characterId);
      if (!detail.ok || !detail.character) return { ok: false, code: 'tavern_character_not_found' };
      const memories = Array.isArray(detail.memories) ? detail.memories.filter((item) => item && item.enabled !== false && item.content) : [];
      if (!memories.length) return { ok: false, code: 'tavern_memory_empty', error: 'Add at least one worldbook entry first.' };
      const embedded = await gateway.createEmbeddings(String(opts.ref), String(opts.model), memories.map((item) => [item.title, item.content, ...(item.keywords || [])].filter(Boolean).join('\\n')), { callType: 'embedding_index' });
      const vectors = {};
      memories.forEach((item, index) => { if (embedded.vectors[index]) vectors[item.id] = embedded.vectors[index]; });
      const rebuilt = store.rebuildEmbeddingIndex(opts.characterId, { modelId: opts.model, vectors, source: embedded.dataOrigin || 'provider' });
      return Object.assign({ ok: true, characterId: String(opts.characterId || ''), mode: 'semantic', dataOrigin: embedded.dataOrigin || 'provider', model: String(opts.model), count: memories.length }, rebuilt);
    } catch (error) { return { ok: false, code: error && error.code || 'tavern_rebuild_failed', error: error.message || String(error) }; }
  }
  return { ok: true, characterId: String(opts.characterId || ''), mode: 'keyword', requestedMode: String(opts.mode || 'keyword'), dataOrigin: 'local-worldbook', message: '关键词索引无需重建' };
});
safeHandle('tavern:generateDraft', async (_e, input) => {
  try {
    const opts = input && typeof input === 'object' ? input : {};
    if (!opts.ref || !opts.model) return { ok: false, code: 'tavern_draft_provider_missing', error: '请先选择账户和模型' };
    const response = await fetch(`http://127.0.0.1:${getAppPort()}/gateway`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + LOCAL_TOKEN },
      body: JSON.stringify({ ref: String(opts.ref), kind: 'chat', payload: { model: String(opts.model), stream: false, response_format: { type: 'json_object' }, messages: [
        { role: 'system', content: [
          '你是本地角色卡创作助手。只输出一个合法的 JSON 对象，不要 Markdown、代码围栏或任何解释文字。',
          '允许字段：name, tagline, description, personality, scenario, greeting, firstMessage, exampleDialogue, systemPrompt, tags, matureAllowed。',
          '质量要求：',
          '- 全部内容用简体中文（用户描述明确要求其他语言时除外）。',
          '- description：不少于 120 字，涵盖外貌、性格、背景来历、与他人关系，写得具体、有画面感，不要空泛形容词堆砌。',
          '- personality：3-6 条具体特质，用分号分隔（如"嘴上傲娇但会偷偷关心人；极度好胜，不服输"）。',
          '- scenario：1-2 句交代角色所处的场景或世界观。',
          '- firstMessage：以角色身份写的开场白，80-200 字，体现说话风格，动作与神态用括号描写。',
          '- exampleDialogue：1-2 轮对话示例，每行以「用户：」或「' + '角色：' + '」开头，展示角色独特的说话方式。',
          '- tags：3-8 个短标签。',
          '- 只根据用户描述创作，不要反问；某字段信息不足时按人设合理补全。若用户要求只改进某个字段，只输出该字段并保持其余字段简洁。',
        ].join('\n') },
        { role: 'user', content: String(opts.brief || '').slice(0, 4000) },
      ] }, telemetry: { scope: 'tavern', callType: 'tavern_character_draft' } }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, code: 'tavern_draft_provider_failed', error: body && body.error && body.error.message ? body.error.message : '模型请求失败' };
    const choice = body && body.choices && body.choices[0] && body.choices[0].message;
    const raw = choice && (choice.content || choice.reasoning_content);
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, code: 'tavern_draft_invalid_json', error: 'The model returned no JSON draft.' };
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { return { ok: false, code: 'tavern_draft_invalid_json', error: 'The model returned invalid JSON; nothing was saved.' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'tavern_draft_invalid_json', error: 'The model draft is not a JSON object.' };
    const normalized = TavernCore.normalizeCharacter(parsed);
    delete normalized.id; delete normalized.createdAt; delete normalized.updatedAt;
    return { ok: true, draft: normalized, costNotice: true };
  } catch (error) { return { ok: false, code: 'tavern_draft_failed', error: error.message || String(error) }; }
});

  return { getTavernStore };
}

module.exports = { createMainTavern };
