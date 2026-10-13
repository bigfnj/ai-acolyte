'use strict';

// The wildcarding pass keys a wrapped Bash approval on the command the wrapper runs,
// because that is the command Claude Code checks.
//
// Evidence, read 2026-10-13 (code.claude.com/docs/en/permissions, "Wrappers"): "Before
// matching Bash rules, Claude Code strips a fixed set of wrappers, so a rule like
// `Bash(npm test *)` also matches `timeout 30 npm test`. The stripped wrappers are
// `timeout`, `time`, `nice`, `nohup`, and `stdbuf`, plus the shell builtins `command`
// and `builtin`, and zsh's `noglob`." Not stripped: `command -v` and zsh's `nocorrect`.
// "Bare `xargs` is also stripped ... only when `xargs` has no flags." The accepted
// shapes follow the wrapper routine in Claude Code 2.1.296's shipped binary, read the
// same day. Before this, `timeout 5 rg x` generalized to `Bash(timeout *)`: a rule for
// text Claude Code removes before it consults any rule.
//
// Every entry here is synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');

const { generalizePermission, processAllowList } = require('../src/permissions');
const { ruleMatches } = require('../src/permission-match');

// The documented list, as a literal, so a later edit to the generalizer that drops
// one fails here naming it.
const DOCUMENTED = ['timeout', 'time', 'nice', 'nohup', 'stdbuf', 'command', 'builtin', 'noglob', 'xargs'];

const STRIPPED = [
  // [entry, generalized, the command Claude Code checks once the wrapper is gone]
  ['Bash(timeout 5 rg x)', 'Bash(rg *)', 'Bash(rg x)'],
  ['Bash(timeout 30 npm test)', 'Bash(npm test *)', 'Bash(npm test)'], // mixed family keeps its subcommand
  ['Bash(timeout -k 2 -s KILL 10s git status)', 'Bash(git status *)', 'Bash(git status)'],
  ['Bash(timeout --signal=TERM --preserve-status 1.5m make)', 'Bash(make *)', 'Bash(make)'],
  ['Bash(time make)', 'Bash(make *)', 'Bash(make)'],
  ['Bash(nice -n 10 rg x)', 'Bash(rg *)', 'Bash(rg x)'],
  ['Bash(nice -5 rg x)', 'Bash(rg *)', 'Bash(rg x)'],
  ['Bash(nice rg x)', 'Bash(rg *)', 'Bash(rg x)'],
  ['Bash(nohup node server.js)', 'Bash(node *)', 'Bash(node server.js)'],
  ['Bash(stdbuf -oL rg x)', 'Bash(rg *)', 'Bash(rg x)'],
  ['Bash(stdbuf -o 0 -e 0 rg x)', 'Bash(rg *)', 'Bash(rg x)'],
  ['Bash(stdbuf --output=L rg x)', 'Bash(rg *)', 'Bash(rg x)'],
  ['Bash(command npm test)', 'Bash(npm test *)', 'Bash(npm test)'],
  ['Bash(command -p git log)', 'Bash(git log *)', 'Bash(git log)'],
  ['Bash(builtin cd x)', 'Bash(cd *)', 'Bash(cd x)'],
  ['Bash(builtin -- cd x)', 'Bash(cd *)', 'Bash(cd x)'],
  ['Bash(noglob git status)', 'Bash(git status *)', 'Bash(git status)'],
  ['Bash(xargs grep pattern)', 'Bash(grep *)', 'Bash(grep pattern)'],
  // Stacked, and after an env prefix Claude Code strips: every layer comes off. (Until
  // 2026-10-13 this row was `FOO=1 timeout 5 git status`; FOO is not on Claude Code's
  // known-safe list, so that line now stays verbatim, below.)
  ['Bash(nohup timeout 5 nice -n 1 rg x)', 'Bash(rg *)', 'Bash(rg x)'],
  ['Bash(NODE_ENV=test timeout 5 git status)', 'Bash(git status *)', 'Bash(git status)'],
  // The inner command is generalized by the ordinary rules, runners included.
  ['Bash(nohup bash -c "make")', 'Bash(bash *)', 'Bash(bash -c "make")'],
];

test('each documented wrapper is stripped and the rule keys on the inner command', () => {
  for (const [entry, expected, inner] of STRIPPED) {
    // MUTATION: make generalizeCommandArg skip stripBashWrappers (use the env split
    // alone for Bash). `Bash(timeout 5 rg x)` is `Bash(timeout *)` again and this fails
    // on the first row. Confirmed 2026-10-13.
    assert.equal(generalizePermission(entry), expected, entry);
    // The rule covers the command Claude Code checks once the wrapper is gone, which
    // is the whole point of keying on it.
    assert.ok(ruleMatches(expected, inner), `${expected} must match ${inner}`);
  }
});

test('every wrapper the docs name is stripped in its plainest shape', () => {
  const plain = {
    timeout: 'timeout 5', time: 'time', nice: 'nice', nohup: 'nohup', stdbuf: 'stdbuf -oL',
    command: 'command', builtin: 'builtin', noglob: 'noglob', xargs: 'xargs',
  };
  assert.deepEqual(Object.keys(plain).sort(), [...DOCUMENTED].sort());
  for (const name of DOCUMENTED) {
    // MUTATION: delete `case 'noglob':` from wrapperLength (src/permissions.js). This
    // fails on noglob alone, as `Bash(noglob *)`. Confirmed 2026-10-13.
    assert.equal(generalizePermission(`Bash(${plain[name]} rg x)`), 'Bash(rg *)', name);
  }
});

test('a wrapper in a shape Claude Code does not strip, or wrapping nothing, stays verbatim', () => {
  const verbatim = [
    'Bash(timeout npm test)',            // no duration: timeout would read `npm` as one
    'Bash(timeout 30)',                  // a duration and no command
    'Bash(timeout --bogus 5 rg)',        // an option the CLI's routine refuses
    'Bash(time -p make)',                // `-p` is an "incomplete fragment" to the CLI
    'Bash(time)',
    'Bash(nice --adjustment=5 rg)',
    'Bash(nice $N rg)',                  // the inner "command" is an expansion
    'Bash(nohup)',
    'Bash(stdbuf rg x)',                 // stdbuf with no mode is not stripped
    'Bash(stdbuf -o$(id) rg)',           // a substitution inside the stripped prefix
    'Bash(command -x rg)',
    'Bash(command)',
    // What the wrapper runs is not a literal command root, so the ordinary guards apply.
    'Bash(timeout 5 ./x.sh)',
    'Bash(timeout 5 "my tool" x)',
    'Bash(timeout 5 for x in y)',
    'Bash(timeout 5 $EDITOR x)',
    'Bash(timeout 5 FOO=1 make)',        // timeout would exec a program named FOO=1
    // After an assignment Claude Code keeps, it strips no wrapper (test/permissions-env.test.js).
    'Bash(FOO=1 timeout 5 git status)',
  ];
  for (const entry of verbatim) {
    // MUTATION: drop the `tokens[consumed][0].startsWith('-')` refusal in
    // stripBashWrappers. `Bash(time -p make)` becomes `Bash(-p *)`. Confirmed 2026-10-13.
    // MUTATION: drop the `consumed >= tokens.length` refusal. `Bash(nohup)` and
    // `Bash(timeout 30)` throw instead of returning. Confirmed 2026-10-13.
    assert.equal(generalizePermission(entry), entry, `${entry} must stay verbatim`);
  }
});

test('forms Claude Code matches as themselves keep the design every runner root has', () => {
  // Controls. Neither of these is stripped by Claude Code, so each is the command it
  // checks, and the pass treats it like `bash`: root wildcard, deny as the boundary.
  assert.equal(generalizePermission('Bash(env FOO=1 make)'), 'Bash(env *)', 'env is not on the documented list');
  assert.equal(generalizePermission('Bash(xargs -0 grep x)'), 'Bash(xargs *)', 'xargs with a flag is matched as xargs');
  assert.equal(generalizePermission('Bash(xargs)'), 'Bash(xargs *)');
  // `command -v` is the documented exception and is a lookup, so it keeps its flags
  // rather than becoming `Bash(command *)`.
  // MUTATION: delete the `first === 'command'` block in generalizeCommandArg. These
  // three become `Bash(command *)`. Confirmed 2026-10-13.
  assert.equal(generalizePermission('Bash(command -v rg)'), 'Bash(command -v *)');
  assert.equal(generalizePermission('Bash(command -V rg)'), 'Bash(command -V *)');
  assert.equal(generalizePermission('Bash(command -p -v rg)'), 'Bash(command -p -v *)');
  // Case matters to the CLI's routine (it compares exact names), so `Time` is not taken.
  assert.equal(generalizePermission('Bash(Time make)'), 'Bash(Time make)');
});

test('PowerShell is untouched: there, timeout is timeout.exe', () => {
  // MUTATION: strip wrappers for PowerShell too (drop the `tool === 'Bash'` test on
  // the stripBashWrappers call). `/t` is no duration, so this becomes verbatim and
  // fails. Confirmed 2026-10-13.
  assert.equal(generalizePermission('PowerShell(timeout /t 5)'), 'PowerShell(timeout *)');
  assert.equal(generalizePermission('PowerShell(nice x)'), 'PowerShell(nice *)');
});

test('existing wrapper wildcards are preserved and the pipeline is a fixed point', () => {
  // Nothing a user already holds is removed or rewritten: an argument already ending
  // in `*` is never re-generalized.
  const held = ['Bash(timeout *)', 'Bash(nohup *)', 'Bash(command *)', 'Bash(xargs *)'];
  assert.deepEqual(processAllowList(held), held);
  const list = [...held, ...STRIPPED.map(([entry]) => entry), 'Bash(time -p make)', 'Bash(rg foo)'];
  const once = processAllowList(list);
  assert.deepEqual(processAllowList(once), once);
  assert.ok(once.includes('Bash(rg *)') && once.includes('Bash(time -p make)'));
});
