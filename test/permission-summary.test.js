'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCodexPermissionSummary, deadShellApprovals, overBroadShellGrants } = require('../src/permission-summary');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-permission-summary-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, 'selected-codex');
  const rules = path.join(codexHome, 'rules');
  fs.mkdirSync(rules, { recursive: true });
  const write = (name, content) => {
    const file = path.join(rules, name);
    fs.writeFileSync(file, content);
    return file;
  };
  return { home, codexHome, rules, write, read: (extra = {}) => readCodexPermissionSummary({ home, codexHome, ...extra }) };
}

const rule = (pattern, decision = 'allow') => `prefix_rule(pattern=${JSON.stringify(pattern)}, decision="${decision}")\n`;
const counts = ({ allow, prompt, forbidden, total, complete }) => ({ allow, prompt, forbidden, total, complete });

test('Codex summary counts saved declarations once, including grouped alternatives and restrictive decisions', (t) => {
  const f = fixture(t);
  f.write('first.rules', '# prefix_rule(pattern=["fake"], decision="allow")\n'
    + rule([['git', 'git.exe'], ['status', 'diff']]) + rule(['git', 'status'])
    + rule(['git', 'push'], 'prompt') + rule(['git', 'push', '--force'], 'forbidden'));
  f.write('second.rules', rule(['git', 'status']));
  f.write('ignored.txt', rule(['ignored']));
  const before = fs.readdirSync(f.rules).map((name) => [name, fs.readFileSync(path.join(f.rules, name), 'hex')]);
  const summary = f.read();
  assert.deepEqual(counts(summary), { allow: 3, prompt: 1, forbidden: 1, total: 5, complete: true },
    'WITNESS each declaration is counted once and prompt/forbidden are never allow approvals');
  assert.equal(summary.files.length, 2);
  assert.deepEqual(summary.allowRules.map(({ pattern }) => pattern), [
    [['git', 'git.exe'], ['status', 'diff']], ['git', 'status'], ['git', 'status'],
  ], 'saved-list rows retain grouped prefixes and duplicate declarations but exclude restrictions');
  assert.notEqual(summary.allowRules[1].path, summary.allowRules[2].path,
    'matching prefixes from different files remain individually inspectable');
  assert.ok(summary.allowRules.every((entry) => Number.isInteger(entry.start)));
  assert.deepEqual(summary.issues, []);
  assert.ok(summary.blindSpots.some((text) => text.includes('Managed and system-scope')));
  assert.deepEqual(fs.readdirSync(f.rules).map((name) => [name, fs.readFileSync(path.join(f.rules, name), 'hex')]), before);
  assert.deepEqual(fs.readdirSync(f.home), ['selected-codex'], 'WITNESS summary reads create no learner state or backup');
});

test('unsupported files contribute no partial-file count while supported siblings remain visible', (t) => {
  const f = fixture(t);
  f.write('known.rules', rule(['rg']) + rule(['git', 'push'], 'prompt'));
  const unknown = f.write('computed.rules', rule(['must-not-count']) + 'value = "computed"\n');
  const summary = f.read();
  assert.deepEqual(counts(summary), { allow: 1, prompt: 1, forbidden: 0, total: 2, complete: false },
    'WITNESS an unsupported file cannot inflate known counts or erase readable siblings');
  assert.equal(summary.issues.length, 1);
  assert.deepEqual(summary.allowRules.map(({ pattern }) => pattern), [['rg']],
    'an unsupported file contributes no misleading partial preview');
  assert.equal(summary.issues[0].path, unknown);
  assert.match(summary.issues[0].reason, /Unsupported/);
  assert.equal(summary.files.find((file) => file.path === unknown).supported, false);
});

test('empty and missing rule directories are complete zero counts', (t) => {
  const f = fixture(t);
  for (const codexHome of [f.codexHome, path.join(f.home, 'missing-codex')]) {
    const summary = f.read({ codexHome });
    assert.deepEqual(counts(summary), { allow: 0, prompt: 0, forbidden: 0, total: 0, complete: true });
    assert.deepEqual(summary.files, []);
    assert.deepEqual(summary.issues, []);
  }
});

test('unreadable files report a partial known subtotal and do not become zero approvals', (t) => {
  const f = fixture(t);
  const unreadable = f.write('private.rules', rule(['secret']));
  f.write('readable.rules', rule(['git', 'status']));
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === unreadable) throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
    return read(file, ...args);
  });
  const summary = f.read();
  assert.deepEqual(counts(summary), { allow: 1, prompt: 0, forbidden: 0, total: 1, complete: false },
    'WITNESS an unreadable sibling makes the displayed count incomplete');
  assert.deepEqual(summary.issues, [{ path: unreadable, reason: 'fixture access denied' }]);
});

test('directory enumeration failures are unknown rather than complete zero counts', (t) => {
  const f = fixture(t);
  const read = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (directory, ...args) => {
    if (directory === f.rules) throw Object.assign(new Error('fixture directory access denied'), { code: 'EACCES' });
    return read(directory, ...args);
  });
  const summary = f.read();
  assert.deepEqual(counts(summary), { allow: 0, prompt: 0, forbidden: 0, total: 0, complete: false },
    'WITNESS unreadable directory is not reported as verified zero');
  assert.deepEqual(summary.issues, [{ path: f.rules, reason: 'fixture directory access denied' }]);
});

test('custom Codex home wins and Auto Learn scope off does not hide existing rules', (t) => {
  const f = fixture(t);
  const defaultRules = path.join(f.home, '.codex', 'rules');
  fs.mkdirSync(defaultRules, { recursive: true });
  fs.writeFileSync(path.join(defaultRules, 'default.rules'), rule(['wrong-home']) + rule(['another-wrong-home']));
  f.write('selected.rules', rule(['selected']));
  assert.deepEqual(counts(f.read({ codexScope: 'off', codexRulesPath: null })),
    { allow: 1, prompt: 0, forbidden: 0, total: 1, complete: true },
    'WITNESS disabling automatic writes leaves selected-profile saved permissions visible');
  assert.equal(readCodexPermissionSummary({ home: f.home }).allow, 2,
    'WITNESS explicit home also supports its normal .codex layout');
});

test('an explicit target outside the user rules directory is included without double counting an in-directory target', (t) => {
  const f = fixture(t);
  const inside = f.write('selected.rules', rule(['inside']));
  const outside = path.join(f.home, 'explicit-target.rules');
  fs.writeFileSync(outside, rule(['outside'], 'forbidden'));
  assert.deepEqual(counts(f.read({ target: outside })), { allow: 1, prompt: 0, forbidden: 1, total: 2, complete: true });
  assert.equal(f.read({ target: inside }).total, 1, 'WITNESS selected target is not counted twice');
});

test('non-regular rules and invalid UTF-8 stay explicit unknown inputs', (t) => {
  const f = fixture(t);
  const directory = path.join(f.rules, 'directory.rules');
  fs.mkdirSync(directory);
  const invalid = f.write('invalid.rules', Buffer.from([0xff, 0xfe]));
  const summary = f.read();
  assert.deepEqual(counts(summary), { allow: 0, prompt: 0, forbidden: 0, total: 0, complete: false });
  assert.equal(summary.issues.length, 2);
  assert.match(summary.issues.find((entry) => entry.path === directory).reason, /non-regular/);
  assert.match(summary.issues.find((entry) => entry.path === invalid).reason, /UTF-8/);
});

// One-off shell approvals (2026-10-13). Every entry below is synthetic: each is the
// SHAPE a real allow list was measured to hold, never a real entry. Each test drives one
// reason, so dropping that reason from DEAD_APPROVAL_REASONS fails the test named for it.
const dead = (list) => deadShellApprovals(list);
for (const [reason, entry, alsoCounted] of [
  // A chain is compound on every segment. No other dead reason fires for this one, so
  // dropping the reason makes the entry live again.
  ['compound-command', 'Bash(git add src && git commit -m wip)', []],
  // `for` without a body has no `;` and no `$(`, so the keyword is the only reason.
  ['reserved-keyword', 'Bash(for f in a b)', []],
  // A command substitution is script syntax and nothing else.
  ['script-syntax', 'Bash(echo $(date))', []],
  // A variable opener has no root, so it is always BOTH of these; the per-reason count is
  // what dropping either one changes.
  ['dynamic-executable', 'PowerShell($stamp = Get-Date)', ['missing-command-root']],
  // A range literal (2026-10-13, src/auto-learn.js containsScriptSyntax) has no root
  // either, and is script syntax.
  ['missing-command-root', 'PowerShell(1..6)', ['script-syntax']],
]) {
  test(`a saved approval flagged ${reason} is counted as a one-off`, () => {
    // MUTATION: drop '${reason}' from DEAD_APPROVAL_REASONS in src/permission-summary.js.
    // Its per-reason count disappears, and where it is the only reason the entry stops
    // counting at all. Confirmed 2026-10-13, one reason at a time.
    const result = dead([entry, 'Bash(git status)']);
    assert.equal(result.byReason[reason], 1, `${entry}: ${JSON.stringify(result.byReason)}`);
    assert.deepEqual(Object.keys(result.byReason).sort(), [reason, ...alsoCounted].sort());
    assert.deepEqual(result.entries, [entry]);
    assert.equal(result.count, 1);
    assert.equal(result.total, 2, 'both exact shell entries were examined');
  });
}

test('ordinary exact approvals, including path and call-operator executables, are not one-offs', () => {
  // The control, and the reason `shell-structure` is NOT in the set (see the comment on
  // DEAD_APPROVAL_REASONS). A path or quoted executable raises `shell-structure` on its
  // own, yet it is an ordinary command that matches again when re-run; counting it
  // would invite deleting an approval that works.
  // MUTATION: add 'shell-structure' to DEAD_APPROVAL_REASONS. The two executable forms
  // below are then counted. Confirmed 2026-10-13.
  const result = dead([
    'Bash(git status)', 'Bash(npm test)', 'Bash(./scripts/build.sh --release)',
    'PowerShell(& "C:\\Tools\\probe.exe" --version)', 'PowerShell(Get-ChildItem -Force)',
  ]);
  assert.deepEqual(result, { count: 0, total: 5, byReason: {}, entries: [] });
});

test('patterns and non-shell entries are not judged', () => {
  // An entry with any `*` is a pattern that may match more than its own text, so it is
  // skipped (neither counted nor examined) even when its text is a one-off shape. Tools
  // that are not shell commands, and non-strings, are ignored the same way.
  // MUTATION: drop the `entry.includes('*')` skip. The loop below is examined, flagged
  // compound and reserved, and counted. Confirmed 2026-10-13.
  const result = dead([
    'Bash(for f in *.txt; do wc -l $f; done)', 'Bash(git status *)', 'PowerShell(Get-Item *)',
    'Read(~/notes/**)', 'WebSearch', 'mcp__fixture__tool', 42, null,
  ]);
  assert.deepEqual(result, { count: 0, total: 0, byReason: {}, entries: [] });
  assert.deepEqual(dead('not a list'), { count: 0, total: 0, byReason: {}, entries: [] });
});

test('the result is memoized on the list contents', () => {
  const list = ['PowerShell($stamp = Get-Date)', 'Bash(git status)'];
  const first = dead(list);
  // MUTATION: delete the memo early-return in deadShellApprovals. Every call builds a
  // fresh object and this identity check fails. Confirmed 2026-10-13.
  assert.equal(dead(list.slice()), first, 'an equal list is the same answer, not a recomputation');
  // And it is keyed on CONTENT, not identity or length: one changed entry is a new answer.
  // MUTATION: key the memo on list.length; this fails. Confirmed 2026-10-13.
  const changed = dead(['PowerShell(1..6)', 'Bash(git status)']);
  assert.notEqual(changed, first);
  assert.deepEqual(changed.entries, ['PowerShell(1..6)']);
  // The memo hands one object to every caller, so it must not be writable by them.
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.entries) && Object.isFrozen(first.byReason));
});

// Over-broad wildcard grants (2026-10-13): saved WILDCARD shell entries whose head is
// shell grammar rather than a command, the shapes the pre-a910daf pass minted. Every
// entry is synthetic. Each row drives one reason, so dropping that reason from
// OVER_BROAD_REASONS fails the row named for it.
const broad = (list) => overBroadShellGrants(list);
for (const [reason, entry, alsoCounted] of [
  ['reserved-keyword', 'Bash(for *)', []],
  ['reserved-keyword', 'Bash(export *)', []],          // the shape found on a real list
  ['reserved-keyword', 'Bash(eval:*)', []],            // the colon spelling is the same rule
  ['reserved-keyword', 'PowerShell(foreach *)', []],
  // An expansion opener has no literal root, so it is always both of these.
  ['dynamic-executable', 'Bash($EDITOR *)', ['missing-command-root']],
  ['dynamic-executable', 'Bash([[ *)', ['missing-command-root']],
  // A range literal and the call operator have no command root at all. `PowerShell(& *)` was
  // the call-operator row until 2026-10-14; it is one of the maintainer-kept grants now (the
  // test after the controls), so the same head under Bash, where `&` backgrounds, takes it.
  ['missing-command-root', 'PowerShell(1..6 *)', []],
  ['missing-command-root', 'Bash(& *)', []],
  // A bare assignment yields no invocation from extractInvocations; classifyInvocation
  // is asked directly and reports the missing root.
  ['missing-command-root', 'Bash(FOO=bar *)', []],
]) {
  test(`a wildcard grant whose head is flagged ${reason} is counted: ${entry}`, () => {
    // MUTATION: drop '${reason}' from OVER_BROAD_REASONS in src/permission-summary.js.
    // Its per-reason count disappears and, where it is the only reason, the entry stops
    // counting. Confirmed 2026-10-13, one reason at a time. MUTATION: drop the
    // classifyInvocation fallback; `Bash(FOO=bar *)` and `Bash(& *)` (`PowerShell(& *)`
    // until 2026-10-14), the heads with no invocation, are no longer counted. Confirmed
    // 2026-10-13, and for `Bash(& *)` 2026-10-14.
    const result = broad([entry, 'Bash(git status *)']);
    assert.equal(result.byReason[reason], 1, `${entry}: ${JSON.stringify(result.byReason)}`);
    assert.deepEqual(Object.keys(result.byReason).sort(), [reason, ...alsoCounted].sort());
    assert.deepEqual(result.entries, [entry]);
    assert.equal(result.count, 1);
    assert.equal(result.total, 2, 'both wildcard shell entries were examined');
  });
}

test('ordinary wildcard grants, runner roots and the two exempt words are not over-broad', () => {
  // `source` and `[` are reserved to the classifier, but they are the `.` runner and
  // `test`, which src/permissions.js wildcards by design; flagging them would ask the
  // user to remove a grant the next approval re-mints.
  // MUTATION: empty OVER_BROAD_EXEMPT_BASH_HEADS. `Bash(source *)` (reserved-keyword)
  // and `Bash([ *)` (dynamic-executable) are counted and this fails. Confirmed 2026-10-13.
  // A head that is only a wrapper (`command`, `timeout 5`) is not counted because the
  // classifier keeps a wrapper that wraps nothing as the root, a `shell-wrapper` command
  // (9a5324e, as Claude Code does). Corrected 2026-10-14: this used to say "MUTATION: drop the
  // `stripped-wrapper` line; `Bash(command *)` is counted as a missing root. Confirmed
  // 2026-10-13", which stopped being true with 9a5324e the same day: deleting that line left
  // this file and the whole suite green (measured 2026-10-14). The heads that reach the line
  // are a wrapper followed only by assignments; the next test pins them.
  const result = broad([
    'Bash(git status *)', 'Bash(bash *)', 'Bash(. *)', 'Bash(source *)', 'Bash([ *)',
    'Bash(command *)', 'Bash(timeout 5 *)', 'Bash(rm *)', 'PowerShell(Get-ChildItem *)',
    'PowerShell(select *)', 'PowerShell(7z *)',
  ]);
  assert.deepEqual(result, { count: 0, total: 11, byReason: {}, entries: [], kept: ['Bash(bash *)'] });
  // `source` is exempt in Bash only; PowerShell has no such word to exempt, and a
  // PowerShell keyword is still flagged next to it.
  assert.deepEqual(broad(['PowerShell(foreach *)', 'Bash(source *)']).entries, ['PowerShell(foreach *)']);
});

test('a wrapper followed only by assignments has its command under the star, so it is not a missing root', () => {
  // The heads that reach the `stripped-wrapper` line in overBroadShellGrants (2026-10-14).
  // The classifier strips the wrapper, steps over the assignment and finds no executable, so it
  // reports `missing-command-root` and `stripped-wrapper` together; the command is under the
  // star, and the wrapper would exec `FOO=1` itself as its program, so the head is not grammar.
  const { classifyInvocation, extractInvocations } = require('../src/auto-learn');
  assert.deepEqual(extractInvocations('Bash', 'timeout 5 FOO=1'), [], 'precondition: no executable in the head');
  const reasons = classifyInvocation({ tool: 'Bash', command: 'timeout 5 FOO=1' }).reasons;
  assert.ok(reasons.includes('stripped-wrapper') && reasons.includes('missing-command-root'), JSON.stringify(reasons));
  // MUTATION: delete the `stripped-wrapper` line. All three are counted as missing roots and
  // this fails. Confirmed 2026-10-14.
  const result = broad(['Bash(timeout 5 FOO=1 *)', 'Bash(nohup FOO=1 *)', 'Bash(command FOO=1 *)', 'Bash(git status *)']);
  assert.deepEqual(result, { count: 0, total: 4, byReason: {}, entries: [], kept: [] });
  // Control: an assignment that OPENS the head is still a missing root (the row above).
  assert.deepEqual(broad(['Bash(FOO=bar *)']).entries, ['Bash(FOO=bar *)']);
});

test('exact entries, the tool-wide grant and non-shell entries are not judged', () => {
  // Exact entries are deadShellApprovals' half; `Bash(*)` is an explicit tool-wide
  // grant with no head to classify.
  // MUTATION: drop the WILDCARD_TAIL test so exact entries are examined too.
  // `Bash(for f in a b)` is then counted. Confirmed 2026-10-13.
  const result = broad(['Bash(for f in a b)', 'PowerShell($x = 1)', 'Bash(*)', 'Read(**)',
    'WebSearch', 'mcp__fixture__tool', 42, null]);
  assert.deepEqual(result, { count: 0, total: 0, byReason: {}, entries: [], kept: [] });
  assert.deepEqual(broad('not a list'), { count: 0, total: 0, byReason: {}, entries: [], kept: [] });
});

test('the 13 blanket grants the maintainer kept are examined and reported apart, never counted', () => {
  // `PowerShell(& *)` is one of the starter pack's 13 blanket interpreter grants, left in
  // place on the maintainer's call (docs/engineering-record.md, "The 13 blanket wrapper
  // grants"), and it is the one of them this diagnostic flags. It was half of the count on the
  // development box (2026-10-13: `Bash(export *)` and `PowerShell(& *)`), so the dashboard
  // asked, on every push, for the removal of a grant the project seeds on purpose.
  // MUTATION: drop the KEPT_HEADS check in overBroadShellGrants. `PowerShell(& *)` and its
  // colon spelling are counted and this fails. Confirmed 2026-10-14.
  const result = broad(['PowerShell(& *)', 'PowerShell(&:*)', 'Bash(bash *)', 'Bash(export *)', 'Bash(& *)']);
  assert.deepEqual(result.entries, ['Bash(export *)', 'Bash(& *)'], 'only the grants nobody decided on are counted');
  assert.equal(result.count, 2);
  assert.equal(result.total, 5, 'the kept grants are still examined');
  assert.deepEqual(result.kept, ['PowerShell(& *)', 'PowerShell(&:*)', 'Bash(bash *)']);
  // Matched by tool and head, not by text alone: the same head under the other tool, and a
  // longer head, are judged as before (`PowerShell(& tool *)` names its program).
  assert.deepEqual(broad(['Bash(& *)', 'PowerShell(& tool *)']).kept, []);
  assert.ok(Object.isFrozen(result.kept));
});

test('the over-broad result is memoized on the list contents, separately from the one-off memo', () => {
  const list = ['Bash(export *)', 'Bash(git status *)'];
  const first = broad(list);
  // MUTATION: delete the memo early-return in overBroadShellGrants. Every call builds a
  // fresh object and this identity check fails. Confirmed 2026-10-13.
  assert.equal(broad(list.slice()), first);
  // Interleaving the other diagnostic must not evict this memo (two memo cells, not one).
  dead(list);
  assert.equal(broad(list), first, 'the one-off memo is a separate cell');
  const changed = broad(['Bash(for *)', 'Bash(git status *)']);
  assert.notEqual(changed, first);
  assert.deepEqual(changed.entries, ['Bash(for *)']);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.entries) && Object.isFrozen(first.byReason));
});
