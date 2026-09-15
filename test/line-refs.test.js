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

const {
  checkBounds, checkVacuous, isVacuousSpan, collectRefs, tracked, stripRefs, anchorsFrom,
} = require('../scripts/check-line-refs.js');

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

// The predicate, pinned directly. The corpus assertion below cannot do this job: the
// tree has zero offenders, so emptying VACUOUS_LINE or flipping `every` to `some` leaves
// it green. Every case here is one the corpus reached at some point during the
// 2026-09-14 pass.
test('the vacuous-line predicate accepts exactly what nobody could have meant', () => {
  assert.equal(isVacuousSpan(['']), true, 'a blank line');
  assert.equal(isVacuousSpan(['    ']), true, 'whitespace only');
  assert.equal(isVacuousSpan(['  }']), true, 'a bare closing brace');
  assert.equal(isVacuousSpan(['      };']), true, 'with a semicolon');
  assert.equal(isVacuousSpan(['  });']), true, 'a closing call');
  assert.equal(isVacuousSpan(['', '  }', '   ']), true, 'a range of nothing but those');

  // The other side, which is what stops this gate eating real references.
  assert.equal(isVacuousSpan(['const VERSION = 1;']), false, 'real code');
  assert.equal(isVacuousSpan(['  // a comment is a legitimate target here']), false,
    'this repo documents itself in comments, so a comment line is a real target');
  assert.equal(isVacuousSpan(['}', 'const x = 1;']), false,
    'a range that STARTS on a brace but covers real code is a reference to that code');
  assert.equal(isVacuousSpan([]), false, 'an empty span is checkBounds business, not this');
});

// The SECOND objective check, and the only other one that can be asserted.
//
// checkBounds catches a reference to a line that does not exist. This catches one that
// exists and says nothing: a blank line, or punctuation that only closes a block. No
// anchor, no prose, no judgement — nobody documents a closing brace, so a reference
// that lands on one is wrong however the sentence around it reads. That is exactly why
// it can be a test while the STALE verdict stays a report.
//
// Reachable, not theoretical. The tree held 13 of these when the 2026-09-14 correction
// pass began, including one written an hour earlier in that same session. They are at
// zero now, which is what makes this a gate rather than a backlog entry.
//
// A range counts only when EVERY line in it is vacuous. Testing just the start line
// called two references wrong whose ranges go on to cover real code.
test('no file:line reference points at a blank line or a bare closing brace', () => {
  // A floor first, for the reason the sibling test above spells out: zero references
  // examined is zero offenders and a green run, and this assertion would go quiet in
  // exactly the way that looks like success.
  const examined = collectRefs(tracked()).length;
  assert.ok(
    examined >= 100,
    `only ${examined} references were extracted, so this test proved nothing`
  );

  const bad = checkVacuous();
  const detail = bad.map((b) => `  ${b.where}\n      ${b.reason}`).join('\n');
  assert.equal(
    bad.length,
    0,
    `${bad.length} reference(s) point at a line that says nothing:\n${detail}\n\n` +
      'Find what the prose actually meant and cite that line. If the code it named was ' +
      'deleted rather than moved, say so in the prose instead of pointing at the gap.'
  );
});

// A reference is stripped out of the prose before the anchor hunt, so that the file
// name inside the reference cannot serve as its own anchor. Stripping the token but
// NOT the backticks around it left an orphan backtick, which paired with the opening
// backtick of the next real anchor and shifted every code span after it. The anchor
// that mattered was then never extracted, and a correct reference was reported STALE
// or UNVERIFIABLE with no way to tell that from "the prose names nothing literal".
//
// This is the exact string that exposed it during the correction pass of 2026-09-14.
// Two agents hit the same bug independently on different files, and both worked around
// it by moving the symbol ahead of the citation, which is why it looked like a writing
// convention rather than a defect.
test('an anchor written AFTER a backticked reference is still extracted', () => {
  const prose = 'The walk at `src/history-adapters.js:939` queues `entry.isSymbolicLink()` children.';
  const anchors = anchorsFrom(stripRefs(prose)).map((a) => a.text);

  assert.ok(
    anchors.includes('entry.isSymbolicLink()'),
    'the code span after the reference was eaten by an orphan backtick, so the anchor ' +
      `hunt never saw it. Extracted: ${JSON.stringify(anchors)}`
  );

  // The other half of the contract, so a "fix" that simply stopped stripping would
  // fail here rather than pass the assertion above by doing nothing.
  assert.ok(
    !anchors.some((a) => a.includes('history-adapters.js')),
    `the reference survived the strip and can now anchor itself: ${JSON.stringify(anchors)}`
  );

  // A reference written WITHOUT backticks must still be removed, and must not take a
  // neighbouring span with it. Without this, consuming an optional backtick on each
  // side could eat the opening backtick of an adjacent anchor and reintroduce the bug
  // from the other direction.
  const bare = 'See src/history-adapters.js:939 and `COMMAND_TOOLS` for the rest.';
  const bareAnchors = anchorsFrom(stripRefs(bare)).map((a) => a.text);
  assert.ok(bareAnchors.includes('COMMAND_TOOLS'), JSON.stringify(bareAnchors));
  assert.ok(!bareAnchors.some((a) => a.includes('history-adapters.js')), JSON.stringify(bareAnchors));
});
