const test = require('node:test');
const assert = require('node:assert/strict');
const process = require('../src/batch');
test('基本处理', () => { assert.deepEqual(process([1]), [1]); });
