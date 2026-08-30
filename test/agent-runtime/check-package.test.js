'use strict';
// 发布防呆脚本（批次 4）：npm run check:package —— 正路径（新鲜包通过）与负路径（旧包拒绝）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '../..');
const { main, parseLatestYml } = require(path.join(root, 'scripts/check-package.js'));

const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest('base64');

async function buildFixture(dir, pkgVersion, exeMtimeMs) {
  // 用当前真实 splash.html/index.html 打包进夹具 asar（内容比对走真源）
  const asarSrc = path.join(dir, 'asar-src');
  fs.mkdirSync(asarSrc, { recursive: true });
  // v1.2.1 批次 12：桌面宠物 pet.html 也纳入 asar 内容比对
  for (const f of ['splash.html', 'index.html', 'pet.html']) fs.copyFileSync(path.join(root, f), path.join(asarSrc, f));
  const dist = path.join(dir, 'dist');
  fs.mkdirSync(path.join(dist, 'win-unpacked', 'resources'), { recursive: true });
  await asar.createPackage(asarSrc, path.join(dist, 'win-unpacked', 'resources', 'app.asar'));
  // 假 setup.exe + latest.yml（sha512 交叉一致）
  const exePath = path.join(dist, 'tangbao-test-setup.exe');
  fs.writeFileSync(exePath, Buffer.from('fake exe payload for check-package test'));
  const hash = sha512(fs.readFileSync(exePath));
  fs.writeFileSync(path.join(dist, 'latest.yml'),
    'version: ' + pkgVersion + '\nfiles:\n  - url: tangbao-test-setup.exe\n    sha512: ' + hash + '\n    size: 42\npath: tangbao-test-setup.exe\nsha512: ' + hash + '\n');
  const at = new Date(exeMtimeMs);
  fs.utimesSync(exePath, at, at);
  return { dist, hash };
}

test('check:package 正路径：新鲜包四道断言全过', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-cp-ok-'));
  const old = process.env.TANGBAO_DIST;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    await buildFixture(dir, pkg.version, Date.now() + 24 * 3600 * 1000); // exe mtime 设为未来（晚于所有关键源）
    process.env.TANGBAO_DIST = path.join(dir, 'dist');
    const res = main();
    assert.equal(res.ok, true);
    assert.equal(res.version, pkg.version);
    assert.deepEqual(res.checks, ['source-mtime', 'asar-content', 'latest-version', 'sha512-cross']);
  } finally {
    if (old === undefined) delete process.env.TANGBAO_DIST; else process.env.TANGBAO_DIST = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('check:package 负路径①：setup.exe 早于关键源（旧包）→ 拒绝', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-cp-old-'));
  const old = process.env.TANGBAO_DIST;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    await buildFixture(dir, pkg.version, 0); // exe mtime = epoch，必然早于关键源
    process.env.TANGBAO_DIST = path.join(dir, 'dist');
    assert.throws(() => main(), /旧包/);
  } finally {
    if (old === undefined) delete process.env.TANGBAO_DIST; else process.env.TANGBAO_DIST = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('check:package 负路径②：asar 内容与源码不一致（旧货）→ 拒绝', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-cp-stale-'));
  const old = process.env.TANGBAO_DIST;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const { dist } = await buildFixture(dir, pkg.version, Date.now() + 24 * 3600 * 1000);
    // 篡改 asar 内的 index.html（模拟打包时用的是旧文件）
    const asarPath = path.join(dist, 'win-unpacked', 'resources', 'app.asar');
    const tgt = path.join(dir, 'tamper');
    fs.mkdirSync(tgt, { recursive: true });
    const files = asar.listPackage(asarPath);
    for (const f of files) {
      if (f === '/index.html' || f === '\\index.html') continue;
      // Windows 下 listPackage 返回反斜杠路径（HANDOFF 坑：用解析不用字符串前缀）
      const rel = f.replace(/^[\\/]+/, '').replace(/\\/g, '/');
      const out = path.join(tgt, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, asar.extractFile(asarPath, rel));
    }
    fs.writeFileSync(path.join(tgt, 'index.html'), '<html><!-- tampered --></html>');
    fs.rmSync(asarPath);
    await asar.createPackage(tgt, asarPath);
    process.env.TANGBAO_DIST = dist;
    assert.throws(() => main(), /不一致/);
  } finally {
    if (old === undefined) delete process.env.TANGBAO_DIST; else process.env.TANGBAO_DIST = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseLatestYml：顶层 version/sha512 与 files[0].sha512 分离解析', () => {
  const yml = parseLatestYml('version: 1.2.0\nfiles:\n  - url: a.exe\n    sha512: FILEHASH\npath: a.exe\nsha512: TOPHASH\n');
  assert.equal(yml.version, '1.2.0');
  assert.equal(yml.topSha, 'TOPHASH');
  assert.equal(yml.fileSha, 'FILEHASH');
});
