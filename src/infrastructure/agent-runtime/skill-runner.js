'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');

const DEFAULTS = Object.freeze({ timeoutMs: 60000, maxOutputBytes: 1024 * 1024, maxConcurrent: 2 });
let active = 0;

function minimalEnv(extra) {
  const keep = ['PATH','Path','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','HOME','USERPROFILE','LANG','LC_ALL']; const env = {};
  for (const key of keep) if (process.env[key] != null) env[key] = process.env[key];
  env.TANGBAO_SKILL_SANDBOX = '1';
  for (const [key, value] of Object.entries(extra || {})) if (/^TANGBAO_SKILL_[A-Z0-9_]+$/.test(key)) env[key] = String(value);
  return env;
}

// v1.2.0 批次 1：网络隔离从「声明」变「默认强制拒绝」。
// 未显式 allowNetwork 时，把全部代理变量指向失效端点（端口 9 discard，连接即拒）——
// curl/pip/npm/requests/undici 等主流 HTTP 客户端都尊重代理环境变量，出网被立即拒绝；
// 并显式清空 NO_PROXY 防止绕过。诚实边界：这是环境变量级阻断，原始套接字不受限
// （Windows 无用户态内核隔离；AppContainer 级隔离留待后续硬化）。
function applyNetworkPolicy(env, allowNetwork) {
  if (allowNetwork) return { mode: 'declared-allowed' };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    env[key] = 'http://127.0.0.1:9';
  }
  env.NO_PROXY = '';
  env.no_proxy = '';
  return { mode: 'blocked-proxy-env' };
}

function interpreter(scriptPath, options) {
  const ext = path.extname(scriptPath).toLowerCase(); const opts = options || {};
  if (['.js','.mjs','.cjs'].includes(ext)) return { command: opts.nodePath || process.execPath, args: [scriptPath], electronAsNode: !!process.versions.electron };
  if (ext === '.py') return { command: opts.pythonPath || (process.platform === 'win32' ? 'python' : 'python3'), args: [scriptPath] };
  if (ext === '.sh') return { command: opts.shellPath || (process.platform === 'win32' ? 'bash' : '/bin/sh'), args: [scriptPath] };
  throw Object.assign(new Error('不支持的 Skill 脚本类型'), { code: 'unsupported_script' });
}

function hasExited(child) { return !child || child.exitCode !== null || child.signalCode !== null; }

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
    timer.unref?.();
    child.once('close', onExit);
    child.once('exit', onExit);
    if (hasExited(child)) finish(true);
  });
}

async function terminateTree(child) {
  if (hasExited(child)) return true;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      killer.on('close', resolve);
      killer.on('error', resolve);
    });
    // taskkill may race with a child that is already exiting; use a bounded
    // direct kill as a fallback for wrappers that do not expose the tree.
    if (!hasExited(child)) { try { child.kill('SIGKILL'); } catch (_) {} }
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { try { child.kill('SIGTERM'); } catch (_) {} }
    if (!await waitForExit(child, 500)) { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_) {} } }
  }
  return waitForExit(child, 2000);
}

async function run(input) {
  const opts = Object.assign({}, DEFAULTS, input || {});
  if (active >= opts.maxConcurrent) return { ok: false, error: { code: 'skill_concurrency_limit', message: 'Skill 脚本并发数已达上限', retryable: true } };
  const spec = interpreter(opts.scriptPath, opts); const argv = spec.args.concat(Array.isArray(opts.args) ? opts.args.map(String) : []);
  const tempDir = opts.cwd || await fsp.mkdtemp(path.join(os.tmpdir(), 'tangbao-skill-run-'));
  const cleanup = !opts.cwd;
  active += 1;
  try {
    return await new Promise((resolve) => {
      let settled = false, timedOut = false, abortRequested = false, truncated = false; const chunks = []; let bytes = 0;
      const env = minimalEnv(opts.env); const netPolicy = applyNetworkPolicy(env, opts.allowNetwork); if (spec.electronAsNode) env.ELECTRON_RUN_AS_NODE = '1';
      const child = spawn(spec.command, argv, { cwd: tempDir, env, windowsHide: true, shell: false, detached: process.platform !== 'win32' });
      const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); if (opts.signal) opts.signal.removeEventListener('abort', onAbort); resolve(result); };
      const capture = (stream, label) => stream.on('data', (chunk) => { if (bytes >= opts.maxOutputBytes) { truncated = true; return; } const allowed = chunk.subarray(0, Math.max(0, opts.maxOutputBytes - bytes)); bytes += allowed.length; chunks.push({ label, data: allowed }); if (allowed.length < chunk.length) truncated = true; });
      capture(child.stdout, 'stdout'); capture(child.stderr, 'stderr');
      const timer = setTimeout(async () => {
        timedOut = true;
        const terminated = await terminateTree(child);
        // B3（P1）：进程树杀不掉时 child 'close' 可能永不触发 → Promise 悬挂、active 永不归还，后续全部命中并发上限。
        // 超时后强制 settle（finish 有 settled 守卫：若 close 先到则此处被忽略）。
        const output = Buffer.concat(chunks.map((item) => item.data)).toString('utf8');
        finish({ ok: false, error: { code: 'skill_script_timeout', message: 'Skill 脚本运行超时', retryable: true }, output, truncated, terminated, isolation: isolationLevel(opts) });
      }, Math.max(1000, Number(opts.timeoutMs) || DEFAULTS.timeoutMs));
      const onAbort = async () => { abortRequested = true; const terminated = await terminateTree(child); finish({ ok: false, error: { code: 'skill_script_aborted', message: 'Skill 脚本已随运行取消', retryable: true }, terminated, isolation: isolationLevel(opts) }); };
      if (opts.signal) { if (opts.signal.aborted) return onAbort(); opts.signal.addEventListener('abort', onAbort, { once: true }); }
      child.on('error', (error) => finish({ ok: false, error: { code: 'skill_script_start_failed', message: error.message, retryable: true }, isolation: isolationLevel(opts) }));
      child.on('close', (code, signal) => {
        const output = Buffer.concat(chunks.map((item) => item.data)).toString('utf8');
        finish(abortRequested ? { ok: false, error: { code: 'skill_script_aborted', message: 'Skill 脚本已随运行取消', retryable: true }, output, truncated, isolation: isolationLevel(opts) }
          : timedOut ? { ok: false, error: { code: 'skill_script_timeout', message: 'Skill 脚本运行超时', retryable: true }, output, truncated, isolation: isolationLevel(opts) }
            : { ok: code === 0, exitCode: code, signal, output, truncated, isolation: isolationLevel(opts), error: code === 0 ? null : { code: 'skill_script_failed', message: 'Skill 脚本退出码 ' + code, retryable: true } });
      });
    });
  } finally { active -= 1; if (cleanup) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {}); }
}

function isolationLevel(options) { return { level: 'process', environment: 'minimal', network: options && options.allowNetwork ? 'declared-allowed' : 'blocked-proxy-env', filesystem: options && options.cwd ? 'workspace-approved' : 'temporary-directory', limits: { timeoutMs: Number(options && options.timeoutMs) || DEFAULTS.timeoutMs, maxOutputBytes: Number(options && options.maxOutputBytes) || DEFAULTS.maxOutputBytes } }; }

module.exports = { DEFAULTS, minimalEnv, applyNetworkPolicy, interpreter, isolationLevel, run, terminateTree };
