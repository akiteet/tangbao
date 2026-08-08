const logger = require('./logger');
function run() { logger.info('run start'); return 'ok'; }
console.log(run());
