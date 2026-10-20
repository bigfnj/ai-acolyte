'use strict';
// SPAWN TIMING CAPTURE: a NODE_OPTIONS preload (committed 2026-10-20).
//
//   usage: CAPTURE_DIR=<empty dir> NODE_OPTIONS='--require "<repo>/scripts/measure/spawn-capture.js"' node --test
//          node scripts/measure/spawn-capture-summary.js <dir> [<dir> ...]
//
// WHAT IT MEASURES. Loaded into every node process and worker thread of a run, it writes one
// JSONL file per process and thread, `p<pid>-t<threadId>.jsonl`, under CAPTURE_DIR:
//   start       when the process (or thread) began running JS, with performance.timeOrigin,
//               its ppid, the tail of its argv and of its executable path;
//   spawned     every child_process.spawn and execFile, with `held`: how many ms the call
//               held its thread (on Windows libuv's spawn returns only once CreateProcess has);
//   spawnSync   every spawnSync, with how long it took and its status;
//   child-exit, child-close, child-error, kill
//               when each child's 'exit' and 'close' arrived, and every kill() called on it;
//   self-exit   the process's own exit.
// Every line carries `at` (Date.now()), `pid` and `tid`. It does nothing when CAPTURE_DIR is
// unset. Paths are cut to their last 80 characters, but a capture still holds local paths and
// argv, so a capture is evidence to read, not a fixture to commit.
//
// HOW IT WAS USED. docs/engineering-record.md, "Spawn timing under load: what a timing capture
// found (2026-10-20)": three full `node --test` runs of `d4e977d` on the development box, each
// with CAPTURE_DIR set to a fresh directory and NODE_OPTIONS loading this file, inside the
// shared suite lock. scripts/measure/spawn-capture-summary.js, given those three directories,
// printed the spawn() hold and child-start figures the record quotes. Per-test timelines were
// read from the same files by hand. This file is the preload those runs used: comments added,
// its logic unchanged.
//
// WHAT IS NOT COMMITTED, AND WHY. Those runs also had a synthetic LOAD GENERATOR running
// beside the suite: 6 loops spawning `node -e 0` and `cmd /c exit` back to back, N worker
// threads spinning, and 1 loop copying node.exe to a fresh temp file and running it once (a
// first run of a new executable, which endpoint scanning holds). An experiment runner started
// it, waited 3 s, ran the suite with this preload and a JSONL test reporter, then ended the
// load's tree with taskkill /T. WARNING: at N=8 the development box locked up and rebooted at
// 23:59 on 2026-10-19 (Kernel-Power 41, no BugCheck), during such a run. Whether the load
// caused it is not known; every run after it used N=4. The generator is described here and
// deliberately left out of the repo. Do not rebuild it to repeat these figures without the
// owner's agreement, and never run it above that level. This preload adds no load of its own:
// one appendFileSync per event.

const dir = process.env.CAPTURE_DIR;
if (dir) {
  const fs = require('fs');
  const path = require('path');
  const { performance } = require('perf_hooks');
  let threadId = 0;
  try { threadId = require('worker_threads').threadId; } catch {}
  const file = path.join(dir, `p${process.pid}-t${threadId}.jsonl`);
  const log = (entry) => {
    try { fs.appendFileSync(file, JSON.stringify({ at: Date.now(), pid: process.pid, tid: threadId, ...entry }) + '\n'); } catch {}
  };
  const short = (value) => String(value).slice(-80);
  log({ ev: 'start', ppid: process.ppid, origin: Math.round(performance.timeOrigin), argv: process.argv.slice(1).map(short).slice(0, 6), exec: short(process.execPath) });
  process.on('exit', (code) => log({ ev: 'self-exit', code }));
  const cp = require('child_process');
  const watch = (child, how, file, args, t0) => {
    if (!child || typeof child.once !== 'function') return child;
    const pid = child.pid;
    log({ ev: 'spawned', how, child: pid, file: short(file), args: (Array.isArray(args) ? args : []).map(short).slice(0, 5), held: Date.now() - t0 });
    child.once('exit', (code, signal) => log({ ev: 'child-exit', child: pid, code, signal }));
    child.once('close', (code, signal) => log({ ev: 'child-close', child: pid, code, signal }));
    child.once('error', (error) => log({ ev: 'child-error', child: pid, err: String(error && error.message) }));
    const kill = child.kill;
    if (typeof kill === 'function') {
      child.kill = function (...rest) { const r = kill.apply(this, rest); log({ ev: 'kill', child: pid, sig: rest[0] || 'SIGTERM', ok: r }); return r; };
    }
    return child;
  };
  const { spawn, execFile, spawnSync } = cp;
  cp.spawn = function (file, args) {
    const t0 = Date.now();
    return watch(spawn.apply(this, arguments), 'spawn', file, args, t0);
  };
  cp.execFile = function (file, args) {
    const t0 = Date.now();
    return watch(execFile.apply(this, arguments), 'execFile', file, args, t0);
  };
  cp.spawnSync = function (file, args) {
    const t0 = Date.now();
    const r = spawnSync.apply(this, arguments);
    log({ ev: 'spawnSync', file: short(file), args: (Array.isArray(args) ? args : []).map(short).slice(0, 5), ms: Date.now() - t0, status: r && r.status, signal: r && r.signal, err: r && r.error && r.error.code });
    return r;
  };
}
