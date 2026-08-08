---
name: refactor-split
description: 大模块/长函数按职责拆分与重构的流程
triggers: [重构, 拆分, 拆函数, 拆分模块, refactor, split, 超长函数, 大文件]
---
# 重构与拆分

1. 先用 get_file_outline / read_file 看清模块整体结构与职责边界。
2. 确定拆分边界：按职责/依赖方向切分，避免循环依赖；把拆分计划写进 todo（todo_write）。
3. 新建文件时保留原入口兼容（导出同名 API 或 re-export），调用方无需改动。
4. 每拆出一部分就运行一次语法/测试验证（node --check 或对应测试），不要一次性拆完再验证。
5. 用 find_symbol / find_references 确认符号引用关系已正确迁移。
6. 拆分前后行为必须一致：跑一遍原有测试与入口冒烟，确认无回归。
