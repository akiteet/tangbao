'use strict';

/*
 * Render the real renderer entry in Electron and check the narrow layouts.
 * This intentionally uses BrowserWindow only; no browser automation package is
 * needed for the release gate.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.disableHardwareAcceleration();
app.disableHardwareAcceleration();
const CASES = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'small-desktop', width: 1024, height: 768 },
  { name: 'compact', width: 720, height: 768 },
  { name: 'narrow', width: 390, height: 844 },
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, label, timeoutMs) {
  return Promise.race([
    promise,
    wait(timeoutMs).then(() => { throw new Error(label + ' timed out after ' + timeoutMs + 'ms'); }),
  ]);
}

async function waitForRenderer(win) {
  for (let i = 0; i < 120; i += 1) {
    const ready = await win.webContents.executeJavaScript('document.readyState === "complete"', true);
    if (ready) return;
    await wait(50);
  }
  throw new Error('renderer did not finish loading');
}

async function waitForApp(win) {
  for (let i = 0; i < 120; i += 1) {
    const ready = await win.webContents.executeJavaScript('Boolean(window.App && App.__bootReady === true)', true);
    if (ready) return;
    await wait(50);
  }
  throw new Error('renderer boot did not finish');
}

async function installTangguanFixture(win) {
  await win.webContents.executeJavaScript(`(() => {
    const now = Date.now();
    const characters = [
      {
        id: 'smoke-character-a',
        name: 'Archivist',
        tagline: 'A local character for layout checks',
        description: 'Keeps long descriptions inside the character card.',
        greeting: 'Welcome to the archive.',
        firstMessage: 'Welcome to the archive.',
        tags: ['local', 'smoke'],
        favorite: true,
        lastUsedAt: now,
        avatar: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="%235b6ee1"/><text x="20" y="26" text-anchor="middle" fill="white">A</text></svg>',
      },
      {
        id: 'smoke-character-b',
        name: 'Navigator with a very long name',
        tagline: 'A second role used to verify character switching',
        description: 'This role has no remote avatar.',
        greeting: 'Ready when you are.',
        firstMessage: 'Ready when you are.',
        tags: ['second'],
        favorite: false,
        lastUsedAt: now - 1000,
        avatar: '',
      },
    ];
     const memories = [
       { id: 'smoke-memory-a', characterId: characters[0].id, title: 'Local rule', content: 'The archive is local.', priority: 80, tags: ['archive'] },
       { id: 'smoke-memory-b', characterId: characters[1].id, title: 'Navigator rule', content: 'Navigator context only.', priority: 70, tags: ['navigation'] },
     ];
    const detail = (id) => {
      const character = characters.find((item) => item.id === id);
      return character ? { ok: true, character: JSON.parse(JSON.stringify(character)), memories: memories.filter((item) => item.characterId === id), revision: 1 } : { ok: false, character: null, memories: [], revision: 1 };
    };
    const regular = { id: 'smoke-regular-conversation', title: 'Regular Chat', messages: [{ role: 'user', content: 'regular conversation' }], updatedAt: now - 3000 };
    const tavernA = { id: 'smoke-tavern-a', title: 'Archivist', tavernCharacterId: characters[0].id, model: 'smoke-model-1', messages: [{ role: 'user', content: 'saved archive message' }, { role: 'assistant', content: 'saved archive answer' }], updatedAt: now - 2000 };
    const tavernB = { id: 'smoke-tavern-b', title: 'Empty session', tavernCharacterId: characters[0].id, messages: [], updatedAt: now - 3000 };
    const tavernCorrupt = { id: 'smoke-tavern-corrupt', title: 'Corrupt session', tavernCharacterId: characters[0].id, messages: { broken: true }, updatedAt: now + 1000 };
    const navigatorSession = { id: 'smoke-tavern-navigator', title: 'Navigator session', tavernCharacterId: characters[1].id, messages: [{ role: 'assistant', content: 'navigator-only answer' }], updatedAt: now - 1500 };
     // Module conversations live in their sidecar buckets. Keep the regular
     // state collection clean so this smoke test catches accidental leakage
     // back into the Chat sidebar.
     const moduleData = {
       tavern: { conversations: [tavernCorrupt, tavernB, tavernA, navigatorSession], activeId: tavernCorrupt.id, revision: 1 },
       create: { conversations: [], activeId: null, revision: 0 },
     };
     App.moduleSessions = { status: 'active', data: JSON.parse(JSON.stringify(moduleData)) };
     App.state.conversations = [regular];
     App.state.activeId = regular.id;
     App.state.settings.accounts = [{ id: 'smoke-account-a', name: 'Smoke account', models: ['smoke-model-1', 'smoke-model-2'] }];
     App.state.settings.providers = Object.assign({}, App.state.settings.providers || {}, {
       tavern: { accountId: 'smoke-account-a', model: 'smoke-model-2' },
       create: { accountId: 'smoke-account-a', model: 'smoke-model-1' },
     });
     App.state.settings.tavernUi = { lastCharacterId: characters[0].id, lastConversationId: tavernCorrupt.id };
     App.persist = () => {};
     // Make persistence deterministic inside each Electron smoke case while
     // preserving the same renderer-facing sidecar contract.
     const clone = (value) => JSON.parse(JSON.stringify(value));
     const saveModule = (module, conversation, activeId) => {
       const bucket = App.moduleSessions.data[module];
       bucket.conversations = [clone(conversation)].concat(bucket.conversations.filter((item) => item.id !== conversation.id));
       if (activeId !== undefined) bucket.activeId = activeId || null;
       bucket.revision = Number(bucket.revision || 0) + 1;
       return { ok: true, module, data: clone(bucket) };
     };
     App.services.moduleSessions = {
       load: (module) => ({ ok: true, module, data: clone(App.moduleSessions.data[module]) }),
       list: (module) => ({ ok: true, module, conversations: clone(App.moduleSessions.data[module].conversations), activeId: App.moduleSessions.data[module].activeId }),
       get: (module, id) => ({ ok: true, module, conversation: clone(App.moduleSessions.data[module].conversations.find((item) => item.id === id) || null) }),
       upsert: (module, conversation, activeId) => saveModule(module, conversation, activeId),
       remove: (module, id) => {
         const bucket = App.moduleSessions.data[module];
         if (window.__tgSmokeState) window.__tgSmokeState.removeCalls.push({ module, id });
         bucket.conversations = bucket.conversations.filter((item) => item.id !== id);
         if (bucket.activeId === id) bucket.activeId = bucket.conversations[0] ? bucket.conversations[0].id : null;
         return { ok: true, module, data: clone(bucket) };
       },
       flushPartial: () => ({ ok: true }),
       migrateLegacy: () => ({ ok: true, migrated: false }),
       info: () => ({ ok: true }),
     };
     window.__tgSmokeState = { saveCharacterCalls: 0, draftCalls: 0, removeCalls: [] };
     App.services.tavern = {
      presets: () => ({ ok: true, presets: [{ id: 'smoke-preset', label: 'Smoke preset', patch: { tagline: 'Preset tagline' } }] }),
      getMatureMode: () => ({ ok: true, matureMode: false }),
      setMatureMode: () => ({ ok: true, matureMode: false }),
      listCharacters: () => ({ ok: true, items: JSON.parse(JSON.stringify(characters)), total: characters.length, nextCursor: null, revision: 1 }),
      getCharacter: (id) => detail(typeof id === 'object' ? id.id : id),
       saveCharacter: () => { window.__tgSmokeState.saveCharacterCalls += 1; return { ok: true, revision: 1 }; },
      toggleFavorite: () => ({ ok: true, revision: 1 }),
      touchCharacter: () => ({ ok: true, revision: 1, characters: JSON.parse(JSON.stringify(characters)) }),
      cloneCharacter: () => ({ ok: true, revision: 1, characterId: characters[1].id }),
      deleteCharacter: () => ({ ok: true, revision: 1 }),
      previewImport: () => ({ ok: false, canceled: true }),
      importCharacter: () => ({ ok: false, canceled: true }),
      exportCharacter: () => ({ ok: true }),
      listMemory: () => ({ ok: true, items: memories, revision: 1 }),
      saveMemory: () => ({ ok: true, revision: 1 }),
      deleteMemory: () => ({ ok: true, revision: 1 }),
      retrieveContext: () => ({ ok: true, items: [], context: '', mode: 'keyword', revision: 1 }),
      rebuildIndex: () => ({ ok: true, count: memories.length }),
       generateDraft: () => { window.__tgSmokeState.draftCalls += 1; return { ok: true, draft: { name: 'Drafted Archivist', tagline: 'Draft tagline', description: 'Draft only' } }; },
    };
    return true;
  })()`, true);
  await win.webContents.executeJavaScript(`(() => {
    if (window.App && App.router && App.router.go) App.router.go('tavern');
    return true;
  })()`, true);
  await wait(120);
}

async function inspectTangguan(win, testCase) {
  return win.webContents.executeJavaScript(`(async () => {
    const failures = [];
    const waitFor = async (selector) => {
      for (let i = 0; i < 120; i += 1) {
        if (document.querySelector(selector)) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    };
    await waitFor('.tg-workspace');
    const root = document.documentElement;
    const body = document.body;
    const host = document.getElementById('tavernView');
    const workspace = host && host.querySelector('.tg-workspace');
    const library = host && host.querySelector('.tg-library');
    const main = host && host.querySelector('.tg-main');
    const surface = host && host.querySelector('.tg-chat-surface');
    const rect = (node) => node ? node.getBoundingClientRect() : null;
    const overflow = Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth;
    if (!host || !workspace || !main || !surface) failures.push('real Tangguan workspace is missing');
    if (overflow > 1) failures.push('Tangguan introduces horizontal overflow ' + overflow);
    if (root.scrollHeight > root.clientHeight + 1) failures.push('Tangguan page introduces document vertical overflow');
    if (host && host.scrollHeight > host.clientHeight + 1) failures.push('Tangguan host introduces page vertical overflow');
    if (host && host.parentElement && host.parentElement.scrollHeight > host.parentElement.clientHeight + 1) failures.push('Tangguan view content introduces page vertical overflow');
    if (library && ${testCase.width} > 900 && Math.abs(library.getBoundingClientRect().width - 240) > 2) failures.push('desktop character library width is unstable');
    if (${testCase.width} > 900) {
      const collapse = host && host.querySelector('[data-tg-library-toggle]');
      if (!collapse) failures.push('desktop character library has no collapse control');
      if (collapse) collapse.click();
      await new Promise((resolve) => setTimeout(resolve, 35));
      const collapsedLibrary = host && host.querySelector('.tg-library');
      const collapsedTab = host && host.querySelector('[data-tg-library-expand]');
      const collapsedTabStyle = collapsedTab && getComputedStyle(collapsedTab);
      if (!collapsedLibrary || Math.abs(collapsedLibrary.getBoundingClientRect().width - 40) > 2) failures.push('desktop character library did not collapse to the narrow rail');
      if (!collapsedTab || Math.abs(collapsedTab.getBoundingClientRect().width - 32) > 2 || collapsedTabStyle.fontSize !== '12px' || collapsedTab.getBoundingClientRect().height < 58) failures.push('collapsed character rail label dimensions are incorrect');
      if (!collapsedTab || collapsedTabStyle.writingMode === 'horizontal-tb' || collapsedTabStyle.textOrientation !== 'upright') failures.push('collapsed character rail is missing its vertical bookmark');
      if (collapsedTab) collapsedTab.click();
      await new Promise((resolve) => setTimeout(resolve, 35));
      const expandedLibrary = host && host.querySelector('.tg-library');
      if (!expandedLibrary || Math.abs(expandedLibrary.getBoundingClientRect().width - 240) > 2) failures.push('desktop character library did not expand again');
    }
    const selectedCard = host && host.querySelector('[data-tg-select="smoke-character-a"]');
    if (!selectedCard || !selectedCard.classList.contains('active')) failures.push('last character was not restored');
    const selectedAvatar = selectedCard && selectedCard.querySelector('img');
    if (!selectedAvatar) failures.push('character card avatar did not render');
    if (selectedAvatar && ${testCase.width} > 900 && (selectedAvatar.getBoundingClientRect().width <= 0 || selectedAvatar.getBoundingClientRect().height <= 0)) failures.push('desktop character card avatar is collapsed');
    const header = host && host.querySelector('.tg-character-header h1');
    if (!header || !header.textContent.includes('Archivist')) failures.push('restored character header is missing');
    const moduleProvider = host && host.querySelector('[data-module-provider="tavern"]');
    const moduleAccountSelect = host && host.querySelector('[data-module-provider-account]');
    const modelButton = document.getElementById('modelSelectBtn');
    const modelDropdown = document.getElementById('modelDropdown');
    if (moduleProvider || moduleAccountSelect) failures.push('Tangguan header still exposes an account selector');
    if (!modelButton || modelButton.hidden) failures.push('Tangguan common model selector is missing');
    if (!modelDropdown || modelDropdown.querySelectorAll('[data-model]').length < 2) failures.push('Tangguan common model selector did not expose account models');
    if (modelButton && !modelButton.textContent.includes('smoke-model-1')) failures.push('valid Tangguan conversation model override is not displayed');
    const tavernProviderBeforeModel = App.state.settings.providers.tavern && App.state.settings.providers.tavern.accountId;
    const tavernModelOption = modelDropdown && modelDropdown.querySelector('[data-model="smoke-model-2"]');
    if (tavernModelOption) tavernModelOption.click();
    if (!App.state.settings.providers.tavern || App.state.settings.providers.tavern.model !== 'smoke-model-2') failures.push('Tangguan model selection did not persist to the module provider');
    if (tavernProviderBeforeModel && App.state.settings.providers.tavern.accountId !== tavernProviderBeforeModel) failures.push('Tangguan model selection changed the configured account');
    const tavernOverride = App.chat.conversationList('tavern').find((item) => item.id === 'smoke-tavern-a');
    if (!tavernOverride || tavernOverride.model !== 'smoke-model-2') failures.push('Tangguan conversation model override did not update');
    const message = host && host.querySelector('#messages .assistant .bubble');
    const initialActiveId = App.state && App.state.activeId;
    const initialModuleActiveId = App.chat && App.chat.activeConversationId ? App.chat.activeConversationId('tavern') : null;
    const initialMessageText = host && host.querySelector('#messages') ? host.querySelector('#messages').textContent : '';
    const initialWelcomeText = host && host.querySelector('#welcome') ? host.querySelector('#welcome').textContent : '';
    if (!message || !message.textContent.includes('saved archive answer')) failures.push('last Tangguan session was not restored');
    if (initialActiveId !== 'smoke-regular-conversation') failures.push('regular Chat active pointer was changed by Tangguan');
    if (initialModuleActiveId !== 'smoke-tavern-a') failures.push('corrupt Tangguan pointer was not recovered to the latest valid session');
    const restoredSessionTitle = host && host.querySelector('#tgSessionSelect') ? host.querySelector('#tgSessionSelect').textContent : '';
    if (!restoredSessionTitle.includes('saved archive message')) failures.push('legacy character-name session title did not fall back to the first user message');
    if (selectedCard && selectedCard.textContent.includes('Keeps long descriptions inside the character card')) failures.push('character card still renders the full description');
    if (selectedCard && !selectedCard.querySelector('[data-tg-recent]')) failures.push('character card does not expose recent-use status');
    if (host && host.querySelector('[data-tg-session-open="smoke-tavern-corrupt"]')) failures.push('corrupt session was exposed in the session list');
    const emptySession = host && host.querySelector('#tgSessionSelect option[value="smoke-tavern-b"]');
    if (!emptySession) failures.push('empty session is not available in the session selector');

    const editorButton = host && host.querySelector('[data-tg-open-editor]');
    if (editorButton) editorButton.click();
    const drawer = host && host.querySelector('.tg-drawer:not([hidden])');
    if (!drawer) failures.push('editor drawer did not open');
    if (drawer && (${testCase.width} > 900) && (drawer.getBoundingClientRect().width < 420 || drawer.getBoundingClientRect().width > 480)) failures.push('desktop editor drawer width is outside the stable range');
    const basic = drawer && drawer.querySelector('[data-tg-group-body="basic"]');
    const advanced = drawer && drawer.querySelector('[data-tg-group-body="advanced"]');
    if (basic && basic.hidden) failures.push('basic editor group is not expanded');
    if (advanced && !advanced.hidden) failures.push('advanced editor group is expanded by default');
    const advancedToggle = drawer && drawer.querySelector('[data-tg-group-toggle="advanced"]');
    if (advancedToggle) advancedToggle.click();
    if (advanced && advanced.hidden) failures.push('advanced editor group did not expand');
     const worldbookToggle = drawer && drawer.querySelector('[data-tg-group-toggle="worldbook"]');
     if (worldbookToggle) worldbookToggle.click();
     const worldbook = drawer && drawer.querySelector('[data-tg-group-body="worldbook"]');
     if (!worldbook || worldbook.hidden) failures.push('worldbook group did not expand');
     if (worldbook && !worldbook.textContent.includes('Local rule')) failures.push('worldbook did not show the selected character entries');
     const mask = host && host.querySelector('[data-tg-drawer-mask]');
     if (!mask || mask.hidden) failures.push('drawer mask is not visible');
     if (drawer && getComputedStyle(drawer.querySelector('.tg-drawer-body')).overflowY !== 'auto') failures.push('editor drawer body is not the scroll container');
     document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
     if (host && host.querySelector('.tg-drawer:not([hidden])')) failures.push('Escape did not close editor drawer');
     const retainedEditorButton = host && host.querySelector('[data-tg-open-editor]');
     if (retainedEditorButton) retainedEditorButton.click();
     await new Promise((resolve) => setTimeout(resolve, 40));
     const retainedDrawer = host && host.querySelector('.tg-drawer:not([hidden])');
     const retainedWorldbook = retainedDrawer && retainedDrawer.querySelector('[data-tg-group-body="worldbook"]');
     if (!retainedWorldbook || retainedWorldbook.hidden) failures.push('worldbook expanded state was lost during drawer remount');
     document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    // Changing characters while the editor is dirty must not silently discard
    // the draft. After explicit discard, the selected character and session
    // must be scoped to the new character.
    const editorAgain = host && host.querySelector('[data-tg-open-editor]');
    if (editorAgain) editorAgain.click();
    await new Promise((resolve) => setTimeout(resolve, 60));
    const reopenedDrawer = host && host.querySelector('.tg-drawer:not([hidden])');
    if (!reopenedDrawer) failures.push('editor drawer did not reopen for dirty-state check');
    const navigatorCard = host && host.querySelector('[data-tg-select="smoke-character-b"]');
    const dirtyInput = host && host.querySelector('#tgName');
    if (dirtyInput) {
      dirtyInput.value = 'Unsaved draft';
      dirtyInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (!dirtyInput) failures.push('editor name input missing for dirty-state check');
    if (!navigatorCard) failures.push('second character card missing for switch check');
    if (navigatorCard) navigatorCard.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const guardModal = document.querySelector('.modal-mask [data-modal-btn="放弃修改"]');
    if (!guardModal) failures.push('dirty editor did not prompt before character switch');
    if (guardModal) guardModal.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const navigatorHeader = host && host.querySelector('.tg-character-header h1');
    const navigatorAnswer = host && host.querySelector('#messages .bubble');
    if (!navigatorHeader || !navigatorHeader.textContent.includes('Navigator')) failures.push('character switch did not update the header');
    if (!navigatorAnswer || !navigatorAnswer.textContent.includes('navigator-only answer')) failures.push('character switch did not restore the scoped session');
    if (navigatorAnswer && navigatorAnswer.textContent.includes('saved archive answer')) failures.push('character switch leaked the previous character session');
    const archiveCard = host && host.querySelector('[data-tg-select="smoke-character-a"]');
    if (archiveCard) archiveCard.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const archiveHeader = host && host.querySelector('.tg-character-header h1');
    if (!archiveHeader || !archiveHeader.textContent.includes('Archivist')) failures.push('switching back to the original character failed');

    if (${testCase.width} <= 900) {
      const openLibrary = host && host.querySelector('[data-tg-open-library]');
      if (!openLibrary) failures.push('narrow layout has no library drawer entry');
      if (openLibrary) openLibrary.click();
      const libraryDrawer = host && host.querySelector('.tg-drawer:not([hidden])');
      if (!libraryDrawer || !libraryDrawer.classList.contains('tg-drawer-library-host')) failures.push('narrow library drawer did not open');
      const sessionTab = libraryDrawer && libraryDrawer.querySelector('[data-tg-library-tab="sessions"]');
      if (sessionTab) sessionTab.click();
      const sessionContent = host && host.querySelector('.tg-drawer:not([hidden]) [data-tg-session-open="smoke-tavern-a"]');
      if (!sessionContent) failures.push('narrow session drawer tab did not render sessions');
      if (mask && mask.hidden) failures.push('narrow drawer mask is not visible');
      if (mask) mask.click();
      if (host && host.querySelector('.tg-drawer:not([hidden])')) failures.push('drawer mask did not close narrow drawer');
    }
    // Select the empty session and assert that the old answer is removed.
    const select = host && host.querySelector('#tgSessionSelect');
    if (select) {
      select.value = 'smoke-tavern-b';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
     const stale = host && host.querySelector('#messages .bubble');
     if (stale && stale.textContent.includes('saved archive answer')) failures.push('empty session retained the previous message DOM');

     // Sending from an empty Tangguan surface must create its session in the
     // Tangguan sidecar instead of falling back to the regular Chat route.
     const beforeDirectTangguanRegular = App.state.conversations.length;
     App.chat.setActiveConversationId('tavern', null);
     if (App.router && App.router.go) App.router.go('tavern', { persist: false });
     await new Promise((resolve) => setTimeout(resolve, 40));
     App.chat.setActiveConversationId('tavern', null);
     App.chat.renderMessages();
     const directTangguanInput = document.getElementById('input');
     if (directTangguanInput) directTangguanInput.value = 'direct Tangguan smoke message';
     if (directTangguanInput && App.chat.send) await App.chat.send();
     await new Promise((resolve) => setTimeout(resolve, 50));
     const directTangguan = App.chat.activeConv();
     if (App.state.view !== 'tavern') failures.push('direct Tangguan send escaped to regular Chat');
     if (!directTangguan || directTangguan.originModule !== 'tavern') failures.push('direct Tangguan send did not create a Tangguan conversation');
     if (App.state.conversations.length !== beforeDirectTangguanRegular) failures.push('direct Tangguan send changed regular Chat conversations');

     // New-session and session-management actions must operate on the current
     // character without silently changing the regular Chat collection.
     const beforeNewSession = App.state.conversations.length;
     const beforeModuleSessions = App.chat && App.chat.conversationList ? App.chat.conversationList('tavern').length : 0;
     const newSessionButton = host && host.querySelector('[data-tg-new-session]');
     if (!newSessionButton) failures.push('new session action is missing');
       if (newSessionButton) {
      newSessionButton.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (App.state.conversations.length !== beforeNewSession) failures.push('new Tangguan session leaked into regular Chat conversations');
      if (App.chat.conversationList('tavern').length !== beforeModuleSessions + 1) failures.push('new session did not create exactly one module conversation');
      const newSession = App.chat.activeConv();
      if (!newSession || newSession.tavernCharacterId !== 'smoke-character-a') failures.push('new session escaped the selected character scope');
      if (!newSession || !Array.isArray(newSession.messages) || newSession.messages.length !== 0) failures.push('new session did not start with an empty message list');
      if (newSession && newSession.title !== '新会话') failures.push('new session did not retain the empty-session title');
      if (App.router && App.router.go) App.router.go('tavern');
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
     const sessionsButton = host && host.querySelector('[data-tg-open-sessions]');
     if (sessionsButton) sessionsButton.click();
     await new Promise((resolve) => setTimeout(resolve, 40));
     const sessionRow = host && host.querySelector('[data-tg-session-open="smoke-tavern-a"]');
     if (!sessionRow) failures.push('session management panel did not render the target session');
     const originalPromptModal = App.ui.promptModal;
     App.ui.promptModal = async () => 'Renamed smoke session';
     const renameButton = host && host.querySelector('[data-tg-session-rename="smoke-tavern-a"]');
     if (renameButton) renameButton.click();
     await new Promise((resolve) => setTimeout(resolve, 40));
     App.ui.promptModal = originalPromptModal;
     const renamedSession = host && host.querySelector('[data-tg-session-open="smoke-tavern-a"]');
     if (!renamedSession || !renamedSession.textContent.includes('Renamed smoke session')) failures.push('session rename did not persist');
     const clearConfirm = window.confirm;
     window.confirm = () => true;
     const clearButton = host && host.querySelector('[data-tg-session-clear="smoke-tavern-a"]');
     if (clearButton) clearButton.click();
     await new Promise((resolve) => setTimeout(resolve, 30));
     window.confirm = clearConfirm;
     const cleared = App.chat.conversationList('tavern').find((item) => item.id === 'smoke-tavern-a');
     if (!cleared || cleared.messages.length !== 0) failures.push('session clear did not remove only the target messages');
     const exportButton = host && host.querySelector('[data-tg-session-export="smoke-tavern-a"]');
     if (exportButton) exportButton.click();
     const activeSessionRow = host && host.querySelector('[data-tg-session-open="smoke-tavern-a"]');
     if (activeSessionRow) activeSessionRow.click();
     await new Promise((resolve) => setTimeout(resolve, 35));
     const deleteConfirm = window.confirm;
     const moduleCountBeforeDelete = App.chat.conversationList('tavern').length;
     window.confirm = () => false;
     let deleteButton = host && host.querySelector('[data-tg-session-delete="smoke-tavern-a"]');
     if (deleteButton) deleteButton.click();
     await new Promise((resolve) => setTimeout(resolve, 35));
     if (App.chat.conversationList('tavern').length !== moduleCountBeforeDelete) failures.push('cancelled Tangguan deletion changed the sidecar');
     if (!App.chat.conversationList('tavern').some((item) => item.id === 'smoke-tavern-a')) failures.push('cancelled Tangguan deletion removed the session');
     if (App.chat.activeConversationId('tavern') !== 'smoke-tavern-a') failures.push('cancelled Tangguan deletion changed the active session');
     window.confirm = () => true;
     deleteButton = host && host.querySelector('[data-tg-session-delete="smoke-tavern-a"]');
     if (deleteButton) deleteButton.click();
     await new Promise((resolve) => setTimeout(resolve, 50));
     window.confirm = deleteConfirm;
     if (App.chat.conversationList('tavern').some((item) => item.id === 'smoke-tavern-a')) failures.push('confirmed Tangguan deletion kept the session in the sidecar');
     if (App.chat.activeConversationId('tavern') === 'smoke-tavern-a') failures.push('confirmed Tangguan deletion kept the deleted active id');
     if (!window.__tgSmokeState.removeCalls.some((call) => call.module === 'tavern' && call.id === 'smoke-tavern-a')) failures.push('confirmed Tangguan deletion did not call the tavern sidecar remover');
     if (host && host.querySelector('[data-tg-session-open="smoke-tavern-a"]')) failures.push('confirmed Tangguan deletion left the row in the UI');

     // Presets and AI drafts only change the editor draft. A save call is
     // expected only after the explicit Save character action.
     const draftEditorButton = host && host.querySelector('[data-tg-open-editor]');
     if (draftEditorButton) draftEditorButton.click();
     await new Promise((resolve) => setTimeout(resolve, 40));
     let draftDrawer = host && host.querySelector('.tg-drawer:not([hidden])');
     const quickToggle = draftDrawer && draftDrawer.querySelector('[data-tg-group-toggle="quick"]');
     if (quickToggle) quickToggle.click();
     const saveCallsBeforeDraft = window.__tgSmokeState && window.__tgSmokeState.saveCharacterCalls || 0;
     const presetButton = host && host.querySelector('[data-tg-preset="smoke-preset"]');
     if (presetButton) presetButton.click();
     await new Promise((resolve) => setTimeout(resolve, 30));
     if (window.__tgSmokeState && window.__tgSmokeState.saveCharacterCalls !== saveCallsBeforeDraft) failures.push('preset unexpectedly saved the character');
     draftDrawer = host && host.querySelector('.tg-drawer:not([hidden])');
     const brief = draftDrawer && draftDrawer.querySelector('#tgBrief');
     const draftButton = draftDrawer && draftDrawer.querySelector('[data-tg-draft]');
     if (brief) brief.value = 'an archivist with a calm voice';
     if (draftButton) draftButton.click();
     await new Promise((resolve) => setTimeout(resolve, 70));
     const draftModal = document.querySelector('.tg-draft-modal');
     if (!draftModal) failures.push('AI draft preview did not open');
     if (draftModal) {
       const draftConfirm = draftModal.querySelector('[data-tg-draft-confirm]');
       if (draftConfirm) draftConfirm.click();
       await new Promise((resolve) => setTimeout(resolve, 30));
       if (window.__tgSmokeState && window.__tgSmokeState.saveCharacterCalls !== saveCallsBeforeDraft) failures.push('AI draft confirmation unexpectedly saved the character');
       const explicitSave = host && host.querySelector('[data-tg-save]');
       if (explicitSave) explicitSave.click();
       await new Promise((resolve) => setTimeout(resolve, 80));
       if (window.__tgSmokeState && window.__tgSmokeState.saveCharacterCalls !== saveCallsBeforeDraft + 1) failures.push('explicit character save was not the only draft write');
     }

    const libraryScroll = host && host.querySelector('.tg-character-list');
    const chatScroll = host && host.querySelector('.tg-chat-surface > .tg-chat-scroll');
    if (libraryScroll && getComputedStyle(libraryScroll).overflowY !== 'auto') failures.push('character list is not independently scrollable');
    if (chatScroll && getComputedStyle(chatScroll).overflowY !== 'auto') failures.push('message area is not independently scrollable');

    // Returning to regular Chat must unmount the Tangguan surface and restore
    // the regular conversation instead of leaving character UI in the DOM.
    if (App.router && App.router.go) App.router.go('chat', { persist: false });
    for (let i = 0; i < 120; i += 1) {
      const restoredMessages = host && host.querySelector('#messages');
      if (restoredMessages && restoredMessages.textContent.includes('regular conversation')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const chatView = document.querySelector('[data-view="chat"]');
    const tavernView = document.querySelector('[data-view="tavern"]');
    const regularChat = App.chat && App.chat.activeConv ? App.chat.activeConv() : null;
    const regularMessages = document.getElementById('messages');
    if (!chatView || chatView.hidden) failures.push('returning to Chat did not show the regular Chat view');
    if (!tavernView || !tavernView.hidden) failures.push('returning to Chat left the Tangguan view visible');
    if (!regularChat || regularChat.id !== 'smoke-regular-conversation') failures.push('returning to Chat did not restore the regular conversation');
    if (regularMessages && !regularMessages.textContent.includes('regular conversation')) failures.push('regular Chat message DOM was not restored');
    const surfaceAfterReturn = App.chat && App.chat.surface ? App.chat.surface() : null;
    if (surfaceAfterReturn && surfaceAfterReturn.owner === 'tavern') failures.push('Tangguan Chat Surface remained mounted after returning to Chat');

    return { viewport: { width: window.innerWidth, height: window.innerHeight }, overflow, bounds: [host, workspace, library, main, surface].filter(Boolean).map(rect), initialActiveId, initialModuleActiveId, initialMessageText, initialWelcomeText, activeId: App.state && App.state.activeId, tavernActiveId: App.chat && App.chat.activeConversationId ? App.chat.activeConversationId('tavern') : null, tavernUi: App.state && App.state.settings && App.state.settings.tavernUi, activeConversation: App.chat && App.chat.activeConv ? (App.chat.activeConv() || null) : null, regularConversations: App.state && App.state.conversations ? App.state.conversations.map((item) => ({ id: item.id, messages: Array.isArray(item.messages) ? item.messages.map((message) => message.content) : null })) : [], moduleConversations: App.chat && App.chat.conversationList ? App.chat.conversationList('tavern').map((item) => ({ id: item.id, tavernCharacterId: item.tavernCharacterId, messages: Array.isArray(item.messages) ? item.messages.map((message) => message.content) : null })) : [], messageText: host && host.querySelector('#messages') ? host.querySelector('#messages').textContent : '', selectedCardHtml: selectedCard ? selectedCard.innerHTML : '', failures };
  })()`, true);
}

async function installDocFixture(win) {
  await win.webContents.executeJavaScript(`(() => {
    const newline = String.fromCharCode(10);
    const lines = [];
    for (let i = 1; i <= 90; i += 1) {
      lines.push('# Chapter ' + i);
      lines.push('This is a long local document line used to keep the outline taller than the available viewport.');
      lines.push('## Detail ' + i + '.1');
      lines.push('The document preview and the outline should stay inside the same adaptive workspace.');
    }
    const firstText = lines.join(newline);
    const secondText = ['# Replacement outline', 'This second document must replace the first outline after switching.', '## Replacement detail', 'The active outline must never retain the previous document headings.'].join(newline);
    App.state.settings.docs = [
      { id: 'smoke-doc', name: 'Adaptive outline document', text: firstText, size: firstText.length, createdAt: Date.now() },
      { id: 'smoke-doc-second', name: 'Replacement outline document', text: secondText, size: secondText.length, createdAt: Date.now() },
    ];
    App.doc.activeId = 'smoke-doc';
    App.persist = () => {};
    if (App.router && App.router.go) App.router.go('doc', { persist: false });
    return true;
  })()`, true);
  await wait(100);
}

async function inspectDoc(win, testCase) {
  return win.webContents.executeJavaScript(`(async () => {
    const failures = [];
    const waitFor = async (selector) => {
      for (let i = 0; i < 120; i += 1) {
        if (document.querySelector(selector)) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    };
    await waitFor('.doc-shell');
    const root = document.documentElement;
    const body = document.body;
    const host = document.getElementById('docView');
    const shell = host && host.querySelector('.doc-shell');
    const main = host && host.querySelector('.doc-main');
    const sidebar = host && host.querySelector('.doc-sidebar');
    const outline = host && host.querySelector('.doc-outline');
    const chat = host && host.querySelector('.doc-chat');
    const rect = (node) => node ? node.getBoundingClientRect() : null;
    const overflow = Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth;
    if (!host || !shell || !main || !sidebar || !outline || !chat) failures.push('real document workspace is missing');
    if (overflow > 1) failures.push('document introduces horizontal overflow ' + overflow);
    if (root.scrollHeight > root.clientHeight + 1) failures.push('document page introduces vertical overflow');
    if (main && main.getBoundingClientRect().height <= 120) failures.push('document main workspace did not retain adaptive height');
    if (sidebar && chat && Math.abs(sidebar.getBoundingClientRect().bottom - chat.getBoundingClientRect().bottom) > 2) failures.push('outline sidebar and right chat panel have different bottom bounds');
    if (outline && outline.getBoundingClientRect().height <= 80) failures.push('outline did not expand with the document workspace');
    if (outline && getComputedStyle(outline).overflowY !== 'scroll' && getComputedStyle(outline).overflowY !== 'auto') failures.push('outline is not independently scrollable');
    if (chat && getComputedStyle(chat).overflow !== 'hidden') failures.push('right document panel does not contain its own layout overflow');
    const secondChip = host && host.querySelector('[data-doc="smoke-doc-second"]');
    if (!secondChip) failures.push('second document fixture is missing');
    if (secondChip) secondChip.click();
    const switchedOutline = host && host.querySelector('#docOutline');
    const switchedTitle = host && host.querySelector('#docDrawerTitle');
    if (!switchedOutline || !switchedOutline.textContent.includes('Replacement outline')) failures.push('outline did not refresh for the switched document');
    if (switchedOutline && switchedOutline.textContent.includes('Chapter 1')) failures.push('outline retained headings from the previous document');
    if (!switchedTitle || !switchedTitle.textContent.includes('Replacement outline document')) failures.push('preview drawer title did not follow the switched document');
    const switchedDrawer = host && host.querySelector('#docDrawer');
    if (!switchedDrawer || !switchedDrawer.classList.contains('open')) failures.push('switching documents did not keep the preview drawer open');
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    return { viewport, overflow, bounds: [host, shell, main, sidebar, outline, chat].filter(Boolean).map(rect), outlineScrollHeight: outline ? outline.scrollHeight : 0, outlineClientHeight: outline ? outline.clientHeight : 0, failures };
  })()`, true);
}

async function inspectCreateTaskSurface(win, testCase) {
  return win.webContents.executeJavaScript(`(async () => {
    const failures = [];
    const waitFor = async (selector) => {
      for (let i = 0; i < 120; i += 1) {
        if (document.querySelector(selector)) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    };
    const root = document.documentElement;
    const body = document.body;
    try {
      App.state.settings.agents = [{ id: 'smoke-task-agent', name: '任务助手', desc: '任务会话 smoke', systemPrompt: '完成任务并如实报告。', model: 'smoke-model-2', temperature: 0.35, topP: 0.85, web: false, tone: '专业', starters: [] }];
      App.router.go('create');
      await waitFor('#createView .create-shell');
      const createHost = document.getElementById('createView');
      const createCatalog = createHost && createHost.querySelector('.create-catalog');
      if (!createHost || !createCatalog) failures.push('Tangchuang library host is missing');
      if (!createCatalog || !createCatalog.querySelector('.create-library-head')) failures.push('Tangchuang library head is missing');
      if (!createCatalog || !createCatalog.querySelector('.create-library-tabs')) failures.push('Tangchuang preset/session tabs are missing');
      if (!createCatalog || !createCatalog.querySelector('[data-create-library-tab="presets"]') || !createCatalog.querySelector('[data-create-library-tab="sessions"]')) failures.push('Tangchuang preset/session tab contract is incomplete');
      const createHeadTitle = createCatalog && createCatalog.querySelector('.create-library-head b');
      const createHeadSubtitle = createCatalog && createCatalog.querySelector('.create-library-head small');
      if (!createHeadTitle || !createHeadSubtitle || getComputedStyle(createHeadTitle).display !== 'block' || getComputedStyle(createHeadSubtitle).display !== 'block' || createHeadSubtitle.getBoundingClientRect().top <= createHeadTitle.getBoundingClientRect().bottom - 1) failures.push('Tangchuang library title and subtitle are not separated');
      if (createCatalog && (createCatalog.querySelector('#catPills, #createSort, #tagPills, [data-cat], [data-tag]'))) failures.push('Tangchuang library still renders category, tag, or sort controls');
      if (createHost && createHost.querySelector('.create-session-header .module-provider-controls, .create-session-header [data-module-provider-account]')) failures.push('Tangchuang session header still exposes an account selector');
      const createModelButton = document.getElementById('modelSelectBtn');
      if (!createModelButton || createModelButton.hidden) failures.push('Tangchuang common model selector is missing');
      if (createModelButton && !createModelButton.textContent.includes('smoke-model-1')) failures.push('Tangchuang module default model is not shown in the common selector');
      if (createHost && createHost.querySelector('[data-tab="templates"], #tplGrid, [data-tpl], #tplModalMask')) failures.push('Tangchuang still exposes the retired template library');
      // v1.1.8 T3：工作流 tab 已隐藏移除——断言入口不存在，且 agent 库正常渲染
      const workflowTab = createHost && createHost.querySelector('[data-tab="workflows"]');
      if (workflowTab) failures.push('Tangchuang workflow tab should be hidden (v1.1.8 T3)');
      const agentTab = createHost && createHost.querySelector('[data-tab="agents"]');
      if (agentTab) agentTab.click();
      await new Promise((resolve) => setTimeout(resolve, 35));
      const createGrid = document.querySelector('#agentGrid');
      if (!createGrid || !createGrid.firstElementChild || createGrid.firstElementChild.id !== 'addAgentBtn') failures.push('Tangchuang new-agent card is not the first grid item');
      const createSearch = document.querySelector('#createSearch');
      if (createSearch) {
        createSearch.value = 'no-match-for-smoke';
        createSearch.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (!document.querySelector('#agentGrid #addAgentBtn') || document.querySelector('#agentGrid')?.firstElementChild?.id !== 'addAgentBtn') failures.push('Tangchuang new-agent card disappeared for an empty search');
        createSearch.value = '';
        createSearch.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      if (${testCase.width} > 900) {
        const createToggle = createCatalog && createCatalog.querySelector('[data-create-library-toggle]');
        if (!createToggle) failures.push('desktop Tangchuang library has no collapse control');
        if (createToggle) createToggle.click();
        await new Promise((resolve) => setTimeout(resolve, 35));
        const collapsedCreate = document.getElementById('createView');
        const collapsedCatalog = collapsedCreate && collapsedCreate.querySelector('.create-catalog');
        const collapsedCreateTab = collapsedCatalog && collapsedCatalog.querySelector('[data-create-library-expand]');
        const collapsedCreateTabStyle = collapsedCreateTab && getComputedStyle(collapsedCreateTab);
        if (!collapsedCreate || !collapsedCreate.classList.contains('create-library-is-collapsed')) failures.push('desktop Tangchuang library did not enter collapsed state');
        if (!collapsedCatalog || Math.abs(collapsedCatalog.getBoundingClientRect().width - 40) > 2) failures.push('desktop Tangchuang library did not collapse to the narrow rail');
        if (!collapsedCreateTab || Math.abs(collapsedCreateTab.getBoundingClientRect().width - 32) > 2 || collapsedCreateTabStyle.fontSize !== '12px' || collapsedCreateTab.getBoundingClientRect().height < 58) failures.push('collapsed Tangchuang library label dimensions are incorrect');
        if (!collapsedCreateTab || collapsedCreateTabStyle.writingMode === 'horizontal-tb' || collapsedCreateTabStyle.textOrientation !== 'upright') failures.push('collapsed Tangchuang library is missing its vertical bookmark');
        if (collapsedCreateTab) collapsedCreateTab.click();
        await new Promise((resolve) => setTimeout(resolve, 35));
        if (document.getElementById('createView')?.classList.contains('create-library-is-collapsed')) failures.push('Tangchuang library did not expand again');
      }
      const card = document.querySelector('[data-agent="smoke-task-agent"]');
      if (!card) failures.push('Tangchuang task agent card is missing');
      if (card) card.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      const start = document.querySelector('#pvStart');
      if (!start) failures.push('Tangchuang task session entry is missing');
      if (start) start.click();
      await new Promise((resolve) => setTimeout(resolve, 90));
      const pane = document.querySelector('#createSessionPane:not([hidden])');
      const paneSurface = document.querySelector('#createChatSurface');
      const surface = App.chat && App.chat.surface ? App.chat.surface() : null;
      const active = App.chat && App.chat.activeConv ? App.chat.activeConv() : null;
      if (App.state.view !== 'create') failures.push('task session escaped Tangchuang');
      if (!pane) failures.push('Tangchuang central session pane did not open');
      if (!paneSurface) failures.push('Tangchuang central Chat Surface is missing');
      if (!surface || surface.owner !== 'create') failures.push('Tangchuang task session did not own its Chat Surface');
      if (!active || active.originModule !== 'create') failures.push('task conversation did not retain originModule=create');
      if (App.state.conversations.some((item) => item && item.originModule === 'create')) failures.push('Tangchuang task conversation leaked into regular Chat state');
      if (!App.chat.conversationList('create').some((item) => item && item.id === (active && active.id))) failures.push('Tangchuang task conversation is missing from its module store');
      if (Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth > 1) failures.push('Tangchuang task drawer introduces horizontal overflow');
      if (pane && ${testCase.width} <= 900 && pane.getBoundingClientRect().right > window.innerWidth + 1) failures.push('narrow Tangchuang session pane exceeds viewport');
      const id = active && active.id;
      if (!active || active.agentId !== 'smoke-task-agent' || active.systemPrompt !== '完成任务并如实报告。' || active.model !== 'smoke-model-2' || active.temperature !== 0.35 || active.topP !== 0.85 || active.web !== false || active.tone !== '专业') failures.push('Tangchuang agent configuration was not attached to the session');
      if (active) {
        active.messages.push({ role: 'user', content: 'old create message must not be copied' });
        App.chat.persistConversation(active);
      }
      const presetTab = document.querySelector('[data-create-library-tab="presets"]');
      const sessionTab = document.querySelector('[data-create-library-tab="sessions"]');
      if (!presetTab || !sessionTab) failures.push('Tangchuang library tabs are not interactive');
      if (sessionTab) sessionTab.click();
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (!document.querySelector('[data-create-session-open="' + id + '"]')) failures.push('Tangchuang create session tab did not use the create sidecar');
      const regularBeforeNewCreateSession = App.state.conversations.length;
      const createBeforeNewSession = App.chat.conversationList('create').length;
      const newCreateSessionButton = document.querySelector('[data-create-new-session]');
      if (!newCreateSessionButton) failures.push('Tangchuang new session action is missing');
      if (newCreateSessionButton) newCreateSessionButton.click();
      await new Promise((resolve) => setTimeout(resolve, 70));
      const inheritedCreate = App.chat.activeConv();
      if (!inheritedCreate || inheritedCreate.id === id) failures.push('Tangchuang new session did not create a new create-sidecar conversation');
      if (!inheritedCreate || inheritedCreate.agentId !== 'smoke-task-agent' || inheritedCreate.systemPrompt !== '完成任务并如实报告。' || inheritedCreate.model !== 'smoke-model-2' || inheritedCreate.temperature !== 0.35 || inheritedCreate.topP !== 0.85 || inheritedCreate.web !== false || inheritedCreate.tone !== '专业') failures.push('Tangchuang new session did not inherit the active agent configuration');
      if (!inheritedCreate || !Array.isArray(inheritedCreate.messages) || inheritedCreate.messages.length !== 0) failures.push('Tangchuang new session copied messages from the previous session');
      const inheritedCreateModelButton = document.getElementById('modelSelectBtn');
      if (inheritedCreateModelButton && !inheritedCreateModelButton.textContent.includes('smoke-model-2')) failures.push('valid create conversation model override is not displayed');
      if (App.state.conversations.length !== regularBeforeNewCreateSession) failures.push('Tangchuang new session changed regular Chat conversations');
      if (App.chat.conversationList('create').length !== createBeforeNewSession + 1) failures.push('Tangchuang new session was not persisted in the create sidecar');
      const renamedCreatePrompt = App.ui.promptModal;
      App.ui.promptModal = async () => 'Renamed create session';
      const renameCreateButton = document.querySelector('[data-create-session-rename="' + id + '"]');
      if (renameCreateButton) renameCreateButton.click();
      await new Promise((resolve) => setTimeout(resolve, 45));
      App.ui.promptModal = renamedCreatePrompt;
      const renamedCreateRow = document.querySelector('[data-create-session-open="' + id + '"]');
      if (!renamedCreateRow || !renamedCreateRow.textContent.includes('Renamed create session')) failures.push('Tangchuang session rename did not persist');
      const originalConfirm = window.confirm;
      window.confirm = () => true;
      const clearCreateButton = document.querySelector('[data-create-session-clear="' + id + '"]');
      if (clearCreateButton) clearCreateButton.click();
      await new Promise((resolve) => setTimeout(resolve, 35));
      window.confirm = originalConfirm;
      const clearedCreate = App.chat.conversationList('create').find((item) => item && item.id === id);
      if (!clearedCreate || clearedCreate.messages.length !== 0) failures.push('Tangchuang session clear did not update only the target session');
      const createSessionRow = document.querySelector('[data-create-session-open="' + id + '"]');
      if (createSessionRow) createSessionRow.click();
      await new Promise((resolve) => setTimeout(resolve, 35));
      const createDeleteConfirm = window.confirm;
      const createModuleCountBeforeDelete = App.chat.conversationList('create').length;
      window.confirm = () => false;
      const deleteCreateButton = document.querySelector('[data-create-session-delete="' + id + '"]');
      if (deleteCreateButton) deleteCreateButton.click();
      await new Promise((resolve) => setTimeout(resolve, 35));
      if (App.chat.conversationList('create').length !== createModuleCountBeforeDelete) failures.push('cancelled Tangchuang deletion changed the sidecar');
      if (!App.chat.conversationList('create').some((item) => item && item.id === id)) failures.push('cancelled Tangchuang deletion removed the session');
      if (App.chat.activeConversationId('create') !== id) failures.push('cancelled Tangchuang deletion changed the active session');
      window.confirm = () => true;
      if (deleteCreateButton) deleteCreateButton.click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      window.confirm = createDeleteConfirm;
      if (App.chat.conversationList('create').some((item) => item && item.id === id)) failures.push('confirmed Tangchuang deletion kept the session in the sidecar');
      if (App.chat.activeConversationId('create') === id) failures.push('confirmed Tangchuang deletion kept the deleted active id');
      if (!window.__tgSmokeState.removeCalls.some((call) => call.module === 'create' && call.id === id)) failures.push('confirmed Tangchuang deletion did not call the create sidecar remover');
      if (document.querySelector('[data-create-session-open="' + id + '"]')) failures.push('confirmed Tangchuang deletion left the row in the UI');
      if (Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth > 1) failures.push('Tangchuang session library introduces horizontal overflow');
      const reopenId = inheritedCreate && inheritedCreate.id;
      // Repeat the same empty-surface check for Tangchuang. This catches the
      // shared composer path that previously called newConversation() without
      // carrying the current module owner.
      App.chat.setActiveConversationId('create', null);
      if (App.create && App.create.openTaskSession) App.create.openTaskSession('');
      await new Promise((resolve) => setTimeout(resolve, 40));
      const beforeDirectCreateRegular = App.state.conversations.length;
      const directCreateInput = document.getElementById('input');
      if (directCreateInput) directCreateInput.value = 'direct Tangchuang smoke message';
      if (directCreateInput && App.chat.send) await App.chat.send();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const directCreate = App.chat.activeConv();
      if (App.state.view !== 'create') failures.push('direct Tangchuang send escaped to regular Chat');
      if (!directCreate || directCreate.originModule !== 'create') failures.push('direct Tangchuang send did not create a Tangchuang conversation');
      if (App.state.conversations.length !== beforeDirectCreateRegular) failures.push('direct Tangchuang send changed regular Chat conversations');
      if (App.create && App.create.closeTaskSession) App.create.closeTaskSession();
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (document.querySelector('#createSessionPane:not([hidden])')) failures.push('Tangchuang session pane close did not hide it');
      if (!reopenId || !App.chat.conversationList('create').some((item) => item && item.id === reopenId && item.originModule === 'create')) failures.push('closing Tangchuang session removed the surviving task conversation');
      if (reopenId && App.create && App.create.openTaskSession) App.create.openTaskSession(reopenId);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const reopened = document.querySelector('#createSessionPane:not([hidden])');
      if (!reopened || App.state.view !== 'create') failures.push('Tangchuang session pane did not reopen inside Tangchuang');
      const reopenedActive = App.chat && App.chat.activeConversationId ? App.chat.activeConversationId('create') : null;
      if (reopenId && reopenedActive !== reopenId) failures.push('reopened Tangchuang session did not restore its conversation');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (document.querySelector('#createSessionPane:not([hidden])')) failures.push('Escape did not close the Tangchuang session pane');
      if (App.create && App.create.closeTaskSession) App.create.closeTaskSession();
    } catch (error) {
      failures.push('Tangchuang task surface smoke failed: ' + (error && error.message ? error.message : String(error)));
    }
    return { viewport: { width: window.innerWidth, height: window.innerHeight }, failures };
  })()`, true);
}

async function inspectRealRenderer(win, testCase) {
  return win.webContents.executeJavaScript(`(async () => {
    const failures = [];
    const waitFor = async (selector) => {
      for (let i = 0; i < 120; i += 1) {
        if (document.querySelector(selector)) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return false;
    };
    const root = document.documentElement;
    const body = document.body;
    try {
      if (window.App && App.router && App.router.go) App.router.go('agent');
    } catch (error) {
      failures.push('real agent route failed: ' + (error && error.message ? error.message : error));
    }
    await waitFor('#agentView .agent-layout');
    const host = document.getElementById('agentView');
    const layout = host && host.querySelector('.agent-layout');
    const main = host && host.querySelector('.agent-main');
    if (!host || !layout || !main) failures.push('real agent layout is missing');
    const overflow = Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth;
    if (overflow > 1) failures.push('real agent introduces horizontal overflow ' + overflow);
    if (layout && layout.getBoundingClientRect().width <= 0) failures.push('real agent layout is collapsed');
    try {
      const thread = window.App && App.agent && App.agent.activeThread ? App.agent.activeThread() : null;
      if (thread && App.agent.restoreThread) {
        thread._liveAnswer = '# Recovered streaming output\\n\\nstable-output';
        thread._liveEvents = [];
        App.agent.restoreThread();
        const answer = document.querySelector('#agentThread .agent-answer');
        if (!answer || !answer.textContent.includes('Recovered streaming output')) failures.push('real renderer lost live streaming output');
      }
    } catch (error) {
      failures.push('real streaming restore check failed: ' + (error && error.message ? error.message : error));
    }
    return { viewport: { width: window.innerWidth, height: window.innerHeight }, failures };
  })()`, true);
}

async function installFixture(win) {
  await win.webContents.executeJavaScript(`(() => {
    const agentSection = document.querySelector('[data-view="agent"]');
    if (agentSection) agentSection.hidden = false;
    document.querySelectorAll('.view').forEach((node) => {
      if (node !== agentSection) node.hidden = true;
    });
    const host = document.getElementById('agentView');
    if (!host) throw new Error('agentView is missing');
    host.innerHTML =
      '<div class="agent-layout">' +
        '<aside class="agent-projects"><div class="agent-projects-head">项目</div></aside>' +
        '<aside class="agent-sessions"><div class="agent-sessions-head">会话</div></aside>' +
        '<main class="agent-main">' +
          '<div class="agent-top"><div class="agent-top-row">' +
            '<div class="agent-field grow"><h1 class="smoke-long-title">非常长的项目标题与工作目录用于验证窄窗口不会挤压标题和顶部控件</h1></div>' +
          '</div></div>' +
          '<div class="agent-thread">' +
            '<div class="agent-msg user"><div class="agent-message-text smoke-long-bubble">用户输入的超长路径 C:\\\\workspace\\\\project\\\\with\\\\a\\\\very\\\\long\\\\folder\\\\name\\\\that\\\\must\\\\wrap</div></div>' +
            '<div class="agent-msg assistant"><div class="agent-answer">' +
              '<h1 class="smoke-long-title">标题很长但必须保持可读并在容器内换行</h1>' +
              '<p>这是用于稳定性收尾版的真实 Markdown 渲染边界检查。</p>' +
              '<pre class="code-block"><div class="code-head"><span>very-long-file-name-that-must-not-push-the-layout.js</span></div><code>const veryLongIdentifier = "abcdefghijklmnopqrstuvwxyz0123456789";\\nconsole.log(veryLongIdentifier);</code></pre>' +
            '</div></div>' +
          '</div>' +
          '<div class="agent-composer"><div class="agent-composer-input-wrap"><textarea></textarea></div><button>发送</button></div>' +
        '</main>' +
      '</div>';
    const layout = host.querySelector('.agent-layout');
    const compact = window.innerWidth <= 900;
    layout.dataset.sidebarMode = compact ? 'compact' : 'wide';
    if (compact) {
      layout.classList.add('agent-layout-compact');
      const projectAside = layout.querySelector('.agent-projects');
      const sessionAside = layout.querySelector('.agent-sessions');
      if (projectAside) projectAside.remove();
      if (sessionAside) sessionAside.remove();
      const tabs = document.createElement('div');
      tabs.className = 'agent-tabs-row';
      tabs.id = 'agentTabsRow';
      tabs.innerHTML = '<div class="agent-expand-tab proj-tab"><span>Project</span></div><div class="agent-expand-tab sess-tab"><span>Session</span></div>';
      layout.insertBefore(tabs, layout.firstChild);
      const openDrawer = (kind) => {
        const old = layout.querySelector('.smoke-drawer');
        if (old) old.remove();
        const drawer = document.createElement('aside');
        drawer.className = kind === 'projects' ? 'agent-projects smoke-drawer' : 'agent-sessions smoke-drawer';
        const headClass = kind === 'projects' ? 'agent-projects-head' : 'agent-sessions-head';
        drawer.innerHTML = '<div class="' + headClass + '"><span>' + (kind === 'projects' ? 'Project' : 'Session') + '</span><div><button class="btn-ghost mini">+ New</button><button class="agent-collapse-btn">&lt;</button></div></div>';
        drawer.querySelector('.agent-collapse-btn').addEventListener('click', () => { drawer.remove(); delete layout.dataset.compactOpen; });
        layout.dataset.compactOpen = kind;
        layout.appendChild(drawer);
      };
      tabs.querySelector('.proj-tab').addEventListener('click', () => openDrawer('projects'));
      tabs.querySelector('.sess-tab').addEventListener('click', () => openDrawer('sessions'));
    } else {
      document.querySelectorAll('.agent-projects-head, .agent-sessions-head').forEach((head) => {
        const actions = document.createElement('div');
        actions.innerHTML = '<button class="btn-ghost mini">+ New</button><button class="agent-collapse-btn">&lt;</button>';
        head.appendChild(actions);
      });
    }
    return true;
  })()`, true);
}

async function inspect(win, testCase) {
  await wait(80);
  return win.webContents.executeJavaScript(`(() => {
    const root = document.documentElement;
    const body = document.body;
    const host = document.getElementById('agentView');
    const layout = document.querySelector('.agent-layout');
    const main = document.querySelector('.agent-main');
    const answer = document.querySelector('.agent-answer');
    const bubble = document.querySelector('.smoke-long-bubble');
    const heading = document.querySelector('.agent-answer h1');
    const code = document.querySelector('.agent-answer .code-block');
    const rect = (node) => node ? ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: node.getBoundingClientRect().width, top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom }) : null;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const overflow = Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth;
    const bounds = [host, layout, main, answer, bubble, heading, code].filter(Boolean).map(rect);
    const rightmost = Math.max(...bounds.map((item) => item.right));
    const failures = [];
    if (viewport.width > ${testCase.width} + 2 || viewport.width < ${testCase.width} - 40) failures.push('window did not reach requested width');
    if (overflow > 1) failures.push('document horizontal overflow ' + overflow);
    if (rightmost > viewport.width + 1) failures.push('content exceeds viewport by ' + (rightmost - viewport.width));
    if (!heading || heading.getBoundingClientRect().height <= 20) failures.push('heading did not retain a readable box');
    if (!bubble || bubble.getBoundingClientRect().height <= 20) failures.push('bubble did not retain a readable box');
    if (!code || code.getBoundingClientRect().width <= 0) failures.push('code block is missing or collapsed');
    const compact = ${testCase.width} <= 900;
    const overflowNow = () => Math.max(root.scrollWidth, body.scrollWidth) - root.clientWidth;
    const hostRect = host.getBoundingClientRect();
    const layoutRect = layout.getBoundingClientRect();
    const expectedGutter = ${testCase.width} <= 640 ? 12 : 16;
    if (Math.abs(layoutRect.left - hostRect.left - expectedGutter) > 1 || Math.abs(hostRect.right - layoutRect.right - expectedGutter) > 1) failures.push('agent layout gutter is not stable');
    if (compact) {
      const tabs = [...document.querySelectorAll('.agent-expand-tab')];
      if (layout.dataset.sidebarMode !== 'compact') failures.push('compact layout marker is missing');
      if (tabs.length !== 2) failures.push('compact layout does not expose exactly two bookmarks');
      if (document.querySelector('.agent-projects, .agent-sessions')) failures.push('compact layout renders a sidebar before opening');
      if (tabs.some((tab) => getComputedStyle(tab).writingMode !== 'vertical-lr')) failures.push('bookmark is not vertical');
      const projectTab = document.querySelector('.proj-tab');
      if (projectTab) projectTab.click();
      const drawer = layout.querySelector('.smoke-drawer');
      const drawerButton = drawer && drawer.querySelector('.btn-ghost.mini');
      if (!drawer) failures.push('bookmark did not open a drawer');
      if (drawerButton && (getComputedStyle(drawerButton).writingMode !== 'horizontal-tb' || getComputedStyle(drawerButton).whiteSpace !== 'nowrap')) failures.push('drawer action button is not horizontal');
      if (drawer && drawer.getBoundingClientRect().right > window.innerWidth + 1) failures.push('drawer exceeds viewport');
      if (overflowNow() > 1) failures.push('drawer introduces horizontal overflow ' + overflowNow());
      const close = drawer && drawer.querySelector('.agent-collapse-btn');
      if (close) close.click();
      if (layout.querySelector('.smoke-drawer')) failures.push('drawer did not close');
    } else {
      const headerButton = document.querySelector('.agent-projects-head .btn-ghost.mini');
      if (headerButton && (getComputedStyle(headerButton).writingMode !== 'horizontal-tb' || getComputedStyle(headerButton).whiteSpace !== 'nowrap')) failures.push('wide layout action button is not horizontal');
    }
    // Account editor regression guard: the model name must retain a usable
    // input box even when the row is wider than a narrow modal.
    if (window.App && App.ui && typeof App.ui.openAccountForm === 'function') {
      try {
        App.ui.openAccountForm('');
        const modelInput = document.querySelector('#accModels .accModelRow');
        const modelRow = document.querySelector('#accModels .model-row');
        const accountForm = document.querySelector('#accountModal .account-form');
        const accountModal = document.querySelector('#accountModal .modal');
        if (!modelInput || modelInput.getBoundingClientRect().width < 150) failures.push('account model name input collapsed');
        if (!modelRow || modelRow.getBoundingClientRect().width < (${testCase.width} <= 720 ? 650 : 682)) failures.push('account model row lost stable width');
        if (!accountForm || accountForm.scrollWidth < accountForm.clientWidth) failures.push('account model row overflow is not contained by its scroller');
        if (!accountModal || accountModal.getBoundingClientRect().width > Math.min(1120, window.innerWidth * .96) + 1) failures.push('account modal exceeds viewport constraint');
        if (${testCase.width} >= 900 && (!accountModal || accountModal.getBoundingClientRect().width < Math.min(1120, window.innerWidth * .96) - 2)) failures.push('account modal is still too narrow on desktop');
        const outputHeader = document.querySelector('#accountModal .model-row-head .h-output');
        if (!outputHeader) failures.push('account model output header is missing');
        const modelHeader = document.querySelector('#accountModal .model-row-head .h-name');
        if (modelHeader && modelInput && getComputedStyle(modelHeader.parentElement).display !== 'none' && Math.abs(modelHeader.getBoundingClientRect().left - modelInput.getBoundingClientRect().left) > 1) failures.push('account model name header is not aligned');
        const close = document.getElementById('accountModalClose');
        if (close) close.click();
      } catch (error) {
        failures.push('account editor smoke failed: ' + (error && error.message ? error.message : String(error)));
      }
    }
    return { viewport, overflow, bounds, failures };
  })()`, true);
}

async function captureFailure(win, dir, testCase) {
  const image = await win.capturePage();
  const filePath = path.join(dir, `ui-${testCase.name}.png`);
  fs.writeFileSync(filePath, image.toPNG());
  return filePath;
}

async function main() {
  const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-ui-'));
  const failureDir = path.join(tempUserData, 'screenshots');
  fs.mkdirSync(failureDir, { recursive: true });
  app.setPath('userData', tempUserData);

  let win;
  const windows = [];
  try {
    console.error('[check:ui] starting Electron');
    await withTimeout(app.whenReady(), 'Electron startup', 10000);
    const failures = [];
    for (const testCase of CASES) {
      win = new BrowserWindow({
        show: false,
        width: testCase.width,
        height: testCase.height,
        webPreferences: { contextIsolation: false, sandbox: false },
      });
      windows.push(win);
      console.error('[check:ui] loading ' + testCase.name);
      await withTimeout(win.loadFile(path.join(ROOT, 'index.html')), 'renderer load ' + testCase.name, 15000);
      await waitForRenderer(win);
      await waitForApp(win);
      const realResult = await inspectRealRenderer(win, testCase);
      await installTangguanFixture(win);
      const tavernResult = await inspectTangguan(win, testCase);
      await installDocFixture(win);
      const docResult = await inspectDoc(win, testCase);
      const createResult = await inspectCreateTaskSurface(win, testCase);
      await installFixture(win);
      const result = await inspect(win, testCase);
      result.tavernDiagnostics = tavernResult;
      result.docDiagnostics = docResult;
      result.createDiagnostics = createResult;
      result.failures = (realResult.failures || []).concat(tavernResult.failures || [], docResult.failures || [], createResult.failures || [], result.failures || []);
      if (result.failures.length) {
        const screenshot = await captureFailure(win, failureDir, testCase);
        failures.push({ case: testCase.name, result, screenshot });
      }
    }
    if (failures.length) throw new Error('UI smoke failed:\n' + JSON.stringify(failures, null, 2));
    console.log(JSON.stringify({ ok: true, cases: CASES.map((item) => item.name) }, null, 2));
  } finally {
    for (const candidate of windows) if (candidate && !candidate.isDestroyed()) candidate.destroy();
    if (app.isReady()) app.quit();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[check:ui] ' + (error && error.stack ? error.stack : error));
    if (app.isReady()) app.exit(1);
    else process.exitCode = 1;
  });
}

module.exports = { CASES, inspect, installFixture, main };
