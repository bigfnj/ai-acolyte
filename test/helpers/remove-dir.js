'use strict';

// Removes a test's scratch directory, waiting out a process that is still letting go of it.
//
// fs.rmSync's maxRetries does not retry EPERM on Node 24 on Windows. Measured 2026-10-20 on
// Node 24.16.0: with a child process standing in a directory for 800 ms, fs.rmSync with
// { recursive, force, maxRetries: 20, retryDelay: 100 } threw EPERM after 0 ms, twice, and
// fs.promises.rm with the same options removed the directory after about 1 s, twice. So each of
// the 28 cleanups in test/ that handed maxRetries to rmSync threw, or left the directory, in
// exactly the case its retries were written for. fs.promises.rm retries EBUSY, EMFILE,
// ENFILE, ENOTEMPTY and EPERM, waiting retryDelay longer each time, so RETRIES at
// RETRY_DELAY_MS gives a holder up to 5.5 s to go. Its waits are Node's own timers, not
// global.setTimeout, so a test that stubs that does not stall them (measured the same day).
//
// node:test awaits a hook that returns a promise, so a caller writes
// `t.after(() => removeDir(dir))`. A call site that cannot await keeps fs.rmSync in a hand
// loop instead, as the fixture cleanup in test/probe-user-hooks.test.js does.
//
// node --test runs every .js under test/, this file too, so its own tests live here and are
// registered only when this is the file being run: a test file that requires it does not run
// them again.

const fs = require('node:fs');

const RETRIES = 10;
const RETRY_DELAY_MS = 100;

function removeDir(dir) {
  return fs.promises.rm(dir, { recursive: true, force: true, maxRetries: RETRIES, retryDelay: RETRY_DELAY_MS });
}

// The same retries, synchronously, for a file where an awaited fs.promises.rm cannot be used
// (2026-10-20). In test/extension-open-threads.test.js it kept the test file's process alive after
// its last test on CI's Node 20 / windows-latest, with no ref'd timer, request or handle visible from
// the main thread, so the run hung until cancelled; the same file as in v1.9.3 (a synchronous
// rmSync) finished in 2 min 28 s (CI runs 39462957968, 39475465959, 39476692653, 39477929287).
// Why Node 20 keeps that process is not known. The wait between tries blocks the thread, so it
// starts no timer: Atomics.wait on a private buffer.
const RETRYABLE = new Set(['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM']);
function removeDirSync(dir) {
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!RETRYABLE.has(error.code) || attempt >= RETRIES) throw error;
      Atomics.wait(nap, 0, 0, RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

module.exports = { removeDir, removeDirSync };

if (require.main === module) {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const os = require('node:os');
  const path = require('node:path');
  const { once } = require('node:events');
  const { spawn } = require('node:child_process');

  test('removeDir removes a nested tree, and a directory already gone is not an error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-remove-dir-'));
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'b', 'file.txt'), 'x');
    await removeDir(dir);
    assert.equal(fs.existsSync(dir), false, 'the tree is gone');
    await removeDir(dir);
  });

  // Windows only: on POSIX a process standing in a directory does not stop its removal, so there
  // is nothing to wait out, and the reporter prints this reason beside the skip.
  // MUTATION: removeDir back to fs.rmSync with the same maxRetries and retryDelay, and this
  // fails on EPERM at once, the directory still there.
  test('removeDir waits out a process standing in the directory for about a second', {
    skip: process.platform !== 'win32' && 'POSIX removes a directory a process stands in, so there is no hold to wait out',
  }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-remove-dir-held-'));
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setTimeout(() => {}, 1000);"],
      { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const exited = once(child, 'exit');
    t.after(async () => {
      child.kill();
      await exited;
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: RETRIES, retryDelay: RETRY_DELAY_MS });
    });
    await Promise.race([once(child.stdout, 'data'),
      exited.then(() => { throw new Error('precondition: the child exited before it stood in the directory'); })]);
    // WITNESS: the hold is real. A removal that does not wait fails now, so the one below had
    // something to wait out.
    assert.throws(() => fs.rmSync(dir, { recursive: true, force: true }), { code: /^(EPERM|EBUSY)$/ },
      'precondition: the child standing in the directory stops a plain removal');
    const started = Date.now();
    await removeDir(dir);
    assert.equal(fs.existsSync(dir), false, `the directory is gone, ${Date.now() - started} ms after removeDir started`);
  });

  // MUTATION: removeDirSync's catch rethrows at once (no retry), and this fails on EPERM.
  test('removeDirSync waits out a process standing in the directory for about a second', {
    skip: process.platform !== 'win32' && 'POSIX removes a directory a process stands in, so there is no hold to wait out',
  }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-remove-dir-sync-held-'));
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setTimeout(() => {}, 1000);"],
      { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const exited = once(child, 'exit');
    t.after(async () => {
      child.kill();
      await exited;
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: RETRIES, retryDelay: RETRY_DELAY_MS });
    });
    await Promise.race([once(child.stdout, 'data'),
      exited.then(() => { throw new Error('precondition: the child exited before it stood in the directory'); })]);
    assert.throws(() => fs.rmSync(dir, { recursive: true, force: true }), { code: /^(EPERM|EBUSY)$/ },
      'precondition: the child standing in the directory stops a plain removal');
    // The child must be able to exit while this thread blocks: it is a separate process, and its
    // own 1 s timer ends it.
    const started = Date.now();
    removeDirSync(dir);
    assert.equal(fs.existsSync(dir), false, `the directory is gone, ${Date.now() - started} ms after removeDirSync started`);
  });
}
