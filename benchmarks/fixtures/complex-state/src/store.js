// 单一数据源
const state = { count: 0 };
module.exports = { get: () => state, inc: () => { state.count += 1; return state; } };
