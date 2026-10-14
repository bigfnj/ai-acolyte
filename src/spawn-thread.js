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
//   - nativeRpcAsync keeps its 10 s backstop, its 16 MiB bound and its wordings,
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
    worker = new Worker(__filename, { workerData: { [TASK]: task } });
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
      track(execFile(task.file, task.args, task.options, (error, stdout, stderr) =>
        reply({ error: error ? describe(error) : null, stdout, stderr })));
    } else if (task.kind === 'config-rpc') {
      require('./codex-mcp-config').nativeRpcAsync(task.requests, { ...task.options, track }, task.context)
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
