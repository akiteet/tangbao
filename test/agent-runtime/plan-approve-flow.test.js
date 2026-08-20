'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readRuntimeSource } = require('./source-helper');

const ROOT = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const agentServer = readRuntimeSource(ROOT);
const agentJs = read('src/renderer/views/agent/agent.js');
const styles = read('styles.css');

test('Plan 模式：首次写工具时发出 plan_approval_request 并等待用户批准', () => {
  assert.match(agentServer, /const approveCallId = 'plan_approve_' \+ runId \+ '_' \+ step;/, '批准请求 callId 必须按 run+step 生成');
  assert.match(agentServer, /waitCardApproval\(emit, runId, 'plan_approval_request', approveCallId, '批准计划并开始执行'/, '必须用 waitCardApproval（自定义 callId 作 approvals key）');
  assert.match(agentServer, /PLAN_BLOCKED_TOOLS\.includes\(tc\.name\)/, '仅对写/命令类工具触发');
  assert.match(agentServer, /!planApprovalPending/, '防重入：同一时刻只挂一张待批准卡');
});

test('waitCardApproval 用调用方 callId 作为 approvals key（批准不会 404）', () => {
  const idx = agentServer.indexOf('function waitCardApproval');
  const seg = agentServer.slice(idx, idx + 1200);
  assert.match(seg, /approvals\.set\(callId,/, '卡片审批必须以调用方 callId 为 key 注册到 approvals 表');
  assert.match(seg, /emit\(eventType, Object\.assign\(\{ runId, callId, command \}, payload \|\| \{\}\)\)/, '只 emit 自定义事件类型，不触发 require_approval 全局审批框');
  assert.doesNotMatch(seg, /emit\('require_approval'/, 'waitCardApproval 内不得再 emit require_approval（避免双弹窗）');
  // plan_exit 卡同样走 waitCardApproval，且事件带 callId 供前端按钮命中
  assert.match(agentServer, /waitCardApproval\(emit, runId, 'plan_exit_request', exitCallId, '退出计划模式并继续修复'/, '完成门退出卡必须用 waitCardApproval 并传自定义 callId');
});

test('Plan 模式：批准后切 auto 并放行当前工具，拒绝返回 plan_rejected 且不终止', () => {
  const approveIdx = agentServer.indexOf("waitCardApproval(emit, runId, 'plan_approval_request'");
  const seg = agentServer.slice(approveIdx, approveIdx + 1800);
  assert.match(seg, /runPlanMode = false;[\s\S]*permCtx\.mode = 'auto';[\s\S]*permCtx\.planApproved = true/, '批准后必须切换执行模式并置 planApproved');
  assert.match(seg, /modeChanged: 'plan_approve'/, '批准后必须发 meta.modeChanged 供前端同步徽章');
  assert.match(seg, /code: 'plan_rejected'/, '拒绝必须返回 plan_rejected 结构化失败');
  assert.match(seg, /countableExecutionFailure = false;/, '拒绝/超时不视为真实工具失败，避免连续失败误中止');
  assert.match(seg, /continue;/, '拒绝后继续循环（模型可调整任务清单）而非终止 run');
});

test('runTool 内 Plan 拦截保留为批准后兜底', () => {
  assert.match(agentServer, /if \(opts\.planMode && !\(opts\.permCtx && opts\.permCtx\.planApproved\) && planBlocked\.includes\(name\)\)/, 'runTool 拦截条件必须排除已批准计划（permCtx.planApproved）');
  assert.match(agentServer, /PLAN_BLOCKED_TOOLS = \[/, 'planBlocked 列表应提取为模块级常量供主循环与 runTool 共用');
});

test('request_user_decision 支持 multiSelect、阻塞等待答复并回传', () => {
  assert.match(agentServer, /multiSelect = args\.multiSelect === true;/, '必须解析 multiSelect 参数');
  assert.match(agentServer, /const multiSelect = args\.multiSelect === true;[\s\S]*multiSelect, context, status: 'pending'/, 'pendingDecisions 记录 multiSelect');
  assert.match(agentServer, /emit\('user_decision_requested', \{ id, question, options, multiSelect, context, at: Date\.now\(\) \}\)/, '提问事件必须携带 multiSelect');
  assert.match(agentServer, /const answer = await waitDecision\(id, opts\.setPhase, opts\.phase\);/, '必须阻塞等待用户答复');
  assert.match(agentServer, /code: 'decision_timeout'/, '超时必须有兜底返回');
  assert.match(agentServer, /summary: '用户答复：'/, '答复必须以工具结果回传模型');
  assert.match(agentServer, /\/api\/agent\/decision/, '必须有答复回传端点');
});

test('前端消费 plan_approval_request / plan_exit_request / user_decision_requested', () => {
  assert.match(agentJs, /ev\.type === 'plan_approval_request'[\s\S]*App\.agent\.showPlanApproval\(ev\)/, '前端必须消费 plan_approval_request');
  assert.match(agentJs, /ev\.type === 'plan_exit_request'[\s\S]*App\.agent\.showPlanExit\(ev\)/, '前端必须消费 plan_exit_request');
  assert.match(agentJs, /ev\.type === 'user_decision_requested'[\s\S]*App\.agent\.showDecisionCard\(ev\)/, '前端必须消费 user_decision_requested');
  assert.match(agentJs, /批准请求/, '计划批准卡必须有「批准请求」按钮');
  assert.match(agentJs, /调整计划/, '计划批准卡必须有「调整计划」按钮');
  assert.match(agentJs, /退出计划模式并继续修复/, '完成门拦截卡必须有退出按钮');
  assert.match(agentJs, /提交答复/, '提问卡必须有提交按钮');
  assert.match(agentJs, /data-custom="1"/, '提问卡必须提供自定义填空');
});

test('提问卡单选/多选随机应变 + 自定义答案优先', () => {
  assert.match(agentJs, /multiSelect \? 'checkbox' : 'radio'/, '选项控件随 multiSelect 切换');
  assert.match(agentJs, /custom \|\| \(sel\.length \? sel\[0\] : ''\)/, '单选时自定义输入优先于选项');
  assert.match(agentJs, /custom \? sel\.concat\(custom\) : sel/, '多选时自定义输入追加到选择');
  assert.match(agentJs, /\/api\/agent\/decision/, '前端提交走 /api/agent/decision');
});

test('meta.modeChanged 同步徽章，运行结束还原项目默认', () => {
  assert.match(agentJs, /modeChanged === 'plan_approve' \|\| meta\.modeChanged === 'plan_exit'/, 'showMeta 必须识别批准/退出标记');
  assert.match(agentJs, /setPlanBadge\('已批准 · 执行中'\)/, '批准后徽章文案切换');
  assert.match(agentJs, /if \(App\.agent\._planApproved\) App\.agent\.resetPlanBadge\(\)/, '运行结束后还原徽章');
  assert.match(styles, /\.agent-plan-approve, \.agent-decision \{/, '卡片样式必须存在');
  assert.match(styles, /\.agent-decision-custom input \{/, '自定义填空样式必须存在');
});

test('PERM_RUNTIME_HINT.plan 引导模型主动提问与产出计划', () => {
  assert.match(agentServer, /plan: '\[当前处于 Plan 模式：先只读探索代码并产出任务清单（todo_write）。遇到不确定的需求、方案取舍或修改范围时，必须用 request_user_decision 向用户提问/, 'Plan 运行时提示必须要求不确定时提问');
  assert.match(agentServer, /multiSelect=true 表示可多选，用户也能自定义填写/, '提示须说明可多选与自定义');
});

test('M6：运行出错状态卡左上角图标不再用 ✕（避免与右侧关闭按钮混淆）', () => {
  const idx = agentJs.indexOf("mode === 'error'");
  const seg = agentJs.slice(idx, idx + 400);
  assert.match(seg, /agent-status-ico">⚠</, 'error 卡左上角图标必须是 ⚠');
  assert.doesNotMatch(seg, /agent-status-ico">✕</, 'error 卡左上角不得再用 ✕');
  assert.match(styles, /\.agent-status-row\.is-error \.agent-status-ico \{[^}]*color:\s*var\(--danger\)/, 'error 图标应有红色强调（v1.1.6 统一收尾：令牌化）');
});

test('M7：「发送前还差」就地提示条已删除，校验改为轻量 toast', () => {
  assert.doesNotMatch(agentJs, /agentComposerCheck/, 'agent.js 不得再引用 agentComposerCheck 容器');
  assert.doesNotMatch(agentJs, /showComposerCheck|hideComposerCheck/, 'agent.js 不得再存在就地校验函数');
  assert.doesNotMatch(agentJs, /agent-composer-check/, 'agent.js 不得再含就地校验模板/样式引用');
  assert.doesNotMatch(styles, /\.agent-composer-check/, 'styles.css 不得再含就地校验样式');
  // 发送前置校验仍保留，只是改为 toast
  assert.match(agentJs, /App\.ui\.toast\('尚未配置糖码 API 与账户模型/, '缺模型拦截改为 toast');
  assert.match(agentJs, /App\.ui\.toast\('当前模型不支持工具调用/, '不支持工具拦截改为 toast');
  assert.match(agentJs, /App\.ui\.toast\('尚未选择项目工作目录/, '未选项目拦截改为 toast');
});
