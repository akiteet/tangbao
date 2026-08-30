'use strict';
// v1.2.1 批次 13「糖码执行效率专项」回归：
// 13a 分段耗时埋点（TTFT/llmRetries/timeBreakdown + 指标遥测 JSON）
// 13b 首响应提速（refreshMcpTools stale-while-revalidate、scanSkills 签名缓存、项目记忆 48KB 上限）
// 13c 每步开销削减（read_file 默认截断、事件落库合批、窗口护栏增量估算、只读工具并行白名单）
// 顺手修：MCP 旧「总是允许」规则形状兼容（批次 6 遗留：{tool:'mcp__server__tool'} 永远匹配不上 tool='mcp'）
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const engine = require('../../src/infrastructure/agent-runtime/agent-runtime-engine.js');
const { createApprovalDecision } = require('../../src/infrastructure/agent-runtime/approval-decision.js');

// ===== 13c.4 read_file / read_files 默认截断 =====

function tmpdir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test('批次13：read_file 默认截断 24000 字符 + maxChars 显式覆盖 + 小文件不截断', async () => {
  const dir = tmpdir('tangbao-p13-read-');
  const big = Array.from({ length: 40 }, (_, i) => 'x'.repeat(1000) + ' 第' + i + '行').join('\n');
  fs.writeFileSync(path.join(dir, 'big.txt'), big, 'utf8');
  fs.writeFileSync(path.join(dir, 'small.txt'), '只有一行', 'utf8');
  const noop = () => {};
  const bigOut = await engine.runTool('read_file', { path: 'big.txt' }, dir, noop, 'run_p13', false, () => false, {});
  assert.equal(bigOut.ok, true);
  assert.equal(bigOut.truncated, true, '整文件超限必须标记 truncated');
  assert.ok(bigOut.summary.includes('maxChars=24000'), '截断提示必须写明默认上限');
  assert.ok(bigOut.summary.length < 25000, '回传内容必须被截断（此前整文件进上下文）');
  assert.ok(bigOut.data.readFiles[0].truncated === true);
  const explicit = await engine.runTool('read_file', { path: 'big.txt', maxChars: 500 }, dir, noop, 'run_p13', false, () => false, {});
  assert.ok(explicit.summary.includes('maxChars=500'), '显式 maxChars 仍可覆盖');
  const small = await engine.runTool('read_file', { path: 'small.txt' }, dir, noop, 'run_p13', false, () => false, {});
  assert.equal(small.truncated, false, '小文件不受默认上限影响');
  const batch = await engine.runTool('read_files', { paths: ['big.txt', 'small.txt'] }, dir, noop, 'run_p13', false, () => false, {});
  assert.equal(batch.truncated, true, 'read_files 逐文件应用同一默认上限');
  assert.ok(batch.summary.includes('maxChars=24000'));
});

// ===== 13b.2 scanSkills 签名缓存（仅注入路径） =====

test('批次13：scanSkills useCache 命中同一结果、内容变更后失效；默认路径始终实时', async () => {
  const dir = tmpdir('tangbao-p13-skill-');
  const skillDir = path.join(dir, '.tangbao-skills', 'alpha');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: alpha\ndescription: v1\n---\n正文一', 'utf8');
  const first = await engine.scanSkills(dir, { useCache: true });
  assert.ok(first.some((s) => s.name === 'alpha' && s.description === 'v1'));
  const second = await engine.scanSkills(dir, { useCache: true });
  assert.strictEqual(second, first, '签名未变时必须命中缓存（同一数组引用）');
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: alpha\ndescription: v2-longer\n---\n正文二', 'utf8');
  const third = await engine.scanSkills(dir, { useCache: true });
  assert.notStrictEqual(third, first, 'SKILL.md 变更（size/mtime 签名）必须重新扫描');
  assert.ok(third.some((s) => s.name === 'alpha' && s.description === 'v2-longer'));
  const fresh = await engine.scanSkills(dir);
  assert.ok(fresh.some((s) => s.description === 'v2-longer'), '不带 useCache 的路径（use_skill/设置面板）不读缓存');
});

// ===== 顺手修：MCP 旧「总是允许」规则形状兼容 =====

test('批次13：旧形状 {tool:mcp__server__tool} 的 allow 规则重新生效', () => {
  const AD = createApprovalDecision();
  const legacyCtx = { mode: 'default', projectRules: [], globalRules: [{ tool: 'mcp__github__create_issue', allow: true }] };
  assert.equal(AD.needsApproval('mcp', 'github/create_issue', false, [], [], null, legacyCtx), false, '旧「总是允许」必须匹配（批次 6 前写入的规则）');
  const modernCtx = { mode: 'default', projectRules: [], globalRules: [{ tool: 'mcp', pattern: 'github/create_issue', allow: true }] };
  assert.equal(AD.needsApproval('mcp', 'github/create_issue', false, [], [], null, modernCtx), false, '新形状规则行为不变');
  const noneCtx = { mode: 'default', projectRules: [], globalRules: [] };
  assert.equal(AD.needsApproval('mcp', 'github/create_issue', false, [], [], null, noneCtx), true, '无规则时 default 模式 MCP 仍需审批');
  assert.equal(AD.needsApproval('mcp', 'other/tool', false, [], [], null, legacyCtx), true, '旧规则只放行对应工具');
});

// ===== 13c.2 窗口护栏增量估算 =====

test('批次13：窗口护栏增量估算与全量估算语义一致（追加/重建两形态）', () => {
  const CM = require('../../src/core/agent-runtime/context-manager');
  const TE = require('../../src/core/models/tokenizer');
  const msgs = [
    { role: 'system', content: '系统提示 '.repeat(200) },
    { role: 'user', content: '用户消息 '.repeat(200) },
  ];
  const w1 = CM.enforceWindow(msgs, 200000, {});
  msgs.push({ role: 'assistant', content: '助手回复 '.repeat(200) });
  const w2 = CM.enforceWindow(msgs, 200000, {});
  const direct = TE.estimateTokens(msgs);
  assert.ok(Math.abs(w2.beforeTokens - direct) <= msgs.length * 2 + 4, '增量估算与整包估算差必须 ≤ 每条消息 2 token 量级');
  assert.equal(w2.triggered, false);
  // 压缩重建形态：数组整体缩短（length 变小）→ 缓存失效，回退全量估算
  msgs.length = 0;
  const rebuilt = [{ role: 'system', content: '压缩后 '.repeat(50) }, { role: 'user', content: '继续 '.repeat(50) }];
  rebuilt.forEach((m) => msgs.push(m));
  const w3 = CM.enforceWindow(msgs, 200000, {});
  assert.ok(Math.abs(w3.beforeTokens - TE.estimateTokens(msgs)) <= 4, '重建后必须回退全量估算（误差≈0）');
});

// ===== 13c.3 事件合批落库 + 13a TTFT 遥测（真库，经 check:sqlite 通道） =====

test('批次13：appendAgentEvents 合批序号连续 + recordModelCallMetric TTFT 遥测往返', (t) => {
  let Database = null;
  try { Database = require('better-sqlite3'); } catch (_) {}
  if (!Database) { t.skip('better-sqlite3 native module unavailable for this Node runtime'); return; }
  const storage = require('../../src/infrastructure/storage/sqlite-store');
  const dir = tmpdir('tangbao-p13-db-');
  if (!storage.init(path.join(dir, 'tangbao.sqlite'))) { t.skip('sqlite-store 初始化失败'); return; }
  const S = storage.StorageService;
  try {
    const batch = Array.from({ length: 20 }, (_, i) => ({ type: 'message', data: { text: '块' + i } }));
    const seqs = S.appendAgentEvents('run_p13', batch);
    assert.equal(seqs.length, 20);
    for (let i = 0; i < 20; i++) assert.equal(seqs[i], i + 1, 'seq 按 run 内递增且连续');
    const events = S.listAgentEvents('run_p13');
    assert.equal(events.length, 20);
    assert.deepEqual(events.map((e) => e.payload.text), batch.map((b) => b.data.text), '回放顺序与入队顺序一致');
    const emptySeqs = S.appendAgentEvents('run_p13', []);
    assert.ok(Array.isArray(emptySeqs) && emptySeqs.length === 0, '空批次返回空数组');
    // 合批后单条续写序号必须衔接
    const tailSeq = S.appendAgentEvent('run_p13', 'done', {});
    assert.equal(tailSeq, 21, '单条 appendAgentEvent 与合批通道共用序号空间');
    // TTFT 进遥测 JSON（不新增列）
    S.recordModelCallMetric({ runId: 'run_p13', modelId: 'model-a', inputTokens: 10, outputTokens: 5, latencyMs: 1000, ttftMs: 321, status: 'completed' });
    S.recordModelCallMetric({ runId: 'run_p13', modelId: 'model-a', inputTokens: 8, outputTokens: 4, latencyMs: 900, status: 'completed' });
    const rows = S.listModelCallMetrics('run_p13');
    assert.equal(rows.find((r) => r.inputTokens === 10).ttftMs, 321, '记录时 ttftMs 经遥测 JSON 往返');
    assert.equal(rows.find((r) => r.inputTokens === 8).ttftMs, null, '无 TTFT 的旧行不编造数值');
    const summary = storage.listModelCallMetricsSummary();
    const item = summary.items.find((x) => x.model === 'model-a');
    assert.equal(item.avgTtftMs, 321, '汇总 AVG 忽略无 TTFT 行');
  } finally {
    try { storage.close(); } catch (_) {}
  }
});

// ===== 静态断言：防回潮（并行白名单/回填顺序/冲刷点/SWR/面板显示） =====

test('批次13：引擎并行工具与合批机制静态守卫', () => {
  const eng = read('src/infrastructure/agent-runtime/agent-runtime-engine.js');
  // 白名单 = 纯本地只读；web_search（plan 拒绝/网络）与 mcp（审批）绝不在列
  assert.match(eng, /const PARALLEL_READONLY_TOOLS = new Set\(\['read_file', 'read_files', 'list_dir', 'glob', 'grep', 'get_repo_map', 'get_file_outline', 'find_symbol', 'find_references'\]\);/);
  const setLine = eng.match(/const PARALLEL_READONLY_TOOLS = new Set\(\[[^\]]*\]\);/)[0];
  assert.ok(!/web_search|mcp__|write_file|run_command/.test(setLine), '并行白名单不得包含网络/审批/写类工具');
  // 串行回退路径必须保留（任一条件不满足 → 原串行语义）
  assert.ok(eng.includes('if (!parallelRan) for (const tc of r.toolCalls) {'));
  // 并行结果按原顺序回填 + 整批护栏
  assert.ok(eng.includes("messages.push({ role: 'tool', tool_call_id: it.tc.id, content: modelToolResult });"));
  assert.ok(eng.includes('const guardAfterBatch = enforceWindowGuard(messages);'));
  // 合批：终态类型集合 / 16 条阈值 / checkpoint 与窗口护栏前冲刷 / 收尾冲刷
  assert.match(eng, /const TERMINAL_EVENT_TYPES = new Set\(\['done', 'error', 'blocked'\]\);/);
  assert.ok(eng.includes('if (eventQueue.length >= 16) flushEvents(); else scheduleEventFlush();'));
  assert.match(eng, /const saveCheckpoint = \(reason\) => \{\s*\n\s*flushEvents\(\);/);
  assert.match(eng, /const enforceWindowGuard = \(msgs\) => \{\s*\n\s*flushEvents\(\);/);
  assert.ok(eng.includes('try { flushEvents(); } catch (_) {} // v1.2.1 批次 13c：收尾前落库全部排队事件'));
});

test('批次13：首响应提速与分段耗时埋点静态守卫', () => {
  const eng = read('src/infrastructure/agent-runtime/agent-runtime-engine.js');
  // MCP stale-while-revalidate + 排序稳定 + run 预热
  assert.ok(eng.includes('void refreshMcpToolsCache();'), 'TTL 过期不得阻塞 LLM 请求');
  assert.ok(eng.includes('.sort((a, b) => (a.function.name < b.function.name'), 'MCP 工具清单排序稳定（保住供应商前缀缓存）');
  assert.ok(eng.includes('await refreshMcpTools(true);'), 'run 开始时预热一次');
  // 项目记忆 48KB 上限
  assert.ok(eng.includes('49152'), '项目记忆单文件 48KB 截断');
  // adapter usage 回报时跳过全量 BPE
  assert.ok(eng.includes('if (inTok == null) inTok = TokenEstimator.estimateTokens(messages);'));
  // usage 分段统计初始化 + TTFT/重试累计
  assert.match(eng, /timeBreakdown: \{ llmMs: 0, toolsMs: 0, approvalsMs: 0, persistMs: 0 \}/);
  assert.ok(eng.includes('usage.llmRetries += Number(r.connectRetries || 0);'));
  assert.equal((eng.match(/ttftMs: firstEventAt \? firstEventAt - streamStartedAt : null/g) || []).length, 2, '两条流路径都要回报 TTFT');
  assert.equal((eng.match(/ttftMs: item\.ttftMs == null \? null : Number\(item\.ttftMs\)/g) || []).length, 2, 'trace 与模型调用指标都要带 TTFT');
  // read_file 默认上限常量
  assert.ok(eng.includes('READ_FILE_DEFAULT_MAX_CHARS = 24000'));
  // runStore 代理白名单放行合批 API
  const proxy = read('src/main/main-agent-runs.js');
  assert.ok(proxy.includes("'appendAgentEvents'"), 'createRunStoreProxy 必须放行 appendAgentEvents');
  // sqlite：合批函数 + 遥测 timing + 汇总列
  const store = read('src/infrastructure/storage/sqlite-store.js');
  assert.match(store, /function appendAgentEvents\(runId, events\)/);
  assert.match(store, /packTelemetry\(cache, cost, attribution, timing\)/);
  assert.ok(store.includes("json_extract(cache_json,'$.timing.ttftMs')"));
  // 用量面板首字延迟显示
  const panel = read('src/renderer/components/ui-settings-storage.js');
  assert.ok(panel.includes('item.ttftMs != null ? item.ttftMs : item.firstByteLatencyMs'));
});
