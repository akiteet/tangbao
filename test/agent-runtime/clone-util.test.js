'use strict';
// 深拷贝共享实现行为回归（v1.2.0 批次 2：补零覆盖模块 clone.js）
const test = require('node:test');
const assert = require('node:assert');
const { clone } = require('../../src/core/util/clone.js');

test('空值原样透传（不包装成对象）', () => {
  assert.equal(clone(null), null);
  assert.equal(clone(undefined), undefined);
});

test('嵌套对象深拷贝：源与副本互不影响', () => {
  const src = { a: 1, list: [1, { b: 'x' }], nested: { deep: { v: true } } };
  const out = clone(src);
  assert.deepEqual(out, src);
  out.list[1].b = 'changed';
  out.nested.deep.v = false;
  assert.equal(src.list[1].b, 'x');
  assert.equal(src.nested.deep.v, true);
});

test('数组独立拷贝', () => {
  const src = [{ id: 1 }];
  const out = clone(src);
  out[0].id = 99;
  assert.equal(src[0].id, 1);
  assert.deepEqual(out, [{ id: 99 }]);
});

test('循环引用返回 null（JSON 往返失败的既定契约）', () => {
  const a = {};
  a.self = a;
  assert.equal(clone(a), null);
});
