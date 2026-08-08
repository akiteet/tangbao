'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..');
const ui = fs.readFileSync(path.join(root, 'src/renderer/components/ui.js'), 'utf8');

test('技能「⋯」菜单挂接一次性外部点击折叠委托', () => {
  assert.match(ui, /_skillMoreBound/);
  assert.match(ui, /document\.addEventListener\('click', \(e\) => \{\s*const inside = e\.target && e\.target\.closest \? e\.target\.closest\('\.skill-more'\) : null;/);
  assert.match(ui, /\.skill-more\[open\]'\)\.forEach\(\(m\) => \{ if \(m !== inside\) m\.open = false; \}\)/);
});

test('技能「⋯」菜单支持 Esc 键关闭且防重复绑定', () => {
  assert.match(ui, /document\.addEventListener\('keydown', \(e\) => \{\s*if \(e\.key === 'Escape'\)/);
  assert.match(ui, /\.skill-more\[open\]'\)\.forEach\(\(m\) => \{ m\.open = false; \}\)/);
  assert.match(ui, /if \(!App\.ui\._skillMoreBound\)/);
});

test('技能菜单项点击后仍保持手动收起', () => {
  assert.match(ui, /const more = btn\.closest\('\.skill-more'\);/);
  assert.match(ui, /if \(more\) more\.open = false;/);
});
