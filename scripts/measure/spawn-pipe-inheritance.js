'use strict';
// DOES A CHILD SPAWNED ON ONE THREAD INHERIT THE PIPES OF A CHILD ANOTHER THREAD IS SPAWNING?
// (committed 2026-10-20)
//
//   usage: node scripts/measure/spawn-pipe-inheritance.js [rounds, default 8] [serial]
//
// Each round starts two worker threads released by one barrier, so their spawn() calls overlap:
// thread L spawns a node that lives 4 s, thread S execFiles a node that writes one byte and exits
// at once. The round prints how long S's spawn held its thread, when S's child exited, and how
// long after that exit its 'close' came. A 'close' that waits about 4 s is S's pipe held open by
// L's child. With `serial`, one shared Atomics lock is held across each spawn() call. Two
// children per round, rounds one after another; nothing else is started.
//
// docs/engineering-record.md ("Spawn timing under load", the cold-push row) and
// src/spawn-thread.js (the comment above the spawn gate) quote it: overlapping, the instant
// child's 'close' came about 4 s after its exit in 8 of 8 rounds; serial, 0-1 ms after it in
// 8 of 8. That result is why src/spawn-thread.js holds one gate across each spawn(). This is the
// script that measured it, with comments added and its logic unchanged.

const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
if (isMainThread) {
  const rounds = Number(process.argv[2] || 8);
  const serial = process.argv[3] === 'serial';
  (async () => {
    const gaps = [];
    for (let i = 0; i < rounds; i += 1) {
      const barrier = new Int32Array(new SharedArrayBuffer(8));
      const lock = new Int32Array(new SharedArrayBuffer(4));
      const run = (role) => new Promise((resolve) => {
        const w = new Worker(__filename, { workerData: { role, barrier: barrier.buffer, lock: lock.buffer, serial } });
        w.once('message', resolve);
      });
      const [s] = await Promise.all([run('S'), run('L')]);
      gaps.push(s.closeGap);
      console.log(`round ${i + 1}: S spawn held ${s.held} ms, exit after ${s.exitAt} ms, close ${s.closeGap} ms after exit`);
    }
    gaps.sort((a, b) => a - b);
    console.log(`${serial ? 'serial' : 'overlapping'}: close gap p50 ${gaps[Math.floor(gaps.length / 2)]} ms, max ${gaps.at(-1)} ms, over 1 s: ${gaps.filter((g) => g > 1000).length} of ${gaps.length}`);
  })();
} else {
  const { spawn, execFile } = require('child_process');
  const barrier = new Int32Array(workerData.barrier);
  const lock = new Int32Array(workerData.lock);
  Atomics.add(barrier, 0, 1);
  Atomics.notify(barrier, 0);
  while (Atomics.load(barrier, 0) < 2) Atomics.wait(barrier, 0, 1, 5);
  const locked = (fn) => {
    if (!workerData.serial) return fn();
    while (Atomics.compareExchange(lock, 0, 0, 1) !== 0) Atomics.wait(lock, 0, 1, 20);
    try { return fn(); } finally { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0); }
  };
  const t0 = Date.now();
  if (workerData.role === 'L') {
    const child = locked(() => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)'], { stdio: 'pipe', windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } }));
    child.once('close', () => parentPort.postMessage({}));
  } else {
    let exitAt = null;
    const child = locked(() => execFile(process.execPath, ['-e', 'process.stdout.write("x")'], { windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' } }, () => {
      parentPort.postMessage({ held, exitAt: exitAt - t0, closeGap: Date.now() - exitAt });
    }));
    const held = Date.now() - t0;
    child.once('exit', () => { exitAt = Date.now(); });
  }
}
