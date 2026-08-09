'use strict';
/*
 * 糖码 v2 对照评测 CLI：
 *   node scripts/compare-eval.js [--tasks benchmarks/tasks.json] [--self benchmarks/last-eval.json] [--traces benchmarks/traces]
 *
 * 读取糖码自评报告 + 外部 Agent（Codex / Claude Code）轨迹目录，输出对比表与
 * benchmarks/compare-report.json。外部轨迹约定：
 *   benchmarks/traces/<agent>/<taskId>.json
 *   { "agent": "<name>", "taskId": "<id>", "passed": true|false, "steps": n,
 *     "toolCalls": n, "failures": n, "durationMs": n }
 */
const path = require('path');
const fs = require('fs');
const { buildComparison } = require('../src/core/agent-runtime/compare-eval');
const { compareBenchmarkReports } = require('../src/core/agent-runtime/benchmark-harness');

const ROOT = path.join(__dirname, '..');

function parseArgs() {
  const out = {
    tasks: path.join(ROOT, 'benchmarks', 'tasks.json'),
    self: path.join(ROOT, 'benchmarks', 'last-eval.json'),
    traces: path.join(ROOT, 'benchmarks', 'traces'),
    baseline: '',
    current: '',
    out: '',
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tasks' && argv[i + 1]) out.tasks = path.resolve(argv[i + 1]);
    else if (argv[i] === '--self' && argv[i + 1]) out.self = path.resolve(argv[i + 1]);
    else if (argv[i] === '--traces' && argv[i + 1]) out.traces = path.resolve(argv[i + 1]);
    else if (argv[i] === '--baseline' && argv[i + 1]) out.baseline = path.resolve(argv[i + 1]);
    else if (argv[i] === '--current' && argv[i + 1]) out.current = path.resolve(argv[i + 1]);
    else if (argv[i] === '--out' && argv[i + 1]) out.out = path.resolve(argv[i + 1]);
  }
  return out;
}

function loadTasks(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (j.tasks || []).filter((t) => t && t.id && t.compare === true).map((t) => ({ id: t.id, title: t.title || '' }));
  } catch (e) {
    console.error('任务集读取失败：' + (e.message || e));
    return [];
  }
}

function loadSelf(file) {
  if (!file || !fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function loadTraces(dir) {
  const traces = {};
  if (!dir || !fs.existsSync(dir)) return traces;
  let agents = [];
  try { agents = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch (_) { return traces; }
  for (const agent of agents) {
    const agentDir = path.join(dir, agent);
    traces[agent] = traces[agent] || {};
    let files = [];
    try { files = fs.readdirSync(agentDir).filter((f) => f.endsWith('.json')); } catch (_) { continue; }
    for (const f of files) {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(agentDir, f), 'utf8'));
        if (t && t.taskId) traces[agent][String(t.taskId)] = t;
      } catch (_) { /* 忽略坏轨迹 */ }
    }
  }
  return traces;
}

function fmt(v, suffix) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? '✅' : '❌';
  if (typeof v === 'number') return String(v) + (suffix || '');
  return String(v);
}

function render(out) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n===== 跨 Agent 对照评测（同任务 · 不同 Harness）=====');
  const header = pad('任务', 46) + out.agents.map((a) => pad(a, 16)).join('');
  console.log(header);
  console.log(pad('', 46) + out.agents.map(() => pad('判定/步/失败', 16)).join(''));
  for (const row of out.rows) {
    const cells = out.agents.map((a) => {
      const r = row.agents[a] || {};
      const pass = fmt(r.passed);
      const steps = fmt(r.steps);
      const fails = fmt(r.failures);
      return pad(pass + ' ' + steps + '/' + fails, 16);
    });
    console.log(pad(row.taskId + ' ' + String(row.title || '').slice(0, 26), 46) + cells.join(''));
  }
  console.log('\n---- 汇总 ----');
  for (const a of out.agents) {
    const s = out.stats[a] || {};
    const rate = s.passRate === null || s.passRate === undefined ? null : Math.round(s.passRate * 100);
    console.log(pad(a, 12) +
      '通过 ' + fmt(s.passed) + '/' + fmt(s.judged) +
      '（' + fmt(rate) + '%）' +
      ' 平均步数 ' + fmt(s.avgSteps) +
      ' 平均失败 ' + fmt(s.avgFailures) +
      ' 平均耗时 ' + fmt(s.avgDurationMs) + 'ms');
  }
}

function main() {
  const args = parseArgs();
  if (args.baseline || args.current) {
    if (!args.baseline || !args.current) {
      console.error('Benchmark 比较需要同时提供 --baseline 和 --current');
      process.exitCode = 2;
      return;
    }
    let baseline;
    let current;
    try {
      baseline = JSON.parse(fs.readFileSync(args.baseline, 'utf8'));
      current = JSON.parse(fs.readFileSync(args.current, 'utf8'));
    } catch (error) {
      console.error('Benchmark 报告读取失败：' + (error.message || error));
      process.exitCode = 2;
      return;
    }
    const result = compareBenchmarkReports(baseline, current);
    const output = args.out || path.join(ROOT, 'benchmarks', 'compare-report.json');
    fs.writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
    console.log('报告已保存：' + output);
    process.exitCode = result.pass ? 0 : 1;
    return;
  }
  const tasks = loadTasks(args.tasks);
  const self = loadSelf(args.self);
  const traces = loadTraces(args.traces);
  if (!tasks.length) {
    console.error('没有带 compare:true 的任务（或任务集读取失败）');
    process.exit(1);
  }
  if (!self) console.log('提示：未提供 --self 糖码报告（benchmarks/last-eval.json），糖码列将留空。先运行 node scripts/bench.js --eval 生成。');
  if (!Object.keys(traces).length) console.log('提示：未发现外部轨迹目录，仅糖码列可见。将 Codex/Claude Code 同任务判定放入 benchmarks/traces/<agent>/<taskId>.json 后重跑。');

  // 输出 JSON 报告（供 CI/脚本消费），终端表格同样渲染
  const out = buildComparison({ tasks, self, traces });
  const reportPath = path.join(ROOT, 'benchmarks', 'compare-report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    at: new Date().toISOString(), agents: out.agents, rows: out.rows, stats: out.stats,
  }, null, 2));
  render(out);
  console.log('\n报告已保存：' + reportPath);
}

if (require.main === module) main();
module.exports = { loadTasks, loadSelf, loadTraces, render };
