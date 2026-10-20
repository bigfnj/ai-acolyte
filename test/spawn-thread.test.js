'use strict';

// src/spawn-thread.js: the extension host's two spawns, made from worker threads
// (2026-10-14). What these pin is that moving the spawn changed nothing else:
// execFile's answer has the same shape; the trust ask keeps its budget, its
// deadline, its wording and its tree kill on every platform; and a host that dies
// outright still takes the worker with it, with the thread in between.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { execFileOffThread } = require('../src/spawn-thread');
const { endProcessTree } = require('../src/exec-resolve');
const api = require('../src/codex-mcp-config');

const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
async function waitFor(predicate, ms) {
  const start = Date.now();
  while (!predicate() && Date.now() - start < ms) await new Promise((resolve) => setTimeout(resolve, 50));
  return predicate();
}
const readPid = (file) => (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8').trim()) || null : null);

// ONE hook, in this order: kill what the test recorded, wait for it to be gone, and
// only then remove the directory. A stand-in that is still running stands in it,
// and a .cmd stand-in's hidden console host keeps that cwd for about a second
// after it dies, which rmSync does not retry. Two hooks registered remove-first
// left a directory behind on every run.
function scratch(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `acolyte-spawn-thread-${name}-`));
  const pids = [];
  t.after(async () => {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await waitFor(() => pids.every(gone), 3000);
    await waitFor(() => { try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; } }, 5000);
  });
  return { dir, pids };
}

// A codex that starts and never answers: the npm shape on Windows (cmd.exe -> node),
// sh exec node on POSIX. It writes its pid first.
function hangingCodex(dir) {
  const pidFile = path.join(dir, 'codex.pid');
  const script = path.join(dir, 'hang.js');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
  if (process.platform === 'win32') {
    const shim = path.join(dir, 'codex.cmd');
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return { executable: shim, pidFile };
  }
  const shim = path.join(dir, 'codex');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return { executable: shim, pidFile };
}

test('execFile on a thread answers in execFile\'s shape, and its handle closes when the thread is done', async () => {
  const ok = await new Promise((resolve) => {
    const child = execFileOffThread(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err")'],
      { windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout, stderr, child }));
  });
  assert.equal(ok.error, null);
  assert.equal(ok.stdout, 'out');
  assert.equal(ok.stderr, 'err');
  const failed = await new Promise((resolve) => {
    execFileOffThread(process.execPath, ['-e', 'process.exit(3)'], { windowsHide: true }, (error) => resolve(error));
  });
  assert.match(failed.message, /^Command failed:/);
  assert.equal(failed.code, 3, 'the exit code is the error code, as execFile reports it');
  const missing = await new Promise((resolve) => {
    execFileOffThread(path.join(os.tmpdir(), 'acolyte-no-such-program-xyz.exe'), [], { windowsHide: true }, (error) => resolve(error));
  });
  assert.equal(missing.code, 'ENOENT');
  // 'close' follows the answer, once the thread has exited; a tree kill after it is
  // a no-op that resolves at once.
  if (!ok.child.closed) await new Promise((resolve) => ok.child.once('close', resolve));
  const started = Date.now();
  await endProcessTree(ok.child);
  assert.ok(Date.now() - started < 100, 'a closed thread child is not asked to end anything');
});

// THE GATE EVERY SPAWN THREAD SHARES (2026-10-20, src/spawn-thread.js "ONE SPAWN AT A TIME").
// Driven from here, through the process-wide slot the module keeps it in: while this thread
// holds the gate no spawn thread starts its child, and a hold older than GATE_STALE_MS (5 s)
// is taken over. The dashboard's consequence, the version probe waiting on the trust worker,
// is pinned in test/dashboard-project-trust.test.js.
test('a thread spawns only while no other holds the gate, and takes over a hold left stale', async () => {
  const run = () => {
    const answer = { at: null };
    execFileOffThread(process.execPath, ['-e', ''], { windowsHide: true }, (error) => { answer.at = Date.now(); answer.error = error; });
    return answer;
  };
  const first = run();
  assert.ok(await waitFor(() => first.at, 15000), 'precondition: a thread spawned and answered');
  const shared = globalThis[Symbol.for('ai-acolyte.spawn-gate')];
  assert.ok(shared instanceof SharedArrayBuffer, 'precondition: the threads were handed the process\'s gate');
  const lock = new Int32Array(shared, 0, 1);
  const base = new Float64Array(shared, 8, 1);
  const stamp = (at) => 1 + Math.floor((at - base[0]) / 100);
  assert.equal(Atomics.compareExchange(lock, 0, 0, stamp(Date.now())), 0, 'precondition: the gate was free');
  const held = run();
  // No clock in the claim: nothing releases the gate but this test. MUTATION: make `gated`
  // run its spawn at once. The answer lands during this wait and this fails. Confirmed 2026-10-20.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const releasedAt = Date.now();
  assert.equal(held.at, null, 'a thread spawned while another held the gate');
  Atomics.store(lock, 0, 0);
  Atomics.notify(lock, 0);
  assert.ok(await waitFor(() => held.at, 15000), 'the spawn ran once the gate was released');
  assert.equal(held.error, null);
  assert.ok(held.at >= releasedAt);
  // A hold taken "10 s ago": `base` is moved back, which only this process's threads read.
  base[0] = Date.now() - 60000;
  Atomics.store(lock, 0, stamp(Date.now() - 10000));
  const stale = run();
  try {
    // MUTATION: drop the stale takeover in `gated`. The thread waits on the stale hold and
    // this times out. Confirmed 2026-10-20.
    assert.ok(await waitFor(() => stale.at, 15000), 'a stale hold stopped every later spawn');
    assert.equal(stale.error, null);
    assert.equal(Atomics.load(lock, 0), 0, 'the thread that took the stale hold over released it');
  } finally {
    // So a failure here fails by name instead of leaving that thread waiting with the file open.
    if (stale.at === null) { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0); }
  }
});

// The asynchronous layers read, as the extension makes it (`offThread: true`):
// bounded by its budget, ended by the worker's own deadline (its wording), and no
// codex left running. The same contract test/codex-mcp-config.test.js pins for
// the in-process route.
test('the trust ask on a thread keeps its budget, its deadline\'s wording and its kill', async (t) => {
  const { dir, pids } = scratch(t, 'ask');
  const home = path.join(dir, 'home'), codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const codex = hangingCodex(dir);
  const tracked = [];
  const started = Date.now();
  const reading = api.readCodexConfigLayersAsync({ home, codexHome, workspaceRoot: dir, codexExecutable: codex.executable,
    timeoutMs: 4000, offThread: true, track: (child) => tracked.push(child) });
  assert.ok(Date.now() - started < 50, 'the call returned without waiting on any spawn');
  assert.equal(tracked.length, 1, 'the thread child is handed to the caller, so a deactivate can end it');
  await assert.rejects(reading, /^Error: Codex config RPC refused: Codex config operation timed out$/);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 6000, `bounded by its 4 s budget plus a kill: took ${elapsed} ms`);
  const pid = readPid(codex.pidFile);
  if (pid) {
    pids.push(pid);
    assert.equal(await waitFor(() => gone(pid), 3000), true, 'the worker ended the codex it started');
  }
});

// Deactivate's path: killLiveChildren calls endProcessTree on what `track`
// received, which here is the ThreadChild. The thread ends the worker it started
// with the real endProcessTree, so taskkill /T on Windows and the group signal on
// POSIX reach the codex under it. The worker's deadline is its 25 s ceiling, so
// within these 3 s only the kill can have ended the codex.
test('ending a thread child ends the worker and the codex it started, on every platform', async (t) => {
  const { dir, pids } = scratch(t, 'tree');
  const home = path.join(dir, 'home'), codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const codex = hangingCodex(dir);
  const tracked = [];
  const outcome = api.readCodexConfigLayersAsync({ home, codexHome, workspaceRoot: dir, codexExecutable: codex.executable,
    timeoutMs: 40000, offThread: true, track: (child) => tracked.push(child) }).then(() => 'answered', (error) => error.message);
  assert.ok(await waitFor(() => readPid(codex.pidFile), 30000), 'precondition: the worker started the stand-in codex');
  const pid = readPid(codex.pidFile);
  pids.push(pid);
  assert.equal(gone(pid), false, 'precondition: the stand-in codex is running');
  // MUTATION: make the thread ignore the host's `end` message (runTask's handler
  // returns at once). Nothing ends the worker, and the codex is still running
  // here. Confirmed 2026-10-14.
  await endProcessTree(tracked[0]);
  assert.equal(await waitFor(() => gone(pid), 3000), true, 'the codex under the worker was ended with it');
  assert.match(await outcome, /^Codex config RPC is unavailable: Command failed: the worker exited/,
    'a killed worker reads as unavailable, as it does without the thread');
  assert.equal(await waitFor(() => tracked[0].closed, 3000), true, 'the thread exits once its worker has closed');
});

// THE HOST DYING OUTRIGHT, WITH THE THREAD IN BETWEEN. A thread's children are its
// process's children: libuv's kill-on-close job on Windows belongs to the process,
// and on POSIX the worker's ppid is the host's pid, so its host watch fires. The
// worker's pid is learned from a preload, active only in the process that runs
// --rpc-worker. The worker's deadline is its 25 s ceiling, so within these 5 s only
// the host's death can have ended it.
test('a host that dies outright still takes the worker it started from a thread', async (t) => {
  const { spawn } = require('node:child_process');
  const { dir, pids } = scratch(t, 'death');
  const home = path.join(dir, 'home'), codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const codex = hangingCodex(dir);
  const workerPidFile = path.join(dir, 'worker.pid');
  const preload = path.join(dir, 'worker-pid.js');
  fs.writeFileSync(preload, `if (process.argv.includes('--rpc-worker')) require('fs').writeFileSync(${JSON.stringify(workerPidFile)}, String(process.pid));\n`);
  const host = spawn(process.execPath, ['-e', `
    require(${JSON.stringify(path.join(__dirname, '..', 'src', 'codex-mcp-config.js'))}).readCodexConfigLayersAsync({
      home: ${JSON.stringify(home)}, codexHome: ${JSON.stringify(codexHome)}, workspaceRoot: ${JSON.stringify(dir)},
      codexExecutable: ${JSON.stringify(codex.executable)}, timeoutMs: 40000, offThread: true,
    }).catch(() => {});
    setInterval(() => {}, 1000);`], {
    stdio: 'ignore', windowsHide: true,
    // NODE_OPTIONS reads a backslash inside quotes as an escape: forward slashes.
    env: { ...process.env, NODE_OPTIONS: `--require "${preload.split(path.sep).join('/')}"` },
  });
  pids.push(host.pid);
  assert.ok(await waitFor(() => readPid(codex.pidFile) && readPid(workerPidFile), 30000),
    'precondition: the host\'s thread started the worker, and the worker the stand-in codex');
  const worker = readPid(workerPidFile), hung = readPid(codex.pidFile);
  pids.push(worker, hung);
  host.kill('SIGKILL');
  assert.equal(await waitFor(() => gone(worker), 5000), true, 'the worker outlived its host');
  // Windows keeps the residual recorded in test/codex-mcp-config.test.js: a .cmd
  // codex's node breaks away from both jobs.
  if (process.platform === 'win32') return;
  assert.equal(await waitFor(() => gone(hung), 3000), true, 'the codex under the worker outlived the host');
});
