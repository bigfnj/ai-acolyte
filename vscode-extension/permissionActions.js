'use strict';

// Coordinate the existing agent-specific actions without interpreting their
// results as policy writes. In particular, a cancelled Codex review is normal.
function createPermissionActions({ runClaude, reviewCodex, isActive = () => true }) {
  let pending = null;
  let disposed = false;

  function optimize() {
    if (pending) return pending;
    // Queue before invoking either callback so another click (or a reentrant
    // callback) observes the same operation, including while review is open.
    pending = Promise.resolve().then(async () => {
      if (disposed || !isActive()) return;
      await runClaude();
      if (disposed || !isActive()) return;
      await reviewCodex();
    }).finally(() => { pending = null; });
    return pending;
  }

  return {
    optimize,
    // An action already invoked owns its own cancellation/lifecycle guards.
    // Disposal prevents this coordinator from starting either remaining action.
    dispose() { disposed = true; },
  };
}

module.exports = { createPermissionActions };
