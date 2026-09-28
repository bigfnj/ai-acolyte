'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCodexRules, removeRuleSpans, patternsOverlap } = require('../src/codex-rule-inventory');
const { renderCodexRules } = require('../src/policy-exporters');

const declaration = (pattern, decision = 'allow') =>
  `prefix_rule(pattern = ${JSON.stringify(pattern)}, decision = ${JSON.stringify(decision)})`;

test('literal inventory accepts empty policy and comments without mistaking quoted lookalikes for rules', () => {
  assert.deepEqual(parseCodexRules(''), { supported: true, rules: [] });
  assert.deepEqual(parseCodexRules('# prefix_rule(pattern=["fake"], decision="allow")\r\n# owner\t\f\r\n'),
    { supported: true, rules: [] });
  const first = String.raw`prefix_rule(
  pattern = ['git', ['status', "log",],], # prefix_rule(fake())
  decision = 'prompt',
  justification = "literal # prefix_rule(pattern = ['not-a-rule']) and \\" ,
  match = ['git status', ['git', 'log', '--oneline',],],
  not_match = ["git push",],
)`;
  const second = declaration(['git', 'push'], 'forbidden');
  const text = '# header\n' + first + ' # keep trailing comment\n\n' + second + '\n# footer';
  const parsed = parseCodexRules(text);
  assert.equal(parsed.supported, true, parsed.reason);
  assert.equal(parsed.rules.length, 2, 'WITNESS comments and quoted lookalikes never become declarations');
  assert.deepEqual(parsed.rules.map((rule) => text.slice(rule.start, rule.end)), [first, second]);
  assert.deepEqual(parsed.rules[0].pattern, ['git', ['status', 'log']]);
  assert.equal(parsed.rules[0].decision, 'prompt');
  assert.deepEqual(parsed.rules[0].match, ['git status', ['git', 'log', '--oneline']]);
  assert.deepEqual(parsed.rules[0].not_match, ['git push']);
  assert.equal(parsed.rules[1].decision, 'forbidden');
});

test('literal inventory decodes supported escapes without changing token identity', () => {
  const text = String.raw`prefix_rule(pattern = ["tool", 'it\'s', "say\"hi", "C:\\bin", "\x41\u03bb\U0001f680", "\101\400\777", "\xE9\xC3\xA9", "\a\b\f\n\r\t\v"], decision="allow")`;
  const parsed = parseCodexRules(text);
  assert.equal(parsed.supported, true, parsed.reason);
  assert.deepEqual(parsed.rules[0].pattern,
    ['tool', "it's", 'say"hi', 'C:\\bin', 'Aλ🚀', 'AĀǿ', 'éÃ©', '\x07\b\f\n\r\t\v'],
    'WITNESS literal escapes retain their actual argv characters');
  const continuation = 'prefix_rule(pattern=["tool", "ab\\\r\ncd"], decision="allow")';
  assert.deepEqual(parseCodexRules(continuation).rules[0].pattern, ['tool', 'abcd']);
});

// Killing mutation: expose already parsed rules when later executable content fails.
test('any computed or unknown Starlark makes the complete file explicitly read-only', () => {
  const valid = declaration(['git', 'status']);
  const unsupported = [
    'ROOT = "git"',
    'load("other.rules", "rules")',
    'def emit():\n  ' + valid,
    'for name in ["git"]:\n  ' + valid,
    'if True:\n  ' + valid,
    'prefix_rule(pattern=["git"] + ["status"], decision="allow")',
    'prefix_rule(pattern=[name for name in ["git"]], decision="allow")',
    'prefix_rule(pattern=make_pattern(), decision="allow")',
    'prefix_rule(pattern=["git"], decision="al" + "low")',
    'prefix_rule(pattern=["git"], decision="allow", unknown="value")',
    'prefix_rule(pattern=["git"], decision="allow", unknown=["value"])',
    'prefix_rule(pattern=["git"], decision="allow", match=examples)',
    'prefix_rule(pattern=["git"], decision="allow", **fields)',
    '"prefix_rule(pattern=[\'git\'], decision=\'allow\')"',
  ];
  for (const content of unsupported) {
    for (const text of [content + '\n' + valid, valid + '\n' + content]) {
      const parsed = parseCodexRules(text);
      assert.equal(parsed.supported, false, 'WITNESS executable or unknown content is not a complete inventory: ' + content);
      assert.deepEqual(parsed.rules, [], 'WITNESS unsupported files never expose a partial removable inventory');
      assert.match(parsed.reason, /Unsupported Codex policy at offset \d+:/);
    }
  }
});

test('malformed and unsupported literal syntax never silently becomes a valid rule', () => {
  const unsupported = [
    'prefix_rule(pattern=["git"], decision="allow") trailing',
    declaration(['git']) + ';' + declaration(['rg']),
    declaration(['git']) + ' ' + declaration(['rg']),
    ' prefix_rule(pattern=["git"], decision="allow")',
    'prefix_rule\n(pattern=["git"], decision="allow")',
    '\ufeff' + declaration(['git']),
    declaration(['git']) + '\r' + declaration(['rg']),
    '# comment\r' + declaration(['git']),
    'prefix_rule(\tpattern=["git"], decision="allow")',
    declaration(['git']) + '\t',
    declaration(['git']) + '\f',
    'prefix_rule(pattern=["git"], decision="allow"',
    'prefix_rule(pattern=["git"), decision="allow")',
    'prefix_rule(pattern=["git" "status"], decision="allow")',
    'prefix_rule(pattern=["git"], decision="allow", decision="forbidden")',
    'prefix_rule(pattern=["git"], pattern=["rg"], decision="allow")',
    'prefix_rule(["git"], "allow")',
    'prefix_rule(pattern=[], decision="allow")',
    'prefix_rule(pattern=[[]], decision="allow")',
    'prefix_rule(pattern=[[ ["git"] ]], decision="allow")',
    'prefix_rule(pattern=["git"], decision="ask")',
    'prefix_rule(pattern=["git"])',
    'prefix_rule(decision="allow")',
    'prefix_rule(pattern=[42], decision="allow")',
    'prefix_rule(pattern=["git"], decision="allow", justification=[])',
    'prefix_rule(pattern=["git"], decision="allow", justification="")',
    'prefix_rule(pattern=["git"], decision="allow", match=[[]])',
    String.raw`prefix_rule(pattern=[r"git"], decision="allow")`,
    String.raw`prefix_rule(pattern=["""git"""], decision="allow")`,
    String.raw`prefix_rule(pattern=["\q"], decision="allow")`,
    String.raw`prefix_rule(pattern=["\x4"], decision="allow")`,
    String.raw`prefix_rule(pattern=["\u123z"], decision="allow")`,
    String.raw`prefix_rule(pattern=["\uD800"], decision="allow")`,
    String.raw`prefix_rule(pattern=["\U00110000"], decision="allow")`,
    'prefix_rule(pattern=["git\nstatus"], decision="allow")',
    'prefix_rule(pattern=["git\u0000"], decision="allow")',
    'prefix_rule(pattern=["unfinished\\',
  ];
  for (const text of unsupported) {
    const parsed = parseCodexRules(text);
    assert.equal(parsed.supported, false, 'WITNESS malformed policy remains read-only: ' + JSON.stringify(text));
    assert.deepEqual(parsed.rules, []);
    assert.ok(parsed.reason);
  }
  assert.equal(parseCodexRules(null).supported, false);
});

test('exact declaration removal preserves Unicode CRLF and every unrelated byte', () => {
  const first = declaration(['git', 'status']);
  const middle = 'prefix_rule(\r\n  pattern=["tool", "😀 café"],\r\n  decision="prompt",\r\n)';
  const last = declaration(['rg', '--files']);
  const before = '# owner 🚀\r\n';
  const between = '\r\n# independent café\r\n';
  const after = ' # trailing owner comment\r\n# final';
  const text = before + first + between + middle + '\r\n' + last + after;
  const parsed = parseCodexRules(text);
  assert.equal(parsed.supported, true, parsed.reason);
  assert.equal(text.slice(parsed.rules[1].start, parsed.rules[1].end), middle);
  assert.deepEqual(Buffer.from(removeRuleSpans(text, [parsed.rules[1]])),
    Buffer.from(before + first + between + '\r\n' + last + after),
    'WITNESS deleting one declaration leaves every outside byte untouched');
  assert.equal(removeRuleSpans(text, [parsed.rules[2], parsed.rules[0]]), before + between + middle + '\r\n' + after);
  assert.equal(removeRuleSpans(text, []), text);
  assert.equal(removeRuleSpans(text, parsed.rules), before + between + '\r\n' + after);
});

test('removal refuses stale selections and cannot operate on a partial inventory', () => {
  const text = declaration(['git', 'status']) + '\n' + declaration(['rg', '--files']);
  const [first, second] = parseCodexRules(text).rules;
  const selections = [
    [{ start: first.start, end: first.end }],
    [{ ...first, start: first.start + 1 }],
    [{ ...first, end: second.end }],
    [{ ...first, pattern: ['git', 'push'] }],
    [{ ...first, decision: 'prompt' }],
    [{ ...first, justification: 'changed' }],
    [first, first],
    [null],
  ];
  for (const selected of selections) {
    assert.throws(() => removeRuleSpans(text, selected), /Refusing to remove stale, overlapping or non-declaration/,
      'WITNESS only current complete declaration records can be removed');
  }
  assert.throws(() => removeRuleSpans(text + '\ncomputed()', [first]), /Refusing to remove rules: Unsupported/);
  assert.throws(() => removeRuleSpans(text + '\ncomputed()', []), /Refusing to remove rules: Unsupported/);
  assert.throws(() => removeRuleSpans(text, null), /must be an array/);
});

test('overlap includes broad and narrow prefixes while keeping different alternatives disjoint', () => {
  const cases = [
    [['git'], ['git', 'status'], true],
    [['git', 'status'], ['git'], true],
    [['git', ['status', 'log']], ['git', 'log', '--oneline'], true],
    [['git', ['status', 'log']], ['git', ['log', 'show']], true],
    [[['git', 'git.exe'], ['status', 'log']], ['git.exe', 'status'], true],
    [['git', ['status', 'log']], ['git', 'push'], false],
    [['git', ['status', 'log']], ['git', ['push', 'fetch']], false],
    [['git', 'status'], ['git', 'status-extra'], false],
    [['git'], ['Git'], false],
    [['git'], ['git.exe'], false],
    [['git'], ['C:\\bin\\git'], false],
    [['git', ''], ['git', '--version'], false],
  ];
  for (const [a, b, expected] of cases) {
    assert.equal(patternsOverlap(a, b), expected, 'WITNESS exact prefix/alternative overlap: ' + JSON.stringify([a, b]));
    assert.equal(patternsOverlap(b, a), expected, 'overlap is symmetric');
  }
  for (const bad of [null, [], [[]], [42], [[['git']]]]) {
    assert.throws(() => patternsOverlap(bad, ['git']), /must be nonempty literal patterns/);
    assert.throws(() => patternsOverlap(['git'], bad), /must be nonempty literal patterns/);
  }
});

test('overlap agrees with independent finite argv enumeration across every varied axis', () => {
  const tokens = ['git', 'Git', 'status', 'push'];
  const positions = [...tokens, ['git', 'Git'], ['status', 'push']];
  const patterns = [...positions.map((p) => [p]), ...positions.flatMap((a) => positions.map((b) => [a, b]))];
  const commands = tokens.flatMap((a) => tokens.flatMap((b) => tokens.map((c) => [a, b, c])));
  const matches = (pattern, command) => pattern.every((part, index) =>
    typeof part === 'string' ? part === command[index] : part.includes(command[index]));
  let overlaps = 0;
  let disjoint = 0;
  for (const a of patterns) {
    for (const b of patterns) {
      const expected = commands.some((command) => matches(a, command) && matches(b, command));
      if (expected) overlaps++;
      else disjoint++;
      assert.equal(patternsOverlap(a, b), expected, JSON.stringify([a, b]));
    }
  }
  assert.ok(overlaps > 0 && disjoint > 0, 'WITNESS exhaustive overlap corpus contains both outcomes');
  assert.ok(patterns.some((p) => p.length === 1) && patterns.some((p) => p.length === 2));
});

test('actual generated grouped git rules remain complete inventory declarations', () => {
  const text = renderCodexRules([
    { prefix: ['git', 'status'], autoSafe: true, successCount: 4 },
    { prefix: ['git', 'ls-files'], autoSafe: true, successCount: 3 },
    { prefix: ['rg', '--files'], autoSafe: true, successCount: 4 },
  ]);
  const parsed = parseCodexRules(text);
  assert.equal(parsed.supported, true, parsed.reason);
  assert.equal(parsed.rules.length, 2);
  const git = parsed.rules.find((rule) => rule.pattern[0] === 'git');
  assert.ok(git && Array.isArray(git.pattern[1]), 'WITNESS exporter produced a grouped git declaration');
  assert.deepEqual(new Set(git.pattern[1]), new Set(['ls-files', 'status']));
  assert.ok(git.match.length > 0 && git.not_match.length > 0);
  const retained = parseCodexRules(removeRuleSpans(text, [git]));
  assert.equal(retained.supported, true);
  assert.deepEqual(retained.rules.map((rule) => rule.pattern), [['rg', '--files']]);
});
