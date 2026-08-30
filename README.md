<p align="center">
  <img src="assets/logo.png" alt="糖包 Tangbao" width="144" />
</p>

<h1 align="center">糖包 Tangbao</h1>

<p align="center">
  <strong>本地优先、私密可控的 AI 工作空间</strong>
  <br />
  <sub>把对话、创作、开发与知识工作，收进一个安静而高效的桌面环境。</sub>
  <br />
  <sub><a href="README.en.md">English</a></sub>
</p>

<p align="center">
  <a href="https://github.com/akiteet/tangbao/releases"><img src="https://img.shields.io/badge/version-1.2.0-1a5cff" alt="Version 1.2.0" /></a>
  <img src="https://img.shields.io/badge/Electron-34.5.8-47848f" alt="Electron 34.5.8" />
  <img src="https://img.shields.io/badge/SQLite-local-2ea44f" alt="Local SQLite" />
  <img src="https://img.shields.io/badge/license-MIT-6e7781" alt="MIT License" />
</p>

---

## 产品定位

糖包是一款为长期使用而设计的 AI 桌面工作空间。它支持你接入自己的模型服务，在本机组织对话、项目、文件、角色与工作流；界面克制，数据边界清晰，能力可以随着你的工作方式逐步扩展。

糖包不绑定单一模型或云端平台。你可以使用 OpenAI、豆包、通义千问、Claude、Gemini，以及兼容 OpenAI API 的自建或中转服务。模型请求会发送到你主动选择的服务商；会话、设置和本地文件索引保存在你的设备上。

## 核心能力

### 一套工作空间，覆盖完整工作流

- **对话**：多模型对话、深度思考、联网搜索、图片输入与附件上下文，适合日常问答、研究与内容整理。
- **糖码 · 编码**：面向真实项目的 AI 编程助手，支持计划、工具调用、权限控制、Skills、检查点与中断恢复。
- **糖绘 · 图像**：文生图与图片编辑，支持参考图、比例与尺寸策略，适合快速探索视觉方向。
- **糖读 · 文档**：解析 PDF、Word、PPT 与 TXT，完成摘要、要点、翻译和大纲整理。
- **糖创 · 智能体**：预设或自定义任务角色，执行独立任务与多步骤工作流。
- **糖馆 · 角色**：角色卡、独立会话、世界书与受控检索，适合角色创作与长期设定管理。
- **自定义模块**：通过 iframe / webview 接入你自己的工具或网页。

### v1.2.1 的三项重点

- **桌面宠物**：常驻桌面的精灵伙伴，跟随糖码的运行状态做出反应；支持固定位置拖动与全屏自由漫游、缩放、自定义导入与移除。
- **糖码执行提速**：只读操作并行执行、大文件按需截断、事件批量落库，出字更快、步骤更省；新增执行耗时画像（首字延迟与分段耗时）。
- **全文检索与审批记忆**：会话检索升级 SQLite FTS5 提速；MCP 审批支持「本会话不再询问 / 永久允许」，已授权工具可随时查看与撤销。

## 适用场景

- 个人研究、写作与内容创作
- 软件项目开发、代码审查与问题排查
- 文档阅读、资料提炼与多语言处理
- 角色设定、世界观维护与多角色对话
- 将常用的本地工具或内部网页集中到一个工作台

## 安装与首次配置

### 直接安装

从 [GitHub Releases](https://github.com/akiteet/tangbao/releases/latest) 下载 `tangbao-1.2.1-setup.exe`，运行安装程序即可。

### 从源码运行

```bash
git clone https://github.com/akiteet/tangbao.git
cd tangbao
npm install
npm start
```

糖码本地后端会随应用自动启动。`npm run server` 仅用于独立调试后端。

### 三步开始使用

1. 打开设置，添加账户，填写 API Base URL、API Key 和模型名称。
2. 为不同模块选择账户与模型；需要图像生成时，在视觉模型区域登记对应模型。
3. 返回工作区，选择对话、糖码、糖绘、糖读、糖创或糖馆开始工作。

### 本地打包

```bash
npm run dist
```

Windows 安装包输出至 `dist/tangbao-1.2.1-setup.exe`。better-sqlite3 使用 Electron ABI，修改依赖或重新安装后请先运行：

```bash
npm run rebuild:electron
```

## 糖码与 MCP

糖码采用计划优先、工具驱动的工作方式：先理解项目，再提出计划，获得批准后执行变更。你可以选择权限模式，控制文件写入、命令执行和技能调用的边界；每一步都会留下运行记录，任务中断后可以继续恢复。

糖码还支持多根工作区、上下文压缩、标准 `SKILL.md` 技能机制和本地受控评测。技能安装与调用见 [docs/SKILLS.md](docs/SKILLS.md)。

### 配置 MCP

进入 **设置 → 提示词 → MCP 服务器**，填写 servers 数组：

```json
[
  {
    "id": "filesystem",
    "name": "文件系统",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/workspace"],
    "enabled": true
  },
  {
    "id": "team-tools",
    "name": "团队工具",
    "transport": "http",
    "url": "https://example.com/mcp",
    "enabled": false
  }
]
```

保存后点击 **测试连接**，确认 server 能连接并返回工具清单。启用的工具会以 `mcp__服务id__工具名` 的形式提供给糖码；首次调用默认需要审批。项目根目录也可以放置官方格式的 `.mcp.json`，同名 server 会以项目配置覆盖全局配置。

连接默认超时 30 秒，工具调用默认超时 60 秒，单次输出超过 200KB 会截断。Plan 模式下不会执行 MCP 工具。

## 隐私与数据

- API Key 由操作系统密钥库保护，仅在主进程中解析，渲染界面不会直接取得明文。
- 会话、设置、附件和本地索引保存在设备上的 SQLite 与文件仓中。
- 糖包不会代替你选择云端模型。使用远程模型或联网搜索时，请求会发送到相应服务商；请按服务商的隐私政策管理敏感内容。
- 核心界面与文档解析依赖已随应用提供，部分模型调用、联网搜索和远程 MCP 服务需要网络连接。
- 卸载与升级前建议通过应用内备份能力保存重要数据。

## 开发者入口

```bash
npm install
npm start
npm test
npm run check:version
npm run check:ui-consistency
npm run check:sqlite
npm run dist
```

项目采用 Electron 主进程、受限 preload 桥接与原生 HTML/CSS/JS 渲染层。SQLite 数据结构见 [docs/DATA_MODEL.md](docs/DATA_MODEL.md)，界面规范见 [docs/UI-SYSTEM.md](docs/UI-SYSTEM.md)，完整更新记录见 [docs/CHANGELOG-v1.2.1.md](docs/CHANGELOG-v1.2.1.md)。

## 版本与许可

当前版本为 **v1.2.1**。本版完整更新内容见 [v1.2.1 发布说明](docs/CHANGELOG-v1.2.1.md)；历史版本说明见 [docs/](docs/)。

糖包以 [MIT License](LICENSE) 发布。
