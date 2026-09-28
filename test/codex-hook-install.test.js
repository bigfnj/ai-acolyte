'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inspectCodexHook, setCodexHook } = require('../src/codex-hook-install');
const { createPolicyLock } = require('../src/policy-lock');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-hook-install-'));
  const codexHome = path.join(home, 'selected-profile');
  fs.mkdirSync(codexHome);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, codexHome, file: path.join(codexHome, 'hooks.json') };
}

test('hook install status is read-only, selects custom home, and never claims trust', (t) => {
  const f = fixture(t);
  const before = fs.readdirSync(f.codexHome);
  const status = inspectCodexHook(f);
  assert.equal(status.path, f.file);
  assert.equal(status.status, 'missing');
  assert.equal(status.trust, 'not-verified');
  assert.deepEqual(fs.readdirSync(f.codexHome), before);
  const installed = setCodexHook(true, f);
  assert.equal(installed.configured, true);
  assert.equal(installed.reviewRequired, true);
  assert.equal(installed.trust, 'not-verified');
  assert.equal(fs.existsSync(path.join(f.home, '.codex')), false);
  assert.deepEqual(fs.readdirSync(f.codexHome), ['hooks.json']);
});

test('hook install backs up exact prior bytes, preserves other events and removes only its handler', (t) => {
  const f = fixture(t);
  const foreign = { hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'foreign' }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: 'start' }] }] }, custom: 'sentinel' };
  const prior = JSON.stringify(foreign, null, 4) + '\r\n';
  fs.writeFileSync(f.file, prior);
  const on = setCodexHook(true, f);
  assert.equal(fs.readFileSync(on.backupPath, 'utf8'), prior);
  const installedBytes = fs.readFileSync(f.file, 'utf8');
  const repeat = setCodexHook(true, f);
  assert.equal(repeat.changed, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), installedBytes);
  assert.equal(fs.readFileSync(on.backupPath, 'utf8'), prior, 'no-op keeps pre-change backup');
  const off = setCodexHook(false, f);
  assert.equal(fs.readFileSync(off.backupPath, 'utf8'), installedBytes);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), foreign);
});

test('hook install rejects a concurrent replacement without overwriting it', (t) => {
  const f = fixture(t);
  const concurrent = '{"hooks":{},"concurrent":"keep"}\n';
  assert.throws(() => setCodexHook(true, { ...f, beforeWrite(file) { fs.writeFileSync(file, concurrent); } }),
    /changed during configuration/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), concurrent);
});

test('hook install rejects unreadable or malformed config and changed definitions', (t) => {
  const f = fixture(t);
  // Invalid UTF-8 inside an otherwise valid JSON string must not be silently
  // replaced by U+FFFD and then rewritten as if it were the original content.
  for (const bytes of [Buffer.from('{broken'), Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])]) {
    fs.writeFileSync(f.file, bytes);
    assert.equal(inspectCodexHook(f).writable, false);
    assert.throws(() => setCodexHook(true, f));
    assert.ok(fs.readFileSync(f.file).equals(bytes));
  }
  fs.unlinkSync(f.file);
  setCodexHook(true, f);
  const modified = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  modified.hooks.Stop[0].hooks[0].command = 'owner edited';
  const bytes = JSON.stringify(modified);
  fs.writeFileSync(f.file, bytes);
  assert.equal(inspectCodexHook(f).status, 'changed-definition');
  assert.throws(() => setCodexHook(false, f), /definition changed/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), bytes);
});

test('hook install participates in the profile-local lock', (t) => {
  const f = fixture(t);
  createPolicyLock({ lockPath: `${f.file}.ai-acolyte.lock` }).locked(() => {
    assert.throws(() => setCodexHook(true, f), { code: 'AUTO_LEARN_LOCKED' });
    assert.equal(fs.existsSync(f.file), false);
  });
  assert.equal(setCodexHook(true, f).configured, true);
});

test('CLI configures selected Codex hook without touching Claude or claiming activation', (t) => {
  const f = fixture(t);
  const claude = path.join(f.home, '.claude');
  fs.mkdirSync(claude);
  const settings = path.join(claude, 'settings.json');
  fs.writeFileSync(settings, '{"permissions":{"allow":["Bash(git status --short)"]}}');
  const original = fs.readFileSync(settings);
  const cli = path.resolve(__dirname, '../bin/wildcard-perms');
  const run = (args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: f.home, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, HOME: f.home, USERPROFILE: f.home, CODEX_HOME: f.codexHome },
  });
  const on = run(['--codex-hook', 'on']);
  assert.equal(on.status, 0, on.stderr);
  const status = JSON.parse(on.stdout);
  assert.equal(status.path, f.file);
  assert.equal(status.configured, true);
  assert.equal(status.trust, 'not-verified');
  assert.match(status.message, /Review this exact hook in Codex/);
  assert.ok(fs.readFileSync(settings).equals(original));
  const before = fs.readFileSync(f.file);
  assert.equal(run(['--codex-hook', 'typo']).status, 2);
  assert.ok(fs.readFileSync(f.file).equals(before));
  const off = run(['--codex-hook', 'off']);
  assert.equal(off.status, 0, off.stderr);
  assert.equal(JSON.parse(off.stdout).configured, false);
  assert.ok(fs.readFileSync(settings).equals(original));
});
