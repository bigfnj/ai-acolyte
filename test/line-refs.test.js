'use strict';

// Every `file:line` reference this repo writes about itself must at least RESOLVE.
//
// The repo documents its own internals by line number, in BACKLOG.md and in code
// comments, and those numbers rot on the next edit. BACKLOG.md's own dead-code
// audit records "~60 stale file:line refs"; `scripts/check-line-refs.js` counts
// the real population at over 150. Two references written during a single change
// were wrong within hours, and two written while fixing THIS cluster were wrong
// within minutes, because a three-line edit to a module header moved everything
// several hundred lines below it.
//
// WHAT THIS ASSERTS, AND WHY IT IS DELIBERATELY NARROW.
//
// Only the objective half: the referenced file exists in the tree, and the
// referenced line exists inside it. Nothing here reads the prose.
//
// The checker's richer STALE verdict is NOT asserted, on purpose. That verdict
// depends on recovering the right anchor from surrounding prose, and it picks a
// neighbouring symbol often enough that asserting it would fail the suite on
// references that are perfectly correct — `bin/wildcard-perms:11-26` is the
// standing example. A gate that cries wolf gets suppressed, and then the real
// signal goes with it. So the imprecise half stays a report you run by hand, and
// only the half that cannot false-positive is a test.
//
// It is also the half that catches the worst failure: a reference to a file that
// was renamed or deleted, or a line past the end of a file that shrank. Those
// send a reader somewhere that does not exist at all, rather than somewhere
// merely out of date.
//
// Cost: ~0.13 s, because it resolves paths and counts lines and does no
// per-anchor scan of the target.
//
// ESCAPE HATCH: a line carrying the marker `line-refs` + `:ignore` has its
// references skipped. Documentation ABOUT the reference format has to contain
// references that dangle on purpose, and scripts/check-line-refs.js tripped this
// very test the moment it became tracked. The marker is LINE-scoped, not
// file-scoped, so a file that uses it for one illustration is still policed for
// its own real references. Reach for it only for an example, never to silence a
// reference that should have been fixed.

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkBounds, collectRefs, tracked } = require('../scripts/check-line-refs.js');

test('every file:line reference resolves to a real file and a line inside it', () => {
  const broken = checkBounds();
  const detail = broken.map((b) => `  ${b.where}\n      ${b.reason}`).join('\n');
  assert.equal(
    broken.length,
    0,
    `${broken.length} file:line reference(s) point at nothing:\n${detail}\n\n` +
      'Run `node scripts/check-line-refs.js --detail` for the full report, ' +
      'including the weaker STALE candidates this test deliberately does not assert.'
  );
});

// A count floor. Without it the test above passes trivially if the extractor
// regex ever stops matching — zero references found is zero broken references,
// and the guard would go quiet in exactly the way that looks like success.
// The number is a floor, not an equality, so adding documentation never fails it.
test('the reference extractor still finds the corpus it is meant to police', () => {
  const refs = collectRefs(tracked());
  assert.ok(
    refs.length >= 100,
    `expected at least 100 file:line references across the tree, found ${refs.length}. ` +
      'If documentation really did shrink that much, lower the floor deliberately; ' +
      'otherwise the extractor in scripts/check-line-refs.js has stopped matching.'
  );
  // Both populations must be represented, so a regression that silently drops one
  // whole class of reference cannot hide behind the other's count.
  assert.ok(refs.some((r) => r.kind === 'doc'), 'no references found in tracked .md files');
  assert.ok(refs.some((r) => r.kind === 'comment'), 'no references found in source comments');
});
