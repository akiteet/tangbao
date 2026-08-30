<p align="center">
  <img src="assets/logo.png" alt="Tangbao" width="144" />
</p>

<h1 align="center">Tangbao 糖包</h1>

<p align="center">
  <strong>A local-first, private, and extensible AI workspace</strong>
  <br />
  <sub>Bring conversation, creation, development, and knowledge work into one calm and capable desktop environment.</sub>
  <br />
  <sub><a href="README.md">中文</a></sub>
</p>

<p align="center">
  <a href="https://github.com/akiteet/tangbao/releases"><img src="https://img.shields.io/badge/version-1.2.0-1a5cff" alt="Version 1.2.0" /></a>
  <img src="https://img.shields.io/badge/Electron-34.5.8-47848f" alt="Electron 34.5.8" />
  <img src="https://img.shields.io/badge/SQLite-local-2ea44f" alt="Local SQLite" />
  <img src="https://img.shields.io/badge/license-MIT-6e7781" alt="MIT License" />
</p>

---

## Product Positioning

Tangbao is an AI desktop workspace designed for sustained, focused use. Bring your own model services and organize conversations, projects, files, characters, and workflows on your own device. The interface stays composed; the data boundary stays clear; the workspace grows with the way you work.

Tangbao does not lock you to a single model or cloud platform. Connect OpenAI, Doubao, Qwen, Claude, Gemini, or any self-hosted or proxy service compatible with the OpenAI API. Model requests go to the provider you choose; conversations, settings, and local indexes remain on your device.

## Core Capabilities

### One workspace for the complete workflow

- **Chat**: Multi-model conversations, deep thinking, web search, image input, and attachment context for everyday questions, research, and content work.
- **Tangma · Coding**: An AI coding assistant for real projects, with planning, tool use, permissions, Skills, checkpoints, and recovery.
- **Tangdraw · Image**: Text-to-image and image editing with reference images, aspect ratios, and size strategies for rapid visual exploration.
- **Tangread · Documents**: Parse PDF, Word, PPT, and TXT files to create summaries, key points, translations, and outlines.
- **Tangcreate · Agents**: Use preset or custom task roles for isolated tasks and multi-step workflows.
- **Tangguan · Characters**: Manage character cards, isolated conversations, worldbooks, and controlled retrieval for long-running creative work.
- **Custom modules**: Bring your own tools or web pages into the workspace through iframe / webview.

### Three v1.2.1 highlights

- **Desktop pet**: A sprite companion living on your desktop that reacts to Tangma's activity; fixed position with dragging or full-screen free roaming, scaling, and custom import/removal.
- **Faster Tangma execution**: Read-only operations run in parallel, large files are truncated on demand, and events are written in batches — quicker first response with fewer wasted steps; new execution timing profile (first-token latency and per-phase durations).
- **Full-text search & approval memory**: Conversation search upgrades to SQLite FTS5; MCP approvals support "don't ask again this session / always allow", with authorized tools reviewable and revocable at any time.

## Designed For

- Personal research, writing, and content creation
- Software development, code review, and troubleshooting
- Document reading, synthesis, and multilingual work
- Character design, worldbuilding, and multi-character dialogue
- Bringing frequently used local tools or internal web apps into one workbench

## Installation & First Setup

### Install the application

Download `tangbao-1.2.1-setup.exe` from [GitHub Releases](https://github.com/akiteet/tangbao/releases/latest), then run the installer.

### Run from source

```bash
git clone https://github.com/akiteet/tangbao.git
cd tangbao
npm install
npm start
```

The Tangma local backend starts with the application. Use `npm run server` only when you need to debug the backend independently.

### Get started in three steps

1. Open Settings and add an account with an API Base URL, API Key, and model names.
2. Choose accounts and models for each module; register a vision model when image input or generation requires one.
3. Return to the workspace and choose Chat, Tangma, Tangdraw, Tangread, Tangcreate, or Tangguan.

### Package locally

```bash
npm run dist
```

The Windows installer is written to `dist/tangbao-1.2.1-setup.exe`. better-sqlite3 uses the Electron ABI; after changing dependencies or reinstalling them, run:

```bash
npm run rebuild:electron
```

## Tangma & MCP

Tangma follows a plan-first, tool-driven workflow: understand the project, propose a plan, then execute changes after approval. Choose a permission mode to control file writes, command execution, and Skills. Each step is recorded, and interrupted work can be resumed.

Tangma also supports multi-root workspaces, context compaction, the standard `SKILL.md` mechanism, and controlled local evaluations. See [docs/SKILLS.md](docs/SKILLS.md) for installing and invoking Skills.

### Configure MCP

Open **Settings → Prompts → MCP Servers** and enter a servers array:

```json
[
  {
    "id": "filesystem",
    "name": "File system",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/workspace"],
    "enabled": true
  },
  {
    "id": "team-tools",
    "name": "Team tools",
    "transport": "http",
    "url": "https://example.com/mcp",
    "enabled": false
  }
]
```

After saving, click **Test connection** to verify the server and inspect its tool list. Enabled tools are exposed to Tangma as `mcp__server-id__tool-name`; the first call normally requires approval. You can also place an official-format `.mcp.json` in a project root; a project server with the same id overrides the global configuration.

Connections time out after 30 seconds by default, tool calls after 60 seconds, and a single response is truncated beyond 200 KB. MCP tools are not executed in Plan mode.

## Privacy & Data

- API Keys are protected by the operating system keychain and resolved only in the main process; the renderer never receives the plaintext value directly.
- Conversations, settings, attachments, and local indexes are stored on the device in SQLite and the local file repository.
- Tangbao does not choose a cloud provider for you. When you use a remote model or web search, requests are sent to that provider; review its privacy policy before sharing sensitive content.
- Core UI and document parsing assets ship with the application. Some model calls, web search, and remote MCP services require network access.
- Back up important data through the application before uninstalling or upgrading.

## Developer Entry Points

```bash
npm install
npm start
npm test
npm run check:version
npm run check:ui-consistency
npm run check:sqlite
npm run dist
```

The application uses an Electron main process, a restricted preload bridge, and a vanilla HTML/CSS/JS renderer. See [docs/DATA_MODEL.md](docs/DATA_MODEL.md) for the SQLite schema, [docs/UI-SYSTEM.md](docs/UI-SYSTEM.md) for interface conventions, and [docs/CHANGELOG-v1.2.1.md](docs/CHANGELOG-v1.2.1.md) for the complete release record.

## Version & License

The current version is **v1.2.1**. Read the [v1.2.1 release notes](docs/CHANGELOG-v1.2.1.md) for the complete update; historical release notes are available in [docs/](docs/).

Tangbao is released under the [MIT License](LICENSE).
