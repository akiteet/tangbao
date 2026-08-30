'use strict';

const crypto = require('crypto');
const TokenEstimator = require('../models/tokenizer');

const SUMMARY_VERSION = 2;
const CHECKPOINT_VERSION = 4;

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value || null)).digest('hex');
}

function list(value) { return Array.isArray(value) ? value : []; }
function text(value, max) {
  const out = value == null ? '' : String(value);
  return max > 0 && out.length > max ? out.slice(0, max) + '\n…（已截断）' : out;
}

function normalizeSummary(input) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    schemaVersion: SUMMARY_VERSION,
    requirements: list(src.requirements).map(String).filter(Boolean).slice(0, 20),
    constraints: list(src.constraints).map(String).filter(Boolean).slice(0, 20),
    completed: list(src.completed).slice(0, 50),
    pending: list(src.pending).slice(0, 50),
    files: list(src.files).slice(0, 100),
    decisions: list(src.decisions).slice(0, 50),
    checks: list(src.checks).slice(0, 50),
    errors: list(src.errors).slice(0, 30),
    nextSteps: list(src.nextSteps).map(String).filter(Boolean).slice(0, 20),
    sourceHashes: src.sourceHashes && typeof src.sourceHashes === 'object' ? src.sourceHashes : {},
    coveredFromSeq: Math.max(0, Number(src.coveredFromSeq) || 0),
    coveredToSeq: Math.max(0, Number(src.coveredToSeq) || 0),
    generatedAt: Number(src.generatedAt) || Date.now(),
  };
}

function summaryIsValid(summary, currentHashes) {
  const s = normalizeSummary(summary);
  if (s.coveredToSeq < s.coveredFromSeq) return { valid: false, stale: [], reason: 'invalid_event_range' };
  const stale = [];
  const hashes = currentHashes && typeof currentHashes === 'object' ? currentHashes : {};
  // B4（P2）：仅当调用方提供了非空哈希上下文时，sourceHashes 中已消失的文件（被删除/回滚）才判 stale；
  // 传空对象（恢复时未提供哈希集）保持原语义，避免误伤。
  const hasAnyHash = Object.keys(hashes).length > 0;
  for (const [file, expected] of Object.entries(s.sourceHashes)) {
    if (hasAnyHash && !Object.prototype.hasOwnProperty.call(hashes, file)) { stale.push(file); continue; }
    if (Object.prototype.hasOwnProperty.call(hashes, file) && hashes[file] !== expected) stale.push(file);
  }
  return { valid: stale.length === 0, stale, reason: stale.length ? 'source_hash_changed' : '' };
}

function summaryFromWorkingState(ws, range) {
  const state = ws || {};
  const sourceHashes = {};
  for (const item of list(state.filesRead).concat(list(state.filesChanged))) {
    if (item && item.path && (item.hash || item.afterHash)) sourceHashes[item.path] = item.afterHash || item.hash;
  }
  return normalizeSummary({
    requirements: state.goal ? [state.goal] : [], constraints: state.constraints,
    completed: state.completedWork, pending: state.pendingWork && state.pendingWork.length ? state.pendingWork : list(state.plan).filter((s) => s && s.status !== 'completed'),
    files: list(state.filesChanged).map((f) => ({ path: f.path, hash: f.afterHash || f.hash || '', restored: !!f.restored })),
    decisions: state.decisions, checks: state.checks, errors: state.unresolvedErrors,
    nextSteps: list(state.pendingWork).map((x) => x && (x.content || x.title || x)).filter(Boolean),
    sourceHashes, coveredFromSeq: range && range.from, coveredToSeq: range && range.to,
  });
}

function summaryToText(summary) {
  const s = normalizeSummary(summary);
  const lines = ['【结构化历史摘要 v2】'];
  const add = (name, value) => { if (value && value.length) lines.push(name + '：' + text(JSON.stringify(value), 2400)); };
  add('需求', s.requirements); add('约束', s.constraints); add('已完成', s.completed); add('待办', s.pending);
  add('文件与哈希', s.files); add('决策', s.decisions); add('验证', s.checks); add('未解决错误', s.errors); add('下一步', s.nextSteps);
  lines.push('覆盖事件：' + s.coveredFromSeq + '..' + s.coveredToSeq);
  return lines.join('\n');
}

function budgetForModel(contextWindow, options) {
  const opts = options || {};
  const window = Math.max(0, Number(contextWindow) || 0);
  const outputReserve = opts.outputReserve != null ? Math.max(0, Number(opts.outputReserve) || 0) : Math.max(1024, Math.floor(window * 0.1));
  const toolReserve = opts.toolReserve != null ? Math.max(0, Number(opts.toolReserve) || 0) : Math.max(1024, Math.floor(window * 0.12));
  const safetyReserve = opts.safetyReserve != null ? Math.max(0, Number(opts.safetyReserve) || 0) : Math.max(512, Math.floor(window * 0.05));
  const usable = Math.max(0, window - outputReserve - toolReserve - safetyReserve);
  return { contextWindow: window, outputReserve, toolReserve, safetyReserve, usable, precompress: Math.floor(usable * 0.72), hard: Math.floor(usable * 0.88), emergency: Math.floor(usable * 0.97) };
}

function decidePressure(tokenCount, budget) {
  const n = Math.max(0, Number(tokenCount) || 0);
  const b = budget || budgetForModel(0);
  if (!b.usable || n < b.precompress) return 'normal';
  if (n < b.hard) return 'precompress';
  if (n < b.emergency) return 'hard';
  return 'emergency';
}

function compactToolMessage(message, maxChars) {
  const copy = Object.assign({}, message);
  const raw = text(copy.content, 0);
  copy.content = raw.length > maxChars ? raw.slice(0, maxChars) + '\n…（大型工具结果已缩减；完整内容保存在事件/Artifact）' : raw;
  return copy;
}

function compactSystemMessage(message, maxChars) {
  const copy = Object.assign({}, message);
  const raw = text(copy.content, 0);
  if (raw.length <= maxChars) return copy;
  const notice = '\n\n…（系统上下文已按窗口预算压缩；完整 Skill 正文和资源仍可通过 use_skill/read_skill_resource 渐进读取）\n\n';
  const available = Math.max(1000, maxChars - notice.length);
  const head = Math.max(700, Math.floor(available * 0.72));
  const tail = Math.max(300, available - head);
  copy.content = raw.slice(0, head) + notice + raw.slice(-tail);
  return copy;
}

function rebuildSafeMessages(messages, options) {
  const opts = options || {};
  const source = list(messages);
  const maxSystemChars = Math.max(4000, Number(opts.maxSystemChars) || 16000);
  const system = source.filter((m) => m && m.role === 'system').map((m) => compactSystemMessage(m, maxSystemChars));
  const recentLimit = Math.max(4, Number(opts.recentLimit) || 12);
  // G5：工具结果独立预算——按预算预留（默认 toolReserve）从尾部保留最近工具消息，超预算丢弃并注明（完整内容在事件）
  const budget = opts.budget || budgetForModel(Number(opts.contextWindow) || 0, opts);
  const toolReserveChars = Math.max(2400, Number(opts.toolReserveChars) || budget.toolReserve || 0);
  const nonSystem = source.filter((m) => m && m.role !== 'system');
  const kept = [];
  let toolChars = 0;
  let droppedTool = false;
  for (let i = nonSystem.length - 1; i >= 0 && kept.length < recentLimit; i--) {
    const m = nonSystem[i];
    if (m.role === 'tool') {
      if (toolChars >= toolReserveChars) { droppedTool = true; continue; }
      const compacted = compactToolMessage(m, 2400);
      if (toolChars + compacted.content.length > toolReserveChars) { droppedTool = true; continue; }
      toolChars += compacted.content.length;
      kept.unshift(compacted);
    } else {
      kept.unshift(Object.assign({}, m, { content: text(m.content, 4000) }));
    }
  }
  const recent = kept;
  if (droppedTool) {
    recent.push({ role: 'tool', tool_call_id: '', content: '…（部分较早工具结果超出独立预算已省略；完整内容保存在事件记录）' });
  }
  const state = opts.workingState || {};
  const summary = opts.summary ? normalizeSummary(opts.summary) : summaryFromWorkingState(state, opts.eventRange);
  const context = {
    role: 'system',
    content: [
      '【上下文安全重建】窗口已达硬阈值。以下状态来自持久化 Working State/摘要，不得忽略：',
      'Goal：' + text(state.goal || opts.goal || '', 1000),
      'Plan：' + text(JSON.stringify(state.plan || []), 2400),
      'Pending：' + text(JSON.stringify(state.pendingWork || []), 1600),
      'Errors：' + text(JSON.stringify(state.unresolvedErrors || []), 1600),
      'Changes：' + text(JSON.stringify(state.filesChanged || []), 2000),
      summaryToText(summary),
    ].join('\n'),
  };
  const rebuilt = system.concat([context], recent);
  return { messages: rebuilt, summary, tokenCount: TokenEstimator.estimateTokens(rebuilt) };
}

// v1.2.1 批次 13c：窗口护栏增量估算——护栏每步前后各调一次（每个工具结果后还会再调），
// 旧实现每次对整份 messages 全量 JSON+BPE 计数（大上下文一次上百 ms 纯 CPU 串行阻塞）。
// 消息数组只会尾部追加（压缩重建时整体缩短→缓存自然失效），追加部分按消息逐条求和：
// 与整包 JSON 计数的差异仅为每条 1-2 个 JSON 分隔符 token，对 72%/88%/97% 压力阈值判定无影响。
const _windowTokenMemo = new WeakMap(); // messages 数组引用 -> { count, tokens }
function estimateWindowTokens(messages) {
  const arr = Array.isArray(messages) ? messages : null;
  if (!arr) return TokenEstimator.estimateTokens(messages);
  const cached = _windowTokenMemo.get(arr);
  if (cached && arr.length > cached.count) {
    let add = 0;
    for (let i = cached.count; i < arr.length; i++) add += TokenEstimator.estimateTokens(arr[i]);
    const tokens = cached.tokens + add;
    _windowTokenMemo.set(arr, { count: arr.length, tokens });
    return tokens;
  }
  const tokens = TokenEstimator.estimateTokens(arr);
  _windowTokenMemo.set(arr, { count: arr.length, tokens });
  return tokens;
}

function enforceWindow(messages, contextWindow, options) {
  const budget = budgetForModel(contextWindow, options);
  const beforeTokens = estimateWindowTokens(messages);
  const pressure = decidePressure(beforeTokens, budget);
  if (pressure === 'normal' || pressure === 'precompress') return { triggered: false, pressure, messages, budget, beforeTokens, afterTokens: beforeTokens };
  const opts = Object.assign({}, options || {});
  if (opts.maxSystemChars == null && budget.hard > 0) opts.maxSystemChars = Math.max(4000, Math.floor(budget.hard * 2.2));
  const rebuilt = rebuildSafeMessages(messages, Object.assign({}, opts, { budget }));
  return { triggered: true, pressure, messages: rebuilt.messages, summary: rebuilt.summary, budget, beforeTokens, afterTokens: rebuilt.tokenCount, shouldStop: pressure === 'emergency' && rebuilt.tokenCount > budget.hard };
}

function normalizeRootScope(scope) {
  const src = scope && typeof scope === 'object' ? scope : {};
  const mode = ['primary', 'single', 'all'].includes(src.mode) ? src.mode : 'primary';
  return { mode, rootId: mode === 'single' ? String(src.rootId || '') : '' };
}

function buildCheckpoint(state, options) {
  const opts = options || {};
  const snapshot = {
    schemaVersion: CHECKPOINT_VERSION,
    phase: opts.phase || 'understanding',
    workspaceId: opts.workspaceId || '', cwd: opts.cwd || '',
    workspaceFingerprint: opts.workspaceFingerprint || '', primaryRootId: opts.primaryRootId || '',
    workspaceSnapshot: opts.workspaceSnapshot || null,
    rootScope: normalizeRootScope(opts.rootScope), allowedRootIds: list(opts.allowedRootIds).map(String).filter(Boolean),
    workingState: state || {}, summaryRef: opts.summaryRef || '',
    eventsToSeq: Math.max(0, Number(opts.eventsToSeq) || 0),
    sourceHashes: opts.sourceHashes || {}, nextStep: opts.nextStep || '', createdAt: Date.now(),
  };
  snapshot.checksum = sha256(Object.assign({}, snapshot, { checksum: undefined }));
  return snapshot;
}

function validateCheckpoint(checkpoint, current) {
  const cp = checkpoint && typeof checkpoint === 'object' ? checkpoint : {};
  const now = current || {};
  const stale = [];
  if (!cp.schemaVersion) return { valid: false, stale, reason: 'checkpoint_version_missing' };
  if (cp.checksum) {
    const actual = sha256(Object.assign({}, cp, { checksum: undefined }));
    if (actual !== cp.checksum) return { valid: false, stale, reason: 'checkpoint_checksum_mismatch' };
  }
  if (cp.workspaceId && now.workspaceId && cp.workspaceId !== now.workspaceId) return { valid: false, stale, reason: 'workspace_changed' };
  if (cp.workspaceFingerprint && now.workspaceFingerprint && cp.workspaceFingerprint !== now.workspaceFingerprint) return { valid: false, stale, reason: 'workspace_roots_changed' };
  if (cp.schemaVersion < 3 && cp.cwd && now.cwd && cp.cwd !== now.cwd) return { valid: false, stale, reason: 'cwd_changed' };
  if (cp.schemaVersion >= 4 && now.rootScope) {
    const expectedScope = normalizeRootScope(cp.rootScope);
    const actualScope = normalizeRootScope(now.rootScope);
    if (JSON.stringify(expectedScope) !== JSON.stringify(actualScope)) return { valid: false, stale, reason: 'root_scope_changed' };
    const expectedRoots = list(cp.allowedRootIds).map(String).sort();
    const actualRoots = list(now.allowedRootIds).map(String).sort();
    if (JSON.stringify(expectedRoots) !== JSON.stringify(actualRoots)) return { valid: false, stale, reason: 'allowed_roots_changed' };
  }
  for (const [file, expected] of Object.entries(cp.sourceHashes || {})) {
    if (now.sourceHashes && Object.prototype.hasOwnProperty.call(now.sourceHashes, file) && now.sourceHashes[file] !== expected) stale.push(file);
  }
  return { valid: stale.length === 0, stale, reason: stale.length ? 'source_hash_changed' : '' };
}

module.exports = { SUMMARY_VERSION, CHECKPOINT_VERSION, sha256, normalizeRootScope, normalizeSummary, summaryIsValid, summaryFromWorkingState, summaryToText, budgetForModel, decidePressure, rebuildSafeMessages, enforceWindow, buildCheckpoint, validateCheckpoint };
