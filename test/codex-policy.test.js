'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readEnterpriseBundle,
  enterpriseRequirements,
  allowedApprovalPolicies,
  allowedSandboxModes,
  enterprisePrefixRules,
  enterprisePrefixRuleHealth,
  enterprisePolicyAssessment,
  enterpriseDecisionFor,
  codexRuleFileSet,
  codexRulesArguments,
} = require('../src/codex-policy');

// A real enterprise requirements bundle, in the shape Codex caches it. These
// helpers are read-only inputs to the "Why did this prompt?" diagnostic. They
// do not edit config.toml or provide an approval-policy toggle.
const bundleWith = (...contents) => ({
  signed_payload: {
    bundle: {
      requirements_toml: {
        enterprise_managed: contents.map((value) => ({ contents: value })),
      },
    },
  },
});

test('managed requirement fragments are joined without inventing policy', () => {
  const bundle = bundleWith(
    'allowed_sandbox_modes = ["read-only", "workspace-write"]',
    'allowed_approval_policies = ["on-request", "never"]',
  );

  assert.equal(enterpriseRequirements(bundle), [
    'allowed_sandbox_modes = ["read-only", "workspace-write"]',
    'allowed_approval_policies = ["on-request", "never"]',
  ].join('\n'));
  assert.deepEqual(allowedSandboxModes(bundle), ['read-only', 'workspace-write']);
  assert.deepEqual(allowedApprovalPolicies(bundle), ['on-request', 'never']);
  assert.equal(allowedApprovalPolicies(null), null, 'no managed key means no known cap');
  assert.equal(allowedSandboxModes({}), null, 'a malformed bundle does not invent a cap');
});

test('the enterprise bundle reader is read-only and fails closed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bundlePath = path.join(dir, 'cloud-config-bundle-cache.json');
  const bundle = bundleWith('allowed_approval_policies = ["on-request"]');
  fs.writeFileSync(bundlePath, JSON.stringify(bundle));

  assert.deepEqual(readEnterpriseBundle(bundlePath), bundle);
  assert.equal(readEnterpriseBundle(path.join(dir, 'missing.json')), null);
  fs.writeFileSync(bundlePath, '{ not json');
  assert.equal(readEnterpriseBundle(bundlePath), null, 'partial or corrupt cache is unknown');
});

// The root-alternative case, which the old parser got right by accident and the
// new one gets right on purpose. Kept verbatim so the rewrite has to stay
// compatible with what the diagnostics already relied on.
test('enterprise root rules identify the managed decision used by diagnostics', () => {
  const bundle = bundleWith([
    '[[rules.prefix_rules]]',
    'pattern = [{ any_of = ["sh", "bash", "zsh"] }]',
    'decision = "prompt"',
    'justification = "Shell launchers require human review."',
    '',
    '[[rules.prefix_rules]]',
    'pattern = [{ any_of = ["curl", "wget"] }]',
    'decision = "prompt"',
    'justification = "Network access requires approval."',
  ].join('\n'));

  const rules = enterprisePrefixRules(bundle);
  assert.equal(rules.length, 2, 'each managed block remains a separate rule');
  assert.deepEqual(rules[0].patterns, ['sh', 'bash', 'zsh']);
  assert.equal(rules[1].justification, 'Network access requires approval.');

  assert.equal(enterpriseDecisionFor(bundle, ['curl', '--version']).decision, 'prompt');
  assert.equal(enterpriseDecisionFor(bundle, ['C:\\tools\\curl.exe', '-s']).root, 'curl');
  assert.equal(enterpriseDecisionFor(bundle, ['/usr/bin/bash', '-lc', 'ls']).root, 'bash');
  assert.equal(enterpriseDecisionFor(bundle, ['rg', '--files']), null);
  assert.equal(enterpriseDecisionFor(bundle, []), null);
  assert.equal(enterpriseDecisionFor(null, ['curl']), null);
});

// ── the shapes the old parser answered wrongly ────────────────────────────────
//
// THE REAL BUNDLE ON THE DEVELOPMENT BOX IS WHERE THESE CAME FROM, not from
// imagination. codex-cli 0.145.0 caches a requirements.toml carrying
//
//   pattern = [{ any_of = ["git","git.exe"] }, { token = "push" },
//              { any_of = ["--force","-f","--force-with-lease","--mirror"] }]
//   decision = "forbidden"
//
// and a second, narrower "gh repo delete" rule written BELOW a broad "gh" prompt
// rule. Against that file the old parser answered ["push"] -> forbidden,
// ["repo"] -> forbidden, ["delete"] -> forbidden and ["gh","repo","delete","x"]
// -> prompt. The first three are commands the org does not forbid; the fourth is
// the dangerous direction, a forbidden command reported as merely prompting.
const ORDERED = [
  '[[rules.prefix_rules]]',
  'pattern = [{ any_of = ["gh", "gh.exe"] }]',
  'decision = "prompt"',
  'justification = "GitHub CLI actions require contextual review."',
  '',
  '# A comment between blocks, with "quoted words" in it, because the real',
  '# bundle has several and the block body runs to the next table header.',
  '[[rules.prefix_rules]]',
  'pattern = [{ any_of = ["gh", "gh.exe"] }, { token = "repo" }, { token = "delete" }]',
  'decision = "forbidden"',
  'justification = "Repository deletion is prohibited."',
  '',
  '[[rules.prefix_rules]]',
  'pattern = [{ any_of = ["vcs", "vcs.exe" ] }, { token = "push" }, { any_of = ["--force", "-f"] }]',
  'decision = "forbidden"',
  'justification = "Force-push is prohibited."',
  '',
  '[windows]',
  'allowed_sandbox_implementations = ["elevated"]',
].join('\n');

test('a later-position token is never mistaken for a command root', () => {
  const bundle = bundleWith(ORDERED);
  const rules = enterprisePrefixRules(bundle);
  assert.equal(rules.length, 3, 'the trailing [windows] table does not become a fourth rule');
  assert.deepEqual(rules[1].patterns, ['gh', 'gh.exe'],
    'patterns is the ROOT position, not every token in the block');
  assert.equal(rules[2].pattern.length, 3, 'all three positions are kept, in order');

  // The four answers the old parser got wrong, and nothing else changed about
  // them: each of these tokens appears in a later position of a real rule.
  for (const argv of [['push'], ['repo'], ['delete'], ['--force'], ['-f']]) {
    assert.equal(enterpriseDecisionFor(bundle, argv), null,
      `${argv[0]} is a later-position token, not a governed command root`);
  }
  // A comment's quoted words are not patterns either.
  assert.equal(enterpriseDecisionFor(bundle, ['quoted']), null);
});

test('a conflict resolves toward the more restrictive decision, not the first rule', () => {
  const bundle = bundleWith(ORDERED);
  // "gh" alone matches only the broad prompt rule.
  assert.equal(enterpriseDecisionFor(bundle, ['gh', 'pr', 'list']).decision, 'prompt');
  // "gh repo delete" matches BOTH, and the harsher one is written second.
  const deletion = enterprisePolicyAssessment(bundle, ['gh', 'repo', 'delete', 'x']);
  assert.equal(deletion.matches.length, 2, 'both rules match this command');
  assert.equal(deletion.match.decision, 'forbidden',
    'Codex takes the more restrictive decision, so the diagnostic must too');
  assert.equal(enterpriseDecisionFor(bundle, ['gh.exe', 'repo', 'delete', 'x']).decision, 'forbidden',
    'the .exe spelling of the root is the same root');

  // Ordered positions past the root are exact. "git PUSH" is not "git push" to
  // git, and folding case here would manufacture a forbidden verdict.
  assert.equal(enterpriseDecisionFor(bundle, ['gh', 'REPO', 'delete']).decision, 'prompt');
  // A prefix shorter than the pattern cannot match it.
  assert.equal(enterpriseDecisionFor(bundle, ['gh', 'repo']).decision, 'prompt');
  assert.equal(enterpriseDecisionFor(bundle, ['vcs', 'push']), null,
    'two of three positions is not a match');
  assert.equal(enterpriseDecisionFor(bundle, ['vcs', 'push', '-f', 'origin']).decision, 'forbidden');
});

// A control that can run degraded must say so. The parser answers for the shapes
// it knows and refuses to answer for the rest, and the refusal is a value the
// caller can read, not a silently dropped rule.
test('an unreadable managed block degrades the whole verdict instead of vanishing', () => {
  const bundle = bundleWith([
    '[[rules.prefix_rules]]',
    'pattern = [{ any_of = ["curl"] }]',
    'decision = "prompt"',
    'justification = "Network access requires approval."',
    '',
    '[[rules.prefix_rules]]',
    'pattern = [{ regex = "^py.*" }]',
    'decision = "forbidden"',
    'justification = "A shape this parser does not implement."',
    '',
    '[[rules.prefix_rules]]',
    'pattern = [{ any_of = ["node"] }]',
    'decision = "quarantine"',
    'justification = "A decision word this parser does not know."',
    '',
    '[[rules.prefix_rules]]',
    'pattern = [{ any_of = ["deno"] }, { token = "run" }, { token = "x" }',
    'decision = "forbidden"',
    'justification = "Unbalanced brackets."',
  ].join('\n'));

  const health = enterprisePrefixRuleHealth(bundle);
  assert.equal(health.degraded, true);
  assert.equal(health.supported, 1, 'only the curl rule is understood');
  assert.equal(health.total, 4, 'the three it cannot read are still counted');
  assert.deepEqual(health.unsupported.map((entry) => entry.reason), [
    'unsupported pattern key regex',
    'unknown decision "quarantine"',
    'no pattern array, or its brackets do not balance',
  ]);

  // A MATCH is degraded, because a rule the parser skipped could be harsher.
  const matched = enterprisePolicyAssessment(bundle, ['curl', 'https://example.test']);
  assert.equal(matched.match.decision, 'prompt');
  assert.equal(matched.degraded, true, 'a confident verdict beside an unread rule is not confident');
  // And so is a NON-match: "no managed rule governs this" is a claim about the
  // whole policy, and this parser did not read the whole policy.
  const missed = enterprisePolicyAssessment(bundle, ['python', 'setup.py']);
  assert.equal(missed.match, null);
  assert.equal(missed.degraded, true);
  assert.ok(missed.blindSpots.some((note) => /Server-side policy/.test(note)),
    'and it names what a local read can never see');

  // The clean bundle is the control: degraded must not be true for everything.
  assert.equal(enterprisePolicyAssessment(bundleWith(ORDERED), ['rg']).degraded, false);
});

// A triple-quoted block holds prose, and prose can contain anything, including
// the exact line that opens a rule. A parser that scanned for the header without
// tracking multi-line strings would invent a rule out of a policy document.
test('a table header inside a multi-line string is prose, not a rule', () => {
  const bundle = bundleWith([
    'guardian_policy_config = """',
    'Guidance to reviewers. A block is written like this:',
    '[[rules.prefix_rules]]',
    'pattern = [{ any_of = ["sudo"] }]',
    'decision = "forbidden"',
    '"""',
    '',
    '[[rules.prefix_rules]]',
    'pattern = [{ any_of = ["curl"] }]',
    'decision = "prompt"',
    'justification = "Real."',
  ].join('\n'));
  const health = enterprisePrefixRuleHealth(bundle);
  assert.equal(health.total, 1, 'the illustration inside the string is not a rule');
  assert.equal(health.degraded, false);
  assert.equal(enterpriseDecisionFor(bundle, ['sudo', 'rm']), null);
  assert.equal(enterpriseDecisionFor(bundle, ['curl']).decision, 'prompt');
});

// The rule files Codex actually loads. One definition, shared by the pre-write
// validator and the "Why did this prompt?" explanation, because a diagnostic that
// enumerates a different set from the writer names a cause the writer never
// checked.
test('the effective rule set substitutes the pending file rather than adding it', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rule-set-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.codex', 'rules');
  fs.mkdirSync(dir, { recursive: true });
  const ours = path.resolve(path.join(dir, 'permission-wildcarding.rules'));
  const theirs = path.resolve(path.join(dir, 'hand-written.rules'));
  fs.writeFileSync(ours, 'prefix_rule(\n)\n');
  fs.writeFileSync(theirs, 'prefix_rule(\n)\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a rules file');

  const plain = codexRuleFileSet({ home, target: ours });
  assert.deepEqual(plain.files, [theirs, ours].sort(), 'only .rules files, sorted');
  assert.deepEqual(plain.effective, plain.files, 'with no substitute the set is what is on disk');
  assert.ok(plain.blindSpots.some((note) => /Managed and system-scope/.test(note)),
    'the set says what it cannot enumerate');

  const pending = path.resolve(path.join(home, 'candidate.rules'));
  const swapped = codexRuleFileSet({ home, target: ours, substitute: pending });
  assert.equal(swapped.effective.includes(ours), false,
    'the deployed copy is REPLACED, never left visible beside the candidate');
  assert.equal(swapped.effective.includes(pending), true, 'the candidate is evaluated');
  assert.equal(swapped.effective.includes(theirs), true, 'and so is the neighbour');
  assert.equal(swapped.effective.length, 2);

  // A first write has no deployed copy to stand in for, and the candidate still
  // has to be in the set or the check proves nothing about it.
  fs.rmSync(ours);
  const first = codexRuleFileSet({ home, target: ours, substitute: pending });
  assert.deepEqual(first.files, [theirs]);
  assert.deepEqual(first.effective.slice().sort(), [theirs, pending].sort());

  assert.deepEqual(codexRulesArguments(['a.rules', 'b.rules']),
    ['--rules', 'a.rules', '--rules', 'b.rules'],
    '--rules is repeatable, so every member gets its own flag');
});

test('a rules directory that cannot be listed is reported, never silently dropped', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rule-fail-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // A FILE where a directory is expected: readdirSync answers ENOTDIR, which is
  // not the ENOENT that means "no Codex on this machine".
  const decoy = path.join(home, 'decoy');
  fs.writeFileSync(decoy, 'x');
  const set = codexRuleFileSet({ home, directories: [decoy] });
  assert.deepEqual(set.files, [], 'no Codex rules exist under this home');
  assert.equal(set.failures.length, 1, 'a directory that could not be listed is reported');
  assert.equal(set.failures[0].path, path.resolve(decoy));
  assert.ok(set.failures[0].code, 'the failure carries a code the caller can print');

  // The control: an absent directory is the ordinary case and is NOT a failure,
  // or every machine without Codex would report a permanent fault.
  const absent = codexRuleFileSet({ home, directories: [path.join(home, 'nope')] });
  assert.deepEqual(absent.failures, []);
});
