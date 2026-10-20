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
// hang: never answers, and starts a grandchild in the same directory that holds the output pipes,
// as claude.exe under cmd.exe does. linger: answers and exits 0, leaving a detached grandchild
// running in the directory. Grandchildren's pids go to STUB_MARK.pids and a hanging stub's own to
// STUB_MARK.stubs, so the test can check and clean up.
// escape: never answers, and leaves a process holding the output pipes whose own parent has
// exited, so a tree kill from the top cannot find it (on POSIX nothing would). It runs in the home
// directory: not the probe's, so only the pipes are at stake, and not the fixture's, whose removal
// it held up on Windows after it was killed (measured: EPERM until the test process ended).
// Its pid goes to .pids.
if (mode === 'escape') {
  const inner = "const g = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], "
    + "{ detached: true, stdio: 'inherit', cwd: process.argv[2], windowsHide: true }); "
    + "require('fs').appendFileSync(process.argv[1], g.pid + ' '); process.exit(0);";
  require('child_process').spawn(process.execPath, ['-e', inner, process.env.STUB_MARK + '.pids', require('os').homedir()],
    { stdio: 'inherit', windowsHide: true });
  fs.appendFileSync(process.env.STUB_MARK + '.stubs', process.pid + ' ');
  setInterval(() => {}, 1000);
  return;
}
if (mode === 'hang' || mode === 'linger') {
  const pids = process.env.STUB_MARK + '.pids';
  const linger = mode === 'linger';
  const sleeper = "require('fs').appendFileSync(process.argv[1], process.pid + ' '); setInterval(() => {}, 1000);";
  const grandchild = require('child_process').spawn(process.execPath, ['-e', sleeper, pids],
    { cwd: process.cwd(), stdio: linger ? 'ignore' : 'inherit', detached: linger, windowsHide: true });
  if (linger) {
    grandchild.unref();
    process.stdout.write('done\\n');
    setTimeout(() => process.exit(0), 500);
  } else {
    fs.appendFileSync(process.env.STUB_MARK + '.stubs', process.pid + ' ');
    // The cmd.exe above, for the cleanup only. Never on POSIX, where the parent is the caller.
    if (process.platform === 'win32') fs.appendFileSync(process.env.STUB_MARK + '.parents', process.ppid + ' ');
    setInterval(() => {}, 1000);
  }
  return;
}
const prompt = args[args.indexOf('-p') + 1];
if (prompt === '/goal x') {
  if (mode === 'open') { process.stdout.write('Goal set: x\\n'); process.exit(0); }
  process.stdout.write("/goal can't run while hooks are restricted (disableAllHooks or allowManagedHooksOnly is set in settings or by policy)\\n");
  process.exit(1);
}
// stuck-last: answers as a restricted client, and a hook run (with one variant and one event, the
// last run) also leaves its directory impossible to empty: a detached sleeper standing in it on
// Windows (its pid to .pids, written here: the sleeper's own start can come after the test's
// cleanup has read the file), a subdirectory nobody may write to on POSIX (its path to .held).
if (mode === 'stuck-last') {
  if (process.platform === 'win32') {
    const sleeper = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],
      { cwd: process.cwd(), stdio: 'ignore', detached: true, windowsHide: true });
    fs.appendFileSync(process.env.STUB_MARK + '.pids', sleeper.pid + ' ');
    sleeper.unref();
  } else {
    const held = path.join(process.cwd(), 'held');
    fs.mkdirSync(held);
    fs.writeFileSync(path.join(held, 'file'), 'x');
    fs.chmodSync(held, 0o555);
    fs.appendFileSync(process.env.STUB_MARK + '.held', held + '\\n');
  }
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

// The pids a hang or linger stub recorded, and whether each is still running.
const recordedPids = (f, suffix = 'pids') => (fs.existsSync(`${f.mark}.${suffix}`)
  ? fs.readFileSync(`${f.mark}.${suffix}`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number) : []);
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

function fixture(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-probe-hooks-'));
  const mark = path.join(tmp, 'calls.jsonl');
  t.after(async () => {
    // Anything a stub left running holds its directory on Windows, so it goes first, and the
    // directory only once it is gone: a kill returns before the process has let go.
    const pids = ['pids', 'stubs', 'parents'].flatMap((suffix) => recordedPids({ mark }, suffix));
    for (const pid of pids) try { process.kill(pid); } catch { /* already gone */ }
    for (const until = Date.now() + 10000; pids.some(alive) && Date.now() < until;) await new Promise((r) => setTimeout(r, 50));
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
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
  return { tmp, temp, claude, mark };
}

// The probe as a child process, its base (AI_ACOLYTE_PROBE_BASE, and os.tmpdir() for anything
// else) pointed into the fixture.
function runProbe(f, args, mode, extraEnv = {}, timeout = 90000) {
  return spawnSync(process.execPath, [SCRIPT, '--claude', f.claude, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout, windowsHide: true,
    env: { ...process.env, AI_ACOLYTE_PROBE_BASE: f.temp, TEMP: f.temp, TMP: f.temp, TMPDIR: f.temp, STUB_MODE: mode, STUB_MARK: f.mark, ...extraEnv },
  });
}
const reportPath = (f) => path.join(f.temp, 'ai-acolyte-user-hook-probe-work', 'report.json');

// The default base is per user, never the shared temp directory (on Linux /tmp, where another
// local user could plant the fixed probe directory with a .claude/settings.json), and has no
// `.claude` segment: Claude Code asks before editing inside one, and `-p` cannot answer, so the
// Write the tool events need would not land.
// MUTATION: default the base back to <CLAUDE_CONFIG_DIR or ~/.claude>/wildcarding and this fails;
// back to os.tmpdir() and it fails too.
test('the probe directories default to a per-user state directory with no .claude segment', () => {
  const winHome = 'C:\\Users\\u';
  assert.equal(probe.defaultProbeBase({ LOCALAPPDATA: 'D:\\Local' }, 'win32', winHome), 'D:\\Local\\ai-acolyte');
  assert.equal(probe.defaultProbeBase({}, 'win32', winHome), 'C:\\Users\\u\\AppData\\Local\\ai-acolyte');
  assert.equal(probe.defaultProbeBase({ LOCALAPPDATA: 'Local' }, 'win32', winHome), 'C:\\Users\\u\\AppData\\Local\\ai-acolyte',
    'a relative LOCALAPPDATA is not a base');
  assert.equal(probe.defaultProbeBase({ XDG_STATE_HOME: '/s/state' }, 'linux', '/home/u'), '/s/state/ai-acolyte');
  assert.equal(probe.defaultProbeBase({}, 'linux', '/home/u'), '/home/u/.local/state/ai-acolyte');
  assert.equal(probe.defaultProbeBase({ XDG_STATE_HOME: 'state' }, 'darwin', '/Users/u'), '/Users/u/.local/state/ai-acolyte',
    'a relative XDG_STATE_HOME is ignored, as the XDG spec says');
  const override = path.join(os.tmpdir(), 'acolyte-probe-base-witness');
  for (const platform of ['win32', 'linux']) {
    assert.equal(probe.defaultProbeBase({ AI_ACOLYTE_PROBE_BASE: override, LOCALAPPDATA: 'D:\\Local', XDG_STATE_HOME: '/s' }, platform, '/h'), override);
  }
  const saved = process.env.AI_ACOLYTE_PROBE_BASE;
  try {
    delete process.env.AI_ACOLYTE_PROBE_BASE;
    const paths = probe.probePaths();
    for (const dir of [paths.cwd, paths.work]) {
      assert.equal(dir.split(/[\\/]/).includes('.claude'), false, `a .claude segment in ${dir}`);
      assert.ok(!dir.startsWith(os.tmpdir() + path.sep), `${dir} is in the shared temp directory`);
      assert.ok(dir.startsWith(probe.defaultProbeBase() + path.sep), dir);
    }
  } finally {
    if (saved === undefined) delete process.env.AI_ACOLYTE_PROBE_BASE; else process.env.AI_ACOLYTE_PROBE_BASE = saved;
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
  const report = JSON.parse(fs.readFileSync(reportPath(f), 'utf8'));
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
  const report = JSON.parse(fs.readFileSync(reportPath(f), 'utf8'));
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

// A claude that never answers is ended with everything under it. The fixture's claude.cmd runs
// the stub under cmd.exe, the shape of Claude Code's own npm shim, and the stub's grandchild sits
// in the probe directory holding the pipes, as claude.exe does. spawnSync's timeout ended cmd.exe
// alone, so the next run could not empty the directory and the probe died. On POSIX the deadline
// ends the child alone (no process group), so 'close' never comes and the grace settles the run.
// MUTATION: put the spawnSync runClaude back, or skip the endProcessTree call, and this fails.
test('a claude that never answers is ended with its tree, and every later run still runs', (t) => {
  const f = fixture(t);
  const run = runProbe(f, ['--run-claude', '--variants', 'settings-flag', '--events', 'UserPromptSubmit', '--timeout-seconds', '1'], 'hang');
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /^\/goal x: unknown \(claude did not finish: ETIMEDOUT\)/m);
  assert.deepEqual(verdictLines(run.stdout), ['settings-flag UserPromptSubmit: inconclusive (claude did not finish: ETIMEDOUT) (Write landed: no; claude exit null)']);
  const stubs = recordedPids(f, 'stubs');
  const grandchildren = recordedPids(f);
  assert.equal(stubs.length, 2, `expected one stub per hanging run, got ${stubs.join(' ')}`);
  assert.equal(grandchildren.length, 2, `expected one grandchild per hanging run, got ${grandchildren.join(' ')}`);
  assert.deepEqual(stubs.filter(alive), [], 'a timed-out claude is still running');
  if (process.platform === 'win32') {
    assert.deepEqual(grandchildren.filter(alive), [], 'a process under the timed-out claude.cmd is still running');
  }
});

// The grace: a run whose 'close' never comes (a process the kill did not reach still holds a
// pipe) settles anyway. The tree kill is replaced by one that does nothing, so the stub and its
// grandchild live on, as such a process would.
// MUTATION: drop the grace timer and the run never settles (the test times out).
test('a run whose close never comes still settles, as timed out, after the deadline and the grace', { timeout: 30000 }, async (t) => {
  const f = fixture(t);
  const cwd = path.join(f.tmp, 'cwd');
  fs.mkdirSync(cwd);
  const saved = { STUB_MODE: process.env.STUB_MODE, STUB_MARK: process.env.STUB_MARK };
  Object.assign(process.env, { STUB_MODE: 'hang', STUB_MARK: f.mark });
  let result;
  const started = Date.now();
  try {
    result = await probe.runClaude({ claude: f.claude, timeoutMs: 500 }, ['-p', 'x'], cwd, async () => {});
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.equal(result.error && result.error.code, 'ETIMEDOUT', JSON.stringify(result));
  assert.equal(result.status, null);
  assert.ok(Date.now() - started >= 500, 'settled before the deadline');
  assert.ok(recordedPids(f, 'stubs').some(alive), 'the stand-in tree kill ended the stub, so this did not test the grace');
});

// A run that settles on 'close' while its tree kill is still running arms no grace. The kill here
// is a stand-in that ends the child and returns only after its 'close', the order the real
// taskkill /T usually gives on Windows. The grace used to be armed when the kill returned, after
// settle had cleared a handle that was still null, so nothing cleared it and the probe's process
// lived on for KILL_GRACE_MS after its last run (audit of 1.9.2: 6 of 6 with a .cmd shim). In a
// driver process, whose loop must be empty once the run has settled; the stand-in claude stands
// in the temp directory itself, which nothing here removes.
// MUTATION: arm the grace without asking `settled` and the driver is still running 1 s after the
// run settled.
test('a run that closes while its tree kill is still running leaves no timer behind', () => {
  const driver = [
    `const probe = require(${JSON.stringify(SCRIPT)});`,
    'let ended = false;',
    "const end = (child) => new Promise((resolve) => { child.once('close', () => setImmediate(() => { ended = true; resolve(); })); child.kill(); });",
    `probe.runClaude({ claude: process.execPath, timeoutMs: 300 }, ['-e', 'setInterval(() => {}, 1000)'], ${JSON.stringify(os.tmpdir())}, end)`,
    '  .then((result) => {',
    "    process.stdout.write(JSON.stringify({ code: result.error && result.error.code, endedBeforeSettle: ended }) + '\\n');",
    "    setTimeout(() => { process.stdout.write('STILL RUNNING\\n'); process.exit(9); }, 1000).unref();",
    '  });',
  ].join('\n');
  const run = spawnSync(process.execPath, ['-e', driver], { cwd: ROOT, encoding: 'utf8', timeout: 20000, windowsHide: true });
  const answer = JSON.parse(run.stdout.split(/\r?\n/)[0] || 'null');
  assert.equal(answer && answer.code, 'ETIMEDOUT', `${run.stdout}\n${run.stderr}`);
  assert.equal(answer.endedBeforeSettle, false, 'WITNESS: the run settled before the stand-in kill returned');
  assert.doesNotMatch(run.stdout, /STILL RUNNING/, 'a timer armed after the run settled kept the probe alive');
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
});

// Settling is not finishing: a survivor's pipes kept the probe's own loop alive, so it printed
// its report and never exited. On Ubuntu that is every timed-out run with a grandchild.
// MUTATION: settle on the grace without letting go of the pipes and the probe never exits.
test('a process the tree kill cannot reach does not keep the probe from finishing', (t) => {
  const f = fixture(t);
  const run = runProbe(f, ['--run-claude', '--variants', 'settings-flag', '--events', 'UserPromptSubmit', '--timeout-seconds', '1'],
    'escape', {}, 30000);
  assert.notEqual(run.signal, 'SIGTERM', 'the probe was still running at 30 s');
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /^\/goal x: unknown \(claude did not finish: ETIMEDOUT\)/m);
  assert.match(run.stdout, /^settings-flag UserPromptSubmit: inconclusive \(claude did not finish: ETIMEDOUT\)/m);
  assert.match(run.stdout, /^report: /m);
  const survivors = recordedPids(f);
  assert.equal(survivors.length, 2, `expected one survivor per run, got ${survivors.join(' ')}`);
  assert.ok(survivors.every(alive), 'a survivor was ended after all, so this did not reach the grace');
});

// A directory the probe cannot empty is a message and exit 3, not an uncaught throw. Two ways in:
// a base that is a file (every platform), and on Windows a process left running in the probe
// directory by a claude that exited, which is what made rmSync fail before.
// MUTATION: drop execute()'s catch, or freshDirectory's, and these fail.
test('a probe directory that cannot be emptied stops the probe with exit 3 and names it', (t) => {
  const f = fixture(t);
  const file = path.join(f.tmp, 'not-a-directory');
  fs.writeFileSync(file, 'x');
  const run = runProbe(f, ['--run-claude'], 'open', { AI_ACOLYTE_PROBE_BASE: file });
  assert.equal(run.status, 3, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stderr, /^probe-user-hooks: could not empty and recreate .*ai-acolyte-user-hook-probe-work \(\w+\)\. A process may still be running in it/m);
  assert.doesNotMatch(run.stderr, /^\s+at /m, 'a stack trace');
  assert.equal(fs.existsSync(f.mark), false, 'claude ran although the work directory failed');
});

test('a process left running in the probe directory stops the next run with exit 3', { skip: process.platform !== 'win32' && 'POSIX removes a directory a process is in' }, (t) => {
  const f = fixture(t);
  const run = runProbe(f, ['--run-claude', '--variants', 'settings-flag', '--events', 'UserPromptSubmit'], 'linger');
  assert.equal(run.status, 3, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /^claude --version: 9\.9\.9/m);
  assert.match(run.stderr, /^probe-user-hooks: could not empty and recreate .*ai-acolyte-user-hook-probe \((EBUSY|EPERM|ENOTEMPTY)\)/m);
  assert.doesNotMatch(run.stderr, /^\s+at /m, 'a stack trace');
  const report = JSON.parse(fs.readFileSync(reportPath(f), 'utf8'));
  assert.match(report.stopped, /could not empty and recreate/);
  assert.equal(report.runs.length, 2, 'the version and goal rows, then the stop');
});

// A directory that cannot be emptied AFTER the last run is a warning: every run completed and its
// verdict is printed, so the exit stays 0 and the report is still written and named. It used to
// be the same stop as a failure before a run: exit 3, "Stopping." and no "report:" line, while
// the header said 0 meant every run completed (audit of 1.9.2).
// MUTATION: call the closing freshDirectory bare again and the probe exits 3 with no report line.
test('a probe directory that cannot be emptied after the last run is a warning, and the report is still named', {
  skip: typeof process.getuid === 'function' && process.getuid() === 0 && 'root may write where the stub forbids it',
}, (t) => {
  const f = fixture(t);
  try {
    const run = runProbe(f, ['--run-claude', '--variants', 'settings-flag', '--events', 'UserPromptSubmit'], 'stuck-last');
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /^\/goal x: restricted\./m);
    assert.deepEqual(verdictLines(run.stdout), ['settings-flag UserPromptSubmit: not fired (Write landed: yes; claude exit 0)']);
    assert.match(run.stderr,
      /^probe-user-hooks: warning: every run completed, but could not empty and recreate .*ai-acolyte-user-hook-probe \((EBUSY|EPERM|ENOTEMPTY|EACCES)\)\. A process may still be running in it/m);
    assert.doesNotMatch(run.stderr, /Stopping/);
    assert.doesNotMatch(run.stderr, /^\s+at /m, 'a stack trace');
    assert.match(run.stdout, /^report: .*report\.json$/m);
    const report = JSON.parse(fs.readFileSync(reportPath(f), 'utf8'));
    assert.equal(report.runs.length, 3, 'the version, goal and hook rows');
    assert.match(report.cleanup, /could not empty and recreate/);
    assert.equal(report.stopped, undefined);
  } finally {
    // POSIX: the subdirectory the stub locked, opened again so the fixture can be removed.
    const held = `${f.mark}.held`;
    if (fs.existsSync(held)) for (const dir of fs.readFileSync(held, 'utf8').split('\n').filter(Boolean)) fs.chmodSync(dir, 0o755);
  }
});
