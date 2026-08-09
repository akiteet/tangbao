'use strict';

const { classifyError } = require('./error-classifier');

function linkAbortSignal(controller, parentSignal) {
  if (!controller || !parentSignal) return () => {};
  const abort = () => {
    try { controller.abort(parentSignal.reason || new Error('cancelled')); } catch (_) { try { controller.abort(); } catch (_) {} }
  };
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener('abort', abort, { once: true });
  return () => parentSignal.removeEventListener('abort', abort);
}

class AbortLifecycle {
  constructor(parentSignal) {
    this.controller = new AbortController();
    this.cleanups = new Set();
    this.children = new Set();
    this.aborted = false;
    this.reason = null;
    // Route parent cancellation through abort() so descendants, cleanups and
    // the persisted terminal state all observe the same lifecycle.
    this.parentUnlink = () => {};
    if (parentSignal) {
      const onParentAbort = () => {
        const raw = parentSignal.reason;
        const reason = raw && (raw.type || raw.code || raw.name === 'AbortError')
          ? raw
          : { type: 'cancelled', code: 'parent_cancelled', message: raw && raw.message || 'parent run cancelled', recoverable: false };
        this.abort(reason);
      };
      if (parentSignal.aborted) onParentAbort();
      else {
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
        this.parentUnlink = () => parentSignal.removeEventListener('abort', onParentAbort);
      }
    }
  }

  get signal() { return this.controller.signal; }

  child() {
    const child = new AbortLifecycle(this.signal);
    this.children.add(child);
    const cleanup = () => this.children.delete(child);
    child.addCleanup(cleanup);
    return child;
  }

  addCleanup(cleanup) {
    if (typeof cleanup !== 'function') return () => {};
    if (this.aborted) { try { cleanup(); } catch (_) {} return () => {}; }
    this.cleanups.add(cleanup);
    return () => this.cleanups.delete(cleanup);
  }

  abort(reason) {
    if (this.aborted) return false;
    this.aborted = true;
    this.reason = classifyError(reason || { type: 'cancelled', code: 'cancelled', message: 'run cancelled', recoverable: false });
    try { this.controller.abort(this.reason); } catch (_) { try { this.controller.abort(); } catch (_) {} }
    for (const child of this.children) child.abort(this.reason);
    for (const cleanup of this.cleanups) { try { cleanup(); } catch (_) {} }
    this.cleanups.clear();
    return true;
  }

  dispose() {
    this.parentUnlink();
    for (const child of this.children) child.dispose();
    this.children.clear();
    for (const cleanup of this.cleanups) { try { cleanup(); } catch (_) {} }
    this.cleanups.clear();
  }
}

function createAbortLifecycle(parentSignal) { return new AbortLifecycle(parentSignal); }

module.exports = { AbortLifecycle, createAbortLifecycle, linkAbortSignal };
