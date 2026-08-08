const test = require('node:test');
const assert = require('node:assert/strict');
const sum = require('../src/sum');
test('sum 基本求和', () => { assert.equal(sum(1, 2), 3); });
