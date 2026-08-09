'use strict';

const READ_ONLY_TOOLS = {
  explore: ['get_repo_map', 'read_file', 'read_files', 'get_file_outline', 'list_dir', 'glob', 'grep', 'find_symbol', 'find_references'],
  test: ['get_repo_map', 'read_file', 'read_files', 'list_dir', 'glob', 'grep', 'detect_verification', 'run_tests', 'run_lint', 'run_typecheck'],
  review: ['get_repo_map', 'read_file', 'read_files', 'list_dir', 'glob', 'grep', 'git_status', 'git_diff', 'git_log', 'git_changed_files', 'find_symbol', 'find_references'],
};

function create(options) {
  const opts = Object.assign({ maxDepth: 2, maxConcurrent: 3, maxChildren: 8 }, options || {});
  const records = new Map();
  const waiters = [];
  let active = 0;
  let counter = 0;

  function descriptor(input, parent) {
    const role = String(input.role || input.type || '');
    if (!READ_ONLY_TOOLS[role]) throw Object.assign(new Error('未知子任务角色：' + role), { code: 'invalid_role' });
    const depth = Number(parent && parent.depth || 0) + 1;
    if (depth > opts.maxDepth) throw Object.assign(new Error('超过子任务最大深度'), { code: 'max_depth' });
    const parentRunId = String(input.parentRunId || parent && parent.id || '');
    if (Array.from(records.values()).filter((item) => item.parentRunId === parentRunId).length >= opts.maxChildren) {
      throw Object.assign(new Error('超过该父任务的子任务数量上限'), { code: 'max_children' });
    }
    return {
      id: String(input.id || ('child_' + Date.now().toString(36) + '_' + (++counter))),
      parentRunId,
      role,
      depth,
      goal: String(input.goal || '').slice(0, 1000),
      allowedTools: READ_ONLY_TOOLS[role].slice(),
      readOnly: true,
      budget: Object.assign({ maxSteps: 8, maxTokens: 0 }, input.budget || {}),
      status: 'pending',
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0,
      result: null,
      error: '',
    };
  }

  function add(input, parent) {
    const item = descriptor(input, parent);
    records.set(item.id, item);
    return item;
  }

  // 保留直接 start 的“超过并发即报错”语义，兼容已有调用方；新的运行循环使用 waitForStart 排队。
  function start(id) {
    const item = records.get(id);
    if (!item) throw Object.assign(new Error('子任务不存在'), { code: 'not_found' });
    if (active >= opts.maxConcurrent) throw Object.assign(new Error('达到子任务并发上限'), { code: 'max_concurrent' });
    if (item.status !== 'pending') throw Object.assign(new Error('子任务状态不可启动'), { code: 'invalid_status' });
    item.status = 'running';
    item.startedAt = Date.now();
    active++;
    return item;
  }

  function drainQueue() {
    while (active < opts.maxConcurrent && waiters.length) {
      const waiter = waiters.shift();
      const item = records.get(waiter.id);
      if (!item || item.status === 'cancelled') { waiter.resolve(null); continue; }
      if (typeof waiter.shouldCancel === 'function' && waiter.shouldCancel()) {
        item.status = 'cancelled';
        item.error = 'parent_cancelled';
        item.finishedAt = Date.now();
        waiter.resolve(null);
        continue;
      }
      try {
        item.status = 'pending';
        waiter.resolve(start(item.id));
      } catch (_) { waiter.resolve(null); }
    }
  }

  function waitForStart(id, shouldCancel, onQueued) {
    const item = records.get(id);
    if (!item) return Promise.resolve(null);
    if (typeof shouldCancel === 'function' && shouldCancel()) {
      cancel(id, 'parent_cancelled');
      return Promise.resolve(null);
    }
    if (active < opts.maxConcurrent) return Promise.resolve(start(id));
    item.status = 'queued';
    if (typeof onQueued === 'function') {
      try { onQueued(item); } catch (_) {}
    }
    return new Promise((resolve) => {
      let settled = false;
      const finishWait = (value) => {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        resolve(value);
      };
      const watch = setInterval(() => {
        if (typeof shouldCancel === 'function' && shouldCancel()) {
          cancel(id, 'parent_cancelled');
          finishWait(null);
        }
      }, 100);
      watch.unref?.();
      waiters.push({ id, resolve: finishWait, shouldCancel });
    });
  }

  function finish(id, result, statusOverride) {
    const item = records.get(id);
    if (!item) return null;
    if (item.status === 'cancelled') return item;
    if (item.status === 'running') active = Math.max(0, active - 1);
    const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'degraded', 'blocked']);
    item.status = terminalStatuses.has(statusOverride)
      ? statusOverride
      : (result && result.ok === false ? 'failed' : 'completed');
    item.finishedAt = Date.now();
    item.result = result || null;
    item.error = result && result.ok === false ? String(result.summary || result.error || 'failed') : '';
    drainQueue();
    return item;
  }

  function cancel(id, reason) {
    const item = records.get(id);
    if (!item) return null;
    if (item.status === 'running') active = Math.max(0, active - 1);
    if (item.status === 'completed' || item.status === 'failed' || item.status === 'cancelled') return item;
    item.status = 'cancelled';
    item.error = String(reason || 'parent_cancelled');
    item.finishedAt = Date.now();
    drainQueue();
    return item;
  }

  function cancelByParent(parentRunId, reason) {
    const out = [];
    for (const item of records.values()) {
      if (item.parentRunId === parentRunId && (item.status === 'pending' || item.status === 'queued' || item.status === 'running')) out.push(cancel(item.id, reason));
    }
    return out;
  }

  function gate(parentRunId) {
    const items = Array.from(records.values()).filter((x) => x.parentRunId === parentRunId);
    return {
      pending: items.filter((x) => x.status === 'pending' || x.status === 'queued' || x.status === 'running'),
      failed: items.filter((x) => x.status === 'failed'),
      cancelled: items.filter((x) => x.status === 'cancelled'),
      completed: items.filter((x) => x.status === 'completed'),
    };
  }

  function snapshot() { return { schemaVersion: 2, options: Object.assign({}, opts), records: Array.from(records.values()).map((item) => JSON.parse(JSON.stringify(item))), active }; }

  function restore(saved) {
    records.clear();
    waiters.length = 0;
    active = 0;
    for (const raw of saved && saved.records || []) {
      const item = Object.assign({}, raw);
      if (item.status === 'running' || item.status === 'queued') item.status = 'pending';
      records.set(item.id, item);
    }
    return saved ? records.size : 0;
  }

  return {
    add, start, waitForStart, finish, cancel, cancelByParent, gate, snapshot, restore,
    isAtCapacity: () => active >= opts.maxConcurrent,
    activeCount: () => active,
    limits: () => Object.assign({}, opts),
    get: (id) => records.get(id),
    list: () => Array.from(records.values()),
  };
}

module.exports = { READ_ONLY_TOOLS, create };
