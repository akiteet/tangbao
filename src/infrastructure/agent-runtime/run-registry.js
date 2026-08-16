'use strict';
/*
 * 糖码运行态注册表（v1.1.5 批次 D4，自 agent-runtime-engine.js 原样抽出）。
 *
 * 集中承载跨请求共享的运行态容器与进程清理逻辑；导出的 Map/Set 是单例实例，
 * engine 解构后所有既有调用点（approvals.get/delete、jobs 遍历等）保持不变。
 * 模块级 `approvedRun`（基本类型 let）与 activeAgentRuns 留在 engine——
 * 前者与审批路由强耦合，后者与 pre-quit flush 逻辑强耦合。
 */
const { exec } = require('child_process');

// callId -> { resolve, timer }  等待前端审批
const approvals = new Map();
// v1.1.0（优化 Plan 模式）：用户提问等待队列——decId -> { resolve, timer, runId }，供 /api/agent/decision 回传答复
const decisionsPending = new Map();
// jobId -> { child, logs, desc }  后台命令
const jobs = new Map();
// v1.1.0（M3）：写前 Diff 审批的会话级授权——allow_file（按路径）/ allow_run（整个运行）
// v2（P1-4）：按 run 隔离——runAuthRegistry 存每个 Run 的授权状态（多 Run 并发不互漏）；模块级变量仅作未迁移兼容
const approvedFiles = new Set();
const runAuthRegistry = new Map(); // runId -> { approvedRun, approvedFiles }
// v1.1.0（M3）：长命令 Session——sessionId -> { child, logs, cursor, desc, code }
const sessions = new Map();

// 进程树终止：Windows taskkill /T /F；非 Win 负 pid 杀进程组
function killTree(child) {
  try {
    if (child && child.pid) {
      if (process.platform === 'win32') {
        exec('taskkill /PID ' + child.pid + ' /T /F', () => {});
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { try { child.kill('SIGTERM'); } catch (e2) {} }
      }
    } else if (child) { try { child.kill(); } catch (e) {} }
  } catch (e) {}
}

// B4（P2）：Run 中止/连接关闭时清理该 Run 的后台 job（jobs Map 条目 + 进程树），防止长驻命令泄漏
function killRunJobs(runId) {
  const id = String(runId || '');
  if (!id) return;
  for (const [jobId, job] of jobs) {
    if (job && job.runId === id) {
      try { killTree(job.child); } catch (_) {}
      jobs.delete(jobId);
    }
  }
}

function killRunSessions(runId) {
  const id = String(runId || '');
  if (!id) return;
  for (const [sessionId, session] of sessions) {
    if (session && session.runId === id) {
      try { killTree(session.child); } catch (_) {}
      sessions.delete(sessionId);
    }
  }
}

module.exports = { approvals, decisionsPending, jobs, approvedFiles, runAuthRegistry, sessions, killTree, killRunJobs, killRunSessions };
