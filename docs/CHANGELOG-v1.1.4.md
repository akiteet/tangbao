# Tangbao v1.1.4

v1.1.4 is the module-boundary and reliability release. It adds the Tangguan character workspace, isolates module sessions, expands image-model capability handling, and makes the UI/runtime checks part of the release contract.

## Tangguan character workspace

- Add a local character-card library with quick presets for a clear assistant, coding partner, study coach, and companion.
- Add AI draft preview with explicit confirmation before a draft is saved.
- Import and export common Tavern/SillyTavern fields, including `character_book.entries`, with bounded starter prompts and safe local avatar handling.
- Protect dirty edits and preserve the selected character/session pointer across reloads and replacement.
- Start a character-scoped chat without modifying ordinary Chat conversations. Character background and example dialogue remain style/reference context and do not replace the base prompt.

## Controlled retrieval

- Add a character-isolated worldbook with keyword/tag retrieval, priority, recency decay, and a token budget.
- Keep an optional embedding index shape for future adapters, but report keyword mode when no real embedding provider is configured.
- Invalidate retrieval indexes and detail caches after worldbook edits; report corruption without damaging the character library.
- Do not introduce a global document RAG index in this release.

## Module isolation

- Move Tangguan and Tangcreate conversations into the versioned `tangbao-module-sessions` sidecar.
- Keep module-owned providers, histories, deletion actions, empty states, and search boundaries separate from ordinary Chat state.
- Migrate legacy module conversations once while preserving the source state and active UI pointers.
- Keep Tangcreate's create entry available even when catalog search has no matches; task sessions start empty and inherit the live agent configuration.

## Image capability adaptation

- Resolve image protocol, legal sizes, response format, and size format by API base plus exact model instead of applying one provider's dimensions globally.
- Add profiles for SenseNova U1/U1 Fast, GPT Image, DALL-E, and Wanx; `gpt-image-2` and `sensenova-u1-fast` start with the common-ratio UI (`1:1`, `16:9`, `9:16`, `4:3`, `3:4`, plus additional ratios), then converge to an explicit provider allow-list when one is returned. Unknown models keep the same fallback without forcing a provider-specific allow-list.
- Preserve custom `imageProtocol`, `imageSizeStrategy`, `imageSizeFormat`, and `imageSizes` model settings. Normalize `x`, `×`, and `*` dimensions internally and restore the provider format at the gateway boundary.
- Revalidate sizes when generating, queueing, retrying, or switching models. Learn allowed sizes from provider errors and persist the learned capability by API Base plus exact model.
- Normalize `b64_json`, Data URL, and remote URL responses. Remote image assets are fetched through the constrained main-process gateway before entering history.

## Reliability and runtime

- Create a durable assistant placeholder before the first streaming byte and update it with request ID, sequence, and stream status.
- Preserve partial output on provider errors, timeouts, renderer reloads, and empty results; avoid duplicate stream nodes and redundant context-bar work.
- Protect account configuration from empty/incomplete snapshots: verify state persistence before writing a new secret and restore the previous account on failure.
- Keep multi-root workspaces, scoped writes, continuation/checkpoint recovery, completion gates, subagent boundaries, and redacted run evidence coherent across renderer, preload, main, and runtime layers.
- Keep API keys in the operating-system secret store; exports, backups, logs, traces, search, and character-card files remain redacted.

## Storage and compatibility

- Keep the core database at Schema v16; no core SQLite migration is introduced by this release.
- Store module sessions, character data, and retrieval indexes in versioned local sidecars / `kv_meta` with revision checks, hashes, migration state, and rollback paths.
- Keep existing v1.1.0, v1.1.1, v1.1.2, and v1.1.3 data readable. Legacy root records continue to migrate under `activeRoot/tangbao-data`.
- Preserve ordinary Chat history while migrating module-owned conversations; uninstall/reinstall does not remove the active data root.

## UI and performance

- Add a bounded, memory-only performance ring buffer (120 samples, disabled by default) for boot, module switch, streaming, persistence, IPC, and list metrics.
- Improve module switching, sidebar search, long-list rendering, account-model editing, Tangguan/Tangcreate library rails, and narrow-window layout behavior.
- Keep image ratio controls, model-specific size labels, collapsed rails, vertical bookmarks, and action buttons stable across desktop and compact layouts.

## Release gates

Run the following before packaging:

```bash
npm test
npm run check:version
npm run check:storage
npm run check:perf
npm run check:electron-abi
npm run check:ui
npm run bench:offline
npm run check:release
git diff --check
```

The UI smoke suite covers `desktop`, `small-desktop`, `compact`, and `narrow`. Windows builds target NSIS; macOS builds target DMG and ZIP artifacts with checksums.

## Verification snapshot

Verified in the current Windows workspace on 2026-08-15:

- `npm test`: 464 tests, 459 passed, 5 skipped because the invoking Node runtime cannot load the local `better-sqlite3` ABI, 0 failed.
- `npm run check:version`: passed for version `1.1.4`.
- `npm run check:storage`: passed with Schema v16 and the `active/tangbao-data` records root.
- `npm run check:perf`: passed; metrics are memory-only and disabled by default.
- `npm run check:electron-abi`: passed with Electron `31.7.7` / Node `20.18.0`.
- `npm run check:ui`: passed for all four smoke windows.
- `npm run bench:offline`: passed with seed `1337`, 8 tasks, 7 successes, and success rate `0.875`.
- `npm run check:release` and `git diff --check`: passed.

## Upgrade notes

- Back up the active data root before installing the release.
- The first startup may migrate legacy module sessions into the sidecar; the source state is preserved and the migration records its status.
- Existing API keys remain in the OS secret store. Re-entering a key is only required when the local secret service or encrypted context is unavailable.
- If the native `better-sqlite3` ABI does not match the invoking Node runtime, SQLite-specific tests may be skipped; run the Electron ABI check and the Electron UI smoke suite in the release environment.
