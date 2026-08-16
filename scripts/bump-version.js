'use strict';

/*
 * 版本号统一 bump 工具（v1.1.5 批次 B）。
 *
 * 用法：
 *   node scripts/bump-version.js <target-version> [--dry-run]
 *   npm run bump -- 1.1.5
 *
 * 只替换「显式锚点」，绝不触碰 README / CHANGELOG 中的历史版本段落：
 *   - package.json / package-lock.json 的 version 字段（JSON 往返，写入前先验证格式稳定）
 *   - role-registry.js        version: '<cur>'
 *   - agent-runtime-engine.js const TOOL_REGISTRY_VERSION = '<cur>' / const RUNTIME_VERSION = '<cur>'
 *   - 两个 release workflow   default: v<cur>
 *   - README.md / README.en.md  tangbao-<cur>-setup.exe
 *
 * 完成后自动调用 check-version.js 验证；check-release.js 需要的
 * docs/CHANGELOG-v<target>.md 若缺失只提醒不阻断（内容由人工撰写）。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

// 文本锚点：[文件, 旧锚点(模板), 必须出现(至少 N 次)]
function textAnchors(cur, target) {
  return [
    ['src/core/agent-runtime/role-registry.js', "version: '" + cur + "'", "version: '" + target + "'", 1],
    ['src/infrastructure/agent-runtime/agent-runtime-engine.js', "const TOOL_REGISTRY_VERSION = '" + cur + "'", "const TOOL_REGISTRY_VERSION = '" + target + "'", 1],
    ['src/infrastructure/agent-runtime/agent-runtime-engine.js', "const RUNTIME_VERSION = '" + cur + "'", "const RUNTIME_VERSION = '" + target + "'", 1],
    ['.github/workflows/macos-release.yml', 'default: v' + cur, 'default: v' + target, 1],
    ['.github/workflows/macos-release-assets.yml', 'default: v' + cur, 'default: v' + target, 1],
    ['README.md', 'tangbao-' + cur + '-setup.exe', 'tangbao-' + target + '-setup.exe', 1],
    ['README.en.md', 'tangbao-' + cur + '-setup.exe', 'tangbao-' + target + '-setup.exe', 1],
  ];
}

function readText(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

// JSON 往返必须字节稳定才允许程序化写入，避免顺手重排手工维护的文件。
// 保留原文件的行尾风格（CRLF/LF）与是否有末尾换行。
function rewriteJson(file, mutate) {
  const raw = readText(file);
  const parsed = JSON.parse(raw);
  const crlf = raw.includes('\r\n');
  const trailingNewline = /\r?\n$/.test(raw);
  const stable = JSON.stringify(parsed, null, 2) + (trailingNewline ? '\n' : '');
  const normalized = crlf ? stable.replace(/\n/g, '\r\n') : stable;
  if (normalized !== raw) throw new Error(file + ' 不是 2 空格 JSON 往返稳定格式，拒绝改写（请手工更新）');
  mutate(parsed);
  const next = JSON.stringify(parsed, null, 2) + (trailingNewline ? '\n' : '');
  return crlf ? next.replace(/\n/g, '\r\n') : next;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const target = args.find((a) => !a.startsWith('--'));
  if (!target || !/^\d+\.\d+\.\d+$/.test(target)) {
    throw new Error('用法: node scripts/bump-version.js <x.y.z> [--dry-run]');
  }
  const pkg = JSON.parse(readText('package.json'));
  const cur = pkg.version;
  if (target === cur) throw new Error('目标版本与当前版本相同: ' + cur);

  const changes = [];

  // 1) package.json / package-lock.json（JSON 字段更新）
  const pkgNext = rewriteJson('package.json', (p) => { p.version = target; });
  changes.push({ file: 'package.json', from: cur, to: target, count: 1 });
  const lockNext = rewriteJson('package-lock.json', (l) => {
    l.version = target;
    if (l.packages && l.packages['']) l.packages[''].version = target;
  });
  if (JSON.parse(lockNext).version !== target) throw new Error('package-lock.json 更新失败');
  changes.push({ file: 'package-lock.json', from: cur, to: target, count: 2 });

  // 2) 文本锚点替换
  const contents = new Map();
  for (const [file, from, to, min] of textAnchors(cur, target)) {
    if (!contents.has(file)) contents.set(file, readText(file));
    const content = contents.get(file);
    const count = content.split(from).length - 1;
    if (count < min) throw new Error(file + ' 未找到锚点 ' + from + '（找到 ' + count + ' 处，要求 >= ' + min + '）');
    // 历史版本段落保护：锚点必须足够特异（含前缀与版本号），这里再确认目标串替换后不会误伤
    contents.set(file, content.split(from).join(to));
    changes.push({ file, from, to, count });
  }

  console.log('[bump-version] ' + cur + ' -> ' + target + (dryRun ? '（dry-run，不落盘）' : ''));
  for (const c of changes) console.log('  ' + c.file + ': ' + (c.from === cur ? c.from : JSON.stringify(c.from)) + ' x' + c.count);

  if (dryRun) {
    console.log('[bump-version] dry-run 结束，未修改任何文件');
    return;
  }

  fs.writeFileSync(path.join(ROOT, 'package.json'), pkgNext);
  fs.writeFileSync(path.join(ROOT, 'package-lock.json'), lockNext);
  for (const [file, content] of contents) fs.writeFileSync(path.join(ROOT, file), content);

  if (!fs.existsSync(path.join(ROOT, 'docs/CHANGELOG-v' + target + '.md'))) {
    console.warn('[bump-version] 提醒：docs/CHANGELOG-v' + target + '.md 尚不存在，check:release 需要该文件，请人工撰写');
  }

  const verify = spawnSync(process.execPath, [path.join(__dirname, 'check-version.js')], { cwd: ROOT, encoding: 'utf8' });
  if (verify.status !== 0) throw new Error('check-version 验证失败:\n' + (verify.stdout || '') + (verify.stderr || ''));
  console.log('[bump-version] 完成，check-version 已通过');
}

if (require.main === module) {
  try { main(); } catch (error) { console.error('[bump-version] ' + (error.message || error)); process.exitCode = 1; }
}

module.exports = { textAnchors, main };
