'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', 'bin', 'wildcard-perms');
const LEGACY_APPROVE_SCRIPT = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'legacy-approve-all.txt'), 'utf8',
);

// Run the real CLI against a throwaway home, so compatibility cleanup and Auto
// Learn state land in the temp tree rather than the developer's ~/.claude.
//
// `cwd` is a parameter rather than always `home`, because the workspace a
// `--learn` invocation resolves to is a FUNCTION of the directory it was run
// from. A harness that can only run from one place cannot tell a fixed default
// from a resolved one.
function runCli(home, args, cwd = home) {
  const root = path.parse(home).root;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8', windowsHide: true,
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
    },
  });
}

function tempHome(t, allow) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-cli-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow } }, null, 2) + '\n',
  );
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

const allowList = (home) => JSON.parse(
  fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'),
).permissions.allow;

test('CLI retired --max on fails without writing policy or compatibility state', (t) => {
  const home = tempHome(t, ['Bash(git status *)', 'Bash(rg *)']);
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const before = fs.readFileSync(settingsPath);

  const on = runCli(home, ['--max', 'on']);
  assert.equal(on.status, 1, on.stdout);
  assert.match(on.stderr, /feature was removed; nothing was changed/);
  assert.equal(on.stdout, '');
  assert.ok(fs.readFileSync(settingsPath).equals(before), 'settings stay byte-identical');
  assert.equal(fs.existsSync(path.join(home, '.claude', 'backups')), false,
    'the retired enable path must not create a snapshot');
  assert.equal(fs.existsSync(path.join(home, '.claude', 'wildcarding', 'approve-all.js')), false,
    'the retired enable path must not recreate the approve hook script');
});

test('CLI retired --max off cleans an owned legacy install without losing later grants', (t) => {
  const home = tempHome(t, [
    'Bash(*)', 'PowerShell(*)', 'Read(*)', 'Edit', 'Write', 'WebFetch(*)', 'WebSearch',
    'Bash(tokei *)',
  ]);
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const statePath = path.join(home, '.claude', 'backups', 'wildcarding-max.json');
  const scriptPath = path.join(home, '.claude', 'wildcarding', 'approve-all.js');
  const backupPath = path.join(home, '.claude', 'backups', 'allow-list.latest.json');
  const mirrorPath = path.join(home, '.permission-wildcarding', 'allow-list.latest.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.mkdirSync(path.dirname(mirrorPath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    allowSnapshot: ['Bash(git status *)', 'Bash(rg *)'],
  }, null, 2) + '\n');
  fs.writeFileSync(scriptPath, LEGACY_APPROVE_SCRIPT);
  const backup = {
    allow: ['Bash(*)', 'PowerShell(*)', 'Bash(git status *)', 'Bash(tokei *)'],
    deny: ['Bash(*)'],
  };
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2) + '\n');
  fs.writeFileSync(mirrorPath, JSON.stringify(backup, null, 2) + '\n');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  settings.hooks = { PreToolUse: [{
    matcher: '*',
    hooks: [{ type: 'command', command: `node \"${scriptPath.split(path.sep).join('/')}\"` }],
  }] };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  const result = runCli(home, ['--max', 'off']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(allowList(home), ['Bash(git status *)', 'Bash(rg *)', 'Bash(tokei *)']);
  const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.equal(after.hooks?.PreToolUse, undefined, 'the exact old hook is removed');
  assert.equal(fs.existsSync(statePath), true,
    'the inert snapshot remains so a configured extension mirror can be filtered safely');
  assert.equal(fs.existsSync(scriptPath), false, 'the owned old script is removed');
  for (const file of [backupPath, mirrorPath]) {
    const cleaned = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(cleaned.allow, ['Bash(git status *)', 'Bash(tokei *)']);
    assert.deepEqual(cleaned.deny, ['Bash(*)'], 'allow cleanup never changes deny');
  }
});

test('CLI --learn honors explicit workspace partition and Codex off scope', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-cli-'));
  const workspace = path.join(home, 'workspaces', 'sample');
  const settings = path.join(home, '.claude', 'settings.json');
  const codexRules = path.join(home, '.codex', 'rules', 'permission-wildcarding.rules');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.mkdirSync(path.dirname(codexRules), { recursive: true });
  fs.writeFileSync(settings, '{"permissions":{"allow":["ManualSentinel"]}}\n');
  fs.writeFileSync(codexRules, '# manual Codex sentinel\n');
  const settingsBefore = fs.readFileSync(settings, 'utf8');
  const codexBefore = fs.readFileSync(codexRules, 'utf8');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const root = path.parse(home).root;
  const result = spawnSync(process.execPath, [
    path.resolve(__dirname, '..', 'bin', 'wildcard-perms'),
    '--learn', 'status', '--mode', 'recommend',
    '--workspace', workspace, '--codex-scope', 'off',
  ], {
    cwd: path.dirname(workspace), encoding: 'utf8', windowsHide: true,
    env: {
      ...process.env, HOME: home, USERPROFILE: home,
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const status = JSON.parse(result.stdout);
  assert.equal(path.resolve(status.paths.claudeSettings), path.resolve(settings));
  assert.equal(status.paths.codexRules, null);
  assert.equal(path.dirname(status.paths.state), path.join(home, '.claude', 'wildcarding'));
  assert.match(path.basename(status.paths.state), /^auto-learn-state\.[0-9a-f]{16}\.json$/);
  assert.equal(fs.existsSync(status.paths.state), true);
  assert.equal(fs.readFileSync(settings, 'utf8'), settingsBefore);
  assert.equal(fs.readFileSync(codexRules, 'utf8'), codexBefore);
  assert.equal(fs.existsSync(
    path.join(workspace, '.codex', 'rules', 'permission-wildcarding.rules'),
  ), false);
});

// ── which workspace `--learn` reads when nobody says ──────────────────────────
//
// The state file is partitioned by a hash of the workspace root, the extension's
// root is the VS Code workspace FOLDER, and the CLI used to default that to
// `process.cwd()`. Run from anywhere but that exact folder — a subdirectory, a
// git worktree, the terminal's last `cd` — it keyed a different and usually
// absent file and printed zeros, which reads as "Auto Learn is doing nothing"
// rather than "you are looking at the wrong file". Measured on the development
// box before the fix: the CLI read `auto-learn-state.397b082565ea6f56.json`
// (absent) while the extension wrote `auto-learn-state.4a20f158639aa72c.json`
// (613 candidates). scripts/smoke.sh has the live-machine half of this gate.

// Create the state partition for `workspace` the way the product does — through
// the CLI, so the hashed filename is never spelled out in a test — and return
// its path. `--mode` is what makes setMode() save on a partition that has none.
function seedWorkspaceState(home, workspace) {
  fs.mkdirSync(workspace, { recursive: true });
  const seeded = runCli(home, [
    '--learn', 'status', '--mode', 'recommend', '--workspace', workspace, '--codex-scope', 'off',
  ]);
  assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
  const statePath = JSON.parse(seeded.stdout).paths.state;
  assert.equal(fs.existsSync(statePath), true, 'precondition: the partition was created');
  return statePath;
}

// A partition that has been SCANNED, as opposed to the stub a mode change leaves.
function markScanned(statePath, at) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  state.lastScanAt = at;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
}

const stateOf = (result) => {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).paths.state;
};

test('CLI --learn reads the workspace state from a subdirectory of that workspace', (t) => {
  const home = tempHome(t, ['Bash(git status *)']);
  const workspace = path.join(home, 'workspaces', 'sample');
  const statePath = seedWorkspaceState(home, workspace);
  markScanned(statePath, '2026-09-24T00:00:00.000Z');

  // Deep enough that no plausible accident lands on it: four levels below the
  // workspace root, which is an ordinary place to be standing in a repo.
  const deep = path.join(workspace, 'src', 'a', 'b', 'c');
  fs.mkdirSync(deep, { recursive: true });

  const status = JSON.parse(runCli(home, ['--learn', 'status'], deep).stdout);
  assert.equal(status.paths.state, statePath,
    'the CLI read a different partition than the one that owns the directory it ran in');
  assert.equal(status.lastScanAt, '2026-09-24T00:00:00.000Z',
    'and it read that partition’s contents, not a fresh empty state that happens '
    + 'to share the filename');

  // MUTATION: restore the old default in bin/wildcard-perms — `workspaceRootFor`
  // returning `path.resolve(process.cwd())` instead of inferWorkspaceRoot(...) —
  // and this fails with the state path keyed on `deep` rather than `workspace`.
});

test('CLI --learn still obeys an explicit --workspace over the inferred one', (t) => {
  const home = tempHome(t, ['Bash(git status *)']);
  const outer = path.join(home, 'workspaces', 'outer');
  const inner = path.join(outer, 'nested', 'inner');
  const outerState = seedWorkspaceState(home, outer);
  markScanned(outerState, '2026-09-24T00:00:00.000Z');
  const innerState = seedWorkspaceState(home, inner);
  markScanned(innerState, '2026-09-24T00:00:01.000Z');
  assert.notEqual(outerState, innerState, 'precondition: two distinct partitions');

  // Standing in the outer workspace, asking for the inner one by name.
  assert.equal(stateOf(runCli(home, ['--learn', 'status', '--workspace', inner], outer)),
    innerState, 'an explicit --workspace must win over anything inference would pick');
  // And the other direction, from inside the inner one.
  assert.equal(stateOf(runCli(home, ['--learn', 'status', '--workspace', outer], inner)),
    outerState);

  // MUTATION: make workspaceRootFor ignore the explicit value (always infer) and
  // both assertions fail, each naming the other partition.
});

test('CLI --learn prefers a scanned ancestor to a nearer unscanned stub', (t) => {
  const home = tempHome(t, ['Bash(git status *)']);
  const outer = path.join(home, 'workspaces', 'outer');
  const inner = path.join(outer, 'nested', 'inner');
  const outerState = seedWorkspaceState(home, outer);
  markScanned(outerState, '2026-09-24T00:00:00.000Z');
  // The stub: opening a subdirectory in VS Code is enough to create one, because
  // setMode() saves a partition that has none. It is nearer AND useless.
  const innerState = seedWorkspaceState(home, inner);
  assert.equal(JSON.parse(fs.readFileSync(innerState, 'utf8')).lastScanAt ?? null, null,
    'precondition: the nearer partition has never been scanned');

  assert.equal(stateOf(runCli(home, ['--learn', 'status'], inner)), outerState,
    'the nearest partition won even though it has nothing in it');

  // MUTATION: drop the stateWasScanned() preference from inferWorkspaceRoot —
  // `if (fs.existsSync(statePath)) return dir;` — and this fails, reading the
  // empty inner stub. The other two tests in this group stay green under that
  // mutation, which is why this one exists separately.
});

test('CLI --learn never adopts the state of a workspace it is not inside', (t) => {
  const home = tempHome(t, ['Bash(git status *)']);
  const stranger = path.join(home, 'workspaces', 'someone-elses-project');
  const strangerState = seedWorkspaceState(home, stranger);
  markScanned(strangerState, '2026-09-24T00:00:00.000Z');

  // A sibling with no partition of its own. The only scanned state on this
  // machine belongs to a project that does NOT contain this directory.
  const mine = path.join(home, 'workspaces', 'mine');
  fs.mkdirSync(mine, { recursive: true });

  const status = JSON.parse(runCli(home, ['--learn', 'status'], mine).stdout);
  assert.notEqual(status.paths.state, strangerState,
    'reporting another project’s candidates as this one’s is worse than reporting '
    + 'none: every count, every applied grant and every Undo target would be theirs');
  assert.equal(status.candidateCount, 0, 'an unscanned workspace reports nothing, honestly');

  // MUTATION: widen the walk from "each ancestor" to "each ancestor and its
  // child directories" — the obvious way to find a workspace the terminal is
  // merely NEXT to, and a change the three tests above all survive — and this
  // one fails, adopting the stranger's partition.
});
