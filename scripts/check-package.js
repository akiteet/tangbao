'use strict';
/* 发布防呆：校验 dist/ 安装包与源码一致（2026-08-27 教训：旧包被传上 Release）。
 * 用法：npm run check:package —— 打包之后、上传 Release 之前必跑，全部通过才允许上传。
 * 四道断言：
 *   ① 最新 setup.exe 的 mtime 不早于全部关键源文件（否则是旧货）；
 *   ② asar 内 splash.html/index.html 与工作区源码归一化后逐字节一致；
 *   ③ latest.yml version === package.json version；
 *   ④ setup.exe 实际 sha512 === latest.yml 顶层 sha512 === files[0].sha512（交叉一致）。
 * 测试缝：process.env.TANGBAO_DIST 可覆盖 dist 目录（供 test/ 夹具验证正/负路径）。 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const asar = require('@electron/asar');

const ROOT = path.join(__dirname, '..');

function fail(msg) { throw new Error('[check:package] ' + msg); }
const sha512 = (buf) => crypto.createHash('sha512').update(buf).digest('base64');

// electron-builder latest.yml 极简解析（仅取顶层字段；files 列表是缩进的，不会误匹配 ^ 锚点）
function parseLatestYml(text) {
  const version = (text.match(/^version:\s*['"]?([^'"\s]+)/m) || [])[1] || '';
  const topSha = (text.match(/^sha512:\s*['"]?([^'"\s]+)/m) || [])[1] || '';
  const fileSha = (text.match(/^  - url: .*[\s\S]*?sha512:\s*['"]?([^'"\s]+)/m) || [])[1] || '';
  return { version, topSha, fileSha };
}

const KEY_SOURCES = [
  'package.json', 'index.html', 'splash.html', 'pet.html', 'styles.css',
  'src/core/shortcuts.js', 'src/renderer/components/shortcuts.js',
  'src/renderer/components/i18n.js', 'src/renderer/views/images/image.js',
  'src/renderer/views/tavern/tavern.js', 'src/renderer/app.js',
  'src/renderer/pet/pet.js',
];
const ASAR_COMPARE_FILES = ['splash.html', 'index.html', 'pet.html'];

function main() {
  const dist = process.env.TANGBAO_DIST ? path.resolve(process.env.TANGBAO_DIST) : path.join(ROOT, 'dist');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!fs.existsSync(dist)) fail('dist 目录不存在（' + dist + '），请先 electron-builder 打包');
  const exes = fs.readdirSync(dist).filter((f) => /-setup\.exe$/i.test(f));
  if (!exes.length) fail('dist 下未找到 *-setup.exe，请先打包');
  exes.sort((a, b) => fs.statSync(path.join(dist, b)).mtimeMs - fs.statSync(path.join(dist, a)).mtimeMs);
  const exe = exes[0];
  const exeAbs = path.join(dist, exe);
  const exeMtime = fs.statSync(exeAbs).mtimeMs;

  // ① 旧包检测：关键源文件不得晚于 exe（容差 1s，规避同批构建毫秒级时间差）
  const stale = KEY_SOURCES.filter((f) => {
    const src = path.join(ROOT, f);
    if (!fs.existsSync(src)) return false;
    return fs.statSync(src).mtimeMs > exeMtime + 1000;
  });
  if (stale.length) fail('检测到旧包：setup.exe（' + exe + '）早于以下已修改源码 → ' + stale.join(', ') + '。请重新打包后再上传。');

  // ② asar 关键文件与工作区源码一致（归一化行尾后比较）
  const asarPath = path.join(dist, 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) fail('缺少 app.asar（' + asarPath + '）——win-unpacked 未生成或已被清理');
  const norm = (s) => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (const f of ASAR_COMPARE_FILES) {
    const src = norm(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    let packed;
    try { packed = norm(asar.extractFile(asarPath, f).toString('utf8')); }
    catch (e) { fail('asar 内缺少 ' + f + '：' + (e && e.message ? e.message : String(e))); }
    if (packed !== src) fail('asar 内 ' + f + ' 与工作区源码不一致——安装包是旧货，禁止上传');
  }

  // ③ latest.yml version 与 package.json 一致
  const ymlPath = path.join(dist, 'latest.yml');
  if (!fs.existsSync(ymlPath)) fail('缺少 latest.yml（' + ymlPath + '）');
  const yml = parseLatestYml(fs.readFileSync(ymlPath, 'utf8'));
  if (yml.version !== pkg.version) fail('latest.yml version=' + yml.version + ' ≠ package.json version=' + pkg.version);

  // ④ sha512 交叉一致：exe 实算 = latest.yml 顶层 = files[0]
  const exeHash = sha512(fs.readFileSync(exeAbs));
  if (yml.topSha && yml.topSha !== exeHash) fail('latest.yml 顶层 sha512 与 setup.exe 实际不符');
  if (yml.fileSha && yml.fileSha !== exeHash) fail('latest.yml files[0].sha512 与 setup.exe 实际不符');

  return { ok: true, version: pkg.version, exe, dist, checks: ['source-mtime', 'asar-content', 'latest-version', 'sha512-cross'] };
}

if (require.main === module) {
  try { console.log(JSON.stringify(main(), null, 2)); }
  catch (error) { console.error(error.message || String(error)); process.exitCode = 1; }
}
module.exports = { main, KEY_SOURCES, ASAR_COMPARE_FILES, parseLatestYml };
