// 预算控制示例项目：任务需要多个步骤（实现 + 测试 + 文档），
// 但运行预算（maxSteps）会被设得很小，Agent 应在耗尽预算时主动停止并说明剩余工作。
function add(a, b) {
  return a + b;
}

module.exports = { add };
