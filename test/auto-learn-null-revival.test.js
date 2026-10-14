'use strict';

// A family stored by v1.6.x with no Claude rule gets one back from its next run (2026-10-14).
// Through v1.6.2 the learner wrote no rule for an informational family (`cargo --version`, `df
// -h`; src/auto-learn.js INFO_PREFIX_FLAGS has the history), so the state file holds those
// families with `claudePermission: null`. The exporter now derives their rule (3417398), but the
// manager's merge kept the stored null for good, because preferredPermissionSpelling(null, x)
// is null, and the managed-inert and user-deny checks in applyUnlocked and the listing's `clone`
// read `item.claudePermission`. So they could not see the rule the exporter would write: a
// reviewed apply wrote a rule a user deny already beats (a dead entry, reported as applied), and
// the review listing offered one a managed ask makes inert. Every family below is synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAutoLearnManager } = require('../src/auto-learn-manager');

function stored(key, prefix, reasons, extra = {}) {
  return {
    key, tool: 'Bash', kind: 'shell', shell: 'bash', root: prefix[0], prefix, claudePermission: null, permissions: [],
    risk: 'unknown', baseAutoSafe: false, complex: false, reasons, sources: ['claude'],
    counts: { success: 3, failed: 0, unknown: 0, total: 3 }, ...extra,
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-null-revival-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settings = path.join(home, '.claude', 'settings.json');
  writeJson(settings, { permissions: { allow: ['WebSearch'], deny: ['Bash(cargo --version *)'] } });
  writeJson(path.join(home, '.claude', 'remote-settings.json'), { permissions: { ask: ['Bash(df -h:*)'], allow: [], deny: [] } });
  const statePath = path.join(home, '.claude', 'wildcarding', 'auto-learn-state.json');
  const candidates = [
    // The two v1.6.x informational families.
    stored('bash:cargo --version', ['cargo', '--version'], ['unknown-command']),
    stored('bash:df -h', ['df', '-h'], ['unknown-command']),
    // Controls. An env-led family whose kept assignment its rule cannot carry: withheld.
    stored('bash:FOO=<redacted> git status', ['git', 'status'],
      ['environment-not-stripped', 'environment-prefix', 'known-read-only-git-operation'], { risk: 'read-only' }),
    // A family that carries the withholding reason although its next run brings a rule.
    stored('bash:FOO=1 cat', ['cat'], ['environment-not-stripped', 'environment-prefix', 'known-read-only-command'],
      { risk: 'read-only' }),
    // A complex family: its null came from a path-executable run the rule would not cover.
    stored('bash:cat', ['cat'], ['known-read-only-command', 'path-executable'], { risk: 'read-only', complex: true }),
  ];
  writeJson(statePath, {
    version: 3, mode: 'recommend', threshold: 3, candidates: Object.fromEntries(candidates.map((item) => [item.key, item])),
    observationHashes: {}, cursors: {}, applied: { claude: [], codex: [] }, reviewed: { claude: [], codex: [] },
    codexTargets: {}, managedClaude: {}, lastScanAt: null, lastScanStats: null, lastApplication: null,
  });
  const runs = ['cargo --version', 'df -h', 'FOO="two words" git status', 'FOO=1 cat f', 'cat f'];
  const learn = createAutoLearnManager({
    home, statePath, threshold: 3, codexRulesPath: null, codexValidator: () => ({ valid: true, decision: 'allow' }),
    historyScanner: () => ({
      observations: runs.map((command, index) => ({ id: `fresh-${index}`, source: 'claude', tool: 'Bash', command, status: 'success' })),
      cursors: { [`path-sha256:${'e'.repeat(24)}`]: { source: 'claude', size: 10, offset: 10 } },
      files: [{ source: 'claude', mode: 'full' }],
    }),
  });
  return { learn, settings };
}

test('a stored family with no rule regains it from one fresh run, and the deny and managed checks then see it', (t) => {
  const { learn, settings } = setup(t);
  learn.scan();
  const byKey = Object.fromEntries(learn.listCandidates().map((item) => [item.key, item]));
  // MUTATION: delete the revival (the `else if (revivesNullRule(...))` in mergeCandidate).
  // Both stay null and this fails. Confirmed 2026-10-14.
  assert.equal(byKey['bash:cargo --version'].claudePermission, 'Bash(cargo --version *)');
  assert.equal(byKey['bash:df -h'].claudePermission, 'Bash(df -h *)');
  assert.deepEqual(byKey['bash:df -h'].permissions, ['Bash(df -h *)'], 'its spelling list follows the rule');
  // The listing sees the managed ask now: the family is inert and not offered to Claude.
  assert.equal(byKey['bash:df -h'].policy, 'inert');
  assert.ok(!byKey['bash:df -h'].eligibleTargets.includes('claude'), JSON.stringify(byKey['bash:df -h'].eligibleTargets));
  // And the write path sees both: the user's deny and the managed ask withhold the grants
  // instead of writing two entries that cannot stop a prompt.
  const picked = [byKey['bash:cargo --version'], byKey['bash:df -h']];
  const application = learn.applyClaude({
    keys: picked.map((item) => item.key), includeReviewed: true,
    expectedFingerprints: Object.fromEntries(picked.map((item) => [item.key, item.fingerprint])),
  });
  assert.deepEqual(application.withheldByPolicy.map(({ key, permission, decision }) => [key, permission, decision]), [
    ['bash:cargo --version', 'Bash(cargo --version *)', 'deny'],
    ['bash:df -h', 'Bash(df -h *)', 'ask'],
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow, ['WebSearch']);
});

test('a withheld, a withholding-marked or a complex stored family keeps its null rule', (t) => {
  const { learn } = setup(t);
  learn.scan();
  const byKey = Object.fromEntries(learn.listCandidates().map((item) => [item.key, item]));
  // The redacted env-led family: every run under its key withholds, so nothing revives it.
  assert.equal(byKey['bash:FOO=<redacted> git status'].claudePermission, null);
  // MUTATION: drop the withholding-reason test from revivesNullRule. `Bash(FOO=1 cat *)`
  // revives here and this fails. Confirmed 2026-10-14. Only the legacy block above it, which
  // needs a fresh run WITHOUT the marker and consumes it, may restore such a family.
  assert.equal(byKey['bash:FOO=1 cat'].claudePermission, null);
  // MUTATION: drop `!existing.complex` from revivesNullRule. `Bash(cat *)` revives on a
  // family whose stored runs include a path executable that rule does not match. Confirmed
  // 2026-10-14.
  assert.equal(byKey['bash:cat'].claudePermission, null);
  assert.equal(byKey['bash:cat'].complex, true, 'precondition: re-derived from its stored reasons');
});
