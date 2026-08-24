'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function main() {
  const perf = read('src/renderer/perf.js');
  const router = read('src/renderer/router.js');
  const app = read('src/renderer/app.js');
  const chat = read('src/renderer/views/chat/chat.js');
  const tavern = read('src/renderer/views/tavern/tavern.js');
  const ui = read('src/renderer/components/ui.js');
  const names = [
    'bootMs', 'moduleSwitchMs', 'tavernRenderMs', 'inputHandlerMs',
    'streamRenderMs', 'stateSerializeMs', 'fileWriteMs', 'sqliteSyncMs',
    'ipcQueueDepth', 'stateBytes', 'messageCount',
  ];

  assert(perf.includes('let enabled = false;'), 'performance recorder must be disabled by default');
  assert(perf.includes('const CAPACITY = 120;'), 'performance recorder must remain bounded');
  assert(!/localStorage|sessionStorage|fetch\s*\(|sendSync|App\.services/.test(perf), 'performance recorder must not persist or communicate');
  for (const name of names) assert(perf.includes(`'${name}'`), `missing performance metric ${name}`);
  assert(router.includes("measure('moduleSwitchMs'"), 'router switch timing is missing');
  assert(app.includes("measure('bootMs'"), 'boot timing is missing');
  assert(chat.includes("measure('inputHandlerMs'"), 'input timing is missing');
  assert(chat.includes("measure('streamRenderMs'"), 'stream timing is missing');
  assert(tavern.includes("measure('tavernRenderMs'"), 'Tangguan render timing is missing');
  assert(ui.includes('scheduleSidebarRender()'), 'sidebar search scheduling is missing');
  console.log(JSON.stringify({ ok: true, metrics: names, persistence: 'memory-only', defaultEnabled: false }, null, 2));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error('[check:perf] ' + (error.message || error)); process.exitCode = 1; }
}

module.exports = { main };
