'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('全局按钮具备无需等待业务完成的即时按下反馈', () => {
  const css = read('styles.css');
  assert.match(css, /button:not\(:disabled\):active\s*\{[^}]*opacity:\s*\.72/);
  assert.match(css, /button:not\(:disabled\):active\s*\{[^}]*transition-duration:\s*0s\s*!important/);
});

test('糖码运行历史弹窗使用单一可见滚动容器', () => {
  const css = read('styles.css');
  assert.match(css, /#agentHistMask \.modal-body\s*\{[^}]*overflow:\s*hidden/);
  assert.match(css, /#agentHistMask \.wf-run\s*\{[^}]*overflow-y:\s*scroll/);
  assert.match(css, /#agentHistMask \.wf-run\s*\{[^}]*min-height:\s*0/);
  assert.match(css, /#agentHistMask \.wf-run\s*\{[^}]*scrollbar-gutter:\s*stable/);
  assert.doesNotMatch(css, /\.agent-modal \.wf-run\s*\{[^}]*max-height:\s*62vh/);
});

test('设置弹窗加宽到 1000px，技能详情弹窗适度加宽到 860px', () => {
  const css = read('styles.css');
  assert.match(css, /#settingsModal \.modal\s*\{[^}]*width:\s*1000px/, '设置弹窗宽度应为 1000px');
  assert.match(css, /#settingsModal \.modal\s*\{[^}]*max-width:\s*95vw/, '设置弹窗保留 max-width:95vw 自适应');
  // 详情弹窗带 modal skill-detail-modal 两个 class，必须用 .modal.skill-detail-modal 提高特异性压过 .modal 的 480px
  assert.match(css, /\.modal\.skill-detail-modal\s*\{[^}]*width:\s*min\(860px, calc\(100vw - 32px\)\)/, '技能详情弹窗宽度应为 min(860px, calc(100vw - 32px)) 且选择器含 .modal 前缀');
  assert.doesNotMatch(css, /\.modal\.skill-detail-modal[^{]*min\(1000px/, '技能详情弹窗不得加宽到 1000px');
});

test('运行历史滚动容器约束高度：flex-basis:0 + height:0，子项不收缩（修复无滚动条回归）', () => {
  const css = read('styles.css');
  const wfRun = css.slice(css.indexOf('#agentHistMask .wf-run'), css.indexOf('#agentHistMask .wf-run') + 400);
  assert.match(wfRun, /flex:\s*1 1 0/, 'wf-run 必须用 flex-basis:0（避免按内容撑开）');
  assert.match(wfRun, /height:\s*0/, 'wf-run 必须显式 height:0（flex-grow 吃掉剩余空间）');
  assert.match(css, /#agentHistMask \.wf-run > \* \{\s*flex-shrink:\s*0/, '滚动容器子项必须禁止收缩');
  assert.match(css, /#agentHistMask \.modal-body\s*\{[^}]*min-height:\s*0/, 'modal-body 必须 min-height:0');
});

test('运行历史点击后先显示弹窗加载态，再异步查询第一页', () => {
  const agent = read('src/renderer/views/agent/agent.js');
  const createAt = agent.indexOf("const modal = document.createElement('div');", agent.indexOf('async showRunHistory()'));
  const appendAt = agent.indexOf('document.body.appendChild(modal);', createAt);
  const awaitAt = agent.indexOf('await loadPage();', createAt);
  assert.ok(createAt >= 0 && appendAt > createAt && awaitAt > appendAt, '弹窗应先插入 DOM，再等待历史 IPC');
  assert.match(agent, /正在加载运行历史/);
});

test('运行历史默认展开项立即加载事件，不必折叠后再展开', () => {
  const agent = read('src/renderer/views/agent/agent.js');
  assert.match(agent, /d\.addEventListener\('toggle', loadWhenOpen\);\s*loadWhenOpen\(\);/);
});

test('运行历史支持每页30条并明确加载更多或全部加载', () => {
  const agent = read('src/renderer/views/agent/agent.js');
  assert.match(agent, /const PAGE_SIZE = 30/);
  assert.match(agent, /listAgentRuns\(thread\.id, PAGE_SIZE, runs\.length\)/);
  assert.match(agent, /id="agentHistLoadMore">加载更多历史/);
  assert.match(agent, /已加载全部运行历史/);
  assert.match(agent, /已加载 ' \+ runs\.length \+ ' 条/);
});

test('运行历史长内容默认摘要并可展开全文且不创建嵌套滚动', () => {
  const agent = read('src/renderer/views/agent/agent.js');
  const css = read('styles.css');
  assert.match(agent, /const longText = \(value, limit, className\) =>/);
  assert.match(agent, /class="agent-hist-long/);
  assert.match(agent, /展开全文/);
  assert.match(agent, /class="agent-hist-full">\$\{esc\(text\)\}/);
  assert.doesNotMatch(agent, /pl\.text \|\| ''\)\.slice\(0, 400\)/);
  assert.doesNotMatch(agent, /JSON\.stringify\(pl\.args \|\| \{\}\)\.slice\(0, 300\)/);
  assert.doesNotMatch(agent, /txt\.slice\(0, 500\)/);
  assert.match(css, /\.agent-hist-long\[open\] \.agent-hist-full\s*\{\s*display:\s*block/);
  assert.doesNotMatch(css, /\.agent-hist-full\s*\{[^}]*overflow-y:\s*(auto|scroll)/);
});

test('运行历史思考展开后显示全部已保存文本且不受高度或内部滚动裁剪', () => {
  const agent = read('src/renderer/views/agent/agent.js');
  const css = read('styles.css');
  assert.match(agent, /longText\(pl\.text \|\| '', 400, 'thinking-text'\)/);
  assert.match(agent, /class="agent-hist-full">\$\{esc\(text\)\}/);
  assert.match(css, /\.agent-hist-long\.thinking-text\[open\] \{[^}]*display:\s*block[^}]*width:\s*100%/s);
  assert.match(css, /\.agent-hist-long\.thinking-text \.agent-hist-full \{[^}]*max-height:\s*none[^}]*overflow:\s*visible/s);
  assert.doesNotMatch(css, /\.agent-hist-long\.thinking-text \.agent-hist-full \{[^}]*overflow-y:\s*(auto|scroll)/s);
});

test('糖码会话卡片移除消息数并将空间留给会话名称', () => {
  const agent = read('src/renderer/views/agent/agent.js');
  const css = read('styles.css');
  const start = agent.indexOf('renderSessions()');
  const end = agent.indexOf('restoreThread()', start);
  const renderSessions = agent.slice(start, end);
  assert.doesNotMatch(renderSessions, /const n = \(t\.history \|\| \[\]\)\.length/);
  assert.doesNotMatch(renderSessions, /agent-session-count/);
  assert.doesNotMatch(css, /\.agent-session-count\s*\{/);
  assert.match(css, /\.agent-session-title \{[^}]*flex:\s*1 1 auto[^}]*min-width:\s*0/s);
});

test('运行历史顶部目标与统计分行完整显示', () => {
  const agent = read('src/renderer/views/agent/agent.js');
  const css = read('styles.css');
  assert.doesNotMatch(agent, /run\.userGoal \|\| ''\)\.slice\(0, 40\)/);
  assert.match(agent, /App\.escapeHtml\(run\.userGoal \|\| '（未记录任务目标）'\)/);
  assert.match(css, /\.wf-hist-item summary\s*\{[^}]*display:\s*grid/);
  assert.match(css, /grid-template-areas:\s*"chevron main" "\. meta"/);
  assert.match(agent, /class="wf-hist-main"><span class="wf-hist-badge"/);
  assert.match(css, /\.wf-hist-main\s*\{[^}]*grid-area:\s*main[^}]*display:\s*flex/);
  assert.match(css, /\.wf-hist-goal\s*\{[^}]*white-space:\s*normal/);
  assert.match(css, /\.wf-hist-meta\s*\{[^}]*white-space:\s*normal/);
  assert.doesNotMatch(css, /\.wf-hist-goal\s*\{[^}]*text-overflow:\s*ellipsis/);
});

test('Agent Run 分页 offset 贯穿 renderer、preload、main 与 SQLite', () => {
  const service = read('src/application/services/fs.js');
  const preload = read('src/preload/preload.js');
  const main = read('src/main/main.js');
  const store = read('src/infrastructure/storage/sqlite-store.js');
  assert.match(service, /listAgentRuns\(threadId, limit, offset\)/);
  assert.match(preload, /listAgentRuns: \(threadId, limit, offset\).*threadId, limit, offset/);
  assert.match(main, /agent:listRuns'[\s\S]*threadId, limit, offset[\s\S]*listAgentRuns\(threadId, limit, offset\)/);
  assert.match(store, /ORDER BY started_at DESC LIMIT \? OFFSET \?/);
  assert.match(store, /function listAgentRuns\(threadId, limit, offset\)/);
  assert.match(store, /stmt\.listRuns\.all\(String\(threadId \|\| ''\), pageSize, pageOffset\)/);
});
