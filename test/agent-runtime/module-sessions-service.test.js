'use strict';
// 渲染层 module-sessions 服务行为回归（v1.2.0 批次 2：vm 沙箱加载，沿 state.js 先例）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const src = fs.readFileSync(path.join(root, 'src/application/services/module-sessions.js'), 'utf8');

/** 构造带假 IPC 的沙箱上下文：calls 记录每次 invoke，scripted 按通道名给出返回值 */
function loadService(scripted) {
  const calls = [];
  const context = {
    App: {
      services: {
        ipc: {
          async invoke(name, args, fallback) {
            calls.push({ name, args, fallback });
            if (scripted[name] === 'throw') throw new Error('ipc down: ' + name);
            if (Object.prototype.hasOwnProperty.call(scripted, name)) return scripted[name];
            return fallback;
          },
        },
      },
    },
  };
  vm.runInNewContext(src, context, { filename: 'module-sessions.js' });
  return { service: context.App.services.moduleSessions, calls };
}

test('不支持的模块名一律返回 unsupported_module 且不打 IPC', async () => {
  const { service, calls } = loadService({});
  const r1 = await service.load('bogus');
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'unsupported_module');
  assert.equal(r1.data.module, 'bogus', '兜底数据仍携带模块名');
  await service.upsert('evil', {}, null);
  await service.remove('', 'id-1');
  await service.flushPartial({ module: 'nope' });
  assert.equal(calls.length, 0, '非法模块不得触达 IPC');
});

test('load 成功透传；失败置 status=failed 并返回兜底数据', async () => {
  const okData = { ok: true, module: 'tavern', data: { format: 'x', conversations: [{ id: 'c1' }] } };
  const good = loadService({ moduleSessionsLoad: okData });
  const r = await good.service.load('tavern');
  assert.deepEqual(r, okData);
  assert.equal(good.service.status, 'pending');
  assert.equal(good.calls[0].name, 'moduleSessionsLoad');

  const bad = loadService({ moduleSessionsLoad: { ok: false, module: 'tavern', data: {} } });
  const r2 = await bad.service.load('tavern');
  assert.equal(r2.ok, false);
  assert.equal(bad.service.status, 'failed', '失败必须反映到服务状态');
});

test('get/upsert/remove/flushPartial 参数按位置正确传给 IPC', async () => {
  const { service, calls } = loadService({});
  await service.get('create', 'conv-9');
  assert.equal(calls[0].name, 'moduleSessionsGet');
  assert.deepEqual(calls[0].args, ['create', 'conv-9']);

  const conv = { id: 'conv-9', messages: [] };
  await service.upsert('create', conv, 'conv-9');
  assert.equal(calls[1].name, 'moduleSessionsSave');
  assert.deepEqual(calls[1].args, ['create', conv, 'conv-9']);

  await service.flushPartial({ module: 'tavern', conversationId: 'c7', partialText: 'abc' });
  assert.equal(calls[2].name, 'moduleSessionsFlushPartial');
  assert.equal(calls[2].args[0].conversationId, 'c7', '载荷对象经 args 数组首元素传入');
  assert.equal(calls[2].fallback.code, 'ipc_unavailable');
});
