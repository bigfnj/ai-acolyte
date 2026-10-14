'use strict';

// What the WRITE path checks before it puts an entry in the user's allow list,
// and what the claims registry records about an entry that is not there. Both
// were places where the listing and the writer disagreed: the listing withheld
// a family, the writer wrote it anyway.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAutoLearnManager } = require('../src/auto-learn-manager');

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-writegate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function observed(id, command, status = 'success') {
  return { id, source: 'claude', tool: 'Bash', command, status };
}
function scannerFeed(observations) {
  return () => ({
    observations,
    cursors: { [`path-sha256:${'a'.repeat(24)}`]: { source: 'claude', size: 100, offset: 100 } },
    files: [{ source: 'claude', mode: 'full' }],
  });
}
function manager(home, observations, options = {}) {
  return createAutoLearnManager({
    home, historyScanner: scannerFeed(observations), codexRulesPath: null,
    codexValidator: () => ({ valid: true, decision: 'allow' }), ...options,
  });
}
function writeSettings(home, value) {
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}
function readSettings(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
}
function readClaims(home) {
  return JSON.parse(fs.readFileSync(
    path.join(home, '.claude', 'wildcarding', 'claude-policy-claims.json'), 'utf8'));
}
const THREE_GIT_STATUS = [
  observed('g1', 'git status'), observed('g2', 'git status --short'), observed('g3', 'git status'),
];

// ── the user's own deny list ──────────────────────────────────────────────────

test('a family the user has denied is withheld rather than written and reported as applied', (t) => {
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: [], deny: ['Bash(git status:*)'] } });
  const learn = manager(home, THREE_GIT_STATUS);
  learn.scan();

  const result = learn.apply();
  assert.equal(result.appliedCount, 0, 'deny wins, so there was nothing to apply');
  assert.deepEqual(readSettings(home).permissions.allow, [],
    'no dead entry is written for a family the user already blocks');

  const [withheld] = result.withheldByPolicy;
  assert.equal(withheld.key, 'bash:git status');
  assert.equal(withheld.rule, 'Bash(git status:*)',
    'the report names the deny entry that beat it, not just a verdict');
  assert.equal(withheld.source, 'user-deny');
});

test('a deny that does not cover the family does not withhold it', (t) => {
  // The control. Without it, a gate that withheld everything would pass the
  // test above, and this path is exactly where "quiet by design" hides a bug.
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: [], deny: ['Bash(git push:*)'] } });
  const learn = manager(home, THREE_GIT_STATUS);
  learn.scan();

  const result = learn.apply();
  assert.deepEqual(result.withheldByPolicy, []);
  assert.deepEqual(readSettings(home).permissions.allow, ['Bash(git status *)']);
});

// J2 (2026-10-14): the LISTING judges the user's deny too, by the same refusal() the write uses.
// The extension's Review picker and dashboard counts read the listing's targets through
// vscode-extension/autoLearnUi.js, so that module answers what the user is shown.
const { reviewableCandidates, isCandidateComplete } = require('../vscode-extension/autoLearnUi');

test('J2: a family the user has denied is withheld by the listing too, so Review and the counts do not offer it', (t) => {
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: [], deny: ['Bash(git status:*)'] } });
  const learn = manager(home, THREE_GIT_STATUS);
  learn.scan();

  // MUTATION: restore 7d08ced's clone (the managed verdict alone). The family lists
  // `eligibleTargets: ['claude']` and `pendingTargets: ['claude']`, Review offers it and the
  // count holds it, while the apply below withholds it: every assertion before the apply fails.
  // Confirmed 2026-10-14.
  const [family] = learn.listCandidates();
  assert.equal(family.key, 'bash:git status');
  assert.equal(family.policy, 'unknown', 'no managed policy: `policy` is still the managed verdict alone');
  assert.deepEqual(family.eligibleTargets, [], 'the deny withholds the Claude target in the listing');
  assert.deepEqual(family.pendingTargets, []);
  assert.deepEqual(learn.listCandidates({ pending: true }), []);
  const settings = readSettings(home);
  assert.equal(isCandidateComplete(family, {}, ['claude']), true, 'nothing is left owing to Claude');
  assert.deepEqual(reviewableCandidates([family], {}, ['claude'], settings).candidates, [],
    'Review offers no family whose write would be withheld');

  // The listing and the write agree.
  const result = learn.applyClaude({
    keys: [family.key], includeReviewed: true, expectedFingerprints: { [family.key]: family.fingerprint },
  });
  assert.equal(result.appliedCount, 0);
  assert.deepEqual(result.withheldByPolicy.map(({ key, source }) => [key, source]), [['bash:git status', 'user-deny']]);
});

test('J2, the control: a deny that does not cover the rule leaves the family listed and pending', (t) => {
  // Passes with and without J2. It is what fails if the listing withholds too much: MUTATION:
  // make clone treat every family as refused. This fails. Confirmed 2026-10-14.
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: [], deny: ['Bash(git push:*)'] } });
  const learn = manager(home, THREE_GIT_STATUS);
  learn.scan();
  const [family] = learn.listCandidates();
  assert.deepEqual(family.eligibleTargets, ['claude']);
  assert.deepEqual(family.pendingTargets, ['claude']);
  assert.equal(reviewableCandidates([family], {}, ['claude'], readSettings(home)).candidates.length, 1);
  assert.deepEqual(learn.apply().appliedKeys, ['bash:git status'], 'and the write agrees: it is applied');
});

test('J2: a Claude deny withholds only the Claude target; the family stays offered for Codex', (t) => {
  // MUTATION: restore 7d08ced's clone. `eligibleTargets` is ['claude', 'codex'] and this fails.
  // MUTATION: drop the Codex target too when the Claude rule is refused. `eligibleTargets` is
  // [] and this fails. Both confirmed 2026-10-14.
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: [], deny: ['Bash(git status:*)'] } });
  const rules = path.join(home, '.codex', 'rules', 'permission-wildcarding.rules');
  const learn = manager(home, THREE_GIT_STATUS, { codexRulesPath: rules });
  learn.scan();
  const [family] = learn.listCandidates();
  assert.deepEqual(family.eligibleTargets, ['codex']);
  assert.deepEqual(family.pendingTargets, ['codex']);
});

// ── claims against entries the file no longer holds ───────────────────────────

test('an entry a live wildcard covers is claimed with the parent named, not written again', (t) => {
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: [] } });
  const learn = manager(home, THREE_GIT_STATUS);
  learn.scan();
  learn.apply();
  assert.deepEqual(readSettings(home).permissions.allow, ['Bash(git status *)']);
  assert.equal(readClaims(home).permissions['Bash(git status *)'].managed, true);

  // What the wildcarding pass does after an apply: the narrow entry is pruned
  // because a broader one covers it. Measured 2026-09-03 as 8 of 12 entries.
  writeSettings(home, { permissions: { allow: ['Bash(git *)'] } });

  learn.apply();
  assert.deepEqual(readSettings(home).permissions.allow, ['Bash(git *)'],
    'the pruned child is not written back; that churn is what the pass would undo again');

  const record = readClaims(home).permissions['Bash(git status *)'];
  assert.equal(record.coveredBy, 'Bash(git *)',
    'the registry says WHY the claimed entry is absent, which is the half a reconcile would lose');
  assert.equal(record.managed, false,
    'this claimant is not holding the entry, so releasing the claim must not pretend to remove it');
  assert.ok(record.claimants.length > 0, 'the claim itself is kept, not dropped');
});

test('an entry the file simply does not have is still claimed as managed', (t) => {
  // The control for the one above: absent-and-uncovered is the case where the
  // tool really did introduce the entry, and it must keep saying so.
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: [] } });
  const learn = manager(home, THREE_GIT_STATUS);
  learn.scan();
  learn.apply();

  const record = readClaims(home).permissions['Bash(git status *)'];
  assert.equal(record.managed, true);
  assert.equal(record.coveredBy, undefined);
});

// ── every spelling a family writes, not only its rule (2026-10-14, G2) ────────
//
// A family that observed `git status` and `git.exe status` writes two entries
// (renderClaudePermissions), and the gates above judged only `claudePermission`,
// the family's rule. So a deny or a managed ask that covers ONLY the alternate
// left `Bash(git.exe status *)` written dead and the family reported as applied
// with nothing withheld, the class F1 closed for a null rule (819e4ab), older than
// it. Reproduced against b1cf72c by all three tests below that fail. A refused
// alternate withholds itself; the family's rule still applies, because the deny
// names nothing that rule grants (applyUnlocked's comment has the reasoning).
const BOTH_SPELLINGS = [
  observed('s1', 'git status'), observed('s2', 'git status --short'), observed('s3', 'git.exe status'),
];

test('a deny that covers only the alternate spelling withholds that spelling and applies the rule', (t) => {
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: [], deny: ['Bash(git.exe status:*)'] } });
  const learn = manager(home, BOTH_SPELLINGS);
  learn.scan();
  const [family] = learn.listCandidates();
  assert.deepEqual(family.permissions, ['Bash(git status *)', 'Bash(git.exe status *)'],
    'precondition: the family renders both spellings');

  // MUTATION: restore b1cf72c's applyUnlocked (judge `item.claudePermission` only and
  // write every rendered spelling). The allow list gains `Bash(git.exe status *)` and
  // nothing is withheld, so both assertions below fail. Confirmed 2026-10-14.
  const result = learn.apply();
  assert.deepEqual(readSettings(home).permissions.allow, ['Bash(git status *)'],
    'no dead entry is written for the spelling the user denies');
  assert.deepEqual(result.withheldByPolicy, [{
    key: 'bash:git status', permission: 'Bash(git.exe status *)',
    decision: 'deny', rule: 'Bash(git.exe status:*)', source: 'user-deny',
  }]);
  // The rest of the family is applied: the deny covers nothing `Bash(git status *)` grants.
  assert.deepEqual(result.appliedKeys, ['bash:git status']);
  assert.deepEqual(Object.keys(readClaims(home).permissions), ['Bash(git status *)'],
    'nothing is claimed for a spelling that was not written');
});

test('the control: a deny that covers neither spelling withholds neither', (t) => {
  // Passes with and without G2. It is what fails if the spelling gate refuses too
  // much: MUTATION: make refusal() refuse every alternate. This fails. Confirmed
  // 2026-10-14.
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: [], deny: ['Bash(git push:*)'] } });
  const learn = manager(home, BOTH_SPELLINGS);
  learn.scan();
  const result = learn.apply();
  assert.deepEqual(result.withheldByPolicy, []);
  assert.deepEqual(readSettings(home).permissions.allow, ['Bash(git status *)', 'Bash(git.exe status *)']);
});

test('a managed ask that covers only the alternate spelling withholds that spelling', (t) => {
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: [] } });
  fs.writeFileSync(path.join(home, '.claude', 'remote-settings.json'),
    JSON.stringify({ permissions: { ask: ['Bash(git.exe status:*)'], allow: [], deny: [] } }));
  const learn = manager(home, BOTH_SPELLINGS);
  learn.scan();
  const [family] = learn.listCandidates();
  // The family's rule is not what the ask covers, so the listing still offers it.
  assert.notEqual(family.policy, 'inert');
  assert.ok(family.eligibleTargets.includes('claude'));

  // MUTATION: restore b1cf72c's applyUnlocked. The ask-covered entry is written and nothing
  // is withheld: this fails. Confirmed 2026-10-14.
  const result = learn.apply();
  assert.deepEqual(readSettings(home).permissions.allow, ['Bash(git status *)']);
  assert.deepEqual(result.withheldByPolicy.map(({ key, permission, decision, rule }) => [key, permission, decision, rule]),
    [['bash:git status', 'Bash(git.exe status *)', 'ask', 'Bash(git.exe status:*)']]);
  assert.deepEqual(result.appliedKeys, ['bash:git status']);
});

// Stored state alone, the shape test/auto-learn-null-revival.test.js uses for F1: the family
// is read from the state file and no scan runs, so nothing a fresh run brings can stand in for
// what the load produced.
function storedBothSpellings(t, { deny = [], ask = [] } = {}) {
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: ['WebSearch'], deny } });
  fs.writeFileSync(path.join(home, '.claude', 'remote-settings.json'),
    JSON.stringify({ permissions: { ask, allow: [], deny: [] } }));
  const statePath = path.join(home, '.claude', 'wildcarding', 'auto-learn-state.json');
  const family = {
    key: 'bash:git status', tool: 'Bash', kind: 'shell', shell: 'bash', root: 'git', prefix: ['git', 'status'],
    claudePermission: 'Bash(git status *)', permissions: ['Bash(git status *)', 'Bash(git.exe status *)'],
    risk: 'read-only', baseAutoSafe: false, complex: false, reasons: ['known-read-only-git-operation'],
    sources: ['claude'], counts: { success: 3, failed: 0, unknown: 0, total: 3 },
  };
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    version: 3, mode: 'recommend', threshold: 3, candidates: { [family.key]: family },
    observationHashes: {}, cursors: {}, applied: { claude: [], codex: [] }, reviewed: { claude: [], codex: [] },
    codexTargets: {}, managedClaude: {}, lastScanAt: null, lastScanStats: null, lastApplication: null,
  }, null, 2) + '\n');
  const learn = createAutoLearnManager({
    home, statePath, threshold: 3, codexRulesPath: null, codexValidator: () => ({ valid: true, decision: 'allow' }),
    // No scan runs in these tests; one that did would bring a fresh run this test excludes.
    historyScanner: () => { throw new Error('no scan may run'); },
  });
  const [listed] = learn.listCandidates();
  assert.deepEqual(listed.permissions, family.permissions, 'precondition: the load kept both spellings');
  const result = learn.applyClaude({
    keys: [listed.key], includeReviewed: true, expectedFingerprints: { [listed.key]: listed.fingerprint },
  });
  return { result, allow: readSettings(home).permissions.allow };
}

test('stored state alone: a reviewed apply withholds a user-denied alternate and writes the rule', (t) => {
  // MUTATION: restore b1cf72c's applyUnlocked. The reviewed apply writes both entries and
  // withholds nothing: this fails. Confirmed 2026-10-14.
  const { result, allow } = storedBothSpellings(t, { deny: ['Bash(git.exe status *)'] });
  assert.deepEqual(result.withheldByPolicy.map(({ permission, source }) => [permission, source]),
    [['Bash(git.exe status *)', 'user-deny']]);
  assert.deepEqual(result.appliedKeys, ['bash:git status']);
  assert.deepEqual(allow, ['WebSearch', 'Bash(git status *)']);
});

test('stored state alone: a reviewed apply withholds a managed-ask alternate and writes the rule', (t) => {
  // MUTATION: restore b1cf72c's applyUnlocked. This fails the same way. Confirmed 2026-10-14.
  const { result, allow } = storedBothSpellings(t, { ask: ['Bash(git.exe status:*)'] });
  assert.deepEqual(result.withheldByPolicy.map(({ permission, decision }) => [permission, decision]),
    [['Bash(git.exe status *)', 'ask']]);
  assert.deepEqual(allow, ['WebSearch', 'Bash(git status *)']);
});

test('stored state alone, the control: with no deny and no ask both spellings are written', (t) => {
  // Passes with and without G2.
  const { result, allow } = storedBothSpellings(t);
  assert.deepEqual(result.withheldByPolicy, []);
  assert.deepEqual(allow, ['WebSearch', 'Bash(git status *)', 'Bash(git.exe status *)']);
});

// The two limits on a family that is ALREADY applied, where the retention filter keeps the key.
test('a spelling already written stays written and claimed when a deny later covers it', (t) => {
  // Passes with and without G2: the spelling gate withholds only what the write would ADD.
  // MUTATION: drop the `fileAllow.has(permission)` keep in applyUnlocked. The entry this
  // claimant manages leaves the desired set, and updateClaudeClaims then deletes it from
  // `allow` on a deny's say-so, which the retention filter exists to refuse. This fails.
  // Confirmed 2026-10-14.
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: [] } });
  const learn = manager(home, BOTH_SPELLINGS);
  learn.scan();
  learn.apply();
  assert.deepEqual(readSettings(home).permissions.allow, ['Bash(git status *)', 'Bash(git.exe status *)']);

  writeSettings(home, { permissions: {
    allow: ['Bash(git status *)', 'Bash(git.exe status *)'], deny: ['Bash(git.exe status:*)'],
  } });
  learn.apply();
  assert.deepEqual(readSettings(home).permissions.allow, ['Bash(git status *)', 'Bash(git.exe status *)']);
  assert.equal(readClaims(home).permissions['Bash(git.exe status *)']?.managed, true, 'the claim is kept');
});

test('an applied family whose rule is now denied does not gain its alternate', (t) => {
  // The family was applied with one spelling; `git.exe status` arrives later, and by then the
  // user denies the family's rule. The key is retained (no revocation), but an alternate is
  // never added without its rule, as a new family with a denied rule writes nothing.
  // MUTATION: restore b1cf72c's applyUnlocked. `Bash(git.exe status *)` is added: this fails.
  // Confirmed 2026-10-14.
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: [] } });
  const feed = THREE_GIT_STATUS.slice();
  const learn = createAutoLearnManager({
    home, codexRulesPath: null, codexValidator: () => ({ valid: true, decision: 'allow' }),
    historyScanner: () => ({
      observations: feed,
      cursors: { [`path-sha256:${'a'.repeat(24)}`]: { source: 'claude', size: 100, offset: 100 } },
      files: [{ source: 'claude', mode: 'full' }],
    }),
  });
  learn.scan();
  learn.apply();
  assert.deepEqual(readSettings(home).permissions.allow, ['Bash(git status *)']);

  feed.push(observed('g4', 'git.exe status'));
  learn.scan();
  writeSettings(home, { permissions: { allow: ['Bash(git status *)'], deny: ['Bash(git status:*)'] } });
  const [family] = learn.listCandidates();
  assert.deepEqual(family.permissions, ['Bash(git status *)', 'Bash(git.exe status *)'], 'precondition');
  const result = learn.apply();
  assert.deepEqual(readSettings(home).permissions.allow, ['Bash(git status *)'],
    'the entry already there stays; the alternate is not added beside a denied rule');
  const alternate = result.withheldByPolicy.find((entry) => entry.permission === 'Bash(git.exe status *)');
  assert.ok(alternate, `the withheld alternate is reported: ${JSON.stringify(result.withheldByPolicy)}`);
  assert.equal(alternate.withRule, 'Bash(git status *)', 'the report names the rule it was withheld with');
  assert.equal(alternate.rule, 'Bash(git status:*)');
});
