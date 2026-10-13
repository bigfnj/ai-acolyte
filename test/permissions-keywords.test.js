'use strict';

// The wildcarding pass must never turn shell grammar into a grant.
//
// Reported 2026-10-13 and confirmed against the code that day: generalizePermission
// keyed every Bash entry on its first whitespace token, so `Bash(for f in a b)` became
// `Bash(for *)`, `Bash(if [ -f x ]; then rm x; fi)` became `Bash(if *)` and
// `Bash($EDITOR x)` became `Bash($EDITOR *)`. BASH_SCRIPT_KEYWORDS existed and its
// comment said `for` must not seed `Bash(for *)`, but only src/local-settings.js read
// it. Measured with src/permission-match.js, `Bash(for *)` covers
// `Bash(for f in *; do rm -rf "$f"; done)`, and processAllowList then pruned every
// other exact loop as covered, collapsing them into the one broad rule.
//
// PowerShell already had its gate (generalizePowerShellArg admits only a plain
// `[A-Za-z][\w.-]*` name outside PS_SCRIPT_KEYWORDS), so the PowerShell shapes below
// are pins on existing behaviour plus the classifier words that set lacked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  generalizePermission, processAllowList, BASH_SCRIPT_KEYWORDS,
} = require('../src/permissions');
const { ruleMatches } = require('../src/permission-match');
const { BASH_RESERVED, POWERSHELL_RESERVED } = require('../src/auto-learn');

const BASH_VERBATIM = [
  // reserved words and control keywords
  'Bash(for f in a b)',
  'Bash(for f in *.txt; do wc -l "$f"; done)',
  'Bash(if [ -f x ]; then rm x; fi)',
  'Bash(while true; do sleep 1; done)',
  'Bash(until false; do y; done)',
  'Bash(case $x in a) echo a ;; esac)',
  'Bash(select x in a b)',
  'Bash(function f { :; })',
  'Bash(then rm x)',
  'Bash(do rm "$f")',
  'Bash(elif [ -d y ])',
  'Bash(else echo no)',
  // `time make` is no longer here: `time` is one of Claude Code's stripped wrappers and
  // keys on `make` since 2026-10-13 (test/permissions-wrappers.test.js). The two shapes
  // the strip refuses still stay verbatim.
  'Bash(time)',
  'Bash(time -p make)',
  'Bash(coproc nc -l 8080)',
  'Bash(! grep -q x f)',
  'Bash(trap "rm -rf ~" EXIT)',
  'Bash(eval "$cmd")',
  'Bash(For f in a b)', // case-folded on purpose: refusing more is the safe side
  // grouping, subshell, arithmetic, conditional
  'Bash({ echo a; echo b; })',
  'Bash((cd sub && make))',
  'Bash(( cd sub ))',
  'Bash(((i++)))',
  'Bash(( i++ ))',
  'Bash([[ -f x ]])',
  // expansions: the program is chosen when the line is expanded
  'Bash($EDITOR notes.txt)',
  'Bash(${EDITOR} notes.txt)',
  'Bash($(which python) x.py)',
  'Bash(`which python` x.py)',
  'Bash(python$VER x.py)',
  'Bash(g* status)',
  // a comment opener, and a redirection before any command
  'Bash(# just a note)',
  'Bash(<in.txt sort)',
  // assignment with no command, and an expansion inside an env prefix
  'Bash(FOO=bar)',
  'Bash(FOO=bar BAZ=1)',
  'Bash(FOO=1 $CMD x)',
  'Bash(FOO=1 for x in y)',
  'Bash(FOO=$(rm -rf ~) git status)',
  'Bash(FOO=`id -u` git status)',
  'Bash(FOO=${X:-a b} git status)',
];

const POWERSHELL_VERBATIM = [
  'PowerShell(foreach ($x in 1..3) { $x })',
  'PowerShell(for ($i = 0; $i -lt 3; $i++) { $i })',
  'PowerShell(if (Test-Path x) { Remove-Item x })',
  'PowerShell(while ($true) { Start-Sleep 1 })',
  'PowerShell(switch ($x) { 1 { "a" } })',
  'PowerShell(try { Get-Item x } catch { $_ })',
  'PowerShell(function f { 1 })',
  'PowerShell(param($a) $a)',
  'PowerShell(trap { continue } 1/0)',
  'PowerShell(exit 1)',
  'PowerShell(throw "boom")',
  'PowerShell(data { "x" })',
  'PowerShell($x = Get-Date)',
  'PowerShell(${x})',
  'PowerShell($(Get-Date))',
  'PowerShell(1..6 | ForEach-Object { $_ })',
  'PowerShell(1..6)',
  'PowerShell(-1..5)',
  'PowerShell(& foo.exe --version)',
];

test('a Bash entry that opens with grammar or an expansion is left verbatim', () => {
  for (const entry of BASH_VERBATIM) {
    // MUTATION: delete the `if (tool === 'Bash' && bashOpensScript(...))` line in
    // generalizeCommandArg (src/permissions.js). Every keyword row becomes
    // `Bash(<keyword> *)` again and this fails on the first, `Bash(for *)`.
    // Confirmed 2026-10-13.
    assert.equal(generalizePermission(entry), entry, `${entry} must not be wildcarded`);
  }
});

test('each of the four checks in the Bash guard is load-bearing on its own', () => {
  // Each MUTATION below was run alone on 2026-10-13 and failed this test.
  // MUTATION: drop the BASH_SCRIPT_KEYWORDS test from bashOpensScript. `for f in a b`
  // has no metacharacter in its first token, so only the keyword set stops it.
  assert.equal(generalizePermission('Bash(for f in a b)'), 'Bash(for f in a b)');
  assert.equal(generalizePermission('Bash(trap "rm -rf ~" EXIT)'), 'Bash(trap "rm -rf ~" EXIT)');
  // MUTATION: drop the BASH_NON_WORD test. `$EDITOR` is in no keyword set.
  assert.equal(generalizePermission('Bash($EDITOR x)'), 'Bash($EDITOR x)');
  // MUTATION: drop the env-prefix expansion test. Without it the strip regex splits
  // inside `$(...)` and the "root" is `-rf`, so this became `Bash(-rf *)`.
  assert.equal(generalizePermission('Bash(FOO=$(rm -rf ~) git status)'),
    'Bash(FOO=$(rm -rf ~) git status)');
  // MUTATION: drop the BASH_ASSIGNMENT test. An assignment with nothing after it was
  // `Bash(FOO=bar *)`, which the repo's matcher reads as a grant for any command
  // that follows that assignment.
  assert.equal(generalizePermission('Bash(FOO=bar)'), 'Bash(FOO=bar)');
  assert.equal(ruleMatches('Bash(FOO=bar *)', 'Bash(FOO=bar rm -rf ~)'), true,
    'precondition: the shape the old pass emitted really was that broad');
});

test('a PowerShell entry that opens with a keyword, variable or range stays verbatim', () => {
  for (const entry of POWERSHELL_VERBATIM) {
    // MUTATION: delete 'exit' (with 'break') from the second row of PS_SCRIPT_KEYWORDS.
    // `PowerShell(exit 1)` becomes `PowerShell(exit *)` and this fails, as does the
    // classifier drift test below. Confirmed 2026-10-13.
    assert.equal(generalizePermission(entry), entry, `${entry} must not be wildcarded`);
  }
});

test('a digit-leading PowerShell command name generalizes; a number or range stays verbatim', () => {
  // Until 2026-10-13 the PowerShell gate admitted only a letter first, so `7z a x.zip`
  // stayed exact in PowerShell while `Bash(7z a x.zip)` became `Bash(7z *)`. The
  // classifier already kept 7z's root and refused only the range literal (3ebbf04).
  // MUTATION: restore the letter-only gate (`/^[A-Za-z][\w.-]*$/.test(first)` in
  // generalizePowerShellArg). Every row here stays exact and this fails on the first.
  // Confirmed 2026-10-13.
  for (const [entry, expected] of [
    ['PowerShell(7z a x.zip)', 'PowerShell(7z *)'],
    ['PowerShell(7za x a.7z)', 'PowerShell(7za *)'],
    ['PowerShell(7z.exe l x)', 'PowerShell(7z.exe *)'],
    ['PowerShell(2to3 -w x.py)', 'PowerShell(2to3 *)'],
  ]) assert.equal(generalizePermission(entry), expected, entry);
  // Controls: PowerShell reads each of these as a number or a range, so the statement
  // is an expression and names no program.
  // MUTATION: drop `!first.includes('..')` from isPowerShellCommandName. `1..6` becomes
  // `PowerShell(1..6 *)` and this fails. Drop the PS_NUMERIC_LITERAL test instead and
  // `42` becomes `PowerShell(42 *)`. Both confirmed 2026-10-13.
  for (const entry of ['PowerShell(1..6)', 'PowerShell(1..6 | ForEach-Object { $_ })', 'PowerShell(-1..5)',
    'PowerShell(1..$n)', 'PowerShell(42)', 'PowerShell(7)', 'PowerShell(1.5)', 'PowerShell(0x1F)',
    'PowerShell(0b101)', 'PowerShell(1e3)', 'PowerShell(10kb)', 'PowerShell(10MB)', 'PowerShell(5l)',
    'PowerShell(2d)', 'PowerShell(1uy)']) {
    assert.equal(generalizePermission(entry), entry, `${entry} is an expression`);
  }
  // Bash is untouched: it has no range operator, so there `1..6` is an attempt to run a
  // program and was already wildcarded like any other name.
  assert.equal(generalizePermission('Bash(7z a x.zip)'), 'Bash(7z *)');
});

test('controls: ordinary commands generalize exactly as they did before the guard', () => {
  const cases = [
    ['Bash(git status)', 'Bash(git status *)'],          // MIXED_FAMILY_ROOTS keep a subcommand
    ['Bash(git push origin main)', 'Bash(git push *)'],
    ['Bash(rg foo)', 'Bash(rg *)'],                       // fixed-purpose root
    ['Bash(rm -rf build)', 'Bash(rm *)'],                 // destructive roots wildcard by design
    ['Bash(bash -c "make")', 'Bash(bash *)'],             // wrappers too; deny is the boundary
    ['Bash(source env.sh)', 'Bash(source *)'],            // exempt: the `.` runner, like bash
    ['Bash(. env.sh)', 'Bash(. *)'],
    ['Bash([ -f x ])', 'Bash([ *)'],                      // exempt: `[` is `test`
    ['Bash(test -f x)', 'Bash(test *)'],
    // These three were pinned here as "this pass does not strip wrappers" so that a
    // change would be a decision. It was one, on 2026-10-13: Claude Code strips them
    // before matching (docs, quoted in src/permissions.js above wrapperLength), so the
    // rule keys on the inner command. `command -v` is the documented exception and
    // keeps its flag. test/permissions-wrappers.test.js holds the full table.
    ['Bash(timeout 5 rg x)', 'Bash(rg *)'],
    ['Bash(command -v rg)', 'Bash(command -v *)'],
    ['Bash(builtin cd x)', 'Bash(cd *)'],
    // The env strip is unchanged too, including a quoted value with a space.
    ['Bash(FOO=bar git status)', 'Bash(git status *)'],
    ['Bash(FOO="a b" rg x)', 'Bash(rg *)'],
    ['Bash(FOO=$HOME/x rg y)', 'Bash(rg *)'],
    ['Bash(g++ -O2 x.cc)', 'Bash(g++ *)'],
    ['Bash(git)', 'Bash(git)'],
    // Already-wildcarded and quoted/path entries are untouched.
    ['Bash(for *)', 'Bash(for *)'],
    ['Bash("/opt/My Tool/tool" --version)', 'Bash("/opt/My Tool/tool" --version)'],
    ['Bash(./scripts/check.sh --fast)', 'Bash(./scripts/check.sh --fast)'],
    ['PowerShell(Get-ChildItem x)', 'PowerShell(Get-ChildItem *)'],
    ['PowerShell(git status --short)', 'PowerShell(git status *)'],
    // `select` and `set` are Bash keywords and ordinary PowerShell aliases. The Bash
    // guard must not leak into the PowerShell path.
    // MUTATION: drop `tool === 'Bash' &&` from the guard; both of these fail.
    ['PowerShell(select Name)', 'PowerShell(select *)'],
    ['PowerShell(set x 1)', 'PowerShell(set *)'],
    ['Read(src/**)', 'Read(src/**)'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(generalizePermission(input), expected, input);
  }
  // The env-stripped rule matches the command Claude Code actually checks, which is
  // the documented reason the strip stays.
  assert.equal(ruleMatches('Bash(git status *)', 'Bash(git status)'), true);
});

test('exact loops stay separate grants instead of collapsing into one Bash(for *)', () => {
  const loops = ['Bash(for f in a b)', 'Bash(for x in $(ls); do rm $x; done)'];
  // Before the guard this was ['Bash(for *)']: the first loop generalized, then
  // prune dropped the second as covered by it.
  assert.deepEqual(processAllowList(loops), loops);

  // Nothing already on a list is removed. A `Bash(for *)` a user already holds is
  // preserved, and still covers what it matches, as the matcher says it does.
  assert.deepEqual(processAllowList(['Bash(for *)', ...loops]), ['Bash(for *)']);
});

test('processAllowList is a fixed point on its own output', () => {
  const list = [
    ...BASH_VERBATIM, ...POWERSHELL_VERBATIM,
    'Bash(git status --short)', 'Bash(git status)', 'Bash(rg foo)', 'Bash(rg *)',
    'Bash(FOO=bar git log -1)', 'Bash(timeout 5 rg x)', 'PowerShell(Get-Item x)',
    'Bash(ls)', 'WebSearch', 'Read(src/**)',
  ];
  const once = processAllowList(list);
  assert.deepEqual(processAllowList(once), once);
  for (const entry of [...BASH_VERBATIM, ...POWERSHELL_VERBATIM]) {
    assert.ok(once.includes(entry), `${entry} survives the full pipeline`);
  }
});

// The generalizer keeps its own copies of the keyword sets. These two tests are what
// stop those copies falling behind the classifier, which is the drift that let
// `Bash(for *)` happen: two descriptions of "this is not a command", one consulted
// by the learner and the other by nothing on the generalizer's path.
// Each exemption names what `Bash(<word> x)` becomes instead, and why.
const BASH_EXEMPT = new Map([
  ['source', ['Bash(source *)', 'the `.` script runner; wildcarded like bash and sh by this pass\'s design']],
  ['[', ['Bash([ *)', 'the `test` builtin, a fixed-purpose command; wildcarded like test']],
  // Added 2026-10-13. `time` is still a reserved word, but Claude Code strips it as a
  // wrapper before matching, so the rule keys on the command it times.
  ['time', ['Bash(x *)', 'a wrapper Claude Code strips before matching; the inner command is keyed']],
]);

test('every classifier Bash reserved word stays verbatim, bar three named exemptions', () => {
  for (const word of BASH_RESERVED) {
    const entry = `Bash(${word} x)`;
    if (BASH_EXEMPT.has(word)) {
      const [expected, why] = BASH_EXEMPT.get(word);
      assert.equal(generalizePermission(entry), expected, `${word}: ${why}`);
      continue;
    }
    // MUTATION: delete 'trap' from BASH_SCRIPT_KEYWORDS. `trap` has no metacharacter,
    // so `Bash(trap x)` becomes `Bash(trap *)` and this fails naming it.
    assert.equal(generalizePermission(entry), entry,
      `${word} is reserved to the classifier (src/auto-learn.js BASH_RESERVED) and must `
      + 'stay verbatim here: add it to BASH_SCRIPT_KEYWORDS, or to BASH_EXEMPT with a reason');
    assert.ok(BASH_SCRIPT_KEYWORDS.has(word) || /[$`(){};|&<>!*?"']/.test(word),
      `${word} is reserved to the classifier but absent from BASH_SCRIPT_KEYWORDS, `
      + 'which src/local-settings.js reads');
  }
  for (const word of BASH_EXEMPT.keys()) {
    assert.ok(BASH_RESERVED.has(word), `${word} is no longer reserved; drop its exemption`);
  }
});

test('every classifier PowerShell reserved word stays verbatim, with no exemptions', () => {
  for (const word of POWERSHELL_RESERVED) {
    const entry = `PowerShell(${word} x)`;
    assert.equal(generalizePermission(entry), entry,
      `${word} is reserved to the classifier (src/auto-learn.js POWERSHELL_RESERVED) `
      + 'and must stay verbatim: add it to PS_SCRIPT_KEYWORDS in src/permissions.js');
  }
});

test('the keyword sets live where the fixed-point cache can see them', () => {
  // src/fixed-point-cache.js keys its verdict on the stat of permissions.js and
  // permission-match.js and nothing else. The guard is therefore sound only while
  // permissions.js keeps its own copies: importing them from auto-learn.js would let a
  // classifier edit change this pass's output with the cache still answering HIT.
  const { codeFiles } = require('../src/fixed-point-cache');
  const stamped = codeFiles().map((file) => path.resolve(file));
  assert.ok(stamped.includes(path.resolve(__dirname, '..', 'src', 'permissions.js')),
    'the cache stamp covers the file this guard lives in, so editing it self-invalidates');
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'permissions.js'), 'utf8');
  const localRequires = [...source.matchAll(/require\('(\.[^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(localRequires, ['./permission-match'],
    'permissions.js must not import a local module the cache stamp does not cover');
});
