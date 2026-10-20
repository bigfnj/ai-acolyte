'use strict';

// Install, remove, inspect and probe the MEMORY.md guard (src/memory-index-guard.js). The
// settings.json half is planned by src/claude-hook-config.js and written through the settings
// writer's compare-and-swap writeTransform, under the shared policy lock, with the bytes as they
// were before the first change kept in <config>/backups. <config> is CLAUDE_CONFIG_DIR when set,
// else ~/.claude (configDirFor). Default off: the hook's presence in settings.json is the whole
// state, and there is no setting key beside it.
//
// THE STABLE COPY. The hook never points into a checkout or the versioned extension directory.
// A VSIX carries no bin/, and a path like `.../ai-acolyte-1.9.0/src/...` would stop being ours
// on the next upgrade. So `on` copies the guard to `<config>/wildcarding/` and registers
// that path, and the copy is refreshed only when the packaged GUARD_REVISION is higher than the
// copy's: comparing bytes would flip-flop between a CRLF checkout and an LF build.
//
// WHERE HOOKS DO NOT RUN. A managed policy that sets allowManagedHooksOnly or disableAllHooks
// stops Claude Code running any user hook (measured 2026-10-19 with Claude Code 2.1.293 and
// 2.1.301; see docs/engineering-record.md). The guard is then installed and inert, and every
// status says so rather than reading as protection.

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createPolicyLock } = require('./policy-lock');
const { createSettingsWriter, readSettingsState, SETTINGS_UNREADABLE, SETTINGS_UNREADABLE_CODE } = require('./settings-write');
const { writeFileAtomicSync } = require('./permissions');
const { managedSettingsPaths } = require('./policy-guard');
const { inspectMemoryGuard, planMemoryGuard, memoryGuardScriptPath } = require('./claude-hook-config');

const PACKAGED_GUARD = path.join(__dirname, 'memory-index-guard.js');
const REVISION_RE = /^const GUARD_REVISION = (\d+);/m;
const PROBE_PROMPT = '/goal probe';
const PROBE_TIMEOUT_MS = 60 * 1000;
const RESTRICTED_TEXT = /can['\u2019]t run while hooks are restricted/i;

function resolveHome(options) {
  return path.resolve(options.home === undefined ? os.homedir() : options.home);
}

// The Claude Code config directory, resolved the way Claude Code resolves it (2026-10-20):
// CLAUDE_CONFIG_DIR when it is set, else <home>/.claude. The guard reads the same variable to
// find the index (src/memory-index-guard.js configDirectory), so the settings.json it is
// registered in, its stable copy and its backup all live where that Claude Code reads.
// `options.configDir` and `options.env` are for tests; an empty CLAUDE_CONFIG_DIR is unset.
function configDirFor(options, home) {
  if (typeof options.configDir === 'string' && options.configDir) return path.resolve(options.configDir);
  const value = (options.env || process.env).CLAUDE_CONFIG_DIR;
  return typeof value === 'string' && value ? path.resolve(value) : path.join(home, '.claude');
}
function settingsPathFor(config) { return path.join(config, 'settings.json'); }
// The shared policy lock, derived from the home in use. POLICY_LOCK_PATH would be the same file
// for the real home, but it froze os.homedir() when policy-lock.js was first required, so a test
// home (or any caller passing another home) would lock the wrong file. It stays under the home
// whatever CLAUDE_CONFIG_DIR says: it is a mutex between this tool's own writers, and every one of
// them takes it at this path.
function lockPathFor(home) { return path.join(home, '.claude', 'wildcarding', 'auto-learn-policy.lock'); }
function backupPathFor(config) { return path.join(config, 'backups', 'settings.json.pre-memory-guard'); }
const ABSENT_SUFFIX = '.absent';

function isFile(target) {
  try { return fs.statSync(target).isFile(); } catch { return false; }
}

// GUARD_REVISION as written in a guard file's text, or null. Read as text, never required: the
// copy lives in the user's home, and the extension host has no business executing it.
function guardRevision(text) {
  const match = REVISION_RE.exec(String(text));
  return match ? Number(match[1]) : null;
}

function revisionOf(file) {
  try { return guardRevision(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The packaged guard's revision, read once: the file ships with this code and cannot change
// while the process lives (an upgrade replaces both together). Every status call, which the
// dashboard makes on each push, read it again before 2026-10-20. A failed read is not kept.
let packagedRevisionRead = null;
function packagedRevision() {
  if (packagedRevisionRead === null) packagedRevisionRead = revisionOf(PACKAGED_GUARD);
  return packagedRevisionRead;
}

// An absolute node to name in the hook command, found on PATH at install time. Never
// process.execPath: in the extension host that is Electron, not node. Absolute PATH entries
// only (src/exec-resolve.js resolveExecutable gives the reason), and on Windows only node.exe,
// because the command runs under a shell that cannot run a .cmd shim by path.
function resolveNodeExecutable(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const name = platform === 'win32' ? 'node.exe' : 'node';
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter((dir) => dir && path.isAbsolute(dir));
  if (platform === 'win32' && env.ProgramFiles) dirs.push(path.join(env.ProgramFiles, 'nodejs'));
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (!isFile(candidate)) continue;
    if (platform !== 'win32') {
      try { fs.accessSync(candidate, fs.constants.X_OK); } catch { continue; }
    }
    return candidate;
  }
  return null;
}

// Copy the packaged guard to the stable path, unless the copy there is already at this
// revision or newer (a newer extension wrote it). Written whole or not at all: no in-place
// fallback, because a running hook reading a half-written script would just fail open, but a
// truncated copy would then stay broken until the next refresh.
function installGuardCopy(home, config, options = {}) {
  const source = options.packagedPath || PACKAGED_GUARD;
  const bytes = fs.readFileSync(source);
  const packaged = guardRevision(bytes.toString('utf8'));
  if (!Number.isInteger(packaged)) throw new Error(`${source} carries no GUARD_REVISION`);
  const target = memoryGuardScriptPath(home, config);
  const existing = revisionOf(target);
  if (existing !== null && existing >= packaged) return { path: target, revision: existing, packaged, refreshed: false };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeFileAtomicSync(target, bytes, { inPlaceFallback: false });
  return { path: target, revision: packaged, packaged, refreshed: true };
}

// The settings.json bytes as they were before this feature ever changed them. Written once:
// a later on/off keeps the first snapshot, which is the one a person undoing the feature wants.
//
// AN ABSENT settings.json IS RECORDED TOO (2026-10-20). When there was no settings.json at the
// first change, there is nothing to copy, and 1.9.0 wrote nothing; the next `off` then found no
// backup and snapshotted the guard-installed bytes, so restoring "the backup" turned the guard
// back on. The first change now leaves a marker saying the file did not exist, and either the
// backup or the marker stops every later snapshot. Returns { path, absent } for the record that
// holds the pre-change state.
function takeBackup(config, settingsPath) {
  const target = backupPathFor(config);
  const marker = `${target}${ABSENT_SUFFIX}`;
  if (fs.existsSync(target)) return { path: target, absent: false };
  if (fs.existsSync(marker)) return { path: marker, absent: true };
  let bytes = null;
  try { bytes = fs.readFileSync(settingsPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (bytes === null) {
    writeFileAtomicSync(marker, `${settingsPath} did not exist before the MEMORY.md guard first changed it, `
      + `${new Date().toISOString()}. Undo the guard by deleting that file.\n`, { inPlaceFallback: false });
    return { path: marker, absent: true };
  }
  writeFileAtomicSync(target, bytes, { inPlaceFallback: false });
  return { path: target, absent: false };
}

function readJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch { return null; }
}

// What this machine says about user hooks, from the files that can be read here: an
// administrator's managed-settings.json, the cached copy of server-delivered policy
// (remote-settings.json), and the user's own disableAllHooks. A server-delivered policy that has
// not been cached is invisible, so "nothing found" is reported as unknown, never as "runs".
function hookPolicy({ home, config, settings, managedPaths, platform }) {
  const managed = [];
  const files = Array.isArray(managedPaths) ? managedPaths : managedSettingsPaths(platform || process.platform, home);
  for (const file of [...files, path.join(config, 'remote-settings.json')]) {
    const data = readJson(file);
    if (!data) continue;
    for (const key of ['allowManagedHooksOnly', 'disableAllHooks']) {
      if (data[key] === true) managed.push(`${file} sets ${key}`);
    }
  }
  if (managed.length) {
    return { restricted: true, sources: managed,
      line: 'Claude Code will not run it here (managed policy blocks user hooks).' };
  }
  if (settings && settings.disableAllHooks === true) {
    return { restricted: true, sources: ['settings.json sets disableAllHooks'],
      line: 'Claude Code will not run it here (disableAllHooks is set in settings.json).' };
  }
  return { restricted: null, sources: [],
    line: 'Claude Code skips user hooks when managed policy restricts them; remotely delivered policy '
      + 'is not visible locally, so run `wildcard-perms --memory-guard probe` to check.' };
}

function labelFor(status, copyOutdated) {
  if (status === 'missing') return 'off';
  if (status === 'configured') return copyOutdated ? 'on (copy outdated)' : 'on';
  if (status === 'outdated') return 'on (needs repair)';
  if (status === 'foreign') return 'foreign';
  return 'unreadable';
}

function memoryGuardStatus(options = {}) {
  const home = resolveHome(options);
  const config = configDirFor(options, home);
  const platform = options.platform || process.platform;
  const settingsPath = settingsPathFor(config);
  const scriptPath = memoryGuardScriptPath(home, config);
  const state = readSettingsState(settingsPath);
  const inspected = state.state === SETTINGS_UNREADABLE
    ? { status: 'unreadable', ours: [], foreign: [], node: null, reason: `${settingsPath} exists but could not be parsed` }
    : inspectMemoryGuard(state.settings, { home, configDir: config, platform });
  const packaged = options.packagedPath ? revisionOf(options.packagedPath) : packagedRevision();
  const copyRevision = revisionOf(scriptPath);
  const on = inspected.ours.length > 0;
  const copyOutdated = on && (copyRevision === null || (packaged !== null && copyRevision < packaged));
  return {
    status: inspected.status,
    label: labelFor(inspected.status, copyOutdated),
    on,
    reason: inspected.reason,
    configDir: config,
    settingsPath,
    scriptPath,
    copy: { exists: isFile(scriptPath), revision: copyRevision },
    packagedRevision: packaged,
    copyOutdated,
    node: inspected.node,
    nodeExists: inspected.node ? isFile(inspected.node) : null,
    policy: hookPolicy({ home, config, settings: state.settings, managedPaths: options.managedSettingsPaths, platform }),
  };
}

// Turn the guard on or off. On: copy (or refresh) the guard, keep the pre-change backup, add or
// repair our handler. Off: remove our handler and nothing else; the copy stays, so a session
// that started with the hook keeps a script to run until it ends. Throws when settings.json is
// unreadable, when another guard is registered, when the lock is held, or when the write did not
// stick on re-read.
function setMemoryGuard(enabled, options = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
  const home = resolveHome(options);
  const config = configDirFor(options, home);
  const platform = options.platform || process.platform;
  const settingsPath = settingsPathFor(config);
  let nodeExecutable = options.nodeExecutable;
  if (enabled) {
    if (nodeExecutable === undefined) nodeExecutable = resolveNodeExecutable({ platform });
    if (!nodeExecutable) {
      throw new Error('cannot find node on PATH. The MEMORY.md guard is a Claude Code hook that runs under '
        + 'Node.js; install Node.js (or put it on PATH) and try again. Nothing was changed.');
    }
    if (!isFile(nodeExecutable)) throw new Error(`${nodeExecutable} does not exist. Nothing was changed.`);
  }
  const plan = { home, configDir: config, nodeExecutable, platform };
  let outcome = null;
  let copy = null;
  let backup = null;
  createPolicyLock({ lockPath: lockPathFor(home) }).locked(() => {
    const state = readSettingsState(settingsPath);
    if (state.state === SETTINGS_UNREADABLE) {
      throw Object.assign(new Error(`${settingsPath} exists but could not be parsed, so it is not safe to write over. Nothing was changed.`),
        { code: SETTINGS_UNREADABLE_CODE });
    }
    // A refusal (another guard, an unreadable hooks shape) throws here, before the copy or the
    // backup is written, so a refused `on` leaves no trace.
    const dry = planMemoryGuard(state.settings, enabled, plan);
    if (enabled) copy = installGuardCopy(home, config, options);
    if (dry.changed) backup = takeBackup(config, settingsPath);
    if (options.beforeWrite) options.beforeWrite(settingsPath);
    outcome = createSettingsWriter({ settingsPath }).writeTransform((latest) => planMemoryGuard(latest, enabled, plan));
  });
  const after = memoryGuardStatus({ ...options, home, configDir: config, platform });
  const held = enabled ? after.status === 'configured' : !after.on;
  if (!held) {
    throw new Error(`settings.json did not keep the MEMORY.md guard ${enabled ? 'on' : 'off'} (it reads ${after.status} now)`);
  }
  // backupPath is a copy of the bytes; backupAbsent the marker that says there were none.
  return { ...after, changed: Boolean(outcome && outcome.wrote), copy,
    backupPath: backup && !backup.absent ? backup.path : null, backupAbsent: backup && backup.absent ? backup.path : null };
}

// Activation's refresh: when our hook is registered and this build's guard is newer than the
// copy, replace the copy. Never writes settings.json.
function refreshMemoryGuardCopy(options = {}) {
  const status = memoryGuardStatus(options);
  if (!status.on || !status.copyOutdated) return { refreshed: false, status };
  const copy = installGuardCopy(resolveHome(options), status.configDir, options);
  return { refreshed: copy.refreshed, copy, status: memoryGuardStatus(options) };
}

// Ask Claude Code whether hooks are restricted on this machine. `/goal` needs hooks, and
// refuses with "/goal can't run while hooks are restricted (disableAllHooks or
// allowManagedHooksOnly is set in settings or by policy)" when they are. This reads that
// MESSAGE TEXT: a Claude Code that rewords it reads as unknown, never as a false "restricted".
// It says whether hooks are restricted, not that a given hook fires.
function classifyProbe(run) {
  const output = `${run && run.stdout ? run.stdout : ''}\n${run && run.stderr ? run.stderr : ''}`;
  if (RESTRICTED_TEXT.test(output)) {
    return { result: 'restricted', detail: 'Claude Code refused /goal because hooks are restricted, so it will not run the MEMORY.md guard here.' };
  }
  if (run && run.error) {
    const why = run.error.code === 'ENOENT' ? 'claude was not found on PATH'
      : run.error.code === 'ETIMEDOUT' ? `claude gave no answer within ${PROBE_TIMEOUT_MS / 1000} s`
        : run.error.message;
    return { result: 'unknown', detail: `The probe could not run: ${why}.` };
  }
  if (run && run.status === 0 && !/unknown (slash )?command/i.test(output)) {
    return { result: 'not restricted', detail: 'Claude Code accepted /goal, so hooks are not restricted by policy here.' };
  }
  const first = output.trim().split(/\r?\n/)[0] || `exit ${run ? run.status : '?'}`;
  return { result: 'unknown', detail: `Claude Code neither refused nor accepted /goal: ${first.slice(0, 200)}` };
}

// Runs `claude -p "/goal probe"` once, in an empty temporary directory so a session that does
// start (hooks allowed) has no project to act on, with stdin closed and a 60 s ceiling. Where
// hooks are allowed this starts a real, short Claude Code turn.
//
// ONE directory NAME, not a fresh random one (2026-10-19). Claude Code writes a transcript under
// ~/.claude/projects/<slug of the cwd>/ even for the refusal (measured: 2.7 KB, Claude Code
// 2.1.301), so a random name left one more project directory per probe. A fixed name keeps that
// to one, emptied and recreated for each run.
const PROBE_DIR_NAME = 'ai-acolyte-memory-guard-probe';
function memoryGuardProbe(options = {}) {
  const { spawnSync } = require('child_process');
  const { resolvedLaunch } = require('./exec-resolve');
  const command = `claude -p "${PROBE_PROMPT}"`;
  let launch;
  try { launch = resolvedLaunch(options.claudeExecutable || 'claude', ['-p', PROBE_PROMPT], 'spawnSync'); }
  catch (error) { return { ...classifyProbe({ error }), command }; }
  const cwd = path.join(os.tmpdir(), PROBE_DIR_NAME);
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.mkdirSync(cwd, { recursive: true });
  let run;
  try {
    run = spawnSync(launch.file, launch.args, { ...launch.options, cwd, input: '', encoding: 'utf8',
      timeout: options.timeoutMs || PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } finally {
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* a probe dir left behind is harmless */ }
  }
  return { ...classifyProbe(run), command };
}

module.exports = {
  resolveNodeExecutable, memoryGuardStatus, setMemoryGuard, refreshMemoryGuardCopy,
  memoryGuardProbe, classifyProbe, guardRevision,
};
