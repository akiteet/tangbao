const test = require('node:test');
const assert = require('node:assert/strict');
const { divide } = require('../src/calc');
test('divide 除零返回 0 而非 Infinity', () => { assert.equal(divide(10, 0), 0); });
