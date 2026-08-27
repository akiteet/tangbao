'use strict';
// 文件仓行为回归（v1.2.0 批次 2：补零覆盖模块 file-repo.js，纯 Node + 临时目录）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const repo = require('../../src/infrastructure/storage/file-repo.js');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-file-repo-'));
}

test('init 建齐全部分类目录', () => {
  const root = tmpRoot();
  const info = repo.init(root);
  assert.deepEqual(info.categories, repo.CATEGORIES);
  for (const c of repo.CATEGORIES) {
    assert.ok(fs.existsSync(path.join(info.base, c)), '缺少分类目录: ' + c);
  }
});

test('put/get 往返（字符串与 Buffer），has/remove/list 正确', () => {
  const root = tmpRoot();
  repo.init(root);
  repo.put('images', 'img-1', 'hello 文本');
  repo.put('documents', 'doc-1', Buffer.from([0, 1, 2, 255]));

  assert.equal(repo.has('images', 'img-1'), true);
  assert.equal(repo.get('images', 'img-1').toString('utf8'), 'hello 文本');
  assert.deepEqual(repo.get('documents', 'doc-1'), Buffer.from([0, 1, 2, 255]));
  assert.ok(repo.list('documents').includes('doc-1'));

  assert.equal(repo.remove('images', 'img-1'), true);
  assert.equal(repo.has('images', 'img-1'), false);
  assert.equal(repo.get('images', 'img-1'), null, '删除后 get 返回 null 而非抛错');
});

test('路径穿越与非法 id 一律拒绝（安全契约）', () => {
  const root = tmpRoot();
  repo.init(root);
  assert.throws(() => repo.put('images', '../evil', 'x'), /非法文件 id/);
  assert.throws(() => repo.put('images', 'a/b', 'x'), /非法文件 id/);
  assert.throws(() => repo.put('not-a-category', 'ok-id', 'x'), /未知文件仓分类/);
  // get/has 按契约吞错：非法输入返回 null/false 而非抛错
  assert.equal(repo.get('../escape', 'x'), null);
  assert.equal(repo.has('not-a-category', 'x'), false);
  // 穿越尝试不得在仓外留下文件
  assert.ok(!fs.existsSync(path.join(root, 'evil')));
});
