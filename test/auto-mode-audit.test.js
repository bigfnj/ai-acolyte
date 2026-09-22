'use strict';

// scripts/auto-mode-audit.js had no test of any kind, and it is the one script here
// that SPAWNS the agent CLI. Two of the things it told you were false: the header
// promised a run that cannot authenticate while the child inherited every
// credential in the environment, and the report named a sandbox directory it had
// deleted four lines earlier.
//
// The probe launch is injected rather than real. Spawning the user's actual
// `claude` would need a login, would take a minute per case, and would make the
// result depend on which machine ran the suite — and the two defects above are in
// the code AROUND the spawn, which is exactly what an injected launch leaves intact.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseArgs, readAllow, stripCredentials, audit, render,
} = require('../scripts/auto-mode-audit.js');

function sandboxDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-audit-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Stands in for the `claude` process: writes the debug line the audit parses, so
// the report comes back with reachedPermissionLoad true and a real ignore list.
//
// The sandbox is read out of CLAUDE_CONFIG_DIR, never off `launch.args`. On Windows
// `claude` resolves to a .cmd shim, so commandLaunch collapses the whole invocation
// into `cmd /d /s /c "<one quoted line>"` and there is no `--debug-file` element to
// index — an earlier version of this helper found -1, took `args[0]`, and wrote a
// file called `d` at the root of the current drive.
function sandboxOf(options) {
  return path.dirname(options.env.CLAUDE_CONFIG_DIR);
}

function fakeProbe(captured, ignored = []) {
  return (launch, options) => {
    captured.launch = launch;
    captured.options = options;
    const lines = ignored.map((entry) =>
      `[DEBUG] Ignoring dangerous permission ${entry} from /probe.settings.json (bypasses classifier)`);
    fs.writeFileSync(path.join(sandboxOf(options), 'debug.log'), lines.join('\n') + '\n');
    return { stdout: '', stderr: 'Not logged in', error: null };
  };
}

// ── the report must not name a directory it deleted ──────────────────────────

test('the report does not name the sandbox it just deleted', (t) => {
  const captured = {};
  const report = audit(['Bash(*)'], 'auto', { run: fakeProbe(captured), env: {}, keep: false });

  assert.equal(report.sandboxRemoved, true, 'the sandbox is removed when --keep was not passed');
  assert.equal(report.sandbox, null,
    'every run without --keep reported a path that had already been deleted, '
    + 'inviting the reader to go and look at a directory that is not there');
  // The claim is checked against the filesystem, not just against itself: the
  // sandbox the probe was actually handed is the one that has to be gone.
  const created = sandboxOf(captured.options);
  assert.match(created, /auto-mode-audit-/, 'the captured path is the audit sandbox');
  assert.ok(!fs.existsSync(created), 'and the directory really is gone');
});

test('--keep reports the sandbox, and it is really there', (t) => {
  const captured = {};
  const report = audit(['Bash(*)'], 'auto', { run: fakeProbe(captured), env: {}, keep: true });
  t.after(() => fs.rmSync(report.sandbox, { recursive: true, force: true }));

  assert.equal(report.sandboxRemoved, false);
  assert.ok(report.sandbox, 'a kept sandbox is named');
  assert.ok(fs.existsSync(report.sandbox),
    'the path reported under --keep must exist, or the field is the same lie in '
    + 'the other direction');
});

test('`keep` is a parameter, so two audits in one process disagree about it', (t) => {
  // The flag used to be read off a module-level `args` binding from inside audit().
  // That resolves only because the one call site sits below the `const`; a second
  // caller in the same process got whatever the first run's CLI flags happened to
  // be, and a module-scope read before initialisation is a ReferenceError.
  const kept = audit([], 'auto', { run: fakeProbe({}), env: {}, keep: true });
  t.after(() => fs.rmSync(kept.sandbox, { recursive: true, force: true }));
  const dropped = audit([], 'auto', { run: fakeProbe({}), env: {}, keep: false });

  assert.equal(kept.sandboxRemoved, false, 'the first call kept its sandbox');
  assert.equal(dropped.sandboxRemoved, true,
    'the second call in the SAME process dropped its own, which it cannot do if '
    + 'sandboxRemoved is decided by anything other than this call\'s argument');
  assert.notEqual(kept.sandbox, null);
  assert.equal(dropped.sandbox, null);
});

test('a removal that did not happen is reported as a sandbox still on disk', (t) => {
  // "rmSync did not throw" is not the same fact as "the directory is gone":
  // `force` swallows ENOENT, and on Windows an open handle can keep a directory
  // alive through a call that returns normally. A flag set from the absence of an
  // exception records "no exception" and reads identically on a run that left the
  // sandbox behind — so this asks the filesystem instead, and here is the case
  // that tells the two apart.
  const captured = {};
  const real = fs.rmSync;
  fs.rmSync = () => {};
  let report;
  try {
    report = audit(['Bash(*)'], 'auto', { run: fakeProbe(captured), env: {}, keep: false });
  } finally {
    fs.rmSync = real;
  }
  const dir = sandboxOf(captured.options);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.ok(fs.existsSync(dir), 'the premise: the removal really did not happen');
  assert.equal(report.sandboxRemoved, false,
    'a removal that did not happen must not be reported as one');
  assert.equal(report.sandbox, dir,
    'and the surviving directory is named, because it is sitting in the temp '
    + 'directory holding the probe settings and the debug log');

  // The human output has to say so too, or the leak is silent.
  const lines = [];
  render({ ...report, settings: '/s.json', loaded: [] }, (text) => lines.push(text));
  assert.match(lines.join(''), /sandbox kept at/, 'the surviving sandbox is printed');
});

test('the human output says the sandbox went, rather than pointing at it', () => {
  const lines = [];
  render({
    settings: '/s.json', mode: 'auto', total: 1, ignored: [], loaded: ['Bash(*)'],
    reachedPermissionLoad: true, launchError: null, sandbox: null, sandboxRemoved: true,
  }, (text) => lines.push(text));
  const out = lines.join('');
  assert.match(out, /sandbox removed/, 'the removal is stated');
  assert.ok(!/auto-mode-audit-/.test(out), 'and no deleted path is printed');
});

// ── the child must not be able to authenticate ───────────────────────────────

test('every credential is stripped from the probe environment', (t) => {
  const captured = {};
  // One from each documented family: direct key, bearer token, OAuth token, the
  // provider switch that OUTRANKS a key, a cloud key, and a base URL that would
  // route the call to a gateway holding its own credential.
  const dirty = {
    PATH: '/usr/bin',
    HOME: '/home/me',
    ANTHROPIC_API_KEY: 'sk-ant-real',
    ANTHROPIC_AUTH_TOKEN: 'bearer-real',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-real',
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_BEARER_TOKEN_BEDROCK: 'aws-real',
    ANTHROPIC_BASE_URL: 'https://gateway.internal',
    GOOGLE_APPLICATION_CREDENTIALS: '/creds.json',
    // Lowercase on purpose: Windows environment names are case-insensitive, so
    // this is the SAME variable as the first one and must not survive either.
    anthropic_api_key: 'sk-ant-lowercase',
  };
  const report = audit(['Bash(*)'], 'auto', { run: fakeProbe(captured), env: dirty, keep: false });
  assert.equal(report.sandboxRemoved, true);

  const passed = captured.options.env;
  for (const name of Object.keys(passed)) {
    assert.ok(!/^(ANTHROPIC_|CLAUDE_CODE_|AWS_|GOOGLE_)/i.test(name),
      `${name} reached the probe; with any credential in scope the child makes a `
      + 'REAL API call, which is precisely what this script\'s header promises it '
      + 'cannot do');
  }
  // Nothing else was thrown away with them — the probe still has to run.
  assert.equal(passed.PATH, '/usr/bin');
  assert.equal(passed.HOME, '/home/me');
  // And the one variable the sandbox depends on is set, not merely inherited.
  assert.ok(passed.CLAUDE_CONFIG_DIR, 'CLAUDE_CONFIG_DIR still points at the sandbox');
  assert.ok(passed.CLAUDE_CONFIG_DIR.includes('auto-mode-audit-'));
});

test('stripCredentials keeps CLAUDE_CONFIG_DIR itself, which is not a credential', () => {
  // It shares no prefix with the stripped families by design; assert it, because a
  // prefix list widened to `CLAUDE_` would silently un-sandbox every future run.
  const env = stripCredentials({ CLAUDE_CONFIG_DIR: '/inherited', ANTHROPIC_API_KEY: 'x' }, '/sandbox');
  assert.equal(env.CLAUDE_CONFIG_DIR, '/sandbox');
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

// ── a malformed settings file is the user's, and the message must say so ─────

test('an unparseable settings.json names the file instead of throwing a SyntaxError', (t) => {
  const dir = sandboxDir(t);
  const target = path.join(dir, 'settings.json');
  // Truncated mid-array: what a reader sees inside somebody else's non-atomic
  // write, which Claude Code performs on every /model, /effort and approval.
  fs.writeFileSync(target, '{ "permissions": { "allow": [ ');

  assert.throws(() => readAllow(target), (error) => {
    assert.equal(error.code, 'AUDIT_INPUT',
      'a bad input is tagged, so main() can answer with one line rather than a '
      + 'stack trace that reads as a bug in the audit');
    assert.ok(error.message.includes(target),
      `the message must name the malformed file; got ${JSON.stringify(error.message)}`);
    return true;
  });
});

test('a missing settings.json says it is missing', (t) => {
  const dir = sandboxDir(t);
  const target = path.join(dir, 'nope.json');
  assert.throws(() => readAllow(target), (error) => {
    assert.equal(error.code, 'AUDIT_INPUT');
    assert.match(error.message, /no settings file at/);
    return true;
  });
});

test('a BOM-prefixed settings.json is still read', (t) => {
  // Regression guard for the half of this bullet that was already fixed. Windows
  // PowerShell 5.1 writes UTF-8 WITH a BOM by default, so this is what a settings
  // file edited by a script on that shell looks like.
  const dir = sandboxDir(t);
  const target = path.join(dir, 'settings.json');
  const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
  fs.writeFileSync(target, Buffer.concat([
    bom, Buffer.from(JSON.stringify({ permissions: { allow: ['Bash(git *)', '', 7] } }), 'utf8'),
  ]));

  assert.deepEqual(readAllow(target), ['Bash(git *)'],
    'the BOM is stripped, and non-string / empty entries are dropped');
});

test('the flags parse into the shape audit and main consume', () => {
  const args = parseArgs(['--json', '--keep', '--mode', 'manual', '--entries', 'Bash(*), Read(*)']);
  assert.equal(args.json, true);
  assert.equal(args.keep, true);
  assert.equal(args.mode, 'manual');
  assert.deepEqual(args.entries, ['Bash(*)', 'Read(*)']);
  assert.deepEqual(parseArgs([]), { mode: 'auto', json: false, settings: null, entries: null, keep: false });
});
