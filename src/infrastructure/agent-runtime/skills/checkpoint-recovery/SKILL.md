---
name: checkpoint-recovery
description: 从检查点/失败中断恢复运行的方法
triggers: [检查点, 恢复运行, checkpoint, 中断恢复, 上次运行, 继续上次, 中断]
---
# 检查点恢复

1. 中断恢复（abort/连续失败/预算耗尽/退出）时，先取最近的检查点（saveAgentCheckpoint 产物）。
2. 读取检查点 reason 与状态：aborted / consecutive-fail / budget / emergency，判断中断原因。
3. 依据检查点里的 plan/completedWork/pendingWork 确定下一步，不重跑已完成步骤。
4. 连续工具失败≥3 次中断时，先排查失败根因（读最近 tool_result 错误）再继续，避免重复失败。
5. 恢复后向用户说明：从哪里恢复、剩余步骤、以及中断时已保存的状态。
