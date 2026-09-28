'use strict';

// Killing mutations: drop hash/existence selection checks; skip suppression;
// skip durable restore intent; skip effective-policy validation; revive old
// claimants; omit backup after grant. Each test names its observable witness.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutoLearnManager } = require('../src/auto-learn-manager');
const { parseCodexRules } = require('../src/codex-rule-inventory');
const { CODEX_BEGIN_MARKER } = require('../src/policy-exporters');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-restore-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, 'custom-codex');
  const rules = path.join(codexHome, 'rules', 'permission-wildcarding.rules');
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  const create = (name = 'a', command = 'git status', extra = {}) => {
    const workspaceRoot = path.join(home, name);
    fs.mkdirSync(workspaceRoot, { recursive: true });
    return createAutoLearnManager({ home, codexHome, workspaceRoot, threshold: 1, mode: 'recommend',
      claudeSettingsPath: null, managedPolicy: { present: false, unreadable: false },
      historyScanner: () => ({ observations: [{ id: name + command, source: 'codex', tool: 'Bash',
        command, status: 'success', cwd: workspaceRoot }], cursors: {}, files: [{ source: 'codex', mode: 'full' }] }),
      codexHistoryStore: () => ({ stale: false, inspected: 'unavailable', reasons: [], notes: [] }),
      codexValidator: () => ({ valid: true, decision: 'allow' }), ...extra });
  };
  return { home, codexHome, rules, create, contents: () => fs.readFileSync(rules, 'utf8') };
}
function select(manager, predicate = () => true) {
  const file = manager.codexRestoreInventory().files.find((file) => file.restore?.some(predicate));
  assert.ok(file, 'fixture must expose a missing saved rule');
  return { path: file.path, expectedExists: file.exists, expectedHash: file.beforeHash,
    ids: file.restore.filter(predicate).map((rule) => rule.id) };
}
const declaration = (prefix, decision = 'allow') => `prefix_rule(pattern=${JSON.stringify(prefix)}, decision="${decision}")`;
function grant(manager) { manager.scan(); assert.equal(manager.applyCodex().appliedCount, 1); }

test('automatic scan backup survives complete Codex-home loss and restores literal decisions without replacing live bytes', (t) => {
  const env = fixture(t);
  const saved = ['allow', 'prompt', 'forbidden'].map((decision) => declaration(['test-' + decision], decision));
  fs.writeFileSync(env.rules, saved.join('\n') + '\n');
  const manager = env.create();
  manager.scan();
  assert.ok(fs.existsSync(manager.paths.codexBackup), 'WITNESS scan retains policy outside Codex home');
  assert.equal(path.relative(env.codexHome, manager.paths.codexBackup).startsWith('..'), true);
  fs.rmSync(env.codexHome, { recursive: true });
  const request = select(manager);
  assert.equal(request.expectedExists, false);
  assert.equal(manager.restoreCodexRules(request).restoredCount, 3);
  assert.deepEqual(parseCodexRules(env.contents()).rules.map((rule) => rule.decision).sort(), ['allow', 'forbidden', 'prompt']);
  fs.writeFileSync(env.rules, '# User text 🧭\r\n' + saved[1] + '\r\n');
  assert.equal(manager.restoreCodexRules(select(manager)).restoredCount, 2);
  assert.ok(env.contents().startsWith('# User text 🧭\r\n' + saved[1] + '\r\n'), 'WITNESS restore preserves exact live bytes');
});

test('grant is retained immediately and managed recovery preserves current owners without reviving old ones', (t) => {
  const env = fixture(t);
  const a = env.create(); const b = env.create('b', 'rg --files');
  grant(a); grant(b);
  const catalog = JSON.parse(fs.readFileSync(a.paths.codexBackup));
  assert.ok(catalog.files[0].rules.some((rule) => rule.pattern[0] === 'rg'), 'WITNESS successful grant is backed up immediately');
  const beforeClaims = JSON.parse(fs.readFileSync(a.paths.codexClaims));
  const rgClaim = Object.entries(beforeClaims.claimants).find(([, text]) => text.includes('rg'));
  const gitClaim = Object.entries(beforeClaims.claimants).find(([, text]) => text.includes('git'));
  const parsed = parseCodexRules(env.contents());
  const git = parsed.rules.find((rule) => rule.pattern[0] === 'git');
  fs.writeFileSync(env.rules, env.contents().slice(0, git.start) + env.contents().slice(git.end));
  a.restoreCodexRules(select(a, (rule) => rule.pattern[0] === 'git'));
  const after = JSON.parse(fs.readFileSync(a.paths.codexClaims));
  assert.equal(after.claimants[rgClaim[0]], rgClaim[1], 'WITNESS unrelated live claimant survives restoration');
  assert.equal(after.claimants[gitClaim[0]], undefined, 'WITNESS restoration does not revive the missing rule old owner');
  assert.match(after.baseline, /git/);
  assert.equal(b.applyCodex().changed, false, 'remaining workspace still reconciles successfully');
});

test('intentional removals suppress both narrower and broader saved allows but never erase retained restrictions', (t) => {
  const env = fixture(t); const manager = env.create();
  fs.writeFileSync(env.rules, [declaration(['git']), declaration(['git', 'status', '--short']), declaration(['git', 'push'], 'prompt')].join('\n'));
  manager.codexInventory();
  fs.writeFileSync(env.rules, declaration(['git', 'status']));
  manager.removeCodexRules({ rules: [manager.codexInventory().rules[0]] });
  const view = manager.codexRestoreInventory();
  assert.equal(view.files[0].restore.filter((rule) => rule.decision === 'allow').length, 0, 'WITNESS suppression excludes every overlapping saved allow');
  assert.equal(view.files[0].suppressed.length, 3);
  assert.equal(manager.restoreCodexRules(select(manager)).restoredCount, 1);
  assert.deepEqual(parseCodexRules(env.contents()).rules.map((rule) => rule.decision), ['prompt']);
});

test('stale file and missing-to-empty changes refuse restore before intent or policy writes', (t) => {
  const env = fixture(t); const manager = env.create();
  fs.writeFileSync(env.rules, declaration(['echo'])); manager.codexInventory(); fs.unlinkSync(env.rules);
  const absent = select(manager);
  fs.writeFileSync(env.rules, '');
  assert.throws(() => manager.restoreCodexRules(absent), /stale/, 'WITNESS absent and empty selections are distinct');
  const empty = select(manager); fs.writeFileSync(env.rules, '# edit\n');
  assert.throws(() => manager.restoreCodexRules(empty), /stale/, 'WITNESS changed hash rejects a stale selection');
  assert.equal(env.contents(), '# edit\n');
  assert.equal(fs.existsSync(manager.paths.codexRemovals), false);
});

test('current decision changes and computed or foreign generated files remain read-only', (t) => {
  const env = fixture(t); const manager = env.create();
  fs.writeFileSync(env.rules, declaration(['echo'])); manager.codexInventory();
  fs.writeFileSync(env.rules, declaration(['echo'], 'forbidden'));
  let file = manager.codexRestoreInventory().files[0];
  assert.equal(file.restore.length, 0); assert.equal(file.conflicts.length, 1);
  fs.writeFileSync(env.rules, 'prefix = ["echo"]\nprefix_rule(pattern=prefix, decision="allow")\n');
  file = manager.codexRestoreInventory().files[0];
  assert.equal(file.supported, false); assert.equal(file.restore.length, 0);
  const sibling = path.join(path.dirname(env.rules), 'other.rules');
  fs.writeFileSync(sibling, CODEX_BEGIN_MARKER + '\n' + declaration(['rg']) + '\n' + CODEX_BEGIN_MARKER.replace('BEGIN ', 'END ') + '\n');
  manager.codexInventory(); fs.unlinkSync(sibling);
  file = manager.codexRestoreInventory().files.find((entry) => entry.path.toLowerCase() === sibling.toLowerCase());
  assert.equal(file.restore.length, 0, 'WITNESS foreign generated target cannot bypass shared ownership');
  assert.equal(file.conflicts.length, 1);
});

test('effective validation refusal leaves all policy, claims and recovery state untouched', (t) => {
  const env = fixture(t); const good = env.create(); grant(good); fs.unlinkSync(env.rules);
  const selected = select(good); const claims = fs.readFileSync(good.paths.codexClaims);
  const bad = env.create('a', '', { codexValidator: () => ({ valid: false, error: 'sibling example failed' }) });
  assert.throws(() => bad.restoreCodexRules(selected), /sibling example failed/, 'WITNESS effective policy validation precedes restore writes');
  assert.equal(fs.existsSync(env.rules), false);
  assert.deepEqual(fs.readFileSync(good.paths.codexClaims), claims);
  assert.equal(fs.existsSync(good.paths.codexRemovals), false);
});

test('interrupted restore blocks every writer and resumes only its exact saved bytes', (t) => {
  const env = fixture(t); const manager = env.create(); grant(manager); fs.unlinkSync(env.rules);
  const failing = env.create('a', 'git status', { testHooks: { afterPolicyWrite: ({ kind }) => { if (kind === 'codex-restore') throw new Error('injected interruption'); } } });
  assert.throws(() => failing.restoreCodexRules(select(manager)), /injected interruption/);
  assert.equal(manager.codexRestoreInventory().pendingRestore, true, 'WITNESS restore intent is durable before its first write');
  assert.throws(() => manager.applyCodex(), /interrupted Codex restore/);
  assert.throws(() => manager.undo(), /interrupted Codex restore/);
  assert.throws(() => manager.removeCodexRules({ resume: true }), /Restore Codex rules/);
  assert.equal(manager.restoreCodexRules({ resume: true }).restoredCount, 1);
  assert.equal(manager.codexRestoreInventory().pendingRestore, false);
  assert.equal(parseCodexRules(env.contents()).rules.length, 1);
});

test('restore recovery preserves concurrent edits and retains the recovery record', (t) => {
  const env = fixture(t); const manager = env.create(); grant(manager); fs.unlinkSync(env.rules);
  const failing = env.create('a', '', { testHooks: { afterPolicyWrite: ({ kind }) => { if (kind === 'codex-restore') throw new Error('stop'); } } });
  assert.throws(() => failing.restoreCodexRules(select(manager)), /stop/);
  fs.appendFileSync(env.rules, '# after interruption\n'); const before = env.contents();
  assert.throws(() => manager.restoreCodexRules({ resume: true }), /file changed/, 'WITNESS interrupted recovery refuses concurrent edits');
  assert.equal(env.contents(), before);
  assert.equal(manager.codexRestoreInventory().pendingRestore, true);
});
