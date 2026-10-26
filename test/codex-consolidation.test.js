'use strict';

// Codex's memory consolidation job, read from one row of its `jobs` table
// (src/codex-consolidation.js). Measured on a Windows box 2026-10-26: Codex runs
// elevated, its memory folder is owned by BUILTIN\Administrators, git refuses it,
// the job fails `failed_workspace_commit` on every run, and MEMORY.md goes stale.
// The fixtures use the measured column set; every path and account in them is
// synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readCodexConsolidation, describeConsolidation, probeWorkspaceOwnership,
} = require('../src/codex-consolidation');

// The same tiering as test/codex-history-store.test.js: `node:sqlite` is absent on
// Node 20, and VS Code hosts within the ^1.80 engine floor may not carry it, so the
// fixtures that need a real database skip, loudly, where it is missing.
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
const SqliteDatabase = sqlite && (typeof sqlite.Database === 'function' ? sqlite.Database : sqlite.DatabaseSync);
const exactTier = typeof SqliteDatabase === 'function';
if (!exactTier) {
  process.stderr.write(
    '\n[codex-consolidation] SKIPPING the exact tier: node:sqlite is unavailable on '
    + `${process.version}. No jobs row was read in this run; only the absent, unavailable, `
    + 'probe and describe tiers were.\n\n',
  );
}

const NodeModule = require('node:module');
function withoutNodeSqlite(fn) {
  const original = NodeModule._load;
  NodeModule._load = function maskedLoad(request, ...rest) {
    if (request === 'node:sqlite' || request === 'sqlite') {
      const error = new Error("Cannot find module 'node:sqlite'");
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    return original.call(this, request, ...rest);
  };
  try { return fn(); } finally { NodeModule._load = original; }
}

// The measured `jobs` columns, in the measured order.
const MEASURED = {
  kind: 'TEXT', job_key: 'TEXT', status: 'TEXT', worker_id: 'TEXT', ownership_token: 'TEXT',
  started_at: 'INTEGER', finished_at: 'INTEGER', lease_until: 'INTEGER', retry_at: 'INTEGER',
  retry_remaining: 'INTEGER', last_error: 'TEXT', input_watermark: 'INTEGER', last_success_watermark: 'INTEGER',
};

function codexHome(t, label = 'home') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `acolyte-consolidation-${label}-`));
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const home = path.join(base, '.codex');
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function jobsStore(home, rows, { name = 'memories_1.sqlite', columns = Object.keys(MEASURED) } = {}) {
  const file = path.join(home, name);
  fs.rmSync(file, { force: true });
  const db = new SqliteDatabase(file);
  db.exec(`CREATE TABLE jobs (${columns.map((column) => `${column} ${MEASURED[column] || 'TEXT'}`).join(', ')})`);
  for (const row of rows) {
    const names = columns.filter((column) => row[column] !== undefined);
    db.prepare(`INSERT INTO jobs (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`)
      .run(...names.map((column) => row[column]));
  }
  db.close();
  return file;
}

const NOW = new Date(2026, 9, 26, 12, 0, 0).getTime();
const SECONDS = Math.floor(NOW / 1000);
const FAILED = {
  kind: 'memory_consolidate_global', job_key: 'global', status: 'error',
  worker_id: 'worker-SECRET', ownership_token: 'SECRET',
  started_at: SECONDS - 7260, finished_at: SECONDS - 7200, lease_until: SECONDS - 7000,
  retry_at: SECONDS - 3600, retry_remaining: 2, last_error: 'failed_workspace_commit',
  input_watermark: 777001, last_success_watermark: 777002,
};
const STAGE_ONE = {
  kind: 'memory_stage1', job_key: '0192aaaa-1111-7000-8000-00000000aa01', status: 'error',
  ownership_token: 'SECRET-STAGE', last_error: 'stage_one_SECRET', finished_at: SECONDS - 60,
};
const NO_SPAWN = () => { throw new Error('the probe spawned where it must not'); };

// The clock text the module must produce, from the same local Date getters.
function localClock(seconds, now = NOW) {
  const at = new Date(seconds * 1000);
  const today = new Date(now);
  const pad = (value) => String(value).padStart(2, '0');
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.toDateString() === today.toDateString() ? time
    : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}

test('no Codex home is absent, says nothing, and creates nothing', (t) => {
  const missing = path.join(codexHome(t, 'absent'), 'not-here');
  const result = readCodexConsolidation({ codexHome: missing, run: NO_SPAWN });
  assert.equal(result.v1.state, 'absent');
  assert.equal(result.v2, null);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(fs.existsSync(missing), false);
  assert.equal(describeConsolidation(result, NOW), null, 'no database in either pipeline, no line');
  const empty = codexHome(t, 'empty');
  const quiet = readCodexConsolidation({ codexHome: empty, run: NO_SPAWN });
  assert.equal(quiet.v1.state, 'absent');
  assert.deepEqual(fs.readdirSync(empty), [], 'reading an empty home writes nothing into it');
});

test('a runtime without node:sqlite is unavailable, muted, and raises no diagnostic', (t) => {
  const home = codexHome(t, 'no-sqlite');
  // Present, so the read is attempted; its bytes never matter, the require fails first.
  fs.writeFileSync(path.join(home, 'memories_1.sqlite'), 'unopened');
  const result = withoutNodeSqlite(() => readCodexConsolidation({ codexHome: home, run: NO_SPAWN }));
  assert.equal(result.v1.state, 'unavailable');
  assert.deepEqual(result.diagnostics, []);
  const described = describeConsolidation(result, NOW);
  assert.equal(described.line, 'Consolidation status: not available (node:sqlite)');
  assert.equal(described.tone, 'info');
});

// MUTATION: `v1.status === 'error'` -> `v1.status !== 'done'` in readCodexConsolidation.
// The running and succeeded rows below then raise the warning, and this fails.
test('a failing job is one warning on MEMORY.md line 0, with no clock time in it', { skip: !exactTier }, (t) => {
  const home = codexHome(t, 'error');
  jobsStore(home, [STAGE_ONE, FAILED]);
  const result = readCodexConsolidation({ codexHome: home, run: NO_SPAWN });
  assert.equal(result.v1.state, 'read');
  assert.equal(result.v1.status, 'error');
  assert.equal(result.v1.lastError, 'failed_workspace_commit');
  assert.equal(result.v1.retryRemaining, 2);
  assert.equal(result.v1.finishedAt, FAILED.finished_at);
  assert.equal(result.diagnostics.length, 1);
  const [diagnostic] = result.diagnostics;
  assert.deepEqual({ ...diagnostic, message: undefined }, {
    code: 'consolidation-failed', severity: 'warning', relativePath: 'MEMORY.md',
    path: path.join(home, 'memories', 'MEMORY.md'), line: 0, message: undefined,
  });
  assert.match(diagnostic.message, /^Codex memory consolidation is failing \(failed_workspace_commit\), so Codex is not rewriting MEMORY\.md/);
  assert.match(diagnostic.message, /See Inspect memory sources for the job's times\.$/, 'no .git, so no git sentence');
  assert.doesNotMatch(diagnostic.message, /\d\d:\d\d/, 'a clock time would change the Problems entry on every retry');
  for (const status of ['running', 'succeeded', 'succeeded_no_workspace_changes', 'done']) {
    jobsStore(home, [{ ...FAILED, status, last_error: null }]);
    const quiet = readCodexConsolidation({ codexHome: home, run: NO_SPAWN });
    assert.equal(quiet.v1.status, status);
    assert.deepEqual(quiet.diagnostics, [], `${status}: not a failure`);
  }
});

test('stage-1 rows and the lease columns are never read', { skip: !exactTier }, (t) => {
  const home = codexHome(t, 'private');
  jobsStore(home, [STAGE_ONE, FAILED, { ...STAGE_ONE, job_key: 'second', last_error: 'another_SECRET' }]);
  const result = readCodexConsolidation({ codexHome: home, run: NO_SPAWN });
  const text = JSON.stringify(result);
  assert.ok(!text.includes('SECRET'), 'an ownership token, worker id or stage-1 error reached the result');
  assert.ok(!text.includes('777001') && !text.includes('777002'), 'a watermark reached the result');
  assert.ok(!text.includes('0192aaaa'), 'a stage-1 job key (a thread id) reached the result');
  assert.equal(result.v1.status, 'error', 'precondition: the global row itself was read');
  assert.equal(result.v1.lastError, 'failed_workspace_commit');
});

test('a jobs table with only the columns read, or only the required three, still reads', { skip: !exactTier }, (t) => {
  const home = codexHome(t, 'narrow');
  jobsStore(home, [FAILED], { columns: ['kind', 'job_key', 'status', 'last_error', 'started_at', 'finished_at', 'retry_at', 'retry_remaining'] });
  const narrow = readCodexConsolidation({ codexHome: home, run: NO_SPAWN });
  assert.equal(narrow.v1.state, 'read');
  assert.equal(narrow.v1.lastError, 'failed_workspace_commit');
  assert.equal(narrow.v1.retryAt, FAILED.retry_at);
  assert.equal(narrow.diagnostics.length, 1);
  jobsStore(home, [FAILED], { columns: ['kind', 'job_key', 'status'] });
  const bare = readCodexConsolidation({ codexHome: home, run: NO_SPAWN });
  assert.equal(bare.v1.state, 'read');
  assert.equal(bare.v1.status, 'error');
  assert.equal(bare.v1.lastError, null);
  assert.equal(bare.v1.finishedAt, null);
  assert.match(bare.diagnostics[0].message, /^Codex memory consolidation is failing, so/);
});

// MUTATION: `b.generation - a.generation` -> `a.generation - b.generation`. The oldest
// store (done) is read, no warning is raised, and this fails.
test('the highest generation wins, by number rather than by name', { skip: !exactTier }, (t) => {
  const home = codexHome(t, 'generation');
  jobsStore(home, [{ ...FAILED, status: 'done', last_error: null }], { name: 'memories_2.sqlite' });
  jobsStore(home, [FAILED], { name: 'memories_10.sqlite' });
  fs.mkdirSync(path.join(home, 'memories_99.sqlite'));
  fs.writeFileSync(path.join(home, 'memories_10.sqlite-wal'), '');
  const result = readCodexConsolidation({ codexHome: home, run: NO_SPAWN });
  assert.equal(result.v1.db, 'memories_10.sqlite', 'a directory or a WAL file is not a store');
  assert.equal(result.v1.status, 'error');
  assert.equal(result.diagnostics.length, 1);
});

test('the v2 pipeline is read beside v1 and never raises the diagnostic', { skip: !exactTier }, (t) => {
  const home = codexHome(t, 'v2');
  jobsStore(home, [FAILED], { name: 'memories_v2_1.sqlite' });
  const only = readCodexConsolidation({ codexHome: home, run: NO_SPAWN });
  assert.equal(only.v1.state, 'absent', 'memories_v2_1 is not a v1 store');
  assert.equal(only.v2.state, 'read');
  assert.equal(only.v2.status, 'error');
  assert.equal(only.v2.root, path.join(home, 'memories_v2'));
  assert.deepEqual(only.diagnostics, [], 'v2 has no MEMORY.md to put a warning on');
  const described = describeConsolidation(only, NOW);
  assert.equal(described.line, `Consolidation: no v1 database · v2: failed ${localClock(FAILED.finished_at)}`);
  assert.equal(described.tone, 'warn');
  jobsStore(home, [{ ...FAILED, status: 'succeeded', last_error: null }]);
  const both = readCodexConsolidation({ codexHome: home, run: NO_SPAWN });
  assert.equal(both.v1.status, 'succeeded');
  assert.equal(describeConsolidation(both, NOW).line,
    `Consolidation: consolidated ${localClock(FAILED.finished_at)} · v2: failed ${localClock(FAILED.finished_at)}`);
});

test('an unknown schema, a missing row and a garbage file are each named, and none warns', { skip: !exactTier }, (t) => {
  const home = codexHome(t, 'states');
  jobsStore(home, [FAILED], { columns: ['kind', 'status', 'last_error'] });
  assert.equal(readCodexConsolidation({ codexHome: home, run: NO_SPAWN }).v1.state, 'unknown-schema');
  const file = path.join(home, 'memories_1.sqlite');
  fs.rmSync(file);
  const db = new SqliteDatabase(file);
  db.exec('CREATE TABLE threads (id TEXT)');
  db.close();
  assert.equal(readCodexConsolidation({ codexHome: home, run: NO_SPAWN }).v1.state, 'unknown-schema');
  jobsStore(home, [STAGE_ONE]);
  const none = readCodexConsolidation({ codexHome: home, run: NO_SPAWN });
  assert.equal(none.v1.state, 'no-row');
  assert.equal(describeConsolidation(none, NOW).line, 'Consolidation: not run yet');
  fs.rmSync(file);
  fs.writeFileSync(file, 'this is not a database, it is long enough to have a header to reject'.repeat(20));
  const garbage = readCodexConsolidation({ codexHome: home, run: NO_SPAWN });
  assert.equal(garbage.v1.state, 'unreadable');
  assert.match(garbage.v1.reason, /^memories_1\.sqlite: /);
  assert.ok(!garbage.v1.reason.includes(home) && garbage.v1.reason.length <= 160, 'the reason names the basename only');
  const described = describeConsolidation(garbage, NOW);
  assert.match(described.line, /^Consolidation status unreadable: memories_1\.sqlite: /);
  assert.equal(described.tone, 'info', 'an unreadable store is muted, not a warning');
  assert.deepEqual(garbage.diagnostics, []);
});

test('implausible times are dropped and free-text codes are withheld', { skip: !exactTier }, (t) => {
  const home = codexHome(t, 'sanitize');
  jobsStore(home, [{ ...FAILED, started_at: 'yesterday', finished_at: 12, retry_at: 99999999999,
    retry_remaining: -1, last_error: 'git failed in C:/Users/someone/.codex/memories' }]);
  const result = readCodexConsolidation({ codexHome: home, run: NO_SPAWN });
  assert.equal(result.v1.startedAt, null);
  assert.equal(result.v1.finishedAt, null);
  assert.equal(result.v1.retryAt, null);
  assert.equal(result.v1.retryRemaining, null);
  assert.equal(result.v1.lastError, null);
  assert.equal(result.v1.lastErrorWithheld, true);
  assert.ok(!JSON.stringify(result).includes('someone'), 'withheld text never leaves the worker');
  assert.match(result.diagnostics[0].message, /failing \(its error text was withheld\)/);
  assert.equal(describeConsolidation(result, NOW).line, 'Consolidation: failed (error withheld)');
});

// --- the git ownership check -------------------------------------------------------

function gitRoot(t, label, folder = 'memories') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `acolyte-consolidation-git-${label}-`));
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const root = path.join(base, folder);
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  const home = path.join(base, 'userhome');
  fs.mkdirSync(home);
  return { base, root, home };
}
const JOB = { pipeline: 'v1', db: 'memories_1.sqlite', status: 'error', lastError: 'failed_workspace_commit',
  finishedAt: FAILED.finished_at };
// git's message, measured 2026-10-26, with the account names replaced. The remedy line
// is tab-indented and its path unquoted.
function dubious(target) {
  return [
    `fatal: detected dubious ownership in repository at '${target}'`,
    `'${target}' is owned by:`,
    '\tBUILTIN/Administrators (S-1-5-32-544)',
    'but the current user is:',
    '\tDIR/someone (S-1-12-1-1111111111-2222222222-3333333333-4444444444)',
    'To add an exception for this directory, call:',
    '',
    `\tgit config --global --add safe.directory ${target}`,
    '',
  ].join('\n');
}
function recorder(answers) {
  const calls = [];
  const run = (file, args, options) => {
    calls.push({ file, args, options });
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    return typeof answer === 'function' ? answer() : answer;
  };
  return { calls, run };
}
const forward = (value) => value.replace(/\\/g, '/');

test('the probe keeps git\'s suggested command, unquoted or single-quoted, only for this folder', (t) => {
  const plain = gitRoot(t, 'plain');
  const env = { HOME: plain.home, PATH: process.env.PATH };
  const unquoted = recorder([{ status: 128, stderr: dubious(forward(plain.root)) }]);
  const found = probeWorkspaceOwnership('v1', plain.root, { job: JOB, platform: 'win32', run: unquoted.run, env });
  assert.equal(found.outcome, 'dubious-ownership');
  assert.equal(found.remedy, `git config --global --add safe.directory ${forward(plain.root)}`);
  assert.equal(found.attempts, 1);
  assert.ok(!JSON.stringify(found).includes('S-1-'), 'the SIDs and account lines are discarded');

  // git single-quotes a path with a space in it, and spells an embedded quote '\''.
  const spaced = gitRoot(t, 'spaced', "o'neil memories");
  const quotedTarget = `'${forward(spaced.root).replace(/'/g, "'\\''")}'`;
  const quoted = recorder([{ status: 128, stderr: dubious(quotedTarget).replace(/\n/g, '\r\n') }]);
  const kept = probeWorkspaceOwnership('v1', spaced.root, { job: JOB, platform: 'win32', run: quoted.run,
    env: { HOME: spaced.home, PATH: process.env.PATH } });
  assert.equal(kept.outcome, 'dubious-ownership');
  assert.equal(kept.remedy, `git config --global --add safe.directory ${quotedTarget}`, 'CRLF and quoting survive');

  // MUTATION: `sameDirectory(target, root, platform)` -> `true`. The foreign path is kept
  // as this folder's fix, and this fails.
  const foreign = recorder([{ status: 128, stderr: dubious('C:/Users/someone-else/.codex/memories') }]);
  const refused = probeWorkspaceOwnership('v1', plain.root, { job: { ...JOB, finishedAt: JOB.finishedAt + 1 },
    platform: 'win32', run: foreign.run, env });
  assert.equal(refused.outcome, 'dubious-ownership');
  assert.equal(refused.remedy, null, 'a command for another folder is not this folder\'s fix');

  // Case and slashes do not make it foreign on Windows.
  const shouted = recorder([{ status: 128, stderr: dubious(plain.root.toUpperCase()) }]);
  assert.equal(probeWorkspaceOwnership('v1', plain.root, { job: { ...JOB, finishedAt: JOB.finishedAt + 2 },
    platform: 'win32', run: shouted.run, env }).remedy, `git config --global --add safe.directory ${plain.root.toUpperCase()}`);
});

test('the probe runs git once, read-only, with a cleaned environment and a deadline', (t) => {
  const box = gitRoot(t, 'args');
  const env = { HOME: box.home, PATH: process.env.PATH, KEEP_ME: 'kept', GIT_DIR: 'elsewhere', git_work_tree: 'elsewhere',
    GIT_INDEX_FILE: 'x', GIT_COMMON_DIR: 'x', GIT_CONFIG_PARAMETERS: "'safe.directory=*'", GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: '*', LC_ALL: 'de_DE.UTF-8' };
  const accepted = recorder([{ status: 0, stderr: '' }]);
  const result = probeWorkspaceOwnership('v1', box.root, { job: JOB, platform: 'win32', run: accepted.run, env });
  assert.equal(result.outcome, 'accepted');
  assert.equal(accepted.calls.length, 1);
  const [call] = accepted.calls;
  assert.match(path.basename(call.file), /^git(\.exe)?$/i);
  assert.deepEqual(call.args, ['-C', box.root, 'rev-parse', '--git-dir']);
  assert.equal(call.options.timeout, 2500);
  assert.equal(call.options.windowsHide, true);
  assert.deepEqual(call.options.stdio, ['ignore', 'ignore', 'pipe']);
  assert.equal(call.options.maxBuffer, 65536);
  const passed = call.options.env;
  for (const name of ['GIT_DIR', 'git_work_tree', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
    assert.equal(name in passed, false, `${name} reached git`);
  }
  assert.equal(passed.KEEP_ME, 'kept');
  assert.equal(passed.LC_ALL, 'C');
  assert.equal(passed.LANGUAGE, '');
  assert.equal(passed.GIT_TERMINAL_PROMPT, '0');
  assert.equal(passed.GIT_CEILING_DIRECTORIES, path.dirname(box.root));
});

test('a missing git, a timeout and other refusals are named; a timeout is retried once, then held', (t) => {
  const box = gitRoot(t, 'outcomes');
  const env = { HOME: box.home, PATH: process.env.PATH };
  const missing = recorder([{ error: Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' }), status: null }]);
  assert.equal(probeWorkspaceOwnership('v1', box.root, { job: JOB, platform: 'win32', run: missing.run, env }).outcome, 'git-missing');
  const other = recorder([{ status: 128, stderr: 'fatal: something else entirely\n' }]);
  assert.equal(probeWorkspaceOwnership('v1', box.root, { job: JOB, platform: 'win32', run: other.run, env }).outcome, 'refused-other');

  const slow = recorder([{ error: Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' }), status: null, signal: 'SIGTERM' }]);
  const first = probeWorkspaceOwnership('v1', box.root, { job: JOB, platform: 'win32', run: slow.run, env });
  assert.deepEqual([first.outcome, first.attempts], ['timeout', 1]);
  const second = probeWorkspaceOwnership('v1', box.root, { job: JOB, platform: 'win32', run: slow.run, env, probes: { v1: first } });
  assert.deepEqual([second.outcome, second.attempts, slow.calls.length], ['timeout', 2, 2], 'one retry');
  const held = probeWorkspaceOwnership('v1', box.root, { job: JOB, platform: 'win32', run: slow.run, env, probes: { v1: second } });
  assert.equal(held, second, 'held: the cached answer comes back');
  assert.equal(slow.calls.length, 2, 'and git is not run a third time');
});

test('the probe never runs off Windows, for another error, or without a .git', (t) => {
  const box = gitRoot(t, 'guards');
  const env = { HOME: box.home, PATH: process.env.PATH };
  const never = recorder([{ status: 0 }]);
  assert.equal(probeWorkspaceOwnership('v1', box.root, { job: JOB, platform: 'linux', run: never.run, env }).outcome, 'skipped');
  assert.equal(probeWorkspaceOwnership('v1', box.root, { job: { ...JOB, lastError: 'agent_failed' }, platform: 'win32',
    run: never.run, env }).outcome, 'skipped');
  assert.equal(probeWorkspaceOwnership('v1', box.root, { job: { ...JOB, status: 'running' }, platform: 'win32',
    run: never.run, env }).outcome, 'skipped');
  fs.rmSync(path.join(box.root, '.git'), { recursive: true });
  assert.equal(probeWorkspaceOwnership('v1', box.root, { job: JOB, platform: 'win32', run: never.run, env }).outcome, 'no-repository');
  assert.equal(never.calls.length, 0);
});

// MUTATION: drop `job.finishedAt, ` from the cache key. A new failed attempt then reuses
// the old answer, the second run below never happens, and this fails.
test('one check per job outcome: the same key reuses it, a new finish time or git config re-runs', (t) => {
  const box = gitRoot(t, 'cache');
  const env = { HOME: box.home, PATH: process.env.PATH };
  const git = recorder([{ status: 128, stderr: dubious(forward(box.root)) }]);
  const first = probeWorkspaceOwnership('v1', box.root, { job: JOB, platform: 'win32', run: git.run, env });
  const again = probeWorkspaceOwnership('v1', box.root, { job: JOB, platform: 'win32', run: git.run, env, probes: { v1: first } });
  assert.equal(again, first);
  assert.equal(git.calls.length, 1, 'the same key does not run git again');
  const retried = probeWorkspaceOwnership('v1', box.root, { job: { ...JOB, finishedAt: JOB.finishedAt + 3600 },
    platform: 'win32', run: git.run, env, probes: { v1: first } });
  assert.equal(git.calls.length, 2, 'Codex failed again, so the check runs again');
  fs.writeFileSync(path.join(box.home, '.gitconfig'), `[safe]\n\tdirectory = ${forward(box.root)}\n`);
  probeWorkspaceOwnership('v1', box.root, { job: { ...JOB, finishedAt: JOB.finishedAt + 3600 },
    platform: 'win32', run: git.run, env, probes: { v1: retried } });
  assert.equal(git.calls.length, 3, 'an edited ~/.gitconfig earns one fresh check');
  const other = probeWorkspaceOwnership('v2', box.root, { job: JOB, platform: 'win32', run: git.run, env, probes: { v2: first } });
  assert.equal(git.calls.length, 4, 'a v1 answer is not a v2 answer');
  assert.notEqual(other.key, first.key);
});

test('a batch launcher for git is not run', { skip: process.platform !== 'win32' }, (t) => {
  const box = gitRoot(t, 'batch');
  const bin = path.join(box.base, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git.cmd'), '@echo off\r\n');
  const saved = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT };
  process.env.PATH = bin;
  process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
  try {
    const never = recorder([{ status: 0 }]);
    const result = probeWorkspaceOwnership('v1', box.root, { job: JOB, platform: 'win32', run: never.run,
      env: { HOME: box.home } });
    assert.equal(result.outcome, 'unsupported-launcher');
    assert.equal(never.calls.length, 0);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.PATHEXT === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = saved.PATHEXT;
  }
});

test('a failing job with a refused folder carries git\'s suggestion into the warning', { skip: !exactTier }, (t) => {
  const home = codexHome(t, 'with-git');
  const root = path.join(home, 'memories');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  jobsStore(home, [FAILED]);
  const git = recorder([{ status: 128, stderr: dubious(forward(root)) }]);
  const env = { HOME: path.dirname(home), PATH: process.env.PATH };
  const result = readCodexConsolidation({ codexHome: home, platform: 'win32', run: git.run, env });
  assert.equal(git.calls.length, 1);
  assert.equal(result.probes.v1.outcome, 'dubious-ownership');
  assert.match(result.diagnostics[0].message, new RegExp(
    `git refuses the memory folder \\(dubious ownership\\); git's suggested fix, which AI Acolyte does not run: `
    + `git config --global --add safe\\.directory ${forward(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  const again = readCodexConsolidation({ codexHome: home, platform: 'win32', run: git.run, env, probes: result.probes });
  assert.equal(git.calls.length, 1, 'the host hands the cache back and nothing re-runs');
  assert.equal(again.diagnostics[0].message, result.diagnostics[0].message, 'the Problems entry does not churn');
  const accepted = readCodexConsolidation({ codexHome: home, platform: 'win32', env,
    run: () => ({ status: 0, stderr: '' }), probes: { v1: { ...result.probes.v1, key: 'stale' } } });
  assert.match(accepted.diagnostics[0].message, /git now accepts the folder; the warning clears when Codex next consolidates\.$/);
  const described = describeConsolidation(result, NOW);
  assert.match(described.line, / · git: dubious ownership \(see Inspect\)$/);
  assert.ok(described.report.some((line) => line.includes(`git's suggested fix, which AI Acolyte does not run: git config`)));
});

// --- the card line ------------------------------------------------------------------

function job(fields) {
  return { pipeline: 'v1', state: 'read', db: 'memories_1.sqlite', root: 'C:/Users/someone/.codex/memories',
    status: 'error', lastError: 'failed_workspace_commit', startedAt: null, finishedAt: SECONDS - 7200,
    retryAt: SECONDS + 1800, retryRemaining: 2, ...fields };
}

test('the card line: failed with its retry, due, exhausted, other day, and the successes', () => {
  const fin = SECONDS - 7200;
  const failed = describeConsolidation({ v1: job({}), v2: null, probes: {} }, NOW);
  assert.equal(failed.line, `Consolidation: failed ${localClock(fin)} (failed_workspace_commit) · retry ${localClock(SECONDS + 1800)}`);
  assert.equal(failed.tone, 'warn');
  assert.match(failed.title, new RegExp(`finished ${new Date(fin * 1000).toISOString().replace(/\./g, '\\.')}`), 'UTC in the tooltip');
  assert.ok(failed.report.some((line) => line === `  finished: ${localClock(fin)} (${new Date(fin * 1000).toISOString()})`));
  assert.equal(describeConsolidation({ v1: job({ retryAt: SECONDS - 60 }) }, NOW).line,
    `Consolidation: failed ${localClock(fin)} (failed_workspace_commit) · retry due`);
  assert.equal(describeConsolidation({ v1: job({ retryRemaining: 0, retryAt: SECONDS - 60 }) }, NOW).line,
    `Consolidation: failed ${localClock(fin)} (failed_workspace_commit) · no retries left`);
  const old = SECONDS - 3 * 86400;
  assert.match(localClock(old), /^\d{4}-\d\d-\d\d \d\d:\d\d$/, 'precondition: another day carries its date');
  assert.equal(describeConsolidation({ v1: job({ finishedAt: old, retryAt: null }) }, NOW).line,
    `Consolidation: failed ${localClock(old)} (failed_workspace_commit)`);
  const done = describeConsolidation({ v1: job({ status: 'succeeded', lastError: null }) }, NOW);
  assert.equal(done.line, `Consolidation: consolidated ${localClock(fin)}`);
  assert.equal(done.tone, 'info');
  assert.equal(describeConsolidation({ v1: job({ status: 'succeeded_no_workspace_changes', lastError: null }) }, NOW).line,
    `Consolidation: consolidated ${localClock(fin)} (no changes)`);
  assert.equal(describeConsolidation({ v1: job({ status: 'running', lastError: null, startedAt: SECONDS - 120 }) }, NOW).line,
    `Consolidation: running since ${localClock(SECONDS - 120)}`);
  assert.equal(describeConsolidation({ v1: { pipeline: 'v1', state: 'unreadable', reason: 'worker failed' } }, NOW).line,
    'Consolidation status unreadable: worker failed');
  assert.equal(describeConsolidation({ v1: { state: 'absent' }, v2: null }, NOW), null);
});
