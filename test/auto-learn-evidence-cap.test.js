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

// ── the ceiling the protected set did not have ────────────────────────────────
//
// REPORTING A BREACH IS NOT BOUNDING IT. The test that used to sit here asserted
// the map was allowed to stay OVER its limit as long as it said so, and that was
// the defect rather than the contract: `decisive` asks only about
// `counts.success` while `counts.failed` only ever grows, so a family that fails
// for ever is below the threshold for ever and retained one hash per observation
// with nothing able to evict it. On a 5-minute interval over a file that is read
// and rewritten whole, that is unbounded I/O, not just unbounded disk.
//
// `limit` is a hard ceiling now, in two tiers, and the three tests below pin the
// three claims that make the second tier safe: it gets under the cap, it cannot
// inflate a count while doing so, and it never touches a family a human decided
// about.

// One big below-threshold family and two small ones. FAILED runs throughout,
// because a failure is what keeps a family below the success threshold for ever
// and is therefore what makes the protected set grow without bound. Measured
// shapes, not guessed: `bash:curl` 6 hashes, `bash:npm` 2, `bash:docker ps` 2.
function failingFixture(t, prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `permission-wildcarding-${prefix}-`));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  const project = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(project, { recursive: true });
  const records = [{ type: 'session_meta', payload: { id: 'v', cwd: 'D:\\work' } }];
  let n = 0;
  const add = (command, count) => {
    for (let i = 0; i < count; i += 1) {
      const id = `x${n += 1}`;
      records.push(call(id, command), {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'boom' }],
        },
      });
    }
  };
  add('curl -sS https://a.example/thing', 6);
  add('npm ls --depth 0', 2);
  add('docker ps -a', 2);
  fs.writeFileSync(path.join(project, 'a.jsonl'), jsonl(...records));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
    `${JSON.stringify({ permissions: { allow: [] } }, null, 2)}\n`);
  return { home, statePath: path.join(home, '.claude', 'wildcarding', 'auto-learn-state.json') };
}
function heldPerFamily(statePath) {
  const perFamily = {};
  for (const value of Object.values(readState(statePath).observationHashes)) {
    perFamily[value.key] = (perFamily[value.key] || 0) + 1;
  }
  return perFamily;
}

test('the protected set is bounded, and what it evicts leaves a tombstone', (t) => {
  const env = failingFixture(t, 'evidence-ceiling');
  // Ten protected hashes against five slots, so the second tier has to fire.
  const learn = createAutoLearnManager({
    home: env.home, threshold: 3, codexRulesPath: null, observationHashLimit: 5,
  });

  const scanned = learn.scan({ platform: 'win32' });
  assert.equal(scanned.observations, 10, 'witness:evidence-ceiling -- the fixture was read');

  const held = Object.keys(readState(env.statePath).observationHashes).length;
  assert.ok(held <= 5,
    `witness:evidence-ceiling -- the map is over its own hard ceiling; held ${held} against 5`);
  assert.equal(scanned.retainedObservations, 0,
    'witness:evidence-ceiling -- nothing is protected here, so nothing may overflow');

  // Not thrown away silently. The family that paid leaves the same record
  // `pruneCandidates` leaves, so "this family was observed, N times" survives.
  const state = readState(env.statePath);
  assert.equal(state.candidates['bash:curl'], undefined,
    'witness:evidence-ceiling -- the evicted family is still a live candidate');
  assert.equal(state.prunedCandidates['bash:curl'], 6,
    'witness:evidence-ceiling -- the eviction left no tombstone, so the run total is lost');
  assert.ok(scanned.prunedCandidates >= 1,
    `witness:evidence-ceiling -- a family left the state and the scan reported 0; got ${scanned.prunedCandidates}`);
});

test('the family that pays is the one holding the most hashes', (t) => {
  // THE EVICTION ORDER, and it is the opposite of `pruneCandidates`'s. That cap
  // is one entry per family, so every eviction frees the same amount and the
  // cheapest evidence should go. This one is per HASH: one pathological family
  // can hold thousands while a thousand ordinary ones hold two each, so evicting
  // cheapest-first would delete a thousand families to free what one frees.
  const env = failingFixture(t, 'evidence-ceiling-order');
  createAutoLearnManager({
    home: env.home, threshold: 3, codexRulesPath: null, observationHashLimit: 5,
  }).scan({ platform: 'win32' });

  const perFamily = heldPerFamily(env.statePath);
  assert.deepEqual(perFamily, { 'bash:npm': 2, 'bash:docker ps': 2 },
    'witness:evidence-ceiling -- evicting the 6-hash family alone gets under the cap of 5. '
    + `Cheapest-first takes both small families first and still has to take the big one: ${JSON.stringify(perFamily)}`);
  const state = readState(env.statePath);
  assert.ok(state.candidates['bash:npm'] && state.candidates['bash:docker ps'],
    'witness:evidence-ceiling -- the small families were evicted to free space one eviction '
    + 'of the large one would have freed');
});

test('a family a human decided about is never the one evicted', (t) => {
  // The residue, and the only thing `retainedObservations` can still report. A
  // grant is a human decision, `pruneCandidates` already refuses to evict one,
  // and this cap has to refuse too -- otherwise it could orphan a grant key that
  // `pruneGrantKeys` reconciled on the line above it.
  const env = failingFixture(t, 'evidence-ceiling-granted');
  createAutoLearnManager({
    home: env.home, threshold: 3, codexRulesPath: null, observationHashLimit: 100000,
  }).scan({ platform: 'win32' });

  const seeded = readState(env.statePath);
  assert.equal(seeded.candidates['bash:curl'].counts.failed, 6,
    'witness:evidence-ceiling -- precondition: the family to be granted is the big one');
  seeded.reviewed = { claude: ['bash:curl'], codex: [] };
  fs.writeFileSync(env.statePath, `${JSON.stringify(seeded, null, 2)}\n`);

  const scanned = createAutoLearnManager({
    home: env.home, threshold: 3, codexRulesPath: null, observationHashLimit: 5,
  }).scan({ platform: 'win32' });

  const perFamily = heldPerFamily(env.statePath);
  assert.equal(perFamily['bash:curl'], 6,
    `witness:evidence-ceiling -- the reviewed family was evicted: ${JSON.stringify(perFamily)}`);
  assert.equal(readState(env.statePath).candidates['bash:curl'].counts.failed, 6,
    'witness:evidence-ceiling -- and its evidence is intact');
  // It cannot get under the cap without touching that family, so it says so
  // rather than pretending. This is the one reachable path left to the number.
  assert.equal(scanned.retainedObservations, 1,
    'witness:evidence-ceiling -- six protected hashes against a cap of five is an overflow of '
    + `one, and the scan has to report it; got ${scanned.retainedObservations}`);
  assert.equal(readState(env.statePath).lastScanStats.retainedObservations, 1,
    'witness:evidence-ceiling -- the writer writes it, so a reload can still see the degradation');
  assert.equal(build(env.home).status().lastScanStats.retainedObservations, 1,
    'witness:evidence-ceiling -- and the reader keeps it, which is where these fields go to die');
});
