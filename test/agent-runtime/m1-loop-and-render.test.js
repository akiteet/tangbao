'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readRuntimeSource } = require('./source-helper');

const ROOT = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const agentServer = readRuntimeSource(ROOT);
const styles = read('styles.css');
const agentJs = read('src/renderer/views/agent/agent.js');

test('M1：Plan 模式写工具拦截必须返回结构化失败（避免完成门误判成功死循环）', () => {
  // v1.1.0（优化 Plan 模式）：planBlocked 提取为模块级 PLAN_BLOCKED_TOOLS，runTool 内改为引用
  const blockIdx = agentServer.indexOf('const planBlocked = PLAN_BLOCKED_TOOLS;');
  const seg = agentServer.slice(blockIdx, blockIdx + 600);
  assert.match(seg, /opts\.planMode && !\(opts\.permCtx && opts\.permCtx\.planApproved\) && planBlocked\.includes\(name\)/, 'Plan 拦截分支必须存在（批准计划后放行）');
  assert.match(seg, /ok:\s*false/, 'Plan 拦截必须返回 ok:false');
  assert.match(seg, /code:\s*'plan_restricted'/, 'Plan 拦截必须带 code=plan_restricted 供完成门与重复失败计数识别');
  assert.doesNotMatch(seg, /return 'Plan 模式：当前为只读模式/, '不应再返回纯字符串（此前会让 normalizeResult 误判为成功）');
});

test('M1：完成门无进展熔断——连续 3 次相同缺口且无文件变更时停止自动修复', () => {
  assert.match(agentServer, /gateStallCount = 0;[\s\S]*lastGateSig = '';[\s\S]*gateChangesFp = ''/, '应在循环顶部声明无进展熔断变量');
  assert.match(agentServer, /sig === lastGateSig && changesFp === gateChangesFp/, '应按缺口签名 + 文件变更指纹识别无进展');
  assert.match(agentServer, /if \(gateStallCount >= 3\)/, '第三次相同缺口且无文件变更时触发熔断');
  assert.match(agentServer, /waitCardApproval\(emit, runId, 'plan_exit_request', exitCallId, '退出计划模式并继续修复'/, 'Plan 模式熔断时应请求用户确认退出 Plan（waitCardApproval 统一 emit plan_exit_request）');
  assert.match(agentServer, /const ok = await waitCardApproval\(emit, runId, 'plan_exit_request'/, 'Plan 退出走既有 approvals / /api/agent/approve 通道，无须新增接口');
  assert.match(agentServer, /runPlanMode = false;[\s\S]*permCtx\.mode = 'auto'/, '用户确认后必须关闭 Plan 模式并切换到可执行权限');
  assert.match(agentServer, /saveCheckpoint\('gate-stall'\)/, '非 Plan 模式熔断必须落 checkpoint 等待人工');
  assert.match(agentServer, /saveCheckpoint\('gate-stall-plan'\)/, 'Plan 模式熔断（用户拒绝退出）必须落 checkpoint 等待人工');
});

test('M1：runPlanMode 可变并贯穿 runTool 调用（不沿用初始 const）', () => {
  assert.match(agentServer, /let runPlanMode = planMode;/, '应在 planMode 常量后声明可变副本');
  assert.match(agentServer, /planMode:\s*runPlanMode/, 'runTool 调用必须传 runPlanMode 而非原常量');
  assert.match(agentServer, /planMode:\s*runPlanMode[\s\S]{0,80}permissionMode/, 'meta 事件同步使用 runPlanMode');
});

test('M4：callLLMStream 具备连接超时与流式空闲超时', () => {
  assert.match(agentServer, /function callLLMStream/, 'callLLMStream 必须存在');
  // 连接超时（30s）：用 controller + setTimeout abort
  assert.match(agentServer, /streamController|controller\.signal/, 'fetch 必须接受 abort signal');
  assert.match(agentServer, /连接超时（30 秒内未建立响应）|LLM 连接超时/, '必须含连接超时文案');
  assert.match(agentServer, /流式空闲超过 120 秒|空闲超时/, '必须含流式空闲超时文案');
  // openai 分支与非 openai 分支都要覆盖：grep 出现 resetIdle 至少两次
  const idleCount = (agentServer.match(/resetIdle\(\)/g) || []).length;
  assert.ok(idleCount >= 4, 'OpenAI / 非 OpenAI 两个分支都必须在 reader.read 后重置空闲计时器');
});

test('M2：恢复会话时思考节点使用 agent-think class，且 CSS 提供 agent-thinking alias 防止历史渲染为大字', () => {
  // agent.js 用对象方法简写 `restoreThread() {`，不是 `function restoreThread`
  const restoreIdx = agentJs.indexOf('restoreThread() {');
  assert.ok(restoreIdx >= 0, '应能找到 restoreThread 方法定义');
  const seg = agentJs.slice(restoreIdx, restoreIdx + 4000);
  // 历史回放里的 thinking 节点必须使用与 appendThinking 一致的 class
  const restoreThinkingIdx = seg.indexOf("ev.type === 'thinking'");
  const restoreSeg = seg.slice(restoreThinkingIdx, restoreThinkingIdx + 600);
  assert.match(restoreSeg, /className\s*=\s*'agent-think'/, 'restoreThread 的 thinking 节点必须使用 agent-think（小字样式）');
  assert.doesNotMatch(restoreSeg, /className\s*=\s*'agent-thinking'/, 'restoreThread 不应再用未定义样式的 agent-thinking');
  // 兜底：styles.css 同时为 agent-thinking 留 alias 规则，避免旧 DOM / 测试残留类目落到默认 body 字体
  assert.match(styles, /\.agent-thinking\s*\{[^}]*font-size:\s*12\.5px/s, 'styles.css 必须给 agent-thinking 提供与 agent-think 一致的 12.5px 样式');
});
