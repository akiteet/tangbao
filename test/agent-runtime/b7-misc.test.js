'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const agentSrc = read('src/infrastructure/agent-runtime/agent-server.js');
const mainSrc = read('src/main/main.js');
const uiSrc = read('src/renderer/components/ui.js');
const { exportRunJSONL } = require('../../src/core/agent-runtime/run-export');
const Gate = require('../../src/core/agent-runtime/completion-gate');
const G = require('../../src/infrastructure/model-gateway/gateway');

test('B7：子代理空结果判失败（不误信 ok:true）', () => {
  assert.match(agentSrc, /subagent_empty_result/, '空结果应有独立失败码');
  assert.match(agentSrc, /子代理未返回内容/, '应有明确提示');
});

test('B7：ZIP 条目按声明大小严格校验（不再 +1 越界容忍）', () => {
  const src = read('src/core/skills/skill-package.js');
  const i = src.indexOf('zip_entry_size_mismatch');
  const seg = src.slice(i - 120, i + 40);
  assert.doesNotMatch(seg, /size \+ 1/, '不应再容忍 +1 越界');
});

test('B7：run-export 支持 seq 从 0 开始的事件流', () => {
  const out = exportRunJSONL({ run: { id: 'r1' }, events: [{ seq: 0, type: 'meta' }, { seq: 1, type: 'done' }] });
  assert.match(out, /recordType/);
  assert.ok(out.includes('"seq":0'), 'seq 0 事件应被导出');
});

test('B7：activeChangesOf 路径大小写归一（Windows 重复计数修复）', () => {
  const ws = { filesChanged: [{ path: 'Src/Foo.ts', at: 1 }, { path: 'src/foo.ts', at: 2 }] };
  const changes = Gate.activeChangesOf(ws);
  assert.equal(changes.length, 1, '大小写不同但同一文件应只计一次');
  assert.equal(changes[0].path, 'src/foo.ts');
});

test('B7：gateway checkTarget 拦截 IPv4-mapped IPv6 元数据地址', () => {
  assert.ok(G.checkTarget(new URL('http://[::ffff:169.254.169.254]/latest/meta-data')), 'IPv4 映射的 169.254 应被拦截');
  assert.ok(G.checkTarget(new URL('http://[::ffff:169.254.170.2]/')), 'IPv4 映射的链路本地应被拦截');
  assert.equal(G.checkTarget(new URL('https://[::ffff:7f00:1]:11434/')), '', '正常回环地址应放行');
});

test('B7：openPath 黑名单含 .hta', () => {
  assert.match(mainSrc, /exe\|bat\|cmd\|com\|scr\|ps1\|msi\|vbs\|jar\|js\|wsf\|lnk\|hta/, '.hta 应纳入可执行黑名单');
});

test('B7：saveWorkspaces 不再静默吞错', () => {
  assert.match(mainSrc, /保存 workspaces\.json 失败/, '失败应记录日志');
});

test('B7：toast 连续调用先清旧 timer', () => {
  assert.match(uiSrc, /if \(App\.ui\._toastTimer\) \{ clearTimeout\(App\.ui\._toastTimer\)/, 'toast 应先清旧 timer');
});
