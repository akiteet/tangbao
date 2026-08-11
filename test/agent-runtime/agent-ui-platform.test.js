'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '../..');

test('糖码首屏提供紧凑入口，并以弹窗展示 v1.1.3 Agent Engineering 运行观测', () => {
  const agentSource = fs.readFileSync(path.join(root, 'src/renderer/views/agent/agent.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

  assert.match(agentSource, /agent-engine-launcher/);
  assert.match(agentSource, /id="agentEngineBtn"/);
  assert.match(agentSource, /openEngineObserver\(\)/);
  assert.match(agentSource, /agentEngineMask/);
  assert.match(agentSource, /agentEngineStats/);
  assert.match(agentSource, /renderEngineStrip\(\)/);
  assert.match(agentSource, /refreshEngineStrip\(\)/);
  assert.match(agentSource, /openLatestTrace\(\)/);
  assert.match(agentSource, /Cache Telemetry/);
  assert.match(agentSource, /showRunHistory\(\{ openRunId:/);
  assert.doesNotMatch(agentSource, /agentEngineRail/);
  assert.doesNotMatch(agentSource, /<section class="agent-engine-rail"/);
  assert.doesNotMatch(styles, /\.agent-engine-rail/);
  assert.match(styles, /\.agent-engine-launcher/);
  assert.match(styles, /\.agent-engine-modal/);
  assert.match(styles, /\.agent-engine-stats/);
  assert.match(styles, /@media \(max-width: 640px\)/);
});
