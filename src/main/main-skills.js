'use strict';
/* 自 main.js 拆分（v1.1.7 批次 E）：技能面板 IPC（v4）——renderer 无文件写权限，经主进程执行。
 * 依赖经 registerMainSkills(deps) 注入：safeHandle / app / getStorageService / getMainWindow。 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const SkillPackage = require('../core/skills/skill-package');
const SkillRegistry = require('../core/skills/skill-registry');

function userSkillsDirsList(app) {
  return [
    path.join(app.getPath('userData'), 'tangbao-data', 'skills'),
    path.join(os.homedir(), '.tangbao-skills'),
    path.join(os.homedir(), '.workbuddy', 'skills'),
  ];
}

function registerMainSkills(deps) {
  const { safeHandle, app, getStorageService, resolveWorkspace } = deps;
  const mainWindow = () => (deps.getMainWindow ? deps.getMainWindow() : null);

/* ---------- v4（技能面板）：技能导入 / 启停（renderer 无文件写权限，经主进程执行） ---------- */
const SKILL_NAME_RE = /^[\p{L}\p{N}_-]{1,64}$/u; // v2（ZIP 兼容）：允许中文等 Unicode 名称，仍拒绝路径/引号等非法字符
const projectSkillRoots = (cwd) => cwd ? [
  path.join(cwd, '.workbuddy', 'skills'),
  path.join(cwd, '.tangbao-skills'),
  path.join(cwd, '.claude', 'skills'),
  path.join(cwd, '.codex', 'skills'),
] : [];
const projectSkillTargetRoot = (cwd) => path.join(cwd, '.workbuddy', 'skills');
const canonicalExistingPath = (value) => {
  const resolved = path.resolve(String(value || ''));
  try { return fs.realpathSync.native(resolved); } catch (_) { return resolved; }
};
const isDirectChildOf = (target, root) => {
  const resolvedTarget = canonicalExistingPath(target);
  const resolvedRoot = canonicalExistingPath(root);
  // B5（P2）：Windows 盘符大小写归一——realpathSync.native 可能返回不同大小写盘符，直接 === 比较会误判
  const norm = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : p);
  return norm(path.dirname(resolvedTarget)) === norm(resolvedRoot) && norm(resolvedTarget) !== norm(resolvedRoot);
};
// 设置页只读列举：直接走主进程，避免依赖糖码后端端口与本地启动令牌。
// v2（统一热刷新）：任何生命周期变更（导入/卸载/移动/恢复/彻底删除/启停/信任/自动触发）后广播，
// renderer 收到后立即刷新设置面板与糖码 / 菜单技能缓存，无需重启。
const broadcastSkillChanged = () => {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('skills:changed', { at: Date.now() }); } catch (_) {}
  }
};
safeHandle('skills:list', async (_e, workspaceId) => {
  try {
    let cwd = '';
    if (workspaceId) {
      const ws = resolveWorkspace(String(workspaceId));
      if (!ws) return { ok: false, error: '无效的工作区标识', skills: [] };
      cwd = ws.cwd;
    }
    // 完整管理枚举不去重：管理页必须显示被覆盖的项目/用户/内置同名实例；Runtime 仍按既有 scanSkills 优先级选生效项。
    const managed = await SkillRegistry.enumerateInstalled(managedSkillRoots(workspaceId));
    const builtinRoot = path.join(__dirname, '..', 'infrastructure', 'agent-runtime', 'skills');
    const builtin = await SkillRegistry.enumerateInstalled([{ scope: 'builtin', dir: builtinRoot }]);
    const all = managed.map((m) => ({ name: m.name, description: m.description, level: m.scope, scope: m.scope, dir: m.dir, enabled: m.enabled }))
      .concat(builtin.map((s) => ({ name: s.name, description: s.description, level: 'builtin', scope: 'builtin', dir: s.dir, enabled: s.enabled !== false })));
    const orderedRoots = [];
    if (cwd) projectSkillRoots(cwd).forEach((dir, index) => orderedRoots.push({ scope: 'project', dir, label: ['项目 .workbuddy', '项目 .tangbao', '项目 .claude', '项目 .codex'][index] || '项目 Skill' }));
    userSkillsDirsList(app).forEach((dir, index) => orderedRoots.push({ scope: 'user', dir, label: ['糖包用户目录', '用户 .tangbao', '用户 .workbuddy'][index] || '用户 Skill' }));
    orderedRoots.push({ scope: 'builtin', dir: builtinRoot, label: '内置 Skill' });
    const resolvedAll = SkillRegistry.annotateDuplicateResolution(all, orderedRoots);
    const conflicts = SkillSecurity.triggerConflicts(resolvedAll);
    const skills = await Promise.all(resolvedAll.map(async (s) => {
      let manifest = null, security = null, trust = null;
      try { manifest = await SkillRegistry.readManifest(s.dir); } catch (_) {}
      try { security = await SkillSecurity.scan(s.dir); trust = await SkillSecurity.trustStatus(s.dir, security.packageHash); } catch (_) {}
      return {
        name: s.name, description: s.description, level: s.level, dir: s.dir, enabled: s.enabled,
        version: (manifest && manifest.version) || String((s.metadata && s.metadata.version) || ''),
        license: (manifest && manifest.license) || s.license || '', compatibility: (manifest && manifest.compatibility) || s.compatibility || '',
        sourceType: manifest && manifest.sourceType || (s.level === 'builtin' ? 'builtin' : 'directory'), sourcePath: manifest && manifest.sourcePath || '',
        installedAt: manifest && manifest.installedAt || 0, updatedAt: manifest && manifest.updatedAt || 0, autoTrigger: !manifest || manifest.autoTrigger !== false,
        packageHash: security && security.packageHash || (manifest && manifest.packageHash) || '',
        resources: security && security.resources || s.resources || [], capabilities: security && security.capabilities || [],
        risk: security && security.score || 'unknown', risks: security && security.risks || [], trusted: !!(trust && trust.trusted), trustReason: trust && trust.reason || 'untrusted',
        allowedTools: s.allowedTools || '', triggerConflicts: conflicts.filter((item) => item.skills.includes(s.name)),
        duplicateCount: Number(s.duplicateCount) || 1,
        effective: s.effective === true,
        resolution: String(s.resolution || (s.enabled === false ? 'disabled' : 'effective')),
        priorityLabel: String(s.priorityLabel || ''),
        coveredBy: s.coveredBy || null,
      };
    }));
    const external = cwd ? await SkillRegistry.detectExternalSkills(cwd) : [];
    return { ok: true, skills, external, conflicts };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), skills: [] };
  }
});

// 可管理范围只接受已知用户/项目 Skill 根下的直接单个目录；禁止把工作区其他任意子目录当成 Skill 操作。
const isAllowedSkillDir = (dir, workspaceId, scope) => {
  const roots = [];
  const expectedScope = String(scope || '');
  if (!expectedScope || expectedScope === 'user') roots.push(...userSkillsDirsList(app));
  if (!expectedScope || expectedScope === 'project') {
    if (workspaceId) {
      const ws = resolveWorkspace(String(workspaceId));
      if (ws && ws.cwd) roots.push(...projectSkillRoots(ws.cwd));
    } else {
      for (const v of workspaceRegistry.values()) roots.push(...projectSkillRoots(v && v.cwd));
    }
  }
  return roots.some((root) => isDirectChildOf(dir, root));
};
// v2（生命周期）：完整管理根——用户级两个目录 + 项目级标准/兼容技能目录。
// workspaceId 非空时项目根只含该工作区（列表/管理均限定当前项目上下文）；为空时包含全部已登记工作区。
// 与运行时 scanSkills 分离：管理枚举不去重、不要求目录名=name，保证被覆盖实例与别名目录可管理。
const managedSkillRoots = (workspaceId) => {
  const roots = [];
  for (const base of userSkillsDirsList(app)) roots.push({ scope: 'user', dir: base });
  const pushProject = (cwd) => {
    for (const dir of projectSkillRoots(cwd)) roots.push({ scope: 'project', dir });
  };
  if (workspaceId) {
    const ws = resolveWorkspace(workspaceId);
    if (ws && ws.cwd) pushProject(ws.cwd);
  } else {
    for (const v of workspaceRegistry.values()) pushProject(v && v.cwd);
  }
  return roots;
};
async function resolveManagedSkill(payload) {
  const name = String((payload && payload.name) || '').trim();
  const workspaceId = String((payload && payload.workspaceId) || '');
  const requestedScope = String((payload && (payload.scope || payload.level)) || '');
  if (requestedScope && !['user', 'project'].includes(requestedScope)) throw Object.assign(new Error('无效的 Skill 作用域'), { code: 'invalid_skill_scope' });
  let cwd = '';
  if (workspaceId) {
    const ws = resolveWorkspace(workspaceId);
    if (!ws) throw Object.assign(new Error('无效的工作区标识'), { code: 'invalid_workspace' });
    cwd = ws.cwd;
  }
  // 完整管理枚举（不去重）：name + dir 精确匹配；dir 缺失时按 name 兜底。
  const rows = await SkillRegistry.enumerateInstalled(managedSkillRoots(workspaceId));
  const requestedDirRaw = String((payload && payload.dir) || '').trim();
  const requestedDir = requestedDirRaw ? canonicalExistingPath(requestedDirRaw) : '';
  let match = rows.find((item) => item.name === name && (!requestedDir || canonicalExistingPath(item.dir) === requestedDir) && (!requestedScope || item.scope === requestedScope));
  if (!match && requestedDir) match = rows.find((item) => canonicalExistingPath(item.dir) === requestedDir && (!requestedScope || item.scope === requestedScope));
  if (!match) throw Object.assign(new Error('未找到可管理的 Skill：' + name), { code: 'skill_not_found' });
  if (!isAllowedSkillDir(match.dir, workspaceId, match.scope)) throw Object.assign(new Error('内置或范围外 Skill 为只读，不能执行该操作'), { code: 'skill_read_only' });
  const meta = await SkillRegistry.readSkillMeta(match.dir);
  return {
    skill: { name: meta.name, level: match.scope, dir: match.dir, enabled: match.enabled },
    meta,
    cwd,
  };
}
safeHandle('skills:import', async (_e, payload) => {
  const scope = String((payload && payload.scope) || 'user');
  const workspaceId = String((payload && payload.workspaceId) || '');
  let targetRoot;
  if (scope === 'project') {
    const ws = workspaceId ? resolveWorkspace(workspaceId) : null;
    if (!ws || !ws.cwd) return { ok: false, error: '请先打开有效项目，再导入项目级 Skill' };
    targetRoot = projectSkillTargetRoot(ws.cwd);
  } else if (scope === 'user') {
    targetRoot = userSkillsDirsList(app)[0];
  } else {
    return { ok: false, error: '无效的 Skill 安装范围' };
  }
  try {
    const picked = await dialog.showOpenDialog(mainWindow(), {
      title: scope === 'project' ? '导入项目 Skill' : '导入用户 Skill',
      properties: ['openFile'],
      filters: [
        { name: 'Agent Skill', extensions: ['zip', 'md'] },
        { name: 'Skill 完整包', extensions: ['zip'] },
        { name: 'SKILL.md', extensions: ['md'] },
      ],
    });
    if (picked.canceled || !picked.filePaths || !picked.filePaths[0]) return { ok: false, canceled: true };
    const sourcePath = picked.filePaths[0];
    const skillPackage = await SkillPackage.packageForSource(sourcePath);
    const incomingManifest = SkillRegistry.manifestFromPackage(skillPackage, { scope, sourceType: skillPackage.sourceType, sourcePath });
    const incomingSecurity = SkillSecurity.scanPackage(skillPackage);
    const compatibility = SkillSecurity.compatibility(skillPackage.skill, { platform: process.platform, tangbaoVersion: app.getVersion(), executables: { node: process.execPath } });
    const targetDir = path.join(targetRoot, skillPackage.skill.name);
    let replace = false;
    if (fs.existsSync(targetDir)) {
      const currentManifest = await SkillRegistry.readManifest(targetDir) || await SkillRegistry.buildManifest(targetDir, { scope });
      const diff = SkillRegistry.diffManifests(currentManifest, incomingManifest);
      const lines = [
        '新增 ' + diff.added.length + ' / 修改 ' + diff.changed.length + ' / 删除 ' + diff.removed.length,
        diff.addedScripts.length ? '新增脚本：' + diff.addedScripts.join('、') : '没有新增脚本',
        '风险等级：' + incomingSecurity.score + '；兼容性：' + (compatibility.ok ? '通过' : compatibility.issues.map((item) => item.message).join('；')),
      ];
      const confirm = await dialog.showMessageBox(mainWindow(), {
        type: incomingSecurity.score === 'high' ? 'warning' : 'question',
        title: '替换同名 Skill',
        message: 'Skill「' + skillPackage.skill.name + '」已存在',
        detail: lines.join('\n'),
        buttons: ['取消', '替换'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (confirm.response !== 1) return { ok: false, canceled: true };
      replace = true;
    } else if (incomingSecurity.score !== 'low' || !compatibility.ok) {
      const confirm = await dialog.showMessageBox(mainWindow(), {
        type: 'warning', title: '确认安装 Skill', message: 'Skill「' + skillPackage.skill.name + '」需要确认',
        detail: '风险等级：' + incomingSecurity.score + '\n能力：' + incomingSecurity.capabilities.join('、') + '\n兼容性：' + (compatibility.ok ? '通过' : compatibility.issues.map((item) => item.message).join('；')),
        buttons: ['取消', '仍然安装'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (confirm.response !== 1) return { ok: false, canceled: true };
    }
    const installed = await SkillPackage.installPackage(skillPackage, targetRoot, { replace });
    const manifest = await SkillRegistry.writeManifest(installed.dir, { scope, sourceType: skillPackage.sourceType, sourcePath });
    broadcastSkillChanged();
    return Object.assign({ ok: true, scope, manifest, risk: incomingSecurity.score, compatibility }, installed);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code ? e.code : 'skill_import_failed' };
  }
});
safeHandle('skills:details', async (_e, payload) => {
  try {
    const managed = await resolveManagedSkill(payload);
    const manifest = await SkillRegistry.readManifest(managed.skill.dir) || await SkillRegistry.buildManifest(managed.skill.dir, { scope: managed.skill.level });
    const security = await SkillSecurity.scan(managed.skill.dir);
    const trust = await SkillSecurity.trustStatus(managed.skill.dir, security.packageHash);
    const compatibility = SkillSecurity.compatibility(managed.meta, { platform: process.platform, tangbaoVersion: app.getVersion(), executables: { node: process.execPath } });
    return {
      ok: true,
      skill: managed.skill,
      identity: { name: managed.skill.name, dir: managed.skill.dir, scope: managed.skill.level, workspaceId: String((payload && payload.workspaceId) || '') },
      manifest, security, trust, compatibility,
      capabilities: { edit: true, reveal: true, toggle: true, uninstall: true },
    };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
safeHandle('skills:edit', async (_e, payload) => {
  try {
    const managed = await resolveManagedSkill(payload);
    const enabledPath = path.join(managed.skill.dir, 'SKILL.md');
    const disabledPath = path.join(managed.skill.dir, 'SKILL.md.disabled');
    const target = fs.existsSync(enabledPath) ? enabledPath : disabledPath;
    if (!fs.existsSync(target)) return { ok: false, error: 'Skill 缺少可编辑的 SKILL.md' };
    const result = await shell.openPath(target);
    return result ? { ok: false, error: result } : { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
safeHandle('skills:reveal', async (_e, payload) => {
  try {
    const managed = await resolveManagedSkill(payload);
    const target = fs.existsSync(path.join(managed.skill.dir, 'SKILL.md'))
      ? path.join(managed.skill.dir, 'SKILL.md')
      : path.join(managed.skill.dir, 'SKILL.md.disabled');
    shell.showItemInFolder(target);
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
safeHandle('skills:export', async (_e, payload) => {
  try {
    const managed = await resolveManagedSkill(payload);
    const picked = await dialog.showSaveDialog(mainWindow(), { title: '导出标准 Skill ZIP', defaultPath: managed.skill.name + '.zip', filters: [{ name: 'Skill ZIP', extensions: ['zip'] }] });
    if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
    return await SkillRegistry.exportStandardZip(managed.skill.dir, picked.filePath);
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
safeHandle('skills:uninstall', async (_e, payload) => {
  try {
    const managed = await resolveManagedSkill(payload);
    const confirm = await dialog.showMessageBox(mainWindow(), { type: 'warning', title: '卸载 Skill', message: '卸载「' + managed.skill.name + '」？', detail: 'Skill 将移入糖包隔离目录，不会永久删除。', buttons: ['取消', '卸载'], defaultId: 0, cancelId: 0, noLink: true });
    if (confirm.response !== 1) return { ok: false, canceled: true };
    const quarantine = path.join(app.getPath('userData'), 'tangbao-data', 'skill-quarantine');
    const result = await SkillRegistry.uninstall(managed.skill.dir, quarantine);
    broadcastSkillChanged();
    return result;
  } catch (e) { console.error('[skills:uninstall]', e); return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
safeHandle('skills:quarantine', async () => {
  try {
    const quarantine = path.join(app.getPath('userData'), 'tangbao-data', 'skill-quarantine');
    const list = await SkillRegistry.listQuarantine(quarantine);
    return { ok: true, items: list };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) }; }
});
safeHandle('skills:restore', async (_e, payload) => {
  try {
    const quarantinePath = String((payload && payload.quarantinePath) || '');
    if (!quarantinePath) return { ok: false, error: '缺少隔离路径' };
    const quarantine = path.resolve(path.join(app.getPath('userData'), 'tangbao-data', 'skill-quarantine'));
    const target = path.resolve(quarantinePath);
    if (target !== quarantine && !target.startsWith(quarantine + path.sep)) return { ok: false, error: '非法隔离路径' };
    // v2（按范围恢复）：默认回到记录的原范围；project 需要目标 workspaceId
    let scope = String((payload && payload.scope) || '');
    if (!scope) { try { const list = await SkillRegistry.listQuarantine(quarantine); const hit = list.find((item) => path.resolve(item.quarantinePath) === target); scope = hit && hit.scope || 'user'; } catch (_) { scope = 'user'; } }
    let targetRoot;
    if (scope === 'project') {
      const ws = resolveWorkspace(String((payload && payload.workspaceId) || ''));
      if (!ws || !ws.cwd) return { ok: false, error: '恢复项目级 Skill 需要打开对应项目' };
      targetRoot = projectSkillTargetRoot(ws.cwd);
    } else {
      scope = 'user';
      targetRoot = userSkillsDirsList(app)[0];
    }
    const confirm = await dialog.showMessageBox(mainWindow(), { type: 'warning', title: '恢复 Skill', message: '恢复「' + path.basename(target) + '」？', detail: '将恢复到' + (scope === 'project' ? '当前项目' : '用户级') + '技能目录；若已存在同名技能则恢复失败。', buttons: ['取消', '恢复'], defaultId: 0, cancelId: 0, noLink: true });
    if (confirm.response !== 1) return { ok: false, canceled: true };
    const restored = await SkillRegistry.restoreFromQuarantine(target, targetRoot);
    // 恢复后按原范围重写清单 scope（隔离目录内清单保留原 scope，这里显式对齐）
    try { await SkillRegistry.writeManifest(restored.dir, { scope, sourceType: 'directory', autoTrigger: true }); } catch (_) {}
    broadcastSkillChanged();
    return Object.assign({ ok: true, scope }, restored);
  } catch (e) { console.error('[skills:restore]', e); return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
// v2（彻底删除）：隔离区 Skill 移入系统回收站（可找回），不做不可逆删除；路径必须位于隔离根内。
safeHandle('skills:purge', async (_e, payload) => {
  try {
    const quarantinePath = String((payload && payload.quarantinePath) || '');
    if (!quarantinePath) return { ok: false, error: '缺少隔离路径' };
    const quarantine = path.resolve(path.join(app.getPath('userData'), 'tangbao-data', 'skill-quarantine'));
    const target = path.resolve(quarantinePath);
    if (target !== quarantine && !target.startsWith(quarantine + path.sep)) return { ok: false, error: '非法隔离路径' };
    const stat = await fs.promises.stat(target).catch(() => null);
    if (!stat || !stat.isDirectory()) return { ok: false, error: '隔离项不存在' };
    const confirm = await dialog.showMessageBox(mainWindow(), { type: 'warning', title: '彻底删除 Skill', message: '将「' + path.basename(target) + '」移入系统回收站？', detail: '可从 Windows 回收站找回；此操作不可撤销。', buttons: ['取消', '移入回收站'], defaultId: 0, cancelId: 0, noLink: true });
    if (confirm.response !== 1) return { ok: false, canceled: true };
    await shell.trashItem(target);
    broadcastSkillChanged();
    return { ok: true, quarantinePath: target };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
safeHandle('skills:trust', async (_e, payload) => {
  try {
    const managed = await resolveManagedSkill(payload);
    const security = await SkillSecurity.scan(managed.skill.dir);
    const level = String((payload && payload.level) || 'version');
    if (!['untrusted', 'version', 'source'].includes(level)) return { ok: false, error: '无效的信任级别' };
    if (level === 'untrusted') {
      const trustPath = path.join(managed.skill.dir, SkillRegistry.TRUST_FILE);
      await fs.promises.unlink(trustPath).catch(() => {});
      broadcastSkillChanged();
      return { ok: true, trusted: false };
    }
    const record = await SkillSecurity.writeTrust(managed.skill.dir, { packageHash: security.packageHash, source: String((payload && payload.source) || ''), level, capabilities: security.capabilities });
    broadcastSkillChanged();
    return { ok: true, trusted: true, record };
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
safeHandle('skills:autoTrigger', async (_e, payload) => {
  try { const managed = await resolveManagedSkill(payload); const manifest = await SkillRegistry.setAutoTrigger(managed.skill.dir, payload && payload.enabled !== false); broadcastSkillChanged(); return { ok: true, autoTrigger: manifest.autoTrigger }; }
  catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
// v2（等级移动）：项目级 ↔ 用户级原子移动（保留启停/信任/自动触发/资源）；目标同名先展示差异确认后替换。
safeHandle('skills:move', async (_e, payload) => {
  try {
    const managed = await resolveManagedSkill(payload);
    const toScope = String((payload && payload.toScope) || '');
    let targetRoot;
    if (toScope === 'project') {
      const ws = resolveWorkspace(String((payload && payload.toWorkspaceId) || ''));
      if (!ws || !ws.cwd) return { ok: false, error: '请先打开有效项目，再移动为项目级 Skill' };
      targetRoot = projectSkillTargetRoot(ws.cwd);
    } else if (toScope === 'user') {
      targetRoot = userSkillsDirsList(app)[0];
    } else {
      return { ok: false, error: '无效的目标 Skill 范围' };
    }
    if (managed.skill.level === toScope) return { ok: false, error: 'Skill 已在该范围' };
    const targetDir = path.join(targetRoot, managed.skill.name);
    let replace = false;
    if (fs.existsSync(targetDir)) {
      const currentManifest = await SkillRegistry.readManifest(targetDir) || await SkillRegistry.buildManifest(targetDir, { scope: toScope });
      const incomingManifest = await SkillRegistry.buildManifest(managed.skill.dir, { scope: toScope });
      const diff = SkillRegistry.diffManifests(currentManifest, incomingManifest);
      const confirm = await dialog.showMessageBox(mainWindow(), {
        type: 'warning', title: '目标范围存在同名 Skill',
        message: '「' + managed.skill.name + '」在目标范围已存在',
        detail: '移动将替换目标版本。\n新增 ' + diff.added.length + ' / 修改 ' + diff.changed.length + ' / 删除 ' + diff.removed.length + ' 个文件' + (diff.addedScripts.length ? '\n新增脚本：' + diff.addedScripts.join('、') : ''),
        buttons: ['取消', '替换并移动'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (confirm.response !== 1) return { ok: false, canceled: true };
      replace = true;
    }
    const moved = await SkillRegistry.moveSkill(managed.skill.dir, targetRoot, { replace, scope: toScope });
    broadcastSkillChanged();
    return Object.assign({ ok: true, scope: toScope }, moved);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code };
  }
});
safeHandle('skills:importExternal', async (_e, payload) => {
  try {
    const workspaceId = String((payload && payload.workspaceId) || ''); const ws = workspaceId ? resolveWorkspace(workspaceId) : null;
    if (!ws || !ws.cwd) return { ok: false, error: '请先打开有效项目' };
    const candidates = await SkillRegistry.detectExternalSkills(ws.cwd);
    const source = candidates.find((item) => item.name === String(payload.name || '') && item.source === String(payload.source || ''));
    if (!source) return { ok: false, error: '未找到外部 Skill' };
    const pkg = await SkillRegistry.packageFromDirectory(source.dir, { sourceType: source.source });
    const targetRoot = payload.scope === 'user' ? userSkillsDirsList(app)[0] : projectSkillTargetRoot(ws.cwd);
    const targetDir = path.join(targetRoot, pkg.skill.name); const replace = fs.existsSync(targetDir);
    const installed = await SkillPackage.installPackage(pkg, targetRoot, { replace });
    await SkillRegistry.writeManifest(installed.dir, { scope: payload.scope === 'user' ? 'user' : 'project', sourceType: source.source, sourcePath: source.dir });
    broadcastSkillChanged();
    return Object.assign({ ok: true }, installed);
  } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e), code: e && e.code }; }
});
safeHandle('skills:toggle', async (_e, payload) => {
  const name = String((payload && payload.name) || '');
  const enable = !!(payload && payload.enable);
  if (!name || !SKILL_NAME_RE.test(name)) return { ok: false, error: '技能名非法' };
  try {
    const managed = await resolveManagedSkill(payload);
    const dir = managed.skill.dir;
    const fsp = require('fs/promises');
    const from = enable ? path.join(dir, 'SKILL.md.disabled') : path.join(dir, 'SKILL.md');
    const to = enable ? path.join(dir, 'SKILL.md') : path.join(dir, 'SKILL.md.disabled');
    const exists = await fsp.access(from).then(() => true).catch(() => false);
    if (!exists) return { ok: false, error: '找不到 ' + path.basename(from) };
    await fsp.rename(from, to);
    broadcastSkillChanged();
    return { ok: true, name, enabled: enable };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

}

module.exports = { registerMainSkills, userSkillsDirsList };
