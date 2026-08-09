# Agent Trace Inspector

Trace Inspector 从糖码运行历史进入，只读展示一次 Root Run 及其子 Run。

## 数据接口

- `agent:tracePage({ rootRunId, cursor, limit, types, statuses, depth, includePayload })`
- `agent:runMetrics(rootRunId)`
- `agent:exportTrace({ rootRunId, redacted: true })`

Trace 页面按事件创建时间分页，支持事件类型、状态和深度过滤。载荷默认脱敏，导出为脱敏 JSONL，并带完整性摘要；导出不会包含 API Key、Authorization、Cookie、Secret、Credential 或 Bearer Token。

## 事件

标准事件包括 `llm_call`、`tool_call`、`subagent`、`budget`、`cache`、审批和终态事件。指标面板展示步骤、工具调用、Token、耗时、队列等待、费用、缓存命中率、节省 Token、节省费用和错误恢复建议。

Inspector 不提供 Trace 重放、工具执行或任意脚本入口。大事件流必须通过 `cursor` 继续加载，损坏事件按原始事件保留并以可诊断状态展示。
