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
  assert.match(absent.note, /not found on PATH or in the standard npm locations/);
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
  const execFile = (launchFile, args, options, done) => { callback = done; assert.ok(options.timeout > 0); return child; };
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
