# 糖包 v1.1.1

发布日期：2026-08-09

## 并行专家 Agent 协作

- `explore / test / review` 子代理统一返回结构化摘要、发现、证据、检查、步骤、工具数、耗时和错误。
- 支持最多 8 个子任务、最多 3 个并发；并发已满的任务进入队列，不自动重试失败任务。
- 父代理等待全部子任务结束后生成 aggregate；部分成功会明确标记为 degraded/blocked，完成门不会误报完全完成。
- 子代理保持只读，所有文件修改仍由父代理执行。
- 新增 `subagent_queued`、`subagent_summary` 事件，实时卡片和历史详情可查看 findings、证据路径、检查结果及失败原因。

## 持久化与安全

- 复用 SQLite Schema v15 的 Agent Run、事件和 WorkingState；新增只读 `agent:runTree(rootRunId)` 历史协作树接口。
- 文件事务统一校验真实路径，阻止已有符号链接和新建路径经外部链接越界。
- Skill Runner 在 timeout/abort 后确认子进程退出，避免挂起进程占用并发槽。

## 发布说明

- 权限模式文档统一为 6 档：`plan / default / acceptEdits / auto / bypass / sandbox`。
- CI 增加依赖安装、全量 `npm test`、JS 语法检查和 Electron 构建检查。
- Provider Canary 没有密钥时跳过，不影响离线测试；本版本不自动重试子代理，也不新增 Schema v16。
