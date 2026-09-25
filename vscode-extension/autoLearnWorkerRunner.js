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
  let queue = Promise.resolve();
  let deactivating = false;
  let deactivation = null;
  const jobs = new Set();
  const workers = new Set();

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
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        if (deadline) { clearTimeout(deadline); deadline = null; }
        if (error) reject(error);
        else resolve(value);
      };
      if (timeoutMs > 0) {
        deadline = setTimeout(() => {
          // The worker is deliberately NOT terminated here, and the order in
          // deactivate() below is why: a thread that may be between two policy
          // writes must reach its own result so the manager's JS rollback stays
          // available. Settling the JOB as a failure is the whole fix — the
          // queue advances, the drain completes, and the worker stays in
          // `workers` so the terminate pass that runs after the drain reaps it.
          settle(new Error(
            `Auto Learn worker for '${operation}' did not answer within ${timeoutMs}ms`));
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
      await Promise.allSettled(lingering.map((worker) =>
        typeof worker.terminate === 'function' ? worker.terminate() : undefined));
    })();
    return deactivation;
  }

  function stats() {
    return { deactivating, jobs: jobs.size, workers: workers.size };
  }

  return { run, deactivate, stats };
}

module.exports = { createAutoLearnWorkerRunner };
