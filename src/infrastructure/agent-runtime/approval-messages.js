'use strict';
/*
 * approval-messages —— 审批/拒绝的模型可见文案构建（纯函数，v1.2.0 批次 7 第三刀自 engine 抽出）。
 * 语义逐字一致：区分超时/拒绝，引导模型调整方案而非原样重试；denyWithRecord 已统一返回
 * 结构化 ToolResult，「失败」前缀仅为文案习惯。
 */

/** 按被拒操作类别给出替代方向，引导模型调整方案而非原样重试 */
function denialSuggestion(action, detail) {
  const a = String(action || '');
  const d = String(detail || '').toLowerCase();
  if (/^git\s/.test(d)) return '请改用只读 git 操作（git status / git diff / git log）获取信息；确需写操作请先征得用户同意。';
  if (a.includes('命令')) return '请将命令拆分为更安全的只读命令，或改用已被允许的命令；不要原样重复申请。';
  if (a.includes('写') || a.includes('编辑') || a.includes('patch') || a.includes('文件')) return '请先读取目标文件确认修改点，缩小修改范围后再试；或改用其他文件/路径。';
  if (a.includes('搜索') || a.includes('web') || a.includes('联网')) return '请改用 read_file / glob / grep 读取本地信息，或关闭联网搜索后继续。';
  if (a.includes('执行') || a.includes('运行')) return '请用已被允许的验证方式（run_tests / run_lint）代替；不要重复被拒的命令。';
  return '请调整方案（例如改用其他文件/命令），不要原样重复申请。';
}

/** 审批结果 → 文案；批准返回 null */
function approvalMsg(ok, action, detail) {
  if (ok === 'timeout') return '失败：等待审批超时（90 秒内用户未响应），本次' + action + '未执行。可稍后重新尝试该操作，或改用无需审批的方式。';
  if (!ok) return '失败：用户拒绝了' + action + '。' + denialSuggestion(action, detail);
  return null;
}

module.exports = { denialSuggestion, approvalMsg };
