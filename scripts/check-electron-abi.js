'use strict';

const { app } = require('electron');

async function main() {
  await app.whenReady();
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    const result = db.prepare('select 1 as ok').get();
    db.close();
    if (!result || result.ok !== 1) throw new Error('better-sqlite3 query verification failed');
    console.log(JSON.stringify({ ok: true, electron: process.versions.electron, node: process.versions.node, module: 'better-sqlite3' }));
  } finally {
    app.quit();
  }
}

main().catch((error) => {
  console.error('[check:electron-abi] ' + (error && error.stack ? error.stack : error));
  if (app.isReady()) app.exit(1);
  else process.exitCode = 1;
});
