'use strict';

// Env-led families (2026-10-13). A run that opens with an assignment Claude Code does not
// strip (`LD_PRELOAD=x cat f`) is matched by Claude Code only through a rule that keeps the
// assignment verbatim (`Bash(LD_PRELOAD=x cat *)`; the evidence is in src/permissions.js,
// above CLAUDE_SAFE_ENV_VARS). Since a9e2adf the learner withheld that run's rule, but it
// keyed the run on the plain family (`bash:cat`), and aggregateObservations nulls a family
// whose runs disagree, so the plain `cat f` runs lost `Bash(cat *)` too. Such runs are
// their own family now, keyed and ruled with the assignments they kept.
//
// Every command here is synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  aggregateObservations, candidateKey, extractInvocations, normalizeCandidateKey,
} = require('../src/auto-learn');
const { renderClaudePermissions, renderCodexRules } = require('../src/policy-exporters');
const { generalizePermission } = require('../src/permissions');
const { ruleMatches } = require('../src/permission-match');
const { createAutoLearnManager } = require('../src/auto-learn-manager');

const run = (id, command, status = 'success') => ({ id, source: 'claude', tool: 'Bash', command, status });
const families = (observations) => Object.fromEntries(aggregateObservations(observations, { threshold: 1 })
  .map((item) => [item.key, item]));

test('an env-led run is its own family, and the plain family keeps its rule', () => {
  const found = families([
    run('1', 'cat a.txt'), run('2', 'cat b.txt'), run('3', 'LD_PRELOAD=x cat f'), run('4', 'LD_PRELOAD=x cat g'),
    run('5', 'FOO=bar git status --short'), run('6', 'git status'),
  ]);
  // MUTATION: drop `lead` from candidateKey (src/auto-learn.js). Both cat shapes key on
  // `bash:cat` again, the family nulls its rule, and this fails. Confirmed 2026-10-13.
  assert.deepEqual(Object.keys(found).sort(),
    ['bash:FOO=bar git status', 'bash:LD_PRELOAD=x cat', 'bash:cat', 'bash:git status']);
  assert.equal(found['bash:cat'].claudePermission, 'Bash(cat *)', 'the plain family keeps its rule');
  assert.equal(found['bash:cat'].counts.success, 2, 'and counts only its own runs');
  assert.equal(found['bash:git status'].claudePermission, 'Bash(git status *)');
  // The env-led families propose the rule Claude Code matches, from the runs that had it.
  assert.equal(found['bash:LD_PRELOAD=x cat'].claudePermission, 'Bash(LD_PRELOAD=x cat *)');
  assert.equal(found['bash:LD_PRELOAD=x cat'].counts.success, 2);
  assert.equal(found['bash:FOO=bar git status'].claudePermission, 'Bash(FOO=bar git status *)');
  assert.deepEqual(found['bash:FOO=bar git status'].examples, ['FOO=bar git status <args>']);
  for (const family of Object.values(found)) {
    // The Codex prefix is the command's, as before: the split only separates evidence.
    assert.deepEqual(family.prefix, family.key.endsWith('cat') ? ['cat'] : ['git', 'status']);
  }
  // An env-led family is never automatic: `environment-prefix` bars it (isAutoSafeCandidate).
  assert.equal(found['bash:FOO=bar git status'].autoSafe, false);
  assert.equal(found['bash:git status'].autoSafe, true, 'control: the plain family is, at this threshold');
  // Each rule matches its own runs in the repo's model of Claude Code's matcher, and the
  // plain rule does not match the env-led run, which is the reason they are two families.
  assert.equal(ruleMatches('Bash(LD_PRELOAD=x cat *)', 'Bash(LD_PRELOAD=x cat f)'), true);
  assert.equal(ruleMatches('Bash(FOO=bar git status *)', 'Bash(FOO=bar git status --short)'), true);
  assert.equal(ruleMatches('Bash(cat *)', 'Bash(LD_PRELOAD=x cat f)'), false);
  assert.equal(ruleMatches('Bash(cat *)', 'Bash(cat a.txt)'), true);
});

test('the env-led rule is the one the wildcarding pass writes for the same approval', () => {
  // src/permissions.js generalizePermission is what an approval of the same command becomes
  // (a9e2adf); the learner must propose that rule or nothing. Rows the pass keeps verbatim
  // (a wrapper after a kept assignment) are rows the learner proposes no rule for.
  for (const [command, key, rule] of [
    ['LD_PRELOAD=x cat f', 'bash:LD_PRELOAD=x cat', 'Bash(LD_PRELOAD=x cat *)'],
    ['FOO=bar git status --short', 'bash:FOO=bar git status', 'Bash(FOO=bar git status *)'],
    // a safe-listed assignment after a kept one is kept too; one before it is stripped
    ['FOO=1 CI=1 make all', 'bash:FOO=1 CI=1 make', 'Bash(FOO=1 CI=1 make *)'],
    ['CI=1 FOO=2 make all', 'bash:FOO=2 make', 'Bash(FOO=2 make *)'],
    ['FOO=x.exe cat f', 'bash:FOO=x.exe cat', 'Bash(FOO=x.exe cat *)'],
    ['FOO= cat f', 'bash:FOO= cat', 'Bash(FOO= cat *)'],
    // control: only safe-listed assignments, so the plain family and its rule
    ['NODE_ENV=test npm test', 'bash:npm test', 'Bash(npm test *)'],
  ]) {
    const [family] = aggregateObservations([run('1', command)], { threshold: 1 });
    assert.equal(family.key, key, command);
    assert.equal(family.claudePermission, rule, command);
    assert.equal(generalizePermission(`Bash(${command})`), rule, `${command}: the pass and the learner disagree`);
    // MUTATION: give normalizeCandidateKey no env-led exception. `FOO=x.exe cat f` keys as
    // `bash:FOO=x cat`, a family nobody ran. Confirmed 2026-10-13.
    assert.equal(normalizeCandidateKey(key), key, `${key} is stable under the key migration`);
  }
  // The old keys still normalize as before.
  assert.equal(normalizeCandidateKey('bash:git.exe status'), 'bash:git status');
});

test('an assignment the rule cannot carry still separates the family, and nothing secret is kept', () => {
  for (const [command, key] of [
    // a credential-shaped name or value: written as `<redacted>`, in the key and the examples
    ['GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 git push origin', 'bash:GITHUB_TOKEN=<redacted> git push'],
    ['API_KEY=abc curl -s x', 'bash:API_KEY=<redacted> curl'],
    ['KUBECONFIG=~/.kube/config kubectl get pods', 'bash:KUBECONFIG=<redacted> kubectl get'],
    // not plain: quoted, an expansion
    ['FOO="a b" cat f', 'bash:FOO=<redacted> cat'],
    ['FOO=$HOME cat f', 'bash:FOO=<redacted> cat'],
    // a wrapper Claude Code does not strip after a kept assignment, or an assignment after
    // a stripped wrapper: Claude Code compares text the rule would not hold
    ['FOO=1 timeout 5 cat f', 'bash:FOO=1 timeout cat'],
    ['timeout 5 FOO=1 cat f', 'bash:timeout FOO=1 cat'],
  ]) {
    const [family] = aggregateObservations([run('1', command)], { threshold: 1 });
    // MUTATION: write every value as itself (environmentLeadWord returns `${name}=${value}`).
    // The token reaches the key and this fails. Confirmed 2026-10-13.
    // MUTATION: drop `leadIsRule = false` for a wrapper after a kept assignment.
    // `Bash(FOO=1 cat *)` is proposed for `FOO=1 timeout 5 cat f`. Confirmed 2026-10-13.
    // MUTATION: drop `leadIsRule = false` for the wrappers before a kept assignment.
    // `Bash(timeout FOO=1 cat *)` is proposed. Confirmed 2026-10-13.
    assert.equal(family.key, key, command);
    assert.equal(family.claudePermission, null, command);
    assert.ok(family.reasons.includes('environment-not-stripped'), command);
    const stored = JSON.stringify(family);
    for (const secret of ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'abc', '.kube']) {
      if (command.includes(secret)) assert.ok(!stored.includes(secret), `${command}: "${secret}" reached the candidate`);
    }
  }
});

test('the exporter judges an env-led rule by the command after the assignments, and only under review', () => {
  // MEASURED 2026-10-13 against b0685b2: `Bash(FOO=1 rm *)`, `Bash(FOO=1 bash *)` and
  // `Bash(FOO=1 curl *)` each rendered under review, because every root table read
  // `foo=1` as the root.
  for (const permission of ['Bash(FOO=1 rm *)', 'Bash(FOO=1 bash *)', 'Bash(FOO=1 curl *)', 'Bash(FOO=1 *)',
    'Bash(FOO=1 BAR=2 sudo ls *)', 'Bash(FOO=1 uv run *)', 'Bash(FOO=1 git push *)',
    // an assignment that makes the program load code named by its value
    'Bash(LD_PRELOAD=x cat *)', 'Bash(LD_LIBRARY_PATH=. cat *)', 'Bash(DYLD_INSERT_LIBRARIES=x cat *)',
    'Bash(PATH=. cat *)', 'Bash(BASH_ENV=x make test *)', 'Bash(NODE_OPTIONS=--require=./x.js jq *)',
    'Bash(FOO=1 PYTHONPATH=. cat *)', 'PowerShell(FOO=1 Get-ChildItem *)']) {
    // MUTATION: delete the assignment branch in claudePermissionIsSafe. `Bash(FOO=1 rm *)`
    // renders. Confirmed 2026-10-13.
    // MUTATION: drop the `assignmentIsUnsafe` line. `Bash(LD_PRELOAD=x cat *)` renders.
    // Confirmed 2026-10-13.
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [], permission);
  }
  for (const permission of ['Bash(FOO=bar git status *)', 'Bash(FOO=1 cat *)', 'Bash(RUST_LOG_STYLE=always rg *)',
    'Bash(FOO=1 CI=1 git diff *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [permission], permission);
    // MUTATION: drop `!reviewed ||` from the assignment branch. `Bash(FOO=bar git status *)`
    // is judged as `git status`, which is suffix-closed, and renders unreviewed. Confirmed
    // 2026-10-13.
    assert.deepEqual(renderClaudePermissions([permission], {}), [], `${permission} is never automatic`);
  }
  // Through the learner: the env-led family's rule renders at review, its Codex prefix is
  // the command's as it always was.
  const [family] = aggregateObservations([run('1', 'FOO=bar git status --short')], { threshold: 1 });
  assert.deepEqual(renderClaudePermissions([family], { includeReviewed: true }), ['Bash(FOO=bar git status *)']);
  assert.match(renderCodexRules([family], { includeReviewed: true }), /pattern = \["git", "status"\]/);
});

test('an assignment whose value names a program the tool runs later is refused, pinned or not', () => {
  // The rule pins the value, but the value IS the program (PROGRAM_NAMING_ENV in
  // src/policy-exporters.js): `Bash(GIT_PAGER=x git log *)` runs `x`, not `git log`. MEASURED
  // 2026-10-13 against 894e86d: all 20 rendered under review, because only the code-loading
  // set was refused.
  const programNaming = ['PAGER', 'GIT_PAGER', 'MANPAGER', 'EDITOR', 'VISUAL', 'GIT_EDITOR', 'BROWSER',
    'PROMPT_COMMAND', 'LESSOPEN', 'LESSCLOSE', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_EXTERNAL_DIFF',
    'GIT_PROXY_COMMAND', 'SSH_ASKPASS', 'SUDO_ASKPASS', 'CC', 'CXX', 'MAKE'];
  for (const name of programNaming) {
    // Over a read subcommand, the half a reviewer might wave through, and over a plain root.
    for (const rule of [`Bash(${name}=x git status *)`, `Bash(${name}=/usr/bin/x cat *)`]) {
      // MUTATION: drop `PROGRAM_NAMING_ENV.has(name)` from assignmentIsUnsafe.
      // `Bash(PAGER=x git status *)` renders. Confirmed 2026-10-13.
      // MUTATION: remove any one name from PROGRAM_NAMING_ENV; that name's rule renders.
      // Confirmed 2026-10-13 for GIT_SSH_COMMAND and CC.
      assert.deepEqual(renderClaudePermissions([rule], { includeReviewed: true }), [], rule);
    }
  }
  // NODE_OPTIONS, PYTHONSTARTUP, PERL5OPT and RUBYOPT are the same class and were already
  // refused (CODE_LOADING_ENV); these pin that they still are.
  for (const name of ['NODE_OPTIONS', 'PYTHONSTARTUP', 'PERL5OPT', 'RUBYOPT']) {
    assert.deepEqual(renderClaudePermissions([`Bash(${name}=x git status *)`], { includeReviewed: true }), [], name);
  }
  // Controls: a safe-shaped variable (locale, log level, a build toggle) whose value is DATA,
  // not a program, still renders at review. `LANG=C`-style vars are unaffected.
  for (const rule of ['Bash(LANG=C git status *)', 'Bash(LC_ALL=C.UTF-8 git log *)', 'Bash(TZ=UTC git status *)',
    'Bash(NODE_ENV=production git diff *)', 'Bash(RUST_LOG=debug git status *)', 'Bash(CI=1 git log *)',
    'Bash(FOO=bar git status *)', 'Bash(CFLAGS=-O2 git status *)']) {
    // MUTATION: add 'CFLAGS' to PROGRAM_NAMING_ENV; this control fails (a value is flags, not
    // a program). Confirmed 2026-10-13.
    assert.deepEqual(renderClaudePermissions([rule], { includeReviewed: true }), [rule], rule);
  }
});

// observationHash's formula (src/auto-learn-manager.js): the call's id and the family key.
const observationHash = (id, key) => crypto.createHash('sha256').update(Buffer.from(`${id}\0${key}`, 'utf8')).digest('hex');

function legacyHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-env-family-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const statePath = path.join(home, '.claude', 'wildcarding', 'auto-learn-state.json');
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  // A state written by a9e2adf..b0685b2: one `bash:cat` family that mixed `cat` and
  // `LD_PRELOAD=x cat` runs, its rule nulled by the second kind, and the hash of one of
  // those env-led calls (`env-old`) recorded under the plain key.
  fs.writeFileSync(statePath, `${JSON.stringify({
    version: 1, mode: 'recommend', threshold: 3,
    candidates: {
      'bash:cat': {
        key: 'bash:cat', tool: 'Bash', kind: 'shell', shell: 'bash', root: 'cat', prefix: ['cat'],
        claudePermission: null, risk: 'read-only', baseAutoSafe: false, complex: false,
        reasons: ['environment-not-stripped', 'environment-prefix', 'known-read-only-command'],
        sources: ['claude'], counts: { success: 4, failed: 0, unknown: 0, total: 4 },
      },
    },
    observationHashes: { [observationHash('env-old', 'bash:cat')]: { key: 'bash:cat', outcome: 'success', source: 'claude' } },
    cursors: {}, applied: { claude: [], codex: [] }, reviewed: { claude: [], codex: [] },
    codexTargets: {}, managedClaude: {}, lastScanAt: null, lastScanStats: null, lastApplication: null,
  }, null, 2)}\n`);
  return { home, statePath };
}
const scanning = (observations) => () => ({
  observations, cursors: { [`path-sha256:${'b'.repeat(24)}`]: { source: 'claude', size: 10, offset: 10 } },
  files: [{ source: 'claude', mode: 'full' }],
});

test('a stored family from before the split gets its plain rule back, and an env-led call is not counted twice', (t) => {
  const { home, statePath } = legacyHome(t);
  const learn = createAutoLearnManager({
    home, threshold: 3, codexRulesPath: null, statePath,
    historyScanner: scanning([
      run('env-old', 'LD_PRELOAD=x cat f'),           // re-read: already counted in bash:cat
      run('env-new', 'LD_PRELOAD=x cat g'),           // new: the env-led family's first run
      run('plain-new', 'cat a.txt'),                  // new: restores the plain rule
    ]),
  });
  learn.scan();
  const byKey = Object.fromEntries(learn.listCandidates().map((item) => [item.key, item]));
  // MUTATION: drop the legacy-key check in scan (src/auto-learn-manager.js). `env-old` is
  // counted again in the env-led family, which then holds 2. Confirmed 2026-10-13.
  assert.equal(byKey['bash:LD_PRELOAD=x cat'].counts.success, 1, 'the re-read call stays counted where it was');
  assert.equal(byKey['bash:LD_PRELOAD=x cat'].claudePermission, 'Bash(LD_PRELOAD=x cat *)');
  // MUTATION: drop the adoption in mergeCandidate. The stored null wins over the plain
  // run's rule and this fails. Confirmed 2026-10-13.
  assert.equal(byKey['bash:cat'].claudePermission, 'Bash(cat *)', 'the first plain run restores the rule');
  assert.equal(byKey['bash:cat'].counts.success, 5, 'the stored counts are kept, not split or dropped');
  // MUTATION: keep `environment-not-stripped` on adoption. The marker stays, so the next
  // disagreement would be undone again; this assertion fails. Confirmed 2026-10-13.
  assert.ok(!byKey['bash:cat'].reasons.includes('environment-not-stripped'), 'the marker is consumed');
  assert.ok(byKey['bash:cat'].reasons.includes('environment-prefix'), 'and the family stays off the automatic path');
  assert.equal(byKey['bash:cat'].autoSafe, false);
  // A second scan of the same history counts nothing again, in either family.
  learn.scan();
  const again = Object.fromEntries(learn.listCandidates().map((item) => [item.key, item]));
  assert.equal(again['bash:cat'].counts.success, 5);
  assert.equal(again['bash:LD_PRELOAD=x cat'].counts.success, 1);
});

test('a disagreement inside an env-led family nulls its rule for good, as for any family', (t) => {
  // The restoring path is for stored PLAIN families only. An env-led family carries the
  // same reason on every run, so a later agreeing run must not read its null as a stored
  // one: `FOO=1 Cat g` proposes `Bash(FOO=1 Cat *)`, a second rule in one family.
  const { home, statePath } = legacyHome(t);
  const learn = createAutoLearnManager({
    home, threshold: 3, codexRulesPath: null, statePath,
    historyScanner: scanning([run('a', 'FOO=1 cat f'), run('b', 'FOO=1 Cat g'), run('c', 'FOO=1 cat h')]),
  });
  learn.scan();
  const family = learn.listCandidates().find((item) => item.key === 'bash:FOO=1 cat');
  // MUTATION: drop `!fresh.reasons.includes('environment-not-stripped')` from the adoption
  // in mergeCandidate. The third run restores `Bash(FOO=1 cat *)` and strips the reason
  // from an env-led family. Confirmed 2026-10-13.
  assert.equal(family.claudePermission, null);
  assert.ok(family.reasons.includes('environment-not-stripped'));
  assert.equal(family.counts.success, 3);
});

test('control: without the stored hash, the same env-led call is the new family\'s evidence', (t) => {
  const { home, statePath } = legacyHome(t);
  const stored = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  stored.observationHashes = {};
  fs.writeFileSync(statePath, `${JSON.stringify(stored, null, 2)}\n`);
  const learn = createAutoLearnManager({
    home, threshold: 3, codexRulesPath: null, statePath,
    historyScanner: scanning([run('env-old', 'LD_PRELOAD=x cat f'), run('env-new', 'LD_PRELOAD=x cat g')]),
  });
  learn.scan();
  const byKey = Object.fromEntries(learn.listCandidates().map((item) => [item.key, item]));
  assert.equal(byKey['bash:LD_PRELOAD=x cat'].counts.success, 2);
  // No plain run arrived, so the stored family keeps its null: nothing restores a rule
  // for a command that was only ever run with the assignment.
  assert.equal(byKey['bash:cat'].claudePermission, null);
  assert.ok(byKey['bash:cat'].reasons.includes('environment-not-stripped'));
  // "Why did this prompt?" (vscode-extension/extension.js) looks a pasted command up with
  // candidateKey on its invocation, which carries the lead, so it finds the env-led family.
  const [invocation] = extractInvocations('Bash', 'LD_PRELOAD=x cat h', {});
  assert.equal(candidateKey(invocation), 'bash:LD_PRELOAD=x cat');
});
