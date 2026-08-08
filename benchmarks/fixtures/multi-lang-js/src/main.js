'use strict';
// fixture：当输入对象缺少 count 字段时，此处会抛 TypeError（count 为 undefined）
function summarize(input) {
  const count = input.count;
  return '共 ' + count + ' 项';
}

module.exports = { summarize };

if (require.main === module) {
  console.log(summarize({}));
}
