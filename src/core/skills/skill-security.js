'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Registry = require('./skill-registry');

const KNOWN_TOOLS = new Set(['read_file','read_files','list_dir','glob','grep','get_repo_map','find_symbol','find_references','detect_verification','list_skill_resources','read_skill_resource','copy_skill_asset','run_skill_script','run_tests','run_lint','run_typecheck','run_build']);
const RISK_PATTERNS = [
  ['network', /\b(fetch\s*\(|https?:\/\/|curl\b|wget\b|socket\b|requests\.)/i],
  ['process', /\b(child_process|spawn\s*\(|exec\s*\(|subprocess\.|os\.system)/i],
  ['environment', /\b(process\.env|os\.environ|getenv\s*\()/i],
  ['sensitive-path', /(?:\.ssh|\.aws|AppData|Library\/Keychains|\/etc\/|\.config)/i],
  ['dynamic-code', /\b(eval\s*\(|new Function\s*\(|execfile\s*\()/i],
];

function parseAllowedTools(value) {
  if (Array.isArray(value)) return value.map(String);
  return String(value || '').split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}
function effectiveAllowedTools(declared, systemAllowed) {
  const requested = parseAllowedTools(declared).filter((name) => KNOWN_TOOLS.has(name));
  const system = new Set(Array.isArray(systemAllowed) ? systemAllowed : []);
  return requested.filter((name) => system.has(name));
}
function capabilityLabels(meta, resources, risks) {
  const labels = ['只读说明']; const list = Array.isArray(resources) ? resources : [];
  if (list.some((item) => item.kind === 'asset')) labels.push('工作区写入');
  if (list.some((item) => item.kind === 'script')) labels.push('进程执行');
  if ((risks || []).some((item) => item.type === 'network')) labels.push('网络访问');
  return labels;
}

function scanFiles(meta, files, packageHash) {
  const risks = [];
  for (const file of files) {
    const ext = path.extname(file.path).toLowerCase();
    if (file.path.startsWith('scripts/') && !['.js','.mjs','.cjs','.py','.sh'].includes(ext)) risks.push({ type: 'unknown-script', severity: 'high', path: file.path, message: '未知脚本扩展' });
    if (!file.path.startsWith('scripts/') || !['.js','.mjs','.cjs','.py','.sh'].includes(ext)) continue;
    const text = file.data.toString('utf8');
    for (const [type, pattern] of RISK_PATTERNS) if (pattern.test(text)) risks.push({ type, severity: type === 'network' || type === 'dynamic-code' ? 'high' : 'medium', path: file.path, message: type });
  }
  const resources = files.filter((item) => item.path !== 'SKILL.md').map((item) => ({ path: item.path, kind: item.path.startsWith('scripts/') ? 'script' : item.path.startsWith('assets/') ? 'asset' : item.path.startsWith('references/') ? 'reference' : 'other' }));
  return { packageHash, risks, score: risks.some((r) => r.severity === 'high') ? 'high' : risks.length ? 'medium' : 'low', capabilities: capabilityLabels(meta, resources, risks), allowedTools: parseAllowedTools(meta.allowedTools), resources };
}

async function scan(skillDir) {
  const meta = await Registry.readSkillMeta(skillDir); const files = await Registry.collectFiles(skillDir);
  return scanFiles(meta, files, await Registry.packageHash(skillDir));
}

function scanPackage(pkg) {
  const manifest = Registry.manifestFromPackage(pkg, {});
  const files = [];
  for (const [archivePath, data] of pkg.files.entries()) {
    const rel = pkg.prefix ? archivePath.slice(pkg.prefix.length) : archivePath;
    if (rel && !rel.endsWith('/')) files.push({ path: rel, data: Buffer.from(data) });
  }
  return scanFiles(pkg.skill, files, manifest.packageHash);
}

function trustRecord(input) {
  return { schemaVersion: 1, packageHash: String(input.packageHash || ''), source: String(input.source || ''), level: String(input.level || 'untrusted'), approvedAt: Date.now(), capabilities: Array.isArray(input.capabilities) ? input.capabilities : [] };
}
async function readTrust(skillDir) { try { return JSON.parse(await fsp.readFile(path.join(skillDir, Registry.TRUST_FILE), 'utf8')); } catch (_) { return null; } }
async function writeTrust(skillDir, input) { const value = trustRecord(input); const target = path.join(skillDir, Registry.TRUST_FILE); const temp = target + '.tmp-' + process.pid; await fsp.writeFile(temp, JSON.stringify(value, null, 2)); await fsp.rename(temp, target); return value; }
async function trustStatus(skillDir, packageHash) { const record = await readTrust(skillDir); if (!record) return { trusted: false, reason: 'untrusted' }; if (record.packageHash !== packageHash) return { trusted: false, reason: 'hash_changed', record }; return { trusted: record.level === 'version' || record.level === 'source', reason: record.level, record }; }

function versionTuple(value) { return String(value || '').match(/\d+/g)?.slice(0, 3).map(Number) || []; }
function versionAtLeast(actual, required) {
  const a = versionTuple(actual), r = versionTuple(required);
  for (let i = 0; i < Math.max(a.length, r.length); i++) { const av = a[i] || 0, rv = r[i] || 0; if (av !== rv) return av > rv; }
  return true;
}
function compatibility(meta, options) {
  const opts = Object.assign({ platform: process.platform, tangbaoVersion: '', executables: {} }, options || {}); const metadata = (meta && meta.metadata) || {}; const issues = [];
  const platforms = Array.isArray(metadata.platforms) ? metadata.platforms.map(String) : [];
  if (platforms.length && !platforms.includes(opts.platform)) issues.push({ code: 'platform', message: '不支持当前平台 ' + opts.platform });
  const minimum = String(metadata.minTangbaoVersion || metadata['min-tangbao-version'] || '');
  if (minimum && opts.tangbaoVersion && !versionAtLeast(opts.tangbaoVersion, minimum)) issues.push({ code: 'tangbao-version', required: minimum, actual: opts.tangbaoVersion, message: '需要糖包 ' + minimum + ' 或更高版本' });
  const runtimes = metadata.runtimes && typeof metadata.runtimes === 'object' ? metadata.runtimes : {};
  for (const name of Object.keys(runtimes)) if (!opts.executables[name]) issues.push({ code: 'runtime', runtime: name, required: String(runtimes[name]), message: '缺少运行时 ' + name });
  const env = Array.isArray(metadata.env) ? metadata.env.map(String) : [];
  return { ok: issues.length === 0, issues, requiredEnv: env, network: metadata.network || false, portable: !metadata.tangbaoOnly, declaredTools: parseAllowedTools(meta && meta.allowedTools) };
}

function triggerConflicts(skills) {
  const seen = new Map(); const output = [];
  for (const skill of skills || []) for (const trigger of skill.triggers || []) { const key = String(trigger).trim().toLowerCase(); if (!key) continue; if (seen.has(key) && seen.get(key) !== skill.name) output.push({ trigger, skills: [seen.get(key), skill.name] }); else seen.set(key, skill.name); }
  return output;
}

module.exports = { KNOWN_TOOLS, parseAllowedTools, effectiveAllowedTools, capabilityLabels, scanFiles, scan, scanPackage, trustRecord, readTrust, writeTrust, trustStatus, compatibility, triggerConflicts, versionAtLeast };
