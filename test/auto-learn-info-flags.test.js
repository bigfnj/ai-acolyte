'use strict';

// A reviewed Claude rule for an informational family (`cargo --version`, `df -h`) and the
// grants it already holds (2026-10-14). The learner keys such a run on `[root, <info
// flag>]` (src/auto-learn.js prefixFor), and until this date permissionFor refused to
// write that second word into a rule, because it is not a bare command part: the family
// carried `claudePermission: null` with `complex: false`. Through v1.6.1 the exporter
// re-derived `Bash(cargo --version *)` from the prefix; a9e2adf made it honour an explicit
// null as "withheld", on the premise that every earlier withholding reason was also a
// complexity reason. It was not, so v1.6.2 stopped producing these rules and, on the first
// scan+apply after an upgrade, revoked the ones already applied.
//
// Every command below is synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { aggregateObservations, extractInvocations } = require('../src/auto-learn');
const { renderClaudePermissions, renderCodexRules } = require('../src/policy-exporters');
const { createAutoLearnManager } = require('../src/auto-learn-manager');

const run = (id, command, status = 'success') => ({ id, source: 'claude', tool: 'Bash', command, status });
const thrice = (command) => [1, 2, 3].map((n) => run(`${command}#${n}`, command));
const codexPatterns = (candidates) => [...renderCodexRules(candidates, { includeReviewed: true })
  .matchAll(/pattern = (\[.*\]),/g)].map((match) => JSON.parse(match[1]));

test('three successes of an informational family produce its reviewed Claude rule again', () => {
  const candidates = aggregateObservations(
    [...thrice('cargo --version'), ...thrice('df -h'), ...thrice('git status')], { threshold: 3 });
  const byKey = Object.fromEntries(candidates.map((item) => [item.key, item]));
  // The learner writes the rule itself now, so nothing downstream has to re-derive it.
  // MUTATION: drop `(index === 1 && INFO_PREFIX_FLAGS.has(String(part)))` from permissionFor's
  // validPart (src/auto-learn.js). The first assertion reads null. Confirmed 2026-10-14.
  assert.equal(byKey['bash:cargo --version'].claudePermission, 'Bash(cargo --version *)');
  assert.equal(byKey['bash:df -h'].claudePermission, 'Bash(df -h *)');
  assert.equal(byKey['bash:cargo --version'].complex, false, 'precondition: not a complexity refusal');
  // The reproduction: v1.6.1 (c09daab) rendered all three, v1.6.2 only the git rule.
  assert.deepEqual(renderClaudePermissions(candidates, { includeReviewed: true }),
    ['Bash(cargo --version *)', 'Bash(df -h *)', 'Bash(git status *)']);
  // Control: the Codex half rendered all three in both releases and still does.
  assert.deepEqual(codexPatterns(candidates), [['cargo', '--version'], ['df', '-h'], ['git', 'status']]);
  // Control: none of the three is automatic. cargo and df are not read-only roots the
  // automatic path trusts, and `git status` needs nothing from this change.
  assert.deepEqual(renderClaudePermissions(candidates, {}), ['Bash(git status *)']);
});

test('the automatic path gains only informational families of the roots it already trusts with any argument', () => {
  // A decision, pinned: with a rule to write, an informational family of a suffix-closed
  // root (src/auto-learn.js AUTO_SUFFIX_CLOSED_ROOTS) is auto-safe like the root itself.
  // MEASURED 2026-10-14 with a 123-family probe (30 roots x 4 informational words, and three
  // PowerShell cmdlets) against 9467b09: 22 families became auto-safe, every one a
  // suffix-closed root (uname, whoami, pwd, true, false, Get-Host, Get-Location), and every
  // rule a strict subset of the root rule that path already writes.
  const { ruleMatches } = require('../src/permission-match');
  const [uname] = aggregateObservations(thrice('uname --version'), { threshold: 3 });
  assert.equal(uname.autoSafe, true);
  assert.deepEqual(renderClaudePermissions([uname], {}), ['Bash(uname --version *)']);
  assert.equal(ruleMatches('Bash(uname *)', 'Bash(uname --version x)'), true, 'covered by the root grant');
  const [root] = aggregateObservations(thrice('uname -a'), { threshold: 3 });
  assert.deepEqual(renderClaudePermissions([root], {}), ['Bash(uname *)'], 'precondition: the root is automatic');
  // Control: a root the automatic path does not trust with any argument stays review-only.
  for (const command of ['ls --version', 'cat -h', 'df -h', 'sort -h']) {
    const [family] = aggregateObservations(thrice(command), { threshold: 3 });
    assert.equal(family.autoSafe, false, command);
    assert.deepEqual(renderClaudePermissions([family], {}), [], command);
  }
});

test('a stored informational family whose rule is null still renders, because nothing withheld it', () => {
  // What v1.6.1 and v1.6.2 wrote to the state file for these families: the learner's null,
  // with no reason that withholds a rule. The exporter treats null as withheld only when the
  // learner says why (`environment-not-stripped`), and otherwise derives the rule from the
  // prefix exactly as v1.6.1 did.
  // MUTATION: honour every explicit null again (drop `candidateWithholdsClaudeRule(candidate)`
  // from candidateClaudePermission in src/policy-exporters.js). This renders [] and fails;
  // so does the upgrade replay below. Confirmed 2026-10-14.
  const stored = [
    { key: 'bash:cargo --version', tool: 'Bash', shell: 'bash', root: 'cargo', prefix: ['cargo', '--version'],
      claudePermission: null, risk: 'unknown', complex: false, reasons: ['unknown-command'] },
    { key: 'bash:df -h', tool: 'Bash', shell: 'bash', root: 'df', prefix: ['df', '-h'],
      claudePermission: null, risk: 'unknown', complex: false, reasons: ['unknown-command'] },
  ];
  assert.deepEqual(renderClaudePermissions(stored, { includeReviewed: true }),
    ['Bash(cargo --version *)', 'Bash(df -h *)']);
});

test('the withholding a9e2adf added still holds: a kept assignment the rule cannot carry gets no rule', () => {
  // `FOO="two words"` is off Claude Code's known-safe list and its value is not plain, so
  // the family is keyed `FOO=<redacted>` and gets no rule (src/auto-learn.js
  // deriveBaseInvocation). Re-deriving from the prefix would hand it `Bash(git status *)`,
  // a rule Claude Code never matches against that command.
  const candidates = aggregateObservations(thrice('FOO="two words" git status'), { threshold: 3 });
  assert.equal(candidates.length, 1);
  const [family] = candidates;
  assert.equal(family.claudePermission, null);
  assert.ok(family.reasons.includes('environment-not-stripped'));
  assert.equal(family.complex, false, 'precondition: the one withholding that is not a complexity refusal');
  // MUTATION: make candidateWithholdsClaudeRule return false. `Bash(git status *)` renders
  // here and this fails. Confirmed 2026-10-14.
  assert.deepEqual(renderClaudePermissions(candidates, { includeReviewed: true }), []);
  // The family from before env-led runs were keyed apart (a plain key, the reason, a null)
  // is withheld the same way until a plain run restores its rule (the manager's mergeCandidate).
  assert.deepEqual(renderClaudePermissions([{
    key: 'bash:cat', tool: 'Bash', shell: 'bash', root: 'cat', prefix: ['cat'], claudePermission: null,
    risk: 'read-only', complex: false, reasons: ['environment-not-stripped', 'environment-prefix'],
  }], { includeReviewed: true }), []);
  // Control: the Codex half is unaffected by the assignment, as before.
  assert.deepEqual(codexPatterns(candidates), [['git', 'status']]);
});

test('every rule the learner withholds without calling the run complex names the reason the exporter honours', () => {
  // The drift guard for the line above. The exporter re-derives a null rule unless the
  // learner records why it withheld it, so a new non-complex way for the learner to null a
  // rule must also add a reason the exporter knows, or the exporter will quietly grant
  // what the learner refused. One synthetic run per shape the learner nulls.
  const corpus = [
    ['Bash', 'cargo --version'], ['Bash', 'df -h'], ['Bash', 'git --version'], ['Bash', 'rg --files'],
    ['Bash', 'uname -V'], ['Bash', 'docker --help'], ['Bash', 'FOO="two words" git status'],
    ['Bash', 'FOO=1 timeout 5 cat f'], ['Bash', 'LD_PRELOAD=x cat f'], ['Bash', 'GITHUB_TOKEN=abc git push'],
    ['Bash', '/usr/bin/cat f'], ['Bash', '"cat" f'], ['Bash', '$X f'], ['Bash', 'for x in a'], ['Bash', 'git'],
    ['Bash', 'docker'], ['Bash', 'timeout 5 cargo --version'], ['PowerShell', 'Get-Process -h'],
    ['PowerShell', '& tool.exe --version'], ['PowerShell', '1..6'],
  ];
  let nulled = 0;
  for (const [tool, command] of corpus) {
    for (const invocation of extractInvocations(tool, command)) {
      if (invocation.claudePermission !== null || invocation.complex) continue;
      nulled += 1;
      assert.ok(invocation.reasons.includes('environment-not-stripped'),
        `${command}: the learner withholds its rule (${JSON.stringify(invocation.reasons)}) with no reason `
        + 'the exporter honours (src/policy-exporters.js CLAUDE_WITHHOLDING_REASONS)');
    }
  }
  assert.ok(nulled >= 2, `precondition: the corpus reaches the env withholding (${nulled})`);
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

test('an upgrade keeps the reviewed informational grants already applied', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-info-flags-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const settings = path.join(home, '.claude', 'settings.json');
  writeJson(settings, { permissions: { allow: ['WebSearch'] } });
  const observations = [...thrice('cargo --version'), ...thrice('df -h')];
  const learn = createAutoLearnManager({
    home, threshold: 3, codexRulesPath: null, codexValidator: () => ({ valid: true, decision: 'allow' }),
    historyScanner: () => ({
      observations, cursors: { [`path-sha256:${'c'.repeat(24)}`]: { source: 'claude', size: 10, offset: 10 } },
      files: [{ source: 'claude', mode: 'full' }],
    }),
  });
  learn.scan();
  const picked = learn.listCandidates().filter((item) => item.meetsThreshold);
  assert.deepEqual(picked.map((item) => item.key), ['bash:cargo --version', 'bash:df -h']);
  learn.applyClaude({
    keys: picked.map((item) => item.key), includeReviewed: true,
    expectedFingerprints: Object.fromEntries(picked.map((item) => [item.key, item.fingerprint])),
  });
  const granted = ['Bash(cargo --version *)', 'Bash(df -h *)'];
  const allow = () => JSON.parse(fs.readFileSync(settings, 'utf8')).permissions.allow;
  assert.deepEqual(allow().filter((entry) => granted.includes(entry)), granted, 'precondition: both applied');

  // The upgrade: the state file as v1.6.1 wrote it, each family's rule null, then the
  // first scan after it in auto-safe mode, which applies with no user action at all.
  const statePath = learn.paths.state;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const key of ['bash:cargo --version', 'bash:df -h']) {
    state.candidates[key].claudePermission = null;
    state.candidates[key].permissions = [];
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  learn.setMode('auto-safe');
  learn.scan();
  // MUTATION: honour every explicit null again (see above). The first v1.6.2 scan+apply
  // removed both entries from `allow`, which is what this measured against 9467b09.
  // Confirmed 2026-10-14.
  assert.deepEqual(allow().filter((entry) => granted.includes(entry)), granted,
    'the reviewed grants the user applied before the upgrade are still in settings.json');
  assert.ok(allow().includes('WebSearch'));
});
