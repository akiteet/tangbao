# 糖包数据模型（Data Model）

> 本文档描述糖包 **v1.0.6** 前端状态的持久化结构，面向开发者，以及想理解「我的数据到底存在哪、长什么样」的用户。
> 配套阅读：[跨模块成果 · v1.0.6 安全改造](./CROSS_MODULE.md)。

---

## 1. 存储载体

| 载体 | 说明 |
|---|---|
| `localStorage` 键 `tangbao_web_state_v1` | 主存储。`doubao_web_state_v1` 为旧键，首次启动时兼容读取并迁移后删除。 |
| `userData/tangbao-data/state.json` | 双写副本（经 `window.electron.saveStateJSON`），便于查看与备份。 |
| 系统密钥库 | API Key 明文**不进上述两者**，改存操作系统密钥服务（见第 6 节）。 |

- 没有 `schemaVersion` 字段，版本迁移靠「字段形态嗅探」完成（见第 7 节）。
- **v1.0.6 起 `state.json` 与 localStorage 里均不再含任何 API Key 明文。**

---

## 2. `App.state` 顶层字段

`App.state` 由 `js/state.js` 的 `defaultState()` 初始化，核心字段如下：

| 字段 | 类型 | 含义 |
|---|---|---|
| `conversations` | `Array` | 聊天对话列表（见第 4 节） |
| `activeId` | `string \| null` | 当前对话 id |
| `theme` | `'light' \| 'dark'` | 主题（外观实际由 `settings.appearance.mode` 控制，二者并存） |
| `view` | `string` | 当前视图模块，默认 `'chat'` |
| `settings` | `Object` | 全局配置（见第 3 节） |
| `agentThreads` | `Array` | 糖码多会话线程（见第 5 节） |
| `activeThreadId` | `string \| null` | 当前激活的糖码会话 id |
| `projects` | `Array` | 糖码项目（见第 5 节） |
| `activeProjectId` | `string \| null` | 当前激活的糖码项目 id |
| `agentProjectsCollapsed` / `agentSessionsCollapsed` | `boolean` | 侧栏折叠状态 |
| `thinkLevel` | `'off' \| 'low' \| 'medium' \| 'high'` | 深度思考强度，默认 `'medium'` |
| `web` | `boolean` | 联网搜索总开关 |

---

## 3. `settings` 子结构

| 子字段 | 结构 / 说明 |
|---|---|
| `accounts` | `[{ id, name, apiBase, models:[{ name, contextWindow, thinkType? }] }]`——**不含 `apiKey`** |
| `defaultAccountId` | `string`，默认账户 id |
| `providers` | `{ default, chat, agent, create, image, doc }`，每项 `{ accountId:'__default__'\|'__custom__'\|<id>, apiBase, model }` |
| `profile` | `{ name:'糖包用户', avatar:'' }` |
| `appearance` | `{ mode:'light'\|'dark'\|'system', accent:'', radius:'' }` |
| `prompts` | `{ chat:'', agent:'', doc:{ summary, points, translate, outline } }`，用户可覆盖的内置提示词 |
| `agents` | `Array`，自定义智能体模板 |
| `agentUsage` | `{ [agentId]: number }`，智能体使用次数 |
| `templates` | `Array`，提示词模板库 `[{ id, title, category, prompt, icon }]` |
| `workflows` | `Array`，智能体工作流 `[{ id, name, steps:[{ title, prompt, usePrev }] }]` |
| `imageHistory` | `Array`，糖绘历史 `[{ id, prompt, style, size, n, images:[b64...], createdAt }]` |
| `docs` | `Array`，已上传文档 `[{ id, name, text, size, createdAt }]`（限长截断） |
| `agentCwd` | `string`，**遗留字段**；旧版编码助手工作目录，迁移时用于创建默认项目 |
| `search` | `{}`，联网搜索配置；Key 存在密钥库的 `'search'` 引用下，不落 state |
| `userMemory` | `string`，用户级长期记忆（对标 CLAUDE.md 用户级），注入糖码系统提示 |
| `contextWindow` | `number`，上下文窗口 token 数，默认 `128000`（自动压缩阈值与 `/context` 分母） |
| `visionModels` | `Array<string>`，视觉模型白名单（`gpt-4o` / `claude-3-5` / `qwen-vl` …） |
| `enabledModules` | `['chat','image','doc','create','agent']`，启用的内置模块 |
| `customModules` | `[{ id, label, url, forceEmbed, hidden }]`，用户自定义模块 |

---

## 4. 对话模型（糖包·聊天）

**conversation**
```
{ id, title, messages:[...], updatedAt,
  agentId?, systemPrompt?, model?, temperature?, topP?, web?, starters?[] }
```

**message**
```
{ role:'user' | 'assistant', content:string,
  think?:string,        // 思考链
  webSources?:number,   // 联网引用条数
  attachments?:[...] }
```

**attachment**
- 图片：`{ id, name, type:'image', data:dataURL, size }`
- 文本：`{ id, name, type:<mime>, text, size }`（文本截断至 20000 字）

---

## 5. 智能体模型（糖码·编码）

**project**
```
{ id, name, cwd, workspaceId,
  auto, approveTools:[], cmdWhitelist:[], planMode,
  createdAt, lastUsedAt }
```
- `cwd`：后端实际工作目录（绝对路径）。
- **`workspaceId`**（v1.0.6 新增）：不透明 UUID。渲染进程只持有它，后端经 `resolveWorkspace(id)` 解析出 `cwd`；未知 id 直接拒绝。详见[跨模块成果](./CROSS_MODULE.md)。

**thread**
```
{ id, projectId, title, updatedAt,
  history:[{ role, content }],   // 持久化时裁剪至最近 60 条
  summary?, summaryCount? }
```

**workspaceId 注册表（主进程）**
- `Map<workspaceId, { cwd, name }>`，持久化到 `userData/workspaces.json`。
- `registerWorkspace(absPath, name)` 校验绝对路径 + 目录存在后，发放 `crypto.randomUUID()` 作为不透明 id（幂等）。
- 旧项目（有 `cwd` 无 `workspaceId`）在运行时惰性登记迁移。

---

## 6. 密钥存储（**不在** state 内）

真实 API Key 不进 `state` / `localStorage` / `state.json`，改由主进程密钥库保管：

- 渲染进程只持有 **ref** 引用：
  - `acc:<accountId>` —— 设置里保存的账户
  - `custom:<module>` —— 模块「自定义填写」的独立密钥
  - `search` —— 联网搜索（Tavily）可选 Key
- 通过 `App.getProvider(module)` 解析得到 `{ apiBase, ref, hasKey, model, models }`，**返回结构里没有 `apiKey`**。
- 密钥落地在 `server/secrets.js`：
  - `safeStorage` 加密（Windows DPAPI / macOS Keychain / Linux libsecret）。
  - 临时文件 + `rename` 原子写，`chmod 600`，写后回读校验。
  - `setSecret` 带**回滚**：写入失败或回读不一致则恢复原值。
  - 系统密钥服务不可用时降级为 base64 明文并标记 `enc:false`（不静默丢 Key）。
- `preload.js` 只暴露 `set / delete / deletePrefix / list / has`，**故意不暴露 `getSecret`**；密钥只在主进程内部使用，不经 IPC 回程消息。

---

## 7. 迁移机制

`App.loadState()` 在启动时对旧数据做字段形态嗅探（无 `schemaVersion`）：

| 旧形态 | 新形态 |
|---|---|
| 模型 `string[]` | `{ name, contextWindow }[]` |
| `think: boolean` | `thinkLevel: 'off' \| 'medium'` |
| 旧单条 `agentHistory` | 包成首个 thread |
| 无 `projects` | 用 `agentCwd` 创建「默认项目」 |
| provider 旧明文 `apiKey` | 暂留一手，交给启动钩子 `migrateSecrets()` 搬进密钥库后再删除 |

---

## 8. v1.0.6 数据模型变化点

1. **密钥移出 state**：`accounts` / `providers` / `search` 的 `apiKey` 全部移除，改存第 6 节的密钥库。
2. **`workspaceId` 取代 cwd 直传**：渲染层持有不透明 UUID，后端解析受控目录（见第 5 节）。
3. **本地文件 `fileId` 化**（M5 #254）：引用改为 `tangbao-file://<fileId>`，不再依赖裸路径。

---

## 9. 已知瑕疵（caveat，仅记录，未修）

> ⚠️ 以下问题为现有实现缺陷，**不在此次文案工作中修复**，建议另开 issue 跟进：

1. **`thinkLevel` 读写路径不一致**：顶层默认写在 `App.state.thinkLevel`，但迁移逻辑写入 `settings.thinkLevel`，两条路径并存。
2. **thread `summary` / `summaryCount` 重启丢失**：`loadState` 线程归一化时未保留该字段，重启后摘要清空。
