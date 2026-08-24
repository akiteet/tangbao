# Tangbao v1.1.8

v1.1.8 is the persistence-integrity, structure, and UI-system release. It fixes a v1.1.6 regression where the image-generation model partition silently reverted to the text group after a restart, completes the main-process domain split (batch F) and the renderer settings split (batch C), and — on the `ui-v118` branch — delivers a ground-up neutral-professional UI redesign across every module, renames the 糖馆 module to `tavern` (with data migration), upgrades the default prompts for chat/糖读/糖馆, and adds work-record bars to 糖读. One SQLite schema migration (v16 → v17) accompanies the persistence fix.

## ui-v118 branch: neutral-professional UI system, tavern rename, prompt upgrades

### Design system

- New `docs/UI-SYSTEM.md` as the single-source spec: a neutral professional direction (ZCode/Linear/GitHub-like tool feel) with a dual-theme token rewrite (pure neutral grays), spacing (`--sp-1..6`), control-height (`--ctl-h-sm|md|lg`), card-padding and modal-width ladders, and a base component layer (`.btn` / `.field` / `.card` / `.row-item` / `.chip` / `.mask` / `.modal`).
- Accent-color RGB linkage fixed so all focus rings follow a custom accent; glass-morphism tokens retired and remapped to flat equivalents; decorative keyframes (shine / jello-press / glow-breathe) removed; the body gradient flattened to solid colors.
- Dark-mode P0 fix: an early `:root` close brace made parsers drop the entire dark variable block; the consistency gate now checks brace balance and dark-block presence.
- Global scrollbar spec unified; 38 `font-size` px literals moved onto the `--fs-*` ladder; pill radius banned on buttons; `scripts/check-ui-consistency.js` (npm run check:ui) enforces 8 FAIL rules so the system cannot regress.

### Module-by-module refactor (12 review rounds)

- **糖包 chat**: context-usage bar moved into the composer tools row; sidebar action rows merged and tightened; a scroll-to-bottom button available in every module.
- **糖馆 / 糖创**: one horizontal card system (`.lib-bar`, two adaptive rows: icon+name+actions / description+tags); compact session rows with 重命名/删除/清空/导出 on a single row; character-card tags rendered inside the card; bookmark tabs aligned in four states; character-library panelization.
- **糖绘**: generation errors shown as compact single-row cards; size icons rendered at true ratio with a unified global sort; the model dropdown lists only models flagged 生图.
- **糖读**: preview drawer triple-close (mask / ESC / same-doc guard); operation messages display a file card + instruction instead of full text (display/payload separated).
- **糖码**: tool-row buttons unified at the 28px control height, connection status merged into one button, agent view polish, equal-width Plan labels (执行/只读).
- **Collapse controls unified** across 糖读/糖馆/糖创: 32×32 buttons with 16px chevron SVGs (right = expand, left = collapse; 糖读's rail narrowed to 28px with a 24px toggle).

### New: 糖读 work-record bars

Every document parse and every analysis (摘要/要点/翻译/拆解, including per-segment progress for long documents) produces a compact record bar reusing the 糖绘 queue-card pattern: status dot + name + result/failure reason + retry + dismiss. Failures persist as records instead of toast-only; done/canceled records auto-dismiss after 10s and failures after 60s; the list shows at most two rows (scroll for more) so the outline section keeps its space when idle.

### 糖馆 renamed to `tavern` (with data migration)

- Renamed across the codebase: module id, `App.tavern`, `#tavernView`, `tavern:*` IPC channels, error codes, conversation fields (`tavernCharacterId`), and file/directory names.
- Load-side migration: `providers.tangguan` → `providers.tavern`, `settings.tangguanUi` → `tavernUi`, and conversation fields remapped in memory; the module-sessions `tangguan.json` bucket is adopted into `tavern.json` automatically on first read (the old file is kept with a `.migrated-*` suffix for rollback).
- Kept intentionally for data safety: the character-library KV key `tangguan:library:v1` (renaming it would orphan every character card), the `tangbao-library.json` storage filenames, the `tg-*` CSS class prefix, and a gateway alias accepting the old module id.

### Prompt upgrades

- **Chat default system prompt**: one line → a structured spec (Markdown discipline with language-tagged code blocks, length adaptation to question complexity, honesty about uncertainty, emoji restraint, refusal of real-harm requests).
- **糖馆 roleplay**: character conversations now use a neutral roleplay base — the base prompt no longer introduces itself as the 糖包 assistant, so it cannot compete with the persona; the character-card header was upgraded from "reference only" to "your identity & behavior definition"; persona-injection failures are loud (console warn + one-shot toast + debug log of the injected length) and minimal cards (name only) get an identity-lock instruction; the mature-content line neutrally states the dual-permission state (global toggle + per-card permission; no-real-harm and no-minors red lines unconditional).
- **AI character draft**: the English key-list prompt became a structured Chinese quality spec — ≥120-character descriptions covering appearance/personality/background, 3-6 concrete traits, 80-200-character in-character openers, example-dialogue format, 3-8 tags.
- **糖读 analysis prompts** (summary/points/translate/outline) gained concrete quality requirements (what to preserve, ordering, caps, short-document handling).
- `settings.prompts` entries default to empty strings and fall back to these built-ins, so users without customized prompts pick the upgrades up automatically — no data migration.

### Fixes

- Entering an old conversation now reliably lands at the very bottom: the full-rebuild and stamp-guard render paths use a settled scroll (immediate + double animation-frame + 250ms compensation) that covers async avatar/image height growth.
- Data-loss guards: drag-reorder no longer persists empty lists; five `acceptStateRevision` guards (accounts / customModules / visionModels / agentThreads / projects) plus default-project overwrite protection keep transient partial snapshots from wiping configured fields.
- Stream-watchdog timeouts now truly disconnect: when the 30s first-byte / 90s idle watchdog fires, the renderer aborts the gateway request so the upstream call is cancelled instead of lingering in the background. Previously each timed-out request kept its upstream connection alive (observed: a rate-limited provider holding requests ~180s before answering 429), so orphaned calls stacked up and exhausted the provider's concurrency quota — surfacing as 糖馆 "总是流式空闲超时". The timeout message now also points at provider rate-limiting/congestion instead of implying a local network fault.

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
