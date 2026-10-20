'use strict';

// `wildcard-perms --memory-guard on|off|status|probe`, through the real CLI against a throwaway
// home. The install logic is covered in memory-guard-install.test.js; what is tested here is
// what only argv can get wrong. A verb listed in VERBS with no dispatch branch falls through to
// HOOK MODE, which rewrites settings.json, so every run below carries a real hook event on stdin
// and an allow list hook mode would rewrite, and asserts the bytes afterwards.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', 'bin', 'wildcard-perms');
// Not a fixed point: hook mode collapses the two `rg` entries (test/cli-hook.test.js).
const UNOPTIMIZED = { permissions: { allow: ['Bash(git status)', 'Bash(git diff)', 'Bash(rg foo)', 'Bash(rg bar)'] } };

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-cli-memory-guard-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(UNOPTIMIZED, null, 2) + '\n');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function run(home, args, extraEnv = {}) {
  const root = path.parse(home).root;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: home, encoding: 'utf8', windowsHide: true,
    input: JSON.stringify({ cwd: home, tool_name: 'Bash' }),
    env: {
      ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'),
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1), ...extraEnv,
    },
  });
}

const settingsText = (home) => fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
const script = (home) => path.join(home, '.claude', 'wildcarding', 'memory-index-guard.js');

// MUTATION: delete the `--memory-guard` dispatch branch in bin/wildcard-perms (leaving it in
// VERBS) and status falls into hook mode: it exits 0 having rewritten the allow list.
test('--memory-guard status dispatches to the verb and never reaches hook mode', (t) => {
  const home = tempHome(t);
  const before = settingsText(home);
  const status = run(home, ['--memory-guard', 'status']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /^wildcard-perms memory-guard: OFF - ~[\\/]\.claude[\\/]settings\.json\n/);
  assert.match(status.stdout, /\n {2}policy: /, 'the policy line is said on every status');
  assert.equal(settingsText(home), before, 'byte-identical: hook mode would have collapsed the rg entries');
  const bare = run(home, ['--memory-guard']);
  assert.equal(bare.status, 0, 'no sub-verb means status');
  assert.match(bare.stdout, /memory-guard: OFF/);
  assert.equal(settingsText(home), before);
});

test('--memory-guard on installs, repeats as already, and off removes only the guard', (t) => {
  const home = tempHome(t);
  const before = settingsText(home);
  const on = run(home, ['--memory-guard', 'on']);
  assert.equal(on.status, 0, on.stderr);
  assert.match(on.stdout, /^wildcard-perms memory-guard: ON - /);
  assert.match(on.stdout, /Applies to Claude Code sessions started from now on\./);
  assert.match(on.stdout, /backup: ~[\\/]\.claude[\\/]backups[\\/]settings\.json\.pre-memory-guard/);
  const data = JSON.parse(settingsText(home));
  assert.deepEqual(data.permissions, UNOPTIMIZED.permissions, 'the allow list rode through untouched');
  assert.equal(data.hooks.PreToolUse.length, 1);
  assert.ok(fs.existsSync(script(home)));
  const node = /^"([^"]+)"/.exec(data.hooks.PreToolUse[0].hooks[0].command)[1];
  assert.ok(path.isAbsolute(node) && fs.existsSync(node), `the hook names a node that exists: ${node}`);

  const again = run(home, ['--memory-guard', 'on']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^wildcard-perms memory-guard: ON \(already\)/);
  const status = run(home, ['--memory-guard', 'status']);
  assert.match(status.stdout, /\n {2}hook: {3}PreToolUse Write\|Edit\|MultiEdit, node /);
  const { GUARD_REVISION } = require('../src/memory-index-guard');
  assert.ok(status.stdout.includes(`memory-index-guard.js, revision ${GUARD_REVISION} (this build ships ${GUARD_REVISION})`), status.stdout);
  assert.match(status.stdout, /\n {2}copy: {3}~[\\/]\.claude[\\/]wildcarding[\\/]memory-index-guard\.js, revision \d+ /);

  const off = run(home, ['--memory-guard', 'off']);
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /^wildcard-perms memory-guard: OFF - /);
  assert.equal(settingsText(home), before, 'off restores the file byte for byte');
});

test('a bad sub-verb or an extra argument is a usage error that writes nothing', (t) => {
  const home = tempHome(t);
  const before = settingsText(home);
  for (const args of [['--memory-guard', 'bogus'], ['--memory-guard', 'on', 'now'], ['--memory-guard', 'on', '--verbose']]) {
    const bad = run(home, args);
    assert.equal(bad.status, 1, `${args.join(' ')}: ${bad.stdout}`);
    assert.equal(bad.stderr, 'usage: wildcard-perms --memory-guard on|off|status|probe\n');
    assert.equal(settingsText(home), before, `${args.join(' ')} wrote settings.json`);
    assert.equal(fs.existsSync(script(home)), false);
  }
});

test('--help lists the verb', (t) => {
  const help = run(tempHome(t), ['--help']);
  assert.match(help.stdout, /^usage: wildcard-perms --memory-guard on\|off\|status\|probe$/m);
});

test('a refusal is reported on stderr with exit 1', (t) => {
  const home = tempHome(t);
  const foreign = { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node /x/memory-index-guard.js' }] }] } };
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(foreign));
  const on = run(home, ['--memory-guard', 'on']);
  assert.equal(on.status, 1);
  assert.match(on.stderr, /^wildcard-perms --memory-guard on: refusing to add the MEMORY\.md guard/);
  assert.equal(settingsText(home), JSON.stringify(foreign));
  const status = run(home, ['--memory-guard', 'status']);
  assert.equal(status.status, 0);
  assert.match(status.stdout, /memory-guard: FOREIGN/);
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{ "half": ');
  const unreadable = run(home, ['--memory-guard', 'status']);
  assert.equal(unreadable.status, 1, 'a status that cannot read settings.json says so in the exit code');
});

// The probe, against a stub `claude` first on PATH that answers the way a restricted machine does.
test('--memory-guard probe runs the stub claude and reports what it said', (t) => {
  const home = tempHome(t);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const stub = path.join(bin, 'claude-stub.js');
  fs.writeFileSync(stub, 'process.stdout.write("/goal can\'t run while hooks are restricted (disableAllHooks or '
    + 'allowManagedHooksOnly is set in settings or by policy)\\n"); process.exitCode = 1;\n');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'claude.cmd'), `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`);
    fs.chmodSync(path.join(bin, 'claude'), 0o755);
  }
  const PATH = [bin, process.env.PATH || process.env.Path || ''].join(path.delimiter);
  const probe = run(home, ['--memory-guard', 'probe'], { PATH, Path: PATH });
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /^wildcard-perms memory-guard probe: restricted\. Claude Code refused \/goal/);
  assert.match(probe.stdout, /reads Claude Code's own message text/);
  fs.writeFileSync(stub, 'process.stdout.write("Invalid API key\\n"); process.exitCode = 1;\n');
  const unknown = run(home, ['--memory-guard', 'probe'], { PATH, Path: PATH });
  assert.equal(unknown.status, 1, 'an answer it cannot read is unknown, and exits 1');
  assert.match(unknown.stdout, /probe: unknown\./);
});
