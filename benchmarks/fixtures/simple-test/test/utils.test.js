const test = require('node:test');
const assert = require('node:assert/strict');
const { clamp } = require('../src/utils');
test('clamp 正常范围', () => { assert.equal(clamp(5, 0, 10), 5); });
