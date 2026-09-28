'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutoLearnManager } = require('../src/auto-learn-manager');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-shared-claims-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const rules = path.join(codexHome, 'rules', 'permission-wildcarding.rules');
  const original = '# Fixture user-owned policy text.\n';
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(rules, original);
  const create = (name, command, options = {}) => {
    const workspaceRoot = path.join(home, 'workspaces', name);
    fs.mkdirSync(workspaceRoot, { recursive: true });
    return createAutoLearnManager({
      home, codexHome, workspaceRoot, codexRulesPath: rules, claudeSettingsPath: null,
      mode: 'recommend', threshold: 1, managedPolicy: { present: false, unreadable: false },
      historyScanner: () => ({
        observations: [{ id: name + '-call', source: 'codex', tool: 'Bash',
          command, status: 'success', cwd: workspaceRoot }],
        cursors: {}, files: [{ source: 'codex', mode: 'full' }],
      }),
      codexHistoryStore: () => ({ stale: false, inspected: 'unavailable', reasons: [], notes: [] }),
      // This isolates shared-writer behavior. Real execpolicy validation is
      // covered by the Codex contract/runtime checks, not replaced by this test.
      codexValidator: () => ({ valid: true, decision: 'allow' }),
      ...options,
    });
  };
  return { home, rules, original, create, text: () => fs.readFileSync(rules, 'utf8') };
}

function apply(manager) {
  manager.scan();
  const result = manager.applyCodex();
  assert.equal(result.appliedCount, 1, 'fixture must actually apply one Codex family');
  assert.equal(manager.status().applied.codex.length, 1);
}

const GIT_STATUS = /^\s*pattern = \["git", "status"\],$/m;
const RG_FILES = /^\s*pattern = \["rg", "--files"\],$/m;

// Killing mutation: render only this workspace's nextCodex instead of retaining
// other workspaces' target-specific grants in the shared generated block.
test('a second workspace preserves unrelated grants in the shared Codex rules file', (t) => {
  const env = fixture(t);
  const first = env.create('a', 'git status');
  const second = env.create('b', 'rg --files');
  assert.notEqual(first.paths.state, second.paths.state);
  assert.equal(first.paths.lock, second.paths.lock);
  assert.equal(first.paths.codexRules, second.paths.codexRules);
  apply(first);
  assert.match(env.text(), GIT_STATUS, 'precondition: workspace A installed git status');
  apply(second);
  assert.match(env.text(), RG_FILES, 'precondition: workspace B installed rg --files');
  assert.match(env.text(), GIT_STATUS,
    'WITNESS applying workspace B must preserve workspace A Codex grant');
  assert.ok(env.text().startsWith(env.original), 'manual policy text must survive both writes');
  assert.deepEqual(env.create('a', 'git status').status().applied.codex, ['bash:git status']);
  assert.deepEqual(env.create('b', 'rg --files').status().applied.codex, ['bash:rg --files']);
  const shared = env.text();
  const claims = fs.readFileSync(first.paths.codexClaims);
  const firstState = fs.readFileSync(first.paths.state);
  const secondState = fs.readFileSync(second.paths.state);
  assert.throws(() => env.create('a', 'git status').undo(), /policy changed after Auto Learn wrote it/);
  assert.equal(env.text(), shared);
  assert.deepEqual(fs.readFileSync(first.paths.codexClaims), claims);
  assert.deepEqual(fs.readFileSync(first.paths.state), firstState);
  assert.deepEqual(fs.readFileSync(second.paths.state), secondState);
  assert.deepEqual(env.create('b', 'rg --files').undo().restoredTargets, ['codex']);
  assert.match(env.text(), GIT_STATUS);
  assert.doesNotMatch(env.text(), RG_FILES);
  assert.equal(env.create('a', 'git status').undo().undone, true);
  assert.equal(env.text(), env.original);
});

// Killing mutation: restore the first writer's raw pre-apply snapshot without
// noticing the second workspace now owns the exact same unchanged rule bytes.
test('Undo cannot revoke an identical Codex prefix claimed by another workspace', (t) => {
  const env = fixture(t);
  const first = env.create('a', 'git status');
  const second = env.create('b', 'git status');
  apply(first);
  apply(second);
  const beforeUndo = env.text();
  const firstState = fs.readFileSync(first.paths.state);
  const secondState = fs.readFileSync(second.paths.state);
  const claims = fs.readFileSync(first.paths.codexClaims);
  let refusal;
  try {
    assert.equal(env.create('a', 'git status').undo().undone, true);
  } catch (error) {
    refusal = error;
  }
  if (refusal) {
    assert.match(refusal.message, /other workspace|shared|claim|policy changed after Auto Learn wrote it/i,
      'a conservative refusal must explain the shared ownership conflict');
    assert.equal(env.text(), beforeUndo, 'refused Undo must preserve policy bytes');
    assert.deepEqual(fs.readFileSync(first.paths.state), firstState, 'refused Undo must preserve its transaction');
    assert.deepEqual(fs.readFileSync(first.paths.codexClaims), claims, 'refused Undo must preserve shared ownership');
  }
  assert.match(env.text(), GIT_STATUS,
    'WITNESS Undo must retain the other workspace identical Codex grant or explicitly refuse');
  assert.deepEqual(fs.readFileSync(second.paths.state), secondState, 'Undo must not rewrite another workspace state');
  if (refusal) {
    assert.deepEqual(env.create('b', 'git status').undo().restoredTargets, ['codex']);
    assert.match(env.text(), GIT_STATUS);
    assert.equal(env.create('a', 'git status').undo().undone, true);
    assert.equal(env.text(), env.original);
  }
});

test('Codex Undo continues refusing an unrelated manual policy edit without writing either state', (t) => {
  const env = fixture(t);
  const first = env.create('a', 'git status');
  apply(first);
  fs.appendFileSync(env.rules, '# Later user-owned edit.\n');
  const before = env.text();
  const stateBefore = fs.readFileSync(first.paths.state);
  assert.throws(() => env.create('a', 'git status').undo(), /policy changed after Auto Learn wrote it/);
  assert.equal(env.text(), before);
  assert.deepEqual(fs.readFileSync(first.paths.state), stateBefore);
});

test('shared Codex claims include custom state paths and remain partitioned by policy target', (t) => {
  const env = fixture(t);
  const statePath = path.join(env.home, '.claude', 'wildcarding', 'nested', 'custom-evidence.json');
  const first = env.create('a', 'git status', { statePath });
  const second = env.create('b', 'rg --files');
  apply(first);
  apply(second);
  assert.match(env.text(), GIT_STATUS, 'WITNESS custom state path must retain shared Codex ownership');
  assert.match(env.text(), RG_FILES);
  assert.equal(first.paths.codexClaims, second.paths.codexClaims);
  const registry = JSON.parse(fs.readFileSync(first.paths.codexClaims, 'utf8'));
  assert.equal(Object.keys(registry.claimants).length, 2);
  assert.equal(registry.target, process.platform === 'win32' ? path.resolve(env.rules).toLowerCase() : path.resolve(env.rules));
  const otherRules = path.join(env.home, 'other-codex', 'rules', 'permission-wildcarding.rules');
  const other = env.create('c', 'git ls-files', { codexRulesPath: otherRules });
  apply(other);
  assert.notEqual(other.paths.codexClaims, first.paths.codexClaims);
  assert.doesNotMatch(fs.readFileSync(otherRules, 'utf8'), GIT_STATUS);
  assert.doesNotMatch(fs.readFileSync(otherRules, 'utf8'), RG_FILES);
  assert.match(env.text(), GIT_STATUS);
  assert.match(env.text(), RG_FILES);
});

test('Undo of a claim-only application releases it before the first workspace can undo', (t) => {
  const env = fixture(t);
  const first = env.create('a', 'git status');
  const second = env.create('b', 'git status');
  apply(first);
  const policy = env.text();
  apply(second);
  assert.equal(env.text(), policy, 'fixture must exercise unchanged policy bytes');
  assert.equal(second.status().canUndo, true,
    'WITNESS a second identical prefix must record an undoable ownership change');
  assert.equal(env.create('b', 'git status').undo().undone, true);
  assert.equal(env.text(), policy, 'claim-only Undo must preserve the other owner rule');
  assert.equal(env.create('a', 'git status').undo().undone, true);
  assert.equal(env.text(), env.original);
  assert.equal(fs.existsSync(first.paths.codexClaims), false);
});

test('pre-registry generated grants remain an unowned baseline and Undo preserves their exact bytes', (t) => {
  const env = fixture(t);
  const { renderCodexRules, mergeGeneratedCodexRules } = require('../src/policy-exporters');
  const legacy = mergeGeneratedCodexRules(env.original, renderCodexRules([
    { prefix: ['git', 'log'], counts: { success: 7 } },
  ], { includeReviewed: true }));
  fs.writeFileSync(env.rules, legacy);
  const first = env.create('a', 'git status');
  apply(first);
  assert.match(env.text(), /^\s*pattern = \["git", "log"\],$/m,
    'WITNESS an unknown legacy generated grant must survive the new writer');
  assert.match(env.text(), GIT_STATUS);
  assert.equal(first.undo().undone, true);
  assert.equal(env.text(), legacy);
  assert.equal(fs.existsSync(first.paths.codexClaims), false);
});

test('an identical legacy grant is not claimed and revoked when this workspace loses eligibility', (t) => {
  const env = fixture(t);
  const { renderCodexRules, mergeGeneratedCodexRules } = require('../src/policy-exporters');
  const legacy = mergeGeneratedCodexRules(env.original, renderCodexRules([
    { prefix: ['git', 'status'], counts: { success: 1 } },
  ], { includeReviewed: true }));
  fs.writeFileSync(env.rules, legacy);
  let status = 'success';
  const first = env.create('a', 'git status', { historyScanner: () => ({
    observations: [{ id: 'a-call', source: 'codex', tool: 'Bash', command: 'git status', status,
      cwd: path.join(env.home, 'workspaces', 'a') }],
    cursors: {}, files: [{ source: 'codex', mode: 'full' }],
  }) });
  apply(first);
  assert.equal(env.text(), legacy, 'fixture must start with an identical unowned grant');
  status = 'failed';
  first.scan();
  first.applyCodex();
  assert.deepEqual(first.status().applied.codex, []);
  assert.match(env.text(), GIT_STATUS,
    'WITNESS matching legacy bytes do not prove this workspace owns their grant');
  assert.equal(env.text(), legacy);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(first.paths.codexClaims, 'utf8')).claimants).length, 0);
});

test('manual generated-rule removal is not resurrected from shared Codex claims', (t) => {
  const env = fixture(t);
  const first = env.create('a', 'git status');
  apply(first);
  const { removeGeneratedCodexRules } = require('../src/policy-exporters');
  fs.writeFileSync(env.rules, removeGeneratedCodexRules(env.text()).text);
  const policy = env.text();
  const registry = fs.readFileSync(first.paths.codexClaims);
  const state = fs.readFileSync(first.paths.state);
  assert.throws(() => env.create('a', 'git status').applyCodex(), /generated block changed outside the recorded claims/,
    'WITNESS a manual deletion must block automatic shared-policy resurrection');
  assert.equal(env.text(), policy);
  assert.deepEqual(fs.readFileSync(first.paths.codexClaims), registry);
  assert.deepEqual(fs.readFileSync(first.paths.state), state);
});

test('unreadable, malformed, unsupported, or wrong-target Codex claims refuse all policy writes', (t) => {
  const env = fixture(t);
  const first = env.create('a', 'git status');
  apply(first);
  const originalLedger = fs.readFileSync(first.paths.codexClaims, 'utf8');
  const ledger = JSON.parse(originalLedger);
  const policy = env.text();
  const state = fs.readFileSync(first.paths.state);
  const claim = Object.keys(ledger.claimants)[0];
  for (const invalid of ['{broken', JSON.stringify({ ...ledger, version: 99 }),
    JSON.stringify({ ...ledger, target: ledger.target + '.other' }),
    JSON.stringify({ ...ledger, claimants: { [claim]: 'x = 1\n' } })]) {
    fs.writeFileSync(first.paths.codexClaims, invalid);
    assert.throws(() => env.create('a', 'git status').applyCodex(), /Codex policy claims/,
      'WITNESS invalid shared ownership must fail closed instead of replacing policy');
    assert.equal(env.text(), policy);
    assert.deepEqual(fs.readFileSync(first.paths.state), state);
    assert.equal(fs.readFileSync(first.paths.codexClaims, 'utf8'), invalid);
  }
  fs.unlinkSync(first.paths.codexClaims);
  fs.mkdirSync(first.paths.codexClaims);
  assert.throws(() => env.create('a', 'git status').applyCodex());
  assert.equal(env.text(), policy);
  assert.deepEqual(fs.readFileSync(first.paths.state), state);
  fs.rmdirSync(first.paths.codexClaims);
  fs.writeFileSync(first.paths.codexClaims, originalLedger);
});

test('a failed shared-claims transaction rolls policy and ownership back together', (t) => {
  const env = fixture(t);
  const first = env.create('a', 'git status');
  apply(first);
  const policy = env.text();
  const registry = fs.readFileSync(first.paths.codexClaims);
  const firstState = fs.readFileSync(first.paths.state);
  let ledgerWritten = false;
  const second = env.create('b', 'rg --files', { testHooks: {
    afterPolicyWrite(event) {
      if (event.kind === 'codex-claims') {
        ledgerWritten = true;
        throw new Error('fixture shared-claims transaction failure');
      }
    },
  } });
  second.scan();
  const secondState = fs.readFileSync(second.paths.state);
  assert.throws(() => second.applyCodex(), /fixture shared-claims transaction failure/);
  assert.equal(ledgerWritten, true, 'WITNESS failure must reach the shared ownership write');
  assert.equal(env.text(), policy, 'WITNESS rollback must retain workspace A and remove aborted workspace B');
  assert.deepEqual(fs.readFileSync(first.paths.codexClaims), registry);
  assert.deepEqual(fs.readFileSync(first.paths.state), firstState);
  assert.deepEqual(fs.readFileSync(second.paths.state), secondState);
});

test('legacy Undo cannot remove a rule after shared ownership has been recorded', (t) => {
  const env = fixture(t);
  const first = env.create('a', 'git status');
  apply(first);
  const saved = JSON.parse(fs.readFileSync(first.paths.state, 'utf8'));
  saved.lastApplication.targets = saved.lastApplication.targets.filter((target) => target.kind !== 'codex-claims');
  fs.writeFileSync(first.paths.state, JSON.stringify(saved) + '\n');
  const second = env.create('b', 'git status');
  apply(second);
  const policy = env.text();
  const state = fs.readFileSync(first.paths.state);
  const registry = fs.readFileSync(first.paths.codexClaims);
  assert.throws(() => env.create('a', 'git status').undo(), /legacy application because shared Codex claims/,
    'WITNESS an old transaction cannot erase subsequently recorded shared ownership');
  assert.equal(env.text(), policy);
  assert.deepEqual(fs.readFileSync(first.paths.state), state);
  assert.deepEqual(fs.readFileSync(first.paths.codexClaims), registry);
});

test('a claim-only Codex grant validates effective policy again before recording ownership', (t) => {
  const env = fixture(t);
  let decision = 'allow';
  const checked = [];
  const codexValidator = (_text, context) => {
    checked.push(context.command);
    return { valid: true, decision };
  };
  const first = env.create('a', 'git status', { codexValidator });
  apply(first);
  assert.deepEqual(checked, [['git', 'status']], 'control: the original rule must be validated');
  // Models a newly effective neighboring prompt/forbidden rule. The generated
  // rule bytes remain the same, but the effective checker verdict has changed.
  decision = 'forbidden';
  const second = env.create('b', 'git status', { codexValidator });
  second.scan();
  const policy = env.text();
  const registry = fs.readFileSync(first.paths.codexClaims);
  const firstState = fs.readFileSync(first.paths.state);
  const secondState = fs.readFileSync(second.paths.state);
  assert.throws(() => second.applyCodex(), /did not allow generated prefix: git status/,
    'WITNESS unchanged rule bytes cannot bypass effective validation for a new claimant');
  assert.deepEqual(checked, [['git', 'status'], ['git', 'status']]);
  assert.equal(env.text(), policy);
  assert.deepEqual(fs.readFileSync(first.paths.codexClaims), registry);
  assert.deepEqual(fs.readFileSync(first.paths.state), firstState);
  assert.deepEqual(fs.readFileSync(second.paths.state), secondState);
});
