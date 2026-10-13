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
    // Control: refusal is of the BARE runner only, the same treatment `sh` gets. A
    // reviewer who narrowed the prefix still gets it, so this is not a blanket ban.
    // MUTATION: make wrapperIsBroad return true for every wrapper; this assertion fails.
    const narrow = renderCodexRules([{ prefix: [root, 'build'] }], { includeReviewed: true });
    assert.ok(compact(narrow).includes('pattern = ' + JSON.stringify([root, 'build'])), narrow);
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
  for (const [root, command] of [
    ['node', 'node build.js'], ['npx', 'npx tsc --noEmit'], ['uvx', 'uvx ruff check .'],
    ['xargs', 'xargs rm'], ['parallel', 'parallel gzip ::: a b'], ['env', 'env FOO=1 make'],
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
    assert.equal(codexRuleCount(prefix), 0, `${JSON.stringify(prefix)} runs whatever code it is handed`);
  }
  // Controls: the same interpreters, narrowed to something that is not program text.
  for (const prefix of [['python', '--version'], ['node', '--version'], ['python', 'script.py'],
    ['python', '-m', 'pytest'], ['node', 'build.js'], ['deno', 'run', 'x.ts'], ['bun', 'run', 'x'],
    ['ruby', 'x.rb'], ['perl', 'x.pl'], ['php', 'x.php'], ['npx', 'tsc'], ['uvx', 'ruff']]) {
    assert.equal(codexRuleCount(prefix), 1, `${JSON.stringify(prefix)} is a narrower prefix and still renders`);
  }
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
