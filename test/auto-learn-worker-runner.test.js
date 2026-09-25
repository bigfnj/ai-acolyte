'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createAutoLearnWorkerRunner } = require('../vscode-extension/autoLearnWorkerRunner');

class FakeWorker extends EventEmitter {
  constructor(start) {
    super();
    this.start = start;
    queueMicrotask(() => start(this));
  }

  terminate() {
    this.emit('exit', 1);
    return Promise.resolve(1);
  }
}

// A thread that emits none of the three events execute() used to settle on. The
// real one is a worker blocked inside a synchronous fs call — statSync against a
// dead network mount — which posts no message, throws no error and does not
// exit. `terminated` records whether anything ever reaped it.
class SilentWorker extends EventEmitter {
  constructor() {
    super();
    this.terminated = false;
  }

  terminate() {
    this.terminated = true;
    this.emit('exit', 1);
    return Promise.resolve(1);
  }
}

// node:test has no default per-test timeout, so a regression that restores the
// unbounded wait would HANG the runner rather than fail it — no name, no
// assertion, nothing to read. Same reasoning as extension-lifecycle-async.js.
const TEST_TIMEOUT = { timeout: 15000 };

// Every assertion below is about a promise SETTLING, so awaiting it directly
// would turn a regression into the file-level timeout — a cancelled test with no
// message. This bounds the wait itself and hands back a string to assert on, so
// removing the deadline fails by name at the line that cares.
async function outcomeWithin(promise, ms = 2000) {
  return Promise.race([
    promise.then((value) => `resolved: ${JSON.stringify(value)}`, (error) => String(error?.message || error)),
    new Promise((resolve) => setTimeout(() => resolve(`still pending after ${ms}ms`), ms)),
  ]);
}

test('zero exit without a worker message is rejected', async () => {
  const runner = createAutoLearnWorkerRunner({
    workerPath: 'worker.js',
    workerFactory: () => new FakeWorker((worker) => worker.emit('exit', 0)),
  });
  await assert.rejects(runner.run('scan'), /code 0 without a result message/);
  await runner.deactivate();
});

test('worker mutations are serialized and invalidate after each result', async () => {
  let active = 0;
  let maximum = 0;
  const mutations = [];
  const runner = createAutoLearnWorkerRunner({
    workerPath: 'worker.js',
    optionsProvider: () => ({ mode: 'recommend' }),
    onMutation: (operation) => mutations.push(operation),
    workerFactory: (_filename, workerOptions) => new FakeWorker((worker) => {
      active += 1;
      maximum = Math.max(maximum, active);
      setImmediate(() => {
        active -= 1;
        worker.emit('message', { ok: true, result: workerOptions.workerData.operation });
        worker.emit('exit', 0);
      });
    }),
  });

  const results = await Promise.all([
    runner.run('scan'), runner.run('apply'), runner.run('undo'),
  ]);
  assert.deepEqual(results, ['scan', 'apply', 'undo']);
  assert.equal(maximum, 1);
  assert.deepEqual(mutations, ['scan', 'apply', 'undo']);
  await runner.deactivate();
});

test('deactivation drains active work before terminating a post-result lingering worker', async () => {
  let release;
  let terminated = false;
  const runner = createAutoLearnWorkerRunner({
    workerPath: 'worker.js',
    workerFactory: () => new FakeWorker((worker) => {
      release = () => worker.emit('message', { ok: true, result: 'finished' });
      worker.terminate = () => {
        terminated = true;
        worker.emit('exit', 0);
        return Promise.resolve(0);
      };
    }),
  });

  const job = runner.run('apply');
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = runner.deactivate();
  assert.equal(runner.stats().deactivating, true);
  await assert.rejects(runner.run('scan'), /deactivating/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(terminated, false, 'active policy work must not be interrupted');
  release();
  assert.equal(await job, 'finished');
  await stopping;
  assert.equal(terminated, true);
  assert.deepEqual(runner.stats(), { deactivating: true, jobs: 0, workers: 0 });
});

test('deactivation prevents an already queued operation from spawning another worker', async () => {
  let workersCreated = 0;
  let release;
  const runner = createAutoLearnWorkerRunner({
    workerPath: 'worker.js',
    workerFactory: () => {
      workersCreated += 1;
      return new FakeWorker((worker) => {
        release = () => worker.emit('message', { ok: true, result: 'finished' });
        worker.terminate = () => {
          worker.emit('exit', 0);
          return Promise.resolve(0);
        };
      });
    },
  });

  const active = runner.run('scan');
  const queued = runner.run('apply');
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = runner.deactivate();
  release();
  assert.equal(await active, 'finished');
  await assert.rejects(queued, /deactivating/);
  await stopping;
  assert.equal(workersCreated, 1);
});

// ── the deadline ───────────────────────────────────────────────────────────────
//
// execute() settled on 'message', 'error' and 'exit' and had no deadline, so a
// thread that emits none of them wedged its job promise permanently. These three
// pin the three consequences that followed, and each one fails with the deadline
// removed — the whole `if (timeoutMs > 0)` block in
// vscode-extension/autoLearnWorkerRunner.js — rather than merely hanging.

test('a worker that never answers is failed on the deadline, not waited on forever',
  TEST_TIMEOUT, async () => {
    const worker = new SilentWorker();
    const runner = createAutoLearnWorkerRunner({
      workerPath: 'worker.js',
      timeoutMs: 60,
      workerFactory: () => worker,
    });

    const outcome = await outcomeWithin(runner.run('scan'));
    assert.match(outcome, /did not answer within 60ms/,
      `a wedged worker never settled its job, so the caller waited for the life of the `
      + `window — got "${outcome}"`);
    // Still live and still tracked: the deadline is deliberately not a kill. A
    // worker may be between two policy writes, and deactivate()'s drain-then-
    // terminate order exists so JS rollback survives.
    assert.equal(worker.terminated, false,
      'the deadline terminated a worker that may be mid-apply, losing its rollback');
    assert.equal(runner.stats().workers, 1, 'the timed-out worker must stay reapable');
    await runner.deactivate();
  });

test('a wedged job releases the queue instead of blocking every later operation',
  TEST_TIMEOUT, async () => {
    // run() chains on `queue`, so an unsettled job is not one broken scan: it is
    // every subsequent scan, apply and undo, for the life of the window.
    const built = [];
    const runner = createAutoLearnWorkerRunner({
      workerPath: 'worker.js',
      timeoutMs: 60,
      workerFactory: (_filename, workerOptions) => {
        const operation = workerOptions.workerData.operation;
        if (operation === 'scan') {
          const wedged = new SilentWorker();
          built.push(wedged);
          return wedged;
        }
        const worker = new FakeWorker((w) => {
          w.emit('message', { ok: true, result: operation });
          w.emit('exit', 0);
        });
        built.push(worker);
        return worker;
      },
    });

    const wedged = runner.run('scan');
    const behind = runner.run('apply');
    assert.match(await outcomeWithin(wedged), /did not answer/);
    const queued = await outcomeWithin(behind);
    assert.equal(queued, 'resolved: "apply"',
      `the operation queued behind a wedged worker never ran — got "${queued}"`);
    assert.equal(built.length, 2, 'precondition: both operations reached the factory');
    await runner.deactivate();
  });

test('deactivate() completes and reaps a worker that wedged mid-job', TEST_TIMEOUT, async () => {
  // The leak. The drain is Promise.allSettled over the job promises, so an
  // unsettled job left deactivate() pending forever: context.subscriptions never
  // drained and the terminate pass after the drain never ran — one live thread
  // per reload. The deadline turns the job into a settled failure, which is all
  // the drain needs; the ORDER is untouched.
  const worker = new SilentWorker();
  const runner = createAutoLearnWorkerRunner({
    workerPath: 'worker.js',
    timeoutMs: 60,
    workerFactory: () => worker,
  });

  const wedged = runner.run('scan');
  // Not awaited to completion first: with no deadline this never settles, and
  // the point of the test is what teardown does about that.
  await outcomeWithin(wedged, 300);

  const drained = await outcomeWithin(runner.deactivate(), 3000);
  assert.equal(drained, 'resolved: undefined',
    `deactivate() never resolved: the drain waits on a job that cannot settle — got "${drained}"`);
  assert.equal(worker.terminated, true,
    'the wedged thread outlived the extension host — one more live worker per reload');
  assert.deepEqual(runner.stats(), { deactivating: true, jobs: 0, workers: 0 });
});

test('the deadline is overridable, including off', TEST_TIMEOUT, async () => {
  // 0 disables it, which is what attaching a debugger to the worker needs, and
  // is also the proof that the 300000 ms default is a value and not a constant
  // baked into the settle path.
  const worker = new SilentWorker();
  const runner = createAutoLearnWorkerRunner({
    workerPath: 'worker.js',
    timeoutMs: 0,
    workerFactory: () => worker,
  });

  const job = runner.run('scan');
  let settled = false;
  job.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(settled, false, 'timeoutMs: 0 must mean no deadline');

  worker.emit('message', { ok: true, result: 'late' });
  worker.emit('exit', 0);
  assert.equal(await job, 'late');
  await runner.deactivate();
});

test('the environment can override the deadline when no option is passed',
  TEST_TIMEOUT, async () => {
    const previous = process.env.PERMISSION_WILDCARDING_WORKER_TIMEOUT_MS;
    process.env.PERMISSION_WILDCARDING_WORKER_TIMEOUT_MS = '60';
    try {
      const runner = createAutoLearnWorkerRunner({
        workerPath: 'worker.js',
        workerFactory: () => new SilentWorker(),
      });
      const outcome = await outcomeWithin(runner.run('scan'));
      assert.match(outcome, /did not answer within 60ms/,
        'the env override is the only lever a user has: a VS Code setting the package '
        + `manifest does not declare is not readable through getConfiguration() — got "${outcome}"`);
      await runner.deactivate();
    } finally {
      if (previous === undefined) delete process.env.PERMISSION_WILDCARDING_WORKER_TIMEOUT_MS;
      else process.env.PERMISSION_WILDCARDING_WORKER_TIMEOUT_MS = previous;
    }
  });
