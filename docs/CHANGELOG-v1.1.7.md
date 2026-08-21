# Tangbao v1.1.7

v1.1.7 is the engineering and experience release. It lands the long-deferred Batch E render-layer split, brings the orphaned Ctrl/Cmd+K command palette to life, paginates image history, adds per-entry enable/disable for Tangguan worldbooks, and surfaces silent failures as explicit warnings. No data model changes.

## Batch E: renderer layer split (engineering)

The three largest files were the target of the deferred refactor. The guiding principle: **move code boundaries, never change function internals** — 340 source-text assertions keep passing because the test source-helper now joins directories instead of reading single files.

- **`agent.js` 3736 → 2075 lines**: render methods extracted into six modules under `src/renderer/views/agent/`:
  - `agent-run-history.js` (showRunHistory + renderRunEvents, the 500-line history panel)
  - `agent-bubbles.js` (message/tool/subagent bubble builders)
  - `agent-approvals.js` (approval/plan/decision cards)
  - `agent-engine-observer.js` (engine observer strip)
  - `agent-layout.js` (main render/projects/sessions/restoreThread)
  - `agent-status.js` (run pill, status summary, resume)
  - Each file is an independent IIFE that `Object.assign`s methods onto `window.App.agent` and re-declares the shared closure helpers (`$` / `agentBase` / `authHeaders` / `workspaceErrorMessage` / `MAX_THREAD_HISTORY`).
- **`main.js` 2947 → 2538 lines**: the skills IPC block (v4) moved verbatim into `src/main/main-skills.js`, registered via dependency injection (`registerMainSkills({ safeHandle, app, getStorageService, getMainWindow })`).
- **Source helper**: `test/agent-runtime/source-helper.js` grew `readRendererSource()` / `readMainSource()` (directory-join, so future splits are covered automatically); 27 test files switched to them.
- **Engine `handleAgent` kept as-is**: its ~12 nested closures (emit/persist/budget/checkpoint) are tightly coupled; splitting equals a refactor with high risk and low benefit. Noted for a later batch.

## Command palette (Ctrl/Cmd + K)

`openCommandPalette` / `renderCommandPalette` / `runCommand` in ui.js were complete but orphaned — the DOM was never created, and search.js also bound Ctrl+K (both listeners fired, opening two masks). Now:

- Command palette DOM + styles landed (`#commandPalette`, input, results).
- Ctrl/Cmd + K opens the palette (module switch, settings/data, cache probe, and local search over conversations/docs/projects/agent threads).
- `runCommand` gained the missing `local:document` / `local:project` / `local:run` branches.
- search.js no longer binds Ctrl+K (local search keeps its toolbar button).

## Image history pagination

The history panel rendered every entry (inline-base64 thumbnails grow the DOM linearly over time). Now it renders 20 entries per page with a "load more" button; searching resets to page one.

## Tangguan worldbook enable/disable

Per-entry checkbox toggles whether a worldbook memory participates in retrieval (`saveMemory` upsert with `enabled`; new entries default enabled; disabled entries show a "已停用" label).

## Tech debt: explicit warnings for silent failures

- Agent event persistence failure (`appendAgentEvent`) warns once per run instead of being silently swallowed (streaming still not blocked).
- `git ls-files` failure in repo-index warns before falling back to directory walking.
- `modules.js` webview `setSize` was already remediated via explicit width/height + resize dispatch (comment documents it).

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

## Upgrade notes

- No database migration; Schema v16 unchanged.
- The render-layer split is behavior-neutral; method names and event flow are identical.
- Command palette changes the Ctrl/Cmd+K behavior: it now opens the palette, not local search (local search stays on the toolbar button).
