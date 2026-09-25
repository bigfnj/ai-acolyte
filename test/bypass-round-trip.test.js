'use strict';

// The bypass toggle's OFF half, which nothing exercised.
//
// `--bypass on` had three tests (test/cli-hook.test.js:171, :202, :277). `--bypass off`
// had none, in any file, and OFF is the only reader of the sidecar stash: applyBypass
// writes { savedMode } on the way in and reads it back on the way out, so "turning it OFF
// restores exactly what you had" -- the sentence src/permissions.js:494 promises -- rested
// on a line no test could reach.
//
// MEASURED, not assumed. `readBypassState` was on test/dead-exports.test.js's
// PENDING_REMOVAL list as a dead export over a live function. Mutating it to `return {}`
// on 2026-09-25 left the whole suite green at 696/694 -- so the restore silently
// degraded to FALLBACK_MODE and nothing said a word. That is what makes this a coverage
// gap rather than a deletion: eleven of the thirteen names on that list died under the
// same treatment.
//
// THE MUTATION THIS FILE EXISTS TO KILL:
//   src/permissions.js readBypassState -> `return {};`
// Both assertions below fail: the stash reads empty, and the OFF transition lands on
// 'default' instead of the mode that was stashed.
//
// Its own process, and os.homedir() is stubbed BEFORE src/permissions is required,
// because BYPASS_STATE_FILE is computed once at module scope (src/permissions.js:510).
// node --test gives each file its own child process, so the stub cannot leak.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-bypass-'));
const realHomedir = os.homedir;
os.homedir = () => HOME;
const { applyBypass, readBypassState, currentMode, isBypassOn } = require('../src/permissions');
os.homedir = realHomedir;

const STASH = path.join(HOME, '.claude', 'backups', 'wildcarding-bypass.json');

after(() => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

test('precondition: the stub took, so this file is not writing to the real home', () => {
  assert.notEqual(HOME, realHomedir(), 'witness:bypass-round-trip -- os.homedir stub');
  assert.ok(STASH.startsWith(HOME), `the sidecar resolved outside the sandbox: ${STASH}`);
  // The module captured the stubbed home. If it did not, every assertion below would be
  // read against ~/.claude/backups and this file would be a live-fire test.
  applyBypass({ permissions: { defaultMode: 'plan' } }, true);
  assert.equal(fs.existsSync(STASH), true,
    'witness:bypass-round-trip -- the stash landed inside the sandbox');
});

test('bypass off restores the exact mode bypass on stashed', () => {
  try { fs.rmSync(STASH, { force: true }); } catch { /* first run */ }
  const before = { permissions: { defaultMode: 'plan', allow: ['Bash(rg *)'] } };

  const on = applyBypass(before, true);
  assert.equal(on.changed, true);
  assert.equal(on.to, 'bypassPermissions');
  assert.equal(isBypassOn(on.settings), true);
  // The stash is the whole mechanism, and this is the assertion the mutation kills.
  assert.equal(readBypassState().savedMode, 'plan',
    'the previous mode was not stashed, so OFF has nothing to restore from');

  const off = applyBypass(on.settings, false);
  assert.equal(off.changed, true);
  assert.equal(off.from, 'bypassPermissions');
  assert.equal(off.to, 'plan',
    'OFF fell back to the default instead of restoring the stashed mode');
  assert.equal(currentMode(off.settings), 'plan');
  // Everything else in the file survives the round trip; the toggle owns one key.
  assert.deepEqual(off.settings.permissions.allow, ['Bash(rg *)']);
});

test('a no-op toggle leaves the stash alone', () => {
  applyBypass({ permissions: { defaultMode: 'acceptEdits' } }, true);
  assert.equal(readBypassState().savedMode, 'acceptEdits');
  // Already on: `changed: false`, and the stash must NOT be overwritten with
  // 'bypassPermissions', which would make the next OFF restore bypass onto itself.
  const again = applyBypass({ permissions: { defaultMode: 'bypassPermissions' } }, true);
  assert.equal(again.changed, false);
  assert.equal(readBypassState().savedMode, 'acceptEdits',
    'a second ON overwrote the stash with the bypass mode itself');
});

test('with no stash at all, off lands on the documented fallback', () => {
  fs.rmSync(STASH, { force: true });
  assert.deepEqual(readBypassState(), {}, 'an absent sidecar reads as {}, never a throw');
  const off = applyBypass({ permissions: { defaultMode: 'bypassPermissions' } }, false);
  assert.equal(off.to, 'default');
});
