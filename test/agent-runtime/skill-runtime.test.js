'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const server = require('../../src/infrastructure/agent-runtime/agent-server');
const Tx = require('../../src/core/agent-runtime/change-transaction');
const ContextManager = require('../../src/core/agent-runtime/context-manager');

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'tangbao-skill-runtime-')); }
function sha(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

test('扫描标准 Skill 保留完整正文与资源清单', async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'long-skill');
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  const body = '# 指引\n' + '完整正文。'.repeat(500);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: long-skill\ndescription: 完整正文测试\ntriggers: [完整测试]\n---\n' + body);
  fs.writeFileSync(path.join(dir, 'references', 'guide.md'), '# Reference');
  server.configureAgentServer({ userSkillsDirs: [root] });
  const skills = await server.scanSkills('');
  const installed = skills.find((item) => item.name === 'long-skill');
  assert.ok(installed);
  assert.equal(installed.body, body);
  assert.ok(installed.body.length > 1500);
  assert.deepEqual(installed.resources.map((item) => item.path), ['references/guide.md']);
});

test('禁用 Skill 不进入运行时扫描，但管理扫描可见', async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'disabled-skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md.disabled'), '---\nname: disabled-skill\ndescription: disabled\n---\n# Disabled');
  server.configureAgentServer({ userSkillsDirs: [root] });
  assert.equal((await server.scanSkills('')).some((item) => item.name === 'disabled-skill'), false);
  const managed = await server.scanSkills('', { includeDisabled: true });
  const disabled = managed.find((item) => item.name === 'disabled-skill');
  assert.ok(disabled);
  assert.equal(disabled.enabled, false);
});

test('二进制事务写入和回滚保持字节完全一致', (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = Buffer.from([0, 255, 1, 2, 128, 10]);
  const after = Buffer.from([9, 8, 0, 254, 7]);
  fs.writeFileSync(path.join(root, 'asset.bin'), before);
  const tx = Tx.plan(root, [{ type: 'write', path: 'asset.bin', content: after.toString('base64'), encoding: 'base64' }]);
  const committed = Tx.commit(tx);
  assert.equal(committed.ok, true);
  assert.deepEqual(fs.readFileSync(path.join(root, 'asset.bin')), after);
  const rolled = Tx.rollback(root, [{ operation: 'write', path: 'asset.bin', afterHash: sha(after), beforeExists: true, beforeContent: before.toString('base64') }]);
  assert.equal(rolled.ok, true);
  assert.deepEqual(fs.readFileSync(path.join(root, 'asset.bin')), before);
});

test('超长 Skill 指引进入统一窗口护栏并保留持久化任务状态', () => {
  const guide = '【技能：long-skill】\n' + '完整技能步骤。'.repeat(10000);
  const messages = [
    { role: 'system', content: 'Core instructions\n' + guide },
    { role: 'user', content: '请执行长任务' },
  ];
  const result = ContextManager.enforceWindow(messages, 2048, {
    outputReserve: 256,
    toolReserve: 256,
    safetyReserve: 128,
    workingState: {
      goal: '保留这个目标',
      plan: [{ content: '尚未完成步骤', status: 'in_progress' }],
      pendingWork: ['继续读取资源'],
      unresolvedErrors: [{ message: '待修复错误' }],
      filesChanged: [{ path: 'src/a.js', afterHash: 'abc' }],
    },
  });
  assert.equal(result.triggered, true);
  assert.ok(result.beforeTokens > result.afterTokens);
  const rebuilt = result.messages.map((message) => String(message.content || '')).join('\n');
  assert.ok(rebuilt.includes('上下文安全重建'));
  assert.ok(rebuilt.includes('保留这个目标'));
  assert.ok(rebuilt.includes('尚未完成步骤'));
  assert.ok(rebuilt.includes('待修复错误'));
});

test('生产运行时提供资源工具且 Skill 脚本默认显式审批', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/infrastructure/agent-runtime/agent-server.js'), 'utf8');
  for (const name of ['list_skill_resources', 'read_skill_resource', 'run_skill_script', 'copy_skill_asset']) assert.ok(source.includes("name: '" + name + "'"));
  assert.ok(source.includes("const bypass = opts.permCtx && opts.permCtx.mode === 'bypass'"));
  assert.ok(source.includes("waitApproval(emit, runId, display, { toolName: name, skillName: skill.name"));
  assert.ok(source.includes('SkillRunner.run({'));
  assert.ok(source.includes('skill_script_not_declared'));
  assert.ok(source.includes("addSection('toolGuidance'"));
  assert.ok(source.includes('ContextManager.enforceWindow'));
});

test('autoTrigger:false 的 Skill 不进入关键词自动注入，但仍可显式找到', async (t) => {
  const root = tempDir();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'manual-skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: manual-skill\ndescription: 手动触发\ntriggers: [手动触发词]\n---\n# Manual');
  server.configureAgentServer({ userSkillsDirs: [root] });
  const Registry = require('../../src/core/skills/skill-registry');
  const manifest = await Registry.writeManifest(dir, { autoTrigger: false });
  assert.equal(manifest.autoTrigger, false);
  const scanned = (await server.scanSkills('')).find((item) => item.name === 'manual-skill');
  assert.ok(scanned);
  assert.equal(scanned.autoTrigger, false);
  const guides = await server.loadSkillGuides('', '包含 手动触发词 的任务');
  assert.ok(!guides.some((guide) => guide.includes('manual-skill')));
  const found = await server.findEnabledSkill('', 'manual-skill');
  assert.ok(found.skill);
});

test('隔离执行器不会继承宿主任意环境变量并返回真实隔离等级', async () => {
  const Runner = require('../../src/infrastructure/agent-runtime/skill-runner');
  process.env.TANGBAO_TEST_SECRET = 'x';
  const env = Runner.minimalEnv();
  assert.equal(env.TANGBAO_TEST_SECRET, undefined);
  assert.equal(env.TANGBAO_SKILL_SANDBOX, '1');
  assert.equal(Runner.isolationLevel({}).network, 'not-enforced');
});
