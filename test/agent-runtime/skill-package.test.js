'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const SkillPackage = require('../../src/core/skills/skill-package');

const STANDARD = `---
name: demo-skill
description: Reads references and runs approved helper scripts when testing skill packages.
license: MIT
metadata:
  author: tangbao
triggers: [测试技能, demo skill]
---
# Demo

Follow the packaged instructions.
`;

async function tempDir() { return fsp.mkdtemp(path.join(os.tmpdir(), 'tb-skill-package-')); }

function pkg(files) {
  return SkillPackage.packageFromFiles(new Map(Object.entries(files).map(([key, value]) => [key, Buffer.from(value)])), { strict: true });
}

test('解析标准 frontmatter 并保留糖码 triggers 扩展', () => {
  const parsed = SkillPackage.parseSkill(STANDARD, 'demo-skill', { strict: true, directoryName: 'demo-skill' });
  assert.equal(parsed.name, 'demo-skill');
  assert.equal(parsed.description.includes('Reads references'), true);
  assert.deepEqual(parsed.triggers, ['测试技能', 'demo skill']);
  assert.equal(parsed.metadata.author, 'tangbao');
  assert.equal(parsed.body.includes('Follow the packaged instructions'), true);
});

test('严格导入拒绝非法名称字符并强制 description（支持中文名）', () => {
  assert.throws(() => SkillPackage.parseSkill('---\nname: bad/name\ndescription: x\n---\nbody', '', { strict: true }), /技能名须/);
  assert.throws(() => SkillPackage.parseSkill('---\nname: valid-name\n---\nbody', '', { strict: true }), /description/);
  const zh = SkillPackage.parseSkill('---\nname: 学霸笔记\ndescription: 生成笔记\n---\nbody', '', { strict: true });
  assert.equal(zh.name, '学霸笔记');
  const under = SkillPackage.parseSkill('---\nname: Bad_Name\ndescription: x\n---\nbody', '', { strict: true });
  assert.equal(under.name, 'Bad_Name');
});

test('历史模式兼容下划线、大小写和无 frontmatter', () => {
  const legacy = SkillPackage.parseSkill('# Legacy\nDo work.', 'Legacy_Skill', { strict: false });
  assert.equal(legacy.name, 'Legacy_Skill');
  assert.equal(legacy.body.includes('Do work'), true);
});

test('识别 ZIP 根目录和唯一顶层目录结构', () => {
  const root = pkg({ 'SKILL.md': STANDARD, 'references/guide.md': '# Guide', 'scripts/check.js': 'console.log("ok")' });
  assert.equal(root.skill.name, 'demo-skill');
  assert.equal(root.resources.length, 2);
  assert.equal(root.hasScripts, true);
  const nested = pkg({ 'demo-skill/SKILL.md': STANDARD, 'demo-skill/assets/template.txt': 'x' });
  assert.equal(nested.prefix, 'demo-skill/');
  assert.equal(nested.resources[0].kind, 'asset');
});

test('拒绝路径穿越、绝对路径、过深路径和混合根', () => {
  assert.throws(() => SkillPackage.normalizeArchivePath('../escape.txt'), /路径越界/);
  assert.throws(() => SkillPackage.normalizeArchivePath('C:/escape.txt'), /绝对路径/);
  assert.throws(() => SkillPackage.normalizeArchivePath('a/b/c/d.txt', { maxDepth: 3 }), /层级/);
  assert.throws(() => pkg({ 'demo-skill/SKILL.md': STANDARD, 'outside.txt': 'x' }), /必须包含 SKILL.md|技能目录之外/);
});

test('唯一顶层包装目录允许与 frontmatter name 不一致（GitHub -main 变体）', () => {
  const nested = pkg({ 'note-skill-main/SKILL.md': STANDARD, 'note-skill-main/references/guide.md': '# Guide' });
  assert.equal(nested.prefix, 'note-skill-main/');
  assert.equal(nested.skill.name, 'demo-skill'); // frontmatter name 权威
  assert.deepEqual(nested.resources.map((item) => item.path), ['references/guide.md']);
  // 混合根 / 越界等安全限制不受影响
  assert.throws(() => pkg({ 'note-skill-main/SKILL.md': STANDARD, 'outside.txt': 'x' }), /必须包含 SKILL.md|技能目录之外/);
});

test('原子安装完整包并列出、分段读取资源', async (t) => {
  const root = await tempDir();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = pkg({ 'SKILL.md': STANDARD, 'references/guide.md': 'abcdef', 'assets/pixel.bin': Buffer.from([0, 1, 2]) });
  source.files = new Map([['SKILL.md', Buffer.from(STANDARD)], ['references/guide.md', Buffer.from('abcdef')], ['assets/pixel.bin', Buffer.from([0, 1, 2])]]);
  source.sourceType = 'zip';
  const installed = await SkillPackage.installPackage(source, root);
  assert.equal(installed.name, 'demo-skill');
  const resources = await SkillPackage.listResources(installed.dir);
  assert.deepEqual(resources.map((item) => item.path), ['assets/pixel.bin', 'references/guide.md']);
  const read = await SkillPackage.readResource(installed.dir, 'references/guide.md', { offset: 2, maxChars: 256 });
  assert.equal(read.content, 'cdef');
  const binary = await SkillPackage.readResource(installed.dir, 'assets/pixel.bin');
  assert.equal(binary.binary, true);
  await assert.rejects(() => SkillPackage.readResource(installed.dir, '../escape.txt'), /路径非法/);
});

test('同名技能默认拒绝，replace 时完整替换', async (t) => {
  const root = await tempDir();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const first = pkg({ 'SKILL.md': STANDARD, 'references/old.md': 'old' });
  first.files = new Map([['SKILL.md', Buffer.from(STANDARD)], ['references/old.md', Buffer.from('old')]]);
  first.sourceType = 'zip';
  await SkillPackage.installPackage(first, root);
  await assert.rejects(() => SkillPackage.installPackage(first, root), (error) => error.code === 'skill_exists');
  const second = pkg({ 'SKILL.md': STANDARD, 'references/new.md': 'new' });
  second.files = new Map([['SKILL.md', Buffer.from(STANDARD)], ['references/new.md', Buffer.from('new')]]);
  second.sourceType = 'zip';
  await SkillPackage.installPackage(second, root, { replace: true });
  assert.equal(fs.existsSync(path.join(root, 'demo-skill', 'references', 'old.md')), false);
  assert.equal(fs.existsSync(path.join(root, 'demo-skill', 'references', 'new.md')), true);
});

test('替换提交失败时恢复旧技能且不残留 staging/backup', async (t) => {
  const root = await tempDir();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const first = pkg({ 'SKILL.md': STANDARD, 'references/old.md': 'old' });
  first.files = new Map([['SKILL.md', Buffer.from(STANDARD)], ['references/old.md', Buffer.from('old')]]);
  first.sourceType = 'zip';
  await SkillPackage.installPackage(first, root);
  const second = pkg({ 'SKILL.md': STANDARD, 'references/new.md': 'new' });
  second.files = new Map([['SKILL.md', Buffer.from(STANDARD)], ['references/new.md', Buffer.from('new')]]);
  second.sourceType = 'zip';
  const rename = async (from, to) => {
    if (path.basename(from).startsWith('.tb-skill-stage-') && to === path.join(root, 'demo-skill')) throw Object.assign(new Error('injected commit failure'), { code: 'injected' });
    return fsp.rename(from, to);
  };
  await assert.rejects(() => SkillPackage.installPackage(second, root, { replace: true, rename }), /injected commit failure/);
  assert.equal(fs.readFileSync(path.join(root, 'demo-skill', 'references', 'old.md'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(root, 'demo-skill', 'references', 'new.md')), false);
  assert.deepEqual((await fsp.readdir(root)).filter((name) => name.startsWith('.tb-skill-')), []);
});

test('旧技能恢复失败时保留唯一备份并返回位置', async (t) => {
  const root = await tempDir();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const first = pkg({ 'SKILL.md': STANDARD, 'references/old.md': 'old' });
  first.files = new Map([['SKILL.md', Buffer.from(STANDARD)], ['references/old.md', Buffer.from('old')]]);
  first.sourceType = 'zip';
  await SkillPackage.installPackage(first, root);
  const second = pkg({ 'SKILL.md': STANDARD, 'references/new.md': 'new' });
  second.files = new Map([['SKILL.md', Buffer.from(STANDARD)], ['references/new.md', Buffer.from('new')]]);
  second.sourceType = 'zip';
  const rename = async (from, to) => {
    const base = path.basename(from);
    if ((base.startsWith('.tb-skill-stage-') || base.startsWith('.tb-skill-backup-')) && to === path.join(root, 'demo-skill')) throw new Error('injected rename failure');
    return fsp.rename(from, to);
  };
  let failure;
  try { await SkillPackage.installPackage(second, root, { replace: true, rename }); }
  catch (error) { failure = error; }
  assert.equal(failure && failure.code, 'skill_restore_failed');
  assert.ok(failure && failure.backupPath);
  assert.equal(fs.readFileSync(path.join(failure.backupPath, 'references', 'old.md'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(root, 'demo-skill')), false);
  assert.deepEqual((await fsp.readdir(root)).filter((name) => name.startsWith('.tb-skill-stage-')), []);
});

test('仅 scripts 下受支持扩展可作为 Skill 脚本', () => {
  assert.equal(SkillPackage.isSupportedScript('scripts/check.js'), true);
  assert.equal(SkillPackage.isSupportedScript('scripts/check.exe'), false);
  assert.equal(SkillPackage.isSupportedScript('references/check.js'), false);
});
