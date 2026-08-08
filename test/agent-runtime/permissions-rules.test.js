'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AS = require('../../src/infrastructure/agent-runtime/agent-server');
const { matchRule, needsApproval, sandboxBlocked, approvalMsg } = AS;

test('G17-B2：matchRule 支持时间衰减（expiresAt 过期即不匹配）', () => {
  const rule = { tool: 'run_command', pattern: 'rm -rf', allow: false, expiresAt: Date.now() - 1000 };
  assert.equal(matchRule(rule, 'run_command', 'rm -rf x', null, null), false, '过期规则不应命中');
  const future = { ...rule, expiresAt: Date.now() + 60000 };
  assert.equal(matchRule(future, 'run_command', 'rm -rf x', null, null), true, '未过期规则应命中');
  const noExpiry = { tool: 'run_command', pattern: 'rm -rf', allow: false };
  assert.equal(matchRule(noExpiry, 'run_command', 'rm -rf x', null, null), true, '无 expiresAt 规则行为不变');
});

test('G17-B2：matchRule 支持 count<=0 视为失效', () => {
  const rule = { tool: 'run_command', pattern: 'npm test', allow: false, count: 0 };
  assert.equal(matchRule(rule, 'run_command', 'npm test', null, null), false);
  const active = { ...rule, count: 3 };
  assert.equal(matchRule(active, 'run_command', 'npm test', null, null), true);
});

test('G17-B2：matchRule 支持 model 级规则（scope=model 仅匹配指定模型）', () => {
  const rule = { tool: 'run_command', pattern: 'danger', allow: false, scope: 'model', model: 'gpt-4o' };
  assert.equal(matchRule(rule, 'run_command', 'danger cmd', null, 'gpt-4o'), true, '同模型应命中');
  assert.equal(matchRule(rule, 'run_command', 'danger cmd', null, 'claude-3-5'), false, '异模型不应命中');
  assert.equal(matchRule(rule, 'run_command', 'danger cmd', null, null), false, '无模型上下文不应命中');
  const generic = { tool: 'run_command', pattern: 'danger', allow: false };
  assert.equal(matchRule(generic, 'run_command', 'danger cmd', null, 'claude-3-5'), true, '非 model 级规则不受模型影响');
});

test('G17-B2：matchRule 向后兼容（tool/pattern/path 命中规则不变）', () => {
  assert.equal(matchRule({ tool: 'write_file', path: 'src/a.js' }, 'write_file', '', 'src/a.js', null), true);
  assert.equal(matchRule({ tool: 'write_file', path: 'src/a.js' }, 'write_file', '', 'src/b.js', null), false);
  assert.equal(matchRule({ tool: '*', pattern: 'git status' }, 'run_command', 'git status', null, null), true);
});

test('G17-B2：needsApproval 第 4 步——model 级 reject 规则仅同模型生效', () => {
  const permCtx = { mode: 'auto', projectRules: [{ tool: 'run_command', pattern: 'danger', allow: false, scope: 'model', model: 'gpt-4o' }], globalRules: [], model: 'claude-3-5' };
  assert.equal(needsApproval('run_command', 'danger cmd', true, [], [], null, permCtx), false, '异模型规则不应触发审批');
  const permCtx2 = { ...permCtx, model: 'gpt-4o' };
  assert.equal(needsApproval('run_command', 'danger cmd', true, [], [], null, permCtx2), true, '同模型规则应触发审批');
});

test('G17-B2：needsApproval——过期 reject 规则被跳过', () => {
  const permCtx = { mode: 'auto', projectRules: [{ tool: 'run_command', pattern: 'danger', allow: false, expiresAt: Date.now() - 1000 }], globalRules: [], model: 'm' };
  assert.equal(needsApproval('run_command', 'danger cmd', true, [], [], null, permCtx), false, '过期规则不应触发审批');
});

test('G17-B2：needsApproval——allow 规则命中（含 model 级）则免审', () => {
  const permCtx = { mode: 'default', projectRules: [{ tool: 'run_command', pattern: 'npm test', allow: true, scope: 'model', model: 'gpt-4o' }], globalRules: [], model: 'gpt-4o' };
  assert.equal(needsApproval('run_command', 'npm test', false, [], [], null, permCtx), false, 'model 级 allow 规则同模型应免审');
  const permCtx2 = { ...permCtx, model: 'claude-3-5' };
  assert.equal(needsApproval('run_command', 'npm test', false, [], [], null, permCtx2), true, '异模型不命中 allow 规则则需审批');
});

test('G17-B3：sandbox 例外规则放行网络命令（沙箱白名单）', () => {
  const permCtx = { mode: 'sandbox', projectRules: [{ tool: 'run_command', pattern: 'curl', allow: true, sandbox: true, scope: 'project' }], globalRules: [], model: 'm' };
  assert.equal(sandboxBlocked('curl -s https://example.com', permCtx), null, '命中沙箱例外应放行');
  assert.ok(sandboxBlocked('curl -s https://example.com', null), '无例外规则时网络命令仍被拦截');
  const noMatch = { ...permCtx, projectRules: [{ tool: 'run_command', pattern: 'npm install', allow: true, sandbox: true, scope: 'project' }] };
  assert.ok(sandboxBlocked('curl -s https://example.com', noMatch), '未命中例外仍拦截');
});

test('G17-B3：sandbox 越界路径命令仍拦截（不受 allow 规则影响）', () => {
  const permCtx = { mode: 'sandbox', projectRules: [{ tool: 'run_command', pattern: '*', allow: true, sandbox: true, scope: 'project' }], globalRules: [], model: 'm' };
  assert.ok(sandboxBlocked('cd ../..', permCtx), '越界路径命令即使通配例外也拦截');
});

test('G17-B4：拒绝文案按操作类别给出替代建议', () => {
  const git = approvalMsg(false, 'git_command', 'git push origin main');
  assert.match(git, /只读 git 操作/, 'git 拒绝应建议只读操作');
  const cmd = approvalMsg(false, '该命令', 'npm install');
  assert.match(cmd, /只读命令/, '普通命令拒绝应建议只读命令');
  const file = approvalMsg(false, '写文件', 'src/a.js');
  assert.match(file, /读取目标文件/, '写文件拒绝应建议先读再改');
  assert.equal(approvalMsg(true, '该命令', ''), null, '批准返回 null');
  assert.match(approvalMsg('timeout', '该命令', ''), /超时/, '超时文案保留');
});
