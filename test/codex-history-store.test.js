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

// `node:sqlite` is absent on Node 20 and flagged on Node 22. The exact tier is
// unreachable there, and a skip that does not say so is a silent pass.
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

// The real schema, reduced to the columns the detector reads. Column names and
// table names are copied from the live store rather than invented, because a
// fixture whose schema is wrong proves the detector works on a database Codex
// does not write.
function threadStore(home, threadIds, { name = 'thread_history_1.sqlite' } = {}) {
  const file = path.join(home, '.codex', name);
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
  for (const id of threadIds) insert.run(id, 4096, 14);
  db.close();
  return file;
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

test('an applied rollout migration is itself a reason, before anything has diverged', (t) => {
  const home = codexHome(t, 'migration');
  rollout(home, THREADS[0]);
  const dir = path.join(home, '.codex', 'rollout-migrations');
  fs.mkdirSync(dir, { recursive: true });

  // Empty is the state measured on the real box, and it is NOT a reason.
  assert.equal(codexHistoryStoreState({ home }).stale, false);

  fs.writeFileSync(path.join(dir, '0001-move-to-thread-store.applied'), 'done\n');
  const state = codexHistoryStoreState({ home });
  assert.equal(state.stale, true);
  assert.match(state.reasons.join('\n'), /rollout migration/);
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

// ── the runtime every user actually has ───────────────────────────────────────
//
// THIS SUITE COULD NOT REACH THE ONLY CONFIGURATION THAT SHIPS. `node:sqlite`
// exists on the Node 24 this repo is developed against and on nothing the
// product runs inside: the VS Code extension host is Node 20 or 22, where the
// require above fails. So every `exactTier` fixture here exercised a tier no
// user has, and the tier every user DOES have — sqlite absent — was never
// driven at all.
//
// What it produced when driven: `inspected: 'partial'`, a pushed note, and
// through `scanTrouble` a permanent `scan degraded` on the Auto Learn row that
// outranked the review count and could never be cleared.
//
// `unavailable` is now its own state, and the three tests below pin the three
// things that have to be true about it: it is NOT `partial`, the real finding
// still fires underneath it, and it survives the trip through the state file.
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
  // matters along with the noise. `stale` is computed from the session index and
  // the migration directory, neither of which needs sqlite, so it must survive.
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
