'use strict';

// `git.exe status` and `git status` run the same program. They used to key as
// two families, so a family with runs spread across the two spellings counted
// each half toward the threshold separately and neither half ever earned a
// grant. Risk classification had normalized `.exe` away for a long time; the
// candidate key was the last place the two were still unrelated.
//
// Unifying the KEY is not the same as unifying the RULE: `Bash(git status *)`
// does not match the command `git.exe status`, so a family that observed both
// spellings has to keep both entries or half its evidence buys nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  aggregateObservations, candidateKey, extractInvocations,
  normalizeCandidateKey, normalizePermissionSpelling,
} = require('../src/auto-learn');
const {
  renderClaudePermissions,
  normalizePermissionSpelling: exporterNormalize,
} = require('../src/policy-exporters');
const { createAutoLearnManager } = require('../src/auto-learn-manager');

const invocation = (command) => extractInvocations('Bash', command, { shell: 'bash' })[0];
function observed(id, command, status = 'success') {
  return { id, source: 'claude', tool: 'Bash', command, status };
}
function families(observations, threshold = 3) {
  return Object.fromEntries(aggregateObservations(observations, { threshold })
    .map((item) => [item.key, item]));
}

test('both spellings of a command root key to one family', () => {
  assert.equal(candidateKey(invocation('git status')), 'bash:git status');
  assert.equal(candidateKey(invocation('git.exe status')), 'bash:git status');
  assert.equal(candidateKey(invocation('GIT.EXE status')), 'bash:git status',
    'the key was already case-folded; the suffix is what was missing');
  // Only the root, and only `.exe`. A subcommand is not an executable name,
  // and `foo.cmd` is a different file from `foo` rather than the same one
  // resolved by PATHEXT.
  assert.equal(candidateKey(invocation('git.cmd status')), 'bash:git.cmd',
    '`.cmd` is not folded into `git`, so it is not even read as the git family');
  assert.equal(normalizeCandidateKey('bash:git status.exe'), 'bash:git status.exe',
    'a later token keeps its suffix; only the command root is normalized');
  assert.equal(normalizeCandidateKey('bash:git.exe status'), 'bash:git status');
});

test('evidence adds up across spellings, and every observed spelling is still granted', () => {
  const byKey = families([
    observed('a', 'git status'),
    observed('b', 'git status --short'),
    observed('c', 'git.exe status'),
  ]);
  assert.deepEqual(Object.keys(byKey), ['bash:git status'], 'one family, not two');

  const family = byKey['bash:git status'];
  assert.equal(family.counts.success, 3);
  assert.equal(family.meetsThreshold, true,
    'split two-and-one, neither half reaches a threshold of three');
  assert.equal(family.claudePermission, 'Bash(git status *)',
    'the canonical spelling is the one the family reports');
  assert.deepEqual(family.permissions, ['Bash(git status *)', 'Bash(git.exe status *)']);
  assert.deepEqual(family.prefix, ['git', 'status'],
    'the prefix the Codex exporter renders follows the same canonical spelling');

  assert.deepEqual(renderClaudePermissions([family], { includeReviewed: true }),
    ['Bash(git status *)', 'Bash(git.exe status *)']);
});

test('a spelling that was never observed is never granted', () => {
  const [family] = aggregateObservations([
    observed('a', 'git status'), observed('b', 'git status'), observed('c', 'git status'),
  ], { threshold: 3 });
  assert.deepEqual(family.permissions, ['Bash(git status *)']);
  assert.deepEqual(renderClaudePermissions([family], { includeReviewed: true }),
    ['Bash(git status *)'], 'one spelling observed, one rule written');
});

test('a family whose permission was withdrawn carries no spellings to grant', () => {
  // The guard that stops the spelling list becoming a way back in. A quoted
  // executable blocks the permission -- Claude Code strips the quotes before
  // matching, so a rule built from the quoted form would grant something else
  // -- and merging that with an unquoted run has to withdraw the permission for
  // the whole family, spellings included.
  const byKey = families([
    observed('a', 'git status'),
    observed('b', '"git" status'),
  ], 1);
  const family = byKey['bash:git status'];
  assert.equal(family.claudePermission, null, 'one blocked observation withdraws the rule');
  assert.deepEqual(family.permissions, [],
    'and takes the observed spelling with it, or the exporter would grant it anyway');
});

test('the exporter and the learner agree on what one spelling of a rule is', () => {
  // The exporter takes no dependency on the learner, so it carries its own
  // copy, the same way it carries its own root tables. This is the drift test
  // for that copy.
  let normalisationApplied = 0;
  for (const rule of [
    'Bash(git.exe status *)', 'Bash(git status *)', 'PowerShell(WHERE.EXE *)',
    'Bash(x.exe *)', 'Bash(.exe *)', 'WebFetch(domain:host.exe.com)', 'WebSearch', '',
  ]) {
    const normalised = exporterNormalize(rule);
    assert.equal(normalised, normalizePermissionSpelling(rule), rule);
    if (normalised !== rule) normalisationApplied += 1;
  }
  // A differential test is only as strong as the axes its cases vary, and this one has an
  // axis that can go degenerate without anything noticing: two implementations that BOTH
  // became the identity function agree perfectly, and so does a case list trimmed down to
  // rules the normaliser leaves alone. At least one case has to be a rule the normalisation
  // actually rewrites, or the comparison above is between two copies of `x => x`.
  assert.ok(normalisationApplied >= 2,
    `only ${normalisationApplied} case(s) were changed by the normaliser, so this compares `
    + 'two implementations on inputs neither of them touches');
});

test('a family split across spellings reaches the threshold and both rules are written', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-spelling-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, `${JSON.stringify({ permissions: { allow: [] } }, null, 2)}\n`);

  const learn = createAutoLearnManager({
    home, threshold: 3, codexRulesPath: null,
    codexValidator: () => ({ valid: true, decision: 'allow' }),
    historyScanner: () => ({
      observations: [
        observed('a', 'git status'), observed('b', 'git status --short'),
        observed('c', 'git.exe status'),
      ],
      cursors: { [`path-sha256:${'a'.repeat(24)}`]: { source: 'claude', size: 10, offset: 10 } },
      files: [{ source: 'claude', mode: 'full' }],
    }),
  });
  learn.scan();

  const [family] = learn.listCandidates();
  assert.equal(family.key, 'bash:git status');
  assert.equal(family.counts.success, 3);
  assert.equal(family.autoSafe, true, 'the combined evidence is what clears the bar');

  learn.apply();
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow,
    ['Bash(git status *)', 'Bash(git.exe status *)'],
    'one family, two entries: the .exe invocations are covered too');

  // The state has to carry the spellings, or the second entry disappears on the
  // next load and the next apply silently narrows the grant.
  const stored = JSON.parse(fs.readFileSync(learn.paths.state, 'utf8'));
  assert.deepEqual(stored.candidates['bash:git status'].permissions,
    ['Bash(git status *)', 'Bash(git.exe status *)']);
});

test('a state written before the unification is merged onto one key, not overwritten', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-spelling-old-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const statePath = path.join(home, '.claude', 'wildcarding', 'auto-learn-state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const split = (key, root, success) => ({
    key, tool: 'Bash', kind: 'shell', shell: 'bash', root, prefix: [root, 'status'],
    claudePermission: `Bash(${root} status *)`, risk: 'read-only', baseAutoSafe: true,
    complex: false, reasons: ['known-read-only-command'], sources: ['claude'],
    counts: { success, failed: 0, unknown: 0, total: success },
  });
  fs.writeFileSync(statePath, `${JSON.stringify({
    version: 1, mode: 'recommend', threshold: 3,
    candidates: {
      'bash:git status': split('bash:git status', 'git', 2),
      'bash:git.exe status': split('bash:git.exe status', 'git.exe', 1),
    },
    observationHashes: {}, cursors: {}, applied: { claude: [], codex: [] },
    reviewed: { claude: [], codex: [] }, codexTargets: {}, managedClaude: {},
    lastScanAt: null, lastScanStats: null, lastApplication: null,
  }, null, 2)}\n`);

  const learn = createAutoLearnManager({ home, threshold: 3, codexRulesPath: null, statePath });
  const candidates = learn.listCandidates();
  assert.equal(candidates.length, 1, 'the two halves are now one family');
  assert.equal(candidates[0].counts.success, 3,
    'both halves were counted evidence; dropping either would lose runs nothing can re-derive');
  assert.deepEqual(candidates[0].permissions,
    ['Bash(git status *)', 'Bash(git.exe status *)']);
});
