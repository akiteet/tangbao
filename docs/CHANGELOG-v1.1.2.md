# 糖包 v1.1.2

v1.1.2 是 Agent Engineering Platform 基础版本，重点是让一次 Agent Run 可治理、可解释、可比较。

## 运行时

- 引入内部 `ToolRegistry` 和 `RoleRegistry`，统一工具 schema、风险、能力、角色、只读属性、超时和版本快照。
- 引入 `BudgetManager`，覆盖步骤、时长、输入/输出 Token、费用、队列等待和进程执行预算，并支持父 Run 向子 Run 分配预算。
- 引入统一错误分类：`tool_failure`、`model_failure`、`permission_failure`、`context_limit`、`timeout`、`invalid_result`、`cancelled`、`budget_exhausted`、`infrastructure_failure`。
- Run 的 `AbortController` 级联到模型、工具和 Skill 进程，取消后清理后台任务、Session、计时器和并发槽。

## 数据和可观测性

- Schema 升级到 v16，新增 Run 版本追踪、`agent_run_metrics` 和 `model_call_metrics`。
- Chat、Agent、Image、Documents、Workflow 统一记录模型调用与缓存指标；未知缓存数据保持 `unknown`，不当作 0。
- 新增 Trace 分页、过滤、协作树、运行指标和脱敏 JSONL 导出。
- 保留 v1.1.0 / v1.1.1 的 Run、事件、Checkpoint、摘要和 ChangeSet。

## Eval / Benchmark

- 新增离线固定 Benchmark Suite，使用 deterministic seed 和 mock provider。
- 覆盖多 Agent、部分失败、取消恢复、排队调度、冷/热缓存和缓存前缀失效。
- 提供报告比较门禁：成功率最多下降 5 个百分点，Token、费用和 p95 延迟默认最多增加 10%。

## 兼容边界

- 子 Agent 继续只读，父 Agent 统一写入。
- Trace Inspector 只读，不支持重放或执行工具。
- Tool Registry 首版只接受内部可信适配器，不执行任意动态插件代码。
