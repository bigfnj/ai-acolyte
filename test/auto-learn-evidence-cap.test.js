'use strict';

// Evidence inflation where the two caps meet.
//
// `pruneCursors` evicts the oldest transcript's cursor and `pruneObservationHashes`
// evicts the oldest transcript's dedupe entries, so the cursor that goes is exactly
// the one whose hashes have already gone. A cursor-less file is re-read whole --
// `safeContinuation` returns false with no prior, so the mode is 'full' and a full
// read emits every observation in the file -- and every observation whose hash was
// trimmed is counted AGAIN, into the `counts.success` that `isAutoSafeCandidate`
// gates an automatic allow-list write on.
//
// These run against real transcripts through the real scanner, with tiny limits.
// A fake scanner cannot prove this: the defect lives in the interaction between
// `safeContinuation`, the full-mode observation filter and the two caps, and a
// stub that hands back a fixed observation list short-circuits all three.
//
// THE KILLING MUTATION, for whoever changes `pruneObservationHashes` next: make
// `decisive` return false, which is the old plain oldest-first trim. APPLIED, and
// all three tests below die -- the first because the two hashes of the
// below-threshold family are no longer in the state file, the second with
// `Bash(git status *)` sitting in the user's settings.json after two scans of a
// two-run family, the third because the cap has nothing left to retain.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAutoLearnManager } = require('../src/auto-learn-manager');

const GIT_KEY = 'bash:git status';

function jsonl(...records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}
function call(id, command) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  };
}
function result(id) {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok' }],
    },
  };
}
function transcript(file, pairs, mtimeSeconds) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const records = [{ type: 'session_meta', payload: { id: 'v', cwd: 'D:\\work' } }];
  for (const [id, command] of pairs) records.push(call(id, command), result(id));
  fs.writeFileSync(file, jsonl(...records));
  // Set explicitly rather than raced against the filesystem: the cursor cap
  // evicts by `mtimeMs`, and which transcript is "oldest" is the whole premise.
  fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
}

// Two transcripts, and every number here is load-bearing.
//
//   a-old.jsonl  two `git status` runs -> one family at 2 successes, threshold 3,
//                so it is BELOW the bar and a re-count would carry it over.
//   b-new.jsonl  six `rg --files` runs -> one family at 6 successes, already over
//                the bar, so its hashes are the ones the cap is allowed to trim.
//
// The `a-`/`b-` prefixes are not decoration. `scanHistoryFiles` walks its files in
// `path.localeCompare` order, so they fix which transcript's hashes go into the
// map FIRST and are therefore what a plain oldest-first trim takes. Named
// `old.jsonl` and `new.jsonl` the order inverts, the git hashes survive by
// accident, and the mutation that deletes the protection does not kill this test
// -- measured, not guessed: that is what the first draft did.
//
// The mtimes are the other half: `a-old` carries the older one, so it is also what
// the cursor cap evicts. That alignment between the two caps is the defect.
function fixture(t, prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `permission-wildcarding-${prefix}-`));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  const project = path.join(home, '.claude', 'projects', 'p');
  transcript(path.join(project, 'a-old.jsonl'), [
    ['g1', 'git status --short'],
    ['g2', 'git status --porcelain'],
  ], 1_700_000_000);
  transcript(path.join(project, 'b-new.jsonl'), Array.from({ length: 6 }, (_, index) =>
    [`r${index}`, 'rg --files src']), 1_800_000_000);
  const settings = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settings, `${JSON.stringify({ permissions: { allow: [] } }, null, 2)}\n`);
  return { home, settings, statePath: path.join(home, '.claude', 'wildcarding', 'auto-learn-state.json') };
}
function build(home, extra = {}) {
  return createAutoLearnManager({
    home,
    threshold: 3,
    codexRulesPath: null,
    // Eight live hashes against a cap of four, and two cursors against a cap of
    // one, so both caps bite on the first scan.
    observationHashLimit: 4,
    cursorLimit: 1,
    ...extra,
  });
}
function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}
function gitFamily(manager) {
  return manager.listCandidates().find((item) => item.key === GIT_KEY);
}

test('an evicted cursor cannot re-count a family over the success threshold', (t) => {
  const env = fixture(t, 'evidence-cap');
  const learn = build(env.home);

  const first = learn.scan({ platform: 'win32' });

  // Preconditions. Each one is a way this test could pass while proving nothing,
  // so each is asserted rather than assumed.
  assert.equal(first.files, 2, 'witness:evidence-cap -- both transcripts were enumerated');
  assert.ok(first.prunedCursors >= 1,
    `witness:evidence-cap -- the cursor cap has to have evicted something; got ${first.prunedCursors}`);
  assert.ok(first.prunedObservations > 0,
    `witness:evidence-cap -- the hash cap has to have trimmed something; got ${first.prunedObservations}`);

  const seeded = gitFamily(learn);
  assert.equal(seeded.counts.success, 2, 'witness:evidence-cap -- two runs seen once each');
  assert.equal(seeded.meetsThreshold, false, 'witness:evidence-cap -- and still below the bar of 3');

  const state = readState(env.statePath);
  assert.equal(Object.keys(state.cursors).length, 1,
    'witness:evidence-cap -- one cursor survived the cap, so one transcript is cursor-less');
  // The fix, stated directly: the below-threshold family keeps its dedupe
  // entries even though they are the oldest in the map.
  const keptKeys = Object.values(state.observationHashes).map((entry) => entry.key);
  assert.equal(keptKeys.filter((key) => key === GIT_KEY).length, 2,
    'witness:evidence-cap -- both hashes of the below-threshold family are held past the cap');

  // The re-read. `a-old.jsonl` has no cursor, so it comes back as a full read and
  // re-emits both of its observations.
  const second = learn.scan({ platform: 'win32' });
  assert.ok(second.observations >= 2,
    `witness:evidence-cap -- the cursor-less transcript has to be re-read; got ${second.observations}`);
  assert.equal(second.newObservations, 0,
    'witness:evidence-cap -- a re-read of bytes already accounted for is not new evidence');

  const after = gitFamily(learn);
  assert.equal(after.counts.success, 2,
    'witness:evidence-cap -- the same two runs, counted once. Four means the re-read was counted again.');
  assert.equal(after.counts.total, 2, 'witness:evidence-cap -- and nothing arrived through another outcome');
  assert.equal(after.meetsThreshold, false,
    'witness:evidence-cap -- a family with two real runs must not reach a threshold of three');
  assert.equal(after.autoSafe, false,
    'witness:evidence-cap -- and must not become eligible for an automatic write');
});

// The same defect at the surface where it costs something: `auto-safe` mode
// applies inside `scan()`, so an inflated count is an allow-list entry the user
// never earned and never reviewed.
test('auto-safe mode writes no grant a re-read manufactured', (t) => {
  const env = fixture(t, 'evidence-cap-write');
  const learn = build(env.home, { mode: 'auto-safe' });

  learn.scan({ platform: 'win32' });
  learn.scan({ platform: 'win32' });

  const allow = JSON.parse(fs.readFileSync(env.settings, 'utf8')).permissions.allow;
  assert.ok(!allow.some((entry) => /git status/.test(entry)),
    `witness:evidence-cap -- a two-run family reached the allow list: ${JSON.stringify(allow)}`);
  // The control. Without it a manager that wrote NOTHING -- a broken fixture, a
  // settings path that went nowhere, an apply that threw and was swallowed --
  // would pass the assertion above for the wrong reason.
  assert.ok(allow.some((entry) => /\brg\b/.test(entry)),
    `witness:evidence-cap -- the six-run family should have been granted: ${JSON.stringify(allow)}`);
});

// The cap can be asked to hold more than it is allowed to evict, and when that
// happens it has to say so. A cap that quietly stops capping is the shape this
// repo keeps finding, so the overflow is a reported number rather than a silence.
test('a cap that cannot evict reports the overflow instead of absorbing it', (t) => {
  const env = fixture(t, 'evidence-cap-degraded');
  // One slot, and the below-threshold family alone needs two.
  const learn = build(env.home, { observationHashLimit: 1 });

  const scanned = learn.scan({ platform: 'win32' });
  const held = Object.keys(readState(env.statePath).observationHashes).length;

  assert.ok(held > 1,
    `witness:evidence-cap -- the protected entries are over the cap of 1; got ${held}`);
  assert.equal(scanned.retainedObservations, held - 1,
    'witness:evidence-cap -- and the scan reports exactly how far over it is');
  assert.equal(readState(env.statePath).lastScanStats.retainedObservations, held - 1,
    'witness:evidence-cap -- the writer writes it, so a reload can still see the degradation');
  assert.equal(build(env.home).status().lastScanStats.retainedObservations, held - 1,
    'witness:evidence-cap -- and the reader keeps it, which is where these fields go to die');
});
