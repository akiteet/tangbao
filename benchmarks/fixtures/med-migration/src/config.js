const raw = { legacy_mode: 'on' };
// 迁移：读取旧字段写入新字段
const config = { mode: raw.legacy_mode === 'on' ? 'enabled' : 'disabled' };
module.exports = config;
