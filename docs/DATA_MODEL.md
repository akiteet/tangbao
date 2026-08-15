# 糖包数据模型（Data Model）

> 本文档描述糖包 **v1.1.4** 的持久化结构，面向开发者，以及想理解「我的数据到底存在哪、长什么样」的用户。
> 配套阅读：[v1.1.4 发布说明](./CHANGELOG-v1.1.4.md)与[跨模块历史成果](./CROSS_MODULE.md)。

---

## 1. 概览

糖包的数据以 **SQLite（better-sqlite3）为权威源**，另有两份辅助持久化：`state.json`（可读双写副本，便于查看与备份）与 `workspaces.json`（工作区注册表）；API 密钥一律存操作系统密钥库（`secrets/kvstore.js`），明文绝不落盘。

| 载体 | 路径 | 角色 |
|---|---|---|
| SQLite 数据库 | `activeRoot/tangbao-data/tangbao.db` | **权威源**：对话、消息、账户、项目、糖码运行等全部结构化数据 |
| 状态双写副本 | `activeRoot/tangbao-data/state.json` | 便于人工查看/备份的只读副本，由主进程随状态变化刷新 |
| 工作区注册表 | `activeRoot/workspaces.json` | `workspaceId ↔ { cwd, name }` 映射 |
| 密钥库 | `activeRoot/tangbao-data/secrets.json` | API Key 等敏感值，`safeStorage` 加密（Windows DPAPI / macOS Keychain / Linux libsecret） |
| localStorage | 渲染进程 | **已废弃**（v1.0.6 之前的主存储；v1.0.7 起不再作为数据源） |

- 数据库 Schema 版本：**`SCHEMA_VERSION = 16`**（`src/core/schemas/db-schema.js`），通过 SQLite `PRAGMA user_version` 顺序执行迁移（见第 5 节）。
- 任何位置都不存 API Key 明文。

### 1.1 数据目录布局

`activeRoot` 是当前真正写入的根目录。用户在设置中选择自定义目录后，SQLite、状态副本、密钥库和大文件统一迁移到 `activeRoot/tangbao-data/`；文件仓位于 `activeRoot/tangbao-data/files/{images,documents,thumbnails,exports,logs,changesets}`。默认 Electron `userData` 目录只保留 `tangbao-location.json` 指针、迁移状态和必要备份，不再持续写入新的记录。

迁移使用临时目录和 SHA-256 校验，成功后原子激活；失败会保留旧目录并在恢复中心显示 `failed` 状态，不静默回退。历史记录、Trace、图片和文档不会自动清理，清理操作只会在预览后移动到时间戳隔离目录。

---

## 2. 表清单（23 张）

### 2.1 核心业务表（14 张，migration0 建表）

| 表 | 关键列 | 职责 |
|---|---|---|
| `conversations` | id, title, agent_id, system_prompt, created_at, updated_at | 糖包·聊天会话 |
| `messages` | id, conv_id, idx, role, content, created_at, meta | 消息正文；思考链/联网引用/附件等并入 `meta` |
| `accounts` | id, name, api_base, created_at, updated_at | 账户（**不含密钥**，密钥走密钥库） |
| `account_models` | account_id, name, context_window, caps, max_output, think_type | 账户模型清单与能力元数据 |
| `providers` | module, account_id, api_base, model | 各模块当前使用的账户/模型 |
| `agents` | id, name, description, system_prompt, icon, category | 糖创自定义智能体 |
| `templates` | id, title, category, prompt, icon | 旧版提示词模板的历史兼容存储；当前界面不再提供模板库 |
| `workflows` | id, name, steps, created_at | 多步骤工作流定义 |
| `image_history` | id, prompt, style, size, n, created_at | 糖绘出图记录 |
| `image_files` | id, history_id, seq, data, created_at | 图片二进制（base64 dataURL） |
| `docs` | id, name, text, size, created_at | 糖读上传文档（文本截断存储） |
| `projects` | id, name, cwd, workspace_id, roots_json, primary_root_id, auto, approve_tools, cmd_whitelist, plan_mode, created_at, last_used_at | 糖码项目（多根工作区：`roots_json` + 主根 `primary_root_id`） |
| `agent_threads` | id, project_id, title, updated_at, history, draft_text, draft_skills, draft_root_scope_json | 糖码会话（含草稿/任务范围草稿） |
| `kv_meta` | key, value | 通用键值元数据 |

### 2.2 工作流运行（1 张，migration1）

| 表 | 关键列 | 职责 |
|---|---|---|
| `workflow_runs` | id, workflow_id, workflow_name, status, input_json, output_json, error, steps_json, started_at, finished_at | 工作流运行历史 |

### 2.3 糖码运行数据（6 张，migration2+；**刻意不进 `TABLES`，清数据时保留运行历史/审计轨迹**）

| 表 | 关键列 | 职责 |
|---|---|---|
| `agent_runs` | id, thread_id, workspace_id, cwd, workspace_snapshot_json, workspace_fingerprint, primary_root_id, user_goal, status, phase, model_id, provider_ref, plan_mode, limits_json, usage_json, error, started_at, finished_at, working_state_id, latest_checkpoint_id, parent_run_id, role, depth, read_only, budget_json, continued_from_run_id, root_run_id, continuation_index, root_scope_json, prompt_version, toolset_version, runtime_version | 糖码每次运行（主 Run / 子 Agent Run / 续段谱系均在此，`role`/`parent_run_id`/`continued_from_run_id` 表达关系） |
| `agent_run_events` | id, run_id, seq, type, payload_json, created_at | 运行事件流（按 run + seq 有序回放） |
| `agent_working_states` | run_id, goal, plan_json, completed_json, pending_json, blocked_json, files_read_json, files_changed_json, commands_json, checks_json, decisions_json, unresolved_errors_json, verification_skips_json, pending_decisions_json, subagents_json, skill_context_json, assumptions_json, user_confirmations_json, updated_at | 运行中工作状态快照（恢复/续段/审批依赖它） |
| `agent_checkpoints` | id, run_id, seq, reason, state_json, events_to_seq, created_at | 断点检查点（精确恢复） |
| `agent_context_summaries` | id, run_id, thread_id, covered_from_seq, covered_to_seq, summary, version, summary_json, source_hashes_json, validity, created_at | 上下文压缩摘要（结构化 + 来源哈希 + 有效性） |
| `agent_changesets` | id, run_id, root_id, path, old_hash, content_ref, operation, new_hash, target_path, before_exists, status, created_at | 运行级文件变更快照（整 Run 回滚 / Diff 恢复） |

### 2.4 运行与模型指标（2 张，migration15 / Schema v16；刻意不进 `TABLES`）

| 表 | 关键列 | 职责 |
|---|---|---|
| `agent_run_metrics` | run_id, root_run_id, steps, tool_calls, input_tokens, output_tokens, cache_json, cost_usd, latency_ms, queue_wait_ms, process_ms, recovery_rate, error_breakdown_json | Agent Run 汇总指标、缓存与成本影响 |
| `model_call_metrics` | id, run_id, root_run_id, scope, call_type, model_id, provider, request_id, input_tokens, output_tokens, cache_json, cost_usd, latency_ms, queue_wait_ms, status, error_type | Chat / Agent / Image / Documents / Workflow / Cache Probe 的统一模型调用指标 |

---

## 3. 糖码运行数据的用途

- **运行历史**：`agent_runs` + `agent_run_events` 支撑设置页「运行历史」弹窗（按页浏览、检索）。
- **断点恢复与自动续段**：`agent_checkpoints` + `agent_working_states` 记录每一步完整工作状态，任务中断后可从检查点**精确恢复**并自动续段；`agent_runs` 的 `continued_from_run_id / root_run_id / continuation_index` 表达续段谱系。
- **上下文压缩**：`agent_context_summaries` 保存压缩摘要（含覆盖消息区间与来源哈希），避免上下文溢出时丢失计划/错误/变更记录。
- **回滚**：`agent_changesets` 保存每次文件写入的前后哈希与内容引用，支持整 Run 回滚与 Diff 恢复。
- **审计**：六张运行表默认保留，不受「清空数据」影响。

---

## 4. 迁移机制

- 版本号：`SCHEMA_VERSION = 16`（`src/core/schemas/db-schema.js`）。
- 启动时读取 `PRAGMA user_version`，按 `MIGRATIONS[当前..]` 顺序执行，每步在事务内提交并 `user_version + 1`（`src/infrastructure/storage/sqlite-store.js`）。
- 迁移历史要点：
  - `0 → 1`：建全部核心表（DDL 幂等）
  - `1 → 2`：`workflow_runs`
  - `2 → 3`：糖码运行五表（agent_runs / run_events / working_states / checkpoints / context_summaries）
  - `3 → 4`：`agent_changesets`（ChangeSet v1）
  - `4 → 6`：`account_models` 扩展（max_output、think_type）
  - `6 → 7`：`agent_runs` 补 working_state_id / latest_checkpoint_id / created_at
  - `7 → 8`：`agent_threads` 草稿（draft_text / draft_skills）
  - `8 → 9`：Working State 补 verification_skips / pending_decisions；`done` 状态回填 `completed`
  - `9 → 10`：ContextSummary v2（summary_json / source_hashes_json / validity）
  - `10 → 11`：ChangeSet v2（operation / new_hash / target_path / before_exists / status）
  - `11 → 12`：子 Agent Run 谱系（parent_run_id / role / depth / read_only / budget_json + subagents_json）
  - `12 → 13`：Skill 工具权限归因上下文（skill_context_json）
  - `13 → 14`：多根工作区（projects.roots_json / primary_root_id，agent_runs 快照与指纹，changesets.root_id）
  - `14 → 15`：Continuation 谱系（continued_from_run_id / root_run_id / continuation_index / root_scope_json + thread 草稿任务范围）
  - `15 → 16`：Run 版本追踪（prompt_version / toolset_version / runtime_version）与运行、模型调用指标表

---

## 5. 密钥存储（**不在** SQLite / state 内）

- 实现：`src/infrastructure/secrets/kvstore.js`。
- `safeStorage` 加密（Windows DPAPI / macOS Keychain / Linux libsecret）；临时文件 + `rename` 原子写、`chmod 600`、写后回读校验；`setSecret` 带**回滚**（失败恢复原值）。
- 系统密钥服务不可用时降级 base64 明文并标记 `enc:false`（不静默丢 Key）。
- 渲染进程只持有**不透明引用**：`acc:<accountId>`（账户密钥）、`custom:<module>`（模块自定义密钥）、`search`（联网搜索 Key）；`getSecret` 仅主进程内部使用，不经 IPC 回程。
- 模型请求统一走主进程网关：渲染层只传 `ref` + `kind`，地址与密钥由主进程解析。

---

## 6. 工作区（workspaces.json）

- 主进程持有 `workspaceId ↔ { cwd, name }` 注册表，持久化到 `userData/workspaces.json`。
- `registerWorkspace(absPath, name)`：校验绝对路径 + 目录存在后发放 `crypto.randomUUID()` 不透明 id（幂等）；旧项目（有 cwd 无 workspaceId）运行时惰性登记迁移。
- 渲染进程只持有 `workspaceId`，后端经 `resolveWorkspace(id)` 解析受控目录；未知 id 直接拒绝。
- v1.1.0 多根：一个项目可挂多个根目录（`projects.roots_json`），任务按范围限定写入（单根 / 多根 / 全部）。

---

## 7. 备份与升级

- **需要备份的内容**：`activeRoot/tangbao-data/tangbao.db`（权威数据）+ `activeRoot/tangbao-data/state.json`（可读副本）+ `activeRoot/workspaces.json`；密钥在系统密钥库中，随系统账户保留。设置页的脱敏备份默认不包含 API Key。
- **恢复中心**：可检查 SQLite 完整性、`state.json` 与 SQLite 一致性、孤儿文件和 Trace，并导出脱敏诊断包；诊断包、Trace 和 Benchmark 报告都不包含密钥。
- v1.1.0 起数据为版本化 SQLite，升级自动迁移、不再丢数据（历史提示：v1.0.5 → v1.0.6 曾因存储迁移清空聊天记录，此后已切换到稳定持久化）。

---

## 8. v1.1.0 相对 v1.0.6 的变化点

1. **权威源迁移**：localStorage → SQLite（`tangbao.db`），`state.json` 降级为双写副本。
2. **Schema 版本化**：引入 `PRAGMA user_version` + `MIGRATIONS`（v1.1.0 时为 15，当前为 16），替代旧版「字段形态嗅探」迁移。
3. **糖码运行持久化**：新增 agent_runs / events / working_states / checkpoints / context_summaries / changesets 六表（断点恢复、自动续段、上下文压缩、整 Run 回滚）。
4. **多根工作区**：projects 增加 roots_json / primary_root_id，任务级写入范围。
5. **架构路径**：`js/`、`server/` 平铺重构为 `src/` 分层（main / preload / renderer / application / core / infrastructure）；密钥库 `server/secrets.js` → `src/infrastructure/secrets/kvstore.js`。
6. **历史状态修正**：`done` 状态统一回填 `completed`。
