'use strict';

// The installers had no test of any kind — not here, not in verify-release.ps1,
// not in CI — and they are the highest-blast-radius files in the repo: they are
// the only writers of settings.json that take no lock, are not atomic, and had
// no backup. Both of them replaced the user's entire policy with nothing but
// their own hook entry, from a single unreadable read:
//
//   install.sh    `try { cfg = JSON.parse(...) } catch {}` then write cfg
//   install.ps1   `ConvertFrom-Json -AsHashtable`, which is PowerShell 6+ ONLY.
//                 Under Windows PowerShell 5.1 — the shell README names for it —
//                 it threw, the catch only warned, and $cfg stayed empty.
//
// Reproduced on 5.1.26100.7019 against a settings.json holding model,
// effortLevel, env, permissions.allow, permissions.deny and a third-party
// SessionStart hook: all six gone, exit code 0, "[OK]" printed.
//
// install.sh's embedded ES module is driven for real below. install.ps1 cannot
// be, on a POSIX CI runner, so it gets static guards against the exact two
// mistakes instead — which is worth more than nothing and runs everywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');

const HEALTHY = JSON.stringify({
  model: 'claude-opus-5',
  effortLevel: 'high',
  env: { FOO: 'bar' },
  permissions: {
    allow: ['Bash(git status *)', 'Bash(rg *)', 'Read(*)'],
    deny: ['Bash(rm -rf /*)'],
  },
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'other-tool' }] }],
  },
}, null, 2) + '\n';

// The ES module install.sh feeds to `node --input-type=module` on stdin. Taken
// from the real file so the test cannot drift from what ships.
function embeddedModule() {
  const sh = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
  const start = sh.indexOf("node --input-type=module <<'EOF'");
  assert.notEqual(start, -1, 'the heredoc that carries the installer logic moved');
  const bodyStart = sh.indexOf('\n', start) + 1;
  const end = sh.indexOf('\nEOF', bodyStart);
  assert.notEqual(end, -1, 'unterminated heredoc');
  return sh.slice(bodyStart, end);
}

// The hook command handed to install.sh's embedded module. Named, not inlined,
// so `what came out is exactly what went in` can be an EXACT-EQUALITY assertion
// below rather than a shape guess with a false-reject surface.
const HOOK_CMD = '/repo/bin/wildcard-perms';

// PowerShell source with its comments removed, for the static .ps1 guards below.
// BOTH comment forms: `<# ... #>` blocks go first, because their interior lines
// do not start with `#` and a line-only filter sails straight past them. Two
// earlier versions of the -AsHashtable guard failed on their own explanatory
// prose — once on a line comment, once on a block comment.
const psCodeOnly = (body) => body
  .replace(/<#[\s\S]*?#>/g, ' ')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

// The body of the `catch { ... }` block that contains `needle`, or null if no
// such block exists. Brace-matched rather than regexed, so what comes back is
// the branch itself and an assertion on it cannot be answered by a line
// somewhere else in the file. Feed it psCodeOnly() output: a comment mentioning
// the branch must not count as the branch.
//
// Deliberately not a PowerShell parser. It assumes the block contains no brace
// inside a string or subexpression, which holds for both installers' refusal
// branches (two Write-Host lines and an exit); a future branch that broke the
// assumption would truncate the body and fail LOUDLY here rather than pass.
function catchBlockContaining(code, needle) {
  const at = code.indexOf(needle);
  if (at === -1) return null;
  const keyword = code.lastIndexOf('catch', at);
  if (keyword === -1) return null;
  const open = code.indexOf('{', keyword);
  if (open === -1 || open > at) return null;
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return i > at ? code.slice(open + 1, i) : null;
    }
  }
  return null;
}

// Returns { code, stdout, stderr, after } — `after` being the bytes on disk.
function runInstaller(settingsPath, source, hookCmd = HOOK_CMD, extraEnv = {}) {
  let code = 0;
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, SETTINGS: settingsPath, HOOK_CMD: hookCmd, HOOK_VIA_NODE: '', ...extraEnv },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    code = typeof error.status === 'number' ? error.status : 1;
    stdout = error.stdout || '';
    stderr = error.stderr || '';
  }
  const after = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null;
  return { code, stdout, stderr, after };
}

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-installer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return path.join(dir, '.claude', 'settings.json');
}

test('the installer keeps every key it found', (t) => {
  const settingsPath = sandbox(t);
  fs.writeFileSync(settingsPath, HEALTHY);

  const run = runInstaller(settingsPath, embeddedModule());
  assert.equal(run.code, 0, run.stderr);

  const after = JSON.parse(run.after);
  // Named individually rather than deep-equalling the whole object, so a
  // failure says WHICH key the installer ate.
  assert.equal(after.model, 'claude-opus-5');
  assert.equal(after.effortLevel, 'high');
  assert.deepEqual(after.env, { FOO: 'bar' });
  assert.equal(after.permissions.allow.length, 3, 'the allow list is the whole point of the tool');
  assert.equal(after.permissions.deny.length, 1, 'deny is what a user cannot afford to lose silently');
  assert.ok(after.hooks.SessionStart, "a co-located third-party hook is not ours to delete");
  assert.equal(after.hooks.PostToolUse.length, 1, 'and ours was actually added');
});

test('an unparseable settings.json is refused, not written over', (t) => {
  const settingsPath = sandbox(t);
  // Truncated mid-array: exactly what a reader sees inside somebody else's
  // non-atomic write, which is routine here — Claude Code rewrites this file
  // on every /model, /effort and approval.
  const broken = '{ "model": "x", "permissions": { "allow": [ ';
  fs.writeFileSync(settingsPath, broken);

  const run = runInstaller(settingsPath, embeddedModule());

  assert.notEqual(run.code, 0, 'a refusal has to be visible in the exit code');
  assert.equal(run.after, broken, 'the bytes are untouched, so the file stays recoverable');
  assert.match(run.stderr, /left untouched/);
});

test('a zero-byte settings.json is refused too', (t) => {
  const settingsPath = sandbox(t);
  // Not the same as absent. This is the window between truncate and write.
  fs.writeFileSync(settingsPath, '');

  const run = runInstaller(settingsPath, embeddedModule());

  assert.notEqual(run.code, 0);
  assert.equal(run.after, '', 'still empty — we did not decide it meant "no config yet"');
  assert.match(run.stderr, /present but empty/);
});

test('a JSON file that is not an object is refused', (t) => {
  const settingsPath = sandbox(t);
  // Parses fine, so the SyntaxError guard does not fire; `cfg.hooks ??= {}` on
  // an array would then write an array with a `hooks` property.
  fs.writeFileSync(settingsPath, '[1, 2, 3]');

  const run = runInstaller(settingsPath, embeddedModule());

  assert.notEqual(run.code, 0);
  assert.equal(run.after, '[1, 2, 3]');
  assert.match(run.stderr, /does not contain a JSON object/);
});

test('an absent settings.json is created, because that is the legitimate case', (t) => {
  const settingsPath = sandbox(t);
  assert.equal(fs.existsSync(settingsPath), false);

  const run = runInstaller(settingsPath, embeddedModule());

  assert.equal(run.code, 0, run.stderr);
  const after = JSON.parse(run.after);
  assert.equal(after.hooks.PostToolUse.length, 1);
  assert.equal(fs.existsSync(settingsPath + '.pre-install-backup'), false,
    'nothing existed, so there is nothing to back up');
});

test('the pre-write backup holds the bytes as found, not the config being written', (t) => {
  const settingsPath = sandbox(t);
  fs.writeFileSync(settingsPath, HEALTHY);

  const run = runInstaller(settingsPath, embeddedModule());
  assert.equal(run.code, 0, run.stderr);

  const backup = fs.readFileSync(settingsPath + '.pre-install-backup', 'utf8');
  // The easy mistake is to serialise `cfg` — which by then already has the new
  // hook pushed into it, making the "backup" a copy of the new state.
  assert.equal(backup, HEALTHY, 'byte-identical to what was there before');
  assert.ok(!backup.includes('PostToolUse'), 'so it is a way back, not a duplicate');
});

test('running twice does not register the hook twice', (t) => {
  const settingsPath = sandbox(t);
  fs.writeFileSync(settingsPath, HEALTHY);

  const source = embeddedModule();
  assert.equal(runInstaller(settingsPath, source).code, 0);
  const second = runInstaller(settingsPath, source);

  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.after).hooks.PostToolUse.length, 1);
  assert.match(second.stdout, /already registered/);
});

test('install.sh registers the hook command bare, with no shell wrapper', (t) => {
  // Nothing asserted the LAUNCHER of the registered command until now, on any of
  // the three registrars. Two reasons it matters, weaker one first:
  //
  //   perf  — a wrapper is paid on EVERY tool call. Measured: `cmd /c node ...`
  //           +17.6 ms, `powershell.exe -Command node ...` +1059 ms, which is 18x
  //           the whole hook.
  //   undo  — both uninstallers recover the hook path by unwrapping
  //           `^node\s+(.+)$` (uninstall.ps1:30#match, uninstall.sh:65#wrapped) and otherwise
  //           compare the command verbatim against the bare path. A wrapped
  //           registration matches NEITHER branch, so it is never recognised as
  //           ours: the hook becomes UN-UNINSTALLABLE, `./uninstall.sh` reports
  //           "nothing removed", and the hook keeps firing. That is the durable
  //           reason — it is a correctness bug, not a slow path.
  //
  // Honest limit: this pins the SPELLING, not the resolved executable. A bare
  // `node` that resolves to a node.cmd/node.bat shim (nvm-windows, Volta) still
  // routes through cmd.exe and pays the ~17.6 ms behind a string this test
  // accepts. Catching that would need a runtime probe, not a string check.
  const settingsPath = sandbox(t);
  fs.writeFileSync(settingsPath, HEALTHY);

  // Non-degeneracy first: an identity assertion proves nothing if the input was
  // itself already wrapped, so pin the fixture to a single bare token.
  assert.equal(HOOK_CMD.trim().split(/\s+/).length, 1,
    'the fixture must be an unwrapped command for the equality below to mean anything');

  const run = runInstaller(settingsPath, embeddedModule());
  assert.equal(run.code, 0, run.stderr);

  // Exact equality, because runInstaller supplies HOOK_CMD itself: whatever
  // install.sh registers must be that string and nothing else. No shape to guess,
  // so no false-reject surface at all.
  //
  // And note what the POSIX shape IS — the bare path, with NO `node` prefix. The
  // shebang plus the `chmod +x` at install.sh:8#chmod carries it, and README.md documents
  // the two spellings the two installers use. A repo-wide `^node ` requirement
  // would reject this perfectly correct registration, which is why the predicate
  // for each registrar is kept separate.
  const registered = JSON.parse(run.after).hooks.PostToolUse[0].hooks[0].command;
  assert.equal(registered, HOOK_CMD,
    'install.sh must register the hook command unwrapped; a launcher prefix breaks '
    + "both uninstallers' `^node\\s+(.+)$` parse and makes the hook un-uninstallable");
});

test('install.sh creates ~/.claude, as install.ps1 already did', () => {
  const sh = fs.readFileSync(path.join(repoRoot, 'install.sh'), 'utf8');
  // Without this, a fresh POSIX machine got ENOENT on the write and `set -e`
  // aborted before the starter-pack prompt. Windows had the mkdir; POSIX did not.
  assert.match(sh, /mkdir -p "\$\(dirname "\$SETTINGS"\)"/,
    'the parent directory must be created before the settings write');
});

test('no PowerShell script uses a PowerShell 7-only JSON parameter', () => {
  // -AsHashtable does not exist in Windows PowerShell 5.1, and the failure is
  // not a syntax error: both scripts parse clean under 5.1 and then eat the
  // config at run time. README.md names `.\install.ps1  # Windows PowerShell`
  // with no version requirement, so 5.1 is a supported shell and this parameter
  // is banned. If it is ever needed, add `#Requires -Version 6` first.
  // Comments are stripped before the check (see psCodeOnly). The ban is on
  // CALLING it; explaining why it is banned, next to the replacement, is the
  // whole point of the fix.

  // Repo root AND scripts/. The scan used to be root-only, which left a hole the
  // moment a .ps1 landed anywhere else — scripts/verify-installers.ps1 now does,
  // and it is precisely a file about this parameter.
  const dirs = [repoRoot, path.join(repoRoot, 'scripts')];
  const scripts = dirs.flatMap((dir) => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((name) => name.endsWith('.ps1'))
    .map((name) => [path.relative(repoRoot, path.join(dir, name)),
      fs.readFileSync(path.join(dir, name), 'utf8')]));
  assert.ok(scripts.length >= 4,
    `expected both installers plus the scripts/ pair, found ${scripts.length}: ${scripts.map(([n]) => n).join(', ')}`);

  for (const [name, body] of scripts) {
    if (/#Requires\s+-Version\s+[6-9]/i.test(body)) continue;
    assert.ok(!/-AsHashtable/.test(psCodeOnly(body)),
      `${name} uses -AsHashtable, which throws on Windows PowerShell 5.1`);
  }
});

test('both PowerShell installers fail closed on an unreadable settings.json', () => {
  // The behavioural version of this is scripts/verify-installers.ps1, which
  // drives both installers as children under powershell.exe and is run by the
  // `installers` job in .github/workflows/test.yml and by
  // scripts/verify-release.ps1. This is the part that can run on a POSIX runner:
  // it pins the refusal, not the wording of the message.
  //
  // (That cross-reference was a promise before it was a fact — it named
  // verify-release.ps1 while verify-release.ps1 contained no installer check at
  // all. Both halves exist now.)
  //
  // Anchored to the BRANCH, never searched for as a substring over the whole
  // file. Three unanchored regexes used to stand here and none of them could
  // fail: delete `exit 1` from both parse-failure branches and every one stayed
  // satisfied by some other line — install.ps1 has two more `exit 1`s and
  // uninstall.ps1 one — leaving warn-then-write, which is the exact shape that
  // ate a settings.json. Worse, uninstall.ps1's `could not be parsed` probe was
  // answered by a COMMENT (uninstall.ps1:46#parsed, the -AsHashtable post-mortem), so
  // it survived deleting the live branch outright. Comments are stripped first,
  // like the -AsHashtable guard above.
  for (const name of ['install.ps1', 'uninstall.ps1']) {
    const code = psCodeOnly(fs.readFileSync(path.join(repoRoot, name), 'utf8'));
    const branch = catchBlockContaining(code, 'could not be parsed');
    assert.ok(branch,
      `${name} has no live catch block that reports an unparseable file; `
      + 'a comment saying so is not a refusal');
    assert.match(branch, /left untouched/,
      `${name}'s parse-failure branch must say it changed nothing`);
    // A warning followed by a write is precisely the shape that caused the loss,
    // so the exit has to be INSIDE this branch — a matching one elsewhere in the
    // file lets execution fall through to the write.
    assert.match(branch, /^\s*exit\s+1\s*$/m,
      `${name}'s parse-failure branch must exit non-zero rather than continue `
      + 'with an empty config');
  }
});

test('install.ps1 builds a bare `node` hook command, not a shell-wrapped one', () => {
  // The behavioural twin is the `install: registers a bare node command` case in
  // scripts/verify-installers.ps1, which reads the string install.ps1 really
  // wrote. That harness exits 0 on non-Windows, so on the POSIX `node --test` CI
  // leg it asserts nothing at all — hence this static guard, in the style of the
  // two above.
  //
  // Banned: `cmd /c node ...` (+17.6 ms per tool call) and
  // `powershell.exe -Command node ...` (+1059 ms, 18x the whole hook). The
  // stronger reason is undo, not speed: both uninstallers recover the hook path
  // with `^node\s+(.+)$` (uninstall.ps1:30#match, uninstall.sh:65#wrapped), a wrapped command
  // matches neither that nor the bare-path comparison, and the hook would become
  // UN-UNINSTALLABLE while still firing on every tool call.
  //
  // Honest limit: SPELLING, not the resolved executable — a bare `node` that
  // resolves to a node.cmd/node.bat shim (nvm-windows, Volta) still routes
  // through cmd.exe and reintroduces the ~17.6 ms. That needs a runtime probe.
  const body = psCodeOnly(fs.readFileSync(path.join(repoRoot, 'install.ps1'), 'utf8'));

  // EVERY assignment, not the first. The old guard used `.exec`, which stops at
  // the first match, so `$hookCommand = 'cmd /c ' + $hookCommand` written
  // anywhere below the real one sailed through — and it is the natural way
  // someone would add a wrapper.
  //
  // Anchored at the ASSIGNMENT, never searched for as a substring. install.ps1
  // also contains `node "$hookCmd" --seed` — an interactive seed invocation with
  // an un-normalized backslash path, NOT a registered string — and a naive grep
  // cannot tell the two apart. Comments are stripped for the same reason: the
  // lines above the assignment quote `node "<path>"` in prose. `+=` is matched
  // too, so an append cannot hide from a guard that only knows about `=`.
  const assignments = [...body.matchAll(/^[^\S\n]*\$hookCommand\b\s*(\+?=)([^\r\n]*)/gm)];
  assert.equal(assignments.length, 1,
    `install.ps1 assigns $hookCommand ${assignments.length} times; this guard reasons `
    + 'about one definition, and a second one is how a wrapper gets added without '
    + `touching the first: ${JSON.stringify(assignments.map((m) => m[0].trim()))}`);
  assert.equal(assignments[0][1], '=',
    'an append to $hookCommand is a wrapper by another name');

  // The WHOLE right-hand side, parsed rather than sampled. The old guard read the
  // first token of the first single-quoted literal, which is blind to everything
  // after that literal: `'node "' + $p + '" & powershell -c evil'` and
  // `'node "' + $p + '" | cmd /c more'` both begin with `node` and both register
  // a shell wrapper.
  //
  // Grammar accepted: single-quoted literals and bare `$variable` references
  // joined by `+`. Anything else — a subexpression, a method call, the format
  // operator, a second statement on the line — is not something a string check
  // can reason about, so it FAILS here rather than passing by default. A literal
  // containing a `+` also fails, for the same reason; it would split wrong, and
  // failing closed on a shape nobody writes is cheaper than guessing.
  const rhs = assignments[0][2].trim();
  const TOKEN = /^(?:'([^']*)'|\$[A-Za-z_][A-Za-z0-9_]*)$/;
  const rendered = rhs.split('+').map((piece) => {
    const token = TOKEN.exec(piece.trim());
    assert.ok(token,
      `install.ps1 builds its registered command from ${JSON.stringify(piece.trim())}, which `
      + 'this guard cannot read. Keep the assignment to quoted literals and bare '
      + `variables, or teach the guard the new shape: ${JSON.stringify(rhs)}`);
    // A variable stands for the install path. The placeholder carries no space,
    // no quote and no shell metacharacter, so the shape assertion below is about
    // the spelling AROUND the path and never about the path itself — which is a
    // user's directory and may contain anything.
    return token[1] === undefined ? 'INSTALL_PATH' : token[1];
  }).join('');

  // THE SHAPE, both ends anchored. Never a substring test for
  // `cmd`/`powershell`/`node`: a user's install path may legitimately contain any
  // of them (C:/Users/x/powershell-tools/…, a checkout under node_modules), and
  // this repo's own path is clean, so a substring bug would pass here and fire on
  // them. Anchoring is also what catches the suffix wrappers, which no first-token
  // test can see.
  //
  // Case-insensitive, deliberately, and this is where the two halves of the guard
  // used to disagree with each other and with the contract they cite. The
  // uninstallers are the contract: uninstall.sh:65#wrapped matches `/^node\s+(.+)$/i` and
  // uninstall.ps1:30#match uses `-match`, which is case-insensitive in PowerShell. Both
  // recover the hook path from `NODE "…"` perfectly well. The twin case in
  // scripts/verify-installers.ps1 has always matched case-insensitively for that
  // reason; this half rejected what all three accept.
  assert.match(rendered, /^node "[^"]+"$/i,
    `install.ps1 registers ${JSON.stringify(rendered)} (path substituted); the registered `
    + 'command must be exactly `node "<path>"`, because both uninstallers parse the '
    + 'registration with `^node\\s+(.+)$` and anything else — a prefix, a suffix, a '
    + 'pipe — makes the hook un-uninstallable as well as ~18x slower');
});

// ── uninstall.sh ─────────────────────────────────────────────────────────────

function embeddedUninstaller() {
  const sh = fs.readFileSync(path.join(repoRoot, 'uninstall.sh'), 'utf8');
  const start = sh.indexOf("node --input-type=module <<'EOF'");
  assert.notEqual(start, -1, 'the heredoc that carries the uninstaller logic moved');
  const bodyStart = sh.indexOf('\n', start) + 1;
  const end = sh.indexOf('\nEOF', bodyStart);
  assert.notEqual(end, -1, 'unterminated heredoc');
  return sh.slice(bodyStart, end);
}

test('the uninstaller keeps a third-party hook that shares our entry', (t) => {
  const settingsPath = sandbox(t);
  const hookCmd = '/repo/bin/wildcard-perms';
  // Ours and a neighbour's in the SAME `hooks` array. Filtering per ENTRY
  // deleted the neighbour along with ours — silently, from a tool whose whole
  // promise is that it does not touch what it did not add.
  fs.writeFileSync(settingsPath, JSON.stringify({
    model: 'x',
    hooks: {
      PostToolUse: [{
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: hookCmd },
          { type: 'command', command: 'neighbour-tool' },
        ],
      }],
    },
  }, null, 2) + '\n');

  const run = runInstaller(settingsPath, embeddedUninstaller());
  assert.equal(run.code, 0, run.stderr);

  const after = JSON.parse(run.after);
  assert.equal(after.hooks.PostToolUse.length, 1, 'the entry survives, because something in it did');
  assert.deepEqual(after.hooks.PostToolUse[0].hooks, [{ type: 'command', command: 'neighbour-tool' }],
    'ours is gone and only ours is gone');
  assert.equal(after.hooks.PostToolUse[0].matcher, 'Bash', 'the entry keeps its other fields');
  assert.equal(after.model, 'x');
});

test('the uninstaller drops the entry, and then hooks, when nothing else is left', (t) => {
  const settingsPath = sandbox(t);
  const hookCmd = '/repo/bin/wildcard-perms';
  fs.writeFileSync(settingsPath, JSON.stringify({
    model: 'x',
    hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd }] }] },
  }, null, 2) + '\n');

  const run = runInstaller(settingsPath, embeddedUninstaller());
  assert.equal(run.code, 0, run.stderr);

  const after = JSON.parse(run.after);
  // No empty `hooks: {}` left behind: an uninstall should leave no trace.
  assert.deepEqual(Object.keys(after), ['model']);
});

test('the uninstaller counts hooks, not entries', (t) => {
  const settingsPath = sandbox(t);
  const hookCmd = '/repo/bin/wildcard-perms';
  // Two registrations of ours, one of them sharing an entry with a neighbour.
  // Per-entry counting reported "1 hook" for two removals.
  fs.writeFileSync(settingsPath, JSON.stringify({
    hooks: {
      PostToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd }, { type: 'command', command: 'neighbour' }] },
        { matcher: 'PowerShell', hooks: [{ type: 'command', command: hookCmd }] },
      ],
    },
  }, null, 2) + '\n');

  const run = runInstaller(settingsPath, embeddedUninstaller());
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /removed 2 wildcard-perms PostToolUse hooks/);

  const after = JSON.parse(run.after);
  assert.equal(after.hooks.PostToolUse.length, 1);
  assert.deepEqual(after.hooks.PostToolUse[0].hooks, [{ type: 'command', command: 'neighbour' }]);
});

test('the two package manifests report the same version', () => {
  // Both ship inside the same VSIX — the extension manifest drives the sidebar
  // badge, and the root one is what `wildcard-perms --version` prints. Nothing
  // asserted they agreed, so they drifted: the extension went 1.4.2 -> 1.4.3 ->
  // 1.4.4 while the root manifest stayed at 1.4.2, and a user with 1.4.4
  // installed saw "Active v1.4.4" in the sidebar and 1.4.2 from the CLI.
  //
  // .github/workflows/release.yml defaults its version input to
  // vscode-extension/package.json, so that one is authoritative and the root
  // follows it.
  const root = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const ext = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'vscode-extension', 'package.json'), 'utf8'));

  assert.equal(root.version, ext.version,
    `root package.json is ${root.version} but the extension manifest is ${ext.version}; `
    + 'release.yml treats the extension manifest as authoritative, so bump the root to match');
});

test('the root manifest cannot be published by accident', () => {
  // `npm publish` in the repo root would otherwise attempt
  // permission-wildcarding@<version> with the WHOLE TREE attached: there is no
  // `files` list and no .npmignore, so test/, img/, docs/ and any .vsix sitting in
  // the root all go up. The name would be wrong too -- the reserved npm name is
  // ai-acolyte, and this manifest is not it.
  //
  // Publishing the CLI for real is a live backlog item. When it happens this flag
  // comes off deliberately and this test changes with it, which is the point: the
  // decision becomes visible in a diff instead of being one stray command away.
  //
  // DO NOT verify this with `npm publish --dry-run`. It exits 0 on a private package
  // and prints "+ permission-wildcarding@<version>", which reads exactly like the flag
  // is inert. Checked against npm 11.13.0: the refusal lives at line 15 of libnpmpublish's
  // own lib/publish.js (`if (manifest.private) throw EPRIVATE`), and npm calls
  // libnpmpublish ONLY when !dryRun. The `private` check inside npm's own publish command
  // is gated on `workspace &&`, so it is about skipping private members of a workspace and
  // is not what stops a plain publish here. Those paths are npm's tree, not ours, so they
  // are deliberately not written as file:line -- check-line-refs.js refuses what it cannot
  // resolve against a tracked file, and it refused the first draft of this comment.
  const root = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

  assert.equal(root.private, true,
    'package.json has lost "private": true, so `npm publish` in the repo root would '
    + 'push the entire tree under the wrong package name');
});

test("the README's install command names the version a build actually produces", () => {
  // README.md tells the reader to name the version rather than glob it, because
  // `ai-acolyte-v*.vsix` can hand VS Code an older leftover and
  // installing an equal or lower version is a silent no-op. That advice only works
  // if the version in the command is the one packaging writes.
  //
  // It went stale: the command still read 1.5.2 at 1.5.4, naming a file no longer
  // in the tree. scripts/check-version-sync.mjs was green throughout -- it reads
  // the two manifests, the artefact and the build stamp, and never the README. The
  // identical hard-coded 1.5.2 in scripts/drive-installed.js was found and fixed;
  // this copy was not, because nothing looked at it.
  const ext = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'vscode-extension', 'package.json'), 'utf8'));
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

  const named = [...readme.matchAll(/ai-acolyte-v[0-9A-Za-z-]+\.vsix/g)]
    .map((match) => match[0]);

  // Asserting the list is non-empty first: a README that stopped naming a version
  // at all would otherwise pass this vacuously.
  assert.ok(named.length > 0,
    'README.md names no ai-acolyte-v<version-without-dots>.vsix at all, so the install '
    + 'instruction can no longer be checked against the manifest');

  for (const filename of named) {
    assert.equal(filename, `ai-acolyte-v${ext.version.replaceAll('.', '')}.vsix`,
      `README.md tells the reader to install ${filename}, but `
      + `packaging produces ${ext.version}. The README warns that installing an equal or `
      + 'lower version is a silent no-op, so a stale number here is the failure it describes.');
  }
});

// ── A registration from another checkout of this tool ────────────────────────
//
// Found live 2026-10-13. The development box's PostToolUse hook still pointed at
// an old checkout of this repo (the directory name from before the rename,
// v1.4.13, 142 commits behind) while the maintained checkout had been cloned
// under the new name. Both installers' duplicate check was an exact match on
// THIS checkout's path, so installing from the new checkout APPENDED a second
// entry; both fired on every tool call, the stale one kept running old code, and
// no fix since 1.4.13 reached a real tool call. Nothing reported it, because
// "registered" was true.
//
// Appended here rather than beside the install.sh cases above: other files cite
// this one by line number. The PowerShell twins are install cases 8-12 and
// uninstall cases 9-10 in scripts/verify-installers.ps1, which run under
// Windows PowerShell 5.1 in the `installers` CI job.

const hook = (command, more = {}) => ({ type: 'command', command, ...more });

// Our registration as the installers now leave it: in the background, "async": true
// (install.sh ASYNC_HOOK has why). The uninstallers ignore the key, so their inputs
// stay hook(); everything an installer writes, or must leave byte-identical, is ours().
const ours = (command, more = {}) => hook(command, { ...more, async: true });

// A settings.json with keys and a hook group of somebody else's around the
// PostToolUse array under test, so preservation is asserted every time.
const settingsWith = (postToolUse) => JSON.stringify({
  model: 'claude-opus-5',
  permissions: { allow: ['Bash(rg *)'], deny: ['Bash(rm -rf /*)'] },
  hooks: {
    SessionStart: [{ hooks: [hook('other-tool')] }],
    PostToolUse: postToolUse,
  },
}, null, 2) + '\n';

// Every PostToolUse command that runs this tool, by the tail the installers key
// on: "exactly one" has to count what would actually fire.
const toolHooks = (cfg) => (cfg.hooks?.PostToolUse ?? [])
  .flatMap((entry) => entry.hooks ?? [])
  .map((h) => h.command)
  .filter((command) => /[\\/]bin[\\/]wildcard-perms"?$/.test(command));

function assertNeighboursKept(after) {
  assert.equal(after.model, 'claude-opus-5');
  assert.deepEqual(after.permissions, { allow: ['Bash(rg *)'], deny: ['Bash(rm -rf /*)'] });
  assert.deepEqual(after.hooks.SessionStart, [{ hooks: [hook('other-tool')] }],
    "a co-located hook group is not ours to touch");
}

test('install: a registration from another checkout is repointed in place, not duplicated', (t) => {
  const settingsPath = sandbox(t);
  // install.ps1's `node "<path>"` spelling, at a path that does not exist, under a
  // matcher neither installer writes, in the MIDDLE of three entries, with a
  // field beside `command`: everything an in-place rewrite has to keep.
  const stale = path.join(path.dirname(path.dirname(settingsPath)), 'old-checkout', 'bin', 'wildcard-perms');
  fs.writeFileSync(settingsPath, settingsWith([
    { matcher: 'Bash', hooks: [hook('first-neighbour')] },
    { matcher: 'Bash|PowerShell|Edit', hooks: [hook(`node "${stale}"`, { timeout: 30 })] },
    { matcher: 'Write', hooks: [hook('last-neighbour')] },
  ]));

  const run = runInstaller(settingsPath, embeddedModule());
  assert.equal(run.code, 0, run.stderr);
  const after = JSON.parse(run.after);

  // The defect, asserted directly: before the fix this was [stale, HOOK_CMD].
  assert.deepEqual(toolHooks(after), [HOOK_CMD],
    'exactly one registration of the tool, pointing at this checkout');
  assert.deepEqual(after.hooks.PostToolUse, [
    { matcher: 'Bash', hooks: [hook('first-neighbour')] },
    { matcher: 'Bash|PowerShell|Edit', hooks: [ours(HOOK_CMD, { timeout: 30 })] },
    { matcher: 'Write', hooks: [hook('last-neighbour')] },
  ], 'repointed where it was: same position, matcher and timeout, neighbours untouched');
  assert.deepEqual(Object.keys(after.hooks.PostToolUse[1].hooks[0]), ['type', 'command', 'timeout', 'async'],
    'rewritten in place, so the hook keeps its key order');
  assertNeighboursKept(after);
  assert.ok(run.stdout.includes(`${stale} -> ${HOOK_CMD}`), `the notice names old -> new:\n${run.stdout}`);
  assert.match(run.stdout, /no longer exists/);
  assert.ok(fs.readFileSync(settingsPath + '.pre-install-backup', 'utf8').includes('old-checkout'),
    'and the way back still holds the old registration');
});

test("install: the bare-path spelling install.sh itself writes is recognised from another checkout too", (t) => {
  const settingsPath = sandbox(t);
  fs.writeFileSync(settingsPath, settingsWith([
    { matcher: 'Bash|PowerShell', hooks: [hook('/old/checkout/bin/wildcard-perms')] },
  ]));

  const run = runInstaller(settingsPath, embeddedModule());
  assert.equal(run.code, 0, run.stderr);
  const after = JSON.parse(run.after);
  assert.deepEqual(after.hooks.PostToolUse, [{ matcher: 'Bash|PowerShell', hooks: [ours(HOOK_CMD)] }]);
  assertNeighboursKept(after);
});

test('install: a command that only mentions the tool is not a registration of it', (t) => {
  // The control. A false match REWRITES somebody else's hook, so the grammar is
  // strict and each of these names the tool without being it: another
  // filename, extra arguments, a prefix command, no `bin` directory, a directory
  // that merely ends in "bin".
  const lookalikes = [
    'wildcard-perms-audit --since today',
    'node "/tools/x/bin/wildcard-perms.js"',
    '/tools/bin/wildcard-perms-old',
    'echo /tools/bin/wildcard-perms',
    'node "/tools/x/bin/wildcard-perms" --seed',
    '/tools/wildcard-perms',
    '/tools/sbin/wildcard-perms',
  ];
  const settingsPath = sandbox(t);
  fs.writeFileSync(settingsPath, settingsWith([
    { matcher: 'Bash', hooks: lookalikes.map((command) => hook(command)) },
  ]));

  const run = runInstaller(settingsPath, embeddedModule());
  assert.equal(run.code, 0, run.stderr);
  const after = JSON.parse(run.after);
  assert.deepEqual(after.hooks.PostToolUse, [
    { matcher: 'Bash', hooks: lookalikes.map((command) => hook(command)) },
    { matcher: 'Bash|PowerShell', hooks: [ours(HOOK_CMD)] },
  ], 'every lookalike untouched and in order, and ours appended as if none were there');
  assert.doesNotMatch(run.stdout, /repointed|duplicate/);
  assertNeighboursKept(after);
});

test('install: this checkout already registered leaves the file byte-identical', (t) => {
  // Both installers' spellings of THIS checkout: install.sh's bare path and
  // install.ps1's `node "<path>"`. Without HOOK_VIA_NODE neither is rewritten.
  for (const spelling of [HOOK_CMD, `node "${HOOK_CMD}"`]) {
    const settingsPath = sandbox(t);
    const before = settingsWith([
      { matcher: 'Bash|PowerShell', hooks: [ours(spelling), hook('neighbour-tool')] },
    ]);
    fs.writeFileSync(settingsPath, before);

    const run = runInstaller(settingsPath, embeddedModule());
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.after, before, `${spelling}: no write at all`);
    assert.equal(fs.existsSync(settingsPath + '.pre-install-backup'), false,
      `${spelling}: nothing written, so no backup either`);
    assert.match(run.stdout, /already registered/);
  }
});

test('install: several stale registrations under one matcher leave exactly one', (t) => {
  const settingsPath = sandbox(t);
  fs.writeFileSync(settingsPath, settingsWith([
    { matcher: 'Bash|PowerShell', hooks: [hook('node "/old/a/bin/wildcard-perms"')] },
    // Shares its entry with a neighbour, so removal has to be per hook.
    { matcher: 'Bash|PowerShell', hooks: [hook('neighbour-tool'), hook('/old/b/bin/wildcard-perms')] },
    // Alone in its entry, so the entry goes with it.
    { matcher: 'Bash|PowerShell', hooks: [hook('/old/c/bin/wildcard-perms')] },
  ]));

  const run = runInstaller(settingsPath, embeddedModule());
  assert.equal(run.code, 0, run.stderr);
  const after = JSON.parse(run.after);
  assert.deepEqual(after.hooks.PostToolUse, [
    { matcher: 'Bash|PowerShell', hooks: [ours(HOOK_CMD)] },
    { matcher: 'Bash|PowerShell', hooks: [hook('neighbour-tool')] },
  ], 'the first is repointed, the others removed, the neighbour and its entry kept');
  assert.ok(run.stdout.includes('/old/a/bin/wildcard-perms -> '), run.stdout);
  // One notice per removal, each naming its path.
  assert.match(run.stdout, /removed a duplicate[^\n]*\/old\/b\/bin\/wildcard-perms/);
  assert.match(run.stdout, /removed a duplicate[^\n]*\/old\/c\/bin\/wildcard-perms/);
  assertNeighboursKept(after);
});

test('install: a stale registration beside this checkout is removed, and this one kept as it is', (t) => {
  // The exact state the pre-fix installer left behind: the stale entry first,
  // the appended one second. Nothing needs repointing, only the stale one goes.
  const settingsPath = sandbox(t);
  fs.writeFileSync(settingsPath, settingsWith([
    { matcher: 'Bash|PowerShell', hooks: [hook('/old/checkout/bin/wildcard-perms')] },
    { matcher: 'Bash|PowerShell', hooks: [ours(HOOK_CMD)] },
  ]));

  const run = runInstaller(settingsPath, embeddedModule());
  assert.equal(run.code, 0, run.stderr);
  const after = JSON.parse(run.after);
  assert.deepEqual(after.hooks.PostToolUse, [{ matcher: 'Bash|PowerShell', hooks: [ours(HOOK_CMD)] }]);
  assert.match(run.stdout, /removed a duplicate[^\n]*\/old\/checkout\/bin\/wildcard-perms/);
  assert.doesNotMatch(run.stdout, /repointed/);
});

test('install: registrations split across matchers are each repointed, none removed', (t) => {
  // One entry per tool is a real shape (the uninstaller tests above carry it).
  // Collapsing it to one entry would leave the hook blind to PowerShell calls,
  // silently; under DIFFERENT matchers a second registration is coverage, not a
  // duplicate.
  const settingsPath = sandbox(t);
  fs.writeFileSync(settingsPath, settingsWith([
    { matcher: 'Bash', hooks: [hook('/old/checkout/bin/wildcard-perms')] },
    { matcher: 'PowerShell', hooks: [hook('/old/checkout/bin/wildcard-perms')] },
  ]));

  const run = runInstaller(settingsPath, embeddedModule());
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.after).hooks.PostToolUse, [
    { matcher: 'Bash', hooks: [ours(HOOK_CMD)] },
    { matcher: 'PowerShell', hooks: [ours(HOOK_CMD)] },
  ]);
  assert.doesNotMatch(run.stdout, /duplicate/);
});

test('install: Windows spellings count as this tool on Windows, and only there', (t) => {
  // `NODE "C:\...\BIN\Wildcard-Perms"`: case and backslashes fold on Windows,
  // where a path is case-insensitive and `\` separates. On POSIX `\` is a
  // filename character, `BIN` is another directory and `NODE` is not a command,
  // so the same string is somebody else's and must be left alone.
  const settingsPath = sandbox(t);
  const spelled = 'NODE "C:\\Old\\Checkout\\BIN\\Wildcard-Perms"';
  fs.writeFileSync(settingsPath, settingsWith([{ matcher: 'Bash|PowerShell', hooks: [hook(spelled)] }]));

  const run = runInstaller(settingsPath, embeddedModule());
  assert.equal(run.code, 0, run.stderr);
  const ptu = JSON.parse(run.after).hooks.PostToolUse;
  if (process.platform === 'win32') {
    assert.deepEqual(ptu, [{ matcher: 'Bash|PowerShell', hooks: [ours(HOOK_CMD)] }]);
  } else {
    assert.deepEqual(ptu, [
      { matcher: 'Bash|PowerShell', hooks: [hook(spelled)] },
      { matcher: 'Bash|PowerShell', hooks: [ours(HOOK_CMD)] },
    ]);
  }

  // And on Windows, Git Bash's /c/... spelling of THIS checkout is this
  // checkout, not a stale one: install.sh run from Git Bash and install.ps1 run
  // from PowerShell must agree that the other's registration is current.
  if (process.platform === 'win32') {
    const second = sandbox(t);
    const before = settingsWith([{ matcher: 'Bash|PowerShell', hooks: [ours('/c/Repo/bin/wildcard-perms')] }]);
    fs.writeFileSync(second, before);
    const again = runInstaller(second, embeddedModule(), 'C:/repo/bin/wildcard-perms');
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.after, before, 'one checkout, two spellings: no write');
  }
});

test('uninstall: a registration whose checkout no longer exists is removed too', (t) => {
  // Before, an uninstall run from the new checkout matched nothing, said
  // "nothing removed", and left a hook that can only fail on every tool call.
  const settingsPath = sandbox(t);
  const gone = path.join(path.dirname(path.dirname(settingsPath)), 'gone-checkout', 'bin', 'wildcard-perms');
  fs.writeFileSync(settingsPath, settingsWith([
    { matcher: 'Bash|PowerShell', hooks: [hook(`node "${gone}"`)] },
    { matcher: 'Bash', hooks: [hook('neighbour')] },
  ]));

  const run = runInstaller(settingsPath, embeddedUninstaller());
  assert.equal(run.code, 0, run.stderr);
  const after = JSON.parse(run.after);
  assert.deepEqual(after.hooks.PostToolUse, [{ matcher: 'Bash', hooks: [hook('neighbour')] }]);
  assertNeighboursKept(after);
  assert.match(run.stdout, /removed 1 wildcard-perms PostToolUse hook\b/);
  assert.ok(run.stdout.includes(gone), run.stdout);
  assert.match(run.stdout, /no longer exists/);
});

test('uninstall: a live checkout elsewhere is left registered, and named', (t) => {
  // Not this checkout's to remove: the user ran THIS checkout's uninstaller.
  // Leaving it silently was the old "nothing removed" story, so it is named.
  const settingsPath = sandbox(t);
  const live = path.join(path.dirname(path.dirname(settingsPath)), 'other-checkout', 'bin', 'wildcard-perms');
  fs.mkdirSync(path.dirname(live), { recursive: true });
  fs.writeFileSync(live, '');
  const before = settingsWith([{ matcher: 'Bash|PowerShell', hooks: [hook(`node "${live}"`)] }]);
  fs.writeFileSync(settingsPath, before);

  const run = runInstaller(settingsPath, embeddedUninstaller());
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.after, before, 'nothing of this checkout, so nothing written');
  assert.match(run.stdout, /nothing removed/);
  assert.ok(run.stdout.includes(`left ${live} registered`), run.stdout);

  // Beside this checkout's own registration: ours goes, the live one stays.
  const both = sandbox(t);
  fs.writeFileSync(both, settingsWith([
    { matcher: 'Bash|PowerShell', hooks: [hook(HOOK_CMD), hook(`node "${live}"`)] },
  ]));
  const again = runInstaller(both, embeddedUninstaller());
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(JSON.parse(again.after).hooks.PostToolUse,
    [{ matcher: 'Bash|PowerShell', hooks: [hook(`node "${live}"`)] }]);
  assert.ok(again.stdout.includes(`left ${live} registered`), again.stdout);
});

// ── install.sh end to end, through a real bash ───────────────────────────────
//
// Everything above feeds install.sh's embedded module to node directly, which
// cannot see the shell half: how SCRIPT_DIR is spelled, what reaches node, the
// starter-pack line. Defects lived there (found 2026-10-13), visible only when
// the script runs under Git Bash on Windows, so these cases run a COPY of the
// real script from a fake checkout under a temp dir, with HOME pointed at a
// sandbox beside it -- the real ~/.claude is never involved -- and answer "n" to
// the seed prompt.
//
// Which bash: on Windows, Git for Windows' own, found from `git --exec-path`,
// never whatever `bash` comes first on PATH, which can be WSL's System32 shim
// and would run a Linux node against a Linux home. Skipped when there is none.
// HOME is handed over with forward slashes: Git Bash converts C:/x to /c/x but
// drops the backslashes of C:\x.
//
// The platform seam is a `uname` shim, put first on PATH from INSIDE bash
// (runSh's launcher), because Git for Windows' bin/bash.exe puts its own
// /usr/bin ahead of anything inherited, and converted with `cygpath -u` there,
// because a C:/ entry splits PATH at its colon. install.sh asks `uname -s` and
// the shim answers, so no variable in the shipped script exists only for tests.

const fwd = (p) => p.split(path.sep).join('/');

function findBash() {
  if (process.platform !== 'win32') {
    return spawnSync('bash', ['-c', 'true']).status === 0 ? 'bash' : null;
  }
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (exec.status !== 0) return null;
  // <git root>/mingw64/libexec/git-core -> <git root>/bin/bash.exe
  const bash = path.join(path.resolve(exec.stdout.trim(), '..', '..', '..'), 'bin', 'bash.exe');
  return fs.existsSync(bash) ? bash : null;
}
const BASH = findBash();
const NO_BASH = BASH ? false
  : (process.platform === 'win32' ? 'no Git for Windows bash.exe found via git --exec-path' : 'no bash on PATH');

// A fake checkout with copies of both scripts, the real starter pack and a stub
// bin/wildcard-perms (install.sh only chmods it, because "n" declines the seed),
// plus an empty home, so install.sh's own mkdir of ~/.claude runs too.
function shCheckout(t, name = 'checkout') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-installer-sh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, name);
  fs.mkdirSync(path.join(checkout, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(checkout, 'patterns'));
  for (const name of ['install.sh', 'uninstall.sh']) {
    fs.copyFileSync(path.join(repoRoot, name), path.join(checkout, name));
  }
  fs.copyFileSync(path.join(repoRoot, 'patterns', 'starter-pack.json'),
    path.join(checkout, 'patterns', 'starter-pack.json'));
  fs.writeFileSync(path.join(checkout, 'bin', 'wildcard-perms'), '#!/usr/bin/env node\n');
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  return { root, checkout, home, settings: path.join(home, '.claude', 'settings.json') };
}

function runSh(box, script, shimDir = null) {
  const launcher = 'if [ -n "$1" ]; then p="$1"; '
    + 'if command -v cygpath >/dev/null 2>&1; then p="$(cygpath -u "$p")"; fi; '
    + 'export PATH="$p:$PATH"; fi; exec bash "$2"';
  const run = spawnSync(BASH, ['-c', launcher, 'installers-test',
    shimDir ? fwd(shimDir) : '', fwd(path.join(box.checkout, script))], {
    input: 'n\n',
    env: { ...process.env, HOME: fwd(box.home) },
    encoding: 'utf8',
    timeout: 60000,
  });
  const after = fs.existsSync(box.settings) ? fs.readFileSync(box.settings, 'utf8') : null;
  return { code: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', after, error: run.error };
}

test('install.sh end to end: the starter-pack line prints its count, and nothing reaches stderr',
  { skip: NO_BASH }, (t) => {
    // Found 2026-10-13 under Git Bash: the count was `node -e "...require('$SCRIPT_DIR/...')"`,
    // a POSIX path spliced INTO the code, which the Windows node cannot open. It printed
    // a MODULE_NOT_FOUND stack and "Merges  curated permissions" with no number, and the
    // install carried on. The same line works on Linux, so only this leg can see it.
    const box = shCheckout(t);
    const run = runSh(box, 'install.sh');
    assert.equal(run.error, undefined, String(run.error));
    assert.equal(run.code, 0, run.stderr);
    const count = JSON.parse(fs.readFileSync(path.join(repoRoot, 'patterns', 'starter-pack.json'), 'utf8')).length;
    assert.ok(count > 0, 'an empty pack would make "Merges 0" indistinguishable from a broken count');
    assert.match(run.stdout, new RegExp(`^Merges ${count} curated permissions into your allow list\\.$`, 'm'),
      run.stdout);
    assert.equal(run.stderr, '', 'nothing on stderr: the old line put a whole MODULE_NOT_FOUND stack there');
    assert.equal(JSON.parse(run.after).hooks.PostToolUse.length, 1, 'and the hook was registered');
  });

// ── Windows: install.sh registers `node "<C:/path>"`, as install.ps1 does ────
//
// Found 2026-10-13: under Git Bash install.sh registered the BARE
// C:/.../bin/wildcard-perms (Git Bash had converted HOOK_CMD on its way into
// node). Windows has no shebang support and an extensionless file has no
// association, so that pops "How do you want to open this file?" on every hook
// fire, the dialog install.ps1's `node "<path>"` exists to avoid. install.sh's
// uname block now hands the module HOOK_VIA_NODE=1 there. The module cases
// below set it directly, with the C:/ path cygpath gives, on every platform:
// each spelling is cased and slashed the same way, so no Windows-only folding is
// involved. The end-to-end cases after them run the uname block itself.

const WIN_HOOK = 'C:/repo/bin/wildcard-perms';
const WIN_COMMAND = `node "${WIN_HOOK}"`;
const VIA_NODE = { HOOK_VIA_NODE: '1' };

test('install, Windows: registers node "<C:/path>", and install.ps1\'s registration is already current', (t) => {
  const fresh = sandbox(t);
  fs.writeFileSync(fresh, HEALTHY);
  const run = runInstaller(fresh, embeddedModule(), WIN_HOOK, VIA_NODE);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.after).hooks.PostToolUse,
    [{ matcher: 'Bash|PowerShell', hooks: [ours(WIN_COMMAND)] }],
    "the command install.ps1 writes, so the two installers agree on Windows");

  // install.ps1's own registration of this checkout: no write at all.
  const ps1 = sandbox(t);
  const before = settingsWith([{ matcher: 'Bash|PowerShell', hooks: [ours(WIN_COMMAND), hook('neighbour-tool')] }]);
  fs.writeFileSync(ps1, before);
  const again = runInstaller(ps1, embeddedModule(), WIN_HOOK, VIA_NODE);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.after, before, 'byte-identical');
  assert.match(again.stdout, /already registered/);
});

test('install, Windows: the bare path an older install.sh left is rewritten in place to run through node', (t) => {
  // Exactly what the pre-fix script registered from Git Bash, with a field beside
  // `command` and a neighbour in the same entry: rewritten where it stands, and
  // reported as what it is, this checkout, never "another checkout".
  const settingsPath = sandbox(t);
  fs.writeFileSync(settingsPath, settingsWith([
    { matcher: 'Bash', hooks: [hook('first-neighbour')] },
    { matcher: 'Bash|PowerShell', hooks: [hook(WIN_HOOK, { timeout: 30 }), hook('neighbour-tool')] },
  ]));

  const run = runInstaller(settingsPath, embeddedModule(), WIN_HOOK, VIA_NODE);
  assert.equal(run.code, 0, run.stderr);
  const after = JSON.parse(run.after);
  assert.deepEqual(after.hooks.PostToolUse, [
    { matcher: 'Bash', hooks: [hook('first-neighbour')] },
    { matcher: 'Bash|PowerShell', hooks: [ours(WIN_COMMAND, { timeout: 30 }), hook('neighbour-tool')] },
  ]);
  assertNeighboursKept(after);
  assert.ok(run.stdout.includes(`${WIN_HOOK} -> ${WIN_COMMAND}`), run.stdout);
  assert.match(run.stdout, /runs through node/);
  assert.doesNotMatch(run.stdout, /another checkout/, 'it is this checkout, and the notice must not say otherwise');

  // Another checkout is repointed to the node form too, not to the bare path.
  const other = sandbox(t);
  fs.writeFileSync(other, settingsWith([
    { matcher: 'Bash|PowerShell', hooks: [hook('node "C:/old/checkout/bin/wildcard-perms"')] },
  ]));
  const moved = runInstaller(other, embeddedModule(), WIN_HOOK, VIA_NODE);
  assert.equal(moved.code, 0, moved.stderr);
  assert.deepEqual(JSON.parse(moved.after).hooks.PostToolUse,
    [{ matcher: 'Bash|PowerShell', hooks: [ours(WIN_COMMAND)] }]);
  assert.match(moved.stdout, /repointed from another checkout/);
});

// Shim commands for runSh's seam: each file is a /bin/sh script running `body`.
// `uname` is what install.sh and uninstall.sh consult; on Linux a `cygpath`
// stands in for Git Bash's.
function shims(box, commands) {
  const dir = path.join(box.root, 'shim');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(commands)) {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`);
    fs.chmodSync(path.join(dir, name), 0o755);
  }
  return dir;
}

const commandsIn = (raw) => JSON.parse(raw).hooks.PostToolUse.flatMap((entry) => entry.hooks.map((h) => h.command));

test('install.sh end to end: under Git Bash, MSYS2 or Cygwin it registers node "<C:/path>", and uninstall.sh removes it',
  { skip: NO_BASH }, (t) => {
    const box = shCheckout(t);
    let shimDir = null;
    let expected;
    if (process.platform === 'win32') {
      // The real thing: Git Bash's own uname (MINGW64_NT-...) and cygpath, so the
      // expectation is install.ps1's spelling of this checkout, the long path with
      // forward slashes, even though os.tmpdir() may be an 8.3 path.
      expected = `node "${fwd(fs.realpathSync.native(box.checkout))}/bin/wildcard-perms"`;
    } else {
      // Linux standing in: uname says MINGW64, and a cygpath that answers only
      // `-m -l <path>` prefixes C:, so the result shows which path was used.
      shimDir = shims(box, {
        uname: "echo 'MINGW64_NT-10.0-26200'",
        cygpath: '[ "$1" = -m ] && [ "$2" = -l ] && printf \'C:%s\\n\' "$3"',
      });
      expected = `node "C:${box.checkout}/bin/wildcard-perms"`;
    }

    const run = runSh(box, 'install.sh', shimDir);
    assert.equal(run.error, undefined, String(run.error));
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(commandsIn(run.after), [expected]);

    const again = runSh(box, 'install.sh', shimDir);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /already registered/);

    // uninstall.sh must recognise it: under Git Bash its HOOK_CMD would otherwise
    // reach node in Git Bash's spelling, which keeps 8.3 components and /tmp's.
    const un = runSh(box, 'uninstall.sh', shimDir);
    assert.equal(un.code, 0, un.stderr);
    assert.match(un.stdout, /removed 1 wildcard-perms PostToolUse hook\b/);
    assert.deepEqual(JSON.parse(un.after), {}, 'nothing of ours left, and nothing else was there');
  });

test('install.sh end to end: on Linux and macOS it registers the bare path, and uninstall.sh removes it',
  { skip: NO_BASH }, (t) => {
    const box = shCheckout(t);
    // On Windows, Git Bash told it is Linux runs the POSIX branch for real.
    const shimDir = process.platform === 'win32' ? shims(box, { uname: "echo 'Linux'" }) : null;

    const run = runSh(box, 'install.sh', shimDir);
    assert.equal(run.error, undefined, String(run.error));
    assert.equal(run.code, 0, run.stderr);
    const registered = commandsIn(run.after);
    assert.equal(registered.length, 1, JSON.stringify(registered));
    assert.doesNotMatch(registered[0], /^node\s/i, 'bare: the shebang plus the chmod carry it');
    if (process.platform === 'win32') {
      // Git Bash converted HOOK_CMD on its way into node, keeping any 8.3
      // component, so compare the file it names rather than the spelling.
      assert.equal(fs.realpathSync.native(registered[0]),
        fs.realpathSync.native(path.join(box.checkout, 'bin', 'wildcard-perms')));
    } else {
      assert.equal(registered[0], `${box.checkout}/bin/wildcard-perms`);
    }

    const un = runSh(box, 'uninstall.sh', shimDir);
    assert.equal(un.code, 0, un.stderr);
    assert.match(un.stdout, /removed 1 wildcard-perms PostToolUse hook\b/);
  });

// ── One checkout, two spellings: 8.3 short paths and directory links ─────────
//
// Found 2026-10-13: the same checkout registered under an 8.3 short path
// (C:/Users/SHORTN~1.EXT/...) was "repointed from another checkout" by both
// installers, and both uninstallers left it in place and named it "another
// checkout", because the comparison was on the text. Git Bash writes that short
// form by itself for a checkout under /tmp. Both .sh scripts now compare
// realpath's spelling, which is the long form on Windows and also resolves
// directory links. A link is the case that runs everywhere (a symlink on POSIX,
// a junction on Windows, neither needs privilege); the 8.3 case runs where
// os.tmpdir() has a short component, which includes GitHub's Windows runners.
// The .ps1 twins, 8.3 only, are verify-installers.ps1's "8.3 spelling" cases.

// A sandbox holding a real bin/wildcard-perms, because realpath needs a file.
function realCheckout(t) {
  const settingsPath = sandbox(t);
  const dir = path.dirname(path.dirname(settingsPath));
  const file = path.join(dir, 'checkout', 'bin', 'wildcard-perms');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/usr/bin/env node\n');
  // How the installer itself would spell it: canonical, forward slashes.
  return { settingsPath, dir, file, hookCmd: fwd(fs.realpathSync.native(file)) };
}

function linkedSpelling(box) {
  const link = path.join(box.dir, 'linked-checkout');
  fs.symlinkSync(path.join(box.dir, 'checkout'), link, process.platform === 'win32' ? 'junction' : 'dir');
  return fwd(path.join(link, 'bin', 'wildcard-perms'));
}

test('install: this checkout through a linked directory is this checkout, not another one', (t) => {
  const box = realCheckout(t);
  const before = settingsWith([{ matcher: 'Bash|PowerShell', hooks: [ours(`node "${linkedSpelling(box)}"`)] }]);
  fs.writeFileSync(box.settingsPath, before);

  const run = runInstaller(box.settingsPath, embeddedModule(), box.hookCmd);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.after, before, 'one file, so nothing to repoint and nothing written');
  assert.match(run.stdout, /already registered/);
  assert.doesNotMatch(run.stdout, /another checkout/);
});

test("uninstall: this checkout's registration through a linked directory is removed as this checkout", (t) => {
  const box = realCheckout(t);
  fs.writeFileSync(box.settingsPath, settingsWith([
    { matcher: 'Bash|PowerShell', hooks: [hook(`node "${linkedSpelling(box)}"`)] },
  ]));

  const run = runInstaller(box.settingsPath, embeddedUninstaller(), box.hookCmd);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /removed 1 wildcard-perms PostToolUse hook\b/);
  assert.doesNotMatch(run.stdout, /another checkout/, 'its own hook, so not named as somebody else\'s');
  assert.equal(JSON.parse(run.after).hooks.PostToolUse, undefined);
});

test('install and uninstall: this checkout under its 8.3 short path is this checkout', (t) => {
  if (process.platform !== 'win32') return t.skip('8.3 short names are a Windows thing');
  const box = realCheckout(t);
  // box.file is spelled through os.tmpdir(), %TEMP%, which keeps its 8.3 form.
  const short = fwd(box.file);
  if (short.toLowerCase() === box.hookCmd.toLowerCase()) {
    return t.skip(`os.tmpdir() has no 8.3 component here (${os.tmpdir()})`);
  }
  assert.match(short, /~/, 'the fixture must really be a short spelling for this to mean anything');

  const before = settingsWith([{ matcher: 'Bash|PowerShell', hooks: [ours(`node "${short}"`)] }]);
  fs.writeFileSync(box.settingsPath, before);
  const run = runInstaller(box.settingsPath, embeddedModule(), box.hookCmd);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.after, before, 'one checkout, two spellings: no write');
  assert.doesNotMatch(run.stdout, /another checkout/);

  const un = runInstaller(box.settingsPath, embeddedUninstaller(), box.hookCmd);
  assert.equal(un.code, 0, un.stderr);
  assert.match(un.stdout, /removed 1 wildcard-perms PostToolUse hook\b/);
  assert.doesNotMatch(un.stdout, /another checkout/);
});

// ── Unquoted paths with a space, and Cygwin's /cygdrive/ spelling ────────────
//
// Found by the v1.6.2 audit, fixed 2026-10-14, in all four scripts.
//
// (1) install.sh registered the BARE path on Linux and macOS unquoted, so from a
// checkout under a path with a space it wrote a command a shell splits at the
// space (Claude Code runs `command` through `sh -c`, or Git Bash on Windows). And
// the strict grammar refused EVERY unquoted path with a space, so that
// registration was never recognised again: a reinstall from a moved checkout
// appended a second entry beside it, and the uninstallers could neither remove
// nor name it. Such a command now counts only when it provably names one file;
// a fresh registration of a spaced path is quoted, and this checkout's old
// unquoted one is quoted in place.
//
// (2) /cygdrive/c/... was not folded on Windows, so this checkout spelled that way
// was "another checkout" whose path "no longer exists", and a live other checkout
// was "gone" to the uninstallers.
//
// The .ps1 twins are install cases 16-18 and uninstall cases 12-13 in
// scripts/verify-installers.ps1.

// A real bin/wildcard-perms under a directory whose name has a space.
function spacedCheckout(t, name = 'old checkout') {
  const settingsPath = sandbox(t);
  const dir = path.dirname(path.dirname(settingsPath));
  const file = path.join(dir, name, 'bin', 'wildcard-perms');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/usr/bin/env node\n');
  return { settingsPath, dir, file, spelled: fwd(fs.realpathSync.native(file)) };
}

test('install: another checkout registered unquoted under a path with a space is repointed, not duplicated', (t) => {
  // The bare spelling install.sh wrote on POSIX, and the `node` one a hand edit or
  // an older Windows install leaves. Both name a file that exists.
  for (const spell of [(p) => p, (p) => `node ${p}`]) {
    const box = spacedCheckout(t);
    const stale = spell(box.spelled);
    assert.match(stale, /\s.*wildcard-perms$/, 'the fixture must really be unquoted with a space');
    fs.writeFileSync(box.settingsPath, settingsWith([
      { matcher: 'Bash|PowerShell', hooks: [hook(stale, { timeout: 30 })] },
    ]));

    const run = runInstaller(box.settingsPath, embeddedModule());
    assert.equal(run.code, 0, run.stderr);
    const after = JSON.parse(run.after);
    // The defect, asserted directly: before the fix this was two entries.
    assert.deepEqual(after.hooks.PostToolUse,
      [{ matcher: 'Bash|PowerShell', hooks: [ours(HOOK_CMD, { timeout: 30 })] }], stale);
    assert.ok(run.stdout.includes(`${box.spelled} -> ${HOOK_CMD}`), run.stdout);
    assert.doesNotMatch(run.stdout, /no longer exists/, 'it exists, so the notice must not say otherwise');
    assertNeighboursKept(after);
  }
});

test('install: an unquoted command with a space that does not name one file is left alone', (t) => {
  // The control for the case above. A path that does not exist proves nothing
  // about a command a shell would split, and the other two are a wrapper and an
  // extra argument around a file that DOES exist: none of them is ours to rewrite.
  const box = spacedCheckout(t);
  const absent = fwd(path.join(box.dir, 'gone checkout', 'bin', 'wildcard-perms'));
  const lookalikes = [absent, `node ${absent}`, `/usr/bin/env node ${box.spelled}`, `node --inspect ${box.spelled}`];
  fs.writeFileSync(box.settingsPath, settingsWith([
    { matcher: 'Bash', hooks: lookalikes.map((command) => hook(command)) },
  ]));

  const run = runInstaller(box.settingsPath, embeddedModule());
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.after).hooks.PostToolUse, [
    { matcher: 'Bash', hooks: lookalikes.map((command) => hook(command)) },
    { matcher: 'Bash|PowerShell', hooks: [ours(HOOK_CMD)] },
  ], 'every lookalike untouched and in order, and ours appended as if none were there');
  assert.doesNotMatch(run.stdout, /repointed|duplicate|quoted/);
});

test("install: a path with a space is registered quoted, and this checkout's unquoted registration is quoted in place", (t) => {
  const box = spacedCheckout(t, 'my checkout');
  const hookCmd = box.spelled;

  // Fresh: single quotes, which sh takes literally.
  const fresh = sandbox(t);
  const first = runInstaller(fresh, embeddedModule(), hookCmd);
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(commandsIn(first.after), [`'${hookCmd}'`]);

  // What the old install.sh wrote from this checkout, with a field beside
  // `command` and a neighbour in the same entry: rewritten where it stands, and
  // never called another checkout.
  fs.writeFileSync(box.settingsPath, settingsWith([
    { matcher: 'Bash|PowerShell', hooks: [hook(hookCmd, { timeout: 30 }), hook('neighbour-tool')] },
  ]));
  const run = runInstaller(box.settingsPath, embeddedModule(), hookCmd);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.after).hooks.PostToolUse, [
    { matcher: 'Bash|PowerShell', hooks: [ours(`'${hookCmd}'`, { timeout: 30 }), hook('neighbour-tool')] },
  ]);
  assert.ok(run.stdout.includes(`${hookCmd} -> '${hookCmd}'`), run.stdout);
  assert.match(run.stdout, /path quoted/);
  assert.doesNotMatch(run.stdout, /another checkout/);

  // Idempotent: the quoted form is this checkout, already registered.
  const again = runInstaller(box.settingsPath, embeddedModule(), hookCmd);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.after, run.after, 'no second rewrite');
  assert.match(again.stdout, /already registered/);

  // Under Windows (HOOK_VIA_NODE), `node <unquoted>` becomes install.ps1's form.
  const win = sandbox(t);
  fs.writeFileSync(win, settingsWith([{ matcher: 'Bash|PowerShell', hooks: [hook(`node ${hookCmd}`)] }]));
  const viaNode = runInstaller(win, embeddedModule(), hookCmd, VIA_NODE);
  assert.equal(viaNode.code, 0, viaNode.stderr);
  assert.deepEqual(commandsIn(viaNode.after), [`node "${hookCmd}"`]);
  assert.match(viaNode.stdout, /path quoted/);

  // A path that itself holds a `'` gets double quotes instead.
  const apostrophe = sandbox(t);
  const odd = "/Users/Jo O'Neil/acolyte/bin/wildcard-perms";
  const oddRun = runInstaller(apostrophe, embeddedModule(), odd);
  assert.equal(oddRun.code, 0, oddRun.stderr);
  assert.deepEqual(commandsIn(oddRun.after), [`"${odd}"`]);
});

test("uninstall: a quoted or unquoted path with a space is this checkout's, and a live one elsewhere is named", (t) => {
  const mine = spacedCheckout(t, 'my checkout');
  const otherFile = path.join(mine.dir, 'other checkout', 'bin', 'wildcard-perms');
  fs.mkdirSync(path.dirname(otherFile), { recursive: true });
  fs.writeFileSync(otherFile, '');
  const other = fwd(fs.realpathSync.native(otherFile));
  const absent = fwd(path.join(mine.dir, 'gone checkout', 'bin', 'wildcard-perms'));
  fs.writeFileSync(mine.settingsPath, settingsWith([
    // This checkout as install.sh now writes it, beside another live checkout
    // and an unquoted path to nothing, which proves nothing and is left.
    { matcher: 'Bash|PowerShell', hooks: [hook(`'${mine.spelled}'`), hook(`node ${other}`), hook(absent)] },
    // This checkout unquoted behind `node`.
    { matcher: 'Bash', hooks: [hook(`node ${mine.spelled}`)] },
  ]));

  const run = runInstaller(mine.settingsPath, embeddedUninstaller(), mine.spelled);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /removed 2 wildcard-perms PostToolUse hooks/);
  assert.deepEqual(JSON.parse(run.after).hooks.PostToolUse,
    [{ matcher: 'Bash|PowerShell', hooks: [hook(`node ${other}`), hook(absent)] }]);
  assert.ok(run.stdout.includes(`left ${other} registered`), run.stdout);
  assert.ok(!run.stdout.includes(absent), `an unprovable command is neither removed nor named:\n${run.stdout}`);
});

test('install and uninstall, Windows: /cygdrive/c/... is the same path as C:/...', (t) => {
  if (process.platform !== 'win32') return t.skip('/cygdrive/ is a Windows spelling; on POSIX it is just a directory');
  const cyg = (p) => p.replace(/^([A-Za-z]):\//, (_, drive) => `/cygdrive/${drive.toLowerCase()}/`);

  // This checkout, spelled the Cygwin way: already registered, and removed as
  // this checkout, never "a checkout that no longer exists".
  const box = realCheckout(t);
  const before = settingsWith([{ matcher: 'Bash|PowerShell', hooks: [ours(`node "${cyg(box.hookCmd)}"`)] }]);
  assert.match(before, /\/cygdrive\/[a-z]\//, 'the fixture must really be the Cygwin spelling');
  fs.writeFileSync(box.settingsPath, before);
  const run = runInstaller(box.settingsPath, embeddedModule(), box.hookCmd);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.after, before, 'one checkout, two spellings: no write');
  assert.doesNotMatch(run.stdout, /another checkout/);
  const un = runInstaller(box.settingsPath, embeddedUninstaller(), box.hookCmd);
  assert.equal(un.code, 0, un.stderr);
  assert.match(un.stdout, /removed 1 wildcard-perms PostToolUse hook\b/);
  assert.doesNotMatch(un.stdout, /no longer exists/);

  // A live OTHER checkout spelled that way: left and named by the uninstaller,
  // not removed as gone; repointed by the installer without "no longer exists".
  const elsewhere = realCheckout(t);
  const otherFile = path.join(elsewhere.dir, 'other', 'bin', 'wildcard-perms');
  fs.mkdirSync(path.dirname(otherFile), { recursive: true });
  fs.writeFileSync(otherFile, '');
  const other = cyg(fwd(fs.realpathSync.native(otherFile)));
  const live = settingsWith([{ matcher: 'Bash|PowerShell', hooks: [hook(`node "${other}"`)] }]);
  fs.writeFileSync(elsewhere.settingsPath, live);
  const left = runInstaller(elsewhere.settingsPath, embeddedUninstaller(), elsewhere.hookCmd);
  assert.equal(left.code, 0, left.stderr);
  assert.equal(left.after, live, 'not this checkout and not gone, so nothing removed');
  assert.ok(left.stdout.includes(`left ${other} registered`), left.stdout);
  const moved = runInstaller(elsewhere.settingsPath, embeddedModule(), elsewhere.hookCmd);
  assert.equal(moved.code, 0, moved.stderr);
  assert.ok(moved.stdout.includes(`${other} -> ${elsewhere.hookCmd}`), moved.stdout);
  assert.doesNotMatch(moved.stdout, /no longer exists/, 'it exists, so the notice must not say otherwise');
});

test('install.sh end to end: from a checkout under a path with a space, the registration is quoted and uninstall.sh removes it',
  { skip: NO_BASH }, (t) => {
    // The shell half too: SCRIPT_DIR with a space must reach node whole, on the
    // POSIX branch (shimmed on Windows) and the Git Bash one alike.
    for (const posix of [true, false]) {
      if (!posix && process.platform !== 'win32') continue; // the MINGW branch needs a real cygpath
      const box = shCheckout(t, 'my checkout');
      const shimDir = posix && process.platform === 'win32' ? shims(box, { uname: "echo 'Linux'" }) : null;
      const run = runSh(box, 'install.sh', shimDir);
      assert.equal(run.error, undefined, String(run.error));
      assert.equal(run.code, 0, run.stderr);
      const registered = commandsIn(run.after);
      assert.equal(registered.length, 1, JSON.stringify(registered));
      const file = fs.realpathSync.native(path.join(box.checkout, 'bin', 'wildcard-perms'));
      if (posix) {
        const unquoted = /^'(.+)'$/.exec(registered[0]);
        assert.ok(unquoted, `bare, but quoted: ${registered[0]}`);
        assert.equal(fs.realpathSync.native(unquoted[1]), file);
      } else {
        assert.equal(registered[0], `node "${fwd(file)}"`);
      }
      const again = runSh(box, 'install.sh', shimDir);
      assert.match(again.stdout, /already registered/);
      const un = runSh(box, 'uninstall.sh', shimDir);
      assert.equal(un.code, 0, un.stderr);
      assert.match(un.stdout, /removed 1 wildcard-perms PostToolUse hook\b/);
    }
  });

// ── uninstall.sh folds case only on Windows ──────────────────────────────────
//
// Found by the v1.6.2 audit, and true of every uninstall.sh before 2026-10-14: its
// hookPath lowercased, turned `\` into `/` and folded /c/ to c:/ on EVERY platform,
// while install.sh's comparable does all three only on Windows. On Linux, and on a
// case-sensitive macOS volume, /src/Acolyte and /src/acolyte are two checkouts,
// and an uninstall run from one removed the other's LIVE registration as its own.
// The Linux half runs on CI's ubuntu legs (and was run in node:20-slim under
// podman on 2026-10-14); the Windows half pins that the fold is still there.
test('uninstall: a sibling checkout differing only by case is another checkout where the file system says so', (t) => {
  const settingsPath = sandbox(t);
  const dir = path.dirname(path.dirname(settingsPath));
  const make = (name) => {
    const file = path.join(dir, name, 'bin', 'wildcard-perms');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return fwd(fs.realpathSync.native(file));
  };
  const mine = make('acolyte');

  if (process.platform === 'win32') {
    // One checkout in any casing: removed as this checkout, never named another.
    const shouted = mine.replace('/acolyte/bin/', '/ACOLYTE/BIN/');
    assert.notEqual(shouted, mine, 'the fixture must really differ in case');
    fs.writeFileSync(settingsPath, settingsWith([{ matcher: 'Bash|PowerShell', hooks: [hook(`node "${shouted}"`)] }]));
    const run = runInstaller(settingsPath, embeddedUninstaller(), mine);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /removed 1 wildcard-perms PostToolUse hook\b/);
    assert.doesNotMatch(run.stdout, /another checkout|no longer exists/);
    return;
  }
  if (fs.existsSync(path.join(dir, 'ACOLYTE'))) {
    return t.skip('this volume folds case (the macOS default), so the sibling cannot exist');
  }

  const sibling = make('Acolyte');
  assert.notEqual(sibling, mine, 'precondition: two directories, not one');
  const before = settingsWith([{ matcher: 'Bash|PowerShell', hooks: [hook(sibling)] }]);
  fs.writeFileSync(settingsPath, before);
  const run = runInstaller(settingsPath, embeddedUninstaller(), mine);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.after, before, "the sibling's live hook is not this checkout's to remove");
  assert.match(run.stdout, /nothing removed/);
  assert.ok(run.stdout.includes(`left ${sibling} registered`), run.stdout);

  // And this checkout's own registration beside it still goes.
  fs.writeFileSync(settingsPath, settingsWith([{ matcher: 'Bash|PowerShell', hooks: [hook(mine), hook(sibling)] }]));
  const both = runInstaller(settingsPath, embeddedUninstaller(), mine);
  assert.equal(both.code, 0, both.stderr);
  assert.deepEqual(JSON.parse(both.after).hooks.PostToolUse, [{ matcher: 'Bash|PowerShell', hooks: [hook(sibling)] }]);
});

// ── "async": true ─────────────────────────────────────────────────────────────
//
// Since 2026-10-14 the installers tell Claude Code not to wait for this hook,
// whose work is for the NEXT prompt: every Bash and PowerShell call waited
// 0.35-0.57 s on it on the development box. install.sh's ASYNC_HOOK comment has
// the measurement, the documentation, and the evidence that a client older than
// 2.1.15 strips the key rather than rejecting settings.json. The .ps1 twins are
// install cases 20-21 and uninstall case 14 in scripts/verify-installers.ps1.

test('install: a fresh registration runs in the background, in install.ps1\'s key order', (t) => {
  for (const [hookCmd, extra, command] of [[HOOK_CMD, {}, HOOK_CMD], [WIN_HOOK, VIA_NODE, WIN_COMMAND]]) {
    const settingsPath = sandbox(t);
    const run = runInstaller(settingsPath, embeddedModule(), hookCmd, extra);
    assert.equal(run.code, 0, run.stderr);
    const registered = JSON.parse(run.after).hooks.PostToolUse[0].hooks[0];
    assert.deepEqual(registered, { type: 'command', command, async: true });
    assert.deepEqual(Object.keys(registered), ['type', 'command', 'async'], 'the order install.ps1 writes');
    assert.strictEqual(registered.async, true, 'a boolean: the schema says boolean, and a string fails it');

    const again = runInstaller(settingsPath, embeddedModule(), hookCmd, extra);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.after, run.after, 'idempotent: no second write');
    assert.match(again.stdout, /already registered/);
  }
});

test('install: this checkout without the key gains it in place, and a hook that sets it itself is left alone', (t) => {
  // Absent: added at the END of the hook, so every key before it keeps its
  // place, with a notice; the neighbour in the same entry is untouched.
  const absent = sandbox(t);
  fs.writeFileSync(absent, settingsWith([
    { matcher: 'Bash|PowerShell', hooks: [hook(HOOK_CMD, { timeout: 30 }), hook('neighbour-tool')] },
  ]));
  const run = runInstaller(absent, embeddedModule());
  assert.equal(run.code, 0, run.stderr);
  const after = JSON.parse(run.after);
  assert.deepEqual(after.hooks.PostToolUse, [
    { matcher: 'Bash|PowerShell', hooks: [ours(HOOK_CMD, { timeout: 30 }), hook('neighbour-tool')] },
  ]);
  assert.deepEqual(Object.keys(after.hooks.PostToolUse[0].hooks[0]), ['type', 'command', 'timeout', 'async']);
  assert.match(run.stdout, /now runs in the background/);
  assert.doesNotMatch(run.stdout, /another checkout|repointed/);
  assertNeighboursKept(after);

  // Present, as false: the user's choice. No write, no notice.
  const optedOut = sandbox(t);
  const before = settingsWith([{ matcher: 'Bash|PowerShell', hooks: [hook(HOOK_CMD, { async: false })] }]);
  fs.writeFileSync(optedOut, before);
  const left = runInstaller(optedOut, embeddedModule());
  assert.equal(left.code, 0, left.stderr);
  assert.equal(left.after, before, 'byte-identical');
  assert.match(left.stdout, /already registered/);

  // Another checkout's that says false is repointed and still says false.
  const moved = sandbox(t);
  fs.writeFileSync(moved, settingsWith([
    { matcher: 'Bash|PowerShell', hooks: [hook('/old/checkout/bin/wildcard-perms', { async: false })] },
  ]));
  const repointed = runInstaller(moved, embeddedModule());
  assert.equal(repointed.code, 0, repointed.stderr);
  assert.deepEqual(JSON.parse(repointed.after).hooks.PostToolUse,
    [{ matcher: 'Bash|PowerShell', hooks: [hook(HOOK_CMD, { async: false })] }]);
  assert.doesNotMatch(repointed.stdout, /in the background/);

  // A duplicate that is REMOVED is not given the key first: one notice, for the keeper.
  const dupes = sandbox(t);
  fs.writeFileSync(dupes, settingsWith([
    { matcher: 'Bash|PowerShell', hooks: [hook('/old/a/bin/wildcard-perms'), hook('/old/b/bin/wildcard-perms')] },
  ]));
  const collapsed = runInstaller(dupes, embeddedModule());
  assert.equal(collapsed.code, 0, collapsed.stderr);
  assert.deepEqual(JSON.parse(collapsed.after).hooks.PostToolUse,
    [{ matcher: 'Bash|PowerShell', hooks: [ours(HOOK_CMD)] }]);
  assert.equal(collapsed.stdout.match(/in the background/g)?.length, 1, collapsed.stdout);
});

test("uninstall: this checkout's registration is removed whatever its async key says", (t) => {
  const settingsPath = sandbox(t);
  fs.writeFileSync(settingsPath, settingsWith([
    { matcher: 'Bash|PowerShell', hooks: [ours(HOOK_CMD), hook('neighbour-tool')] },
    { matcher: 'Bash', hooks: [hook(HOOK_CMD, { async: false })] },
    { matcher: 'PowerShell', hooks: [hook(`node "${HOOK_CMD}"`)] },
  ]));
  const run = runInstaller(settingsPath, embeddedUninstaller());
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /removed 3 wildcard-perms PostToolUse hooks/);
  assert.deepEqual(JSON.parse(run.after).hooks.PostToolUse,
    [{ matcher: 'Bash|PowerShell', hooks: [hook('neighbour-tool')] }]);
});
