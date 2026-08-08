// fixture：add 缺少类型标注，允许 string 隐式传入，导致运行期拼接而非加法
export function add(a, b) {
  return a + b;
}
