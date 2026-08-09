'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readRuntimeSource } = require('./source-helper');

const ROOT = path.join(__dirname, '../..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('项目级 Skill 以 .workbuddy/skills 为标准根并保留旧目录兼容', () => {
  const main = read('src/main/main.js');
  const runtime = readRuntimeSource(ROOT);
  assert.match(main, /path\.join\(cwd, '\.workbuddy', 'skills'\)/);
  assert.match(main, /path\.join\(cwd, '\.tangbao-skills'\)/);
  assert.match(main, /path\.join\(cwd, '\.claude', 'skills'\)/);
  assert.match(main, /path\.join\(cwd, '\.codex', 'skills'\)/);
  assert.match(main, /projectSkillTargetRoot = \(cwd\) => path\.join\(cwd, '\.workbuddy', 'skills'\)/);
  assert.match(runtime, /path\.join\(cwd, '\.workbuddy', 'skills'\)/);
});

test('用户级 Skill 纳入 ~/.workbuddy/skills 且项目操作绑定作用域与工作区', () => {
  const main = read('src/main/main.js');
  const ui = read('src/renderer/components/ui.js');
  assert.match(main, /path\.join\(os\.homedir\(\), '\.workbuddy', 'skills'\)/);
  assert.match(ui, /data-skill-scope=/);
  assert.match(ui, /scope: btn\.dataset\.skillScope/);
  assert.match(ui, /workspaceId: \(project && project\.workspaceId\) \|\| ''/);
  assert.match(ui, /scope: inp\.dataset\.skillScope/);
});

test('Skill 管理只允许已知根下的直接单个目录并重新枚举精确匹配', () => {
  const main = read('src/main/main.js');
  assert.match(main, /fs\.realpathSync\.native\(resolved\)/);
  // B5（P2）：Windows 盘符大小写归一后再比较（原 === 直比在 realpathSync.native 盘符大小写不一致时误判）
  assert.match(main, /norm\(path\.dirname\(resolvedTarget\)\) === norm\(resolvedRoot\)/);
  assert.match(main, /norm\(resolvedTarget\) !== norm\(resolvedRoot\)/);
  assert.match(main, /SkillRegistry\.enumerateInstalled\(managedSkillRoots\(workspaceId\)\)/);
  assert.match(main, /canonicalExistingPath\(item\.dir\) === requestedDir/);
  assert.match(main, /!requestedScope \|\| item\.scope === requestedScope/);
  assert.match(main, /isAllowedSkillDir\(match\.dir, workspaceId, match\.scope\)/);
});

test('详情、启停、编辑、定位和隔离卸载贯穿 renderer/preload/main', () => {
  const main = read('src/main/main.js');
  const preload = read('src/preload/preload.js');
  const service = read('src/application/services/skills.js');
  const ui = read('src/renderer/components/ui.js');

  for (const channel of ['skills:details', 'skills:edit', 'skills:reveal', 'skills:uninstall', 'skills:toggle']) {
    assert.match(main, new RegExp(channel.replace(':', '\\:')));
  }
  assert.match(preload, /skillsEdit: \(payload\) => ipcRenderer\.invoke\('skills:edit', payload\)/);
  assert.match(preload, /skillsReveal: \(payload\) => ipcRenderer\.invoke\('skills:reveal', payload\)/);
  assert.match(service, /edit\(payload\) \{ return this\.manage\('skillsEdit', payload\); \}/);
  assert.match(service, /reveal\(payload\) \{ return this\.manage\('skillsReveal', payload\); \}/);
  assert.match(ui, /data-skill-act="edit"/);
  assert.match(ui, /data-skill-act="reveal"/);
  assert.match(ui, /data-detail-act="toggle"/);
  assert.match(ui, /data-detail-act="edit"/);
  assert.match(ui, /data-detail-act="reveal"/);
  assert.match(ui, /data-detail-act="uninstall"/);
});

test('项目级 Skill 卸载跨盘回退：rename 失败时复制+删除（EXDEV 根因修复）', () => {
  const registry = read('src/core/skills/skill-registry.js');
  const main = read('src/main/main.js');
  const ui = read('src/renderer/components/ui.js');
  // registry：uninstall 必须捕获跨盘/占用错误并回退复制+删除
  const unIdx = registry.indexOf('async function uninstall');
  const unSeg = registry.slice(unIdx, unIdx + 900);
  assert.match(unSeg, /await fsp\.rename\(dir, dest\)/, 'uninstall 先尝试 rename');
  assert.match(unSeg, /\['EXDEV', 'EPERM', 'EBUSY', 'EACCES'\]\.includes\(err\.code\)/, '必须识别跨盘/占用错误码');
  assert.match(unSeg, /await fsp\.cp\(dir, dest, \{ recursive: true, force: true \}\)/, '跨盘回退必须复制');
  assert.match(unSeg, /await fsp\.rm\(dir, \{ recursive: true, force: true \}\)/, '跨盘回退必须删除原目录');
  // main：卸载错误落日志，便于排查
  assert.match(main, /console\.error\('\[skills:uninstall\]', e\)/, '主进程卸载异常应打日志');
  // ui：异常不得静默（此前无 catch 表现为"点卸载无反应"），卸载成功文案明确
  assert.match(ui, /\} catch \(e\) \{[\s\S]*?App\.ui\.toast\('操作失败：' \+ \(\(e && e\.message\) \|\| e\)\)/, 'skill 操作异常必须 toast 反馈');
  assert.match(ui, /act === 'uninstall' \? '已卸载 Skill（移入隔离区）'/, '卸载成功文案应明确为已卸载');
});

test('项目级 Skill 恢复跨盘回退：隔离区 → 项目盘 rename 失败时复制+删除（对称修复）', () => {
  const registry = read('src/core/skills/skill-registry.js');
  const main = read('src/main/main.js');
  const ui = read('src/renderer/components/ui.js');
  const rsIdx = registry.indexOf('async function restoreFromQuarantine');
  const rsSeg = registry.slice(rsIdx, rsIdx + 900);
  assert.match(rsSeg, /await fsp\.rename\(src, target\)/, 'restore 先尝试 rename');
  assert.match(rsSeg, /\['EXDEV', 'EPERM', 'EBUSY', 'EACCES'\]\.includes\(err\.code\)/, 'restore 必须识别跨盘/占用错误码');
  assert.match(rsSeg, /await fsp\.cp\(src, target, \{ recursive: true, force: true \}\)/, 'restore 跨盘回退必须复制');
  assert.match(rsSeg, /await fsp\.rm\(src, \{ recursive: true, force: true \}\)/, 'restore 跨盘回退必须删除隔离目录');
  assert.match(main, /console\.error\('\[skills:restore\]', e\)/, '主进程恢复异常应打日志');
  assert.match(ui, /\} catch \(e\) \{[\s\S]*?App\.ui\.toast\('恢复失败：' \+ \(\(e && e\.message\) \|\| e\)\)/, '隔离区恢复异常必须 toast 反馈');
});

test('同名Skill全部展示并由主进程按Runtime根顺序标记生效状态', () => {
  const main = read('src/main/main.js');
  const runtime = readRuntimeSource(ROOT);
  const ui = read('src/renderer/components/ui.js');
  assert.match(main, /SkillRegistry\.enumerateInstalled\(\[\{ scope: 'builtin', dir: builtinRoot \}\]\)/);
  assert.match(main, /SkillRegistry\.annotateDuplicateResolution\(all, orderedRoots\)/);
  assert.match(main, /duplicateCount: Number\(s\.duplicateCount\) \|\| 1/);
  assert.match(main, /resolution: String\(s\.resolution/);
  assert.match(main, /coveredBy: s\.coveredBy \|\| null/);
  assert.match(runtime, /entries\.sort\(\(a, b\) => a\.name\.localeCompare\(b\.name\)\)/);
  assert.match(ui, /当前生效/);
  assert.match(ui, /其他同名项生效/);
  assert.match(ui, /同名 ' \+ s\.duplicateCount \+ ' 项/);
  assert.match(ui, /Number\(s\.duplicateCount\) > 1/);
});

test('编辑和定位只能作用于解析后的 SKILL.md，卸载需确认并移入隔离区', () => {
  const main = read('src/main/main.js');
  assert.match(main, /const managed = await resolveManagedSkill\(payload\)/);
  assert.match(main, /path\.join\(managed\.skill\.dir, 'SKILL\.md'\)/);
  assert.match(main, /path\.join\(managed\.skill\.dir, 'SKILL\.md\.disabled'\)/);
  assert.match(main, /shell\.openPath\(target\)/);
  assert.match(main, /shell\.showItemInFolder\(target\)/);
  assert.match(main, /title: '卸载 Skill'/);
  assert.match(main, /SkillRegistry\.uninstall\(managed\.skill\.dir, quarantine\)/);
  assert.doesNotMatch(main, /shell\.trashItem\(managed\.skill\.dir\)/);
});
