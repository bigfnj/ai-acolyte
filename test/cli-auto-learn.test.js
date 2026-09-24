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
function runCli(home, args) {
  const root = path.parse(home).root;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: home, encoding: 'utf8', windowsHide: true,
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
