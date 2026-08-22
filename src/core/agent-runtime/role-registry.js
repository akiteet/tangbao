'use strict';

const crypto = require('crypto');

const DEFAULT_ROLES = Object.freeze([
  { name: 'explore', version: '1.0.0', readOnly: true, capabilities: ['workspace.read', 'repo.inspect'], tools: ['get_repo_map', 'read_file', 'read_files', 'get_file_outline', 'list_dir', 'glob', 'grep'] },
  { name: 'test', version: '1.0.0', readOnly: true, capabilities: ['workspace.read', 'repo.inspect', 'verification.run'], tools: ['get_repo_map', 'read_file', 'list_dir', 'glob', 'grep', 'detect_verification', 'run_tests', 'run_lint', 'run_typecheck'] },
  { name: 'review', version: '1.0.0', readOnly: true, capabilities: ['workspace.read', 'repo.inspect', 'git.read'], tools: ['get_repo_map', 'read_file', 'list_dir', 'glob', 'grep', 'git_status', 'git_diff', 'git_log', 'git_changed_files'] },
]);

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

class RoleRegistry {
  constructor(roles) {
    this.roles = new Map();
    for (const role of roles || DEFAULT_ROLES) this.register(role);
  }

  register(input) {
    const role = input || {};
    const name = String(role.name || '').trim();
    if (!name) throw Object.assign(new Error('role_name_required'), { code: 'role_name_required' });
    if (this.roles.has(name)) throw Object.assign(new Error('role_already_registered: ' + name), { code: 'role_already_registered' });
    const normalized = Object.freeze({
      name,
      version: String(role.version || '1.0.0'),
      promptVersion: String(role.promptVersion || '1.0.0'),
      readOnly: role.readOnly !== false,
      capabilities: Object.freeze(Array.from(new Set(Array.isArray(role.capabilities) ? role.capabilities.map(String) : []))),
      tools: Object.freeze(Array.from(new Set(Array.isArray(role.tools) ? role.tools.map(String) : []))),
      description: String(role.description || ''),
    });
    this.roles.set(name, normalized);
    return normalized;
  }

  resolve(name) { return this.roles.get(String(name || '')) || null; }

  list(filter) {
    const f = filter || {};
    return Array.from(this.roles.values()).filter((role) => {
      if (f.name && role.name !== f.name) return false;
      if (f.readOnly != null && role.readOnly !== !!f.readOnly) return false;
      if (f.capability && !role.capabilities.includes(f.capability)) return false;
      return true;
    });
  }

  toolsFor(name, toolRegistry) {
    const role = this.resolve(name);
    if (!role) return [];
    return role.tools.map((toolName) => toolRegistry && toolRegistry.resolve(toolName, { role: role.name, capabilities: role.capabilities, readOnly: role.readOnly }) || null).filter(Boolean);
  }

  protocolToolsFor(name, toolRegistry) {
    return this.toolsFor(name, toolRegistry).map((definition) => ({ type: 'function', function: { name: definition.name, description: definition.description || '', parameters: JSON.parse(JSON.stringify(definition.inputSchema || { type: 'object', properties: {} })) } }));
  }

  snapshot() {
    const roles = this.list().map((role) => ({ name: role.name, version: role.version, promptVersion: role.promptVersion, readOnly: role.readOnly, capabilities: role.capabilities.slice(), tools: role.tools.slice() }));
    return { version: '1.1.7', fingerprint: crypto.createHash('sha256').update(stable(roles)).digest('hex'), roles };
  }
}

module.exports = { RoleRegistry, DEFAULT_ROLES };
