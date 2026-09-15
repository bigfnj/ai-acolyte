'use strict';

// What the WRITE path checks before it puts an entry in the user's allow list,
// and what the claims registry records about an entry that is not there. Both
// were places where the listing and the writer disagreed: the listing withheld
// a family, the writer wrote it anyway.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAutoLearnManager } = require('../src/auto-learn-manager');

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'permission-wildcarding-writegate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function observed(id, command, status = 'success') {
  return { id, source: 'claude', tool: 'Bash', command, status };
}
function scannerFeed(observations) {
  return () => ({
    observations,
    cursors: { [`path-sha256:${'a'.repeat(24)}`]: { source: 'claude', size: 100, offset: 100 } },
    files: [{ source: 'claude', mode: 'full' }],
  });
}
function manager(home, observations, options = {}) {
  return createAutoLearnManager({
    home, historyScanner: scannerFeed(observations), codexRulesPath: null,
    codexValidator: () => ({ valid: true, decision: 'allow' }), ...options,
  });
}
function writeSettings(home, value) {
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}
function readSettings(home) {
  return JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
}
function readClaims(home) {
  return JSON.parse(fs.readFileSync(
    path.join(home, '.claude', 'wildcarding', 'claude-policy-claims.json'), 'utf8'));
}
const THREE_GIT_STATUS = [
  observed('g1', 'git status'), observed('g2', 'git status --short'), observed('g3', 'git status'),
];

// ── the user's own deny list ──────────────────────────────────────────────────

test('a family the user has denied is withheld rather than written and reported as applied', (t) => {
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: [], deny: ['Bash(git status:*)'] } });
  const learn = manager(home, THREE_GIT_STATUS);
  learn.scan();

  const result = learn.apply();
  assert.equal(result.appliedCount, 0, 'deny wins, so there was nothing to apply');
  assert.deepEqual(readSettings(home).permissions.allow, [],
    'no dead entry is written for a family the user already blocks');

  const [withheld] = result.withheldByPolicy;
  assert.equal(withheld.key, 'bash:git status');
  assert.equal(withheld.rule, 'Bash(git status:*)',
    'the report names the deny entry that beat it, not just a verdict');
  assert.equal(withheld.source, 'user-deny');
});

test('a deny that does not cover the family does not withhold it', (t) => {
  // The control. Without it, a gate that withheld everything would pass the
  // test above, and this path is exactly where "quiet by design" hides a bug.
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: [], deny: ['Bash(git push:*)'] } });
  const learn = manager(home, THREE_GIT_STATUS);
  learn.scan();

  const result = learn.apply();
  assert.deepEqual(result.withheldByPolicy, []);
  assert.deepEqual(readSettings(home).permissions.allow, ['Bash(git status *)']);
});

// ── claims against entries the file no longer holds ───────────────────────────

test('an entry a live wildcard covers is claimed with the parent named, not written again', (t) => {
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: [] } });
  const learn = manager(home, THREE_GIT_STATUS);
  learn.scan();
  learn.apply();
  assert.deepEqual(readSettings(home).permissions.allow, ['Bash(git status *)']);
  assert.equal(readClaims(home).permissions['Bash(git status *)'].managed, true);

  // What the wildcarding pass does after an apply: the narrow entry is pruned
  // because a broader one covers it. Measured 2026-09-03 as 8 of 12 entries.
  writeSettings(home, { permissions: { allow: ['Bash(git *)'] } });

  learn.apply();
  assert.deepEqual(readSettings(home).permissions.allow, ['Bash(git *)'],
    'the pruned child is not written back; that churn is what the pass would undo again');

  const record = readClaims(home).permissions['Bash(git status *)'];
  assert.equal(record.coveredBy, 'Bash(git *)',
    'the registry says WHY the claimed entry is absent, which is the half a reconcile would lose');
  assert.equal(record.managed, false,
    'this claimant is not holding the entry, so releasing the claim must not pretend to remove it');
  assert.ok(record.claimants.length > 0, 'the claim itself is kept, not dropped');
});

test('an entry the file simply does not have is still claimed as managed', (t) => {
  // The control for the one above: absent-and-uncovered is the case where the
  // tool really did introduce the entry, and it must keep saying so.
  const home = tempHome(t);
  writeSettings(home, { permissions: { allow: [] } });
  const learn = manager(home, THREE_GIT_STATUS);
  learn.scan();
  learn.apply();

  const record = readClaims(home).permissions['Bash(git status *)'];
  assert.equal(record.managed, true);
  assert.equal(record.coveredBy, undefined);
});
