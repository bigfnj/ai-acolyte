'use strict';

// The backup exists to survive a managed-settings refresh that resets
// settings.json. Restoring the allow list alone hands every permission back with
// the deny list — the boundary bypass mode and auto-safe both defer to —
// still missing, which is worse than not restoring. These drive the real commands
// through the extension against a throwaway home.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

function disposable() { return { dispose() {} }; }

// Purge extension.js AND every src/ module it pulls in. See the long note in
// test/extension-activation.test.js: `delete require.cache[extensionPath]` alone
// leaves every src/ module holding the FIRST harness's `os` stub, so a later
// activation in this file resolves `home = os.homedir()` defaults to an earlier
// test's temp home — which t.after has already deleted, so the write re-creates
// it and leaks a directory into %TEMP% on every run.
function purgeProjectModules(extensionPath, rootSrc) {
  const extensionDir = path.dirname(extensionPath) + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(rootSrc + path.sep) || key.startsWith(extensionDir)) {
      delete require.cache[key];
    }
  }
}

function harness(tempHome) {
  const commands = new Map();
  const warnings = [];
  const warningAnswers = [];
  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    RelativePattern: class RelativePattern {
      constructor(base, pattern) { this.base = base; this.pattern = pattern; }
    },
    StatusBarAlignment: { Right: 2 },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    Uri: { file: (fsPath) => ({ fsPath }) },
    commands: {
      registerCommand(id, handler) { commands.set(id, handler); return disposable(); },
      executeCommand() {},
    },
    window: {
      createStatusBarItem() { return { hide() {}, show() {}, dispose() {} }; },
      registerWebviewViewProvider() { return disposable(); },
      setStatusBarMessage() {},
      showErrorMessage() {},
      showInformationMessage() { return Promise.resolve(undefined); },
      showWarningMessage(message) {
        warnings.push(message);
        return Promise.resolve(warningAnswers.length ? warningAnswers.shift() : undefined);
      },
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: path.join(tempHome, 'workspace') } }],
      createFileSystemWatcher(pattern) {
        return { pattern, onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} };
      },
      getConfiguration() {
        return {
          // Auto Learn off: these tests are about the backup, not the learner.
          get: (key, fallback) => (key === 'autoLearn.enabled' ? false : fallback),
          inspect: () => ({}),
          update: async () => {},
        };
      },
      onDidChangeConfiguration() { return disposable(); },
      onDidChangeWorkspaceFolders() { return disposable(); },
    },
  };

  const extensionPath = require.resolve('../vscode-extension/extension');
  const rootSrc = path.resolve(__dirname, '..', 'src');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => tempHome };
    if (parent?.filename === extensionPath && request.startsWith('./src/')) {
      return originalLoad.call(this, path.join(rootSrc, request.slice('./src/'.length)), parent, isMain);
    }
    if (request === './memoryLint' && parent?.filename === extensionPath) {
      return {
        MemoryLint: class MemoryLint { activate() {} onReconcile() { return { dispose() {} }; } },
        memoryReport: () => ({ conf: {}, dir: null, report: null }),
        cfg: () => ({ enabled: true, dir: '', lineBudget: 300, totalBudget: 12000, maxLines: 200 }),
        discoverDirs: () => [],
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  purgeProjectModules(extensionPath, rootSrc);
  const extension = require(extensionPath);
  extension.activate({ subscriptions: [] });
  return {
    commands,
    extension,
    warnings,
    warningAnswers,
    async dispose() {
      await extension.deactivate();
      Module._load = originalLoad;
      purgeProjectModules(extensionPath, rootSrc);
    },
  };
}

function setup(t) {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-backup-'));
  fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
  t.after(() => fs.rmSync(tempHome, { recursive: true, force: true }));
  const settingsPath = path.join(tempHome, '.claude', 'settings.json');
  const backupPath = path.join(tempHome, '.claude', 'backups', 'allow-list.latest.json');
  // The off-tree mirror's default, resolved against the mocked home so these
  // stay hermetic — nothing here may touch the real ~/.permission-wildcarding.
  const mirrorPath = path.join(tempHome, '.permission-wildcarding', 'allow-list.latest.json');
  return {
    tempHome,
    settingsPath,
    backupPath,
    mirrorPath,
    write: (value) => fs.writeFileSync(settingsPath, JSON.stringify(value, null, 2) + '\n'),
    read: () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')),
  };
}

const DENY = ['Bash(rm -rf /*)', 'Bash(mkfs* *)', 'Bash(dd * of=/dev/*)'];
const RETIRED_CORE = [
  'Bash(*)', 'PowerShell(*)', 'Read(*)', 'Edit', 'Write', 'WebFetch(*)', 'WebSearch',
];

// Materialise the exact on-disk shape written by v1.5.1. The current product
// cannot create this state; it can only recognise and remove it after the user
// confirms the migration.
function writeRetiredFixture(env, { snapshot, current, deny = DENY, defaultMode = 'default' }) {
  const statePath = path.join(env.tempHome, '.claude', 'backups', 'wildcarding-max.json');
  const scriptPath = path.join(env.tempHome, '.claude', 'wildcarding', 'approve-all.js');
  const command = `node "${scriptPath.replace(/\\/g, '/')}"`;

  env.write({
    model: 'claude-opus-5',
    permissions: { allow: current, deny, defaultMode },
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'neighbour-tool' }] }],
    },
  });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    allowSnapshot: snapshot,
    defaultMode: null,
    savedAt: '2026-09-01T00:00:00.000Z',
  }, null, 2) + '\n');
  return { statePath, command };
}

function writeBackupCopies(env, allow, deny = DENY) {
  const body = JSON.stringify({ allow, deny }, null, 2) + '\n';
  fs.mkdirSync(path.dirname(env.backupPath), { recursive: true });
  fs.mkdirSync(path.dirname(env.mirrorPath), { recursive: true });
  fs.writeFileSync(env.backupPath, body);
  fs.writeFileSync(env.mirrorPath, body);
}

async function confirmRetiredCleanup(app) {
  app.warningAnswers.push('Review legacy cleanup', 'Remove legacy configuration');
  await app.commands.get('permission-wildcarding.toggleMax')();
}

test('a policy wipe restores the deny list, not just the allow list', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)', 'Bash(rg *)'], deny: DENY } });

  const app = harness(env.tempHome);
  try {
    // Populates the backup from live settings.
    await app.commands.get('permission-wildcarding.runNow')();

    const saved = JSON.parse(fs.readFileSync(env.backupPath, 'utf8'));
    assert.deepEqual(saved.deny, DENY, 'the backup must capture deny, not only allow');

    // An org policy refresh resets settings.json.
    env.write({ permissions: { allow: [], deny: [] } });
    await app.commands.get('permission-wildcarding.restoreBackup')();

    const after = env.read().permissions;
    assert.deepEqual(after.allow, ['Bash(git status *)', 'Bash(rg *)']);
    assert.deepEqual(after.deny, DENY, 'restoring allow without deny leaves no killswitch');
  } finally {
    await app.dispose();
  }
});

test('a pre-1.12 allow-only backup still restores, and upgrades in place', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: DENY } });
  // The legacy on-disk shape is a bare array.
  fs.mkdirSync(path.dirname(env.backupPath), { recursive: true });
  fs.writeFileSync(env.backupPath, JSON.stringify(['Bash(tokei *)'], null, 2) + '\n');

  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.restoreBackup')();
    const after = env.read().permissions;
    assert.deepEqual(after.allow, ['Bash(tokei *)'], 'legacy array must still be readable');
    assert.deepEqual(after.deny, DENY, 'a legacy backup must not clear a live deny list');

    // The write path upgrades the file to the { allow, deny } shape.
    const saved = JSON.parse(fs.readFileSync(env.backupPath, 'utf8'));
    assert.equal(Array.isArray(saved), false);
    assert.deepEqual(saved.allow, ['Bash(tokei *)']);
    assert.deepEqual(saved.deny, DENY);
  } finally {
    await app.dispose();
  }
});

test('settings with no deny key never gain an empty one', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)'] } });

  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.runNow')();
    await app.commands.get('permission-wildcarding.restoreBackup')();
    assert.equal(
      Object.prototype.hasOwnProperty.call(env.read().permissions, 'deny'), false,
      'writing an empty deny key would misrepresent the user policy',
    );
  } finally {
    await app.dispose();
  }
});

test('confirmed legacy cleanup purges owned blanket entries from both backups', async (t) => {
  const env = setup(t);
  const userPerms = ['Bash(git status *)', 'Bash(rg *)'];
  const legacyAllow = [...RETIRED_CORE, 'Bash(git status *)'];
  const deny = [...DENY, 'Bash(*)'];
  const fixture = writeRetiredFixture(env, { snapshot: userPerms, current: legacyAllow, deny });
  writeBackupCopies(env, [...new Set([...userPerms, ...legacyAllow])], deny);

  const app = harness(env.tempHome);
  try {
    await confirmRetiredCleanup(app);

    const live = env.read();
    const primary = JSON.parse(fs.readFileSync(env.backupPath, 'utf8'));
    const mirror = JSON.parse(fs.readFileSync(env.mirrorPath, 'utf8'));
    assert.ok(!live.permissions.allow.includes('Bash(*)'));
    assert.ok(!primary.allow.includes('Bash(*)'), 'the primary must not reassert a removed grant');
    assert.ok(!mirror.allow.includes('Bash(*)'), 'the mirror must not reassert a removed grant');
    assert.ok(!primary.allow.includes('PowerShell(*)'));
    assert.ok(!mirror.allow.includes('PowerShell(*)'));
    assert.ok(live.permissions.deny.includes('Bash(*)'), 'an identically spelled deny remains live');
    assert.ok(primary.deny.includes('Bash(*)'), 'allow cleanup must not purge the primary deny list');
    assert.ok(mirror.deny.includes('Bash(*)'), 'allow cleanup must not purge the mirrored deny list');
    for (const p of userPerms) {
      assert.ok(live.permissions.allow.includes(p), `live user permission ${p} must survive cleanup`);
      assert.ok(primary.allow.includes(p), `primary must retain user permission ${p}`);
      assert.ok(mirror.allow.includes(p), `mirror must retain user permission ${p}`);
    }
    assert.ok(live.hooks.PostToolUse, 'an unrelated hook must survive cleanup');
    assert.equal(live.hooks.PreToolUse, undefined, 'the exactly owned approve hook is removed');
    assert.equal(fs.existsSync(fixture.statePath), false, 'the consumed migration snapshot is removed');
  } finally {
    await app.dispose();
  }
});

// A valid snapshot is provenance. Entries present both in that snapshot and the
// retired blanket set belong to the user; cleanup must restore them and retain
// their backup cover while removing only additions absent from the snapshot.
test('legacy cleanup keeps overlapping user grants recorded by the snapshot', async (t) => {
  const env = setup(t);
  const held = ['Read(*)', 'Edit', 'WebSearch', 'mcp__context7__*'];
  const userPerms = ['Bash(git status *)', 'Bash(rg *)', ...held];
  const legacyAllow = [...RETIRED_CORE, 'mcp__context7__*'];
  writeRetiredFixture(env, { snapshot: userPerms, current: legacyAllow });
  writeBackupCopies(env, [...new Set([...userPerms, ...legacyAllow])]);

  const app = harness(env.tempHome);
  try {
    await confirmRetiredCleanup(app);
    const live = env.read().permissions.allow;
    const saved = JSON.parse(fs.readFileSync(env.backupPath, 'utf8')).allow;

    for (const permission of held) {
      assert.ok(live.includes(permission), `${permission} is restored from the ownership snapshot`);
      assert.ok(saved.includes(permission), `${permission} is the user's and keeps its backup cover`);
    }
    for (const added of ['Bash(*)', 'PowerShell(*)', 'Write', 'WebFetch(*)']) {
      assert.ok(!live.includes(added), `cleanup removes owned ${added}`);
      assert.ok(!saved.includes(added), `${added} must not remain available for reassertion`);
    }
  } finally {
    await app.dispose();
  }
});

// The two broad grants are not ownership proof by themselves. A user may have
// chosen them directly, so ordinary backup restoration must preserve them when
// no valid cleanup fixture proves that the retired feature created them.
test('backup restore preserves legitimate broad grants without cleanup evidence', async (t) => {
  const env = setup(t);
  const userPerms = ['Bash(*)', 'PowerShell(*)'];
  env.write({ permissions: { allow: [], deny: DENY } });

  fs.mkdirSync(path.dirname(env.backupPath), { recursive: true });
  fs.writeFileSync(env.backupPath, JSON.stringify({
    allow: userPerms,
    deny: DENY,
  }) + '\n');

  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.restoreBackup')();
    const after = env.read().permissions;
    for (const p of userPerms) {
      assert.ok(after.allow.includes(p), `legitimate permission ${p} must be restored`);
    }
  } finally {
    await app.dispose();
  }
});

test('startup policy recovery cannot resurrect MAX grants from a dormant backup', async (t) => {
  const env = setup(t);
  const snapshot = [
    'Bash(git status *)', 'Bash(rg *)', 'Bash(tokei *)', 'Read(src/**)', 'WebSearch',
  ];
  env.write({ permissions: { allow: [], deny: [] } });
  const statePath = path.join(env.tempHome, '.claude', 'backups', 'wildcarding-max.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ allowSnapshot: snapshot }, null, 2) + '\n');
  writeBackupCopies(env, [...snapshot, ...RETIRED_CORE]);

  const app = harness(env.tempHome);
  try {
    const live = env.read().permissions.allow;
    for (const permission of snapshot) assert.ok(live.includes(permission));
    for (const permission of RETIRED_CORE.filter((entry) => !snapshot.includes(entry))) {
      assert.ok(!live.includes(permission), `${permission} must stay masked during startup restore`);
    }
    assert.equal(fs.existsSync(statePath), true,
      'the snapshot remains until both physical backup copies are explicitly cleaned');
  } finally {
    await app.dispose();
  }
});

test('activation retains every legacy artifact when a policy file is unreadable', async (t) => {
  const env = setup(t);
  fs.writeFileSync(env.settingsPath, '{ half-written');
  const statePath = path.join(env.tempHome, '.claude', 'backups', 'wildcarding-max.json');
  const scriptPath = path.join(env.tempHome, '.claude', 'wildcarding', 'approve-all.js');
  const codexStatePath = path.join(env.tempHome, '.claude', 'backups', 'wildcarding-codex-max.json');
  const codexPath = path.join(env.tempHome, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.mkdirSync(codexPath, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ allowSnapshot: [] }) + '\n');
  fs.writeFileSync(codexStatePath, JSON.stringify({ priorApproval: 'on-request' }) + '\n');
  fs.writeFileSync(scriptPath, 'foreign bytes that cleanup must not inspect after a read failure\n');

  const app = harness(env.tempHome);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fs.existsSync(statePath), true);
    assert.equal(fs.existsSync(codexStatePath), true);
    assert.equal(fs.existsSync(scriptPath), true);
  } finally {
    await app.dispose();
  }
});

// ── ownership evidence ────────────────────────────────────────────────────────
// Values that can also be chosen directly do not prove that this extension owns
// them. Activation must stay silent until an exact old hook or valid snapshot
// provides evidence.

test('activation does not prompt for broad grants or Codex never without ownership evidence', async (t) => {
  const env = setup(t);
  const allow = ['Bash(*)', 'PowerShell(*)', 'Bash(git status *)'];
  env.write({ permissions: { allow, deny: DENY } });
  const codexPath = path.join(env.tempHome, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  fs.writeFileSync(codexPath, 'approval_policy = "never"\nmodel = "gpt-5.4"\n');
  const beforeCodex = fs.readFileSync(codexPath, 'utf8');

  const app = harness(env.tempHome);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(!app.warnings.some((message) => message.includes('configuration shaped like the retired')),
      'automatic migration must not ask based only on values the user can choose independently');
    const afterAllow = env.read().permissions.allow;
    assert.ok(afterAllow.includes('Bash(*)'), 'activation leaves the broad Bash grant untouched');
    assert.ok(afterAllow.includes('PowerShell(*)'), 'activation leaves the broad PowerShell grant untouched');
    assert.equal(fs.readFileSync(codexPath, 'utf8'), beforeCodex,
      'activation leaves an independently chosen Codex policy untouched');
  } finally {
    await app.dispose();
  }
});

test('stale snapshots plus later broad choices never trigger automatic cleanup', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(*)', 'PowerShell(*)'], deny: DENY } });
  const backupDir = path.join(env.tempHome, '.claude', 'backups');
  const claudeState = path.join(backupDir, 'wildcarding-max.json');
  const codexState = path.join(backupDir, 'wildcarding-codex-max.json');
  const codexPath = path.join(env.tempHome, '.codex', 'config.toml');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(path.dirname(codexPath), { recursive: true });
  fs.writeFileSync(claudeState, JSON.stringify({
    allowSnapshot: ['Bash(git status *)'], defaultMode: null,
  }) + '\n');
  fs.writeFileSync(codexState, JSON.stringify({ priorApproval: 'on-request' }) + '\n');
  fs.writeFileSync(codexPath, 'approval_policy = "never"\nmodel = "gpt-5.6-sol"\n');
  const settingsBefore = fs.readFileSync(env.settingsPath);
  const codexBefore = fs.readFileSync(codexPath);

  const app = harness(env.tempHome);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(fs.readFileSync(env.settingsPath).equals(settingsBefore));
    assert.ok(fs.readFileSync(codexPath).equals(codexBefore));
    assert.equal(app.warnings.some((message) => /legacy cleanup/i.test(message)), false);
    assert.equal(fs.existsSync(claudeState), true);
    assert.equal(fs.existsSync(codexState), true);
  } finally {
    await app.dispose();
  }
});

// ── the off-tree mirror ────────────────────────────────────────────────────────────────────────────────
// Observed 2026-09-09: every directory under ~/.claude was recreated, so the
// primary backup went with the thing it exists to protect. These cover the
// recovery that failure needs, and the two ways a second copy goes wrong.
test('the backup is mirrored outside ~/.claude', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: ['Bash(git status *)', 'Bash(rg *)'], deny: DENY } });

  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.runNow')();

    const mirrored = JSON.parse(fs.readFileSync(env.mirrorPath, 'utf8'));
    assert.deepEqual(mirrored.deny, DENY, 'the mirror must carry deny, not only allow');
    assert.deepEqual(mirrored, JSON.parse(fs.readFileSync(env.backupPath, 'utf8')),
      'the two copies must be byte-identical, or restore depends on which one is read');
    // The whole point: outside the directory whose reset it survives.
    assert.ok(!env.mirrorPath.startsWith(path.join(env.tempHome, '.claude')),
      'a mirror inside ~/.claude protects against nothing');
  } finally {
    await app.dispose();
  }
});

test('losing all of ~/.claude still restores, from the mirror', async (t) => {
  const env = setup(t);
  const userPerms = ['Bash(git status *)', 'Bash(rg *)'];
  env.write({ permissions: { allow: userPerms, deny: DENY } });

  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.runNow')();
    assert.ok(fs.existsSync(env.mirrorPath), 'precondition: the mirror was written');

    // The actual failure, not a settings rewrite: the directory is recreated,
    // so settings.json AND backups/ are gone together.
    fs.rmSync(path.join(env.tempHome, '.claude'), { recursive: true, force: true });
    fs.mkdirSync(path.join(env.tempHome, '.claude'), { recursive: true });
    env.write({ permissions: { allow: [], deny: [] } });
    assert.ok(!fs.existsSync(env.backupPath), 'precondition: the primary backup is gone');

    await app.commands.get('permission-wildcarding.restoreBackup')();

    const after = env.read().permissions;
    for (const p of userPerms) {
      assert.ok(after.allow.includes(p), `${p} must come back from the mirror`);
    }
    assert.deepEqual(after.deny, DENY, 'deny must travel with allow off the mirror too');
  } finally {
    await app.dispose();
  }
});

// The reason readBackup falls back rather than unioning. A stale mirror is the
// normal state after upgrading from a version that wrote only the primary, or
// after the mirror path changes -- and a union read would treat whatever it still
// holds as part of the high-water mark, handing back the entry the user pruned.
// Asserts the absolute answer (the entry stays gone), not that two reads agree.
test('a stale mirror cannot resurrect an entry pruned from the primary', async (t) => {
  const env = setup(t);
  env.write({ permissions: { allow: [], deny: DENY } });

  // Primary is authoritative and no longer holds the pruned entry.
  fs.mkdirSync(path.dirname(env.backupPath), { recursive: true });
  fs.writeFileSync(env.backupPath,
    JSON.stringify({ allow: ['Bash(rg *)'], deny: DENY }, null, 2) + '\n');
  // The mirror lagged and still does.
  fs.mkdirSync(path.dirname(env.mirrorPath), { recursive: true });
  fs.writeFileSync(env.mirrorPath,
    JSON.stringify({ allow: ['Bash(rg *)', 'Bash(curl *)'], deny: DENY }, null, 2) + '\n');

  const app = harness(env.tempHome);
  try {
    await app.commands.get('permission-wildcarding.restoreBackup')();
    const after = env.read().permissions;
    assert.ok(after.allow.includes('Bash(rg *)'), 'the primary\'s entries must restore');
    assert.ok(!after.allow.includes('Bash(curl *)'),
      'a stale mirror entry must not come back: the primary, when present, is the whole answer');
  } finally {
    await app.dispose();
  }
});

test('legacy cleanup preserves MCP blankets for servers introduced after MAX', async (t) => {
  // Old MAX generated a blanket only for servers represented in the pre-MAX
  // snapshot. A current-only server blanket is therefore a later user/learner
  // grant, while context7's blanket is an owned generated addition.
  const env = setup(t);
  const snapshot = ['Bash(git status *)', 'mcp__context7__query-docs'];
  const legacyAllow = [...RETIRED_CORE, 'mcp__context7__*', 'mcp__figma__*'];
  writeRetiredFixture(env, { snapshot, current: legacyAllow });
  writeBackupCopies(env, [...new Set([...snapshot, ...legacyAllow])]);

  const app = harness(env.tempHome);
  try {
    await confirmRetiredCleanup(app);
    const live = env.read().permissions.allow;
    const saved = JSON.parse(fs.readFileSync(env.backupPath, 'utf8')).allow;

    assert.ok(live.includes('mcp__figma__*'),
      'the later figma blanket must survive live cleanup');
    assert.ok(saved.includes('mcp__figma__*'),
      'the later figma blanket must keep its backup cover');

    assert.ok(!saved.includes('mcp__context7__*'),
      'a generated context7 blanket leaves the backup');
    assert.ok(saved.includes('mcp__context7__query-docs'),
      'the user\u2019s specific context7 grant keeps its backup cover');
    assert.ok(live.includes('mcp__context7__query-docs'),
      'the user\u2019s specific context7 grant is restored live');
  } finally {
    await app.dispose();
  }
});
