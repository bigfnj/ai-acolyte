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
//
// "A STAT" WAS NOT TRUE until 2026-10-14. Finding the file is a PATH x PATHEXT
// walk on Windows (exec-resolve's resolveExecutable), and every dashboard push
// paid it: 434 statSync per push measured independently on the development box
// (49 PATH entries x 11 extensions, codex found at entry 36), 9.8-11.6 ms, and
// 597 per push here with the binary at the end of PATH. The resolved path is now
// memoized per (name, PATH, PATHEXT, the npm fallback roots) for LOCATE_TTL_MS;
// identity() still stats that one file, and a stat that fails drops the memo, so
// a moved or removed binary is re-walked on the very next call.

const fs = require('fs');
const path = require('path');
const { spawnSync, execFile } = require('child_process');
const { commandLaunch, resolveExecutable, endProcessTree } = require('./exec-resolve');

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
// ONE SLOT PER EXECUTABLE NAME (2026-10-14), holding the file identity it
// answered for. It was keyed on name + path + mtime + size and never evicted, so
// every upgrade in place left the previous build's entry behind for the life of
// the host. A changed identity now replaces the slot, and the number of names is
// bounded too (CACHE_LIMIT, least recently used first), for a setting someone
// edits through many values.
const CACHE_LIMIT = 32;
const cache = new Map();
const inflight = new Map();
// A located file is trusted for this long before PATH is walked again: long
// enough that a dashboard pushing every few seconds walks it about once a minute,
// short enough that a codex installed EARLIER on PATH than the one found is
// picked up without a reload. A miss is re-walked on the same clock, so a fresh
// install is noticed within a minute.
const LOCATE_TTL_MS = 60000;
const located = new Map();
// Bumped by abandonCodexVersionProbes(). A probe that settles under an older epoch
// remembers nothing: deactivate kills tracked children, and a probe it killed was
// cached as a 60 s "timed out" failure that a same-realm re-activate read first.
let probeEpoch = 0;

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
function walkFor(name) {
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

// Memoized per everything the walk reads: the name, PATH, PATHEXT, and the two
// roots exec-resolve falls back to when PATH says nothing (%APPDATA%\npm and
// %ProgramFiles%\nodejs). A change to any of them is a different key.
function locateCodex(executable, now) {
  const name = String(executable || 'codex');
  const key = [name, process.env.PATH, process.env.PATHEXT, process.env.APPDATA, process.env.ProgramFiles].join('\0');
  const memo = located.get(key);
  if (memo && now - memo.at <= LOCATE_TTL_MS) return memo.resolved;
  const resolved = walkFor(name);
  located.set(key, { resolved, at: now });
  if (located.size > CACHE_LIMIT) located.delete(located.keys().next().value);
  return resolved;
}

function forgetLocation(executable) {
  const name = String(executable || 'codex');
  for (const key of [...located.keys()]) if (key.startsWith(`${name}\0`)) located.delete(key);
}

function identity(executable, now) {
  const resolved = locateCodex(executable, now);
  if (!resolved) return { resolved: null, key: null };
  try {
    const stat = fs.statSync(resolved);
    return { resolved, key: `${resolved}\0${stat.mtimeMs}\0${stat.size}` };
  } catch {
    // The memo pointed at a file that is gone: walk again now, not in a minute.
    forgetLocation(executable);
    const again = locateCodex(executable, now);
    if (!again || again === resolved) return { resolved: null, key: null };
    try {
      const stat = fs.statSync(again);
      return { resolved: again, key: `${again}\0${stat.mtimeMs}\0${stat.size}` };
    } catch { return { resolved: null, key: null }; }
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

function cached(executable, id, now) {
  const hit = id.key && cache.get(executable);
  if (!hit || hit.id !== id.key) return null;
  if (hit.failed && now - hit.at > FAILURE_TTL_MS) { cache.delete(executable); return null; }
  // Least recently used goes first when the slot count is over the limit.
  cache.delete(executable);
  cache.set(executable, hit);
  return hit.status;
}

function remember(executable, id, status, now) {
  if (!id.key) return status;
  cache.delete(executable);
  cache.set(executable, { id: id.key, status, at: now, failed: status.version === null });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  return status;
}

// Where a missing codex was looked for. exec-resolve walks PATH, which is where a
// winget or standalone install puts it (the winget build is a native codex.exe
// linked from WinGet\Links), and then npm's global folder, which is often missing
// from the PATH a VS Code host inherits. Until 2026-10-14 this named only the npm
// locations, which sent a winget user looking in the wrong place.
function missing(executable, now) {
  return statusFrom({ executable, resolved: null, now,
    error: `${executable} was not found on PATH (where a winget, standalone or npm install puts it) `
      + 'or in npm\'s global folder' });
}

// Synchronous, for the CLI (`wildcard-perms --learn status`) and tests.
// `options.run` replaces spawnSync for tests; it receives (file, args, options).
function codexVersionStatus(options = {}) {
  const executable = String(options.executable || 'codex');
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  try {
    const id = identity(executable, now);
    if (!id.resolved) return missing(executable, now);
    const hit = cached(executable, id, now);
    if (hit) return hit;
    const launch = commandLaunch(executable, ['--version']);
    const run = typeof options.run === 'function' ? options.run : spawnSync;
    const result = run(launch.file, launch.args, { ...launch.options, encoding: 'utf8', windowsHide: true,
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS });
    const error = result?.error ? String(result.error.code || result.error.message || result.error)
      : result?.status !== 0 ? `--version exited ${result?.status ?? 'without a status'}` : null;
    return remember(executable, id, statusFrom({ executable, resolved: id.resolved, stdout: result?.stdout, error, now }), now);
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
    const id = identity(executable, now);
    if (!id.resolved) return missing(executable, now);
    return cached(executable, id, now);
  } catch {
    return null;
  }
}

// Asynchronous probe for the extension host, which must not block on a spawn.
// Concurrent calls for the same file share one child. `options.execFile`
// replaces child_process.execFile for tests; `options.track` receives the child
// so the caller can end it on deactivate. Resolves, never rejects.
//
// ITS OWN TIMER, not execFile's `timeout` (2026-10-14). execFile reports any
// kill as `error.killed`, so a probe ended by deactivate read as "timed out" and
// was cached as a failure for FAILURE_TTL_MS. The reason "timed out" now means
// this timer fired; and a probe that settles after abandonCodexVersionProbes()
// remembers nothing at all, however it ended.
function probeCodexVersionStatus(options = {}) {
  const executable = String(options.executable || 'codex');
  const now = typeof options.now === 'function' ? options.now : Date.now;
  let id;
  try { id = identity(executable, now()); }
  catch (error) { return Promise.resolve(statusFrom({ executable, resolved: null, error: String(error.message || error), now: now() })); }
  if (!id.resolved) return Promise.resolve(missing(executable, now()));
  const hit = cached(executable, id, now());
  if (hit) return Promise.resolve(hit);
  const flight = `${executable}\0${id.key}`;
  if (inflight.has(flight)) return inflight.get(flight);
  const epoch = probeEpoch;
  const promise = new Promise((resolve) => {
    try {
      const launch = commandLaunch(executable, ['--version']);
      const run = typeof options.execFile === 'function' ? options.execFile : execFile;
      const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
      let timedOut = false;
      let timer = null;
      const child = run(launch.file, launch.args, { ...launch.options, windowsHide: true,
        maxBuffer: 64 * 1024 }, (error, stdout) => {
        clearTimeout(timer);
        const reason = timedOut ? 'timed out' : error ? String(error.code || error.message || error) : null;
        const status = statusFrom({ executable, resolved: id.resolved, stdout, error: reason, now: now() });
        resolve(epoch === probeEpoch ? remember(executable, id, status, now()) : status);
      });
      timer = setTimeout(() => { timedOut = true; endProcessTree(child); }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      if (child && typeof options.track === 'function') options.track(child);
    } catch (error) {
      resolve(statusFrom({ executable, resolved: id.resolved, error: String(error.message || error), now: now() }));
    }
  }).finally(() => { if (inflight.get(flight) === promise) inflight.delete(flight); });
  inflight.set(flight, promise);
  return promise;
}

// What the dashboard push uses: the cached answer when there is one, otherwise
// start a probe in the background and return null for now.
//
// THE PROBE NOW ASKS FOR ONE PUSH OF ITS OWN (2026-10-14). It used not to, on the
// theory that the next ordinary push would show the result; on a quiet window
// there is no next push, so the CLI line stayed blank until something unrelated
// happened. `options.onSettled` is called once, by the call that STARTED the
// probe, when that probe has an answer to show. Bounded by construction: that
// answer is cached, so the push it causes reads it and starts nothing, and a
// call that found a probe already in flight registers nothing.
function dashboardCodexVersion(options = {}) {
  const status = peekCodexVersionStatus(options);
  if (status) return status;
  const executable = String(options.executable || 'codex');
  const started = !(() => {
    try {
      const id = identity(executable, Date.now());
      return id.key && inflight.has(`${executable}\0${id.key}`);
    } catch { return false; }
  })();
  const epoch = probeEpoch;
  const probe = probeCodexVersionStatus(options);
  if (started && typeof options.onSettled === 'function') {
    probe.then(() => { if (epoch === probeEpoch) options.onSettled(); }, () => {});
  }
  return null;
}

// The extension's deactivate, after it killed the probe it was tracking: drop the
// in-flight table and let nothing in flight remember its answer. Cached answers
// stay; they describe a file, not an activation.
function abandonCodexVersionProbes() {
  probeEpoch += 1;
  inflight.clear();
}

// Five doors, each with a consumer outside test/ (test/dead-exports.test.js):
// the CLI and scripts/check-codex-version.js take the synchronous status and
// the declared window, the extension takes the dashboard read and the abandon
// call its deactivate makes. Parsing, classification and the async probe are
// reached THROUGH those doors in test/codex-version.test.js, which is the path
// every caller actually takes.
module.exports = {
  CODEX_TESTED_VERSIONS, CODEX_VERSION_WINDOW,
  codexVersionStatus, dashboardCodexVersion, abandonCodexVersionProbes,
};
