'use strict';

const Security = require('./skill-security');

function activation(skill, mode) {
  const item = skill || {};
  return {
    name: String(item.name || ''),
    level: String(item.level || ''),
    packageHash: String(item.packageHash || ''),
    activation: mode === 'explicit' ? 'explicit' : (mode === 'tool' ? 'tool' : 'auto'),
    trusted: item.trusted === true,
    trustLevel: String(item.trustLevel || ''),
    declaredTools: Security.parseAllowedTools(item.allowedTools),
  };
}

function dedupe(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !item.name) continue;
    const previous = map.get(item.name);
    if (!previous || previous.activation !== 'explicit') map.set(item.name, item);
  }
  return Array.from(map.values());
}

function publicContext(items) {
  return dedupe(items).map((item) => ({
    name: item.name,
    level: item.level,
    packageHash: item.packageHash,
    activation: item.activation,
    trusted: item.trusted,
    trustLevel: item.trustLevel,
    declaredTools: Array.isArray(item.declaredTools) ? item.declaredTools.slice() : [],
  }));
}

function attributeTool(items, toolName, systemAllowed) {
  const active = dedupe(items);
  const system = new Set(Array.isArray(systemAllowed) ? systemAllowed : []);
  const declared = active.filter((item) => Array.isArray(item.declaredTools) && item.declaredTools.length);
  const allowedBy = declared.filter((item) => item.declaredTools.includes(toolName)).map((item) => item.name);
  const deniedBy = declared.filter((item) => !item.declaredTools.includes(toolName)).map((item) => item.name);
  const systemAllowedTool = system.size === 0 || system.has(toolName);
  const allowed = systemAllowedTool && (declared.length === 0 || allowedBy.length > 0);
  return {
    toolName: String(toolName || ''),
    allowed,
    reason: !systemAllowedTool ? 'system_denied' : (declared.length && !allowedBy.length ? 'skill_not_declared' : 'allowed'),
    activeSkills: active.map((item) => item.name),
    allowedBy,
    deniedBy,
    declaredPolicy: declared.length > 0,
  };
}

function appendActivation(items, skill, mode) {
  return dedupe((Array.isArray(items) ? items : []).concat([activation(skill, mode)]));
}

module.exports = { activation, dedupe, publicContext, attributeTool, appendActivation };
