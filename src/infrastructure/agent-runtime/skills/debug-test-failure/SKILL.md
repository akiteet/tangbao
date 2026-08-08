---
name: debug-test-failure
description: 测试失败时的系统化排查与修复流程
triggers: [测试失败, test failed, 用例失败, failing test, 跑测试, 修复测试]
---

# 排查测试失败

1. 用 run_tests 运行测试，拿到失败的命令与退出码。
2. 用 read_file 读取失败用例源码，先看懂断言期望什么、实际得到什么。
3. 用 grep 搜索失败输出中的关键符号/文件路径，定位涉及文件。
4. 判断失败是否由本次修改引起（run_tests 返回的 relatedToChanges 可参考）。
5. 修复后只重跑最小相关测试（对应命令/文件），通过后再跑完整测试。
6. 全部通过前不得声称任务完成；记录失败原因到总结。
