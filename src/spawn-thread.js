'use strict';

// THE EXTENSION HOST NEVER WAITS ON CreateProcess (2026-10-14).
//
// On Windows libuv's spawn is synchronous: execFile() and spawn() return only once
// CreateProcess has, and on a box whose endpoint security hooks process creation
// that is no longer cheap. Measured on the development box, n=15, how long spawn()
// held the calling thread (p50): node 207 ms, cmd.exe 74 ms, taskkill 61 ms, and
// the real winget codex.exe (332 MB) 465 ms. The dashboard push starts two
// spawns, the Codex version probe and the project-trust worker, so a cold push held
// the extension host for about 700 ms and a push after a config.toml edit for
// about 220 ms, and every other extension in the window waited behind it
// (docs/engineering-record.md has the method and the before-and-after figures).
//
// A worker thread pays it instead. `new Worker()` returned in 0.44 ms (p50, n=15),
// and a spawn made on a thread does not stall the host thread at all: a spin on
// the main thread saw a longest gap of 4.1 ms while the thread spawned the real
// codex 11 times, against 5.1 ms with no spawn.
//
// WHAT RUNS WHERE. The thread runs the code that ran on the host, unchanged: the
// version probe's execFile, and nativeRpcAsync in src/codex-mcp-config.js. Every
// child it starts stays a ChildProcess on that thread, so what was written for a
// ChildProcess still holds there:
//   - endProcessTree runs on the thread, against the real child: taskkill /T on
//     Windows, the group signal on POSIX (the config worker is still spawned
//     detached), and the freed-PID guard (exitCode OR signalCode) on the real handle;
//   - nativeRpcAsync keeps its backstop (the caller's budget: 25 s for the trust ask
//     since efeb0c1), its 16 MiB bound and its wordings,
//     and its deadline is counted from the HOST's call (`startedAt`), so the
//     thread's own start is budgeted like the worker's;
//   - the process tree is the same one. A thread's children are this process's
//     children: libuv's kill-on-close job on Windows belongs to the process, and
//     the config worker's ppid is still the host's pid, so the host-death handling
//     in src/codex-mcp-config.js is untouched.
// The host holds a ThreadChild for each task. `track` hands it to the extension's
// trackChild like any child, and endProcessTree (src/exec-resolve.js) ends it by
// asking the thread to end what it started. One thread per task, as the Auto Learn
// runner does it: it exits by itself once its task has answered and its children
// have closed, so there is no pool to retire.

const { EventEmitter } = require('node:events');
const { isMainThread, workerData } = require('node:worker_threads');
const { END_TREE } = require('./exec-resolve');

const TASK = 'ai-acolyte.spawn-thread';
// How long an end request waits for the thread to say its tree is gone. Longer
// than the 5 s taskkill ceiling it waits on; deactivate bounds its own wait at 6 s.
const END_BOUND_MS = 6000;

// ONE SPAWN AT A TIME ACROSS THESE THREADS (2026-10-20). On Windows, libuv makes a
// child's ends of its stdio pipes inheritable for the length of spawn(), and every
// CreateProcess in the process inherits every inheritable handle there is at that
// moment. Two threads spawning at once therefore hand each other's pipe ends to
// their children. A cold dashboard push starts two threads together: the version
// probe (`codex --version`) and the trust ask (the config worker, which lives for
// as long as Codex takes to answer). When the two spawns overlapped, the worker held
// the probe's stdout open, so the probe's 'close' and its answer waited for the
// worker to exit. Measured on the development box under load: `--version` exited
// 2.3 s after the probe began, its 'close' came 2.8 s after that, one millisecond
// after the worker exited, and the probe's 5 s timer had already called it "timed
// out", which then stood for 60 s. In isolation, two threads spawning together: the short
// child's 'close' came about 4 s after its exit in 8 of 8 rounds, until the long one
// exited, and 0 ms after it in 8 of 8 with each spawn() held under one lock.
//
// So each spawn made here holds the gate below, shared by every spawn thread this
// process starts, for the length of the spawn() call only: by the time spawn()
// returns, libuv has closed the child's ends on this side. A second thread waits
// out one CreateProcess (74-465 ms p50 on that box, about 1 s at worst under load),
// on its own thread, never the host's. The lock word holds when it was taken, so a
// holder that never released (a thread that died inside the call) is taken over
// after GATE_STALE_MS, and the gate can delay a spawn but never stop one.
//
// NOT GATED, and recorded: spawns on the extension host thread and on the Auto Learn
// worker thread, and the taskkill a thread runs to end its tree. Each is short-lived
// or rare, and a pipe it leaks makes one answer wait for one other process to exit.
const GATE = 'ai-acolyte.spawn-gate';
const GATE_SLOT = Symbol.for('ai-acolyte.spawn-gate');
const GATE_STALE_MS = 5000;
const GATE_TICK_MS = 100;

// THE GATE'S CLOCK IS MONOTONIC (2026-10-20). It was Date.now(), the wall clock: set the clock
// back an hour (a time sync, a manual change) and every hold looked an hour younger, so a dead
// holder's hold was not stale for an hour and every gated spawn waited on it; set it forward
// and a live holder's hold could be taken over mid-spawn. process.hrtime is libuv's uv_hrtime
// (QueryPerformanceCounter on Windows, CLOCK_MONOTONIC elsewhere): one clock for the whole
// process, so the host thread that writes `base` and every spawn thread that reads it are on
// one scale, and no wall-clock step moves it. Checked 2026-10-20 on Node 24.16: a worker's
// reading always fell between the host's readings either side of it. performance.timeOrigin +
// performance.now() agreed there too, but a worker's timeOrigin has not always been the
// process's, and hrtime has no such history.
const monotonicMs = () => Number(process.hrtime.bigint() / 1000000n);

// One gate per process, kept on the global, so a reloaded copy of this module (a
// same-realm re-activate) shares it with threads its predecessor started. The Int32 at
// byte 0 is the lock word (0 free, else 1 + the tenths of a second after `base` when it
// was taken), and the Float64 at byte 8 is `base`, on monotonicMs' scale, written before
// any thread can read it.
function spawnGate() {
  if (!(globalThis[GATE_SLOT] instanceof SharedArrayBuffer)) {
    const shared = new SharedArrayBuffer(16);
    new Float64Array(shared, 8, 1)[0] = monotonicMs();
    globalThis[GATE_SLOT] = shared;
  }
  return globalThis[GATE_SLOT];
}

// The thread's half: run `start` (one spawn) holding the gate, and hand back what it
// returned. Without a gate in workerData (a thread started some other way) it runs
// ungated, as before.
function gated(start) {
  const shared = workerData?.[GATE];
  if (!(shared instanceof SharedArrayBuffer)) return start();
  const lock = new Int32Array(shared, 0, 1);
  const base = new Float64Array(shared, 8, 1)[0];
  const stamp = () => 1 + Math.max(0, Math.floor((monotonicMs() - base) / GATE_TICK_MS));
  let mine = stamp();
  for (;;) {
    const held = Atomics.compareExchange(lock, 0, 0, mine);
    if (held === 0) break;
    if (monotonicMs() - (base + (held - 1) * GATE_TICK_MS) > GATE_STALE_MS
      && Atomics.compareExchange(lock, 0, held, mine) === held) break;
    Atomics.wait(lock, 0, held, 50);
    mine = stamp();
  }
  try {
    return start();
  } finally {
    // Only this hold is released: one taken over as stale is no longer this thread's.
    if (Atomics.compareExchange(lock, 0, mine, 0) === mine) Atomics.notify(lock, 0, 1);
  }
}

const describe = (error) => ({ message: String((error && error.message) || error),
  code: error?.code ?? null, signal: error?.signal ?? null, killed: error?.killed === true });

class ThreadChild extends EventEmitter {
  constructor() {
    super();
    this.worker = null;
    this.closed = false;
    this.ending = null;
  }

  // Resolves when the thread says its children are ended, when it has exited, or
  // after END_BOUND_MS, whichever is first. Never rejects. Asked once: the second
  // caller (a deadline, then deactivate) waits on the same answer.
  [END_TREE]() {
    if (this.closed || !this.worker) return Promise.resolve();
    if (!this.ending) {
      const worker = this.worker;
      this.ending = new Promise((resolve) => {
        let bound = null;
        const onMessage = (message) => { if (message?.op === 'ended') done(); };
        const done = () => {
          clearTimeout(bound);
          worker.off('message', onMessage);
          this.off('close', done);
          resolve();
        };
        worker.on('message', onMessage);
        this.once('close', done);
        bound = setTimeout(done, END_BOUND_MS);
        if (typeof bound.unref === 'function') bound.unref();
        try { worker.postMessage({ op: 'end' }); } catch { done(); }
      });
    }
    return this.ending;
  }
  // No kill(), on purpose: END_TREE is the one door, so a caller that ends this
  // without endProcessTree, or without awaiting it, fails loudly in a test instead
  // of half-working in production.
}

// Start `task` on a thread of its own. `settle` is called once, with the thread's
// answer or, if the thread could not start or stopped without one, an error whose
// message begins with `lost`. 'close' is emitted on the ThreadChild when the thread
// has exited, which is after every child it started has closed.
function startThread(task, settle, lost) {
  const { Worker } = require('node:worker_threads');
  const child = new ThreadChild();
  let answered = false;
  const answer = (result) => { if (!answered) { answered = true; settle(result); } };
  let worker;
  try {
    worker = new Worker(__filename, { workerData: { [TASK]: task, [GATE]: spawnGate() } });
  } catch (error) {
    // Nothing started, so nothing needs ending. Answered on a later tick, the way
    // a spawn failure reaches execFile's callback, never inline.
    process.nextTick(() => {
      answer({ error: { message: `${lost}: ${error.message}` } });
      child.closed = true;
      child.emit('close', null);
    });
    return child;
  }
  child.worker = worker;
  let failure = null;
  worker.on('message', (message) => { if (message?.op === 'result') answer(message); });
  // An uncaught error on the thread is followed by 'exit', where it is answered.
  worker.on('error', (error) => { failure = error; });
  worker.once('exit', (code) => {
    answer({ error: { message: failure ? `${lost}: ${failure.message}` : `${lost} (the thread exited ${code})` } });
    child.closed = true;
    child.worker = null;
    child.emit('close', code);
  });
  return child;
}

// execFile's signature and callback, run on a thread. Returns the ThreadChild at
// once, as execFile returns its ChildProcess. The callback's error carries
// execFile's `message`, `code`, `signal` and `killed`.
function execFileOffThread(file, args, options, callback) {
  return startThread({ kind: 'execFile', file, args, options }, (result) => {
    const error = result.error ? Object.assign(new Error(result.error.message),
      { code: result.error.code ?? null, signal: result.error.signal ?? null, killed: result.error.killed === true }) : null;
    callback(error, result.stdout ?? '', result.stderr ?? '');
  }, 'the thread that ran it stopped without an answer');
}

// nativeRpcAsync's contract (src/codex-mcp-config.js), run on a thread: the same
// results, the same failure messages, and `options.track` receives the ThreadChild.
// The clock starts here, on the host, so the worker's deadline counts the thread.
function configRpcOffThread(requests, options, context) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = startThread({ kind: 'config-rpc', requests, context, options: {
      codexExecutable: options.codexExecutable, nodeExecutable: options.nodeExecutable,
      timeoutMs: options.timeoutMs, startedAt } },
    (result) => (result.error ? reject(new Error(result.error.message)) : resolve(result.results)),
    'Codex config RPC is unavailable: the thread that ran it stopped without an answer');
    if (typeof options.track === 'function') options.track(child);
  });
}

// The thread's half. It tracks every child its task starts, ends them all when the
// host asks, and lets its port go, so it exits as soon as the task has answered and
// those children have closed.
function runTask(task) {
  const { parentPort } = require('node:worker_threads');
  const { endProcessTree } = require('./exec-resolve');
  const children = new Set();
  const track = (spawned) => {
    if (!spawned || typeof spawned.once !== 'function') return;
    children.add(spawned);
    const forget = () => children.delete(spawned);
    spawned.once('close', forget);
    spawned.once('error', forget);
  };
  const post = (message) => { try { parentPort.postMessage(message); } catch { /* the host is gone */ } };
  const reply = (message) => post({ op: 'result', ...message });
  parentPort.on('message', (message) => {
    if (message?.op !== 'end') return;
    Promise.all([...children].map((spawned) => endProcessTree(spawned))).then(() => post({ op: 'ended' }));
  });
  parentPort.unref();
  try {
    if (task.kind === 'execFile') {
      const { execFile } = require('node:child_process');
      track(gated(() => execFile(task.file, task.args, task.options, (error, stdout, stderr) =>
        reply({ error: error ? describe(error) : null, stdout, stderr }))));
    } else if (task.kind === 'config-rpc') {
      require('./codex-mcp-config').nativeRpcAsync(task.requests, { ...task.options, track, spawnGate: gated }, task.context)
        .then((results) => reply({ results }), (error) => reply({ error: describe(error) }));
    } else {
      reply({ error: { message: `unknown spawn-thread task ${String(task.kind)}` } });
    }
  } catch (error) {
    reply({ error: describe(error) });
  }
}

if (!isMainThread && workerData && workerData[TASK]) runTask(workerData[TASK]);

// Two doors, one per caller: src/codex-version.js takes the execFile form for its
// version probe, src/codex-mcp-config.js the config RPC for the trust ask. Each is
// chosen by the caller's `offThread: true`, which only the extension passes.
module.exports = { execFileOffThread, configRpcOffThread };
