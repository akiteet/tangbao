<br>
<p align="center">
  <img src="assets/logo.png" alt="Tangbao" width="160" />
</p>
<h1 align="center">糖包 Tangbao</h1>
<p align="center">
  <strong>本地优先的全能 AI 助手桌面工作站</strong>
  <br/>
  <sub><a href="README.en.md">English</a></sub>
</p>

---

> 一个「纯前端 + 本地后端」的 AI 桌面应用，用 Electron 打造，零云服务依赖。接入你自己的 API Key，让对话、编码、绘图、文档分析全部在本地完成——密钥不出本机，数据归你所有。

## 简介

糖包是一个**本地优先、隐私安全**的全能 AI 助手桌面工作站。对话、编码、图像生成、文档分析与自定义智能体统一收纳进一个玻璃拟态界面：

- **本地优先与隐私** —— API 密钥由操作系统密钥库（Electron `safeStorage`）加密保管，仅主进程解析，明文绝不落盘；对话与设置持久化在本地 SQLite，不经过任何第三方服务器。
- **多账户、多模型统一管理** —— OpenAI / 豆包 / 通义千问 / Claude / Gemini，以及任何 OpenAI 兼容中转站，一个应用内自由切换。
- **六模块一站式** —— 聊天、编码（糖码）、绘图（糖绘）、文档（糖读）、智能体（糖创）、自定义模块。
- **无框架、启动如飞** —— 原生 HTML/CSS/JS，highlight.js 与 PDF.js 本地内置，断网也能跑核心功能。

## 功能特性

| | 模块 | 核心能力 |
|---|------|---------|
| 💬 | **糖包 · 聊天** | 多模型对话、深度思考、联网搜索、图片输入、语音听写、附件上下文 |
| 🤖 | **糖码 · 编码** | 本地 AI 编程助手：多项目/多会话、工具调用、Plan 模式、权限体系、技能机制 |
| 🎨 | **糖绘 · 图像** | 文生图 + 图片编辑（参考图上传），多种风格与比例 |
| 📄 | **糖读 · 文档** | PDF / Word / PPT / TXT 解析，摘要、要点提取、翻译、大纲生成 |
| 🧩 | **糖创 · 智能体** | 自定义 AI 角色、提示词模板库、多步骤工作流 |
| 🔌 | **自定义模块** | 通过 iframe / webview 嵌入你自己的应用或网页 |

**数据与隐私**：对话与设置存于本地 SQLite（`better-sqlite3`），API 密钥经 OS 密钥库加密；不采集、不上传任何内容。

## 安装

- **直接安装**：从 [GitHub Releases](https://github.com/akiteet/tangbao/releases/latest) 下载 `tangbao-1.1.1-setup.exe`，双击安装即可。
- **从源码运行**：

```bash
git clone https://github.com/akiteet/tangbao.git
cd tangbao
npm install
npm start          # 启动应用（糖码本地后端随应用自动启动）
```

> `npm run server` 仅用于独立调试糖码后端；正常使用不需要单独启动。
>
> **打包**：`npm run dist` → `dist/tangbao-1.1.1-setup.exe`

## 配置

点击左下角齿轮 → **设置**：

1. **添加账户** → API Base URL + Key + 模型列表（支持 OpenAI 兼容接口）。
2. 每个模块可独立选择账户或自定义模型。
3. 视觉模型在「视觉模型」标签添加（支持部分匹配，如 `gpt-5` → `gpt-5.5`）。

## 糖码 · 编码助手

糖码是内置的本地 AI 编程助手，采用先计划后执行、工具驱动的交互范式，面向真实项目开发场景：

- **Plan 模式** —— 只读探索并产出任务清单；不确定时主动向你提问（问题 + 选项 + 自定义填空，单选/多选）；首次写文件时弹「计划待批准」，批准后自动切换执行模式继续。
- **权限体系** —— 6 档权限模式（plan / default / acceptEdits / auto / bypass / sandbox）+ 项目级规则（总是允许 / 总是拒绝 / 命令白名单），拒绝时给出替代建议。
- **技能机制** —— 标准 `SKILL.md` 技能机制（兼容 `.claude/skills`、`.codex/skills` 目录），设置面板可导入、启停、隔离卸载。
- **运行历史与恢复** —— 每步落检查点，任务中断后可**精确恢复**并自动续段；历史面板按页浏览与全文检索。
- **上下文管理** —— 自动压缩长对话，保留计划、错误与变更记录，避免上下文溢出。
- **多根工作区** —— 一个项目可挂多个文件夹，按任务限定写入范围（单根 / 多根 / 全部）。
- **本地安全评测** —— 内置受控评测任务（隔离 fixture），可一键批量跑安全基线。

## 技能（Skills）

糖码支持主流 Agent Skills 技能机制：把 `SKILL.md` 放进约定目录即可被自动加载，也可显式调用（对话里 `/skills`、`/skill <名称>`，或模型用 `list_skills` / `use_skill` 工具）。

- 📖 安装与调用指南：**[docs/SKILLS.md](docs/SKILLS.md)**
- 🧩 模板与示例：**[examples/skills/](examples/skills/)**（`template` 空模板 + `demo-code-review` 示例）

```bash
# 把示例技能装到项目里，一分钟上手
cp -r examples/skills/demo-code-review <项目>/.workbuddy/skills/
```

## 数据与升级提示

- 数据保存在应用数据目录（SQLite + 配置），卸载重装不会删除；升级安装包前建议先备份。
- 历史版本注意事项：v1.0.5 → v1.0.6 曾因存储迁移清空聊天记录，此后已切换到稳定的 SQLite 持久化，升级不再丢失数据。

## 开发

```
tangbao/
├── src/
│   ├── main/                  # Electron 主进程（窗口、IPC、密钥库、糖码后端拉起）
│   ├── preload/               # 安全 IPC 桥接
│   ├── renderer/              # 主窗口 SPA（视图与组件）
│   ├── application/           # 渲染层服务封装（skills / shell / storage 等）
│   ├── core/                  # 领域逻辑（模型能力、权限、完成门、技能、工作区）
│   └── infrastructure/        # 基础设施（SQLite 存储、糖码 Runtime、模型网关、密钥库）
├── docs/                      # 文档（SKILLS / DATA_MODEL / CHANGELOG / PROMPT_SYSTEM）
├── examples/skills/           # 技能模板与示例
├── index.html                 # 主窗口入口
├── styles.css                 # 全局样式
└── package.json
```

- **测试**：`npm test`（全量 323 个用例，覆盖 Runtime / 存储 / 权限 / 技能 / UI 契约）
- **打包**：`npm run dist`（Electron 31 + electron-builder，产物在 `dist/`）
- **数据模型**：见 [docs/DATA_MODEL.md](docs/DATA_MODEL.md)

## v1.1.1

- 并行 `explore / test / review` 子代理最多 8 个任务、3 个并发，超出并发进入队列；子代理只读，父代理统一修改。
- 子代理结果包含 findings、证据、checks、耗时和失败原因；部分成功会标记为 degraded/blocked，并可在运行历史中查看协作树。
- 安装包：`tangbao-1.1.1-setup.exe`。权限模式共 6 档：`plan / default / acceptEdits / auto / bypass / sandbox`。

## License

[MIT](LICENSE)
