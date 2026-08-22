<br>
<p align="center">
  <img src="assets/logo.png" alt="Tangbao" width="160" />
</p>
<h1 align="center">Tangbao 糖包</h1>
<p align="center">
  <strong>A local-first, all-in-one AI assistant desktop workstation</strong>
  <br/>
  <sub><a href="README.md">中文</a></sub>
</p>

---

> A "pure frontend + local backend" AI desktop app built with Electron, with zero cloud-service dependencies. Bring your own API keys — chat, coding, image generation, and document analysis all happen locally. Keys never leave your machine; your data stays yours.

## Overview

Tangbao is a **local-first, privacy-first** all-in-one AI assistant desktop workstation. Chat, coding, image generation, document analysis, character workspaces, and task agents are unified in a single glassmorphism interface:

- **Local-first & private** — API keys are encrypted by the OS keychain (Electron `safeStorage`) and resolved only in the main process; plaintext never touches disk. Conversations and settings are persisted in a local SQLite database and never pass through any third-party server.
- **Unified multi-account / multi-model** — OpenAI, Doubao, Qwen, Claude, Gemini, and any OpenAI-compatible endpoint under one roof.
- **Six built-in modules in one** — Chat, Coding (Tangma), Image (Tangdraw), Documents (Tangread), Agents (Tangcreate), and Characters (Tangguan), plus custom modules.
- **No framework, fast** — vanilla HTML/CSS/JS with a glassmorphism UI; highlight.js and PDF.js are vendored for offline use.

## Features

| | Module | Highlights |
|---|--------|-----------|
| 💬 | **Chat** | Multi-model conversation, deep thinking, web search, image input, voice dictation, attachment context |
| 🤖 | **Tangma · Coding Agent** | Local AI coding assistant: multi-project/session, tool calling, Plan mode, permission system, skills |
| 🎨 | **Tangdraw · Image** | Text-to-image + image editing (reference upload), multiple styles and aspect ratios |
| 📄 | **Tangread · Documents** | PDF / Word / PPT / TXT parsing, summaries, key points, translation, outlines |
| 🧩 | **Tangcreate · Agents** | Preset/custom agents, isolated task sessions, multi-step workflows |
| 🎭 | **Tangguan · Characters** | Character cards, isolated chats, character-scoped worldbooks and retrieval |
| 🔌 | **Custom modules** | Embed your own apps or web pages via iframe / webview |

**Data & privacy**: conversations and settings are stored in local SQLite (`better-sqlite3`); API keys are encrypted with the OS keychain. Nothing is collected or uploaded.

## Installation

- **Install the app**: download `tangbao-1.1.7-setup.exe` from the [GitHub Releases](https://github.com/akiteet/tangbao/releases/latest) page and run it.
- **Run from source**:

```bash
git clone https://github.com/akiteet/tangbao.git
cd tangbao
npm install
npm start          # launches the app (the Tangma local backend starts automatically)
```

> `npm run server` is only for standalone debugging of the Tangma backend; regular use does not need it.
>
> **Package**: `npm run dist` → `dist/tangbao-1.1.7-setup.exe`

## Configuration


Click the gear icon in the bottom-left → **Settings**:

1. **Add an account** → API Base URL + Key + model list (OpenAI-compatible endpoints supported).
2. Each module can select its own account or custom model.
3. Vision models are added under the "Vision models" tab (partial matching supported, e.g. `gpt-5` → `gpt-5.5`).
4. Image model details can define the image protocol, size strategy, and custom sizes; `gpt-image-2` and `sensenova-u1-fast` start with the full common-ratio set and converge to a model-specific enumeration when the provider returns one.

## Tangma · Coding Agent

Tangma is a built-in local AI coding agent that follows a plan-first, tool-driven interaction paradigm, built for real project development:

- **Plan mode** — explores read-only and produces a task list; asks you proactively when uncertain (question + options + custom input, single/multi-select); prompts a "plan approval" card on the first file write, then switches to execution mode automatically once approved.
- **Permission system** — 6 permission levels (plan / default / acceptEdits / auto / bypass / sandbox) plus project rules (always allow / always deny / command whitelist), with suggestions when an operation is denied.
- **Skills** — standard `SKILL.md` mechanism (compatible with `.claude/skills`, `.codex/skills` directories); import, enable/disable, and quarantine skills from the settings panel.
- **Run history & recovery** — checkpoints every step; interrupted runs can be **precisely resumed** with automatic continuation; the history panel supports paged browsing and search.
- **Context management** — automatically compacts long conversations while preserving plans, errors, and change records to avoid context overflow.
- **Multi-root workspaces** — attach multiple folders to one project and scope writes per task (single / multi / all roots).
- **Local safe eval** — built-in controlled evaluation tasks (isolated fixtures) with one-click batch runs for a security baseline.

## Skills

Tangma supports a mainstream agent-skills mechanism: drop a `SKILL.md` into a convention directory and it is loaded automatically; you can also invoke it explicitly (`/skills`, `/skill <name>` in chat, or via the `list_skills` / `use_skill` tools).

- 📖 Guide: **[docs/SKILLS.md](docs/SKILLS.md)**
- 🧩 Templates & examples: **[examples/skills/](examples/skills/)** (`template` blank template + `demo-code-review` example)

```bash
# Install an example skill into your project in one minute
cp -r examples/skills/demo-code-review <project>/.workbuddy/skills/
```

## Data & Upgrade Notes

- Data lives in the app data directory (SQLite + config); uninstalling/reinstalling does not delete it. It is recommended to back up before upgrading.
- Tangguan character data and Tangguan/Tangcreate module sessions use versioned local sidecars; the first upgrade migrates legacy module sessions while ordinary Chat history stays in the main state.
- Historical note: v1.0.5 → v1.0.6 cleared chat history during a storage migration. Since then the app has moved to stable SQLite persistence — upgrades no longer lose data.

## Development

```
tangbao/
├── src/
│   ├── main/                  # Electron main process (window, IPC, keychain, Tangma backend)
│   ├── preload/               # Safe IPC bridge
│   ├── renderer/              # Main window SPA (views & components)
│   ├── application/           # Renderer service layer (skills / shell / storage ...)
│   ├── core/                  # Domain logic (model capabilities, permissions, completion gate, skills, Tangguan, workspaces)
│   └── infrastructure/        # Infrastructure (SQLite, module sidecars, Tangguan indexes, Tangma runtime, gateway, secrets)
├── docs/                      # Documentation (SKILLS / DATA_MODEL / CHANGELOG / PROMPT_SYSTEM)
├── examples/skills/           # Skill templates & examples
├── index.html                 # Main window entry
├── styles.css                 # Global styles
└── package.json
```

- **Tests**: `npm test` (487 cases; 482 pass, 5 skipped — 4 SQLite-ABI cases run for real under Electron via `npm run check:sqlite`, 1 eval-archive case needs `TANGBAO_EVAL_ARCHIVE_DIR` — 0 failures)
- **Release gates**: `npm run check:version`, `npm run check:storage`, `npm run check:perf`, `npm run check:electron-abi`, `npm run check:sqlite`, `npm run check:ui`, `npm run check:release`, and `npm run bench:offline`
- **Package**: `npm run dist` (Electron 31 + electron-builder, output in `dist/`)
- **Data model**: see [docs/DATA_MODEL.md](docs/DATA_MODEL.md)

## Version history

### v1.1.7 (engineering & experience)

- **Batch E renderer split**: agent.js 3736 → 2075 lines, render methods extracted into 6 modules (run-history/bubbles/approvals/engine-observer/layout/status); main.js skills IPC moved to main-skills.js; 340 source-text assertions covered via directory-joining source-helper.
- **Command palette (Ctrl/Cmd + K)**: landed the orphaned implementation — module switch, settings, cache probe, local search over conversations/docs/projects/threads; fixed the double-binding clash with local search.
- **Image history pagination**: 20 per page + load more; no more linear DOM growth from inline base64.
- **Tanguan worldbook enable/disable**: per-entry toggle (disabled entries skip retrieval).
- **Tech debt**: agent event persistence and git ls-files failures now warn explicitly instead of being swallowed.

See [docs/CHANGELOG-v1.1.7.md](docs/CHANGELOG-v1.1.7.md).

### v1.1.6 (performance & data slimming)

- **Switch-path jank root cause fixed**: `activate()` synchronously triggered three full-state serializations (incl. base64 attachments) — persistence moved off the switch frame, float sanitization switched to manual shallow copy, attachments externalized.
- **Chat attachments externalized**: images are saved to file storage on send (reusing the image-assets infrastructure); state stores references only, lazy migration for old inline base64, over-quota falls back to inline without loss.
- **Performance observability**: Settings → Data → Performance Diagnostics (toggle / export snapshot / clear), 11 metrics visible.
- **SQLite write-through optimized**: `PRAGMA synchronous=NORMAL` + incremental upsert in `syncState` (clearAll fallback), main-process blocking reduced.
- **UI refresh**: design tokens, spring micro-motions, glass layering, unified component styles; semantic color tokens (danger/success/warning).
- **Typography**: bundled JetBrains Mono (OFL, offline) for code/data, CJK fallbacks completed, font-size ladder tokenized.
- **Doc Reader enhanced**: persistent Q&A history, stop generation, translation direction, long-document segmentation, Word/PPT parsing, rename/export/doc-limit hints.
- **Data reliability**: fixed the streaming partial-persistence wiring gap (P0, once blanked state.json); SQLite fallback restored, startup auto-heals.

See [docs/CHANGELOG-v1.1.6.md](docs/CHANGELOG-v1.1.6.md).

### v1.1.5

- Architecture slimming: the 4158-line agent runtime engine now delegates to four focused modules (HTTP transport `agent-server-http`, tool protocol definitions renamed and relocated into `tool-runtime`, search providers `search-providers`, runtime state registry `run-registry`) with zero behavior change — the offline benchmark stays byte-identical to v1.1.4 (seed 1337, success rate 0.875).
- Infrastructure convergence: the main process and the agent backend share one HTTP auth implementation (timing-safe compare + loopback checks); readJson/clone/escapeHtml and the renderer IPC fault-tolerant wrappers each collapse to a single implementation.
- Release automation: `npm run bump -- <version>` performs every release version replacement in one command (dry-run and historical-section protection included); check:version / check-release now derive the version from package.json as the single source.
- Prompt caching alignment: the gateway chat path consults the capability check just like the runtime — reasoning-class models no longer send cache_control. The database stays at Schema v16; no migration.
- Test hardening: `npm run check:sqlite` runs SQLite cases under the Electron runtime (the 4 structural skips in plain Node are covered in CI), wired into the release contract.

See [docs/CHANGELOG-v1.1.5.md](docs/CHANGELOG-v1.1.5.md) for details.

### v1.1.4 (historical)

- Tangguan character workspace: presets, AI draft preview, dirty-state protection, JSON import/export, and common Tavern/SillyTavern fields including `character_book.entries`.
- Isolated module sessions: Tangguan character chats and Tangcreate task sessions stay in their own sidecar, with safe switching, deletion, and empty-state behavior.
- Controlled character RAG: retrieval is limited to the active character's worldbook and ranked by keywords, tags, priority, recency, and token budget. Without real embeddings the app reports keyword mode and never introduces a global document index.
- Capability-driven image generation: resolve protocol, legal sizes, response format, and size format by API base plus exact model; include SenseNova U1/U1 Fast, GPT Image, DALL-E, Wanx, URL responses, and provider error enumeration learning.
- Custom image capabilities: account models can save protocol, size strategy, and `imageSizes`; `gpt-image-2`, `sensenova-u1-fast`, and unknown models expose a full common-ratio UI including `1:1`, `16:9`, `9:16`, `4:3`, and `3:4`, while queued, running, and retried tasks revalidate sizes.
- Streaming reliability: create a recoverable assistant placeholder before the first byte, throttle sequence-aware partial saves, preserve partial output on failures/reloads, and restore old account state if persistence or secret writes fail.
- Storage and compatibility: keep Schema v16; versioned sidecars/`kv_meta` hold module sessions, character data, and indexes with hash-verified migration and rollback. API keys stay out of card exports, backups, logs, traces, and search.
- Performance and UI: add a bounded, disabled-by-default in-memory performance ring buffer; improve module switching, streaming rendering, sidebar search, long-list rendering, and narrow-window layouts, covered by four Electron smoke windows.
- Release gates: version, storage, performance, Electron ABI, UI, offline benchmark, and platform packaging checks are part of the v1.1.4 closure.

See [docs/CHANGELOG-v1.1.4.md](docs/CHANGELOG-v1.1.4.md) for the detailed release notes and upgrade guidance.

### v1.1.3 (historical)

- Stability loop: migration state, staged copy verification, rollback, recovery center, SQLite/state audits, backups, and quarantine cleanup previews.
- Model and Cache management: Provider Health, model profiles, unified model-call metrics, and a user-triggered real Cache Probe. Missing provider Usage remains unknown.
- Productivity: `Ctrl/Cmd + K` command palette, paginated local search, notifications, and consistent loading/failure/cancelled states.
- Agent engineering: read-only Trace Inspector, collaboration tree, normalized Budget/Abort/Error handling, redacted exports, and reproducible Runtime Offline Benchmarks.
- After a data-location migration, the app can automatically recover the legacy Windows secret context when the ciphertext matches. API keys never enter ordinary backups, diagnostics, or Trace exports.

### v1.1.1 (historical)

- Parallel `explore / test / review` subagents support up to 8 tasks and 3 active workers; extra tasks are queued. Subagents are read-only and the parent owns all writes.
- Results include findings, evidence, checks, duration, and failure reasons. Partial success is marked `degraded`/`blocked` and the collaboration tree is available in run history.
- Installer: `tangbao-1.1.1-setup.exe`. There are six permission levels: `plan / default / acceptEdits / auto / bypass / sandbox`.

## License

[MIT](LICENSE)
