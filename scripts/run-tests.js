'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const testRoot = path.join(projectRoot, 'test');

function collectTests(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectTests(fullPath));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) files.push(fullPath);
  }
  return files;
}

const testFiles = collectTests(testRoot).sort();
if (!testFiles.length) {
  console.error('No test files found under ' + testRoot);
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error.stack || result.error.message || String(result.error));
    process.exitCode = 1;
  } else {
    process.exitCode = typeof result.status === 'number' ? result.status : 1;
  }
}
