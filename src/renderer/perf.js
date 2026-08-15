'use strict';

// Development/diagnostic-only performance ring buffer. It is deliberately
// disabled by default and has no persistence, IPC, upload, or UI surface.
(function () {
  window.App = window.App || {};
  const CAPACITY = 120;
  const NAMES = new Set([
    'bootMs', 'moduleSwitchMs', 'tangguanRenderMs', 'inputHandlerMs',
    'streamRenderMs', 'stateSerializeMs', 'fileWriteMs', 'sqliteSyncMs',
    'ipcQueueDepth', 'stateBytes', 'messageCount',
  ]);
  const samples = [];
  let enabled = false;

  function now() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now() : Date.now();
  }

  function record(name, value, meta) {
    if (!enabled || !NAMES.has(String(name))) return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    const item = Object.assign({ name: String(name), value: number, at: Date.now() }, meta || {});
    samples.push(item);
    if (samples.length > CAPACITY) samples.splice(0, samples.length - CAPACITY);
    return item;
  }

  function measure(name, startedAt, meta) {
    if (!enabled || !Number.isFinite(Number(startedAt))) return null;
    return record(name, Math.max(0, now() - Number(startedAt)), meta);
  }

  function mark(name, detail) {
    if (!enabled) return null;
    return Object.assign({ name: String(name || 'mark'), at: Date.now(), time: now() }, detail || {});
  }

  function begin() { return enabled ? now() : 0; }
  function setEnabled(value) { enabled = value === true; return enabled; }

  App.perf = {
    names: Object.freeze(Array.from(NAMES)),
    isEnabled() { return enabled; },
    enable() { return setEnabled(true); },
    disable() { return setEnabled(false); },
    begin,
    measure,
    mark,
    record,
    clear() { samples.length = 0; },
    snapshot() { return samples.map((item) => Object.assign({}, item)); },
  };
})();
