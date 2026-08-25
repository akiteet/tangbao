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
<p align="center">
  <img src="https://img.shields.io/badge/version-1.1.8-1a5cff" alt="Version" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
  <img src="https://img.shields.io/badge/Electron-31-47848f" alt="Electron" />
  <img src="https://img.shields.io/badge/tests-492%20passing-2ea44f" alt="Tests" />
  <img src="https://img.shields.io/badge/SQLite-3-green" alt="SQLite" />
</p>

---

> 一个「纯前端 + 本地后端」的 AI 桌面应用，用 Electron 打造，零云服务依赖。接入你自己的 API Key，让对话、编码、绘图、文档分析全部在本地完成——密钥不出本机，数据归你所有。

## 目录

- [简介](#简介)
- [功能特性](#功能特性)
- [安装](#安装)
- [配置](#配置)
- [糖码 · 编码助手](#糖码--编码助手)
- [技能（Skills）](#技能skills)
- [数据与升级提示](#数据与升级提示)
- [开发](#开发)
- [版本历史](#版本历史)
- [License](#license)

## 简介

糖包是一个**本地优先、隐私安全**的全能 AI 助手桌面工作站。对话、编码、图像生成、文档分析、角色库与任务型智能体统一收纳进一个中性专业风格界面：

- **本地优先与隐私** —— API 密钥由操作系统密钥库（Electron `safeStorage`）加密保管，仅主进程解析，明文绝不落盘；对话与设置持久化在本地 SQLite，不经过任何第三方服务器。
- **多账户、多模型统一管理** —— OpenAI / 豆包 / 通义千问 / Claude / Gemini，以及任何 OpenAI 兼容中转站，一个应用内自由切换。
- **六个内置模块一站式** —— 聊天、编码（糖码）、绘图（糖绘）、文档（糖读）、智能体（糖创）、角色库（糖馆），另支持自定义模块。
- **无框架、启动如飞** —— 原生 HTML/CSS/JS，highlight.js 与 PDF.js 本地内置，断网也能跑核心功能。

## 功能特性

| | 模块 | 核心能力 |
|---|------|---------|
| 💬 | **糖包 · 聊天** | 多模型对话、深度思考、联网搜索、图片输入、语音听写、附件上下文 |
| 🤖 | **糖码 · 编码** | 本地 AI 编程助手：多项目/多会话、工具调用、Plan 模式、权限体系、技能机制 |
| 🎨 | **糖绘 · 图像** | 文生图 + 图片编辑（参考图上传），多种风格与比例 |
| 📄 | **糖读 · 文档** | PDF / Word / PPT / TXT 解析，摘要、要点提取、翻译、大纲生成 |
| 🧩 | **糖创 · 智能体** | 预设与自定义 AI 角色、独立任务会话、多步骤工作流 |
| 🎭 | **糖馆 · 角色库** | 角色卡、独立角色会话、角色专属世界书与受控检索 |
| 🔌 | **自定义模块** | 通过 iframe / webview 嵌入你自己的应用或网页 |

**数据与隐私**：对话与设置存于本地 SQLite（`better-sqlite3`），API 密钥经 OS 密钥库加密；不采集、不上传任何内容。

## 安装

- **直接安装**：从 [GitHub Releases](https://github.com/akiteet/tangbao/releases/latest) 下载 `tangbao-1.1.8-setup.exe`，双击安装即可。
- **从源码运行**：

```bash
git clone https://github.com/akiteet/tangbao.git
cd tangbao
npm install
npm start          # 启动应用（糖码本地后端随应用自动启动）
```

> `npm run server` 仅用于独立调试糖码后端；正常使用不需要单独启动。
>
> **打包**：`npm run dist` → `dist/tangbao-1.1.8-setup.exe`

## 配置

点击左下角齿轮 → **设置**：

1. **添加账户** → API Base URL + Key + 模型列表（支持 OpenAI 兼容接口）。
2. 每个模块可独立选择账户或自定义模型。
3. 视觉模型在「视觉模型」标签添加（支持部分匹配，如 `gpt-5` → `gpt-5.5`）。
4. 糖绘模型详情可配置图像协议、尺寸策略和自定义尺寸；`gpt-image-2` 与 `sensenova-u1-fast` 默认提供完整常用比例，接口返回明确枚举后会按当前模型自动收敛。

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
- 糖馆角色库、糖馆/糖创模块会话使用版本化本地侧车存储；首次升级会迁移旧模块会话，普通聊天记录仍留在主状态中。
- 历史版本注意事项：v1.0.5 → v1.0.6 曾因存储迁移清空聊天记录，此后已切换到稳定的 SQLite 持久化，升级不再丢失数据。

## 开发

```
tangbao/
├── src/
│   ├── main/                  # Electron 主进程（窗口、IPC、密钥库、糖码后端拉起）
│   ├── preload/               # 安全 IPC 桥接
│   ├── renderer/              # 主窗口 SPA（视图与组件）
│   ├── application/           # 渲染层服务封装（skills / shell / storage 等）
│   ├── core/                  # 领域逻辑（模型能力、权限、完成门、技能、糖馆、工作区）
│   └── infrastructure/        # 基础设施（SQLite、模块侧车、糖馆索引、糖码 Runtime、模型网关、密钥库）
├── docs/                      # 文档（SKILLS / DATA_MODEL / CHANGELOG / PROMPT_SYSTEM）
├── examples/skills/           # 技能模板与示例
├── index.html                 # 主窗口入口
├── styles.css                 # 全局样式
└── package.json
```

**运行时架构**：

```
┌───────────────────────────── 渲染进程（Renderer） ─────────────────────────────┐
│  SPA（原生 HTML/CSS/JS）                                                        │
│  聊天 / 糖码 / 糖绘 / 糖读 / 糖创 / 糖馆 ··· 模块视图                              │
└──────────────┬────────────────────────────────────────────────────────────────┘
               │ preload 安全桥（contextBridge，仅白名单 IPC）
┌──────────────▼────────────────────────────────────────────────────────────────┐
│  Electron 主进程（Main）                                                        │
│  ├─ 模型网关 gateway（转发到 OpenAI 兼容 API，密钥只存主进程）                      │
│  ├─ SQLite 存储（better-sqlite3）+ state.json 双写 + 文件仓（附件/图片/文档）       │
│  ├─ 密钥库（OS safeStorage 加密，渲染进程拿不到明文）                              │
│  └─ 糖码本地后端（agent-server：工具执行、权限、检查点、技能）                      │
└──────────────┬────────────────────────────────────────────────────────────────┘
               │ 本机 127.0.0.1 随机端口（Bearer 启动令牌鉴权）
┌──────────────▼────────────────────────────────────────────────────────────────┐
│  模型供应商（OpenAI / 豆包 / 通义千问 / Claude / Gemini / 兼容中转）               │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **测试**：`npm test`（当前 506 个用例，500 个通过、6 个跳过——5 个 SQLite ABI 用例由 `npm run check:sqlite` 在 Electron 运行时真实执行、1 个评测存档用例需设 `TANGBAO_EVAL_ARCHIVE_DIR`——0 个失败）
- **评测存档**：`eval-task-contracts` 里的 med-007 历史产物用例需设置 `TANGBAO_EVAL_ARCHIVE_DIR` 指向本机 `eval-runs-archive-*` 目录后才会真实执行，未设置时优雅跳过
- **闭环门禁**：`npm run check:version`、`npm run check:storage`、`npm run check:perf`、`npm run check:electron-abi`、`npm run check:sqlite`（Electron 运行时跑 SQLite 用例，补纯 Node 的 ABI 跳过）、`npm run check:ui`、`npm run check:release`、`npm run bench:offline`
- **打包**：`npm run dist`（Electron 31 + electron-builder，产物在 `dist/`）
- **数据模型**：见 [docs/DATA_MODEL.md](docs/DATA_MODEL.md)

## 版本历史

### v1.1.8（持久化完整性、工程收尾与 UI 系统重构）

- **UI 全面改版（中性专业风）**：全新设计系统——双主题中性灰阶、统一的基础组件与间距/圆角/字号规格，滚动条、卡片、弹窗、折叠控件全应用一套标准；全模块列表卡与操作布局重做，长回复可随时一键回到底部，糖读新增解析/分析工作记录条；新增启动画面，应用就绪后直接呈现完整界面；暗色模式稳定性修复。
- **P0 修复：生图模型分区跨重启保持**：v1.1.6 回归导致生图模型分类重启后回退文本分组。已修复并升级本地数据库结构。注意：升级前已被固化的标记需在设置里重新标记一次。
- **默认提示词全面升级**：聊天默认提示结构化（格式纪律 / 详略适配 / 诚实优先）；糖馆角色扮演改为中性扮演框架——角色卡即身份与行为准则，基础提示不再自称助手；AI 角色草稿与糖读摘要/要点/翻译/拆解的质量要求更明确。未自定义过提示词的用户自动生效。
- **数据与流式修复**：进入旧会话稳定定位到底部；流式响应超时会真正断开请求，供应商限流时不再反复空等报错；多处数据丢失防护加强（异常快照不再覆盖已配置字段）。
- **工程结构收尾**：主进程与设置层完成模块化拆分，为后续迭代打底。

详细说明见 [docs/CHANGELOG-v1.1.8.md](docs/CHANGELOG-v1.1.8.md)。

详细说明见 [docs/CHANGELOG-v1.1.8.md](docs/CHANGELOG-v1.1.8.md)。

### v1.1.7（工程与体验）

- **批次 E 渲染层拆分**：agent.js 3736 → 2075 行，渲染方法拆为 6 个模块（运行历史/气泡/审批/引擎观测/布局/状态）；main.js 技能 IPC 拆出 main-skills.js；340 条源码断言经 source-helper 目录拼接自动覆盖。
- **命令面板（Ctrl/Cmd + K）**：落地此前孤儿代码——模块切换、设置、Cache Probe、会话/文档/糖码项目/糖码会话搜索；修复与本地搜索的双绑定冲突。
- **糖绘历史分页**：每页 20 条 + 加载更多，避免内联 base64 历史 DOM 线性膨胀。
- **糖馆世界书启停**：逐条启用/停用开关（停用后不参与检索）。
- **技术债**：agent 事件落库失败与 git ls-files 失败显式告警（不再静默吞错）。

详细说明见 [docs/CHANGELOG-v1.1.7.md](docs/CHANGELOG-v1.1.7.md)。

### v1.1.6（性能与数据瘦身）

- **切换卡顿根治**：`activate()` 同步全量序列化（三次 `JSON.stringify`，含 base64 附件）是切换卡顿的根因——持久化移出切换帧、浮窗脱敏改为手动浅拷贝、附件外置后不再拖累每次保存。
- **聊天附件外置**：图片附件发送即落盘（复用糖绘 image-assets 基础设施），state 只存引用；惰性迁移旧内联附件，超配额回退内联不丢数据。
- **性能可观测**：设置 → 数据 → 性能诊断（开关 + 导出快照 + 清空），11 项性能指标可查。
- **SQLite 优化**：`PRAGMA synchronous=NORMAL` + `syncState` 增量 upsert（失败回退 clearAll），主进程写穿不再阻塞。
- **UI 灵动晶莹升级**：设计令牌补全、弹簧微动效、晶莹质感分层、组件风格统一；语义色令牌（危险/成功/警告）体系化。
- **字体体系升级**：引入本地 JetBrains Mono（OFL，离线可用）作为代码/数据字体，中文回退补全，字号收敛为令牌阶梯。
- **糖读模块增强**：Q&A 历史持久化、停止生成、翻译方向选择、长文档分段分析、Word/PPT 解析、文档重命名/导出/上限提示。
- **数据可靠性**：修复流式部分持久化断线（P0，曾导致 state.json 被写空）；SQLite 兜底恢复完整，启动自动治愈。

详细说明见 [docs/CHANGELOG-v1.1.6.md](docs/CHANGELOG-v1.1.6.md)。

### v1.1.5

- 架构减重：4158 行的糖码引擎拆分出四个聚焦模块（HTTP 传输层 agent-server-http、工具协议定义正名迁入 tool-runtime、搜索供应商 search-providers、运行态注册表 run-registry），全部行为零变化——离线基准与 v1.1.4 逐字节一致（seed 1337，成功率 0.875）。
- 基础设施收敛：主进程与糖码后端共用一份 HTTP 鉴权实现（常数时间比较 + 回环校验），readJson/clone/escapeHtml 与渲染层 IPC 容错包装各自收敛为单一实现。
- 发布自动化：新增 `npm run bump -- <version>` 一条命令完成发版全部版本号替换（含 dry-run 与历史段落保护），check:version / check:release 改为从 package.json 派生版本单一来源。
- Prompt Caching 对齐：模型网关聊天路径与糖码运行时一样先过能力判定，reasoning 类模型不再注入 cache_control；数据库保持 Schema v16，无迁移。
- 测试补强：新增 `npm run check:sqlite` 在 Electron 运行时真实执行 SQLite 用例（纯 Node 下的 4 个结构性跳过在 CI 中被补齐），并接入发布契约与 CI。

详细说明见 [docs/CHANGELOG-v1.1.5.md](docs/CHANGELOG-v1.1.5.md)。

### v1.1.4（历史版本）

- 糖馆角色工作区：提供角色卡预设、AI 草稿预览、脏状态保护、JSON 导入/导出，以及 Tavern/SillyTavern 常见字段和 `character_book.entries` 兼容。
- 角色隔离会话：糖馆角色会话与普通聊天分离；糖创任务会话也使用独立侧车，切换模块、删除会话和空状态均保持所属边界。
- 受控角色 RAG：仅检索当前角色自己的世界书，按关键词、标签、优先级、时间衰减和 Token 预算排序；没有真实 Embedding 时明确使用关键词模式，不引入全局文档索引。
- 糖绘模型适配：按 API Base + 精确模型解析图像协议、合法尺寸、响应格式和尺寸格式；覆盖 SenseNova U1/U1 Fast、GPT Image、DALL-E、Wanx 等 profile，支持 `b64_json`、URL 和错误枚举学习。
- 自定义图像能力：账户模型可保存协议、尺寸策略和 `imageSizes`；`gpt-image-2`、`sensenova-u1-fast` 与未知模型展示包含 `1:1`、`16:9`、`9:16`、`4:3`、`3:4` 的完整常用比例，任务入队、执行和重试都会重新校验尺寸。
- 流式可靠性：首字节前创建可恢复助手占位，按序列节流保存中间结果，保留错误/超时/重载后的部分输出；账户状态落盘与密钥写入失败会恢复旧配置。
- 存储与兼容：继续使用 Schema v16；模块会话、角色库和索引使用版本化本地侧车/`kv_meta`，迁移有哈希校验、状态记录和回滚路径；API Key 不进入角色卡导出、备份、日志、Trace 或搜索。
- 性能与界面：新增默认关闭、有界内存性能环形记录；优化模块切换、流式渲染、侧栏搜索、长列表和窄窗口折叠布局，并由 Electron 四窗口 smoke 覆盖。
- 发布门禁：版本、存储、性能、Electron ABI、UI、离线 Benchmark 和平台打包检查纳入 1.1.4 闭环。

详细说明与升级注意事项见 [docs/CHANGELOG-v1.1.4.md](docs/CHANGELOG-v1.1.4.md)。

### v1.1.3（历史版本）

- 稳定性闭环：数据目录迁移状态、临时复制校验、失败回滚、恢复中心、SQLite/state 一致性审计、备份与隔离清理预览。
- 模型与 Cache 管理：Provider Health、模型配置档案、统一模型调用指标，以及用户主动触发的真实 Cache Probe；Provider 未返回 Usage 时保持未知。
- 产品效率：`Ctrl/Cmd + K` 命令面板、本地分页搜索、通知中心和统一加载/失败/取消状态。
- Agent 工程：只读 Trace Inspector、协作树、Budget/Abort/Error 归一化、脱敏导出和可重复的 Runtime Offline Benchmark。
- 数据目录迁移后会在条件满足时自动恢复旧 Windows 密钥上下文，不要求重新填写 API Key；密钥不进入普通备份、诊断包或 Trace 导出。

### v1.1.1（历史版本）

- 并行 `explore / test / review` 子代理最多 8 个任务、3 个并发，超出并发进入队列；子代理只读，父代理统一修改。
- 子代理结果包含 findings、证据、checks、耗时和失败原因；部分成功会标记为 degraded/blocked，并可在运行历史中查看协作树。
- 安装包：`tangbao-1.1.1-setup.exe`。权限模式共 6 档：`plan / default / acceptEdits / auto / bypass / sandbox`。

## License

[MIT](LICENSE)
