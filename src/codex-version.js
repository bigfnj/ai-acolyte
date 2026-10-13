'use strict';

// WHICH CODEX THIS IS, AND WHETHER ANYTHING HERE WAS EVER CHECKED AGAINST IT.
//
// Declared 2026-10-13. Every Codex claim in this repository is evidence about a
// particular codex-cli build: docs/codex-compatibility.md names the version
// beside each runtime result, and test/codex-contract.test.js prints the one it
// ran against. Nothing compared those versions with the binary a user actually
// has, so "tested" and "installed" could drift apart without a word. This module
// is that comparison, and nothing more.
//
// INFORMATION, NEVER A WARNING. Codex ships often. A status that turned amber
// whenever the installed build was newer than the newest one tested here would
// be wrong on most machines most of the time -- an always-on false alarm, the
// exact defect class this release removes elsewhere. So the result carries a
// note and `severity: 'info'` unconditionally, nothing is disabled or refused
// outside the window, and the dashboard renders it as a muted line. Being
// outside the window means "not exercised here", not "broken".
//
// Read-only and bounded: one `<codex> --version` spawn with a short timeout,
// never a session, never a config read, never auth. A result is cached per
// executable and per resolved file (path + mtime + size), so an upgrade in place
// is noticed on the next call and a repeated call costs a stat. It never throws:
// an unreachable or silent binary yields `version: null` and a note that says
// why.

const fs = require('fs');
const path = require('path');
const { spawnSync, execFile } = require('child_process');
const { commandLaunch, resolveExecutable } = require('./exec-resolve');

// Each version this repository has exercised, with what was exercised on it.
// docs/codex-compatibility.md ("Supported version window, declared 2026-10-13")
// is the long form; keep the two in step when a run extends the window.
const CODEX_TESTED_VERSIONS = Object.freeze([
  Object.freeze({ version: '0.145.0', platform: 'win32', date: '2026-09-28',
    exercised: 'fresh-session runtime harnesses, real VS Code acceptance groups and the execpolicy contract' }),
  Object.freeze({ version: '0.154.0', platform: 'win32', date: '2026-09-24',
    exercised: 'CLI-only execpolicy and local-state audit' }),
  Object.freeze({ version: '0.161.0', platform: 'win32', date: '2026-10-13',
    exercised: 'execpolicy contract and shell-wrapper matrix, CLI-only loopback runtime harnesses, code-mode history shapes' }),
]);
const CODEX_VERSION_WINDOW = Object.freeze({ min: '0.145.0', max: '0.161.0' });

const DEFAULT_TIMEOUT_MS = 5000;
// A failed probe (timeout, crash, unparseable output) is retried after this long
// rather than cached for the file's lifetime: the first run of a freshly
// installed binary is the one most likely to be slow, and it should not be the
// only answer the session ever gets.
const FAILURE_TTL_MS = 60000;
const cache = new Map();
const inflight = new Map();

// `codex-cli 0.161.0`, optionally with a prerelease (`0.162.0-alpha.3`) or a
// leading `v`, anywhere in the output: a banner or warning line ahead of it is
// tolerated, a bare number is not, because "some digits somewhere" is how a
// wrong binary would masquerade as Codex.
function parseCodexVersion(text) {
  const match = /(?:^|\s)codex-cli\s+v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?=\s|$)/m.exec(String(text == null ? '' : text));
  if (!match) return null;
  const core = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`;
  return { version: match[4] ? `${core}-${match[4]}` : core, core, prerelease: match[4] || null };
}

function parts(version) {
  const parsed = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(version));
  if (!parsed) return null;
  return { numbers: [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])], prerelease: parsed[4] || null };
}

// Semver precedence for the parts this needs: numeric core first, then a
// prerelease sorts BELOW its release (0.162.0-alpha < 0.162.0). Prerelease
// identifiers compare as whole strings; nothing here depends on ordering two
// prereleases of the same version.
function compareCodexVersions(a, b) {
  const left = parts(a);
  const right = parts(b);
  if (!left || !right) return NaN;
  for (let index = 0; index < 3; index += 1) {
    if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] < right.numbers[index] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

const windowText = () => `${CODEX_VERSION_WINDOW.min}-${CODEX_VERSION_WINDOW.max}`;
const testedList = () => CODEX_TESTED_VERSIONS.map((entry) => entry.version);

// Pure: version string in, verdict and note out. `inWindow` is null when the
// version is unknown, because "not known" and "outside" are different answers.
function classifyCodexVersion(version) {
  const tested = testedList();
  const base = { version: version || null, window: { ...CODEX_VERSION_WINDOW }, tested, severity: 'info' };
  if (!version || !parts(version)) {
    return { ...base, version: null, inWindow: null, testedExactly: false,
      note: `Codex CLI version unknown. Tested window ${windowText()} (information only).` };
  }
  const testedExactly = tested.includes(version);
  const aboveMin = compareCodexVersions(version, CODEX_VERSION_WINDOW.min) >= 0;
  const belowMax = compareCodexVersions(version, CODEX_VERSION_WINDOW.max) <= 0;
  const inWindow = aboveMin && belowMax;
  let note;
  if (testedExactly) note = `Codex CLI ${version}: a tested version (window ${windowText()}).`;
  else if (inWindow) note = `Codex CLI ${version} is inside the tested window ${windowText()} but was not itself exercised.`;
  else if (!belowMax) note = `Codex CLI ${version} is newer than the newest tested version (${CODEX_VERSION_WINDOW.max}). `
    + 'Information only: nothing is disabled; newer builds have not been exercised here.';
  else note = `Codex CLI ${version} is older than the oldest tested version (${CODEX_VERSION_WINDOW.min}). `
    + 'Information only: nothing is disabled; older builds have not been exercised here.';
  return { ...base, inWindow, testedExactly, note };
}

function isFile(target) {
  try { return fs.statSync(target).isFile(); } catch { return false; }
}

// The file a launch would run, so its identity can key the cache. Windows
// already resolves to an absolute path in exec-resolve; POSIX hands bare names
// to spawn, so walk PATH here the way the shell would.
function locateCodex(executable) {
  const name = String(executable || 'codex');
  if (process.platform === 'win32') return resolveExecutable(name);
  if (name.includes('/')) return isFile(path.resolve(name)) ? path.resolve(name) : null;
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (isFile(candidate)) return candidate;
    } catch { /* not here */ }
  }
  return null;
}

function identity(executable) {
  const resolved = locateCodex(executable);
  if (!resolved) return { resolved: null, key: null };
  try {
    const stat = fs.statSync(resolved);
    return { resolved, key: `${executable}\0${resolved}\0${stat.mtimeMs}\0${stat.size}` };
  } catch {
    return { resolved: null, key: null };
  }
}

function statusFrom({ executable, resolved, stdout, error, now }) {
  const parsed = error ? null : parseCodexVersion(stdout);
  const verdict = classifyCodexVersion(parsed?.version || null);
  const reason = error || (parsed ? null : 'its --version output did not name a codex-cli version');
  return {
    ...verdict,
    executable,
    resolved: resolved || null,
    checkedAt: new Date(now).toISOString(),
    ...(reason ? { note: `Codex CLI version unavailable (${reason}). Tested window ${windowText()}; information only.`, reason } : {}),
  };
}

function cached(id, now) {
  const hit = id.key && cache.get(id.key);
  if (!hit) return null;
  if (hit.failed && now - hit.at > FAILURE_TTL_MS) { cache.delete(id.key); return null; }
  return hit.status;
}

function remember(id, status, now) {
  if (id.key) cache.set(id.key, { status, at: now, failed: status.version === null });
  return status;
}

function missing(executable, now) {
  return statusFrom({ executable, resolved: null, error: `${executable} was not found on PATH or in the standard npm locations`, now });
}

// Synchronous, for the CLI (`wildcard-perms --learn status`) and tests.
// `options.run` replaces spawnSync for tests; it receives (file, args, options).
function codexVersionStatus(options = {}) {
  const executable = String(options.executable || 'codex');
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  try {
    const id = identity(executable);
    if (!id.resolved) return missing(executable, now);
    const hit = cached(id, now);
    if (hit) return hit;
    const launch = commandLaunch(executable, ['--version']);
    const run = typeof options.run === 'function' ? options.run : spawnSync;
    const result = run(launch.file, launch.args, { ...launch.options, encoding: 'utf8', windowsHide: true,
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS });
    const error = result?.error ? String(result.error.code || result.error.message || result.error)
      : result?.status !== 0 ? `--version exited ${result?.status ?? 'without a status'}` : null;
    return remember(id, statusFrom({ executable, resolved: id.resolved, stdout: result?.stdout, error, now }), now);
  } catch (error) {
    return statusFrom({ executable, resolved: null, error: String(error.message || error), now });
  }
}

// Cache-only read: the last answer for the file that would run now, or null.
// Never spawns, so a hot path (the dashboard push) can call it freely.
function peekCodexVersionStatus(options = {}) {
  const executable = String(options.executable || 'codex');
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  try {
    const id = identity(executable);
    if (!id.resolved) return missing(executable, now);
    return cached(id, now);
  } catch {
    return null;
  }
}

// Asynchronous probe for the extension host, which must not block on a spawn.
// Concurrent calls for the same file share one child. `options.execFile`
// replaces child_process.execFile for tests; `options.track` receives the child
// so the caller can end it on deactivate. Resolves, never rejects.
function probeCodexVersionStatus(options = {}) {
  const executable = String(options.executable || 'codex');
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let id;
  try { id = identity(executable); }
  catch (error) { return Promise.resolve(statusFrom({ executable, resolved: null, error: String(error.message || error), now: now() })); }
  if (!id.resolved) return Promise.resolve(missing(executable, now()));
  const hit = cached(id, now());
  if (hit) return Promise.resolve(hit);
  if (inflight.has(id.key)) return inflight.get(id.key);
  const promise = new Promise((resolve) => {
    try {
      const launch = commandLaunch(executable, ['--version']);
      const run = typeof options.execFile === 'function' ? options.execFile : execFile;
      const child = run(launch.file, launch.args, { ...launch.options, windowsHide: true,
        timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS, maxBuffer: 64 * 1024 }, (error, stdout) => {
        const reason = error ? String(error.killed ? 'timed out' : error.code || error.message || error) : null;
        resolve(remember(id, statusFrom({ executable, resolved: id.resolved, stdout, error: reason, now: now() }), now()));
      });
      if (child && typeof options.track === 'function') options.track(child);
    } catch (error) {
      resolve(statusFrom({ executable, resolved: id.resolved, error: String(error.message || error), now: now() }));
    }
  }).finally(() => inflight.delete(id.key));
  inflight.set(id.key, promise);
  return promise;
}

// What the dashboard push uses: the cached answer when there is one, otherwise
// start a probe in the background and return null for now. The probe does NOT
// trigger a refresh of its own; the next ordinary push shows the result. A
// push it caused would be an extra one nobody asked for, and the panel's
// one-push-per-burst contract is tested (test/dashboard-view.test.js).
function dashboardCodexVersion(options = {}) {
  const status = peekCodexVersionStatus(options);
  if (status) return status;
  probeCodexVersionStatus(options);
  return null;
}

// Four doors, each with a consumer outside test/ (test/dead-exports.test.js):
// the CLI and scripts/check-codex-version.js take the synchronous status and
// the declared window, the extension takes the dashboard read. Parsing,
// classification and the async probe are reached THROUGH those doors in
// test/codex-version.test.js, which is the path every caller actually takes.
module.exports = {
  CODEX_TESTED_VERSIONS, CODEX_VERSION_WINDOW,
  codexVersionStatus, dashboardCodexVersion,
};
