'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceService } = require('../../src/application/services/workspace');

function project() {
  return { name: 'demo', cwd: 'C:/demo', workspaceId: 'stale', roots: [], primaryRootId: '' };
}

test('workspace service repairs a stale id and retries the operation once', async () => {
  const calls = [];
  const shell = {
    getWorkspace: async (id) => { calls.push(['get', id]); return { ok: false, code: 'unknown_workspace' }; },
    registerWorkspace: async (cwd, name) => { calls.push(['register', cwd, name]); return { ok: true, workspaceId: 'fresh', cwd, roots: [{ rootId: 'root', name, path: cwd }], primaryRootId: 'root' }; },
  };
  const service = createWorkspaceService({ shell, persist: () => calls.push(['persist']) });
  const p = project();
  let operationCalls = 0;
  const result = await service.run(p, async (id) => {
    operationCalls++;
    return operationCalls === 1 ? { ok: false, code: 'invalid_workspace' } : { ok: true, workspaceId: id };
  });

  assert.equal(result.ok, true);
  assert.equal(result.workspaceId, 'fresh');
  assert.equal(operationCalls, 2);
  assert.equal(p.workspaceId, 'fresh');
  assert.deepEqual(calls.map((item) => item[0]), ['get', 'register', 'persist', 'register', 'persist']);
});

test('workspace service does not silently use cwd when repair cannot register', async () => {
  const p = project();
  const service = createWorkspaceService({
    shell: {
      getWorkspace: async () => ({ ok: false, code: 'unknown_workspace' }),
      registerWorkspace: async () => ({ ok: false, code: 'root_not_found', error: 'missing' }),
    },
  });
  const result = await service.run(p, async () => ({ ok: true }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'workspace_reselection_required');
  assert.equal(result.needsSelection, true);
});

test('workspace service allows at most one repair retry', async () => {
  const p = project();
  const service = createWorkspaceService({
    shell: {
      getWorkspace: async () => ({ ok: true, workspaceId: 'stale', cwd: p.cwd, roots: [], primaryRootId: '' }),
      registerWorkspace: async () => ({ ok: true, workspaceId: 'fresh', cwd: p.cwd }),
    },
  });
  let operationCalls = 0;
  const result = await service.run(p, async () => {
    operationCalls++;
    return { ok: false, code: 'unknown_workspace' };
  });
  assert.equal(result.ok, false);
  assert.equal(operationCalls, 2);
});
