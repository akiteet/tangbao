'use strict';
/*
 * tool-result-format —— 工具结果的归一化与模型可见文本格式化（纯函数，无外部依赖）。
 * v1.2.0 批次 7 第二刀自 agent-runtime-engine.js 抽出；语义与原实现逐字一致
 * （含批次 5-③D 的两处修复：空串 summary 兜底 error.message、裸字符串兜底分支降级为防御+warn）。
 */

function normalizeResult(inner, meta) {
  meta = meta || {};
  const base = { ok: true, summary: '', durationMs: meta.durationMs || 0 };
  let r;
  if (inner && typeof inner === 'object' && 'ok' in inner) {
    r = Object.assign(base, inner);
    // v1.2.0 批次 2 修复：空串 summary 同样触发兜底（原 == null 判不出 ''，失败结果模型看不到原因）
    if (!r.summary && r.error && r.error.message) r.summary = r.error.message;
  } else {
    const s = String(inner == null ? '' : inner);
    // v1.2.0 批次 7 收尾：仓内工具已全部返回结构化 ToolResult，本分支仅作旧式返回的兜底防御。
    // 前缀判定保留以防第三方路径回归；触发即打 warn 提醒改为对象返回。
    const bad = /^(失败|拒绝|错误|未找到|无效|为空|越界|已取消|搜索关键词为空|命令为空|模式为空|正则无效|读取失败|路径越界|工具执行出错|工具执行失败)/.test(s);
    if (!bad) try { console.warn('[engine] 工具返回了裸字符串（旧式），建议改为 { ok, summary } 对象：' + s.slice(0, 60)); } catch (_) {}
    r = Object.assign(base, { ok: !bad, summary: s });
    if (bad) r.error = { code: 'tool_error', message: s, retryable: false };
  }
  if (meta.exitCode != null && r.exitCode == null) r.exitCode = meta.exitCode;
  if (meta.truncated && !r.truncated) r.truncated = true;
  if (meta.artifactRef) r.artifactRef = meta.artifactRef;
  if (meta.changedFiles) r.changedFiles = meta.changedFiles;
  // v2（补全 2+3）：readFiles / nextCursor 提升到顶层（模型可结构化判断读取范围与续读）
  if (r.data && Array.isArray(r.data.readFiles) && !r.readFiles) r.readFiles = r.data.readFiles;
  if (r.nextCursor == null && r.data && r.data.cursor != null && r.data.nextStartLine != null) r.nextCursor = r.data.nextStartLine;
  else if (r.nextCursor == null && r.data && r.data.cursor != null) r.nextCursor = r.data.cursor;
  if (r.ok === false && !r.error) r.error = { code: 'tool_error', message: r.summary || '工具执行失败', retryable: false };
  return r;
}

// 把结构化 ToolResult 转成模型 messages 里的纯文本（保留截断/退出码提示）
function formatToolResult(r) {
  if (!r || typeof r !== 'object') return String(r == null ? '' : r);
  let s = r.summary || '';
  if (r.ok === false && r.error && r.error.message) {
    const code = r.error.code ? '（' + r.error.code + '）' : '';
    const retry = r.error.retryable === false ? '\n[不可原样重试] 请根据错误调整方案、参数或阶段，不要机械重复同一工具调用。' : '\n[可重试] 先修正触发原因，再重试。';
    s = r.error.message + code + retry;
  }
  if (r.truncated) s += '\n[输出已截断' + (r.nextCursor ? '，可用 read_command_output / cursor 继续读取' : '') + ']';
  if (r.exitCode != null) s += '\n[退出码 ' + r.exitCode + ']';
  return s;
}

module.exports = { normalizeResult, formatToolResult };
