---
name: your-skill-name
description: 一句话说明这个技能做什么
license: MIT
compatibility: 说明所需环境；没有特殊要求可删除此字段
metadata:
  author: your-name
triggers: [关键词1, 关键词2, 中文关键词]
---

# 技能标题

## 工作流程

1. 第一步：明确输入、约束和预期结果。
2. 第二步：按最小范围执行任务；需要资料时先读取 `references/`。
3. 第三步：运行适用验证，失败时先修复再交付。

## 资源

- 参考资料放在 `references/`。
- 可复用脚本放在 `scripts/`；导入或激活不会自动执行，显式执行需审批。
- 模板、图片等放在 `assets/`；复制进项目需写入审批。

## 输出要求

说明改动、验证证据、剩余风险和用户可复现步骤。

> `triggers` 是糖码兼容扩展；标准 Skill 的核心字段是 `name` 与 `description`。目录名必须与 `name` 一致。