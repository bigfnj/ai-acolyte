'use strict';

// `state.managedClaude` records which allow-list entries this claimant wrote,
// and `applyUnlocked` re-keys it BY PERMISSION, because one family can render
// more than one spelling of the same grant. The normalizer went on cleaning the
// key to 512 characters while cleaning the value beside it to 768 -- the length
// a permission is actually allowed -- so the key was a TRUNCATION of its own
// value, and two permissions sharing a 512-character prefix collapsed onto one
// entry. The second silently replaced the first.
//
// What that costs is not cosmetic. `releaseClaudeGrants` passes
// `Object.values(grantsBefore.managedClaude)` to `updateClaudeClaims` as the set
// of permissions to restore, so a grant lost here is a grant `undo()` does not
// put back and a claim the registry stops holding on another workspace's behalf.
//
// Is a 513-to-768-character permission real? It is what a long `Bash(...)`
// prefix with a path and several flags renders to, and `clean(..., 768)` exists
// precisely because the project decided that length is legitimate. Nothing
// anywhere shortens a permission to 512 before it reaches this map.
//
// MUTATION APPLIED: put `clean(key, 512)` back in `managedClaude`. Both tests
// below fail, the first with one surviving entry instead of two.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAutoLearnManager } = require('../src/auto-learn-manager');

// 512 characters of shared prefix, then a tail that differs. Plain letters, so
// `clean`'s whitespace collapsing and control-character stripping cannot be
// what separates them -- only the length cap can.
const SHARED = `Bash(${'a'.repeat(507)}`;
const LONG_ONE = `${SHARED}${'x'.repeat(80)} *)`;
const LONG_TWO = `${SHARED}${'y'.repeat(80)} *)`;

function statePathFor(home) {
  return path.join(home, '.claude', 'wildcarding', 'auto-learn-state.json');
}
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-managed-keys-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  const file = statePathFor(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1, mode: 'recommend', threshold: 3,
    candidates: {}, observationHashes: {}, cursors: {},
    applied: { claude: [], codex: [] }, reviewed: { claude: [], codex: [] },
    codexTargets: {}, managedClaude: { [LONG_ONE]: LONG_ONE, [LONG_TWO]: LONG_TWO },
    managedHits: {}, managedHitsAt: null,
    derivedGuidance: { accepted: [], declined: [] }, prunedCandidates: {},
    lastScanAt: null, lastScanStats: null, lastApplication: null,
  }, null, 2)}\n`);
  return { home, file };
}
function build(home) {
  return createAutoLearnManager({
    home, threshold: 3, codexRulesPath: null,
    historyScanner: () => ({ observations: [], cursors: {}, files: [] }),
  });
}

test('two permissions sharing a 512-character prefix are two grants, not one', (t) => {
  const env = fixture(t);
  assert.notEqual(LONG_ONE, LONG_TWO, 'witness:managed-claude-keys -- fixture sanity');
  assert.equal(LONG_ONE.slice(0, 512), LONG_TWO.slice(0, 512),
    'witness:managed-claude-keys -- they have to be indistinguishable at 512 characters');
  assert.ok(LONG_ONE.length > 512 && LONG_ONE.length <= 768,
    `witness:managed-claude-keys -- and legal at 768; got ${LONG_ONE.length}`);

  // A write, so the value goes out through `persistentState` as well as in
  // through `sanitizeState`: the truncation was in a normalizer both directions
  // share, and a round trip is what a long-lived state file actually does.
  const learn = build(env.home);
  learn.setMode('observe');

  const after = JSON.parse(fs.readFileSync(env.file, 'utf8'));
  const values = Object.values(after.managedClaude).sort();
  assert.deepEqual(values, [LONG_ONE, LONG_TWO].sort(),
    `witness:managed-claude-keys -- both grants have to survive the round trip; kept ${values.length}`);
  assert.equal(Object.keys(after.managedClaude).length, 2,
    'witness:managed-claude-keys -- under two distinct keys, not collapsed onto one');
});

test('the key is a lossless spelling of the permission it stands for', (t) => {
  const env = fixture(t);
  build(env.home).setMode('observe');

  const after = JSON.parse(fs.readFileSync(env.file, 'utf8'));
  for (const [key, permission] of Object.entries(after.managedClaude)) {
    assert.equal(key, permission,
      'witness:managed-claude-keys -- `applyUnlocked` writes permission-to-itself, and a key '
      + 'that is a truncated copy of its own value is the shape the collision came from');
  }
});
