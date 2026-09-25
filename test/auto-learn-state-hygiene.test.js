'use strict';

// The state file is long-lived, shared by several installed copies of this
// tool, and three of its structures used to grow without a cap or a prune.
// These tests pin the four hygiene mechanisms that answer that: the version
// gate, the cursor cap, the candidate cap and its tombstones, and the grant-key
// reconciliation -- plus the two things a scan reports about itself that a
// reload used to discard.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAutoLearnManager, migrateStateTo } = require('../src/auto-learn-manager');

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-hygiene-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function statePathFor(home) {
  return path.join(home, '.claude', 'wildcarding', 'auto-learn-state.json');
}
function writeState(home, value) {
  const file = statePathFor(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}
function readState(home) {
  return JSON.parse(fs.readFileSync(statePathFor(home), 'utf8'));
}
function observed(id, command, status = 'success') {
  return { id, source: 'claude', tool: 'Bash', command, status };
}
// A scanner whose enumeration the test controls: `files` is what decides
// whether a scan counts as blind, and `cursors` is what the map is replaced
// from when it does not.
function scanner({ observations = [], cursors = {}, files = [{ source: 'claude', mode: 'full' }] } = {}) {
  return () => ({ observations, cursors, files });
}
function manager(home, scan, options = {}) {
  return createAutoLearnManager({
    home, historyScanner: scan, codexRulesPath: null,
    codexValidator: () => ({ valid: true, decision: 'allow' }),
    ...options,
  });
}
function cursorKey(index) {
  return `path-sha256:${String(index).padStart(24, '0')}`;
}
function baseState(extra = {}) {
  return {
    version: 1, mode: 'recommend', threshold: 3, candidates: {}, observationHashes: {},
    cursors: {}, applied: { claude: [], codex: [] }, reviewed: { claude: [], codex: [] },
    codexTargets: {}, managedClaude: {}, managedHits: {}, managedHitsAt: null,
    derivedGuidance: { accepted: [], declined: [] }, prunedCandidates: {},
    lastScanAt: null, lastScanStats: null, lastApplication: null, ...extra,
  };
}
function storedCandidate(key, counts) {
  const [shell, command] = key.split(':');
  const prefix = command.split(' ');
  return {
    key, tool: shell === 'powershell' ? 'PowerShell' : 'Bash', kind: 'shell', shell,
    root: prefix[0], prefix, claudePermission: null, permissions: [], risk: 'unknown',
    baseAutoSafe: false, complex: false, reasons: [], sources: ['claude'],
    counts: { success: 0, failed: 0, unknown: 0, total: 0, ...counts },
  };
}

// ── the version gate ──────────────────────────────────────────────────────────

test('a state file from an unsupported older version is reset, not half-read', (t) => {
  const home = tempHome(t);
  writeState(home, baseState({
    version: 0,
    candidates: { 'bash:git status': storedCandidate('bash:git status', { success: 9 }) },
    applied: { claude: ['bash:git status'], codex: [] },
  }));
  const learn = manager(home, scanner());
  const status = learn.status();
  assert.equal(status.candidateCount, 0,
    'version 0 has no registered migration, so the state is reset rather than read');
  assert.deepEqual(status.applied.claude, [],
    'a reset drops the grants too; a half-read state is the thing being refused');
});

test('a state file the running code is current with is read normally', (t) => {
  const home = tempHome(t);
  writeState(home, baseState({
    candidates: { 'bash:git status': storedCandidate('bash:git status', { success: 9 }) },
  }));
  // The control for the test above: same state, declared version 1, and the
  // candidate survives. Without it a reset-everything bug would pass that test.
  assert.equal(manager(home, scanner()).status().candidateCount, 1);
});

test('a state file written by a NEWER copy of the tool is read but never written over', (t) => {
  const home = tempHome(t);
  writeState(home, baseState({
    version: 99,
    candidates: { 'bash:git status': storedCandidate('bash:git status', { success: 9 }) },
    managedHits: { 'Bash(git push:*)': { hits: 4, tools: ['Bash'] } },
  }));
  const learn = manager(home, scanner({ observations: [observed('a', 'rg --files src')] }));

  // Reading is still allowed: refusing that would break `--learn status` on a
  // machine mid-upgrade, and reading cannot lose a field.
  assert.equal(learn.status().candidateCount, 1);

  assert.throws(() => learn.scan(), /version 1 over version 99/,
    'writing this copy\'s whitelist back would silently drop the newer copy\'s fields');

  const after = readState(home);
  assert.equal(after.version, 99, 'the file on disk is untouched');
  assert.deepEqual(after.managedHits, { 'Bash(git push:*)': { hits: 4, tools: ['Bash'] } },
    'the field an older copy would have dropped is still there');
});

// ── the version floor, which this module's own ladder cannot reach ────────────

// `MIN_SUPPORTED_VERSION` and `VERSION` are both 1 and `STATE_MIGRATIONS` is
// empty, so every state the floor rejects is a state the missing-step check
// rejects on the very next line. MEASURED, not assumed: mutating the floor to
// `if (false) return null` leaves the whole suite green, "a state file from an
// unsupported older version is reset" above included, because version 0 falls
// out of the `while` for want of a migration and returns null anyway. Two
// doors, one reachable.
//
// The case where the two doors DISAGREE is exactly the one a version bump
// creates: a ladder that has a migration for a version below the floor, where
// the missing-step door is wide open and only the floor refuses. `VERSION`
// cannot be raised here to reach it -- bumping it against an empty
// `STATE_MIGRATIONS` resets every user's state file -- so `migrateStateTo`
// takes the ladder as a parameter and these drive it with a synthetic one.

test('the version floor refuses a state the migration chain could otherwise climb', () => {
  const migrations = new Map([
    [1, (raw) => ({ ...raw, version: 2, climbed: [...(raw.climbed || []), 1] })],
    [2, (raw) => ({ ...raw, version: 3, climbed: [...(raw.climbed || []), 2] })],
  ]);
  const ladder = { version: 3, minSupported: 2, migrations };
  const ancient = { version: 1, mode: 'observe' };

  // The control, and this test is worthless without it: the same input against
  // the same migrations with the floor lowered climbs both rungs. So the null
  // below is the floor's doing and not a missing step.
  assert.deepEqual(migrateStateTo(ancient, { ...ladder, minSupported: 1 }).climbed, [1, 2],
    'witness:version-floor -- the chain really can carry a version 1 state up to 3');

  assert.equal(migrateStateTo(ancient, ladder), null,
    'witness:version-floor -- below the floor is a reset even when every migration exists');

  // At the floor, not below it, so this one is read and migrated.
  assert.deepEqual(migrateStateTo({ version: 2, mode: 'observe' }, ladder).climbed, [2],
    'witness:version-floor -- the floor is inclusive; a state AT it is still readable');
});

test('a missing migration step is still its own reason to reset', () => {
  // The other door, kept honest. With the floor at 1 and no step registered for
  // 1, the `while` is what refuses -- so neither check is standing in for the
  // other and removing either one is visible from here.
  const ladder = { version: 3, minSupported: 1, migrations: new Map([[2, (raw) => raw]]) };
  assert.equal(migrateStateTo({ version: 1 }, ladder), null,
    'witness:version-floor -- no step for version 1, so the chain cannot be climbed');
  // And a state from a newer build is handed back untouched rather than reset,
  // which is what lets `save()` refuse to write over it.
  const newer = { version: 9, mode: 'observe' };
  assert.equal(migrateStateTo(newer, ladder), newer,
    'witness:version-floor -- a newer state is readable, not resettable');
});

// ── what a scan reports about itself ──────────────────────────────────────────

test('a scan that could not enumerate anything says so, and the flag survives a reload', (t) => {
  const home = tempHome(t);
  const cursors = { [cursorKey(1)]: { source: 'claude', size: 10, offset: 10, mtimeMs: 1 } };
  const seeded = manager(home, scanner({ cursors }));
  seeded.scan();
  assert.equal(seeded.status().lastScanStats.blindScan, false,
    'an ordinary scan is not blind');

  // Nothing but root-walk failures: the corpus was not looked at, so the cursor
  // map is preserved and the caller has to be told why.
  const blind = manager(home, scanner({
    cursors: {},
    files: [{ source: 'claude', mode: 'error', scope: 'root', error: 'EACCES' }],
  }));
  const result = blind.scan();
  assert.equal(result.blindScan, true);
  assert.equal(Object.keys(readState(home).cursors).length, 1,
    'the preserved map is what the flag is reporting on');

  // The reload is the point: `sanitizeState` rebuilt three fields and dropped
  // the rest, so a flag written by the scan vanished the moment it was read back.
  assert.equal(manager(home, scanner()).status().lastScanStats.blindScan, true);
});

test('prunedObservations survives a reload instead of being dropped by the reader', (t) => {
  const home = tempHome(t);
  // `threshold: 1`, so the two-run family is at the bar and its dedupe entries
  // are trimmable. Below the bar they are held whatever their age -- see
  // `pruneObservationHashes` -- and this test would then be measuring the
  // reload of a field the cap was never allowed to set.
  const learn = manager(home, scanner({
    observations: [observed('a', 'rg --files src'), observed('b', 'rg --files test')],
  }), { observationHashLimit: 1, threshold: 1 });
  const result = learn.scan();
  assert.equal(result.prunedObservations, 1, 'the cap trimmed one hash');
  assert.equal(readState(home).lastScanStats.prunedObservations, 1, 'and the writer wrote it');

  assert.equal(manager(home, scanner()).status().lastScanStats.prunedObservations, 1,
    'the reader has to keep the field the writer writes');
});

// ── the cursor cap ────────────────────────────────────────────────────────────

test('cursors are capped even on the blind path, oldest transcript evicted first', (t) => {
  const home = tempHome(t);
  const cursors = {};
  for (let index = 1; index <= 5; index += 1) {
    cursors[cursorKey(index)] = { source: 'claude', size: 10, offset: 10, mtimeMs: index * 1000 };
  }
  manager(home, scanner({ cursors }), { cursorLimit: 5 }).scan();
  assert.equal(Object.keys(readState(home).cursors).length, 5);

  // The blind path is the one with no other pruning mechanism: the map is
  // preserved wholesale, so without a cap it can only ever grow.
  const blind = manager(home, scanner({
    cursors: {},
    files: [{ source: 'claude', mode: 'error', scope: 'root', error: 'EACCES' }],
  }), { cursorLimit: 3 });
  const result = blind.scan();
  assert.equal(result.blindScan, true, 'this has to be the preserved-map path or it proves nothing');
  assert.equal(result.prunedCursors, 2);

  const kept = Object.keys(readState(home).cursors).sort();
  assert.deepEqual(kept, [cursorKey(3), cursorKey(4), cursorKey(5)].sort(),
    'the three newest transcripts keep their offsets; the two oldest are re-read');
});

// ── the candidate cap ─────────────────────────────────────────────────────────

test('the candidate cap evicts the cheapest evidence and never a decision', (t) => {
  const home = tempHome(t);
  writeState(home, baseState({
    threshold: 3,
    candidates: {
      // Below threshold, cheapest first: these are the evictable ones.
      'bash:aa one': storedCandidate('bash:aa one', { unknown: 1, total: 1 }),
      'bash:bb two': storedCandidate('bash:bb two', { success: 2, total: 2 }),
      // At threshold, so it has earned its place.
      'bash:cc three': storedCandidate('bash:cc three', { success: 5, total: 5 }),
      // Below threshold, but a human applied it: a decision outranks a count.
      'bash:dd four': storedCandidate('bash:dd four', { success: 1, total: 1 }),
    },
    applied: { claude: ['bash:dd four'], codex: [] },
  }));
  const learn = manager(home, scanner(), { candidateLimit: 2, threshold: 3 });
  const result = learn.scan();
  assert.equal(result.prunedCandidates, 2);

  const after = readState(home);
  assert.deepEqual(Object.keys(after.candidates).sort(), ['bash:cc three', 'bash:dd four'],
    'the at-threshold family and the applied one survive; the two cheapest go');
  assert.deepEqual(after.prunedCandidates, { 'bash:aa one': 1, 'bash:bb two': 2 },
    'a tombstone keeps the family name and its run total, which is the evidence');
  assert.equal(learn.status().prunedCandidateCount, 2,
    'and the count is reported, not merely stored');
});

test('eviction order is by run count, not by key order', (t) => {
  const home = tempHome(t);
  // `zz` is cheapest and `aa` is dearest, so a pass that evicted in key order
  // would drop `aa` and keep `zz`. Both are below threshold and unapplied, so
  // the run count is the only thing that can separate them.
  writeState(home, baseState({
    threshold: 3,
    candidates: {
      'bash:aa one': storedCandidate('bash:aa one', { success: 2, total: 2 }),
      'bash:zz two': storedCandidate('bash:zz two', { unknown: 1, total: 1 }),
    },
  }));
  manager(home, scanner(), { candidateLimit: 1, threshold: 3 }).scan();
  assert.deepEqual(Object.keys(readState(home).candidates), ['bash:aa one']);
});

// ── grant keys against candidates ─────────────────────────────────────────────

test('an applied key with no candidate is reconciled away, the way observation hashes are', (t) => {
  const home = tempHome(t);
  writeState(home, baseState({
    candidates: { 'bash:git status': storedCandidate('bash:git status', { success: 5, total: 5 }) },
    // `sanitizeState` drops a candidate whose key or prefix fails validation
    // while `applied()` keeps every key verbatim, so this shape is reachable
    // from an ordinary state file rather than only by hand.
    applied: { claude: ['bash:git status', 'bash:ghost gone'], codex: [] },
    reviewed: { claude: ['bash:ghost gone'], codex: [] },
  }));
  const learn = manager(home, scanner());
  const result = learn.scan();
  assert.equal(result.prunedGrants, 2, 'one applied key and one reviewed key');

  const after = readState(home);
  assert.deepEqual(after.applied.claude, ['bash:git status'],
    'the orphan is gone and the live grant is untouched');
  assert.deepEqual(after.reviewed.claude, []);
});
