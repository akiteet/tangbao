# 糖包 v1.1.3

v1.1.3 是稳定性闭环增强版。它在 v1.1.2 的 Agent Engineering 基础上，把数据迁移、密钥恢复、模型调用、Cache、搜索和发布验证接成可检查的闭环。

## 稳定性与数据安全

- 数据目录迁移增加 `pending/copying/verified/failed/active` 状态、迁移 ID、文件清单、SHA-256 校验、临时目录、原子激活和失败回滚。
- 新增存储审计与恢复中心：SQLite 完整性、`state.json` 一致性、孤儿图片/文档/Trace、备份、迁移结果、密钥恢复结果和脱敏诊断包。
- 旧目录清理先预览，默认移动到时间戳隔离目录；不自动删除历史 Run、Trace、图片或文档。
- 自定义数据目录统一承载 `tangbao-data`，默认目录只保留指针、迁移状态和必要备份。
- 密钥库新增诊断与显式旧上下文恢复；解密验证失败时不覆盖原密钥，并在覆盖前备份原始密文。

## Runtime 与 Agent

- 抽出可注入的 `runAgent(input, dependencies)` 边界，离线 Benchmark 直接驱动真实 Runtime。
- Budget 覆盖模型、工具、队列等待和进程执行；Abort 级联到模型、工具、Skill、子 Agent、队列和后台任务。
- 所有终态只写入一次；取消、预算耗尽、权限拒绝和基础设施失败不会被误报为完成。
- 协作树保留父子关系，finding 支持 `confidence`、evidence 和 `sourceRunId`；Trace Inspector 保持只读，不支持重放。

## 模型与 Cache

- Chat、Agent、Image、Documents、Workflow、Context Summary 和 Cache Probe 统一写入 `model_call_metrics`，每次调用生成本地 `requestId`。
- 新增 Provider Health、模型 Profile 和用户主动触发的真实 Cache Probe。
- Provider 未返回 Token、成本或 Cache Usage 时保持 `null/unknown`，不把未知伪装成 0；离线 Benchmark 使用 `offline-mock` 并明确标注来源。

## 产品体验与工程效率

- 新增 `Ctrl/Cmd + K` 命令面板、本地分页搜索和通知中心。
- “运行观测”继续作为紧凑入口和弹窗，不占用首屏整块横栏。
- 新增 `npm run check:version`、`npm run check:storage`、`npm run bench:offline` 和 `npm run check:release`。
- CI 增加 Node 18/20/22、Windows 全量测试与 NSIS 检查、macOS x64/arm64 DMG/ZIP 检查、迁移检查和离线 Benchmark 重复性检查。

## 兼容边界

- Schema 继续保持 v16；v1.1.0/v1.1.1/v1.1.2 的历史数据、事件、摘要、Checkpoint、ChangeSet 和密钥上下文不主动删除。
- 子 Agent 只读，父 Agent 统一写入；不自动重试全部失败任务；不开放任意动态插件代码。
- API Key 不进入普通备份、诊断包、Trace 导出或 Benchmark 报告。
