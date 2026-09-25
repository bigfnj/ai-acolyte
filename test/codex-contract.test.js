'use strict';

// PER-RULE CONTRACT AGAINST THE REAL BINARY.
//
// Every other Codex test in this repo proves this repository's MODEL of Codex.
// This one asks Codex. For each rule the exporter emits it proves four things —
// an exact positive, a near miss, a non-member of an emitted union, and an
// inverted match/not_match pair — and then proves that a rejected check leaves
// the deployed rules file byte-identical with no grant recorded.
//
// THESE CANNOT RUN ON GITHUB'S RUNNERS. There is no `codex` binary there and no
// authentication for one. So they skip, and the skip ANNOUNCES ITSELF on stderr
// with the reason, because a check that quietly does nothing is worse than an
// absent one: it reports green and nobody knows the question was never asked.
// The version that did answer is recorded in the run output for the same reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { commandLaunch } = require('../src/exec-resolve');
const { renderCodexRules } = require('../src/policy-exporters');
const { createAutoLearnManager } = require('../src/auto-learn-manager');

function codex(args) {
  const launch = commandLaunch('codex', args);
  if (process.platform === 'win32' && !launch.resolved) return { status: null, stdout: '', stderr: 'unresolved' };
  const result = spawnSync(launch.file, launch.args, {
    encoding: 'utf8', windowsHide: true, timeout: 60000, ...launch.options,
  });
  if (result.error) return { status: null, stdout: '', stderr: String(result.error.message || result.error) };
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

const probe = codex(['--version']);
const CODEX_VERSION = probe.status === 0 ? probe.stdout.trim() : null;
if (CODEX_VERSION) {
  process.stderr.write(`\n[codex-contract] RUNNING against ${CODEX_VERSION} on ${process.platform}.\n\n`);
} else {
  process.stderr.write(
    '\n[codex-contract] SKIPPED — no reachable `codex` binary ' +
    `(${(probe.stderr || 'exit ' + probe.status).trim().slice(0, 120)}). ` +
    'NOTHING in this file was verified against a real Codex. This is expected on CI, ' +
    'where there is no binary and no auth, and it is NOT a pass.\n\n',
  );
}
const skip = CODEX_VERSION ? false : 'no reachable codex binary (see the stderr banner)';

// A deliberately independent reader. The oracle must not share code with the
// thing under test, or a renderer that emitted a malformed `match` list and a
// parser that mirrored the same mistake would agree with each other.
function parseEmittedRules(text) {
  const rules = [];
  const blocks = String(text).split(/\bprefix_rule\s*\(/).slice(1);
  for (const block of blocks) {
    const body = block.slice(0, block.indexOf('\n)'));
    const list = (key) => {
      const at = new RegExp(`${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(body);
      if (!at) return [];
      return [...at[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
    };
    const patternAt = /pattern\s*=\s*(\[[\s\S]*?\])\s*,\s*\n/.exec(body);
    rules.push({
      pattern: patternAt ? patternAt[1].replace(/\s+/g, ' ') : '',
      match: list('match'),
      notMatch: list('not_match'),
      text: `prefix_rule(${block.slice(0, block.indexOf('\n)') + 2)}`,
    });
  }
  return rules;
}

function decisionFor(rulesFile, argv) {
  const result = codex(['execpolicy', 'check', '--rules', rulesFile, '--', ...argv]);
  if (result.status !== 0) return { error: (result.stderr || result.stdout).trim() };
  try { return JSON.parse(result.stdout); } catch { return { error: `unparseable output: ${result.stdout}` }; }
}

function tempFile(t, prefix, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `codex-contract-${prefix}-`));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const file = path.join(dir, 'permission-wildcarding.rules');
  fs.writeFileSync(file, text);
  return { dir, file };
}

const candidate = (prefix, extra = {}) => ({ autoSafe: true, risk: 'low', prefix, ...extra });

// One of each emitted shape: two single-token roots, two two-token prefixes, and
// the git union the exporter builds when several auto-safe read subcommands are
// learned. Five rules, so "every emitted rule" below is a loop over a corpus
// rather than over one lucky case.
const CANDIDATES = [
  candidate(['whoami'], { successCount: 9 }),
  candidate(['pwd'], { successCount: 6 }),
  candidate(['rg', '--files'], { successCount: 5 }),
  candidate(['rg', '--version'], { successCount: 5 }),
  candidate(['git', 'status'], { successCount: 4 }),
  candidate(['git', 'ls-files'], { successCount: 4 }),
  candidate(['git', 'rev-parse'], { successCount: 3 }),
];
const GENERATED = renderCodexRules(CANDIDATES);
const EMITTED = parseEmittedRules(GENERATED);

test('the emitted corpus this file exercises is not empty', () => {
  // The precondition, and it has to be a real assertion. A renderer change that
  // emitted nothing would otherwise turn every per-rule test below into a loop
  // over zero rules, and a file of empty loops reports green.
  assert.ok(EMITTED.length >= 5, `expected several emitted rules, got ${EMITTED.length}`);
  assert.ok(EMITTED.some((rule) => !/,/.test(rule.pattern)), 'a single-token rule must be emitted');
  assert.ok(EMITTED.some((rule) => /,/.test(rule.pattern) && !/\[.*\[/.test(rule.pattern)),
    'a two-token rule must be emitted');
  assert.ok(EMITTED.some((rule) => /\[/.test(rule.pattern.slice(1))),
    'at least one rule must be a union, or the union tests below prove nothing');
  for (const rule of EMITTED) {
    assert.ok(rule.match.length >= 1, `${rule.pattern} emitted no match examples`);
    assert.ok(rule.notMatch.length >= 1, `${rule.pattern} emitted no not_match examples`);
  }
});

test('every emitted rule allows its own exact positives', { skip }, (t) => {
  const { file } = tempFile(t, 'positive', GENERATED);
  let checked = 0;
  for (const rule of EMITTED) {
    for (const example of rule.match) {
      const argv = example.split(/\s+/).filter(Boolean);
      const answer = decisionFor(file, argv);
      assert.equal(answer.error, undefined, `${example}: ${answer.error}`);
      assert.equal(answer.decision, 'allow', `${rule.pattern} must allow its own example ${example}`);
      assert.ok(Array.isArray(answer.matchedRules) && answer.matchedRules.length >= 1,
        `${example} was allowed by no named rule`);
      checked += 1;
    }
  }
  // Witness label: a run that checked nothing must not read as a pass.
  assert.ok(checked >= EMITTED.length, `WITNESS exact-positive checks run: ${checked}`);
  t.diagnostic(`WITNESS ${checked} exact positives against ${CODEX_VERSION}`);
});

test('every emitted rule refuses its own near misses', { skip }, (t) => {
  const { file } = tempFile(t, 'nearmiss', GENERATED);
  let checked = 0;
  for (const rule of EMITTED) {
    for (const example of rule.notMatch) {
      const argv = example.split(/\s+/).filter(Boolean);
      const answer = decisionFor(file, argv);
      assert.equal(answer.error, undefined, `${example}: ${answer.error}`);
      assert.notEqual(answer.decision, 'allow',
        `${rule.pattern} must NOT allow its own counter-example ${example}`);
      checked += 1;
    }
  }
  // And a near miss the exporter did not think of: one character short of the
  // real prefix, which a sloppy substring match would wave through.
  for (const argv of [['r'], ['rg2'], ['gi', 'status'], ['git', 'stat']]) {
    const answer = decisionFor(file, argv);
    assert.equal(answer.error, undefined);
    assert.notEqual(answer.decision, 'allow', `${argv.join(' ')} is not an emitted prefix`);
    checked += 1;
  }
  assert.ok(checked >= EMITTED.length + 4, `WITNESS near-miss checks run: ${checked}`);
  t.diagnostic(`WITNESS ${checked} near misses against ${CODEX_VERSION}`);
});

test('a non-member of an emitted union is not allowed by it', { skip }, (t) => {
  const { file } = tempFile(t, 'union', GENERATED);
  const union = EMITTED.find((rule) => /^\[\s*"git"\s*,\s*\[/.test(rule.pattern));
  assert.ok(union, `no git union was emitted; pattern list was ${EMITTED.map((r) => r.pattern).join(' | ')}`);
  const members = [...union.pattern.matchAll(/"([^"]+)"/g)].map((m) => m[1]).slice(1);
  assert.ok(members.length >= 2, `a union needs at least two members, got ${members.join(',')}`);

  // Every member is allowed...
  for (const member of members) {
    assert.equal(decisionFor(file, ['git', member]).decision, 'allow', `union member ${member}`);
  }
  // ...and these are not members, so nothing may allow them. `add` and `commit`
  // are the ones that matter: same root, same shape, one token different, and
  // both are writes.
  let refused = 0;
  for (const outsider of ['push', 'add', 'commit', 'clean', 'statuses']) {
    assert.equal(members.includes(outsider), false, `${outsider} must not be an emitted member`);
    const answer = decisionFor(file, ['git', outsider]);
    assert.equal(answer.error, undefined);
    assert.notEqual(answer.decision, 'allow', `git ${outsider} is not in the emitted union`);
    refused += 1;
  }
  t.diagnostic(`WITNESS union ${members.join('|')}: ${refused} non-members refused by ${CODEX_VERSION}`);
});

// Codex SELF-TESTS the `match` and `not_match` lists when it loads a rules file.
// That makes the lists load-bearing rather than documentation, and it is the
// strongest single guarantee in the generated format: a rule whose examples
// contradict its own pattern will not load at all.
test('an inverted match/not_match pair is rejected by the binary, per rule', { skip }, (t) => {
  let inverted = 0;
  for (const rule of EMITTED) {
    // Swap the two lists in this rule only, leaving the rest of the file alone,
    // so the rejection names THIS rule and not some neighbour.
    const swapped = rule.text
      .replace(/match = \[([\s\S]*?)\]/, (whole, body) => `match = [@@MATCH@@${body}@@`)
      .replace(/not_match = \[([\s\S]*?)\]/, (whole, body) => `not_match = [${body}]`);
    const matchBody = /\n    match = \[([\s\S]*?)\n    \],/.exec(rule.text);
    const notBody = /\n    not_match = \[([\s\S]*?)\n    \],/.exec(rule.text);
    assert.ok(matchBody && notBody, `could not isolate the example lists of ${rule.pattern}`);
    void swapped;
    const mutant = rule.text
      .replace(matchBody[0], '\n    match = [@@SWAP@@\n    ],')
      .replace(notBody[0], `\n    not_match = [${matchBody[1]}\n    ],`)
      .replace('@@SWAP@@', notBody[1]);
    assert.notEqual(mutant, rule.text, 'the swap must actually change the rule');

    const { file } = tempFile(t, `inverted-${inverted}`, `${mutant}\n`);
    const result = codex(['execpolicy', 'check', '--rules', file, '--', 'rg']);
    assert.notEqual(result.status, 0,
      `${rule.pattern}: codex accepted a rule whose own examples contradict its pattern`);
    assert.match(`${result.stderr}${result.stdout}`, /expected example to (not )?match|failed to parse policy/,
      `${rule.pattern}: the rejection must name the self-test, not something incidental`);
    inverted += 1;
  }
  assert.equal(inverted, EMITTED.length, `WITNESS every emitted rule was inverted: ${inverted}`);
  t.diagnostic(`WITNESS ${inverted} inverted rules rejected by ${CODEX_VERSION}`);
});

// The write side. A rejected check must cost nothing: the deployed file stays
// byte-identical and the candidate is still pending, or a failed apply would
// quietly claim a grant it never wrote.
test('a rejected check leaves the deployed file byte-identical and records no grant', { skip }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-contract-reject-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  const history = path.join(home, '.claude', 'projects', 'p', 'session.jsonl');
  const rules = path.join(home, '.codex', 'rules', 'permission-wildcarding.rules');
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.mkdirSync(path.dirname(rules), { recursive: true });
  const call = (id, command) => JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
  const done = (id) => JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok' }] },
  });
  fs.writeFileSync(history, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'v', cwd: 'C:\\w' } }),
    call('a', 'rg --files'), done('a'),
    call('b', 'rg --files src'), done('b'),
    call('c', 'rg --files test'), done('c'),
    '',
  ].join('\n'));

  // A hand-written rule the user already had in the deployed file, OUTSIDE our
  // markers, whose own examples contradict its pattern. Codex refuses to load
  // the file, so the merged text cannot validate — and the merge is the only
  // thing this tool is allowed to change.
  const poison = [
    'prefix_rule(',
    '    pattern = ["handwritten"],',
    '    decision = "allow",',
    '    justification = "mine",',
    '    match = [', '        "not-handwritten",', '    ],',
    '    not_match = [', '        "handwritten",', '    ],',
    ')', '',
  ].join('\n');
  fs.writeFileSync(rules, poison);
  const before = fs.readFileSync(rules);

  const manager = createAutoLearnManager({ home, threshold: 3, codexRulesPath: rules });
  manager.scan({ platform: 'win32' });
  const pendingBefore = manager.listCandidates().find((item) => item.key === 'bash:rg --files');
  assert.ok(pendingBefore, 'the fixture must produce a candidate, or nothing is being tested');
  assert.ok(pendingBefore.pendingTargets.includes('codex'));

  assert.throws(() => manager.apply(), /codex execpolicy check/);
  assert.ok(fs.readFileSync(rules).equals(before), 'the deployed rules file is byte-identical');
  const after = manager.listCandidates().find((item) => item.key === 'bash:rg --files');
  assert.ok(after.pendingTargets.includes('codex'), 'a failed apply must not claim the grant');
  assert.equal((after.appliedTo || []).includes('codex'), false);
  assert.equal(manager.status().lastApplyAt, null, 'no application was recorded');
  t.diagnostic(`WITNESS rejected apply left ${before.length} bytes unchanged, verified by ${CODEX_VERSION}`);
});

// The premise of the whole effective-set change, end to end. A rule that
// validates perfectly on its own must be refused when a NEIGHBOURING rule file
// forbids the same prefix, because that is the decision Codex will make.
test('a neighbouring rule file that forbids the prefix blocks the write', { skip }, (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-contract-neighbour-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  const history = path.join(home, '.claude', 'projects', 'p', 'session.jsonl');
  const rulesDir = path.join(home, '.codex', 'rules');
  const rules = path.join(rulesDir, 'permission-wildcarding.rules');
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.mkdirSync(rulesDir, { recursive: true });
  const call = (id, command) => JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
  const done = (id) => JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok' }] },
  });
  fs.writeFileSync(history, [
    JSON.stringify({ type: 'session_meta', payload: { id: 'v', cwd: 'C:\\w' } }),
    call('a', 'rg --files'), done('a'),
    call('b', 'rg --files src'), done('b'),
    call('c', 'rg --files test'), done('c'),
    '',
  ].join('\n'));

  // First: with no neighbour, the apply succeeds. This is the control, and it is
  // what makes the refusal below attributable to the neighbour rather than to
  // anything else in the fixture.
  const clean = createAutoLearnManager({ home, threshold: 3, codexRulesPath: rules });
  clean.scan({ platform: 'win32' });
  const applied = clean.apply();
  assert.ok(applied.changedTargets.includes('codex'), 'the control apply must succeed');
  assert.match(fs.readFileSync(rules, 'utf8'), /prefix_rule\(/);
  clean.undo();

  // Now the neighbour, in the same directory Codex reads.
  fs.writeFileSync(path.join(rulesDir, 'org-overrides.rules'), [
    'prefix_rule(',
    '    pattern = ["rg"],',
    '    decision = "forbidden",',
    '    justification = "A neighbouring file the organisation ships.",',
    ')', '',
  ].join('\n'));
  const before = fs.existsSync(rules) ? fs.readFileSync(rules) : null;

  const manager = createAutoLearnManager({ home, threshold: 3, codexRulesPath: rules });
  manager.scan({ platform: 'win32' });
  let message = '';
  try {
    manager.apply();
    assert.fail('the neighbouring forbidden rule must block the write');
  } catch (error) { message = error.message; }
  assert.match(message, /did not allow generated prefix|rejected generated rules/);
  assert.match(message, /Rule files evaluated together/,
    'the error names the whole set, or it sends the reader to the wrong file');
  assert.match(message, /org-overrides\.rules/, 'and names the neighbour that actually decided');
  if (before) assert.ok(fs.readFileSync(rules).equals(before), 'the deployed file is byte-identical');
  t.diagnostic(`WITNESS neighbour conflict refused by ${CODEX_VERSION}: ${message.split('\n')[0]}`);
});
