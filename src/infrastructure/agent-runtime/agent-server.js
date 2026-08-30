'use strict';

/**
 * Public Agent Server adapter.
 *
 * HTTP/SSE, authentication, and dependency injection remain behind the
 * runtime engine boundary. Keeping this module small preserves the historic
 * import path used by the Electron main process and standalone server CLI.
 */
const runtime = require('./agent-runtime-engine');

module.exports = {
  startAgentServer: runtime.startAgentServer,
  configureAgentServer: runtime.configureAgentServer,
  flushActiveAgentRuns: runtime.flushActiveAgentRuns,
  hasActiveAgentRuns: runtime.hasActiveAgentRuns,
  runAgent: runtime.runAgent,
  scanSkills: runtime.scanSkills,
  loadSkillGuides: runtime.loadSkillGuides,
  findEnabledSkill: runtime.findEnabledSkill,
  matchRule: runtime.matchRule,
  needsApproval: runtime.needsApproval,
  sandboxBlocked: runtime.sandboxBlocked,
  approvalMsg: runtime.approvalMsg,
  parsePatch: runtime.parsePatch,
  applyPatchToContent: runtime.applyPatchToContent,
  validateExpectedHashes: runtime.validateExpectedHashes,
  lineDiff: runtime.lineDiff,
  setAgentEventObserver: runtime.setAgentEventObserver, // v1.2.1 批次 12：桌面宠物 AI 事件桥
};

if (require.main === module) {
  runtime.startAgentServer(Number(process.env.PORT) || 3000);
}
