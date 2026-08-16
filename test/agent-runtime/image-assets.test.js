'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createImageAssetStore, sniffImageMime, validAssetName } = require('../../src/infrastructure/storage/image-assets');

// 1x1 像素的真实图片 base64（png / jpeg 头）
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AmgA//9k=';
const WEBP_HEADER_B64 = 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';

function tempStore(quotaBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-img-assets-'));
  return { dir, store: createImageAssetStore({ dir, quotaBytes }) };
}

test('sniffImageMime：png/jpeg/webp 魔数与垃圾输入', () => {
  assert.equal(sniffImageMime(PNG_B64), 'image/png');
  assert.equal(sniffImageMime(JPEG_B64), 'image/jpeg');
  assert.equal(sniffImageMime(WEBP_HEADER_B64), 'image/webp');
  assert.equal(sniffImageMime('aaaaaaaa'), null); // 无效内容（等号不足时按 null 处理）
  assert.equal(sniffImageMime(''), null);
});

test('validAssetName：拒绝路径穿越与非法字符', () => {
  assert.equal(validAssetName('img-abc123.png'), true);
  assert.equal(validAssetName('../etc/passwd'), false);
  assert.equal(validAssetName('a/b.png'), false);
  assert.equal(validAssetName('a\\b.png'), false);
  assert.equal(validAssetName('..png'), false);
  assert.equal(validAssetName(''), false);
  assert.equal(validAssetName('C:/x.png'), false);
});

test('save/read/remove 往返：扩展名按内容嗅探、dataUrl 带正确 MIME', () => {
  const { dir, store } = tempStore();
  const saved = store.save(PNG_B64);
  assert.equal(saved.ok, true);
  assert.match(saved.name, /^img-[a-z0-9-]+\.png$/);
  assert.equal(fs.existsSync(path.join(dir, saved.name)), true);

  const read = store.read(saved.name);
  assert.equal(read.ok, true);
  assert.equal(read.mime, 'image/png');
  assert.match(read.dataUrl, /^data:image\/png;base64,/);

  const jpeg = store.save(JPEG_B64);
  assert.equal(jpeg.ok, true);
  assert.match(jpeg.name, /\.jpg$/);

  const removed = store.remove(saved.name);
  assert.equal(removed.ok, true);
  assert.equal(store.read(saved.name).ok, false);
  assert.equal(store.read(saved.name).code, 'image_asset_not_found');
  assert.equal(store.remove(saved.name).code, 'image_asset_not_found');
});

test('save：拒绝非 base64 输入；read/remove：拒绝恶意名称', () => {
  const { store } = tempStore();
  assert.equal(store.save('not base64!!').code, 'image_asset_not_base64');
  assert.equal(store.save('').code, 'image_asset_empty');
  assert.equal(store.read('../secrets.json').code, 'image_asset_bad_name');
  assert.equal(store.read('../../state.json').code, 'image_asset_bad_name');
  assert.equal(store.remove('..').code, 'image_asset_bad_name');
});

test('配额护栏：超限写入返回 code:quota，不产生文件', () => {
  const { dir, store } = tempStore(1024); // 1KB 配额
  const first = store.save(PNG_B64); // ~70 字节
  assert.equal(first.ok, true);
  const many = Array.from({ length: 30 }, () => store.save(PNG_B64));
  const quotaHit = many.some((r) => r && r.code === 'quota');
  assert.equal(quotaHit, true);
  // 触发配额后目录体积不超过配额（+最后一张容差）
  let total = 0;
  for (const name of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, name)).size;
  assert.ok(total <= 1024 + 200, 'dir size within quota: ' + total);
});

test('迁移语义支撑：先写文件后改索引的素材（save 幂等独立、失败不污染）', () => {
  const { store } = tempStore();
  const a = store.save(PNG_B64);
  const b = store.save(PNG_B64);
  assert.notEqual(a.name, b.name); // 每次落盘独立文件名，重复内容不覆盖
  assert.equal(store.read(a.name).dataUrl, store.read(b.name).dataUrl);
});
