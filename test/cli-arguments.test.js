'use strict';

// What each verb does with an argument its parser never reads (1.9.3), through the real CLI
// against a throwaway home. Before, an unknown option beside a verb was ignored (the
// unrecognized-option guard fired only with NO verb), so `--drain --dryrun`, a typo for
// `--dry-run`, ran a REAL drain, and a stray word after `--bypass on`, `--seed` or `--drain` was
// dropped while the verb wrote. Now an option the verb does not take is refused at dispatch, exit
// 2, naming it, and a stray word is refused with the verb's own usage, exit 1, as --gates already
// did; neither runs anything.
//
// Every run starts from a home whose settings.json hook mode would rewrite, whose project
// settings.local.json a drain would promote and prune, and whose CLAUDE.md a guidance or gates
// install would change, and carries a real hook event on stdin, so a verb that ran, or a
// fall-through to hook mode, shows up as a changed file in the home's tree.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.resolve(__dirname, '..', 'bin', 'wildcard-perms');
// Not a fixed point: hook mode collapses the two `rg` entries (test/cli-hook.test.js).
const UNOPTIMIZED = { permissions: { allow: ['Bash(git status)', 'Bash(git diff)', 'Bash(rg foo)', 'Bash(rg bar)'] } };
// Portable, so a real drain promotes it into settings.json and prunes it here.
const LOCAL = { permissions: { allow: ['Bash(npm test)'] } };

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-cli-arguments-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(UNOPTIMIZED, null, 2) + '\n');
  fs.writeFileSync(path.join(home, '.claude', 'settings.local.json'), JSON.stringify(LOCAL, null, 2) + '\n');
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# Mine\n');
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return home;
}

// Every config root the CLI could reach points into the throwaway home, and Python at a file
// that does not exist, so nothing here can touch the developer's own ~/.claude or ~/.codex.
function run(home, args) {
  const root = path.parse(home).root;
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: home, encoding: 'utf8', windowsHide: true, timeout: 60000,
    input: JSON.stringify({ cwd: home, tool_name: 'Bash' }),
    env: {
      ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CODEX_HOME: path.join(home, '.codex'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
      TOOLBOX_PYTHON: path.join(home, 'no-such-python'),
    },
  });
}

// Every file under the home with its bytes, so any write anywhere is seen.
function tree(home) {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else files[path.relative(home, file)] = fs.readFileSync(file, 'base64');
    }
  };
  walk(home);
  return files;
}

const GUIDANCE_USAGE = 'usage: wildcard-perms --guidance on|off|status\n'
  + '       wildcard-perms --guidance derived\n'
  + '       wildcard-perms --guidance accept|decline|reset <id>\n';
const GATES_USAGE = 'usage: wildcard-perms --gates on|off|status|refresh\n'
  + '       wildcard-perms --gates list [--json]\n'
  + '       wildcard-perms --gates retire|restore [--] <memory> [<memory>...]\n';
const LEARN_USAGE = 'usage: wildcard-perms --learn scan|status|apply|undo|hits '
  + '[--mode observe|recommend|auto-safe] [--workspace <path>] [--codex-scope user|off] '
  + '[--threshold <count>] [--codex-executable <path>]\n';
const DRAIN_USAGE = 'usage: wildcard-perms --drain [--workspace <path>] [--dry-run]\n';

// MUTATION: make the dispatch chain's unknown-option branch `argv.length && false && ...` and
// `--drain --dryrun` runs a real drain, exit 0, settings.json and settings.local.json rewritten.
test('an option the verb does not take is refused at dispatch, exit 2, naming it, and nothing runs', (t) => {
  const home = tempHome(t);
  const before = tree(home);
  for (const [args, named, verb] of [
    [['--drain', '--dryrun'], '--dryrun', '--drain'],
    [['--drain', '--dryrun', '--verbose'], '--dryrun --verbose', '--drain'],
    [['--drain', '--workspace', home, '--dry-run', '--force'], '--force', '--drain'],
    [['--seed', '--dry-run'], '--dry-run', '--seed'],
    [['--bypass', 'on', '--force'], '--force', '--bypass'],
    [['--learn', 'apply', '--dry-run'], '--dry-run', '--learn'],
    [['--guidance', 'accept', 'batch-file-edits', '--force'], '--force', '--guidance'],
    [['--guidance', 'derived', '-x'], '-x', '--guidance'],
    [['--guidance', 'on', '--workspace', home], '--workspace', '--guidance'],
    [['--gates', 'list', '--verbose'], '--verbose', '--gates'],
    // gatesList reads `--json` only after `list`, so before the verb it is not an option it takes.
    [['--json', '--gates', 'list'], '--json', '--gates'],
    [['--codex-workspace-rules', 'remove', '--all'], '--all', '--codex-workspace-rules'],
    [['--codex-hook', 'on', '--force'], '--force', '--codex-hook'],
    [['--memory-guard', 'status', '--json'], '--json', '--memory-guard'],
  ]) {
    const bad = run(home, args);
    assert.equal(bad.status, 2, `${args.join(' ')}: ${bad.stdout}${bad.stderr}`);
    assert.ok(bad.stderr.startsWith(`wildcard-perms: unrecognized option ${named} for ${verb}; nothing was run\n\n`),
      `${args.join(' ')}: ${bad.stderr.slice(0, 300)}`);
    assert.match(bad.stderr, /^usage: wildcard-perms --help \| --version$/m, 'followed by the full usage');
    assert.equal(bad.stdout, '', `${args.join(' ')} ran a verb`);
    assert.deepEqual(tree(home), before, `${args.join(' ')} wrote into the home`);
  }

  // The options each verb does define still reach it, wherever its parser reads them.
  const dry = run(home, ['--drain', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^wildcard-perms --drain \(dry run\): would promote 1 to user scope/);
  assert.equal(run(home, ['--workspace', home, '--drain', '--dry-run']).status, 0, '--workspace before the verb');
  assert.deepEqual(tree(home), before, 'a dry run writes nothing');
  for (const args of [
    ['--learn', 'status', '--workspace', home, '--codex-scope', 'off', '--codex-executable', path.join(home, 'no-codex')],
    ['--guidance', 'derived', '--workspace', home],
    ['--codex-workspace-rules', 'status', '--workspace', home],
  ]) {
    const ok = run(home, args);
    assert.equal(ok.status, 0, `${args.join(' ')}: ${ok.stderr}`);
  }
  // `--gates list --json` reaches gatesList, which fails only for want of Python.
  const list = run(home, ['--gates', 'list', '--json']);
  assert.match(list.stderr, /^wildcard-perms --gates list: recall\.py --gates-list failed/, list.stderr);

  // Witness: the first case's verb is a real policy write when it runs.
  const drain = run(home, ['--drain']);
  assert.equal(drain.status, 0, drain.stderr);
  assert.notDeepEqual(tree(home), before, 'precondition: --drain alone writes');
});

// MUTATIONS, one per verb, each FIRES here: drop the stray-word refusal in bypass(), seed(),
// drain(), codexWorkspaceRules(), the derived branch of guidance(), learn(), the list branch of
// gates(), legacyClaudeMax() or legacyCodexMax(), and that verb's case exits 0.
test('a word the verb never reads is refused with its usage, exit 1, and nothing runs', (t) => {
  const home = tempHome(t);
  const before = tree(home);
  const maxOnly = (verb) => `wildcard-perms ${verb}: retired compatibility command accepts only off or status.\n`;
  for (const [args, usage] of [
    [['--bypass', 'on', 'extra'], 'usage: wildcard-perms --bypass on|off|status\n'],
    [['extra', '--bypass', 'on'], 'usage: wildcard-perms --bypass on|off|status\n'],
    [['--seed', 'extra'], 'usage: wildcard-perms --seed\n'],
    [['--drain', 'extra'], DRAIN_USAGE],
    [['--drain', '--workspace', home, 'extra'], DRAIN_USAGE],
    // learnOption reads the first --workspace, so the second one's path was dropped.
    [['--drain', '--workspace', home, '--workspace', 'elsewhere'], DRAIN_USAGE],
    [['--codex-workspace-rules', 'status', 'extra'], 'usage: wildcard-perms --codex-workspace-rules status|remove [--workspace <path>]\n'],
    [['--guidance', 'derived', 'extra'], GUIDANCE_USAGE],
    [['--guidance', 'accept', 'batch-file-edits', 'extra'], GUIDANCE_USAGE],
    [['--guidance', 'decline', '--workspace', home, 'batch-file-edits', 'extra'], GUIDANCE_USAGE],
    [['--guidance', 'reset', 'batch-file-edits', 'extra'], GUIDANCE_USAGE],
    [['--learn', 'status', 'extra'], LEARN_USAGE],
    // `status` after the options is not the subcommand: learn() reads args[at + 1], which here is
    // `--mode`. Before, this set the mode, then printed the usage.
    [['--learn', '--mode', 'observe', 'status'], LEARN_USAGE],
    [['--gates', 'list', 'extra'], GATES_USAGE],
    [['--max', 'status', 'extra'], maxOnly('--max')],
    [['--codex-max', 'status', 'extra'], maxOnly('--codex-max')],
  ]) {
    const bad = run(home, args);
    assert.equal(bad.status, 1, `${args.join(' ')}: ${bad.stdout}${bad.stderr}`);
    assert.equal(bad.stderr, usage, args.join(' '));
    assert.equal(bad.stdout, '', `${args.join(' ')} ran a verb`);
    assert.deepEqual(tree(home), before, `${args.join(' ')} wrote into the home`);
  }

  // The retired pair stay outside the dispatch check (verbOptions says why) and refuse options
  // themselves, a single-dash one included; `on` still says the feature was removed first.
  const noOptions = (verb) => `wildcard-perms ${verb}: the retired compatibility command accepts no options.\n`;
  for (const [args, said] of [
    [['--max', 'off', '--dry-run'], noOptions('--max')],
    [['--codex-max', 'status', '-x'], noOptions('--codex-max')],
    [['--max', 'on', '--dry-run'], 'wildcard-perms --max: this feature was removed; nothing was changed.\n'],
  ]) {
    const bad = run(home, args);
    assert.equal(bad.status, 1, `${args.join(' ')}: ${bad.stdout}${bad.stderr}`);
    assert.equal(bad.stderr, said, args.join(' '));
    assert.deepEqual(tree(home), before, `${args.join(' ')} wrote into the home`);
  }

  // Option values and the guidance id are read, not strays: these reach the verb.
  for (const args of [['--bypass', 'status'], ['--codex-workspace-rules', 'remove', '--workspace', home],
    ['--guidance', 'derived', '--workspace', home], ['--max', 'status'], ['--codex-max', 'status']]) {
    const ok = run(home, args);
    assert.equal(ok.status, 0, `${args.join(' ')}: ${ok.stderr}`);
  }
  const accept = run(home, ['--guidance', 'accept', '--workspace', home, 'batch-file-edits']);
  assert.doesNotMatch(accept.stderr, /^usage:/, `the id after --workspace <path> is read: ${accept.stderr}`);

  // Witness: the first case is a real policy write when it runs without the stray word.
  const on = run(home, ['--bypass', 'on']);
  assert.equal(on.status, 0, on.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).permissions.defaultMode,
    'bypassPermissions', 'precondition: --bypass on alone writes');
});

// 1.9.4. A run with bare words and no verb reached hook mode: `gates status` (the dashes
// forgotten) and `extra` printed "+3 -4 → 3 entries", rewrote settings.json and settings.local.json
// and exited 0, and on a terminal blocked on stdin. Hook mode is an empty argv only.
// MUTATION: put back `&& argv.some((arg) => arg.startsWith('-'))` on the no-verb branch of the
// dispatch chain and `gates status` exits 0 with the home rewritten.
test('bare words with no verb are refused, exit 2, naming them, and hook mode never runs', async (t) => {
  const home = tempHome(t);
  const before = tree(home);
  for (const args of [['gates', 'status'], ['extra'], ['status'], ['learn', 'scan'], ['']]) {
    const bad = run(home, args);
    assert.equal(bad.status, 2, `${JSON.stringify(args)}: ${bad.stdout}${bad.stderr}`);
    assert.ok(bad.stderr.startsWith(`wildcard-perms: unrecognized argument ${args.join(' ')}: no verb given, `
      + 'and hook mode takes no arguments; nothing was run\n\n'), `${JSON.stringify(args)}: ${bad.stderr.slice(0, 300)}`);
    assert.match(bad.stderr, /^usage: wildcard-perms --help \| --version$/m, 'followed by the full usage');
    assert.equal(bad.stdout, '', JSON.stringify(args));
    assert.deepEqual(tree(home), before, `${JSON.stringify(args)} wrote into the home`);
  }
  // A dashed word beside them is still named as the unrecognized option, as before.
  const mixed = run(home, ['gates', '--status']);
  assert.equal(mixed.status, 2, mixed.stderr);
  assert.equal(mixed.stderr.split('\n')[0], 'wildcard-perms: unrecognized option --status');
  // --help and --version still answer beside a bare word.
  assert.match(run(home, ['gates', '--help']).stdout, /^usage: wildcard-perms --help \| --version$/m);
  assert.equal(run(home, ['extra', '--version']).stdout, `${require('../package.json').version}\n`);
  assert.deepEqual(tree(home), before, 'help, version and the mixed refusal wrote nothing');

  // On a terminal nothing closes stdin: the refusal must exit without reading it. The payload is
  // larger than a pipe buffer, so its write completes only if something read it.
  const root = path.parse(home).root;
  const child = spawn(process.execPath, [CLI, 'gates', 'status'], {
    cwd: os.tmpdir(), windowsHide: true,
    env: {
      ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CODEX_HOME: path.join(home, '.codex'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      HOMEDRIVE: root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(root.length - 1),
      TOOLBOX_PYTHON: path.join(home, 'no-such-python'),
    },
  });
  let drained = false;
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify({ cwd: home, tool_name: 'Bash', pad: 'x'.repeat(8 * 1024 * 1024) }),
    (error) => { if (!error) drained = true; });
  let timedOut = false;
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { timedOut = true; child.stdin.destroy(); child.kill('SIGKILL'); }, 10000);
    child.on('close', (exit) => { clearTimeout(timer); resolve(exit); });
  });
  assert.equal(timedOut, false, 'gates status waited on an open stdin, as hook mode does');
  assert.equal(code, 2);
  assert.equal(drained, false, 'stdin was read, so the words reached hook mode');
  assert.deepEqual(tree(home), before, 'and the home is untouched');

  // Witness: an empty argv is hook mode, and with this event it rewrites the policy.
  const hook = run(home, []);
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(hook.stderr, /^wildcard-perms: \+3 -4 → 3 entries$/m);
  assert.notDeepEqual(tree(home), before, 'precondition: hook mode writes');
});

// 1.9.4. learn() saved --mode and --threshold (setMode) before it checked the subcommand, so a
// missing or mistyped one wrote the state and then printed the usage: `--learn sacn --mode
// auto-safe` left Auto Learn in auto-safe, which the Codex Stop hook then scans in.
// MUTATION: make learn()'s subcommand check `if (false)` and `--learn sacn --mode auto-safe`
// writes the state file before the usage.
test('a --learn with a missing or mistyped subcommand prints its usage before --mode or --threshold is saved', (t) => {
  const home = tempHome(t);
  const before = tree(home);
  for (const args of [
    ['--learn', 'sacn', '--mode', 'auto-safe'],
    ['--learn', '--mode', 'auto-safe'],
    ['--learn', '--threshold', '1'],
    ['--learn', 'scan-all', '--threshold', '2', '--mode', 'observe'],
    ['--learn', '--workspace', home, '--mode', 'observe'],
  ]) {
    const bad = run(home, args);
    assert.equal(bad.status, 1, `${args.join(' ')}: ${bad.stdout}${bad.stderr}`);
    assert.equal(bad.stderr, LEARN_USAGE, args.join(' '));
    assert.equal(bad.stdout, '', args.join(' '));
    assert.deepEqual(tree(home), before, `${args.join(' ')} wrote into the home`);
  }

  // Witness: with a subcommand the same options are saved.
  const ok = run(home, ['--learn', 'status', '--mode', 'auto-safe', '--threshold', '2', '--workspace', home,
    '--codex-scope', 'off', '--codex-executable', path.join(home, 'no-codex')]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).mode, 'auto-safe', 'precondition: --learn status --mode saves the mode');
  assert.equal(JSON.parse(ok.stdout).threshold, 2, 'precondition: and the threshold');
  assert.notDeepEqual(tree(home), before, 'precondition: the state file was written');
});
