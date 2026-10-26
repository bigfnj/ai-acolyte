'use strict';

// THE ONE SQLITE ROW AI ACOLYTE READS FROM CODEX'S MEMORY PIPELINE (2026-10-26).
//
// Codex's memory pipeline has a phase-2 "consolidation" job that rewrites
// `~/.codex/memories/MEMORY.md`. Its state is one row of the `jobs` table in
// `~/.codex/memories_<n>.sqlite`: `kind = 'memory_consolidate_global'`,
// `job_key = 'global'`. Measured on a Windows box where Codex runs elevated, the row
// read `status = 'error'`, `last_error = 'failed_workspace_commit'`, two retries left,
// the next one an hour after the last, and MEMORY.md had stopped changing. Nothing on
// the Codex side says so where a user would see it, so the Codex memory card does.
//
// WHAT IS READ, AND ALL OF IT. From the highest-generation `memories_<n>.sqlite` (v1,
// Codex's default pipeline, rooted at `memories/`) and the highest
// `memories_v2_<n>.sqlite` (the opt-in v2 pipeline, rooted at `memories_v2/`, which
// has no MEMORY.md), that one row, and of it only `status`, `last_error`,
// `started_at`, `finished_at`, `retry_at` and `retry_remaining`, each only when the
// column exists. `kind` and `job_key` are named in the WHERE clause and never
// selected.
//
// WHAT IS NEVER READ. Any other row, including the stage-1 rows beside it (one per
// rollout, which name sessions); `worker_id`, `ownership_token`, `input_watermark`,
// `last_success_watermark`, or any column this list does not name. The database is
// opened read-only (src/history-adapters.js `withReadOnlyDatabase`), and nothing here
// writes to it, to the memory folder, or to git's configuration.
//
// THE ONE CHILD PROCESS. On Windows, when the row says `failed_workspace_commit` and
// the memory folder is a git repository, `git -C <root> rev-parse --git-dir` is run
// once per job outcome (probeWorkspaceOwnership, below), because the measured cause
// is git refusing a folder owned by BUILTIN\Administrators: Codex runs elevated, the
// folder is created under that owner, and git runs at Medium integrity. The check
// is read-only and bounded by PROBE_TIMEOUT_MS. Of what git prints, only the
// `safe.directory` command line it suggests is kept, and only when it names this
// very folder; the rest names accounts and SIDs and is discarded unread. AI Acolyte
// shows git's suggestion and never runs it.
//
// Where it runs: readCodexConsolidation on the Auto Learn worker thread
// (src/auto-learn-worker.js, the 'codexMemory' operation), OUTSIDE readCodexMemory,
// so the native gates signature (src/codex-memory-gates.js) and recall never see a
// job status. describeConsolidation is pure and runs on the extension host.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveCodexHome } = require('./codex-paths');
const { withReadOnlyDatabase } = require('./history-adapters');
const { resolvedLaunch, BATCH_ARGUMENT_REFUSED_CODE } = require('./exec-resolve');

const JOB_KIND = 'memory_consolidate_global';
const JOB_KEY = 'global';
const V1_STORE = /^memories_(\d+)\.sqlite$/i;
const V2_STORE = /^memories_v2_(\d+)\.sqlite$/i;
const PIPELINES = [
  { name: 'v1', pattern: V1_STORE, folder: 'memories' },
  { name: 'v2', pattern: V2_STORE, folder: 'memories_v2' },
];
const REQUIRED_COLUMNS = ['kind', 'job_key', 'status'];
// The allowlist, beyond `status`. Selected only where the column exists, so a store
// with fewer columns still reads.
const OPTIONAL_COLUMNS = ['last_error', 'started_at', 'finished_at', 'retry_at', 'retry_remaining'];
// Unix seconds between 2000-01-01 and 2100-01-01. Anything else is not a time this
// row could hold, and is dropped rather than drawn as 1970 or a far future.
const EARLIEST = 946684800;
const LATEST = 4102444800;
// `status` and `last_error` are codes Codex writes (`error`, `failed_workspace_commit`).
// Anything that is not a plain identifier could be free text, and is withheld.
const IDENTIFIER = /^[\w.:-]{1,96}$/;
const REASON_LIMIT = 160;
// Under the 5 s the worker runner gives a terminated thread to exit
// (vscode-extension/autoLearnWorkerRunner.js, DEFAULT_TERMINATE_DEADLINE_MS).
const PROBE_TIMEOUT_MS = 2500;
const SUCCEEDED = new Set(['done', 'succeeded', 'succeeded_no_workspace_changes']);
// What git and its config reading must not take from the inherited environment: a
// repository, a work tree, an index or a config the caller's shell pointed at.
const STRIPPED_ENV = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']);
const STRIPPED_ENV_PATTERN = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;
const REMEDY = /^\s*git config --global --add safe\.directory (.+?)\s*$/m;

function clip(text, limit = REASON_LIMIT) {
  const value = String(text == null ? '' : text);
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

// A failure reason names the database by its basename and nothing above it.
function failureReason(reason, file, codexHome) {
  let text = String(reason || 'unknown error');
  for (const [from, to] of [[file, path.basename(file || '')], [codexHome, '<Codex home>']]) {
    if (!from) continue;
    for (const spelling of new Set([from, from.replace(/\\/g, '/')])) text = text.split(spelling).join(to);
  }
  return clip(text);
}

function plainTime(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= EARLIEST && value <= LATEST ? value : null;
}

// The highest generation, as src/history-adapters.js picks `state_<n>.sqlite`.
function newestStore(entries, pattern, codexHome) {
  return entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => ({ name: entry.name, generation: Number(pattern.exec(entry.name)[1]) }))
    .sort((a, b) => b.generation - a.generation)
    .map((entry) => path.join(codexHome, entry.name))[0] || null;
}

function readJob(file, base, codexHome) {
  const outcome = withReadOnlyDatabase(file, (db, tables, columns) => {
    if (!tables.has('jobs')) return { ok: true, state: 'unknown-schema', reason: 'no jobs table' };
    const present = columns('jobs');
    const missing = REQUIRED_COLUMNS.filter((name) => !present.has(name));
    if (missing.length) return { ok: true, state: 'unknown-schema', reason: `the jobs table has no ${missing.join(', ')}` };
    const selected = ['status', ...OPTIONAL_COLUMNS.filter((name) => present.has(name))];
    const row = db.prepare(`select ${selected.map((name) => `"${name}"`).join(', ')} from jobs where kind = ? and job_key = ? limit 1`)
      .get(JOB_KIND, JOB_KEY);
    return { ok: true, state: row ? 'read' : 'no-row', row: row || null };
  });
  if (!outcome.ok) {
    return { ...base, state: outcome.unavailable ? 'unavailable' : 'unreadable',
      reason: failureReason(outcome.reason, file, codexHome) };
  }
  if (outcome.state !== 'read') return { ...base, state: outcome.state, ...(outcome.reason ? { reason: outcome.reason } : {}) };
  const row = outcome.row;
  const job = { ...base, state: 'read' };
  for (const [column, key] of [['status', 'status'], ['last_error', 'lastError']]) {
    const value = row[column];
    if (value === null || value === undefined) job[key] = null;
    else if (typeof value === 'string' && IDENTIFIER.test(value)) job[key] = value;
    else { job[key] = null; job[`${key}Withheld`] = true; }
  }
  for (const [column, key] of [['started_at', 'startedAt'], ['finished_at', 'finishedAt'], ['retry_at', 'retryAt']]) {
    job[key] = plainTime(row[column]);
  }
  const retries = row.retry_remaining;
  job.retryRemaining = Number.isSafeInteger(retries) && retries >= 0 && retries <= 1000 ? retries : null;
  return job;
}

// Equal directories, as git and Windows compare them: no `\\?\` prefix, one slash
// style, no trailing slash, and no case on Windows. When the spellings still differ
// (an 8.3 short name, a junction), both are resolved and compared again.
function directoryKey(value, platform) {
  const text = String(value).replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/^\/\/\?\//, '').replace(/\/+$/, '');
  return platform === 'win32' ? text.toLowerCase() : text;
}
function sameDirectory(a, b, platform) {
  if (directoryKey(a, platform) === directoryKey(b, platform)) return true;
  try {
    return directoryKey(fs.realpathSync.native(a), platform) === directoryKey(fs.realpathSync.native(b), platform);
  } catch { return false; }
}

// git's own suggested command, kept only when it names this folder. Single quotes
// are git's quoting for a path with spaces in it, and `'\''` its embedded quote.
function remedyFrom(stderr, root, platform) {
  if (!/detected dubious ownership/.test(stderr)) return null;
  const match = REMEDY.exec(stderr);
  if (!match) return null;
  let target = match[1];
  if (target.length >= 2 && target.startsWith("'") && target.endsWith("'")) target = target.slice(1, -1).replace(/'\\''/g, "'");
  if (!sameDirectory(target, root, platform)) return null;
  return match[0].trim();
}

// The mtime and size of git's two global config files, so a user who adds the
// exception (or removes it) gets one fresh check instead of the cached answer.
function gitConfigStamp(env) {
  const home = env.HOME || os.homedir();
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [path.join(home, '.gitconfig'), path.join(xdg, 'git', 'config')].map((file) => {
    try { const stat = fs.statSync(file); return `${stat.mtimeMs}:${stat.size}`; } catch { return 'none'; }
  }).join('|');
}

function probeEnvironment(base, root) {
  const env = {};
  for (const [name, value] of Object.entries(base || {})) {
    const upper = name.toUpperCase();
    if (STRIPPED_ENV.has(upper) || STRIPPED_ENV_PATTERN.test(upper)) continue;
    env[name] = value;
  }
  return { ...env, GIT_CEILING_DIRECTORIES: path.dirname(root), GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANGUAGE: '' };
}

function outcomeOf(result, root, platform) {
  const code = result?.error?.code;
  if (code === 'ENOENT') return { outcome: 'git-missing', remedy: null };
  if (code === 'ETIMEDOUT') return { outcome: 'timeout', remedy: null };
  if (result?.error) return { outcome: 'refused-other', remedy: null };
  if (result?.status === 0) return { outcome: 'accepted', remedy: null };
  const stderr = typeof result?.stderr === 'string' ? result.stderr : String(result?.stderr || '');
  if (/detected dubious ownership/.test(stderr)) return { outcome: 'dubious-ownership', remedy: remedyFrom(stderr, root, platform) };
  if (/not a git repository/i.test(stderr)) return { outcome: 'no-repository', remedy: null };
  return { outcome: 'refused-other', remedy: null };
}

// Whether git accepts the memory folder, the cause measured behind
// `failed_workspace_commit` on Windows. `pipeline` is 'v1' or 'v2'; `options.job` is
// that pipeline's sanitized row, as readJob returns it. Returns the record the host
// caches and hands back as `options.probes[pipeline]`:
// { key, outcome, remedy, attempts }. Never throws.
//
// The key is the job's outcome (database, finished_at, last_error), the folder, and
// git's global config stamp, so the check runs once per failed attempt Codex makes
// (an hour apart, measured), and once more when the user edits their git config. A
// timeout is tried once more before it is held.
function probeWorkspaceOwnership(pipeline, root, options = {}) {
  const skipped = { key: null, outcome: 'skipped', remedy: null, attempts: 0 };
  const job = options.job || {};
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' || job.status !== 'error' || job.lastError !== 'failed_workspace_commit') return skipped;
  try { fs.lstatSync(path.join(root, '.git')); } catch { return { ...skipped, outcome: 'no-repository' }; }
  const base = options.env || process.env;
  let key;
  try {
    key = JSON.stringify([pipeline, job.db, job.finishedAt, job.lastError, root, gitConfigStamp(base)]);
  } catch { return skipped; }
  const cached = options.probes && typeof options.probes === 'object' ? options.probes[pipeline] : null;
  let attempts = 1;
  if (cached && typeof cached.key === 'string' && cached.key === key) {
    if (cached.outcome !== 'timeout' || !(cached.attempts < 2)) return cached;
    attempts = (Number.isSafeInteger(cached.attempts) ? cached.attempts : 1) + 1;
  }
  let launch;
  try { launch = resolvedLaunch('git', ['-C', root, 'rev-parse', '--git-dir']); } catch (error) {
    if (error?.code === BATCH_ARGUMENT_REFUSED_CODE) return { key, outcome: 'unsupported-launcher', remedy: null, attempts };
    return { key, outcome: error?.code === 'ENOENT' ? 'git-missing' : 'refused-other', remedy: null, attempts };
  }
  // A batch launcher runs through cmd.exe, which re-parses the path; not worth it for
  // a diagnostic, so nothing is spawned.
  if (launch.options?.windowsVerbatimArguments) return { key, outcome: 'unsupported-launcher', remedy: null, attempts };
  const env = probeEnvironment(base, root);
  let result;
  try {
    const run = typeof options.run === 'function' ? options.run : spawnSync;
    result = run(launch.file, launch.args, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'],
      maxBuffer: 65536, timeout: PROBE_TIMEOUT_MS, env });
  } catch (error) {
    result = { error };
  }
  return { key, ...outcomeOf(result, root, platform), attempts };
}

function failureSentence(probe) {
  if (probe?.outcome === 'dubious-ownership') {
    return probe.remedy
      ? `git refuses the memory folder (dubious ownership); git's suggested fix, which AI Acolyte does not run: ${probe.remedy}`
      : 'git refuses the memory folder (dubious ownership).';
  }
  if (probe?.outcome === 'accepted') return 'git now accepts the folder; the warning clears when Codex next consolidates.';
  return 'See Inspect memory sources for the job\'s times.';
}

/**
 * Read the consolidation job's row from each pipeline's newest database. Runs on the
 * Auto Learn worker thread and never throws. `options` takes the codex-paths options
 * (`home`, `codexHome`), `probes` (the host's cache, as returned last time), and for
 * tests `platform`, `run` and `env`.
 */
function readCodexConsolidation(options = {}) {
  const result = { v1: null, v2: null, probes: { v1: null, v2: null }, diagnostics: [] };
  let codexHome = null;
  try {
    codexHome = resolveCodexHome(options);
    let entries;
    try { entries = fs.readdirSync(codexHome, { withFileTypes: true }); } catch (error) {
      result.v1 = error?.code === 'ENOENT' ? { pipeline: 'v1', state: 'absent', db: null, root: path.join(codexHome, 'memories') }
        : { pipeline: 'v1', state: 'unreadable', db: null, root: path.join(codexHome, 'memories'),
          reason: `the Codex home could not be listed (${error?.code || 'error'})` };
      return result;
    }
    for (const { name, pattern, folder } of PIPELINES) {
      const root = path.join(codexHome, folder);
      const file = newestStore(entries, pattern, codexHome);
      if (!file) {
        result[name] = name === 'v1' ? { pipeline: name, state: 'absent', db: null, root } : null;
        continue;
      }
      const job = readJob(file, { pipeline: name, db: path.basename(file), root }, codexHome);
      result[name] = job;
      if (job.state === 'read') result.probes[name] = probeWorkspaceOwnership(name, root, { ...options, job });
    }
    const v1 = result.v1;
    if (v1.state === 'read' && v1.status === 'error') {
      const why = v1.lastError ? ` (${v1.lastError})` : v1.lastErrorWithheld ? ' (its error text was withheld)' : '';
      result.diagnostics.push({
        code: 'consolidation-failed', severity: 'warning', relativePath: 'MEMORY.md',
        path: path.join(v1.root, 'MEMORY.md'), line: 0,
        message: `Codex memory consolidation is failing${why}, so Codex is not rewriting MEMORY.md and its references `
          + `can name rollout summaries Codex has since renamed. ${failureSentence(result.probes.v1)}`,
      });
    }
  } catch (error) {
    result.v1 = { pipeline: 'v1', state: 'unreadable', db: null, root: codexHome ? path.join(codexHome, 'memories') : null,
      reason: failureReason(error?.message || error, null, codexHome) };
    result.diagnostics = [];
  }
  return result;
}

function pad(value) { return String(value).padStart(2, '0'); }
// Local time: HH:MM on the same day as `now`, else YYYY-MM-DD HH:MM.
function clock(seconds, now) {
  const at = new Date(seconds * 1000);
  const today = new Date(now);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const sameDay = at.getFullYear() === today.getFullYear() && at.getMonth() === today.getMonth()
    && at.getDate() === today.getDate();
  return sameDay ? time : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${time}`;
}
function iso(seconds) { return new Date(seconds * 1000).toISOString(); }
function failing(job) { return job?.state === 'read' && job.status === 'error'; }

function statusText(job) {
  return job.status || (job.statusWithheld ? 'withheld (not a plain code)' : 'none');
}

// The short state, for the card line and the v2 suffix.
function shortState(job, probe, now, full) {
  if (!job || job.state === 'absent') return full ? 'no v1 database' : 'no database';
  if (job.state === 'unavailable') return 'not available (node:sqlite)';
  if (job.state === 'unreadable') return `unreadable: ${job.reason || job.db || 'unknown error'}`;
  if (job.state === 'unknown-schema') return `unknown schema (${job.db})`;
  if (job.state === 'no-row') return 'not run yet';
  const at = (seconds) => (seconds == null ? '' : ` ${clock(seconds, now)}`);
  if (job.status === 'error') {
    if (!full) return `failed${at(job.finishedAt)}`;
    const why = job.lastError ? ` (${job.lastError})` : job.lastErrorWithheld ? ' (error withheld)' : '';
    let text = `failed${at(job.finishedAt)}${why}`;
    if (job.retryRemaining === 0) text += ' · no retries left';
    else if (job.retryAt != null) text += job.retryAt * 1000 <= now ? ' · retry due' : ` · retry ${clock(job.retryAt, now)}`;
    if (probe?.outcome === 'dubious-ownership') text += ' · git: dubious ownership (see Inspect)';
    else if (probe?.outcome === 'accepted') text += ' · git: accepts the folder now';
    return text;
  }
  if (SUCCEEDED.has(job.status)) {
    return `consolidated${at(job.finishedAt)}${full && job.status === 'succeeded_no_workspace_changes' ? ' (no changes)' : ''}`;
  }
  if (job.status === 'running') return `running${job.startedAt == null ? '' : ` since ${clock(job.startedAt, now)}`}`;
  return `status ${statusText(job)}`;
}

function titleFor(job) {
  if (!job || job.state === 'absent') return null;
  if (job.state !== 'read') return `${job.db || 'Codex home'}: ${job.state}${job.reason ? ` (${job.reason})` : ''}`;
  const parts = [`status ${statusText(job)}`];
  if (job.lastError || job.lastErrorWithheld) parts.push(`last error ${job.lastError || 'withheld'}`);
  if (job.startedAt != null) parts.push(`started ${iso(job.startedAt)}`);
  if (job.finishedAt != null) parts.push(`finished ${iso(job.finishedAt)}`);
  if (job.retryAt != null) parts.push(`retry at ${iso(job.retryAt)}`);
  if (job.retryRemaining != null) parts.push(`${job.retryRemaining} ${job.retryRemaining === 1 ? 'retry' : 'retries'} left`);
  return `${job.db}, ${JOB_KIND}: ${parts.join('; ')}`;
}

const PROBE_WORDS = {
  'dubious-ownership': 'git refuses the folder (dubious ownership)',
  accepted: 'git accepts the folder',
  'refused-other': 'git refused the folder for another reason (not shown)',
  'git-missing': 'git was not found',
  timeout: `git did not answer within ${PROBE_TIMEOUT_MS} ms`,
  'unsupported-launcher': 'git resolves to a batch launcher, which this check does not run',
  'no-repository': 'the folder is not a git repository, so there is nothing to check',
};

function reportFor(name, job, probe, now) {
  const label = name === 'v1' ? 'v1 (memories)' : 'v2 (memories_v2)';
  if (!job || job.state === 'absent') return [`${label}: no memories_<n>.sqlite in this Codex home`];
  const lines = [`${label}: ${job.db || 'Codex home'}, ${job.state}${job.reason ? `: ${job.reason}` : ''}`];
  if (job.state !== 'read') return lines;
  const when = (seconds) => `${clock(seconds, now)} (${iso(seconds)})`;
  lines.push(`  status: ${statusText(job)}`);
  if (job.lastError || job.lastErrorWithheld) lines.push(`  last error: ${job.lastError || 'withheld (not a plain code)'}`);
  if (job.startedAt != null) lines.push(`  started: ${when(job.startedAt)}`);
  if (job.finishedAt != null) lines.push(`  finished: ${when(job.finishedAt)}`);
  if (job.retryAt != null) lines.push(`  retry at: ${when(job.retryAt)}${job.retryAt * 1000 <= now ? ', due' : ''}`);
  if (job.retryRemaining != null) lines.push(`  retries left: ${job.retryRemaining}`);
  if (probe && PROBE_WORDS[probe.outcome]) {
    lines.push(`  git ownership check: ${PROBE_WORDS[probe.outcome]}`);
    if (probe.remedy) lines.push(`  git's suggested fix, which AI Acolyte does not run: ${probe.remedy}`);
  }
  return lines;
}

/**
 * The card line, its tone and tooltip, and the Inspect report, from what
 * readCodexConsolidation returned. Pure; runs on the extension host. Null when
 * neither pipeline has a database.
 */
function describeConsolidation(state, now = Date.now()) {
  const v1 = state?.v1 || null;
  const v2 = state?.v2 || null;
  const probes = state?.probes || {};
  if ((!v1 || v1.state === 'absent') && !v2) return null;
  let line;
  if (v1?.state === 'unavailable') line = 'Consolidation status: not available (node:sqlite)';
  else if (v1?.state === 'unreadable') line = `Consolidation status unreadable: ${v1.reason || v1.db || 'unknown error'}`;
  else line = `Consolidation: ${shortState(v1, probes.v1, now, true)}`;
  if (v2) line += ` · v2: ${shortState(v2, probes.v2, now, false)}`;
  const titles = [titleFor(v1), v2 ? `v2: ${titleFor(v2)}` : null].filter(Boolean);
  return {
    line,
    tone: failing(v1) || failing(v2) ? 'warn' : 'info',
    title: titles.join('\n'),
    report: [
      ...reportFor('v1', v1, probes.v1, now),
      ...(v2 ? reportFor('v2', v2, probes.v2, now) : []),
      'Read-only: one row of the jobs table, six columns; AI Acolyte never writes the database or runs git\'s suggestion.',
    ],
  };
}

module.exports = { readCodexConsolidation, describeConsolidation, probeWorkspaceOwnership };
