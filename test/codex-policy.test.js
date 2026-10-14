'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCodexRuleStore } = require('../src/codex-rule-store');
const { createAutoLearnManager } = require('../src/auto-learn-manager');
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
  refreshProjectTrust,
  abandonProjectTrustRefreshes,
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

// Windows file names are case-insensitive, and the target every caller passes is
// a hard-coded lowercase `permission-wildcarding.rules`, while the listing reports
// the spelling on disk. Compared as raw strings the one file was two members, and
// the substitute replaced only one of them, so the deployed copy was validated
// beside the candidate. Demonstrated before the fix, 2026-10-13: `files` held
// both spellings and `effective` held deployed PLUS pending.
function caseFixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rule-case-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.codex', 'rules');
  fs.mkdirSync(dir, { recursive: true });
  const onDisk = path.resolve(path.join(dir, 'Permission-Wildcarding.rules'));
  const neighbour = path.resolve(path.join(dir, 'hand-written.rules'));
  fs.writeFileSync(onDisk, 'prefix_rule(pattern=["git", "status"], decision="allow")\n');
  fs.writeFileSync(neighbour, 'prefix_rule(pattern=["rg"], decision="allow")\n');
  return {
    home, dir, onDisk, neighbour,
    lower: path.join(dir, 'permission-wildcarding.rules'),
    pending: path.resolve(path.join(home, 'candidate.rules')),
  };
}

test('a differently-cased target is the deployed file, not a second one, on Windows',
  { skip: process.platform !== 'win32' }, (t) => {
    const box = caseFixture(t);
    const plain = codexRuleFileSet({ home: box.home, target: box.lower });
    assert.deepEqual(plain.files, [box.onDisk, box.neighbour].sort(),
      'one file, listed once, under the spelling that is on disk');

    const swapped = codexRuleFileSet({ home: box.home, target: box.lower, substitute: box.pending });
    assert.equal(swapped.files.length, 2, 'the deployed file is one member');
    assert.equal(swapped.effective.includes(box.onDisk), false,
      'the deployed copy is REPLACED by the candidate, never validated beside it');
    assert.equal(swapped.effective.includes(box.pending), true, 'the candidate is evaluated');
    assert.deepEqual(swapped.effective.slice().sort(), [box.neighbour, box.pending].sort());
  });

test('a target whose directory is cased differently is still the deployed file, on Windows',
  { skip: process.platform !== 'win32' }, (t) => {
    const box = caseFixture(t);
    const shouted = path.join(box.home, '.CODEX', 'RULES', 'permission-wildcarding.rules');
    const swapped = codexRuleFileSet({ home: box.home, target: shouted, substitute: box.pending });
    assert.deepEqual(swapped.files, [box.onDisk, box.neighbour].sort(),
      'the listing spelling wins and the target adds nothing');
    assert.deepEqual(swapped.effective.slice().sort(), [box.neighbour, box.pending].sort(),
      'and the substitute stands in for the deployed copy');
  });

test('a rules directory reached under two spellings contributes each file once, on Windows',
  { skip: process.platform !== 'win32' }, (t) => {
    // The dedupe on its own. With the target check above keyed, a duplicate can
    // still arrive from the LISTING: the same directory named twice, differently
    // cased, is read twice and yields every file under both spellings.
    const box = caseFixture(t);
    const set = codexRuleFileSet({ home: box.home, directories: [path.join(box.home, '.CODEX', 'rules')] });
    assert.deepEqual(set.files, [box.onDisk, box.neighbour].sort(),
      'the first spelling seen is kept and the second listing adds nothing');
  });

test('the rule-store inventory lists a differently-cased target once, on Windows',
  { skip: process.platform !== 'win32' }, (t) => {
    // The inventory walks `files`, so before the fix it listed the one file
    // twice and every rule in it twice, under the same id: the id hashes a
    // case-folded path, so the two rows were indistinguishable to a removal.
    const box = caseFixture(t);
    const snapshot = (file) => {
      let content = Buffer.alloc(0);
      let exists = true;
      try { content = fs.readFileSync(file); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        exists = false;
      }
      return { exists, content, hash: crypto.createHash('sha256').update(content).digest('hex') };
    };
    const store = createCodexRuleStore({
      codexHome: path.join(box.home, '.codex'), target: box.lower,
      claimsPath: path.join(box.home, 'claims.json'), storePath: path.join(box.home, 'store.json'),
      backupPath: path.join(box.home, 'backup.json'), snapshot,
      atomicWrite() { throw new Error('inventory must not write'); }, validate() {},
    });
    const inventory = store.inventory();
    assert.deepEqual(inventory.files.map((file) => file.path).sort(), [box.onDisk, box.neighbour].sort());
    const ids = inventory.rules.map((rule) => rule.id);
    assert.equal(ids.length, 2, 'one git-status rule and one rg rule, each listed once');
    assert.equal(new Set(ids).size, ids.length, 'and no two rows share an id');
  });

test('case stays significant where the filesystem is case-sensitive', (t) => {
  // The control, runnable everywhere through the injected platform. On POSIX two
  // spellings are two files, so the substitute for a lowercase target that does
  // not match the on-disk name must NOT displace that file: displacing it would
  // validate a set with a real rules file missing. Asserted on `effective`,
  // which is the same on a case-sensitive disk (where the lowercase target does
  // not exist) and on NTFS (where it does, and `files` therefore grows by one).
  const box = caseFixture(t);
  const posix = codexRuleFileSet({
    home: box.home, target: box.lower, substitute: box.pending, platform: 'linux',
  });
  assert.equal(posix.effective.includes(box.onDisk), true,
    'a differently-spelled file is a different file and stays in the set');
  assert.equal(posix.effective.includes(box.pending), true);

  // And the folding is the platform's rule, not this machine's: injected win32
  // folds even where the real filesystem would keep the spellings apart.
  const folded = codexRuleFileSet({
    home: box.home, target: box.lower, substitute: box.pending, platform: 'win32',
  });
  assert.equal(folded.effective.includes(box.onDisk), false, 'win32 semantics fold the two spellings');
  assert.equal(folded.effective.includes(box.pending), true);
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

// ── trusted project rule folders ──────────────────────────────────────────────
//
// What Codex itself does was measured, not assumed (2026-10-13, codex-cli
// 0.161.0, isolated profiles; the evidence is in src/codex-policy.js under
// "project rule directories"): `<project>/.codex/rules` governs a session only
// when the project is trusted, and `config/read` with includeLayers reports each
// project layer with a `disabledReason` when it is not. These tests pin how that
// answer is used. The injected `rpc` returns the measured reply shape.
const measuredDisabledReason = (cwd) => 'To load project-local config, hooks, and exec policies, ' +
  `add ${cwd.toLowerCase()} as a trusted project in config.toml.`;
const projectLayer = (folder, disabledReason) => ({ name: { type: 'project', dotCodexFolder: folder },
  version: 'fixture', ...(disabledReason ? { disabledReason } : {}) });
function layersRpc(layersFor, calls = []) {
  return (requests) => {
    calls.push(requests);
    return requests.map((request) => ({ config: {}, layers: layersFor(request.params.cwd) }));
  };
}
const codexAbsent = () => () => { throw new Error('Codex config RPC refused: Codex executable is not reachable'); };
// Counts, rather than throws: a throwing route is caught and sends the lookup to
// the config.toml fallback, so "it threw" cannot show that Codex was not asked.
function countingRpc() {
  const rpc = (requests) => { rpc.calls += 1; return requests.map(() => ({ config: {}, layers: [] })); };
  rpc.calls = 0;
  return rpc;
}

function projectFixture(t) {
  // Long-name form, so the path a test writes into config.toml is the one the
  // fallback compares (os.tmpdir() can be an 8.3 short name on Windows).
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-project-rules-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // The fixture is its own repository root, so no folder above it -- a real
  // repository, or a real ~/.codex, on the machine running the suite -- can
  // become a candidate.
  fs.mkdirSync(path.join(base, '.git'));
  fs.writeFileSync(path.join(base, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const home = path.join(base, 'home');
  const codexHome = path.join(home, '.codex');
  const workspace = path.join(base, 'Workspace');
  const projectRules = path.join(workspace, '.codex', 'rules');
  fs.mkdirSync(path.join(codexHome, 'rules'), { recursive: true });
  fs.mkdirSync(projectRules, { recursive: true });
  const userFile = path.join(codexHome, 'rules', 'permission-wildcarding.rules');
  const projectFile = path.join(projectRules, 'project.rules');
  fs.writeFileSync(userFile, 'prefix_rule(pattern=["rg"], decision="allow")\n');
  fs.writeFileSync(projectFile, 'prefix_rule(pattern=["fd"], decision="allow")\n');
  const config = path.join(codexHome, 'config.toml');
  const writeConfig = (text) => fs.writeFileSync(config, text);
  const trust = (key, level = 'trusted') => writeConfig(`[projects.'${key}']\ntrust_level = "${level}"\n`);
  return { base, home, codexHome, workspace, projectRules, userFile, projectFile, config, writeConfig, trust };
}

test('a trusted project rule folder joins the set, because Codex says it loads it', (t) => {
  const box = projectFixture(t);
  const calls = [];
  const set = codexRuleFileSet({ home: box.home, workspaceRoot: box.workspace,
    rpc: layersRpc((cwd) => [projectLayer(path.join(cwd, '.codex'))], calls) });
  assert.deepEqual(set.files, [box.userFile, box.projectFile].sort());
  assert.deepEqual(set.projectDirectories, [box.projectRules]);
  assert.ok(set.directories.includes(box.projectRules));
  assert.equal(calls.length, 1, 'Codex was asked once');
  assert.deepEqual(calls[0], [{ method: 'config/read', params: { cwd: box.workspace, includeLayers: true } }],
    'about this workspace, with its layers');
});

test('an untrusted project rule folder stays out, and the set says why', (t) => {
  // The mutation this exists to kill: ignore `disabledReason` and every project
  // folder Codex lists -- trusted or not -- would join the set, so "Why did this
  // prompt?" would cite a rule the session never loaded.
  const box = projectFixture(t);
  const set = codexRuleFileSet({ home: box.home, workspaceRoot: box.workspace,
    rpc: layersRpc((cwd) => [projectLayer(path.join(cwd, '.codex'), measuredDisabledReason(cwd))]) });
  assert.deepEqual(set.files, [box.userFile], 'the untrusted project file is not evaluated');
  assert.deepEqual(set.projectDirectories, []);
  assert.ok(set.blindSpots.some((note) => note.includes(box.projectRules) && /not trusted/.test(note)),
    'and the omission is reported, naming the folder');
});

test('with no workspace root the set is the user-scope rules, and it says so', (t) => {
  const box = projectFixture(t);
  const rpc = countingRpc();
  const set = codexRuleFileSet({ home: box.home, rpc });
  assert.deepEqual(set.files, [box.userFile]);
  assert.equal(rpc.calls, 0);
  assert.ok(set.blindSpots.some((note) => /user-scope rules alone/.test(note)));
});

test('Codex is asked only when a .codex folder it could load exists', (t) => {
  const box = projectFixture(t);
  fs.rmSync(path.join(box.workspace, '.codex'), { recursive: true });
  const empty = countingRpc();
  assert.deepEqual(codexRuleFileSet({ home: box.home, workspaceRoot: box.workspace, rpc: empty }).files,
    [box.userFile]);
  assert.equal(empty.calls, 0, 'no project folder, nothing to ask about');
  // CODEX_HOME is never a project layer (measured with it at a repository
  // root), so a workspace that contains it has nothing to ask about either.
  const home = countingRpc();
  assert.deepEqual(codexRuleFileSet({ home: box.home, workspaceRoot: box.home, rpc: home }).files,
    [box.userFile]);
  assert.equal(home.calls, 0, 'CODEX_HOME is not a candidate project folder');
});

// 2026-10-14. A layer only ever adds `<folder>/rules`, so a `.codex` holding only
// config.toml or hooks cannot change the answer, and on the v1.6.2 tree it still
// cost an app-server start per config edit (about a second on the host thread).
test('a .codex folder with no rules folder is not asked about, and one that gains rules is', (t) => {
  const box = projectFixture(t);
  fs.rmSync(box.projectRules, { recursive: true });
  fs.writeFileSync(path.join(box.workspace, '.codex', 'config.toml'), 'model = "x"\n');
  fs.mkdirSync(path.join(box.workspace, '.codex', 'hooks'));
  const rpc = countingRpc();
  const ask = () => codexRuleFileSet({ home: box.home, workspaceRoot: box.workspace, rpc });
  // MUTATION: test `directoryExists(folder)` instead of `<folder>/rules` in
  // projectCandidates. This counts 1. Confirmed 2026-10-14.
  assert.deepEqual(ask().files, [box.userFile]);
  assert.equal(rpc.calls, 0, 'config.toml and hooks alone are not a reason to start an app-server');
  // The control: the same folder with a rules folder IS asked about, without any
  // config.toml edit, because the candidate signature moved.
  fs.mkdirSync(box.projectRules);
  ask();
  assert.equal(rpc.calls, 1, 'a rules folder appearing is asked about');
});

// The shape found on the development box: a home directory whose `.git` holds
// only a credentials file. Codex did not treat it as a repository (measured), and
// counting it would put every workspace under the home inside one "repository".
// Needs a temp directory that is not itself inside a real repository.
function insideRepository(dir) {
  for (let current = path.resolve(dir); ;) {
    const marker = path.join(current, '.git');
    try {
      const stat = fs.statSync(marker);
      if (stat.isFile() || fs.existsSync(path.join(marker, 'HEAD'))) return true;
    } catch {}
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

test('a .git that is not a repository does not pull enclosing folders in',
  { skip: insideRepository(os.tmpdir()) && 'the temp directory is inside a git repository' }, (t) => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-project-marker-')));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const home = path.join(base, 'home');
    const outer = path.join(base, 'outer');
    const workspace = path.join(outer, 'ws');
    const outerRules = path.join(outer, '.codex', 'rules');
    fs.mkdirSync(outerRules, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(outerRules, 'outer.rules'), 'prefix_rule(pattern=["fd"], decision="allow")\n');
    fs.mkdirSync(path.join(outer, '.git'));
    fs.writeFileSync(path.join(outer, '.git', 'credentials'), '');
    const notRepository = countingRpc();
    assert.deepEqual(codexRuleFileSet({ home, workspaceRoot: workspace, rpc: notRepository }).files, []);
    assert.equal(notRepository.calls, 0, 'the enclosing folder is not a candidate');

    // The control: make it a repository and the enclosing folder is a candidate,
    // and joins the set when Codex reports its layer enabled (measured: the
    // repository root, an intermediate folder and the cwd were all listed).
    fs.writeFileSync(path.join(outer, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const calls = [];
    const set = codexRuleFileSet({ home, workspaceRoot: workspace,
      rpc: layersRpc(() => [projectLayer(path.join(outer, '.codex'))], calls) });
    assert.equal(calls.length, 1);
    assert.deepEqual(set.files, [path.join(outerRules, 'outer.rules')]);
  });

test('Codex is asked again only when config.toml or the candidate folders change', (t) => {
  const box = projectFixture(t);
  box.trust(box.workspace);
  let trusted = true;
  const calls = [];
  const rpc = layersRpc((cwd) => [projectLayer(path.join(cwd, '.codex'),
    trusted ? undefined : measuredDisabledReason(cwd))], calls);
  const ask = () => codexRuleFileSet({ home: box.home, workspaceRoot: box.workspace, rpc });
  assert.ok(ask().files.includes(box.projectFile));
  assert.ok(ask().files.includes(box.projectFile));
  assert.equal(calls.length, 1, 'an unchanged config.toml reuses the answer: each ask starts an app-server');

  // What Codex would say changes only because config.toml did, so until it is
  // edited the cached answer stands.
  trusted = false;
  assert.ok(ask().files.includes(box.projectFile));
  assert.equal(calls.length, 1);
  fs.appendFileSync(box.config, '# trust withdrawn\n');
  assert.equal(ask().files.includes(box.projectFile), false, 'an edited config.toml is asked about again');
  assert.equal(calls.length, 2);

  // A .codex/rules folder that appears is asked about too, with config.toml
  // untouched: otherwise it stays invisible until the next config edit. A bare
  // `.codex` is not (2026-10-14): it cannot add a rule.
  fs.mkdirSync(path.join(box.base, '.codex'));
  ask();
  assert.equal(calls.length, 2, 'a .codex with no rules folder changes nothing');
  fs.mkdirSync(path.join(box.base, '.codex', 'rules'));
  ask();
  assert.equal(calls.length, 3);
});

// THE HOST'S DOORS (2026-10-14): `projectTrust: 'cached'` never asks, and
// refreshProjectTrust settles a miss asynchronously. The extension uses exactly
// these two (vscode-extension/extension.js codexRuleSetOptions and its callers).
function deferredRpc(layersFor) {
  const rpc = (requests) => {
    rpc.calls += 1;
    return new Promise((resolve, reject) => {
      rpc.pending.push({
        answer: () => resolve(requests.map((request) => ({ config: {}, layers: layersFor(request.params.cwd) }))),
        fail: (error) => reject(error),
      });
    });
  };
  rpc.calls = 0;
  rpc.pending = [];
  return rpc;
}

test('the cached read never asks Codex: a miss is pending, says so, and leaves the project out', (t) => {
  const box = projectFixture(t);
  const rpc = countingRpc();
  // MUTATION: drop the `projectTrust === 'cached'` branch in projectRuleDirectories.
  // The sync ask runs and this counts 1. Confirmed 2026-10-14.
  const set = codexRuleFileSet({ home: box.home, workspaceRoot: box.workspace, rpc, projectTrust: 'cached' });
  assert.equal(rpc.calls, 0, 'the host door never starts an app-server');
  assert.equal(set.projectPending, true);
  assert.deepEqual(set.files, [box.userFile], 'project rules are left out, never guessed');
  assert.ok(set.blindSpots.some((note) => /still being checked/.test(note)), 'and the set says why');
  // No candidate at all is not pending: there is nothing to ask, so nothing waits.
  fs.rmSync(box.projectRules, { recursive: true });
  const none = codexRuleFileSet({ home: box.home, workspaceRoot: box.workspace, rpc, projectTrust: 'cached' });
  assert.equal(none.projectPending, false);
  assert.equal(rpc.calls, 0);
});

test('one refresh settles the cached read, concurrent refreshes share it, and a fresh one does nothing', async (t) => {
  const box = projectFixture(t);
  const rpc = deferredRpc((cwd) => [projectLayer(path.join(cwd, '.codex'))]);
  const options = { home: box.home, workspaceRoot: box.workspace, rpc };
  const first = refreshProjectTrust(options);
  const second = refreshProjectTrust(options);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rpc.calls, 1, 'two refreshes of one entry share one ask');
  assert.equal(codexRuleFileSet({ ...options, projectTrust: 'cached' }).projectPending, true,
    'still pending while Codex has not answered');
  rpc.pending[0].answer();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  const settled = codexRuleFileSet({ ...options, projectTrust: 'cached' });
  assert.equal(settled.projectPending, false);
  assert.deepEqual(settled.files, [box.userFile, box.projectFile].sort(), 'the trusted project rule is counted now');
  assert.equal(await refreshProjectTrust(options), false, 'a fresh verdict needs no refresh');
  assert.equal(rpc.calls, 1);
});

test('a refresh that fails falls back to config.toml, and one abandoned mid-ask stores nothing', async (t) => {
  const box = projectFixture(t);
  box.trust(box.workspace);
  const failing = deferredRpc(() => []);
  const options = { home: box.home, workspaceRoot: box.workspace, rpc: failing };
  const refused = refreshProjectTrust(options);
  await new Promise((resolve) => setImmediate(resolve));
  failing.pending[0].fail(new Error('Codex config RPC refused: Codex executable is not reachable'));
  assert.equal(await refused, true);
  const fallback = codexRuleFileSet({ ...options, projectTrust: 'cached' });
  assert.ok(fallback.files.includes(box.projectFile), 'the exact trusted entry counts, as on the sync route');
  assert.ok(fallback.blindSpots.some((note) => /Codex could not be asked/.test(note)));

  // Abandoned: the extension's deactivate killed the worker, so whatever the ask
  // settles with is "the worker was killed" and must never become the verdict.
  const killed = deferredRpc(() => []);
  const fresh = { home: box.home, workspaceRoot: box.workspace, rpc: killed };
  const inFlight = refreshProjectTrust(fresh);
  await new Promise((resolve) => setImmediate(resolve));
  abandonProjectTrustRefreshes();
  killed.pending[0].fail(new Error('Codex config RPC is unavailable: Command failed'));
  // MUTATION: drop the epoch check in refreshProjectTrust. The killed ask is
  // cached as the fallback and this reads false. Confirmed 2026-10-14.
  assert.equal(await inFlight, false);
  assert.equal(codexRuleFileSet({ ...fresh, projectTrust: 'cached' }).projectPending, true,
    'nothing was stored, so the next activation asks again');
});

// A TIMEOUT IS NOT A VERDICT (2026-10-14; src/codex-policy.js PROJECT_TRUST_RETRY_MS).
// A cold app-server that missed the host's budget left the narrow config.toml
// fallback cached until config.toml or the candidate folders changed, which for a
// quiet config is the life of the window. Driven through the host's two doors with
// a test clock, in both wordings a timeout reaches them in: the worker's own
// deadline and the host's backstop.
test('a timed-out trust ask stands for a minute and is then asked again, and a definitive failure stays', async (t) => {
  const box = projectFixture(t);
  box.trust(box.workspace);
  let clock = 1000000;
  const now = () => clock;
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  for (const reason of ['Codex config RPC refused: Codex config operation timed out',
    'Codex config RPC is unavailable: the worker timed out']) {
    const rpc = deferredRpc((cwd) => [projectLayer(path.join(cwd, '.codex'))]);
    const options = { home: box.home, workspaceRoot: box.workspace, rpc, now };
    const first = refreshProjectTrust(options);
    await tick();
    rpc.pending[0].fail(new Error(reason));
    assert.equal(await first, true);
    const meanwhile = codexRuleFileSet({ ...options, projectTrust: 'cached' });
    assert.equal(meanwhile.projectPending, false, `${reason}: the fallback is the answer for now`);
    assert.ok(meanwhile.files.includes(box.projectFile), 'read from the exact trusted entry, as before');
    assert.ok(meanwhile.blindSpots.some((note) => /Codex could not be asked .*timed out/.test(note)));
    assert.equal(await refreshProjectTrust(options), false, 'within the minute nothing asks again');
    assert.equal(rpc.calls, 1);

    clock += 61000;
    // MUTATION: store a timeout like any other failure (`retryAt` always null in
    // settleProjectTrust). The fallback stays fresh, this reads false, and Codex is
    // never asked again. Confirmed 2026-10-14.
    assert.equal(codexRuleFileSet({ ...options, projectTrust: 'cached' }).projectPending, true,
      `${reason}: a minute on, the timeout no longer stands`);
    const second = refreshProjectTrust(options);
    await tick();
    assert.equal(rpc.calls, 2, 'so the next push asks Codex again');
    rpc.pending[1].answer();
    assert.equal(await second, true);
    clock += 10 * 60000;
    const answered = codexRuleFileSet({ ...options, projectTrust: 'cached' });
    assert.equal(answered.projectPending, false, 'an answer from Codex has no expiry');
    assert.ok(answered.files.includes(box.projectFile));
    assert.equal(answered.blindSpots.some((note) => /Codex could not be asked/.test(note)), false,
      'and it replaced the fallback');
  }

  // The control: a failure that describes the installation stays until
  // config.toml or the folders change, exactly as before.
  const absent = deferredRpc(() => []);
  const options = { home: box.home, workspaceRoot: box.workspace, rpc: absent, now };
  const refused = refreshProjectTrust(options);
  await tick();
  absent.pending[0].fail(new Error('Codex config RPC refused: Codex executable is not reachable'));
  assert.equal(await refused, true);
  clock += 10 * 60000;
  // MUTATION: treat every failure as transient (`timedOutAsk` always true). This
  // reads true and a missing codex is asked about again every minute. Confirmed 2026-10-14.
  assert.equal(codexRuleFileSet({ ...options, projectTrust: 'cached' }).projectPending, false,
    '"not reachable" is an answer about the installation, and it stays');
  assert.equal(await refreshProjectTrust(options), false);
  assert.equal(absent.calls, 1);
});

test('a config.toml edited while the ask runs does not let the old answer stand for the new file', async (t) => {
  const box = projectFixture(t);
  const rpc = deferredRpc((cwd) => [projectLayer(path.join(cwd, '.codex'))]);
  const options = { home: box.home, workspaceRoot: box.workspace, rpc };
  const asked = refreshProjectTrust(options);
  await new Promise((resolve) => setImmediate(resolve));
  // A different size, so the signature moves even within one mtime tick.
  box.writeConfig('# edited while Codex was being asked\n[features]\nplugins = false\n');
  rpc.pending[0].answer();
  assert.equal(await asked, true, 'the caller is told to look again');
  assert.equal(codexRuleFileSet({ ...options, projectTrust: 'cached' }).projectPending, true,
    'the verdict about the old config was not stored for the new one');
});

// THE CACHE SHAPE (2026-10-14). The key held config.toml's size+mtime, so each
// edit added an entry and the old ones stayed until LRU eviction: 100 edits held
// 32 entries, each carrying the whole config.toml text (630 KiB measured, every
// copy holding an MCP server token). One entry per workspace now, checked against
// the signature it stores, and holding the parsed trust entries only.
test('config.toml edits replace one trust entry instead of piling up and evicting others', (t) => {
  const box = projectFixture(t);
  // A second profile, so its edits are not edits of the first one's config.toml.
  const otherHome = path.join(box.base, 'other-home');
  fs.mkdirSync(path.join(otherHome, '.codex'), { recursive: true });
  const otherConfig = path.join(otherHome, '.codex', 'config.toml');
  const steady = countingRpc();
  const busy = countingRpc();
  const askSteady = () => codexRuleFileSet({ home: box.home, workspaceRoot: box.workspace, rpc: steady });
  askSteady();
  assert.equal(steady.calls, 1, 'precondition: the steady workspace is cached');
  for (let edit = 0; edit < 40; edit += 1) {
    fs.writeFileSync(otherConfig, `# edit ${edit}\n${'x'.repeat(edit)}\n`);
    codexRuleFileSet({ home: otherHome, workspaceRoot: box.workspace, rpc: busy });
  }
  assert.equal(busy.calls, 40, 'precondition: every edit was asked about');
  // MUTATION: put fileSignature(configFile) back into the key. Forty edits are
  // forty entries, the steady one is evicted, and this counts 2. Confirmed 2026-10-14.
  askSteady();
  assert.equal(steady.calls, 1, 'forty edits elsewhere left the steady entry cached');
});

test('a cached trust entry keeps none of config.toml\'s text', async (t) => {
  const box = projectFixture(t);
  // Never held whole by this test: the halves are joined only in the file, so a
  // heap that contains the joined token got it from what the cache kept.
  const left = crypto.randomBytes(16).toString('hex');
  const right = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(box.config, Buffer.concat([
    Buffer.from(`[mcp_servers.fixture]\ncommand = "x"\nenv = { TOKEN = "`), Buffer.from(left),
    Buffer.from(right), Buffer.from(`" }\n\n[projects.'${box.workspace}']\ntrust_level = "trusted"\n`),
  ]));
  const set = codexRuleFileSet({ home: box.home, workspaceRoot: box.workspace, rpc: codexAbsent() });
  assert.ok(set.files.includes(box.projectFile), 'precondition: the fallback read the trusted entry');
  // V8 keeps the subject of the last successful regex match (RegExp.input), and
  // the parser's last match was on a line sliced out of config.toml, which pins
  // the whole text until any other match replaces it. Transient and not the
  // cache, so replace it before looking: found without this line, gone with it.
  /flush/.exec('flush the last-match slot');
  // A heap snapshot collects garbage first, so what is left is what is retained.
  const v8 = require('node:v8');
  const chunks = [];
  for await (const chunk of v8.getHeapSnapshot()) chunks.push(chunk);
  const heap = Buffer.concat(chunks).toString('utf8');
  assert.ok(heap.includes(left), 'precondition: the snapshot does contain strings this test holds');
  // MUTATION: keep `text` on the entry again (or drop the JSON round trip, so a
  // sliced key pins its parent). The token is found. Confirmed 2026-10-14.
  assert.equal(heap.includes(left + right), false, 'the config.toml text, token and all, is still retained');
});

test('codex absent: config.toml is read directly, and the set says so', (t) => {
  // The real worker and a codex that does not exist: the route a machine with
  // no reachable Codex actually takes.
  const box = projectFixture(t);
  box.trust(box.workspace);
  const set = codexRuleFileSet({ home: box.home, workspaceRoot: box.workspace,
    codexExecutable: path.join(box.base, 'no-such-codex.exe') });
  assert.deepEqual(set.files, [box.userFile, box.projectFile].sort(),
    'an exact trusted [projects] entry for the workspace root counts');
  assert.ok(set.blindSpots.some((note) => /Codex could not be asked/.test(note) && /not reachable/.test(note)),
    'the fallback names itself and why it was taken');
});

test('the config.toml fallback trusts only an exact trusted entry for the workspace root', (t) => {
  const box = projectFixture(t);
  const ws = box.workspace;
  // A fresh failing route per call is a fresh cache entry, so two configs of
  // equal size written within one timestamp tick cannot share an answer.
  const read = (text, extra = {}) => {
    box.writeConfig(text);
    return codexRuleFileSet({ home: box.home, workspaceRoot: ws, rpc: codexAbsent(), ...extra });
  };
  const included = (set) => set.files.includes(box.projectFile);
  const header = (key, level = 'trusted') => `[projects.'${key}']\ntrust_level = "${level}"\n`;

  assert.equal(included(read(header(ws))), true, 'single-quoted header');
  assert.equal(included(read(`[projects."${ws.replace(/\\/g, '\\\\')}"]\ntrust_level = "trusted"\n`)), true,
    'basic-string header with escaped separators');
  assert.equal(included(read(`model = "x"\n\n${header(ws)}\n[features]\nplugins = false\n`)), true,
    'among other tables');

  // Measured as NOT trusted by Codex: excluded here too.
  assert.equal(included(read(header(ws.replace(/\\/g, '/')))), process.platform !== 'win32',
    'forward slashes are a different key on Windows');
  assert.equal(included(read(header(ws + path.sep))), false, 'a trailing separator is a different key');
  assert.equal(included(read(header(path.dirname(ws)))), false, 'a trusted parent confers nothing');

  const untrusted = read(header(ws, 'untrusted'));
  assert.equal(included(untrusted), false);
  assert.ok(untrusted.blindSpots.some((note) => /does not mark this folder trusted/.test(note)));

  const none = read('model = "x"\n');
  assert.equal(included(none), false);
  assert.ok(none.blindSpots.some((note) => /no \[projects\] entry naming this exact folder/.test(note)));

  // Spellings Codex accepts but this reading does not interpret: left out and
  // said, never guessed at.
  const dotted = read(`projects.'${ws}'.trust_level = "trusted"\n`);
  assert.equal(included(dotted), false);
  assert.ok(dotted.blindSpots.some((note) => /does not interpret/.test(note)));
  const inline = read(`[projects]\n'${ws}' = { trust_level = "trusted" }\n`);
  assert.equal(included(inline), false);
  assert.ok(inline.blindSpots.some((note) => /does not interpret/.test(note)));

  // A header inside a multi-line string is string content.
  assert.equal(included(read(`developer_instructions = """\n${header(ws)}"""\n`)), false);
});

test('the fallback folds case on Windows only, and refuses conflicting entries', (t) => {
  const box = projectFixture(t);
  const read = (text, platform) => {
    box.writeConfig(text);
    return codexRuleFileSet({ home: box.home, workspaceRoot: box.workspace, rpc: codexAbsent(), platform });
  };
  const included = (set) => set.files.some((file) => file.toLowerCase() === box.projectFile.toLowerCase());
  // Measured: Codex on Windows trusted a key differing from the cwd in drive
  // letter and in segment case. The platform is injected, so this runs anywhere.
  const shouted = box.workspace.toUpperCase();
  assert.equal(included(read(`[projects.'${shouted}']\ntrust_level = "trusted"\n`, 'win32')), true,
    'win32 folds case');
  assert.equal(included(read(`[projects.'${shouted}']\ntrust_level = "trusted"\n`, 'linux')), false,
    'a case-sensitive platform does not');
  // Two entries for the one folder that disagree are not resolved by guessing.
  const conflicting = read(`[projects.'${box.workspace}']\ntrust_level = "trusted"\n` +
    `[projects.'${shouted}']\ntrust_level = "untrusted"\n`, 'win32');
  assert.equal(included(conflicting), false);
  assert.ok(conflicting.blindSpots.some((note) => /conflicting trust entries/.test(note)));
});

function storeFor(box, extra = {}) {
  const writes = new Map();
  const snapshot = (file) => {
    if (writes.has(file)) {
      const content = writes.get(file);
      return { exists: true, content, hash: crypto.createHash('sha256').update(content).digest('hex') };
    }
    let content = Buffer.alloc(0);
    let exists = true;
    try { content = fs.readFileSync(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      exists = false;
    }
    return { exists, content, hash: crypto.createHash('sha256').update(content).digest('hex') };
  };
  const store = createCodexRuleStore({
    codexHome: box.codexHome, home: box.home, codexExecutable: path.join(box.base, 'no-such-codex.exe'),
    target: box.userFile, workspaceRoot: box.workspace,
    claimsPath: path.join(box.base, 'claims.json'), storePath: path.join(box.base, 'store.json'),
    backupPath: path.join(box.base, 'backup.json'), snapshot,
    atomicWrite(file, content) { writes.set(file, Buffer.from(content)); }, validate() {}, ...extra,
  });
  return { store, writes };
}

test('the rule-store inventory lists a trusted project rule read-only and never backs it up', (t) => {
  const box = projectFixture(t);
  box.trust(box.workspace);
  const { store, writes } = storeFor(box);
  const inventory = store.inventory();
  const project = inventory.rules.find((rule) => rule.path === box.projectFile);
  const user = inventory.rules.find((rule) => rule.path === box.userFile);
  assert.ok(project, 'the trusted project rule is listed');
  assert.equal(project.removable, false, 'and is read-only: this store only writes inside CODEX_HOME');
  assert.match(project.reason, /Project rule file/);
  assert.equal(inventory.files.find((file) => file.path === box.projectFile).scope, 'project');
  assert.equal(user.removable, true, 'the user rule beside it stays removable');
  assert.throws(() => store.remove({ rules: [project] }), /stale or read-only/);

  store.backup();
  // The catalog keys paths case-folded on win32 (src/codex-policy-backup.js).
  const saved = JSON.parse(writes.get(path.join(box.base, 'backup.json')).toString('utf8'))
    .files.map((file) => file.path.toLowerCase());
  assert.ok(saved.includes(box.userFile.toLowerCase()), 'the user file is backed up');
  assert.equal(saved.includes(box.projectFile.toLowerCase()), false,
    'the project file is not: restore refuses any path outside this CODEX_HOME');
});

test('a workspace root spelled in another case still finds its trusted project rules, on Windows',
  { skip: process.platform !== 'win32' }, (t) => {
    // VS Code hands over a lowercase drive letter; config.toml keys and the disk
    // may spell segments differently. The trusted file must still be recognised
    // as the project's, or it would be offered for removal.
    const box = projectFixture(t);
    box.trust(box.workspace[0].toUpperCase() + box.workspace.slice(1));
    const spelled = box.workspace[0].toLowerCase() + box.workspace.slice(1).replace(/Workspace$/, 'WORKSPACE');
    const { store } = storeFor(box, { workspaceRoot: spelled });
    const project = store.inventory().rules.find((rule) => rule.path.toLowerCase() === box.projectFile.toLowerCase());
    assert.ok(project, 'the trusted project rule is listed');
    assert.equal(project.removable, false);
  });

// A stand-in codex on PATH, in the shape npm installs it, that records every
// argument list it is given and answers execpolicy check with "allow".
function installRecordingCodex(dir, name, log) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    const shim = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(shim, `@echo off\r\n>>"${log}" echo %*\r\necho {"decision":"allow"}\r\n`, 'utf8');
    return shim;
  }
  const shim = path.join(dir, name);
  fs.writeFileSync(shim, `#!/bin/sh\necho "$@" >> '${log}'\necho '{"decision":"allow"}'\n`, 'utf8');
  fs.chmodSync(shim, 0o755);
  return shim;
}

test('the user-scope write check never sees a trusted project rule, even one that forbids the write', (t) => {
  // The project forbids exactly the prefix being learned, and a second project
  // file does not parse. In the check, either would fail a user-scope write that
  // is valid in every other project (measured on 0.161.0: the neighbour's
  // forbidden wins, and an unparseable --rules member exits 1).
  const box = projectFixture(t);
  box.trust(box.workspace);
  fs.writeFileSync(box.projectFile, 'prefix_rule(pattern=["git"], decision="forbidden")\n');
  const broken = path.join(box.projectRules, 'broken.rules');
  fs.writeFileSync(broken, 'prefix_rule(pattern=["git" decision=\n');
  // The control: the same project IS in the set the explanation and inventory
  // use, so its absence from the check below is the design, not a miss.
  const visible = codexRuleFileSet({ home: box.home, workspaceRoot: box.workspace, rpc: codexAbsent() });
  assert.ok(visible.files.includes(box.projectFile) && visible.files.includes(broken));

  const bin = path.join(box.base, 'bin');
  const log = path.join(box.base, 'codex-arguments.log');
  installRecordingCodex(bin, 'wcprojectscopecodex', log);
  const manager = createAutoLearnManager({ home: box.home, codexHome: box.codexHome, workspaceRoot: box.workspace,
    codexRulesPath: box.userFile, codexExecutable: 'wcprojectscopecodex', threshold: 1, mode: 'recommend',
    claudeSettingsPath: null, managedPolicy: { present: false, unreadable: false },
    historyScanner: () => ({ observations: [{ id: 'project-scope', source: 'codex', tool: 'Bash',
      command: 'git status', status: 'success', cwd: box.workspace }], cursors: {}, files: [{ source: 'codex', mode: 'full' }] }),
    codexHistoryStore: () => ({ stale: false, inspected: 'unavailable', reasons: [], notes: [] }) });
  manager.scan();
  const before = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${before}`;
  let applied;
  try { applied = manager.applyCodex(); } finally { process.env.PATH = before; }
  assert.equal(applied.appliedCount, 1, 'the user-scope write went through');
  // The Windows launcher quotes each argument; the shell script does not.
  const checks = fs.readFileSync(log, 'utf8').replace(/"/g, '').split(/\r?\n/)
    .filter((line) => /execpolicy check/.test(line));
  assert.ok(checks.length >= 1, 'the real validator ran the stand-in codex');
  for (const line of checks) {
    assert.ok(line.includes(path.join(box.codexHome, 'rules')), 'it checked the user-scope set');
    assert.equal(line.toLowerCase().includes(box.projectRules.toLowerCase()), false,
      'and no project rule file was passed to it');
  }
});
