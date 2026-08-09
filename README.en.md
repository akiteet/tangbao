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

Tangbao is a **local-first, privacy-first** all-in-one AI assistant desktop workstation. Chat, coding, image generation, document analysis, and custom agents are unified in a single glassmorphism interface:

- **Local-first & private** — API keys are encrypted by the OS keychain (Electron `safeStorage`) and resolved only in the main process; plaintext never touches disk. Conversations and settings are persisted in a local SQLite database and never pass through any third-party server.
- **Unified multi-account / multi-model** — OpenAI, Doubao, Qwen, Claude, Gemini, and any OpenAI-compatible endpoint under one roof.
- **Six modules in one** — Chat, Coding (Tangma), Image (Tangdraw), Documents (Tangread), Agents (Tangcreate), plus custom modules.
- **No framework, fast** — vanilla HTML/CSS/JS with a glassmorphism UI; highlight.js and PDF.js are vendored for offline use.

## Features

| | Module | Highlights |
|---|--------|-----------|
| 💬 | **Chat** | Multi-model conversation, deep thinking, web search, image input, voice dictation, attachment context |
| 🤖 | **Tangma · Coding Agent** | Local AI coding assistant: multi-project/session, tool calling, Plan mode, permission system, skills |
| 🎨 | **Tangdraw · Image** | Text-to-image + image editing (reference upload), multiple styles and aspect ratios |
| 📄 | **Tangread · Documents** | PDF / Word / PPT / TXT parsing, summaries, key points, translation, outlines |
| 🧩 | **Tangcreate · Agents** | Custom AI personas, prompt template library, multi-step workflows |
| 🔌 | **Custom modules** | Embed your own apps or web pages via iframe / webview |

**Data & privacy**: conversations and settings are stored in local SQLite (`better-sqlite3`); API keys are encrypted with the OS keychain. Nothing is collected or uploaded.

## Installation

- **Install the app**: download `tangbao-1.1.1-setup.exe` from the [GitHub Releases](https://github.com/akiteet/tangbao/releases/latest) page and run it.
- **Run from source**:

```bash
git clone https://github.com/akiteet/tangbao.git
cd tangbao
npm install
npm start          # launches the app (the Tangma local backend starts automatically)
```

> `npm run server` is only for standalone debugging of the Tangma backend; regular use does not need it.
>
> **Package**: `npm run dist` → `dist/tangbao-1.1.1-setup.exe`

## Configuration

v1.1.1 has six permission levels: `plan`, `default`, `acceptEdits`, `auto`, `bypass`, and `sandbox`.

Click the gear icon in the bottom-left → **Settings**:

1. **Add an account** → API Base URL + Key + model list (OpenAI-compatible endpoints supported).
2. Each module can select its own account or custom model.
3. Vision models are added under the "Vision models" tab (partial matching supported, e.g. `gpt-5` → `gpt-5.5`).

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
- Historical note: v1.0.5 → v1.0.6 cleared chat history during a storage migration. Since then the app has moved to stable SQLite persistence — upgrades no longer lose data.

## Development

```
tangbao/
├── src/
│   ├── main/                  # Electron main process (window, IPC, keychain, Tangma backend)
│   ├── preload/               # Safe IPC bridge
│   ├── renderer/              # Main window SPA (views & components)
│   ├── application/           # Renderer service layer (skills / shell / storage ...)
│   ├── core/                  # Domain logic (model capabilities, permissions, completion gate, skills, workspaces)
│   └── infrastructure/        # Infrastructure (SQLite storage, Tangma runtime, model gateway, secrets)
├── docs/                      # Documentation (SKILLS / DATA_MODEL / CHANGELOG / PROMPT_SYSTEM)
├── examples/skills/           # Skill templates & examples
├── index.html                 # Main window entry
├── styles.css                 # Global styles
└── package.json
```

- **Tests**: `npm test` (323 cases covering runtime / storage / permissions / skills / UI contracts)
- **Package**: `npm run dist` (Electron 31 + electron-builder, output in `dist/`)
- **Data model**: see [docs/DATA_MODEL.md](docs/DATA_MODEL.md)

## v1.1.1

- Parallel `explore / test / review` subagents support up to 8 tasks and 3 active workers; extra tasks are queued. Subagents are read-only and the parent owns all writes.
- Results include findings, evidence, checks, duration, and failure reasons. Partial success is marked `degraded`/`blocked` and the collaboration tree is available in run history.
- Installer: `tangbao-1.1.1-setup.exe`. There are six permission levels: `plan / default / acceptEdits / auto / bypass / sandbox`.

## License

[MIT](LICENSE)
