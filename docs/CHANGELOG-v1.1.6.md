# Tangbao v1.1.6

v1.1.6 is the performance and data-slimming release. It targets the root cause of switch-path jank that persisted through three prior rounds of render-layer fixes, adds a performance observability surface, externalizes chat image attachments to file storage, and optimizes SQLite write-through. No user-facing workflows change.

## Performance observability

- The performance ring buffer (11 metrics: bootMs, moduleSwitchMs, stateSerializeMs, stateBytes, etc.) was instrumented but had no UI surface — making the prior jank fixes blind. The Settings → Data panel now has a "性能诊断" (Performance Diagnostics) card: a toggle to enable/disable the recorder, an export-snapshot button (JSON download), and a clear button. The toggle state persists in `settings.perfEnabled` and bootstraps from localStorage before state loads so bootMs itself can be recorded. The recorder stays pure-memory (no persistence, no communication); the check:perf red line is intact.

## Switch-path jank root cause (batch B)

The three prior rounds (BPE memo, renderMessages content stamp, agent.render reentry stamp) optimized render-layer repainting, but the real hotspot was `activate()` synchronously calling `App.persist()`, which triggered **three full-state serializations** on the switch frame:

1. `JSON.stringify(stateValue)` — full state, no indent, for dirty-check comparison.
2. `JSON.stringify(persisted, null, 2)` — full state, with indent, the actual disk content.
3. `sanitizeFloatState`'s `JSON.parse(JSON.stringify(state))` — a third full deep-copy for float-window state sanitization.

All three included every conversation's messages and base64 attachments, all synchronous on the renderer thread. Session switches went through `activate()` which bypassed `scheduleRoutePersist`'s `setTimeout(0)` deferral — this is why session switches felt worse than module switches.

- **B1**: `activate()`'s `App.persist()` (chat.js:641,682) changed to `setTimeout(() => App.persist(), 0)` — the three serializations move off the switch frame, aligned with module-switch deferral.
- **B2**: `sanitizeFloatState` (state.js:97) no longer does `JSON.parse(JSON.stringify(state))` — replaced with manual shallow-copy sanitization (only top-level fields + delete apiKey). Eliminates the third full-state serialization on every persist.
- **B3**: Tests guard the `createPersistedSnapshot` cache path (unchanged content returns cached snapshot without the second stringify).

## Chat attachments externalized (batch C)

Chat image attachments were inline base64 in `conv.messages[].attachments[].data`, entering state serialization and SQLite `messages.meta` — a single 5MB image made every persist serialize it. This was the volume amplifier on top of the three serializations.

- **C1**: On send, image attachments are saved via `App.services.images.save` (reuses the v1.1.5 image-assets infrastructure). State stores `{name, type, origName, size}` references, not base64. Save failure falls back to inline (data preserved, no loss).
- **C2**: `buildContent` stays synchronous; a new `preloadAttachments(m)` async method preloads name→data before `streamChat` (send + regenerate paths). An LRU cache (40 entries) backs `readImageAsset`.
- **C3**: Lazy migration — rendered imgs with name-but-no-data async-fetch and backfill `src` + `message.attachments[].data`, then persist (files-first, re-runnable).
- **C4**: Quota guard — the image-assets 500MB quota applies; over-quota falls back to inline + toast.

## SQLite write-through optimization (batch D)

- **D1**: `PRAGMA synchronous=NORMAL` (WAL-safe, no fsync per commit) — reduces main-process blocking on every persist.
- **D2**: `syncState` no longer does `clearAll` (11-table DELETE) + full reinsert — now incremental upsert (INSERT OR REPLACE is idempotent) + prune only deleted conversations. Small tables (accounts/providers/agents/etc) upsert without clearing. Failure falls back to clearAll + full reinsert (existing path).

## What's deferred

Batch E (renderer/main/engine split: ~3800 lines across main.js, agent.js, engine handleAgent) is deferred to v1.1.7. It is pure engineering refactoring unrelated to the performance goals of this release; each step requires migrating 25 source-text assertion tests via a new renderer-source-helper. The A-D batches complete the performance and data-slimming objectives.

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

- No database migration; Schema v16 unchanged. SQLite `synchronous` pragma change is transparent (WAL + NORMAL is safe).
- Chat image attachments migrate lazily: old messages with inline base64 will be externalized to files on first render, then persisted as references. The migration is re-runnable and never loses data.
- API keys remain in the OS secret store; nothing about key handling changed.
