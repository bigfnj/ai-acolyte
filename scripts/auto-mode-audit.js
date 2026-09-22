'use strict';

// Which of your allow entries does Claude Code actually load?
//
// In auto mode the classifier is the decider, and Claude Code DISCARDS any
// allow entry that would bypass it, logging one line per entry:
//
//   [DEBUG] Ignoring dangerous permission Bash(*) from <file> (bypasses classifier)
//
// An entry that is discarded cannot stop a prompt, so counting it as coverage
// is counting a rule that is not there. This audits the whole list in one run.
//
// It is free and it cannot touch your real configuration:
//   - CLAUDE_CONFIG_DIR points at an empty sandbox, so no managed policy fetch
//     and nothing of yours is read or written
//   - your settings file is read and never modified; only a copy of the allow
//     array is written into the sandbox
//   - every credential-bearing variable is stripped from the child's
//     environment, so the run stops at "Not logged in", and the permission load
//     happens BEFORE that, so the answer arrives without an API call
//
// That third line used to claim the same outcome from CLAUDE_CONFIG_DIR alone,
// which was false: redirecting the config directory hides the stored login and
// leaves the ENVIRONMENT untouched, so anyone with ANTHROPIC_API_KEY exported —
// the normal setup for CI and for a gateway — made a real API call from a
// script whose header promised there could not be one. See stripCredentials.
//
// Usage:
//   node scripts/auto-mode-audit.js                     audit ~/.claude/settings.json in auto mode
//   node scripts/auto-mode-audit.js --mode manual       the same list in manual (default) mode
//   node scripts/auto-mode-audit.js --settings <path>   audit some other settings file
//   node scripts/auto-mode-audit.js --entries "Bash(*)" test specific entries instead
//   node scripts/auto-mode-audit.js --json              machine-readable output
//   node scripts/auto-mode-audit.js --keep              leave the sandbox on disk to inspect

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { commandLaunch } = require('../src/exec-resolve');

const IGNORED_LINE = /Ignoring dangerous permission (.+?) from .+? \(bypasses classifier\)/g;

// Every prefix that can hand the child a credential, name an account, or point it
// at a gateway that holds one. Claude Code documents twenty-one such variables
// across four providers — API key, auth token, OAuth token, profile, the WIF
// triple, the three USE_<provider> switches, four provider keys and five base-URL
// overrides — and that list has grown with every provider added.
//
// Matched by PREFIX rather than enumerated, because an enumeration that misses the
// newest name fails SILENTLY and in the expensive direction: the probe
// authenticates, the header still promises it cannot, and nothing in the output
// says which happened. Over-stripping costs nothing at all here. The child is a
// throwaway `claude -p` that must not reach the network, and the one variable it
// needs is set explicitly afterwards.
const CREDENTIAL_ENV_PREFIXES = [
  'ANTHROPIC_', 'CLAUDE_CODE_', 'AWS_', 'GOOGLE_', 'GCLOUD_', 'CLOUDSDK_', 'AZURE_',
];

// Uppercased before comparing: Windows environment names are case-insensitive and
// `process.env` hands back whatever case the parent used, so a lowercase
// `anthropic_api_key` set in a shell profile is the same variable and must go too.
function stripCredentials(base, configDir) {
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    if (CREDENTIAL_ENV_PREFIXES.some((prefix) => name.toUpperCase().startsWith(prefix))) continue;
    env[name] = value;
  }
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

// A bad input is the user's to fix, so it gets one line and an exit code. Tagged
// rather than caught by type, so a genuine defect inside this script still comes
// out as a stack trace instead of being dressed up as the user's fault.
function inputError(message) {
  const error = new Error(message);
  error.code = 'AUDIT_INPUT';
  return error;
}

function parseArgs(argv) {
  const args = { mode: 'auto', json: false, settings: null, entries: null, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') args.json = true;
    else if (flag === '--keep') args.keep = true;
    else if (flag === '--mode') args.mode = String(argv[++index] || 'auto');
    else if (flag === '--settings') args.settings = String(argv[++index] || '');
    else if (flag === '--entries') args.entries = String(argv[++index] || '').split(',').map((v) => v.trim()).filter(Boolean);
  }
  return args;
}

// Throws an AUDIT_INPUT error rather than a raw SyntaxError. The unguarded parse
// this replaces printed `Unexpected token } in JSON at position 412` and a stack
// trace into `scripts/auto-mode-audit.js`, which reads as a bug in the audit and
// never names the file that is actually malformed — and settings.json is rewritten
// by Claude Code on every /model, /effort and approval, so a reader landing inside
// somebody else's non-atomic write is routine rather than exotic.
function readAllow(settingsPath) {
  let text;
  try {
    text = fs.readFileSync(settingsPath, 'utf8');
  } catch (error) {
    throw inputError(error.code === 'ENOENT'
      ? `no settings file at ${settingsPath}`
      : `${settingsPath} could not be read: ${error.message}`);
  }
  let raw;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw inputError(`${settingsPath} is not valid JSON: ${error.message}`);
  }
  const allow = raw && raw.permissions && Array.isArray(raw.permissions.allow) ? raw.permissions.allow : [];
  return allow.filter((entry) => typeof entry === 'string' && entry);
}

// The real probe launch, named so a test can substitute one. There is no other way
// to cover the report this function builds: the alternative is spawning the user's
// actual `claude` binary from the test suite, which is slow, needs a login, and
// makes the outcome depend on the machine the tests run on.
function runProbe(launch, options) {
  return spawnSync(launch.file, launch.args, options);
}

// Runs one probe and returns the entries Claude Code refused to load.
//
// `keep` is a PARAMETER. It used to be read straight off the module-level `args`
// binding from inside here, which worked only because the single call site happens
// to sit below that `const` — a second caller, or moving either line, turns the
// same code into a ReferenceError from the temporal dead zone.
function audit(entries, mode, options = {}) {
  const keep = Boolean(options.keep);
  const run = typeof options.run === 'function' ? options.run : runProbe;
  const baseEnv = options.env || process.env;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-mode-audit-'));
  const configDir = path.join(sandbox, 'config');
  const probePath = path.join(sandbox, 'probe.settings.json');
  const debugPath = path.join(sandbox, 'debug.log');
  fs.mkdirSync(configDir, { recursive: true });
  // deny and ask are emptied so the run answers one question only: which allow
  // entries survive the load.
  fs.writeFileSync(probePath, `${JSON.stringify({ permissions: { allow: entries, deny: [], ask: [] } }, null, 2)}\n`);

  const launch = commandLaunch('claude', [
    '--settings', probePath,
    '--permission-mode', mode,
    '--debug-file', debugPath,
    '-p', `audit-${crypto.randomBytes(3).toString('hex')}`,
  ]);
  const result = run(launch, {
    encoding: 'utf8', windowsHide: true, timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: stripCredentials(baseEnv, configDir),
    ...launch.options,
  });

  let log = '';
  try { log = fs.readFileSync(debugPath, 'utf8'); } catch {}
  const ignored = [];
  let match;
  IGNORED_LINE.lastIndex = 0;
  while ((match = IGNORED_LINE.exec(log)) !== null) ignored.push(match[1]);

  const stderr = `${result.stderr || ''}${result.stdout || ''}`;
  // The child has no credentials on purpose, so this is the expected end of a
  // healthy run. Anything else means the probe did not get far enough to be
  // trusted, and saying so beats reporting an empty ignore list as "all good".
  const reachedPermissionLoad = log.includes('Ignoring dangerous permission') ||
    /Not logged in|Please run \/login|Invalid API key/i.test(stderr);

  // Asked of the filesystem, not inferred from "rmSync did not throw". `force`
  // swallows ENOENT and a Windows handle can keep a directory alive past a
  // successful-looking call, so a flag set from the absence of an exception would
  // record "no exception" and be indistinguishable on a run that left the sandbox
  // sitting in the temp directory.
  if (!keep) { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {} }
  const sandboxRemoved = !keep && !fs.existsSync(sandbox);

  return {
    // Null when the directory is gone, because every run without `--keep` used to
    // report a path that had been deleted four lines earlier — an answer that
    // invites the reader to go and look at something that is not there. When the
    // removal did NOT work the path is reported, since then it really is on disk.
    sandbox: sandboxRemoved ? null : sandbox,
    sandboxRemoved,
    mode, total: entries.length,
    ignored: [...new Set(ignored)],
    reachedPermissionLoad,
    launchError: result.error ? result.error.code || result.error.message : null,
    note: reachedPermissionLoad ? null : stderr.trim().split('\n').slice(0, 3).join(' | '),
  };
}

function render(report, write) {
  if (report.launchError) {
    write(`could not launch claude: ${report.launchError}\n`);
    return;
  }
  if (!report.reachedPermissionLoad) {
    write(`probe did not reach the permission load, so the result is not trustworthy: ${report.note}\n`);
    return;
  }
  write(`${report.settings}\nmode ${report.mode}: ${report.total} entries, ${report.ignored.length} discarded, ${report.loaded.length} loaded\n`);
  if (report.ignored.length) {
    write('\ndiscarded (cannot stop a prompt in this mode):\n');
    for (const entry of report.ignored.slice().sort()) write(`  - ${entry}\n`);
  }
  // One branch per state the sandbox can actually be in. A removal that failed is
  // worth a line of its own: the directory holds the probe settings and the debug
  // log, and silence would leave it accumulating one copy per run.
  if (report.sandboxRemoved) write('\nsandbox removed\n');
  else if (report.sandbox) write(`\nsandbox kept at ${report.sandbox}\n`);
}

function main(argv, { env = process.env, write = (text) => process.stdout.write(text), fail = (text) => process.stderr.write(text) } = {}) {
  const args = parseArgs(argv);
  const settingsPath = args.settings || path.join(os.homedir(), '.claude', 'settings.json');
  let entries;
  try {
    entries = args.entries || readAllow(settingsPath);
  } catch (error) {
    if (error.code !== 'AUDIT_INPUT') throw error;
    fail(`${error.message}\n`);
    return 1;
  }
  const report = audit(entries, args.mode, { keep: args.keep, env });
  report.settings = args.entries ? '(explicit --entries)' : settingsPath;
  report.loaded = entries.filter((entry) => !report.ignored.includes(entry));

  if (args.json) write(`${JSON.stringify(report, null, 2)}\n`);
  else render(report, write);
  return 0;
}

// `exitCode` rather than `process.exit`, which can cut a pipe off mid-write.
if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { parseArgs, readAllow, stripCredentials, audit, render, main, CREDENTIAL_ENV_PREFIXES };
