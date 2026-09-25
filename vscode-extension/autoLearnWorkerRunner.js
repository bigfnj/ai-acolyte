'use strict';

const { Worker } = require('node:worker_threads');

// How long one worker operation may run before the runner stops waiting for it.
//
// `execute()` settled on 'message', 'error' or 'exit' and on nothing else, so a
// thread blocked inside a synchronous fs call — a statSync against a dead
// network mount is the observed shape — emitted none of the three and its job
// promise stayed pending forever. Three things followed, and none of them was
// visible from outside:
//
//   - `run()` chains on `queue`, so every later scan, apply and undo waited
//     behind the wedged one. Auto Learn was dead for the life of the window.
//   - `deactivate()`'s drain is Promise.allSettled over those same jobs, so it
//     never resolved, `context.subscriptions` never drained, and the terminate
//     pass that follows the drain never ran: one live thread per reload.
//   - nothing said so. A wedged scan and a quiet one look identical.
//
// The number is chosen against the slowest operation that is still WORKING, not
// against the typical one. The manager's own execFile timeouts are 180000 ms, so
// any deadline at or below that would kill a legitimate operation before its own
// timeout could fire and report properly. 300000 ms clears that by a minute. A
// real scan on this box measures 117-142 ms, so this is ~2000x the observed
// cost — it is a backstop for a thread that will never answer, not a budget.
const DEFAULT_WORKER_TIMEOUT_MS = 300000;

// How long a worker that has already MISSED its deadline is given to exit on its
// own before the runner stops waiting and terminates it.
//
// The deadline deliberately does not kill: a thread that may be between two
// policy writes has to reach its own result so the manager's JS rollback stays
// available, and `deactivate()` drains before it terminates for the same reason.
// What that argument did NOT license was leaving the worker for teardown. The
// only `workers.delete` was inside the 'exit' handler, and a thread blocked in a
// synchronous fs call — the exact case the deadline was written for — emits no
// 'exit'. With a 300 s deadline against a 5-minute reconcile, a wedged mount
// produced roughly one orphaned V8 isolate and OS thread every five minutes for
// the life of the window. "Reaped at teardown" is unbounded between reloads.
//
// 30 s after a deadline that is already 300 s: if the thread has not come back
// in five and a half minutes it is not coming back, and the rollback window the
// no-kill rule protects has long closed.
const DEFAULT_REAP_GRACE_MS = 30000;

// And how long the terminate() itself is waited on, in the reap above and in
// deactivate()'s pass. `terminate()` resolves ON THREAD EXIT, and a thread
// inside a synchronous libuv call cannot be interrupted until that syscall
// returns — so awaiting it unbounded reproduces, in the reap, exactly the hang
// the deadline was added to remove. Issuing the terminate is the part this
// module controls; waiting for it to be honoured is not.
const DEFAULT_TERMINATE_DEADLINE_MS = 5000;

// Overridable: `timeoutMs` on the runner (what the tests use), else
// PERMISSION_WILDCARDING_WORKER_TIMEOUT_MS in the environment, which is the only
// lever available to a user, since a VS Code setting the package manifest does
// not declare is not readable through getConfiguration(). 0 or a negative value
// disables the deadline, which is what attaching a debugger to the worker needs.
function resolveWorkerTimeout(value) {
  for (const candidate of [value, process.env.PERMISSION_WILDCARDING_WORKER_TIMEOUT_MS]) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const parsed = Number(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return DEFAULT_WORKER_TIMEOUT_MS;
}

function createAutoLearnWorkerRunner(options = {}) {
  const workerPath = options.workerPath;
  const optionsProvider = typeof options.optionsProvider === 'function'
    ? options.optionsProvider : () => ({});
  const workerFactory = typeof options.workerFactory === 'function'
    ? options.workerFactory : (filename, workerOptions) => new Worker(filename, workerOptions);
  const onMutation = typeof options.onMutation === 'function' ? options.onMutation : () => {};
  const timeoutMs = resolveWorkerTimeout(options.timeoutMs);
  const positive = (value, fallback) =>
    (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback);
  const reapGraceMs = positive(options.reapGraceMs, DEFAULT_REAP_GRACE_MS);
  const terminateDeadlineMs = positive(options.terminateDeadlineMs, DEFAULT_TERMINATE_DEADLINE_MS);
  let queue = Promise.resolve();
  let deactivating = false;
  let deactivation = null;
  const jobs = new Set();
  const workers = new Set();

  // Ask the thread to die and stop waiting on the answer. Never rejects: every
  // caller here is cleaning up, and a terminate that fails must not take the
  // cleanup with it.
  function terminateBounded(worker) {
    if (!worker || typeof worker.terminate !== 'function') return Promise.resolve('no-terminate');
    let settle = () => {};
    const done = new Promise((resolve) => { settle = resolve; });
    const timer = setTimeout(() => settle('deadline'), terminateDeadlineMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      Promise.resolve(worker.terminate()).then(
        () => { clearTimeout(timer); settle('exited'); },
        () => { clearTimeout(timer); settle('failed'); },
      );
    } catch {
      clearTimeout(timer);
      settle('threw');
    }
    return done;
  }

  function execute(operation, args) {
    if (deactivating) return Promise.reject(new Error('Auto Learn is deactivating'));
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = workerFactory(workerPath, {
          workerData: { options: optionsProvider(), operation, args },
        });
      } catch (error) {
        reject(error);
        return;
      }
      workers.add(worker);
      let settled = false;
      let deadline = null;
      let reap = null;
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        if (deadline) { clearTimeout(deadline); deadline = null; }
        if (error) reject(error);
        else resolve(value);
      };
      if (timeoutMs > 0) {
        deadline = setTimeout(() => {
          // The worker is deliberately NOT terminated at this instant, and the
          // order in deactivate() below is why: a thread that may be between two
          // policy writes must reach its own result so the manager's JS rollback
          // stays available. Settling the JOB as a failure is what releases the
          // queue and lets the drain complete.
          settle(new Error(
            `Auto Learn worker for '${operation}' did not answer within ${timeoutMs}ms`));
          // BUT IT IS REAPED, on a clock of its own. Leaving it for teardown was
          // the leak: the only `workers.delete` is in the 'exit' handler below,
          // and a thread wedged in a synchronous fs call never emits 'exit', so
          // nothing removed it and nothing terminated it until the window
          // reloaded. See DEFAULT_REAP_GRACE_MS above for why 30 s, and why
          // waiting for the terminate to be honoured is not this module's job.
          reap = setTimeout(() => {
            reap = null;
            // It came back on its own inside the grace. The 'exit' handler has
            // already removed it, and terminating a thread that has exited would
            // be a second, pointless call.
            if (!workers.has(worker)) return;
            workers.delete(worker);
            terminateBounded(worker);
          }, reapGraceMs);
          if (typeof reap.unref === 'function') reap.unref();
        }, timeoutMs);
        // A pending deadline must not be the reason a host, or `node --test`,
        // stays alive after everything else has finished.
        if (typeof deadline.unref === 'function') deadline.unref();
      }
      worker.once('message', (message) => {
        if (!message?.ok) {
          const error = new Error(message?.error?.message || 'Auto Learn worker failed');
          if (message?.error?.code) error.code = message.error.code;
          if (message?.error?.stack) error.stack = message.error.stack;
          settle(error);
          return;
        }
        try {
          onMutation(operation, message.result);
          settle(null, message.result);
        } catch (error) {
          settle(error);
        }
      });
      worker.once('error', (error) => settle(error));
      worker.once('exit', (code) => {
        workers.delete(worker);
        // A thread that exited needs no reaping, and a timer still holding a
        // reference to a dead worker is the retention this pass exists to stop.
        if (reap) { clearTimeout(reap); reap = null; }
        if (settled) return;
        settle(new Error(`Auto Learn worker exited with code ${code} without a result message`));
      });
    });
  }

  function run(operation, ...args) {
    if (deactivating) return Promise.reject(new Error('Auto Learn is deactivating'));
    const job = queue.then(() => execute(operation, args));
    queue = job.catch(() => undefined);
    jobs.add(job);
    job.then(() => jobs.delete(job), () => jobs.delete(job));
    return job;
  }

  function deactivate() {
    if (deactivation) return deactivation;
    deactivating = true;
    deactivation = (async () => {
      // A manager operation may be between policy writes. Drain authorized work
      // to its result so JS rollback remains available; queued work sees the
      // deactivating guard and never starts. Only completed workers that failed
      // to exit are safe to terminate after all job promises have settled.
      await Promise.allSettled([...jobs]);
      const lingering = [...workers];
      workers.clear();
      // `terminateBounded`, not a bare `terminate()`. This pass had no deadline
      // of its own and `terminate()` resolves on THREAD EXIT, so a thread stuck
      // in a synchronous libuv call left the reap hanging in exactly the way the
      // drain used to hang — and this one runs during the host's teardown, where
      // a hang is an extension that never finishes unloading.
      await Promise.allSettled(lingering.map((worker) => terminateBounded(worker)));
    })();
    return deactivation;
  }

  function stats() {
    return { deactivating, jobs: jobs.size, workers: workers.size };
  }

  return { run, deactivate, stats };
}

module.exports = { createAutoLearnWorkerRunner };
