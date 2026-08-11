'use strict';

// Keep workspace identity repair in one place. Callers must never fall back to
// a raw cwd after the main process rejects an opaque workspace id.
function createWorkspaceService(deps) {
  const options = deps || {};
  const shell = options.shell || {};
  const persist = typeof options.persist === 'function' ? options.persist : () => {};

  const invalidCodes = new Set(['unknown_workspace', 'invalid_workspace']);

  function errorText(value) {
    if (!value) return '';
    if (value instanceof Error) return String(value.message || '');
    if (typeof value === 'object') return String(value.code || value.error || value.message || '');
    return String(value);
  }

  function isInvalid(value) {
    const text = errorText(value).toLowerCase();
    if (invalidCodes.has(text)) return true;
    return /(?:unknown|invalid)[ _-]?workspace/.test(text) || /workspace.*(?:expired|stale|失效|无效)/i.test(text);
  }

  function failure(code, error, reason) {
    return {
      ok: false,
      code: code || 'workspace_reselection_required',
      error: error || '当前项目工作区不可用，请重新选择项目文件夹',
      reason: reason || 'workspace_unavailable',
      needsSelection: true,
    };
  }

  function syncProject(project, result) {
    if (!project || !result || !result.ok) return;
    if (result.workspaceId) project.workspaceId = String(result.workspaceId);
    if (result.cwd) project.cwd = result.cwd;
    if (Array.isArray(result.roots)) {
      project.roots = result.roots.map((root) => ({
        rootId: root.rootId,
        name: root.name,
        path: root.path,
      }));
    }
    if (result.primaryRootId) project.primaryRootId = result.primaryRootId;
    persist();
  }

  function projectCwd(project) {
    if (!project) return '';
    if (project.cwd) return String(project.cwd);
    const roots = Array.isArray(project.roots) ? project.roots : [];
    const primary = roots.find((root) => root.rootId === project.primaryRootId) || roots[0];
    return primary && primary.path ? String(primary.path) : '';
  }

  async function register(project) {
    const cwd = projectCwd(project);
    if (!cwd || typeof shell.registerWorkspace !== 'function') {
      return failure('workspace_reselection_required', '找不到可用的项目文件夹，请重新选择项目文件夹', 'missing_path');
    }
    try {
      const result = await shell.registerWorkspace(cwd, project && project.name);
      if (result && result.ok && result.workspaceId) {
        syncProject(project, result);
        return { ok: true, workspaceId: String(result.workspaceId), project, repaired: true, result };
      }
      return failure('workspace_reselection_required', (result && (result.error || result.message)) || '项目文件夹无法访问，请重新选择', (result && result.code) || 'registration_failed');
    } catch (error) {
      return failure('workspace_reselection_required', errorText(error) || '项目文件夹登记失败，请重新选择', 'registration_failed');
    }
  }

  async function ensureProject(project) {
    if (!project) return failure('workspace_reselection_required', '请先打开有效项目', 'project_missing');
    const currentId = String(project.workspaceId || '');
    if (currentId && typeof shell.getWorkspace === 'function') {
      try {
        const result = await shell.getWorkspace(currentId);
        if (result && result.ok) {
          syncProject(project, result);
          return { ok: true, workspaceId: currentId, project, repaired: false, result };
        }
        if (!isInvalid(result)) return failure('workspace_reselection_required', (result && result.error) || '无法读取当前项目工作区', (result && result.code) || 'workspace_read_failed');
      } catch (error) {
        if (!isInvalid(error)) return failure('workspace_reselection_required', errorText(error) || '无法读取当前项目工作区', 'workspace_read_failed');
      }
    }
    project.workspaceId = '';
    return register(project);
  }

  async function run(project, operation) {
    const ensured = await ensureProject(project);
    if (!ensured.ok) return ensured;
    if (typeof operation !== 'function') return ensured;
    let result;
    try {
      result = await operation(ensured.workspaceId, ensured);
    } catch (error) {
      result = { ok: false, code: error && error.code, error: errorText(error) };
    }
    if (!isInvalid(result)) return result;

    // The opaque registry can be refreshed between preflight and the actual
    // operation. Repair and retry exactly once, then surface the failure.
    project.workspaceId = '';
    const repaired = await register(project);
    if (!repaired.ok) return repaired;
    try {
      return await operation(repaired.workspaceId, repaired);
    } catch (error) {
      return { ok: false, code: error && error.code || 'workspace_operation_failed', error: errorText(error) || '项目工作区操作失败' };
    }
  }

  return { ensureProject, run, register, isInvalid, syncProject, projectCwd };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createWorkspaceService };
} else {
  window.App = window.App || {};
  window.App.services = window.App.services || {};
  window.App.services.workspace = createWorkspaceService({
    shell: window.App.services.shell,
    persist: () => window.App.persist(),
  });
}
