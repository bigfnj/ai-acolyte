'use strict';
// DO USER HOOKS RUN UNDER THIS MACHINE'S POLICY? A reproducer (written 2026-10-20).
//
//   usage: node scripts/probe-user-hooks.js --run-claude [--claude <path>]
//            [--events PreToolUse,PostToolUse,UserPromptSubmit]
//            [--variants settings-flag,project-local] [--timeout-seconds 120]
//
// Without --run-claude it prints every command it would run and the canary settings each one
// gets, then exits 2 having run nothing. With it, it runs the installed Claude Code:
//   1. `claude --version` (no model turn), for the record;
//   2. `claude -p "/goal x"` once. `/goal` needs hooks, and a client whose hooks are restricted
//      refuses it with "/goal can't run while hooks are restricted (disableAllHooks or
//      allowManagedHooksOnly is set in settings or by policy)". That refusal is what names the
//      policy; src/memory-guard-install.js's `--memory-guard probe` asks the same question;
//   3. for each variant and each event, `claude -p` once in a freshly emptied temporary
//      directory, asked to make one Write there, with ONE log-only canary command hook
//      registered for that event:
//        settings-flag   in a settings file passed with `--settings`;
//        project-local   in that directory's `.claude/settings.local.json`.
//      Each run reports whether its canary fired and whether the Write landed.
//
// WHY IT EXISTS. README.md ("Design principle: watch the cause, do not hook the event") and
// docs/claude-code-permissions.md say that where a managed policy sets `allowManagedHooksOnly`,
// no user hook ran on the three events tried (PreToolUse, PostToolUse, UserPromptSubmit),
// measured on 2026-10-19 with Claude Code 2.1.293 and 2.1.301. Those runs were made by hand and
// left no artefact, which is how the per-event reading they replaced had gone unchallenged.
// This script repeats them. It was run once against a real client, on 2026-10-20 with its
// directories under os.tmpdir(): 6 of 6 canaries did not fire, and the Write landed. Its
// directories have moved twice since (see defaultProbeBase), and that run has not been repeated
// from where they are now. test/probe-user-hooks.test.js runs it against a stub claude.
//
// WHAT IT DOES NOT COVER. A hook in ~/.claude/settings.json: registering one would edit the
// user's real settings, so the "user" case of the 2026-10-19 runs is not reproduced here. No
// event but the three. And no `if` field, matcher subtlety or async hook.
//
// READING THE RESULT. A canary that fired is a hook that ran. One that did not is evidence
// only when its event had a chance: PreToolUse and PostToolUse need a tool call, so a run whose
// Write did not land reports them `inconclusive`. Even then, a silent canary cannot tell the
// policy from anything else that keeps a hook from running (an untrusted project folder, a
// shell that cannot start node); the /goal answer is what names the policy. On a machine with
// no such policy every canary should fire, which is the control that gives "not fired" its
// meaning.
//
// COST AND TRACES. Each `claude -p` is one real Claude Code turn on the account claude is
// signed in with: 1 + 3 x 2 = 7 by default. Each run writes a transcript under
// ~/.claude/projects/<slug of the directory it ran in>, so every run uses ONE fixed directory
// name, emptied and recreated, and the transcripts land in one project folder (the reason
// src/memory-guard-install.js gives for its fixed probe directory). The canary logs, the
// settings files and report.json stay in a second fixed directory, printed at the end.
// Nothing outside those two directories is written by this script.
//
// Exit codes: 0 every run completed (whatever it found); 1 claude could not be started;
// 2 refused (no --run-claude) or a usage error; 3 a probe directory could not be emptied (a
// process still running in it, on Windows), named in the message.

const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const VARIANTS = ['settings-flag', 'project-local'];
const OPT_IN = '--run-claude';
const PROBE_DIR_NAME = 'ai-acolyte-user-hook-probe';
const WORK_DIR_NAME = 'ai-acolyte-user-hook-probe-work';
const WRITE_FILE = 'canary.txt';
const WRITE_PROMPT = `Use the Write tool to create the file ${WRITE_FILE} in the current directory, `
  + 'containing the single word canary. Do nothing else.';
const GOAL_PROMPT = '/goal x';
// The apostrophe is matched by `.`, since Claude Code may print a straight or a curly one.
const RESTRICTED_TEXT = /can.t run while hooks are restricted/i;
const HOOK_TIMEOUT_SECONDS = 10;
const DEFAULT_TIMEOUT_SECONDS = 120;
const USAGE = 'usage: node scripts/probe-user-hooks.js --run-claude [--claude <path>] '
  + '[--events PreToolUse,PostToolUse,UserPromptSubmit] [--variants settings-flag,project-local] '
  + `[--timeout-seconds ${DEFAULT_TIMEOUT_SECONDS}]`;

const usageError = (message) => Object.assign(new Error(message), { usage: true });

function parseArgs(argv) {
  const options = {
    run: false, help: false, claude: 'claude', events: [...EVENTS], variants: [...VARIANTS],
    timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
  };
  const list = (value, allowed, flag) => {
    const items = value.split(',').map((item) => item.trim()).filter(Boolean);
    if (!items.length) throw usageError(`${flag} needs at least one of ${allowed.join(', ')}`);
    const unknown = items.filter((item) => !allowed.includes(item));
    if (unknown.length) throw usageError(`${flag}: unknown ${unknown.join(', ')}; expected ${allowed.join(', ')}`);
    return allowed.filter((item) => items.includes(item));   // canonical order, no repeats
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === OPT_IN) { options.run = true; continue; }
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!['--claude', '--events', '--variants', '--timeout-seconds'].includes(arg)) {
      throw usageError(`unknown argument: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw usageError(`${arg} needs a value`);
    i += 1;
    if (arg === '--claude') options.claude = value;
    else if (arg === '--events') options.events = list(value, EVENTS, arg);
    else if (arg === '--variants') options.variants = list(value, VARIANTS, arg);
    else {
      const seconds = Number(value);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) {
        throw usageError(`--timeout-seconds must be a whole number from 1 to 600, not ${value}`);
      }
      options.timeoutMs = seconds * 1000;
    }
  }
  return options;
}

// Claude Code runs a hook command through a shell (sh, or Git Bash on Windows). Inside double
// quotes that shell still expands `$` and backticks, and a quote ends the argument, so a path
// carrying one is refused rather than escaped (as src/claude-hook-config.js does). Forward
// slashes on Windows, the spelling the MEMORY.md guard registers.
function shellPath(file, label, platform) {
  const value = platform === 'win32' ? file.replace(/\\/g, '/') : file;
  const control = [...value].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
  if (control || /["`$]/.test(value) || (platform !== 'win32' && value.includes('\\'))) {
    throw new Error(`the ${label} path contains a character a shell would rewrite: ${value}`);
  }
  return value;
}

function hookCommand({ event, node, canary, log, platform = process.platform }) {
  if (!EVENTS.includes(event)) throw new Error(`unknown hook event: ${event}`);
  return `"${shellPath(node, 'node', platform)}" "${shellPath(canary, 'canary', platform)}" ${event} `
    + `"${shellPath(log, 'log', platform)}"`;
}

// The settings one run gets: one event, one group, one log-only command hook. The tool events
// match every tool; UserPromptSubmit takes no matcher. Never `async`.
function canarySettings(spec) {
  const group = { hooks: [{ type: 'command', command: hookCommand(spec), timeout: HOOK_TIMEOUT_SECONDS }] };
  return { hooks: { [spec.event]: [TOOL_EVENTS.has(spec.event) ? { matcher: '*', ...group } : group] } };
}

// The canary itself, written into the work directory as canary.js. It appends one line naming
// the event it was registered for and the hook_event_name Claude Code sent, prints nothing and
// exits 0, so it cannot change the turn it observes. Not called in this process.
function canaryMain() {
  const fs = require('fs');
  const [event, log] = process.argv.slice(2);
  let input = '';
  let written = false;
  const record = () => {
    if (written) return;
    written = true;
    let named = null;
    try { named = JSON.parse(input).hook_event_name || null; } catch { /* no payload: still a run */ }
    fs.appendFileSync(log, JSON.stringify({ event, hookEventName: named, at: new Date().toISOString() }) + '\n');
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', record);
  process.stdin.on('error', record);
  setTimeout(() => { record(); process.exit(0); }, 3000).unref();
}
const CANARY_SOURCE = `'use strict';\n// Written by scripts/probe-user-hooks.js.\n(${canaryMain.toString()})();\n`;

// A per-user base, never the shared temp directory: on Linux os.tmpdir() is /tmp, where another
// local user could pre-create these fixed directories with a planted .claude/settings.json or
// CLAUDE.md that `claude -p` would then load as this user. The guard's own probe moved off
// os.tmpdir() for the same reason in 1.9.1 (src/memory-guard-install.js).
//
// AND NO `.claude` SEGMENT (2026-10-20). The first per-user base was <config>/wildcarding, the
// guard probe's. Claude Code asks before it edits a path inside a `.claude` directory (skills,
// agents, commands and worktrees aside; an audit's reading of the client, not measured here),
// and `-p --permission-mode acceptEdits --allowedTools Write` cannot answer that ask, so the
// Write the tool-event cases depend on very likely stopped landing there and PreToolUse and
// PostToolUse read "inconclusive". The guard's probe allows no tool at all, so the same base
// costs it nothing. Here the base is the platform's per-user state directory:
// %LOCALAPPDATA%\ai-acolyte on Windows, $XDG_STATE_HOME/ai-acolyte or ~/.local/state/ai-acolyte
// elsewhere. AI_ACOLYTE_PROBE_BASE overrides it (the tests use it).
const BASE_ENV = 'AI_ACOLYTE_PROBE_BASE';
function defaultProbeBase(env = process.env, platform = process.platform, home = os.homedir()) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const absolute = (value) => (value && paths.isAbsolute(value) ? value : null);
  if (env[BASE_ENV]) return path.resolve(env[BASE_ENV]);
  if (platform === 'win32') return paths.join(absolute(env.LOCALAPPDATA) || paths.join(home, 'AppData', 'Local'), 'ai-acolyte');
  return paths.join(absolute(env.XDG_STATE_HOME) || paths.join(home, '.local', 'state'), 'ai-acolyte');
}

function probePaths(base = defaultProbeBase()) {
  const work = path.join(base, WORK_DIR_NAME);
  return { cwd: path.join(base, PROBE_DIR_NAME), work, canary: path.join(work, 'canary.js'), report: path.join(work, 'report.json') };
}

function planRuns(options, paths, node = process.execPath, platform = process.platform) {
  const runs = [
    { kind: 'version', label: 'claude --version', args: ['--version'] },
    { kind: 'goal', label: GOAL_PROMPT, args: ['-p', GOAL_PROMPT] },
  ];
  for (const variant of options.variants) {
    for (const event of options.events) {
      const log = path.join(paths.work, `${variant}-${event}.log`);
      const settings = canarySettings({ event, node, canary: paths.canary, log, platform });
      const settingsFile = variant === 'settings-flag'
        ? path.join(paths.work, `settings-${event}.json`)
        : path.join(paths.cwd, '.claude', 'settings.local.json');
      const args = ['-p', WRITE_PROMPT, '--permission-mode', 'acceptEdits', '--allowedTools', 'Write',
        ...(variant === 'settings-flag' ? ['--settings', settingsFile] : [])];
      runs.push({ kind: 'hook', label: `${variant} ${event}`, variant, event, log, settings, settingsFile, args });
    }
  }
  return runs;
}

const quoted = (arg) => (/^[\w./:=,-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`);
const commandLine = (claude, args) => [claude, ...args].map(quoted).join(' ');

function describePlan(runs, options, paths) {
  const turns = runs.filter((run) => run.kind !== 'version').length;
  const lines = [
    `probe-user-hooks: ${runs.length} claude runs, ${turns} of them a real Claude Code turn.`,
    `  every run starts in ${paths.cwd}, emptied and recreated first;`,
    `  canary logs, settings files and the report go to ${paths.work}.`,
  ];
  for (const run of runs) {
    lines.push(`  ${run.label}: ${commandLine(options.claude, run.args)}`);
    if (run.kind === 'hook') lines.push(`    ${run.settingsFile} = ${JSON.stringify(run.settings)}`);
  }
  return `${lines.join('\n')}\n`;
}

// A directory that cannot be emptied stops the probe with a message, never a stack trace. On
// Windows that is a process still running in it (its working directory holds the folder), or
// one holding a file there open.
const DIRECTORY_FAILED = 3;
function freshDirectory(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw Object.assign(new Error(`could not empty and recreate ${dir} (${error.code || error.message}). `
      + 'A process may still be running in it or holding a file there; end it, remove the directory, and run the probe again'),
    { probeDirectory: dir });
  }
}

// ASYNC, AND THE DEADLINE ENDS THE TREE (2026-10-20). This ran claude with spawnSync and its
// `timeout`, which kills the one process it started, and on Windows that is cmd.exe: Claude
// Code's npm `claude.cmd` is cmd-shim's direct-exe form, which npmShimLaunch does not read:
//   "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
// (2.1.293's, on the development box), so the launch always goes through cmd.exe, and the
// claude.exe under it kept running. The next run's freshDirectory then
// met that claude's working directory, Windows refused the rmSync, and the probe died on an
// uncaught throw. Now, as src/memory-guard-install.js memoryGuardProbe does it, the run is async
// and the deadline calls endProcessTree (src/exec-resolve.js), which ends cmd.exe and everything
// under it. A run settles on 'close' or, should 'close' never come (a process that survived the
// kill still holding a pipe: on POSIX any grandchild, since the deadline ends the child alone;
// on Windows one whose parent had already exited, so taskkill /T cannot find it), KILL_GRACE_MS
// after the kill, letting go of the pipes so the probe can still exit. Resolves, never rejects,
// with { status } or { error }, plus stdout and stderr.
const KILL_GRACE_MS = 2000;
const OUTPUT_CAP = 4 * 1024 * 1024;
function runClaude(options, args, cwd, endTree) {
  const { spawn } = require('child_process');
  const execResolve = require('../src/exec-resolve');
  const end = endTree || execResolve.endProcessTree;
  return new Promise((resolve) => {
    const out = { stdout: '', stderr: '' };
    let settled = false;
    let deadline = null;
    let grace = null;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(grace);
      resolve({ status: null, ...out, ...result });
    };
    const timedOut = () => Object.assign(new Error(`no answer within ${options.timeoutMs / 1000} s`), { code: 'ETIMEDOUT' });
    let child;
    try {
      const launch = execResolve.npmShimLaunch(options.claude, args) || execResolve.resolvedLaunch(options.claude, args, 'spawn');
      child = spawn(launch.file, launch.args, { ...launch.options, cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      settle({ error });
      return;
    }
    for (const stream of ['stdout', 'stderr']) {
      child[stream].setEncoding('utf8');
      child[stream].on('data', (chunk) => { if (out[stream].length < OUTPUT_CAP) out[stream] += chunk; });
    }
    let killed = false;
    // Settling is not enough when 'close' never comes: the pipes a survivor holds keep this
    // process's loop alive, so the probe would print its report and never exit. They are let go.
    const abandon = () => {
      for (const stream of [child.stdin, child.stdout, child.stderr]) try { stream.destroy(); } catch { /* gone */ }
      try { child.unref(); } catch { /* gone */ }
      settle({ error: timedOut() });
    };
    deadline = setTimeout(() => {
      killed = true;
      Promise.resolve(end(child)).catch(() => {}).then(() => {
        grace = setTimeout(abandon, KILL_GRACE_MS);
      });
    }, options.timeoutMs);
    // A program that cannot start emits 'error' then 'close'; one already running that fails a
    // kill emits 'error' and is still running, so only 'close' (or the grace) settles that one.
    child.on('error', (error) => { if (!Number.isInteger(child.pid)) settle({ error }); });
    child.on('close', (status) => settle(killed ? { error: timedOut() } : { status }));
    child.stdin.on('error', () => { /* a child that exits before reading stdin */ });
    child.stdin.end();
  });
}

function firstLine(run) {
  const text = `${run.stdout || ''}\n${run.stderr || ''}`.trim();
  return (text.split(/\r?\n/)[0] || `exit ${run.status}`).slice(0, 300);
}

function readFires(log) {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { unparsed: line }; }
  });
}

// What one hook run says about its event.
function judgeHook({ event, fires, writeLanded, run }) {
  if (fires.some((fire) => fire.event === event)) return 'fired';
  if (run.error) return `inconclusive (claude did not finish: ${run.error.code || run.error.message})`;
  // A turn that failed (no sign-in, a refused flag) gave no event its chance either.
  if (run.status !== 0) return `inconclusive (claude exited ${run.status})`;
  if (TOOL_EVENTS.has(event) && !writeLanded) return 'inconclusive (the Write did not land, so no tool ran)';
  return 'not fired';
}

function judgeGoal(run) {
  const output = `${run.stdout || ''}\n${run.stderr || ''}`;
  if (RESTRICTED_TEXT.test(output)) return 'restricted';
  if (run.error) return `unknown (claude did not finish: ${run.error.code || run.error.message})`;
  if (run.status === 0) return 'accepted (hooks are not restricted)';
  return 'unknown';
}

// A directory that cannot be emptied ends the probe with exit 3 and a message naming it, and the
// report as far as it got is written when the work directory still takes it.
async function execute(options, runs, paths, io) {
  const report = { at: new Date().toISOString(), platform: process.platform, claude: options.claude, runs: [] };
  try {
    return await executeRuns(options, runs, paths, io, report);
  } catch (error) {
    if (!error || !error.probeDirectory) throw error;
    io.err.write(`probe-user-hooks: ${error.message}. Stopping.\n`);
    report.stopped = error.message;
    try { fs.writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`); } catch { /* the work directory is the one that failed */ }
    return DIRECTORY_FAILED;
  }
}

async function executeRuns(options, runs, paths, io, report) {
  freshDirectory(paths.work);
  fs.writeFileSync(paths.canary, CANARY_SOURCE);
  for (const run of runs) {
    freshDirectory(paths.cwd);
    if (run.kind === 'hook') {
      fs.mkdirSync(path.dirname(run.settingsFile), { recursive: true });
      fs.writeFileSync(run.settingsFile, `${JSON.stringify(run.settings, null, 2)}\n`);
    }
    const result = await runClaude(options, run.args, paths.cwd);
    if (result.error && result.error.code === 'ENOENT') {
      io.err.write(`probe-user-hooks: ${options.claude} could not be started (${result.error.message}); stopping.\n`);
      report.runs.push({ label: run.label, error: result.error.message });
      fs.writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`);
      return 1;
    }
    const row = { label: run.label, kind: run.kind, exit: result.status, firstLine: firstLine(result) };
    if (run.kind === 'version') {
      report.version = row.firstLine;
      io.out.write(`claude --version: ${row.firstLine}\n`);
    } else if (run.kind === 'goal') {
      row.verdict = judgeGoal(result);
      io.out.write(`${GOAL_PROMPT}: ${row.verdict}. It said: ${row.firstLine}\n`);
    } else {
      const fires = readFires(run.log);
      const writeLanded = fs.existsSync(path.join(paths.cwd, WRITE_FILE));
      Object.assign(row, { variant: run.variant, event: run.event, fires, writeLanded,
        verdict: judgeHook({ event: run.event, fires, writeLanded, run: result }) });
      io.out.write(`${run.label}: ${row.verdict} (Write landed: ${writeLanded ? 'yes' : 'no'}; claude exit ${result.status})\n`);
    }
    report.runs.push(row);
  }
  freshDirectory(paths.cwd);
  fs.writeFileSync(paths.report, `${JSON.stringify(report, null, 2)}\n`);
  io.out.write(`report: ${paths.report}\n`);
  return 0;
}

function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr }) {
  let options;
  try { options = parseArgs(argv); } catch (error) {
    io.err.write(`probe-user-hooks: ${error.message}\n${USAGE}\n`);
    return 2;
  }
  if (options.help) { io.out.write(`${USAGE}\n`); return 0; }
  const paths = probePaths();
  let runs;
  try { runs = planRuns(options, paths); } catch (error) {
    io.err.write(`probe-user-hooks: ${error.message}\n`);
    return 2;
  }
  io.out.write(describePlan(runs, options, paths));
  if (!options.run) {
    io.err.write(`probe-user-hooks: refused, nothing was run. Each "claude -p" above is a real Claude Code turn; `
      + `pass ${OPT_IN} to run them.\n`);
    return 2;
  }
  return execute(options, runs, paths, io);
}

if (require.main === module) Promise.resolve(main()).then((code) => { process.exitCode = code; });

module.exports = {
  EVENTS, VARIANTS, parseArgs, hookCommand, canarySettings, defaultProbeBase, probePaths, planRuns, judgeHook, judgeGoal,
  runClaude,
};
