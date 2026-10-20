'use strict';
// scripts/probe-user-hooks.js reproduces the 2026-10-19 measurement behind README.md's
// "no user hooks at all" reading of allowManagedHooksOnly. It runs real Claude Code turns, so
// these tests never run a real claude: they check its argument handling, the canary settings it
// registers, that it refuses without --run-claude (a stub claude records every call, and none
// may arrive), and how it reads a run, against a stub that answers as a restricted client and
// as an unrestricted one.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'probe-user-hooks.js');
const probe = require(SCRIPT);

const STUB = `'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const args = process.argv.slice(2);
if (process.env.STUB_MARK) fs.appendFileSync(process.env.STUB_MARK, JSON.stringify(args) + '\\n');
const mode = process.env.STUB_MODE || 'restricted';
if (args[0] === '--version') { process.stdout.write('9.9.9 (Claude Code)\\n'); process.exit(0); }
const prompt = args[args.indexOf('-p') + 1];
if (prompt === '/goal x') {
  if (mode === 'open') { process.stdout.write('Goal set: x\\n'); process.exit(0); }
  process.stdout.write("/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is set in settings or by policy)\\n");
  process.exit(1);
}
const at = args.indexOf('--settings');
const file = at >= 0 ? args[at + 1] : path.join(process.cwd(), '.claude', 'settings.local.json');
const hooks = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).hooks || {}) : {};
const fire = (event) => {
  if (mode !== 'open') return;
  for (const group of hooks[event] || []) for (const hook of group.hooks) {
    execSync(hook.command, { input: JSON.stringify({ hook_event_name: event }), stdio: ['pipe', 'ignore', 'inherit'] });
  }
};
fire('UserPromptSubmit');
if (mode !== 'nowrite') {
  fire('PreToolUse');
  fs.writeFileSync(path.join(process.cwd(), 'canary.txt'), 'canary');
  fire('PostToolUse');
}
process.stdout.write('done\\n');
`;

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-probe-hooks-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const stub = path.join(bin, 'claude-stub.js');
  fs.writeFileSync(stub, STUB);
  let claude;
  if (process.platform === 'win32') {
    claude = path.join(bin, 'claude.cmd');
    fs.writeFileSync(claude, `@echo off\r\n"${process.execPath}" "${stub}" %*\r\n`);
  } else {
    claude = path.join(bin, 'claude');
    fs.writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`);
    fs.chmodSync(claude, 0o755);
  }
  const temp = path.join(tmp, 'temp');
  fs.mkdirSync(temp);
  return { tmp, temp, claude, mark: path.join(tmp, 'calls.jsonl') };
}

// The probe as a child process, its base (CLAUDE_CONFIG_DIR, and os.tmpdir() for anything else)
// pointed into the fixture.
function runProbe(f, args, mode) {
  return spawnSync(process.execPath, [SCRIPT, '--claude', f.claude, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 90000, windowsHide: true,
    env: { ...process.env, CLAUDE_CONFIG_DIR: f.temp, TEMP: f.temp, TMP: f.temp, TMPDIR: f.temp, STUB_MODE: mode, STUB_MARK: f.mark },
  });
}

// The default base is per user, never the shared temp directory (on Linux /tmp, where another
// local user could plant the fixed probe directory with a .claude/settings.json).
// MUTATION: default probePaths' base back to os.tmpdir() and this fails.
test('the probe directories default to <config>/wildcarding, never the shared temp directory', () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const config = path.join(os.tmpdir(), 'acolyte-probe-config-witness');
  try {
    process.env.CLAUDE_CONFIG_DIR = config;
    const paths = probe.probePaths();
    assert.ok(paths.cwd.startsWith(path.join(config, 'wildcarding') + path.sep), paths.cwd);
    assert.ok(paths.work.startsWith(path.join(config, 'wildcarding') + path.sep), paths.work);
    delete process.env.CLAUDE_CONFIG_DIR;
    const home = probe.probePaths();
    assert.ok(home.cwd.startsWith(path.join(os.homedir(), '.claude', 'wildcarding') + path.sep), home.cwd);
    assert.ok(!home.cwd.startsWith(os.tmpdir() + path.sep), 'the default must not be the shared temp directory');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

const verdictLines = (stdout) => stdout.split(/\r?\n/).filter((line) => /^(settings-flag|project-local) /.test(line));

test('without --run-claude it prints the plan, runs nothing and exits 2', (t) => {
  const f = fixture(t);
  const run = runProbe(f, [], 'open');
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /refused, nothing was run/);
  assert.match(run.stderr, /--run-claude/);
  assert.match(run.stdout, /8 claude runs, 7 of them a real Claude Code turn/);
  for (const variant of probe.VARIANTS) {
    for (const event of probe.EVENTS) assert.match(run.stdout, new RegExp(`^  ${variant} ${event}: `, 'm'));
  }
  assert.equal(fs.existsSync(f.mark), false, 'the stub claude was called although the probe refused');
  assert.deepEqual(fs.readdirSync(f.temp), [], 'the refusal wrote into the temporary directory');
});

test('arguments: defaults, subsets in canonical order, and every malformed form refused', () => {
  const defaults = probe.parseArgs([]);
  assert.equal(defaults.run, false);
  assert.equal(defaults.claude, 'claude');
  assert.deepEqual(defaults.events, probe.EVENTS);
  assert.deepEqual(defaults.variants, probe.VARIANTS);
  assert.equal(defaults.timeoutMs, 120000);
  const some = probe.parseArgs(['--run-claude', '--events', 'UserPromptSubmit,PreToolUse,PreToolUse',
    '--variants', 'project-local', '--timeout-seconds', '30', '--claude', 'C:/x/claude.exe']);
  assert.equal(some.run, true);
  assert.deepEqual(some.events, ['PreToolUse', 'UserPromptSubmit']);
  assert.deepEqual(some.variants, ['project-local']);
  assert.equal(some.timeoutMs, 30000);
  assert.equal(some.claude, 'C:/x/claude.exe');
  for (const bad of [['--events', 'SessionStart'], ['--events', ','], ['--variants', 'user'], ['--timeout-seconds', '0'],
    ['--timeout-seconds', '1.5'], ['--timeout-seconds', '601'], ['--claude'], ['--claude', '--run-claude'], ['--yes'], ['run']]) {
    assert.throws(() => probe.parseArgs(bad), (error) => error.usage === true, `accepted ${bad.join(' ')}`);
  }
});

test('a bad argument prints the usage line and exits 2', (t) => {
  const f = fixture(t);
  const run = runProbe(f, ['--events', 'Stop'], 'open');
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown Stop/);
  assert.match(run.stderr, /^usage: node scripts\/probe-user-hooks\.js --run-claude/m);
  assert.equal(fs.existsSync(f.mark), false);
});

test('each canary is one log-only command hook on its one event', () => {
  const spec = { node: 'C:\\Program Files\\nodejs\\node.exe', canary: 'C:\\T\\work\\canary.js', log: 'C:\\T\\work\\a.log', platform: 'win32' };
  const command = (event) => `"C:/Program Files/nodejs/node.exe" "C:/T/work/canary.js" ${event} "C:/T/work/a.log"`;
  for (const event of ['PreToolUse', 'PostToolUse']) {
    assert.deepEqual(probe.canarySettings({ ...spec, event }),
      { hooks: { [event]: [{ matcher: '*', hooks: [{ type: 'command', command: command(event), timeout: 10 }] }] } });
  }
  assert.deepEqual(probe.canarySettings({ ...spec, event: 'UserPromptSubmit' }),
    { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: command('UserPromptSubmit'), timeout: 10 }] }] } });
  assert.equal(probe.hookCommand({ event: 'PreToolUse', node: '/usr/bin/node', canary: '/t/canary.js', log: '/t/a.log', platform: 'linux' }),
    '"/usr/bin/node" "/t/canary.js" PreToolUse "/t/a.log"');
  assert.throws(() => probe.canarySettings({ ...spec, event: 'Stop' }), /unknown hook event/);
  for (const log of ['C:\\T\\$HOME.log', 'C:\\T\\a"b.log', 'C:\\T\\a`b.log', `C:\\T\\a${String.fromCharCode(10)}b.log`]) {
    assert.throws(() => probe.canarySettings({ ...spec, event: 'PreToolUse', log }), /a shell would rewrite/, `accepted ${JSON.stringify(log)}`);
  }
  assert.throws(() => probe.hookCommand({ event: 'PreToolUse', node: '/usr/bin/node', canary: '/t/c\\x.js', log: '/t/a.log', platform: 'linux' }),
    /a shell would rewrite/);
});

test('the plan gives each settings-flag run its own --settings file, and the project-local runs none', () => {
  const paths = probe.probePaths(path.join(os.tmpdir(), 'plan-only'));
  const runs = probe.planRuns(probe.parseArgs([]), paths, process.execPath, process.platform);
  assert.deepEqual(runs.map((run) => run.kind), ['version', 'goal', 'hook', 'hook', 'hook', 'hook', 'hook', 'hook']);
  for (const run of runs.filter((r) => r.kind === 'hook')) {
    const at = run.args.indexOf('--settings');
    if (run.variant === 'settings-flag') {
      assert.equal(run.args[at + 1], run.settingsFile);
      assert.equal(path.dirname(run.settingsFile), paths.work, 'a --settings file outside the work directory');
    } else {
      assert.equal(at, -1);
      assert.equal(run.settingsFile, path.join(paths.cwd, '.claude', 'settings.local.json'));
    }
    assert.deepEqual(Object.keys(run.settings.hooks), [run.event]);
  }
});

test('against a restricted stub: /goal reads restricted, every canary silent while the Write lands', (t) => {
  const f = fixture(t);
  const run = runProbe(f, ['--run-claude'], 'restricted');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^claude --version: 9\.9\.9 \(Claude Code\)$/m);
  assert.match(run.stdout, /^\/goal x: restricted\. It said: \/goal can't run while hooks are restricted/m);
  const lines = verdictLines(run.stdout);
  assert.equal(lines.length, 6, run.stdout);
  for (const line of lines) assert.match(line, /: not fired \(Write landed: yes; claude exit 0\)$/);
  const report = JSON.parse(fs.readFileSync(path.join(f.temp, 'wildcarding', 'ai-acolyte-user-hook-probe-work', 'report.json'), 'utf8'));
  assert.equal(report.version, '9.9.9 (Claude Code)');
  assert.equal(report.runs.length, 8);
  assert.equal(fs.readFileSync(f.mark, 'utf8').trim().split('\n').length, 8, 'one stub call per planned run');
});

test('against an unrestricted stub: every canary fires and names the event Claude Code sent', (t) => {
  const f = fixture(t);
  const run = runProbe(f, ['--run-claude'], 'open');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^\/goal x: accepted \(hooks are not restricted\)/m);
  const lines = verdictLines(run.stdout);
  assert.equal(lines.length, 6, run.stdout);
  for (const line of lines) assert.match(line, /: fired \(Write landed: yes/);
  const report = JSON.parse(fs.readFileSync(path.join(f.temp, 'wildcarding', 'ai-acolyte-user-hook-probe-work', 'report.json'), 'utf8'));
  for (const row of report.runs.filter((r) => r.kind === 'hook')) {
    assert.deepEqual(row.fires.map((fire) => [fire.event, fire.hookEventName]), [[row.event, row.event]], row.label);
  }
});

test('a run whose Write did not land calls the tool events inconclusive, not silent', (t) => {
  const f = fixture(t);
  const run = runProbe(f, ['--run-claude', '--variants', 'settings-flag'], 'nowrite');
  assert.equal(run.status, 0, run.stderr);
  const lines = verdictLines(run.stdout);
  assert.deepEqual(lines.map((line) => line.replace(/ \(Write landed.*$/, '')), [
    'settings-flag PreToolUse: inconclusive (the Write did not land, so no tool ran)',
    'settings-flag PostToolUse: inconclusive (the Write did not land, so no tool ran)',
    'settings-flag UserPromptSubmit: not fired',
  ]);
});

test('a turn that failed or never finished is inconclusive for every event', () => {
  for (const event of probe.EVENTS) {
    assert.match(probe.judgeHook({ event, fires: [], writeLanded: true, run: { status: 1 } }), /^inconclusive \(claude exited 1\)$/);
    assert.match(probe.judgeHook({ event, fires: [], writeLanded: true, run: { error: { code: 'ETIMEDOUT' } } }), /^inconclusive .*ETIMEDOUT/);
    assert.equal(probe.judgeHook({ event, fires: [{ event }], writeLanded: false, run: { status: 1 } }), 'fired');
  }
  assert.equal(probe.judgeGoal({ status: 1, stdout: '/goal can\u2019t run while hooks are restricted (x)' }), 'restricted');
  assert.equal(probe.judgeGoal({ status: 1, stdout: 'Invalid API key' }), 'unknown');
});
