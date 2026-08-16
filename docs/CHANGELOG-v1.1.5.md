# Tangbao v1.1.5

v1.1.5 is the architecture-slimming and release-automation release. It converges duplicated infrastructure code, splits the agent runtime engine into focused modules, makes version bumps a one-command operation, closes the SQLite test coverage gap under Electron, and aligns the chat gateway's prompt-caching behavior with the runtime's capability checks. No user-facing workflows change; all refactors are behavior-neutral and guarded by the offline benchmark's deterministic output.

## Cleanup and hygiene

- Remove the empty legacy `js/` and `server/` directories and fix five stale path references (index.html, main.js, chat.js, kvstore.js) that still pointed at the pre-1.1.0 layout.
- Ignore `.tmp-electron-user-data/` in `.gitignore` so debug profiles never pollute `git status`.
- Decouple `eval-task-contracts` from a machine-bound absolute archive path: the med-007 historical-fixture case now activates via `TANGBAO_EVAL_ARCHIVE_DIR` and skips gracefully when unset.
- Drop the v1.1.1–v1.1.3 installers from local `dist/` (build artifacts only; git was never affected).

## Version automation

- `check-version.js` and `check-release.js` now derive the version from `package.json` (single source) instead of hardcoding it; README anchors are tightened to `tangbao-<version>-setup.exe`.
- New `scripts/bump-version.js` (`npm run bump -- <version>`): replaces the explicit anchor list across package files, the role registry, both runtime version constants, both release workflows, and both READMEs in one command. It preserves historical version sections, refuses to rewrite files that are not JSON-round-trip stable, supports `--dry-run`, warns when the version's CHANGELOG file is missing, and self-verifies via `check-version`. Releasing no longer requires ~11 manual edits.
- The release contract now also requires the `check:sqlite` script.

## Infrastructure convergence

- New `src/infrastructure/http/request-auth.js`: `tokenEqual` / `bearerToken` / `tokenMatches` / `createTokenChecker` / `isLoopbackHost` are shared by the main-process static server and the agent runtime instead of being maintained twice (security-sensitive dedup), with unit tests covering timing-safe comparison, Bearer extraction, debug-mode bypass, and DNS-rebinding host checks.
- New `src/core/util/clone.js` and `src/infrastructure/util/json.js`: `clone` (tool-registry, module-sessions) and `readJson` (legacy-context, tangguan store and indexes) now have one implementation each. `image-capabilities` keeps its local copy because it is a UMD dual-environment module. Atomic-write helpers stay put — their serialization format is coupled to file hash checks.
- New `src/application/services/ipc.js`: the renderer services' IPC fault-tolerant wrappers (`fs`, `skills`, `module-sessions`) converge on one entry point with per-caller fallbacks and a unified enriched error shape; ipc.js is loaded before other services.
- Renderer `search.js` delegates to `App.escapeHtml`; both `tangguan-store` files carry explicit layering notes.

## Agent runtime engine split (behavior-neutral)

The 4158-line `agent-runtime-engine.js` is now 3700 lines with four new focused modules; all call sites and wire behavior are unchanged, verified by the full test suite and byte-identical offline benchmark output (seed 1337, success rate 0.875):

- `agent-server-http.js` — HTTP transport layer: server creation, the entry guard chain (loopback Host → OPTIONS → Bearer token), CORS, JSON/SSE send helpers, and body reading, with the runtime-mutable `ALLOW_ORIGIN` injected as a getter. The business route table stays in the engine.
- `tool-runtime.js` — the 227-line tool protocol definitions (formerly `LEGACY_TOOL_DEFINITIONS`, now rightly named `TOOL_DEFINITIONS`) live next to the registry builder that consumes them, including the multi-root `rootId` injection.
- `search-providers.js` — Tavily / Bing / DuckDuckGo providers and the `doSearch` orchestration (a dead `firstAttr` helper with zero references was dropped).
- `run-registry.js` — the runtime state singletons (approvals, decisionsPending, jobs, approvedFiles, runAuthRegistry, sessions) plus `killTree` / `killRunJobs` / `killRunSessions`; the engine destructures the same instances, so no call site changed.

The remaining engine bulk (agent loop, tool implementations, handleAgent) is slated for v1.1.6, as is the renderer/main-process split deferred from this release's stretch batch.

## Prompt caching alignment

- The gateway's non-OpenAI chat path now consults `capabilities.promptCachingMode` before injecting `cache_control`, matching the runtime's `callLLMStream`: reasoning-class models (deepseek-r1 / o1 / o3 / thinking, mode `off`) no longer send cache markers, and the renderer can still force-disable via `promptCaching: false`.
- Audit confirmed the rest of the planned feature already shipped in v1.1.3/v1.1.4 (adapter-side cache_control injection, cached-token usage normalization, `model_call_metrics.cache_json` persistence, cache probe and hit-rate/savings panels), so no Schema change was needed — the database stays at Schema v16.

## SQLite tests under Electron

- New `npm run check:sqlite` runs `storage-search-metrics` under Electron's Node runtime (`ELECTRON_RUN_AS_NODE=1`, matching native ABI): the four cases that structurally skip in plain-Node `npm test` now execute for real. The CI ui job (which already rebuilds natives for Electron) runs this step, closing the gap that previously left real database logic covered only by the `select 1` ABI smoke.

## UI performance and consistency

- Remove `backdrop-filter` from the three always-visible large surfaces (sidebar, topbar, and every assistant message card). At 88%+ background opacity over a smooth gradient the blur contributed almost nothing visually, but forced a blur recomposite on every stream chunk, scroll, and sidebar update — the main source of visible jank on Windows. Glass blur is retained on small transient overlays (modals, dropdowns, command suggestions, approval bar, memory card) where the cost is negligible.
- Revision after user feedback: assistant message cards were left without a background by the first pass (the glass background shared a line with the removed filter); they now use a solid `--panel-bg` surface with a visible `--border-strong` edge, clearly separated from the gradient background and the light-blue user bubble in both themes.
- Unify all monospace rendering on the existing `--font-mono` token: ten hardcoded font stacks across three different variants (plus one inline style in the agent memory editor) now resolve identically on every platform.
- Tokenize border radii onto the six-step scale (`--radius-xs/md/sm`/`--radius`/`--radius-lg`/`--radius-pill`): 150 single-value declarations mapped, two new fine-grained tokens (`xs`/`md`) added and wired into the appearance radius slider so all corners scale together. Multi-value bubble-tail radii and circles are intentionally untouched.
- Switch-path jank (second revision): `estimateTokens` gains an LRU memo so re-entering a conversation no longer re-runs o200k BPE over unchanged messages (the context-usage bar and compaction decisions were the largest synchronous task on conversation switch); `renderMessages` now guards on a content stamp (conversation id + count + content/think length sum + last stream status) so module round-trips reuse the existing DOM; the agent (糖码) view skips its full `innerHTML` rebuild on module re-entry when a structural stamp (model, project, roots, collapse state, thread, run state) is unchanged — state-change re-renders inside the view are untouched.

## Tangbu (image) module upgrade

Full interaction and UI upgrade per `糖绘v1.1.5升级计划.md` (planned as five batches, all shipped):

- Closing the edit loop: the lightbox gains "use as reference" (one click feeds a generated or historical image back into the edit flow) plus "copy image" to clipboard. Prompt text and the reference image now survive module round-trips (draft save/restore on re-render), and preset naming uses an inline input instead of a blocking `window.prompt`.
- Queue feedback: visual task cards (running with live elapsed time, queued with position and removable, failed with full error on hover and retry, canceled); skeleton placeholders match the selected aspect ratio; queue status and result status are separate slots that no longer overwrite each other.
- Lightbox and grid: keyboard control (Esc/arrows), double-click zoom toggle with wheel step zoom (1–4x) and drag panning; grid cards render at the true image aspect ratio (no more fixed-height cropping of tall images); downloads are named by the actual sniffed MIME type; the lightbox shows model/ratio/time metadata.
- History storage overhaul: images move from inline base64 in settings to files under `tangbao-data/images/` via new whitelisted main-process IPC (`image:saveAsset/readAsset/deleteAsset`) — the renderer never gains arbitrary-path file access. Settings keep a lightweight index; legacy inline entries migrate automatically on first open (files written before the index switches, re-runnable); a 500MB directory quota guards runaway growth; on save failure entries fall back to the inline format so no data is lost.
- History management: per-entry delete (removes its files), clear-all with a non-blocking confirm dialog, prompt search, view-all expansion for entries beyond four thumbnails, and per-image compare selection with model/ratio/time difference highlighting. History cap raised 30 → 200.
- First image-module media queries (≤900px / ≤560px): stacked option labels, single-column advanced params, touch-friendlier lightbox navigation, adaptive grid and history layout.

## Release gates

Run the following before packaging:

```bash
npm test
npm run check:version
npm run check:storage
npm run check:perf
npm run check:electron-abi
npm run check:sqlite
npm run check:ui
npm run bench:offline
npm run check:release
git diff --check
```

## Verification snapshot

Verified in the current Windows workspace on 2026-08-16:

- `npm test`: 472 tests, 467 passed, 5 skipped (4 SQLite ABI cases covered by `check:sqlite` under Electron, 1 archive-dependent case gated on `TANGBAO_EVAL_ARCHIVE_DIR`), 0 failed.
- `npm run check:sqlite`: 4 tests, 4 passed, 0 skipped under Electron `31.7.7`.
- `npm run check:version`: passed for version `1.1.5`.
- `npm run check:storage`: passed with Schema v16 unchanged.
- `npm run check:perf`: passed; metrics remain memory-only and disabled by default.
- `npm run check:electron-abi`: passed with Electron `31.7.7` / Node `20.18.0`.
- `npm run check:ui`: passed for all four smoke windows.
- `npm run bench:offline`: passed with seed `1337`, 8 tasks, success rate `0.875` — identical to the v1.1.4 snapshot, confirming behavior-neutral refactors.
- `npm run check:release` and `git diff --check`: passed.

## Upgrade notes

- No database migration; Schema v16 data from v1.1.0–v1.1.4 remains readable as-is.
- API keys stay in the OS secret store; nothing about key handling changed.
- The standalone debug server (`node src/infrastructure/agent-runtime/agent-server.js`) keeps its loopback-only lenient mode; no configuration is required.
- To enable the historical eval-archive test case, set `TANGBAO_EVAL_ARCHIVE_DIR` to the local `eval-runs-archive-*` directory; it is optional and skips cleanly without it.
