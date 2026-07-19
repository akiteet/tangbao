<br>
<p align="center">
  <img src="assets/logo.png" alt="Tangbao" width="160" />
</p>
<h1 align="center">糖包 Tangbao</h1>
<p align="center">
  <strong>你的全能 AI 助手桌面工作站</strong>
</p>
<p align="center">
  <img src="https://img.shields.io/badge/Electron-31-47848f?style=flat&logo=electron&logoColor=white" />
  <img src="https://img.shields.io/badge/Node.js-22-339933?style=flat&logo=node.js&logoColor=white" />
  <img src="https://img.shields.io/badge/Platform-Windows-0078D6?style=flat&logo=windows&logoColor=white" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat" />
  <a href="https://github.com/akiteet/tangbao/releases"><img src="https://img.shields.io/github/v/release/akiteet/tangbao?style=flat&color=ff6b6b" /></a>
  <a href="https://github.com/akiteet/tangbao/releases/latest"><img src="https://img.shields.io/badge/下载-Windows_安装包-0078D6?style=flat&logo=windows" /></a>
</p>

---

> 一个**纯前端 + 本地后端**的 AI 桌面应用，用 Electron 打造，零云服务依赖。接入你自己的 API Key，让对话、编码、绘图、文档分析都在本地完成。

## 安装

[**→ 下载最新安装包**](https://github.com/akiteet/tangbao/releases/latest)（`糖包-1.0.0-setup.exe`），双击安装即可。

开发者从源码运行：

## 五大模块

| | 模块 | 核心能力 |
|---|------|---------|
| 💬 | **糖包·聊天** | 多模型对话、深度思考、联网搜索、图片输入、语音听写、附件上下文 |
| 🤖 | **糖码·编码** | 本地 AI 编程助手，多项目/多会话、工具调用、Plan 模式、命令白名单 |
| 🎨 | **糖绘·图像** | 文生图 + 图片编辑（参考图上传），多种风格与比例 |
| 📄 | **糖读·文档** | PDF/Word/PPT/TXT 解析，摘要、要点提取、翻译、大纲生成 |
| 🧩 | **糖创·智能体** | 自定义 AI 角色、提示词模板库、多步骤工作流 |

## 设计哲学

- **离线优先** —— highlight.js、PDF.js 全部 vendored，断网也能跑核心功能
- **无框架** —— 原生 HTML/CSS/JS，不依赖 React/Vue，启动如飞
- **多模型兼容** —— 支持 OpenAI / 豆包 / 通义千问 / Claude / Gemini 等任何 OpenAI 兼容 API
- **数据自主** —— 所有对话和设置存在 localStorage，不经过任何服务器

## 快速开始

```bash
git clone https://github.com/GuJialu/tangbao.git
cd tangbao
npm install
npm start            # 启动 Electron
npm run server       # 启动糖码后端（编码助手需要）
```

> **打包：** `npm run dist` → `dist/糖包-1.0.0-setup.exe`

## 配置

点击左下角齿轮 → **设置** 即可：

1. **添加账户** → API Base URL + Key + 模型列表
2. 每个模块可独立选择账户或自定义
3. 视觉模型需在「视觉模型」标签添加（支持部分匹配，如 `gpt-5` → `gpt-5.5`）

## 项目结构

```
tangbao/
├── main.js                # Electron 主进程
├── preload.js             # IPC 桥接
├── index.html             # 主窗口 SPA
├── styles.css             # 全局样式
├── js/
│   ├── chat.js            # 多轮对话 + 流式 SSE
│   ├── agent.js           # 糖码编码助手 UI
│   ├── image.js           # 糖绘图像生成/编辑
│   ├── doc.js             # 糖读文档分析
│   ├── create.js          # 智能体编辑器
│   ├── modules.js         # 自定义模块引擎
│   ├── state.js           # 持久化状态管理
│   ├── router.js, ui.js   # 路由 + UI 组件
│   └── markdown.js        # Markdown 渲染
├── server/
│   └── agent-server.js    # 糖码后端（工具执行引擎）
├── assets/                # Logo / 图标
└── vendor/                # highlight.js, PDF.js
```

## License

MIT
