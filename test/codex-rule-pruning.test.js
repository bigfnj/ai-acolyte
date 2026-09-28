'use strict';

// Killing mutations for this regression group (isolated copies, never live policy):
// stale-selection drops the selected id/hash; shared-owner-prune retains an owner's
// removed declaration; regrant-suppression bypasses suppressedCodex; durable-removal-
// intent skips save(intent); prewrite-validation skips execpolicy; undo-suppression
// skips the snapshot overlap check; ambiguous-ownership permits malformed markers;
// target-switch-undo reads only the current home; foreign-managed-target enables
// another target's generated rule; marker-crossing treats an embedded marker as owned.
// Each mutation is required to fail exactly its named scenario in the development
// evidence record, with the executed module hash and advanced mtime witnessed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutoLearnManager } = require('../src/auto-learn-manager');
const { parseCodexRules } = require('../src/codex-rule-inventory');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-prune-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, 'custom-codex');
  const rules = path.join(codexHome, 'rules', 'permission-wildcarding.rules');
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  fs.writeFileSync(rules, '# Original user text.\r\n');
  const create = (name = 'a', command = 'git status', extra = {}) => {
    const workspaceRoot = path.join(home, name);
    fs.mkdirSync(workspaceRoot, { recursive: true });
    return createAutoLearnManager({ home, codexHome, workspaceRoot, claudeSettingsPath: null,
      threshold: 1, mode: 'recommend', managedPolicy: { present: false, unreadable: false },
      historyScanner: () => ({ observations: [{ id: name + command, source: 'codex', tool: 'Bash',
        command, status: 'success', cwd: workspaceRoot }], cursors: {}, files: [{ source: 'codex', mode: 'full' }] }),
      codexHistoryStore: () => ({ stale: false, inspected: 'unavailable', reasons: [], notes: [] }),
      codexValidator: () => ({ valid: true, decision: 'allow' }), ...extra });
  };
  const contents = () => fs.readFileSync(rules, 'utf8');
  const grants = () => parseCodexRules(contents()).rules.filter((rule) => rule.decision === 'allow');
  return { home, codexHome, rules, create, contents, grants };
}
function grant(manager) {
  manager.scan();
  assert.equal(manager.applyCodex().appliedCount, 1, 'fixture actually grants a family');
}
function choose(manager, predicate = () => true) {
  const rule = manager.codexInventory().rules.find(predicate);
  assert.ok(rule, 'fixture rule must be listed');
  return { id: rule.id, path: rule.path, fileHash: rule.fileHash };
}

test('inventory covers sibling decisions and refuses whole computed files while Codex writing is off', (t) => {
  const env = fixture(t);
  fs.writeFileSync(env.rules, 'prefix_rule(pattern=["git", "status"], decision="allow")\n');
  const sibling = path.join(path.dirname(env.rules), 'manual.rules');
  fs.writeFileSync(sibling, 'prefix_rule(pattern=["git", "push"], decision="prompt")\n' +
    'prefix_rule(pattern=["git", "reset"], decision="forbidden")\n');
  const computed = path.join(path.dirname(env.rules), 'computed.rules');
  fs.writeFileSync(computed, 'prefix_rule(pattern=["rg"], decision="allow")\nx = ["git"]\n');
  const manager = env.create('off', '', { codexRulesPath: null });
  const inventory = manager.codexInventory();
  assert.equal(inventory.rules.length, 3);
  assert.equal(inventory.rules.filter((rule) => rule.removable).length, 1);
  assert.equal(inventory.files.find((file) => file.path === computed).supported, false,
    'WITNESS computed file must never offer its literal prefix as removable');
  const restricted = inventory.rules.find((rule) => rule.decision === 'forbidden');
  assert.throws(() => manager.removeCodexRules({ rules: [restricted] }), /read-only/);
  assert.equal(manager.removeCodexRules({ rules: [choose(manager, (rule) => rule.decision === 'allow')] }).removedCount, 1);
});

test('manual removal preserves all unrelated UTF-8 and CRLF bytes, refuses stale or fabricated selections', (t) => {
  const env = fixture(t);
  const manager = env.create();
  const rule = "prefix_rule(decision='allow', pattern=['écho', '你好'])";
  const head = '# 🧭 before\r\n';
  const tail = ' # inline note\r\n# after\r\nprefix_rule(pattern=["git", "push"], decision="prompt")\r\n';
  fs.writeFileSync(env.rules, head + rule + tail);
  const selected = choose(manager);
  assert.throws(() => manager.removeCodexRules({ rules: [{ ...selected, path: path.join(env.home, 'foreign.rules') }] }), /stale/);
  fs.appendFileSync(env.rules, '# changed\r\n');
  assert.throws(() => manager.removeCodexRules({ rules: [selected] }), /stale/,
    'WITNESS stale selection must fail before policy or removal record writes');
  assert.equal(fs.existsSync(manager.paths.codexRemovals), false);
  manager.removeCodexRules({ rules: [choose(manager)] });
  assert.equal(env.contents(), head + tail + '# changed\r\n');
  const record = JSON.parse(fs.readFileSync(manager.paths.codexRemovals));
  assert.equal(Buffer.from(record.lastRemoval.changes[0].before, 'base64').toString(), head + rule + tail + '# changed\r\n');
});

test('shared removal drops identical claims and survives fresh managers, rescan, reviewed apply and another workspace', (t) => {
  const env = fixture(t);
  const a = env.create();
  const b = env.create('b');
  const unrelated = env.create('c', 'rg --files');
  grant(a); grant(b); grant(unrelated);
  const bState = fs.readFileSync(b.paths.state);
  a.removeCodexRules({ rules: [choose(a, (rule) => rule.pattern[0] === 'git')] });
  assert.equal(env.grants().some((rule) => rule.pattern[0] === 'git'), false,
    'WITNESS explicit removal must remove every identical managed claim');
  assert.ok(env.grants().some((rule) => rule.pattern[0] === 'rg'));
  assert.deepEqual(fs.readFileSync(b.paths.state), bState, 'do not mutate another workspace evidence');
  const fresh = env.create('b');
  fresh.scan();
  const candidate = fresh.listCandidates()[0];
  assert.equal(candidate.codexSuppressed, true);
  assert.equal(candidate.eligibleTargets.includes('codex'), false);
  assert.equal(candidate.appliedTo.includes('codex'), false);
  assert.deepEqual(fresh.status().applied.codex, [], 'removed rules must not keep an applied status badge');
  const result = fresh.applyCodex({ keys: [candidate.key], includeReviewed: true,
    expectedFingerprints: { [candidate.key]: candidate.fingerprint } });
  assert.equal(result.appliedCount, 0);
  assert.equal(result.withheldByPolicy[0].source, 'codex-removal');
  assert.equal(env.grants().some((rule) => rule.pattern[0] === 'git'), false,
    'WITNESS reviewed application must not revive another workspace removed prefix');
  const other = env.create('d');
  other.scan();
  assert.equal(other.applyCodex().appliedCount, 0);
  assert.ok(env.grants().some((rule) => rule.pattern[0] === 'rg'));
});

test('removed broad manual prefix suppresses overlapping generated families without suppressing different commands', (t) => {
  const env = fixture(t);
  fs.writeFileSync(env.rules, 'prefix_rule(pattern=["git"], decision="allow")\n');
  const manager = env.create();
  manager.removeCodexRules({ rules: [choose(manager)] });
  const status = env.create('status', 'git status');
  status.scan();
  assert.equal(status.applyCodex().appliedCount, 0,
    'WITNESS removed broader prefix must suppress a narrower learned prefix');
  const other = env.create('other', 'rg --files');
  grant(other);
  const isolated = env.create('isolated', 'git status', { codexHome: path.join(env.home, 'different-home') });
  grant(isolated);
});

test('grouped Git declaration removal suppresses every alternative and keeps unrelated grants', (t) => {
  const env = fixture(t);
  const manager = env.create('group', '', {
    historyScanner: () => ({ observations: ['status', 'log', 'diff'].map((verb) => ({
      id: verb, source: 'codex', tool: 'Bash', command: 'git ' + verb, status: 'success',
      cwd: path.join(env.home, 'group'),
    })), cursors: {}, files: [{ source: 'codex', mode: 'full' }] }),
  });
  manager.scan();
  const candidates = manager.listCandidates();
  assert.equal(manager.applyCodex({ includeReviewed: true, keys: candidates.map((item) => item.key),
    expectedFingerprints: Object.fromEntries(candidates.map((item) => [item.key, item.fingerprint])) }).appliedCount, 3);
  const grouped = manager.codexInventory().rules[0];
  assert.ok(Array.isArray(grouped.pattern[1]), 'fixture is a grouped declaration');
  manager.removeCodexRules({ rules: [grouped] });
  for (const verb of ['status', 'log', 'diff']) {
    const fresh = env.create(verb, 'git ' + verb);
    fresh.scan();
    assert.equal(fresh.applyCodex().appliedCount, 0);
  }
  grant(env.create('files', 'git ls-files'));
});

test('failed removal persists an explicit recovery intent, blocks writers, and resumes only exact recorded bytes', (t) => {
  const env = fixture(t);
  const manager = env.create();
  grant(manager);
  const selected = choose(manager);
  const failing = env.create('a', 'git status', { testHooks: {
    afterPolicyWrite: ({ kind }) => { if (kind === 'codex-removal') throw new Error('injected interruption'); },
  } });
  assert.throws(() => failing.removeCodexRules({ rules: [selected] }), /injected interruption/);
  assert.equal(manager.codexInventory().pendingRemoval, true,
    'WITNESS interrupted removal must retain durable intent');
  assert.throws(() => manager.applyCodex(), /interrupted Codex removal/);
  assert.throws(() => manager.undo(), /interrupted Codex removal/);
  assert.equal(manager.removeCodexRules({ resume: true }).removedCount, 1);
  assert.equal(manager.codexInventory().pendingRemoval, false);
  assert.equal(env.grants().length, 0);
  assert.equal(manager.applyCodex().appliedCount, 0);
});

test('recovery refuses a concurrent edit without losing it or the pending removal', (t) => {
  const env = fixture(t);
  const manager = env.create();
  grant(manager);
  const failing = env.create('a', 'git status', { testHooks: {
    afterPolicyWrite: ({ kind }) => { if (kind === 'codex-removal') throw new Error('stop'); },
  } });
  assert.throws(() => failing.removeCodexRules({ rules: [choose(manager)] }), /stop/);
  fs.appendFileSync(env.rules, '# user edit after interruption\n');
  const after = env.contents();
  assert.throws(() => manager.removeCodexRules({ resume: true }), /file changed/,
    'WITNESS recovery must not erase a concurrent policy edit');
  assert.equal(env.contents(), after);
  assert.equal(manager.codexInventory().pendingRemoval, true);
});

test('effective-policy validation failure leaves rules, ownership and suppression untouched', (t) => {
  const env = fixture(t);
  const good = env.create();
  grant(good);
  const before = env.contents();
  const claims = fs.readFileSync(good.paths.codexClaims);
  const bad = env.create('a', '', { codexValidator: () => ({ valid: false, error: 'neighbor has failing inline example' }) });
  assert.throws(() => bad.removeCodexRules({ rules: [choose(bad)] }), /neighbor has failing inline example/);
  assert.equal(env.contents(), before, 'WITNESS validation refusal must precede removal writes');
  assert.deepEqual(fs.readFileSync(good.paths.codexClaims), claims);
  assert.equal(fs.existsSync(good.paths.codexRemovals), false);
});

test('Undo refuses a historical snapshot that would restore a separately removed manual allow rule', (t) => {
  const env = fixture(t);
  const sibling = path.join(path.dirname(env.rules), 'manual.rules');
  fs.writeFileSync(sibling, 'prefix_rule(pattern=["git", "status"], decision="allow")\n');
  const a = env.create();
  grant(a);
  const b = env.create('b', 'rg --files');
  grant(b); // Its pre-apply backup includes git status.
  b.removeCodexRules({ rules: [choose(b, (rule) => rule.path === sibling)] });
  const policy = env.contents();
  assert.throws(() => b.undo(), /explicitly removed Codex prefix/,
    'WITNESS Undo cannot restore suppressed prefix even if its target bytes still match');
  assert.equal(env.contents(), policy);
});

test('malformed removal records fail closed and marker lookalikes inside quoted strings do not imply ownership', (t) => {
  const env = fixture(t);
  const manager = env.create();
  fs.writeFileSync(env.rules, 'prefix_rule(pattern=["echo"], decision="allow", justification="# BEGIN permission-wildcarding\\n# END permission-wildcarding")\n');
  assert.equal(manager.codexInventory().rules[0].owned, false);
  fs.mkdirSync(path.dirname(manager.paths.codexRemovals), { recursive: true });
  fs.writeFileSync(manager.paths.codexRemovals, '{oops');
  assert.throws(() => manager.codexInventory(), /removal record/);
  assert.throws(() => manager.applyCodex(), /removal record/);
});

test('ambiguous generated block markers cannot bypass shared claim removal', (t) => {
  const env = fixture(t);
  const manager = env.create();
  grant(manager);
  const { CODEX_BEGIN_MARKER } = require('../src/policy-exporters');
  fs.appendFileSync(env.rules, CODEX_BEGIN_MARKER + '\n');
  const inventory = manager.codexInventory();
  assert.equal(inventory.rules.length, 0);
  assert.match(inventory.files[0].reason, /ambiguous/);
});

test('switching Codex homes cannot use the new home removal scope to undo an old target', (t) => {
  const env = fixture(t);
  const first = env.create();
  grant(first);
  const next = env.create('a', 'git status', { codexHome: path.join(env.home, 'new-home') });
  const newRules = next.paths.codexRules;
  fs.mkdirSync(path.dirname(newRules), { recursive: true });
  fs.writeFileSync(newRules, 'prefix_rule(pattern=["git", "status"], decision="allow")\n');
  next.removeCodexRules({ rules: [choose(next)] });
  const before = env.contents();
  assert.throws(() => next.undo(), /different Codex target after explicit removals/,
    'WITNESS target-switch Undo must not consult only the current Codex home');
  assert.equal(env.contents(), before);
});

test('generated sibling targets stay read-only so removal cannot strand their shared ownership', (t) => {
  const env = fixture(t);
  const a = env.create();
  grant(a);
  const b = env.create('b', 'rg --files', { codexRulesPath: path.join(path.dirname(env.rules), 'other.rules') });
  grant(b);
  const selected = choose(b, (rule) => rule.path === env.rules);
  const found = b.codexInventory().rules.find((rule) => rule.id === selected.id);
  assert.equal(found.removable, false, 'WITNESS foreign generated target must stay read-only');
  assert.throws(() => b.removeCodexRules({ rules: [selected] }), /read-only/);
  assert.equal(a.applyCodex().changed, false, 'original owner remains consistent');
});

test('a narrow removal blocks a broader learned grant that would cover the removed command', (t) => {
  const env = fixture(t);
  const manager = env.create();
  fs.writeFileSync(env.rules, 'prefix_rule(pattern=["git", "status", "--short"], decision="allow")\n');
  manager.removeCodexRules({ rules: [choose(manager)] });
  manager.scan();
  assert.equal(manager.applyCodex().appliedCount, 0,
    'WITNESS broader regrant must not bypass a narrower removed prefix');
});

test('a declaration crossing a generated marker boundary is read-only', (t) => {
  const env = fixture(t);
  const manager = env.create();
  const { CODEX_BEGIN_MARKER } = require('../src/policy-exporters');
  fs.writeFileSync(env.rules, 'prefix_rule(\n' + CODEX_BEGIN_MARKER + '\n' +
    'pattern=["git", "status"], decision="allow")\n' + CODEX_BEGIN_MARKER.replace('BEGIN ', 'END ') + '\n');
  const inventory = manager.codexInventory();
  assert.equal(inventory.rules.length, 0, 'WITNESS marker inside a declaration must not be treated as external policy');
  assert.match(inventory.files[0].reason, /ambiguous/);
});
