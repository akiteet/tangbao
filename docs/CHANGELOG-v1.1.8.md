# Tangbao v1.1.8

v1.1.8 is the persistence-integrity and structure release. It fixes a v1.1.6 regression where the image-generation model partition silently reverted to the text group after a restart, completes the main-process domain split (batch F), and continues the renderer split into the settings layer (batch C). One SQLite schema migration (v16 → v17) accompanies the fix.

## P0 fix: image model partition flag survives restart

In v1.1.6 the account settings gained a two-group model partition ("对话/文本" vs "生图") driven by an `imageModel` boolean flag on each model row. Users who flipped a model to the image group and kept the default image options (protocol = auto, strategy = auto, sizes empty) lost the classification on every restart:

- **Root cause 1**: the startup normalizer `applyLoaded` rebuilds each model object from a field whitelist (`src/renderer/state/state.js`). The whitelist carried the older optional image fields (`imageProtocol` / `imageSizeStrategy` / `imageSizeFormat` / `imageSizes`, added in v1.1.4) but never gained the newer `imageModel` boolean. A pure-flag row was stripped on load — and the next persist then wrote the stripped version back to disk, making the loss permanent.
- **Root cause 2**: the SQLite mirror could not represent any image fields at all (`account_models` had no image columns; both the write path in `sqlite-store.js` and the read path in `migrator.js` dropped them). Any load that fell back to SQLite also reverted configured protocol/size settings.

**Fix**:

- `applyLoaded` whitelist now round-trips `imageModel`.
- Schema migration 16 (v16 → v17) adds `image_model INTEGER NOT NULL DEFAULT 0` and `image_extra TEXT` (JSON: protocol / strategy / format / sizes) to `account_models`; `setAccountModels` writes them, `readState` restores them.
- New test file `test/agent-runtime/image-partition-persistence.test.js`: vm-based `applyLoaded` round-trip, schema v17 migration + idempotency, and a real-SQLite round-trip wired into the Electron-ABI channel (`check:sqlite`).

**Data note**: models whose pure `imageModel:true` flag was already固化-stripped before this upgrade cannot be recovered automatically — re-mark them once in Settings → 账户. Models that had protocol/strategy/sizes configured are rescued automatically by the existing partition heuristic.

## Batch F: main.js domain split complete

Following the `createMainSkills` factory precedent from v1.1.7, all four deferred domains moved out of the main process entry:

- **`main-storage.js`** — `createMainStorage(deps)`: lazy SQLite singleton, data-location move flow, backup/restore/diagnostics/migration/import-export IPC. Returns `getStorageService` / `readActiveStateObject` / `getStorageFileRepo` for the other domains. The `state.json` cluster (revision gate, atomic write, chat partials, `fs:*`) stays in `main.js`; the revision gate and atomic writer are injected back via deps.
- **`main-tangguan.js`** — `createMainTangguan(deps)`: all 20 `tangguan:*` handlers plus the store singleton.
- **`main-agent-runs.js`** — `createMainAgentRuns(deps)`: run history/trace export/controlled eval/context-summary IPC; returns `createRunStoreProxy(getStorageService)` for the agent-server backend injection.
- **`main-float.js`** — `createMainFloat(deps)`: float window lifecycle, bounds/state persistence, `redactFloatStateJson`, and all `float:*` IPC; returns `toggleFloatWindow` / `restoreFloatWindowIfOpen` / `closeAllFloatWindows` for startup restore, tray, global hotkey and the main-window closed hook.

`main.js` is now **2560 → 1473 lines**. Every cut passed the two-way identifier audit (undefined sources inside the module + stale references in the host), full tests and the four-window Electron smoke.

## Batch C: ui.js settings-layer split

The same batch-E pattern (independent IIFE + `Object.assign(window.App.ui, {...})`, loaded after ui.js, closure helpers redeclared per file) extracted five modules into `src/renderer/components/`:

- `ui-sidebar-topbar.js` — sidebar rendering/topbar title/think & web toggles/model select
- `ui-command-palette.js` — palette open/render/run
- `ui-settings-storage.js` — data location/storage audit/secret store/model health & metrics
- `ui-skills-panel.js` — skills panel, details modal, quarantine
- `ui-accounts.js` — account list/form, model rows (including the image partition controls)

`ui.js` is now **2857 → 1506 lines**. The source helper gained `readComponentsSource()` (directory join over `src/renderer/components/`); 12 test files switched to it.

## Deferred: chat.js split

A closure-dependency audit found the candidate blocks lean on 3–14 shared helpers each, including the module-session persistence layer (~140 lines). Copying that surface into three files would duplicate core storage logic around the streaming path for modest line-count gain — the same risk/benefit call as v1.1.7's engine `handleAgent`. Deferred with evidence recorded in the handoff document.

## Verification

- Full suite: 497 tests / 491 pass / 0 fail / 5 skipped (+1 real-SQLite case skipped under plain Node, covered by `check:sqlite` under Electron ABI).
- Gates: version / storage / perf / release checks green at 1.1.8.
- Electron UI smoke: desktop / small-desktop / compact / narrow all pass.
