'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { planStoredCodexApprovals, planProjectCodexRules } = require('../src/codex-approval-plans');
const { parseCodexRules } = require('../src/codex-rule-inventory');
const { CODEX_BEGIN_MARKER } = require('../src/policy-exporters');

const workspaceRoot = path.resolve('fixture-project');
const file = path.join(workspaceRoot, '.codex', 'rules', 'authored.rules');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const declaration = (pattern, decision = 'allow') =>
  `prefix_rule(pattern = ${JSON.stringify(pattern)}, decision = ${JSON.stringify(decision)})`;
const managed = (text) => `${CODEX_BEGIN_MARKER}\n${text}\n${CODEX_BEGIN_MARKER.replace('BEGIN ', 'END ')}\n`;
const stored = (text, options = {}) => planStoredCodexApprovals({ path: file, text, ...options });
const project = (text, options = {}) => planProjectCodexRules({ path: file, text, workspaceRoot, ...options });

test('stored approval plans bind exact source bytes and preserve argv spelling while widening only the target', () => {
  const original = 'prefix_rule(\r\n pattern=["Git.EXE", "status", "--short"],\r\n decision="allow", justification="café 🚀",\r\n not_match=[["Git.EXE", "status", "--long"]],\r\n)';
  const text = '# owner\r\n' + original + ' # keep trailing comment\r\n';
  const input = Object.freeze({ path: file, text });
  const result = planStoredCodexApprovals(input);
  assert.equal(result.supported, true);
  assert.equal(result.plans.length, 1, 'WITNESS a narrow stored auto-safe approval produces one proposal');
  const plan = result.plans[0];
  assert.deepEqual(plan.target.pattern, ['Git.EXE', 'status'], 'WITNESS target preserves exact argv case and order');
  assert.equal(plan.target.text, declaration(['Git.EXE', 'status']));
  assert.equal(plan.source.text, original, 'WITNESS source declaration retains Unicode CRLF and inline tests');
  assert.equal(text.slice(plan.source.start, plan.source.end), original);
  assert.equal(plan.source.hash, hash(text), 'WITNESS source hash binds the complete original bytes');
  assert.equal(plan.source.path, file);
  assert.equal(plan.source.origin, 'authored');
  assert.equal(plan.preserveSource, true);
  assert.equal(plan.reviewRequired, true);
  assert.equal(plan.autoApply, false, 'WITNESS proposals never authorize automatic application');
  assert.equal(plan.autoSafe, true);
  assert.equal(plan.kind, 'stored-widening');
  assert.equal(input.text, text);
  assert.deepEqual(parseCodexRules(plan.target.text).rules[0].pattern, plan.target.pattern);
  assert.equal(stored(text).plans[0].id, plan.id);
  assert.notEqual(stored(text + '# changed\r\n').plans[0].id, plan.id,
    'WITNESS source hash makes stale source selections distinct');
  assert.notEqual(stored(text, { path: path.join(path.dirname(file), 'other.rules') }).plans[0].id, plan.id);
});

test('stored approval alternatives require every branch auto-safe and retain grouped prefix axes', () => {
  const grouped = [['git.exe', 'git'], ['status', 'ls-files'], ['--short', '--long']];
  const result = stored(declaration(grouped));
  assert.equal(result.plans.length, 1);
  assert.deepEqual(result.plans[0].target.pattern, grouped.slice(0, 2),
    'WITNESS alternatives retain their original position spelling and order');
  const unsafe = stored(declaration(['git', ['status', 'push'], '--short']));
  assert.equal(unsafe.plans.length, 0, 'WITNESS one unsafe alternative blocks the entire stored widening');
  assert.match(unsafe.skipped[0].reason, /every alternative is auto-safe/);
  const mixedLengths = stored(declaration(['whoami', ['--help', '-a'], '--verbose']));
  assert.equal(mixedLengths.plans.length, 0);
  assert.match(mixedLengths.skipped[0].reason, /auto-safe|different reusable prefix lengths/);
  const excessive = stored(declaration(['git', Array.from({ length: 257 }, (_, index) => 'status' + index), '--short']));
  assert.equal(excessive.plans.length, 0);
  assert.match(excessive.skipped[0].reason, /256/);
  assert.equal(stored(declaration(['git', ['status', 'status'], '--short'])).plans.length, 1);
});

test('stored approvals never widen restrictive decisions or across an overlapping restriction', () => {
  const narrow = declaration(['git', 'status', '--short']);
  for (const blocked of [['git'], ['git', 'status'], ['git', 'status', '--long'], ['git', ['push', 'status'], '--long']]) {
    const result = stored(narrow + '\n' + declaration(blocked, 'forbidden'));
    assert.equal(result.plans.length, 0, 'WITNESS broad and narrow restrictive overlap blocks widening');
    assert.match(result.skipped[0].reason, /overlaps/);
    assert.equal(result.skipped[1].source.decision, 'forbidden');
  }
  assert.equal(stored(narrow + '\n' + declaration(['git', 'status'], 'prompt')).plans.length, 0);
  assert.equal(stored(narrow + '\n' + declaration(['git', 'push'], 'forbidden')).plans.length, 1,
    'different subcommands do not overlap');
  assert.equal(stored(narrow + '\n' + declaration(['Git', 'status'], 'forbidden')).plans.length, 1,
    'different executable case stays distinct');
  assert.equal(stored(declaration(['git', 'status', '--short'], 'prompt')).plans.length, 0);
});

test('stored approval no-op detection respects prefix breadth and case without duplicate proposals', () => {
  const narrow = declaration(['git', 'status', '--short']);
  assert.equal(stored(declaration(['git', 'status'])).plans.length, 0);
  for (const existing of [['git'], ['git', 'status'], [['git.exe', 'git'], ['status', 'ls-files']]]) {
    const result = stored(narrow + '\n' + declaration(existing));
    assert.equal(result.plans.length, 0, 'WITNESS an existing broader allow suppresses redundant widening');
    assert.match(result.skipped[0].reason, /already covers/);
  }
  assert.equal(stored(narrow + '\n' + declaration(['git', 'status', '--long'])).plans.length, 1,
    'narrow sibling approvals need one shared proposal');
  assert.equal(stored(narrow + '\n' + declaration(['Git', 'status'])).plans.length, 1);
  assert.equal(stored(narrow + '\n' + declaration(['git', 'push'])).plans.length, 1);
});

test('proposal portability refuses contextual executable and argument variants without broadening unsafe families', () => {
  const refused = [
    ['/usr/bin/git', 'status', '--short'], ['C:\\bin\\git.exe', 'status', '--short'], ['./git', 'status', '--short'],
    ['git', 'status', 'README.md'], ['git', 'status', '.'], ['git', 'status', '../other'],
    ['git', 'status', '--porcelain=v1'], ['git', 'status', '$HOME'], ['git', 'status', '%TEMP%'],
    ['git', 'status', '~'], ['git', 'status', 'two words'], ['git', 'status', 'D:relative'],
    ['git', '-C', 'repo', 'status'], ['npm', 'run', 'build'], ['tool', '-x', 'resource'],
  ];
  for (const pattern of refused) {
    assert.equal(stored(declaration(pattern)).plans.length, 0, 'WITNESS contextual stored approvals are not widened');
    assert.equal(project(declaration(pattern)).plans.length, 0, 'WITNESS contextual project rules are not imported');
  }
  for (const pattern of [['git', 'push', '--force'], ['git', 'log', '--oneline'], ['rm', '-rf'], ['tool', '-x']]) {
    const result = stored(declaration(pattern));
    assert.equal(result.plans.length, 0, 'WITNESS non-auto-safe families never become stored widening proposals');
    assert.match(result.skipped[0].reason, /auto-safe/);
    assert.equal(project(declaration(pattern)).plans.length, 1, 'exact portable reviewed import has different eligibility');
  }
  assert.equal(stored(declaration(['rg', '--files', '--hidden'])).plans.length, 1);
  assert.equal(project(declaration(['git', 'status', '--short'])).plans.length, 1);
});

test('project imports preserve exact authored decisions metadata and review boundaries', () => {
  const rules = [
    'prefix_rule(\r\n pattern=["git", "status", "--short"], decision="allow", justification="café 🚀", match=[["git", "status", "--short"]],\r\n)',
    declaration(['git', 'push'], 'prompt'),
    declaration(['rm', '-rf'], 'forbidden'),
    declaration(['git', 'push', '--force']),
  ];
  const text = '# user\r\n' + rules.join('\r\n# divider\r\n') + '\r\n';
  const result = project(text);
  assert.equal(result.plans.length, 4);
  assert.deepEqual(result.plans.map((entry) => entry.target.decision), ['allow', 'prompt', 'forbidden', 'allow'],
    'WITNESS project import does not downcast restrictive decisions');
  for (const [index, plan] of result.plans.entries()) {
    assert.equal(plan.kind, 'project-import');
    assert.equal(plan.target.text, rules[index], 'WITNESS imported declaration is exact including metadata and CRLF');
    assert.deepEqual(plan.target.pattern, parseCodexRules(rules[index]).rules[0].pattern);
    assert.equal(plan.source.text, rules[index]);
    assert.equal(plan.source.hash, hash(text));
    assert.equal(plan.preserveSource, true);
    assert.equal(plan.reviewRequired, true);
    assert.equal(plan.autoApply, false);
    assert.match(plan.reviewReason, /user scope/);
  }
  assert.equal(result.plans[0].autoSafe, true);
  assert.equal(result.plans[3].autoSafe, false);
  assert.match(result.plans[3].reviewReason, /not auto-safe.*explicit review/,
    'WITNESS non-auto-safe exact allows require an explicit review reason');
});

test('project import scope is the selected workspace direct rules directory only', () => {
  const text = declaration(['git', 'status']);
  for (const alternate of [path.join(workspaceRoot, 'authored.rules'), path.join(workspaceRoot, '.codex', 'rules', 'nested', 'a.rules'),
    path.join(workspaceRoot, '.codex', 'rules', 'a.json'), path.join(workspaceRoot, 'other', '.codex', 'rules', 'a.rules')]) {
    const result = project(text, { path: alternate });
    assert.equal(result.supported, false, 'WITNESS files outside the selected project rules directory are refused');
    assert.equal(result.plans.length, 0);
    assert.match(result.reason, /direct/);
  }
  assert.equal(project(text).plans.length, 1);
  assert.throws(() => project(text, { workspaceRoot: 'relative' }), /absolute/);
  assert.throws(() => stored(text, { path: 'relative.rules' }), /absolute/);
});

test('generated and authored declarations remain distinct and ambiguous markers refuse the whole file', () => {
  const generated = declaration(['git', 'status', '--short']);
  const authored = declaration(['rg', '--files', '--hidden']);
  const text = managed(generated) + '\n' + authored;
  for (const planner of [stored, project]) {
    const result = planner(text);
    assert.equal(result.plans.length, 1, 'WITNESS generated declarations never become authored proposals');
    assert.deepEqual(result.plans[0].source.pattern, ['rg', '--files', '--hidden']);
    assert.equal(result.skipped[0].source.origin, 'generated');
    assert.match(result.skipped[0].reason, /Generated/);
    for (const bad of [text + '\n' + CODEX_BEGIN_MARKER, CODEX_BEGIN_MARKER + '\n' + authored,
      'prefix_rule(\n' + CODEX_BEGIN_MARKER + '\npattern=["git"], decision="allow")\n' + CODEX_BEGIN_MARKER.replace('BEGIN ', 'END ')]) {
      const refused = planner(bad);
      assert.equal(refused.supported, false, 'WITNESS ambiguous generated ownership refuses every proposal');
      assert.deepEqual(refused.plans, []);
      assert.match(refused.reason, /ambiguous|cross/);
    }
  }
});

test('whole-file computed malformed and lossy sources never yield partial plans', () => {
  const valid = declaration(['git', 'status', '--short']);
  const badTexts = [valid + '\nvalue = ["git"]', valid + '\nunknown()', valid + '\n' + declaration(['git']) + ',',
    valid + '\n\ud800', valid + '\nprefix_rule(pattern=["git"], decision="ask")'];
  for (const planner of [stored, project]) {
    for (const text of badTexts) {
      const result = planner(text);
      assert.equal(result.supported, false, 'WITNESS unsupported suffix refuses the complete source file');
      assert.deepEqual(result.plans, []);
      assert.deepEqual(result.skipped, []);
      assert.equal(typeof result.reason, 'string');
    }
    const empty = planner('# owner\r\n');
    assert.equal(empty.supported, true);
    assert.deepEqual(empty.plans, []);
  }
});
