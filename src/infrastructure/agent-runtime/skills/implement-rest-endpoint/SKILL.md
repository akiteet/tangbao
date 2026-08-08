---
name: implement-rest-endpoint
description: 新增 REST API 端点的完整实现流程（路由+校验+处理+测试）
triggers: [新增接口, 新接口, 端点, endpoint, REST API, 路由, api接口, 加个接口]
---

# 实现 REST 端点

1. 用 get_repo_map 找路由文件（通常 server/app/routes/api 下）；用 grep 搜现有路由注册模式。
2. 遵循现有风格：路由定义、请求解析、错误处理三段式；参数用现有校验工具（如 zod/joi/自研 validate）。
3. 实现 handler：参数校验 → 业务逻辑 → 返回统一响应结构（沿用项目已有 res 封装）。
4. 用 run_tests 或项目测试命令补充/更新该接口测试；若项目无测试，至少用 run_command 手动 curl 冒烟。
5. 高风险场景：修改公共路由中间件时跑全量测试 + build。
6. 完成后在总结中列出新端点路径、方法、请求/响应示例。
