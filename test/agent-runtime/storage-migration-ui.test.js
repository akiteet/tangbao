'use strict';

const fs = require('node:fs');
const { readRuntimeSource, readRendererSource, readMainSource } = require('./source-helper');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');

test('storage migration UI has a non-submit button and visible failure handling', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'src/renderer/components/ui.js'), 'utf8');
  const main = readMainSource();
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

  assert.match(html, /<button type="button" class="btn-primary" id="chooseStorageLocation">/);
  assert.match(ui, /await service\.chooseStorageLocation\(\)/);
  assert.match(ui, /location_not_writable/);
  assert.match(ui, /写入权限/);
  assert.match(ui, /EPERM/);
  assert.match(ui, /迁移失败：/);
  assert.match(ui, /service\.relaunchApp\(\)/);
  assert.match(main, /move\.code !== 'location_not_writable'/);
  assert.match(main, /重新选择/);
  assert.match(main, /打开目录/);
  assert.match(main, /授予“修改”权限/);
  assert.match(styles, /\.toast[\s\S]*z-index: 420/);
});
