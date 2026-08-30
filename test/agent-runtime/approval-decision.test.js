'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// v1.2.0 批次 7 第六刀：审批决策链自引擎抽为纯模块后的直接行为断言
const { createApprovalDecision } = require('../../src/infrastructure/agent-runtime/approval-decision.js');

const AD = createApprovalDecision();
const { needsApproval, sandboxBlocked, classifyRisk, matchRule, globMatch, TOOL_RISK } = AD;

test('批次7第六刀：风险分类与规则匹配基础行为不变', () => {
  assert.equal(classifyRisk('run_command', 'rm -rf build'), 'destructive');
  assert.equal(classifyRisk('run_command', 'npm install left-pad'), 'network_access');
  assert.equal(classifyRisk('write_file', ''), 'workspace_write');
  assert.equal(classifyRisk('read_file', ''), 'read_only');
  assert.equal(globMatch('src/a/b.js', 'src/**/*.js'), true);
  assert.equal(matchRule({ tool: '*', pattern: 'git status' }, 'run_command', 'git status', null, null), true);
});

test('needsApproval 第 1 步：bypass 全放行（含破坏性命令）', () => {
  assert.equal(needsApproval('run_command', 'rm -rf /', false, [], [], null, { mode: 'bypass' }), false);
});

test('needsApproval 第 2 步：plan 只读模式拒绝写类/命令类/子代理/搜索，放行只读', () => {
  const plan = { mode: 'plan' };
  assert.equal(needsApproval('write_file', null, true, [], [], 'a.txt', plan), true);
  assert.equal(needsApproval('run_command', 'ls', true, [], [], null, plan), true);
  assert.equal(needsApproval('run_subagent', null, true, [], [], null, plan), true);
  assert.equal(needsApproval('web_search', null, true, [], [], null, plan), true);
  assert.equal(needsApproval('read_file', null, true, [], [], null, plan), false);
});

test('needsApproval 第 3 步：runAuth 会话级授权优先；未迁移时读注入的兜底授权态', () => {
  // run 级授权放行 default 模式下本应审批的命令
  assert.equal(needsApproval('run_command', 'npm run build', false, [], [], null,
    { mode: 'default', runAuth: { approvedRun: true, approvedFiles: new Set() } }), false);
  // 未迁移路径：兜底访问器返回已授权 → 放行（缺省工厂返回 false → 仍需审批）
  const Approved = createApprovalDecision({ getFallbackRunApproved: () => true });
  assert.equal(Approved.needsApproval('run_command', 'npm run build', false, [], [], null, { mode: 'default' }), false);
  assert.equal(needsApproval('run_command', 'npm run build', false, [], [], null, { mode: 'default' }), true);
  // allow_file：目标文件在兜底集合内 → 写免审批
  const FileOK = createApprovalDecision({ getFallbackApprovedFiles: () => new Set(['a.txt']) });
  assert.equal(FileOK.needsApproval('write_file', null, false, [], [], 'a.txt', { mode: 'default' }), false);
  assert.equal(needsApproval('write_file', null, false, [], [], 'a.txt', { mode: 'default' }), true);
});

test('needsApproval 第 4/5 步：reject 规则强制审批；destructive 可被 force:true 放行', () => {
  const reject = { mode: 'auto', projectRules: [{ tool: 'run_command', pattern: 'danger*', allow: false }] };
  assert.equal(needsApproval('run_command', 'danger cmd x', true, [], [], null, reject), true);
  const forced = { mode: 'default', projectRules: [{ tool: 'run_command', pattern: 'deploy *', allow: true, force: true }] };
  assert.equal(needsApproval('run_command', 'deploy prod', false, [], [], null, forced), false);
  assert.equal(needsApproval('run_command', 'rm -rf x', false, [], [], null, { mode: 'default' }), true);
});

test('needsApproval 第 6-8 步：allow 规则 > 旧白名单 > 只读自动放行', () => {
  // 无 force 的 allow 规则不能越过第 5 步风险强制（network_access 仍需审批）
  const allowNet = { mode: 'default', projectRules: [{ tool: 'run_command', pattern: 'npm install', allow: true }] };
  assert.equal(needsApproval('run_command', 'npm install left-pad', false, [], [], null, allowNet), true);
  // 旧 cmdWhitelist 前缀匹配（无 permCtx 时 mode 回退 default，普通命令仍要审批）
  assert.equal(needsApproval('run_command', 'git status --short', false, [], ['git status'], null, null), false);
  assert.equal(needsApproval('run_command', 'make all', false, [], ['git status'], null, null), true);
  // 只读 git 结构化工具任何非 plan 模式免审批
  assert.equal(needsApproval('git_status', null, false, [], [], null, null), false);
  // SAFE_CMD 在 default 模式免审批
  assert.equal(needsApproval('run_command', 'ls -la', false, [], [], null, { mode: 'default' }), false);
});

test('needsApproval 第 9-11 步：acceptEdits 自动编辑/auto 放行/approveTools 强制审批', () => {
  assert.equal(needsApproval('edit_file', null, false, [], [], 'a.js', { mode: 'acceptEdits' }), false);
  assert.equal(needsApproval('run_command', './build.sh', false, [], [], null, { mode: 'acceptEdits' }), true);
  assert.equal(needsApproval('run_command', './build.sh', true, [], [], null, { mode: 'auto' }), false);
  assert.equal(needsApproval('use_skill', null, false, [], [], null, { mode: 'auto' }), false); // 只读工具兜底放行
  assert.equal(needsApproval('use_skill', null, false, ['use_skill'], [], null, { mode: 'auto' }), true); // 第 10 步强制审批
});

test('sandboxBlocked：越界路径硬边界 + 网络命令可被沙箱例外放行', () => {
  assert.equal(sandboxBlocked('cat ../secrets.txt'), '越界路径命令');
  assert.equal(sandboxBlocked('C:\\Windows\\system32\\whoami'), '越界路径命令');
  assert.equal(sandboxBlocked('curl -L https://example.com'), '网络命令'); // classifyRisk 网络正则要求 curl 带参数
  assert.equal(sandboxBlocked('echo https://example.com'), null); // URL 不误判盘符/网络
  assert.equal(sandboxBlocked('ls -la'), null);
  // 越界路径不可被任何例外放行；网络命令可被 allow+sandbox 精确命中放行
  const escapeRule = { projectRules: [{ tool: 'run_command', pattern: 'cat ../*', allow: true, sandbox: true }], model: null };
  assert.equal(sandboxBlocked('cat ../secrets.txt', escapeRule), '越界路径命令');
  const netRule = { projectRules: [{ tool: 'run_command', pattern: 'npm install', allow: true, sandbox: true }], model: null };
  assert.equal(sandboxBlocked('npm install left-pad', netRule), null);
});

test('第六刀导出面：工厂产物包含全部迁移符号且 TOOL_RISK 枚举不变', () => {
  for (const k of ['TOOL_RISK', 'classifyRisk', 'SAFE_CMD', 'READONLY_GIT_TOOLS', 'matchRule', 'globMatch', 'sandboxBlocked', 'needsApproval']) {
    assert.ok(AD[k], 'missing export ' + k);
  }
  assert.deepEqual(Object.keys(TOOL_RISK), ['read_only', 'workspace_write', 'process_execution', 'network_access', 'destructive', 'git']);
});

test('批次6：MCP 默认需审批（default/acceptEdits/sandbox），auto 自主放行', () => {
  const base = { approvedRun: false, approvedFiles: new Set() };
  assert.equal(needsApproval('mcp', 'filesystem/read_file', false, [], [], null, { mode: 'default', runAuth: base }), true, 'default 模式 MCP 默认需审批');
  assert.equal(needsApproval('mcp', 'filesystem/read_file', false, [], [], null, { mode: 'acceptEdits', runAuth: base }), true, 'acceptEdits 模式 MCP 默认需审批');
  assert.equal(needsApproval('mcp', 'filesystem/read_file', false, [], [], null, { mode: 'sandbox', runAuth: base }), true, 'sandbox 模式 MCP 默认需审批');
  assert.equal(needsApproval('mcp', 'filesystem/read_file', true, [], [], null, { mode: 'auto', runAuth: base }), false, 'auto 模式 MCP 免审批（全自主语义）');
});

test('批次6：MCP 会话级工具授权（本会话不再询问）——approvedTools 命中即放行', () => {
  const perm = { mode: 'default', runAuth: { approvedRun: false, approvedFiles: new Set(), approvedTools: new Set(['mcp|filesystem/read_file']) } };
  assert.equal(needsApproval('mcp', 'filesystem/read_file', false, [], [], null, perm), false, '命中已授权 MCP 工具应放行');
  assert.equal(needsApproval('mcp', 'filesystem/other_tool', false, [], [], null, perm), true, '未授权 MCP 工具仍应审批');
  assert.equal(needsApproval('mcp', 'filesystem/read_file', false, [], [], null, { mode: 'default', runAuth: { approvedRun: false, approvedFiles: new Set() } }), true, '无 approvedTools 时仍应审批');
});

test('批次6：全局 allow 规则放行 MCP（永久允许此工具 → 规则引擎放行）', () => {
  const perm = {
    mode: 'default',
    runAuth: { approvedRun: false, approvedFiles: new Set() },
    projectRules: [],
    globalRules: [{ tool: 'mcp', pattern: 'filesystem/read_file', allow: true, scope: 'global' }],
  };
  assert.equal(needsApproval('mcp', 'filesystem/read_file', false, [], [], null, perm), false, '全局 allow 规则命中应放行');
  assert.equal(needsApproval('mcp', 'filesystem/other', false, [], [], null, perm), true, '未命中规则的 MCP 工具仍审批');
});
