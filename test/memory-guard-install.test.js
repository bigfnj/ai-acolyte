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
  assert.equal(status.label, 'on (copy outdated)', 'a registered hook with no copy reads as outdated');
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
  assert.equal(classifyProbe({ status: 0, stdout: 'Goal set: probe', stderr: '' }).result, 'not restricted');
  assert.equal(classifyProbe({ status: 0, stdout: 'Unknown command: /goal', stderr: '' }).result, 'unknown');
  assert.equal(classifyProbe({ status: 1, stdout: '', stderr: 'Invalid API key' }).result, 'unknown');
  assert.match(classifyProbe({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }).detail, /claude was not found on PATH/);
  assert.match(classifyProbe({ error: Object.assign(new Error('x'), { code: 'ETIMEDOUT' }), status: null }).detail, /no answer within 60 s/);
});

// A stub `claude` that records how it was run and answers with the refusal.
function stubClaude(t, answer, exitCode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-claude-stub-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = path.join(dir, 'record.json');
  const script = path.join(dir, 'claude-stub.js');
  fs.writeFileSync(script, `const fs = require('fs');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(),
  entries: fs.readdirSync(process.cwd()) }));
process.stdout.write(${JSON.stringify(answer)} + '\\n');
process.exitCode = ${exitCode};
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
  return { dir, executable, record: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
}

test('the probe runs claude -p "/goal probe" once, in an empty temporary directory', (t) => {
  const stub = stubClaude(t, RESTRICTED, 1);
  const probe = memoryGuardProbe({ claudeExecutable: stub.executable });
  assert.equal(probe.result, 'restricted', probe.detail);
  assert.equal(probe.command, 'claude -p "/goal probe"');
  const seen = stub.record();
  assert.deepEqual(seen.argv, ['-p', '/goal probe']);
  assert.deepEqual(seen.entries, [], 'the probe session has no project to act on');
  assert.equal(fs.existsSync(seen.cwd), false, 'and its directory is removed afterwards');
  // One fixed name, because Claude Code keeps a transcript directory per working directory.
  // MUTATION: go back to fs.mkdtempSync and the basename carries a random suffix.
  assert.equal(path.basename(seen.cwd), 'ai-acolyte-memory-guard-probe');
  fs.mkdirSync(seen.cwd);
  fs.writeFileSync(path.join(seen.cwd, 'left-over.txt'), 'from an earlier probe');
  memoryGuardProbe({ claudeExecutable: stub.executable });
  assert.deepEqual(stub.record().entries, [], 'a leftover from an earlier probe is cleared first');
  const accepted = stubClaude(t, 'Goal set.', 0);
  assert.equal(memoryGuardProbe({ claudeExecutable: accepted.executable }).result, 'not restricted');
  assert.equal(memoryGuardProbe({ claudeExecutable: path.join(stub.dir, 'missing-claude') }).result, 'unknown');
});
