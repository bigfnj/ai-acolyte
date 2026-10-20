'use strict';

// scripts/prune-drive-dirs.js, which scripts/drive-vscode.js runs before it makes a run's
// directory, against a fake temp root and never the real one: every call here passes `root`.
// On 2026-10-20 the real %TEMP% held 112 drive directories, 3.00 GB, that nothing pruned.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { removeDir } = require('./helpers/remove-dir');
const { DRIVE_PREFIX, pruneDriveDirs } = require('../scripts/prune-drive-dirs');

const HOUR = 60 * 60 * 1000;
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

// A junction made on a directory something still has open can fail EBUSY or EPERM for a moment
// on Windows (test/codex-memory-gates.test.js has the measurements); retried briefly.
function link(target, at) {
  for (let attempt = 0; ; attempt += 1) {
    try { fs.symlinkSync(target, at, LINK_TYPE); return; } catch (error) {
      if (process.platform !== 'win32' || !['EBUSY', 'EPERM'].includes(error.code) || attempt >= 10) throw error;
      if (fs.existsSync(at) && !fs.lstatSync(at).isSymbolicLink() && !fs.readdirSync(at).length) fs.rmdirSync(at);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

// The fake root: five run directories 1 to 5 hours old, the run at index i holding one file of
// 100 * (i + 1) bytes. Beside them, each made 48 hours old so that it falls in the pruned set
// the moment it is taken for a run: a directory with another name, a run-like name one character
// short, a FILE with a run's name, and a junction (a symlink on POSIX) with a run's name, whose
// own time is new but whose target's is old. Every link points at `outside`, which holds a file
// nothing may remove, and the oldest run holds a link to it as well.
function fakeRoot(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-prune-drive-'));
  t.after(() => removeDir(base));
  const root = path.join(base, 'temp');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'p'.repeat(5000));
  const now = Date.now();
  const age = (target, hoursOld) => { const at = new Date(now - hoursOld * HOUR); fs.utimesSync(target, at, at); };
  const runs = [];
  for (let i = 1; i <= 5; i += 1) {
    const dir = path.join(root, `${DRIVE_PREFIX}run00${i}`);
    fs.mkdirSync(path.join(dir, 'user-data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'user-data', 'log.txt'), 'x'.repeat(100 * i));
    runs.push({ dir, bytes: 100 * i });
  }
  link(outside, path.join(runs[4].dir, 'linked-outside'));
  runs.forEach(({ dir }, i) => age(dir, i + 1));
  const others = {
    otherName: path.join(root, 'acolyte-vscode-other-AbC123'),
    shortName: path.join(root, `${DRIVE_PREFIX}short`),
    fileNamed: path.join(root, `${DRIVE_PREFIX}file01`),
    linkNamed: path.join(root, `${DRIVE_PREFIX}link01`),
  };
  fs.mkdirSync(others.otherName);
  fs.writeFileSync(path.join(others.otherName, 'keep.txt'), 'keep');
  fs.mkdirSync(others.shortName);
  fs.writeFileSync(others.fileNamed, 'a file, not a run');
  link(outside, others.linkNamed);
  for (const target of [others.otherName, others.shortName, others.fileNamed, outside]) age(target, 48);
  return { root, outside, runs, others };
}

function capture() {
  const lines = { log: [], warn: [] };
  return { lines, log: { log: (line) => lines.log.push(line), warn: (line) => lines.warn.push(line) } };
}

const exists = (target) => { try { fs.lstatSync(target); return true; } catch { return false; } };

// MUTATION: drop the keep-N (`runs.slice(keep)` to `runs`) and the three newest are gone.
// MUTATION: drop the prefix check and the directory with another name is removed.
// MUTATION: lstatSync to statSync and the junction with a run's name is taken for an old run
// and unlinked.
test('the three most recent runs stay, the older ones go, and nothing else in the root is touched', (t) => {
  const box = fakeRoot(t);
  const { lines, log } = capture();
  const result = pruneDriveDirs({ root: box.root, env: {}, log });

  assert.deepEqual(box.runs.map(({ dir }) => exists(dir)), [true, true, true, false, false],
    'the 3 newest runs are kept and the 2 older ones removed');
  assert.equal(exists(path.join(box.others.otherName, 'keep.txt')), true, 'a directory with another name is left');
  assert.equal(exists(box.others.shortName), true, 'a name one character short of a run is left');
  assert.equal(fs.readFileSync(box.others.fileNamed, 'utf8'), 'a file, not a run', 'a file with a run\'s name is left');
  assert.equal(exists(box.others.linkNamed) && fs.lstatSync(box.others.linkNamed).isSymbolicLink(), true,
    'a junction with a run\'s name is left, as a link');
  assert.equal(fs.readFileSync(path.join(box.outside, 'precious.txt'), 'utf8').length, 5000,
    'nothing behind a link was removed, from inside a run or from the root');
  assert.deepEqual(result.kept, box.runs.slice(0, 3).map(({ dir }) => dir), 'kept, newest first');
  assert.equal(result.removed, 2);
  assert.equal(result.freedBytes, box.runs[3].bytes + box.runs[4].bytes,
    'the freed size counts the removed files and not the 5000 bytes behind the link');
  assert.deepEqual(lines.warn, []);
  assert.deepEqual(lines.log, [`Pruned 2 earlier drive directories from ${box.root}, freeing 0.0 MB; `
    + 'kept the 3 most recent (ACOLYTE_DRIVE_KEEP=3).']);
});

test('ACOLYTE_DRIVE_KEEP sets how many stay, 0 keeps none, and a value that is not a number removes nothing', (t) => {
  const box = fakeRoot(t);
  assert.throws(() => pruneDriveDirs({ root: box.root, env: { ACOLYTE_DRIVE_KEEP: 'three' }, log: capture().log }),
    /ACOLYTE_DRIVE_KEEP must be a whole number of earlier drive directories to keep, not "three"/);
  assert.equal(box.runs.every(({ dir }) => fs.existsSync(dir)), true, 'a refused value removed nothing');
  const one = pruneDriveDirs({ root: box.root, env: { ACOLYTE_DRIVE_KEEP: '1' }, log: capture().log });
  assert.deepEqual(one.kept, [box.runs[0].dir]);
  assert.equal(one.removed, 4);
  const { lines, log } = capture();
  const none = pruneDriveDirs({ root: box.root, env: { ACOLYTE_DRIVE_KEEP: '0' }, log });
  assert.deepEqual(none.kept, []);
  assert.equal(none.removed, 1);
  assert.equal(fs.existsSync(box.runs[0].dir), false);
  assert.match(lines.log[0], /^Pruned 1 earlier drive directory from .*; kept the 0 most recent \(ACOLYTE_DRIVE_KEEP=0\)\.$/);
});

// A run directory that cannot be removed: on Windows a process standing in it, on POSIX a
// subdirectory nobody may write to. Root may remove what that forbids, so as root it skips.
test('a run directory that cannot be removed is a warning, and the rest are still pruned', {
  skip: process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0
    && 'root may remove what the fixture forbids',
}, async (t) => {
  const box = fakeRoot(t);
  const held = box.runs[3].dir;
  const locked = path.join(held, 'user-data');
  let child;
  let exited;
  if (process.platform === 'win32') {
    child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setTimeout(() => {}, 60000);"],
      { cwd: held, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    exited = once(child, 'exit');
    await Promise.race([once(child.stdout, 'data'),
      exited.then(() => { throw new Error('precondition: the child exited before it stood in the directory'); })]);
  } else {
    fs.chmodSync(locked, 0o555);
  }
  try {
    const { lines, log } = capture();
    const result = pruneDriveDirs({ root: box.root, env: {}, log });
    assert.equal(exists(held), true, 'precondition: the held run is still there');
    assert.equal(exists(box.runs[4].dir), false, 'the run that could go, went');
    assert.equal(result.removed, 1);
    assert.deepEqual(result.failed.map(({ dir }) => dir), [held]);
    assert.equal(lines.warn.length, 1);
    assert.match(lines.warn[0],
      /^warning: could not remove the earlier drive directory .*run004 \((EPERM|EBUSY|EACCES|ENOTEMPTY)\); left in place$/);
    assert.match(lines.log[0], /^Pruned 1 earlier drive directory from .*; 1 could not be removed\.$/);
  } finally {
    if (child) { child.kill(); await exited; } else if (exists(locked)) fs.chmodSync(locked, 0o755);
  }
});
