'use strict';

// The MEMORY.md guard's installer (src/memory-guard-install.js), against throwaway homes: the
// stable copy and its revision rule, the one-time backup, the settings.json write through the
// compare-and-swap writer under the policy lock, the refusals, the status and its policy line,
// and the /goal probe against a stub `claude`. Nothing here touches the real ~/.claude.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveNodeExecutable, memoryGuardStatus, setMemoryGuard, refreshMemoryGuardCopy,
  memoryGuardProbe, classifyProbe, guardRevision,
} = require('../src/memory-guard-install');
const { GUARD_REVISION } = require('../src/memory-index-guard');
const { memoryGuardDefinition } = require('../src/claude-hook-config');

function fixture(t, settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-memory-guard-install-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (settings !== undefined) fs.writeFileSync(settingsPath, settings);
  return {
    home, settingsPath,
    script: path.join(home, '.claude', 'wildcarding', 'memory-index-guard.js'),
    backup: path.join(home, '.claude', 'backups', 'settings.json.pre-memory-guard'),
    // No managed-settings.json anywhere: the machine's real policy files must not decide a test,
    // and no CLAUDE_CONFIG_DIR from the environment running the suite either.
    options: { home, nodeExecutable: process.execPath, managedSettingsPaths: [], env: {} },
    bytes: () => fs.readFileSync(settingsPath),
    json: () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')),
  };
}

const OTHER = { model: 'opus', effortLevel: 'high', permissions: { allow: ['Bash(git *)'], deny: ['Bash(rm -rf *)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node audit.js', timeout: 5 }] }],
    PostToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node "C:/x/bin/wildcard-perms"', async: true }] }],
  } };
const text = (value) => JSON.stringify(value, null, 2) + '\n';

test('a fresh install writes the copy, the hook and no backup when there was no settings.json', (t) => {
  const f = fixture(t);
  const result = setMemoryGuard(true, f.options);
  assert.equal(result.status, 'configured');
  assert.equal(result.label, 'on');
  assert.equal(result.changed, true);
  assert.equal(result.backupPath, null, 'nothing to back up');
  assert.equal(result.backupAbsent, `${f.backup}.absent`, 'but the absence is recorded');
  assert.equal(fs.existsSync(f.backup), false);
  assert.deepEqual(f.json(), { hooks: { PreToolUse: [memoryGuardDefinition({ home: f.home, nodeExecutable: process.execPath })] } });
  assert.equal(guardRevision(fs.readFileSync(f.script, 'utf8')), GUARD_REVISION);
  assert.equal(result.nodeExists, true);
  assert.equal(result.copyOutdated, false);
});

// MUTATION: write the backup on every change (drop the existsSync test in takeBackup) and the
// second on below overwrites the pre-guard bytes with the guard's own output.
test('on keeps the pre-change bytes once, is idempotent, and off round-trips settings.json byte for byte', (t) => {
  const prior = text(OTHER);
  const f = fixture(t, prior);
  const on = setMemoryGuard(true, f.options);
  assert.equal(on.changed, true);
  assert.equal(fs.readFileSync(f.backup, 'utf8'), prior, 'the backup is the bytes before the first change');
  const installed = f.bytes();
  const data = f.json();
  assert.deepEqual(data.hooks.PostToolUse, OTHER.hooks.PostToolUse);
  assert.deepEqual(data.hooks.PreToolUse[0], OTHER.hooks.PreToolUse[0]);
  assert.ok(installed.toString().includes(JSON.stringify(OTHER.hooks.PostToolUse, null, 2).replace(/\n/g, '\n    ')),
    'the other hooks serialise exactly as they did');
  const again = setMemoryGuard(true, f.options);
  assert.equal(again.changed, false);
  assert.ok(f.bytes().equals(installed), 'a repeat on writes nothing');
  const off = setMemoryGuard(false, f.options);
  assert.equal(off.changed, true);
  assert.equal(off.status, 'missing');
  assert.equal(f.bytes().toString(), prior, 'off restores the file exactly');
  assert.equal(fs.readFileSync(f.backup, 'utf8'), prior, 'off is a change too, and keeps the first snapshot');
  setMemoryGuard(true, f.options);
  assert.equal(fs.readFileSync(f.backup, 'utf8'), prior, 'a later on keeps the first snapshot');
  assert.ok(fs.existsSync(f.script), 'off leaves the copy, so a running session still has a script to run');
});

// CLAUDE_CONFIG_DIR moves Claude Code's settings.json, and the guard already reads it to find the
// index, so install, status and backup follow it too (audit 2026-10-20). Unset, or empty, it is
// <home>/.claude, as before.
// MUTATION: make configDirFor ignore CLAUDE_CONFIG_DIR and the first half writes <home>/.claude.
test('CLAUDE_CONFIG_DIR moves the settings.json, the stable copy and the backup, and unset means ~/.claude', (t) => {
  const f = fixture(t, text(OTHER));
  const config = path.join(f.home, 'elsewhere', 'claude-config');
  fs.mkdirSync(config, { recursive: true });
  const configured = path.join(config, 'settings.json');
  fs.writeFileSync(configured, text({ model: 'sonnet' }));
  const options = { ...f.options, env: { CLAUDE_CONFIG_DIR: config } };
  const on = setMemoryGuard(true, options);
  assert.equal(on.settingsPath, configured);
  assert.equal(on.scriptPath, path.join(config, 'wildcarding', 'memory-index-guard.js'));
  assert.equal(on.status, 'configured');
  assert.ok(fs.existsSync(on.scriptPath), 'the copy is under the config dir');
  assert.equal(on.backupPath, path.join(config, 'backups', 'settings.json.pre-memory-guard'));
  assert.equal(fs.readFileSync(on.backupPath, 'utf8'), text({ model: 'sonnet' }));
  const registered = JSON.parse(fs.readFileSync(configured, 'utf8'));
  assert.deepEqual(registered.hooks.PreToolUse, [memoryGuardDefinition({ home: f.home, configDir: config, nodeExecutable: process.execPath })]);
  assert.ok(registered.hooks.PreToolUse[0].hooks[0].command.includes('claude-config/wildcarding/memory-index-guard.js'));
  assert.equal(f.bytes().toString(), text(OTHER), '<home>/.claude/settings.json is not the one in use, and is untouched');
  assert.equal(fs.existsSync(f.script), false);
  assert.equal(memoryGuardStatus(options).label, 'on');
  assert.equal(memoryGuardStatus(f.options).label, 'off', 'unset, the home config has no guard');
  assert.equal(setMemoryGuard(false, options).on, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(configured, 'utf8')), { model: 'sonnet' });

  const plain = setMemoryGuard(true, { ...f.options, env: { CLAUDE_CONFIG_DIR: '' } });
  assert.equal(plain.settingsPath, f.settingsPath, 'an empty CLAUDE_CONFIG_DIR is unset');
  assert.ok(fs.existsSync(f.script));
});

// The backup is "as it was before the FIRST change" even when there was no file then (audit
// 2026-10-20): 1.9.0 wrote nothing on that first on, so the next off snapshotted the
// guard-installed bytes, and restoring that "backup" turned the guard back on.
// MUTATION: skip the absent marker (return early on ENOENT as 1.9.0 did) and the off below writes
// a backup holding the installed hook.
test('on with no settings.json records the absence, and a later off never backs up the installed bytes', (t) => {
  const f = fixture(t);
  const on = setMemoryGuard(true, f.options);
  assert.equal(fs.existsSync(f.settingsPath), true, 'precondition: on created settings.json');
  const off = setMemoryGuard(false, f.options);
  assert.equal(off.changed, true);
  assert.equal(fs.existsSync(f.backup), false, 'no backup of the guard-installed bytes');
  assert.equal(off.backupPath, null);
  assert.equal(off.backupAbsent, on.backupAbsent, 'off reports the first change\'s record');
  assert.match(fs.readFileSync(on.backupAbsent, 'utf8'), /did not exist before the MEMORY\.md guard first changed it/);
  setMemoryGuard(true, f.options);
  setMemoryGuard(false, f.options);
  assert.equal(fs.existsSync(f.backup), false, 'nor on any later change');
});

// writeTransform writes LF; a CRLF settings.json keeps every value, and its exact CRLF bytes are
// in the backup.
test('a CRLF settings.json keeps every value, and its bytes are what the backup holds', (t) => {
  const prior = text(OTHER).replace(/\n/g, '\r\n');
  const f = fixture(t, prior);
  setMemoryGuard(true, f.options);
  assert.ok(fs.readFileSync(f.backup).equals(Buffer.from(prior)), 'the backup is byte-exact, CRs and all');
  const data = f.json();
  data.hooks.PreToolUse = data.hooks.PreToolUse.slice(0, 1);
  assert.deepEqual(data, OTHER);
  setMemoryGuard(false, f.options);
  assert.deepEqual(f.json(), OTHER);
});

test('an outdated hook of ours is repaired, not doubled', (t) => {
  const f = fixture(t);
  const ours = memoryGuardDefinition({ home: f.home, nodeExecutable: process.execPath });
  fs.writeFileSync(f.settingsPath, text({ hooks: { PreToolUse: [{ ...ours, hooks: [{ ...ours.hooks[0], timeout: 99 }] }] } }));
  assert.equal(memoryGuardStatus(f.options).status, 'outdated');
  assert.equal(memoryGuardStatus(f.options).label, 'on (needs repair)');
  const result = setMemoryGuard(true, f.options);
  assert.equal(result.status, 'configured');
  assert.deepEqual(f.json(), { hooks: { PreToolUse: [ours] } });
});

test('a foreign guard is refused, and the refusal leaves no copy, no backup and no change', (t) => {
  const prior = text({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node "/repo/src/memory-index-guard.js"' }] }] } });
  const f = fixture(t, prior);
  assert.equal(memoryGuardStatus(f.options).label, 'foreign');
  assert.throws(() => setMemoryGuard(true, f.options), /refusing to add the MEMORY\.md guard/);
  assert.equal(f.bytes().toString(), prior);
  assert.equal(fs.existsSync(f.script), false, 'no copy for a refused install');
  assert.equal(fs.existsSync(f.backup), false);
  const off = setMemoryGuard(false, f.options);
  assert.equal(off.changed, false, 'off has nothing of ours to remove, and leaves the foreign hook alone');
  assert.equal(f.bytes().toString(), prior);
});

test('an unreadable settings.json is refused before anything is written', (t) => {
  const prior = '{ "model": "opus", "permissions": { "allow": [ ';
  const f = fixture(t, prior);
  assert.throws(() => setMemoryGuard(true, f.options), (error) => error.code === 'SETTINGS_UNREADABLE');
  assert.equal(f.bytes().toString(), prior);
  assert.equal(fs.existsSync(f.script), false);
  assert.equal(memoryGuardStatus(f.options).status, 'unreadable');
  assert.equal(memoryGuardStatus(f.options).label, 'unreadable');
});

// The shared policy lock, at the path derived from THIS home.
// MUTATION: lock POLICY_LOCK_PATH (the real home's) instead of lockPathFor(home) and the held
// lock below is not contended, so the install goes through.
test('a held policy lock is reported as busy and nothing is written', (t) => {
  const f = fixture(t, text(OTHER));
  const lock = path.join(f.home, '.claude', 'wildcarding', 'auto-learn-policy.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, owner: 'another writer', at: new Date().toISOString() }));
  assert.throws(() => setMemoryGuard(true, f.options), (error) => error.code === 'AUTO_LEARN_LOCKED');
  assert.equal(f.bytes().toString(), text(OTHER));
  assert.equal(fs.existsSync(f.script), false);
});

// The re-read after the write is a real check: a write that "succeeded" and left the file as it
// was must throw. The rename is swallowed here, the way a filter driver or a racing writer can.
// MUTATION: drop the `if (!held) throw` in setMemoryGuard and this passes silently.
test('a write that did not stick is reported, not announced', (t) => {
  const f = fixture(t, text(OTHER));
  const realRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.resolve(to) === path.resolve(f.settingsPath)) { fs.unlinkSync(from); return; }
    return realRename(from, to);
  });
  assert.throws(() => setMemoryGuard(true, f.options), /did not keep the MEMORY\.md guard on/);
});

test('on refuses when no node can be found, and writes nothing', (t) => {
  const f = fixture(t, text(OTHER));
  assert.throws(() => setMemoryGuard(true, { ...f.options, nodeExecutable: null }), /cannot find node on PATH/);
  assert.throws(() => setMemoryGuard(true, { ...f.options, nodeExecutable: path.join(f.home, 'no-node.exe') }), /does not exist/);
  assert.equal(f.bytes().toString(), text(OTHER));
  assert.equal(fs.existsSync(f.script), false);
});

test('node is found on PATH, absolute entries only, and never as a .cmd on Windows', (t) => {
  const f = fixture(t);
  const bin = path.join(f.home, 'bin');
  const empty = path.join(f.home, 'empty');
  fs.mkdirSync(bin);
  fs.mkdirSync(empty);
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  fs.writeFileSync(path.join(bin, name), '');
  if (process.platform !== 'win32') fs.chmodSync(path.join(bin, name), 0o755);
  if (process.platform === 'win32') fs.writeFileSync(path.join(empty, 'node.cmd'), '@echo off\r\n');
  const env = (PATH) => ({ PATH, ProgramFiles: empty });
  assert.equal(resolveNodeExecutable({ env: env([empty, bin].join(path.delimiter)) }), path.join(bin, name));
  assert.equal(resolveNodeExecutable({ env: env(empty) }), null, 'a node.cmd shim is not a node');
  // A relative entry that DOES hold a node from where this process stands: still skipped.
  // MUTATION: drop `path.isAbsolute(dir)` from the PATH filter and `bin` below is found.
  const cwd = process.cwd();
  process.chdir(f.home);
  try {
    assert.ok(fs.existsSync(path.join('bin', name)), 'precondition: the relative entry holds a node');
    assert.equal(resolveNodeExecutable({ env: env(['.', 'bin'].join(path.delimiter)) }), null, 'relative entries are skipped');
  } finally {
    process.chdir(cwd);
  }
});

// Refreshed by REVISION, never by bytes: the same revision with different bytes (a CRLF copy
// against an LF build) is left alone, an older revision is replaced, a newer one is kept.
// MUTATION: refresh when the bytes differ and the CRLF case below is rewritten.
test('the stable copy is refreshed when the packaged revision is higher, and only then', (t) => {
  const f = fixture(t);
  setMemoryGuard(true, f.options);
  const shipped = fs.readFileSync(f.script, 'utf8');
  const flipped = shipped.includes('\r\n') ? shipped.replace(/\r\n/g, '\n') : shipped.replace(/\n/g, '\r\n');
  fs.writeFileSync(f.script, flipped);
  assert.equal(refreshMemoryGuardCopy(f.options).refreshed, false, 'same revision, other line endings: kept');
  assert.equal(fs.readFileSync(f.script, 'utf8'), flipped);
  // An explicit on copies too, under the same rule.
  assert.equal(setMemoryGuard(true, f.options).copy.refreshed, false);
  assert.equal(fs.readFileSync(f.script, 'utf8'), flipped, 'on leaves a same-revision copy alone');

  fs.writeFileSync(f.script, shipped.replace(/^const GUARD_REVISION = \d+;/m, 'const GUARD_REVISION = 0;'));
  assert.equal(memoryGuardStatus(f.options).label, 'on (copy outdated)');
  const refreshed = refreshMemoryGuardCopy(f.options);
  assert.equal(refreshed.refreshed, true);
  assert.equal(fs.readFileSync(f.script, 'utf8'), shipped);
  assert.equal(memoryGuardStatus(f.options).label, 'on');

  const newer = shipped.replace(/^const GUARD_REVISION = \d+;/m, `const GUARD_REVISION = ${GUARD_REVISION + 5};`);
  fs.writeFileSync(f.script, newer);
  assert.equal(refreshMemoryGuardCopy(f.options).refreshed, false, 'a newer copy (a newer extension) is kept');
  assert.equal(fs.readFileSync(f.script, 'utf8'), newer);

  // A packaged build whose revision is higher than the copy's, as after an upgrade.
  const packaged = path.join(f.home, 'packaged-guard.js');
  fs.writeFileSync(packaged, shipped.replace(/^const GUARD_REVISION = \d+;/m, `const GUARD_REVISION = ${GUARD_REVISION + 9};`));
  const upgraded = refreshMemoryGuardCopy({ ...f.options, packagedPath: packaged });
  assert.equal(upgraded.refreshed, true);
  assert.equal(guardRevision(fs.readFileSync(f.script, 'utf8')), GUARD_REVISION + 9);

  // Without our hook registered, the copy is not touched at all.
  setMemoryGuard(false, f.options);
  fs.writeFileSync(f.script, 'const GUARD_REVISION = 0;\n');
  assert.equal(refreshMemoryGuardCopy(f.options).refreshed, false);
  assert.equal(fs.readFileSync(f.script, 'utf8'), 'const GUARD_REVISION = 0;\n');
});

// The packaged guard ships with this code, so its revision is read once per process, not on
// every status call (the dashboard calls status on each push).
// MUTATION: read PACKAGED_GUARD inside memoryGuardStatus again and the second call reads it.
test('status reads the packaged guard\'s revision once, not on every call', (t) => {
  const f = fixture(t);
  const packaged = path.join(__dirname, '..', 'src', 'memory-index-guard.js');
  memoryGuardStatus(f.options);
  const reads = [];
  const real = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function readFileSync(file, ...rest) {
    reads.push(path.resolve(String(file)));
    return real.call(this, file, ...rest);
  });
  const status = memoryGuardStatus(f.options);
  memoryGuardStatus(f.options);
  assert.equal(status.packagedRevision, GUARD_REVISION);
  assert.ok(reads.length > 0, 'WITNESS: the mock sees status\'s own reads');
  assert.deepEqual(reads.filter((file) => file === path.resolve(packaged)), [], `re-read: ${reads.join(', ')}`);
});

test('status says when the node the hook names is gone', (t) => {
  const f = fixture(t);
  const ghost = path.join(f.home, 'gone', process.platform === 'win32' ? 'node.exe' : 'node');
  fs.writeFileSync(f.settingsPath, text({ hooks: { PreToolUse: [memoryGuardDefinition({ home: f.home, nodeExecutable: ghost })] } }));
  const status = memoryGuardStatus(f.options);
  assert.equal(status.status, 'configured');
  assert.equal(status.nodeExists, false);
  assert.equal(status.copy.exists, false);
  assert.equal(status.label, 'on (needs repair)', 'a hook whose node is gone judges nothing, and reads as needing repair');
  const repaired = setMemoryGuard(true, f.options);
  assert.equal(repaired.label, 'on', 'on re-points it at the node found now');
  assert.equal(repaired.nodeExists, true);
});

// The policy line, on every status, from what this machine can read.
// MUTATION: drop 'allowManagedHooksOnly' from the key list in hookPolicy and the first two cases
// read as unknown.
test('the policy line says when Claude Code will not run the guard, and says unknown otherwise', (t) => {
  const f = fixture(t, text({}));
  const managed = path.join(f.home, 'managed-settings.json');
  fs.writeFileSync(managed, JSON.stringify({ allowManagedHooksOnly: true }));
  let policy = memoryGuardStatus({ ...f.options, managedSettingsPaths: [managed] }).policy;
  assert.equal(policy.restricted, true);
  assert.equal(policy.line, 'Claude Code will not run it here (managed policy blocks user hooks).');
  assert.match(policy.sources[0], /sets allowManagedHooksOnly$/);

  fs.writeFileSync(path.join(f.home, '.claude', 'remote-settings.json'), '\uFEFF' + JSON.stringify({ allowManagedHooksOnly: true }));
  policy = memoryGuardStatus(f.options).policy;
  assert.equal(policy.restricted, true, 'the cached server-delivered policy counts');
  fs.rmSync(path.join(f.home, '.claude', 'remote-settings.json'));

  fs.writeFileSync(managed, JSON.stringify({ disableAllHooks: true }));
  assert.equal(memoryGuardStatus({ ...f.options, managedSettingsPaths: [managed] }).policy.restricted, true);

  fs.writeFileSync(f.settingsPath, text({ disableAllHooks: true }));
  policy = memoryGuardStatus(f.options).policy;
  assert.equal(policy.line, 'Claude Code will not run it here (disableAllHooks is set in settings.json).');

  fs.writeFileSync(f.settingsPath, text({ disableAllHooks: false }));
  policy = memoryGuardStatus(f.options).policy;
  assert.equal(policy.restricted, null, 'nothing found is unknown, never "runs"');
  assert.match(policy.line, /remotely delivered policy is not visible locally, so run `wildcard-perms --memory-guard probe`/);
});

// ── the /goal probe ──────────────────────────────────────────────────────────

const RESTRICTED = "/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is set in settings or by policy)";

test('the probe reads Claude Code\'s refusal text, and anything else as accepted or unknown', () => {
  assert.equal(classifyProbe({ status: 1, stdout: RESTRICTED, stderr: '' }).result, 'restricted');
  assert.equal(classifyProbe({ status: 0, stdout: '', stderr: RESTRICTED.replace("'", '\u2019') }).result, 'restricted');
  assert.equal(classifyProbe({ status: 0, stdout: 'Goal set: reply with the word acolyte-probe-ok and stop', stderr: '' }).result,
    'not restricted');
  assert.equal(classifyProbe({ status: 0, stdout: 'acolyte-probe-ok', stderr: '' }).result, 'not restricted');
  // Accepted needs positive evidence (audit 2026-10-20): an exit 0 without the goal's word is
  // unknown, never "not restricted".
  // MUTATION: drop the PROBE_WORD test from classifyProbe and the first three below read as
  // "not restricted".
  for (const answer of ['Unknown skill: goal', 'Goal set: probe', '', '/goal is only available in trusted workspaces. Restart, '
    + 'accept the trust dialog, and try again.', 'Unknown command: /goal acolyte-probe-ok']) {
    assert.equal(classifyProbe({ status: 0, stdout: answer, stderr: '' }).result, 'unknown', JSON.stringify(answer));
  }
  assert.equal(classifyProbe({ status: 1, stdout: 'acolyte-probe-ok', stderr: '' }).result, 'unknown', 'and it needs exit 0');
  assert.equal(classifyProbe({ status: 0, stdout: 'Unknown command: /goal', stderr: '' }).result, 'unknown');
  assert.equal(classifyProbe({ status: 1, stdout: '', stderr: 'Invalid API key' }).result, 'unknown');
  assert.match(classifyProbe({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }).detail, /claude was not found on PATH/);
  assert.match(classifyProbe({ error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), status: null }).detail, /no answer within 60 s/);
});

// A stub `claude` that records how it was run (and its pid) and answers, or sleeps first.
function stubClaude(t, answer, exitCode, sleepMs = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-claude-stub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = path.join(dir, 'record.json');
  const script = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(script, `const fs = require('fs');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid,
  entries: fs.readdirSync(process.cwd()), witness: process.env.ACOLYTE_PROBE_WITNESS || null }));
setTimeout(() => {
  process.stdout.write(${JSON.stringify(answer)} + '\\n');
  process.exitCode = ${exitCode};
}, ${sleepMs});
`);
  let executable;
  if (process.platform === 'win32') {
    executable = path.join(dir, 'claude.cmd');
    fs.writeFileSync(executable, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    executable = path.join(dir, 'claude');
    fs.writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(executable, 0o755);
  }
  return { dir, script, executable, record: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
}

const PROBE_ARGV = ['-p', '/goal reply with the word acolyte-probe-ok and stop', '--tools', '', '--no-session-persistence'];

// The bound arrives as arguments (audit 2026-10-20): an inert goal, no built-in tools, nothing
// saved. `--tools ""` is an empty argument, and survives the cmd.exe launch.
// MUTATION: drop '--tools', '' from PROBE_ARGS and the argv below differs.
test('the probe runs the bounded /goal command once, in an empty directory of its own', async (t) => {
  const f = fixture(t);
  const stub = stubClaude(t, RESTRICTED, 1);
  const options = { home: f.home, env: {}, claudeExecutable: stub.executable };
  const probe = await memoryGuardProbe(options);
  assert.equal(probe.result, 'restricted', probe.detail);
  assert.equal(probe.command, 'claude -p "/goal reply with the word acolyte-probe-ok and stop" --tools "" --no-session-persistence');
  const seen = stub.record();
  assert.deepEqual(seen.argv, PROBE_ARGV);
  assert.deepEqual(seen.entries, [], 'the probe session has no project to act on');
  assert.equal(fs.existsSync(seen.cwd), false, 'and its directory is removed afterwards');
  // One fixed name, because Claude Code keeps a transcript directory per working directory, in
  // the user's own config dir. MUTATION: go back to fs.mkdtempSync and the basename carries a
  // random suffix; go back to os.tmpdir() and the parent is not <home>/.claude/wildcarding.
  assert.equal(fs.realpathSync(path.dirname(seen.cwd)), fs.realpathSync(path.join(f.home, '.claude', 'wildcarding')));
  assert.equal(path.basename(seen.cwd), 'ai-acolyte-memory-guard-probe');
  assert.equal(probe.directory, path.join(f.home, '.claude', 'wildcarding', 'ai-acolyte-memory-guard-probe'));
  fs.mkdirSync(probe.directory);
  await memoryGuardProbe(options);
  assert.equal(stub.record().cwd, seen.cwd, 'an empty leftover of our own is used');
  const accepted = stubClaude(t, 'Goal set: reply with the word acolyte-probe-ok and stop\nacolyte-probe-ok', 0);
  assert.equal((await memoryGuardProbe({ ...options, claudeExecutable: accepted.executable })).result, 'not restricted');
  // An exit 0 that is not an acceptance, through the whole probe: unknown.
  const unknownSkill = stubClaude(t, 'Unknown skill: goal', 0);
  const unknown = await memoryGuardProbe({ ...options, claudeExecutable: unknownSkill.executable });
  assert.equal(unknown.result, 'unknown');
  assert.match(unknown.detail, /neither refused nor accepted \/goal: Unknown skill: goal/);
  assert.equal((await memoryGuardProbe({ ...options, claudeExecutable: path.join(stub.dir, 'missing-claude') })).result, 'unknown');
});

// --strict-mcp-config makes /goal's restriction check answer wrongly: measured at integration
// (2026-10-20, Claude Code 2.1.293, the real home, a policy that sets allowManagedHooksOnly), /goal
// refused with every other probe argument and RAN with it, so the probe read "not restricted"
// while a PreToolUse canary still did not fire. And the answer is only true of the environment
// claude runs in, so the child inherits this process's environment.
// MUTATION: add '--strict-mcp-config' back to PROBE_ARGS and this fails; give the spawn an
// `env: {}` and the witness is missing.
test('the probe never passes --strict-mcp-config, and claude inherits the real environment', async (t) => {
  const f = fixture(t);
  const stub = stubClaude(t, RESTRICTED, 1);
  const saved = process.env.ACOLYTE_PROBE_WITNESS;
  process.env.ACOLYTE_PROBE_WITNESS = 'inherited';
  t.after(() => { if (saved === undefined) delete process.env.ACOLYTE_PROBE_WITNESS; else process.env.ACOLYTE_PROBE_WITNESS = saved; });
  const probe = await memoryGuardProbe({ home: f.home, env: {}, claudeExecutable: stub.executable });
  const seen = stub.record();
  assert.ok(seen.argv.length > 2, `precondition: the stub saw the probe's arguments: ${JSON.stringify(seen.argv)}`);
  assert.equal(seen.argv.includes('--strict-mcp-config'), false, `--strict-mcp-config was passed: ${JSON.stringify(seen.argv)}`);
  assert.doesNotMatch(probe.command, /--strict-mcp-config/);
  assert.equal(seen.witness, 'inherited', 'claude runs with this process\'s environment');
});

// An npm shim in cmd-shim's node form is run as the node script it names, with no cmd.exe, and
// only a shim it cannot read goes through resolvedLaunch.
// MUTATION: call resolvedLaunch alone and npmShimLaunch is never asked.
test('the probe asks npmShimLaunch first, and runs what it returns', async (t) => {
  const f = fixture(t);
  const stub = stubClaude(t, RESTRICTED, 1);
  const execResolve = require('../src/exec-resolve');
  const asked = [];
  t.mock.method(execResolve, 'npmShimLaunch', (name, args) => {
    asked.push({ name, args: [...args] });
    return { file: process.execPath, args: [stub.script, ...args], options: {}, resolved: name };
  });
  const probe = await memoryGuardProbe({ home: f.home, env: {}, claudeExecutable: path.join(stub.dir, 'not-a-real-claude') });
  assert.equal(probe.result, 'restricted', probe.detail);
  assert.deepEqual(asked, [{ name: path.join(stub.dir, 'not-a-real-claude'), args: PROBE_ARGV }]);
  assert.deepEqual(stub.record().argv, PROBE_ARGV);
});

// The deadline ends the whole tree. On Windows the stub is a .cmd, so the process the probe holds
// is cmd.exe and the stub's node is its child: spawnSync's timeout ended cmd.exe and left that
// node running (audit 2026-10-20).
// The stub's node holds the probe's stdio pipes, so while it lives the probe cannot finish: an
// answer well inside the stub's 60 s sleep is the proof that it was ended at the deadline.
// MUTATION: end only the child at the deadline (child.kill() in place of endProcessTree) and on
// Windows the probe waits out the stub's full 60 s.
test('a probe that outlives its deadline is ended with everything it started', async (t) => {
  const f = fixture(t);
  const stub = stubClaude(t, 'too late', 0, 60 * 1000);
  t.after(() => { try { process.kill(stub.record().pid); } catch { /* already gone */ } });
  const started = Date.now();
  const probe = await memoryGuardProbe({ home: f.home, env: {}, claudeExecutable: stub.executable, timeoutMs: 2500 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 30 * 1000, `the probe answered ${elapsed} ms after it started, against a 2.5 s deadline`);
  assert.equal(probe.result, 'unknown');
  assert.match(probe.detail, /claude gave no answer within/);
  const { pid } = stub.record();
  let alive = true;
  for (let i = 0; i < 40 && alive; i += 1) {
    try { process.kill(pid, 0); await new Promise((done) => setTimeout(done, 50)); } catch { alive = false; }
  }
  assert.equal(alive, false, `the stub (pid ${pid}) outlived the probe's deadline`);
});

// 'close' waits for every holder of the child's pipes, and a process outside the tree the deadline
// ends can hold them: here the stand-in claude starts a middle process that starts a detached
// holder with the same stdout and exits, so the holder's parent is gone and taskkill /T (or the
// POSIX child kill) never reaches it. The probe used to settle only on 'close', so it waited out
// the holder's 60 s, and the extension's probingUserHooks and the CLI stayed stuck with it (audit
// of 1.9.1). Run in a driver process, so the test also proves nothing the probe leaves keeps a
// process like the CLI alive.
// MUTATION: drop the grace timer after the deadline and the driver is still running at 25 s;
// drop the pipe destroy and it still is.
test('a probe whose pipes are held past its deadline still answers, and lets its process exit', async (t) => {
  const { setTimeout: wait } = require('node:timers/promises');
  const { spawn } = require('node:child_process');
  const f = fixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-claude-holder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const record = path.join(dir, 'holder.json');
  const holder = path.join(dir, 'holder.js');
  const middle = path.join(dir, 'middle.js');
  const script = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(holder, `require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid }));\n`
    + 'setTimeout(() => {}, 60 * 1000);\n');
  // The middle and the holder stand in the temp directory itself, which nothing here removes:
  // Windows will not remove a directory a process stands in, or has only just left (the
  // probe's directory and this one both failed that way, the second only under full-suite load).
  const standIn = JSON.stringify(os.tmpdir());
  fs.writeFileSync(middle, `const held = require('child_process').spawn(process.execPath, [${JSON.stringify(holder)}],\n`
    + `  { detached: true, cwd: ${standIn}, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });\n`
    + 'held.unref();\n');
  fs.writeFileSync(script, `require('child_process').spawn(process.execPath, [${JSON.stringify(middle)}],\n`
    + `  { cwd: ${standIn}, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });\n`
    + 'setTimeout(() => {}, 60 * 1000);\n');
  let executable;
  if (process.platform === 'win32') {
    executable = path.join(dir, 'claude.cmd');
    fs.writeFileSync(executable, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    executable = path.join(dir, 'claude');
    fs.writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(executable, 0o755);
  }
  const held = () => (fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')).pid : null);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const options = { home: f.home, env: {}, claudeExecutable: executable, timeoutMs: 1500 };
  const driver = spawn(process.execPath, ['-e',
    `require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'memory-guard-install.js'))})`
    + `.memoryGuardProbe(${JSON.stringify(options)}).then((probe) => process.stdout.write(JSON.stringify(probe)));`],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  try {
    let stdout = '';
    driver.stdout.on('data', (chunk) => { stdout += chunk; });
    let exited = false;
    driver.on('exit', () => { exited = true; });
    const started = Date.now();
    for (let i = 0; i < 500 && !exited; i += 1) await wait(50);
    assert.ok(held(), 'precondition: the holder started, and holds the probe\'s stdout');
    const holderAlive = alive(held());
    assert.equal(exited, true, `the probe's process was still running ${Date.now() - started} ms after it started, against a 1.5 s deadline`);
    assert.equal(holderAlive, true, 'WITNESS: the holder was still alive when the probe answered, so close had not come');
    const probe = JSON.parse(stdout);
    assert.equal(probe.result, 'unknown');
    assert.match(probe.detail, /claude gave no answer within/);
  } finally {
    // In the body, not t.after, so the holder is gone before the hooks remove its directory.
    try { driver.kill(); } catch { /* exited */ }
    const pid = held();
    if (pid) {
      try { process.kill(pid); } catch { /* gone */ }
      for (let i = 0; i < 100 && alive(pid); i += 1) await wait(50);
    }
  }
});

// A child that survives the deadline's kill is let go at the grace: its stdin, stdout and stderr
// destroyed and its handle unref'd, as scripts/probe-user-hooks.js's abandon does, so nothing the
// probe holds keeps its process alive. The grace destroyed stdout and stderr only, so on POSIX a
// claude that outlived its SIGTERM kept `wildcard-perms --memory-guard probe` running after it had
// printed (audit of 1.9.2). In a driver process. The stand-in claude is node itself (the driver
// replaces npmShimLaunch) and stands in the temp directory, which nothing here removes. On POSIX
// it ignores SIGTERM and the real tree kill runs; Windows has no kill a process can ignore
// (taskkill /F), so there the driver replaces the tree kill with one that does nothing.
// MUTATION: drop the child.unref() from the grace and the driver is still running at 20 s. (The
// stdin destroy is for parity with the twin: stdin was ended at the start, and dropping it alone
// survived, 26 of 26.)
test('a child that survives the deadline\'s kill does not keep the probe\'s process alive', async (t) => {
  const { setTimeout: wait } = require('node:timers/promises');
  const { spawn } = require('node:child_process');
  const f = fixture(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-claude-survivor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const record = path.join(dir, 'survivor.json');
  const stub = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(stub, `process.chdir(${JSON.stringify(os.tmpdir())});\n`
    + `require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid }));\n`
    + "process.on('SIGTERM', () => {});\nsetTimeout(() => {}, 60 * 1000);\n");
  const src = path.resolve(__dirname, '..', 'src');
  const options = { home: f.home, env: {}, claudeExecutable: 'claude-stand-in', timeoutMs: 1000 };
  const driver = spawn(process.execPath, ['-e', [
    `const execResolve = require(${JSON.stringify(path.join(src, 'exec-resolve.js'))});`,
    `execResolve.npmShimLaunch = (name, args) => ({ file: process.execPath, args: [${JSON.stringify(stub)}, ...args], options: {} });`,
    "if (process.platform === 'win32') execResolve.endProcessTree = () => Promise.resolve();",
    `require(${JSON.stringify(path.join(src, 'memory-guard-install.js'))}).memoryGuardProbe(${JSON.stringify(options)})`,
    '  .then((probe) => {',
    // The witness is taken here, before the driver exits: on Windows a child that is not
    // detached is in the driver's kill-on-close job, and goes with it.
    `    const { pid } = JSON.parse(require('fs').readFileSync(${JSON.stringify(record)}, 'utf8'));`,
    '    let survived = true;',
    '    try { process.kill(pid, 0); } catch { survived = false; }',
    '    process.stdout.write(JSON.stringify({ ...probe, survived }));',
    '  });',
  ].join('\n')], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const survivor = () => (fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')).pid : null);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    let stdout = '';
    let stderr = '';
    driver.stdout.on('data', (chunk) => { stdout += chunk; });
    driver.stderr.on('data', (chunk) => { stderr += chunk; });
    let exited = false;
    driver.on('exit', () => { exited = true; });
    const started = Date.now();
    for (let i = 0; i < 400 && !exited; i += 1) await wait(50);
    assert.ok(survivor(), `precondition: the stand-in claude started. ${stderr}`);
    assert.equal(exited, true, `the probe's process was still running ${Date.now() - started} ms after it started, against a 1 s deadline`);
    const probe = JSON.parse(stdout);
    assert.equal(probe.survived, true, 'WITNESS: the stand-in claude outlived the deadline\'s kill');
    assert.equal(probe.result, 'unknown');
    assert.match(probe.detail, /claude gave no answer within/);
  } finally {
    try { driver.kill(); } catch { /* exited */ }
    const pid = survivor();
    if (pid) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      for (let i = 0; i < 100 && alive(pid); i += 1) await wait(50);
    }
  }
});

// A stand-in claude that answers as a restricted client and leaves the probe's directory hard to
// remove: on Windows a detached process standing in it for `lifeMs`, on POSIX (where a process in a
// directory does not stop its removal) a subdirectory nobody may write to. What it left goes to
// its record, for the cleanup.
function strayClaude(t, lifeMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-claude-stray-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const record = path.join(dir, 'stray.json');
  const script = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(script, `const fs = require('fs');
const path = require('path');
if (process.platform === 'win32') {
  const stray = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${lifeMs})'],
    { cwd: process.cwd(), detached: true, stdio: 'ignore', windowsHide: true });
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: stray.pid }));
  stray.unref();
} else {
  const held = path.join(process.cwd(), 'held');
  fs.mkdirSync(held);
  fs.writeFileSync(path.join(held, 'file'), 'x');
  fs.chmodSync(held, 0o555);
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ held }));
}
process.stdout.write(${JSON.stringify(RESTRICTED)} + '\\n');
process.exitCode = 1;
`);
  let executable;
  if (process.platform === 'win32') {
    executable = path.join(dir, 'claude.cmd');
    fs.writeFileSync(executable, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    executable = path.join(dir, 'claude');
    fs.writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(executable, 0o755);
  }
  const left = () => (fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, 'utf8')) : {});
  const cleanup = async (probeDir) => {
    const { setTimeout: wait } = require('node:timers/promises');
    const { pid, held } = left();
    if (pid) {
      try { process.kill(pid); } catch { /* gone */ }
      for (let i = 0; i < 100; i += 1) { try { process.kill(pid, 0); } catch { break; } await wait(50); }
    }
    if (held && fs.existsSync(held)) fs.chmodSync(held, 0o755);
    // Retried by hand: Windows lets go of a directory a moment after the process in it has gone,
    // and on Node 24 rmSync's own retries gave up on that EPERM at once (measured).
    for (let i = 0; ; i += 1) {
      try { fs.rmSync(probeDir, { recursive: true, force: true }); break; } catch (error) { if (i >= 50) throw error; }
      await wait(100);
    }
  };
  return { executable, left, cleanup };
}

// A directory the probe cannot remove is said, and the answer stays Claude Code's. The removal
// sat in a bare catch, so a stray process left an empty directory that was reused, or a non-empty
// one that was refused, next time, and nothing said why (audit of 1.9.2).
// MUTATION: swallow the removal's failure again (resolve the plain answer on both paths) and the
// detail no longer names the directory.
test('a probe directory that cannot be removed afterwards is named in the detail, and the answer stays', {
  skip: typeof process.getuid === 'function' && process.getuid() === 0 && 'root may write where the stub forbids it',
}, async (t) => {
  const f = fixture(t);
  const stray = strayClaude(t, 60 * 1000);
  const directory = path.join(f.home, '.claude', 'wildcarding', 'ai-acolyte-memory-guard-probe');
  try {
    const probe = await memoryGuardProbe({ home: f.home, env: {}, claudeExecutable: stray.executable });
    assert.ok(stray.left().pid || stray.left().held, 'precondition: the stand-in left something in the directory');
    assert.equal(probe.result, 'restricted', probe.detail);
    assert.ok(probe.detail.startsWith('Claude Code refused /goal because hooks are restricted'), probe.detail);
    assert.match(probe.detail, /The probe's directory, .*ai-acolyte-memory-guard-probe, could not be removed afterwards \((EBUSY|EPERM|ENOTEMPTY|EACCES)\): a process may still be running in it or holding a file there\.$/);
    assert.ok(fs.existsSync(directory), 'precondition: the directory is still there');
  } finally {
    await stray.cleanup(directory);
  }
});

// And a process that leaves within the removal's retries is waited out. Windows only: on POSIX a
// process standing in a directory does not stop its removal.
// MUTATION: drop maxRetries from the removal and the first EBUSY is the answer: the directory
// stays and the detail names it.
test('a stray process that leaves the probe\'s directory soon after is waited out', {
  skip: process.platform !== 'win32' && 'POSIX removes a directory a process stands in',
}, async (t) => {
  const f = fixture(t);
  const stray = strayClaude(t, 300);
  const directory = path.join(f.home, '.claude', 'wildcarding', 'ai-acolyte-memory-guard-probe');
  try {
    const probe = await memoryGuardProbe({ home: f.home, env: {}, claudeExecutable: stray.executable });
    assert.ok(stray.left().pid, 'precondition: the stand-in left a process standing in the directory');
    assert.equal(probe.result, 'restricted', probe.detail);
    assert.doesNotMatch(probe.detail, /could not be removed/);
    assert.equal(fs.existsSync(directory), false, 'the directory was removed once the stray had gone');
  } finally {
    await stray.cleanup(directory);
  }
});

// The fixed directory used to sit in os.tmpdir(), which is /tmp and shared on Linux: another
// user could create it first, holding a .claude/settings.json (or CLAUDE.md, .mcp.json) that
// `claude -p` would load as the victim, and the pre-created directory made rmSync throw,
// uncaught (audit 2026-10-20). An existing directory that is not empty is refused, Claude Code is
// not run, and the planted files are left exactly where they are.
// MUTATION: clear and reuse an existing directory as 1.9.0 did (rmSync then mkdirSync
// recursive) and the stub runs in the planted directory.
test('the probe refuses a directory that already holds files, and does not run claude', async (t) => {
  const f = fixture(t);
  const stub = stubClaude(t, 'Goal set.', 0);
  const dir = path.join(f.home, '.claude', 'wildcarding', 'ai-acolyte-memory-guard-probe');
  const planted = path.join(dir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(planted), { recursive: true });
  fs.writeFileSync(planted, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo planted' }] }] } }));
  const probe = await memoryGuardProbe({ home: f.home, env: {}, claudeExecutable: stub.executable });
  assert.equal(probe.result, 'unknown');
  assert.match(probe.detail, /^The probe did not run: .*ai-acolyte-memory-guard-probe already exists and is not empty, so Claude Code was not run in it\./);
  assert.throws(() => stub.record(), /ENOENT/, 'claude never ran');
  assert.ok(fs.existsSync(planted), 'and nothing of someone else\'s was deleted');
  fs.rmSync(dir, { recursive: true });
  fs.writeFileSync(dir, 'a file, not a directory');
  assert.match((await memoryGuardProbe({ home: f.home, env: {}, claudeExecutable: stub.executable })).detail, /is not a plain directory/);
  assert.throws(() => stub.record(), /ENOENT/);
});
