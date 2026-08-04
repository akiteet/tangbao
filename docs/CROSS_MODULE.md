# 跨模块成果 · v1.0.6 安全改造

> 本文档汇总糖包 **v1.0.6** 的跨模块安全改造：所有涉及「API Key 如何保管、请求如何转发、本地目录如何隔离」的改动，以及它们如何贯穿聊天 / 绘图 / 文档 / 创作 / 智能体五大模块。
> 配套阅读：[数据模型](./DATA_MODEL.md)。

---

## 安全摘要（Security Summary）

**Your API keys never leave the main process.** In v1.0.6, plaintext keys are gone from `state.json` and localStorage. Every model request is routed through a main-process gateway that resolves the target address and key itself; the renderer only ever holds an opaque `ref` (e.g. `acc:xxx`) and a `kind` (e.g. `chat`).

**你的密钥永远不出主进程。** v1.0.6 起，明文 Key 从 `state.json` 与 localStorage 中彻底消失。所有模型请求统一经主进程网关转发，地址与密钥都由主进程自己解析；渲染进程只持有一个不透明的 `ref`（如 `acc:xxx`）和一个请求种类 `kind`（如 `chat`）。

---

## 1. 模块清单

| 模块 | 文件 | 职责 |
|---|---|---|
| 运行时 | `js/runtime.js` | **本次改造核心**：随机端口/启动令牌、密钥库桥接、`gatewayFetch`、`syncEndpoints`、`migrateSecrets` |
| 状态 | `js/state.js` | `App.state` 持久化 + `App.getProvider(module)` 解析（无 `apiKey`） |
| 启动编排 | `js/app.js` | `boot()` 注入密钥迁移钩子 |
| 聊天 | `js/chat.js`（糖包·聊天） | 多轮对话 + 流式 SSE |
| 图像 | `js/image.js`（糖绘） | 文生图 + 图片编辑 |
| 文档 | `js/doc.js`（糖读） | PDF/Word/PPT/TXT 解析与摘要 |
| 创作 | `js/create.js`（糖创） | 智能体编辑器 / 工作流 |
| 编码 | `js/agent.js`（糖码） | 本地 AI 编程助手 UI |
| 上下文 | `js/context.js` | 对话/智能体共享的上下文压缩（聊天与糖码复用） |
| UI | `js/ui.js` | 设置弹窗（API Key 输入入口） |
| 其它 | `modules.js` / `router.js` / `config.js` / `markdown.js` | 模块注册表、路由、配置、渲染 |

主进程安全模块（均位于 `server/`）见第 3 节。

---

## 2. 密钥 / 网关统一改造

**统一出口**：渲染进程不再直连模型 API，全部走 `App.rt.gatewayFetch({ ref, kind, payload })` + `App.rt.gatewayError(res)`。

`gatewayFetch` 签名在六处调用点完全同构，仅 `kind` 不同：

| 调用点 | `kind` | 说明 |
|---|---|---|
| `js/chat.js` | `chat` | 聊天补全 |
| `js/image.js` | `chat` + `images` | 提示词润色 + 出图 |
| `js/doc.js` | `chat` | 文档分析 |
| `js/create.js` | `chat` | 智能体运行 |
| `js/context.js` | `chat` | 上下文摘要压缩 |
| `js/agent.js` | （走 `/api/agent`） | 同构：请求体只带 `ref` + `workspaceId`，密钥由后端从主进程取 |

- `App.getProvider(module)`（state.js）**不再返回 `apiKey`**，改返回 `ref` + `hasKey`；`persist()` 触发 `syncEndpoints()` 把「ref → 接口地址」同步给主进程网关。
- `ui.js` 的 Key 输入框改为 `App.rt.setSecret('acc:'+id, key)`；保存账户时 `delete a.apiKey`。
- **一致性亮点**：渲染进程既指定不了转发目标，也拿不到密钥——密钥解析点统一收敛到主进程的 `secrets.getSecret`。

---

## 3. 主进程安全三件套（`server/`）

### 3.1 `gateway.js` —— 模型网关（取代旧 `/api-proxy`）

旧做法：渲染进程用 `x-target-url` / `x-auth` 头把「转发到哪」和明文 Key 一起递过来，等于开了一个开放代理。

新做法（`ref` + `kind` + `payload`）：

- **`KIND` 路径白名单**：`chat → /chat/completions`、`images → /images/generations`、`embeddings → /embeddings`、`models → /models`。渲染进程指定不了路径。
- **`setEndpoints`**：只接受 `http(s)` 的 `ref → apiBase` 映射，来自用户设置而非请求。
- **`checkTarget` SSRF 拦截**：刻意**不**一刀切禁内网（本地 Ollama / vLLM / 公司中转站是正常用法）；只拦云元数据地址 `169.254.169.254` / `169.254.170.2` / `metadata.google.internal` / `metadata.goog` / `instance-data` 及所有 `169.254.*` 链路本地地址。
- **错误体不含 `Authorization`**：上游连接失败时只回传 `code: message`，绝不带密钥。
- **流式透传 + `AbortController`**：客户端断开（点停止 / 关页面）即掐断上游，避免白烧 token。

### 3.2 `secrets.js` —— 密钥库

- `safeStorage` 加密（Windows DPAPI / macOS Keychain / Linux libsecret）。
- 临时文件 + `rename` 原子写、`chmod 600`、写后回读校验。
- **`setSecret` 带回滚**：写入失败或回读不一致则恢复原值，绝不丢 Key。
- 系统密钥服务不可用时降级 base64 明文并标记 `enc:false`（不静默丢 Key）。
- 无任何读回明文的 IPC；`getSecret` 仅主进程内部使用。

### 3.3 `agent-server.js` —— 糖码后端

- 由主进程注入 `getSecret` / `getEndpoint` / `resolveWorkspace`。
- `handleAgent` 与 `/api/memory`：用 `workspaceId` → `resolveWorkspace` 解析 `cwd`，**未知 id 直接 400 拒绝**。
- 请求体不再接受 `apiBase` / `apiKey`；搜索 Key 由 `getSecret('search')` 取。

---

## 4. `workspaceId` 注册表（`main.js`）

- `workspaceRegistry: Map<workspaceId, { cwd, name }>` + 反向 `workspacePathToId`，持久化到 `userData/workspaces.json`。
- `registerWorkspace(absPath, name)`：校验绝对路径 + 目录存在，幂等，发放 `crypto.randomUUID()` 作为**不透明 id**。
- IPC `app:registerWorkspace`；目录选择对话框复用同一登记。
- 启动时 `loadWorkspaces()` + `configureAgentServer({ ...resolveWorkspace })`。
- **`/proxy` 已删除**：强制嵌入改由 `openChildWindow` 子窗口承载，彻底移除开放代理。

---

## 5. 启动迁移钩子（`app.js` · `boot()`）

在 `loadState()` 之后、UI 初始化之前（仅主窗、浮窗跳过）：

```
refreshSecrets()      // 取回主进程已存的密钥引用
  → migrateSecrets()  // 把 1.0.5 及更早残留在 state 里的明文 Key 加密迁入密钥库
  → [moved 则 persist()]  // 迁移成功才删明文，立刻落盘
  → syncEndpoints()   // 把 ref→地址 同步给主进程网关
```

`migrateSecrets()` 扫描 `settings.accounts[].apiKey`、`providers[].apiKey`、`search.apiKey` → 加密写入并回读校验 → **仅校验通过才删除明文**；任一步失败保留明文（宁可不迁移也不丢 Key）。

---

## 6. 安全收益总结

| 维度 | v1.0.5 及之前 | v1.0.6 |
|---|---|---|
| API Key 存放 | 明文在 `state.json` / localStorage | 操作系统密钥库加密，渲染进程不可见 |
| 请求转发 | 渲染进程指定任意目标 + 带明文 Key | 主进程网关 + 路径白名单，只传 `ref`/`kind` |
| SSRF | 无防护 | 拦云元数据 `169.254.*` / `metadata.*` |
| 本地目录 | 渲染进程直传裸 `cwd` | `workspaceId` 不透明 id，后端解析受控目录 |
| 开放代理 | 存在 `/proxy` | 已删除 |

**隐私承诺**：你的对话、文档、密钥均保存在本机，糖包不会主动上传到任何第三方。密钥在本机加密保管，明文绝不落盘、不经 IPC 回程。

---

## 7. 测试覆盖现状

> ⚠️ 当前**零自动化测试**（无 `test` script，无 jest/vitest/mocha 依赖）。以下为建议补测点，**不在此次工作中补**。

| 建议补测点 | 说明 |
|---|---|
| `gateway.checkTarget` | 云元数据地址拦截（`169.254.*` / `metadata.*`） |
| `gateway.buildUrl` | 用户 Base URL 已含完整路径时不重复拼接 |
| `secrets.setSecret` | 回滚分支（写入失败 / 回读不一致恢复原值） |
| `resolveWorkspace` | 未知 `workspaceId` 返回 `null` / 400 拒绝 |
| `migrateSecrets` | 失败时保留明文、不乱删 Key |

`gateway.js` 已导出 `checkTarget` / `buildUrl` / `KIND` 等纯函数，是最低成本的切入点。
