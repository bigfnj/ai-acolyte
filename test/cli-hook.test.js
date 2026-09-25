'use strict';

// Hook mode — the PostToolUse path, which had no test coverage at all despite
// being the highest-frequency writer of settings.json on a real machine.
//
// It used to read the file, spend ~57 ms in processAllowList, then spread its
// stale snapshot back with no lock and no re-read. Claude Code rewrites that file
// in place on every /model, /effort and approval, so the common casualty was
// model / effortLevel / hooks. The pass is also required to be silent and to exit
// 0 whatever happens: it runs after every single tool call, and a noisy or
// non-zero hook is paid constantly.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', 'bin', 'wildcard-perms');

// The real CLI in hook mode: no arguments, the event as JSON on stdin. `input`
// is what no existing test supplied, which is why this path was never entered.
function runHook(home, event) {
  const root = path.parse(home).root;
  return spawnSync(process.execPath, [CLI], {
    cwd: home, encoding: 'utf8', windowsHide: true,
    input: JSON.stringify(event ?? {}),
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
    },
  });
}

function tempHome(t, settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-hook-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n',
  );
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const settingsOf = (home) => JSON.parse(
  fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'),
);

test('the hook generalizes without disturbing anything else in the file', (t) => {
  const home = tempHome(t, {
    model: 'claude-opus-5',
    effortLevel: 'high',
    hooks: { PostToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node x' }] }] },
    permissions: {
      allow: ['Bash(git status)', 'Bash(git diff)', 'Bash(rg foo)', 'Bash(rg bar)'],
      deny: ['Bash(rm -rf /*)'],
    },
  });

  const result = runHook(home, { cwd: home });
  assert.equal(result.status, 0, `hook must always exit 0; stderr: ${result.stderr}`);

  const after = settingsOf(home);
  // The two documented shapes, pinned together: a fixed-purpose tool collapses to
  // its root, while a mixed-capability dispatcher keeps the subcommand boundary —
  // so `rg` becomes one entry and `git` stays two.
  assert.ok(after.permissions.allow.includes('Bash(rg *)'),
    'a fixed-purpose command generalizes to its root');
  assert.ok(after.permissions.allow.includes('Bash(git status *)'),
    'a dispatcher keeps its subcommand: Bash(git *) would grant push, reset and clean too');
  assert.ok(!after.permissions.allow.includes('Bash(git *)'),
    'and must NOT collapse to the root');
  assert.equal(after.model, 'claude-opus-5');
  assert.equal(after.effortLevel, 'high');
  assert.deepEqual(after.permissions.deny, ['Bash(rm -rf /*)'],
    'the safety boundary survives its own tool rewriting the file');
  assert.deepEqual(after.hooks.PostToolUse[0].matcher, 'Bash|PowerShell',
    'losing the hook registration would silently disable this tool');
});

test('a held policy lock stops the write, silently and with exit 0', (t) => {
  // The write used to take NO lock, so it landed regardless of who held it —
  // able to interleave with Auto Learn's settings write and its claims write,
  // which is the exact failure src/policy-lock.js exists to prevent. Now the
  // changed path is lock-guarded, and losing the race must cost nothing: the
  // next tool call fires the hook again and the pass is idempotent.
  const before = ['Bash(git status)', 'Bash(git diff)', 'Bash(git log)'];
  const home = tempHome(t, { permissions: { allow: before } });
  const lockPath = path.join(home, '.claude', 'wildcarding', 'auto-learn-policy.lock');
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  // This test process is alive, so the lock is never reclaimed as stale.
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid, owner: 'test-owner', at: new Date().toISOString(),
  }) + '\n');

  const result = runHook(home, { cwd: home });
  assert.equal(result.status, 0, 'a busy lock is not an error on the hook path');
  assert.equal(result.stderr, '', `the hook path is quiet by design; got: ${result.stderr}`);
  assert.deepEqual(settingsOf(home).permissions.allow, before,
    'nothing may be written while another policy writer holds the lock');
});

test('an already-optimal list is left alone, with no output', (t) => {
  // The common case by a wide margin — measured at 404 of 423 entries already
  // generalized on a real machine. It must not write, and must not lock.
  const allow = ['Bash(git *)', 'Bash(rg *)'];
  const home = tempHome(t, { permissions: { allow } });
  const file = path.join(home, '.claude', 'settings.json');
  const beforeMtime = fs.statSync(file).mtimeMs;

  const result = runHook(home, { cwd: home });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '', 'a no-op pass says nothing');
  assert.deepEqual(settingsOf(home).permissions.allow, allow);
  assert.equal(fs.statSync(file).mtimeMs, beforeMtime,
    'a fixed point must not be rewritten — the file is not touched at all');
});

test('a settings.json caught mid-write is left alone, silently', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-hook-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.claude', 'settings.json');
  const partial = '{ "permissions": { "allow": ["Bash(git ';
  fs.writeFileSync(file, partial);

  const result = runHook(home, { cwd: home });
  assert.equal(result.status, 0, 'still exits 0');
  assert.equal(result.stderr, '',
    'a SyntaxError here is somebody else\'s atomic write in progress, not news — '
      + 'it used to print, because a SyntaxError has no .code and failed the ENOENT test');
  assert.equal(fs.readFileSync(file, 'utf8'), partial, 'and the half-written file is untouched');
});

test('a missing settings.json is not an error either', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-hook-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = runHook(home, { cwd: home });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

// ── direct policy verbs and retired compatibility dispatch ──────────────────

// Bypass still writes Claude settings and must distinguish an absent file from
// an unreadable one. The retired MAX spellings remain in dispatch only so old
// scripts cannot fall through to hook mode; their `on` paths must never write.
function runVerb(home, args) {
  const root = path.parse(home).root;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: home, encoding: 'utf8', windowsHide: true,
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
    },
  });
}

function brokenHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-broken-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  // Truncated mid-array, exactly as a reader sees it inside a non-atomic write.
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
    '{ "model": "claude-opus-5", "permissions": { "allow": [ ');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('--bypass on refuses an unreadable settings.json instead of replacing it', (t) => {
  const home = brokenHome(t);
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const before = fs.readFileSync(settingsPath, 'utf8');

  const run = runVerb(home, ['--bypass', 'on']);

  assert.notEqual(run.status, 0, 'a refusal has to be visible in the exit code');
  assert.match(run.stderr, /refused/, run.stderr || run.stdout);
  assert.equal(fs.readFileSync(settingsPath, 'utf8'), before,
    'the bytes are untouched, so the damaged file stays recoverable');
});

test('retired --max on preserves settings and an existing cleanup snapshot', (t) => {
  const home = brokenHome(t);
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const settingsBefore = fs.readFileSync(settingsPath);
  const snapshot = path.join(home, '.claude', 'backups', 'wildcarding-max.json');
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  const real = JSON.stringify({ allowSnapshot: ['Bash(git *)', 'Bash(rg *)'] }, null, 2) + '\n';
  fs.writeFileSync(snapshot, real);

  const run = runVerb(home, ['--max', 'on']);

  assert.equal(run.status, 1);
  assert.match(run.stderr, /feature was removed; nothing was changed/);
  assert.ok(fs.readFileSync(settingsPath).equals(settingsBefore), 'settings are byte-identical');
  assert.equal(fs.readFileSync(snapshot, 'utf8'), real,
    'the cleanup snapshot remains available to the hidden off path');
});

test('--bypass still works on an absent settings.json, which is the legitimate case', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-fresh-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  // The refusal must key on "present but unreadable", not on "no settings yet",
  // or a first run is broken.
  const run = runVerb(home, ['--bypass', 'on']);
  assert.equal(run.status, 0, run.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  assert.equal(after.permissions.defaultMode, 'bypassPermissions');
});


// ── the concurrency the toggles used to lose ─────────────────────────────────
//
// Bypass used to read settings.json, compute a whole new object, and write it
// back. It holds the policy lock, and the lock is irrelevant:
// Claude Code never takes it and rewrites this file on every /model, /effort and
// approval. So anything that landed between the read and the write was reverted.
// Nothing in the suite covered that — every existing test writes the file once
// and never moves it underneath a running verb.
//
// The seam is a Node `--require` preload, NOT an env var the product checks. The
// shim monkey-patches fs.readFileSync inside the child and returns STALE bytes
// for the first read of settings.json only, so the process behaves exactly as it
// would if Claude Code had written between its first read and its write. Nothing
// in bin/wildcard-perms knows it is under test; the only coupling is "settings
// .json is read via fs.readFileSync", which is true at src/settings-write.js and
// at the CLI's own readSettings.
function staleReadShim(t, stalePayload, { poisonRead = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'stale-first-read.js');
  fs.writeFileSync(shim, [
    "const fs = require('fs');",
    "const real = fs.readFileSync;",
    `const stale = ${JSON.stringify(stalePayload)};`,
    `const poisonRead = ${poisonRead};`,
    'let seen = 0;',
    // Only readFileSync, and only for that basename, so the sidecar reads and
    // writeFileAtomicSync's own I/O are untouched.
    //
    // Targeting a specific read INDEX, not just the first. The first read of
    // settings.json is readSettingsForWrite's preflight, whose parsed value is
    // only tested against null and then discarded — poisoning it proves nothing
    // about the window that matters. Traced order for --bypass:
    //   #1 readSettingsState  (preflight, discarded)
    //   #2 rawSettingsText    (writeTransform: the transform's input AND the
    //                          compare-and-swap baseline, one read for both)
    //   #3 rawSettingsText    (the swap re-check)
    'fs.readFileSync = function patched(target, ...rest) {',
    "  if (typeof target === 'string' && target.endsWith('settings.json')) {",
    '    seen += 1;',
    '    if (seen === poisonRead) {',
    "      return rest[0] === 'utf8' || rest[0]?.encoding === 'utf8' ? stale : Buffer.from(stale);",
    '    }',
    '  }',
    '  return real.call(this, target, ...rest);',
    '};',
  ].join('\n'));
  return shim;
}

function runVerbWithShim(home, shim, args) {
  const root = path.parse(home).root;
  return spawnSync(process.execPath, ['--require', shim, CLI, ...args], {
    cwd: home, encoding: 'utf8', windowsHide: true,
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
    },
  });
}

test('--bypass keeps a key that landed between its read and its write', (t) => {
  // On disk: what Claude Code wrote while the verb was working.
  const home = tempHome(t, {
    model: 'claude-opus-5',
    effortLevel: 'high',
    permissions: { allow: ['Bash(git status *)', 'Bash(npm test)'], deny: ['Bash(rm -rf /*)'] },
  });
  // What the verb's FIRST read returns: an older file, missing all of that.
  const stale = JSON.stringify({ permissions: { allow: ['Bash(git status *)'] } }, null, 2) + '\n';

  // Read #2 is the one writeTransform hands to the transform.
  const run = runVerbWithShim(home, staleReadShim(t, stale, { poisonRead: 2 }), ['--bypass', 'on']);
  assert.equal(run.status, 0, run.stderr);

  const after = settingsOf(home);
  assert.equal(after.permissions.defaultMode, 'bypassPermissions', 'the toggle took effect');
  // Reverted code writes the stale object: no model, no effortLevel, no deny, and
  // one fewer approval.
  assert.equal(after.model, 'claude-opus-5', 'model survived');
  assert.equal(after.effortLevel, 'high', 'effortLevel survived');
  assert.deepEqual(after.permissions.deny, ['Bash(rm -rf /*)'], 'deny survived');
  assert.ok(after.permissions.allow.includes('Bash(npm test)'),
    'and the approval that landed in the window survived');
});

// ── the fixed-point cache, from the hook's side ──────────────────────────────
//
// The module has its own unit tests. These are the integration half, and they
// exist because every pre-existing hook test is a COLD MISS: tempHome mints a
// fresh directory per test, so the cache file never exists on the first call and
// the hit path would otherwise ship with no coverage at all.
//
// In particular, 'an already-optimal list is left alone, with no output' above
// asserts only that mtime and content are unchanged. That is true on a hit, true
// on a miss, and true with the cache module deleted entirely — it has no killing
// mutation for this feature and is not a test of it.
const cache = require('../src/fixed-point-cache');

function cacheFileFor(home) {
  return path.join(home, '.claude', 'wildcarding', 'fixed-point.json');
}

function writeCacheKey(home, key) {
  const file = cacheFileFor(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${key}\n`, 'utf8');
  return file;
}

test('a poisoned cache key suppresses the pass, which is what proves the lookup runs', (t) => {
  // A list that is deliberately NOT a fixed point: two specific git calls the
  // pass would collapse to one wildcard.
  const allow = ['Bash(git status --short)', 'Bash(git status --long)'];
  const home = tempHome(t, { permissions: { allow } });
  const file = path.join(home, '.claude', 'settings.json');
  const bytes = fs.readFileSync(file);

  // Claim, falsely, that these exact bytes are already a fixed point. Computed
  // with the real key function so the version and code-stamp segments are right —
  // a hand-typed key would be rejected on shape and prove nothing.
  writeCacheKey(home, cache.fixedPointKey(bytes));

  const result = runHook(home, { cwd: home });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.deepEqual(settingsOf(home).permissions.allow, allow,
    'the pass was skipped on the cache\'s word alone');

  // And the control: without the poisoned key the same input IS generalized, so
  // the assertion above is about the cache and not about the pass being a no-op.
  fs.unlinkSync(cacheFileFor(home));
  fs.writeFileSync(file, bytes);
  assert.equal(runHook(home, { cwd: home }).status, 0);
  assert.deepEqual(settingsOf(home).permissions.allow, ['Bash(git status *)'],
    'with no cache entry the pass runs and collapses the pair');
});

test('a stale version segment forces a full pass', (t) => {
  const allow = ['Bash(git status --short)', 'Bash(git status --long)'];
  const home = tempHome(t, { permissions: { allow } });
  const bytes = fs.readFileSync(path.join(home, '.claude', 'settings.json'));

  // The right content hash under the WRONG format version. This is the mutation
  // that matters most: if the comparison ever drops a segment, an entry written
  // by an older generalizer would be honoured forever.
  const real = cache.fixedPointKey(bytes);
  writeCacheKey(home, real.replace(/^\d+:/, '999:'));

  assert.equal(runHook(home, { cwd: home }).status, 0);
  assert.deepEqual(settingsOf(home).permissions.allow, ['Bash(git status *)'],
    'the stale key was not trusted');
});

test('a list that needed work is never recorded as a fixed point', (t) => {
  // The worst bug available here: writing the key before verifying, which would
  // be a permanent false hit for content that always needs the pass.
  const home = tempHome(t, { permissions: { allow: ['Bash(git status --short)', 'Bash(git status --long)'] } });

  assert.equal(runHook(home, { cwd: home }).status, 0);
  assert.deepEqual(settingsOf(home).permissions.allow, ['Bash(git status *)'], 'it did the work');

  // The actual invariant, in one line. `run()` writes a key only under
  // `if (!pending)`, and this fixture is deliberately not a fixed point, so no
  // key may exist at all.
  //
  // What was here before: a `if (key !== null)` block that could never execute
  // for this fixture, containing among other things
  // `assert.ok(key === post || key !== post, ...)` — true for every pair of
  // values in JavaScript including NaN. Four of five assertions unreachable and
  // one a tautology, in a test whose name promises the property below.
  assert.equal(fs.existsSync(cacheFileFor(home)), false,
    'a list that needed work must leave no key behind — writing one before '
    + 'verifying would be a permanent false hit for content that always needs the pass');
});

test('the cache converges in exactly three calls, and the third is a hit', (t) => {
  // Convergence has a precise shape and it is not "one call". run() stamps only
  // bytes it READ and verified, never bytes it believes it wrote — writeAllow
  // re-reads and rebases inside itself and can fall back to a non-atomic write,
  // so the post-write content is a file state this process never saw. So:
  //
  //   call 1  reads a non-fixed-point list, no key exists, runs the pass, WRITES
  //           settings.json, and deliberately stamps nothing
  //   call 2  reads the now-generalized list, still no key, runs the pass, finds
  //           it is a fixed point, writes NOTHING and stamps the key
  //   call 3  HITS, and touches neither file
  //
  // The load-bearing assertion is on the KEY file's mtime across calls 3+. That
  // is what separates a hit from a miss that quietly redid the pass and reached
  // the same answer — asserting only that settings.json stops changing passes
  // with the cache deleted entirely, because a fixed point is not rewritten
  // either way. This file makes exactly that criticism of a test 80 lines above,
  // and the first version of this one inherited the flaw.
  //
  // It also pins the property without which the hook would write on EVERY call:
  // writeAllow appends new entries at the end, so what lands is a permutation of
  // the pass's output rather than that output verbatim. If a permutation could
  // fail to be a fixed point there would be no call 3. Verified separately as
  // 0 of 400 permutations of the live list, but it holds for a non-obvious reason
  // (map/Set/filter all preserve first-occurrence order).
  const home = tempHome(t, { permissions: { allow: ['Bash(git status --short)', 'Bash(git status --long)'] } });
  const file = path.join(home, '.claude', 'settings.json');

  // Call 1 — does the work, stamps nothing.
  assert.equal(runHook(home, { cwd: home }).status, 0);
  const afterFirst = fs.readFileSync(file, 'utf8');
  assert.deepEqual(JSON.parse(afterFirst).permissions.allow, ['Bash(git status *)'],
    'call 1 generalized the pair');
  assert.equal(fs.existsSync(cacheFileFor(home)), false,
    'and stamped nothing, because it never read the bytes it wrote');

  // Call 2 — verifies the written bytes and stamps them.
  assert.equal(runHook(home, { cwd: home }).status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), afterFirst, 'call 2 wrote nothing');
  assert.equal(fs.existsSync(cacheFileFor(home)), true,
    'call 2 read a fixed point and stamped it — which is only possible because '
    + 'what writeAllow left behind is itself a fixed point');
  const key = fs.readFileSync(cacheFileFor(home), 'utf8').trim();
  const keyMtime = fs.statSync(cacheFileFor(home)).mtimeMs;
  const settingsMtime = fs.statSync(file).mtimeMs;

  // Calls 3 and 4 — hits. Neither file may move.
  assert.equal(runHook(home, { cwd: home }).status, 0);
  assert.equal(runHook(home, { cwd: home }).status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), afterFirst, 'settings bytes unchanged');
  assert.equal(fs.statSync(file).mtimeMs, settingsMtime, 'and settings not rewritten');
  assert.equal(fs.readFileSync(cacheFileFor(home), 'utf8').trim(), key, 'same key');
  assert.equal(fs.statSync(cacheFileFor(home)).mtimeMs, keyMtime,
    'and the key was not RE-earned, which is what proves those calls hit');
});

test('an unusable cache degrades to a miss, silently, in every shape', (t) => {
  const allow = ['Bash(git status --short)', 'Bash(git status --long)'];
  const collapsed = ['Bash(git status *)'];

  // Garbage, a truncated prefix of a real key, empty, whitespace, and a
  // DIRECTORY where the file should be — readFileSync throws EISDIR there, not
  // ENOENT, which is the case people forget.
  const shapes = ['not a key at all', '1:4ecb', '', '   \n', '<dir>'];
  for (const shape of shapes) {
    const home = tempHome(t, { permissions: { allow } });
    const file = cacheFileFor(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (shape === '<dir>') fs.mkdirSync(file);
    else fs.writeFileSync(file, shape, 'utf8');

    const result = runHook(home, { cwd: home });
    assert.equal(result.status, 0, `exit 0 for ${JSON.stringify(shape)}`);
    // NOT asserted silent: these fixtures deliberately need work, and a pass
    // that WRITES prints one `+n -m` diagnostic by design. The quiet contract
    // covers the no-op case, which the fixed-point test above owns. My first
    // version of this asserted empty stderr and failed on the real diagnostic —
    // worth keeping the distinction written down.
    assert.doesNotMatch(result.stderr, /error|Error|Cannot|undefined/,
      `no failure reported for ${JSON.stringify(shape)}`);
    assert.deepEqual(settingsOf(home).permissions.allow, collapsed,
      `still generalized for ${JSON.stringify(shape)}`);
  }
});

test('the hook loads no generalizer at all on a cache hit', (t) => {
  // The require chain is 3.5 ms of the ~13 ms this cache saves, and it can only
  // be deferred because the hit path does not need processAllowList. If someone
  // moves that require back to module scope the timing win halves silently, with
  // no functional symptom — so assert the module is not loaded rather than
  // trusting a clock.
  const home = tempHome(t, { permissions: { allow: ['Bash(rg *)'] } });
  const probe = path.join(home, 'probe.js');
  fs.writeFileSync(probe, [
    'process.on("exit", () => {',
    '  const loaded = Object.keys(require.cache).some((k) => /[\\\\/]src[\\\\/]permissions\\.js$/.test(k));',
    '  require("fs").writeFileSync(process.env.PW_PROBE_OUT, loaded ? "loaded" : "absent");',
    '});',
  ].join('\n'));
  const out = path.join(home, 'probe.txt');
  const root = path.parse(home).root;
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, PW_PROBE_OUT: out,
    HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
  };

  // First call primes the cache (and does load the generalizer, on the miss).
  spawnSync(process.execPath, [CLI], { cwd: home, encoding: 'utf8', input: '{}', env });
  // Second call is the hit.
  spawnSync(process.execPath, ['--require', probe, CLI], { cwd: home, encoding: 'utf8', input: '{}', env });

  assert.equal(fs.readFileSync(out, 'utf8'), 'absent',
    'src/permissions.js must not be loaded on a cache hit');
});


// ── the argument dispatch in front of hook mode ──────────────────────────────
//
// bin/wildcard-perms is a flat if/else chain whose FINAL else is hook mode, and
// hook mode rewrites settings.json. The three branches in front of it —
// --help/-h, --version/-V and the unrecognized-option guard — had no coverage
// at all, which is the wrong way round: reaching the last else by accident is
// the failure the guard exists to stop.
//
// The guard is the load-bearing one. Without it `--gate` (a typo for `--gates`)
// fell through to hook mode, so the single most likely first command anyone
// types silently rewrote the user's permission policy and exited 0 — and on a
// TTY, where nothing ever closes stdin, it instead hung forever waiting for an
// event that was never coming. Both halves are pinned: the policy file must be
// byte-identical afterwards, and stdin must never be read.

const { spawn } = require('node:child_process');
const PACKAGE_VERSION = require('../package.json').version;

// Deliberately NOT a fixed point: hook mode collapses the two `rg` entries and
// rewrites the file. That is what makes "byte-identical afterwards" an
// assertion rather than a tautology about a file nothing would have touched.
const UNOPTIMIZED = ['Bash(git status)', 'Bash(git diff)', 'Bash(rg foo)', 'Bash(rg bar)'];

// runHook's environment, but the arguments are the subject and stdin carries a
// real hook event: if a branch falls through to the last else, the event that
// would rewrite the policy is already sitting there waiting to be read.
function runArgs(home, args) {
  const root = path.parse(home).root;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: home, encoding: 'utf8', windowsHide: true,
    input: JSON.stringify({ cwd: home, tool_name: 'Bash' }),
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
    },
  });
}

const bytesOf = (home) => fs.readFileSync(path.join(home, '.claude', 'settings.json'));

for (const flag of ['--gate', '-x', '--dry-run', '--learn-all']) {
  test(`an unrecognized flag (${flag}) is refused, and writes nothing`, (t) => {
    const home = tempHome(t, { permissions: { allow: UNOPTIMIZED } });
    const before = bytesOf(home);

    const run = runArgs(home, [flag]);

    assert.equal(run.status, 2,
      `a refusal exits 2, not 0 — exiting 0 is how this went unnoticed; got ${run.status}`);
    assert.equal(run.stdout, '', 'the refusal belongs on stderr, so a pipe does not swallow it');
    assert.equal(run.stderr.split('\n')[0], `wildcard-perms: unrecognized option ${flag}`,
      `the offending flag has to be named back; got: ${JSON.stringify(run.stderr.slice(0, 200))}`);
    // Followed by the full usage, because a bare refusal leaves the reader
    // guessing at the verb they meant.
    assert.match(run.stderr, /^usage: wildcard-perms --gates on\|off\|status\|refresh$/m);
    assert.match(run.stderr, /^usage: wildcard-perms --help \| --version$/m);
    assert.ok(bytesOf(home).equals(before),
      'settings.json must be byte-identical: falling through to hook mode rewrote it');
  });
}

test('every flag in an unrecognized invocation is named back, not just the first', (t) => {
  const home = tempHome(t, { permissions: { allow: UNOPTIMIZED } });
  const before = bytesOf(home);

  const run = runArgs(home, ['--gate', 'on', '--verbose']);

  assert.equal(run.status, 2);
  assert.equal(run.stderr.split('\n')[0],
    'wildcard-perms: unrecognized option --gate --verbose');
  assert.ok(bytesOf(home).equals(before));
});

test('an unrecognized flag never reads stdin, and never waits for it', async (t) => {
  // THE observable that matters, and the one the exit code cannot give you: the
  // bug was that an unknown flag reached hook mode and processed the allow
  // list. So spawn with stdin held OPEN — never end()ed, exactly as a TTY
  // leaves it — and prove two things at once:
  //
  //   * the process exits anyway. Hook mode only runs on stdin's 'end', so a
  //     fall-through hangs forever here instead of exiting.
  //   * the payload is never drained. It is deliberately larger than any pipe
  //     buffer, so the write callback can only complete if something on the
  //     other end actually read it. Measured: 39 ms / not drained through the
  //     guard, versus a hang and a full 8 MiB drained in hook mode.
  const home = tempHome(t, { permissions: { allow: UNOPTIMIZED } });
  const before = bytesOf(home);
  const root = path.parse(home).root;
  // NOT cwd: home. A child that has to be killed still holds its cwd open on
  // Windows, and tempHome's rmSync then throws EBUSY from an after-hook — which
  // is how the failing version of this test hung the runner instead of just
  // reporting the failure.
  const child = spawn(process.execPath, [CLI, '--gate'], {
    cwd: os.tmpdir(), windowsHide: true,
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
    },
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  // A valid hook event, padded past the pipe buffer. Valid on purpose: under a
  // fall-through it is a real event that really would rewrite the policy.
  let drained = false;
  child.stdin.on('error', () => {});
  child.stdin.write(
    JSON.stringify({ cwd: home, tool_name: 'Bash', pad: 'x'.repeat(8 * 1024 * 1024) }),
    (error) => { if (!error) drained = true; },
  );

  // On the timeout the child is KILLED and then awaited, so this resolves only
  // once every pipe is closed. Resolving on the timer alone left the hung child
  // referenced by the runner, and a failing assertion is worthless if the
  // reporter never gets to print it.
  let timedOut = false;
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.stdin.destroy();
      child.kill('SIGKILL');
    }, 10000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });

  assert.equal(timedOut, false,
    'the process must exit without stdin ever being closed — hook mode waits for EOF forever');
  assert.equal(outcome.code, 2, `exited on ${outcome.signal ?? 'no signal'}`);
  assert.equal(drained, false,
    'stdin was consumed, so the flag reached hook mode and the event was processed');
  assert.match(stderr, /^wildcard-perms: unrecognized option --gate$/m);
  assert.ok(bytesOf(home).equals(before), 'and the policy file is untouched');
});

for (const flag of ['--help', '-h']) {
  test(`${flag} explains itself, exits 0, and writes nothing`, (t) => {
    const home = tempHome(t, { permissions: { allow: UNOPTIMIZED } });
    const before = bytesOf(home);

    const run = runArgs(home, [flag]);

    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '', `help is not an error; got: ${run.stderr}`);
    // The one line that has to be there: with no --help at all, the first thing
    // a new user typed was itself a policy write.
    assert.match(run.stdout,
      /^Run with NO arguments to act as a PostToolUse hook \(reads a JSON event on stdin\)\.$/m);
    for (const verb of ['--learn', '--drain', '--guidance', '--gates', '--seed',
      '--bypass']) {
      assert.ok(run.stdout.includes(`usage: wildcard-perms ${verb}`),
        `${verb} is dispatched but undocumented, so --help cannot be trusted to be complete`);
    }
    assert.doesNotMatch(run.stdout, /--max|--codex-max/,
      'retired compatibility spellings must not remain in the public help surface');
    assert.ok(bytesOf(home).equals(before), 'help must not touch the policy file');
  });
}

test('--help wins over a verb, so --learn --help explains instead of running', (t) => {
  // The ordering of the chain is the whole point: --help is checked ahead of
  // the verbs on purpose. Behind them, `--learn apply --help` runs the apply.
  const home = tempHome(t, { permissions: { allow: UNOPTIMIZED } });
  const before = bytesOf(home);

  const run = runArgs(home, ['--learn', 'apply', '--help']);

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.match(run.stdout, /^usage: wildcard-perms --help \| --version$/m);
  assert.ok(bytesOf(home).equals(before));
  // Every artefact --learn would leave lives under this one directory (state,
  // claims registry, policy lock), so its absence proves the verb never ran —
  // and stays true whatever those files are called next.
  assert.equal(fs.existsSync(path.join(home, '.claude', 'wildcarding')), false,
    'no Auto Learn artefact may be created: --learn must not have run at all');
});

for (const flag of ['--version', '-V']) {
  test(`${flag} prints exactly the package version, and writes nothing`, (t) => {
    const home = tempHome(t, { permissions: { allow: UNOPTIMIZED } });
    const before = bytesOf(home);

    const run = runArgs(home, [flag]);

    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, '');
    // Compared against package.json rather than a literal, so a release bump
    // cannot leave this test asserting a version the CLI no longer reports.
    assert.equal(run.stdout, `${PACKAGE_VERSION}\n`);
    assert.match(run.stdout, /^\d+\.\d+\.\d+\n$/,
      'the version is consumed by installers and must stay bare — no banner, no prefix');
    assert.ok(bytesOf(home).equals(before), '--version must not touch the policy file');
  });
}


// ── retired Codex compatibility command ─────────────────────────────────────

function codexLegacyHome(t, { snapshot = true } = {}) {
  const home = tempHome(t, { permissions: { allow: [] } });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'),
    'approval_policy = "never"\nmodel = "gpt-5.6-sol"\nsandbox_mode = "workspace-write"\n');
  if (snapshot) {
    const state = path.join(home, '.claude', 'backups', 'wildcarding-codex-max.json');
    fs.mkdirSync(path.dirname(state), { recursive: true });
    fs.writeFileSync(state, JSON.stringify({ priorApproval: 'on-request' }, null, 2) + '\n');
  }
  return home;
}
const codexConfigOf = (home) => fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');

for (const args of [
  ['--codex-max', 'on'],
  ['--codex-max', 'on', '--override-stale-policy'],
]) {
  test(`${args.join(' ')} cannot enable the retired feature`, (t) => {
    const home = codexLegacyHome(t);
    const configPath = path.join(home, '.codex', 'config.toml');
    const statePath = path.join(home, '.claude', 'backups', 'wildcarding-codex-max.json');
    const configBefore = fs.readFileSync(configPath);
    const stateBefore = fs.readFileSync(statePath);

    const run = runArgs(home, args);

    assert.equal(run.status, 1);
    assert.match(run.stderr, /feature was removed; nothing was changed/);
    assert.ok(fs.readFileSync(configPath).equals(configBefore), 'config.toml stays byte-identical');
    assert.ok(fs.readFileSync(statePath).equals(stateBefore), 'the cleanup snapshot is retained');
  });
}

test('--codex-max status reports only legacy cleanup state', (t) => {
  const run = runArgs(codexLegacyHome(t), ['--codex-max', 'status']);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /legacy Codex MAX configuration: DETECTED/);
  assert.match(run.stdout, /approval_policy=never, snapshot=valid/);
  assert.doesNotMatch(run.stdout, /enterprise policy|override|enable/i);
});

test('--codex-max off restores an owned legacy setting and preserves other config', (t) => {
  const home = codexLegacyHome(t);
  const statePath = path.join(home, '.claude', 'backups', 'wildcarding-codex-max.json');

  const run = runArgs(home, ['--codex-max', 'off']);

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /removed legacy configuration/);
  assert.equal(codexConfigOf(home),
    'approval_policy = "on-request"\nmodel = "gpt-5.6-sol"\nsandbox_mode = "workspace-write"\n');
  assert.equal(fs.existsSync(statePath), false, 'the consumed cleanup snapshot is removed');
});

test('--codex-max off refuses an unowned never policy without changing it', (t) => {
  const home = codexLegacyHome(t, { snapshot: false });
  const before = codexConfigOf(home);

  const run = runArgs(home, ['--codex-max', 'off']);

  assert.equal(run.status, 1);
  assert.match(run.stderr, /no valid legacy snapshot proves ownership/);
  assert.equal(codexConfigOf(home), before);
});

// ── the stdin cap ─────────────────────────────────────────────────────────────
//
// A PostToolUse payload carries the tool's OUTPUT, so its size is whatever the
// tool printed, and the hook accumulated it without a bound to read one short
// string out of it.
//
// The dangerous way to cap it is to keep the prefix. A truncated prefix is
// invalid JSON, hookCwd() returns null, and the project-local drain then stops
// promoting approvals FOREVER with nothing in any log to say why — which is why
// these two tests are a pair: one proves the drain still happens under the cap,
// the other proves that when it does not happen the run says so.

// A workspace with one project-local approval that user scope does not cover, so
// "the drain ran" and "the drain did not run" are distinguishable on disk.
function workspaceWithLocalApproval(home) {
  const workspace = path.join(home, 'project');
  fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, '.claude', 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['Bash(tokei .)'] } }, null, 2) + '\n',
  );
  return workspace;
}

const localAllowOf = (workspace) => JSON.parse(fs.readFileSync(
  path.join(workspace, '.claude', 'settings.local.json'), 'utf8',
)).permissions.allow;

test('a hook event under the cap still drains the project-local approvals', (t) => {
  const home = tempHome(t, { permissions: { allow: ['Bash(git status *)'] } });
  const workspace = workspaceWithLocalApproval(home);

  // Padded, but comfortably under the 1 MiB cap: this is the ordinary case, and
  // it has to stay ordinary or the assertion below is about the padding.
  const run = runHook(home, {
    cwd: workspace, tool_name: 'Bash', tool_response: { stdout: 'x'.repeat(256 * 1024) },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /exceeded/, 'nothing was capped at this size');
  assert.ok(settingsOf(home).permissions.allow.includes('Bash(tokei *)'),
    'precondition for the test below: at this size the drain promotes the local entry');
  assert.deepEqual(localAllowOf(workspace), [],
    'and prunes it locally once the promotion is verified');
});

test('a hook event over the cap says so and skips the drain instead of truncating', (t) => {
  const home = tempHome(t, { permissions: { allow: ['Bash(git status)', 'Bash(git diff)'] } });
  const workspace = workspaceWithLocalApproval(home);

  const run = runHook(home, {
    cwd: workspace, tool_name: 'Bash', tool_response: { stdout: 'x'.repeat(2 * 1024 * 1024) },
  });

  // Exit 0 whatever happens: this runs after every single tool call.
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '', 'the hook path stays quiet on stdout');
  // The line that makes this a graceful fallback rather than a silent one. A cap
  // that truncates instead reports nothing at all, and the drain simply stops.
  assert.match(run.stderr, /hook event exceeded 1048576 bytes/);
  assert.match(run.stderr, /the project-local drain was skipped for this call/);

  // No cwd was read, so no drain — and specifically NOT a half-drain.
  assert.deepEqual(localAllowOf(workspace), ['Bash(tokei .)'],
    'the local file must be untouched, not partially promoted');
  assert.ok(!settingsOf(home).permissions.allow.includes('Bash(tokei *)'),
    'nothing was promoted from a payload we could not read');

  // And the half that does not depend on the payload still ran, which is what the
  // stderr line promises. Without this the "user-scope pass still ran" sentence is
  // a claim nothing checks.
  assert.deepEqual(settingsOf(home).permissions.allow,
    ['Bash(git status *)', 'Bash(git diff *)'],
    'the wildcarding pass reads settings.json, not the event, and is unaffected');

  // MUTATION: remove the cap (`input += chunk` unconditionally, `run(input)`) and
  // this fails on the stderr match, with the local entry promoted and pruned.
  // MUTATION: keep the prefix instead of dropping it (`input` not reset, still
  // `run(input)`) and it fails the same way it would in production — silently, on
  // the stderr assertion only, with the drain skipped and nothing saying why.
});

// ── the diagnostic describes the write, not the intent ────────────────────────
//
// wildcardUnderLock computed its +added/-removed/total from its OWN pre-write
// snapshot while writeAllow, which re-reads and rebases inside itself, was
// already returning the real counts. The two agree until a concurrent settings
// write lands between the caller's read and the writer's — which is the only
// case where anyone reads the line, because it is the case where something
// surprising happened. src/settings-write.js:212-214 names the failure: a caller
// reporting its own intent announced "+299 restored" over a file that already
// had them.
//
// Deterministic here rather than raced: a `--require` preload patches
// fs.readFileSync and rewrites settings.json after the caller's read, so
// writeAllow's re-read sees a file the caller never saw. That is the interleaving
// Claude Code produces by itself on every /model, /effort and approval.
function runHookWithSettingsRace(home, { afterRead, replacement }) {
  const shim = path.join(home, 'race-shim.js');
  fs.writeFileSync(shim, [
    "const fs = require('fs');",
    "const path = require('path');",
    'const target = path.resolve(process.env.PW_RACE_TARGET);',
    'const at = Number(process.env.PW_RACE_AFTER);',
    'const body = process.env.PW_RACE_BODY;',
    'let reads = 0;',
    'const real = fs.readFileSync;',
    'fs.readFileSync = function (file, ...rest) {',
    '  const out = real.call(this, file, ...rest);',
    '  if (typeof file === "string" && path.resolve(file) === target) {',
    '    reads += 1;',
    '    if (reads === at) real.call(fs, target) && fs.writeFileSync(target, body);',
    '  }',
    '  return out;',
    '};',
  ].join('\n') + '\n');

  const root = path.parse(home).root;
  return spawnSync(process.execPath, ['--require', shim, CLI], {
    cwd: home, encoding: 'utf8', windowsHide: true,
    input: JSON.stringify({ tool_name: 'Bash' }),
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
      PW_RACE_TARGET: path.join(home, '.claude', 'settings.json'),
      PW_RACE_AFTER: String(afterRead),
      PW_RACE_BODY: JSON.stringify(replacement, null, 2) + '\n',
    },
  });
}

test('the hook diagnostic counts what landed, not what the pass meant to do', (t) => {
  const home = tempHome(t, { permissions: { allow: ['Bash(git status)', 'Bash(git diff)'] } });

  // Read 1 is run()'s byte read, read 2 is wildcardUnderLock's readSettingsState,
  // read 3 is writeAllow's own. Rewrite after read 2: a neighbour dropped
  // Bash(git diff) and added Bash(zzz *) while this pass was thinking.
  const run = runHookWithSettingsRace(home, {
    afterRead: 2,
    replacement: { permissions: { allow: ['Bash(git status)', 'Bash(zzz *)'] } },
  });

  assert.equal(run.status, 0, run.stderr);
  const allow = settingsOf(home).permissions.allow;

  // First: the race really happened, or this test is pinning the easy case where
  // both implementations agree and it proves nothing.
  assert.ok(allow.includes('Bash(zzz *)'),
    'precondition: the concurrent write must have survived the rebase, or no read '
    + 'disagreed with any other and the diagnostic had nothing to get wrong');
  assert.deepEqual(allow, ['Bash(zzz *)', 'Bash(git status *)', 'Bash(git diff *)']);

  // And now the line. The total is the one a reader checks against the file.
  assert.match(run.stderr, /^wildcard-perms: \+2 -1 → 3 entries$/m,
    `the diagnostic must describe the file that exists; got ${JSON.stringify(run.stderr)}`);
  const reported = /→ (\d+) entries/.exec(run.stderr);
  assert.equal(Number(reported[1]), allow.length,
    'the reported total and the real entry count are the same number or the line is fiction');

  // MUTATION: restore the pre-write snapshot arithmetic in wildcardUnderLock —
  // `after.filter(p => !before.includes(p))` / `before.filter(p => !after.includes(p))`
  // over `after.length` — and this fails with "+2 -2 → 2 entries" written over a
  // file holding 3.
});
// ── stdin is read synchronously, and must still be read WHOLE ────────────────
//
// The hook stopped using process.stdin: constructing the stream and running the
// event loop for its 'data'/'end' round trip was 5.4 min / 5.1 p50 ms of a 59-65
// ms hook call, on the path that runs after every single tool call. What replaces
// it is a bounded fs.readSync loop, and the loop is the load-bearing part — a
// pipe hands over whatever has arrived so far, so a short read is not EOF.
//
// Stopping at the first read truncates a payload delivered in pieces, and a
// truncated payload is invalid JSON: hookCwd returns null and the project-local
// drain is skipped. That is the exact failure the byte cap above is written
// around, reached by a different door.

// A hook event written in slices with gaps between them, the shape spawnSync
// cannot produce because it hands the child everything at once. The payload is
// deliberately larger than one 64 KiB read buffer as well, so a single read
// cannot accidentally capture it.
function runHookChunked(home, event, slices = 12) {
  const root = path.parse(home).root;
  const child = spawn(process.execPath, [CLI], {
    cwd: os.tmpdir(), windowsHide: true,
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.resume();
  const payload = JSON.stringify(event);
  const size = Math.ceil(payload.length / slices);
  let index = 0;
  const write = () => {
    if (index * size >= payload.length) { child.stdin.end(); return; }
    child.stdin.write(payload.slice(index * size, (index + 1) * size));
    index += 1;
    setTimeout(write, 4);
  };
  child.stdin.on('error', () => {});
  write();
  return new Promise((resolve) => {
    child.on('close', (status) => resolve({ status, stderr, slices: index }));
  });
}

test('a hook event delivered in slices is read whole, not truncated at the first read', async (t) => {
  const home = tempHome(t, { permissions: { allow: ['Bash(git status *)'] } });
  const workspace = workspaceWithLocalApproval(home);

  const run = await runHookChunked(home, {
    cwd: workspace, tool_name: 'Bash', tool_response: { stdout: 'x'.repeat(200 * 1024) },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.slices > 1,
    `the payload has to arrive in more than one piece or this proves nothing; got ${run.slices}`);
  assert.doesNotMatch(run.stderr, /exceeded/, `under the cap at this size; got: ${run.stderr}`);
  assert.doesNotMatch(run.stderr, /did not parse as JSON/,
    `the whole event was read, so it parsed; got: ${run.stderr}`);

  // The observable that separates "read whole" from "read the first slice":
  // the cwd only exists in the payload, so the drain can only have run if the
  // JSON parsed, and the JSON can only parse if every slice was collected.
  assert.ok(settingsOf(home).permissions.allow.includes('Bash(tokei *)'),
    'the cwd came out of a payload that arrived in pieces, so the drain promoted the local entry');
  assert.deepEqual(localAllowOf(workspace), [],
    'and pruned it locally once the promotion was verified');

  // MUTATION: drop the loop in bin/wildcard-perms — one `fs.readSync(0, ...)`
  // instead of `for (;;)` — and this fails on the promotion assertion, with
  // "the 17800-byte hook event on stdin did not parse as JSON" on stderr.
  // MUTATION: `if (read < buffer.length) break;` fails identically.
});

test('a hook event that does not parse says so instead of skipping the drain in silence', (t) => {
  const home = tempHome(t, { permissions: { allow: ['Bash(git status)', 'Bash(git diff)'] } });
  const workspace = workspaceWithLocalApproval(home);

  // A truncated event: valid JSON up to the cut, which is precisely what a
  // short read produces and precisely what cannot be distinguished from an
  // empty one after the fact.
  const root = path.parse(home).root;
  const whole = JSON.stringify({ cwd: workspace, tool_name: 'Bash' });
  const run = spawnSync(process.execPath, [CLI], {
    cwd: os.tmpdir(), encoding: 'utf8', windowsHide: true,
    input: whole.slice(0, whole.length - 8),
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
    },
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, '', 'the hook path stays quiet on stdout');
  // The line that makes the skip visible. Without it the run is byte-identical
  // to a healthy one that simply had nothing to drain.
  assert.match(run.stderr, /hook event on stdin did not parse as JSON/);
  assert.match(run.stderr, /the project-local drain was skipped for this call/);

  // And it is a skip, not a half-drain.
  assert.deepEqual(localAllowOf(workspace), ['Bash(tokei .)'],
    'nothing may be promoted or pruned from an event that could not be read');
  assert.deepEqual(settingsOf(home).permissions.allow,
    ['Bash(git status *)', 'Bash(git diff *)'],
    'the user-scope pass reads settings.json, not the event, and still ran');

  // MUTATION: restore the silent `catch { return null; }` in hookCwd and this
  // fails on the stderr match — with every other assertion still passing, which
  // is exactly how the silent version survived.
});
