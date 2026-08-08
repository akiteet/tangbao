// 示例数据层：users 表无 email 列，需迁移
const table = { columns: ['id', 'name'], rows: [{ id: 1, name: 'a' }] };
function query() { return table.rows; }
module.exports = { query };
