'use strict';

// A single advisory lock guards every writer that touches agent policy files.
// Auto Learn and the extension's wildcarding pass both mutate
// ~/.claude/settings.json, and Auto Learn writes the claims registry in the
// same operation, so an interleaved write would leave the registry describing
// entries the other writer had already replaced.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const POLICY_LOCK_CODE = 'AUTO_LEARN_LOCKED';
const DEFAULT_STALE_MS = 10 * 60 * 1000;
// One canonical path for every writer — the extension, the CLI, and the Auto
// Learn manager's default. Derive it here rather than re-spelling it per caller,
// so a writer cannot end up holding a lock nobody else contends for.
const POLICY_LOCK_PATH = path.join(os.homedir(), '.claude', 'wildcarding', 'auto-learn-policy.lock');
const POLICY_LOCK_BUSY_MESSAGE =
  'Auto Learn is mid-scan — try again in a moment.';

// How old a lock file is, never negative. `stat.mtimeMs` carries sub-millisecond
// precision while `Date.now()` is whole milliseconds, so a file written moments
// ago can read as being from the FUTURE: measured over 200 writes on this
// machine, the raw difference ranged from -1.07 ms to +1.09 ms and was zero or
// negative 111 times.
//
// That made the reclaim test a coin flip. The comparison was also `<=`, so
// `staleMs: 0`, which must mean "reclaim immediately", instead meant "never
// reclaim" for any lock whose age rounded to zero. Clamping and comparing
// strictly makes `staleMs` read as "stale once older than this", so 0 reclaims
// at once and the boundary is no longer a lottery.
function lockAgeMs(stat) {
  return Math.max(0, Date.now() - stat.mtimeMs);
}

function createPolicyLock(options = {}) {
  const lockPath = options.lockPath;
  if (!lockPath) throw new Error('A policy lock requires a lock path');
  const staleMs = Number.isFinite(options.staleMs) ? Math.max(0, options.staleMs) : DEFAULT_STALE_MS;
  const clock = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const busy = typeof options.busyMessage === 'function'
    ? options.busyMessage
    : () => POLICY_LOCK_BUSY_MESSAGE;

  function removeOwnedLock(owner) {
    try {
      const metadata = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (metadata.owner !== owner) return false;
      fs.unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  }

  // Release a lock this process created but never managed to fill in.
  //
  // `openSync(..., 'wx')` creates the file and the metadata is written as a SECOND
  // step, so a throw in between — ENOSPC, EIO, a full quota — leaves a lock with no
  // owner in it. `removeOwnedLock` proves ownership by parsing that metadata, so it
  // returns false for the one file this process is unambiguously responsible for,
  // and the orphan is left for the staleness path to clean up: five seconds while it
  // is zero bytes (`honourFor` below), and the FULL stale window — ten minutes by
  // default — if the write got far enough to put bytes in it, because a non-empty
  // ownerless lock is indistinguishable from a foreign one by content alone.
  //
  // Identified by the inode read from our own descriptor rather than by content there
  // may be none of. `wx` means no other writer can have created this file, and the
  // inode comparison means a lock that some other process reclaimed and replaced
  // while this one was unwinding is left to its new owner.
  //
  // That comparison is also what fails closed when the inode is unknown: `createdIno`
  // is undefined only if `fstatSync` on an open descriptor failed, and no real inode
  // is ever equal to undefined, so the unlink is skipped without a separate branch.
  // An explicit `if (createdIno === undefined) return false` was written here first
  // and removed — no reachable input distinguished it, so it was a line that could
  // not be tested rather than a guard.
  function removeCreatedLock(owner, createdIno) {
    if (removeOwnedLock(owner)) return true;
    try {
      if (fs.statSync(lockPath).ino !== createdIno) return false;
      fs.unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  }

  // Only reclaim a lock whose owner is provably gone, and only after confirming
  // the file did not change while that was being decided.
  function recoverLock() {
    try {
      const stat = fs.statSync(lockPath);
      const text = fs.readFileSync(lockPath, 'utf8');
      let metadata = {};
      try { metadata = JSON.parse(text); } catch {}
      const validPid = Number.isInteger(metadata.pid) && metadata.pid > 0;
      if (validPid) {
        let alive = true;
        try { process.kill(metadata.pid, 0); }
        catch (error) {
          if (error.code === 'ESRCH') alive = false;
          else return false;
        }
        if (alive) return false;
      } else if (lockAgeMs(stat) < honourFor(stat, staleMs)) {
        return false;
      }
      const before = { text, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
      const verifyStat = fs.statSync(lockPath);
      const verifyText = fs.readFileSync(lockPath, 'utf8');
      if (verifyStat.size !== before.size || verifyStat.mtimeMs !== before.mtimeMs ||
          verifyStat.ino !== before.ino || verifyText !== before.text) return false;
      fs.unlinkSync(lockPath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      return false;
    }
  }

  function locked(operation) {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const owner = crypto.randomBytes(16).toString('hex');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let fd;
      let created = false;
      let createdIno;
      let failure;
      try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
        created = true;
        // Taken before the write, because after it throws there is no descriptor
        // left to ask and the file on disk can no longer prove whose it is.
        try { createdIno = fs.fstatSync(fd).ino; } catch {}
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, owner, at: clock() }) + '\n', 'utf8');
        fs.fsyncSync(fd);
      } catch (error) {
        failure = error;
      } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      }
      if (!failure) break;
      if (created) removeCreatedLock(owner, createdIno);
      if (failure.code === 'EEXIST' && attempt === 0 && recoverLock()) continue;
      if (failure.code === 'EEXIST') {
        const conflict = new Error(busy(lockPath));
        conflict.code = POLICY_LOCK_CODE;
        throw conflict;
      }
      throw failure;
    }
    try { return operation(); }
    finally { removeOwnedLock(owner); }
  }

  return { locked, path: lockPath };
}

// A lock file that was created but never filled in, and how long it is honoured.
//
// `locked` opens with `wx` and writes the metadata as a SECOND step, so a process that
// dies between those two calls leaves a zero-byte lock. There is no pid in it to probe,
// so `recoverLock` falls through to the age test and refuses to reclaim for the whole
// stale window — ten minutes by default, for a hole that is open for less than a
// millisecond. It fails closed rather than corrupting anything, but ten minutes is the
// wrong order of magnitude for the mistake, and the instruction-file lock in
// `agent-guidance.js` puts it on an interactive path where a user is waiting.
//
// A grace rather than an immediate reclaim, because a zero-byte lock is also what a
// HEALTHY holder looks like for that sub-millisecond window. `Math.min` so an explicit
// smaller `staleMs` keeps meaning what it says — `staleMs: 0` still reclaims at once.
// What makes this safe is the unchanged-file re-verification below the age test: if the
// real owner writes its metadata between the two stats, the size changes and the reclaim
// is abandoned.
const ZERO_BYTE_GRACE_MS = 5000;

function honourFor(stat, staleMs) {
  return stat.size === 0 ? Math.min(staleMs, ZERO_BYTE_GRACE_MS) : staleMs;
}

module.exports = {
  createPolicyLock,
  POLICY_LOCK_CODE,
  POLICY_LOCK_PATH,
  POLICY_LOCK_BUSY_MESSAGE,
  DEFAULT_POLICY_LOCK_STALE_MS: DEFAULT_STALE_MS,
};
