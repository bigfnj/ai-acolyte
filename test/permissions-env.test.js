'use strict';

// A leading environment assignment is stripped from a Bash entry only when Claude Code
// strips it before an allow rule is consulted; any other assignment is kept, verbatim,
// in the rule.
//
// Evidence, read 2026-10-13. The docs (code.claude.com/docs/en/permissions, "Wrappers"):
// "Claude Code also strips a leading assignment of certain known-safe environment
// variables, so `Bash(npm test *)` matches `NODE_ENV=test npm test`. An allow rule won't
// match past an assignment of any other variable." The page does not name the variables.
// Claude Code 2.1.296's shipped binary does: the allow-path routine removes a leading
// `NAME=VALUE ` only while NAME is in one fixed set of 39 and VALUE matches
// `[A-Za-z0-9_./:-]+`. The same binary's allow matcher tries each rule against the
// command text as written as well as the stripped text, and its own "don't ask again"
// suggestion for a line led by any other assignment is the exact rule with the
// assignment in it. So `Bash(FOO=1 git push *)` matches `FOO=1 git push origin`, and
// `Bash(git push *)` does not.
//
// Every entry here is synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');

const { generalizePermission, processAllowList, claudeStripsAssignment } = require('../src/permissions');
const { ruleMatches } = require('../src/permission-match');

// The list as read from the binary, as a LITERAL, so an edit that drops one fails here
// naming it, and an addition has to be made in both places on evidence.
const CLAUDE_SAFE_ENV_VARS_2_1_296 = [
  'GOEXPERIMENT', 'GOOS', 'GOARCH', 'CGO_ENABLED', 'GO111MODULE', 'RUST_BACKTRACE', 'RUST_LOG',
  'NODE_ENV', 'PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE', 'PYTEST_DISABLE_PLUGIN_AUTOLOAD',
  'PYTEST_DEBUG', 'ANTHROPIC_API_KEY', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_TIME', 'CHARSET',
  'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'TZ', 'LS_COLORS', 'LSCOLORS', 'GREP_COLOR',
  'GREP_COLORS', 'GCC_COLORS', 'TIME_STYLE', 'BLOCK_SIZE', 'BLOCKSIZE', 'COLUMNS', 'LINES', 'CLICOLOR',
  'CLICOLOR_FORCE', 'CI', 'DEBIAN_FRONTEND', 'GIT_TERMINAL_PROMPT',
];

test('the known-safe list is the 39 names Claude Code 2.1.296 strips, with a plain value only', () => {
  assert.equal(CLAUDE_SAFE_ENV_VARS_2_1_296.length, 39);
  for (const name of CLAUDE_SAFE_ENV_VARS_2_1_296) {
    // MUTATION: delete 'CI' from CLAUDE_SAFE_ENV_VARS (src/permissions.js). This fails
    // naming it. Confirmed 2026-10-13.
    assert.equal(claudeStripsAssignment(name, '1'), true, name);
    assert.equal(generalizePermission(`Bash(${name}=1 rg x)`), 'Bash(rg *)', name);
  }
  // Values the routine's `[A-Za-z0-9_./:-]+` refuses: quoted, empty, an expansion, a
  // space, a comma or a plus. MUTATION: make claudeStripsAssignment test the name only;
  // the first of these is stripped and this fails. Confirmed 2026-10-13.
  for (const value of ['"test"', "'test'", '', '$X', 'a,b', 'a+b']) {
    assert.equal(claudeStripsAssignment('NODE_ENV', value), false, value);
  }
  // Names off the list, and case matters.
  for (const name of ['FOO', 'GITHUB_TOKEN', 'LD_PRELOAD', 'PATH', 'PYTHONUTF8', 'node_env', 'GIT_PAGER']) {
    assert.equal(claudeStripsAssignment(name, '1'), false, name);
  }
});

const TABLE = [
  // [entry, generalized, the text Claude Code matches it against once its strip is done]
  // stripped: known-safe, plain, at the head of the line
  ['Bash(NODE_ENV=test npm test)', 'Bash(npm test *)', 'Bash(npm test)'],
  ['Bash(CI=1 FORCE_COLOR=0 npm test)', 'Bash(npm test *)', 'Bash(npm test)'],
  ['Bash(LANG=en_US.UTF-8 TZ=America/New_York rg x)', 'Bash(rg *)', 'Bash(rg x)'],
  ['Bash(NODE_ENV=test timeout 5 git status)', 'Bash(git status *)', 'Bash(git status)'],
  // kept verbatim: a name off the list, a quoted value, a safe one after a kept one
  ['Bash(GITHUB_TOKEN=x git push origin)', 'Bash(GITHUB_TOKEN=x git push *)', 'Bash(GITHUB_TOKEN=x git push origin)'],
  ['Bash(FOO=bar rg x)', 'Bash(FOO=bar rg *)', 'Bash(FOO=bar rg x)'],
  ['Bash(FOO="a b" rg x)', 'Bash(FOO="a b" rg *)', 'Bash(FOO="a b" rg x)'],
  ['Bash(NODE_ENV="test" npm test)', 'Bash(NODE_ENV="test" npm test *)', 'Bash(NODE_ENV="test" npm test)'],
  ['Bash(FOO=2 CI=1 make all)', 'Bash(FOO=2 CI=1 make *)', 'Bash(FOO=2 CI=1 make all)'],
  // stripped then kept: the safe head goes, the rest stays as written
  ['Bash(CI=1 FOO=2 make all)', 'Bash(FOO=2 make *)', 'Bash(FOO=2 make all)'],
  ['Bash(FOO=1 command -v rg)', 'Bash(FOO=1 command -v *)', 'Bash(FOO=1 command -v rg)'],
];

test('safe assignments are stripped, any other is kept verbatim in the rule', () => {
  for (const [entry, expected, checked] of TABLE) {
    // MUTATION: make claudeStripsAssignment return true (the old strip-everything rule).
    // `Bash(GITHUB_TOKEN=x git push origin)` becomes `Bash(git push *)`. Confirmed 2026-10-13.
    // MUTATION: drop `!kept &&` from splitEnvPrefix. `Bash(FOO=2 CI=1 make all)` loses its
    // CI=1 and this fails. Confirmed 2026-10-13.
    // MUTATION: drop `${lead}` from the root return in generalizeCommandArg.
    // `Bash(FOO=bar rg x)` becomes `Bash(rg *)`. Confirmed 2026-10-13.
    assert.equal(generalizePermission(entry), expected, entry);
    // The rule matches the text Claude Code checks: the stripped command for a safe
    // head, the command as written once an assignment is kept.
    assert.ok(ruleMatches(expected, checked), `${expected} must match ${checked}`);
  }
  // The rule the old pass wrote does not match the command it came from, which is the
  // prompt loop this fixes: Claude Code would not strip GITHUB_TOKEN to reach it.
  assert.equal(ruleMatches('Bash(git push *)', 'Bash(GITHUB_TOKEN=x git push origin)'), false);
});

test('a kept assignment followed by a wrapper, or holding a glob or rule syntax, stays verbatim', () => {
  for (const entry of [
    // Claude Code strips no wrapper after an assignment it keeps, so `Bash(FOO=1 rg *)`
    // would never match and `Bash(FOO=1 timeout *)` would grant whatever timeout runs.
    'Bash(FOO=1 timeout 5 git status)', 'Bash(FOO=1 nohup make)', 'Bash(FOO=1 xargs grep x)',
    'Bash(FOO=1 time make)',
    // a `*` would be read as a glob in the rule; the others do not survive as rule text
    'Bash(GLOB=*.txt ls)', 'Bash(FOO=a\\b ls)', 'Bash(FOO=a;b ls)',
    // the existing guards still apply to what follows the assignments
    'Bash(FOO=1 ./x.sh)', 'Bash(FOO=1 for x in y)', 'Bash(FOO=bar)', 'Bash(FOO=bar BAZ=1)',
    'Bash(FOO=$(rm -rf ~) git status)',
  ]) {
    // MUTATION: drop the `wrapperLength(...) !== 0` half of the kept-assignment refusal.
    // `Bash(FOO=1 timeout 5 git status)` becomes `Bash(FOO=1 timeout *)`. Confirmed 2026-10-13.
    // MUTATION: drop the character half. `Bash(GLOB=*.txt ls)` becomes `Bash(GLOB=*.txt
    // ls *)`, a rule that admits any GLOB value. Confirmed 2026-10-13.
    assert.equal(generalizePermission(entry), entry, `${entry} must stay verbatim`);
  }
  // Controls: PowerShell has no assignment prefix and is untouched.
  assert.equal(generalizePermission('PowerShell(FOO=1 x)'), 'PowerShell(FOO=1 x)');
  assert.equal(generalizePermission('PowerShell(Get-ChildItem x)'), 'PowerShell(Get-ChildItem *)');
});

test('existing wildcards are preserved and the pipeline is a fixed point', () => {
  // A `Bash(git push *)` the old pass minted from an env-prefixed approval is not removed:
  // an argument already ending in `*` is never re-generalized.
  const held = ['Bash(git push *)', 'Bash(rg *)'];
  assert.deepEqual(processAllowList(held), held);
  const list = [...held, ...TABLE.map(([entry]) => entry), 'Bash(FOO=1 timeout 5 git status)'];
  const once = processAllowList(list);
  assert.deepEqual(processAllowList(once), once);
  assert.ok(once.includes('Bash(GITHUB_TOKEN=x git push *)'));
  assert.ok(once.includes('Bash(FOO=1 timeout 5 git status)'));
});
