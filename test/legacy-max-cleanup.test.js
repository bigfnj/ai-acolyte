'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cleanup = require('../src/legacy-max-cleanup');
// Exact bytes written by v1.5.1. The production cleanup ships only this
// fixture's digest, never the retired auto-approve program itself.
const LEGACY_APPROVE_SCRIPT = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'legacy-approve-all.txt'), 'utf8',
);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-legacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function ownedHook(scriptPath, extra = []) {
  return {
    PreToolUse: [{
      matcher: '*',
      hooks: [
        { type: 'command', command: cleanup.legacyApproveCommandFor(scriptPath, 'win32') },
        ...extra,
      ],
    }],
  };
}

test('Claude cleanup restores the snapshot and removes only retired feature grants', (t) => {
  const root = tempDir(t);
  const statePath = path.join(root, 'wildcarding-max.json');
  const scriptPath = path.join(root, 'approve-all.js');
  writeJson(statePath, {
    allowSnapshot: ['Bash(git status *)', 'mcp__context7__query-docs'],
    defaultMode: 'auto',
  });
  const unrelated = { type: 'command', command: 'node "safe-hook.js"' };
  const settings = {
    permissions: {
      defaultMode: 'default',
      allow: [
        ...cleanup.LEGACY_ALLOW_CORE,
        'mcp__context7__*',
        'mcp__figma__*',
        'Bash(npm test *)',
      ],
      deny: ['Bash(rm -rf *)'],
    },
    hooks: ownedHook(scriptPath, [unrelated]),
  };

  const result = cleanup.removeLegacyClaudeMax(settings, {
    statePath,
    scriptPath,
    platform: 'win32',
    confirmAmbiguous: true,
  });

  assert.equal(result.changed, true);
  assert.equal(result.present, false);
  assert.equal(result.settings.permissions.defaultMode, 'auto');
  assert.deepEqual(result.settings.permissions.deny, settings.permissions.deny);
  assert.deepEqual(result.settings.permissions.allow, [
    'Bash(git status *)',
    'mcp__context7__query-docs',
    'mcp__figma__*',
    'Bash(npm test *)',
  ]);
  assert.deepEqual(result.settings.hooks.PreToolUse[0].hooks, [unrelated]);
  assert.ok(!result.removedAllow.includes('mcp__figma__*'));
  assert.ok(result.removedAllow.includes('mcp__context7__*'));
});

test('Claude cleanup removes only MCP blankets the retired feature could have generated', () => {
  assert.deepEqual(
    cleanup.legacyGeneratedAllow([
      'Bash(git status *)',
      'mcp__context7__query-docs',
      'mcp__owned__*',
    ]),
    [
      ...cleanup.LEGACY_ALLOW_CORE,
      'mcp__context7__*',
    ],
  );
});

test('a stale Claude snapshot is not ownership proof without confirmation', (t) => {
  const root = tempDir(t);
  const statePath = path.join(root, 'wildcarding-max.json');
  writeJson(statePath, { allowSnapshot: ['Bash(git status *)'], defaultMode: null });
  const settings = { permissions: { allow: ['Bash(*)', 'PowerShell(*)'] } };

  const refused = cleanup.removeLegacyClaudeMax(settings, { statePath });
  assert.equal(refused.changed, false);
  assert.deepEqual(refused.settings, settings);
  assert.ok(refused.warnings.includes('legacy-allow-ownership-ambiguous'));

  const confirmed = cleanup.removeLegacyClaudeMax(settings, {
    statePath,
    confirmAmbiguous: true,
  });
  assert.equal(confirmed.changed, true);
  assert.deepEqual(confirmed.settings.permissions.allow, ['Bash(git status *)']);
});

test('an invalid Claude snapshot leaves ambiguous blanket grants byte-for-byte', (t) => {
  const root = tempDir(t);
  const statePath = path.join(root, 'wildcarding-max.json');
  writeJson(statePath, {});
  const settings = { permissions: { allow: ['Bash(*)', 'PowerShell(*)', 'Read(*)'] } };
  const result = cleanup.removeLegacyClaudeMax(settings, {
    statePath,
    confirmAmbiguous: true,
  });
  assert.equal(result.changed, false);
  assert.deepEqual(result.settings, settings);
  assert.equal(result.snapshotValid, false);
});

test('Claude snapshot validation rejects non-string permission entries', (t) => {
  const root = tempDir(t);
  const statePath = path.join(root, 'wildcarding-max.json');
  writeJson(statePath, { allowSnapshot: ['Bash(git status *)', { permission: 'Read(*)' }] });
  const settings = { permissions: { allow: ['Bash(*)', 'PowerShell(*)'] } };
  const result = cleanup.removeLegacyClaudeMax(settings, {
    statePath,
    confirmAmbiguous: true,
  });
  assert.equal(result.changed, false);
  assert.equal(result.snapshotValid, false);
  assert.deepEqual(result.settings, settings);
});

test('Claude cleanup restores only the auto mode transition MAX actually made', (t) => {
  const root = tempDir(t);
  const scriptPath = path.join(root, 'approve-all.js');
  for (const [saved, expected] of [
    ['auto', 'auto'],
    [null, 'default'],
    ['default', 'default'],
    ['bypassPermissions', 'default'],
  ]) {
    const statePath = path.join(root, `${String(saved)}.json`);
    writeJson(statePath, { allowSnapshot: ['Bash(git status *)'], defaultMode: saved });
    const settings = {
      permissions: { allow: ['Bash(*)', 'PowerShell(*)'], defaultMode: 'default' },
      hooks: ownedHook(scriptPath),
    };
    const result = cleanup.removeLegacyClaudeMax(settings, {
      statePath,
      scriptPath,
      platform: 'win32',
      confirmAmbiguous: true,
    });
    assert.equal(result.settings.permissions.defaultMode, expected, `saved mode ${String(saved)}`);
  }
});

test('an exact hook restores a valid snapshot from every partial allow layer', (t) => {
  const root = tempDir(t);
  const statePath = path.join(root, 'wildcarding-max.json');
  const scriptPath = path.join(root, 'approve-all.js');
  writeJson(statePath, { allowSnapshot: ['Bash(git status *)'], defaultMode: 'auto' });

  for (const current of [
    ['Bash(*)', 'Read(*)'],
    ['PowerShell(*)', 'Write'],
    [],
  ]) {
    const result = cleanup.removeLegacyClaudeMax({
      permissions: { allow: current, defaultMode: 'default' },
      hooks: ownedHook(scriptPath),
    }, {
      statePath,
      scriptPath,
      platform: 'win32',
      confirmAmbiguous: true,
    });
    assert.equal(result.present, false);
    assert.deepEqual(result.settings.permissions.allow, ['Bash(git status *)']);
    assert.equal(result.settings.permissions.defaultMode, 'auto');
  }
});

test('owned hook removal preserves unrelated malformed and future hook entries', (t) => {
  const root = tempDir(t);
  const statePath = path.join(root, 'wildcarding-max.json');
  const scriptPath = path.join(root, 'approve-all.js');
  writeJson(statePath, { allowSnapshot: [] });
  const malformed = { matcher: 'foreign', hooks: { command: 'future-shape' }, extra: true };
  const scalar = 'future-entry';
  const settings = {
    permissions: { allow: ['Bash(*)'] },
    hooks: {
      PreToolUse: [
        malformed,
        scalar,
        ...ownedHook(scriptPath).PreToolUse,
      ],
    },
  };
  const result = cleanup.removeLegacyClaudeMax(settings, {
    statePath,
    scriptPath,
    platform: 'win32',
    confirmAmbiguous: true,
  });
  assert.deepEqual(result.settings.hooks.PreToolUse, [malformed, scalar]);
});

test('hook cleanup requires the exact command generated by the retired release', (t) => {
  const root = tempDir(t);
  const scriptPath = path.join(root, 'approve-all.js');
  const settings = {
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ command: 'node "somewhere/approve-all.js"' }] }] },
  };
  const status = cleanup.legacyClaudeMaxStatus(settings, { scriptPath, platform: 'win32' });
  assert.equal(status.hook, false);
  assert.equal(status.hookLike, true);
  const result = cleanup.removeLegacyClaudeMax(settings, { scriptPath, platform: 'win32' });
  assert.equal(result.changed, false);
  assert.deepEqual(result.settings, settings);
  assert.ok(result.warnings.includes('legacy-hook-ownership-ambiguous'));
});

test('approve script removal requires the exact retired file bytes', (t) => {
  const root = tempDir(t);
  const foreign = path.join(root, 'foreign.js');
  fs.writeFileSync(foreign, '// unrelated approve-all helper\n');
  assert.deepEqual(cleanup.removeLegacyApproveScript(foreign), {
    removed: false,
    reason: 'ownership-ambiguous',
  });
  assert.equal(fs.existsSync(foreign), true);

  const lookalike = path.join(root, 'lookalike.js');
  fs.writeFileSync(lookalike,
    "// permission-wildcarding MAX mode\nconst x = { permissionDecisionReason: 'permission-wildcarding MAX mode' };\n");
  assert.equal(cleanup.removeLegacyApproveScript(lookalike).reason, 'ownership-ambiguous');
  assert.equal(fs.existsSync(lookalike), true);

  const owned = path.join(root, 'owned.js');
  fs.writeFileSync(owned, LEGACY_APPROVE_SCRIPT);
  assert.deepEqual(cleanup.removeLegacyApproveScript(owned), { removed: true, reason: null });
  assert.equal(fs.existsSync(owned), false);
});

test('Codex cleanup restores on-request without changing nested tables', (t) => {
  const root = tempDir(t);
  const statePath = path.join(root, 'wildcarding-codex-max.json');
  writeJson(statePath, { priorApproval: 'on-request' });
  const text = 'model = "gpt-5"\napproval_policy = "never"\n\n[projects.demo]\ntrust_level = "trusted"\n';
  const result = cleanup.removeLegacyCodexMax(text, { statePath, confirmAmbiguous: true });
  assert.equal(result.changed, true);
  assert.equal(result.restoredTo, 'on-request');
  assert.equal(result.text,
    'model = "gpt-5"\napproval_policy = "on-request"\n\n[projects.demo]\ntrust_level = "trusted"\n');
});

test('Codex cleanup removes an extension-owned key that was previously absent', (t) => {
  const root = tempDir(t);
  const statePath = path.join(root, 'wildcarding-codex-max.json');
  writeJson(statePath, { priorApproval: null });
  const result = cleanup.removeLegacyCodexMax(
    'approval_policy = "never"\nsandbox_mode = "workspace-write"\n',
    { statePath, confirmAmbiguous: true },
  );
  assert.equal(result.changed, true);
  assert.equal(result.restoredTo, null);
  assert.equal(result.text, 'sandbox_mode = "workspace-write"\n');
});

test('Codex cleanup refuses user-owned never when no valid snapshot exists', (t) => {
  const root = tempDir(t);
  const statePath = path.join(root, 'missing.json');
  const text = 'approval_policy = "never"\nsandbox_mode = "read-only"\n';
  const result = cleanup.removeLegacyCodexMax(text, { statePath, confirmAmbiguous: true });
  assert.equal(result.changed, false);
  assert.equal(result.text, text);
  assert.ok(result.warnings.includes('legacy-codex-snapshot-missing'));
});

test('Codex snapshot validation rejects non-scalar prior approval', (t) => {
  const root = tempDir(t);
  const statePath = path.join(root, 'wildcarding-codex-max.json');
  writeJson(statePath, { priorApproval: { value: 'on-request' } });
  const text = 'approval_policy = "never"\n';
  const result = cleanup.removeLegacyCodexMax(text, { statePath, confirmAmbiguous: true });
  assert.equal(result.changed, false);
  assert.equal(result.snapshotValid, false);
  assert.equal(result.text, text);
});

test('Codex cleanup does not flatten structured or nested policy', (t) => {
  const root = tempDir(t);
  const statePath = path.join(root, 'wildcarding-codex-max.json');
  writeJson(statePath, { priorApproval: 'on-request' });
  for (const text of [
    'approval_policy = { reject = { sandbox_approval = true } }\n',
    '[projects.demo]\napproval_policy = "never"\n',
  ]) {
    const result = cleanup.removeLegacyCodexMax(text, { statePath, confirmAmbiguous: true });
    assert.equal(result.changed, false);
    assert.equal(result.text, text);
  }
});

test('retired Codex approval values are not restored into a current config', (t) => {
  const root = tempDir(t);
  const statePath = path.join(root, 'wildcarding-codex-max.json');
  writeJson(statePath, { priorApproval: 'untrusted' });
  const result = cleanup.removeLegacyCodexMax(
    'approval_policy = "never"\nmodel = "gpt-5"\n',
    { statePath, confirmAmbiguous: true },
  );
  assert.equal(result.changed, true);
  assert.equal(result.text, 'model = "gpt-5"\n');
  assert.deepEqual(result.warnings, ['legacy-prior-approval-not-restored:untrusted']);
});

test('cleanup API exports no enabling operation', () => {
  const forbidden = Object.keys(cleanup).filter((name) => /^(enable|apply|register|set)/i.test(name));
  assert.deepEqual(forbidden, []);
});
