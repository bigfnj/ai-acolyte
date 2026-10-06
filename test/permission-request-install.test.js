'use strict';

// Installing and removing exactly the PermissionRequest hook entries, against
// temporary homes only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  claudeHookCommand, planClaudeHook, planCodexHook,
  inspectClaudePermissionHook, setClaudePermissionHook,
  inspectCodexPermissionHook, setCodexPermissionHook,
} = require('../src/permission-request-install');
const { setCodexHook } = require('../src/codex-hook-install');

const SCRIPT = path.resolve(__dirname, '../bin/wildcard-perms');

function fixture(t, settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-permission-install-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (settings !== undefined) fs.writeFileSync(settingsPath, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome);
  return { home, settingsPath, codexHome, hooksPath: path.join(codexHome, 'hooks.json') };
}

const ours = (command = claudeHookCommand()) => ({ type: 'command', command, timeout: 10 });

test('the Claude command names this checkout with forward slashes on Windows', () => {
  const windows = claudeHookCommand({ scriptPath: 'C:\\repo\\bin\\wildcard-perms', platform: 'win32' });
  assert.equal(windows, 'node "C:/repo/bin/wildcard-perms" --permission-request claude');
  assert.throws(() => claudeHookCommand({ scriptPath: 'relative/path' }), /absolute path/);
  assert.throws(() => claudeHookCommand({ scriptPath: '/x/"evil' }), /quotes/);
});

test('planning the Claude hook adds one group, keeps foreign hooks and removes only its own handler', () => {
  const foreignHandler = { type: 'command', command: 'someone-else' };
  const settings = { model: 'm', hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'post' }] }],
    PermissionRequest: [{ matcher: '*', hooks: [foreignHandler] }] } };
  const on = planClaudeHook(settings, true);
  assert.equal(on.changed, true);
  assert.deepEqual(on.settings.hooks.PermissionRequest, [{ matcher: '*', hooks: [foreignHandler] },
    { matcher: 'Bash|PowerShell', hooks: [ours()] }]);
  assert.deepEqual(on.settings.hooks.PostToolUse, settings.hooks.PostToolUse);
  assert.equal(planClaudeHook(on.settings, true).changed, false, 'a second install is a no-op');
  const off = planClaudeHook(on.settings, false);
  assert.deepEqual(off.settings, settings, 'removal restores the foreign state exactly');
  // A group shared with a foreign handler keeps the foreign handler.
  const shared = { hooks: { PermissionRequest: [{ matcher: 'Bash|PowerShell', hooks: [foreignHandler, ours()] }] } };
  assert.deepEqual(planClaudeHook(shared, false).settings.hooks.PermissionRequest,
    [{ matcher: 'Bash|PowerShell', hooks: [foreignHandler] }]);
  // Installing into a file with no hooks and removing again leaves no hooks key.
  const bare = { permissions: { allow: ['Bash(ls *)'] } };
  assert.deepEqual(planClaudeHook(planClaudeHook(bare, true).settings, false).settings, bare);
});

test('planning the Claude hook refuses shapes it cannot inspect and definitions it did not write', () => {
  assert.throws(() => planClaudeHook({ hooks: [] }, true), /not an object/);
  assert.throws(() => planClaudeHook({ hooks: { PermissionRequest: {} } }, true), /not an array/);
  assert.throws(() => planClaudeHook({ hooks: { PermissionRequest: [{ hooks: 'x' }] } }, true), /malformed/);
  const moved = ours(claudeHookCommand({ scriptPath: path.resolve('/old/checkout/bin/wildcard-perms') }));
  const settings = { hooks: { PermissionRequest: [{ matcher: 'Bash|PowerShell', hooks: [moved] }] } };
  assert.throws(() => planClaudeHook(settings, true), /different definition/);
  assert.throws(() => planClaudeHook(settings, false), /different definition/);
  const twice = { hooks: { PermissionRequest: [{ matcher: 'Bash', hooks: [ours()] }, { matcher: 'Bash', hooks: [ours()] }] } };
  assert.throws(() => planClaudeHook(twice, false), /ambiguous/);
});

test('installing the Claude hook is idempotent and preserves every other setting', (t) => {
  const original = { model: 'opus', effortLevel: 'high', permissions: { allow: ['Bash(ls *)'], deny: ['Bash(rm -rf /)'] },
    hooks: { PostToolUse: [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node "x/wildcard-perms"' }] }] } };
  const f = fixture(t, original);
  assert.equal(inspectClaudePermissionHook(f).status, 'missing');
  const on = setClaudePermissionHook(true, f);
  assert.equal(on.configured, true);
  assert.equal(on.changed, true);
  const installed = fs.readFileSync(f.settingsPath);
  const again = setClaudePermissionHook(true, f);
  assert.equal(again.changed, false);
  assert.ok(fs.readFileSync(f.settingsPath).equals(installed), 'a repeat install writes nothing');
  const off = setClaudePermissionHook(false, f);
  assert.equal(off.configured, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settingsPath, 'utf8')), original);
  assert.equal(setClaudePermissionHook(false, f).changed, false);
});

test('installing the Claude hook refuses an unreadable settings file without writing', (t) => {
  const f = fixture(t, '{broken');
  assert.equal(inspectClaudePermissionHook(f).status, 'unreadable');
  assert.throws(() => setClaudePermissionHook(true, f), /could not be parsed/);
  assert.equal(fs.readFileSync(f.settingsPath, 'utf8'), '{broken');
});

test('the Claude status names a managed policy that keeps user hooks off this event', (t) => {
  const f = fixture(t, {});
  fs.writeFileSync(path.join(f.home, '.claude', 'remote-settings.json'),
    JSON.stringify({ allowManagedHooksOnly: true, hooks: { PostToolUse: [] } }));
  assert.equal(inspectClaudePermissionHook(f).policy.dropped, true);
  fs.writeFileSync(path.join(f.home, '.claude', 'remote-settings.json'),
    JSON.stringify({ allowManagedHooksOnly: true, hooks: { PostToolUse: [], PermissionRequest: [] } }));
  assert.equal(inspectClaudePermissionHook(f).policy.dropped, false);
});

test('installing the Codex hook backs up prior bytes, keeps the Stop hook and foreign events, and is idempotent', (t) => {
  const f = fixture(t);
  setCodexHook(true, { home: f.home, codexHome: f.codexHome });
  const withStop = fs.readFileSync(f.hooksPath, 'utf8');
  const on = setCodexPermissionHook(true, f);
  assert.equal(on.configured, true);
  assert.equal(on.trust, 'not-verified');
  assert.equal(on.reviewRequired, true);
  assert.equal(fs.readFileSync(on.backupPath, 'utf8'), withStop);
  const installed = fs.readFileSync(f.hooksPath, 'utf8');
  const data = JSON.parse(installed);
  assert.equal(data.hooks.Stop.length, 1, 'the after-turn Stop hook survives');
  assert.equal(data.hooks.PermissionRequest[0].matcher, 'Bash');
  assert.equal(setCodexPermissionHook(true, f).changed, false);
  assert.equal(fs.readFileSync(f.hooksPath, 'utf8'), installed);
  const off = setCodexPermissionHook(false, f);
  assert.equal(off.configured, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.hooksPath, 'utf8')), JSON.parse(withStop));
});

test('the Codex plan refuses malformed files and changed definitions, and keeps CRLF', () => {
  assert.throws(() => planCodexHook('{broken', true), /cannot parse/);
  assert.throws(() => planCodexHook('{"hooks":[]}', true), /object/);
  const installed = planCodexHook(null, true).text;
  const edited = JSON.parse(installed);
  edited.hooks.PermissionRequest[0].hooks[0].timeout = 99;
  assert.throws(() => planCodexHook(JSON.stringify(edited), false), /different definition/);
  const crlf = planCodexHook('{\r\n  "x": 1\r\n}\r\n', true).text;
  assert.ok(crlf.includes('\r\n') && !/[^\r]\n/.test(crlf));
});

test('installing the Codex hook refuses a concurrent replacement without overwriting it', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.hooksPath, '{"hooks":{}}\n');
  const concurrent = '{"hooks":{},"concurrent":"keep"}\n';
  assert.throws(() => setCodexPermissionHook(true, { ...f, beforeWrite(file) { fs.writeFileSync(file, concurrent); } }),
    /changed during configuration/);
  assert.equal(fs.readFileSync(f.hooksPath, 'utf8'), concurrent);
  assert.equal(inspectCodexPermissionHook(f).configured, false);
});

test('CLI install and removal touch only the temporary profile and say what each product needs', (t) => {
  const f = fixture(t, { model: 'm' });
  const env = { ...process.env, HOME: f.home, USERPROFILE: f.home, CODEX_HOME: f.codexHome };
  const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', windowsHide: true, env, cwd: f.home });
  const on = run(['--permission-hook', 'on']);
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /\[claude\]: ON/);
  assert.match(on.stdout, /\[codex\]: ON/);
  assert.match(on.stdout, /run \/hooks/);
  assert.match(on.stdout, /mode: observe/);
  assert.equal(JSON.parse(fs.readFileSync(f.settingsPath, 'utf8')).hooks.PermissionRequest.length, 1);
  const status = run(['--permission-hook', 'status', '--product', 'codex']);
  assert.match(status.stdout, /\[codex\]: ON/);
  assert.doesNotMatch(status.stdout, /\[claude\]/);
  const off = run(['--permission-hook', 'off']);
  assert.equal(off.status, 0, off.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settingsPath, 'utf8')), { model: 'm' });
  assert.equal(run(['--permission-hook', 'on', '--product', 'neither']).status, 2);
  assert.equal(run(['--permission-hook', 'bogus']).status, 2);
});
