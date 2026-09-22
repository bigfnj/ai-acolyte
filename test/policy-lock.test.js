'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPolicyLock, POLICY_LOCK_CODE, POLICY_LOCK_BUSY_MESSAGE } = require('../src/policy-lock');

function tempLock(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-lock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'nested', 'auto-learn-policy.lock');
}

test('one holder at a time, and the lock is released on both paths', (t) => {
  const lockPath = tempLock(t);
  const first = createPolicyLock({ lockPath });
  const second = createPolicyLock({ lockPath });

  // Auto Learn and the wildcarding pass are separate lock objects over one path,
  // so the second writer must be told to back off rather than interleave.
  first.locked(() => {
    assert.ok(fs.existsSync(lockPath), 'the lock file exists while held');
    assert.throws(() => second.locked(() => {}), (error) => error.code === POLICY_LOCK_CODE);
  });
  assert.ok(!fs.existsSync(lockPath), 'released after the callback returns');

  assert.throws(() => first.locked(() => { throw new Error('write failed'); }), /write failed/);
  assert.ok(!fs.existsSync(lockPath), 'released after the callback throws');

  assert.equal(second.locked(() => 'ran'), 'ran');
});

// One string per condition. The thrown message used to be a second wording of the same
// fact ("Auto Learn is already running (lock: …)") that every consumer threw away and
// replaced with POLICY_LOCK_BUSY_MESSAGE by hand, so the two could drift and only the
// discarded one carried the lock path. The constant IS the default now, and a caller with
// a different condition to describe — the instruction-file lock in agent-guidance.js —
// supplies `busyMessage` instead of inheriting a message about Auto Learn.
test('the thrown message is the one the consumers show, and a supplier can override it', (t) => {
  const lockPath = tempLock(t);
  const held = createPolicyLock({ lockPath });
  held.locked(() => {
    assert.throws(() => createPolicyLock({ lockPath }).locked(() => {}),
      (error) => error.message === POLICY_LOCK_BUSY_MESSAGE);
    assert.throws(
      () => createPolicyLock({ lockPath, busyMessage: (target) => `mine: ${target}` }).locked(() => {}),
      (error) => error.message === `mine: ${lockPath}`);
  });
});

test('a lock left by a dead process is reclaimed, a live one is not', (t) => {
  const lockPath = tempLock(t);
  const lock = createPolicyLock({ lockPath });
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  // A pid that cannot exist stands in for a crashed holder.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 31 - 1, owner: 'gone' }) + '\n');
  assert.equal(lock.locked(() => 'reclaimed'), 'reclaimed');

  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: 'alive' }) + '\n');
  assert.throws(() => lock.locked(() => {}), (error) => error.code === POLICY_LOCK_CODE);
  assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')).owner, 'alive',
    'a live holder keeps its lock file');
});

test('an ownerless lock is only reclaimed once it is stale', (t) => {
  const lockPath = tempLock(t);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, 'not json\n');

  const patient = createPolicyLock({ lockPath, staleMs: 10 * 60 * 1000 });
  assert.throws(() => patient.locked(() => {}), (error) => error.code === POLICY_LOCK_CODE);

  const impatient = createPolicyLock({ lockPath, staleMs: 0 });
  assert.equal(impatient.locked(() => 'reclaimed'), 'reclaimed');
});

// The orphan `locked()` leaves behind if it dies mid-acquire: `openSync(..., 'wx')`
// creates the file and the metadata is written as a SECOND step, so a crash in between
// leaves a lock with no pid to probe. `recoverLock` then falls to the age test, which
// used to refuse for the full stale window — ten minutes, for a write that takes
// milliseconds, on a path a user is now waiting on through the instruction-file lock.
test('a zero-byte lock is honoured for a short grace, not the full stale window', (t) => {
  const lockPath = tempLock(t);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const patient = () => createPolicyLock({ lockPath, staleMs: 10 * 60 * 1000 });
  const atAge = (contents, ms) => {
    fs.writeFileSync(lockPath, contents);
    const when = new Date(Date.now() - ms);
    fs.utimesSync(lockPath, when, when);
  };

  // Well past any honest holder of a hole that is open for under a millisecond.
  atAge('', 30_000);
  assert.equal(patient().locked(() => 'reclaimed'), 'reclaimed');

  // Inside the grace it is still held: an empty lock is also what a HEALTHY holder
  // looks like for that window, so reclaiming on sight would evict a live writer.
  atAge('', 0);
  assert.throws(() => patient().locked(() => {}), (error) => error.code === POLICY_LOCK_CODE);

  // A non-empty ownerless lock is untouched by the grace and still waits out the
  // full window — otherwise this would be a five-second stale window for every lock.
  atAge('not json\n', 30_000);
  assert.throws(() => patient().locked(() => {}), (error) => error.code === POLICY_LOCK_CODE);

  // And an explicit smaller staleMs keeps meaning what it says rather than being
  // lengthened to the grace.
  atAge('', 0);
  assert.equal(createPolicyLock({ lockPath, staleMs: 0 }).locked(() => 'now'), 'now');
});

// The other half of that orphan: not a crash, but a WRITE that fails. `openSync`
// has already created the file by then, so the failure unwinds past a lock this
// process is holding and cannot prove it owns — `removeOwnedLock` parses metadata
// that was never written and returns false. The grace above caps the zero-byte case
// at five seconds; the partial-write case is not zero bytes and waits out the whole
// stale window. Either way the holder died before it existed, so nobody should wait.
//
// `fd` is a number only for the metadata write inside `locked`, which is what makes
// this patch surgical: `tempLock`'s own writes and the test's go through untouched.
function failingFdWrite(t, onWrite) {
  const real = fs.writeFileSync;
  t.after(() => { fs.writeFileSync = real; });
  fs.writeFileSync = function (target, ...rest) {
    if (typeof target !== 'number') return real.call(fs, target, ...rest);
    if (onWrite) onWrite();
    const error = new Error('no space left on device');
    error.code = 'ENOSPC';
    throw error;
  };
  return () => { fs.writeFileSync = real; };
}

test('a lock whose write failed is cleaned up by the process that created it', (t) => {
  const lockPath = tempLock(t);
  const restore = failingFdWrite(t);

  assert.throws(() => createPolicyLock({ lockPath }).locked(() => 'never runs'),
    (error) => error.code === 'ENOSPC',
    'the write failure is reported, not swallowed into a busy error');
  assert.ok(!fs.existsSync(lockPath),
    'openSync created the lock file and the metadata write threw; the creating '
    + 'process must remove it rather than leave an ownerless lock behind');

  restore();
  // The consequence, stated as the next writer sees it: no wait, no stale window.
  assert.equal(createPolicyLock({ lockPath, staleMs: 10 * 60 * 1000 }).locked(() => 'ran'), 'ran',
    'the next writer acquires at once instead of waiting out the stale window');
});

test('a PARTIALLY written lock is cleaned up too, not left for the stale window', (t) => {
  const lockPath = tempLock(t);
  // Bytes on disk, but not parseable metadata — ENOSPC halfway through the write.
  // This is the case the zero-byte grace cannot help with: `honourFor` only shortens
  // the window for an EMPTY file, so a truncated one is honoured for the full ten
  // minutes, and it is exactly as ownerless as the empty one.
  const restore = failingFdWrite(t, () => fs.writeFileSync(lockPath, '{"pid":1,"own'));

  assert.throws(() => createPolicyLock({ lockPath }).locked(() => 'never runs'),
    (error) => error.code === 'ENOSPC');
  assert.ok(!fs.existsSync(lockPath),
    'a half-written lock is still this process\'s to remove; leaving it strands '
    + 'every later writer for the full stale window, which the grace never shortens');

  restore();
  assert.equal(createPolicyLock({ lockPath, staleMs: 10 * 60 * 1000 }).locked(() => 'ran'), 'ran');
});

test('the cleanup removes OUR lock, never a file that replaced it', (t) => {
  const lockPath = tempLock(t);
  // Someone else reclaims and re-creates the lock between our `openSync` and our
  // cleanup. Deleting on sight would evict a live holder mid-write; the inode taken
  // from our own descriptor is what tells the two apart.
  //
  // Driven at the COMPARISON, not through a real usurper. Simulating one means
  // unlink-then-recreate at the same path, and that is not deterministic here: NTFS
  // can hand the replacement the MFT record it just freed. Measured — the
  // filesystem version of this test passed 30/30 runs on its own and then failed
  // inside the parallel full suite, where the guard was fine and the simulation was
  // not. Making `fstatSync` report an inode the file on disk does not have puts the
  // cleanup in exactly the state a usurper would, with no race in it.
  const realFstat = fs.fstatSync;
  t.after(() => { fs.fstatSync = realFstat; });
  fs.fstatSync = (fd, ...rest) => ({ ...realFstat.call(fs, fd, ...rest), ino: -1 });
  const restore = failingFdWrite(t);

  assert.throws(() => createPolicyLock({ lockPath }).locked(() => 'never runs'),
    (error) => error.code === 'ENOSPC');
  fs.fstatSync = realFstat;
  restore();

  assert.ok(fs.existsSync(lockPath),
    'the cleanup must unlink only the file whose inode it recorded; a lock some '
    + 'other process reclaimed and replaced belongs to its new owner, which is '
    + 'alive and mid-write, and unlinking it would evict a live holder');
});

// The reclaim boundary, made deterministic. The test above reaches it only by
// accident of timing: `stat.mtimeMs` carries sub-millisecond precision while
// `Date.now()` is whole milliseconds, so a just-written file can read as being
// from the future. Measured over 200 writes, the raw difference ranged from
// -1.07 ms to +1.09 ms and was zero or negative 111 times.
//
// On Windows the intervening `patient.locked()` attempt burns more than a
// millisecond of file operations, so the age is positive by the time it
// matters and the old `<=` comparison passed. On Linux those operations are
// fast enough that the age is still zero, which is why CI failed on v1.4.0 and
// v1.3.0 passed by luck. Setting mtime explicitly removes the lottery.
test('the reclaim boundary does not depend on sub-millisecond timing', (t) => {
  const lockPath = tempLock(t);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const atAge = (ms) => {
    fs.writeFileSync(lockPath, 'not json\n');
    const when = new Date(Date.now() - ms);
    fs.utimesSync(lockPath, when, when);
  };

  // `staleMs: 0` must mean "reclaim immediately", so an age of exactly zero
  // reclaims. Under `<=` this returned false and the lock was never reclaimed.
  atAge(0);
  assert.equal(createPolicyLock({ lockPath, staleMs: 0 }).locked(() => 'now'), 'now');

  // A clock skew that puts the file in the future must not read as "fresh
  // forever" either; the age is clamped rather than left negative.
  atAge(-5000);
  assert.equal(createPolicyLock({ lockPath, staleMs: 0 }).locked(() => 'future'), 'future');

  // A lock younger than the window is still held, which is the whole point.
  atAge(0);
  assert.throws(() => createPolicyLock({ lockPath, staleMs: 60_000 }).locked(() => {}),
    (error) => error.code === POLICY_LOCK_CODE);
  atAge(59_000);
  assert.throws(() => createPolicyLock({ lockPath, staleMs: 60_000 }).locked(() => {}),
    (error) => error.code === POLICY_LOCK_CODE);

  // And older than the window is reclaimed.
  atAge(61_000);
  assert.equal(createPolicyLock({ lockPath, staleMs: 60_000 }).locked(() => 'stale'), 'stale');
});
