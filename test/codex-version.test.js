'use strict';

// THE DECLARED CODEX VERSION WINDOW, AND THE PROMISE THAT IT ONLY EVER INFORMS.
//
// src/codex-version.js (2026-10-13) answers one question -- which codex-cli the
// configured executable is, and whether this repository ever exercised it --
// and is forbidden from turning the answer into a warning. These tests drive it
// only through the doors production uses (codexVersionStatus for the CLI and
// scripts/check-codex-version.js, dashboardCodexVersion for the extension), with
// a stand-in spawner, so the real binary is never needed and never run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CODEX_TESTED_VERSIONS, CODEX_VERSION_WINDOW, codexVersionStatus, dashboardCodexVersion,
  abandonCodexVersionProbes,
} = require('../src/codex-version');

// A real file for each stand-in, so the cache key (path, mtime, size) is a real
// identity, and a fresh one per case so no case reads another's cached answer.
let counter = 0;
function fakeBinary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `fake-codex-${(counter += 1)}`);
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
  return file;
}

function statusFor(t, stdout, extra = {}) {
  const calls = [];
  const run = (file, args, options) => { calls.push({ file, args, options }); return { status: 0, stdout, ...extra }; };
  return { status: codexVersionStatus({ executable: fakeBinary(t), run }), calls };
}

test('the declared window is the tested list, oldest to newest', () => {
  const tested = CODEX_TESTED_VERSIONS.map((entry) => entry.version);
  assert.deepEqual(tested, ['0.145.0', '0.154.0', '0.161.0']);
  assert.equal(CODEX_VERSION_WINDOW.min, tested[0]);
  assert.equal(CODEX_VERSION_WINDOW.max, tested[tested.length - 1]);
  for (const entry of CODEX_TESTED_VERSIONS) {
    assert.match(entry.date, /^2026-\d\d-\d\d$/, `${entry.version} names when it was exercised`);
    assert.ok(entry.exercised.length > 10, `${entry.version} names what was exercised`);
  }
});

test('codex-cli --version output parses in every spelling a real build or wrapper emits', (t) => {
  const cases = [
    ['codex-cli 0.161.0\n', '0.161.0'],
    ['codex-cli 0.161.0\r\n', '0.161.0'],
    ['codex-cli 0.161.0', '0.161.0'],
    ['codex-cli v0.161.0\n', '0.161.0'],
    ['WARNING: proceeding, even though we could not update PATH\ncodex-cli 0.154.0\n', '0.154.0'],
    ['codex-cli 0.162.0-alpha.3\n', '0.162.0-alpha.3'],
    ['codex-cli 1.0.0\n', '1.0.0'],
  ];
  for (const [stdout, version] of cases) {
    const { status, calls } = statusFor(t, stdout);
    assert.equal(status.version, version, JSON.stringify(stdout));
    assert.deepEqual(calls[0].args.slice(-1), ['--version'], 'the only thing ever asked of the binary is --version');
    assert.ok(calls[0].options.timeout > 0 && calls[0].options.timeout <= 30000, 'the spawn is bounded');
  }
  // Digits alone are not a Codex: a wrong binary must not masquerade as one.
  for (const stdout of ['0.161.0\n', 'codex 0.161.0\n', 'codex-cli 0.161\n', 'codex-cli\n', '', 'git version 2.47.0\n']) {
    const { status } = statusFor(t, stdout);
    assert.equal(status.version, null, `${JSON.stringify(stdout)} names no codex-cli version`);
    assert.equal(status.inWindow, null, 'unknown is not the same answer as outside');
    assert.match(status.note, /version unavailable/);
  }
});

test('inside, exactly tested, and outside the window each say which, and only inform', (t) => {
  const verdict = (stdout) => statusFor(t, stdout).status;

  const exact = verdict('codex-cli 0.161.0');
  assert.equal(exact.inWindow, true);
  assert.equal(exact.testedExactly, true);
  assert.match(exact.note, /0\.161\.0: a tested version/);

  const between = verdict('codex-cli 0.150.2');
  assert.equal(between.inWindow, true);
  assert.equal(between.testedExactly, false);
  assert.match(between.note, /inside the tested window .* not itself exercised/);

  const newer = verdict('codex-cli 0.170.0');
  assert.equal(newer.inWindow, false);
  assert.match(newer.note, /newer than the newest tested version \(0\.161\.0\)/);
  assert.match(newer.note, /Information only: nothing is disabled/);

  const older = verdict('codex-cli 0.140.0');
  assert.equal(older.inWindow, false);
  assert.match(older.note, /older than the oldest tested version \(0\.145\.0\)/);

  // Numeric, not lexicographic: as strings "0.99.0" sorts after "0.145.0".
  const ninetyNine = verdict('codex-cli 0.99.0');
  assert.equal(ninetyNine.inWindow, false, 'WITNESS 0.99 is older than 0.145, whatever the string order says');
  assert.match(ninetyNine.note, /older/);

  // A prerelease sorts below its release: 0.162.0-alpha is still newer than
  // 0.161.0, and 0.145.0-rc.1 is older than the oldest tested build.
  assert.equal(verdict('codex-cli 0.162.0-alpha.1').inWindow, false);
  assert.equal(verdict('codex-cli 0.145.0-rc.1').inWindow, false);
  assert.equal(verdict('codex-cli 0.161.0-alpha.1').inWindow, true);
  assert.equal(verdict('codex-cli 0.161.0-alpha.1').testedExactly, false, 'a prerelease is not the tested release');

  for (const status of [exact, between, newer, older, ninetyNine]) {
    assert.equal(status.severity, 'info', `${status.version} is information, never a warning`);
    assert.deepEqual(status.tested, ['0.145.0', '0.154.0', '0.161.0']);
    assert.deepEqual(status.window, { min: '0.145.0', max: '0.161.0' });
  }
});

test('an unreachable, failing or silent binary yields version null and never throws', (t) => {
  const absent = codexVersionStatus({ executable: path.join(os.tmpdir(), 'acolyte-no-such-codex-xyz', 'codex'),
    run: () => assert.fail('nothing that does not exist may be spawned') });
  assert.equal(absent.version, null);
  assert.equal(absent.resolved, null);
  // Names PATH as where a winget or standalone build lives, not npm alone
  // (2026-10-14): the winget codex.exe is linked from WinGet's Links folder, on PATH.
  assert.match(absent.note, /not found on PATH \(where a winget, standalone or npm install puts it\) or in npm's global folder/);
  assert.equal(absent.severity, 'info');

  const bareMissing = codexVersionStatus({ executable: 'acolyte-no-such-codex-xyz', run: () => assert.fail('not spawned') });
  assert.equal(bareMissing.version, null);

  const timedOut = statusFor(t, '', { error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }) }).status;
  assert.equal(timedOut.version, null);
  assert.match(timedOut.note, /ETIMEDOUT/);

  const exitedNonzero = statusFor(t, 'codex-cli 0.161.0', { status: 3 }).status;
  assert.equal(exitedNonzero.version, null, 'a nonzero --version is not trusted even if it printed a version');
  assert.match(exitedNonzero.reason, /exited 3/);

  const throwing = codexVersionStatus({ executable: fakeBinary(t), run: () => { throw new Error('spawn exploded'); } });
  assert.equal(throwing.version, null);
  assert.match(throwing.note, /spawn exploded/);
});

test('one spawn per binary until the file changes, and failures are retried later', (t) => {
  const file = fakeBinary(t);
  let spawns = 0;
  let stdout = 'codex-cli 0.154.0\n';
  const run = () => { spawns += 1; return { status: 0, stdout }; };
  assert.equal(codexVersionStatus({ executable: file, run }).version, '0.154.0');
  assert.equal(codexVersionStatus({ executable: file, run }).version, '0.154.0');
  assert.equal(spawns, 1, 'WITNESS a repeat call for the same file is a stat, not a spawn');

  // An upgrade in place: new bytes, new mtime, new answer.
  stdout = 'codex-cli 0.161.0\n';
  fs.writeFileSync(file, '#!/bin/sh\n# upgraded\n');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.equal(codexVersionStatus({ executable: file, run }).version, '0.161.0');
  assert.equal(spawns, 2, 'a changed binary is asked again');

  const flaky = fakeBinary(t);
  let now = 1000000;
  let attempts = 0;
  const failOnce = () => { attempts += 1; return attempts === 1 ? { status: null, error: Object.assign(new Error('slow'), { code: 'ETIMEDOUT' }) } : { status: 0, stdout: 'codex-cli 0.161.0' }; };
  assert.equal(codexVersionStatus({ executable: flaky, run: failOnce, now: () => now }).version, null);
  assert.equal(codexVersionStatus({ executable: flaky, run: failOnce, now: () => now }).version, null, 'a failure is cached briefly');
  assert.equal(attempts, 1);
  now += 61000;
  assert.equal(codexVersionStatus({ executable: flaky, run: failOnce, now: () => now }).version, '0.161.0',
    'WITNESS a slow first run is not the only answer the session ever gets');
  assert.equal(attempts, 2);
});

test('the dashboard read never spawns synchronously, shares one probe, and hands the child over', (t) => {
  const file = fakeBinary(t);
  const tracked = [];
  let callback;
  const child = { pid: 4242 };
  // No execFile `timeout`: the probe arms its own timer (2026-10-14), so that
  // "timed out" means that timer fired and not that something else killed it.
  const execFile = (launchFile, args, options, done) => { callback = done; assert.equal(options.timeout, undefined); return child; };
  assert.equal(dashboardCodexVersion({ executable: file, execFile, track: (c) => tracked.push(c) }), null,
    'no cached answer yet, so nothing to show; the probe runs in the background');
  assert.equal(dashboardCodexVersion({ executable: file, execFile: () => assert.fail('a second probe while one is in flight'), track: () => {} }), null);
  assert.deepEqual(tracked, [child], 'the extension can end the probe on deactivate');
  callback(null, 'codex-cli 0.170.0\n', '');
  const shown = dashboardCodexVersion({ executable: file, execFile: () => assert.fail('cached now'), track: () => {} });
  assert.equal(shown.version, '0.170.0');
  assert.equal(shown.inWindow, false);
  assert.equal(shown.severity, 'info');

  // A probe that cannot even start is still an answer on the next read, not a throw.
  const broken = fakeBinary(t);
  assert.equal(dashboardCodexVersion({ executable: broken, execFile: () => { throw new Error('EPERM'); } }), null);
  const missing = dashboardCodexVersion({ executable: path.join(os.tmpdir(), 'acolyte-no-such-codex-xyz', 'codex') });
  assert.equal(missing.version, null, 'an absent binary is answered at once, without a probe');
  assert.match(missing.note, /not found/);
});

// A stand-in executable reachable only BY NAME, behind `padding` empty PATH
// entries, so finding it is the PATH x PATHEXT walk every dashboard push paid.
function bareNameOnPath(t, padding = 12) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-locate-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dirs = Array.from({ length: padding }, (_, index) => {
    const dir = path.join(base, `empty-${index}`);
    fs.mkdirSync(dir);
    return dir;
  });
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const name = `acolytelocate${(counter += 1)}`;
  const file = path.join(bin, process.platform === 'win32' ? `${name}.cmd` : name);
  fs.writeFileSync(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = [...dirs, bin].join(path.delimiter);
  t.after(() => { process.env.PATH = before; });
  return { name, file };
}

// Counts the fs calls a locate makes. Both, because the POSIX walk tests
// accessSync before it stats and the Windows walk only stats.
function countFsProbes(t) {
  const counts = { stat: 0 };
  const realStat = fs.statSync;
  const realAccess = fs.accessSync;
  fs.statSync = function statSync(...args) { counts.stat += 1; return realStat.apply(this, args); };
  fs.accessSync = function accessSync(...args) { counts.stat += 1; return realAccess.apply(this, args); };
  t.after(() => { fs.statSync = realStat; fs.accessSync = realAccess; });
  return counts;
}

test('a cached dashboard read costs one stat, not a PATH walk, and a moved binary is found again', (t) => {
  const { name, file } = bareNameOnPath(t);
  let callback;
  assert.equal(dashboardCodexVersion({ executable: name, execFile: (f, a, o, done) => { callback = done; return {}; } }), null);
  callback(null, 'codex-cli 0.161.0\n', '');
  const counts = countFsProbes(t);
  const shown = dashboardCodexVersion({ executable: name, execFile: () => assert.fail('cached') });
  assert.equal(shown.version, '0.161.0', 'precondition: the read is a cache hit');
  // Measured before the memo on the development box: 434 per push with codex at
  // PATH entry 36. Here twelve empty entries x PATHEXT would be dozens on Windows.
  // MUTATION: make locateCodex walk every time (drop the memo hit). This counts the
  // whole walk. Confirmed 2026-10-14.
  assert.ok(counts.stat <= 2, `a cached read made ${counts.stat} fs probes`);

  // The memo is not a stale answer: the file it points at is stat'ed on every
  // read, and once it is gone the walk runs again at once.
  fs.rmSync(file);
  const gone = dashboardCodexVersion({ executable: name, execFile: () => assert.fail('nothing to probe') });
  assert.equal(gone.version, null);
  assert.match(gone.note, /not found/, 'a removed binary is reported missing on the next read, not in a minute');
});

test('one cache slot per executable name, and the number of names is bounded', (t) => {
  let spawns = 0;
  const run = () => { spawns += 1; return { status: 0, stdout: 'codex-cli 0.161.0\n' }; };
  const steady = fakeBinary(t);
  codexVersionStatus({ executable: steady, run });
  // Forty upgrades in place of ANOTHER binary. Keyed on the file identity, each
  // was a new slot that nothing evicted; under any bound they would have pushed
  // the steady entry out.
  const upgraded = fakeBinary(t);
  for (let build = 0; build < 40; build += 1) {
    fs.writeFileSync(upgraded, `#!/bin/sh\n# build ${build}\n${'x'.repeat(build)}\n`);
    codexVersionStatus({ executable: upgraded, run });
  }
  assert.equal(spawns, 41, 'precondition: every upgrade was asked about');
  codexVersionStatus({ executable: steady, run });
  // MUTATION: key the cache on the file identity again (with the bound kept).
  // Forty identities evict the steady one and this counts 42. Confirmed 2026-10-14.
  assert.equal(spawns, 41, 'upgrades of one binary hold one slot');
  // And the names themselves are bounded: 32 more evict the steady one.
  for (let other = 0; other < 32; other += 1) codexVersionStatus({ executable: fakeBinary(t), run });
  const before = spawns;
  codexVersionStatus({ executable: steady, run });
  // MUTATION: drop the CACHE_LIMIT eviction in remember(). The steady entry
  // survives and this counts 0. Confirmed 2026-10-14.
  assert.equal(spawns - before, 1, 'the least recently used name was evicted');
});

test('a probe ends by its own timer as "timed out", and one killed from outside is not cached as one', async (t) => {
  // Killed from outside: the extension's deactivate. execFile reports any kill as
  // `error.killed`, which the probe used to read as "timed out" and cache for a
  // minute, so a same-realm re-activate showed a timeout nobody had.
  const external = fakeBinary(t);
  let deliver;
  dashboardCodexVersion({ executable: external, execFile: (f, a, o, done) => { deliver = done; return {}; } });
  abandonCodexVersionProbes();
  deliver(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }), '', '');
  await new Promise((resolve) => setImmediate(resolve));
  let probes = 0;
  // MUTATION: drop the `epoch === probeEpoch` check before remember(). The kill is
  // cached and this read returns it instead of starting a probe. Confirmed 2026-10-14.
  assert.equal(dashboardCodexVersion({ executable: external, execFile: () => { probes += 1; return {}; } }), null,
    'nothing was remembered from the killed probe');
  assert.equal(probes, 1, 'so the next read probes again');

  // A kill that is not this probe's timer, without an abandon, is still not called a timeout.
  const killed = fakeBinary(t);
  let done;
  dashboardCodexVersion({ executable: killed, execFile: (f, a, o, callback) => { done = callback; return {}; } });
  done(Object.assign(new Error('Command failed'), { killed: true, code: null, signal: 'SIGTERM' }), '', '');
  const status = dashboardCodexVersion({ executable: killed, execFile: () => assert.fail('cached') });
  // MUTATION: restore `error.killed ? 'timed out' : ...`. This reads "timed out".
  // Confirmed 2026-10-14.
  assert.doesNotMatch(status.note, /timed out/);

  // The probe's own timer: the only "timed out" there is. The stand-in child
  // answers a kill the way a real one does, by calling back with an error.
  //
  // FIRED BY HAND, NOT AWAITED (2026-10-14). This case used to wait 30 ms for the
  // real timer, and that timer is unref'd ON PURPOSE: it must never be what keeps
  // the extension host, or a CLI that loads this module, alive. With a stand-in
  // child that is not a process, nothing else held the event loop open while the
  // test waited, so Node 20 and 22 ended the file with "Promise resolution is
  // still pending but the event loop has already resolved" and cancelled it and
  // every test after it (CI run 38525363435, all four Node 20/22 legs; Node 24's
  // runner happened to keep its own loop alive). In production the probe's child
  // is a real ChildProcess, a ref'd handle of its own, so this was the test's
  // defect alone. The timer is captured as it is armed, checked for being
  // unref'd and for the delay asked for, cleared, and its callback run here.
  const slow = fakeBinary(t);
  const child = {};
  const realSetTimeout = global.setTimeout;
  let armed = null;
  global.setTimeout = (fn, ms, ...rest) => {
    const handle = realSetTimeout(fn, ms, ...rest);
    armed = { fn, ms, handle };
    return handle;
  };
  let finished;
  try {
    finished = new Promise((resolve) => {
      dashboardCodexVersion({ executable: slow, timeoutMs: 30, execFile: (f, a, o, callback) => {
        child.kill = () => { callback(Object.assign(new Error('Command failed'), { killed: true }), '', ''); resolve(); };
        return child;
      } });
    });
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.ok(armed, 'precondition: the probe armed a timer of its own');
  assert.equal(armed.ms, 30, 'the timer is the one the caller bounded the probe with');
  // MUTATION: drop `timer.unref()` in probeCodexVersionStatus, which is the
  // tempting way to make the old version of this case pass on Node 20/22. This
  // fails. Confirmed 2026-10-14.
  assert.equal(armed.handle.hasRef(), false, 'a probe timer must never hold the host or the CLI open');
  clearTimeout(armed.handle);
  armed.fn();
  await finished;
  const timedOut = dashboardCodexVersion({ executable: slow, execFile: () => assert.fail('cached') });
  // MUTATION: drop `timedOut = true` from the probe's timer. This reads the kill's
  // own error code instead. Confirmed 2026-10-14.
  assert.match(timedOut.note, /timed out/);
});

test('the probe a push started asks for one push of its own when it lands, and only that one', async (t) => {
  // A quiet window has no "next push": the CLI line stayed blank until something
  // unrelated refreshed the panel.
  const file = fakeBinary(t);
  let deliver;
  let settled = 0;
  let joined = 0;
  dashboardCodexVersion({ executable: file, execFile: (f, a, o, done) => { deliver = done; return {}; },
    onSettled: () => { settled += 1; } });
  // A second push while the probe is in flight registers nothing: one probe, one push.
  dashboardCodexVersion({ executable: file, execFile: () => assert.fail('one probe'), onSettled: () => { joined += 1; } });
  deliver(null, 'codex-cli 0.161.0\n', '');
  await new Promise((resolve) => setImmediate(resolve));
  // MUTATION: drop the onSettled call in dashboardCodexVersion. This reads 0.
  // Confirmed 2026-10-14.
  assert.equal(settled, 1, 'the probe that was started asks for exactly one push');
  assert.equal(joined, 0, 'a push that joined the probe in flight asks for none');
  // The push that follows reads the cache and starts nothing, so nothing loops.
  let again = 0;
  assert.equal(dashboardCodexVersion({ executable: file, execFile: () => assert.fail('cached'),
    onSettled: () => { again += 1; } }).version, '0.161.0');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(again, 0);
});

// The CLI door. `--learn status` carries the same status as `codexCli`, and pays nothing
// on a machine with no Codex home: no field content, and no spawn of anything.
test('wildcard-perms --learn status reports codexCli only when there is a Codex home', (t) => {
  const { spawnSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-version-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace);
  const run = () => spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'wildcard-perms'),
    '--learn', 'status', '--workspace', workspace, '--codex-scope', 'off', '--codex-executable', 'acolyte-no-such-codex-xyz'], {
    cwd: home, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex') },
  });
  const without = run();
  assert.equal(without.status, 0, without.stderr);
  assert.equal(JSON.parse(without.stdout).codexCli, null, 'no Codex home, no Codex CLI status');

  fs.mkdirSync(path.join(home, '.codex'));
  const withHome = run();
  assert.equal(withHome.status, 0, 'an unreachable codex never changes the exit status');
  const cli = JSON.parse(withHome.stdout).codexCli;
  assert.equal(cli.executable, 'acolyte-no-such-codex-xyz', 'the configured --codex-executable is the one asked about');
  assert.equal(cli.version, null);
  assert.equal(cli.severity, 'info');
  assert.match(cli.note, /not found/);
});
