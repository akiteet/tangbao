'use strict';
/*
 * 糖码 v1.1.0 M0 评测基线 · 指标分析 + v2（P1-7）Eval Runner
 *
 * 用法：
 *   node scripts/bench.js --db <app.db 路径>            # 只读聚合历史运行指标（原模式）
 *   node scripts/bench.js --list                        # 列出评测任务
 *   node scripts/bench.js --eval simple-001             # 跑单个任务（需后端已启动）
 *   node scripts/bench.js --eval                        # 跑全部可自动任务（safe-* 需人工交互，跳过）
 *
 * Eval Runner 环境变量（驱动糖码后端）：
 *   AGENT_BASE  后端地址，默认 http://127.0.0.1:3000（糖码独立模式默认 3000）
 *   AGENT_TOKEN 启动令牌（若后端启用了 token 校验）
 *   EVAL_MODEL  模型 id（默认取 env EVAL_MODEL，缺失时提示）
 *   EVAL_REF    模型账户引用（传给主进程解密对应账户，不包含密钥明文）
 *   EVAL_CWD    无 fixture 任务的工作目录；仅运行隔离 fixture 时可不填
 *   EVAL_RUNS_DIR 隔离 fixture 工作区根目录（默认系统临时目录/tangbao-eval-runs）
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { judgeTask } = require('../src/core/agent-runtime/eval-judge');

const TASKS_FILE = path.join(__dirname, '..', 'benchmarks', 'tasks.json');

function parseArgs() {
  const out = { db: '', list: false, eval: undefined };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db' && argv[i + 1]) out.db = argv[i + 1];
    else if (argv[i] === '--list') out.list = true;
    else if (argv[i] === '--eval') out.eval = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
  }
  return out;
}

function defaultDbPath() {
  // 桌面版应用数据目录（与 sqlite-store 初始化一致），Windows 优先
  const candidates = [
    process.env.TANGBAO_DATA,
    path.join(os.homedir(), 'AppData', 'Roaming', 'tangbao', 'tangbao-data', 'app.db'),
    path.join(os.homedir(), '.tangbao', 'app.db'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || candidates[1];
}

function loadTasks() {
  try {
    const j = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    return (j.tasks || []).filter((t) => t && t.id && t.goal);
  } catch (e) {
    console.error('无法读取评测任务集 benchmarks/tasks.json：' + (e.message || e));
    return [];
  }
}

function resolveFixtureSource(fixtureDir) {
  const rel = String(fixtureDir || '');
  if (!rel) return '';
  const projectRoot = path.join(__dirname, '..');
  const candidates = [
    path.resolve(projectRoot, rel),
    path.resolve(projectRoot, 'benchmarks', rel),
  ];
  const source = candidates.find((candidate) => fs.existsSync(candidate));
  if (!source) {
    throw new Error('评测 fixture 不存在：' + rel + '（已检查项目根目录和 benchmarks/）');
  }
  return source;
}

function prepareFixture(task, fallbackCwd, options = {}) {
  if (!task.fixtureDir) return { cwd: fallbackCwd, cleanup: () => {}, isolated: false };
  const source = resolveFixtureSource(task.fixtureDir);
  const runsRoot = path.resolve(options.runsRoot || process.env.EVAL_RUNS_DIR || path.join(os.tmpdir(), 'tangbao-eval-runs'));
  fs.mkdirSync(runsRoot, { recursive: true });
  const safeId = String(task.id).replace(/[^A-Za-z0-9_-]/g, '_');
  const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  const target = path.join(runsRoot, safeId + '-' + runId);
  fs.mkdirSync(target, { recursive: false });
  fs.cpSync(source, target, { recursive: true });
  return {
    cwd: target,
    isolated: true,
    // 评测目录保留用于复核；不主动删除，避免 Windows safe-delete 队列和误删风险。
    cleanup: () => {},
  };
}

// ===== v2（P1-7）：Eval Runner——驱动糖码后端执行任务并采集结果 =====
async function runEvalTask(task, opts) {
  const base = opts.base;
  const cwd = opts.cwd;
  const model = opts.model;
  const ref = opts.ref || '';
  const headers = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token;
  const startedAt = Date.now();
  let status = 'failed';
  let steps = 0;
  let toolCalls = 0;
  let failures = 0;
  let consecFail = 0;        // 当前连续失败计数
  let maxConsecFail = 0;     // 连续失败峰值
  let resultTokens = 0;      // 结果 token 估算（字符数 / 4）
  let compressionHits = 0;   // 压缩/预算中断计数
  let lastError = '';
  const events = [];
  try {
    const resp = await fetch(base + '/api/agent', {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs || 20 * 60 * 1000),
      body: JSON.stringify({
        prompt: task.goal, cwd, workspaceId: 'eval', model, ref, auto: true, planMode: false,
        threadId: 'eval_' + task.id, maxSteps: task.timeoutSteps || 10,
        thinkLevel: 'low',
      }),
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop();
      for (const line of parts) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(data); } catch (e) { continue; }
        events.push({ type: ev.type, payload: ev });
        if (ev.type === 'tool_call') toolCalls++;
        if (ev.type === 'tool_result') {
          steps++;
          const ok = ev.result && ev.result.ok !== false;
          if (!ok) {
            failures++;
            consecFail++;
            if (consecFail > maxConsecFail) maxConsecFail = consecFail;
          } else {
            consecFail = 0;
          }
          const rtext = ev.result && (typeof ev.result === 'string' ? ev.result : (ev.result.summary || ''));
          if (rtext) {
            resultTokens += Math.ceil(String(rtext).length / 4);
            if (/truncat|已截断|\[省略\]|…\s*$/i.test(rtext)) compressionHits++;
          }
        }
        if (ev.type === 'message' && ev.text) resultTokens += Math.ceil(String(ev.text).length / 4);
        if (ev.type === 'thinking' && ev.text) resultTokens += Math.ceil(String(ev.text).length / 4);
        if (ev.type === 'done') status = 'done';
        if (ev.type === 'blocked') {
          status = status === 'failed' ? 'blocked' : status;
          lastError = ev.reason || '';
          if (ev.reason && /compact|压缩|预算|上下文/i.test(ev.reason)) compressionHits++;
        }
        if (ev.type === 'error') { lastError = ev.message || ''; }
      }
    }
    if (status !== 'done' && status !== 'blocked') status = 'error';
  } catch (e) {
    status = 'error';
    lastError = String(e && e.message ? e.message : e);
  }
  const selfReportedDone = status === 'done';
  const judgment = judgeTask(task, { cwd, status: selfReportedDone ? 'completed' : status, events });
  const machinePassed = !!judgment.ok;
  // v3（判分门禁）：自报完成但机器判分失败 → 显式 assertion_failed，不再计入“通过”
  if (!machinePassed && selfReportedDone) status = 'assertion_failed';
  return {
    id: task.id, title: task.title, status, steps, toolCalls, failures,
    consecutiveFailures: maxConsecFail, resultTokens, compressionHits, judgment,
    selfReportedDone, machinePassed,
    durationMs: Date.now() - startedAt, error: lastError,
  };
}

async function mainEval(onlyId) {
  const base = process.env.AGENT_BASE || 'http://127.0.0.1:3000';
  const token = process.env.AGENT_TOKEN || '';
  const model = process.env.EVAL_MODEL || '';
  const ref = process.env.EVAL_REF || '';
  const cwd = process.env.EVAL_CWD || '';
  const all = loadTasks();
  const tasks = all.filter((t) => !t.manualOnly);
  const skipped = all.filter((t) => t.manualOnly);
  const targets = onlyId === true ? tasks : tasks.filter((t) => t.id === onlyId);
  if (onlyId !== true && !targets.length) {
    console.error('未找到任务：' + onlyId + '（可用 --list 查看）');
    process.exit(1);
  }
  const requiresCwd = targets.some((t) => !t.fixtureDir);
  if (requiresCwd && (!cwd || !fs.existsSync(cwd))) {
    console.error('所选任务包含无 fixture 项，请设置 EVAL_CWD 为明确的隔离工作目录');
    process.exit(1);
  }
  if (!model) {
    console.error('请设置 EVAL_MODEL 为糖码要调用的模型 id（如 gpt-4o-mini / deepseek-chat）');
    process.exit(1);
  }
  console.log('\n===== 糖码 Eval Runner（后端 ' + base + ' · 模型 ' + model + ' · cwd ' + (cwd || 'fixture-only') + '）=====');
  console.log('评测集共 ' + all.length + ' 个：自动执行 ' + targets.length + ' 个，人工驱动跳过 ' + skipped.length + ' 个（multi-turn/审批/重启/外部注入，需人工逐步驱动）…\n');
  const results = [];
  for (const t of targets) {
    process.stdout.write('▶ ' + t.id + ' ' + t.title + ' … ');
    const fixture = prepareFixture(t, cwd);
    let r;
    try { r = await runEvalTask(t, { base, token, model, ref, cwd: fixture.cwd, timeoutMs: (t.timeoutSteps || 10) * 60 * 1000 }); }
    finally { fixture.cleanup(); }
    results.push(r);
    console.log((r.machinePassed ? '✅ 判分通过' : (r.selfReportedDone ? '⚠️ 断言失败' : '❌ ' + r.status)) + ' · ' + r.steps + ' 步 · ' + r.toolCalls + ' 工具 · ' + Math.round(r.durationMs / 1000) + 's' + (r.error ? ' · ' + String(r.error).slice(0, 60) : ''));
  }
  const passed = results.filter((r) => r.machinePassed);
  const selfDone = results.filter((r) => r.selfReportedDone);
  const assertionFailed = results.filter((r) => r.selfReportedDone && !r.machinePassed);
  const structuredCount = results.filter((r) => r.judgment && r.judgment.mode && r.judgment.mode !== 'legacy-evidence').length;
  const totalSteps = results.reduce((a, r) => a + (r.steps || 0), 0);
  const totalResultTokens = results.reduce((a, r) => a + (r.resultTokens || 0), 0);
  const totalCompression = results.reduce((a, r) => a + (r.compressionHits || 0), 0);
  const maxConsecFailAll = results.reduce((a, r) => Math.max(a, r.consecutiveFailures || 0), 0);

  // 回归对比：与上次评测同 id 任务比较（机器判分通过率优先，旧报告字段缺失时回退 status==='done'）
  const reportPath = path.join(__dirname, '..', 'benchmarks', 'last-eval.json');
  const prevById = {};
  try {
    const prev = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    (prev.results || []).forEach((r) => { prevById[r.id] = r; });
  } catch (_) { /* 首次运行无历史，跳过对比 */ }
  const passedOf = (r) => (typeof r.machinePassed === 'boolean' ? r.machinePassed : (r.status === 'done' && r.judgment && r.judgment.ok));
  let regressions = 0;
  const regressionList = [];
  for (const r of results) {
    const p = prevById[r.id];
    if (!p) continue;
    const degraded =
      (passedOf(p) && !passedOf(r)) ||
      ((r.failures || 0) > (p.failures || 0) + 2) ||
      ((r.consecutiveFailures || 0) > (p.consecutiveFailures || 0) + 2);
    if (degraded) { regressions++; regressionList.push(r.id); }
  }

  console.log('\n---- 评测汇总 ----');
  console.log('任务数: ' + results.length + '（结构化判分 ' + structuredCount + ' / legacy 证据 ' + (results.length - structuredCount) + '）' +
    ' | 机器判分通过: ' + passed.length + ' (' + Math.round((passed.length / Math.max(1, results.length)) * 100) + '%)' +
    ' | 自报完成: ' + selfDone.length + ' | 断言失败: ' + assertionFailed.length +
    ' | 平均步骤: ' + (results.length ? Math.round(totalSteps / results.length) : 0) +
    ' | 平均耗时: ' + (results.length ? Math.round(results.reduce((a, r) => a + r.durationMs, 0) / results.length / 1000) : 0) + 's');
  console.log('连续失败峰值: ' + maxConsecFailAll +
    ' | 结果 token 估算: ' + totalResultTokens +
    ' | 压缩/预算中断: ' + totalCompression +
    ' | 回归: ' + regressions + (regressionList.length ? ' (' + regressionList.join(',') + ')' : ''));
  fs.writeFileSync(reportPath, JSON.stringify({
    reportVersion: 3, at: new Date().toISOString(), base, model, cwd, results,
    metrics: {
      machineSuccessRate: results.length ? passed.length / results.length : 0,
      selfReportedDone: selfDone.length, assertionFailed: assertionFailed.length,
      structuredCount, regressions, maxConsecutiveFailures: maxConsecFailAll,
      totalResultTokens, totalCompressionHits: totalCompression,
    },
  }, null, 2));
  console.log('结果已保存：' + reportPath);
  const allPassed = passed.length === results.length;
  process.exit(allPassed && regressions === 0 ? 0 : 1);
}

function main() {
  const args = parseArgs();
  if (args.list) {
    const tasks = loadTasks();
    console.log('评测任务集（' + tasks.length + ' 个）：');
    tasks.forEach((t) => console.log('  ' + String(t.id).padEnd(14) + '[' + (t.tags || []).join(',') + '] ' + t.title));
    return;
  }
  if (args.eval) {
    mainEval(args.eval === true ? true : String(args.eval)).catch((e) => {
      console.error('Eval 异常：' + (e && e.message ? e.message : e));
      process.exit(1);
    });
    return;
  }
  const { db: dbArg } = args;
  const dbPath = dbArg || defaultDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) {
    console.error('未找到数据库，请用 --db 指定路径（应用数据目录下的 app.db）');
    process.exit(1);
  }
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    console.error('无法加载 better-sqlite3：请在 Electron 环境（ABI 匹配）下运行本脚本。' + (e.message || e));
    process.exit(1);
  }
  const db = new Database(dbPath, { readonly: true });

  const runs = db.prepare('SELECT * FROM agent_runs ORDER BY started_at ASC').all();
  if (!runs.length) {
    console.log('agent_runs 表为空——还没有糖码运行记录。');
    db.close();
    return;
  }

  const evCount = db.prepare('SELECT run_id, type, COUNT(*) c FROM agent_run_events GROUP BY run_id, type').all();
  const evByRun = {};
  evCount.forEach((r) => {
    evByRun[r.run_id] = evByRun[r.run_id] || {};
    evByRun[r.run_id][r.type] = r.c;
  });
  const usageByRun = {};
  runs.forEach((r) => {
    try { usageByRun[r.id] = r.usage_json ? JSON.parse(r.usage_json) : {}; } catch (_) { usageByRun[r.id] = {}; }
  });

  const rows = runs.map((r) => {
    const u = usageByRun[r.id] || {};
    const ev = evByRun[r.id] || {};
    return {
      id: String(r.id).slice(0, 18), goal: String(r.user_goal || '').slice(0, 36),
      status: r.status, steps: u.steps || 0, tokens: u.tokens || 0,
      toolCalls: u.toolCalls || 0, failures: u.failures || 0, repeatedReads: u.repeatedReads || 0,
      evTotal: Object.values(ev).reduce((a, b) => a + b, 0),
      durationMs: (Number(r.finished_at) || Number(r.started_at)) - Number(r.started_at),
    };
  });

  console.log('\n===== 糖码 Agent Run 指标（' + runs.length + ' 次运行）=====');
  console.log('运行ID            目标                                  状态        步骤  token   工具  失败  重复读  事件数  耗时');
  rows.forEach((r) => {
    console.log(
      r.id.padEnd(18) + r.goal.padEnd(38) +
      String(r.status).padEnd(10) +
      String(r.steps).padEnd(5) + String(r.tokens).padEnd(8) +
      String(r.toolCalls).padEnd(6) + String(r.failures).padEnd(6) +
      String(r.repeatedReads).padEnd(7) + String(r.evTotal).padEnd(6) +
      Math.round(r.durationMs / 1000) + 's'
    );
  });

  const done = rows.filter((r) => r.status === 'completed' || r.status === 'done');
  console.log('\n---- 汇总 ----');
  console.log('总运行数: ' + rows.length + ' | 完成: ' + done.length +
    ' (' + Math.round((done.length / rows.length) * 100) + '%)' +
    ' | 失败: ' + rows.filter((r) => r.status === 'failed').length +
    ' | 平均步骤: ' + (rows.length ? Math.round(rows.reduce((a, r) => a + r.steps, 0) / rows.length) : 0) +
    ' | 平均 token: ' + (rows.length ? Math.round(rows.reduce((a, r) => a + r.tokens, 0) / rows.length) : 0) +
    ' | 总工具调用: ' + rows.reduce((a, r) => a + r.toolCalls, 0) +
    ' | 工具失败: ' + rows.reduce((a, r) => a + r.failures, 0) +
    ' | 重复读取: ' + rows.reduce((a, r) => a + r.repeatedReads, 0));
  db.close();
}

if (require.main === module) main();
module.exports = { loadTasks, resolveFixtureSource, prepareFixture, runEvalTask, mainEval };
