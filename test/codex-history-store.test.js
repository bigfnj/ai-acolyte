'use strict';

// THE READER IS CORRECT TODAY. THIS PROVES THE DETECTOR FOR THE DAY IT IS NOT.
//
// MEASURED ON THE DEVELOPMENT BOX 2026-09-24, codex-cli 0.145.0: Codex writes
// the rollout JSONL files under `~/.codex/sessions` that `scanHistoryFiles`
// consumes AND maintains `~/.codex/thread_history_1.sqlite` beside them
// (`thread_turns` 20, `thread_items` 567, `thread_history_projection_state` 52).
// The projection table's columns are `thread_id`, `next_rollout_byte_offset`
// and `next_rollout_ordinal` — it is a cursor INTO the rollout files — and its
// 52 rows matched the 52 rollout files exactly, zero orphans in either
// direction. sqlite is a projection, so the reader stays as it is.
//
// The failure it has no defence against is a migration. A store that becomes the
// source of truth leaves `~/.codex/sessions` frozen, and a scan of a frozen
// directory reports `{files: 52, observations: 0, errors: 0}` — the same numbers
// a quiet week reports. So every fixture below makes the two stores DISAGREE and
// asserts the disagreement is visible, plus one healthy control, because a
// detector that fires on everything is not a detector.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { codexHistoryStoreState } = require('../src/history-adapters');
const { createAutoLearnManager } = require('../src/auto-learn-manager');

// `node:sqlite` is absent on Node 20 and flagged before Node 22.13. VS Code
// 1.141.1 (Node 24.21.0) loads it; hosts within the ^1.80 engine floor may not,
// so the `unavailable` tier stays (measured 2026-10-13). The exact tier is
// unreachable where it is absent, and a skip that does not say so is a silent
// pass.
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
const exactTier = Boolean(sqlite && typeof sqlite.DatabaseSync === 'function');
if (!exactTier) {
  process.stderr.write(
    '\n[codex-history-store] SKIPPING the exact tier: node:sqlite is unavailable on ' +
    `${process.version}. The sqlite-versus-rollout comparison was NOT exercised in this run; ` +
    'only the session-index and migration tiers were.\n\n',
  );
}

const THREADS = [
  '0192aaaa-1111-7000-8000-00000000aa01',
  '0192aaaa-1111-7000-8000-00000000aa02',
  '0192aaaa-1111-7000-8000-00000000aa03',
];

function codexHome(t, label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `codex-history-${label}-`));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(home, '.codex', 'sessions', '2026', '09', '24'), { recursive: true });
  return home;
}

// A rollout file in the real naming shape: `rollout-<timestamp>-<thread id>.jsonl`.
// The thread id in the NAME is the correlation key, which is why the detector can
// answer without opening a single transcript.
function rollout(home, threadId) {
  const file = path.join(home, '.codex', 'sessions', '2026', '09', '24',
    `rollout-2026-09-24T10-00-00-${threadId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd: 'C:\\w' } })}\n`);
  return file;
}

// Where archiving puts a rollout, MEASURED 2026-10-13: a flat folder beside
// `sessions/`, same file name, no date directories.
function archivedRollout(home, threadId) {
  const dir = path.join(home, '.codex', 'archived_sessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-24T10-00-00-${threadId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', payload: { id: threadId, cwd: 'C:\\w' } })}\n`);
  return file;
}

// The real schema, reduced to the columns the detector reads. Column names and
// table names are copied from the live store rather than invented, because a
// fixture whose schema is wrong proves the detector works on a database Codex
// does not write.
//
// `offsets` is the projection's cursor per thread and defaults to 0. It used to
// be a fixed 4096 for every thread, against fixture rollouts of about seventy
// bytes, which no real store holds -- measured 2026-10-13, the cursor equalled
// the file size for 13 of 13 threads -- and which the projection check now
// correctly reads as a store ahead of its transcripts.
function threadStore(home, threadIds, { name = 'thread_history_1.sqlite', offsets = {} } = {}) {
  const file = path.join(home, '.codex', name);
  fs.rmSync(file, { force: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE thread_history_projection_state (
    thread_id TEXT PRIMARY KEY,
    next_rollout_byte_offset INTEGER NOT NULL,
    next_rollout_ordinal INTEGER NOT NULL )`);
  db.exec(`CREATE TABLE thread_items (
    thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
    rollout_ordinal INTEGER NOT NULL, created_at_ms INTEGER NOT NULL,
    item_json TEXT NOT NULL, item_type TEXT NOT NULL DEFAULT '',
    updated_at_ordinal INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (thread_id, turn_id, item_id) )`);
  const insert = db.prepare(
    'INSERT INTO thread_history_projection_state (thread_id, next_rollout_byte_offset, next_rollout_ordinal) VALUES (?, ?, ?)',
  );
  for (const id of threadIds) insert.run(id, offsets[id] ?? 0, 14);
  db.close();
  return file;
}

// Codex's thread-state database, `state_5.sqlite` on the development box. The
// columns are the measured ones (2026-10-13) up to `archived`, which is the last
// one the detector reads; `rollout_migration_state` is the measured table whole.
function stateStore(home, rows, { migrations = [], name = 'state_5.sqlite' } = {}) {
  const file = path.join(home, '.codex', name);
  fs.rmSync(file, { force: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'cli', model_provider TEXT NOT NULL DEFAULT 'openai',
    cwd TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
    sandbox_policy TEXT NOT NULL DEFAULT '', approval_mode TEXT NOT NULL DEFAULT '',
    tokens_used INTEGER NOT NULL DEFAULT 0, has_user_event INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0 )`);
  db.exec(`CREATE TABLE rollout_migration_state (
    migration_id TEXT PRIMARY KEY, last_checked_thread_created_at INTEGER,
    last_checked_thread_id TEXT, updated_at INTEGER )`);
  const insert = db.prepare('INSERT INTO threads (id, rollout_path, archived) VALUES (?, ?, ?)');
  for (const row of rows) insert.run(row.id, row.rolloutPath, row.archived ? 1 : 0);
  const migration = db.prepare('INSERT INTO rollout_migration_state (migration_id, updated_at) VALUES (?, 0)');
  for (const id of migrations) migration.run(id);
  db.close();
  return file;
}

function sessionIndex(home, ids) {
  fs.writeFileSync(path.join(home, '.codex', 'session_index.jsonl'),
    `${ids.map((id) => JSON.stringify({ id, thread_name: 'fixture' })).join('\n')}\n`);
}

test('a store and a rollout directory that agree are reported healthy and exact', { skip: !exactTier }, (t) => {
  const home = codexHome(t, 'agree');
  for (const id of THREADS) rollout(home, id);
  threadStore(home, THREADS);

  const state = codexHistoryStoreState({ home });
  assert.equal(state.inspected, 'exact', 'the store opened and was compared');
  assert.equal(state.stale, false);
  assert.deepEqual(state.reasons, [], 'a healthy corpus produces no reason to worry');
  assert.equal(state.rolloutFiles, 3);
  assert.equal(state.storeThreads, 3);
  assert.deepEqual(state.orphans, []);
  // This is the shape measured on the real box: 52 == 52, zero orphans.
  assert.equal(state.rolloutThreads, state.storeThreads);
});

test('a thread the store knows and the rollout directory does not is a stale directory', { skip: !exactTier }, (t) => {
  const home = codexHome(t, 'orphan');
  // Two of three threads still have a transcript. The third exists only in the
  // store, which is exactly what a half-migrated backend looks like.
  rollout(home, THREADS[0]);
  rollout(home, THREADS[1]);
  threadStore(home, THREADS);

  const state = codexHistoryStoreState({ home });
  assert.equal(state.inspected, 'exact');
  assert.equal(state.stale, true);
  assert.deepEqual(state.orphans, [THREADS[2]]);
  assert.match(state.reasons.join('\n'), /1 Codex thread\(s\) exist in the history store/);
  assert.match(state.reasons.join('\n'), /invisible to it/);
});

test('an empty rollout directory beside a populated store is named, not read as quiet', { skip: !exactTier }, (t) => {
  const home = codexHome(t, 'emptied');
  threadStore(home, THREADS);

  const state = codexHistoryStoreState({ home });
  assert.equal(state.stale, true);
  assert.equal(state.rolloutFiles, 0);
  // Both signals fire: every thread is an orphan AND the directory is empty.
  // The second is the one that matters, because zero files is precisely what a
  // clean scan of a migrated machine reports.
  assert.match(state.reasons.join('\n'), /The reader would report a clean scan of an empty directory/);
});

// A control that can run degraded must SAY so. A store it cannot open is not
// evidence of health, and reporting `stale: false` without the qualifier would
// be a log line that cannot fail.
test('a store that cannot be opened reports partial, never healthy', { skip: !exactTier }, (t) => {
  const home = codexHome(t, 'corrupt');
  for (const id of THREADS) rollout(home, id);
  fs.writeFileSync(path.join(home, '.codex', 'thread_history_1.sqlite'),
    'this is not a database, it is nine words of text');

  const state = codexHistoryStoreState({ home });
  assert.equal(state.inspected, 'partial', 'the exact comparison did not run');
  assert.equal(state.stale, false, 'and it found nothing, which is not the same as finding nothing wrong');
  assert.match(state.notes.join('\n'), /could not be read/);
  assert.match(state.notes.join('\n'), /treat this as unknown, not healthy/);
});

// The fallback tier, which is the only one available on Node 20. It needs no
// sqlite driver at all: `session_index.jsonl` names thread ids in plain JSONL.
test('session_index.jsonl alone catches a thread with no transcript', (t) => {
  const home = codexHome(t, 'index');
  rollout(home, THREADS[0]);
  fs.writeFileSync(path.join(home, '.codex', 'session_index.jsonl'), [
    JSON.stringify({ id: THREADS[0], thread_name: 'kept', updated_at: '2026-09-24T10:00:00Z' }),
    JSON.stringify({ id: THREADS[1], thread_name: 'moved', updated_at: '2026-09-24T11:00:00Z' }),
    '',
  ].join('\n'));

  const state = codexHistoryStoreState({ home });
  assert.equal(state.stale, true);
  assert.deepEqual(state.orphans, [THREADS[1]]);
  // The control: an index that agrees with the directory is not stale. Without
  // this the assertion above would also pass a detector that always fires.
  fs.writeFileSync(path.join(home, '.codex', 'session_index.jsonl'),
    `${JSON.stringify({ id: THREADS[0], thread_name: 'kept' })}\n`);
  const healthy = codexHistoryStoreState({ home });
  assert.equal(healthy.stale, false);
  assert.deepEqual(healthy.reasons, []);
});

// WAS "an applied rollout migration is itself a reason", and that reason fired
// on a record rather than on a move. Measured 2026-10-13 the box carries a
// recorded migration (`legacy_to_paginated_v1` in state_5.sqlite) over a store
// whose every cursor matches its transcript byte for byte. A record of a
// migration is context; the transcript checks are what see one that moved the
// source of truth, and they run either way.
test('an applied rollout migration is a note, not a reason', (t) => {
  const home = codexHome(t, 'migration');
  rollout(home, THREADS[0]);
  const dir = path.join(home, '.codex', 'rollout-migrations');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '0001-move-to-thread-store.applied'), 'done\n');

  const state = codexHistoryStoreState({ home });
  assert.equal(state.stale, false,
    `witness:migration-note -- a recorded migration was read as divergence: ${state.reasons.join(' | ')}`);
  assert.deepEqual(state.reasons, []);
  assert.match(state.notes.join('\n'), /rollout migration/);

  // The control: the migration note does not quiet the check that matters. A
  // thread with no transcript still makes the directory stale, note and all.
  sessionIndex(home, [THREADS[0], THREADS[1]]);
  const diverged = codexHistoryStoreState({ home });
  assert.equal(diverged.stale, true);
  assert.deepEqual(diverged.orphans, [THREADS[1]]);
  assert.match(diverged.notes.join('\n'), /rollout migration/);
});

// ── archived threads ──────────────────────────────────────────────────────────
//
// THE DEFECT, REPRODUCED ON THE REAL BOX 2026-10-13: the user archived four
// Codex threads, Codex moved their rollouts into `archived_sessions/`, and the
// history store and session index went on naming all four. A walk of
// `sessions/` alone read them as orphans, so every scan reported "scan degraded
// -- Codex history store has moved", permanently, over a store that had moved
// nothing.

test('an archived thread is not an orphan', (t) => {
  // No sqlite needed: the session index alone names both threads, so this runs
  // on every runtime, including the node-20 CI legs.
  const home = codexHome(t, 'archived');
  rollout(home, THREADS[0]);
  const archived = archivedRollout(home, THREADS[1]);
  sessionIndex(home, [THREADS[0], THREADS[1]]);

  const state = codexHistoryStoreState({ home });
  assert.equal(state.stale, false,
    `witness:archived-orphan -- an archived transcript was read as a missing one: ${state.reasons.join(' | ')}`);
  assert.deepEqual(state.orphans, []);
  assert.equal(state.archivedFiles, 1);
  assert.equal(state.rolloutThreads, 2);
  assert.equal(state.rolloutFiles, 2);

  // The control: with the archived transcript really gone, the same thread IS
  // an orphan. Without this a detector that stopped looking would pass above.
  fs.rmSync(archived);
  const gone = codexHistoryStoreState({ home });
  assert.equal(gone.stale, true);
  assert.deepEqual(gone.orphans, [THREADS[1]]);
  assert.equal(gone.orphanCount, 1);
  assert.equal(gone.findings.orphans, 1);
  assert.doesNotMatch(gone.reasons.join('\n'), /[\\/](?:Users|home|tmp)[\\/]|\.jsonl/i,
    'a persisted reason names directories, never a path or a transcript file');
});

// A thread can move while the walk runs -- archived, or unarchived back into
// `sessions/` -- and a single walk then misses it for exactly one scan, which is
// all it takes to put "scan degraded" on the row. The walk is simulated missing
// the archive once by making the first listing of that folder come back empty.
test('a thread missed by one walk is found by the re-walk, not reported', (t) => {
  const home = codexHome(t, 'rewalk');
  rollout(home, THREADS[0]);
  const archived = archivedRollout(home, THREADS[1]);
  sessionIndex(home, [THREADS[0], THREADS[1]]);
  const archiveDir = path.resolve(path.dirname(archived));
  const real = fs.readdirSync;
  const missing = (times) => {
    let left = times;
    fs.readdirSync = function readdirSync(dir, ...rest) {
      const entries = real.call(this, dir, ...rest);
      if (left > 0 && path.resolve(String(dir)) === archiveDir) { left -= 1; return []; }
      return entries;
    };
    try { return codexHistoryStoreState({ home }); } finally { fs.readdirSync = real; }
  };

  const once = missing(1);
  assert.equal(once.stale, false,
    `witness:rewalk -- a transcript one walk missed was reported as missing: ${once.reasons.join(' | ')}`);
  assert.deepEqual(once.orphans, []);

  // The control: missed by BOTH walks it really is unaccounted for, so the
  // re-walk is a second look and not a way of never reporting anything.
  const twice = missing(2);
  assert.equal(twice.stale, true);
  assert.deepEqual(twice.orphans, [THREADS[1]]);
});

test('a store thread whose only transcript is archived reads exact and healthy', { skip: !exactTier }, (t) => {
  const home = codexHome(t, 'archived-exact');
  rollout(home, THREADS[0]);
  rollout(home, THREADS[1]);
  const archived = archivedRollout(home, THREADS[2]);
  threadStore(home, THREADS);

  const state = codexHistoryStoreState({ home });
  assert.equal(state.inspected, 'exact');
  assert.equal(state.stale, false, state.reasons.join(' | '));
  assert.equal(state.storeThreads, 3);
  assert.equal(state.rolloutThreads, 3);

  fs.rmSync(archived);
  const gone = codexHistoryStoreState({ home });
  assert.equal(gone.stale, true);
  assert.equal(gone.orphanCount, 1);
  assert.equal(gone.findings.orphans, 1);
  assert.deepEqual(gone.orphans, [THREADS[2]]);
});

test('an archive that is not a configured root is accounted for and named, not orphaned', (t) => {
  // The one-root spelling every caller used before archived_sessions existed.
  // The archive is still walked so its threads are not orphans, but the reader
  // does NOT read it, and the result has to say so rather than vouch for it.
  const home = codexHome(t, 'archive-unscanned');
  const sessions = path.join(home, '.codex', 'sessions');
  rollout(home, THREADS[0]);
  archivedRollout(home, THREADS[1]);
  sessionIndex(home, [THREADS[0], THREADS[1]]);

  const state = codexHistoryStoreState({ home, sessionsDir: sessions });
  assert.equal(state.stale, false, state.reasons.join(' | '));
  assert.match(state.notes.join('\n'), /1 archived transcript\(s\) are not read because archived_sessions is not a configured history root/);

  // The control: with the archive configured, as the default now is, there is
  // nothing to warn about.
  const configured = codexHistoryStoreState({ home });
  assert.equal(configured.stale, false);
  assert.doesNotMatch(configured.notes.join('\n'), /not a configured history root/);
});

test('a store cursor past the end of its transcript is a stale projection', { skip: !exactTier }, (t) => {
  const home = codexHome(t, 'projection');
  const file = rollout(home, THREADS[0]);
  const size = fs.statSync(file).size;

  threadStore(home, [THREADS[0]], { offsets: { [THREADS[0]]: size + 1 } });
  const ahead = codexHistoryStoreState({ home });
  assert.equal(ahead.inspected, 'exact');
  assert.equal(ahead.stale, true);
  assert.deepEqual(ahead.projectionAhead, [THREADS[0]]);
  assert.equal(ahead.findings.projectionAhead, 1);
  assert.match(ahead.reasons.join('\n'), /ahead/);

  // The control is the measured healthy shape: cursor == size exactly. Strictly
  // greater is the rule, because a cursor at end of file is a store that is
  // fully caught up, not one that outran its transcript.
  threadStore(home, [THREADS[0]], { offsets: { [THREADS[0]]: size } });
  const level = codexHistoryStoreState({ home });
  assert.equal(level.stale, false, level.reasons.join(' | '));
  assert.deepEqual(level.projectionAhead, []);
});

test('the thread-state database classifies a missing transcript and never adds one', { skip: !exactTier }, (t) => {
  const elsewhere = (home) => path.join(home, '.codex', 'elsewhere');

  // (a) The measured box: one recorded migration over a healthy corpus.
  const a = codexHome(t, 'state-migration');
  rollout(a, THREADS[0]);
  threadStore(a, [THREADS[0]]);
  stateStore(a, [{ id: THREADS[0], rolloutPath: path.join(a, '.codex', 'sessions', 'x.jsonl') }],
    { migrations: ['legacy_to_paginated_v1'] });
  const migrated = codexHistoryStoreState({ home: a });
  assert.equal(migrated.stale, false, migrated.reasons.join(' | '));
  assert.deepEqual(migrated.migrations, ['legacy_to_paginated_v1']);
  assert.match(migrated.notes.join('\n'), /legacy_to_paginated_v1\); that alone is not divergence/);

  // (b) Codex writes a transcript somewhere the reader does not look. On
  // Windows the path carries the `\\?\` prefix some real rows carry.
  const b = codexHome(t, 'state-relocated');
  rollout(b, THREADS[0]);
  fs.mkdirSync(elsewhere(b), { recursive: true });
  const moved = path.join(elsewhere(b), `rollout-2026-09-24T10-00-00-${THREADS[1]}.jsonl`);
  fs.writeFileSync(moved, '{}\n');
  threadStore(b, [THREADS[0], THREADS[1]]);
  stateStore(b, [{ id: THREADS[1], rolloutPath: process.platform === 'win32' ? `\\\\?\\${moved}` : moved }]);
  const relocated = codexHistoryStoreState({ home: b });
  assert.equal(relocated.stale, true);
  assert.equal(relocated.findings.relocated, 1);
  assert.deepEqual(relocated.relocated, [THREADS[1]]);
  assert.deepEqual(relocated.orphans, [], 'a transcript that exists is relocated, not orphaned');
  assert.match(relocated.reasons.join('\n'), /writing where the reader does not read/);
  assert.doesNotMatch(relocated.reasons.join('\n'), /elsewhere|\.jsonl/,
    'the relocated path is a user path and must not reach a persisted reason');

  // (c) The state row names a transcript that does not exist and is not
  // archived: an orphan, exactly as without the database.
  const c = codexHome(t, 'state-orphan');
  rollout(c, THREADS[0]);
  threadStore(c, [THREADS[0], THREADS[1]]);
  stateStore(c, [{ id: THREADS[1], rolloutPath: path.join(elsewhere(c), 'missing.jsonl'), archived: false }]);
  const orphan = codexHistoryStoreState({ home: c });
  assert.equal(orphan.stale, true);
  assert.deepEqual(orphan.orphans, [THREADS[1]]);

  // (d) Archived, and its transcript deleted afterwards: the user's doing, not
  // divergence. A note, so the row stays clean.
  const d = codexHome(t, 'state-archived-gone');
  rollout(d, THREADS[0]);
  threadStore(d, [THREADS[0], THREADS[1]]);
  stateStore(d, [{ id: THREADS[1], rolloutPath: path.join(d, '.codex', 'archived_sessions', 'gone.jsonl'), archived: true }]);
  const deleted = codexHistoryStoreState({ home: d });
  assert.equal(deleted.stale, false, deleted.reasons.join(' | '));
  assert.deepEqual(deleted.orphans, []);
  assert.match(deleted.notes.join('\n'), /deleted archive, not divergence/);

  // NEVER ADDS: a thread only the state database knows is not an orphan. Rows
  // can precede their transcripts, so the table is a classifier, not a source.
  stateStore(d, [
    { id: THREADS[1], rolloutPath: path.join(d, '.codex', 'archived_sessions', 'gone.jsonl'), archived: true },
    { id: THREADS[2], rolloutPath: path.join(d, '.codex', 'sessions', 'not-yet.jsonl') },
  ]);
  assert.equal(codexHistoryStoreState({ home: d }).stale, false,
    'a state row with no transcript and no store entry was promoted to a known thread');

  // (e) A state database that will not read costs its classification, never
  // the comparison: still exact, a note, no reason.
  const e = codexHome(t, 'state-garbage');
  rollout(e, THREADS[0]);
  threadStore(e, [THREADS[0]]);
  fs.writeFileSync(path.join(e, '.codex', 'state_5.sqlite'), 'this is not a database either');
  const garbage = codexHistoryStoreState({ home: e });
  assert.equal(garbage.inspected, 'exact',
    `witness:state-db -- an unreadable thread-state database downgraded the comparison to ${garbage.inspected}`);
  assert.equal(garbage.stale, false);
  assert.match(garbage.notes.join('\n'), /thread-state database could not be read/);
  // The control on the same home: a real store orphan is still found with the
  // state database unreadable.
  threadStore(e, [THREADS[0], THREADS[1]]);
  const stillStale = codexHistoryStoreState({ home: e });
  assert.equal(stillStale.stale, true);
  assert.deepEqual(stillStale.orphans, [THREADS[1]]);
});

test('a machine with no Codex at all is answered exactly, and is not a fault', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-history-none-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = codexHistoryStoreState({ home });
  assert.equal(state.inspected, 'exact', 'absence is a known answer, not an unknown one');
  assert.equal(state.stale, false);
  assert.equal(state.present, false);
  assert.deepEqual(state.reasons, []);
});

// The integration half. A detector nothing consults is not a control, and the
// scan result is where every consumer — CLI, dashboard card, worker — reads its
// health from.
test('a stale store turns a clean-looking scan into a reported degraded one', (t) => {
  const home = codexHome(t, 'scan');
  const sessions = path.join(home, '.codex', 'sessions');
  rollout(home, THREADS[0]);
  fs.writeFileSync(path.join(home, '.codex', 'session_index.jsonl'), [
    JSON.stringify({ id: THREADS[0] }),
    JSON.stringify({ id: THREADS[1] }),
  ].join('\n'));

  const manager = createAutoLearnManager({
    home, codexRoots: [sessions], claudeRoots: [path.join(home, '.claude', 'projects')],
  });
  const result = manager.scan();
  // The numbers that make this dangerous: the scan itself looks fine.
  assert.equal(result.errors, 0);
  assert.equal(result.blindScan, false);
  // And the one that says otherwise.
  assert.equal(result.codexHistoryStale, true);
  assert.equal(result.codexHistoryInspected, 'exact');
  assert.match(result.codexHistoryReasons.join('\n'), /no rollout file/);

  // Persisted, so a consumer reading status() rather than the scan return sees
  // it too. The extension card reads exactly this path.
  const stats = manager.status().lastScanStats;
  assert.equal(stats.codexHistoryStale, true);
  assert.equal(stats.codexHistoryInspected, 'exact');
  assert.ok(stats.codexHistoryReasons.length >= 1);
});

// `{ skip: !exactTier }` like its five siblings, and it was the one test in this file
// that lacked it. Both assertions below name a verdict only reachable when the exact
// tier can run: with no `node:sqlite` every root answers `unavailable`, so the "one
// healthy root, one unreadable root" premise cannot be built and the worst-of is
// `unavailable` rather than `partial` — which is CORRECT behaviour, not a regression.
//
// It went red on node 20 on both platforms while passing on node 22 and 24. That is
// precisely the defect this whole test file was added to catch, reproduced inside the
// test written to catch it: an assertion that encodes the author's runtime.
test('a healthy corpus scan says so, and the detector cannot fail the scan', { skip: !exactTier }, (t) => {
  const home = codexHome(t, 'scan-ok');
  const sessions = path.join(home, '.codex', 'sessions');
  rollout(home, THREADS[0]);

  const clean = createAutoLearnManager({ home, codexRoots: [sessions] }).scan();
  assert.equal(clean.codexHistoryStale, false);
  assert.equal(clean.codexHistoryInspected, 'exact');
  assert.deepEqual(clean.codexHistoryReasons, []);

  // WORST WINS ACROSS ROOTS. One root inspected exactly does not redeem another
  // that could not be read, and rounding the pair up to `exact` is the reporting
  // failure this whole detector exists to prevent. The two roots are deliberately
  // unequal: with both healthy, an aggregator that always answered `exact` would
  // look correct.
  const second = codexHome(t, 'scan-second');
  const secondSessions = path.join(second, '.codex', 'sessions');
  rollout(second, THREADS[1]);
  fs.writeFileSync(path.join(second, '.codex', 'thread_history_1.sqlite'), 'not a database');
  const mixed = createAutoLearnManager({
    home, codexRoots: [sessions, secondSessions],
  }).scan();
  assert.equal(mixed.codexHistoryInspected, 'partial',
    'one unreadable root makes the answer for the corpus partial');
  assert.equal(mixed.codexHistoryStale, false, 'and partial is still not stale');
  assert.match(mixed.codexHistoryNotes.join('\n'), /treat this as unknown, not healthy/);

  // A probe that throws must degrade the report, never take the scan with it.
  // This is a scan-health signal; losing a whole scan to it would be a worse
  // outcome than the blindness it exists to report.
  const thrown = createAutoLearnManager({
    home, codexRoots: [sessions],
    codexHistoryStore: () => { throw new Error('probe exploded'); },
  }).scan();
  assert.equal(thrown.codexHistoryInspected, 'partial');
  assert.equal(thrown.codexHistoryStale, false);
  assert.match(thrown.codexHistoryNotes.join('\n'), /probe exploded/);
  assert.match(thrown.codexHistoryNotes.join('\n'), /staleness is unknown/);
});

// ── a runtime without node:sqlite ─────────────────────────────────────────────
//
// THIS SUITE ONCE COULD NOT REACH THE CONFIGURATION ITS USERS RAN. When these
// tests were written, `node:sqlite` existed on the Node 24 this repo is
// developed against and not in the extension hosts then in use, so every
// `exactTier` fixture exercised a tier those users did not have, and the tier
// they did have — sqlite absent — was never driven at all. VS Code 1.141.1
// (Node 24.21.0) loads it; hosts within the ^1.80 engine floor may not, so the
// `unavailable` tier stays (measured 2026-10-13), and so do these tests.
//
// What it produced when driven: `inspected: 'partial'`, a pushed note, and
// through `scanTrouble` a permanent `scan degraded` on the Auto Learn row that
// outranked the review count and could never be cleared.
//
// `unavailable` is now its own state, and the tests below pin what has to be
// true about it: it is NOT `partial`, the real finding still fires underneath
// it — archived transcripts included — and it survives the trip through the
// state file.
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

// The mask has to actually mask, or all three tests below are green over a
// runtime that still has the module and prove nothing. Asserted rather than
// assumed, and asserted in the direction that fails loudly on Node 24.
test('witness: the sqlite mask is what a Node 20 extension host looks like', () => {
  const masked = withoutNodeSqlite(() => {
    try { require('node:sqlite'); return 'loaded'; }
    catch (error) { return error.code; }
  });
  assert.equal(masked, 'MODULE_NOT_FOUND',
    'witness:sqlite-unavailable -- the Module._load hook did not intercept the require, so '
    + 'every assertion below is measuring the developer runtime instead of the shipped one');
});

test('a runtime with no node:sqlite is unavailable, which is not degraded', (t) => {
  const home = codexHome(t, 'no-sqlite');
  for (const id of THREADS) rollout(home, id);
  // A store FILE is present — that is what makes the probe attempt to run. Its
  // contents never matter here, because the require fails before the open.
  fs.writeFileSync(path.join(home, '.codex', 'thread_history_1.sqlite'), 'unopened');

  const state = withoutNodeSqlite(() => codexHistoryStoreState({ home }));

  assert.equal(state.inspected, 'unavailable',
    'witness:sqlite-unavailable -- a probe the runtime cannot host is inapplicable, not degraded. '
    + `got ${state.inspected}`);
  assert.equal(state.stale, false);
  // The wording matters as much as the state: "treat this as unknown, not
  // healthy" is the sentence that belongs to a check that RAN and failed.
  assert.doesNotMatch(state.notes.join('\n'), /treat this as unknown, not healthy/,
    'witness:sqlite-unavailable -- the degraded-check wording was reused for a check that was '
    + 'never applicable');
  assert.match(state.notes.join('\n'), /cannot run on this Node runtime/);
  // And the control, on the same corpus: a store file that IS openable and is
  // garbage is still `partial`. Without this, returning 'unavailable' for every
  // failure would pass the assertion above.
  if (exactTier) {
    assert.equal(codexHistoryStoreState({ home }).inspected, 'partial',
      'witness:sqlite-unavailable -- a store that could be opened and was not a database must '
      + 'still be a degraded check');
  }
});

test('the real finding still fires loudly with no sqlite at all', (t) => {
  // The whole risk of introducing a not-trouble state: quieting the check that
  // matters along with the noise. `stale` is computed from the session index
  // against the rollout folders, neither of which needs sqlite, so it must
  // survive.
  const home = codexHome(t, 'no-sqlite-stale');
  rollout(home, THREADS[0]);
  fs.writeFileSync(path.join(home, '.codex', 'thread_history_1.sqlite'), 'unopened');
  fs.writeFileSync(path.join(home, '.codex', 'session_index.jsonl'), [
    JSON.stringify({ id: THREADS[0] }),
    JSON.stringify({ id: THREADS[1] }),
  ].join('\n'));

  const state = withoutNodeSqlite(() => codexHistoryStoreState({ home }));
  assert.equal(state.inspected, 'unavailable');
  assert.equal(state.stale, true,
    'witness:sqlite-unavailable -- a thread with no transcript is still a stale rollout directory');
  assert.deepEqual(state.orphans, [THREADS[1]]);
  assert.match(state.reasons.join('\n'), /no rollout file/);
});

test('with no sqlite at all an archived thread is still accounted for and a missing one still found', (t) => {
  // The tier a host below the engine floor gets, and the shape of the real box:
  // one live thread, one archived, one with no transcript anywhere. Only the
  // last is an orphan, with no sqlite to read either database.
  const home = codexHome(t, 'no-sqlite-archived');
  rollout(home, THREADS[0]);
  archivedRollout(home, THREADS[1]);
  fs.writeFileSync(path.join(home, '.codex', 'thread_history_1.sqlite'), 'unopened');
  fs.writeFileSync(path.join(home, '.codex', 'state_5.sqlite'), 'unopened');
  sessionIndex(home, THREADS);

  const state = withoutNodeSqlite(() => codexHistoryStoreState({ home }));
  assert.equal(state.inspected, 'unavailable',
    'the thread-state database is a classifier and must not move the tier either way');
  assert.equal(state.stale, true);
  assert.deepEqual(state.orphans, [THREADS[2]],
    'witness:archived-orphan -- with no sqlite the archived thread was read as missing too');
  assert.equal(state.archivedFiles, 1);
});

test('unavailable survives the state file instead of decaying to skipped', (t) => {
  const home = codexHome(t, 'no-sqlite-scan');
  const sessions = path.join(home, '.codex', 'sessions');
  rollout(home, THREADS[0]);
  fs.writeFileSync(path.join(home, '.codex', 'thread_history_1.sqlite'), 'unopened');

  const manager = createAutoLearnManager({
    home, codexRoots: [sessions], claudeRoots: [path.join(home, '.claude', 'projects')],
  });
  const result = withoutNodeSqlite(() => manager.scan());
  assert.equal(result.codexHistoryInspected, 'unavailable');
  assert.equal(result.codexHistoryStale, false);

  // The reload. `scanStats` whitelists the states it will accept and rewrites
  // anything else to 'skipped', which is how a fourth state silently becomes a
  // third one on the next window.
  const reloaded = createAutoLearnManager({
    home, codexRoots: [sessions], claudeRoots: [path.join(home, '.claude', 'projects')],
  }).status().lastScanStats;
  assert.equal(reloaded.codexHistoryInspected, 'unavailable',
    'witness:sqlite-unavailable -- the persisted state was not in the reader whitelist, so a '
    + 'reload turned it back into a value the badge cannot distinguish');
});

// ── the manager: the archive is a history root by default ─────────────────────
//
// Accounting for the archive in the detector is half the fix. The other half is
// READING it: an archived thread's calls are real evidence, and the extension
// used to pin the Codex root to `sessions/` alone, so archiving a thread
// removed its calls from the corpus the moment Codex moved the file.

function archivedShellRollout(home, threadId, calls = 3) {
  const dir = path.join(home, '.codex', 'archived_sessions');
  fs.mkdirSync(dir, { recursive: true });
  const records = [{ type: 'session_meta', payload: { id: threadId, cwd: home } }];
  for (let index = 0; index < calls; index += 1) {
    const callId = `archived-${index}`;
    records.push({ type: 'response_item', payload: {
      type: 'function_call', name: 'shell_command', call_id: callId,
      arguments: JSON.stringify({ command: 'git status --short', workdir: home }),
    } });
    records.push({ type: 'response_item', payload: {
      type: 'function_call_output', call_id: callId, output: JSON.stringify({ exit_code: 0, output: 'fixture' }),
    } });
  }
  const file = path.join(dir, `rollout-2026-09-24T10-00-00-${threadId}.jsonl`);
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  return file;
}

test('the default Codex roots read an archived rollout as a Codex source', (t) => {
  const home = codexHome(t, 'manager-archive');
  archivedShellRollout(home, THREADS[0]);
  const manager = createAutoLearnManager({ home, claudeRoots: [path.join(home, '.claude', 'projects')] });
  assert.deepEqual(manager.paths.codexHistory, [
    path.join(home, '.codex', 'sessions'), path.join(home, '.codex', 'archived_sessions'),
  ]);
  const result = manager.scan({ platform: 'win32' });
  assert.equal(result.newObservations, 3,
    'witness:archived-root -- the archived rollout contributed no evidence');
  assert.equal(result.codexHistoryStale, false);
  const candidates = manager.listCandidates();
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0].sources, ['codex']);

  // The control is the old default, `sessions/` alone, on an identical corpus:
  // the archive is not read, so a passing assertion above is the root and not
  // something else in the fixture.
  const control = codexHome(t, 'manager-archive-control');
  archivedShellRollout(control, THREADS[0]);
  const old = createAutoLearnManager({
    home: control, codexRoots: [path.join(control, '.codex', 'sessions')],
    claudeRoots: [path.join(control, '.claude', 'projects')],
  }).scan({ platform: 'win32' });
  assert.equal(old.newObservations, 0);
});

test('the manager probes each Codex home once, with every root under it', (t) => {
  const home = codexHome(t, 'manager-groups');
  const sessions = path.join(home, '.codex', 'sessions');
  const archived = path.join(home, '.codex', 'archived_sessions');
  const calls = [];
  const probe = (options) => {
    calls.push(options);
    return { stale: false, inspected: 'exact', reasons: [], notes: [],
      findings: { orphans: 1, relocated: 0, projectionAhead: 2, emptyRollouts: 0 } };
  };
  const claudeRoots = [path.join(home, '.claude', 'projects')];

  const one = createAutoLearnManager({ home, claudeRoots, codexRoots: [sessions, archived], codexHistoryStore: probe }).scan();
  // ONE call for one home. Probing per root made a probe of `sessions/` alone
  // and a probe of `archived_sessions/` alone, and each read the other's
  // threads as orphans.
  assert.equal(calls.length, 1,
    `witness:probe-groups -- one Codex home was probed ${calls.length} times`);
  assert.deepEqual(calls[0].sessionsDirs, [sessions, archived]);
  assert.equal(calls[0].sessionsDir, sessions);
  assert.equal(calls[0].codexHome, path.join(home, '.codex'));
  assert.deepEqual(one.codexHistoryFindings, { orphans: 1, relocated: 0, projectionAhead: 2, emptyRollouts: 0 });

  // The control: two homes are two probes, and their findings add up.
  calls.length = 0;
  const second = codexHome(t, 'manager-groups-second');
  const secondSessions = path.join(second, '.codex', 'sessions');
  const two = createAutoLearnManager({
    home, claudeRoots, codexRoots: [sessions, archived, secondSessions], codexHistoryStore: probe,
  }).scan();
  assert.deepEqual(calls.map((call) => call.sessionsDirs), [[sessions, archived], [secondSessions]]);
  assert.deepEqual(two.codexHistoryFindings, { orphans: 2, relocated: 0, projectionAhead: 4, emptyRollouts: 0 });
});

test('codexHistoryFindings survives a reload, and a probe that throws records none', (t) => {
  const home = codexHome(t, 'manager-findings');
  rollout(home, THREADS[0]);
  sessionIndex(home, [THREADS[0], THREADS[1]]);
  const options = { home, claudeRoots: [path.join(home, '.claude', 'projects')] };

  const result = createAutoLearnManager(options).scan();
  assert.equal(result.codexHistoryStale, true);
  assert.deepEqual(result.codexHistoryFindings, { orphans: 1, relocated: 0, projectionAhead: 0, emptyRollouts: 0 });
  // The reload, which is what the panel reads after a window restart. A field
  // the whitelist does not name is dropped here, silently.
  const reloaded = createAutoLearnManager(options).status().lastScanStats;
  assert.deepEqual(reloaded.codexHistoryFindings, { orphans: 1, relocated: 0, projectionAhead: 0, emptyRollouts: 0 },
    'witness:findings-reload -- the counts the dashboard phrases its warning from did not survive a reload');

  // The control: a probe that threw has no findings to report, and saying zero
  // would claim a check that never ran found nothing.
  const thrown = createAutoLearnManager({
    ...options, codexHistoryStore: () => { throw new Error('probe exploded'); },
  }).scan();
  assert.equal(thrown.codexHistoryFindings, null);
  assert.equal(createAutoLearnManager(options).status().lastScanStats.codexHistoryFindings, null);
});
