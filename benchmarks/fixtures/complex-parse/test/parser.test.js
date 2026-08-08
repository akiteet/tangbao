const test = require('node:test');
const assert = require('node:assert/strict');
const parse = require('../src/parser');
test('正常输入', () => { assert.doesNotThrow(() => parse('x')); });
