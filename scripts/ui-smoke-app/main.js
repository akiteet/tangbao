'use strict';

const { app } = require('electron');
const { main } = require('../ui-smoke.js');

main().catch((error) => {
  console.error('[check:ui] ' + (error && error.stack ? error.stack : error));
  if (app.isReady()) app.exit(1);
  else process.exitCode = 1;
});
