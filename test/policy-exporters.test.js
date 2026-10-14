'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  renderCodexRules,
  validateCodexRulesText,
  renderClaudePermissions,
  mergeClaudeAllow,
  mergeGeneratedCodexRules,
} = require('../src/policy-exporters');

function candidate(prefix, extra = {}) {
  return { autoSafe: true, risk: 'low', prefix, ...extra };
}

function compact(value) {
  return String(value).replace(/, /g, ',');
}

function manualRule(pattern) {
  const example = pattern.join(' ');
  return [
    'prefix_rule(',
    '    pattern = ' + JSON.stringify(pattern) + ',',
    '    decision = ' + JSON.stringify('allow') + ',',
    '    justification = ' + JSON.stringify('test rule') + ',',
    '    match = [' + JSON.stringify(example) + '],',
    '    not_match = [' + JSON.stringify('__not_match__') + '],',
    ')',
    '',
  ].join('\n');
}

test('Codex renderer is deterministic and unions strict auto-safe Git subcommands', () => {
  const quote = String.fromCharCode(34);
  const candidates = [
    candidate(['git', 'status'], { successCount: 3, justification: 'safe ' + quote + 'reason\nnext' }),
    candidate(['git', 'rev-parse'], { successCount: 2 }),
  ];
  const rendered = renderCodexRules(candidates);
  assert.equal(rendered, renderCodexRules(candidates.slice().reverse()));
  assert.ok(rendered.includes('# Generator format version: 1'));
  assert.ok(compact(rendered).includes('pattern = ' + JSON.stringify(['git', ['rev-parse', 'status']])));
  assert.ok(rendered.includes('decision = ' + JSON.stringify('allow')));
  assert.ok(rendered.includes('match = ['));
  assert.ok(rendered.includes('not_match = ['));
  assert.ok(rendered.includes('git push'));
  assert.ok(rendered.includes(JSON.stringify('safe ' + quote + 'reason next')));
  assert.deepEqual(validateCodexRulesText(rendered), { valid: true, errors: [] });
});

test('Codex auto-safe mode fails closed on unsafe or unrepresentable candidates', () => {
  const rendered = renderCodexRules([
    { autoSafe: false, risk: 'low', prefix: ['rg', '--files'] },
    candidate(['rm', '-rf']),
    candidate(['curl', '--head']),
    candidate(['git', 'push']),
    candidate(['bash', '-lc', 'rg --files']),
    candidate(['rg', '*.js']),
    candidate(['rg', '--files'], { complex: true }),
    candidate(['rg', '--files'], { secretBearing: true }),
    candidate(['rg']),
    candidate(['date']),
    candidate(['hostname']),
    candidate(['cat']),
    candidate(['Get-Content']),
    candidate(['Get-ChildItem']),
    candidate(['Test-Path']),
    candidate(['git', 'diff']),
    candidate(['git', 'status'], { reasons: ['environment-prefix'] }),
    candidate(['git', 'rev-parse'], { reasons: ['remote-argument'] }),
    candidate(['rg', '--files'], { reasons: ['network-command'] }),
  ]);
  assert.ok(rendered.includes('No auto-safe command prefixes were eligible'));
  assert.equal((rendered.match(/prefix_rule\(/g) || []).length, 0);
});

test('explicitly reviewed Codex export remains narrow and rejects broad wrappers and secrets', () => {
  const reviewed = renderCodexRules([
    { prefix: ['curl', '--head'] },
    { autoSafe: false, prefix: ['git', 'diff'] },
    { prefix: ['powershell.exe', '-Command', 'Get-ChildItem'], wrapper: true },
    { prefix: ['powershell.exe', '-File', 'D:\\tools\\audit.ps1', 'scan'], wrapper: true },
    { prefix: ['tool', 'TOKEN=secret'] },
  ], { includeReviewed: true });
  assert.ok(compact(reviewed).includes('pattern = ' + JSON.stringify(['curl', '--head'])));
  assert.ok(compact(reviewed).includes('pattern = ' + JSON.stringify(['git', 'diff'])));
  assert.ok(compact(reviewed).includes('pattern = ' + JSON.stringify(['powershell.exe', '-File', 'D:\\tools\\audit.ps1', 'scan'])));
  assert.ok(!reviewed.includes('-Command'));
  assert.ok(!reviewed.includes('TOKEN=secret'));
  assert.equal(validateCodexRulesText(reviewed).valid, true);
});

// The learner's SHELL_WRAPPERS only raises risk; under `includeReviewed` this exporter
// never reads risk, so the learner table could not stop a reviewed bare runner prefix.
// MEASURED 2026-10-13 before the exporter entries existed: the candidate the learner
// builds from `just build` (prefix ["just"], complex false) rendered as a valid one-token
// prefix_rule, and the same for make, hyperfine and duckdb. A one-token pattern for any
// of them runs whatever recipe, benchmarked command or `.shell` line it is handed.
for (const [root, command] of [
  ['duckdb', 'duckdb -c "SELECT 1"'], ['hyperfine', "hyperfine 'sleep 1'"],
  ['just', 'just build'], ['make', 'make all'],
]) {
  test(`reviewed Codex export refuses a bare ${root} prefix and keeps a narrower one`, () => {
    const { classifyInvocation } = require('../src/auto-learn');
    const learned = classifyInvocation({ tool: 'Bash', command, source: 'claude' });
    assert.deepEqual(learned.prefix, [root], 'precondition: the learner hands over the bare root');
    for (const item of [learned, { prefix: [`${root}.exe`] }]) {
      const rendered = renderCodexRules([item], { includeReviewed: true });
      // MUTATION: drop '${root}' (or '${root}.exe') from SHELL_WRAPPERS in
      // src/policy-exporters.js. wrapperIsBroad never runs, the reviewed branch returns
      // the prefix, and a one-token prefix_rule is emitted. Confirmed 2026-10-13 for each
      // root and each spelling, one at a time.
      //
      // That was true of the table as it stood that morning. The same day the exporter
      // began unioning in the learner's SHELL_WRAPPERS, and all four roots are in both,
      // so dropping one from OWN_SHELL_WRAPPERS alone now survives (measured for `just`:
      // every test in this file stays green). The redundancy is the point of the union.
      // What kills it now
      // is dropping the root from BOTH tables (measured for `just`: this test fails), or
      // dropping the union itself, which the tests further down pin.
      assert.equal((rendered.match(/prefix_rule\(/g) || []).length, 0,
        `${JSON.stringify(item.prefix)} must not become a reviewed Codex rule:\n${rendered}`);
    }
    // Control: for just and make, refusal is of the BARE runner only, the same treatment `sh`
    // gets. A reviewer who narrowed the prefix to a recipe still gets it, so this is not a
    // blanket ban. MUTATION: make wrapperIsBroad return true for every wrapper; this fails.
    // Changed 2026-10-14, as a decision: hyperfine and duckdb are no longer in this control.
    // `["hyperfine", "build"]` admits a second benchmarked command and `["duckdb", "build"]` a
    // `.shell` line (both measured, src/policy-exporters.js RUNNER_GRAMMAR), so naming
    // something narrows neither; "hyperfine, duckdb and wsl are broad at any depth" holds them.
    const narrow = renderCodexRules([{ prefix: [root, 'build'] }], { includeReviewed: true });
    if (root === 'just' || root === 'make') {
      assert.ok(compact(narrow).includes('pattern = ' + JSON.stringify([root, 'build'])), narrow);
    } else {
      assert.equal((narrow.match(/prefix_rule\(/g) || []).length, 0, narrow);
    }
  });
}

// The 27 learner SHELL_WRAPPERS roots this exporter's own table lacked until 2026-10-13.
// MEASURED that day against the previous exporter: every one of them, bare, rendered a
// valid one-token reviewed prefix_rule (99 leaks counting the .exe and .cmd spellings).
// Kept as a LITERAL on purpose. The exporter now derives these from the learner's table,
// so the drift test below cannot notice the learner dropping one; this list can.
const NEWLY_REFUSED_RUNNERS = [
  '.', 'bun', 'command', 'deno', 'env', 'eval', 'exec', 'iex', 'invoke-expression',
  'java', 'mshta', 'node', 'npm', 'npx', 'parallel', 'perl', 'php', 'pnpm', 'py',
  'python', 'python3', 'ruby', 'rundll32', 'source', 'uvx', 'xargs', 'yarn',
];
const spellingsOf = (root) => (/^[a-z0-9][a-z0-9_+-]*$/.test(root)
  ? [root, `${root}.exe`, `${root}.cmd`] : [root]);
const codexRuleCount = (prefix) =>
  (renderCodexRules([{ prefix }], { includeReviewed: true }).match(/prefix_rule\(/g) || []).length;

test('reviewed Codex export refuses every learner runner as a bare prefix, in every spelling', () => {
  for (const root of NEWLY_REFUSED_RUNNERS) {
    for (const spelling of spellingsOf(root)) {
      // MUTATION: build SHELL_WRAPPERS from OWN_SHELL_WRAPPERS alone (drop the learner
      // union in src/policy-exporters.js). The first root, `.`, renders a one-token rule
      // and this fails; so do all 27. Confirmed 2026-10-13.
      assert.equal(codexRuleCount([spelling]), 0,
        `${JSON.stringify([spelling])} is an arbitrary-execution runner and must not become a bare rule`);
    }
  }
});

test('the refusal reaches a bare prefix the learner itself builds', () => {
  const { classifyInvocation } = require('../src/auto-learn');
  // `xargs rm` was the xargs row until 2026-10-13, when the learner began stripping a
  // bare, flagless `xargs` the way Claude Code's matcher does (it keys on `rm` now). A
  // flagged xargs is matched as xargs, so `xargs -0 rm` is the row that hands over the root.
  for (const [root, command] of [
    ['node', 'node build.js'], ['npx', 'npx tsc --noEmit'], ['uvx', 'uvx ruff check .'],
    ['xargs', 'xargs -0 rm'], ['parallel', 'parallel gzip ::: a b'], ['env', 'env FOO=1 make'],
  ]) {
    const learned = classifyInvocation({ tool: 'Bash', command, source: 'claude' });
    assert.deepEqual(learned.prefix, [root], `precondition: ${command} hands over the bare root`);
    const rendered = renderCodexRules([learned], { includeReviewed: true });
    assert.equal((rendered.match(/prefix_rule\(/g) || []).length, 0, `${command}:\n${rendered}`);
  }
});

test('a narrower reviewed runner prefix still renders, and the exporter keeps its own extras', () => {
  // Control: refusal is of the BARE runner only, the rule wrapperIsBroad already applied
  // to `just` and `make`. MUTATION: make wrapperIsBroad return true for every wrapper;
  // these fail.
  // `['xargs', '-0']` was in this list until 2026-10-13. It names no command, so it
  // admits `xargs -0 <anything>`, and it is refused now (the code-flag tests below); the
  // narrower form that names one is the control instead.
  for (const prefix of [['node', '--version'], ['npx', 'tsc'], ['uvx', 'ruff'], ['xargs', '-0', 'grep']]) {
    const rendered = renderCodexRules([{ prefix }], { includeReviewed: true });
    assert.ok(compact(rendered).includes('pattern = ' + JSON.stringify(prefix)), rendered);
    assert.equal(validateCodexRulesText(rendered).valid, true, rendered);
  }
  // `command.com` is in the exporter's own list and nowhere in the learner's. The union
  // must not have replaced the own list. MUTATION: build SHELL_WRAPPERS from the learner
  // spellings alone; this fails.
  assert.equal(codexRuleCount(['command.com']), 0);
  // The existing shell-specific rules are untouched: `bash -c` is still broad, and
  // `bash script.sh` still narrow.
  assert.equal(codexRuleCount(['bash', '-c']), 0);
  assert.equal(codexRuleCount(['bash', 'script.sh']), 1);
});

// A reviewed prefix that hands an interpreter its program as text is arbitrary execution,
// exactly as `bash -c` is. MEASURED 2026-10-13 before the check existed: every prefix in
// this table rendered as a valid reviewed prefix_rule, because a two-token prefix of a
// non-shell runner was always treated as "narrower". Synthetic prefixes throughout.
const INLINE_CODE = [
  ['python', '-c'], ['python3', '-c'], ['py', '-c'], ['python.exe', '-c'], ['python', '-Ic'],
  ['python', '-W', 'ignore', '-c'],          // behind a value option: anywhere counts
  ['node', '-e'], ['node', '--eval'], ['node', '-p'], ['node', '--print'], ['node', '-pe'],
  ['node', '--eval=1'], ['node.exe', '-e'],
  ['deno', 'eval'], ['bun', '-e'], ['bun', '--eval'],
  ['ruby', '-e'], ['ruby', '-ne'], ['ruby', '-E'], // -E is an encoding; refused on purpose
  ['perl', '-e'], ['perl', '-E'], ['perl', '-lane'],
  ['php', '-r'], ['php', '-R'],
  ['npx', '-c'], ['npx', '--call'],
];

test('a reviewed interpreter prefix carrying an inline-code flag is refused like bash -c', () => {
  for (const prefix of INLINE_CODE) {
    // MUTATION: delete the INLINE_CODE_FLAGS check in wrapperIsBroad
    // (src/policy-exporters.js). The first row, ["python","-c"], renders and this fails.
    // Confirmed 2026-10-13. Deleting one interpreter's entry (perl) fails its rows alone.
    //
    // Superseded the same day: the interpreter rule below (INTERPRETER_GRAMMAR) refuses
    // every row of this table on its own as well, because a code flag is not an option
    // that table lists, so deleting the INLINE_CODE_FLAGS check now survives this loop.
    // What still needs it is a code flag AFTER the pinned program, which the grammar
    // reads as the program's own argument; the test after next holds that row
    // (`["python", "x.py", "-c"]`) and is what the deletion fails now.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} runs whatever code it is handed`);
  }
  // Controls: the same interpreters, narrowed to something that is not program text.
  for (const prefix of [['python', '--version'], ['node', '--version'], ['python', 'script.py'],
    ['python', '-m', 'pytest'], ['node', 'build.js'], ['deno', 'run', 'x.ts'], ['bun', 'run', 'x'],
    ['ruby', 'x.rb'], ['perl', 'x.pl'], ['php', 'x.php'], ['npx', 'tsc'], ['uvx', 'ruff']]) {
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} is a narrower prefix and still renders`);
  }
});

// An interpreter or shell prefix is narrow only once it pins the program: a script path,
// a module NAME (`-m pytest`, `php -f x.php`), or exactly one inert informational form.
// MEASURED 2026-10-13 against a309f54 with a 132-prefix probe: every row of BROAD
// below rendered there (bar `["fish", "-C", "x"]`, already refused), 70 in all, and
// none of the controls changed. Each admits the next token, which can be the code flag:
// `python -u -c ...`, `bash -x -c ...`, `node -r x -e ...`, `python -m <any module>`.
const INTERPRETER_BROAD = [
  // the measured four, and options that end the prefix
  ['python', '-u'], ['bash', '-x'], ['node', '-r'], ['python', '-m'],
  ['python', '-W'], ['python', '-O'], ['python', '-B'], ['python3', '-I'], ['py', '-3.12'],
  ['node', '--require'], ['node', '--inspect'], ['ruby', '-w'], ['perl', '-w'], ['php', '-n'], ['php', '-f'],
  ['bash', '-e'], ['bash', '-l'], ['bash', '--login'], ['zsh', '-f'], ['fish', '-i'],
  // a value option's value is not the program
  ['python', '-W', 'ignore'], ['python', '-X', 'utf8'], ['python', '-u', '-W', 'ignore'],
  ['node', '-r', 'ts-node/register'], ['node', '--import', 'x'], ['node', '--title', 'x'],
  ['ruby', '-I', 'lib'], ['ruby', '-r', 'json'], ['perl', '-I', 'lib'], ['perl', '-Mstrict'], ['php', '-d', 'x=1'],
  ['bash', '-o', 'pipefail'], ['bash', '-euo', 'pipefail'], ['bash', '--rcfile', 'x'],
  // an option the table does not know, stdin, code or a server in an option
  ['node', '--bogus', 'x.js'], ['python', '-'], ['bash', '-'], ['python', '--', '-'], ['sh', '-s'],
  ['bash', '-ec'], ['bash', '-xc'], ['php', '-a'], ['php', '-S', 'localhost:8000'], ['fish', '-c', 'x'],
  ['fish', '--init-command=x'],
  ['node', '--import=data:text/javascript,1', 'x.js'], ['node', '--import', 'data:x', 'x.js'],
  // `-h` is set -h and `-V` is not the version, in a POSIX shell
  ['bash', '-h'], ['bash', '-V'], ['dash', '-E'],
  // a subcommand that still needs its target, or runs code itself
  ['deno', 'run'], ['deno', 'run', '-A'], ['deno', 'serve'], ['deno', 'repl'], ['deno', '--unstable', 'run', 'x.ts'],
  ['bun', 'run'], ['bun', 'x'], ['bun', 'exec', 'x'], ['bun', 'create'], ['bun', '--watch', 'x.ts'],
];

test('an interpreter or shell prefix is broad until it pins the program it runs', () => {
  for (const prefix of INTERPRETER_BROAD) {
    // MUTATION: delete the INTERPRETER_GRAMMAR dispatch in wrapperIsBroad (the generic
    // rule then decides). `["python", "-W", "ignore"]` renders. Confirmed 2026-10-13.
    // MUTATION: let an unknown option `continue` in interpreterIsBroad.
    // `["node", "--bogus", "x.js"]` renders. Confirmed 2026-10-13.
    // MUTATION: read a value option as a flag (drop the `k += 1` that skips its value).
    // `["python", "-W", "ignore"]` reads `ignore` as the script. Confirmed 2026-10-13.
    // MUTATION: give the POSIX shells DEFAULT_INFO instead of SHELL_INFO. `["bash", "-h"]`
    // renders. Confirmed 2026-10-13.
    // MUTATION: make a subcommand that needs a target pin on its own (drop the target
    // check). `["deno", "run"]` renders. Confirmed 2026-10-13.
    // MUTATION: drop `broadValue` from the node grammar. `["node", "--import", "data:x",
    // "x.js"]` renders. Confirmed 2026-10-13.
    // MUTATION: drop `|| rest[k] === '-'` after the walk. `["python", "--", "-"]` (the
    // program is stdin) renders. Confirmed 2026-10-13. A `-`, `bash -c`/`-s`, `php
    // -a`/`-S` or fish `-c` before the program needs no line of its own: none is in any
    // table, so each is an unknown option.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} has not pinned a program`);
  }
  // An inline-code flag after the pinned program is still refused, by INLINE_CODE_FLAGS
  // alone: the grammar reads it as the script's own argument (30f92a4 refused it on
  // purpose as the safe failure, and that stands).
  // MUTATION: delete the INLINE_CODE_FLAGS check. This row renders. Confirmed 2026-10-13.
  assert.equal(codexRuleCount(['python', 'x.py', '-c']), 0);
});

test('an interpreter or shell prefix that pins its program, or only asks for help or a version, renders', () => {
  for (const prefix of [
    // the 30f92a4 controls, unchanged
    ['python', '--version'], ['node', '--version'], ['python', 'script.py'], ['python', '-m', 'pytest'],
    ['node', 'build.js'], ['deno', 'run', 'x.ts'], ['bun', 'run', 'x'], ['ruby', 'x.rb'], ['perl', 'x.pl'],
    ['php', 'x.php'], ['bash', 'script.sh'], ['pwsh', '-File', 'x.ps1'],
    // informational forms, exactly
    ['python', '-V'], ['python', '-h'], ['python', '--help'], ['node', '-v'], ['node', '-h'],
    ['bash', '--version'], ['bash', '--help'],
    // options first, then the program
    ['python', '-u', 'x.py'], ['python', '-W', 'ignore', 'x.py'], ['python', '-mpytest'], ['python3', '-I', '-m', 'pip'],
    ['py', '-3.12', '-m', 'pip'], ['node', '--inspect', 'x.js'], ['node', '-r', 'ts-node/register', 'x.ts'],
    ['node', '--require=dotenv/config', 'x.js'], ['ruby', '-w', 'x.rb'], ['ruby', '-I', 'lib', 'x.rb'],
    ['perl', '-w', 'x.pl'], ['perl', '-Mstrict', 'x.pl'], ['php', '-n', 'x.php'], ['php', '-f', 'x.php'],
    ['php', '-d', 'x=1', 'x.php'], ['bash', '-e', 'x.sh'], ['bash', '-euo', 'pipefail', 'x.sh'], ['bash', '-x', 'x.sh'],
    ['bash', '--', 'x.sh'], ['fish', 'x.fish'], ['zsh', 'x.zsh'],
    // once pinned, the rest are the program's own arguments
    ['python', '-m', 'pytest', '-x'], ['python', 'x.py', '-u'], ['bash', 'x.sh', '-c'],
    // subcommands that pin, and a target after one that needs it
    ['deno', 'test'], ['deno', 'fmt'], ['deno', 'x.ts'], ['bun', 'test'], ['bun', 'install'], ['bun', 'x', 'tsc'],
    ['bun', 'x.ts'],
  ]) {
    // MUTATION: drop the `pin` handling (`-m MODULE`). `["python", "-m", "pytest"]` is an
    // unknown option and refused. Confirmed 2026-10-13.
    // MUTATION: drop the exact-info early return. `["python", "--version"]` is refused.
    // Confirmed 2026-10-13.
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} pins its program and still renders`);
  }
});

test('parallel is broad at any depth, because it runs its command line through a shell', () => {
  // GNU parallel composes each job and hands it to a shell, so naming the command does
  // not narrow it the way it narrows xargs (`["xargs", "rm"]` still renders, 30f92a4).
  // MUTATION: drop 'parallel' from ALWAYS_BROAD_WRAPPERS. `["parallel", "gzip"]` renders.
  // Confirmed 2026-10-13.
  for (const prefix of [['parallel', 'gzip'], ['parallel', '-j4', 'gzip'], ['parallel', '--version'],
    ['parallel.exe', 'gzip']]) {
    assert.equal(codexRuleCount(prefix), 0, JSON.stringify(prefix));
  }
  assert.equal(codexRuleCount(['xargs', 'rm']), 1, 'control: xargs execs without a shell');
});

test('any other runner prefix that ends in an option is broad unless it only asks for a version', () => {
  // `npx -y` admits `npx -y <any package>`, `npm --silent` admits `npm --silent exec ...`.
  // MUTATION: delete the ends-in-an-option rule at the bottom of wrapperIsBroad.
  // `["npx", "-y"]` renders. Confirmed 2026-10-13.
  for (const prefix of [['npx', '-y'], ['npx', '--yes'], ['npm', '--silent'], ['uvx', '--from'], ['make', '-k'],
    ['java', '-cp'], ['java', '-version'], ['just', '--justfile']]) {
    assert.equal(codexRuleCount(prefix), 0, JSON.stringify(prefix));
  }
  for (const prefix of [['npx', 'tsc'], ['uvx', 'ruff'], ['npx', '--version'], ['npm', 'test'], ['npm', 'run', 'build'],
    ['make', 'test'], ['java', '-jar', 'x.jar'], ['just', 'build']]) {
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} still renders`);
  }
});

// Development-environment runners, package runners and task runners (RUNNER_GRAMMAR in
// src/policy-exporters.js, 2026-10-13). A runner-exec form is broad until it names a
// concrete command, and then it is judged by that command. MEASURED that day against
// bceb66f with a 268-prefix synthetic probe: 263 rendered there and 109 render now; 154
// went from rendered to refused and none the other way. Every row of RUNNER_BROAD rendered
// at bceb66f bar `["npm", "exec", "--"]` (the generic ends-in-an-option rule already
// refused it), the bare `["uv"]` and `["docker"]` included, because none of these roots was
// on either wrapper table (npm, npx, uvx, pnpm, yarn, make and just had only the generic rule).
const RUNNER_BROAD = [
  // bare roots that were on no table
  ['uv'], ['docker'], ['kubectl'], ['poetry'], ['pipx'], ['direnv'], ['mise'], ['devbox'], ['podman'],
  ['uv.exe'], ['docker.exe'],
  // the exec form names no command yet, or only the runner's operand
  ['direnv', 'exec'], ['direnv', 'exec', '.'], ['uv', 'run'], ['uv', 'run', '--with', 'x'], ['uv', 'run', '-m'],
  ['uv', 'tool', 'run'], ['poetry', 'run'], ['pipx', 'run'], ['pipx', 'run', '--spec', 'x'], ['mise', 'exec'],
  ['mise', 'x'], ['mise', 'exec', 'node@20'], ['mise', 'exec', '--'], ['npm', 'exec'], ['npm', 'x'], ['npm', 'exec', '--'],
  ['npm', 'exec', '--package', 'x'], ['npx', '--package', 'x'], ['uvx', '--from', 'x'], ['pnpm', 'exec'], ['pnpm', 'dlx'],
  ['yarn', 'dlx'], ['docker', 'exec'], ['docker', 'exec', 'ctr'], ['docker', 'exec', '-it', 'ctr'],
  ['docker', 'exec', '-e', 'A=1', 'ctr'], ['docker', 'run'], ['docker', 'run', 'img'], ['docker', 'compose', 'run', 'web'],
  ['kubectl', 'exec'], ['kubectl', 'exec', 'pod'], ['kubectl', 'exec', 'pod', '--'],
  // ... or names a command that is itself broad
  ['direnv', 'exec', '.', 'sh'], ['direnv', 'exec', '.', 'bash', '-c'], ['direnv', 'exec', '.', 'python'],
  ['uv', 'run', 'python'], ['uv', 'run', 'python', '-c'], ['uv', 'run', '--with', 'x', 'python'], ['uv', 'run', 'sh'],
  ['uv', 'run', 'bash', '-c'], ['uv', 'run', '--', 'python'], ['uv', 'tool', 'run', 'python'], ['poetry', 'run', 'python'],
  ['poetry', 'run', 'sh', '-c'], ['pipx', 'run', 'python'], ['mise', 'exec', '--', 'sh'],
  ['mise', 'exec', 'node@20', '--', 'python'], ['npm', 'exec', '--', 'sh'], ['npm', 'exec', 'node'], ['npx', 'sh'],
  ['npx', 'node'], ['npx', '-p', 'x', 'sh'], ['uvx', 'python'], ['uvx', 'sh'], ['uvx', '--with', 'x', 'python'],
  ['pnpm', 'exec', 'sh'], ['pnpm', 'sh'], ['yarn', 'node'], ['yarn', 'run', 'node'], ['docker', 'exec', 'ctr', 'sh'],
  ['docker', 'exec', '-it', 'ctr', 'bash'], ['docker', 'container', 'exec', 'ctr', 'sh'], ['docker', 'run', '--rm', 'img', 'sh'],
  ['docker', 'compose', 'exec', 'web', 'sh'], ['podman', 'exec', 'ctr', 'sh'], ['kubectl', 'exec', 'pod', '--', 'sh'],
  ['kubectl', 'exec', '-it', 'pod', '--', 'bash'],
  // a command after options the tables cannot bound, at either level
  ['uv', 'run', '--bogus', 'pytest'], ['uv', '--bogus', 'run', 'pytest'], ['uv', '--bogus', 'run', 'python'],
  ['docker', '-H', 'x', 'exec', 'c', 'sh'], ['docker', '-v'], ['poetry', 'run', '-v', 'pytest'], ['mise', 'exec', '-c', 'x'],
  ['npm', 'exec', '-c', 'x'], ['npm', 'exec', '--call', 'x'], ['npx', '--bogus', 'tsc'], ['pnpm', 'exec', '-c', 'x'],
  ['pnpm', '-c', 'exec', 'x'], ['pnpm', '--bogus', 'test'], ['direnv', 'exec', '-x', '.'],
  ['kubectl', '--context', 'x', 'get'],
];

test('a runner-exec prefix is broad until it names a concrete command, and then as broad as that command', () => {
  for (const prefix of RUNNER_BROAD) {
    // MUTATION: drop the RUNNER_GRAMMAR test from candidateEligibleForCodex. Every root
    // that is not also a SHELL_WRAPPERS member (`["uv"]` first) skips wrapperIsBroad and
    // renders. Confirmed 2026-10-13.
    // MUTATION: make wrapperIsBroad's first line `if (!SHELL_WRAPPERS.has(root)) return
    // false` again. `["uv"]` renders. Confirmed 2026-10-13.
    // MUTATION: delete the `if (runner) return runnerIsBroad(...)` dispatch. `["uv"]` is
    // still refused bare, but `["uv", "run"]` falls to the generic rule and renders.
    // Confirmed 2026-10-13.
    // MUTATION: drop `|| wrapperIsBroad(inner)` from runnerIsBroad's exec branch.
    // `["direnv", "exec", ".", "sh"]` renders. Confirmed 2026-10-13.
    // MUTATION: drop `operands: 1` from DOCKER_EXEC. `["docker", "exec", "ctr"]` reads `ctr`
    // as the command and renders. Confirmed 2026-10-13.
    // MUTATION: drop `at < 0 ||` from the dispatcher branch. `["uv", "--bogus", "run",
    // "python"]` looks up an `undefined` subcommand and renders. Confirmed 2026-10-13.
    // MUTATION: drop `fallback: 'exec'` handling (return false). `["pnpm", "sh"]` renders.
    // Confirmed 2026-10-13.
    // MUTATION: drop `if (grammar.untilDashDash) continue;` in execWrapperInner. kubectl's
    // walk stops at `pod` and judges it as the command, so `["kubectl", "exec", "pod", "--",
    // "sh"]` renders. Confirmed 2026-10-13.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} admits any command`);
  }
  // The shape the learner itself hands over: `run` is a FAMILY_SUBCOMMANDS entry for uv and
  // pipx, `exec` for docker and kubectl, so each family keys on the two-token form.
  const { classifyInvocation } = require('../src/auto-learn');
  for (const [command, prefix] of [['uv run pytest -x', ['uv', 'run']], ['docker exec app ls', ['docker', 'exec']],
    ['kubectl exec pod -- ls', ['kubectl', 'exec']], ['pipx run black .', ['pipx', 'run']]]) {
    const learned = classifyInvocation({ tool: 'Bash', command, source: 'claude' });
    assert.deepEqual(learned.prefix, prefix, `precondition: ${command}`);
    assert.equal((renderCodexRules([learned], { includeReviewed: true }).match(/prefix_rule\(/g) || []).length, 0, command);
  }
});

test('a runner prefix that names a concrete command, or a fixed-purpose subcommand, still renders', () => {
  for (const prefix of [
    // the command is named and narrow
    ['direnv', 'exec', '.', 'pytest'], ['direnv', 'exec', '.', 'make', 'test'], ['uv', 'run', 'pytest'],
    ['uv', 'run', 'pytest', '-x'], ['uv', 'run', '--with', 'rich', 'pytest'], ['uv', 'run', 'script.py'],
    ['uv', 'run', 'python', 'script.py'], ['uv', 'run', '--', 'pytest'], ['uv', '--directory', 'x', 'run', 'pytest'],
    ['uv', 'tool', 'run', 'ruff'], ['poetry', 'run', 'pytest'], ['poetry', 'run', 'python', 'manage.py'],
    ['poetry', '-C', 'x', 'run', 'pytest'], ['pipx', 'run', 'black'], ['pipx', 'run', '--spec', 'black==24', 'black'],
    ['mise', 'exec', '--', 'pytest'], ['mise', 'exec', 'node@20', '--', 'node', 'x.js'],
    ['mise', 'x', 'python@3.12', '--', 'pytest'], ['mise', 'exec', '-j', '4', '--', 'pytest'], ['npm', 'exec', 'tsc'],
    ['npm', 'exec', '--', 'tsc'], ['npm', 'exec', '--package', 'typescript', '--', 'tsc'], ['npm', 'x', 'eslint'],
    ['npx', 'tsc'], ['npx', '-y', 'tsc'], ['npx', '-p', 'typescript', 'tsc'], ['uvx', 'ruff'], ['uvx', 'ruff', 'check'],
    ['uvx', '--from', 'httpie', 'http'], ['pnpm', 'exec', 'jest'], ['pnpm', 'dlx', 'create-vite'], ['pnpm', 'jest'],
    ['yarn', 'dlx', 'create-vite'], ['yarn', 'run', 'build'], ['yarn', 'build'],
    ['docker', 'exec', 'ctr', 'ls'], ['docker', 'exec', '-it', 'ctr', 'pytest'],
    ['docker', 'exec', '-w', '/app', 'ctr', 'make', 'test'], ['docker', 'exec', 'ctr', 'bash', 'x.sh'],
    ['docker', 'container', 'exec', 'ctr', 'ls'], ['docker', 'run', '--rm', 'img', 'pytest'],
    ['docker', 'compose', 'exec', 'web', 'pytest'], ['podman', 'exec', 'ctr', 'ls'], ['kubectl', 'exec', 'pod', '--', 'ls'],
    ['kubectl', 'exec', '-it', 'pod', '-c', 'app', '--', 'pytest'], ['kubectl', '-n', 'ns', 'exec', 'pod', '--', 'ls'],
    // the module form is `python -m MODULE`, judged by the interpreter grammar
    ['uv', 'run', '-m', 'pytest'],
    // fixed-purpose subcommands, and the exact informational forms
    ['uv', 'sync'], ['uv', 'pip', 'list'], ['uv', 'lock'], ['uv', 'tool', 'install', 'ruff'], ['poetry', 'install'],
    ['pipx', 'install', 'black'], ['pipx', 'list'], ['direnv', 'allow'], ['direnv', 'status'], ['devbox', 'add', 'go'],
    ['devbox', 'install'], ['mise', 'install'], ['mise', 'use', 'node@20'], ['mise', 'ls'], ['docker', 'ps'],
    ['docker', 'build', '.'], ['docker', 'images'], ['podman', 'ps'], ['kubectl', 'get', 'pods'], ['kubectl', 'logs'],
    ['kubectl', '-n', 'ns', 'get'], ['pnpm', 'install'], ['pnpm', 'test'], ['pnpm', '--filter', 'x', 'test'],
    ['pnpm', '-r', 'test'], ['yarn', 'install'], ['yarn', 'test'], ['uv', '--version'], ['docker', '--version'],
    ['direnv', '--help'], ['devbox', '--version'], ['poetry', '--version'], ['uvx', '--version'], ['npx', '--version'],
    // a subcommand is looked up as an own key, so a prototype name is just an unknown word
    ['docker', 'constructor'],
  ]) {
    // MUTATION: delete the `module` line in execWrapperInner. `-m` is then an unknown
    // option and `["uv", "run", "-m", "pytest"]` is refused. Confirmed 2026-10-13.
    // MUTATION: drop the `info` check in runnerIsBroad. `["uv", "--version"]` is an
    // unknown dispatcher option and is refused. Confirmed 2026-10-13.
    // MUTATION: give KUBECTL no `options`. `["kubectl", "-n", "ns", "exec", "pod", "--",
    // "ls"]` is refused. Confirmed 2026-10-13.
    // MUTATION: look the subcommand up with `node.sub[rest[at]]` instead of Object.hasOwn.
    // `["docker", "constructor"]` reaches Object's constructor and is refused. Confirmed
    // 2026-10-13.
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} names its command and still renders`);
  }
});

test('devbox run and ssh are broad at any depth, and so are the identity and host switches of docker and kubectl', () => {
  // devbox runs an ad-hoc command through `eval $DEVBOX_RUN_CMD`, each argument wrapped in
  // Go double quotes, which a POSIX shell still expands: `devbox run npm test '$(rm -rf .)'`
  // runs the rm. That is the shape Claude Code's page recommends as an EXACT rule
  // (`Bash(devbox run npm test)`), and as a prefix it is broad. ssh hands a remote shell
  // one command line. `-u`/`--user` and `--privileged` change who the command runs as, or
  // with what, in the container; `--as` impersonates in the cluster; `-v /:/h` mounts the
  // host's root. kubectl without `--` lets a later token be kubectl's own `--as`.
  for (const prefix of [
    ['devbox', 'run'], ['devbox', 'run', 'test'], ['devbox', 'run', 'npm', 'test'], ['devbox', 'run', '--pure', 'test'],
    ['devbox', 'shell'], ['devbox', 'global', 'run', 'x'], ['mise', 'watch', 'build'], ['npm', 'explore', 'x'],
    ['yarn', 'exec', 'x'], ['yarn', 'workspace', 'a', 'build'], ['poetry', 'shell'],
    // `["ssh", "-V"]` was in this row until 2026-10-14; it prints and exits (measured), and the
    // informational-forms test below holds it narrow. `-V` before a host is still broad.
    ['ssh'], ['ssh', 'host'], ['ssh', 'host', 'ls'], ['ssh', '-p', '22', 'host', 'ls'], ['ssh.exe', 'host'], ['ssh', '-V', 'host'],
    ['docker', 'exec', '-u', 'root', 'ctr', 'ls'], ['docker', 'exec', '--privileged', 'ctr', 'ls'],
    ['docker', 'run', '-v', '/:/h', 'img', 'ls'], ['docker', 'run', '--privileged', 'img', 'ls'],
    ['docker', 'run', '--entrypoint', 'sh', 'img', 'x'], ['kubectl', 'exec', '--as', 'admin', 'pod', '--', 'ls'],
    ['kubectl', 'exec', 'pod', 'ls'], ['kubectl', 'run', 'x'], ['kubectl', 'debug', 'node/x'], ['kubectl', 'attach', 'pod'],
  ]) {
    // MUTATION: make devbox's `run` `{ exec: {} }` (judged by its command).
    // `["devbox", "run", "npm", "test"]` renders. Confirmed 2026-10-13.
    // MUTATION: delete the `ssh` entry from RUNNER_GRAMMAR. `["ssh"]` renders. Confirmed
    // 2026-10-13.
    // MUTATION: add '-u' to DOCKER_EXEC's values. `["docker", "exec", "-u", "root", "ctr",
    // "ls"]` renders. Confirmed 2026-10-13.
    // MUTATION: drop `explore` from the npm table. `["npm", "explore", "x"]` is a fixed
    // subcommand and renders. Confirmed 2026-10-13.
    assert.equal(codexRuleCount(prefix), 0, JSON.stringify(prefix));
  }
});

test('make, just and npm value options are modelled: ending right after a value is still ending in options', () => {
  // `["make", "-C", "dir"]` rendered at bceb66f (668a685 recorded it, not solved): the
  // generic rule only asked whether the LAST token was an option. Each row admits any
  // target, script or a further option (`make -C dir --eval=...`, `npm --prefix dir exec sh`).
  for (const prefix of [
    ['make', '-C', 'dir'], ['make', '-f', 'x.mk'], ['make', '-C', 'dir', '-f', 'x.mk'], ['make', '--directory', 'dir'],
    ['make', '--directory=dir'], ['make', '-j', '4'], ['make', '-j4'], ['make', 'CFLAGS=-O2'], ['make', '-Cdir'],
    ['make', '-kC', 'dir'], ['make', '-I', 'inc'], ['make', '--eval', 'x', 'all'], ['make', '-E', 'x', 'all'],
    ['make', '--bogus', 'all'],
    ['just', '-f', 'x'], ['just', '--justfile', 'x'], ['just', '-d', 'dir'], ['just', '--working-directory', 'dir'],
    ['just', '--set', 'a', 'b'], ['just', 'a=b'], ['just', '-c', 'x'], ['just', '--command', 'x'],
    ['just', '--shell', 'sh', 'build'], ['just', '--chooser', 'x', 'build'], ['just', '--list', 'x'],
    ['npm', '-C', 'dir'], ['npm', '--prefix', 'dir'], ['npm', '-w', 'ws'], ['npm', '--workspace', 'ws'],
    ['npm', '--prefix', 'dir', 'run'], ['npm', 'run'], ['npm', 'run-script'], ['npm', 'run', '--silent'], ['npm', 'init'],
    ['npm', 'create'], ['npm', '--script-shell', 'x', 'test'], ['npm', '--bogus', 'test'], ['npm', '--json', 'false'],
    ['mise', 'run'], ['mise', 'r'], ['mise', 'run', '-j'], ['pnpm', 'run'], ['yarn', 'run'],
  ]) {
    // MUTATION: targetIsBroad returns false when the walk runs out. `["make", "-C", "dir"]`
    // renders. Confirmed 2026-10-13.
    // MUTATION: read a value option as a flag (drop `k += 1` on the values line).
    // `["make", "-C", "dir"]` takes `dir` for the target and renders. Confirmed 2026-10-13.
    // MUTATION: drop the `assignments` continue. `["make", "CFLAGS=-O2"]` reads the override
    // as a target and renders. Confirmed 2026-10-13 with `CC=gcc`, which is a refused
    // program-naming override since 2026-10-14 (the next test), so the row is a data one now;
    // reconfirmed with it 2026-10-14.
    // MUTATION: drop `booleans` from skipRunnerOptions. `["npm", "--json", "false"]` reads
    // `false` as a subcommand and renders. Confirmed 2026-10-13.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} has named no target`);
  }
  for (const prefix of [
    ['make', '-C', 'dir', 'test'], ['make', '-f', 'x.mk', 'all'], ['make', '-j', '4', 'test'], ['make', '-j', 'test'],
    // `["make", "CC=gcc", "all"]` stood here until 2026-10-14; CC names the compiler every
    // recipe runs, so it is refused now, as a decision (src/policy-exporters.js MAKE).
    ['make', '-k', 'test'], ['make', 'CFLAGS=-O2', 'all'], ['make', '--directory=dir', 'all'], ['make', '-Cdir', 'test'],
    ['make', '--', 'test'], ['make', '--version'], ['make', 'test'],
    ['just', '-f', 'x', 'build'], ['just', '--set', 'a', 'b', 'build'], ['just', '-n', 'build'], ['just', 'a=b', 'build'],
    ['just', 'build'], ['just', '--version'],
    ['npm', 'test'], ['npm', 'run', 'build'], ['npm', '--prefix', 'dir', 'test'], ['npm', '-w', 'ws', 'run', 'build'],
    ['npm', 'run', '--silent', 'build'], ['npm', '-s', 'test'], ['npm', 'ci'], ['npm', 'install'], ['npm', 'init', 'vite'],
    ['npm', '--version'], ['mise', 'run', 'test'], ['pnpm', 'run', 'build'],
  ]) {
    // MUTATION: drop `values2` (just's `--set NAME VALUE`). `--set` is unknown and
    // `["just", "--set", "a", "b", "build"]` is refused. Confirmed 2026-10-13.
    // MUTATION: drop `optionalNumber` (make's `-j [N]`). `["make", "-j", "4", "test"]` is
    // refused. MUTATION: consume the next token after `-j` whatever it is. `["make", "-j",
    // "test"]` is refused. Both confirmed 2026-10-13.
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} names its target and still renders`);
  }
});

test('on the Claude side a runner-exec rule is refused at any depth, and a fixed subcommand is untouched', () => {
  // claudePermissionIsSafe refuses a wrapper root at any depth (64b4eaa); a runner-exec form
  // gets the same treatment at the subcommand: `Bash(uv run pytest *)` is refused like
  // `Bash(npx tsc *)`. MEASURED 2026-10-13 against bceb66f: all 37 Claude probes rendered
  // under review, these 23 among them, and 14 still do.
  for (const permission of [
    'Bash(uv run *)', 'Bash(uv run pytest *)', 'Bash(uv tool run *)', 'Bash(docker exec *)', 'Bash(docker exec ctr ls *)',
    'Bash(docker run *)', 'Bash(docker container exec *)', 'Bash(docker compose exec *)', 'Bash(kubectl exec *)',
    'Bash(kubectl run *)', 'Bash(poetry run *)', 'Bash(poetry shell *)', 'Bash(pipx run *)', 'Bash(direnv exec *)',
    'Bash(devbox run *)', 'Bash(devbox run npm test *)', 'Bash(devbox shell *)', 'Bash(mise exec *)', 'Bash(mise x *)',
    'Bash(mise run *)', 'Bash(docker -H x *)', 'PowerShell(docker exec *)', 'Bash(podman exec *)',
  ]) {
    // MUTATION: delete the claudeRuleRunsAnyCommand line in claudePermissionIsSafe.
    // `Bash(uv run *)` renders. Confirmed 2026-10-13.
    // MUTATION: make reachesRunnerExec return false. `Bash(uv run pytest *)` (narrow by
    // the Codex reading) renders. Confirmed 2026-10-13.
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [], permission);
  }
  // The learner's own proposal for `uv run pytest -x` is the first row's rule.
  const { classifyInvocation } = require('../src/auto-learn');
  const learned = classifyInvocation({ tool: 'Bash', command: 'uv run pytest -x', source: 'claude' });
  assert.equal(learned.claudePermission, 'Bash(uv run *)', 'precondition');
  assert.deepEqual(renderClaudePermissions([learned], { includeReviewed: true }), []);
  for (const permission of [
    'Bash(docker ps *)', 'Bash(docker images *)', 'Bash(kubectl get *)', 'Bash(kubectl -n ns get *)', 'Bash(uv sync *)',
    'Bash(uv pip list *)', 'Bash(pipx install *)', 'Bash(poetry install *)', 'Bash(mise ls *)', 'Bash(mise run test *)',
    'Bash(direnv allow *)', 'Bash(devbox add *)', 'Bash(docker build *)',
  ]) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [permission], `${permission} still renders`);
  }
});

// "A value is a command" (2026-10-13). Each row below rendered as a reviewed Codex
// prefix_rule against 3a451fd (72 of the 76 rows of the probe these come from; the other four
// were the xargs and ssh pins at the end), because git, rsync, scp, sftp, tar, find, fd, the
// compose binaries and nerdctl were on no wrapper or runner table. What each one runs is in
// the comments at GIT and at the end of RUNNER_GRAMMAR in src/policy-exporters.js, with the
// measurements.
test('a git prefix carrying -c, --config-env or --exec-path= before its subcommand is broad, and so is one that names none', () => {
  for (const prefix of [
    ['git'], ['git', '-c'], ['git', '-c', 'core.pager=less'], ['git', '-c', 'core.fsmonitor=x', 'status'],
    ['git', '-c', 'alias.st=!sh', 'st'], ['git', '-ccore.pager=x', 'log'], ['git', '--config-env', 'core.pager=X', 'log'],
    ['git', '--config-env=core.pager=X', 'log'], ['git', '-C', 'dir', '-c', 'x=y', 'status'],
    ['git', '--no-pager', '-c', 'x=y', 'log'], ['git', '--exec-path=/x', 'status'], ['git', '--bogus', 'status'],
    ['git.exe', '-c', 'x=y', 'status'], ['GIT', '-c', 'x=y', 'status'],
    // a prefix that ends in global options has named no subcommand; the next word may be `-c`
    ['git', '-C', 'dir'], ['git', '--no-pager'], ['git', '-p'], ['git', '--git-dir', 'x'], ['git', '--work-tree=x'],
    // and through every wrapper, by the recursion
    ['xargs', 'git'], ['xargs', '-I', '{}', 'git'], ['timeout', '5', 'git', '-c', 'x=y', 'status'],
    ['env', 'git', '-c', 'x=y', 'log'], ['uv', 'run', 'git', '-c', 'x=y', 'status'],
    ['docker', 'exec', 'ctr', 'git', '--config-env=alias.x=Y', 'x'],
  ]) {
    // MUTATION: delete the `if (base === 'git')` line in wrapperIsBroad. Nothing judges a git
    // prefix and `["git"]` renders. Confirmed 2026-10-13.
    // MUTATION: delete the git line in candidateEligibleForCodex. `["git"]` renders; the
    // wrapper rows are still refused, by the recursion. Confirmed 2026-10-13.
    // MUTATION: add '-c' to GIT's `values`. `["git", "-c", "core.fsmonitor=x", "status"]`
    // reads as `-c VALUE status` and renders. Confirmed 2026-10-13.
    // MUTATION: add `config-env` to GIT's `fused`. `["git", "--config-env=core.pager=X",
    // "log"]` renders. Confirmed 2026-10-13.
    // MUTATION: add `exec-path` to GIT's `fused`. `["git", "--exec-path=/x", "status"]`
    // renders. Confirmed 2026-10-13.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} lets the next token name a program`);
  }
  // The learner never hands this shape over (a git argv that opens with an option has no
  // family subcommand, so it is `complex`), and it is refused for that reason as before.
  const { classifyInvocation } = require('../src/auto-learn');
  const learned = classifyInvocation({ tool: 'Bash', command: 'git -c core.pager=less log', source: 'claude' });
  assert.equal(learned.complex, true, 'precondition');
  assert.equal((renderCodexRules([learned], { includeReviewed: true }).match(/prefix_rule\(/g) || []).length, 0);
});

test('a git prefix that names its subcommand after path options still renders, and the automatic path is unchanged', () => {
  for (const prefix of [
    ['git', 'status'], ['git', 'log'], ['git', 'push'], ['git', '-C', 'dir', 'status'], ['git', '--no-pager', 'log'],
    ['git', '-C', 'dir', '--no-pager', 'diff'], ['git', '--git-dir=x', 'status'], ['git', '--git-dir', 'x', 'status'],
    ['git', '--work-tree', 'w', '--git-dir', 'x', 'status'], ['git', '--version'], ['git', '--help'], ['git', '-v'],
    // after the subcommand, `-c` is the subcommand's (reuse a message, count matches)
    ['git', 'commit', '-c', 'HEAD'], ['git', 'grep', '-c', 'x'], ['git.exe', 'status'],
    ['xargs', 'git', 'status'], ['timeout', '5', 'git', 'status'], ['uv', 'run', 'git', 'status'],
  ]) {
    // MUTATION: drop '-C' from GIT's `values`. `["git", "-C", "dir", "status"]` is an unknown
    // option and is refused. Confirmed 2026-10-13.
    // MUTATION: give GIT no `info`. `["git", "--version"]` is refused. Confirmed 2026-10-13.
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} names its subcommand and still renders`);
  }
  // The automatic path: AUTO_SAFE_GIT_SUBCOMMANDS still renders unreviewed, unioned.
  // MUTATION: put `git: GIT` in RUNNER_GRAMMAR instead of the two by-name checks. Membership
  // there refuses every git prefix on the automatic path: this assertion fails, and so do
  // the first test in this file ('Codex renderer is deterministic and unions strict
  // auto-safe Git subcommands') and the managed-merge test. Confirmed 2026-10-13.
  assert.ok(compact(renderCodexRules([candidate(['git', 'status']), candidate(['git', 'rev-parse'])]))
    .includes('pattern = ' + JSON.stringify(['git', ['rev-parse', 'status']])));
  // The Claude side needed nothing: a word other than a read subcommand after `git` was
  // already refused. These are pins, true at 3a451fd too.
  for (const permission of ['Bash(git -c x=y status *)', 'Bash(git -C dir status *)', 'Bash(git --config-env=a=B log *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [], permission);
  }
  assert.deepEqual(renderClaudePermissions(['Bash(git status *)'], { includeReviewed: true }), ['Bash(git status *)']);
});

test('rsync, scp, sftp, tar, find and fd read a program from an option anywhere on the line, so no prefix of them is narrow', () => {
  const prefixes = [
    ['rsync'], ['rsync', '-a'], ['rsync', '-av', 'src/', 'dst/'], ['rsync', '-e', 'ssh'], ['rsync', '--rsh=ssh'],
    ['rsync.exe', '-a'], ['scp'], ['scp', '-r'], ['scp', '-S', 'prog'], ['scp', 'a', 'host:b'], ['scp', '-o', 'ProxyCommand=x'],
    ['sftp'], ['sftp', '-D', 'x'], ['sftp', 'host'], ['tar'], ['tar', '-xf'], ['tar', '-tf', 'a.tar'],
    ['tar', '-xf', 'a.tar', '--to-command=sh'], ['tar', '-I', 'x'], ['tar', '--use-compress-program=x'], ['tar.exe', '-xf'],
    ['tar', '-cf', 'a.tar', 'dir'], ['find'], ['find', '.'], ['find', '.', '-name', 'x'], ['find', '.', '-exec'],
    ['find.exe', '.'], ['fd'], ['fd', 'pattern'], ['fd', '-x'], ['fdfind', 'x'],
    // the recursion carries them through a wrapper
    ['xargs', 'tar'], ['xargs', 'find'], ['nice', '-n', '5', 'rsync', '-a'],
  ];
  for (const prefix of prefixes) {
    // MUTATION: delete `rsync: RUNS_ANY_COMMAND` from RUNNER_GRAMMAR. `["rsync"]` renders.
    // The same for `scp`, `sftp`, `tar`, `find`, `fd` and `fdfind`, one at a time: each one's
    // first row renders. Confirmed 2026-10-13.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} admits a later option that names a program`);
    if (prefix.length > 1 && !['scp', 'sftp', 'xargs', 'nice'].includes(prefix[0])) {
      // The Claude side: each multi-token rule rendered under review at 3a451fd.
      const rule = `Bash(${prefix.join(' ')} *)`;
      assert.deepEqual(renderClaudePermissions([rule], { includeReviewed: true }), [], rule);
    }
  }
});

test('docker-compose, podman-compose and nerdctl take the docker grammar', () => {
  for (const prefix of [
    ['docker-compose'], ['docker-compose', 'exec'], ['docker-compose', 'exec', 'web'], ['docker-compose', 'exec', 'web', 'sh'],
    ['docker-compose', 'run', 'web', 'bash'], ['docker-compose', 'run', '--rm', 'web'],
    ['docker-compose', '-f', 'x.yml', 'exec', 'web', 'ls'], ['docker-compose', 'exec', '-u', 'root', 'web', 'ls'],
    ['docker-compose.exe', 'exec', 'web', 'sh'], ['podman-compose', 'exec', 'web', 'sh'], ['nerdctl'], ['nerdctl', 'exec', 'ctr'],
    ['nerdctl', 'exec', 'ctr', 'sh'], ['nerdctl', 'run', 'img'], ['nerdctl', 'run', '--privileged', 'img', 'ls'],
    ['nerdctl', 'container', 'exec', 'ctr', 'sh'], ['nerdctl', 'compose', 'exec', 'web', 'sh'],
    ['nerdctl', '--namespace', 'k8s.io', 'exec', 'c', 'ls'],
  ]) {
    // MUTATION: delete `'docker-compose': COMPOSE` from RUNNER_GRAMMAR. `["docker-compose"]`
    // renders. Likewise `nerdctl` and `podman-compose`. Confirmed 2026-10-13.
    // MUTATION: give COMPOSE `sub: {}`. `exec` is a fixed subcommand and
    // `["docker-compose", "exec", "web", "sh"]` renders. Confirmed 2026-10-13.
    assert.equal(codexRuleCount(prefix), 0, JSON.stringify(prefix));
  }
  for (const prefix of [
    ['docker-compose', 'exec', 'web', 'pytest'], ['docker-compose', 'run', '--rm', 'web', 'pytest'], ['docker-compose', 'ps'],
    ['docker-compose', 'up'], ['docker-compose', '--version'], ['podman-compose', 'exec', 'web', 'ls'], ['nerdctl', 'ps'],
    ['nerdctl', 'exec', 'ctr', 'ls'], ['nerdctl', 'images'],
  ]) {
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} names its command and still renders`);
  }
  for (const permission of ['Bash(docker-compose exec *)', 'Bash(docker-compose run web pytest *)', 'Bash(nerdctl exec *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [], permission);
  }
  for (const permission of ['Bash(docker-compose ps *)', 'Bash(nerdctl ps *)', 'Bash(podman-compose logs *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [permission], permission);
  }
});

test('xargs -I and ssh -o ProxyCommand were already broad where they should be', () => {
  // Pins, each true at 3a451fd: xargs is judged by the command it names (`-I` takes a value),
  // and ssh is broad at any depth (RUNNER_GRAMMAR), ProxyCommand included.
  for (const prefix of [['xargs', '-I', '{}'], ['xargs', '-I', '{}', 'sh'], ['xargs', '-I{}', 'sh', '-c'],
    ['ssh', '-o', 'ProxyCommand=x', 'host'], ['ssh', '-oProxyCommand=x']]) {
    assert.equal(codexRuleCount(prefix), 0, JSON.stringify(prefix));
  }
  assert.equal(codexRuleCount(['xargs', '-I', '{}', 'rm']), 1, 'control: as narrow as `["rm"]`');
});

test('PowerShell code switches were already broad in every abbreviation, and stay so', () => {
  // PowerShell accepts any unambiguous prefix of a parameter, case-insensitively, so
  // `-co`, `-Com` and `-e` are `-Command` and `-EncodedCommand`. The existing branch
  // treats every second token other than -File/-f as broad, which covers all of them.
  // These are pins, not a change: each was already refused on 2026-10-13.
  for (const prefix of [['pwsh', '-c'], ['pwsh', '-Command'], ['pwsh', '-co'], ['pwsh', '-Com'],
    ['pwsh', '-EncodedCommand'], ['pwsh', '-enc'], ['pwsh', '-e'], ['pwsh', '-ec'], ['pwsh', '/c'],
    ['pwsh', '--command'], ['powershell.exe', '-C'], ['powershell', '-NoProfile', '-Command']]) {
    assert.equal(codexRuleCount(prefix), 0, JSON.stringify(prefix));
  }
  assert.equal(codexRuleCount(['pwsh', '-File', 'x.ps1']), 1, 'control: a named script is narrow');
});

test('env and xargs are as narrow as the command they name, and broad when they name none', () => {
  // Decision (2026-10-13): xargs execs its command directly, with no shell, so
  // `["xargs", "rm"]` is `["rm"]` with arguments read from stdin. A reviewer may approve
  // `["rm"]`, so this is no broader; `["xargs", "sh"]` is exactly as broad as `["sh"]`.
  // env is the same, plus `-S`, which takes a whole command line in one argument.
  // MUTATION: delete the env/xargs branch in wrapperIsBroad. ["env","FOO=1"] renders
  // (it is "two tokens, so narrower") and this fails. Confirmed 2026-10-13.
  for (const prefix of [['env', 'FOO=1'], ['env', '-i'], ['env', 'FOO=1', 'make'],
    ['env', '-S', 'sh -c x'], ['env', '--bogus', 'rm'], ['env', 'python', '-c'],
    ['xargs', '-0'], ['xargs', 'sh'], ['xargs', '-n1', 'sh'], ['xargs', '-I', '{}', 'sh', '-c'],
    ['xargs', 'python', '-c'], ['xargs', '--bogus', 'rm']]) {
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} names no command, or a broad one`);
  }
  // MUTATION: drop `|| wrapperIsBroad(inner)` from that branch. ["xargs","sh"] and
  // ["env","FOO=1","make"] render and the loop above fails. Confirmed 2026-10-13.
  for (const prefix of [['env', 'FOO=1', 'make', 'test'], ['env', 'FOO=1', 'rm'], ['env', '-u', 'PATH', 'rm'],
    ['env', 'python', 'x.py'], ['xargs', 'rm'], ['xargs', '-0', 'grep'], ['xargs', 'sh', 'x.sh'],
    ['xargs', '-I{}', 'rm', '{}']]) {
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} names its command and still renders`);
  }
});

// Process and exec wrappers: each runs whatever command follows its own options.
// MEASURED 2026-10-13 against the previous exporter (fa9db35), with a 117-prefix probe of
// synthetic prefixes: every bare root below, and every option-only tail further down,
// rendered as a valid reviewed prefix_rule; 80 of the 117 rendered then and are refused
// now, and none went the other way. Kept as a LITERAL so a root dropped from the
// exporter's own row fails here by name.
const EXEC_WRAPPER_ROOTS = [
  'busybox', 'builtin', 'chroot', 'chrt', 'doas', 'firejail', 'flock', 'gdb', 'ionice', 'ltrace',
  'nice', 'nocorrect', 'noglob', 'nohup', 'nsenter', 'pkexec', 'runas', 'runuser', 'script',
  'setsid', 'stdbuf', 'strace', 'su', 'sudo', 'systemd-run', 'taskset', 'time', 'timeout',
  'unshare', 'valgrind', 'watch',
];

test('every process and exec wrapper is refused as a bare reviewed prefix, in both spellings', () => {
  for (const root of EXEC_WRAPPER_ROOTS) {
    for (const spelling of [root, `${root}.exe`]) {
      // MUTATION: delete the `...[...].flatMap(...)` row from OWN_SHELL_WRAPPERS
      // (src/policy-exporters.js). `["busybox"]` renders a one-token rule and this fails;
      // so do all 31 roots. Confirmed 2026-10-13.
      assert.equal(codexRuleCount([spelling]), 0, `${JSON.stringify([spelling])} runs whatever follows it`);
    }
  }
});

test('an exec wrapper prefix that stops before naming a command is broad', () => {
  // The option-only tails: each ends inside the wrapper's own syntax, so the next token
  // can be any program at all.
  for (const prefix of [
    ['timeout', '5'], ['timeout', '-k', '2', '10s'], ['timeout', '--signal=KILL', '5'], ['timeout', '-k'],
    ['nice', '-n', '10'], ['nice', '-5'], ['stdbuf', '-oL'], ['stdbuf', '-o', 'L'], ['time', '-p'],
    ['setsid', '-f'], ['ionice', '-c', '3'], ['flock', 'lock'], ['flock', '-n', 'lock'],
    ['nsenter', '-t', '1', '-m'], ['strace', '-f', '-e', 'trace=open'], ['ltrace', '-c'],
    ['chroot', '/srv/x'], ['unshare', '-r'], ['taskset', '0x1'], ['chrt', '-f', '10'],
    ['valgrind', '--tool=memcheck'], ['exec', '-a', 'x'], ['command', '-p'], ['nohup', '--'],
  ]) {
    // MUTATION: drop `+ (grammar.operands || 0)` in execWrapperInner. `["timeout", "5"]`
    // reads `5` as the command and renders. Confirmed 2026-10-13.
    // MUTATION: delete the EXEC_WRAPPER_GRAMMAR branch in wrapperIsBroad. Every row here
    // falls to "two tokens, so narrower". Confirmed 2026-10-13.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} names no command`);
  }
});

test('an exec wrapper is exactly as narrow as the command it names', () => {
  // Broad: the command it names is itself broad, an option the grammar does not know,
  // or flock's `-c`, which comes after the lock file and takes a shell command line.
  for (const prefix of [
    ['timeout', '5', 'sh'], ['nohup', 'bash', '-c'], ['busybox', 'sh'], ['builtin', 'eval'],
    ['exec', 'sh'], ['command', 'sh'], ['nice', 'python', '-c'], ['setsid', 'env', 'FOO=1'],
    ['strace', '-f', 'xargs', 'sh'], ['noglob', 'xargs', '-0'], ['nohup', 'timeout', '5'],
    ['timeout', '--bogus', '5', 'rm'], ['nice', '--bogus', 'rm'], ['ionice', '-z', 'rm'],
    ['flock', 'lock', '-c'], ['flock', 'lock', '--command'], ['flock', '--command=x', 'lock'],
  ]) {
    // MUTATION: drop `|| wrapperIsBroad(inner)` from the new branch. `["timeout", "5",
    // "sh"]` renders. Confirmed 2026-10-13.
    // MUTATION: make an unknown option `continue` instead of returning null.
    // `["timeout", "--bogus", "5", "rm"]` renders. Confirmed 2026-10-13.
    // MUTATION: drop the leading-dash refusal at the end of execWrapperInner.
    // `["flock", "lock", "-c"]` renders. Confirmed 2026-10-13.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} is as broad as what it runs`);
  }
  // Controls: a concrete command after the wrapper's options renders, the same decision
  // 30f92a4 made for xargs (it execs without a shell, so it is no broader than the
  // command), and `command -v` is a lookup that runs nothing.
  for (const prefix of [
    ['timeout', '5', 'rg'], ['timeout', '-k', '2', '10s', 'make', 'test'], ['timeout', '--', '5', 'rg'],
    ['nice', '-n', '10', 'rg'], ['nohup', 'rg'], ['stdbuf', '-oL', 'grep'], ['time', '-p', 'rg'],
    ['setsid', 'rg'], ['ionice', '-c', '3', 'rg'], ['flock', '/tmp/l', 'rg'], ['busybox', 'ls'],
    ['nsenter', '-t', '1', '-m', 'ls'], ['strace', '-f', 'ls'], ['ltrace', '-c', 'ls'],
    ['chroot', '/srv/x', 'ls'], ['unshare', '-r', 'ls'], ['taskset', '0x1', 'ls'],
    ['chrt', '-f', '10', 'ls'], ['valgrind', '--tool=memcheck', 'ls'], ['builtin', 'cd'],
    ['noglob', 'ls'], ['nocorrect', 'ls'], ['command', 'rg'], ['exec', 'rg'],
    ['command', '-v'], ['command', '-v', 'rg'],
  ]) {
    // MUTATION: delete the `grammar.lookup` line in execWrapperInner. `-v` is then an
    // unknown option, `["command", "-v"]` is refused and this fails. Confirmed
    // 2026-10-13. (Dropping only the `inner === LOOKUP` return in wrapperIsBroad is an
    // equivalent mutant: a Symbol has no length and no root, so it falls through to
    // narrow anyway. The explicit return is kept so that reads as intended.)
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} names its command and still renders`);
  }
});

test('identity-changing and shell-text wrappers are broad at any depth', () => {
  // A named command does not narrow these: watch and eval hand their arguments to a
  // shell, script and firejail can, sudo-like wrappers change who the command runs as,
  // and gdb and systemd-run carry options this module cannot bound.
  for (const prefix of [
    ['watch', 'ls'], ['sudo', 'rm'], ['sudo', '-u', 'root', 'ls'], ['sudo.exe', 'ls'], ['doas', 'ls'],
    ['pkexec', 'ls'], ['su', '-c'], ['runuser', '-u', 'x', 'ls'], ['runas', '/user:x', 'cmd'],
    ['eval', 'x'], ['script', '-q'], ['firejail', 'ls'], ['systemd-run', 'ls'], ['gdb', '--args', 'x'],
  ]) {
    // MUTATION: delete the ALWAYS_BROAD_WRAPPERS check in wrapperIsBroad. `["watch",
    // "ls"]` renders. Confirmed 2026-10-13.
    assert.equal(codexRuleCount(prefix), 0, JSON.stringify(prefix));
  }
});

test('the Claude side refuses the same wrappers at any depth, by membership', () => {
  // claudePermissionIsSafe refuses a wrapper root at any depth (64b4eaa), so the new
  // roots are refused there too. The learner strips the wrappers Claude Code strips, so
  // a rule like these only reaches the exporter from a shape Claude Code does not strip.
  for (const permission of ['Bash(timeout *)', 'Bash(nohup rg *)', 'Bash(sudo ls *)', 'Bash(watch *)',
    'Bash(nice -n *)', 'PowerShell(sudo *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [], permission);
  }
  assert.deepEqual(renderClaudePermissions(['Bash(git diff *)'], { includeReviewed: true }), ['Bash(git diff *)']);
});

test('every reviewed cmd prefix is broad: the code switch may follow other switches', () => {
  // cmd.exe takes its command from the first /c or /k after any other switches (/r is
  // an old alias of /c). Checking the second token alone let these three render.
  // MUTATION: restore `return second === '/c' || second === '/k'` for cmd; the second
  // row renders and this fails. Confirmed 2026-10-13.
  for (const prefix of [['cmd', '/c'], ['cmd', '/d', '/c'], ['cmd', '/q'], ['cmd.exe', '/r'], ['command.com', '/k']]) {
    assert.equal(codexRuleCount(prefix), 0, JSON.stringify(prefix));
  }
});

test('the Claude side already refuses interpreter code-flag rules, by wrapper membership', () => {
  // Consistent with the Codex half, and stricter: claudePermissionIsSafe refuses a
  // runner root at any depth (pinned as a decision in 64b4eaa), so there is no
  // narrower-prefix rule there for a code flag to slip past.
  for (const permission of ['Bash(python -c *)', 'Bash(node -e *)', 'Bash(env FOO=1 *)',
    'Bash(xargs sh *)', 'PowerShell(pwsh -c *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [], permission);
  }
  assert.deepEqual(renderClaudePermissions(['Bash(git diff *)'], { includeReviewed: true }), ['Bash(git diff *)']);
});

test('exporter refusal covers every learner shell wrapper, so the tables cannot drift', () => {
  const { SHELL_WRAPPERS: learner } = require('../src/auto-learn');
  assert.ok(learner.size >= 43, 'precondition: the learner table is the one measured on 2026-10-13');
  const leaked = [];
  for (const root of learner) {
    for (const spelling of spellingsOf(root)) if (codexRuleCount([spelling]) !== 0) leaked.push(spelling);
  }
  // MUTATION: drop the learner union; 99 spellings leak and this fails listing them.
  assert.deepEqual(leaked, [],
    'a root in src/auto-learn.js SHELL_WRAPPERS renders as a bare reviewed Codex rule');
  for (const root of NEWLY_REFUSED_RUNNERS) {
    assert.ok(learner.has(root), `${root} left the learner table; decide whether the exporter `
      + 'should still refuse it and, if so, add it to OWN_SHELL_WRAPPERS');
  }
});

test('on the Claude side a learner runner is refused at any depth, as every wrapper already was', () => {
  // A deliberate consequence of one shared table, pinned so it reads as a decision.
  // Before 2026-10-13 each of these rendered under review.
  for (const permission of ['Bash(node --version *)', 'Bash(command -v *)', 'Bash(xargs -0 *)',
    'PowerShell(node --version *)', 'Bash(python --version *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [],
      `${permission} names a runner and must stay refused under review`);
  }
  // Control: a non-runner multi-token rule still renders under review.
  assert.deepEqual(renderClaudePermissions(['Bash(git diff *)'], { includeReviewed: true }),
    ['Bash(git diff *)']);
});

test('Codex validator rejects malformed and dangerously broad generated rules', () => {
  assert.equal(validateCodexRulesText('prefix_rule(').valid, false);
  for (const pattern of [
    ['powershell.exe', '-Command'],
    ['python'],
    ['curl'],
    ['git'],
    ['rg', '*.js'],
  ]) {
    const result = validateCodexRulesText(manualRule(pattern));
    assert.equal(result.valid, false, JSON.stringify({ pattern, result }));
  }
  assert.equal(validateCodexRulesText('dangerous_call()\n').valid, false);
});

test('Claude renderer emits only vetted root wildcards', () => {
  const permissions = renderClaudePermissions([
    candidate(['rg', '--files'], { tool: 'Bash', claudePermission: 'Bash(rg --files *)' }),
    candidate(['Get-ChildItem'], { shell: 'powershell' }),
    candidate(['Get-Content'], { shell: 'powershell' }),
    candidate(['Test-Path'], { shell: 'powershell' }),
    candidate(['cat'], { tool: 'Bash', claudePermission: 'Bash(cat *)' }),
    candidate(['date'], { tool: 'Bash', claudePermission: 'Bash(date *)' }),
    candidate(['hostname'], { tool: 'Bash', claudePermission: 'Bash(hostname *)' }),
    candidate(['git', 'status'], { tool: 'Bash', claudePermission: 'Bash(git status *)' }),
    candidate(['git', 'rev-parse'], {
      tool: 'Bash', claudePermission: 'Bash(git rev-parse *)', reasons: ['environment-prefix'],
    }),
    candidate(['rm'], { tool: 'Bash', claudePermission: 'Bash(rm *)' }),
    candidate(['curl'], { tool: 'Bash', claudePermission: 'Bash(curl *)' }),
    candidate(['anything'], { tool: 'PowerShell', claudePermission: 'PowerShell(& *)' }),
    { autoSafe: false, root: 'cat', tool: 'Bash' },
  ]);
  assert.deepEqual(permissions, ['Bash(git status *)', 'Bash(rg --files *)']);
});

// This gate is a second, independent copy of the learner's. Feed it candidates
// already flagged autoSafe — as if the learner's gate had failed open — and it
// must still refuse anything whose argument can reach stdout, because the
// emitted `Bash(<root> *)` would also match `<root> ... > <path>`.
test('the exporter refuses content-writing roots even when handed autoSafe: true', () => {
  const permissions = renderClaudePermissions([
    candidate(['echo'], { tool: 'Bash', claudePermission: 'Bash(echo *)' }),
    candidate(['printf'], { tool: 'Bash', claudePermission: 'Bash(printf *)' }),
    candidate(['basename'], { tool: 'Bash', claudePermission: 'Bash(basename *)' }),
    candidate(['dirname'], { tool: 'Bash', claudePermission: 'Bash(dirname *)' }),
    candidate(['Get-Date'], { shell: 'powershell' }),
    candidate(['Write-Output'], { shell: 'powershell' }),
    candidate(['git', 'cat-file'], { tool: 'Bash', claudePermission: 'Bash(git cat-file *)' }),
    // Retained, so the test proves exclusion rather than a blanket refusal.
    candidate(['whoami'], { tool: 'Bash', claudePermission: 'Bash(whoami *)' }),
  ]);
  assert.deepEqual(permissions, ['Bash(whoami *)']);
});

// The two gates are duplicated on purpose — a bug in one should not propagate.
// Duplication only helps while both describe the same set, so assert they agree
// modulo the exporter's .exe spellings (the learner strips .exe when normalizing).
test('the learner and exporter auto-safe sets do not drift apart', () => {
  const {
    AUTO_SUFFIX_CLOSED_ROOTS: exporterRoots,
    AUTO_SAFE_GIT_SUBCOMMANDS: exporterGit,
  } = require('../src/policy-exporters');
  const {
    AUTO_SUFFIX_CLOSED_ROOTS: learnerRoots,
    AUTO_SAFE_GIT: learnerGit,
  } = require('../src/auto-learn');

  const stripExe = (set) => new Set([...set].map((root) => root.replace(/\.exe$/, '')));
  assert.deepEqual(
    [...stripExe(exporterRoots)].sort(),
    [...stripExe(learnerRoots)].sort(),
    'auto-safe root sets disagree between src/auto-learn.js and src/policy-exporters.js',
  );
  assert.deepEqual(
    [...exporterGit].sort(),
    [...learnerGit].sort(),
    'auto-safe git subcommand sets disagree between the two gates',
  );
});

test('explicitly reviewed Claude export can retain narrow read candidates', () => {
  const permissions = renderClaudePermissions([
    { autoSafe: false, tool: 'Bash', prefix: ['cat'], claudePermission: 'Bash(cat *)' },
    { autoSafe: false, tool: 'Bash', prefix: ['git', 'diff'], claudePermission: 'Bash(git diff *)' },
    { autoSafe: false, shell: 'powershell', prefix: ['Get-Content'] },
  ], { includeReviewed: true });
  assert.deepEqual(permissions, [
    'Bash(cat *)', 'Bash(git diff *)', 'PowerShell(Get-Content *)',
  ]);
});

// The third argument used to be an allow-list processor that only this test ever
// supplied; production spelled it `null`. It is gone, so what is asserted here is
// what production actually does: append generated entries after the manual ones,
// never reorder or drop a manual entry, and never mutate the caller's array.
//
// The arity is asserted too. A removed parameter that some caller still passes
// positionally would silently become `options`, and `{ includeReviewed: true }`
// arriving in the wrong slot is the one mistake this change could cause.
test('Claude merge appends generated entries and leaves manual ones untouched', () => {
  const manual = ['Bash(git status *)', 'WebSearch'];
  const merged = mergeClaudeAllow(manual, [candidate(['rg', '--files'], {
    tool: 'Bash', claudePermission: 'Bash(rg --files *)',
  })]);
  assert.deepEqual(merged, ['Bash(git status *)', 'WebSearch', 'Bash(rg --files *)']);
  assert.deepEqual(manual, ['Bash(git status *)', 'WebSearch'], 'the input array is not mutated');

  // Third position is options now, not a processor.
  assert.equal(mergeClaudeAllow.length, 2, 'options is defaulted, so only two required parameters');
  const reviewed = mergeClaudeAllow([], [
    { autoSafe: false, tool: 'Bash', prefix: ['cat'], claudePermission: 'Bash(cat *)' },
  ], { includeReviewed: true });
  assert.deepEqual(reviewed, ['Bash(cat *)'],
    'options in the third slot still reaches renderClaudePermissions');
  assert.deepEqual(mergeClaudeAllow([], [
    { autoSafe: false, tool: 'Bash', prefix: ['cat'], claudePermission: 'Bash(cat *)' },
  ]), [], 'and without it the reviewed candidate is still withheld');

  // A stray function in the old slot must not be read as options and must not be
  // called. Silently invoking a leftover argument is how a removed parameter
  // keeps working just well enough to hide a mistake.
  let called = false;
  assert.deepEqual(
    mergeClaudeAllow(manual, [candidate(['rg', '--files'], {
      tool: 'Bash', claudePermission: 'Bash(rg --files *)',
    })], () => { called = true; return []; }),
    ['Bash(git status *)', 'WebSearch', 'Bash(rg --files *)'],
  );
  assert.equal(called, false, 'the retired processor argument is never invoked');
});

test('Codex managed merge preserves manual text and replaces only its marked section', () => {
  const manual = '# hand written\n' + manualRule(['rg', '--files']);
  const firstRules = renderCodexRules([candidate(['git', 'status'])]);
  const secondRules = renderCodexRules([candidate(['git', 'rev-parse'])]);
  const first = mergeGeneratedCodexRules(manual, firstRules);
  assert.ok(first.startsWith(manual));
  assert.ok(first.includes('# BEGIN permission-wildcarding generated rules'));
  assert.equal(mergeGeneratedCodexRules(first, firstRules), first);

  const second = mergeGeneratedCodexRules(first, secondRules);
  assert.ok(second.startsWith(manual));
  assert.ok(compact(second).includes('pattern = ' + JSON.stringify(['git', 'rev-parse'])));
  assert.ok(!compact(second).includes('pattern = ' + JSON.stringify(['git', 'status'])));
  assert.throws(
    () => mergeGeneratedCodexRules('# BEGIN permission-wildcarding generated rules\n', firstRules),
    /unbalanced/
  );
});

// A single-token root wildcard covers every argument, so the two automatic
// allow-lists only hold read-only roots. That left roots the starter pack
// already grants for the other shell with no route at all: the learner refused
// to propose what the seed it ships had granted. A reviewer may now grant them,
// and only a reviewer.
test('a reviewable root is grantable by hand and never automatically', () => {
  for (const permission of ['PowerShell(ctest *)', 'PowerShell(magick *)', 'Bash(magick *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [permission],
      `${permission} should be grantable under review`);
    assert.deepEqual(renderClaudePermissions([permission], {}), [],
      `${permission} must not be automatically applicable`);
  }

  // The read-only roots keep both routes, so the split did not demote them.
  // `whoami` is suffix-closed as well as read-only, which is what the
  // automatic path requires; `stat` is read-only but not suffix-closed, so it
  // was already review-only before this change and stays that way.
  assert.deepEqual(renderClaudePermissions(['Bash(whoami *)'], {}), ['Bash(whoami *)']);
  assert.deepEqual(renderClaudePermissions(['Bash(stat *)'], { includeReviewed: true }), ['Bash(stat *)']);
  assert.deepEqual(renderClaudePermissions(['Bash(stat *)'], {}), []);

  // Not a blanket opening: a root on neither list stays refused either way.
  for (const permission of ['Bash(ffmpeg *)', 'PowerShell(Invoke-Build *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [],
      `${permission} is on no list and must stay refused`);
  }

  // A wrapper or install root is refused even under review, so the reviewable
  // list cannot be used to reach arbitrary execution.
  for (const permission of ['Bash(python *)', 'Bash(npm *)', 'PowerShell(& *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [],
      `${permission} must stay refused under review`);
  }
});

// Versioned and distribution interpreter names, and the Windows launch suffixes (2026-10-14,
// commandBase in src/policy-exporters.js). MEASURED that day against 3417398 with a 136-probe
// over these rows and the two tests below: 87 verdicts changed, 70 from rendered to refused (20
// bare spellings, 21 code forms, 20 reviewed Claude rules, 9 `.cmd`/`.bat` wrapper prefixes)
// and 17 learner families from `unknown-command` to `shell-wrapper`; none the other way, and no
// pinned form or control moved. The rest were refused already, through the learner union's
// `.cmd` spellings (`python3.cmd`, bare `pwsh.cmd`, `timeout.cmd`, `nice.cmd`) or the old
// `.exe|.cmd` strip (`uv.cmd`). Each row is [spelling, a form that hands over code, a form that
// pins the program].
const INTERPRETER_SPELLINGS = [
  ['python3.12', ['-c', 'x'], ['x.py']], ['python2.7', ['-c', 'x'], ['x.py']],
  ['python3.13t', ['-Ic', 'x'], ['-m', 'pytest']], ['pythonw', ['-c', 'x'], ['x.pyw']],
  ['python3-dbg', ['-c', 'x'], ['x.py']], ['pypy3', ['-c', 'x'], ['x.py']], ['pyw', ['-c', 'x'], ['x.py']],
  ['python.bat', ['-c', 'x'], ['x.py']], ['python3.cmd', ['-c', 'x'], ['x.py']],
  ['Python3.12.EXE', ['-c', 'x'], ['x.py']],
  ['nodejs', ['-e', 'x'], ['x.js']], ['node20', ['-e', 'x'], ['x.js']], ['node.bat', ['-p', 'x'], ['x.js']],
  ['ruby3.2', ['-e', 'x'], ['x.rb']], ['perl5.36', ['-e', 'x'], ['x.pl']], ['php8.2', ['-r', 'x'], ['x.php']],
  ['php82', ['-r', 'x'], ['x.php']],
  ['pwsh-preview', ['-Command', 'x'], ['-File', 'x.ps1']], ['pwsh-lts', ['-c', 'x'], ['-File', 'x.ps1']],
  ['pwsh.cmd', ['-Command', 'x'], ['-File', 'x.ps1']], ['powershell.bat', ['-enc', 'x'], ['-File', 'x.ps1']],
  ['yarnpkg', ['node'], ['build']],
];
// Tools whose names merely START with an interpreter's. Not aliases, so judged as before.
const NOT_INTERPRETERS = ['python3-config', 'python-config', 'nodemon', 'node-gyp', 'perldoc', 'phpunit',
  'pytest', 'pyright', 'rubocop', 'pwsh-x'];

test('a versioned, distribution or .cmd/.bat interpreter name is refused exactly as its base is', () => {
  const { classifyInvocation } = require('../src/auto-learn');
  for (const [spelling, code, pinned] of INTERPRETER_SPELLINGS) {
    // MUTATION: drop the python row from COMMAND_ALIASES (src/policy-exporters.js).
    // `["python3.12"]` renders a bare rule and this fails. Confirmed 2026-10-14.
    // MUTATION: strip only `.exe|.cmd` in commandBase (the old suffix set). `["python.bat"]`
    // renders. Confirmed 2026-10-14.
    // MUTATION: drop `&& !SHELL_WRAPPERS.has(base)` in wrapperIsBroad. The root is on no
    // table, so `["python3.12"]` renders. Confirmed 2026-10-14.
    assert.equal(codexRuleCount([spelling]), 0, `${spelling} is an interpreter and must not become a bare rule`);
    assert.equal(codexRuleCount([spelling, ...code]), 0, `${JSON.stringify([spelling, ...code])} hands over code`);
    // Control: the base's grammar judges it, so a pinned program still renders.
    assert.equal(codexRuleCount([spelling, ...pinned]), 1, `${JSON.stringify([spelling, ...pinned])} pins its program`);
    // The Claude half refuses an interpreter root at any depth, by membership (64b4eaa).
    // MUTATION: drop `|| SHELL_WRAPPERS.has(commandBase(root))` from claudePermissionIsSafe.
    // `Bash(python3.12 x.py *)` renders. Confirmed 2026-10-14.
    const rule = `Bash(${spelling} ${pinned.join(' ')} *)`;
    assert.deepEqual(renderClaudePermissions([rule], { includeReviewed: true }), [], rule);
    // The learner's own lookup agrees (its independent copy, interpreterAlias).
    // MUTATION: make interpreterAlias return its argument unchanged (src/auto-learn.js).
    // `python3.12 x.py` is `unknown-command` and this fails. Confirmed 2026-10-14.
    const learned = classifyInvocation({ tool: 'Bash', command: `${spelling} ${pinned.join(' ')}`, source: 'claude' });
    assert.ok(learned.reasons.includes('shell-wrapper'), `${spelling}: ${JSON.stringify(learned.reasons)}`);
  }
  // The two copies agree on what is NOT an alias, too.
  for (const name of NOT_INTERPRETERS) {
    assert.equal(codexRuleCount([name]), 1, `${name} is not an interpreter alias and is judged as before`);
    const learned = classifyInvocation({ tool: 'Bash', command: `${name} x`, source: 'claude' });
    assert.ok(!learned.reasons.includes('shell-wrapper'), `${name}: ${JSON.stringify(learned.reasons)}`);
  }
});

test('the .cmd and .bat spellings of a wrapper are judged as the wrapper', () => {
  // MEASURED 2026-10-14 against 3417398: 9 of these 12 rendered, because the wrapper rows were
  // spelled bare and `.exe` only; `timeout.cmd` and `nice.cmd` were refused through the learner
  // union's `.cmd` spellings, and `uv.cmd` by the old `.exe|.cmd` strip.
  for (const prefix of [['sudo.cmd', 'rm'], ['sudo.bat', 'ls'], ['doas.cmd', 'ls'], ['timeout.cmd', '5'],
    ['nohup.bat', 'sh'], ['nice.cmd', '-n', '5'], ['watch.cmd', 'ls'], ['cmd.bat', '/c'], ['npx.bat', 'sh'],
    ['env.bat', 'FOO=1'], ['uv.cmd', 'run'], ['docker.bat', 'exec', 'ctr', 'sh']]) {
    assert.equal(codexRuleCount(prefix), 0, JSON.stringify(prefix));
  }
  // Controls: the same wrappers once they name a narrow command, as their bare spelling does.
  for (const prefix of [['timeout.cmd', '5', 'rg'], ['nohup.bat', 'rg'], ['uv.cmd', 'run', 'pytest'],
    ['docker.bat', 'ps']]) {
    assert.equal(codexRuleCount(prefix), 1, JSON.stringify(prefix));
  }
});

test('the validator bans a bare interpreter or a broad PowerShell prefix in every spelling', () => {
  // The second line behind wrapperIsBroad: a generated rules file is refused at merge time.
  // MUTATION: restore the exact-name list in patternSafetyErrors' python check.
  // `["python3.12"]` validates and this fails. Confirmed 2026-10-14.
  for (const pattern of [['python3.12'], ['pypy3'], ['pyw'], ['python.bat'], ['pwsh-preview'],
    ['pwsh.cmd', '-Command'], ['powershell.bat', '-c']]) {
    assert.equal(validateCodexRulesText(manualRule(pattern)).valid, false, JSON.stringify(pattern));
  }
  for (const pattern of [['python3-config'], ['pwsh.cmd', '-File', 'x.ps1'], ['python3.12', 'x.py']]) {
    assert.equal(validateCodexRulesText(manualRule(pattern)).valid, true, JSON.stringify(pattern));
  }
});

// MEASURED 2026-10-14 against 4a02252 (src/policy-exporters.js RUNNER_GRAMMAR has the tool
// measurements): 25 of the 27 rows of the first list rendered as a reviewed prefix_rule there,
// `["duckdb", "--version"]` included, through the generic rule and its informational exception;
// `["duckdb", "-version"]` (not a DEFAULT_INFO word) and `["xargs", "duckdb"]` (the bare root)
// were refused already. The 7 informational controls rendered there and still do. duckdb runs an
// `-init` file before it prints its version, so it keeps no exception.
test('hyperfine, duckdb and wsl are broad at any depth, but for the informational forms measured inert', () => {
  for (const prefix of [
    ['hyperfine', 'echo SAFE'], ['hyperfine', '-N', 'x'], ['hyperfine', '--runs', '1', 'x'], ['hyperfine', '--setup', 'x'],
    ['hyperfine', 'build'], ['hyperfine.exe', 'x'],
    ['duckdb', 'x.db'], ['duckdb', 'x.db', 'SELECT 1'], ['duckdb', '-c', 'SELECT 1'], ['duckdb', '-readonly', 'x.db'],
    ['duckdb', '--version'], ['duckdb', '-version'], ['duckdb', '--help'], ['duckdb', '-h'], ['duckdb.exe', 'x.db'],
    ['wsl', 'ls'], ['wsl', '-e', 'ls'], ['wsl', '--exec', 'ls'], ['wsl', '-d', 'Ubuntu', 'ls'], ['wsl', '-u', 'root'],
    ['wsl', '--', 'ls'], ['wsl', '-h'], ['wsl', '-V'], ['wsl.exe', 'ls'],
    // and through every wrapper, by the recursion
    ['timeout', '5', 'hyperfine', 'x'], ['xargs', 'duckdb'], ['nohup', 'wsl', 'ls'],
  ]) {
    // MUTATION: delete the hyperfine entry from RUNNER_GRAMMAR. `["hyperfine", "echo SAFE"]`
    // falls to the generic rule and renders. Confirmed 2026-10-14.
    // MUTATION: give duckdb `infoOnly(DEFAULT_INFO)`. `["duckdb", "--version"]` renders.
    // Confirmed 2026-10-14.
    // MUTATION: delete the wsl entry. `["wsl", "ls"]` renders. Confirmed 2026-10-14.
    // MUTATION: drop `if (node.any) return true;` in runnerIsBroad. An infoOnly root then
    // reads as a dispatcher with no subcommands and `["hyperfine", "echo SAFE"]` renders.
    // Confirmed 2026-10-14.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} runs a command or code it names`);
  }
  for (const prefix of [['hyperfine', '--version'], ['hyperfine', '-V'], ['hyperfine', '--help'], ['hyperfine', '-h'],
    ['wsl', '--version'], ['wsl', '--help'], ['wsl.exe', '--version']]) {
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} was measured to print and exit`);
  }
  // The learner hands over exactly these shapes: a bare root, or the root and an
  // informational word (prefixFor), and `duckdb --version` is the one that rendered.
  const { classifyInvocation } = require('../src/auto-learn');
  for (const command of ['duckdb --version', 'duckdb x.db', "hyperfine 'sleep 1'", 'wsl ls']) {
    const learned = classifyInvocation({ tool: 'Bash', command, source: 'claude' });
    assert.equal((renderCodexRules([learned], { includeReviewed: true }).match(/prefix_rule\(/g) || []).length, 0, command);
  }
  // The Claude half refused all three at any depth already, by membership (64b4eaa), and
  // still does: a pin.
  for (const permission of ['Bash(hyperfine --version *)', 'Bash(duckdb x.db *)', 'Bash(wsl --version *)',
    'PowerShell(wsl ls *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [], permission);
  }
});

// Exporter consistency (2026-10-14). MEASURED against 09df009 over exactly the rows below:
// 15/15 Claude informational rules, 19/19 Codex informational prefixes and 3/3 Claude tar/find/fd
// rules went from refused to rendered; 7/8 `.cmd`/`.bat` Claude rules and 10/10 env rows from
// rendered to refused; all 34 controls kept their verdict.
test('a runner that is not a wrapper keeps its exact informational forms narrow on the Claude half too', () => {
  // b0685b2: "Exact informational forms (`["docker", "--version"]`) stay narrow", true on the
  // Codex half and not on this one, where reachesRunnerExec read `--version` as an unknown
  // dispatcher option. Every rule in the first list was refused at 09df009.
  for (const permission of ['Bash(docker --version *)', 'Bash(docker -h *)', 'Bash(podman --version *)',
    'Bash(uv --version *)', 'Bash(uv -V *)', 'Bash(poetry --version *)', 'Bash(pipx --version *)',
    'Bash(kubectl --help *)', 'Bash(kubectl -h *)', 'Bash(direnv --help *)', 'Bash(mise --version *)',
    'Bash(devbox --version *)', 'Bash(nerdctl --version *)', 'Bash(docker-compose --version *)',
    'PowerShell(docker --version *)']) {
    // MUTATION: drop the informational line at the top of reachesRunnerExec. `Bash(docker
    // --version *)` is refused again and this fails. Confirmed 2026-10-14.
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [permission], permission);
    assert.deepEqual(renderClaudePermissions([permission], {}), [], `${permission} is never automatic`);
  }
  // Controls: only the exact two-token form, only at the runner's own level, and never for a
  // runner the Claude half refuses by membership or as a network root.
  for (const permission of ['Bash(docker --version x *)', 'Bash(docker exec --help *)', 'Bash(uv run --help *)',
    'Bash(devbox run --help *)', 'Bash(kubectl exec -h *)', 'Bash(docker -H x *)', 'Bash(npm --version *)',
    'Bash(npx --version *)', 'Bash(make --version *)', 'Bash(ssh -V *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [], permission);
  }
  // And the two halves now agree on every form the first list names.
  for (const prefix of [['docker', '--version'], ['uv', '-V'], ['kubectl', '--help'], ['podman', '--version']]) {
    assert.equal(codexRuleCount(prefix), 1, JSON.stringify(prefix));
  }
});

test('the exact long informational form of a measured wrapper, tar, find and fd is narrow, and ssh -V', () => {
  // Each was refused on both halves with no stated reason. MEASURED 2026-10-14 (marker-file
  // payloads, src/policy-exporters.js WRAPPER_INFO_ROOTS and RUNNER_GRAMMAR): every one prints
  // and exits before the command or option after it is read.
  for (const prefix of [['timeout', '--version'], ['timeout', '--help'], ['nice', '--version'], ['nohup', '--help'],
    ['stdbuf', '--version'], ['chroot', '--version'], ['env', '--version'], ['env', '--help'], ['xargs', '--version'],
    ['xargs', '--help'], ['tar', '--version'], ['tar', '--help'], ['find', '--version'], ['find', '--help'],
    ['fd', '--version'], ['fdfind', '--help'], ['ssh', '-V'], ['ssh.exe', '-V'], ['timeout.exe', '--version']]) {
    // MUTATION: drop the WRAPPER_INFO_ROOTS line in wrapperIsBroad. `["timeout", "--version"]`
    // is an unknown option again and this fails. Confirmed 2026-10-14.
    // MUTATION: give tar RUNS_ANY_COMMAND again. `["tar", "--version"]` fails. Confirmed
    // 2026-10-14.
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} prints and exits`);
  }
  // Controls: the short forms are other options to these tools (`tar -h` dereferences, `tar
  // -V` names a volume), anything after the informational word is not exact, and the
  // unmeasured, identity-changing and shell-text wrappers keep no exception.
  for (const prefix of [['timeout', '-h'], ['tar', '-h'], ['tar', '-V'], ['find', '-h'], ['fd', '-V'],
    ['ssh', '--version'], ['ssh', '-V', 'host'], ['timeout', '--version', '5', 'sh'], ['xargs', '--help', 'sh'],
    ['tar', '--version', '--to-command=sh'], ['setsid', '--version'], ['strace', '--version'], ['sudo', '-V'],
    ['sudo', '--version'], ['eval', '--version'], ['watch', '--version'], ['rsync', '--version'], ['scp', '-V'],
    ['command', '--version'], ['duckdb', '--version']]) {
    assert.equal(codexRuleCount(prefix), 0, JSON.stringify(prefix));
  }
  // The Claude half: tar, find and fd are runners that are not wrappers, so their long forms
  // render there too; the wrappers stay refused by membership (64b4eaa), and ssh as a network
  // root, which is the reason this half does not follow the Codex one for them.
  for (const permission of ['Bash(tar --version *)', 'Bash(find --help *)', 'Bash(fd --version *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [permission], permission);
  }
  for (const permission of ['Bash(timeout --version *)', 'Bash(env --version *)', 'Bash(xargs --help *)',
    'Bash(ssh -V *)', 'Bash(tar -h *)', 'Bash(find . *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [], permission);
  }
});

test('the .cmd and .bat spellings of a risky root are refused like the root, on both halves', () => {
  // Item 2's normalization (commandBase) reached the wrapper and interpreter tables; the
  // destructive, network, state-mutating and git checks still read the exact spelling, so 7
  // of these 8 rendered at 09df009 as reviewed Claude rules: the root was on no list.
  // `Bash(ssh.cmd host *)` was refused already, by the runner table item 2 had reached.
  for (const permission of ['Bash(git.cmd push *)', 'Bash(git.bat reset --hard *)', 'Bash(rm.cmd -rf *)',
    'Bash(curl.bat https://example.invalid *)', 'Bash(ssh.cmd host *)', 'Bash(hostname.bat -s *)',
    'Bash(gh.cmd pr *)', 'PowerShell(remove-item.bat x *)']) {
    // MUTATION: make refusedRoot read the exact spelling only. `Bash(rm.cmd -rf *)` renders and
    // this fails. Confirmed 2026-10-14. `Bash(git.cmd push *)` is refused by prefixIsKnownRisky's
    // git check (commandBase); claudePermissionIsSafe's own git branch keeps the exact spelling,
    // because normalizing it too was measured to be an equivalent mutant and was not kept.
    // MUTATION: restore `root === 'git' || root === 'git.exe'` in prefixIsKnownRisky.
    // `Bash(git.cmd push *)` renders. Confirmed 2026-10-14.
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [], permission);
  }
  // Controls: a read-only git subcommand in that spelling renders as it did (the exporter's
  // allow tables keep the exact spelling, so `cat.cmd` is not trusted as `cat`).
  assert.deepEqual(renderClaudePermissions(['Bash(git.cmd status *)'], { includeReviewed: true }), ['Bash(git.cmd status *)']);
  assert.deepEqual(renderClaudePermissions(['Bash(cat.cmd *)'], { includeReviewed: true }), []);
  assert.deepEqual(renderClaudePermissions(['Bash(cat *)'], { includeReviewed: true }), ['Bash(cat *)']);
  // The automatic Codex path and the validator read the same tables.
  assert.equal((renderCodexRules([candidate(['curl.bat', '--head'])]).match(/prefix_rule\(/g) || []).length, 0);
  for (const pattern of [['curl.bat'], ['git.cmd'], ['Curl.CMD']]) {
    // MUTATION: restore the exact `['curl', 'curl.exe']` list in the validator. `["curl.bat"]`
    // validates and this fails. Confirmed 2026-10-14.
    assert.equal(validateCodexRulesText(manualRule(pattern)).valid, false, JSON.stringify(pattern));
  }
});

test('on the Codex half an env assignment that names or loads a program is refused, as it is on the Claude half', () => {
  // 520103d: "The Codex exporter is unaffected". Not so: env carries its assignments as
  // arguments, and a reviewed prefix can even open with one (J1, BUILD_PROGRAM_BROAD below).
  // Each row rendered at 09df009.
  for (const prefix of [['env', 'GIT_PAGER=x', 'git', 'log'], ['env', 'LD_PRELOAD=./x.so', 'cat'],
    ['env', 'PATH=/tmp', 'ls'], ['env', '-i', 'EDITOR=x', 'git', 'commit'], ['env', 'FOO=1', 'GIT_SSH_COMMAND=x', 'git', 'fetch'],
    ['env', 'NODE_OPTIONS=--require=./x', 'npm', 'test'], ['env', 'DYLD_INSERT_LIBRARIES=x', 'ls'], ['env', '--', 'PAGER=x', 'man'],
    ['xargs', 'env', 'PAGER=x', 'man', 'ls'], ['timeout', '5', 'env', 'BASH_ENV=x', 'make', 'test']]) {
    // MUTATION: delete the assignment check in wrapperIsBroad's env branch. `["env",
    // "GIT_PAGER=x", "git", "log"]` renders and this fails. Confirmed 2026-10-14.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} hands a program over in an assignment`);
  }
  // Controls: an ordinary assignment, an unset, and a named command, as before.
  for (const prefix of [['env', 'FOO=1', 'git', 'log'], ['env', 'LANG=C', 'ls'], ['env', '-u', 'PATH', 'rm'],
    ['env', 'CI=1', 'make', 'test']]) {
    assert.equal(codexRuleCount(prefix), 1, JSON.stringify(prefix));
  }
});

// Invoke-Expression's argument is a whole script (measured; src/policy-exporters.js
// ALWAYS_BROAD_WRAPPERS). Each row's verdict at 0ecf75b is in the commit that added this test.
const IEX_PREFIXES = [['iex', 'Get-Date'], ['IEX', 'Get-Date'], ['iex', '$x'], ['iex', '-Command'],
  ['invoke-expression', 'x'], ['Invoke-Expression', 'Get-ChildItem'], ['Invoke-Expression', '-Command', 'x'],
  ['Microsoft.PowerShell.Utility\\Invoke-Expression', 'x'], ['iex.exe', 'x'], ['iex'], ['Invoke-Expression'],
  ['timeout', '5', 'iex', 'x'], ['xargs', 'invoke-expression']];

test('Invoke-Expression and iex are broad at any depth, in every spelling', () => {
  for (const prefix of IEX_PREFIXES) {
    // MUTATION: drop 'iex' from ALWAYS_BROAD_WRAPPERS. `["iex", "Get-Date"]` falls to the
    // generic rule and renders. Confirmed 2026-10-14. Dropping 'invoke-expression' fails its
    // rows the same way. Confirmed 2026-10-14.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} evaluates code`);
  }
  // The Claude half refused them at any depth already, by membership: pins.
  for (const permission of ['PowerShell(iex *)', 'PowerShell(Invoke-Expression Get-Date *)', 'PowerShell(IEX x *)',
    'Bash(iex x *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [], permission);
  }
  // The learner's verdict agrees: a shell-wrapper risk whatever the case, keyed on the bare root.
  const { classifyInvocation } = require('../src/auto-learn');
  for (const command of ["iex 'Get-Date'", "Invoke-Expression 'Get-Date'", "IEX 'x'"]) {
    const learned = classifyInvocation({ tool: 'PowerShell', command, source: 'claude' });
    assert.ok(learned.reasons.includes('shell-wrapper'), `${command}: ${JSON.stringify(learned.reasons)}`);
    assert.equal(learned.prefix.length, 1, command);
  }
  // Control: a cmdlet whose name merely contains the word is judged as before.
  assert.equal(codexRuleCount(['Invoke-ExpressionLint', 'x']), 1);
});

// Invoke-Command runs a script block, the iex class (measured; src/policy-exporters.js
// ALWAYS_BROAD_WRAPPERS). Each row's verdict at fd05398 is in the commit that added this test.
const ICM_PREFIXES = [['icm'], ['Invoke-Command'], ['ICM', '-ScriptBlock'], ['icm', 'x'],
  ['Invoke-Command', '-FilePath', 'x.ps1'], ['Invoke-Command', '-ComputerName', 'host', '-ScriptBlock'],
  ['Microsoft.PowerShell.Core\\Invoke-Command', 'x'], ['invoke-command.exe', 'x'], ['timeout', '5', 'icm', 'x']];

test('Invoke-Command and icm are broad at any depth, in every spelling', () => {
  for (const prefix of ICM_PREFIXES) {
    // MUTATION: drop 'icm' and 'invoke-command' from ALWAYS_BROAD_WRAPPERS. Their prefixes reach
    // the generic rule and `["icm", "x"]` renders. Confirmed 2026-10-14.
    // MUTATION: drop them from the learner's SHELL_WRAPPERS (src/auto-learn.js). Nothing here
    // asks wrapperIsBroad and bare `["icm"]` renders. Confirmed 2026-10-14.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} runs a script block`);
  }
  for (const permission of ['PowerShell(icm *)', 'PowerShell(Invoke-Command -FilePath x.ps1 *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [], permission);
  }
  const { classifyInvocation } = require('../src/auto-learn');
  // A local form: with `-ComputerName` the learner calls it `network-command` first, rightly.
  for (const command of ['Invoke-Command -ScriptBlock $sb', 'icm -ScriptBlock $sb']) {
    const learned = classifyInvocation({ tool: 'PowerShell', command, source: 'claude' });
    assert.ok(learned.reasons.includes('shell-wrapper'), `${command}: ${JSON.stringify(learned.reasons)}`);
  }
  // Control: a different cmdlet of the same verb is judged as before.
  assert.equal(codexRuleCount(['Invoke-WebLint', 'x']), 1);
});

// make and just overrides that choose the recipe shell or load a program (src/policy-exporters.js
// MAKE and JUST). Each row's verdict at c16728e is in the commit that added this test.
const OVERRIDE_BROAD = [
  ['make', 'SHELL=./x.sh', 'test'], ['make', '.SHELLFLAGS=-ec', 'test'], ['make', 'MAKESHELL=x', 'all'],
  ['make', 'SHELL :=x', 'all'], ['make', 'X!=cmd', 'all'], ['make', 'MAKEFLAGS=--eval=x', 'all'],
  ['make', 'MAKEFILES=x.mk', 'all'], ['make', 'CC=gcc', 'all'], ['make', 'LD_PRELOAD=x', 'all'], ['make', 'PATH=/tmp', 'all'],
  ['make', 'test', 'SHELL=./x.sh'], ['make', 'test', '--eval=x'], ['make', 'test', '-E', 'x'], ['make', '--', 'SHELL=x', 'all'],
  ['just', 'NODE_OPTIONS=x', 'build'], ['just', '--set', 'PATH', '/tmp', 'build'], ['just', '--shell', 'sh', 'build'],
  ['just', '--shell-arg', '-c', 'build'], ['just', '--shell-command', 'build'], ['just', '--dotenv-command', 'x', 'build'],
  ['just', '--clear-shell-args', 'build'],
];
const OVERRIDE_NARROW = [
  ['make', 'CFLAGS=-O2', 'all'], ['make', 'V=1', 'test'], ['make', 'test', 'CFLAGS=-O2'], ['make', 'test', 'all'],
  ['make', '-j4', 'test', '-k'], ['make', 'X:=1', 'all'], ['make', 'X::=1', 'all'], ['make', 'X+=1', 'all'], ['make', 'X?=1', 'all'],
  ['just', 'a=b', 'build'], ['just', '--set', 'a', 'b', 'build'], ['just', 'build', 'SHELL=x'],
];

test('a make or just override that names the recipe shell or a program is broad, a data override is not', () => {
  for (const prefix of OVERRIDE_BROAD) {
    // MUTATION: make MAKE's unsafeVariable return false. `["make", "SHELL=./x.sh", "test"]`
    // renders. Confirmed 2026-10-14.
    // MUTATION: drop `operator.includes('!')`. `["make", "X!=cmd", "all"]` renders. Confirmed
    // 2026-10-14.
    // MUTATION: drop `scanAll: true` from MAKE. `["make", "test", "SHELL=./x.sh"]` and `["make",
    // "test", "--eval=x"]` render: the walk stops at the target. Confirmed 2026-10-14.
    // MUTATION: restore the old `NAME=` pattern for make. `.SHELLFLAGS=-ec` reads as a target
    // and renders. Confirmed 2026-10-14.
    // MUTATION: drop the `--set` check. `["just", "--set", "PATH", "/tmp", "build"]` renders.
    // Confirmed 2026-10-14.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} chooses what runs the recipes`);
  }
  for (const prefix of OVERRIDE_NARROW) {
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} is a data override and still renders`);
  }
  // `just build SHELL=x` passes SHELL=x to the recipe as an argument (just reads overrides only
  // before the first recipe), so it is the recipe's business, as `["just", "build", "x"]` is.
});

// The programs make's own rules run (2026-10-14, F6 of the v1.6.3 confirmation audit;
// src/policy-exporters.js MAKE_PROGRAM_VARIABLES and MAKE_COMMAND_VARIABLE, which cite GNU make's
// default variable table and the GNU Coding Standards). Every row of MAKE_PROGRAM_BROAD rendered
// at 7cbba2b except the three envNameIsUnsafe already refused (CC, CXX, MAKE).
const MAKE_PROGRAM_NAMES = ['AR', 'AS', 'OBJC', 'CO', 'CPP', 'FC', 'F77', 'GET', 'LD', 'LEX', 'LINT', 'M2C', 'PC',
  'YACC', 'MAKEINFO', 'TEX', 'TEXI2DVI', 'WEAVE', 'CWEAVE', 'TANGLE', 'CTANGLE', 'RM', 'BISON', 'FLEX', 'INSTALL',
  'INSTALL_PROGRAM', 'INSTALL_DATA', 'LDCONFIG', 'RANLIB', 'TEXI2PDF'];
const MAKE_PROGRAM_BROAD = [
  ...MAKE_PROGRAM_NAMES.map((name) => ['make', `${name}=./x`, 'all']),
  ['make', 'RM=./x', 'clean'], ['make', 'INSTALL=./x', 'install'], ['make', 'AR :=./x', 'lib'], ['make', 'LD?=./x', 'all'],
  ['make', 'all', 'AR=./x'], ['make', '-k', 'test', 'RM=./x'],
  ['make', 'COMPILE.c=./x', 'all'], ['make', 'LINK.o=./x', 'all'], ['make', 'COMPILE.cc=./x', 'all'],
  ['make', 'PREPROCESS.S=./x', 'all'], ['make', 'LEX.l=./x', 'all'], ['make', 'YACC.y=./x', 'all'],
  ['make', 'LINT.c=./x', 'all'], ['make', 'CHECKOUT,v=./x', 'all'],
];
// Data: the flags variables, the install locations and the usual switches, which must still render.
const MAKE_DATA_NARROW = [
  ['make', 'VERBOSE=1', 'all'], ['make', 'V=1', 'test'], ['make', 'PREFIX=/usr/local', 'install'],
  ['make', 'prefix=/usr/local', 'install'], ['make', 'DESTDIR=/tmp/stage', 'install'], ['make', 'CFLAGS=-O2', 'all'],
  ['make', 'CXXFLAGS=-O2', 'all'], ['make', 'CPPFLAGS=-DX', 'all'], ['make', 'LDFLAGS=-s', 'all'],
  ['make', 'ARFLAGS=rv', 'lib'], ['make', 'LDLIBS=-lm', 'all'], ['make', 'bindir=/opt/bin', 'install'],
  ['make', 'INSTALLDIR=/opt', 'install'], ['make', 'RMDIR=x', 'clean'], ['make', 'COMPILE=x', 'all'],
  ['make', 'install', 'DESTDIR=/tmp/stage'],
  // just: no built-in variable names a program, so an override the environment judgment does
  // not refuse is the justfile's own business (measured; MAKE_PROGRAM_VARIABLES says how).
  // `["just", "AR=x", "build"]` stood here until J1 (2026-10-14): under `set export` a just
  // override is an environment assignment, and the Codex export's environment judgment now
  // holds the build programs, so it is broad (BUILD_PROGRAM_BROAD below).
  ['just', 'PYTHON=python3', 'test'],
];

test('a make override of a program its own rules run is broad, and data overrides still render', () => {
  for (const prefix of MAKE_PROGRAM_BROAD) {
    // MUTATION: drop `MAKE_PROGRAM_VARIABLES.has(name) ||` from MAKE's unsafeVariable (since J1,
    // from codexEnvNameIsUnsafe, which MAKE's unsafeVariable calls). Every program row renders.
    // Confirmed 2026-10-14.
    // MUTATION: drop `MAKE_COMMAND_VARIABLE.test(name) ||` (likewise). The COMPILE.c, LINK.o, ...
    // and CHECKOUT,v rows render. Confirmed 2026-10-14.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} chooses a program make's rules run`);
  }
  for (const prefix of MAKE_DATA_NARROW) {
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} is a data override and still renders`);
  }
  // Case matters to make: `cc` is not the compiler variable, CC is. MUTATION: look the name up
  // upper-cased in MAKE_PROGRAM_VARIABLES. `["make", "cc=x", "all"]` is refused and this fails.
  // Confirmed 2026-10-14.
  assert.equal(codexRuleCount(['make', 'cc=x', 'all']), 1);
  assert.equal(codexRuleCount(['make', 'CC=x', 'all']), 0);
});

// J1 (2026-10-14): the build programs join the Codex export's environment judgment
// (src/policy-exporters.js codexEnvNameIsUnsafe, which cites GNU make's manual and the Cargo
// Book for each name). Measured against 7d08ced: 114 of BUILD_PROGRAM_BROAD's 124 rows
// rendered. The other ten were the two env rows that end at a bare `make`, broad already, and the eight credential-provider rows, which the secret filter refuses
// for the word in their name (candidateContainsSecret); the bare `-e NAME` row is the spelling
// that filter cannot see. Until J1 a prefix that opens with an assignment was judged by no table
// at all, so even `["CC=./x", "make"]`, `["LD_PRELOAD=./x.so", "cat"]` and `["FOO=1", "bash"]`
// rendered.
const CARGO_PROGRAM_ROWS = [
  ['RUSTC', 'build'], ['RUSTC_WRAPPER', 'build'], ['RUSTC_WORKSPACE_WRAPPER', 'build'], ['RUSTDOC', 'doc'],
  ['RUSTFMT', 'fmt'], ['CARGO_BUILD_RUSTC', 'build'], ['CARGO_BUILD_RUSTC_WRAPPER', 'build'],
  ['CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER', 'build'], ['CARGO_BUILD_RUSTDOC', 'doc'],
  ['CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER', 'build'], ['CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUNNER', 'test'],
  ['CARGO_REGISTRY_CREDENTIAL_PROVIDER', 'build'], ['CARGO_REGISTRY_GLOBAL_CREDENTIAL_PROVIDERS', 'build'],
  ['CARGO_REGISTRIES_MY_REGISTRY_CREDENTIAL_PROVIDER', 'build'], ['CARGO_CREDENTIAL_ALIAS_MINE', 'build'],
  ['CARGO_DOC_BROWSER', 'doc'],
];
const BUILD_PROGRAM_BROAD = [
  // The rows the lead named, in the two spellings an assignment can lead a Codex prefix with.
  ['AR=./x', 'make'], ['LD=./x', 'make', 'all'], ['RANLIB=./x', 'make'],
  ['env', 'AR=./x', 'make'], ['env', 'LD=./x', 'make', 'all'], ['env', 'RANLIB=./x', 'make'],
  // Every F6 program name, before a command that renders on its own (so the name is what refuses).
  ...MAKE_PROGRAM_NAMES.flatMap((name) => [[`${name}=./x`, 'make', 'all'], ['env', `${name}=./x`, 'make', 'all']]),
  ['env', 'COMPILE.c=./x', 'make', 'all'], ['env', 'LINK.o=./x', 'make', 'all'],
  ['env', 'MAKEFLAGS=--eval=x', 'make', 'all'], ['env', 'MAKEFILES=x.mk', 'make', 'all'],
  ['MAKEFLAGS=--eval=x', 'make', 'all'], ['RANLIB=./x', 'make', 'lib'], ['FOO=1', 'AR=./x', 'make', 'all'],
  // cargo's program names.
  ...CARGO_PROGRAM_ROWS.flatMap(([name, sub]) => [['env', `${name}=./x`, 'cargo', sub], [`${name}=./x`, 'cargo', sub]]),
  // The other places the Codex export reads an assignment.
  ['docker', 'exec', '-e', 'AR=./x', 'ctr', 'make', 'all'], ['podman', 'run', '-e', 'RANLIB=./x', 'img', 'make', 'lib'],
  ['docker', 'exec', '--env=RUSTC=./x', 'ctr', 'cargo', 'build'], ['docker', 'exec', '-eLD=./x', 'ctr', 'make', 'all'],
  ['docker', 'exec', '-e', 'CARGO_REGISTRY_CREDENTIAL_PROVIDER', 'ctr', 'cargo', 'build'],
  ['just', 'AR=x', 'build'], ['just', '--set', 'LD', './x', 'build'], ['make', 'RUSTC=./x', 'all'],
  ['make', 'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=./x', 'all'], ['timeout', '5', 'env', 'AR=./x', 'make', 'all'],
  // A leading assignment of the classes env was already judged for, now judged in this spelling too.
  ['CC=./x', 'make', 'all'], ['LD_PRELOAD=./x.so', 'cat'], ['GIT_PAGER=x', 'git', 'log'], ['PATH=.', 'cat'],
  ['FOO=1', 'bash'], ['FOO=1', 'sh', '-c'], ['FOO=1', 'env', 'AR=./x', 'make', 'all'], ['FOO=1'], ['FOO=1', 'BAR=2'],
];
// Data, and names nobody reads as a program: these still render.
const BUILD_DATA_NARROW = [
  ['env', 'CFLAGS=-O2', 'make', 'all'], ['env', 'LDFLAGS=-s', 'make', 'all'], ['env', 'ARFLAGS=rv', 'make', 'lib'],
  ['env', 'PREFIX=/usr/local', 'make', 'install'], ['env', 'DESTDIR=/tmp/stage', 'make', 'install'],
  ['env', 'VERBOSE=1', 'make', 'all'], ['env', 'V=1', 'make', 'test'], ['env', 'LDLIBS=-lm', 'make', 'all'],
  ['CFLAGS=-O2', 'make', 'all'], ['LDFLAGS=-s', 'make', 'all'], ['PREFIX=/usr/local', 'make', 'install'],
  ['DESTDIR=/tmp/stage', 'make', 'install'], ['VERBOSE=1', 'make', 'all'], ['FOO=1', 'CFLAGS=-O2', 'make', 'all'],
  ['env', 'RUSTFLAGS=-Copt-level=3', 'cargo', 'build'], ['env', 'CARGO_TARGET_DIR=t', 'cargo', 'build'],
  ['env', 'CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUSTFLAGS=-g', 'cargo', 'build'], ['RUST_LOG=debug', 'cargo', 'test'],
  ['env', 'CARGO_INCREMENTAL=0', 'cargo', 'build'], ['env', 'RUSTC_BOOTSTRAP=1', 'cargo', 'build'],
  ['docker', 'exec', '-e', 'CFLAGS=-O2', 'ctr', 'make', 'all'], ['just', 'PYTHON=python3', 'test'],
  ['make', 'RUSTFLAGS=-g', 'all'], ['FOO=1', 'cat'], ['LANG=C', 'git', 'log'], ['FOO=1', 'make', 'all'],
];

test('J1: a build program named by an assignment makes a Codex prefix broad wherever the export reads one', () => {
  // Precondition: each command renders alone, so a refusal below is the assignment's.
  for (const prefix of [['make', 'all'], ['make', 'lib'], ['cat'], ['git', 'log'], ['cargo', 'build'], ['cargo', 'test'],
    ['cargo', 'doc'], ['cargo', 'fmt'], ['just', 'build']]) {
    assert.equal(codexRuleCount(prefix), 1, `precondition: ${JSON.stringify(prefix)} renders`);
  }
  for (const prefix of BUILD_PROGRAM_BROAD) {
    // MUTATION: revert J1 in src/policy-exporters.js. Every row renders but the ten named above.
    // Confirmed 2026-10-14.
    // MUTATION: drop MAKE_PROGRAM_VARIABLES from codexEnvNameIsUnsafe. The F6-name rows render.
    // MUTATION: drop CARGO_PROGRAM_ENV or CARGO_PROGRAM_ENV_PATTERN. The cargo rows render.
    // MUTATION: delete the leading-assignment block in candidateEligibleForCodex. Every row that
    // opens with an assignment renders.
    // MUTATION: judge env's assignments by assignmentIsUnsafe again. `["env", "AR=./x", "make",
    // "all"]` renders.
    // MUTATION: restore envNameIsUnsafe in envAssignmentIsUnsafe or in JUST's unsafeVariable. The
    // docker and podman rows, or the two just rows, render. All confirmed 2026-10-14.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} names a program a build runs`);
  }
  for (const prefix of BUILD_DATA_NARROW) {
    // MUTATION: add 'CFLAGS' to CARGO_PROGRAM_ENV. The CFLAGS rows fail. Confirmed 2026-10-14.
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} carries data and still renders`);
  }
  // Case-exact, as F6's names are. To make, `ar` is not the archiver variable; a POSIX
  // environment is case-sensitive too. MUTATION: look the name up upper-cased in
  // codexEnvNameIsUnsafe. Every row here is refused and this fails. Confirmed 2026-10-14.
  // (A native Windows program reads its environment case-insensitively, measured with node: that
  // residual is recorded in docs/engineering-record.md, J1, and this pins the decision as made.)
  for (const prefix of [['env', 'ar=./x', 'make', 'all'], ['env', 'Ar=./x', 'make', 'all'], ['ar=./x', 'make', 'all'],
    ['env', 'ranlib=./x', 'make', 'lib'], ['env', 'rustc=./x', 'cargo', 'build'],
    ['env', 'CARGO_TARGET_x86_64_unknown_linux_gnu_LINKER=./x', 'cargo', 'build'], ['just', 'ar=x', 'build']]) {
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} is not the variable the tool reads`);
  }
});

test('J1 is Codex export only: the Claude half keeps G4(b), a reviewed env-led build-program rule still renders', () => {
  // A control, passing before and after J1: G4(b) accepts these because the rule keeps the
  // literal value the user ran. MUTATION: judge claudePermissionIsSafe's leading assignments by
  // codexEnvNameIsUnsafe. Every rule in the first loop is refused and this fails. Confirmed
  // 2026-10-14.
  for (const permission of ['Bash(AR=x cargo build *)', 'Bash(LD=./ld cargo build *)', 'Bash(RANLIB=x cargo build *)',
    'Bash(RUSTC=x cargo build *)', 'Bash(RUSTC_WRAPPER=sccache cargo build *)', 'Bash(MAKEFLAGS=-j4 cargo build *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [permission], permission);
  }
  // PROGRAM_NAMING_ENV itself is unchanged: CC, CXX and MAKE are still refused there.
  for (const permission of ['Bash(CC=x cargo build *)', 'Bash(CXX=x cargo build *)', 'Bash(MAKE=x cargo build *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [], permission);
  }
});

test('J1: the Codex validator judges a pattern that opens with assignments by the command after them', () => {
  // MUTATION: delete the `lead` lines in patternSafetyErrors. `["FOO=1", "curl"]` and the two
  // assignment-only patterns validate, and this fails. Confirmed 2026-10-14.
  for (const pattern of [['FOO=1', 'curl'], ['FOO=1', 'python'], ['FOO=1', 'BAR=2', 'git'], ['FOO=1', 'pwsh'],
    ['FOO=1'], ['FOO=1', 'BAR=2']]) {
    assert.equal(validateCodexRulesText(manualRule(pattern)).valid, false, JSON.stringify(pattern));
  }
  for (const pattern of [['FOO=1', 'cat'], ['FOO=1', 'git', 'status'], ['FOO=1', 'curl', '--version']]) {
    assert.equal(validateCodexRulesText(manualRule(pattern)).valid, true, JSON.stringify(pattern));
  }
});

// bunx is `bun x` and pnpx is `pnpm dlx` (src/policy-exporters.js RUNNER_ALIASES). Each
// row's verdict at e6d227c is in the commit that added this test.
const ALIAS_BROAD = [['bunx'], ['bunx', 'sh'], ['bunx', 'node'], ['bunx', '--bun', 'vite'], ['bunx.exe', 'sh'],
  ['bun', 'x', 'sh'], ['bun', 'x', 'node', '-e', 'x'], ['bun', 'x', 'python', '-c', 'x'], ['pnpx'], ['pnpx', 'sh'],
  ['pnpx', 'node'], ['pnpx.cmd', 'sh'], ['xargs', 'bunx'], ['timeout', '5', 'pnpx', 'sh']];
const ALIAS_NARROW = [['bunx', 'tsc'], ['bunx', 'cowsay', 'hi'], ['bun', 'x', 'tsc'], ['pnpx', 'create-vite'],
  ['pnpx', 'tsc', '--noEmit'], ['timeout', '5', 'bunx', 'tsc']];

test('bunx and pnpx are judged as bun x and pnpm dlx: broad until they name a narrow command', () => {
  for (const prefix of ALIAS_BROAD) {
    // MUTATION: delete the RUNNER_ALIASES lookup in wrapperIsBroad. `["bunx"]` is then a
    // wrapper with no grammar of its own and only `["bunx"]` itself is refused; `["bunx",
    // "sh"]` renders and this fails. Confirmed 2026-10-14.
    // MUTATION: drop `exec: ['x']` from bun's subcommands. Any named target pins `bun x` again,
    // so `["bunx", "sh"]` and `["bun", "x", "sh"]` render. Confirmed 2026-10-14.
    // MUTATION: drop 'bunx' and 'pnpx' from OWN_SHELL_WRAPPERS and from the learner's
    // SHELL_WRAPPERS. candidateEligibleForCodex never asks wrapperIsBroad and `["bunx"]`
    // renders. Confirmed 2026-10-14. Dropping them from OWN_SHELL_WRAPPERS alone survives, by
    // design (the learner union still lists them; measured); from the learner alone, the
    // learner assertion below fails.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} runs any package bin or a broad command`);
  }
  for (const prefix of ALIAS_NARROW) {
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} names a narrow command and still renders`);
  }
  // The Claude half refuses them at any depth by membership, as it refuses bun and pnpm.
  for (const permission of ['Bash(bunx tsc *)', 'Bash(pnpx create-vite *)', 'PowerShell(bunx *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [], permission);
  }
  // The learner calls them runners, as it calls `bun x` and `npx` (src/auto-learn.js SHELL_WRAPPERS).
  const { classifyInvocation } = require('../src/auto-learn');
  for (const command of ['bunx tsc', 'pnpx create-vite']) {
    const learned = classifyInvocation({ tool: 'Bash', command, source: 'claude' });
    assert.ok(learned.reasons.includes('shell-wrapper'), `${command}: ${JSON.stringify(learned.reasons)}`);
    assert.equal((renderCodexRules([learned], { includeReviewed: true }).match(/prefix_rule\(/g) || []).length, 0,
      `${command}: the learner's bare-root prefix is refused`);
  }
});

// The environment a runner hands its command (the lead's decision, 2026-10-14): an assignment
// that loads or names a program is refused inside docker/podman/compose `-e` as it is after
// `env`, and every environment FILE is refused, its contents being unknowable at review time.
// node's and uv's `--env-file` were measured to load code (src/policy-exporters.js). Each row's
// verdict at f23e978 is in the commit that added this test.
const ENV_REFUSED = [
  ['docker', 'exec', '-e', 'LD_PRELOAD=/x.so', 'ctr', 'cat'], ['docker', 'exec', '-eLD_PRELOAD=/x.so', 'ctr', 'cat'],
  ['docker', 'exec', '--env=GIT_PAGER=x', 'ctr', 'git', 'log'], ['docker', 'exec', '--env', 'PATH=/tmp', 'ctr', 'ls'],
  ['docker', 'exec', '-e', 'LD_PRELOAD', 'ctr', 'cat'], ['podman', 'run', '-e', 'BASH_ENV=x', 'img', 'make', 'test'],
  ['nerdctl', 'exec', '-e', 'DYLD_INSERT_LIBRARIES=x', 'ctr', 'ls'],
  ['docker', 'compose', 'exec', '-e', 'NODE_OPTIONS=--require=x', 'web', 'npm', 'test'],
  ['docker', 'compose', 'run', '-e', 'LD_PRELOAD=x', 'web', 'ls'], ['docker-compose', 'exec', '-e', 'EDITOR=x', 'web', 'git', 'commit'],
  ['docker', 'exec', '--env-file', 'x.env', 'ctr', 'cat'], ['docker', 'run', '--env-file=x.env', 'img', 'ls'],
  ['podman', 'run', '--env-file', 'x.env', 'img', 'pytest'], ['uv', 'run', '--env-file', 'x.env', 'pytest'],
  ['uv', 'run', '--env-file=x.env', 'pytest'], ['uvx', '--env-file', 'x.env', 'ruff'], ['uv', 'tool', 'run', '--env-file', 'x', 'ruff'],
  ['node', '--env-file', 'x.env', 'x.js'], ['node', '--env-file=x.env', 'x.js'], ['node', '--env-file-if-exists=x.env', 'x.js'],
  ['deno', 'run', '--env-file', 'x.ts'], ['deno', '--env-file', 'run', 'x.ts'], ['bun', '--env-file', 'x.env', 'x.ts'],
  ['bun', 'run', '--env-file', 'x.env', 'x.ts'], ['just', '--dotenv-path', 'x.env', 'build'], ['just', '-E', 'x.env', 'build'],
  ['just', '--dotenv-filename=x.env', 'build'], ['timeout', '5', 'node', '--env-file', 'x', 'x.js'],
];
const ENV_NARROW = [
  ['docker', 'exec', '-e', 'FOO=bar', 'ctr', 'ls'], ['docker', 'exec', '-eFOO=bar', 'ctr', 'ls'], ['docker', 'exec', '-e', 'FOO', 'ctr', 'ls'],
  ['docker', 'run', '-e', 'CI=1', 'img', 'pytest'], ['docker', 'compose', 'exec', '-e', 'FOO=1', 'web', 'pytest'],
  ['podman', 'exec', '--env=TZ=UTC', 'ctr', 'date'], ['uv', 'run', '--no-env-file', 'pytest'], ['node', 'x.js'],
  ['just', '--no-dotenv', 'build'], ['just', '-f', 'x', 'build'],
];

test('an environment option that names or loads a program, and any environment file, make a runner prefix broad', () => {
  for (const prefix of ENV_REFUSED) {
    // MUTATION: delete the `grammar.env` check in execWrapperInner. `["docker", "exec", "-e",
    // "LD_PRELOAD=/x.so", "ctr", "cat"]` renders. Confirmed 2026-10-14.
    // MUTATION: drop the envFused check. `["docker", "exec", "-eLD_PRELOAD=/x.so", "ctr",
    // "cat"]` renders. Confirmed 2026-10-14.
    // MUTATION: put '--env-file' back into DOCKER_EXEC's values. `["docker", "exec",
    // "--env-file", "x.env", "ctr", "cat"]` renders. Confirmed 2026-10-14.
    // MUTATION: put '--env-file' back into UVX_EXEC's values. The uv rows render. Confirmed
    // 2026-10-14.
    // MUTATION: drop the env-file alternative from node's `broad`. `["node", "--env-file=x.env",
    // "x.js"]` renders (the generic fused form). Confirmed 2026-10-14.
    // MUTATION: put '--dotenv-path' back into JUST's values. `["just", "--dotenv-path", "x.env",
    // "build"]` renders. Confirmed 2026-10-14.
    // The four deno and bun rows were refused already (their top-level and post-subcommand
    // options are not modelled, so `--env-file` was an unknown option): pins.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} lets the environment load or name a program`);
  }
  // Controls: a data-valued assignment, a copied safe name, the opt-out flags, and nothing at all.
  for (const prefix of ENV_NARROW) {
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} is as narrow as its command`);
  }
  // A data-valued assignment does not narrow a broad command either.
  assert.equal(codexRuleCount(['docker', 'exec', '-e', 'FOO=bar', 'ctr', 'sh']), 0);
});

// node options that name a file deciding what loads (src/policy-exporters.js, node's `broad`).
// Each row's verdict at 1d66310 is in the commit that added this test.
const NODE_FILE_BROAD = [
  ['node', '--openssl-config=x.cnf', 'x.js'], ['node', '--openssl-config', 'x.cnf', 'x.js'],
  ['node', '--experimental-config-file=node.config.json', 'x.js'], ['node', '--experimental-config-file', 'c.json', 'x.js'],
  ['node', '--openssl-shared-config', 'x.js'], ['node', '--experimental-default-config-file', 'x.js'],
  ['nodejs', '--openssl-config=x.cnf', 'x.js'], ['uv', 'run', 'node', '--openssl-config=x', 'x.js'],
];
const NODE_FILE_NARROW = [['node', 'x.js'], ['node', '--icu-data-dir', 'icu', 'x.js'], ['node', '--report-dir=r', 'x.js'],
  ['node', '--title', 't', 'x.js']];

test('a node option naming an OpenSSL or node config file is broad, like --env-file', () => {
  for (const prefix of NODE_FILE_BROAD) {
    // MUTATION: drop `openssl-config` from node's `broad`. `["node", "--openssl-config=x.cnf",
    // "x.js"]` matches the generic fused form and renders. Confirmed 2026-10-14.
    // MUTATION: drop `experimental-config-file` from it. `["node",
    // "--experimental-config-file=node.config.json", "x.js"]` renders. Confirmed 2026-10-14.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} names a file that decides what loads`);
  }
  for (const prefix of NODE_FILE_NARROW) {
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} still renders`);
  }
});

// `deno x` is deno's npx, and `dx` its alias (src/policy-exporters.js INTERPRETER_GRAMMAR and
// RUNNER_ALIASES). Each row's verdict at b11038d is in the commit that added this test.
const DENO_X_BROAD = [['deno', 'x'], ['deno', 'x', 'sh'], ['deno', 'x', 'node'], ['deno', 'x', 'python', '-c', 'x'],
  ['deno', 'x', 'timeout', '5', 'sh'], ['deno', 'x', '--preload', 'p.js', 'tsc'], ['deno', 'x', '-c', 'deno.json', 'tsc'],
  ['deno', 'x', '--env-file', 'x', 'tsc'], ['dx'], ['dx', 'sh'], ['dx.exe', 'node'],
  // deno run is unchanged: any option after `run` is broad (pins).
  ['deno', 'run', '-A', 'npm:cowsay'], ['deno', 'run']];
const DENO_X_NARROW = [['deno', 'x', 'tsc'], ['deno', 'x', 'npm:create-vite'], ['deno', 'x', 'jsr:@std/http/file-server'],
  ['dx', 'tsc'], ['deno', 'run', 'x.ts'], ['deno', 'run', 'npm:cowsay'], ['deno', 'test'], ['deno', 'fmt']];

test('deno x and dx are judged by the command they name, and deno run keeps its pinned target', () => {
  for (const prefix of DENO_X_BROAD) {
    // MUTATION: drop `exec: ['x']` from deno's subcommands. Any named target pins `deno x` again
    // and `["deno", "x", "sh"]` renders. Confirmed 2026-10-14.
    // MUTATION: drop the `dx` entry from RUNNER_ALIASES. `["dx", "sh"]` is a wrapper with no
    // grammar of its own and renders. Confirmed 2026-10-14.
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} runs any package bin or a broad command`);
  }
  for (const prefix of DENO_X_NARROW) {
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} names a narrow command and still renders`);
  }
  for (const permission of ['Bash(dx tsc *)', 'Bash(deno x tsc *)']) {
    assert.deepEqual(renderClaudePermissions([permission], { includeReviewed: true }), [], permission);
  }
});
