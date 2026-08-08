'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function runtimeCandidates(runtime) {
  const value = String(runtime || '').toLowerCase();
  // Electron 主进程里的 process.execPath 是 electron.exe（发布版则是应用 exe），
  // 直接传 -e/--test 会再次启动 GUI 应用并让同步判分永久等待。
  // ELECTRON_RUN_AS_NODE 是 Electron 官方的 Node CLI 模式；普通 node 可安全忽略该变量。
  if (value === 'node') return [{
    executable: process.execPath,
    prefixArgs: [],
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
  }];
  if (value === 'python') {
    return process.platform === 'win32'
      ? [{ executable: 'py', prefixArgs: ['-3'] }, { executable: 'python', prefixArgs: [] }, { executable: 'python3', prefixArgs: [] }]
      : [{ executable: 'python3', prefixArgs: [] }, { executable: 'python', prefixArgs: [] }];
  }
  return [];
}

function resolveRuntime(runtime, context) {
  const ctx = context || {};
  if (typeof ctx.resolveRuntime === 'function') return ctx.resolveRuntime(runtime);
  const candidates = runtimeCandidates(runtime);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate.executable, candidate.prefixArgs.concat(['--version']), {
        stdio: 'pipe', timeout: 5000, windowsHide: true, shell: false,
        env: candidate.env || process.env,
      });
      return candidate;
    } catch (_) {}
  }
  return null;
}

function collectTestFiles(root, rel, suffix) {
  const base = inside(root, rel || 'test');
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) return [];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && (!suffix || entry.name.endsWith(suffix))) out.push(path.relative(root, full));
    }
  };
  walk(base);
  return out.sort();
}

function inside(root, rel) {
  const base = path.resolve(root);
  const full = path.resolve(base, String(rel || ''));
  if (full !== base && !full.startsWith(base + path.sep)) throw new Error('check_path_outside_fixture');
  return full;
}

function runCheck(check, context) {
  const ctx = context || {};
  const root = ctx.cwd;
  if (!check || typeof check === 'string') return { ok: null, type: 'legacy', description: String(check || '') };
  const type = check.type;
  try {
    if (type === 'file_exists') return { ok: fs.existsSync(inside(root, check.path)), type, path: check.path };
    if (type === 'file_contains') {
      const content = fs.readFileSync(inside(root, check.path), 'utf8');
      const ok = check.regex ? new RegExp(check.regex, check.flags || '').test(content) : content.includes(String(check.text || ''));
      return { ok, type, path: check.path };
    }
    if (type === 'command') {
      const args = Array.isArray(check.args) ? check.args.map((arg) => String(arg)) : null;
      if (check.runtime || check.executable || args) {
        let spec = null;
        if (check.runtime) spec = resolveRuntime(check.runtime, ctx);
        else if (check.executable) spec = { executable: String(check.executable), prefixArgs: [] };
        if (!spec) {
          return {
            ok: null, type, skipped: true, infrastructureFailure: true,
            code: String(check.runtime || 'command') + '_runtime_missing',
            runtime: String(check.runtime || ''),
          };
        }
        const finalArgs = (spec.prefixArgs || []).concat(args || []);
        execFileSync(spec.executable, finalArgs, {
          cwd: root, stdio: 'pipe', timeout: Number(check.timeoutMs) || 120000,
          windowsHide: true, shell: false, env: spec.env || process.env,
        });
        return { ok: true, type, runtime: check.runtime || '', executable: spec.executable, args: finalArgs };
      }
      const command = String(check.command || '');
      if (!command) return { ok: false, type, error: 'command_required' };
      execFileSync(process.platform === 'win32' ? 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/d', '/c', command] : ['-c', command], { cwd: root, stdio: 'pipe', timeout: Number(check.timeoutMs) || 120000, windowsHide: true });
      return { ok: true, type, command };
    }
    if (type === 'test_files') {
      const files = collectTestFiles(root, check.path || 'test', check.suffix || '.test.js');
      if (!files.length) return { ok: false, type, error: 'test_files_missing', path: check.path || 'test' };
      const spec = resolveRuntime('node', ctx);
      if (!spec) return { ok: null, type, skipped: true, infrastructureFailure: true, code: 'node_runtime_missing', runtime: 'node' };
      execFileSync(spec.executable, (spec.prefixArgs || []).concat(['--test'], files), {
        cwd: root, stdio: 'pipe', timeout: Number(check.timeoutMs) || 120000,
        windowsHide: true, shell: false, env: spec.env || process.env,
      });
      return { ok: true, type, runtime: 'node', executable: spec.executable, files };
    }
    if (type === 'event') {
      const events = Array.isArray(ctx.events) ? ctx.events : [];
      return { ok: events.some((event) => event.type === check.eventType), type, eventType: check.eventType };
    }
    if (type === 'status') return { ok: String(ctx.status) === String(check.value), type, value: check.value };
    return { ok: false, type: type || 'unknown', error: 'unsupported_check' };
  } catch (error) {
    return { ok: false, type, error: error && error.message ? error.message : String(error) };
  }
}

function judgeTask(task, context) {
  const checks = Array.isArray(task && task.expectedChecks) ? task.expectedChecks : [];
  const results = checks.map((check) => runCheck(check, context));
  const skippedInfrastructure = results.filter((result) => result.ok === null && result.infrastructureFailure);
  const structured = results.filter((result) => result.ok !== null);
  const legacy = results.filter((result) => result.ok === null && !result.infrastructureFailure);
  const events = Array.isArray(context && context.events) ? context.events : [];
  const completed = context && (context.status === 'completed' || context.status === 'done');
  const hasChange = events.some((event) => event.type === 'tool_diff' || (event.type === 'tool_result' && event.payload && event.payload.name && /write|edit|patch|create|move|delete/.test(event.payload.name)));
  const hasVerification = events.some((event) => event.type === 'tool_result' && event.payload && event.payload.result && event.payload.result.ok !== false && event.payload.result.data && event.payload.result.data.kind);
  const structuredOk = structured.every((result) => result.ok === true);
  // B6（P2）：mixed 任务（含结构化 checks）的 legacy 部分不再强求 completed——结构化 checks 已代表行为正确性
  // （safety 类任务正确结果可能是 blocked/budget_exhausted）；纯 legacy 任务维持「完成 + 证据」判定。
  const legacyOk = !legacy.length || (structured.length
    ? true
    : (completed && (hasChange || (task.tags || []).includes('context') || (task.tags || []).includes('safety')) && (hasVerification || (task.tags || []).includes('text') || (task.tags || []).includes('context') || (task.tags || []).includes('safety'))));
  // v3（判分语义）：含结构化 checks 的任务按「行为正确性」判定（safety 类正确结果可能是 blocked/budget_exhausted，
  // 不能强制 completed）；纯 legacy 字符串任务维持「完成 + 证据」判定。
  const ok = !skippedInfrastructure.length && (structured.length ? (structuredOk && (!legacy.length || legacyOk)) : (!!completed && legacyOk));
  const infrastructureSkipped = skippedInfrastructure.length > 0;
  return {
    ok, completed: !!completed, checks: results,
    mode: structured.length ? (legacy.length ? 'mixed' : 'structured') : (infrastructureSkipped ? 'infrastructure-skipped' : 'legacy-evidence'),
    hasChange, hasVerification, infrastructureSkipped,
    infrastructureFailures: skippedInfrastructure.map((result) => result.code || result.error || 'infrastructure_failure'),
  };
}

module.exports = { inside, runCheck, judgeTask, runtimeCandidates, resolveRuntime, collectTestFiles };
